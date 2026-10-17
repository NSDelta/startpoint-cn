import { getPlayerSync } from "../data/domains/player"
import { getRoomShareRowSync } from "../data/domains/social-room-shares"
import { getRoom } from "./room/manager"
import { sessionManager } from "./state/SessionManager"

/** 投递资格门要看的最小事实（只取招募行里已有的列） */
export interface BellCandidateFacts {
    readonly roomNumber: string
    readonly hostPid: number
    readonly hostViewerId: number
}

/**
 * T1 投递资格门（设计 v2 §5）：候选在**写投递行之前**逐个判定，被滤掉的房间
 * 不占 return_attention_max_num 名额（对齐参考实现 Ku1o/startpoint-cn-kulo
 * 「不要为不存在的房主业务记录消耗投递配额」，src/routes/api/attention.ts）。
 *
 * 房间在本节点可见（单节点部署的常态）：校验真实房间态——未解散
 * （raising_state !== 4）、房主会话在线、真人未满员。占用只数真人
 * （comId 判别，全仓约定）——keep-open 下 NPC 占位不挡真人。
 *
 * 房间不在本节点（多节点/中心化部署）：本进程拿不到房间态，改用**跨节点可见、
 * 且"缺失即未知"不会误杀**的事实：
 *   1. 房主的玩家行必须存在（缺行 = 业务记录已消失，对齐参考实现的
 *      `!!getPlayerSync(room.host_player_id)`）；
 *   2. 若好友大厅注册行（social_room_shares）里有这个房间且未过期，则据它判断
 *      解散（raising_state === 4）与满员（mates >= 3）——这是跨节点的房间态快照。
 * 刻意**不**用 presence 当房主在线判据：presence 行会被惰性清扫、且等待中的房主
 * 未必每 10s 轮询 check，把"查不到"当成"离线"会静默吃掉大量正常铃铛。
 * 异节点房主的离线由招募行自身的机制收敛：房主每 15s 重发一次（上限 20 次），
 * 停发后最迟 45s（单次授权寿命）该铃铛就从 guest 轮询中消失。
 */
export function isBellDeliveryEligible(candidate: BellCandidateFacts, nowMs: number): boolean {
    const room = getRoom(candidate.roomNumber)
    if (room !== undefined && room !== null) {
        if (room.raising_state === 4) return false
        const hostClient = sessionManager.getRoomHostClient(candidate.roomNumber)
        if (!hostClient) return false
        const realMembers = hostClient.mates.filter(mate => !mate.comId).length
        return realMembers < 3
    }

    if (getPlayerSync(candidate.hostPid) === null) return false
    const share = getRoomShareRowSync(candidate.roomNumber)
    if (share !== undefined && share.expires_at_ms > nowMs) {
        if (share.raising_state === 4) return false
        if (share.mates >= 3) return false
    }
    return true
}
