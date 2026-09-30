import { randomBytes } from "crypto";
import { getDb } from "../db";
import {
    Account,
    AccountBinding,
    BindAudit,
    BindAuditAction,
    BindState,
    BindingCreatedBy,
    BindingPlatform,
    DeviceGrant,
    RawAccountBinding,
    RawBindAudit,
    RawDeviceGrant,
    RawSignupCode,
    SignupCode,
    SignupCodeStatus,
} from "../types";
import { getAccountSync } from "./account";
import { getRealNow } from "../../runtime/time/game-time";

// Account binding (contract C2)
//
// Tables: signup_codes, account_bindings, device_grants, bind_audit.
// Every write function opens its own transaction; nested calls rely on
// better-sqlite3 savepoints, so a public write function may call another one.

type Db = ReturnType<typeof getDb>;

/** Characters used by signup codes; confusable glyphs (0/O/1/I) are removed. */
export const SIGNUP_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
export const SIGNUP_CODE_LENGTH = 6
/** Signup codes are valid for 30 minutes (contract A2). */
export const SIGNUP_CODE_TTL_MINUTES = 30
/** A code is locked after this many failed attempts. */
export const SIGNUP_CODE_MAX_ATTEMPTS = 5
/** Device grants are valid for 30 days (contract 3.2). */
export const DEVICE_GRANT_TTL_DAYS = 30
export const BINDING_PLATFORMS: readonly BindingPlatform[] = ["qq", "kook"]

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assertBindingPlatform(platform: string): BindingPlatform {
    if (platform !== "qq" && platform !== "kook") {
        throw new Error("Unknown binding platform")
    }
    return platform
}

function requireNonEmpty(value: string, label: string): string {
    const trimmed = value.trim()
    if (trimmed === "") throw new Error(`Binding ${label} must not be empty`)
    return trimmed
}

function requireSafeId(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Binding ${label} must be a positive integer`)
    }
    return value
}

function normalizeListLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_LIST_LIMIT
    if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("Binding list limit must be a positive integer")
    }
    return Math.min(limit, MAX_LIST_LIMIT)
}

/** Signup codes are case insensitive for the player. */
export function normalizeSignupCode(code: string): string {
    return code.trim().toUpperCase().replace(/[\s-]/g, "")
}

function normalizeBindState(value: unknown): BindState {
    if (value === "pending" || value === "active" || value === "disabled") return value
    // Rows created before contract C2 must not be locked out by the gate.
    return "active"
}

function generateSignupCodeValue(): string {
    const bytes = randomBytes(SIGNUP_CODE_LENGTH)
    let code = ""
    for (let index = 0; index < SIGNUP_CODE_LENGTH; index += 1) {
        // The alphabet length divides 256, so the modulo stays uniform.
        code += SIGNUP_CODE_ALPHABET[bytes[index] % SIGNUP_CODE_ALPHABET.length]
    }
    return code
}

function buildSignupCode(raw: RawSignupCode): SignupCode {
    return {
        id: raw.id,
        code: raw.code,
        accountId: raw.account_id,
        status: raw.status as SignupCodeStatus,
        platform: raw.platform === null ? null : assertBindingPlatform(raw.platform),
        platformUid: raw.platform_uid,
        attempts: raw.attempts,
        expiresAt: new Date(raw.expires_at),
        createdAt: new Date(raw.created_at),
        updatedAt: new Date(raw.updated_at),
        revision: raw.revision,
    }
}

function buildAccountBinding(raw: RawAccountBinding): AccountBinding {
    return {
        id: raw.id,
        accountId: raw.account_id,
        platform: assertBindingPlatform(raw.platform),
        platformUid: raw.platform_uid,
        displayName: raw.display_name,
        isPrimary: raw.is_primary === 1,
        createdBy: raw.created_by as BindingCreatedBy,
        note: raw.note,
        createdAt: new Date(raw.created_at),
        updatedAt: new Date(raw.updated_at),
        revision: raw.revision,
    }
}

function buildDeviceGrant(raw: RawDeviceGrant): DeviceGrant {
    return {
        deviceId: raw.device_id,
        accountId: raw.account_id,
        token: raw.token,
        expiresAt: new Date(raw.expires_at),
        createdAt: new Date(raw.created_at),
        updatedAt: new Date(raw.updated_at),
    }
}

function buildBindAudit(raw: RawBindAudit): BindAudit {
    return {
        id: raw.id,
        action: raw.action as BindAuditAction,
        accountId: raw.account_id,
        platform: raw.platform === null ? null : assertBindingPlatform(raw.platform),
        platformUid: raw.platform_uid,
        detail: raw.detail,
        actor: raw.actor,
        createdAt: new Date(raw.created_at),
    }
}

const signupCodeColumns = `
    id, code, account_id, status, platform, platform_uid,
    attempts, expires_at, created_at, updated_at, revision
`

const accountBindingColumns = `
    id, account_id, platform, platform_uid, display_name,
    is_primary, created_by, note, created_at, updated_at, revision
`

const deviceGrantColumns = `
    device_id, account_id, token, expires_at, created_at, updated_at
`

const bindAuditColumns = `
    id, action, account_id, platform, platform_uid, detail, actor, created_at
`

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export interface BindAuditInput {
    action: BindAuditAction
    accountId?: number | null
    platform?: BindingPlatform | null
    platformUid?: string | null
    detail?: unknown
    actor?: string | null
    createdAt?: string
}

/**
 * Appends one binding audit row. Auditing never blocks the audited write.
 */
export function appendBindAuditSync(input: BindAuditInput): number {
    const db = getDb()
    const detail = input.detail === undefined || input.detail === null
        ? null
        : typeof input.detail === "string" ? input.detail : JSON.stringify(input.detail)
    const createdAt = input.createdAt ?? getRealNow().toISOString()
    const result = db.prepare(`
        INSERT INTO bind_audit (action, account_id, platform, platform_uid, detail, actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        input.action,
        input.accountId ?? null,
        input.platform ?? null,
        input.platformUid ?? null,
        detail,
        input.actor ?? null,
        createdAt,
    )
    return Number(result.lastInsertRowid)
}

export interface ListBindAuditFilter {
    accountId?: number
    action?: BindAuditAction
    platformUid?: string
    limit?: number
}

export function listBindAuditSync(filter: ListBindAuditFilter = {}): BindAudit[] {
    const db = getDb()
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (filter.accountId !== undefined) {
        conditions.push("account_id = ?")
        parameters.push(requireSafeId(filter.accountId, "account id"))
    }
    if (filter.action !== undefined) {
        conditions.push("action = ?")
        parameters.push(filter.action)
    }
    if (filter.platformUid !== undefined) {
        conditions.push("platform_uid = ?")
        parameters.push(requireNonEmpty(filter.platformUid, "platform uid"))
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    const rows = db.prepare(`
        SELECT ${bindAuditColumns}
        FROM bind_audit
        ${where}
        ORDER BY id DESC
        LIMIT ?
    `).all(...parameters, normalizeListLimit(filter.limit)) as RawBindAudit[]
    return rows.map(buildBindAudit)
}

// ---------------------------------------------------------------------------
// signup codes
// ---------------------------------------------------------------------------

export interface CreateSignupCodeInput {
    accountId: number
    platform?: BindingPlatform | null
    /** Test and admin override; defaults to {@link SIGNUP_CODE_TTL_MINUTES}. */
    ttlMinutes?: number
    actor?: string | null
}

/**
 * Issues a signup code for an account and revokes the previous pending code
 * of the same account (contract CC-1: one live code per account).
 */
export function createSignupCodeSync(input: CreateSignupCodeInput): SignupCode {
    const db = getDb()
    const accountId = requireSafeId(input.accountId, "account id")
    const platform = input.platform == null ? null : assertBindingPlatform(input.platform)
    const ttlMinutes = input.ttlMinutes ?? SIGNUP_CODE_TTL_MINUTES
    if (!Number.isSafeInteger(ttlMinutes)) {
        throw new Error("Signup code TTL must be an integer number of minutes")
    }
    const actor = input.actor ?? "system"

    return db.transaction((): SignupCode => {
        const accountExists = db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId)
        if (accountExists === undefined) throw new Error("Signup code account does not exist")

        const now = getRealNow()
        const nowIso = now.toISOString()
        const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString()

        revokeSignupCodesForAccountSync(accountId, actor)

        let code: string | null = null
        for (let attempt = 0; attempt < 64; attempt += 1) {
            const candidate = generateSignupCodeValue()
            const existing = db.prepare("SELECT 1 FROM signup_codes WHERE code = ?").get(candidate)
            if (existing === undefined) {
                code = candidate
                break
            }
        }
        if (code === null) throw new Error("Could not allocate a unique signup code")

        const inserted = db.prepare(`
            INSERT INTO signup_codes (
                code, account_id, status, platform, platform_uid,
                attempts, expires_at, created_at, updated_at, revision
            ) VALUES (?, ?, 'pending', ?, NULL, 0, ?, ?, ?, 1)
        `).run(code, accountId, platform, expiresAt, nowIso, nowIso)
        const id = Number(inserted.lastInsertRowid)

        appendBindAuditSync({
            action: "issue_code",
            accountId,
            platform,
            detail: { codeId: id },
            actor,
            createdAt: nowIso,
        })

        const raw = db.prepare(`
            SELECT ${signupCodeColumns} FROM signup_codes WHERE id = ?
        `).get(id) as RawSignupCode
        return buildSignupCode(raw)
    })()
}

export function getSignupCodeSync(code: string): SignupCode | null {
    const normalized = normalizeSignupCode(code)
    if (normalized === "") return null
    const raw = getDb().prepare(`
        SELECT ${signupCodeColumns} FROM signup_codes WHERE code = ?
    `).get(normalized) as RawSignupCode | undefined
    return raw === undefined ? null : buildSignupCode(raw)
}

/**
 * Returns the live (pending, not yet expired) code of an account, if any.
 */
export function getActiveSignupCodeSync(accountId: number): SignupCode | null {
    const db = getDb()
    const raw = db.prepare(`
        SELECT ${signupCodeColumns}
        FROM signup_codes
        WHERE account_id = ? AND status = 'pending' AND expires_at > ?
        ORDER BY id DESC
        LIMIT 1
    `).get(requireSafeId(accountId, "account id"), getRealNow().toISOString()) as RawSignupCode | undefined
    return raw === undefined ? null : buildSignupCode(raw)
}

export interface ListSignupCodesFilter {
    accountId?: number
    status?: SignupCodeStatus
    limit?: number
}

export function listSignupCodesSync(filter: ListSignupCodesFilter = {}): SignupCode[] {
    const db = getDb()
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (filter.accountId !== undefined) {
        conditions.push("account_id = ?")
        parameters.push(requireSafeId(filter.accountId, "account id"))
    }
    if (filter.status !== undefined) {
        conditions.push("status = ?")
        parameters.push(filter.status)
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    const rows = db.prepare(`
        SELECT ${signupCodeColumns}
        FROM signup_codes
        ${where}
        ORDER BY id DESC
        LIMIT ?
    `).all(...parameters, normalizeListLimit(filter.limit)) as RawSignupCode[]
    return rows.map(buildSignupCode)
}

/**
 * Revokes every pending code of an account. Idempotent: a second call
 * returns 0.
 */
export function revokeSignupCodesForAccountSync(
    accountId: number,
    actor: string | null = "system",
): number {
    const db = getDb()
    const id = requireSafeId(accountId, "account id")
    return db.transaction((): number => {
        const nowIso = getRealNow().toISOString()
        const result = db.prepare(`
            UPDATE signup_codes
            SET status = 'revoked', updated_at = ?, revision = revision + 1
            WHERE account_id = ? AND status = 'pending'
        `).run(nowIso, id)
        const changes = Number(result.changes)
        if (changes > 0) {
            appendBindAuditSync({
                action: "revoke_code",
                accountId: id,
                detail: { revoked: changes },
                actor,
                createdAt: nowIso,
            })
        }
        return changes
    })()
}

export interface RevokeSignupCodeInput {
    id?: number
    code?: string
    actor?: string | null
}

/** Revokes one code by row id or by code value. */
export function revokeSignupCodeSync(input: RevokeSignupCodeInput): boolean {
    const db = getDb()
    if (input.id === undefined && input.code === undefined) {
        throw new Error("Revoking a signup code needs an id or a code")
    }
    const normalized = input.code === undefined ? null : normalizeSignupCode(input.code)
    return db.transaction((): boolean => {
        const nowIso = getRealNow().toISOString()
        const result = normalized === null
            ? db.prepare(`
                UPDATE signup_codes
                SET status = 'revoked', updated_at = ?, revision = revision + 1
                WHERE id = ? AND status = 'pending'
            `).run(nowIso, requireSafeId(input.id!, "signup code id"))
            : db.prepare(`
                UPDATE signup_codes
                SET status = 'revoked', updated_at = ?, revision = revision + 1
                WHERE code = ? AND status = 'pending'
            `).run(nowIso, normalized)
        const changes = Number(result.changes)
        if (changes > 0) {
            appendBindAuditSync({
                action: "revoke_code",
                code: undefined,
                accountId: null,
                detail: normalized === null ? { codeId: input.id } : { code: normalized },
                actor: input.actor ?? "admin",
                createdAt: nowIso,
            } as BindAuditInput)
        }
        return changes > 0
    })()
}

export type SignupCodeFailureCode =
    | "CODE_INVALID"
    | "CODE_EXPIRED"
    | "CODE_USED"
    | "CODE_LOCKED"
    | "ALREADY_BOUND"
    | "ACCOUNT_DISABLED"

export interface ConsumeSignupCodeInput {
    code: string
    platform: BindingPlatform
    platformUid: string
    displayName?: string | null
    actor?: string | null
}

export type ConsumeSignupCodeResult =
    | { ok: true; accountId: number; binding: AccountBinding; code: SignupCode }
    | { ok: false; code: SignupCodeFailureCode; attempts?: number }

/**
 * Consumes a signup code and binds the given platform identity to the code's
 * account, in one transaction.
 *
 * Failure codes are the ones frozen for `POST /api/bot/bind` (contract 3.4);
 * `ACCOUNT_DISABLED` is additionally returned for disabled accounts (CC-1).
 */
export function consumeSignupCodeSync(input: ConsumeSignupCodeInput): ConsumeSignupCodeResult {
    const db = getDb()
    const platform = assertBindingPlatform(input.platform)
    const platformUid = requireNonEmpty(input.platformUid, "platform uid")
    const code = normalizeSignupCode(input.code)
    const actor = input.actor ?? "bot"
    if (code === "") return { ok: false, code: "CODE_INVALID" }

    return db.transaction((): ConsumeSignupCodeResult => {
        const nowIso = getRealNow().toISOString()
        const raw = db.prepare(`
            SELECT ${signupCodeColumns} FROM signup_codes WHERE code = ?
        `).get(code) as RawSignupCode | undefined
        if (raw === undefined) return { ok: false, code: "CODE_INVALID" }

        // A failed attempt burns one try; the code locks at the limit.
        const fail = (reason: SignupCodeFailureCode): ConsumeSignupCodeResult => {
            const attempts = raw.attempts + 1
            db.prepare(`
                UPDATE signup_codes
                SET attempts = ?, updated_at = ?, revision = revision + 1
                WHERE id = ?
            `).run(attempts, nowIso, raw.id)
            return {
                ok: false,
                code: attempts >= SIGNUP_CODE_MAX_ATTEMPTS ? "CODE_LOCKED" : reason,
                attempts,
            }
        }

        if (raw.status === "bound") return fail("CODE_USED")
        if (raw.status === "revoked") return fail("CODE_INVALID")
        if (raw.status === "expired") return fail("CODE_EXPIRED")
        if (raw.attempts >= SIGNUP_CODE_MAX_ATTEMPTS) {
            return { ok: false, code: "CODE_LOCKED", attempts: raw.attempts }
        }
        if (raw.expires_at <= nowIso) {
            db.prepare(`
                UPDATE signup_codes
                SET status = 'expired', updated_at = ?, revision = revision + 1
                WHERE id = ?
            `).run(nowIso, raw.id)
            return fail("CODE_EXPIRED")
        }
        if (raw.platform !== null && raw.platform !== platform) return fail("CODE_INVALID")

        const account = db.prepare(`
            SELECT id, bind_state FROM accounts WHERE id = ?
        `).get(raw.account_id) as { id: number; bind_state: string | null } | undefined
        if (account === undefined) return fail("CODE_INVALID")

        const bindState = normalizeBindState(account.bind_state)
        if (bindState === "disabled") return fail("ACCOUNT_DISABLED")

        const occupied = db.prepare(`
            SELECT id, account_id FROM account_bindings
            WHERE platform = ? AND platform_uid = ? AND is_primary = 1
        `).get(platform, platformUid) as { id: number; account_id: number } | undefined
        if (occupied !== undefined && occupied.account_id !== raw.account_id) {
            return fail("ALREADY_BOUND")
        }

        const bindResult = bindPlatformAccountSync({
            accountId: raw.account_id,
            platform,
            platformUid,
            displayName: input.displayName ?? null,
            createdBy: "bot",
            actor,
        })
        if (!bindResult.ok) {
            return fail(bindResult.code === "ALREADY_BOUND" ? "ALREADY_BOUND" : "CODE_INVALID")
        }

        db.prepare(`
            UPDATE signup_codes
            SET status = 'bound', platform = ?, platform_uid = ?,
                updated_at = ?, revision = revision + 1
            WHERE id = ?
        `).run(platform, platformUid, nowIso, raw.id)

        const codeRow = db.prepare(`
            SELECT ${signupCodeColumns} FROM signup_codes WHERE id = ?
        `).get(raw.id) as RawSignupCode

        return {
            ok: true,
            accountId: raw.account_id,
            binding: bindResult.binding,
            code: buildSignupCode(codeRow),
        }
    })()
}

// ---------------------------------------------------------------------------
// account bindings
// ---------------------------------------------------------------------------

export interface BindPlatformAccountInput {
    accountId: number
    platform: BindingPlatform
    platformUid: string
    displayName?: string | null
    /** Defaults to false: admins add non-primary bindings (contract A7). */
    isPrimary?: boolean
    createdBy?: BindingCreatedBy
    note?: string | null
    actor?: string | null
}

export type BindPlatformAccountResult =
    | { ok: true; binding: AccountBinding }
    | { ok: false; code: "ALREADY_BOUND" | "ACCOUNT_NOT_FOUND" }

/**
 * Writes one platform binding for an account.
 *
 * Re-binding the same (platform, uid, account) triple is idempotent; binding a
 * uid that is already the primary identity of another account fails with
 * `ALREADY_BOUND` (contract A6).
 */
export function bindPlatformAccountSync(
    input: BindPlatformAccountInput,
): BindPlatformAccountResult {
    const db = getDb()
    const accountId = requireSafeId(input.accountId, "account id")
    const platform = assertBindingPlatform(input.platform)
    const platformUid = requireNonEmpty(input.platformUid, "platform uid")
    const createdBy = input.createdBy ?? "admin"
    const actor = input.actor ?? createdBy
    const requestedPrimary = input.isPrimary === true

    return db.transaction((): BindPlatformAccountResult => {
        const nowIso = getRealNow().toISOString()
        const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId)
        if (account === undefined) return { ok: false, code: "ACCOUNT_NOT_FOUND" }

        const occupied = db.prepare(`
            SELECT id, account_id FROM account_bindings
            WHERE platform = ? AND platform_uid = ? AND is_primary = 1
        `).get(platform, platformUid) as { id: number; account_id: number } | undefined
        if (occupied !== undefined && occupied.account_id !== accountId) {
            return { ok: false, code: "ALREADY_BOUND" }
        }

        const existing = db.prepare(`
            SELECT ${accountBindingColumns}
            FROM account_bindings
            WHERE account_id = ? AND platform = ? AND platform_uid = ?
        `).get(accountId, platform, platformUid) as RawAccountBinding | undefined

        // The first identity of an account on a platform becomes its primary.
        const accountPrimary = db.prepare(`
            SELECT id FROM account_bindings
            WHERE account_id = ? AND platform = ? AND is_primary = 1
        `).get(accountId, platform)
        const isPrimary = requestedPrimary || (existing === undefined && accountPrimary === undefined)

        let bindingId: number
        if (existing === undefined) {
            const inserted = db.prepare(`
                INSERT INTO account_bindings (
                    account_id, platform, platform_uid, display_name, is_primary,
                    created_by, note, created_at, updated_at, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `).run(
                accountId,
                platform,
                platformUid,
                input.displayName ?? null,
                isPrimary ? 1 : 0,
                createdBy,
                input.note ?? null,
                nowIso,
                nowIso,
            )
            bindingId = Number(inserted.lastInsertRowid)
        } else {
            bindingId = existing.id
            db.prepare(`
                UPDATE account_bindings
                SET display_name = ?, is_primary = ?, note = ?,
                    updated_at = ?, revision = revision + 1
                WHERE id = ?
            `).run(
                input.displayName ?? existing.display_name,
                isPrimary ? 1 : existing.is_primary,
                input.note ?? existing.note,
                nowIso,
                bindingId,
            )
        }

        if (isPrimary) {
            db.prepare(`
                UPDATE accounts
                SET bind_state = 'active', bind_platform = ?, bind_uid = ?
                WHERE id = ?
            `).run(platform, platformUid, accountId)
        } else {
            db.prepare(`
                UPDATE accounts
                SET bind_state = 'active'
                WHERE id = ? AND bind_state <> 'disabled'
            `).run(accountId)
        }

        appendBindAuditSync({
            action: "bind",
            accountId,
            platform,
            platformUid,
            detail: { bindingId, isPrimary, createdBy },
            actor,
            createdAt: nowIso,
        })

        // Becoming bound is the end of every code this account still has in
        // flight (CC-2; docs/systems/client-binding.md: one live code per
        // account). A straggler left pending here could later be handed to a
        // *different* platform identity and would still pass the
        // `consumeSignupCodeSync` pre-checks — that path only rejects a uid
        // that is another account's primary, it does not reject an account
        // that is already bound — so the code would really take effect as a
        // fresh non-primary binding. Revoking it here covers both writers:
        // this function is the shared write path behind the admin API and the
        // bot consume path.
        //
        // On the consume path the caller re-marks the code it just spent with
        // `status = 'bound'` in this same transaction, after this call
        // (`consumeSignupCodeSync`), so the spent code still ends up `bound`
        // and keeps its one-time semantics; only true stragglers stay revoked.
        // A cosmetic side effect of that ordering: the spent code also leaves
        // one `revoke_code` audit row behind before being re-marked `bound`.
        //
        // The failure exits above return before this point, so a rejected bind
        // never revokes anything (ACCOUNT_NOT_FOUND / ALREADY_BOUND).
        revokeSignupCodesForAccountSync(accountId, actor)

        const raw = db.prepare(`
            SELECT ${accountBindingColumns} FROM account_bindings WHERE id = ?
        `).get(bindingId) as RawAccountBinding
        return { ok: true, binding: buildAccountBinding(raw) }
    })()
}

export interface UnbindPlatformAccountInput {
    bindingId?: number
    accountId?: number
    platform?: BindingPlatform
    platformUid?: string
    /** Bot self-service may only drop non-primary bindings (contract 3.4). */
    allowPrimary?: boolean
    actor?: string | null
}

export type UnbindPlatformAccountResult =
    | { ok: true; binding: AccountBinding }
    | { ok: false; code: "BINDING_NOT_FOUND" | "PRIMARY_BINDING" }

export function unbindPlatformAccountSync(
    input: UnbindPlatformAccountInput,
): UnbindPlatformAccountResult {
    const db = getDb()
    const actor = input.actor ?? "admin"
    const allowPrimary = input.allowPrimary === true

    return db.transaction((): UnbindPlatformAccountResult => {
        const conditions: string[] = []
        const parameters: unknown[] = []
        if (input.bindingId !== undefined) {
            conditions.push("id = ?")
            parameters.push(requireSafeId(input.bindingId, "binding id"))
        }
        if (input.accountId !== undefined) {
            conditions.push("account_id = ?")
            parameters.push(requireSafeId(input.accountId, "account id"))
        }
        if (input.platform !== undefined) {
            conditions.push("platform = ?")
            parameters.push(assertBindingPlatform(input.platform))
        }
        if (input.platformUid !== undefined) {
            conditions.push("platform_uid = ?")
            parameters.push(requireNonEmpty(input.platformUid, "platform uid"))
        }
        if (conditions.length === 0) throw new Error("Unbinding needs a binding selector")

        const raw = db.prepare(`
            SELECT ${accountBindingColumns}
            FROM account_bindings
            WHERE ${conditions.join(" AND ")}
            ORDER BY is_primary DESC, id ASC
            LIMIT 1
        `).get(...parameters) as RawAccountBinding | undefined
        if (raw === undefined) return { ok: false, code: "BINDING_NOT_FOUND" }

        const binding = buildAccountBinding(raw)
        if (binding.isPrimary && !allowPrimary) return { ok: false, code: "PRIMARY_BINDING" }

        const nowIso = getRealNow().toISOString()
        db.prepare("DELETE FROM account_bindings WHERE id = ?").run(binding.id)

        if (binding.isPrimary) {
            const remaining = db.prepare(`
                SELECT ${accountBindingColumns}
                FROM account_bindings
                WHERE account_id = ? AND platform = ?
                ORDER BY id ASC
                LIMIT 1
            `).get(binding.accountId, binding.platform) as RawAccountBinding | undefined
            if (remaining === undefined) {
                db.prepare(`
                    UPDATE accounts
                    SET bind_state = 'pending', bind_platform = NULL, bind_uid = NULL
                    WHERE id = ? AND bind_state <> 'disabled'
                `).run(binding.accountId)
            } else {
                db.prepare(`
                    UPDATE account_bindings
                    SET is_primary = 1, updated_at = ?, revision = revision + 1
                    WHERE id = ?
                `).run(nowIso, remaining.id)
                db.prepare(`
                    UPDATE accounts SET bind_platform = ?, bind_uid = ? WHERE id = ?
                `).run(remaining.platform, remaining.platform_uid, binding.accountId)
            }
        }

        appendBindAuditSync({
            action: "unbind",
            accountId: binding.accountId,
            platform: binding.platform,
            platformUid: binding.platformUid,
            detail: { bindingId: binding.id, isPrimary: binding.isPrimary },
            actor,
            createdAt: nowIso,
        })

        return { ok: true, binding }
    })()
}

export type PromoteBindingResult =
    | { ok: true; binding: AccountBinding }
    | { ok: false; code: "BINDING_NOT_FOUND" | "ALREADY_BOUND" }

/** Makes one binding the primary identity of its account (contract 3.5). */
export function promoteBindingSync(bindingId: number, actor: string | null = "admin"): PromoteBindingResult {
    const db = getDb()
    const id = requireSafeId(bindingId, "binding id")

    return db.transaction((): PromoteBindingResult => {
        const raw = db.prepare(`
            SELECT ${accountBindingColumns} FROM account_bindings WHERE id = ?
        `).get(id) as RawAccountBinding | undefined
        if (raw === undefined) return { ok: false, code: "BINDING_NOT_FOUND" }

        const occupied = db.prepare(`
            SELECT id FROM account_bindings
            WHERE platform = ? AND platform_uid = ? AND is_primary = 1 AND id <> ?
        `).get(raw.platform, raw.platform_uid, id)
        if (occupied !== undefined) return { ok: false, code: "ALREADY_BOUND" }

        const nowIso = getRealNow().toISOString()
        db.prepare(`
            UPDATE account_bindings
            SET is_primary = 0, updated_at = ?, revision = revision + 1
            WHERE account_id = ? AND platform = ? AND is_primary = 1
        `).run(nowIso, raw.account_id, raw.platform)
        db.prepare(`
            UPDATE account_bindings
            SET is_primary = 1, updated_at = ?, revision = revision + 1
            WHERE id = ?
        `).run(nowIso, id)
        db.prepare(`
            UPDATE accounts
            SET bind_state = 'active', bind_platform = ?, bind_uid = ?
            WHERE id = ?
        `).run(raw.platform, raw.platform_uid, raw.account_id)

        appendBindAuditSync({
            action: "promote",
            accountId: raw.account_id,
            platform: assertBindingPlatform(raw.platform),
            platformUid: raw.platform_uid,
            detail: { bindingId: id },
            actor,
            createdAt: nowIso,
        })

        const updated = db.prepare(`
            SELECT ${accountBindingColumns} FROM account_bindings WHERE id = ?
        `).get(id) as RawAccountBinding
        return { ok: true, binding: buildAccountBinding(updated) }
    })()
}

/**
 * Resolves the binding behind a platform identity; the primary binding wins.
 */
export function getBindingByPlatformUidSync(
    platform: BindingPlatform,
    platformUid: string,
): AccountBinding | null {
    const raw = getDb().prepare(`
        SELECT ${accountBindingColumns}
        FROM account_bindings
        WHERE platform = ? AND platform_uid = ?
        ORDER BY is_primary DESC, id ASC
        LIMIT 1
    `).get(assertBindingPlatform(platform), requireNonEmpty(platformUid, "platform uid")) as RawAccountBinding | undefined
    return raw === undefined ? null : buildAccountBinding(raw)
}

export function getPrimaryBindingSync(
    accountId: number,
    platform?: BindingPlatform,
): AccountBinding | null {
    const db = getDb()
    const id = requireSafeId(accountId, "account id")
    const raw = platform === undefined
        ? db.prepare(`
            SELECT ${accountBindingColumns}
            FROM account_bindings
            WHERE account_id = ? AND is_primary = 1
            ORDER BY id ASC
            LIMIT 1
        `).get(id) as RawAccountBinding | undefined
        : db.prepare(`
            SELECT ${accountBindingColumns}
            FROM account_bindings
            WHERE account_id = ? AND platform = ? AND is_primary = 1
            ORDER BY id ASC
            LIMIT 1
        `).get(id, assertBindingPlatform(platform)) as RawAccountBinding | undefined
    return raw === undefined ? null : buildAccountBinding(raw)
}

export interface ListBindingsFilter {
    accountId?: number
    platform?: BindingPlatform
    platformUid?: string
    primaryOnly?: boolean
    limit?: number
}

export function listBindingsSync(filter: ListBindingsFilter = {}): AccountBinding[] {
    const db = getDb()
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (filter.accountId !== undefined) {
        conditions.push("account_id = ?")
        parameters.push(requireSafeId(filter.accountId, "account id"))
    }
    if (filter.platform !== undefined) {
        conditions.push("platform = ?")
        parameters.push(assertBindingPlatform(filter.platform))
    }
    if (filter.platformUid !== undefined) {
        conditions.push("platform_uid = ?")
        parameters.push(requireNonEmpty(filter.platformUid, "platform uid"))
    }
    if (filter.primaryOnly === true) conditions.push("is_primary = 1")
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
    const rows = db.prepare(`
        SELECT ${accountBindingColumns}
        FROM account_bindings
        ${where}
        ORDER BY account_id ASC, is_primary DESC, id ASC
        LIMIT ?
    `).all(...parameters, normalizeListLimit(filter.limit)) as RawAccountBinding[]
    return rows.map(buildAccountBinding)
}

// ---------------------------------------------------------------------------
// device grants
// ---------------------------------------------------------------------------

export interface UpsertDeviceGrantInput {
    deviceId: number
    accountId: number
    /** Defaults to a fresh 32 byte hex token (contract 3.2). */
    token?: string | null
    ttlDays?: number
    expiresAt?: string | null
}

/**
 * Creates or refreshes the grant that maps a game device to an account.
 */
export function upsertDeviceGrantSync(input: UpsertDeviceGrantInput): DeviceGrant {
    const db = getDb()
    const deviceId = requireSafeId(input.deviceId, "device id")
    const accountId = requireSafeId(input.accountId, "account id")
    const ttlDays = input.ttlDays ?? DEVICE_GRANT_TTL_DAYS
    if (!Number.isSafeInteger(ttlDays)) {
        throw new Error("Device grant TTL must be an integer number of days")
    }
    const token = input.token ?? randomBytes(32).toString("hex")
    if (typeof token !== "string" || token.trim() === "") {
        throw new Error("Device grant token must not be empty")
    }

    return db.transaction((): DeviceGrant => {
        const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId)
        if (account === undefined) throw new Error("Device grant account does not exist")

        const now = getRealNow()
        const nowIso = now.toISOString()
        const expiresAt = input.expiresAt
            ?? new Date(now.getTime() + ttlDays * 24 * 60 * 60_000).toISOString()

        db.prepare(`
            INSERT INTO device_grants (device_id, account_id, token, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                account_id = excluded.account_id,
                token = excluded.token,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
        `).run(deviceId, accountId, token, expiresAt, nowIso, nowIso)

        const raw = db.prepare(`
            SELECT ${deviceGrantColumns} FROM device_grants WHERE device_id = ?
        `).get(deviceId) as RawDeviceGrant
        return buildDeviceGrant(raw)
    })()
}

export function getDeviceGrantSync(deviceId: number): DeviceGrant | null {
    const raw = getDb().prepare(`
        SELECT ${deviceGrantColumns} FROM device_grants WHERE device_id = ?
    `).get(requireSafeId(deviceId, "device id")) as RawDeviceGrant | undefined
    return raw === undefined ? null : buildDeviceGrant(raw)
}

/** Same as {@link getDeviceGrantSync} but returns null once the grant expired. */
export function getActiveDeviceGrantSync(deviceId: number): DeviceGrant | null {
    const grant = getDeviceGrantSync(deviceId)
    if (grant === null) return null
    return grant.expiresAt.getTime() <= getRealNow().getTime() ? null : grant
}

export function clearDeviceGrantSync(deviceId: number): boolean {
    const result = getDb()
        .prepare("DELETE FROM device_grants WHERE device_id = ?")
        .run(requireSafeId(deviceId, "device id"))
    return Number(result.changes) > 0
}

export function clearDeviceGrantsForAccountSync(accountId: number): number {
    const result = getDb()
        .prepare("DELETE FROM device_grants WHERE account_id = ?")
        .run(requireSafeId(accountId, "account id"))
    return Number(result.changes)
}

export interface AccountDeviceMapping {
    account_id: number
    bind_state: BindState
    grant_token: string
    grant_expires_at: string
}

/**
 * Returns the account a device currently maps to (contract CC-1), or null when
 * the device has no grant. The caller decides how to treat `pending` versus
 * `active`.
 */
export function getAccountByDeviceSync(deviceId: number): AccountDeviceMapping | null {
    const row = getDb().prepare(`
        SELECT grant.account_id AS account_id,
               account.bind_state AS bind_state,
               grant.token AS grant_token,
               grant.expires_at AS grant_expires_at
        FROM device_grants AS grant
        JOIN accounts AS account ON account.id = grant.account_id
        WHERE grant.device_id = ?
    `).get(requireSafeId(deviceId, "device id")) as {
        account_id: number
        bind_state: string | null
        grant_token: string
        grant_expires_at: string
    } | undefined
    if (row === undefined) return null
    return {
        account_id: row.account_id,
        bind_state: normalizeBindState(row.bind_state),
        grant_token: row.grant_token,
        grant_expires_at: row.grant_expires_at,
    }
}

// ---------------------------------------------------------------------------
// account state and login name resolution
// ---------------------------------------------------------------------------

/** Reads `accounts.bind_state` without widening the shared Account type. */
export function getAccountBindStateSync(accountId: number): BindState | null {
    const row = getDb()
        .prepare("SELECT bind_state FROM accounts WHERE id = ?")
        .get(requireSafeId(accountId, "account id")) as { bind_state: string | null } | undefined
    if (row === undefined) return null
    return normalizeBindState(row.bind_state)
}

export function setAccountBindStateSync(
    accountId: number,
    state: BindState,
    actor: string | null = "admin",
): boolean {
    if (state !== "pending" && state !== "active" && state !== "disabled") {
        throw new Error("Unknown account bind state")
    }
    const db = getDb()
    const id = requireSafeId(accountId, "account id")
    return db.transaction((): boolean => {
        const nowIso = getRealNow().toISOString()
        const result = db.prepare("UPDATE accounts SET bind_state = ? WHERE id = ?").run(state, id)
        if (Number(result.changes) === 0) return false
        appendBindAuditSync({
            action: state === "active" ? "bind" : "unbind",
            accountId: id,
            detail: { bindState: state, actor },
            actor,
            createdAt: nowIso,
        })
        return true
    })()
}

/**
 * Resolves a login name to an account: platform identity first, then the
 * legacy `accounts.username` column (contract 3.2).
 */
export function resolveAccountByLoginNameSync(loginName: string): Account | null {
    const normalized = loginName.trim()
    if (normalized === "") return null

    for (const platform of BINDING_PLATFORMS) {
        const binding = getBindingByPlatformUidSync(platform, normalized)
        if (binding !== null) return getAccountSync(binding.accountId)
    }

    const row = getDb()
        .prepare("SELECT id FROM accounts WHERE username = ?")
        .get(normalized) as { id: number } | undefined
    return row === undefined ? null : getAccountSync(row.id)
}
