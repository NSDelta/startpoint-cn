import {
    projectCharacterPatch,
    projectEquipmentEntity,
} from "../common-response/entities"
import { mergeCommonResponseFragments } from "../common-response/merge"
import type { CommonResponseFragment } from "../common-response/model"
import { projectItemOverflowCommonResponse } from "../item-overflow/common-response"
import type { StarCrumbExchangeSuccess } from "./owner"

export interface StarCrumbExchangeResponseInput {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    readonly result: StarCrumbExchangeSuccess
    readonly characterList: readonly Record<string, unknown>[]
    readonly mailArrived: boolean
}

/**
 * `ItemShopPeriodError`：CN 1.8.1 客户端在 star crumb 兑换这条 remote 上唯一可用的
 * 「业务失败」结果码之一（另两个是 3006 `ExchangePeriodError` 与 3010
 * `ShopPurchaseStepOverDayPeriod`）。
 *
 * `pinball/remote/exchange/starCrumb/ExchangeStarCrumbRealRemote.as` 的 errorHandler
 * 对 `RemoteErrorKind` 除 `FailureResult`(kind 8) 以外的全部种类都走
 * `defaultErrorHandler`，而 kind 8 里只特判 2053/3006/3010：HTTP 4xx 或「200 + 其它
 * result_code」在客户端都是硬错误弹窗（连同 `RequestQueue.clearQueue()`，玩家看到
 * 「发生意想不到的错误」并被迫重登）。2053 对应客户端
 * `item_buy_dialog_partly_outdated`（「内容已过期，请刷新」），是三者中唯一不谎称
 * 「今日次数已满」（3010）或「活动已结束」（3006）的措辞，也正是兑换被服务端拒绝时
 * 的真实原因：客户端本地视图（余额/持有/条目）已经过期。
 */
export const STALE_CLIENT_VIEW_RESULT_CODE = 2053

export interface StarCrumbExchangeRefusalInput {
    readonly dataHeaders: Readonly<Record<string, unknown>>
    /** 未变更的当前余额：拒绝不扣款，客户端据此把本地余额纠正回服务端真值。 */
    readonly starCrumb: number
    readonly mailArrived: boolean
}

/**
 * 兑换被拒时的「未变更事实」响应：HTTP 200 + MsgPack + 非成功 `result_code`
 * （`STALE_CLIENT_VIEW_RESULT_CODE`）+ 空增量列表。与
 * `src/routes/api/expod.ts` 的 `INSUFFICIENT_EXP` 分支同一范式
 * （提交 `3b6a9f50`）：可预期的业务失败绝不能以 HTTP 4xx 表达，否则 CN 客户端把
 * 传输层错误升级成致命弹窗与请求队列清空。
 *
 * 这里不返回任何角色/道具/装备增量，因此客户端不会误以为兑换成功；`user_info`
 * 只回当前余额，形状与成功响应完全一致（同样的 7 个 null 尾字段）。
 */
export function projectStarCrumbExchangeRefusalResponse(
    input: StarCrumbExchangeRefusalInput,
): Record<string, unknown> {
    const fragment: CommonResponseFragment = {
        user_info: { star_crumb: input.starCrumb },
        character_list: [],
        item_list: {},
        equipment_list: [],
        mission_info: null,
        over_max: null,
        mail_arrived: input.mailArrived,
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...mergeCommonResponseFragments([fragment]),
            active_mission_list: null,
            config: null,
            user_daily_challenge_point_list: null,
            encyclopedia_info: null,
            fund_receive_list: null,
            monthly_charge_bonus_info: null,
            crazy_gacha_result_list: null,
        },
    }
}

export function projectStarCrumbExchangeResponse(
    input: StarCrumbExchangeResponseInput,
): Record<string, unknown> {
    const overMax = projectItemOverflowCommonResponse(input.result.itemOverflowDispositions)
    const fragment: CommonResponseFragment = {
        user_info: {
            star_crumb: input.result.starCrumbAfter,
            ...(input.result.itemOverflowDispositions.some(
                disposition => disposition.kind === "sold",
            ) && input.result.freeManaAfter !== null
                ? { free_mana: input.result.freeManaAfter }
                : {}),
        },
        character_list: input.characterList.map(
            character => projectCharacterPatch(character),
        ),
        item_list: input.result.rewardItems,
        equipment_list: input.result.equipment.map(
            equipment => projectEquipmentEntity(equipment),
        ),
        mission_info: null,
        over_max: overMax.length > 0 ? overMax : null,
        mail_arrived: input.mailArrived,
    }
    return {
        data_headers: input.dataHeaders,
        data: {
            ...mergeCommonResponseFragments([fragment]),
            active_mission_list: null,
            config: null,
            user_daily_challenge_point_list: null,
            encyclopedia_info: null,
            fund_receive_list: null,
            monthly_charge_bonus_info: null,
            crazy_gacha_result_list: null,
        },
    }
}
