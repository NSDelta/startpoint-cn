import type { ShopCampaignDescriptor, ShopCatalog } from "./shop"
import type { ShopItem } from "./types/shop"

export const SHOP_CAMPAIGN_PERIOD_ERROR_CODE = 1652

/**
 * 「过期活动商店」容忍开关（私有服专用）：`SHOP_CAMPAIGN_PERIOD_TOLERANT=1` 打开。
 *
 * 官方服在活动期外开商店，服务端回 1652、客户端弹「发生错误」——这对运营期是对的。
 * 私有服里活动商店（方舟守护者 / 赛马娘联动 / 珍奇品…）的档期停在 2022–2023，
 * 玩家却从界面点得进去，于是每次都给一次错误弹窗。打开这个开关后**只放过「档期已过」**
 * 这一条，`availableFrom` 还没到的（未来内容）照旧拒绝，lineup 与存在性校验也照旧。
 *
 * 默认关：任何没显式打开的部署行为与上游一致。
 */
function periodTolerant(): boolean {
    const raw = (process.env.SHOP_CAMPAIGN_PERIOD_TOLERANT ?? "").trim().toLowerCase()
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

/** 同一个开关的公开版本：货架单品（`isShopItemAvailable`）也要跟着放过。 */
export function isShopPeriodTolerant(): boolean {
    return periodTolerant()
}

export class ShopCampaignValidationError extends Error {}

export class ShopCampaignPeriodError extends Error {
    readonly resultCode = SHOP_CAMPAIGN_PERIOD_ERROR_CODE
}

export function requireAvailableShopCampaign(
    catalog: Pick<ShopCatalog, "campaignsByKey">,
    shopType: number,
    campaignId: number,
    lineupId: number | null,
    nowMs: number,
): Readonly<ShopCampaignDescriptor> {
    if ((shopType !== 4 && shopType !== 7)
        || !Number.isSafeInteger(campaignId) || campaignId <= 0
        || !Number.isFinite(nowMs)) {
        throw new ShopCampaignValidationError("Invalid shop campaign request.")
    }
    const campaign = catalog.campaignsByKey[`${shopType}:${campaignId}`]
    if (campaign === undefined) {
        throw new ShopCampaignValidationError("Shop campaign does not exist.")
    }
    if (nowMs < campaign.availableFromMs) {
        throw new ShopCampaignPeriodError("Shop campaign is outside its available period.")
    }
    if (nowMs > campaign.availableUntilMs && !periodTolerant()) {
        throw new ShopCampaignPeriodError("Shop campaign is outside its available period.")
    }
    if (lineupId !== null && (
        !Number.isSafeInteger(lineupId)
        || lineupId <= 0
        || !campaign.lineupIds.includes(lineupId)
    )) {
        throw new ShopCampaignValidationError("Shop campaign lineup does not exist.")
    }
    return campaign
}

export function isShopItemVisibleForCampaign(
    item: Pick<ShopItem, "campaignId" | "lineupId">,
    shopType: number,
    selections: Readonly<Record<string, number>>,
): boolean {
    if (item.campaignId === undefined && item.lineupId === undefined) return true
    if (!Number.isSafeInteger(item.campaignId) || item.campaignId! <= 0) return false
    if (item.lineupId === undefined) return true
    if (!Number.isSafeInteger(item.lineupId) || item.lineupId <= 0) return false
    return selections[`${shopType}:${item.campaignId}`] === item.lineupId
}
