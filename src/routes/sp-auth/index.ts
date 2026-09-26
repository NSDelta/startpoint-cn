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
import { spLogin } from "../../lib/sp-auth/login"
import { spRegister } from "../../lib/sp-auth/register"
import { fail, messageFor } from "../../lib/sp-auth/result"
import type { SpAuthResult } from "../../lib/sp-auth/result"
import {
    spBindStatus,
    spLogout,
    spProfile,
    spResend,
} from "../../lib/sp-auth/token-ops"

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
    fastify.post("/register", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "register", () => spRegister(body))
    })

    fastify.post("/login", async (request, reply) => {
        const body = readBody(request)
        return guard(reply, "login", () => spLogin(body))
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
}

export default routes
