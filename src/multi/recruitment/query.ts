// Read path for the bell: turns the process-local recruitment registry into the
// `data.multi` list that `/attention/check` returns.
//
// The registry only knows what the host advertised and when. Every fact that can
// go stale — the room still existing, still having a free real-player slot, the
// viewer already being inside it — is re-checked against the coordinator here so
// a guest never receives a bell for a room it cannot actually join.
import type { MultiCoordinator } from "../coordinator/interface"
import type { ParticipantIdentity } from "../coordinator/contracts"
import {
    buildAttentionMultiList,
    buildAttentionMultiNotification,
    type AttentionMultiList,
    type AttentionMultiNotification,
} from "./attention"
import type { RecruitmentRegistry } from "./registry"

/** Rooms hold three real players in total, matching the client's own `< 3` gate. */
export const RECRUITMENT_ROOM_CAPACITY = 3

/** `attention_config.return_attention_max_num` — the client keeps at most three bells. */
export const ATTENTION_HOLDING_LIMIT = 3

export interface RecruitmentHostFacts {
    readonly hostPlayerId: number
    readonly mainCharacterId: number
    readonly rankLevel: number
    readonly isNewbie: boolean
}

export interface RecruitmentHostResolver {
    resolve(hostViewerId: number): Promise<RecruitmentHostFacts | null>
}

export interface AttentionRecruitmentQueryInput {
    readonly viewerId: number
    readonly requesterPlayerId: number
    /**
     * `holding_number` from the client: how many bells it is already holding.
     * The client keeps at most `return_attention_max_num` (3), so this caps how
     * many we may return and an exhausted client gets an empty list.
     */
    readonly holdingNumber?: number
}

export interface AttentionRecruitmentDependencies {
    readonly registry: RecruitmentRegistry
    readonly coordinator: Pick<MultiCoordinator, "getRoomStatus">
    readonly resolveHost: RecruitmentHostResolver["resolve"]
    readonly participantFor: (viewerId: number) => ParticipantIdentity
    readonly resolveEstablisherFollow: (input: {
        readonly requester: ParticipantIdentity
        readonly requesterPlayerId: number
        readonly hostViewerId: number
        readonly hostPlayerId: number
        readonly hostEntryTime: number
        readonly roomNumber: string
    }) => number
    readonly nowMs?: () => number
    readonly onResolveError?: (roomNumber: string, error: unknown) => void
}

/**
 * Remaining bell slots for this poll.
 *
 * `holding_number` is how many bells the client already holds, so it is only a
 * request for `return_attention_max_num - holding` more. A malformed value is
 * treated as "holds nothing" rather than "holds everything": refusing to send a
 * bell is invisible to the player, while a bad parse silently disabling random
 * recruitment for every legacy client would be very hard to notice.
 */
function resolveRequestedLimit(holdingNumber: number | undefined): number {
    if (holdingNumber === undefined || holdingNumber === null) return ATTENTION_HOLDING_LIMIT
    const requested = Number.isSafeInteger(holdingNumber) ? holdingNumber as number : 0
    if (requested <= 0) return 0
    return Math.min(requested, ATTENTION_HOLDING_LIMIT)
}

/**
 * Bell notifications the viewer may legally accept right now, newest first.
 *
 * Returns `{ multi: [] }` rather than omitting the key when nothing qualifies:
 * the client treats a missing `data.multi` as `Option.None` (no reception at
 * all) while an empty array is the ordinary "nothing to show" shape.
 */
export async function collectAttentionRecruitments(
    input: AttentionRecruitmentQueryInput,
    dependencies: AttentionRecruitmentDependencies,
): Promise<AttentionMultiList> {
    const nowMs = (dependencies.nowMs ?? (() => Date.now()))()
    const limit = resolveRequestedLimit(input.holdingNumber)
    if (limit <= 0) return buildAttentionMultiList([])

    const requester = dependencies.participantFor(input.viewerId)
    const notifications: AttentionMultiNotification[] = []

    for (const recruitment of dependencies.registry.listVisible(nowMs)) {
        if (notifications.length >= limit) break
        // A host is never notified about its own recruitments.
        if (recruitment.hostViewerId === input.viewerId) continue

        const room = await dependencies.coordinator.getRoomStatus({
            participant: requester,
            roomNumber: recruitment.roomNumber,
        })
        if (!room.ok) {
            if (room.error !== "ROOM_NOT_FOUND") {
                dependencies.onResolveError?.(recruitment.roomNumber, room.error)
            }
            continue
        }
        const status = room.value
        // The advertised facts must still match the live room.
        if (status.category !== recruitment.category
            || status.questId !== recruitment.questId
            || status.host.viewerId !== recruitment.hostViewerId) {
            continue
        }
        // Guests already inside the room keep their bell; everybody else needs a
        // free real-player seat.
        const alreadyJoined = status.members.some(member => member.viewerId === input.viewerId)
        if (!alreadyJoined && status.members.length >= RECRUITMENT_ROOM_CAPACITY) continue

        const host = await dependencies.resolveHost(recruitment.hostViewerId)
        if (!host) continue

        notifications.push(buildAttentionMultiNotification({
            recruitment,
            host: {
                mainCharacterId: host.mainCharacterId,
                rankLevel: host.rankLevel,
                isNewbie: host.isNewbie,
                hostEntryTime: status.hostEntryTime,
            },
            establisherFollow: dependencies.resolveEstablisherFollow({
                requester,
                requesterPlayerId: input.requesterPlayerId,
                hostViewerId: recruitment.hostViewerId,
                hostPlayerId: host.hostPlayerId,
                hostEntryTime: status.hostEntryTime,
                roomNumber: recruitment.roomNumber,
            }),
        }))
    }

    return buildAttentionMultiList(notifications)
}