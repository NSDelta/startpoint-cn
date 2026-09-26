/**
 * P4 服务端绑定闸门 —— 契约 C3（`data_headers.result_code = 517` + `data_headers.sp_binding`）。
 *
 * 判定矩阵见 `契约变更/CC-1-注册与设备判定矩阵.md`，接缝见 `派工任务卡.md` 卡 A5。
 *
 * 三条硬约束（改这里之前请先读任务卡，别凭感觉放宽）：
 *  1. 判定必须发生在 `src/routes/cn/tool.ts` 的 `getDeviceBindingSync(deviceId)`（`:86`）之后、
 *     已知设备分支（`:88`）之前 —— 该分支会把 pending（已发码未绑定）账号直接放行。
 *  2. 开关关（代码默认）时 `evaluateBindGate` 在读任何表之前就返回 `gate_disabled`，
 *     `/tool/signup` 的行为与 P4 之前逐字节一致。
 *  3. 配置一律从注入的 env 解析，非法取值 fail-closed（宁拒不放）；不接受「看不懂就当关」。
 *
 * 本模块只读 P2 的领域函数（`src/data/domains/*`），自己不写 SQL、不改任何表结构。
 */

import { appendBindAuditSync, getAccountBindStateSync, getAccountByDeviceSync } from "../data/domains/account-binding"
import { getAccountSync } from "../data/domains/account"
import { getDeviceBindingSync } from "../data/domains/session"
import type { BindState } from "../data/types"
import { generateDataHeaders } from "../utils"
import { getRealNow, getRealNowMs } from "../runtime/time/game-time"
import { SP_AUTH_ERROR_MESSAGES, parseDeviceId } from "./sp-auth/contract"
import type { SpAuthErrorCode } from "./sp-auth/contract"

// ---------------------------------------------------------------------------
// 契约常量
// ---------------------------------------------------------------------------

/** 开关：只认 `1`/`true`/`yes`/`on`；缺省（未配置）按代码默认 **关**。 */
export const BIND_GATE_ENABLED_ENV = "BIND_GATE_ENABLED"
/** 服主自测白名单：逗号分隔，token 同时比对请求体 `device_id` 与 `udid` 头。 */
export const BIND_GATE_EXEMPT_UDIDS_ENV = "BIND_GATE_EXEMPT_UDIDS"

/**
 * 闸门自己的 `result_code`（契约 C3）。
 * **516 已被 `src/lib/takeover-access.ts:6` 的 `TAKEOVER_OLD_ACCESS_ERROR` 占用，不得复用。**
 */
export const BIND_GATE_REQUIRED_CODE = 517

/** 契约 C3 冻结的错误码（C7 字典成员，`src/lib/sp-auth/contract.ts:15-30`）。 */
export const BIND_GATE_REQUIRED_ERROR: SpAuthErrorCode = "BIND_REQUIRED"

/** `data_headers` 里新增的键（契约 C3）。 */
export const BIND_GATE_HEADER_KEY = "sp_binding"

/** `bind_audit.actor`；`gate_reject` 动作由 P3 登记在 `src/data/types.ts:951`。 */
export const BIND_GATE_AUDIT_ACTOR = "bind-gate"

/** iOS 客户端固定发送的 dummy udid（任务卡 §2 真机实测；Android 不这样发）。 */
export const IOS_DUMMY_UDID = "10000001"

/** iOS 侧 UA 特征：`iOS;`（本仓既有判据，见 `src/utils.ts:156` 的 `getRequestPlatformSync`）/
 * AdobeAIR（AIR 打包）/ CFNetwork（原生网络栈）；大小写不敏感。 */
export const IOS_USER_AGENT_HINTS = ["ios;", "adobeair", "cfnetwork"] as const

/** iOS 没有验证码界面（I1b 未决）⇒ 只能人工绑定；这行给服主看的。 */
export const IOS_MANUAL_BIND_HINT =
    "iOS 玩家被绑定闸门拦下：iOS 端暂无验证码界面（I1b 未决），走 R3 人工绑定 —— 玩家群里报 UDID/设备号 → bot → 后台人工绑定。"

const ENABLED_VALUES: readonly string[] = ["1", "true", "yes", "on"]
const DISABLED_VALUES: readonly string[] = ["0", "false", "no", "off"]

// ---------------------------------------------------------------------------
// 配置解析（注入式 env，照 `src/lib/udid-probe.ts:117-126` 的形状）
// ---------------------------------------------------------------------------

export interface BindGateConfig {
    /** 闸门是否生效。未配置 = 关（代码默认 0；`.env.example` 写 1）。 */
    readonly enabled: boolean
    /** 非 null = 读到无法识别的取值，已按 fail-closed 当「开」处理，原文留给日志。 */
    readonly invalidValue: string | null
    /** `BIND_GATE_EXEMPT_UDIDS` 解析结果（trim / 丢空 / 去重，顺序保留）。 */
    readonly exemptTokens: readonly string[]
}

/**
 * 取值表：空/缺失 ⇒ 关；`0|false|no|off` ⇒ 关；`1|true|yes|on` ⇒ 开；
 * **其他任何值 ⇒ 开（fail-closed）并在日志里喊出原文**。
 *
 * 与 `src/lib/udid-probe.ts:110-112` 的 `flagEnabled`（只认 `1`/`true`，其余当关）不同：
 * 闸门是安全边界，「配置写错」必须表现为拦截而不是静默放行。
 */
export function resolveBindGateConfig(env: NodeJS.ProcessEnv = process.env): BindGateConfig {
    const raw = (env[BIND_GATE_ENABLED_ENV] ?? "").trim()
    const normalized = raw.toLowerCase()
    let enabled = false
    let invalidValue: string | null = null
    if (normalized === "" || DISABLED_VALUES.includes(normalized)) {
        enabled = false
    } else if (ENABLED_VALUES.includes(normalized)) {
        enabled = true
    } else {
        enabled = true
        invalidValue = raw
    }
    return {
        enabled,
        invalidValue,
        exemptTokens: parseExemptTokens(env[BIND_GATE_EXEMPT_UDIDS_ENV]),
    }
}

function parseExemptTokens(raw: string | undefined): readonly string[] {
    const tokens: string[] = []
    for (const piece of (raw ?? "").split(",")) {
        const token = piece.trim()
        if (token !== "" && !tokens.includes(token)) tokens.push(token)
    }
    return tokens
}

/** 启动横幅：让服主在日志第一屏就能看到闸门开没开（由 `src/cn-server.ts` 的片段调用）。 */
export function reportBindGateMode(env: NodeJS.ProcessEnv = process.env): BindGateConfig {
    const config = resolveBindGateConfig(env)
    if (config.enabled) {
        const notes: string[] = []
        if (config.invalidValue !== null) {
            notes.push(`${BIND_GATE_ENABLED_ENV}="${config.invalidValue}" 无法识别，已按 fail-closed 当「开」处理`)
        }
        if (config.exemptTokens.length > 0) {
            notes.push(`${BIND_GATE_EXEMPT_UDIDS_ENV} 白名单 ${config.exemptTokens.length} 项（仅服主自测用）`)
        }
        const suffix = notes.length > 0 ? ` [${notes.join("；")}]` : ""
        console.log(
            `[BIND-GATE] enabled: /tool/signup 拒绝未绑定设备（契约 C3, result_code=${BIND_GATE_REQUIRED_CODE}）${suffix}`,
        )
    } else {
        console.log(
            `[BIND-GATE] disabled（${BIND_GATE_ENABLED_ENV} 缺省/关）：未绑定账号可直接进游戏；` +
            "生产环境必须设为 1，否则绑定流程形同虚设",
        )
    }
    return config
}

// ---------------------------------------------------------------------------
// 客户端平台判定（只影响日志与 iOS 提示，不影响判定结果）
// ---------------------------------------------------------------------------

export type BindGateClient = "ios" | "android"

/**
 * 平台判定（**只影响日志与 iOS 提示，不影响放行/拒绝**）：
 *  ① `udid` 头 == dummy `10000001`（任务卡 §2 真机实测）；
 *  ② UA 命中 `iOS;` / `AdobeAIR` / `CFNetwork`；
 *  ③ `requestedby: ios` 头（`src/utils.ts:160` 既有判据）。
 * 身份键永远是 `body.device_id`，这里判错也不会改变判定结果。
 */
export function resolveBindGateClient(input: {
    udid?: string | null
    userAgent?: string | null
    requestedBy?: string | null
}): BindGateClient {
    if ((input.udid ?? "").trim() === IOS_DUMMY_UDID) return "ios"
    const userAgent = (input.userAgent ?? "").toLowerCase()
    if (IOS_USER_AGENT_HINTS.some((hint) => userAgent.includes(hint))) return "ios"
    if ((input.requestedBy ?? "").trim().toLowerCase() === "ios") return "ios"
    return "android"
}

// ---------------------------------------------------------------------------
// 设备 → 账号（闸门的「主体」）
// ---------------------------------------------------------------------------

export interface BindGateSubject {
    readonly accountId: number
    readonly bindState: BindState
    /** 映射来源：`device_binding` = signup 会复用的那张表；`grant` = `/sp-auth/register` 发的设备凭证。 */
    readonly source: "device_binding" | "grant"
    /** 仅 `source === "grant"` 时有值（ISO 串）。 */
    readonly grantExpiresAt: string | null
}

/** 查不到主体时说明原因，便于日志定位（不参与判定分支）。 */
export type BindGateSubjectMiss = "device_unmapped" | "device_orphaned" | "grant_expired"

export interface BindGateSubjectLookup {
    readonly subject: BindGateSubject | null
    readonly missing: BindGateSubjectMiss | null
}

export interface BindGateSubjectDeps {
    /** 默认 `getRealNowMs()`；测试可注入固定时钟。 */
    readonly nowMs?: () => number
}

/**
 * 设备名下的账号。
 *
 * 先看 `device_bindings`（signup 的已知设备分支就是用它选账号，闸门必须审同一个账号），
 * 再退回「未过期的 `device_grants`」：`/sp-auth/register` 双写两张表，但 P2 之前的历史玩家
 * 只有 `device_bindings`，严格按 §3.3 字面「grant 不存在即 517」会把存量玩家全部挡在门外，
 * 与分工文档 §3.1「`bind_state` 默认 active 是为了不误伤既有账号」冲突。
 */
export function resolveBindGateSubject(
    deviceId: number,
    deps: BindGateSubjectDeps = {},
): BindGateSubjectLookup {
    const nowMs = deps.nowMs ?? getRealNowMs

    const binding = getDeviceBindingSync(deviceId)
    if (binding) {
        const account = getAccountSync(binding.account_id)
        if (account) {
            const bindState = getAccountBindStateSync(account.id)
            // null = 账号行在这两条查询之间消失，视为不可信（fail-closed）。
            if (bindState === null) return { subject: null, missing: "device_orphaned" }
            return {
                subject: { accountId: account.id, bindState, source: "device_binding", grantExpiresAt: null },
                missing: null,
            }
        }
        // 悬空 device_bindings（tool.ts:101 会重建账号）：旧账号的 grant 不能替新身份作证。
        return { subject: null, missing: "device_orphaned" }
    }

    const mapping = getAccountByDeviceSync(deviceId)
    if (mapping === null) return { subject: null, missing: "device_unmapped" }
    const expiresAtMs = Date.parse(mapping.grant_expires_at)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs()) {
        return { subject: null, missing: "grant_expired" }
    }
    return {
        subject: {
            accountId: mapping.account_id,
            bindState: mapping.bind_state,
            source: "grant",
            grantExpiresAt: mapping.grant_expires_at,
        },
        missing: null,
    }
}

// ---------------------------------------------------------------------------
// 判定（纯函数）
// ---------------------------------------------------------------------------

export type BindGateReason =
    | "gate_disabled"
    | "udid_exempt"
    | "bind_state_active"
    | "device_id_invalid"
    | "device_unmapped"
    | "device_orphaned"
    | "grant_expired"
    | "bind_state_pending"
    | "bind_state_disabled"

export interface BindGateInput {
    /** 原始 `body.device_id`（未校验类型）。 */
    readonly deviceId: unknown
    /** `request.headers["udid"]` 原值（可能是数组）。 */
    readonly udid?: string | string[] | null
    /** `request.headers["user-agent"]` 原值。 */
    readonly userAgent?: string | string[] | null
    /** `request.headers["requestedby"]` 原值（iOS 判据之一，见 `src/utils.ts:160`）。 */
    readonly requestedBy?: string | string[] | null
    /** env 注入点；缺省 `process.env`。 */
    readonly env?: NodeJS.ProcessEnv
    /** 直接给配置（优先于 `env`），测试用。 */
    readonly config?: BindGateConfig
}

export interface BindGateDeps {
    /** 覆盖设备→账号查询（纯函数测试用；缺省走 `resolveBindGateSubject`）。 */
    readonly resolveSubject?: (deviceId: number) => BindGateSubjectLookup
    readonly nowMs?: () => number
}

export interface BindGateDecision {
    /** true = 放行交给既有 signup 流程；false = 回 517，不落任何库写。 */
    readonly allow: boolean
    readonly reason: BindGateReason
    /** 仅 `allow === false` 时非 null（C7 字典成员）。 */
    readonly code: SpAuthErrorCode | null
    /** 仅 `allow === false` 时非 null。 */
    readonly resultCode: number | null
    readonly message: string | null
    readonly client: BindGateClient
    readonly deviceId: number | null
    readonly udid: string | null
    readonly userAgent: string | null
    readonly subject: BindGateSubject | null
    /** 命中的白名单 token（仅 `reason === "udid_exempt"`）。 */
    readonly exemptToken: string | null
    readonly config: BindGateConfig
}

/**
 * 闸门判定。**纯函数**：不写库、不打日志（副作用在 `recordBindGateRejection`）。
 *
 * 放行只有三种：开关关、命中白名单、主体 `bind_state === "active"`。
 * 其余一切（device_id 非法 / 无映射 / 悬空 binding / grant 过期 / pending / disabled）一律拒绝，
 * 即 fail-closed。
 */
export function evaluateBindGate(input: BindGateInput, deps: BindGateDeps = {}): BindGateDecision {
    const config = input.config ?? resolveBindGateConfig(input.env ?? process.env)
    const udid = firstHeaderValue(input.udid)
    const userAgent = firstHeaderValue(input.userAgent)
    const client = resolveBindGateClient({ udid, userAgent, requestedBy: firstHeaderValue(input.requestedBy) })
    const shared = { client, udid, userAgent, exemptToken: null, config } as const

    // ① 开关关：在读任何表之前返回（逐字节一致 + 零额外开销）。
    if (!config.enabled) {
        return {
            ...shared,
            allow: true,
            reason: "gate_disabled",
            code: null,
            resultCode: null,
            message: null,
            deviceId: null,
            subject: null,
        }
    }

    // ② 服主自测白名单（token 同时比对 device_id 与 udid；垃圾 token 永不匹配）。
    const exemptToken = matchExemptToken(config.exemptTokens, input.deviceId, udid)
    if (exemptToken !== null) {
        return {
            ...shared,
            allow: true,
            reason: "udid_exempt",
            code: null,
            resultCode: null,
            message: null,
            deviceId: parseDeviceId(input.deviceId),
            subject: null,
            exemptToken,
        }
    }

    // ③ 身份键：一律 `body.device_id`（iOS 的 udid 是 dummy）。
    const deviceId = parseDeviceId(input.deviceId)
    if (deviceId === null) {
        return decideReject(shared, "device_id_invalid", BIND_GATE_REQUIRED_ERROR, null, null)
    }

    const lookup = (deps.resolveSubject ?? ((id: number) => resolveBindGateSubject(id, { nowMs: deps.nowMs })))(deviceId)
    const subject = lookup.subject
    if (subject === null) {
        // 无映射 / 悬空 / grant 过期：一律按「还没完成绑定」处理。
        return decideReject(shared, lookup.missing ?? "device_unmapped", BIND_GATE_REQUIRED_ERROR, deviceId, null)
    }

    if (subject.bindState === "active") {
        return {
            ...shared,
            allow: true,
            reason: "bind_state_active",
            code: null,
            resultCode: null,
            message: null,
            deviceId,
            subject,
        }
    }

    if (subject.bindState === "disabled") {
        return decideReject(shared, "bind_state_disabled", "ACCOUNT_DISABLED", deviceId, subject)
    }

    return decideReject(shared, "bind_state_pending", BIND_GATE_REQUIRED_ERROR, deviceId, subject)
}

function decideReject(
    shared: { client: BindGateClient; udid: string | null; userAgent: string | null; exemptToken: null; config: BindGateConfig },
    reason: BindGateReason,
    code: SpAuthErrorCode,
    deviceId: number | null,
    subject: BindGateSubject | null,
): BindGateDecision {
    return {
        ...shared,
        allow: false,
        reason,
        code,
        resultCode: BIND_GATE_REQUIRED_CODE,
        message: messageFor(code),
        deviceId,
        subject,
    }
}

/** 文案一律取 C7 冻结字典（`src/lib/sp-auth/contract.ts:39-54`），不另造话术。 */
export function messageFor(code: SpAuthErrorCode): string {
    return SP_AUTH_ERROR_MESSAGES[code] ?? SP_AUTH_ERROR_MESSAGES.SERVICE_UNAVAILABLE
}

// ---------------------------------------------------------------------------
// 响应载荷（契约 C3 冻结形状）
// ---------------------------------------------------------------------------

export interface BindGatePayload {
    readonly data_headers: Record<string, unknown>
    readonly data: Record<string, unknown>
}

/**
 * HTTP 200 + `data_headers.result_code = 517` + `data_headers.sp_binding`；
 * 再在 `data` 里回一份同样的 `sp_binding` 与可读 `message`，给拿不到头部的客户端兜底。
 *
 * `viewer_id` 保持 `generateDataHeaders` 的默认 0：拒绝路径绝不回可登录凭据。
 * （`generateDataHeaders` 只拷贝 `fields` 列出的键，所以 `sp_binding` 必须自己 spread 上去。）
 */
export function buildBindGateRejection(decision: BindGateDecision): BindGatePayload {
    if (decision.allow || decision.code === null) {
        throw new Error("buildBindGateRejection requires a rejection decision")
    }
    const message = decision.message ?? messageFor(decision.code)
    const spBinding = { ok: false, code: decision.code, message }
    return {
        data_headers: {
            ...generateDataHeaders({ result_code: BIND_GATE_REQUIRED_CODE }),
            [BIND_GATE_HEADER_KEY]: spBinding,
        },
        data: {
            result_code: BIND_GATE_REQUIRED_CODE,
            code: decision.code,
            message,
            [BIND_GATE_HEADER_KEY]: spBinding,
        },
    }
}

// ---------------------------------------------------------------------------
// 日志 + 审计（唯一的副作用出口）
// ---------------------------------------------------------------------------

export interface BindGateLogRecord {
    readonly event: "bind_gate_reject"
    readonly contract: "C3"
    readonly result_code: number
    readonly code: SpAuthErrorCode
    readonly message: string
    readonly reason: BindGateReason
    readonly client: BindGateClient
    readonly device_id: number | null
    readonly udid: string | null
    readonly user_agent: string | null
    readonly account_id: number | null
    readonly bind_state: BindState | null
    readonly source: BindGateSubject["source"] | null
    readonly hint: string | null
    readonly time: string
}

/** 一行 JSON：`client` 字段就是「iOS 还是 Android 被挡了」。 */
export function buildBindGateLogRecord(decision: BindGateDecision, now: Date = getRealNow()): BindGateLogRecord {
    const code = decision.code ?? BIND_GATE_REQUIRED_ERROR
    return {
        event: "bind_gate_reject",
        contract: "C3",
        result_code: BIND_GATE_REQUIRED_CODE,
        code,
        message: decision.message ?? messageFor(code),
        reason: decision.reason,
        client: decision.client,
        device_id: decision.deviceId,
        udid: decision.udid,
        user_agent: decision.userAgent,
        account_id: decision.subject?.accountId ?? null,
        bind_state: decision.subject?.bindState ?? null,
        source: decision.subject?.source ?? null,
        hint: decision.client === "ios" ? IOS_MANUAL_BIND_HINT : null,
        time: now.toISOString(),
    }
}

/**
 * 拒绝时的副作用：打日志（iOS 多打一行中文提示）+ 写 `bind_audit(action="gate_reject")`。
 * 审计写失败只记一行日志，绝不影响 517 响应（审计不阻塞被审计动作）。
 */
export function recordBindGateRejection(decision: BindGateDecision, now: Date = getRealNow()): BindGateLogRecord {
    const record = buildBindGateLogRecord(decision, now)
    console.log(`[BIND-GATE] ${JSON.stringify(record)}`)
    if (record.hint !== null) {
        console.log(`[BIND-GATE] iOS 玩家被拦（device_id=${record.device_id ?? "?"}, reason=${record.reason}）：${record.hint}`)
    }
    try {
        appendBindAuditSync({
            action: "gate_reject",
            accountId: record.account_id,
            detail: record,
            actor: BIND_GATE_AUDIT_ACTOR,
            createdAt: record.time,
        })
    } catch (error) {
        console.log(`[BIND-GATE] audit write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return record
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function firstHeaderValue(value: string | string[] | null | undefined): string | null {
    if (Array.isArray(value)) {
        for (const item of value) {
            const trimmed = typeof item === "string" ? item.trim() : ""
            if (trimmed !== "") return trimmed
        }
        return null
    }
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed === "" ? null : trimmed
}

function matchExemptToken(tokens: readonly string[], rawDeviceId: unknown, udid: string | null): string | null {
    if (tokens.length === 0) return null
    const candidates: string[] = []
    if (typeof rawDeviceId === "number" && Number.isFinite(rawDeviceId)) candidates.push(String(rawDeviceId))
    if (typeof rawDeviceId === "string" && rawDeviceId.trim() !== "") candidates.push(rawDeviceId.trim())
    if (udid !== null) candidates.push(udid)
    for (const token of tokens) {
        const lowered = token.toLowerCase()
        for (const candidate of candidates) {
            if (candidate.toLowerCase() === lowered) return token
        }
    }
    return null
}
