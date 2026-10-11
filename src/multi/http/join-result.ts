import type {
    CoordinatorErrorCode,
    CoordinatorResult,
} from "../coordinator/contracts"
import type { RoomStatus } from "../coordinator/interface"
import type { MultiQuestAvailabilityProvider } from "./context"

type JoinUnavailableError = Exclude<CoordinatorErrorCode, "ROOM_NOT_FOUND">

export type RoomJoinResult =
    | { readonly kind: "available"; readonly value: RoomStatus }
    | { readonly kind: "missing"; readonly error: "ROOM_NOT_FOUND" }
    | { readonly kind: "unavailable"; readonly error: JoinUnavailableError }

export function roomUnavailableRaisingState(
    error: CoordinatorErrorCode,
): 3 | 7 | 9 {
    if (error === "ROOM_NOT_FOUND") return 9
    if (error === "ROOM_FULL") return 3
    return 7
}

/**
 * CN 1.8.1 MultiBattleQuestPrepareRealRemote 仅接受 raising_state 1/2/9；
 * 3/4/7/8/10/11/12/13 会让客户端抛 ClientError 5001。除 ROOM_NOT_FOUND(→9)
 * 外的一切失败都必须走 A-error 通道（调用方回 result_code 4507 → Failure）。
 */
export function prepareFailureRaisingState(
    error: CoordinatorErrorCode,
): 9 | null {
    return error === "ROOM_NOT_FOUND" ? 9 : null
}

/**
 * CN 1.8.1 MultiBattleQuestRestoreRoomRealRemote：9=Disbanded、13=NotMate；
 * 除房间不存在外的失败按 13 处理。
 */
export function restoreRoomUnavailableRaisingState(
    error: CoordinatorErrorCode,
): 9 | 13 {
    return error === "ROOM_NOT_FOUND" ? 9 : 13
}

export interface RoomRaisingStateProjection {
    readonly raisingState: number
    /** true 时调用方保留原有的 host-offline 日志。 */
    readonly hostOffline: boolean
    /** true = 请求者已在房内，这次是「回房」而不是「加入新房」。 */
    readonly returningMember: boolean
}

/**
 * 回房投影：CN 1.8.1 MultiBattleQuestPrepareRealRemote.selectRoomSuccessHandler 只接受
 * raising_state 1/2/9（2 每 3 秒重试、第 5 次即 Failure；4 等其余值直接抛 ClientError 5001）。
 *
 * 战斗期间客户端会主动断开房间 socket（只有房间场景保活），队长因此被判 hostOnline=false。
 * 回来的队友若拿到 2，会在约 15 秒后判 Failure，并触发客户端上报
 * multi_battle_quest/create_room_failure；那条路由缺失时是 404，客户端把它渲染成
 * 「发生意想不到的错误 回到登录界面 (No.H404)」。
 *
 * 所以「已经在房内的成员」不再等队长，直接按回房放行 1；等待只留给真正的新加入者。
 * 这里只改投影给客户端的值，不动房间自身的 raising_state —— 战斗释放依赖 4 阻止新战斗
 * 与延迟释放重叠（见 embedded.ts 的 releaseBattle 注释）。
 */
export function projectRoomRaisingState(
    room: RoomStatus,
    viewerId: number,
): RoomRaisingStateProjection {
    if (viewerId === room.host.viewerId) {
        return { raisingState: 1, hostOffline: false, returningMember: false }
    }
    if (room.members.some(member => member.viewerId === viewerId)) {
        return { raisingState: 1, hostOffline: false, returningMember: true }
    }
    if (!room.hostOnline) {
        return { raisingState: 2, hostOffline: true, returningMember: false }
    }
    return { raisingState: room.raisingState, hostOffline: false, returningMember: false }
}

export function classifyRoomJoin(
    questAvailability: MultiQuestAvailabilityProvider,
    result: CoordinatorResult<RoomStatus>,
): RoomJoinResult {
    if (!result.ok) return result.error === "ROOM_NOT_FOUND"
        ? { kind: "missing", error: result.error }
        : { kind: "unavailable", error: result.error }
    return questAvailability.check(result.value.category, result.value.questId).available
        ? { kind: "available", value: result.value }
        : { kind: "unavailable", error: "QUEST_NOT_AVAILABLE" }
}
