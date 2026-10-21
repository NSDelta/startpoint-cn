import { deepFreeze } from "../../content/deep-freeze"
import type { ShopItem } from "../types/shop"
import type { EffectiveShopOffer, ShopCatalog } from "./model"
import { shopCatalogKey } from "./model"
import {
    getRushFinalOperationOverrideForSourceEvent,
    RUSH_EVENT_TYPE,
    type RushFinalOperationOverride,
} from "../rush-final-operation-override"
import {
    getShopCnMonth,
    isShopPeriodAvailable,
    isShopPeriodExpired,
    shopPeriodEndMs,
} from "./period"
import { isShopPeriodTolerant } from "../shop-select-campaign"

export class ShopOfferNotPurchasableError extends Error {}
export class ShopOfferPeriodError extends Error {
    readonly resultCode = 2053
}
export class ShopOfferScheduleError extends Error {}

export function resolveEffectiveShopOffer(
    catalog: ShopCatalog,
    shopType: number,
    shopItemId: number,
    nowMs: number,
    rushOverride: RushFinalOperationOverride | null = null,
): EffectiveShopOffer {
    if (!Number.isFinite(nowMs)) throw new ShopOfferPeriodError("Invalid shop time.")
    const entry = catalog.entries[shopCatalogKey(shopType, shopItemId)]
    if (entry === undefined || entry.kind !== "purchase") {
        throw new ShopOfferNotPurchasableError("Shop offer is not purchasable.")
    }
    let periods = entry.periods
    if (rushOverride !== null
        && entry.scope.kind === "event"
        && entry.scope.eventType === RUSH_EVENT_TYPE) {
        const source = getRushFinalOperationOverrideForSourceEvent(
            catalog,
            rushOverride,
            entry.scope.eventId,
        )
        if (source !== null) {
            periods = [...periods, {
                availableFrom: source.availableFrom,
                availableUntil: source.availableUntil,
            }]
        }
    }
    if (!periods.some(period => isShopPeriodAvailable(period, nowMs))) {
        // 2026-10-20 业主：「修好的商店里带了不能兑换的期间限定」——货架侧已经把已过期
        // 单品放过（`shop-sales-list`），但购买侧原来仍按档期拒（result_code 2053）。
        // 开关打开时：只要这些档期**全都已经结束**（不是还没开始），就照样允许兑换。
        const expiredButTolerated = isShopPeriodTolerant()
            && periods.every(period => isShopPeriodExpired(period, nowMs))
        if (!expiredButTolerated) {
            throw new ShopOfferPeriodError("Shop offer is outside its available period.")
        }
    }

    const month = getShopCnMonth(nowMs)
    let item: Readonly<ShopItem> = entry.item
    if (entry.item.costScheduleId !== undefined) {
        const rows = catalog.scheduleRowsByMonth[`${entry.item.costScheduleId}:${month}`] ?? []
        let effectiveRows = rows.filter(row => isShopPeriodAvailable(row, nowMs))
        if (effectiveRows.length === 0 && rows.length > 0 && isShopPeriodTolerant()) {
            // 过期档期也放过时，价格表同样要挑出一档：取「结束得最晚」的那一档，结果确定。
            const byEndDesc = [...rows].sort(
                (a, b) => shopPeriodEndMs(b) - shopPeriodEndMs(a),
            )
            effectiveRows = [byEndDesc[0]]
        }
        if (effectiveRows.length !== 1) {
            throw new ShopOfferScheduleError("Shop cost schedule is missing or ambiguous.")
        }
        item = deepFreeze({
            ...entry.item,
            costs: effectiveRows[0].costs.map(cost => ({ ...cost })),
        })
    }
    return deepFreeze({
        ...entry,
        item,
        virtualMonthCn: month,
    })
}
