/**
 * Device-grant token handling for `/sp-auth/*` (contract C1).
 *
 * C1: `token` is 32 random bytes hex, lives in `device_grants.token`, and is
 * used **only** by the login page (poll / resend / profile / logout) — it is
 * never injected into game requests. The grant itself is owned by the P2 data
 * layer; this module only resolves and issues it.
 *
 * TTL (contract 3.2, revised 2026-10-01): 15 days of **inactivity**, sliding.
 * Each authenticated `/sp-auth/*` call re-arms it to "last seen + 15 days"
 * (`src/lib/sp-auth/token-ops.ts`), so an active player never has to log in
 * again while a device idle for 15 straight days does. Renewal never rotates
 * the token string.
 *
 * NOTE (fragment for integration): resolving a grant **by token** belongs in
 * the data layer. P2 shipped `getDeviceGrantSync(device_id)` only, so this
 * module carries a single read-only lookup (`findGrantByToken`) that the P2
 * fragment in `D:\wfcnmod\交付片段\p3\` replaces verbatim with an indexed
 * query. No write of any kind happens here.
 */

import { timingSafeEqual } from "crypto"
import {
    clearDeviceGrantSync,
    getDeviceGrantSync,
    upsertDeviceGrantSync,
} from "../../data/domains/account-binding"
import { getDb } from "../../data/db"
import type { DeviceGrant, RawDeviceGrant } from "../../data/types"
import { getRealNowMs } from "../../runtime/time/game-time"
import {
    SP_AUTH_TOKEN_BYTES,
    parseDeviceId,
    parseToken,
} from "./contract"

export interface ResolvedGrant {
    grant: DeviceGrant
    accountId: number
    /** True when resolution came from the `device_id` fallback, not the token. */
    viaDeviceId: boolean
}

/** Constant-time token compare; falls back to a plain compare on length mismatch. */
export function tokensMatch(expected: string, provided: string): boolean {
    const left = Buffer.from(expected, "utf8")
    const right = Buffer.from(provided, "utf8")
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
}

/**
 * Read-only token → grant lookup. `deviceIdHint` is an optimisation only (the
 * client knows its own device id after register/login); the full scan is the
 * contract-compatible path, because C1's token endpoints send `{token}` alone.
 *
 * MOVE TO DATA LAYER: see the P2 fragment — the ledger expects exactly this
 * query as `getDeviceGrantByTokenSync(token)` next to `getDeviceGrantSync`.
 */
function findGrantByToken(token: string, deviceIdHint: number | null): DeviceGrant | null {
    const db = getDb()
    const columns = "device_id, account_id, token, expires_at, created_at, updated_at"

    if (deviceIdHint !== null) {
        const hinted = db
            .prepare(`SELECT ${columns} FROM device_grants WHERE device_id = ?`)
            .get(deviceIdHint) as RawDeviceGrant | undefined
        if (hinted !== undefined && tokensMatch(hinted.token, token)) {
            return toDeviceGrant(hinted)
        }
        return null
    }

    // No hint: the client only sent a token, which is what C1 specifies.
    const rows = db
        .prepare(`SELECT ${columns} FROM device_grants`)
        .all() as RawDeviceGrant[]
    for (const row of rows) {
        if (tokensMatch(row.token, token)) return toDeviceGrant(row)
    }
    return null
}

/** Mirrors the data layer's own `buildDeviceGrant` mapping. */
function toDeviceGrant(raw: RawDeviceGrant): DeviceGrant {
    return {
        deviceId: raw.device_id,
        accountId: raw.account_id,
        token: raw.token,
        expiresAt: new Date(raw.expires_at),
        createdAt: new Date(raw.created_at),
        updatedAt: new Date(raw.updated_at),
    }
}

/**
 * Resolves the grant a page token refers to.
 *
 * The token is always verified against the stored grant with a constant-time
 * compare, so this is a lookup path, never an authentication bypass. A caller
 * that also supplies `device_id` gets the indexed lookup; C1's token-only
 * requests get the scan.
 */
export function resolveGrantByToken(
    tokenValue: unknown,
    deviceIdHint?: unknown,
): ResolvedGrant | null {
    const token = parseToken(tokenValue)
    if (token === null) return null

    const deviceId = parseDeviceId(deviceIdHint)
    const grant = findGrantByToken(token, deviceId)
    if (grant === null) return null
    return { grant, accountId: grant.accountId, viaDeviceId: deviceId !== null }
}

/** True when the grant is still inside its 15 day inactivity window. */
export function isGrantActive(grant: DeviceGrant, nowMs: number = getRealNowMs()): boolean {
    return grant.expiresAt.getTime() > nowMs
}

/**
 * Issues (or refreshes) the grant a device logs in with. The data layer
 * generates the token (`randomBytes(32).toString("hex")`) and applies the 15 day
 * TTL, so this is a thin wrapper that keeps the TTL policy in one place. This is
 * the **login** path, which mints a new credential on purpose — activity-based
 * renewal of an existing token goes through `refreshDeviceGrantExpirySync`
 * (see `src/lib/sp-auth/token-ops.ts`).
 */
export function issueGrantForDevice(deviceId: number, accountId: number): DeviceGrant {
    return upsertDeviceGrantSync({ deviceId, accountId })
}

/** Logout: drop the grant so the token dies with it. Already-gone is fine. */
export function revokeGrantForDevice(deviceId: unknown): boolean {
    const parsed = parseDeviceId(deviceId)
    if (parsed === null) return false
    return clearDeviceGrantSync(parsed)
}

/** Token byte length, re-exported for the ops log and tests. */
export const SP_AUTH_TOKEN_HEX_LENGTH = SP_AUTH_TOKEN_BYTES * 2
