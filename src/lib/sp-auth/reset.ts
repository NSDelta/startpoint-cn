/**
 * Self-service password reset — `POST /sp-auth/reset-request` and
 * `POST /sp-auth/reset-confirm` (contract C1 addendum "忘记密码").
 *
 * The flow is deliberately three-legged, because holding a code must not be
 * enough to seize an account:
 *
 *   ① `POST /sp-auth/reset-request`  login name **or** bound QQ → a 6 char code
 *   ② `POST /api/bot/reset`          the QQ bound to that account sends the code
 *                                    in the group ⇒ the code becomes `confirmed`
 *   ③ `POST /sp-auth/reset-confirm`  code + new password ⇒ hash rewritten and
 *                                    every device credential revoked
 *
 * Decision order (each step resolves before the next one runs):
 *
 *   reset-request
 *     1. more than `SP_AUTH_RESET_IP_MAX_REQUESTS` from this IP in 60 s
 *        → RATE_LIMITED (cheap gate in front of account enumeration)
 *     2. empty `account` → ACCOUNT_NOT_FOUND
 *     3. `resolveAccountByLoginNameSync` (username **or** bound QQ, exactly like
 *        `/sp-auth/login`) → null → ACCOUNT_NOT_FOUND
 *     4. no active QQ binding (bind_state ≠ active, or no qq binding row)
 *        → RESET_NO_QQ
 *     5. another reset code was issued for this account < 60 s ago
 *        → RATE_LIMITED (same window as `/sp-auth/resend`)
 *     6. issue a 15 minute code; the previous live one is revoked → ok
 *
 *   reset-confirm
 *     1. `isStrongPassword` → PASSWORD_WEAK. Checked **before** the code is
 *        looked up, so a weak password never burns a valid code
 *     2. account resolution → ACCOUNT_NOT_FOUND
 *     3. unknown code, a code belonging to another account, or a code that
 *        already was used/revoked → RESET_CODE_INVALID
 *     4. expired → CODE_EXPIRED
 *     5. `attempts >= PASSWORD_RESET_CODE_MAX_ATTEMPTS` → RATE_LIMITED
 *     6. no `/api/bot/reset` confirmation yet → RESET_NOT_CONFIRMED (and the
 *        failed attempt is counted, so guessing dies after 5 tries)
 *     7. `hashPassword` + `updateAccountSync`, mark the code used, delete every
 *        `device_grants` row of the account and the `sessions` VIEWER row
 *        (the old device has to log in again) → ok({account})
 *
 * Accounts with `status = "disabled"` are **not** special-cased here: a disabled
 * account cannot log in anyway (`src/lib/sp-auth/login.ts:78-81`), so resetting
 * its password grants nothing. The frozen failure list for these two endpoints
 * has no ACCOUNT_DISABLED branch.
 */

import {
    clearDeviceGrantsForAccountSync,
    consumePasswordResetCodeSync,
    getAccountBindStateSync,
    getBoundPlatformBindingSync,
    getPasswordResetCodeSync,
    incrementPasswordResetCodeAttemptsSync,
    listPasswordResetCodesSync,
    PASSWORD_RESET_CODE_MAX_ATTEMPTS,
    resolveAccountByLoginNameSync,
    appendBindAuditSync,
} from "../../data/domains/account-binding"
import { updateAccountSync } from "../../data/domains/account"
import { deleteAccountSessionsOfTypeSync } from "../../data/domains/session"
import { SessionType } from "../../data/types"
import { getRealNowMs } from "../../runtime/time/game-time"
import {
    isWithinCodeIssueWindow,
    issuePasswordResetCode,
    rateLimitRetryAfterMs,
    SP_AUTH_AUDIT_ACTOR,
} from "../signup-code"
import { isStrongPassword } from "./contract"
import type {
    SpAuthResetConfirmBody,
    SpAuthResetConfirmData,
    SpAuthResetRequestBody,
    SpAuthResetRequestData,
} from "./contract"
import { hashPassword } from "./password"
import { fail, ok } from "./result"
import type { SpAuthResult } from "./result"

/** Same order of magnitude as the signup-code window (CC-1: 60 s). */
export const SP_AUTH_RESET_IP_WINDOW_MS = 60_000

/**
 * Per-IP budget for `reset-request`. Deliberately looser than the per-account
 * window (one request per account per 60 s): a household or a campus NAT shares
 * one address, while account enumeration is already throttled per account.
 */
export const SP_AUTH_RESET_IP_MAX_REQUESTS = 10

/** Sliding window state; process-local like the bot API limiter by design. */
const resetRequestHits = new Map<string, number[]>()

export interface SpAuthResetContext {
    /** `request.ip`; omitted in unit tests that call the handler directly. */
    readonly ip?: string | null
}

function ipWithinBudget(ip: string, nowMs: number): boolean {
    const recent = (resetRequestHits.get(ip) ?? [])
        .filter((at) => nowMs - at < SP_AUTH_RESET_IP_WINDOW_MS)
    if (recent.length >= SP_AUTH_RESET_IP_MAX_REQUESTS) {
        resetRequestHits.set(ip, recent)
        return false
    }
    recent.push(nowMs)
    resetRequestHits.set(ip, recent)
    // Keep the map from growing without bound on a long-lived server.
    if (resetRequestHits.size > 512) {
        for (const [key, hits] of resetRequestHits) {
            const kept = hits.filter((at) => nowMs - at < SP_AUTH_RESET_IP_WINDOW_MS)
            if (kept.length === 0) resetRequestHits.delete(key)
            else resetRequestHits.set(key, kept)
        }
    }
    return true
}

/**
 * Test hook: forgets every in-memory IP window. The limiter is process-local
 * state, so a test file that exercises several scenarios has to clear it.
 */
export function clearResetRequestRateState(): void {
    resetRequestHits.clear()
}

function readLoginName(value: unknown): string {
    return typeof value === "string" ? value.trim() : ""
}

/**
 * The QQ that speaks for an account (`null` when nothing is bound): the primary
 * qq binding when set, otherwise the earliest one — the same precedence
 * `resolveAccountByLoginNameSync` applies in the other direction.
 */
export function resolveBoundQq(accountId: number): string | null {
    const binding = getBoundPlatformBindingSync(accountId, "qq")
    return binding === null ? null : binding.platformUid
}

function auditReset(
    action: "reset_request" | "reset_confirm" | "reset_password",
    accountId: number | null,
    detail: Record<string, unknown>,
): void {
    try {
        appendBindAuditSync({
            action,
            accountId,
            detail,
            actor: SP_AUTH_AUDIT_ACTOR,
            createdAt: new Date(getRealNowMs()).toISOString(),
        })
    } catch {
        // Auditing must never block the action it audits (see src/lib/bind-gate.ts).
    }
}

/** `POST /sp-auth/reset-request` */
export function spResetRequest(
    input: SpAuthResetRequestBody,
    env: NodeJS.ProcessEnv = process.env,
    context: SpAuthResetContext = {},
): SpAuthResult<SpAuthResetRequestData> {
    const nowMs = getRealNowMs()
    const ip = typeof context.ip === "string" && context.ip.trim() !== "" ? context.ip.trim() : null
    if (ip !== null && !ipWithinBudget(ip, nowMs)) {
        auditReset("reset_request", null, { reason: "rate_limited_ip" })
        return fail("RATE_LIMITED")
    }

    const loginName = readLoginName(input.account)
    if (loginName === "") {
        auditReset("reset_request", null, { reason: "account_missing" })
        return fail("ACCOUNT_NOT_FOUND")
    }

    // Same resolution as `/sp-auth/login`: username first, then any bound
    // platform identity (QQ number), so either one may be typed on the page.
    const account = resolveAccountByLoginNameSync(loginName)
    if (account === null) {
        auditReset("reset_request", null, { reason: "account_not_found" })
        return fail("ACCOUNT_NOT_FOUND")
    }

    const bindState = getAccountBindStateSync(account.id) ?? "pending"
    const qq = resolveBoundQq(account.id)
    if (bindState !== "active" || qq === null) {
        auditReset("reset_request", account.id, { reason: "no_qq_binding", bind_state: bindState })
        return fail("RESET_NO_QQ")
    }

    const previous = listPasswordResetCodesSync({ accountId: account.id, limit: 1 })[0]
    if (previous !== undefined && isWithinCodeIssueWindow(previous.createdAt, nowMs)) {
        auditReset("reset_request", account.id, {
            reason: "rate_limited",
            retry_after_ms: rateLimitRetryAfterMs(previous.createdAt, nowMs),
        })
        return fail("RATE_LIMITED")
    }

    const code = issuePasswordResetCode(account.id, env)
    const expiresInSec = Math.max(0, Math.round((code.expiresAt.getTime() - nowMs) / 1000))
    return ok({
        code: code.code,
        expiresInSec,
        account: account.username ?? loginName,
    })
}

/** `POST /sp-auth/reset-confirm` */
export function spResetConfirm(
    input: SpAuthResetConfirmBody,
): SpAuthResult<SpAuthResetConfirmData> {
    const password = input.password
    if (!isStrongPassword(password)) {
        // Never logged: only the fact that the check failed.
        auditReset("reset_password", null, { reason: "password_weak" })
        return fail("PASSWORD_WEAK")
    }

    const loginName = readLoginName(input.account)
    const account = loginName === "" ? null : resolveAccountByLoginNameSync(loginName)
    if (account === null) {
        auditReset("reset_password", null, { reason: "account_not_found" })
        return fail("ACCOUNT_NOT_FOUND")
    }

    const code = getPasswordResetCodeSync(readLoginName(input.code))
    if (code === null || code.accountId !== account.id) {
        auditReset("reset_password", account.id, { reason: "code_invalid" })
        return fail("RESET_CODE_INVALID")
    }
    if (code.status !== "pending" && code.status !== "confirmed") {
        auditReset("reset_password", account.id, { reason: `code_${code.status}`, code_id: code.id })
        return fail("RESET_CODE_INVALID")
    }
    if (code.expiresAt.getTime() <= getRealNowMs()) {
        incrementPasswordResetCodeAttemptsSync(code.id)
        auditReset("reset_password", account.id, { reason: "code_expired", code_id: code.id })
        return fail("CODE_EXPIRED")
    }
    if (code.attempts >= PASSWORD_RESET_CODE_MAX_ATTEMPTS) {
        auditReset("reset_password", account.id, {
            reason: "code_locked",
            code_id: code.id,
            attempts: code.attempts,
        })
        return fail("RATE_LIMITED")
    }
    if (code.confirmedAt === null) {
        const attempts = incrementPasswordResetCodeAttemptsSync(code.id)?.attempts
            ?? code.attempts + 1
        auditReset("reset_password", account.id, {
            reason: "reset_not_confirmed",
            code_id: code.id,
            attempts,
        })
        return attempts >= PASSWORD_RESET_CODE_MAX_ATTEMPTS
            ? fail("RATE_LIMITED")
            : fail("RESET_NOT_CONFIRMED")
    }

    updateAccountSync({ id: account.id, passwordHash: hashPassword(password) })
    consumePasswordResetCodeSync({ id: code.id, accountId: account.id, actor: SP_AUTH_AUDIT_ACTOR })
    // Old devices must log in again: kill the grants and the viewer session.
    // Player data is keyed by account_id (`src/data/domains/player.ts:490`), so
    // the save survives the lost session.
    const revokedGrants = clearDeviceGrantsForAccountSync(account.id)
    deleteAccountSessionsOfTypeSync(account.id, SessionType.VIEWER)

    auditReset("reset_password", account.id, {
        code_id: code.id,
        confirmed_qq: code.confirmedQq,
        revoked_grants: revokedGrants,
        viewer_session: "deleted",
    })
    return ok({ account: account.username ?? loginName })
}
