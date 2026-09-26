/**
 * Token-addressed `/sp-auth/*` operations: `bind-status`, `resend`, `profile`
 * and `logout` (contract C1).
 *
 * All four are driven by the page `token` (32 byte hex, C1) and share one
 * resolution step. Because the P2 layer has no "grant by token" query yet, the
 * optional `device_id` field lets the client (which knows its own device id)
 * reach the grant; see `src/lib/sp-auth/token.ts` for the fragment note.
 *
 * `device_id` is a lookup hint only — the token is always compared against the
 * stored grant with `crypto.timingSafeEqual`, so supplying it can never turn
 * into an authorisation bypass.
 */

import {
    appendBindAuditSync,
    getAccountBindStateSync,
    getPrimaryBindingSync,
} from "../../data/domains/account-binding"
import { getAccountSync, getAccountPlayersSync } from "../../data/domains/account"
import { getPlayerSync } from "../../data/domains/player"
import { getViewerIdSync } from "../../data/domains/session"
import type { AccountBinding } from "../../data/types"
import {
    SP_AUTH_AUDIT_ACTOR,
    activeCodeViewForAccount,
    isWithinCodeIssueWindow,
    issueSignupCode,
    rateLimitRetryAfterMs,
    toCodeView,
} from "../../lib/signup-code"
import { getRealNow } from "../../runtime/time/game-time"
import { maskPlatformUid } from "./contract"
import type {
    SpAuthBindStatusData,
    SpAuthLogoutData,
    SpAuthProfileData,
    SpAuthResendData,
    SpAuthTokenBody,
} from "./contract"
import { fail, ok } from "./result"
import type { SpAuthResult } from "./result"
import { isGrantActive, resolveGrantByToken, revokeGrantForDevice } from "./token"

interface ResolvedToken {
    accountId: number
    deviceId: number
    token: string
}

/**
 * Resolves `{token, device_id?}` to a live grant. Expired grants are refused so
 * the page falls back to the login screen (C1 `TOKEN_INVALID`).
 */
function resolveToken(input: SpAuthTokenBody & { device_id?: unknown }): ResolvedToken | null {
    const resolved = resolveGrantByToken(input.token, input.device_id)
    if (resolved === null) return null
    if (!isGrantActive(resolved.grant)) return null
    return {
        accountId: resolved.accountId,
        deviceId: resolved.grant.deviceId,
        token: resolved.grant.token,
    }
}

// ---------------------------------------------------------------------------
// bind-status
// ---------------------------------------------------------------------------

export function spBindStatus(
    input: SpAuthTokenBody & { device_id?: unknown },
): SpAuthResult<SpAuthBindStatusData> {
    const resolved = resolveToken(input)
    if (resolved === null) {
        auditReject(null, "bind_status", { reason: "token_invalid" })
        return fail("TOKEN_INVALID")
    }

    const viewerId = getViewerIdSync(resolved.accountId)
    const bindState = getAccountBindStateSync(resolved.accountId)
    const activeCode = activeCodeViewForAccount(resolved.accountId)
    const bound = bindState === "active"

    return ok({
        bound,
        code: bound || activeCode === null ? null : activeCode.code,
        code_expires_at: bound || activeCode === null ? null : activeCode.expiresAt.toISOString(),
        // `viewer_id` is optional in C1, but the page needs it right after the
        // bot completes the binding. Omit it while unbound to keep the payload
        // from looking like a finished identity.
        ...(viewerId > 0 ? { viewer_id: viewerId } : {}),
    })
}

// ---------------------------------------------------------------------------
// resend
// ---------------------------------------------------------------------------

export function spResend(
    input: SpAuthTokenBody & { device_id?: unknown },
    env: NodeJS.ProcessEnv = process.env,
): SpAuthResult<SpAuthResendData> {
    const resolved = resolveToken(input)
    if (resolved === null) {
        auditReject(null, "resend", { reason: "token_invalid" })
        return fail("TOKEN_INVALID")
    }

    const previous = activeCodeViewForAccount(resolved.accountId)
    if (previous !== null && isWithinCodeIssueWindow(previous.createdAt)) {
        auditReject(resolved.accountId, "resend", {
            reason: "rate_limited",
            retry_after_ms: rateLimitRetryAfterMs(previous.createdAt),
        })
        return fail("RATE_LIMITED")
    }

    const issued = issueSignupCode(resolved.accountId, env)
    if (!issued.ok) return fail("RATE_LIMITED")

    appendBindAuditSync({
        action: "issue_code",
        accountId: resolved.accountId,
        detail: {
            device_id: resolved.deviceId,
            code_id: issued.code.id,
            trigger: "resend",
            replaced_code_id: previous?.id ?? null,
        },
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })

    return ok(issued.view)
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

export function spProfile(
    input: SpAuthTokenBody & { device_id?: unknown },
): SpAuthResult<SpAuthProfileData> {
    const resolved = resolveToken(input)
    if (resolved === null) {
        auditReject(null, "profile", { reason: "token_invalid" })
        return fail("TOKEN_INVALID")
    }

    const account = getAccountSync(resolved.accountId)
    if (account === null) {
        auditReject(resolved.accountId, "profile", { reason: "account_missing" })
        return fail("TOKEN_INVALID")
    }

    const bindState = getAccountBindStateSync(account.id) ?? "pending"
    const primary = getPrimaryBindingSync(account.id)
    const activeCode = activeCodeViewForAccount(account.id)
    const player = firstPlayer(account.id)

    return ok({
        viewer_id: getViewerIdSync(account.id),
        username: account.username ?? "",
        bound: bindState === "active",
        bind_state: bindState,
        platform: bindingPlatformOf(primary),
        platform_uid_masked: maskPlatformUid(primary?.platformUid ?? null),
        display_name: primary?.displayName ?? null,
        bound_at: primary?.createdAt.toISOString() ?? null,
        code: bindState === "active" ? null : activeCode?.code ?? null,
        code_expires_at: bindState === "active"
            ? null
            : activeCode?.expiresAt.toISOString() ?? null,
        player_name: player?.name ?? null,
        rank_point: player?.rankPoint ?? 0,
        leader_character_id: player?.leaderCharacterId ?? 0,
    })
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

export function spLogout(
    input: SpAuthTokenBody & { device_id?: unknown },
): SpAuthResult<SpAuthLogoutData> {
    const resolved = resolveToken(input)
    if (resolved === null) {
        // C1 defines no failure code for logout; a stale token is already
        // "logged out", so answer success instead of stranding the page.
        return ok({})
    }

    revokeGrantForDevice(resolved.deviceId)
    // NOTE(contract): `BindAuditAction` has no "logout" verb (C2 list), so the
    // token revocation is recorded as a `gate_reject` carrying `reason:logout`.
    appendBindAuditSync({
        action: "gate_reject",
        accountId: resolved.accountId,
        detail: { reason: "logout", device_id: resolved.deviceId },
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })
    return ok({})
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstPlayer(accountId: number) {
    const playerIds = getAccountPlayersSync(accountId)
    const playerId = playerIds.length > 0 ? playerIds[0] : undefined
    if (playerId === undefined) return null
    return getPlayerSync(playerId)
}

function bindingPlatformOf(binding: AccountBinding | null) {
    return binding?.platform ?? null
}

function auditReject(
    accountId: number | null,
    endpoint: string,
    detail: Record<string, unknown>,
): void {
    appendBindAuditSync({
        action: "gate_reject",
        accountId,
        detail: { ...detail, endpoint },
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })
}
