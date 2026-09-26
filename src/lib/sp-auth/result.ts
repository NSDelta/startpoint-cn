/**
 * Result plumbing shared by the `/sp-auth/*` operations.
 *
 * Operations return a discriminated result instead of throwing so the route
 * layer stays a pure envelope mapper: every business outcome — success or
 * C7 error — is a value, and only a genuine internal fault escapes as an
 * exception (the route turns that into `SERVICE_UNAVAILABLE`).
 */

import { SP_AUTH_ERROR_MESSAGES } from "./contract"
import type { SpAuthErrorCode } from "./contract"

export type SpAuthResult<TData, TFailureData = undefined> =
    | { ok: true; data: TData }
    | { ok: false; code: SpAuthErrorCode; data?: TFailureData }

/** Success constructor keeps the generic noise out of the operations. */
export function ok<TData>(data: TData): { ok: true; data: TData } {
    return { ok: true, data }
}

/**
 * Failure constructor. The no-`data` overload matters: `spLogin` returns
 * `{code, data?: SpAuthCodeView}` and must still be able to answer a plain
 * `BAD_CREDENTIALS` without inventing a payload.
 *
 * `data` is omitted (never set to `undefined`) so a plain failure serialises as
 * exactly `{ok,code,message}` — C1 only defines `data` for `DEVICE_TAKEN` and
 * `BIND_REQUIRED`.
 */
export function fail(code: SpAuthErrorCode): { ok: false; code: SpAuthErrorCode }
export function fail<TFailureData>(
    code: SpAuthErrorCode,
    data: TFailureData,
): { ok: false; code: SpAuthErrorCode; data: TFailureData }
export function fail<TFailureData>(
    code: SpAuthErrorCode,
    data?: TFailureData,
): { ok: false; code: SpAuthErrorCode; data?: TFailureData } {
    return data === undefined ? { ok: false, code } : { ok: false, code, data }
}

/** C7 wording, used by the route when it builds the failure envelope. */
export function messageFor(code: SpAuthErrorCode): string {
    return SP_AUTH_ERROR_MESSAGES[code]
}
