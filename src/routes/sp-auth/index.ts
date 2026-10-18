/**
 * `/sp-auth/*` HTTP surface — contract C1 (§3.2).
 *
 * Wire rules the whole namespace obeys:
 *   - `POST` + `application/json` only;
 *   - HTTP status is **always 200**, even for failures (C1);
 *   - success is `{ok:true,data:{…}}`, failure is `{ok:false,code,message,data?}`
 *     with `code` from the shared C7 dictionary.
 *
 * The handlers stay thin on purpose: field validation, the CC-1 matrix and the
 * audit trail live in `src/lib/sp-auth/**`, and every database access goes
 * through `src/data/domains/**` (no SQL in this layer).
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spLogin } from "../../lib/sp-auth/login"
import { spRegister } from "../../lib/sp-auth/register"
import { spResetConfirm, spResetRequest } from "../../lib/sp-auth/reset"
import { fail, messageFor } from "../../lib/sp-auth/result"
import type { SpAuthResult } from "../../lib/sp-auth/result"
import {
    spBindStatus,
    spLogout,
    spProfile,
    spResend,
} from "../../lib/sp-auth/token-ops"
import { createIpRateLimiter } from "../../lib/ip-rate-limit"

type Body = Record<string, unknown>

function sendResult(reply: FastifyReply, result: SpAuthResult<unknown, unknown>): FastifyReply {
    if (result.ok) {
        reply.header("content-type", "application/json")
        return reply.status(200).send({ ok: true, data: result.data })
    }
    const code = result.code
    // C7 wording; the client may show its own copy, this is the fallback.
    const message = messageFor(code)
    reply.header("content-type", "application/json")
    return result.data === undefined
        ? reply.status(200).send({ ok: false, code, message })
        : reply.status(200).send({ ok: false, code, message, data: result.data })
}

/**
 * Wraps a handler so an unexpected throw still honours C1 ("HTTP 一律 200")
 * and never leaks a stack trace or a password to the client. The detail goes to
 * the server log only, and only the error message — never the request body.
 */
async function guard(
    reply: FastifyReply,
    label: string,
    run: () => Promise<SpAuthResult<unknown, unknown>> | SpAuthResult<unknown, unknown>,
): Promise<FastifyReply> {
    try {
        return sendResult(reply, await run())
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[sp-auth] ${label} failed: ${message}`)
        return sendResult(reply, fail("SERVICE_UNAVAILABLE"))
    }
}

function readBody(request: FastifyRequest): Body {
    const body = request.body
    return body !== null && typeof body === "object" ? body as Body : {}
}

const routes = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * 2026-10-18 加固：`/sp-auth/register|login` 以前**完全没有限流**，而两者都要
     * 做 bcrypt（`compareSync`，cost=10，**同步阻塞事件循环**），失败还会写一行
     * `bind_audit`。于是未认证的暴力破解 = CPU 打满 + 全站请求被卡 + 审计表膨胀。
     * 这里按对端 IP 上滑动窗口（与 `reset.ts` 的 per-IP 窗口同一量级），
     * 成功与失败共用一个桶，避免「只对失败计数」被绕过。
     */
    const credentialLimiter = createIpRateLimiter({ limit: 20, windowMs: 60_000 })
    const credentialLimited = (
        request: FastifyRequest,
        reply: FastifyReply,
        label: string,
    ): FastifyReply | null => {
        if (credentialLimiter.check(request.ip ?? "unknown")) return null
        console.warn(`[sp-auth] ${label} rate limited ip=${request.ip ?? "-"}`)
        return sendResult(reply, fail("RATE_LIMITED"))
    }

    fastify.post("/register", async (request, reply) => {
        const limited = credentialLimited(request, reply, "register")
        if (limited !== null) return limited
        const body = readBody(request)
        return guard(reply, "register", () => spRegister(body, process.env, { ip: request.ip }))
    })

    fastify.post("/login", async (request, reply) => {
        const limited = credentialLimited(request, reply, "login")
        if (limited !== null) return limited
        const body = readBody(request)
        return guard(reply, "login", () => spLogin(body, process.env, { ip: request.ip }))
    })

    fastify.post("/bind-status", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "bind-status", () => spBindStatus(body))
    })

    fastify.post("/resend", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "resend", () => spResend(body))
    })

    fastify.post("/profile", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "profile", () => spProfile(body))
    })

    fastify.post("/logout", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "logout", () => spLogout(body))
    })

    // 忘记密码 ①: 用户名或已绑定的 QQ 换一枚 15 分钟重置码。The IP is passed in
    // for the per-address window only; it is never written to the audit detail.
    fastify.post("/reset-request", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "reset-request", () => spResetRequest(body, process.env, { ip: request.ip }))
    })

    // 忘记密码 ③: 码必须已被群里的 `/api/bot/reset` 确认过才会改密码。
    fastify.post("/reset-confirm", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "reset-confirm", () => spResetConfirm(body))
    })

    /**
     * 临时排障通道（**不属于契约 C1**，只为真机排障存在）：客户端把日志行用 GET 发到这里，
     * 直接追加落盘，省得去翻服务器 stdout 里被百分号编码过的 URL。
     *   GET /sp-auth/diag?i=<批次序号>&l=<urlencode(若干行日志)>
     * 落盘路径取 `SP_DIAG_FILE`，缺省 `<os.tmpdir()>/sp-diag.log`。
     * 客户端拿不拿得到 200 都无所谓：就算这个路由不存在，pino 也会把整条 URL 记进运行日志。
     *
     * 2026-10-18 加固：这条路由本身是**未认证的磁盘写入原语** —— 任何人都能往
     * `SP_DIAG_FILE` 追加任意内容（含换行 ⇒ 可伪造日志行），无限刷就能把磁盘写满。
     * 现在默认**不注册**，只有显式 `SP_DIAG_ENABLED=1` 才打开；打开后单次文本截断到
     * 1KB、并按对端 IP 限流。
     */
    if ((process.env.SP_DIAG_ENABLED ?? "").trim() === "1") {
        const diagLimiter = createIpRateLimiter({ limit: 60, windowMs: 60_000 })
        fastify.get("/diag", async (request, reply) => {
            if (!diagLimiter.check(request.ip ?? "unknown")) {
                return reply.status(429).type("text/plain; charset=utf-8").send("Too Many Requests")
            }
            const query = request.query as Record<string, unknown>
            const seq = typeof query.i === "string" ? query.i.slice(0, 32) : "?"
            const text = typeof query.l === "string" ? query.l.slice(0, 1024) : ""
            const file = process.env.SP_DIAG_FILE ?? join(tmpdir(), "sp-diag.log")
            try {
                await appendFile(file, `--- i=${seq} ---\n${text}\n`, "utf8")
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[sp-auth] diag append failed: ${message}`)
            }
            reply.header("content-type", "text/plain; charset=utf-8")
            return reply.status(200).send("ok")
        })
    }
}

export default routes
