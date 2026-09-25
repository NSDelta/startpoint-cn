import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto"
import { FastifyInstance, FastifyRequest } from "fastify"

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
}
