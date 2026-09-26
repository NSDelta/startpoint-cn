/**
 * `POST /sp-auth/register` — contract C1 + CC-1 device decision matrix.
 *
 * CC-1 matrix implemented here, in order:
 *
 * | device_grants.device_id | behaviour                                     |
 * |-------------------------|-----------------------------------------------|
 * | no mapping              | create `pending` account, issue code + grant  |
 * | → pending, code alive   | reuse the SAME account, revoke old code, new  |
 * |                         | code, TTL reset, ≤1 per 60 s → RATE_LIMITED   |
 * | → pending, code dead    | reuse that `pending` account, new code        |
 * | → active                | DEVICE_TAKEN + `{username, viewer_id}`, never |
 * |                         | any credential                                |
 * | → disabled              | ACCOUNT_DISABLED                              |
 *
 * A conflicting `udid` header never wins: C1 fixes `body.device_id` as the
 * identity, because iOS reports the same synthetic UDID for every device.
 */

import bcrypt from "bcryptjs"
import {
    appendBindAuditSync,
    getAccountByDeviceSync,
    getDeviceGrantSync,
    resolveAccountByLoginNameSync,
    setAccountBindStateSync,
} from "../../data/domains/account-binding"
import {
    getAccountSync,
    insertAccountSync,
    updateAccountSync,
} from "../../data/domains/account"
import { insertDefaultPlayerSync } from "../../data/domains/player"
import { getViewerIdSync, insertDeviceBindingSync } from "../../data/domains/session"
import type { BindState } from "../../data/types"
import {
    SP_AUTH_AUDIT_ACTOR,
    activeCodeViewForAccount,
    isWithinCodeIssueWindow,
    issueSignupCode,
} from "../../lib/signup-code"
import { getRealNow } from "../../runtime/time/game-time"
import {
    isValidUsername,
    isStrongPassword,
    parseDeviceId,
} from "./contract"
import type {
    SpAuthDeviceTakenData,
    SpAuthRegisterData,
} from "./contract"
import { fail, ok } from "./result"
import type { SpAuthResult } from "./result"
import { ensureViewerSession } from "./session-viewer"
import { issueGrantForDevice } from "./token"

export interface SpAuthDeviceState {
    deviceId: number
    accountId: number
    bindState: BindState
    grantExpiresAt: Date
    /** True when the stored grant itself is past its 30 day window. */
    grantExpired: boolean
}

/**
 * Reads the CC-1 row for a device. `getAccountByDeviceSync` deliberately does
 * not judge grant expiry (P2 note), so the caller compares the timestamp.
 */
export function resolveDeviceState(deviceId: number): SpAuthDeviceState | null {
    const mapping = getAccountByDeviceSync(deviceId)
    if (mapping === null) return null
    const grantExpiresAt = new Date(mapping.grant_expires_at)
    return {
        deviceId,
        accountId: mapping.account_id,
        bindState: mapping.bind_state,
        grantExpiresAt,
        grantExpired: grantExpiresAt.getTime() <= getRealNow().getTime(),
    }
}

export interface SpAuthRegisterInput {
    username?: unknown
    password?: unknown
    device_id?: unknown
    version?: unknown
}

/** Account shape created by this API: no IdP, credentials live in `accounts`. */
function createPendingAccount(deviceId: number, username: string, passwordHash: string) {
    const now = getRealNow()
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "sp_auth",
        idpId: `sp:${deviceId}:${now.getTime()}`,
        status: "normal",
        username,
        passwordHash,
    })
    setAccountBindStateSync(account.id, "pending", SP_AUTH_AUDIT_ACTOR)
    insertDefaultPlayerSync(account.id)
    return account
}

export async function spRegister(
    input: SpAuthRegisterInput,
    env: NodeJS.ProcessEnv = process.env,
): Promise<SpAuthResult<SpAuthRegisterData, SpAuthDeviceTakenData>> {
    const username = typeof input.username === "string" ? input.username.trim() : ""
    const password = typeof input.password === "string" ? input.password : ""
    const deviceId = parseDeviceId(input.device_id)
    const version = typeof input.version === "string" ? input.version : null

    // Field validation happens before any write so a bad request never leaves
    // an orphan `pending` account behind.
    if (!isValidUsername(username)) {
        return fail("USERNAME_INVALID")
    }
    if (!isStrongPassword(password)) {
        return fail("PASSWORD_WEAK")
    }
    if (deviceId === null) {
        // C1 has no "missing device" code for this endpoint; the closest
        // declared one keeps the client on a code path it already implements.
        auditReject("register", null, { reason: "device_id_invalid", version })
        return fail("RATE_LIMITED")
    }

    // Usernames are unique per account independent of any device mapping.
    const existingByName = resolveAccountByLoginNameSync(username)
    if (existingByName !== null) {
        auditReject("register", existingByName.id, { reason: "username_taken", version })
        return fail("USERNAME_TAKEN")
    }

    const state = resolveDeviceState(deviceId)

    if (state !== null && state.bindState === "disabled") {
        auditReject("register", state.accountId, { reason: "account_disabled", version })
        return fail("ACCOUNT_DISABLED")
    }

    if (state !== null && state.bindState === "active") {
        // CC-1: refuse and hand back only non-credential identifying data.
        const occupying = getAccountSync(state.accountId)
        const viewerId = getViewerIdSync(state.accountId)
        auditReject("register", state.accountId, { reason: "device_taken", version })
        return fail("DEVICE_TAKEN", {
            username: occupying?.username ?? null,
            viewer_id: viewerId,
        })
    }

    // --- CC-1 branch: no mapping, or an existing `pending` mapping ---------
    let accountId: number
    let created = false

    if (state === null) {
        const passwordHash = bcrypt.hashSync(password, 10)
        const account = createPendingAccount(deviceId, username, passwordHash)
        accountId = account.id
        created = true
    } else {
        accountId = state.accountId
        // Reuse the pending account instead of spawning duplicates. Idempotent
        // re-register only refreshes the credentials when the code already died,
        // which is exactly CC-1's "过期/被吊销" branch.
        const account = getAccountSync(accountId)
        if (account === null) {
            auditReject("register", accountId, { reason: "pending_account_missing", version })
            return fail("RATE_LIMITED")
        }
        if (state.grantExpired) {
            updateAccountSync({
                id: accountId,
                username,
                passwordHash: bcrypt.hashSync(password, 10),
            })
        }
    }

    // CC-1 rate limit: "pending + code still alive" may only be refreshed once
    // per 60 s. An expired/revoked code is always refreshable.
    if (!created) {
        const previous = activeCodeViewForAccount(accountId)
        if (previous !== null && isWithinCodeIssueWindow(previous.createdAt)) {
            auditReject("register", accountId, { reason: "rate_limited", version })
            return fail("RATE_LIMITED")
        }
    }

    const issued = issueSignupCode(accountId, env)
    if (!issued.ok) {
        return fail("RATE_LIMITED")
    }

    // Keep a still-valid page token: re-registering from the same device must be
    // idempotent, otherwise the page that is polling with the stored token would
    // be logged out by its own retry. A fresh token is minted only when the
    // device had no grant or the grant already expired (CC-1 "已过期/被吊销").
    const grant = state !== null && !state.grantExpired
        ? getDeviceGrantSync(deviceId) ?? issueGrantForDevice(deviceId, accountId)
        : issueGrantForDevice(deviceId, accountId)
    insertDeviceBindingSync(deviceId, accountId)
    const viewerId = await ensureViewerSession(accountId)

    appendBindAuditSync({
        action: "register",
        accountId,
        detail: {
            device_id: deviceId,
            created,
            reused_pending: !created,
            code_id: issued.code.id,
            version,
        },
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })

    return ok({
        token: grant.token,
        code: issued.view.code,
        code_expires_at: issued.view.code_expires_at,
        viewer_id: viewerId,
        username,
    })
}

// ---------------------------------------------------------------------------
// helpers kept local so the module reads top-down
// ---------------------------------------------------------------------------

function auditReject(
    action: "register" | "gate_reject",
    accountId: number | null,
    detail: Record<string, unknown>,
): void {
    appendBindAuditSync({
        action,
        accountId,
        detail,
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })
}
