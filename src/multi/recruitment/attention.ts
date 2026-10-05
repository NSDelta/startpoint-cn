// Bell (attention) notification payloads for real-host co-op recruiting.
//
// The field set below is exactly what the client's
// `AttentionCheckRealRemoteService.successHandler` validates before it will
// build a notification. Every scalar is type-checked and a mismatch raises
// ClientError 870x, so all eight `quest_info` fields must always be present and
// carry the documented primitive type (`host_entry_time` is a Float/Number).
import type { RecruitmentRecord } from "./registry"

/** Share type the client sends for "advertise to random players" (share_type_list: [3]). */
export const RECRUITMENT_SHARE_TYPE = 3

export interface AttentionQuestInfo {
    category_id: number
    quest_id: number
    room_number: string
    establisher_character: number
    establisher_character_evolution_img_level: number
    establisher_follow: number
    establisher_rank: number
    host_entry_time: number
    is_newbie: boolean
}

export interface AttentionMultiNotification {
    attention_key: string
    quest_info: AttentionQuestInfo
}

export interface AttentionMultiList {
    multi: AttentionMultiNotification[]
}

export interface RecruitmentHostView {
    /** Leader character is the room host's main character; the client renders it on the bell. */
    readonly mainCharacterId: number
    readonly rankLevel: number
    readonly isNewbie: boolean
    /** Unix seconds when the host entered the room; drives the client's bell timer. */
    readonly hostEntryTime: number
}

/** True when the client's share request asks us to advertise the room to randoms. */
export function requestsRandomRecruitment(shareTypeList: unknown): boolean {
    if (!Array.isArray(shareTypeList)) return false
    return shareTypeList.some(entry => {
        const value = typeof entry === "string" ? Number(entry) : entry
        return value === RECRUITMENT_SHARE_TYPE
    })
}

export function buildAttentionMultiNotification(input: {
    readonly recruitment: RecruitmentRecord
    readonly host: RecruitmentHostView
    readonly establisherFollow: number
}): AttentionMultiNotification {
    const characterId = Number.isSafeInteger(input.host.mainCharacterId)
        && input.host.mainCharacterId > 0
        ? input.host.mainCharacterId
        : 1
    return {
        attention_key: input.recruitment.attentionKey,
        quest_info: {
            category_id: input.recruitment.category,
            quest_id: input.recruitment.questId,
            room_number: input.recruitment.roomNumber,
            establisher_character: characterId,
            establisher_character_evolution_img_level: 0,
            establisher_follow: input.establisherFollow,
            establisher_rank: input.host.rankLevel,
            host_entry_time: input.host.hostEntryTime,
            is_newbie: input.host.isNewbie,
        },
    }
}

export function buildAttentionMultiList(
    notifications: readonly AttentionMultiNotification[],
): AttentionMultiList {
    return { multi: [...notifications] }
}
