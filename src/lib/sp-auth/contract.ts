/**
 * Contract C1 (`/sp-auth/*`) wire types + field validation rules.
 *
 * The JSON shape and the error-code dictionary are frozen by the work
 * division document (§3.2 / C7). Every code below is shared with P5/P6/P8/P9,
 * so values must never be renamed or re-spelled — add a new one instead.
 */

import type { BindingPlatform, BindState, SignupCodeStatus } from "../../data/types"

// ---------------------------------------------------------------------------
// Error codes (C7)
// ---------------------------------------------------------------------------

export const SP_AUTH_ERROR_CODES = [
    "USERNAME_TAKEN",
    "USERNAME_INVALID",
    "PASSWORD_WEAK",
    "DEVICE_TAKEN",
    "RATE_LIMITED",
    "BAD_CREDENTIALS",
    "BIND_REQUIRED",
    "ACCOUNT_DISABLED",
    "TOKEN_INVALID",
    "CODE_INVALID",
    "CODE_EXPIRED",
    "CODE_USED",
    "CODE_LOCKED",
    // Added by the self-service password reset ("忘记密码") cards. Existing
    // values above are frozen and must not be renamed or reordered.
    "ACCOUNT_NOT_FOUND",
    "RESET_NO_QQ",
    "RESET_CODE_INVALID",
    "RESET_NOT_CONFIRMED",
    "CODE_NOT_FOUND",
    "QQ_MISMATCH",
    "SERVICE_UNAVAILABLE",
] as const

export type SpAuthErrorCode = typeof SP_AUTH_ERROR_CODES[number]

/**
 * Chinese client-facing wording (C7). `DEVICE_TAKEN` is quoted verbatim from
 * the contract; the rest follow the same voice. The client shows its own copy
 * for most of these — the message is a fallback / ops aid.
 */
export const SP_AUTH_ERROR_MESSAGES: Record<SpAuthErrorCode, string> = {
    USERNAME_TAKEN: "该登录名已被使用，请换一个。",
    USERNAME_INVALID: "登录名格式不合法（4-20 位字母/数字/下划线，且不能以数字开头）。",
    PASSWORD_WEAK: "密码强度不足（8-64 位，字母/数字/符号都行，不能有空格或中文；大写、小写、数字、符号四类里至少要有两类）。",
    DEVICE_TAKEN: "本机已经注册过账号，请用账号密码登录。",
    RATE_LIMITED: "操作太频繁，请稍后再试。",
    BAD_CREDENTIALS: "登录名或密码不正确。",
    BIND_REQUIRED: "该账号尚未完成 QQ/KOOK 绑定。",
    ACCOUNT_DISABLED: "该账号已被停用，请联系管理员。",
    TOKEN_INVALID: "登录状态已失效，请重新登录。",
    CODE_INVALID: "验证码不正确。",
    CODE_EXPIRED: "验证码已过期，请在游戏里重新获取。",
    CODE_USED: "验证码已被使用。",
    CODE_LOCKED: "验证码尝试次数过多，已锁定，请重新获取。",
    ACCOUNT_NOT_FOUND: "没有找到这个账号，请检查登录名或 QQ 号是否填对。",
    RESET_NO_QQ: "该账号还没有绑定 QQ，无法自助重置密码，请联系管理员。",
    RESET_CODE_INVALID: "重置码不正确，请照抄群里的那串字母数字。",
    RESET_NOT_CONFIRMED: "还没有在群里发送 /reset 确认，请先发一次再提交新密码。",
    CODE_NOT_FOUND: "重置码不存在或已被使用，请在网页上重新获取。",
    QQ_MISMATCH: "发命令的 QQ 与该账号绑定的 QQ 不一致。",
    SERVICE_UNAVAILABLE: "服务暂时不可用，请稍后再试。",
}

// ---------------------------------------------------------------------------
// Wire envelope
// ---------------------------------------------------------------------------

export interface SpAuthSuccess<TData> {
    ok: true
    data: TData
}

export interface SpAuthFailure<TData = unknown> {
    ok: false
    code: SpAuthErrorCode
    message: string
    data?: TData
}

export type SpAuthEnvelope<TData, TFailureData = unknown> =
    | SpAuthSuccess<TData>
    | SpAuthFailure<TFailureData>

// ---------------------------------------------------------------------------
// Response payloads (§3.2)
// ---------------------------------------------------------------------------

export interface SpAuthCodeView {
    code: string
    code_expires_at: string
}

/**
 * Per-request context the **route layer** owns (source IP, …). Never part of the
 * C1 body: it exists so `login`/`register` can join the gate's own device with the
 * device the game reports at `/tool/signup` (see `device-follow.ts`).
 */
export interface SpAuthRequestContext {
    ip?: string
}

/** `POST /sp-auth/register` → data */
export interface SpAuthRegisterData extends SpAuthCodeView {
    token: string
    viewer_id: number
    username: string
    /**
     * Client v5.25+: the device id the **game** uses on this machine, when the
     * server managed to recognise it (device-follow). The gate adopts it so both
     * halves end up on one id. Absent for older clients / when nothing matched.
     */
    game_device_id?: number
}

/** `POST /sp-auth/login` → data */
export interface SpAuthLoginData {
    token: string
    viewer_id: number
    username: string
    bound: true
    /** See {@link SpAuthRegisterData.game_device_id}. */
    game_device_id?: number
}

/** `POST /sp-auth/bind-status` → data */
export interface SpAuthBindStatusData {
    bound: boolean
    code: string | null
    code_expires_at: string | null
    viewer_id?: number
}

/** `POST /sp-auth/resend` → data */
export type SpAuthResendData = SpAuthCodeView

/**
 * `POST /sp-auth/reset-request` → data (self-service "忘记密码").
 *
 * `account` is the normalized username the code belongs to, so the page can
 * show "验证码已发给 <account>" even when the player typed their QQ number.
 * `expiresInSec` is the remaining lifetime of the freshly issued code (900 for
 * the 15 minute default) — the page renders a countdown from it.
 */
export interface SpAuthResetRequestData {
    code: string
    expiresInSec: number
    account: string
}

/** `POST /sp-auth/reset-confirm` → data: just the account that was reset. */
export interface SpAuthResetConfirmData {
    account: string
}

/**
 * `POST /sp-auth/profile` → data.
 *
 * Not in the §3.2 table (added by card A4); the shape mirrors the existing
 * `take_over/get_user_data_by_take_over_data` user payload plus binding state
 * so the page can render "who am I" without another round trip.
 */
export interface SpAuthProfileData {
    viewer_id: number
    username: string
    bound: boolean
    bind_state: BindState
    platform: BindingPlatform | null
    platform_uid_masked: string | null
    display_name: string | null
    bound_at: string | null
    code: string | null
    code_expires_at: string | null
    player_name: string | null
    rank_point: number
    leader_character_id: number
}

/** `POST /sp-auth/logout` → data (empty object, per C1). */
export type SpAuthLogoutData = Record<string, never>

/** `DEVICE_TAKEN` carries the occupying account so the page can suggest login. */
export interface SpAuthDeviceTakenData {
    username: string | null
    viewer_id: number
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface SpAuthRegisterBody {
    username?: unknown
    password?: unknown
    device_id?: unknown
    version?: unknown
}

export interface SpAuthLoginBody {
    login_name?: unknown
    password?: unknown
    device_id?: unknown
}

export interface SpAuthTokenBody {
    token?: unknown
}

/** `POST /sp-auth/reset-request`: username or bound QQ number. */
export interface SpAuthResetRequestBody {
    account?: unknown
}

/** `POST /sp-auth/reset-confirm`: same account field + the code + new password. */
export interface SpAuthResetConfirmBody {
    account?: unknown
    code?: unknown
    password?: unknown
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

/** Login name shape. Reserved loosely: at least one letter, no leading digit. */
export const SP_AUTH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{3,19}$/

/**
 * Password charset. v5.5（业主 m05850「密码强度判断有问题」）：
 * 旧口径是 `[A-Za-z0-9]{8,64}` —— 符号一律判弱，但错误文案从来没说过「不能用符号」，
 * 玩家拿 `Aa123456!` 一看提示「需含大写字母、小写字母和数字」只会觉得判定坏了。
 * 现在放开到**可打印 ASCII**（`!`–`~`，即 0x21–0x7E）：空格、中文、emoji 仍然不行，
 * 但 `!@#$%^&*` 这类常见符号都可以用。
 */
export const SP_AUTH_PASSWORD_PATTERN = /^[!-~]{8,64}$/

/**
 * v5.6（业主 m06468 的 `SpLogin(5).log`）：四类字符里**至少两类**即可。
 * 旧口径要求「大写 + 小写 + 数字」三类齐备 —— 真机上玩家 08:51:34–08:52:55 连发 17 次注册、
 * 17 次全被 `PASSWORD_WEAK` 挡回（`qq123456!`、`wodemima1`、`qqq11111` 这类都被拒），
 * 他看到的只是「登录的下一步没修好」。安全收益极低（8-64 位可打印 ASCII 的搜索空间已经够大），
 * 体验损失极大 ⇒ 放宽为「小写 / 大写 / 数字 / 符号 四类里至少两类」。
 * `tools/sp_auth.test.cjs` 的弱密码表已同步换成新口径下的真弱密码
 * （`12345678` / `abcdefgh` / `ABCDEFGH` / `!!!!!!!!` / `qq 123456` / `带符号 Passw0rd`）。
 */
export const SP_AUTH_PASSWORD_MIN_CLASSES = 2

export interface SpAuthPasswordClasses {
    lower: boolean
    upper: boolean
    digit: boolean
    symbol: boolean
    count: number
}

/** 四类字符计数。仅用于强度判定与「还差什么」的提示文案（永不记录密码本身）。 */
export function describePasswordClasses(value: string): SpAuthPasswordClasses {
    const lower = /[a-z]/.test(value)
    const upper = /[A-Z]/.test(value)
    const digit = /[0-9]/.test(value)
    const symbol = /[^A-Za-z0-9]/.test(value)
    return {
        lower,
        upper,
        digit,
        symbol,
        count: (lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0) + (symbol ? 1 : 0),
    }
}

/** Random grant tokens / idle windows kept in one place for readability. */
export const SP_AUTH_TOKEN_BYTES = 32

export function isValidUsername(value: unknown): value is string {
    return typeof value === "string" && SP_AUTH_USERNAME_PATTERN.test(value)
}

/** v5.6 policy: 8-64 printable ASCII (no spaces / CJK) with at least
 *  `SP_AUTH_PASSWORD_MIN_CLASSES` of {lower, upper, digit, symbol}. */
export function isStrongPassword(value: unknown): value is string {
    if (typeof value !== "string") return false
    if (value.length < 8 || value.length > 64) return false
    if (!SP_AUTH_PASSWORD_PATTERN.test(value)) return false
    return describePasswordClasses(value).count >= SP_AUTH_PASSWORD_MIN_CLASSES
}

/** Positive safe integer device id (`device_grants.device_id`). */
export function parseDeviceId(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Opaque grant token: 32 random bytes hex. */
export function parseToken(value: unknown): string | null {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export function codeStatusIsActive(status: SignupCodeStatus): boolean {
    return status === "pending"
}

/** `12345678` → `1234****5678`; short values collapse to `***`. */
export function maskPlatformUid(uid: string | null): string | null {
    if (!uid) return null
    if (uid.length <= 4) return "****"
    return `${uid.slice(0, 4)}****${uid.slice(-4)}`
}
