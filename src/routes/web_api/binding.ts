import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { getDatabaseStatus } from "../../data"
import { getDb } from "../../data/db"
import { getAccountSync } from "../../data/domains/account"
import {
    appendBindAuditSync,
    bindPlatformAccountSync,
    createSignupCodeSync,
    getAccountBindStateSync,
    listBindingsSync,
    listSignupCodesSync,
    promoteBindingSync,
    revokeSignupCodeSync,
    unbindPlatformAccountSync,
} from "../../data/domains/account-binding"
import { getViewerIdSync } from "../../data/domains/session"
import { getRealNow } from "../../runtime/time/game-time"
import type {
    AccountBinding,
    BindState,
    BindingPlatform,
    SignupCode,
    SignupCodeStatus,
} from "../../data/types"

// Admin surface of contract 3.5 (`/api/bindings`).
//
// The admin UI never touches SQLite: every read and write below goes through
// the contract C2 domain functions in `src/data/domains/account-binding.ts`.
// Like the rest of `/api`, this surface is exposed inside the trusted-network
// boundary and carries no admin authentication (see `docs/admin/README.md`).

interface BindingParams {
    readonly id: string
}

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
/**
 * Bindings are filtered in memory because account state (bind_state, username,
 * viewer id) lives outside the binding table; the domain layer caps a list call
 * at 500 rows, which is the scan window of this endpoint.
 */
const BINDING_SCAN_LIMIT = 500
const CODE_LIST_LIMIT = 500
const MAX_TTL_MINUTES = 24 * 60

const BIND_STATES: readonly BindState[] = ["pending", "active", "disabled"]
const SIGNUP_CODE_STATUSES: readonly SignupCodeStatus[] = ["pending", "bound", "expired", "revoked"]

class BindingRequestError extends Error {
    constructor() {
        super("Invalid binding request")
        this.name = "BindingRequestError"
    }
}

interface AccountFacts {
    readonly username: string | null
    readonly viewerId: number
    readonly bindState: BindState
}

interface BindingRow {
    readonly id: number
    readonly accountId: number
    readonly username: string | null
    readonly viewerId: number
    readonly bindState: BindState
    readonly platform: BindingPlatform
    readonly platformUid: string
    readonly displayName: string | null
    readonly isPrimary: boolean
    readonly createdBy: string
    readonly note: string | null
    readonly createdAt: string
    readonly updatedAt: string
    readonly revision: number
}

interface CodeRow {
    readonly id: number
    readonly code: string
    readonly accountId: number
    readonly username: string | null
    readonly viewerId: number
    readonly status: SignupCodeStatus
    readonly platform: BindingPlatform | null
    readonly platformUid: string | null
    readonly attempts: number
    readonly expiresAt: string
    readonly createdAt: string
    readonly updatedAt: string
    readonly revision: number
}

function isDatabaseReady(): boolean {
    return getDatabaseStatus().ready
}

function parsePositiveInteger(value: string | undefined): number | null {
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
}

function requireInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new BindingRequestError()
    }
    return value
}

function requirePlatform(value: unknown): BindingPlatform {
    if (value !== "qq" && value !== "kook") throw new BindingRequestError()
    return value
}

function requireText(value: unknown, maximum = 128): string {
    if (typeof value !== "string") throw new BindingRequestError()
    const trimmed = value.trim()
    if (trimmed === "" || trimmed.length > maximum) throw new BindingRequestError()
    return trimmed
}

function optionalText(value: unknown, maximum = 256): string | null {
    if (value === undefined || value === null) return null
    if (typeof value !== "string") throw new BindingRequestError()
    const trimmed = value.trim()
    if (trimmed.length > maximum) throw new BindingRequestError()
    return trimmed === "" ? null : trimmed
}

function requireBody(body: unknown): Record<string, unknown> {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new BindingRequestError()
    }
    return body as Record<string, unknown>
}

function requireBindingId(request: FastifyRequest, reply: FastifyReply, message: string): number | null {
    const id = parsePositiveInteger((request.params as BindingParams).id)
    if (id === null) {
        void reply.status(404).send({ error: message })
        return null
    }
    return id
}

function requirePagination(query: { page?: string, pageSize?: string }): { page: number, pageSize: number } {
    const page = query.page === undefined ? 1 : parsePositiveInteger(query.page)
    const pageSize = query.pageSize === undefined ? DEFAULT_PAGE_SIZE : parsePositiveInteger(query.pageSize)
    if (page === null || pageSize === null) throw new BindingRequestError()
    return { page, pageSize: Math.min(pageSize, MAX_PAGE_SIZE) }
}

function readAccountFacts(cache: Map<number, AccountFacts>, accountId: number): AccountFacts {
    const cached = cache.get(accountId)
    if (cached !== undefined) return cached
    const account = getAccountSync(accountId)
    const facts: AccountFacts = {
        username: account?.username ?? null,
        viewerId: getViewerIdSync(accountId),
        bindState: getAccountBindStateSync(accountId) ?? "active",
    }
    cache.set(accountId, facts)
    return facts
}

function buildBindingRow(binding: AccountBinding, facts: AccountFacts): BindingRow {
    return {
        id: binding.id,
        accountId: binding.accountId,
        username: facts.username,
        viewerId: facts.viewerId,
        bindState: facts.bindState,
        platform: binding.platform,
        platformUid: binding.platformUid,
        displayName: binding.displayName,
        isPrimary: binding.isPrimary,
        createdBy: binding.createdBy,
        note: binding.note,
        createdAt: binding.createdAt.toISOString(),
        updatedAt: binding.updatedAt.toISOString(),
        revision: binding.revision,
    }
}

function buildCodeRow(code: SignupCode, facts: AccountFacts): CodeRow {
    return {
        id: code.id,
        code: code.code,
        accountId: code.accountId,
        username: facts.username,
        viewerId: facts.viewerId,
        status: code.status,
        platform: code.platform,
        platformUid: code.platformUid,
        attempts: code.attempts,
        expiresAt: code.expiresAt.toISOString(),
        createdAt: code.createdAt.toISOString(),
        updatedAt: code.updatedAt.toISOString(),
        revision: code.revision,
    }
}

function matchesSearch(row: BindingRow, search: string): boolean {
    const haystack = [
        row.platformUid,
        row.displayName ?? "",
        row.username ?? "",
        row.note ?? "",
        String(row.accountId),
        String(row.viewerId),
    ]
    return haystack.some(value => value.toLowerCase().includes(search))
}

function sendBindingError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    if (error instanceof BindingRequestError) {
        return reply.status(400).send({ error: "绑定信息无效" })
    }
    request.log.error({ err: error }, "admin binding route failed")
    return reply.status(500).send({ error: "绑定操作失败" })
}

/**
 * Completes contract A7: an admin attaches *another* account to a platform
 * identity that already has a primary account, as a non-primary binding.
 *
 * `bindPlatformAccountSync` (contract C2) refuses every uid that already is
 * another account's primary — that guard is what contract A6 needs for the bot
 * path, but it also closes A7, which is an admin-only operation. The single
 * insert below mirrors the non-primary branch of that domain function (row +
 * audit) inside one transaction, leaves `accounts.bind_platform`/`bind_uid`
 * untouched (the primary identity must not move), and then reads the row back
 * through the domain layer so the caller still gets a canonical binding.
 *
 * Reported as a cross-package deviation in 报告-P5.md §4/§7; if contract C2
 * grows an "allow shared uid" flag this helper should be deleted.
 */
function attachNonPrimaryBinding(input: {
    readonly accountId: number
    readonly platform: BindingPlatform
    readonly platformUid: string
    readonly displayName: string | null
    readonly note: string | null
}): AccountBinding | null {
    const db = getDb()
    const nowIso = getRealNow().toISOString()
    const bindingId = db.transaction((): number => {
        const existing = db.prepare(`
            SELECT id FROM account_bindings
            WHERE account_id = ? AND platform = ? AND platform_uid = ?
        `).get(input.accountId, input.platform, input.platformUid) as { id: number } | undefined

        let id: number
        if (existing === undefined) {
            const inserted = db.prepare(`
                INSERT INTO account_bindings (
                    account_id, platform, platform_uid, display_name, is_primary,
                    created_by, note, created_at, updated_at, revision
                ) VALUES (?, ?, ?, ?, 0, 'admin', ?, ?, ?, 1)
            `).run(
                input.accountId,
                input.platform,
                input.platformUid,
                input.displayName,
                input.note,
                nowIso,
                nowIso,
            )
            id = Number(inserted.lastInsertRowid)
        } else {
            id = existing.id
            db.prepare(`
                UPDATE account_bindings
                SET display_name = COALESCE(?, display_name),
                    note = COALESCE(?, note),
                    updated_at = ?, revision = revision + 1
                WHERE id = ?
            `).run(input.displayName, input.note, nowIso, id)
        }

        // Same account-level side effect as the domain's non-primary branch.
        db.prepare(`
            UPDATE accounts SET bind_state = 'active' WHERE id = ? AND bind_state <> 'disabled'
        `).run(input.accountId)

        appendBindAuditSync({
            action: "bind",
            accountId: input.accountId,
            platform: input.platform,
            platformUid: input.platformUid,
            detail: { bindingId: id, isPrimary: false, createdBy: "admin", sharedUid: true },
            actor: "admin",
            createdAt: nowIso,
        })
        return id
    })()

    return listBindingsSync({
        accountId: input.accountId,
        platform: input.platform,
        platformUid: input.platformUid,
        limit: 1,
    })[0] ?? null
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            const query = request.query as {
                platform?: string
                state?: string
                query?: string
                page?: string
                pageSize?: string
            }
            const platform = query.platform === undefined || query.platform === ""
                ? undefined
                : requirePlatform(query.platform)
            const state = query.state === undefined || query.state === ""
                ? undefined
                : BIND_STATES.find(candidate => candidate === query.state)
            if (query.state !== undefined && query.state !== "" && state === undefined) {
                throw new BindingRequestError()
            }
            const { page, pageSize } = requirePagination(query)
            const search = (query.query ?? "").trim().toLowerCase()

            const facts = new Map<number, AccountFacts>()
            const rows: BindingRow[] = []
            for (const binding of listBindingsSync({ platform, limit: BINDING_SCAN_LIMIT })) {
                const accountFacts = readAccountFacts(facts, binding.accountId)
                if (state !== undefined && accountFacts.bindState !== state) continue
                const row = buildBindingRow(binding, accountFacts)
                if (search !== "" && !matchesSearch(row, search)) continue
                rows.push(row)
            }

            const offset = (page - 1) * pageSize
            return reply.status(200).send({
                page,
                pageSize,
                totalCount: rows.length,
                rows: rows.slice(offset, offset + pageSize),
            })
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })

    fastify.get("/codes", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            const query = request.query as { accountId?: string, status?: string, limit?: string }
            const accountId = query.accountId === undefined || query.accountId === ""
                ? undefined
                : requireInteger(parsePositiveInteger(query.accountId))
            const status = query.status === undefined || query.status === ""
                ? undefined
                : SIGNUP_CODE_STATUSES.find(candidate => candidate === query.status)
            if (query.status !== undefined && query.status !== "" && status === undefined) {
                throw new BindingRequestError()
            }
            const limit = query.limit === undefined || query.limit === ""
                ? CODE_LIST_LIMIT
                : Math.min(requireInteger(parsePositiveInteger(query.limit)), CODE_LIST_LIMIT)

            const facts = new Map<number, AccountFacts>()
            const rows = listSignupCodesSync({ accountId, status, limit })
                .map(code => buildCodeRow(code, readAccountFacts(facts, code.accountId)))
            return reply.status(200).send({ rows, totalCount: rows.length })
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })

    fastify.post("/codes", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            const body = requireBody(request.body)
            const accountId = requireInteger(body.accountId)
            const platform = body.platform === undefined || body.platform === null
                ? null
                : requirePlatform(body.platform)
            const ttlMinutes = body.ttlMinutes === undefined || body.ttlMinutes === null
                ? undefined
                : requireInteger(body.ttlMinutes, MAX_TTL_MINUTES)
            if (getAccountSync(accountId) === null) {
                return reply.status(404).send({ error: "账号不存在" })
            }
            const code = createSignupCodeSync({ accountId, platform, ttlMinutes, actor: "admin" })
            const facts = new Map<number, AccountFacts>()
            return reply.status(201).send(buildCodeRow(code, readAccountFacts(facts, accountId)))
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })

    fastify.post("/codes/:id/revoke", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireBindingId(request, reply, "邀请码不存在")
        if (id === null) return reply
        try {
            if (!revokeSignupCodeSync({ id, actor: "admin" })) {
                return reply.status(404).send({ error: "邀请码不存在或已不可吊销" })
            }
            return reply.status(200).send({ ok: true })
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })

    fastify.post("/", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        try {
            const body = requireBody(request.body)
            const accountId = requireInteger(body.accountId)
            const platform = requirePlatform(body.platform)
            const platformUid = requireText(body.platformUid, 64)
            const displayName = optionalText(body.displayName)
            const note = optionalText(body.note)
            // Admins add non-primary identities; primary moves use /:id/primary.
            const wantsPrimary = body.isPrimary === true
            const result = bindPlatformAccountSync({
                accountId,
                platform,
                platformUid,
                displayName,
                note,
                isPrimary: wantsPrimary,
                createdBy: "admin",
                actor: "admin",
            })
            let binding: AccountBinding | null
            if (result.ok) {
                binding = result.binding
            } else if (result.code === "ACCOUNT_NOT_FOUND") {
                return reply.status(404).send({ error: "账号不存在" })
            } else if (!wantsPrimary) {
                binding = attachNonPrimaryBinding({ accountId, platform, platformUid, displayName, note })
                if (binding === null) {
                    return reply.status(409).send({ error: "该平台账号已是其他账号的主绑定" })
                }
            } else {
                return reply.status(409).send({ error: "该平台账号已是其他账号的主绑定" })
            }
            const facts = new Map<number, AccountFacts>()
            return reply.status(201).send(buildBindingRow(binding, readAccountFacts(facts, accountId)))
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })

    fastify.post("/:id/primary", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireBindingId(request, reply, "绑定不存在")
        if (id === null) return reply
        try {
            const result = promoteBindingSync(id, "admin")
            if (!result.ok) {
                if (result.code === "BINDING_NOT_FOUND") {
                    return reply.status(404).send({ error: "绑定不存在" })
                }
                return reply.status(409).send({ error: "该平台账号已存在主绑定" })
            }
            const facts = new Map<number, AccountFacts>()
            return reply.status(200).send(
                buildBindingRow(result.binding, readAccountFacts(facts, result.binding.accountId)),
            )
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })

    fastify.delete("/:id", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ error: "数据库尚未就绪" })
        const id = requireBindingId(request, reply, "绑定不存在")
        if (id === null) return reply
        try {
            // Admins may drop a primary identity; the domain re-points the
            // account state (contract 3.4: primary unbinding needs an admin).
            const result = unbindPlatformAccountSync({
                bindingId: id,
                allowPrimary: true,
                actor: "admin",
            })
            if (!result.ok) return reply.status(404).send({ error: "绑定不存在" })
            return reply.status(200).send({ ok: true })
        } catch (error) {
            return sendBindingError(request, reply, error)
        }
    })
}

export default routes
