/**
 * Signup-code policy for `/sp-auth/*` (contract C1 item 4, C7 code set).
 *
 * The code value itself, its uniqueness and its lifecycle live in the P2 data
 * layer (`src/data/domains/account-binding.ts`). This module owns the
 * *policy* the API has to apply on top of it:
 *
 *   - how long a code lives (`SIGNUP_CODE_TTL_MINUTES`, default 30);
 *   - the per-device 60 s re-issue window (CC-1 "同设备 60 秒内只允许一次");
 *   - revocation of the previous code (one live code per account, CC-1);
 *   - `bind_audit` bookkeeping for the code we handed out.
 */

import {
    createSignupCodeSync,
    getActiveSignupCodeSync,
} from "../data/domains/account-binding"
import type { SignupCode } from "../data/types"
import { getRealNowMs } from "../runtime/time/game-time"
import { SP_AUTH_ERROR_CODES } from "./sp-auth/contract"
import type { SpAuthCodeView } from "./sp-auth/contract"

/** Fallback TTL when `SIGNUP_CODE_TTL_MINUTES` is absent or unparsable. */
export const SP_AUTH_DEFAULT_CODE_TTL_MINUTES = 30

/** Upper bound keeps a fat-fingered env value from creating eternal codes. */
export const SP_AUTH_MAX_CODE_TTL_MINUTES = 7 * 24 * 60

/** CC-1: the same device may only ask for a fresh code once per 60 s. */
export const SP_AUTH_CODE_ISSUE_WINDOW_MS = 60_000

/** Actor recorded in `bind_audit` for everything this API does. */
export const SP_AUTH_AUDIT_ACTOR = "sp-auth"

/**
 * Reads `SIGNUP_CODE_TTL_MINUTES` with the injectable-env pattern from
 * `src/lib/udid-probe.ts:117-126` — never through `src/runtime/config.ts`
 * (contract C9 / CC-4).
 */
export function resolveSignupCodeTtlMinutes(env: NodeJS.ProcessEnv = process.env): number {
    const raw = (env.SIGNUP_CODE_TTL_MINUTES ?? "").trim()
    if (raw.length === 0) return SP_AUTH_DEFAULT_CODE_TTL_MINUTES
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return SP_AUTH_DEFAULT_CODE_TTL_MINUTES
    return Math.min(parsed, SP_AUTH_MAX_CODE_TTL_MINUTES)
}

/** Wire view of a code: exactly the `code` + `code_expires_at` pair of C1. */
export function toCodeView(code: SignupCode): SpAuthCodeView {
    return { code: code.code, code_expires_at: code.expiresAt.toISOString() }
}

export interface SpAuthCodeIssueFailure {
    ok: false
    code: typeof SP_AUTH_ERROR_CODES[number]
}

export type SpAuthCodeIssueResult =
    | { ok: true; code: SignupCode; view: SpAuthCodeView }
    | SpAuthCodeIssueFailure

/**
 * Issues a fresh code for an account: revokes the previous pending one, resets
 * the TTL and writes the `issue_code` audit row (the data layer writes
 * `revoke_code` when it actually revokes something).
 */
export function issueSignupCode(
    accountId: number,
    env: NodeJS.ProcessEnv = process.env,
): SpAuthCodeIssueResult {
    const ttlMinutes = resolveSignupCodeTtlMinutes(env)
    const code = createSignupCodeSync({
        accountId,
        ttlMinutes,
        actor: SP_AUTH_AUDIT_ACTOR,
    })
    return { ok: true, code, view: toCodeView(code) }
}

/** `null` when the account has no live (pending + unexpired) code. */
export function activeCodeViewForAccount(accountId: number): SignupCode | null {
    return getActiveSignupCodeSync(accountId)
}

/**
 * True while the last code we handed out is still inside the per-device
 * re-issue window. `/sp-auth/resend` uses it; `register` only applies it to the
 * CC-1 "pending + code still alive" branch.
 */
export function isWithinCodeIssueWindow(
    lastIssuedAt: Date | null | undefined,
    nowMs: number = getRealNowMs(),
): boolean {
    if (!lastIssuedAt) return false
    return nowMs - lastIssuedAt.getTime() < SP_AUTH_CODE_ISSUE_WINDOW_MS
}

/** Machine-readable hint for the ops log when a request is throttled. */
export function rateLimitRetryAfterMs(
    lastIssuedAt: Date | null | undefined,
    nowMs: number = getRealNowMs(),
): number {
    if (!lastIssuedAt) return 0
    return Math.max(0, SP_AUTH_CODE_ISSUE_WINDOW_MS - (nowMs - lastIssuedAt.getTime()))
}
