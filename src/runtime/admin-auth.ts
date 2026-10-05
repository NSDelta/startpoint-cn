/**
 * 管理后台（/admin/ 与 /api/* 管理面）的口令闸门 —— 公网部署的必需件。
 *
 * 为什么需要它：`/admin/` 是完整的管理控制台（改存档、发邮件、重置账号、看在线状态），
 * 而 `/api/*` 下的管理接口此前**没有任何认证**。一旦 8001 暴露到公网，等于把后台交给
 * 所有人。本模块把「后台必须过口令」做成服务端强制，而不是靠反代或安全组"记得配"。
 *
 * 两种模式（由环境变量决定，`resolveAdminAuthConfig`）：
 *
 *   - `ADMIN_PASSWORD` 已设置  → **口令模式**：任何来源访问后台都必须先登录，登录后发一枚
 *     随机会话 Cookie（HttpOnly + SameSite=Strict）。会话只存在内存里，重启即失效。
 *   - `ADMIN_PASSWORD` 未设置  → **仅本机模式**：只有来源地址是回环地址的请求可以访问后台，
 *     其余一律 403。这是"没配口令也不至于裸奔"的兜底，不是"开放"。
 *
 * 之所以要区分这两种模式：开发/测试环境直接 `http://127.0.0.1:8001/admin/` 打开就能用，
 * 不需要先想一个口令；而一旦这台机器对外提供服务，就必须走口令模式。
 *
 * 边界与取舍：
 *   - 口令比较用 bcrypt（复用 `src/lib/sp-auth/password.ts`，cost 10），与玩家账号同一套实现；
 *   - 会话令牌只用 `randomBytes`，不签名、不落盘 —— 进程内存即真相，重启后所有会话失效；
 *   - 连续失败会按来源地址锁定一段时间（防在线爆破），成功即清零；
 *   - **不信任 `X-Forwarded-For`**，除非显式 `ADMIN_TRUST_PROXY=1`：否则任何人加一个
 *     `X-Forwarded-For: 127.0.0.1` 就能骗过"仅本机模式"。
 */

import { randomBytes } from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { hashPassword, verifyPasswordHash } from "../lib/sp-auth/password"

/** 配口令时用的环境变量；运行时只读一次。 */
export const ADMIN_PASSWORD_ENV = "ADMIN_PASSWORD"
/** 登录用户名；默认 `admin`。 */
export const ADMIN_USERNAME_ENV = "ADMIN_USERNAME"
/** 设为 `1` 才信任 `X-Forwarded-For`（反代场景）。 */
export const ADMIN_TRUST_PROXY_ENV = "ADMIN_TRUST_PROXY"

/** 会话 Cookie 名。 */
export const ADMIN_SESSION_COOKIE = "spcn_admin_session"

/** 口令最短长度：低于这个值直接判为配置错误，不让它上线。 */
export const ADMIN_PASSWORD_MIN_LENGTH = 8
/** 单次登录会话时长。 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** 同一来源地址连续失败多少次后锁定。 */
export const ADMIN_LOGIN_MAX_FAILURES = 5
/** 锁定时长。 */
export const ADMIN_LOGIN_LOCKOUT_MS = 10 * 60 * 1000
/** 会话表上限，防止无限增长。 */
const ADMIN_SESSION_MAX_ENTRIES = 512
/** 失败计数表上限。 */
const ADMIN_FAILURE_MAX_ENTRIES = 1024

/**
 * 需要口令的后台路径。
 *
 * 刻意用**精确前缀**而不是"除游戏 API 之外全要"：游戏 API 挂在 `/api/index.php`，
 * 与本列表没有包含关系，且 `/sp-auth`、`/sdk`、资产路由等都要对玩家开放。
 * 新增管理接口时**必须**在这里登记，否则它就是裸奔的 —— 契约测试会检查这份清单
 * 与 `src/routes/web_api/index.ts` 里注册的子插件一致。
 */
export const ADMIN_PROTECTED_API_PREFIXES: readonly string[] = [
    "/api/player",
    "/api/server",
    "/api/mail",
    "/api/news",
    "/api/gifts",
    "/api/bindings",
    "/api/bot",
    "/api/lookup",
    "/api/scheduled-resource",
    "/api/seeds",
]

/** 免登录的后台路径（登录/登出自身，否则会死循环）。 */
const ADMIN_PUBLIC_PATHS: readonly string[] = ["/admin/login", "/admin/logout"]

export type AdminAuthMode = "password" | "loopback-only"

export interface AdminAuthConfig {
    readonly mode: AdminAuthMode
    /** 口令模式下的默认用户名。 */
    readonly username: string
    /** 口令模式下启动时算出的 bcrypt 哈希；仅本机模式为 null。 */
    readonly passwordHash: string | null
    readonly trustProxy: boolean
}

/**
 * 读取并校验后台认证配置。**任何配置错误都抛异常**（而不是退回开放）——
 * 一个静默降级的口令闸门比没有闸门更危险。
 *
 * 绝不读取 `process.env`：按本仓库 CC-4 约定由调用方注入环境对象。
 */
export function resolveAdminAuthConfig(env: NodeJS.ProcessEnv = process.env): AdminAuthConfig {
    const rawPassword = env[ADMIN_PASSWORD_ENV]
    const trustProxy = env[ADMIN_TRUST_PROXY_ENV] === "1"
    const rawUsername = env[ADMIN_USERNAME_ENV]
    const username = typeof rawUsername === "string" && rawUsername.trim() !== ""
        ? rawUsername.trim()
        : "admin"

    if (rawPassword === undefined || rawPassword === null || rawPassword.trim() === "") {
        return { mode: "loopback-only", username, passwordHash: null, trustProxy }
    }
    if (rawPassword !== rawPassword.trim()) {
        throw new Error(
            `${ADMIN_PASSWORD_ENV} 首尾不能有空白字符（多半是从配置文件里复制时带进来的）`,
        )
    }
    if ([...rawPassword].length < ADMIN_PASSWORD_MIN_LENGTH) {
        throw new Error(`${ADMIN_PASSWORD_ENV} 至少 ${ADMIN_PASSWORD_MIN_LENGTH} 个字符`)
    }
    return {
        mode: "password",
        username,
        passwordHash: hashPassword(rawPassword),
        trustProxy,
    }
}

/** 该路径是否需要后台认证。 */
export function isAdminProtectedPath(pathname: string): boolean {
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        return !ADMIN_PUBLIC_PATHS.some(allowed => pathname === allowed || pathname.startsWith(`${allowed}/`))
    }
    return ADMIN_PROTECTED_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** 只要请求头里带了 `text/html`（含通配的任意类型）就当作"人用浏览器在看页面"。 */
function prefersHtml(request: FastifyRequest): boolean {
    const accept = request.headers.accept
    if (accept === undefined || accept.trim() === "") return true
    return accept.split(",").some(part => {
        const mediaType = part.split(";", 1)[0].trim().toLowerCase()
        return mediaType === "text/html" || mediaType === "text/*" || mediaType === "*/*"
    })
}

/**
 * 请求来源地址。`ADMIN_TRUST_PROXY=1` 时取 `X-Forwarded-For` 最左段，
 * 否则一律用 TCP 对端地址（伪造请求头不影响判定）。
 */
export function requestClientAddress(request: FastifyRequest, config: AdminAuthConfig): string {
    if (config.trustProxy) {
        const forwarded = request.headers["x-forwarded-for"]
        const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
        if (typeof raw === "string" && raw.trim() !== "") {
            const first = raw.split(",")[0]?.trim()
            if (first !== undefined && first !== "") return first
        }
    }
    return request.ip ?? ""
}

const LOOPBACK_V4_PATTERN = /^127\./
const IPV4_MAPPED_PREFIX = "::ffff:"

/** 是否回环地址（本机模式据此放行）。 */
export function isLoopbackAddress(address: string): boolean {
    let candidate = address.trim().toLowerCase()
    if (candidate === "") return false
    if (candidate.startsWith("[") && candidate.endsWith("]")) candidate = candidate.slice(1, -1)
    if (candidate.startsWith(IPV4_MAPPED_PREFIX)) candidate = candidate.slice(IPV4_MAPPED_PREFIX.length)
    if (candidate === "::1" || candidate === "localhost") return true
    return LOOPBACK_V4_PATTERN.test(candidate)
}

function parseCookies(header: string | undefined): Map<string, string> {
    const jar = new Map<string, string>()
    if (header === undefined) return jar
    for (const part of header.split(";")) {
        const separator = part.indexOf("=")
        if (separator <= 0) continue
        const name = part.slice(0, separator).trim()
        if (name === "") continue
        jar.set(name, part.slice(separator + 1).trim())
    }
    return jar
}

interface AdminSession {
    readonly username: string
    expiresAt: number
}

/** 会话表 + 失败计数表；进程内存，重启即清空。 */
interface AdminAuthState {
    readonly sessions: Map<string, AdminSession>
    readonly failures: Map<string, { count: number; lockedUntil: number }>
}

function pruneSessions(state: AdminAuthState, now: number): void {
    for (const [token, session] of state.sessions) {
        if (session.expiresAt <= now) state.sessions.delete(token)
    }
    while (state.sessions.size >= ADMIN_SESSION_MAX_ENTRIES) {
        const oldest = state.sessions.keys().next()
        if (oldest.done === true) break
        state.sessions.delete(oldest.value)
    }
}

function loginFailure(state: AdminAuthState, key: string, now: number): { readonly locked: boolean; readonly retryAfterSeconds: number } {
    const current = state.failures.get(key)
    if (current !== undefined && current.lockedUntil > now) {
        return { locked: true, retryAfterSeconds: Math.ceil((current.lockedUntil - now) / 1000) }
    }
    const count = (current?.count ?? 0) + 1
    const lockedUntil = count >= ADMIN_LOGIN_MAX_FAILURES ? now + ADMIN_LOGIN_LOCKOUT_MS : 0
    if (state.failures.size > ADMIN_FAILURE_MAX_ENTRIES) {
        for (const [candidate, entry] of state.failures) {
            if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) state.failures.delete(candidate)
        }
    }
    state.failures.set(key, { count: lockedUntil === 0 ? count : 0, lockedUntil })
    return {
        locked: lockedUntil !== 0,
        retryAfterSeconds: lockedUntil === 0 ? 0 : Math.ceil(ADMIN_LOGIN_LOCKOUT_MS / 1000),
    }
}

function issueSession(state: AdminAuthState, username: string, now: number): string {
    pruneSessions(state, now)
    const token = randomBytes(32).toString("base64url")
    state.sessions.set(token, { username, expiresAt: now + ADMIN_SESSION_TTL_MS })
    return token
}

function sessionFor(state: AdminAuthState, request: FastifyRequest, now: number): AdminSession | null {
    const token = parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE)
    if (token === undefined || token === "") return null
    const session = state.sessions.get(token)
    if (session === undefined) return null
    if (session.expiresAt <= now) {
        state.sessions.delete(token)
        return null
    }
    return session
}

/** 会话 Cookie 的公共属性；`secure` 由调用方按部署是否走 TLS 决定。 */
function sessionCookieHeader(token: string, secure: boolean): string {
    const attributes = [
        `${ADMIN_SESSION_COOKIE}=${token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
    ]
    if (secure) attributes.push("Secure")
    return attributes.join("; ")
}

function clearCookieHeader(): string {
    return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}

/**
 * 登录页。刻意做成内联 HTML（不走 SPA）：未登录时 `/admin/` 的静态资源本就被挡住，
 * 若登录页也依赖 SPA 资源，就会出现"要加载被保护资源才能登录"的死结。
 *
 * 不引入任何外部资源（字体/CDN），内网与离线环境同样能用。
 */
function loginPageHtml(username: string, mode: AdminAuthMode, notice: string | null): string {
    const loopbackHint = mode === "loopback-only"
        ? `<p class="hint">当前是<b>仅本机模式</b>：服务端没有设置 <code>${ADMIN_PASSWORD_ENV}</code>，
           因此只允许从这台机器本身访问后台。要让公网也能进后台，请在 <code>.env</code> 里设置
           <code>${ADMIN_PASSWORD_ENV}</code> 后重启服务。</p>`
        : ""
    const noticeHtml = notice === null ? "" : `<p class="error" role="alert">${escapeHtml(notice)}</p>`
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>StarPoint CN 管理后台 · 登录</title>
<style>
    :root { color-scheme: light dark; --bg:#f5f6f8; --card:#ffffff; --fg:#1f2329; --muted:#646a73;
            --border:#e5e6eb; --primary:#1664ff; --danger:#d4380d; --field:#ffffff; }
    @media (prefers-color-scheme: dark) {
        :root { --bg:#16181c; --card:#1f2229; --fg:#e8eaed; --muted:#9aa0a6; --border:#31343c;
                --primary:#4c8dff; --danger:#ff7875; --field:#15171b; }
    }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
           padding:24px; background:var(--bg); color:var(--fg); font-size:14px;
           font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
    main { width:100%; max-width:380px; background:var(--card); border:1px solid var(--border);
           border-radius:12px; padding:28px 24px; box-shadow:0 8px 28px rgb(0 0 0 / 8%); }
    h1 { margin:0 0 4px; font-size:18px; }
    .sub { margin:0 0 20px; color:var(--muted); font-size:12.5px; }
    label { display:block; margin:14px 0 6px; font-size:13px; color:var(--muted); }
    input { width:100%; padding:9px 11px; font-size:14px; color:var(--fg); background:var(--field);
            border:1px solid var(--border); border-radius:8px; }
    input:focus { outline:2px solid var(--primary); outline-offset:-1px; border-color:transparent; }
    button { width:100%; margin-top:20px; padding:10px; font-size:14px; font-weight:600; color:#fff;
             background:var(--primary); border:0; border-radius:8px; cursor:pointer; }
    button:disabled { opacity:.6; cursor:progress; }
    .error { margin:14px 0 0; padding:9px 11px; color:var(--danger); font-size:13px;
             border:1px solid currentColor; border-radius:8px; }
    .hint { margin:18px 0 0; color:var(--muted); font-size:12px; line-height:1.6; }
    code { padding:1px 5px; font-size:12px; background:var(--bg); border-radius:4px; }
    .foot { margin:18px 0 0; color:var(--muted); font-size:12px; text-align:center; }
</style>
</head>
<body>
<main>
    <h1>StarPoint CN 管理后台</h1>
    <p class="sub">World Flipper Server</p>
    <form id="login" method="post" action="/admin/login" autocomplete="on">
        <label for="username">用户名</label>
        <input id="username" name="username" value="${escapeHtml(username)}" autocomplete="username" required>
        <label for="password">口令</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
        <button type="submit">登录</button>
    </form>
    ${noticeHtml}
    ${loopbackHint}
    <p class="foot">连续输错 ${ADMIN_LOGIN_MAX_FAILURES} 次会锁定 ${Math.round(ADMIN_LOGIN_LOCKOUT_MS / 60000)} 分钟</p>
</main>
<script>
(function () {
    var form = document.getElementById("login")
    form.addEventListener("submit", function (event) {
        event.preventDefault()
        var button = form.querySelector("button")
        button.disabled = true
        fetch("/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                username: document.getElementById("username").value,
                password: document.getElementById("password").value
            })
        }).then(function (response) {
            return response.json().catch(function () { return {} }).then(function (body) {
                if (response.ok) { window.location.replace("/admin/"); return }
                var current = document.querySelector(".error")
                if (current) current.remove()
                var error = document.createElement("p")
                error.className = "error"
                error.setAttribute("role", "alert")
                error.textContent = body.error || ("登录失败（HTTP " + response.status + "）")
                form.insertAdjacentElement("afterend", error)
                button.disabled = false
            })
        }).catch(function () {
            button.disabled = false
            alert("无法连接服务端，请确认服务已启动")
        })
    })
})()
</script>
</body>
</html>
`
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

export interface AdminAuthInstallOptions {
    readonly config: AdminAuthConfig
    /** 覆盖"当前时间"，便于测试；默认 `Date.now`。 */
    readonly now?: () => number
    /** 会话 Cookie 是否带 `Secure`（部署在 TLS 之后时设 true）。 */
    readonly secureCookie?: boolean
    /** 关掉启动横幅（测试用）。 */
    readonly quiet?: boolean
}

/**
 * 注册后台认证：一个 `onRequest` 闸门 + `/admin/login`、`/admin/logout` 两条路由。
 *
 * 必须在任何后台路由（`registerAdminUi`、`routes/web_api`）**之前**调用 ——
 * 这里用的是全局 `onRequest` 钩子，它对之后注册的所有路由生效。
 */
export function installAdminAuth(
    fastify: FastifyInstance,
    options: AdminAuthInstallOptions,
): void {
    const config = options.config
    const now = options.now ?? (() => Date.now())
    const state: AdminAuthState = { sessions: new Map(), failures: new Map() }

    fastify.get("/admin/login", async (request, reply) => {
        if (config.mode === "loopback-only" && !isLoopbackAddress(requestClientAddress(request, config))) {
            reply.status(403).type("text/plain; charset=utf-8")
                .send(`后台未设置 ${ADMIN_PASSWORD_ENV}，当前只允许从服务器本机访问。`)
            return
        }
        reply.header("cache-control", "no-store").type("text/html; charset=utf-8")
            .send(loginPageHtml(config.username, config.mode, null))
    })

    fastify.post("/admin/login", async (request, reply) => {
        const address = requestClientAddress(request, config)
        const wantsJson = !prefersHtml(request)
        // 两种提交形态都要能读：登录页用 fetch 发 JSON；`/admin/login` 也接受
        // HTML 表单（真实入口把表单正文解析成 URLSearchParams）。
        const rawBody = (request.body ?? {}) as Record<string, unknown>
        const fieldOf = (name: string): string => {
            if (rawBody instanceof URLSearchParams) return rawBody.get(name) ?? ""
            const value = rawBody[name]
            return typeof value === "string" ? value : ""
        }
        const username = fieldOf("username").trim()
        const password = fieldOf("password")

        const fail = (status: number, message: string, retryAfterSeconds = 0) => {
            if (retryAfterSeconds > 0) reply.header("retry-after", String(retryAfterSeconds))
            if (wantsJson) {
                reply.status(status).send({ error: message })
                return
            }
            reply.status(status).header("cache-control", "no-store").type("text/html; charset=utf-8")
                .send(loginPageHtml(config.username, config.mode, message))
        }

        if (config.mode === "loopback-only") {
            // 本机模式没有口令可验：来源地址就是全部依据。
            if (isLoopbackAddress(address)) {
                reply.redirect("/admin/", 303)
                return
            }
            fail(403, `后台未设置 ${ADMIN_PASSWORD_ENV}，当前只允许从服务器本机访问。`)
            return
        }

        const current = now()
        const lock = state.failures.get(address)
        if (lock !== undefined && lock.lockedUntil > current) {
            fail(429, "失败次数过多，已暂时锁定，请稍后再试。", Math.ceil((lock.lockedUntil - current) / 1000))
            return
        }

        const usernameMatches = username === config.username
        const passwordMatches = verifyPasswordHash(password, config.passwordHash)
        if (!usernameMatches || !passwordMatches) {
            const outcome = loginFailure(state, address, current)
            request.log.warn({ address, username }, "admin login rejected")
            if (outcome.locked) {
                fail(429, "失败次数过多，已暂时锁定，请稍后再试。", outcome.retryAfterSeconds)
                return
            }
            fail(401, "用户名或口令不正确。")
            return
        }

        state.failures.delete(address)
        const token = issueSession(state, config.username, current)
        reply.header("set-cookie", sessionCookieHeader(token, options.secureCookie === true))
        request.log.info({ address }, "admin login accepted")
        if (wantsJson) {
            reply.status(200).send({ username: config.username, expiresInSeconds: Math.floor(ADMIN_SESSION_TTL_MS / 1000) })
            return
        }
        reply.redirect("/admin/", 303)
    })

    const logout = async (request: FastifyRequest, reply: FastifyReply) => {
        const token = parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE)
        if (token !== undefined) state.sessions.delete(token)
        reply.header("set-cookie", clearCookieHeader()).redirect("/admin/login", 303)
    }
    fastify.get("/admin/logout", logout)
    fastify.post("/admin/logout", logout)

    fastify.addHook("onRequest", async (request, reply) => {
        const pathname = request.url.split("?", 1)[0] ?? ""
        if (!isAdminProtectedPath(pathname)) return

        if (config.mode === "loopback-only") {
            if (isLoopbackAddress(requestClientAddress(request, config))) return
            if (prefersHtml(request)) {
                reply.status(403).header("cache-control", "no-store").type("text/html; charset=utf-8")
                    .send(loginPageHtml(config.username, config.mode, `后台未设置 ${ADMIN_PASSWORD_ENV}，当前只允许从服务器本机访问。`))
                return
            }
            await reply.status(403).send({ error: `后台未设置 ${ADMIN_PASSWORD_ENV}，当前只允许从服务器本机访问。` })
            return
        }

        if (sessionFor(state, request, now()) !== null) return

        if (prefersHtml(request)) {
            reply.redirect("/admin/login", 303)
            return
        }
        await reply.status(401).send({ error: "需要登录管理后台" })
    })

    if (options.quiet !== true) {
        const detail = config.mode === "password"
            ? `口令模式（用户名 ${config.username}，会话 ${Math.round(ADMIN_SESSION_TTL_MS / 3600000)} 小时）`
            : "仅本机模式（未设置 ADMIN_PASSWORD，只允许回环地址访问后台）"
        console.log(`[ADMIN-AUTH] ${detail}${config.trustProxy ? "，信任 X-Forwarded-For" : ""}`)
    }
}
