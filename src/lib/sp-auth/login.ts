/**
 * `POST /sp-auth/login` — contract C1.
 *
 * `login_name` resolution order is fixed by C1: `account_bindings.platform_uid`
 * (QQ/KOOK id) first, then `accounts.username` — both live behind
 * `resolveAccountByLoginNameSync` in the P2 layer.
 *
 * Status handling:
 *   - `disabled` → `ACCOUNT_DISABLED`
 *   - `pending`  → `BIND_REQUIRED` + `data:{code, code_expires_at}` so the page
 *                  can show (or re-issue) the pending verification code
 *   - `active`   → issue the device grant and answer `{bound:true}`
 */

import {
    appendBindAuditSync,
    getAccountBindStateSync,
    resolveAccountByLoginNameSync,
} from "../../data/domains/account-binding"
import { updateAccountSync } from "../../data/domains/account"
import { insertDeviceBindingSync } from "../../data/domains/session"
import type { BindState } from "../../data/types"
import {
    SP_AUTH_AUDIT_ACTOR,
    activeCodeViewForAccount,
    issueSignupCode,
    toCodeView,
} from "../../lib/signup-code"
import { getRealNow } from "../../runtime/time/game-time"
import { parseDeviceId } from "./contract"
import type { SpAuthCodeView, SpAuthLoginData } from "./contract"
import { verifyPasswordHash } from "./password"
import { fail, ok } from "./result"
import type { SpAuthResult } from "./result"
import { resolveDeviceState } from "./register"
import { ensureViewerSession } from "./session-viewer"
import { issueGrantForDevice, resolveGrantByToken } from "./token"

export interface SpAuthLoginInput {
    login_name?: unknown
    password?: unknown
    device_id?: unknown
    /**
     * Not part of the C1 request table: the page token, accepted as the
     * "this device is mine" proof when the device is already claimed.
     */
    token?: unknown
}

export async function spLogin(
    input: SpAuthLoginInput,
    env: NodeJS.ProcessEnv = process.env,
): Promise<SpAuthResult<SpAuthLoginData, SpAuthCodeView>> {
    const loginName = typeof input.login_name === "string" ? input.login_name.trim() : ""
    const password = typeof input.password === "string" ? input.password : ""
    const deviceId = parseDeviceId(input.device_id)

    if (loginName.length === 0 || password.length === 0) {
        auditReject(null, { reason: "missing_credentials" })
        return fail("BAD_CREDENTIALS")
    }
    if (deviceId === null) {
        auditReject(null, { reason: "device_id_invalid" })
        return fail("BAD_CREDENTIALS")
    }

    const account = resolveAccountByLoginNameSync(loginName)
    if (account === null) {
        auditReject(null, { reason: "account_not_found", login_name: loginName })
        return fail("BAD_CREDENTIALS")
    }

    if (!verifyPasswordHash(password, account.passwordHash)) {
        auditReject(account.id, { reason: "bad_password" })
        return fail("BAD_CREDENTIALS")
    }

    if (account.status === "disabled") {
        auditReject(account.id, { reason: "account_disabled" })
        return fail("ACCOUNT_DISABLED")
    }

    const bindState = bindStateOf(account.id)

    // CC-1: `disabled` 优先于「未绑定」——被管理员停用的账号一律 ACCOUNT_DISABLED，
    // 不得退化成 BIND_REQUIRED 而把账号重新拖回待绑定流程。
    if (bindState === "disabled") {
        auditReject(account.id, { reason: "account_disabled" })
        return fail("ACCOUNT_DISABLED")
    }

    if (bindState !== "active") {
        // C1: pending accounts get the code back so the page can resume polling.
        const view = codeViewFor(account.id, env)
        if (view === null) {
            auditReject(account.id, { reason: "bind_required_no_code" })
            return fail("BIND_REQUIRED")
        }
        appendBindAuditSync({
            action: "login",
            accountId: account.id,
            detail: { device_id: deviceId, result: "bind_required" },
            actor: SP_AUTH_AUDIT_ACTOR,
            createdAt: getRealNow().toISOString(),
        })
        return fail("BIND_REQUIRED", view)
    }

    // One device maps to one account (CC-1). The page token is the only
    // credential that can re-point a device, so require it when the device is
    // already claimed by somebody else.
    const deviceState = resolveDeviceState(deviceId)
    if (deviceState !== null && deviceState.accountId !== account.id) {
        const claimed = resolveGrantByToken(input.token, deviceId)
        const authorised = claimed !== null && claimed.accountId === account.id
        if (!authorised) {
            auditReject(account.id, {
                reason: "device_taken",
                device_id: deviceId,
                occupying_account_id: deviceState.accountId,
            })
            return fail("DEVICE_TAKEN")
        }
    }

    updateAccountSync({ id: account.id, lastLoginTime: getRealNow() })

    const grant = issueGrantForDevice(deviceId, account.id)
    insertDeviceBindingSync(deviceId, account.id)
    const viewerId = await ensureViewerSession(account.id)

    appendBindAuditSync({
        action: "login",
        accountId: account.id,
        detail: { device_id: deviceId, result: "ok", login_name: loginName },
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })

    return ok({
        token: grant.token,
        viewer_id: viewerId,
        username: account.username ?? loginName,
        bound: true,
    })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `pending` is the safe default when the column is unreadable. */
function bindStateOf(accountId: number): BindState {
    return getAccountBindStateSync(accountId) ?? "pending"
}

/** Current code view, issuing one when the pending account has none left. */
function codeViewFor(accountId: number, env: NodeJS.ProcessEnv): SpAuthCodeView | null {
    const active = activeCodeViewForAccount(accountId)
    if (active !== null) return toCodeView(active)
    const issued = issueSignupCode(accountId, env)
    return issued.ok ? issued.view : null
}

function auditReject(accountId: number | null, detail: Record<string, unknown>): void {
    appendBindAuditSync({
        action: "gate_reject",
        accountId,
        detail,
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })
}
