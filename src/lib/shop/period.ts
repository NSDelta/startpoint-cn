import type { ShopItem, ShopItemAvailabilityPeriod } from "../types/shop"
import { GameCalendarError, type GameCalendarPolicy } from "../../time/game-calendar"
import { getGameCalendar } from "../../time/game-calendar-provider"

export class ShopPeriodFormatError extends Error {}

export function parseShopCnTimestamp(
    value: string,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number {
    try {
        return calendar.parseMasterTimestamp(value)
    } catch (error) {
        if (error instanceof GameCalendarError) {
            throw new ShopPeriodFormatError(`Invalid shop period: ${value}.`)
        }
        throw error
    }
}

export function getShopCnMonth(
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number {
    if (!Number.isFinite(nowMs)) throw new ShopPeriodFormatError("Invalid shop time.")
    return calendar.getMonth(nowMs)
}

export function isShopPeriodAvailable(
    period: Readonly<ShopItemAvailabilityPeriod>,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const availableFromMs = parseShopCnTimestamp(period.availableFrom, calendar)
    const availableUntilMs = period.availableUntil === null
        ? Infinity
        : parseShopCnTimestamp(period.availableUntil, calendar)
    return nowMs >= availableFromMs && nowMs <= availableUntilMs
}

/** 档期的结束时刻（`availableUntil` 为 null 表示无限）。 */
export function shopPeriodEndMs(
    period: Readonly<ShopItemAvailabilityPeriod>,
    calendar: GameCalendarPolicy = getGameCalendar(),
): number {
    return period.availableUntil === null
        ? Infinity
        : parseShopCnTimestamp(period.availableUntil, calendar)
}

/** 这一段档期是否**已经过去**（区别于「还没开始」）。 */
export function isShopPeriodExpired(
    period: Readonly<ShopItemAvailabilityPeriod>,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    return period.availableUntil !== null && shopPeriodEndMs(period, calendar) < nowMs
}

export function isShopItemAvailable(
    shopItem: ShopItem,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const periods = [{
        availableFrom: shopItem.availableFrom,
        availableUntil: shopItem.availableUntil,
    }, ...(shopItem.compatibilityPeriods ?? [])]
    return periods.some(period => isShopPeriodAvailable(period, nowMs, calendar))
}

/**
 * 该单品**所有**档期都已结束（与「还没开始」区分开）。
 *
 * 私有服开关 `SHOP_CAMPAIGN_PERIOD_TOLERANT` 只放过「已过期」：活动商店的货架停在
 * 2022–2023，玩家却点得进去，于是整个货架都是灰的。有了这个判据，过期单品照常上架，
 * 还没开卖的未来单品依旧不下发。
 */
export function isShopItemExpired(
    shopItem: ShopItem,
    nowMs: number,
    calendar: GameCalendarPolicy = getGameCalendar(),
): boolean {
    const periods = [{
        availableFrom: shopItem.availableFrom,
        availableUntil: shopItem.availableUntil,
    }, ...(shopItem.compatibilityPeriods ?? [])]
    return periods.every(period => (
        period.availableUntil !== null
        && parseShopCnTimestamp(period.availableUntil, calendar) < nowMs
    ))
}
