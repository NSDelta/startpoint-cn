import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { generateDataHeaders } from "../../../utils"
import {
    countLocalFollowersSync,
    listLocalFollowerSourcesSync,
    listLocalFollowTargetsSync,
} from "../../../data/domains/follow"
import { resolveFollowTarget, resolveFollowViewer } from "./context"
import { projectRelationFor } from "./profile"

function ok(viewerId: number, data: Record<string, unknown>, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId }),
        data,
    })
}

function aError(viewerId: number, resultCode: number, reply: FastifyReply) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        data_headers: generateDataHeaders({ viewer_id: viewerId, result_code: resultCode }),
        data: {},
    })
}

function parseSearchViewerId(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? value : null
    }
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * 一次 `follow/lists` 最多投影多少条关系。
 *
 * 客户端把这一份列表拆成“关注 / 粉丝 / 互关”三个页签，三个页签共用同一个上限；
 * 100 与 Content `config.json` 的 `max_follows_count`（我方关注上限）一致，
 * 所以正常玩家的“关注”页签永远拿得到全部出边。粉丝数上限（50）不单独截断：
 * 玩家自己的关注与粉丝合并后可能超过 100，此时按活跃度截断，
 * 被截掉的是最久未登录的关系，且不会把某个页签单独清空。
 */
const FOLLOW_LIST_DISPLAY_LIMIT = 100

export function registerFollowReadRoutes(fastify: FastifyInstance): void {
    // follow/lists：与当前玩家有任一方向边的同服玩家 + 被关注数
    fastify.post("/lists", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const targetIds = listLocalFollowTargetsSync(viewer.playerId)
        const followerIds = listLocalFollowerSourcesSync(viewer.playerId)
        const seen = new Set<number>()
        const followInfo = []
        for (const targetId of [...targetIds, ...followerIds]) {
            if (seen.has(targetId)) continue
            seen.add(targetId)
            const projected = projectRelationFor(viewer.playerId, targetId)
            if (projected !== null) followInfo.push(projected)
        }
        followInfo.sort((left, right) => (
            (right.last_login_time ?? 0) - (left.last_login_time ?? 0)
            || (left.viewer_id ?? 0) - (right.viewer_id ?? 0)
        ))
        return ok(viewer.viewerId, {
            follow_info: followInfo.slice(0, FOLLOW_LIST_DISPLAY_LIMIT),
            followed_count: countLocalFollowersSync(viewer.playerId),
        }, reply)
    })

    // follow/search_id：只解析本地 session（同服边界）
    fastify.post("/search_id", async (request: FastifyRequest, reply: FastifyReply) => {
        const viewer = await resolveFollowViewer(request, reply)
        if (viewer === null) return
        const searchId = (request.body as { search_id?: unknown })?.search_id
        const parsedSearchId = parseSearchViewerId(searchId)
        if (parsedSearchId === null) {
            return reply.status(400).send({ error: "Bad Request", message: "Invalid request body." })
        }
        const targetPlayerId = await resolveFollowTarget(parsedSearchId)
        if (targetPlayerId === null) {
            return aError(viewer.viewerId, 1457, reply)
        }
        const projected = projectRelationFor(viewer.playerId, targetPlayerId)
        if (projected === null) {
            return aError(viewer.viewerId, 1457, reply)
        }
        return ok(viewer.viewerId, { search_result: projected }, reply)
    })
}
