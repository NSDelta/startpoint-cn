import type { FastifyInstance, FastifyRequest } from "fastify"
import fs from "node:fs"

/**
 * B0 临时取证探针：把请求里的身份头原样记下来。
 *
 * 用途：判定 iOS 客户端首启 signup 请求的 `UDID` 头来自 SDK / 本地存档 / 其它，
 * 结论写进 `报告-B0-iOS身份分支.md`。
 *
 * 硬约束（改这个文件前先读）：
 * - **只观察，不改行为**：不读写 reply、不碰 request.body/headers，不注册路由、不改错误码；
 * - 默认关闭：仅当 `SP_PROBE_UDID=1` 时注册钩子；关闭时不产生任何日志与副作用；
 * - `SP_PROBE_LOG=<file>` 追加写文件，否则写 stdout；
 * - 每请求**恰好**一行 JSON：`{ts, method, url, ip, udid, short_udid, user_agent, has_session, body_keys}`
 *   （`body_keys` 只列键名，不落体内容；`udid`/`short_udid` 缺失写 `null`；
 *   `short_udid` 同时探测 `short-udid` 与 `short_udid` 两种拼写）。
 * - 正常请求由 `preHandler` 写（body 已解析 ⇒ 有 `body_keys`）；被 body 解析阶段拒掉的请求
 *   （415/400）到不了 `preHandler`，由 `onResponse` 兜底写一行 `body_keys: null`——
 *   宁可少一个字段，也不能让真机请求变成零证据。
 */

export const PROBE_ENV_FLAG = "SP_PROBE_UDID"
export const PROBE_ENV_LOG_PATH = "SP_PROBE_LOG"

export interface UdidProbeOptions {
    readonly logPath?: string | undefined
    readonly writeLine?: (line: string) => void
    readonly now?: () => Date
}

function headerValue(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (typeof entry === "string" && entry.trim().length > 0) return entry.trim()
        }
        return null
    }
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

/**
 * `short_udid` 在服务端契约里没有既有读点（`src/lib/takeover-access.ts:15` 与
 * `src/routes/cn/tool.ts:72` 只读 `udid`），因此这里对两种常见拼写都探测：
 * 有就记，没有就是 `null`——探针的价值正在于用真机回答「SDK 到底发不发」。
 */
function shortUdidValue(headers: FastifyRequest["headers"]): string | null {
    return headerValue(headers["short-udid"]) ?? headerValue(headers["short_udid"])
}

function bodyKeysOf(body: unknown): string[] | null {
    if (body === null || body === undefined) return null
    if (Buffer.isBuffer(body)) return null
    if (typeof body !== "object" || Array.isArray(body)) return null
    return Object.keys(body as Record<string, unknown>).sort()
}

/**
 * 请求快照。`url` 用 `originalUrl`（含 query），便于区分同路径不同参数的首启请求。
 */
export function buildUdidProbeRecord(request: FastifyRequest, now: Date = new Date()): Record<string, unknown> {
    const headers = request.headers
    return {
        ts: now.toISOString(),
        method: request.method,
        url: request.originalUrl ?? request.url,
        ip: request.ip ?? null,
        udid: headerValue(headers.udid),
        short_udid: shortUdidValue(headers),
        user_agent: headerValue(headers["user-agent"]),
        has_session: headerValue(headers.cookie) !== null,
        body_keys: bodyKeysOf(request.body),
    }
}

/**
 * 注册探针。返回是否真的注册了（调用方可用于打印一行启动横幅）。
 */
export function installUdidProbe(fastify: FastifyInstance, options: UdidProbeOptions = {}): boolean {
    const logPath = options.logPath
    const writeLine = options.writeLine ?? (logPath
        ? (line: string) => { fs.appendFileSync(logPath, `${line}\n`) }
        : (line: string) => { console.log(line) })
    const now = options.now ?? (() => new Date())

    // 保证「每请求恰好一行」：preHandler 命中即写并销号；被 body 解析阶段拒掉
    // （415/400，例如未注册的 content-type）的请求到不了 preHandler，由 onResponse 兜底。
    const pending = new WeakSet<FastifyRequest>()

    fastify.addHook("onRequest", async request => {
        pending.add(request)
    })

    // preHandler：body 已解析，能拿到 body_keys；此时仍未进入路由处理，观察不改行为。
    fastify.addHook("preHandler", async request => {
        pending.delete(request)
        const record = buildUdidProbeRecord(request, now())
        writeLine(JSON.stringify(record))
    })

    // 兜底：body 没解析出来（body_keys 记 null），但身份头照样落盘——真机取证最怕「零证据」。
    fastify.addHook("onResponse", async request => {
        if (!pending.has(request)) return
        pending.delete(request)
        const record = buildUdidProbeRecord(request, now())
        writeLine(JSON.stringify(record))
    })
    return true
}

function flagEnabled(value: string | undefined): boolean {
    return value === "1" || value === "true"
}

/**
 * 环境变量入口：`SP_PROBE_UDID=1` 才注册。
 */
export function installUdidProbeFromEnv(
    fastify: FastifyInstance,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (!flagEnabled(env[PROBE_ENV_FLAG])) return false
    const logPath = (env[PROBE_ENV_LOG_PATH] ?? "").trim()
    installUdidProbe(fastify, { logPath: logPath.length > 0 ? logPath : undefined })
    console.log(`[${PROBE_ENV_FLAG}] identity probe active (${logPath.length > 0 ? `append -> ${logPath}` : "stdout"})`)
    return true
}
