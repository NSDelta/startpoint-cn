/**
 * P10-C：iOS 公告通道的绑定验证码提供者（`provideCode` 的唯一实现）。
 *
 * 背景：iOS 客户端没有自研登录页，玩家看不到 6 位验证码。P10-B 借雷廷 SDK 的
 * 原生公告弹窗（`sdk_v3/get_notice.do` → `NoticeBean`）开了一条显示通道
 * （`src/routes/cn/ios-leiting.ts`），但那条通道的 `provideCode` 一直是**未注入**状态
 * ⇒ 启动日志 `provideCode=fallback-text`，玩家只能看到兜底话术。本模块把它接上。
 *
 * 三条设计约束（改这里之前先读任务卡）：
 *
 *  1. **账号解析必须与绑定闸门同源**。闸门 `resolveBindGateSubject`
 *     （`src/lib/bind-gate.ts:195-232`）是「先 `device_bindings` 再未过期的 `device_grants`」，
 *     因为 `/sp-auth/register` 会双写两张表（`src/lib/sp-auth/register.ts:206`）、
 *     而 P2 之前的存量玩家只有 `device_bindings`。这里**直接复用同一个函数**，
 *     绝不另写一套只查 grants 的窄解析 —— 否则会出现「闸门认得出这个设备、公告查不到人」。
 *
 *  2. **反复打开公告不得换码**。iOS 玩家会反复唤出公告弹窗；每次请求都 `issueSignupCode`
 *     会让「他刚看到的码」立刻失效（CC-1 只保证 60 秒窗口，不足以救这个场景）。
 *     所以顺序永远是「先取活码，**取不到才发**」，发码只发生在 `activeCodeViewForAccount`
 *     返回 null 之后。
 *
 *  3. **查不到人不许抛错**。契约（`src/routes/cn/ios-leiting.ts:427`）规定 `null` = 回兜底文案；
 *     处理器虽已把抛错也降级成兜底文案，但那是**最后一道网**，不是本模块的借口：
 *     所有「没找到 / 字段不认识」分支一律显式 return null。
 */

import { getPrimaryBindingSync, getAccountBindStateSync } from "../data/domains/account-binding"
import { resolveBindGateSubject } from "./bind-gate"
import { activeCodeViewForAccount, issueSignupCode } from "./signup-code"
import { parseDeviceId } from "./sp-auth/contract"
import type { IosNoticeIdentity } from "../routes/cn/ios-leiting"

/** 返回码的语义（供日志与测试断言，不影响公告文案）。 */
export type IosNoticeCodeOutcome =
    | "code"
    | "unbound_device"
    | "already_bound"
    | "device_id_invalid"
    | "account_disabled"
    | "lookup_failed"

export interface IosNoticeCodeResolution {
    /** 直接喂给 `IosNoticeCodeProvider` 的返回值：非 null 即真实验证码。 */
    readonly code: string | null
    readonly outcome: IosNoticeCodeOutcome
    readonly accountId: number | null
}

/**
 * 设备标识 → 账号：**复用闸门那套**（`resolveBindGateSubject`），保证「闸门认账的设备，
 * 公告也认账」。
 *
 * `resolveBindGateSubject` 的 grant 分支会判 `grant_expires_at`（`:219-222`），
 * 与闸门行为一致；`device_bindings` 分支不带过期概念（存量玩家靠它续命）。
 */
function resolveAccountIdFromIds(ids: IosNoticeIdentity): number | null {
    // `IosNoticeIdentity.deviceId` 由 `resolveIosNoticeIdentity` 从 query/body 解析，
    // 规则与 `resolveDeviceKey` 同源，但这里只认数字形态（`device_bindings.device_id` 是整数）。
    const deviceId = parseDeviceId(ids.deviceId)
    if (deviceId === null) return null
    const lookup = resolveBindGateSubject(deviceId)
    return lookup.subject?.accountId ?? null
}

/**
 * 该账号是否**已经完成绑定**。
 *
 * 判据取「`bind_state === "active"` **或** 存在任何 QQ/KOOK 平台绑定记录」，是两者取或：
 *  · `bindPlatformAccountSync`（`:659-671`）在写绑定的同一个事务里把 `bind_state` 推到
 *    `active`，正常路径下两者同真；
 *  · 但 `bind_state` 还有 `setAccountBindStateSync` 这条人工出口，平台绑定行也可能被
 *    `unbindPlatformAccountSync` 单独摘掉。取或让「已经绑过的人」无论从哪条路进来都走
 *    已绑定分支，而不会傻乎乎地发一个**根本不需要的新码**给已经绑好的玩家。
 */
function isAlreadyBound(accountId: number): boolean {
    if (getAccountBindStateSync(accountId) === "active") return true
    return getPrimaryBindingSync(accountId) !== null
}

/**
 * 解析结果（纯查表，不写字）。测试直接断言这个，避免为了覆盖「已绑定」语义而反复打 HTTP。
 *
 * 注意：**只有 outcome === "code" 且 code === null 时才真的发码**，见 `createIosNoticeCodeProvider`。
 */
export function resolveIosNoticeCode(ids: IosNoticeIdentity): IosNoticeCodeResolution {
    const accountId = resolveAccountIdFromIds(ids)
    if (accountId === null) {
        // 没映射 / 悬空 / grant 过期 / deviceId 不是数字 —— 一律「查不到」，回兜底话术。
        return {
            code: null,
            outcome: parseDeviceId(ids.deviceId) === null ? "device_id_invalid" : "unbound_device",
            accountId: null,
        }
    }

    const bindState = getAccountBindStateSync(accountId)
    if (bindState === "disabled") {
        // 封禁账号：不发码（发了也绑不上，`consumeSignupCodeSync` 会回 ACCOUNT_DISABLED）。
        return { code: null, outcome: "account_disabled", accountId }
    }
    if (isAlreadyBound(accountId)) {
        return { code: null, outcome: "already_bound", accountId }
    }

    const live = activeCodeViewForAccount(accountId)
    if (live !== null) {
        // 关键：**已绑定的活码直接复用**。玩家反复打开公告看到的永远是同一个码。
        return { code: live.code, outcome: "code", accountId }
    }

    // 没有活码（首次注册后码过期、或被 bot 消费失败后吊销）才发新的。
    const issued = issueSignupCode(accountId)
    return issued.ok
        ? { code: issued.code.code, outcome: "code", accountId }
        : { code: null, outcome: "lookup_failed", accountId }
}

/**
 * 造 `IosNoticeCodeProvider`（契约见 `src/routes/cn/ios-leiting.ts:431`）。
 *
 * 返回 `null` ⇒ 处理器回兜底文案；**绝不抛错**：任何内部异常都在这里收成日志 + null，
 * 让「公告弹窗显示兜底话术」而不是「玩家看到一个 HTTP 500」。
 */
export function createIosNoticeCodeProvider(
    deps: { readonly log?: (line: string) => void } = {},
) {
    const log = deps.log ?? ((line: string) => { console.log(line) })
    return (ids: IosNoticeIdentity): string | null => {
        try {
            const resolution = resolveIosNoticeCode(ids)
            if (resolution.code !== null) return resolution.code
            // 已绑定 / 封禁是**正常**业务分支，不该刷 warn；只有真异常才值得惊动服主。
            if (resolution.outcome === "lookup_failed") {
                log(`[iOS-NOTICE-CODE] 取码失败（account_id=${resolution.accountId ?? "?"}），回兜底文案`)
            }
            return null
        } catch (error) {
            log(`[iOS-NOTICE-CODE] provider 异常：${error instanceof Error ? error.message : String(error)}`)
            return null
        }
    }
}
