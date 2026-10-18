/**
 * 游戏 API 的请求认证（`LOGIN_TOKEN` 头）—— 2026-10-18 加固。
 *
 * 背景：国服客户端在 `initialize` 里调 `/api/index.php/tool/signup`，把响应里的
 * `login_token` 存进 `DevConfig.loginToken`（客户端 `InitializeRealRemote.as:458`），
 * 之后**每个**请求都带上 `LOGIN_TOKEN` 头（客户端 `RequestQueue.as:181-183`）。
 * 本仓库此前把 `login_token` 用 `Math.random()` 造出来发走、既不存储也不校验，
 * 于是「谁在玩这个账号」在服务端完全没有凭据：知道 viewer_id 就能冒充。
 *
 * 这层加固把那个头变成真凭据：
 *   - signup 时签发 32 字节随机令牌，**同一个账号每次 signup 拿回同一个令牌**
 *     （不做启动期轮换：客户端要等响应处理完才换用新令牌，轮换会让启动期的
 *     请求带着旧令牌撞上闸门，把玩家自己锁在门外）；库里按明文存，理由见
 *     `src/data/domains/account.ts` 的 `getAccountLoginTokenSync`；
 *   - 之后每个 `/api/index.php/*` 请求比对「请求体 viewer_id → 账号」的令牌；
 *   - 三种模式由 `GAME_AUTH_MODE` 控制，**默认 enforce**（缺令牌或不匹配就拒）；
 *     若线上出现追不上的老客户端，`GAME_AUTH_MODE=audit` 是逃生门（只记录不拦）。
 *
 * 刻意不做的事：
 *   - 不碰 `/sp-auth/*`（那是登录页自己的凭据体系，契约 C1）；
 *   - 不要求「令牌必须存在」：老账号（本次上线前建的）库里没有令牌，
 *     `unset` 一律放行，等它下一次 signup 自然补上（避免上线即踢人）；
 *   - 不改任何游戏路由的签名：拒绝发生在 preHandler。
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { getDb } from "../data/db"
import {
    getAccountLoginTokenSync,
    setAccountLoginTokenSync,
} from "../data/domains/account"
import { appendBindAuditSync } from "../data/domains/account-binding"
import { SessionType } from "../data/types"
import { generateDataHeaders } from "../utils"
import { getRealNow } from "../runtime/time/game-time"
import { TAKEOVER_OLD_ACCESS_ERROR } from "./takeover-access"

export const LOGIN_TOKEN_HEADER = "login_token"
export const LOGIN_TOKEN_BYTES = 32
export const GAME_API_PREFIX = "/api/index.php/"

/**
 * 唯一允许「没有令牌」的游戏 API：令牌就是它发出去的，客户端此刻还没有。
 * 其余启动期请求（asset/、channels/ 等）本来就带不了 viewer_id，撞不到校验。
 */
export const GAME_AUTH_BOOTSTRAP_PATHS: readonly string[] = ["/api/index.php/tool/signup"]

/**
 * enforce 模式下拒绝客户端时用的 result_code。复用既有的 516
 * （`TAKEOVER_OLD_ACCESS_ERROR`，语义 = 这台设备的凭据已过期，请重新登录），
 * 客户端对这个码已有处理，不用赌它认不认识新码。
 */
export const GAME_AUTH_REJECT_RESULT_CODE = TAKEOVER_OLD_ACCESS_ERROR

export type GameAuthMode = "off" | "audit" | "enforce"
export type LoginTokenState = "match" | "mismatch" | "missing" | "unset"

/**
 * 默认 enforce（2026-10-18 加固）：令牌是客户端每次启动都会拿到的，而它挡掉的
 * 是「知道 viewer_id 就能冒充」这条真实存在的攻击链（viewer_id 会经好友列表、
 * 房间列表、attention 广播流出去，且 viewer 会话永不过期），所以默认必须是拦，
 * 不是观察。老客户端（不发 login_token 头）会把 `GAME_AUTH_MODE=audit` 当作逃生门：
 * 只记录不拦，但启动横幅会持续告警。未知取值一律按 enforce 处理，避免拼错的
 * 环境变量把闸门静默降级成 audit。
 */
export function resolveGameAuthMode(env: NodeJS.ProcessEnv = process.env): GameAuthMode {
    const raw = (env.GAME_AUTH_MODE ?? "").trim().toLowerCase()
    if (raw === "off" || raw === "audit") return raw
    if (raw === "enforce") return "enforce"
    if (raw !== "") {
        console.warn(`[GAME-AUTH] 未知的 GAME_AUTH_MODE=${raw}，按 enforce 处理（拦下没有登录令牌的请求）`)
    }
    return "enforce"
}

/**
 * 取得该账号的登录令牌（**没有才生成**）。
 *
 * 刻意不做「每次启动轮换」：客户端要等这次响应处理完才换用新令牌，而启动期的
 * 请求里还带着旧的，轮换就会把玩家自己挡在门外。需要轮换的场合（改密码、
 * 怀疑设备令牌泄露）显式调 `rotateLoginTokenSync`。
 */
export function issueLoginTokenSync(accountId: number): string {
    const existing = getAccountLoginTokenSync(accountId)
    if (existing !== null) return existing
    return rotateLoginTokenSync(accountId)
}

/** 强制换发新令牌：旧令牌立刻失效（客户端下次启动 signup 时会拿到新的）。 */
export function rotateLoginTokenSync(accountId: number): string {
    const token = randomBytes(LOGIN_TOKEN_BYTES).toString("hex")
    setAccountLoginTokenSync(accountId, token, getRealNow().toISOString())
    return token
}

function firstHeaderValue(value: unknown): string | null {
    if (Array.isArray(value)) {
        const first = value[0]
        return typeof first === "string" && first.length > 0 ? first : null
    }
    return typeof value === "string" && value.length > 0 ? value : null
}

/** 请求头里客户端带来的令牌（Flash 发 `LOGIN_TOKEN`，Node 侧一律小写）。 */
export function readLoginTokenHeader(headers: Record<string, unknown>): string | null {
    return firstHeaderValue(headers[LOGIN_TOKEN_HEADER])
        ?? firstHeaderValue(headers["LOGIN_TOKEN"])
        ?? firstHeaderValue(headers["x-login-token"])
}

/**
 * 令牌三态。`unset`（库里没存过）单独成一态：老账号上线即放行，等它下次
 * signup 补上令牌，避免加固当天把所有在线玩家踢下线。
 */
export function verifyLoginTokenSync(accountId: number, token: string | null): LoginTokenState {
    const stored = getAccountLoginTokenSync(accountId)
    if (stored === null) return "unset"
    if (token === null) return "missing"
    const expected = Buffer.from(stored, "utf8")
    const actual = Buffer.from(token, "utf8")
    if (expected.length !== actual.length) return "mismatch"
    return timingSafeEqual(expected, actual) ? "match" : "mismatch"
}

/** 请求体 `viewer_id` → 账号（viewer session 的 token 就是 viewer_id 的十进制文本）。 */
export function accountIdOfViewerId(viewerId: number): number | null {
    const row = getDb().prepare(`
        SELECT account_id FROM sessions WHERE token = ? AND type = ? LIMIT 1
    `).get(String(viewerId), SessionType.VIEWER) as { account_id: number } | undefined
    return row === undefined ? null : row.account_id
}

export function parseViewerIdField(value: unknown): number | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
    if (typeof value !== "string") return null
    const normalized = value.trim()
    if (!/^\d{1,15}$/.test(normalized)) return null
    const parsed = Number(normalized)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** 同账号的告警节流：令牌不匹配可能是客户端缓存旧令牌，别把日志刷爆。 */
const MISMATCH_WARN_INTERVAL_MS = 10_000
const lastMismatchWarnAt = new Map<number, number>()

function recordMismatch(accountId: number, path: string, state: LoginTokenState): void {
    const nowMs = Date.now()
    const last = lastMismatchWarnAt.get(accountId) ?? 0
    if (nowMs - last < MISMATCH_WARN_INTERVAL_MS) return
    lastMismatchWarnAt.set(accountId, nowMs)
    const detail = { reason: "login_token_mismatch", state, path }
    console.warn(`[GAME-AUTH] login token mismatch account=${accountId} state=${state} path=${path}`)
    try {
        appendBindAuditSync({
            action: "gate_reject",
            accountId,
            detail,
            actor: "game-auth",
            createdAt: getRealNow().toISOString(),
        })
    } catch {
        // 审计写失败不能影响请求本身
    }
}

/**
 * 装上游戏 API 的令牌校验。注册位置无所谓（Fastify 保证 body 解析先于 preHandler），
 * 但必须只在 `installCnBodyParsers` 之后调用，否则 msgpack 请求体还没有 `viewer_id`。
 */
export function installGameAuthGuard(fastify: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
    const mode = resolveGameAuthMode(env)
    if (mode === "off") {
        console.log("[GAME-AUTH] disabled（GAME_AUTH_MODE=off）")
        return
    }
    const bootstrap = new Set(GAME_AUTH_BOOTSTRAP_PATHS)
    console.log(mode === "enforce"
        ? "[GAME-AUTH] enforce：viewer_id 与 LOGIN_TOKEN 不匹配的请求将被拒绝"
        : "[GAME-AUTH] audit：只记录不匹配，不拦请求（GAME_AUTH_MODE=enforce 才拦）")

    fastify.addHook("preHandler", async (request, reply) => {
        const url = request.url
        if (!url.startsWith(GAME_API_PREFIX)) return
        const path = url.split("?")[0]
        if (bootstrap.has(path)) return

        const body = request.body
        if (body === null || typeof body !== "object" || Array.isArray(body)) return
        const viewerId = parseViewerIdField((body as Record<string, unknown>).viewer_id)
        if (viewerId === null) return

        const accountId = accountIdOfViewerId(viewerId)
        // 没建号的 viewer_id 交给路由自己回它该回的错，这里不掺和。
        if (accountId === null) return

        const state = verifyLoginTokenSync(
            accountId,
            readLoginTokenHeader(request.headers as Record<string, unknown>),
        )
        if (state === "match" || state === "unset") return

        recordMismatch(accountId, path, state)
        if (mode !== "enforce") return

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({
                viewer_id: viewerId,
                result_code: GAME_AUTH_REJECT_RESULT_CODE,
            }),
            data: {},
        })
    })
}
