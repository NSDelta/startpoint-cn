/**
 * VIEWER session bridge for `/sp-auth/*`.
 *
 * The repo has exactly one viewer identity mechanism: a `sessions` row of type
 * `SessionType.VIEWER` whose **token is `String(viewerId)`**
 * (`src/routes/cn/tool.ts:125-135`). C1 deliberately reuses it instead of
 * inventing a second token table, so registration/login materialise the same
 * row the game signup path would.
 */

import {
    deleteAccountSessionsOfTypeSync,
    getViewerIdSync,
    insertSessionWithToken,
} from "../../data/domains/session"
import { SessionType } from "../../data/types"
import type { Session } from "../../data/types"
import { generateViewerId } from "../../utils"
import { getRealNowMs } from "../../runtime/time/game-time"

/** Same nominal lifetime the existing signup path stamps on a VIEWER session. */
const VIEWER_SESSION_NOMINAL_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Returns the account's existing `viewer_id`, or mints one. The in-memory
 * `viewerIdToAccountId` map used by `src/routes/cn/tool.ts:35` is intentionally
 * not touched: that map dies on restart and the database session row is the
 * durable lookup every other path already uses.
 */
export async function ensureViewerSession(accountId: number): Promise<number> {
    const existing = getViewerIdSync(accountId)
    if (existing > 0) return existing

    const viewerId = generateViewerId()
    const session: Session = {
        token: String(viewerId),
        accountId,
        expires: new Date(getRealNowMs() + VIEWER_SESSION_NOMINAL_MS),
        type: SessionType.VIEWER,
    }
    await insertSessionWithToken(session)
    return viewerId
}

/** Replaces any existing VIEWER session with a freshly minted identity. */
export async function rotateViewerSession(accountId: number): Promise<number> {
    deleteAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)
    return ensureViewerSession(accountId)
}
