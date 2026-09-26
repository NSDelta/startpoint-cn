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
    PASSWORD_WEAK: "密码强度不足（8-64 位，需同时含大写字母、小写字母和数字）。",
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

/** `POST /sp-auth/register` → data */
export interface SpAuthRegisterData extends SpAuthCodeView {
    token: string
    viewer_id: number
    username: string
}

/** `POST /sp-auth/login` → data */
export interface SpAuthLoginData {
    token: string
    viewer_id: number
    username: string
    bound: true
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

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

/** Login name shape. Reserved loosely: at least one letter, no leading digit. */
export const SP_AUTH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{3,19}$/

/** Existing repo password policy (`src/routes/cn/takeOver.ts:53-61`). */
export const SP_AUTH_PASSWORD_PATTERN = /^[A-Za-z0-9]{8,64}$/

/** Random grant tokens / idle windows kept in one place for readability. */
export const SP_AUTH_TOKEN_BYTES = 32

export function isValidUsername(value: unknown): value is string {
    return typeof value === "string" && SP_AUTH_USERNAME_PATTERN.test(value)
}

/** Same policy as `takeOver.ts`: 8-64 ASCII alnum with upper+lower+digit. */
export function isStrongPassword(value: unknown): value is string {
    return typeof value === "string"
        && value.length >= 8
        && value.length <= 64
        && SP_AUTH_PASSWORD_PATTERN.test(value)
        && /[A-Z]/.test(value)
        && /[a-z]/.test(value)
        && /[0-9]/.test(value)
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
