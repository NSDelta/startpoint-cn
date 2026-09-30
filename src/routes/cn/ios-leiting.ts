import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

// --- iOS Leiting SDK 登录 mock ---
// 移植自 dennis96292/startpoint-cn-launcher：
//   https://github.com/dennis96292/startpoint-cn-launcher
//   原始位置 resources/server/out/cn-server.js（IOS_SDK_LOGIN_BLOB / iosLoginPaths / iosStubPaths）
// 背景：iOS 是 AOT 编译无法改成 sdkDummy，必须走真实 Leiting SDK 登录；
// 以下端点返回 AES 加密的游客 UserBean（SDK 内置密钥可解密，任何凭据都接受）。
// SDK 日志接口与 /wf/210009_config_20200415.json 引导接口由"灰"制作，
// 基于 DontBeAlarmed/startpoint-cn@dev 提交 11d3bcf9。
//
// ── β 修复（P10-B / 卡 A12，2026-09）─────────────────────────────────────────
// 修复前：对所有客户端返回同一段**写死的**密文（明文 userId=10000001）⇒ 全体 iOS 设备
// 共用同一身份（B0 真机实测：设备 33 次 UDID 头全为 10000001，见 报告-B0-iOS身份分支.md）。
// 修复后按设备派生，规则如下（全部是稳定映射，**零随机数**）：
//   · 设备标识优先级：`udid` 头 > `short-udid`/`short_udid` 头
//     > query/body 里的 `device_id` | `deviceId` | `udid` | `openudid` | `idfa` | `newCaid`
//     > 兜底指纹（`request.ip` + `user-agent` + `accept-language`）。
//     兜底只在「SDK 首次启动、还没有拿到 UDID」时才会命中（B0 探针实录：真机首个
//     check_login.do 不带 udid 头），命中时会打一行 `src=fallback` 日志便于真机取证；
//     IOS_SDK_IDENTITY_STRICT=1 可改成直接拒绝（不发明身份）。
//   · userId/sid = HMAC-SHA256(serverSecret, deviceKey) 派生的 8 位十进制 `9xxxxxxx`
//     （与原 `10000001` 等长；uid = 同一个数值 ⇒ 仍满足 `uid === Number(userId)`）。
//   · 幂等：若设备标识本身已是 `9xxxxxxx`（= 本服务上次下发的 userId，客户端会把它回灌
//     进 UDID 头）⇒ **原样采用**，保证「首次按兜底指纹定下 id、之后按 UDID 头」不漂移。
//     副作用（已知并接受）：拿到过某设备 id 的客户端可以自称该 id；私服局域网场景下
//     这仍严格优于修复前的「所有人共用 10000001」。
//   · key/iv 与派生 secret 一律来自环境变量（IOS_SDK_BEAN_KEY / IOS_SDK_BEAN_IV /
//     IOS_SDK_IDENTITY_SECRET），**不再入库常量**；任一缺失 ⇒ fail closed（返回非 "0"
//     status + 空 data，绝不退化成共享身份）。
//   · 响应形状不变：`{status,type,message,data}`，`data` 仍是 AES-128-CBC 密文的 base64；
//     明文字段长度与修复前逐字段相同 ⇒ 明文同为 417 B、密文同为 432 B（576 字符 base64）。
//   · 16 条 iosLoginPaths 一视同仁；iosStubPaths 不动。
const iosLoginOKShape = { status: "0", type: "0", message: "" }
const iosStatusOK = { status: "0", statusCode: "0", memo: "", message: "", data: "" }
const iosLoginPaths = ["/mobile!mobileLoginPubV2.action", "/login/mobile!mobileLoginPubV2.action", "/mobile!sdkLogin.action", "/login/mobile!sdkLogin.action", "/mobile!guestRegister.action", "/login/mobile!guestRegister.action", "/mobile!sdkCheckLogin.action", "/login/mobile!sdkCheckLogin.action", "/sdk/v3-3/code_login_v2.do", "/sdk/v3-3/code_login.do", "/sdk/v3-3/pwd_login.do", "/sdk/v3-3/check_login.do", "/sdk/v3-3/check_force.do", "/sdk/v3-3/taptap_login.do", "/sdk/auth_login.do", "/sdk/v3-3/auth_login.do"];
const iosStubPaths = ["/mobile_two!getRegisterCodeOnly.action", "/login/mobile_two!getRegisterCodeOnly.action", "/aes/message/send_phone_code", "/aes/message/send_login_verify_code", "/aes/message/send_bind_phone_login_code", "/aes/message/send_register_code"];

const SDK_LOG_PATHS = [
    "/api/sdk_log!addScreenLog",
    "/api/sdk_log!addScreenLog.action",
    "/api/sdk_api!getCaidNew",
    "/api/sdk_api!getCaidNew.action",
] as const;

const MG_LOG_PATHS = [
    "/api/mg_log!addMgActivateLog.action",
    "/api/mg_log!addMgCreateRoleLog.action",
    "/api/mg_log!addMgLoginLog.action",
    "/api/mg_log!addMgRegisterLog.action",
] as const;

/** 环境变量名（key/iv/派生 secret 都不入库常量）。 */
export const IOS_SDK_BEAN_KEY_ENV = "IOS_SDK_BEAN_KEY"
export const IOS_SDK_BEAN_IV_ENV = "IOS_SDK_BEAN_IV"
export const IOS_SDK_IDENTITY_SECRET_ENV = "IOS_SDK_IDENTITY_SECRET"
export const IOS_SDK_IDENTITY_STRICT_ENV = "IOS_SDK_IDENTITY_STRICT"

/** 本服务下发的 userId 形状：`9` + 7 位十进制（8 字符，与修复前的 `10000001` 等长）。 */
const DERIVED_USER_ID_PATTERN = /^9\d{7}$/
const DERIVED_USER_ID_BASE = 90_000_000
const DERIVED_USER_ID_SPAN = 10_000_000
/** `registTime`/`timestamp` 的取值基线与跨度（派生而非取当前时间 ⇒ 整份 bean 是纯函数）。 */
const BEAN_TIME_BASE = 1_700_000_000_000
const BEAN_TIME_SPAN = 60_000_000_000
const BEAN_TIME_SKEW_SPAN = 10_000_000

/** 设备标识候选键（query/body 通用）。`mac`/`imei` 在 iOS 上恒为空或被 SDK 填成常量，故意不收。 */
const DEVICE_ID_KEYS = ["device_id", "deviceId", "udid", "openudid", "idfa", "newCaid"] as const
/** 头里的设备标识候选，按任务卡要求 `udid` 优先。 */
const DEVICE_ID_HEADERS = ["udid", "short-udid", "short_udid"] as const

/** AES-128-CBC 的 key/iv 各 16 字节。 */
const AES_KEY_BYTES = 16

export interface IosSdkIdentityOptions {
    /** AES-128-CBC key（16 字节）；缺省读 IOS_SDK_BEAN_KEY。 */
    readonly aesKey?: string | undefined
    /** AES-128-CBC iv（16 字节）；缺省读 IOS_SDK_BEAN_IV。 */
    readonly aesIv?: string | undefined
    /** 身份派生 secret；缺省读 IOS_SDK_IDENTITY_SECRET。 */
    readonly identitySecret?: string | undefined
    /** true = 拿不到设备标识时直接拒绝（不发明身份）；缺省读 IOS_SDK_IDENTITY_STRICT。 */
    readonly strict?: boolean | undefined
}

export interface IosLeitingPluginOptions {
    readonly ios?: {
        readonly apiHost: string
        readonly apiScheme: "http" | "https"
    }
    /** 按设备派生身份的材料；缺省从 env 读。 */
    readonly sdkIdentity?: IosSdkIdentityOptions
    /** iOS 公告通道（= 验证码展示）+ 探针；见 IOS_NOTICE_PATHS 上方注释。 */
    readonly notice?: IosNoticeOptions
    /** 注入环境变量（测试用）；缺省 process.env。 */
    readonly env?: NodeJS.ProcessEnv
}

export interface IosSdkIdentityConfig {
    readonly aesKey: Buffer
    readonly aesIv: Buffer
    readonly identitySecret: string
    readonly strict: boolean
}

export type IosSdkIdentityConfigResult =
    | { readonly ok: true; readonly config: IosSdkIdentityConfig }
    | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] }

export interface IosSdkIdentity {
    readonly userId: string
    readonly userName: string
    readonly uid: number
    readonly token: string
    readonly mmid: string
    readonly ddid: string
    readonly registTime: string
    readonly timestamp: string
}

export interface IosSdkBean {
    readonly userId: string
    readonly data: string
}

export interface ResolvedDeviceKey {
    /** 用于派生的设备标识（绝不入日志）。 */
    readonly deviceKey: string
    /** 取证用来源标记：udid / short-udid / query:<key> / body:<key> / fallback。 */
    readonly source: string
    /** 设备标识的 SHA-256 前 12 位 hex（可入日志，用于判定「两台设备是否不同身份」）。 */
    readonly fingerprint: string
}

/** 环境变量里第一条非空值（已 trim）。 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
    const value = env[name]
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function flagEnabled(value: string | undefined): boolean {
    return value === "1" || value === "true"
}

/**
 * 解析派生身份所需材料：显式 options 优先于 env；key/iv 必须恰好 16 字节。
 * 缺任何一项都**不**回退到任何内置常量 —— 调用方据此 fail closed。
 */
export function resolveIosSdkIdentityConfig(
    options: IosSdkIdentityOptions = {},
    env: NodeJS.ProcessEnv = process.env,
): IosSdkIdentityConfigResult {
    const missing: string[] = []
    const aesKey = options.aesKey?.trim() || readEnv(env, IOS_SDK_BEAN_KEY_ENV)
    const aesIv = options.aesIv?.trim() || readEnv(env, IOS_SDK_BEAN_IV_ENV)
    const identitySecret = options.identitySecret?.trim() || readEnv(env, IOS_SDK_IDENTITY_SECRET_ENV)

    if (!aesKey) missing.push(IOS_SDK_BEAN_KEY_ENV)
    if (!aesIv) missing.push(IOS_SDK_BEAN_IV_ENV)
    if (!identitySecret) missing.push(IOS_SDK_IDENTITY_SECRET_ENV)
    if (aesKey && Buffer.byteLength(aesKey, "utf8") !== AES_KEY_BYTES) {
        return { ok: false, reason: `${IOS_SDK_BEAN_KEY_ENV} must be exactly ${AES_KEY_BYTES} bytes`, missing: [] }
    }
    if (aesIv && Buffer.byteLength(aesIv, "utf8") !== AES_KEY_BYTES) {
        return { ok: false, reason: `${IOS_SDK_BEAN_IV_ENV} must be exactly ${AES_KEY_BYTES} bytes`, missing: [] }
    }
    if (missing.length > 0) {
        return { ok: false, reason: `missing env: ${missing.join(", ")}`, missing }
    }

    return {
        ok: true,
        config: {
            aesKey: Buffer.from(aesKey as string, "utf8"),
            aesIv: Buffer.from(aesIv as string, "utf8"),
            identitySecret: identitySecret as string,
            strict: options.strict ?? flagEnabled(env[IOS_SDK_IDENTITY_STRICT_ENV]),
        },
    }
}

/**
 * 把设备标识映射成 userId：已是本服务下发的形状 ⇒ 幂等原样返回；否则 HMAC 派生。
 * **不使用任何随机数** ⇒ 同一设备永远得到同一个 userId。
 */
export function deriveIosSdkUserId(identitySecret: string, deviceKey: string): string {
    if (DERIVED_USER_ID_PATTERN.test(deviceKey)) return deviceKey
    const digest = createHmac("sha256", identitySecret).update(deviceKey, "utf8").digest()
    return String(DERIVED_USER_ID_BASE + (digest.readUInt32BE(0) % DERIVED_USER_ID_SPAN))
}

/** 由最终 userId 展开整份身份（摘要输入的载体是 userId ⇒ 幂等）。 */
export function deriveIosSdkIdentity(identitySecret: string, deviceKey: string): IosSdkIdentity {
    const userId = deriveIosSdkUserId(identitySecret, deviceKey)
    const digest = createHmac("sha256", identitySecret).update(`ios-sdk:${userId}`, "utf8").digest()
    const hex = digest.toString("hex")
    const registTime = String(BEAN_TIME_BASE + (digest.readUIntBE(20, 5) % BEAN_TIME_SPAN))
    return {
        userId,
        userName: `g_${userId}`,
        uid: Number(userId),
        // 下面四个字段长度与修复前逐字段相同（token 23 / mmid 14 / ddid 14 / 时间戳 13）。
        token: `sp-${hex.slice(0, 20)}`,
        mmid: `sp-mmid-${hex.slice(20, 26)}`,
        ddid: `sp-ddid-${hex.slice(26, 32)}`,
        registTime,
        timestamp: String(Number(registTime) + (digest.readUIntBE(25, 5) % BEAN_TIME_SKEW_SPAN)),
    }
}

/**
 * 构造 bean 明文。字段与顺序与修复前解出的 23 字段明文**逐字段一一对应**
 * （仅身份字段换成派生值，`nickName`/`channelNo`/`age` 等原值保留）。
 */
export function buildIosSdkBeanPlaintext(identity: IosSdkIdentity): string {
    return JSON.stringify({
        userId: identity.userId,
        userName: identity.userName,
        nickName: "旅人",
        sid: identity.userId,
        token: identity.token,
        channelNo: "110001",
        game: "wf",
        isGuest: "1",
        bind: "0",
        adult: "1",
        age: "99",
        auth: "1",
        mmid: identity.mmid,
        ddid: identity.ddid,
        guestUpgrade: "0",
        type: "0",
        memo: "",
        status: "0",
        statusCode: "0",
        registTime: identity.registTime,
        timestamp: identity.timestamp,
        realNameAuth: "1",
        uid: identity.uid,
    })
}

/** AES-128-CBC + PKCS7，返回 base64（响应 `data` 的形态与修复前一致）。 */
export function encryptIosSdkBean(plaintext: string, config: IosSdkIdentityConfig): string {
    const cipher = createCipheriv("aes-128-cbc", config.aesKey, config.aesIv)
    return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64")
}

/** 端到端：设备标识 ⇒ `{userId, data}`。 */
export function buildIosSdkBean(deviceKey: string, config: IosSdkIdentityConfig): IosSdkBean {
    const identity = deriveIosSdkIdentity(config.identitySecret, deviceKey)
    return { userId: identity.userId, data: encryptIosSdkBean(buildIosSdkBeanPlaintext(identity), config) }
}

function normalizeCandidate(value: unknown): string | null {
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function headerCandidate(request: FastifyRequest): ResolvedDeviceKey | null {
    for (const name of DEVICE_ID_HEADERS) {
        const raw = request.headers[name]
        const flat = Array.isArray(raw) ? raw[0] : raw
        const value = normalizeCandidate(flat)
        if (value) return { deviceKey: value, source: name, fingerprint: "" }
    }
    return null
}

function recordCandidate(record: unknown, source: string): ResolvedDeviceKey | null {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return null
    const bag = record as Record<string, unknown>
    for (const key of DEVICE_ID_KEYS) {
        const value = normalizeCandidate(bag[key])
        if (value) return { deviceKey: value, source: `${source}:${key}`, fingerprint: "" }
    }
    return null
}

/** 从字符串 body 里尽力抠出设备标识：JSON → urlencoded → 明文正则 → AES 解密后再 JSON。 */
function stringBodyCandidate(body: string, config: IosSdkIdentityConfig): ResolvedDeviceKey | null {
    const text = body.trim()
    if (text.length === 0) return null

    if (text.startsWith("{")) {
        try {
            const parsed = recordCandidate(JSON.parse(text), "body")
            if (parsed) return parsed
        } catch {
            // 不是合法 JSON，继续往下试
        }
    }

    const search = new URLSearchParams(text)
    for (const key of DEVICE_ID_KEYS) {
        const value = normalizeCandidate(search.get(key))
        if (value) return { deviceKey: value, source: `body:${key}`, fingerprint: "" }
    }

    // 明文/半结构化扫描（SDK 可能把参数拼成一行日志式文本）
    for (const key of DEVICE_ID_KEYS) {
        const pattern = new RegExp(`["'\\s&?]${key}["'\\s]*[=:]\\s*"?([A-Za-z0-9._:\\-]{4,128})`, "i")
        const match = pattern.exec(text)
        const value = normalizeCandidate(match?.[1])
        if (value) return { deviceKey: value, source: `body:${key}`, fingerprint: "" }
    }

    // 兜底假设：SDK 可能用同一套 AES 参数加密请求体
    try {
        const decrypted = decryptIfBeanCiphertext(text, config)
        if (decrypted) {
            const parsed = recordCandidate(JSON.parse(decrypted), "body")
            if (parsed) return parsed
        }
    } catch {
        // 不是密文，忽略
    }
    return null
}

/** 尽力把 base64 当成「同一套 AES 参数」的密文解开；失败返回 null。 */
function decryptIfBeanCiphertext(base64: string, config: IosSdkIdentityConfig): string | null {
    if (!/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length % 4 !== 0 || base64.length < 32) return null
    try {
        const decipher = createDecipheriv("aes-128-cbc", config.aesKey, config.aesIv)
        const plain = Buffer.concat([decipher.update(Buffer.from(base64, "base64")), decipher.final()])
        const text = plain.toString("utf8")
        return text.trim().startsWith("{") ? text : null
    } catch {
        return null
    }
}

function fingerprintOf(deviceKey: string): string {
    return createHash("sha256").update(deviceKey, "utf8").digest("hex").slice(0, 12)
}

/** 兜底指纹：仅当 SDK 首启还没拿到 UDID 时才会用到（局域网内对端地址逐设备唯一）。 */
export function fallbackDeviceKey(request: FastifyRequest): string {
    const userAgent = normalizeCandidate(request.headers["user-agent"]) ?? ""
    const acceptLanguage = normalizeCandidate(request.headers["accept-language"]) ?? ""
    return `ip:${request.ip ?? ""}|ua:${userAgent}|lang:${acceptLanguage}`
}

/**
 * 解析「本次请求代表哪台设备」。返回 null = 找不到任何设备标识（strict 模式下拒绝）。
 */
export function resolveDeviceKey(
    request: FastifyRequest,
    config: IosSdkIdentityConfig,
): ResolvedDeviceKey | null {
    const candidates: (ResolvedDeviceKey | null)[] = [
        headerCandidate(request),
        recordCandidate(request.query, "query"),
    ]
    const body = request.body
    if (typeof body === "string") {
        candidates.push(stringBodyCandidate(body, config))
    } else if (Buffer.isBuffer(body)) {
        candidates.push(stringBodyCandidate(body.toString("utf8"), config))
    } else {
        candidates.push(recordCandidate(body, "body"))
    }

    for (const candidate of candidates) {
        if (candidate) return { ...candidate, fingerprint: fingerprintOf(candidate.deviceKey) }
    }
    if (config.strict) return null
    const key = fallbackDeviceKey(request)
    return { deviceKey: key, source: "fallback", fingerprint: fingerprintOf(key) }
}

// ── iOS 公告通道（= 把绑定验证码送到玩家眼前）─────────────────────────────────
// 来源：P10-A 交付片段 `交付片段/p10a/ios-notice.fragment.ts`（由本文件 owner 落笔）。
// 依据（P10-A 报告 §2C 主二进制实测）：LeitingSDK 是**静态链进主二进制**的（IPA 里 0 个
// .framework/.dylib），公告流程全在 SDK 内部：`getNotice:` → `v2PostDataWithUrl:params:
// completion:`（POST）→ URL 格式串 `%@sdk_v3/get_notice.do` → 响应装进 `NoticeBean` →
// `initWithType:bean:` **原生弹窗**（cancelBtn/helpBtn/sureBtn）。且游戏侧 AS3 没有公告实现
// （iOS/安卓 SWF 的 ABC 已被 AOT 剥离，showNoticeTip/NoticeBean 0 命中）⇒ **展示完全由 SDK
// 完成，客户端零改动、也不需要越狱**。服务端在这个端点上返回什么，玩家就在原生弹窗里看到什么。
//
// 两段，默认状态不同：
//   ① 探针 installIosNoticeProbe —— **默认关**（IOS_NOTICE_PROBE=1 开）。只记不改，用途是
//      真机跑一次确定 SDK 的**真实请求行**：带不带 `/login` 前缀、基址带不带尾斜杠、
//      请求体字段名是什么。不落原始 cookie（避免把会话凭据写进日志）。
//   ② 公告端点 —— **默认开**。三种前缀一起接（基址形态静态无法确定），回「多别名霰弹」
//      payload（SDK 到底读 noticeContent / NOTICECONTENT / urgentNoticeContent 哪一个，静态
//      确定不了），探针确认字段名之后由调用方把 `shotgun` 收窄成 false。
//
// 已知边界：本插件是 Fastify **封闭上下文**，所以探针钩子只作用于本文件注册的路由
// （SDK 的身份/公告面基本都在这里：/sdk_v3*、/sdk/v3-3/*、/mobile!*、/wf/210009_config*、
// /protocols/leiting/*、/sync_data）；`/api/policy/report` 等不属于本插件的路径不会被记录，
// 要全覆盖得由集成者在 cn-server.ts 里装等价钩子（见报告 §5/§6）。
export const IOS_NOTICE_PROBE_ENV = "IOS_NOTICE_PROBE"
export const IOS_NOTICE_PROBE_LOG_DIR_ENV = "IOS_NOTICE_PROBE_LOG_DIR"

/** 公告端点：SDK 用 `%@sdk_v3/get_notice.do` 运行时拼基址 ⇒ 三种可能形态一起接。 */
export const IOS_NOTICE_PATHS = [
    "/sdk_v3/get_notice.do",
    "/login/sdk_v3/get_notice.do",
    "/api/sdk_v3/get_notice.do",
] as const

const IOS_NOTICE_ID = "sp-cn-bind-code"
const IOS_NOTICE_TITLE = "服务器绑定验证码"
/** 探针只记「可能属于 SDK 身份/公告面」的请求，避免被游戏资源请求刷爆。 */
const IOS_NOTICE_PROBE_URL_FILTER = /notice|config|sdk|login|auth|leiting|version/i
const IOS_NOTICE_PROBE_MAX_BODY = 4096
const IOS_NOTICE_UID_KEYS = ["uid", "userId", "userid", "leitingNo", "ltNo"] as const
const IOS_NOTICE_DEVICE_KEYS = ["deviceId", "device_id", "udid", "myDeviceId", "targetDeviceId"] as const

export interface IosNoticeIdentity {
    readonly uid?: string | undefined
    readonly deviceId?: string | undefined
    readonly udid?: string | undefined
}

/**
 * 由 uid/设备号换绑定码。返回 null = 查不到 ⇒ **回兜底文案**（契约要求：未接 provider 时不得抛错）。
 * P3 的 `/sp-auth/*`（`src/lib/signup-code.ts`）就绪后，由集成者在注册处注入同源实现：
 * 同一个码只能被 bot 消费一次，失败码沿用 C4（CODE_INVALID/CODE_EXPIRED/CODE_USED/CODE_LOCKED/ALREADY_BOUND）。
 */
export type IosNoticeCodeProvider = (ids: IosNoticeIdentity) => Promise<string | null> | string | null

export interface IosNoticeOptions {
    /** 探针开关；缺省读 IOS_NOTICE_PROBE=1（缺省关 ⇒ 测试与日常运行不产生任何文件）。 */
    readonly probe?: boolean | undefined
    /** 探针日志目录；缺省读 IOS_NOTICE_PROBE_LOG_DIR，再缺省 `<cwd>/out/ios-probe`。 */
    readonly probeLogDir?: string | undefined
    /** 探针每行出口（测试注入）；缺省追加写 `<probeLogDir>/ios-probe-<时间>.log`，写不了就退到 stdout。 */
    readonly probeWriteLine?: ((line: string) => void) | undefined
    /** 绑定码提供者；缺省恒 null ⇒ 兜底文案。 */
    readonly provideCode?: IosNoticeCodeProvider | undefined
    /** true = 多别名霰弹响应（默认）；探针确认 SDK 读哪个字段后收窄为 false。 */
    readonly shotgun?: boolean | undefined
    /** 文案里承诺的有效期（分钟），默认 30。 */
    readonly ttlMinutes?: number | undefined
    /** 可注入时钟（测试用）。 */
    readonly now?: (() => Date) | undefined
}

export interface IosNoticeProbeOptions extends IosNoticeOptions {
    readonly enabled?: boolean | undefined
    readonly logDir?: string | undefined
}

function noticeHeaderValue(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (typeof entry === "string" && entry.trim().length > 0) return entry.trim()
        }
        return null
    }
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

/** 请求体转文本：Fastify 已把 json / form-urlencoded 解析成对象，msgpack 之类到不了这里。 */
function bodyTextOf(body: unknown): string {
    if (typeof body === "string") return body
    if (Buffer.isBuffer(body)) return body.toString("utf8")
    if (body === null || body === undefined) return ""
    try {
        return JSON.stringify(body)
    } catch {
        return ""
    }
}

function recordBodyOf(body: unknown): Record<string, unknown> | undefined {
    if (typeof body !== "object" || body === null || Buffer.isBuffer(body) || Array.isArray(body)) return undefined
    return body as Record<string, unknown>
}

function bodyKeysOf(body: unknown): string[] | null {
    const record = recordBodyOf(body)
    return record ? Object.keys(record).sort() : null
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
    if (!record) return null
    for (const key of keys) {
        const value = record[key]
        if (typeof value === "string" && value.trim().length > 0) return value.trim()
        if (typeof value === "number" && Number.isFinite(value)) return String(value)
    }
    return null
}

function matchGroup(text: string, pattern: RegExp): string | null {
    const match = pattern.exec(text)
    return match?.[1] ?? null
}

/** 从 query/body（对象优先，字符串再正则兜底）解析 uid 与设备标识。 */
export function resolveIosNoticeIdentity(request: FastifyRequest): IosNoticeIdentity {
    const query = recordBodyOf(request.query)
    const body = recordBodyOf(request.body)
    const text = bodyTextOf(request.body)
    const uid = firstString(body, IOS_NOTICE_UID_KEYS)
        ?? firstString(query, IOS_NOTICE_UID_KEYS)
        ?? matchGroup(text, /"?(?:uid|userId|userid)"?\s*[=:]\s*"?(\d{4,})/)
    const deviceId = firstString(body, IOS_NOTICE_DEVICE_KEYS)
        ?? firstString(query, IOS_NOTICE_DEVICE_KEYS)
        ?? matchGroup(text, /"?(?:deviceId|device_id|udid)"?\s*[=:]\s*"?([A-Za-z0-9._:\-]{4,128})/)
    return {
        uid: uid ?? undefined,
        deviceId: deviceId ?? undefined,
        udid: deviceId ?? undefined,
    }
}

/** 有话术自写：不复用任何他人字符串（B 线红线）。 */
function buildIosNoticeContent(code: string | null, ttlMinutes: number): string {
    if (code) {
        return `服务器绑定验证码：${code}\n${ttlMinutes} 分钟内有效。\n把它发给 QQ 群里的 bot（/bind ${code}）即完成绑定；\n过期就在游戏里重新打开本公告即可刷新。`
    }
    return "请先在 QQ 群里向 bot 发送 /bind 获取绑定流程，或联系服主人工绑定。"
}

/**
 * 「霰弹」payload：把主二进制字符串表里出现过的字段名一次全给上（noticeId/NOTICECID/
 * NOTICECONTENT/noticeContent/urgentNotice…/announce… 等）。SDK 实际读哪个只能靠真机探针，
 * 确认后把 shotgun 关掉只留那一个即可。
 */
function buildIosNoticePayload(content: string, shotgun: boolean): Record<string, unknown> {
    if (!shotgun) {
        return { code: 0, noticeId: IOS_NOTICE_ID, NOTICECONTENT: content }
    }
    return {
        code: 0,
        resultCode: 0,
        success: true,
        msg: content,
        noticeId: IOS_NOTICE_ID,
        NOTICECID: IOS_NOTICE_ID,
        NOTICECONTENT: content,
        noticeContent: content,
        content,
        title: IOS_NOTICE_TITLE,
        noticeTitle: IOS_NOTICE_TITLE,
        urgentNoticeTitle: IOS_NOTICE_TITLE,
        urgentNoticeContent: content,
        announceMsg: content,
        announceClickFlag: "0",
        announceTopFlag: "1",
        announceMsgFlag: "1",
        announceClickUrl: "",
        showNoticeTip: "1",
        data: {
            noticeId: IOS_NOTICE_ID,
            NOTICECONTENT: content,
            noticeContent: content,
            content,
            title: IOS_NOTICE_TITLE,
            urgentNoticeTitle: IOS_NOTICE_TITLE,
            urgentNoticeContent: content,
            announceMsg: content,
        },
    }
}

/** 公告端点处理器：永远 200 + JSON；provideCode 抛错只降级成兜底文案，绝不让请求失败。 */
export function createIosNoticeHandler(options: IosNoticeOptions = {}) {
    const provideCode = options.provideCode
    const ttlMinutes = options.ttlMinutes ?? 30
    const shotgun = options.shotgun ?? true

    return async (request: FastifyRequest, reply: FastifyReply) => {
        const ids = resolveIosNoticeIdentity(request)
        let code: string | null = null
        if (provideCode) {
            try {
                code = await provideCode(ids)
            } catch (error) {
                console.warn(`[iOS-NOTICE] provideCode 失败：${(error as Error).message}`)
            }
        }
        const content = buildIosNoticeContent(code, ttlMinutes)
        console.log(`[iOS-NOTICE] ${request.method} ${request.originalUrl ?? request.url} uid=${ids.uid ?? "-"} deviceId=${ids.deviceId ?? "-"} code=${code ?? "(兜底文案)"}`)
        return reply.type("application/json").send(buildIosNoticePayload(content, shotgun))
    }
}

/**
 * 探针一行 JSON。**只观察不改行为**：不碰 reply、不改 request.body/headers、不注册路由。
 * 不落 cookie / authorization（日志不该成为凭据副本）；body 截断到 4096 字节。
 */
export function buildIosNoticeProbeRecord(
    request: FastifyRequest,
    extra: { readonly response?: string | null; readonly status?: number | null } = {},
    now: Date = new Date(),
): string {
    const headers = request.headers
    return JSON.stringify({
        ts: now.toISOString(),
        method: request.method,
        url: request.originalUrl ?? request.url,
        ip: request.ip ?? null,
        status: extra.status ?? null,
        user_agent: noticeHeaderValue(headers["user-agent"]),
        host: noticeHeaderValue(headers.host),
        content_type: noticeHeaderValue(headers["content-type"]),
        content_length: noticeHeaderValue(headers["content-length"]),
        udid: noticeHeaderValue(headers.udid),
        short_udid: noticeHeaderValue(headers["short-udid"]) ?? noticeHeaderValue(headers["short_udid"]),
        body_keys: bodyKeysOf(request.body),
        body: bodyTextOf(request.body).slice(0, IOS_NOTICE_PROBE_MAX_BODY),
        response: extra.response === undefined ? null : extra.response,
    })
}

/**
 * 装探针（默认关）。返回是否真的装了，调用方用它打一行启动横幅。
 * 每请求**恰好**一行：onSend（响应体已知）写正常请求；被 body 解析阶段拒掉（415/400）的
 * 请求到不了 onSend，由 onResponse 兜底 —— 真机取证最怕「零证据」。
 */
export function installIosNoticeProbe(fastify: FastifyInstance, options: IosNoticeProbeOptions = {}): boolean {
    if (options.enabled !== true) return false

    const now = options.now ?? (() => new Date())
    let writeLine = options.probeWriteLine
    if (!writeLine) {
        const logDir = options.probeLogDir ?? options.logDir
        if (logDir) {
            try {
                fs.mkdirSync(logDir, { recursive: true })
                const logPath = path.join(logDir, `ios-probe-${now().toISOString().replace(/[:.]/g, "-")}.log`)
                writeLine = (line: string) => {
                    try {
                        fs.appendFileSync(logPath, `${line}\n`)
                    } catch {
                        // 磁盘问题不该影响请求
                    }
                }
                console.log(`[iOS-NOTICE-PROBE] append -> ${logPath}`)
            } catch {
                writeLine = undefined
            }
        }
    }
    const emit = writeLine ?? ((line: string) => { console.log(`[iOS-NOTICE-PROBE] ${line}`) })

    const pending = new WeakSet<FastifyRequest>()
    const interesting = (request: FastifyRequest): boolean =>
        IOS_NOTICE_PROBE_URL_FILTER.test(request.originalUrl ?? request.url ?? "")

    fastify.addHook("onRequest", async request => {
        if (interesting(request)) pending.add(request)
    })

    fastify.addHook("onSend", async (request, reply, payload) => {
        if (!pending.has(request)) return payload
        pending.delete(request)
        const text = typeof payload === "string" ? payload : bodyTextOf(payload)
        emit(buildIosNoticeProbeRecord(request, {
            status: reply.statusCode,
            response: text.slice(0, IOS_NOTICE_PROBE_MAX_BODY),
        }, now()))
        return payload
    })

    fastify.addHook("onResponse", async (request, reply) => {
        if (!pending.has(request)) return
        pending.delete(request)
        emit(buildIosNoticeProbeRecord(request, { status: reply.statusCode, response: "[[body-not-parsed]]" }, now()))
    })
    return true
}

function loginFailure(message: string): Record<string, string> {
    return { ...iosLoginOKShape, status: "1", message, data: "" }
}

export default async function iosLeitingRoutes(
    fastify: FastifyInstance,
    options: IosLeitingPluginOptions = {},
): Promise<void> {
    const ios = options.ios
    const identityConfig = resolveIosSdkIdentityConfig(options.sdkIdentity ?? {}, options.env ?? process.env)
    if (!identityConfig.ok) {
        console.warn(`[iOS-SDK-LOGIN] per-device identity DISABLED (${identityConfig.reason}); SDK login will fail closed`)
    } else {
        console.log(`[iOS-SDK-LOGIN] per-device identity active (strict=${identityConfig.config.strict})`)
    }
    const config = identityConfig.ok ? identityConfig.config : null
    let unconfiguredReplies = 0

    // iOS 公告通道：探针（默认关）+ 公告端点（默认开）。探针装在最前面，保证它覆盖本插件全部路由。
    const env = options.env ?? process.env
    const noticeOptions = options.notice ?? {}
    const envProbeLogDir = (env[IOS_NOTICE_PROBE_LOG_DIR_ENV] ?? "").trim()
    const noticeProbeEnabled = noticeOptions.probe ?? flagEnabled(env[IOS_NOTICE_PROBE_ENV])
    const noticeProbeLogDir = noticeOptions.probeLogDir
        ?? (envProbeLogDir.length > 0 ? envProbeLogDir : path.join(process.cwd(), "out", "ios-probe"))
    const noticeProbeInstalled = installIosNoticeProbe(fastify, {
        ...noticeOptions,
        enabled: noticeProbeEnabled,
        logDir: noticeProbeLogDir,
    })
    if (noticeProbeInstalled) {
        console.log(`[iOS-NOTICE-PROBE] active (dir=${noticeProbeLogDir}); one line per request on /notice|config|sdk|login|auth|leiting|version/i`)
    } else {
        console.log(`[iOS-NOTICE-PROBE] inactive; set ${IOS_NOTICE_PROBE_ENV}=1 to capture the SDK's real request lines`)
    }

    // 区服/CDN 配置
    fastify.get("/area/config.json", async (_request, reply) => {
        return reply.type("application/json").send({
            area_list: [],
            cdn_list: [{ url: "" }],
        })
    })

    // 功能开关
    fastify.get("/protocols/leiting/switch/switch.txt", async (_request, reply) => {
        return reply.type("text/plain").send("{}")
    })

    // 客户端 IP 检测：返回直连对端地址（request.ip）。
    // 边界说明：仅当客户端直连本服务、或反向代理已按 fastify trustProxy 配置正确透传
    // X-Forwarded-For 时，该值才是真实公网来源 IP；否则它只是上一个网络对端。
    fastify.get("/myip", async (request, reply) => {
        return reply.type("text/plain").send(request.ip)
    })

    // 广告配置
    fastify.post("/logmonitor/api/advert!getNewConfig.action", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0, data: {} })
    })

    // SKAdNetwork
    fastify.get("/api/skan/query_detail", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0, data: {} })
    })

    // SDK 埋点（兼容带/不带 .action）
    for (const route of SDK_LOG_PATHS) {
        fastify.post(route, async (_request, reply) => {
            return reply.type("application/json").send({ code: 0, data: {} })
        })
    }

    // SDK 日志（GET/POST 都接受）
    for (const route of MG_LOG_PATHS) {
        fastify.all(route, async (_request, reply) => {
            return reply.type("application/json").send({ code: 0, message: "success" })
        })
    }

    // 引导配置（apiPath 取 iOS 兼容配置的显式地址）
    fastify.get("/wf/210009_config_20200415.json", async (_request, reply) => {
        return reply.type("application/json").send({
            default: {
                apiPath: ios?.apiHost ?? "",
                apiScheme: ios?.apiScheme ?? "http",
            },
        })
    })

    // sync_data 静默吞掉
    fastify.post("/sync_data", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0 })
    })

    // ── 平台/设备埋点裸路由：最小无副作用吞掉 ────────────────────────────────
    // 依据：真机取证 2026-09-29 12:59:58（iPhone 7 Plus / iOS 15.8.3，客户端为局域网内手机，
    // 地址按仓库隐私约定以 <LAN_IP> 占位，见 scripts/check-hygiene.sh 的 IP_RE/IP_ALLOW）
    // 共 35 条请求落在未知路由 404 上，其中下面 4 条占 27 条 —— 全部是**平台侧埋点**，
    // 不参与游戏进度，客户端对响应体只做「成功/失败」判断（同族端点在我们这里都回
    // `{code:0}` 且真机 200，见 ios-leiting 既有 /logmonitor、/api/skan、MG_LOG_PATHS）。
    //
    // 取证原行（D:\wfcnmod\tmp\server-lan.log，UTF-16LE；同内容见 server-log-phone.txt）：
    //   POST /behavior_log/report        12x -> 404
    //   GET  /api/micro/micro_red/enter_position?channelNo=210009&game=wf&token=(null)&userId=(null)  8x -> 404
    //   POST /api/device/report           4x -> 404
    //   POST /api/iplog/report            3x -> 404
    //
    // 边界（务必保持）：
    //  1. **不读身份**。`enter_position` 的 `token`/`userId` 真机上是字面串 `(null)`
    //     （客户端 Leiting SDK extension 未赋值的属性被 `%@` 打印成 `(null)`），即该请求
    //     不带任何可用于关联玩家的凭据。因此这里一律不解析账号、不查库、不落库 ——
    //     否则会重蹈 load.ts:208-215 注释里「未认证 viewer_id 被当账号」的覆辙。
    //  2. **不读 body**。埋点体形状未知（8001 抓头代理 capture.jsonl 里没有这 4 条的记录），
    //     纯吞掉 ⇒ body 解析失败也绝不影响响应（Fastify 默认 JSON/urlencoded 解析器）。
    //  3. `protocols/leiting/sensitive/part/*.txt` **故意不在**这里实现：它是已定稿决策
    //     （tools/ios_leiting_route.test.cjs:267-278「remain unavailable without
    //     authoritative payloads」+ tools/combined_startup.test.cjs:124-126
    //     「协议版本文件没有权威 payload，保持未实现」），没有权威 payload 前必须继续 404。
    const telemetryAck = { code: 0 } as const
    for (const route of [
        "/behavior_log/report",
        "/api/device/report",
        "/api/iplog/report",
    ] as const) {
        fastify.post(route, async (_request, reply) => {
            return reply.type("application/json").send(telemetryAck)
        })
    }

    // 社区入口（micro_red）：同族端点（/logmonitor、/api/skan）回 `{code:0,data:{}}`，
    // 形状保持一致。**未验证**：客户端是否据 `data` 里的字段决定跳转社区页（静态判不了），
    // 空 `data` 是最保守的选择；若真机出现「点了社区没反应/白页」，先怀疑这里。
    fastify.get("/api/micro/micro_red/enter_position", async (_request, reply) => {
        return reply.type("application/json").send({ code: 0, data: {} })
    })

    // Leiting SDK 登录 mock（任何凭据都接受，但身份**按设备派生**）
    for (const p of iosLoginPaths) {
        fastify.all(p, (request, reply) => {
            if (config === null) {
                unconfiguredReplies += 1
                if (unconfiguredReplies === 1) {
                    console.warn(`[iOS-SDK-LOGIN] refusing to issue a shared identity: ${identityConfig.ok ? "" : identityConfig.reason}`)
                }
                reply.send(loginFailure("ios-sdk-login-unconfigured"))
                return
            }
            const device = resolveDeviceKey(request, config)
            if (device === null) {
                console.warn(`[iOS-SDK-LOGIN] no device identifier on ${p} (strict mode); refusing`)
                reply.send(loginFailure("ios-sdk-login-device-unknown"))
                return
            }
            const bean = buildIosSdkBean(device.deviceKey, config)
            console.log(`[iOS-SDK-LOGIN] ${p} user=${bean.userId} src=${device.source} fp=${device.fingerprint}`)
            reply.send({ ...iosLoginOKShape, data: bean.data })
        })
    }
    for (const p of iosStubPaths) {
        fastify.all(p, (_req, reply) => { console.log("[iOS-SDK-STUB] " + p); reply.send(iosStatusOK); });
    }

    // iOS 公告端点：SDK 的 getNotice 弹窗通道（= 玩家能看到绑定验证码的地方）。
    // 默认开通、默认霰弹字段；真机探针确认 SDK 实际读哪个字段后，把 notice.shotgun 设成 false 收窄。
    const noticeHandler = createIosNoticeHandler(noticeOptions)
    for (const p of IOS_NOTICE_PATHS) {
        fastify.post(p, noticeHandler)
    }
    console.log(`[iOS-NOTICE] notice endpoints ready (${IOS_NOTICE_PATHS.length} paths, shotgun=${noticeOptions.shotgun ?? true}, provideCode=${noticeOptions.provideCode ? "injected" : "fallback-text"})`)
}
