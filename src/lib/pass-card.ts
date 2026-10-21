import { getContentSnapshot } from "../content/runtime/content-snapshot"
import { GameCalendarError, type GameCalendarPolicy } from "../time/game-calendar"
import { getGameCalendar } from "../time/game-calendar-provider"
import type { ActiveMissionReward } from "./mission/rewards"

export interface PassCardEventDefinition {
    eventId: number
    thresholdPoint: number
    levelThreshold: number
    startTime: number
    endTime: number
    forceTime: number
}

export interface PassCardRewardDefinition {
    rewardId: number
    eventId: number
    level: number
    reward1: ActiveMissionReward
    reward2: ActiveMissionReward
}

function firstRow(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : undefined
}

function integer(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "" || value === "(None)") return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
}

function cnTimestamp(
    value: unknown,
    calendar: GameCalendarPolicy,
): number | undefined {
    if (typeof value !== "string" || value === "") return undefined
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) return undefined
        throw error
    }
}

function parseReward(row: readonly unknown[], kindIndex: number): ActiveMissionReward | undefined {
    const kind = integer(row[kindIndex])
    if (kind === undefined) return undefined
    const amount = integer(row[kindIndex + 1]) ?? (kind === 6 ? 0 : undefined)
    if (amount === undefined) return undefined
    const itemId = integer(row[kindIndex + 2])
    const characterId = integer(row[kindIndex + 3])
    const equipmentId = integer(row[kindIndex + 4])
    const degreeId = integer(row[kindIndex + 5])
    if (kind === 1 && itemId === undefined) return undefined
    if (kind === 2 && equipmentId === undefined) return undefined
    if (kind === 4 && characterId === undefined) return undefined
    if (kind === 6 && degreeId === undefined) return undefined
    return {
        kind,
        amount,
        ...(itemId !== undefined ? { itemId } : {}),
        ...(characterId !== undefined ? { characterId } : {}),
        ...(equipmentId !== undefined ? { equipmentId } : {}),
        ...(degreeId !== undefined ? { degreeId } : {}),
    }
}

export function getPassCardEventDefinition(
    eventId: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): PassCardEventDefinition | undefined {
    const passCardEvents = getContentSnapshot().repository.table<Record<string, unknown>>(
        "pass_card_event.json",
    )
    const row = firstRow(passCardEvents[String(eventId)])
    const thresholdPoint = row ? integer(row[4]) : undefined
    const levelThreshold = row ? integer(row[5]) : undefined
    const startTime = row ? cnTimestamp(row[8], calendar) : undefined
    const endTime = row ? cnTimestamp(row[9], calendar) : undefined
    const forceTime = row ? cnTimestamp(row[10], calendar) : undefined
    if (thresholdPoint === undefined
        || levelThreshold === undefined || levelThreshold <= 0
        || startTime === undefined || endTime === undefined || forceTime === undefined) return undefined
    return { eventId, thresholdPoint, levelThreshold, startTime, endTime, forceTime }
}

export function getActivePassCardEventDefinitionAt(
    at: Date,
    calendar: GameCalendarPolicy = getGameCalendar(),
): PassCardEventDefinition | undefined {
    const passCardEvents = getContentSnapshot().repository.table<Record<string, unknown>>(
        "pass_card_event.json",
    )
    return Object.keys(passCardEvents)
        .map(eventId => integer(eventId))
        .filter((eventId): eventId is number => eventId !== undefined)
        .sort((left, right) => left - right)
        .map(eventId => getPassCardEventDefinition(eventId, calendar))
        .filter((event): event is PassCardEventDefinition =>
            event !== undefined && isPassCardEventActiveAt(event, at),
        )
        // 宽限期会让上一期与新一期同时「有效」，必须取**开始得最晚**的那期（否则永远命中第 1 期）。
        .sort((left, right) => right.startTime - left.startTime)[0]
}

/**
 * 通行证期是否仍在服务窗口内。
 *
 * 真机症状（玩家报「修行之道 C7101 / 损坏」）：客户端按 master 的 `force_time`（= end_time + 1 个月）
 * 仍显示可领，而服务端只看 `[start_time, end_time]` ⇒ 过了 end_time 立刻回 400 `Unknown pass card.`。
 * 这里把窗口放到 `force_time`，与客户端展示口径对齐。
 */
export function isPassCardEventActiveAt(event: PassCardEventDefinition, at: Date): boolean {
    const time = at.getTime()
    const until = Math.max(event.endTime, event.forceTime)
    return Number.isFinite(time) && event.startTime <= time && time <= until
}

export function getPassCardRewardDefinition(rewardId: number): PassCardRewardDefinition | undefined {
    const passCardRewards = getContentSnapshot().repository.table<Record<string, unknown>>(
        "pass_card_reward.json",
    )
    const row = firstRow(passCardRewards[String(rewardId)])
    if (!row) return undefined
    const eventId = integer(row[0])
    const level = integer(row[1])
    const reward1 = parseReward(row, 2)
    const reward2 = parseReward(row, 8)
    if (eventId === undefined || level === undefined || !reward1 || !reward2) return undefined
    return { rewardId, eventId, level, reward1, reward2 }
}
