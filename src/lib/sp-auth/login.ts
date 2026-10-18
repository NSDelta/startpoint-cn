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
 *   - `active`   → issue the device grant and answer `{bound:true}`; when the
 *                  device is currently claimed by another account the credentials
 *                  win and the device is re-pointed here (2026-02 device rebind,
 *                  see `register.ts`'s header note)
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
import { claimReportedDevices, noteGateLogin } from "./device-follow"
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
    /**
     * Also outside C1 (client v5.25+): the **container** the gate runs in —
     * iOS `NSHomeDirectory()`'s last path segment, Android the app data dir.
     * The game reports the same segment inside its own `storage_directory_path`
     * at `/tool/signup`, which is how the two halves of one machine are joined
     * (see `device-follow.ts`). Older clients simply omit it and the join falls
     * back to the source IP.
     */
    client_key?: unknown
}

/** Per-request context the route layer owns (never part of the body). */
export type SpAuthRequestContext = import("./contract").SpAuthRequestContext

export async function spLogin(
    input: SpAuthLoginInput,
    env: NodeJS.ProcessEnv = process.env,
    ctx: SpAuthRequestContext = {},
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

    // One device maps to one account (CC-1), and the newest register/login wins
    // that mapping (2026-02,「允许注册并改绑本机」— see `register.ts`'s header note).
    // A correct username + password is therefore enough to re-point a device that
    // somebody else claimed: refusing here is what locked the real owner out after
    // a device change, and there is no credential-free way to prove ownership
    // anyway (the page token is device-scoped, so it survives a wipe as nothing).
    const deviceState = resolveDeviceState(deviceId)
    if (deviceState !== null && deviceState.accountId !== account.id) {
        const claimed = resolveGrantByToken(input.token, deviceId)
        const authorised = claimed !== null && claimed.accountId === account.id
        if (!authorised) {
            appendBindAuditSync({
                action: "login",
                accountId: account.id,
                detail: {
                    reason: "device_rebind",
                    device_id: deviceId,
                    previous_account_id: deviceState.accountId,
                    login_name: loginName,
                },
                actor: SP_AUTH_AUDIT_ACTOR,
                createdAt: getRealNow().toISOString(),
            })
        }
    }

    updateAccountSync({ id: account.id, lastLoginTime: getRealNow() })

    const grant = issueGrantForDevice(deviceId, account.id)
    insertDeviceBindingSync(deviceId, account.id)
    const viewerId = await ensureViewerSession(account.id)

    // 「并号」：这台机器上游戏用的那把设备号（`/tool/signup` 报到过），跟着这次登录改绑过来，
    // 并把号码回给客户端（v5.25 起客户端会直接采用它）。见 `device-follow.ts`。
    const clientKey = typeof input.client_key === "string" ? input.client_key : null
    noteGateLogin({ accountId: account.id, ip: ctx.ip, key: clientKey })
    const claimed = claimReportedDevices({
        accountId: account.id,
        ip: ctx.ip,
        key: clientKey,
        loginName,
        env,
    })

    appendBindAuditSync({
        action: "login",
        accountId: account.id,
        detail: {
            device_id: deviceId,
            result: "ok",
            login_name: loginName,
            followed_device_ids: claimed,
        },
        actor: SP_AUTH_AUDIT_ACTOR,
        createdAt: getRealNow().toISOString(),
    })

    return ok({
        token: grant.token,
        viewer_id: viewerId,
        username: account.username ?? loginName,
        bound: true,
        ...(claimed.length > 0 ? { game_device_id: claimed[0] } : {}),
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
