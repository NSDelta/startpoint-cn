// In-process registry for bell (attention) co-op recruitment.
//
// A recruitment is created the first time a room host asks the server to share
// the room with `share_type_list: [3]` (the client's "random recruitment" share
// type) and refreshed on every later share. It is deliberately process-local:
// the design keeps recruitment state tied to the live room in this node and
// never persists it, so a restart or a Hub handover simply drops pending bells.
//
// See docs/systems/random-recruitment.md for the wire contract. The two numbers
// below mirror the client's own attention configuration, which the game applies
// from the `/attention/check` `config` block:
//   attention_recruitment_interval_seconds = 15  -> the host redelivers every 15s
//   attention_recruitment_redeliver_limit  = 20  -> and gives up after 20 sends
// The host device stops re-sharing at that limit, so the server must stop
// advertising the room at the same point instead of keeping a dead bell alive.
export const RECRUITMENT_REDELIVER_INTERVAL_MS = 15_000
export const RECRUITMENT_REDELIVER_LIMIT = 20

// The host's first `share_room` can land a moment before its own local clock
// reaches the entry time it reports, so allow a small negative skew.
const VISIBLE_SKEW_MS = 5_000

// A bell outlives its last refresh by this much. During steady-state
// recruitment the host refreshes every 15s; 30s covers one missed refresh plus
// polling jitter before guests stop seeing a room that is no longer advertised.
const VISIBLE_TAIL_MS = 30_000

export const RECRUITMENT_VISIBLE_WINDOW_MS = VISIBLE_TAIL_MS

export interface RecruitmentRecord {
    readonly roomNumber: string
    readonly hostViewerId: number
    readonly category: number
    readonly questId: number
    readonly attentionKey: string
    /** Server-clock ms of the first share; also the recruitment's birth. */
    readonly firstSharedAtMs: number
    /** Server-clock ms of the most recent share. */
    lastSharedAtMs: number
    /** How many times the host has asked us to advertise this room. */
    shareCount: number
}

export interface ShareWindowInput {
    readonly recruited: boolean
    readonly nowMs: number
    readonly room: {
        readonly roomNumber: string
        readonly category: number
        readonly questId: number
        readonly hostViewerId: number
    }
}

function createAttentionKey(sequence: number, nowMs: number): string {
    const entropy = Math.floor(Math.random() * 0x1_0000_0000)
        .toString(16)
        .padStart(8, "0")
    return `wfcn-${sequence.toString(36)}-${nowMs.toString(36)}-${entropy}`
}

export class RecruitmentRegistry {
    private readonly byRoom = new Map<string, RecruitmentRecord>()
    private sequence = 0

    /**
     * Applies one `share_room` call. Returns the live record when the room is
     * being advertised, or null when the call cancelled/none of the requested
     * share types are ours. Re-sharing the same room only bumps the refresh
     * clock, the redelivery count, and (for a cancelled-then-reopened room) the
     * key — it never creates a second notification for the same room.
     */
    share(input: ShareWindowInput): RecruitmentRecord | null {
        const roomNumber = input.room.roomNumber
        if (!input.recruited) {
            this.byRoom.delete(roomNumber)
            return null
        }

        const existing = this.byRoom.get(roomNumber)
        if (existing
            && existing.hostViewerId === input.room.hostViewerId
            && existing.category === input.room.category
            && existing.questId === input.room.questId) {
            existing.lastSharedAtMs = input.nowMs
            existing.shareCount += 1
            return existing
        }

        const record: RecruitmentRecord = {
            roomNumber,
            hostViewerId: input.room.hostViewerId,
            category: input.room.category,
            questId: input.room.questId,
            attentionKey: createAttentionKey(++this.sequence, input.nowMs),
            firstSharedAtMs: input.nowMs,
            lastSharedAtMs: input.nowMs,
            shareCount: 1,
        }
        this.byRoom.set(roomNumber, record)
        return record
    }

    /** Drops a room's recruitment; used when the room disbands or expires. */
    close(roomNumber: string): boolean {
        return this.byRoom.delete(roomNumber)
    }

    /** Drops every recruitment owned by a host, regardless of room number. */
    closeAllForHost(hostViewerId: number): number {
        let removed = 0
        for (const [roomNumber, record] of this.byRoom) {
            if (record.hostViewerId === hostViewerId && this.byRoom.delete(roomNumber)) {
                removed += 1
            }
        }
        return removed
    }

    get(roomNumber: string): RecruitmentRecord | null {
        return this.byRoom.get(roomNumber) ?? null
    }

    /**
     * Live recruitments a viewer may be notified about, most recent first.
     *
     * Only the process-local, still-fresh part of the state is filtered here.
     * Room liveness (still exists, still has a free real-player slot, host not
     * in battle) is the coordinator's business and is applied by the caller, so
     * this stays a pure function of the registry plus a clock.
     */
    listVisible(nowMs: number): RecruitmentRecord[] {
        const visible: RecruitmentRecord[] = []
        for (const [roomNumber, record] of this.byRoom) {
            const expired = nowMs > record.lastSharedAtMs + VISIBLE_TAIL_MS
            const exhausted = record.shareCount >= RECRUITMENT_REDELIVER_LIMIT
            if (expired || exhausted) {
                this.byRoom.delete(roomNumber)
                continue
            }
            if (nowMs + VISIBLE_SKEW_MS < record.firstSharedAtMs) continue
            visible.push(record)
        }
        visible.sort((left, right) => (
            right.lastSharedAtMs - left.lastSharedAtMs
            || left.roomNumber.localeCompare(right.roomNumber)
        ))
        return visible
    }

    /** Test/ops helper: forget every recruitment. */
    clear(): void {
        this.byRoom.clear()
    }

    get size(): number {
        return this.byRoom.size
    }
}

/**
 * The process-wide recruitment registry.
 *
 * Rooms, their HTTP routes, and `/attention/check` all run in one process, so a
 * single shared instance is the whole coordination mechanism — there is no
 * second node to gossip with and no persisted queue to replay.
 */
export const recruitmentRegistry = new RecruitmentRegistry()
