"use strict"

// 后台口令闸门（src/runtime/admin-auth.ts）的行为与契约测试。
//
// 三类断言：
//   1. 覆盖清单 —— isAdminProtectedPath 必须护住"全部管理面"，且绝不误伤游戏 API。
//   2. 配置解析 —— 没口令 = 仅本机模式；口令非法 = 启动失败（绝不静默降级成无认证）。
//   3. 运行时 —— 真的经 Fastify 钩子跑一遍：未登录被挡、登录后可进、退出后失效、锁定生效。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const repositoryRoot = path.resolve(__dirname, "..")
const adminAuthPath = path.join(repositoryRoot, "src/runtime/admin-auth.ts")
const webApiIndexPath = path.join(repositoryRoot, "src/routes/web_api/index.ts")
const cnServerPath = path.join(repositoryRoot, "src/cn-server.ts")

/**
 * 与 src/cn-server.ts 同款：把表单正文解析成 `URLSearchParams`。
 * 真实入口用 fastify 自带的 `application/x-www-form-urlencoded` 解析器，
 * 这里显式注册一次，保证登录页的表单提交路径被真正覆盖到。
 */
function installFormParser(app) {
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, new URLSearchParams(body)),
    )
    return app
}

function loadAdminAuth() {
    assert.equal(fs.existsSync(adminAuthPath), true, "required admin auth module must exist")
    return require(adminAuthPath)
}

const PASSWORD = "starpoint-admin-2026"

/** 口令模式下的最小请求上下文；`ip` 可换成非回环以模拟公网来源。 */
function createPasswordApp(t, { username } = {}) {
    const auth = loadAdminAuth()
    const app = installFormParser(Fastify({ logger: false }))
    app.get("/api/server/status", async () => ({ ok: true }))
    app.get("/api/index.php/tool/signup", async () => ({ game: true }))
    app.get("/admin/", async () => "admin shell")
    const config = auth.resolveAdminAuthConfig({
        [auth.ADMIN_PASSWORD_ENV]: PASSWORD,
        ...(username === undefined ? {} : { [auth.ADMIN_USERNAME_ENV]: username }),
    })
    auth.installAdminAuth(app, { config })
    t.after(() => app.close())
    return { app, auth }
}

/** 登录并返回会话 Cookie（形如 `spcn_admin_session=<token>`）。 */
async function login(app, auth, { username, password } = {}) {
    const response = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": "application/json", accept: "application/json" },
        payload: {
            username: username ?? auth.resolveAdminAuthConfig({ [auth.ADMIN_PASSWORD_ENV]: PASSWORD }).username,
            password: password ?? PASSWORD,
        },
    })
    return { response, cookie: sessionCookieOf(response) }
}

/** SPA / 客户端视角的请求：显式声明只要 JSON，因此不会被重定向到登录页。 */
function apiRequest(app, url, options = {}) {
    return app.inject({
        method: "GET",
        url,
        ...options,
        headers: { accept: "application/json", ...(options.headers ?? {}) },
    })
}

function sessionCookieOf(response) {
    const raw = response.headers["set-cookie"]
    const header = Array.isArray(raw) ? raw[0] : raw
    if (typeof header !== "string") return null
    return header.split(";")[0]
}

test("admin protection list covers every management prefix registered under /api", () => {
    const { ADMIN_PROTECTED_API_PREFIXES, isAdminProtectedPath } = loadAdminAuth()
    const webApiSource = fs.readFileSync(webApiIndexPath, "utf8")

    // src/routes/web_api/index.ts 里每个注册前缀都必须是受保护清单的前缀或子路径。
    const registered = [...webApiSource.matchAll(/prefix:\s*"(\/[^"]+)"/g)].map(match => match[1])
    assert.equal(registered.includes("/player"), true, "web api contract changed: /player is missing")
    for (const prefix of registered) {
        const full = `/api${prefix}`
        assert.equal(
            isAdminProtectedPath(full),
            true,
            `管理面 ${full} 必须被后台闸门覆盖：请把它加进 ADMIN_PROTECTED_API_PREFIXES`,
        )
        assert.equal(
            ADMIN_PROTECTED_API_PREFIXES.some(entry => full === entry || full.startsWith(`${entry}/`)),
            true,
            `${full} 只被 isAdminProtectedPath 覆盖，清单里找不到对应前缀`,
        )
    }

    // 顶层单独注册的两个（cn-server.ts）也要覆盖。
    const cnServerSource = fs.readFileSync(cnServerPath, "utf8")
    assert.match(cnServerSource, /indexWebApiPlugin,\s*\{\s*prefix:\s*"\/api"/, "cn-server must register the web api under /api")
    assert.match(cnServerSource, /seedsWebApiPlugin,\s*\{\s*prefix:\s*"\/api\/seeds"/, "cn-server must register seeds under /api/seeds")
    assert.equal(isAdminProtectedPath("/api/seeds"), true)
    assert.equal(isAdminProtectedPath("/api/seeds/42/delete"), true)
    for (const prefix of ["/api/player", "/api/server/accounts", "/api/mail/send", "/api/news", "/api/gifts",
        "/api/bindings", "/api/bot/bind", "/api/lookup", "/api/scheduled-resource", "/api/seeds"]) {
        assert.equal(isAdminProtectedPath(prefix), true, `${prefix} 必须受保护`)
    }
})

test("admin protection never blocks the game API or the public auth surface", () => {
    const { isAdminProtectedPath } = loadAdminAuth()

    for (const pathname of [
        "/api/index.php",
        "/api/index.php/tool/signup",
        "/api/index.php/asset/get_path",
        "/api/index.php/assetintitle",
        "/sp-auth/login",
        "/sp-auth/bind/verify",
        "/patch/cn/path",
        "/healthz",
        "/",
    ]) {
        assert.equal(isAdminProtectedPath(pathname), false, `${pathname} 不是管理面，不能被闸门挡住`)
    }

    // /admin 前缀整体受保护，只有登录/退出两条白名单例外。
    assert.equal(isAdminProtectedPath("/admin"), true)
    assert.equal(isAdminProtectedPath("/admin/"), true)
    assert.equal(isAdminProtectedPath("/admin/assets/index-DKgNOd-p.js"), true)
    assert.equal(isAdminProtectedPath("/admin/accounts"), true)
    assert.equal(isAdminProtectedPath("/admin/login"), false)
    assert.equal(isAdminProtectedPath("/admin/logout"), false)
})

test("missing password resolves to loopback-only mode instead of no auth", () => {
    const { resolveAdminAuthConfig, ADMIN_PASSWORD_ENV } = loadAdminAuth()

    for (const env of [{}, { [ADMIN_PASSWORD_ENV]: "" }, { [ADMIN_PASSWORD_ENV]: "   " }]) {
        const config = resolveAdminAuthConfig(env)
        assert.equal(config.mode, "loopback-only")
        assert.equal(config.passwordHash, null)
        assert.equal(config.username, "admin")
    }
})

test("startup rejects a weak or malformed password instead of degrading to no auth", () => {
    const { resolveAdminAuthConfig, ADMIN_PASSWORD_ENV, ADMIN_PASSWORD_MIN_LENGTH } = loadAdminAuth()

    assert.equal(ADMIN_PASSWORD_MIN_LENGTH >= 8, true)
    assert.throws(
        () => resolveAdminAuthConfig({ [ADMIN_PASSWORD_ENV]: "short" }),
        /ADMIN_PASSWORD/,
    )
    assert.throws(
        () => resolveAdminAuthConfig({ [ADMIN_PASSWORD_ENV]: " padded-secret " }),
        /ADMIN_PASSWORD/,
    )
})

test("password mode stores a bcrypt hash and never the plaintext", () => {
    const { resolveAdminAuthConfig, ADMIN_PASSWORD_ENV, ADMIN_USERNAME_ENV } = loadAdminAuth()
    const config = resolveAdminAuthConfig({ [ADMIN_PASSWORD_ENV]: PASSWORD, [ADMIN_USERNAME_ENV]: "  owner  " })

    assert.equal(config.mode, "password")
    assert.equal(config.username, "owner")
    assert.match(config.passwordHash, /^\$2[aby]\$/)
    assert.equal(config.passwordHash.includes(PASSWORD), false)
})

test("trust proxy is off unless explicitly enabled", () => {
    const auth = loadAdminAuth()
    // 真实请求里 `request.ip` 来自 TCP 对端；测试直接用最小替身喂给它。
    const request = { headers: { "x-forwarded-for": "203.0.113.9" }, ip: "10.0.0.5" }
    const plain = { headers: {}, ip: "10.0.0.5" }

    assert.equal(auth.requestClientAddress(request, { trustProxy: false }), "10.0.0.5")
    assert.equal(auth.requestClientAddress(request, { trustProxy: true }), "203.0.113.9")
    assert.equal(auth.requestClientAddress(plain, { trustProxy: true }), "10.0.0.5")
    // 带空白或全空的 X-Forwarded-For 不能改变判定结果。
    for (const forwarded of ["   ", ",", ""]) {
        assert.equal(
            auth.requestClientAddress({ headers: { "x-forwarded-for": forwarded }, ip: "10.0.0.5" }, { trustProxy: true }),
            "10.0.0.5",
        )
    }
    // 多级代理只取最左段（最靠近客户端的那个地址）。
    assert.equal(
        auth.requestClientAddress({ headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.7" }, ip: "10.0.0.5" }, { trustProxy: true }),
        "203.0.113.9",
    )
})

test("loopback detection covers v4, v6 and the v4-mapped form", () => {
    const { isLoopbackAddress } = loadAdminAuth()

    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
        assert.equal(isLoopbackAddress(address), true, `${address} 应判定为回环`)
    }
    for (const address of ["192.168.1.10", "10.0.0.5", "203.0.113.9", "::ffff:192.168.1.10", "", "nonsense"]) {
        assert.equal(isLoopbackAddress(address), false, `${address} 不应判定为回环`)
    }
})

test("loopback-only mode keeps outsiders out of the admin surface", async t => {
    const { resolveAdminAuthConfig, installAdminAuth } = loadAdminAuth()
    const app = Fastify({ logger: false })
    app.get("/api/server/status", async () => ({ ok: true }))
    app.get("/admin/", async () => "admin shell")
    installAdminAuth(app, { config: resolveAdminAuthConfig({}) })
    t.after(() => app.close())

    const local = await app.inject({ method: "GET", url: "/admin/" })
    assert.equal(local.statusCode, 200)

    const remote = await app.inject({ method: "GET", url: "/admin/", remoteAddress: "203.0.113.9" })
    assert.equal(remote.statusCode, 403)
    const remoteApi = await app.inject({ method: "GET", url: "/api/server/status", remoteAddress: "203.0.113.9" })
    assert.equal(remoteApi.statusCode, 403)

    // 仅本机模式下登录页只作说明，不给可用表单。
    const loginPage = await app.inject({ method: "GET", url: "/admin/login" })
    assert.equal(loginPage.statusCode, 200)
    assert.match(loginPage.payload, /仅本机|ADMIN_PASSWORD/)
})

test("password mode blocks unauthenticated admin and api requests", async t => {
    const { app } = createPasswordApp(t)

    const page = await app.inject({ method: "GET", url: "/admin/", headers: { accept: "text/html" } })
    assert.equal(page.statusCode, 303)
    assert.equal(page.headers.location, "/admin/login")

    const api = await apiRequest(app, "/api/server/status")
    assert.equal(api.statusCode, 401)
    assert.equal(JSON.parse(api.payload).error.includes("登录"), true)

    const asset = await app.inject({ method: "GET", url: "/admin/assets/index-DKgNOd-p.js" })
    assert.equal(asset.statusCode, 303)
    assert.equal(asset.headers.location, "/admin/login")

    // 游戏 API 不受影响：没有后台身份也能正常进游戏。
    const game = await apiRequest(app, "/api/index.php/tool/signup")
    assert.equal(game.statusCode, 200)
})

test("a correct password opens the whole admin surface until logout", async t => {
    const { app, auth } = createPasswordApp(t)

    const { response, cookie } = await login(app, auth)
    assert.equal(response.statusCode, 200)
    assert.equal(JSON.parse(response.payload).username, auth.resolveAdminAuthConfig({ [auth.ADMIN_PASSWORD_ENV]: PASSWORD }).username)
    assert.match(cookie, new RegExp(`^${auth.ADMIN_SESSION_COOKIE}=[A-Za-z0-9_-]{20,}$`))
    const setCookie = String(response.headers["set-cookie"])
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)

    const page = await app.inject({ method: "GET", url: "/admin/", headers: { accept: "text/html", cookie } })
    assert.equal(page.statusCode, 200)
    assert.equal(page.payload, "admin shell")

    const api = await apiRequest(app, "/api/server/status", { headers: { cookie } })
    assert.equal(api.statusCode, 200)

    const logout = await app.inject({ method: "POST", url: "/admin/logout", headers: { cookie, accept: "text/html" } })
    assert.equal(logout.statusCode, 303)
    assert.equal(logout.headers.location, "/admin/login")
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/)

    const after = await apiRequest(app, "/api/server/status", { headers: { cookie } })
    assert.equal(after.statusCode, 401)
})

test("JSESSIONID-style form login is accepted and returns to the login page on failure", async t => {
    const { app, auth } = createPasswordApp(t, { username: "owner" })

    const ok = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `username=owner&password=${encodeURIComponent(PASSWORD)}`,
    })
    assert.equal(ok.statusCode, 303)
    assert.equal(ok.headers.location, "/admin/")

    const bad = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "username=owner&password=wrong-password",
    })
    assert.equal(bad.statusCode, 401)
    assert.equal(bad.headers.location, undefined)
    assert.match(bad.payload, /口令|密码/)

    const wrongUser = await login(app, auth, { username: "not-owner" })
    assert.equal(wrongUser.response.statusCode, 401)
})

test("repeated failures from one source are rate limited", async t => {
    const { app, auth } = createPasswordApp(t)

    // 前 N-1 次只是普通失败；第 N 次失败当场触发锁定（第 N 次就返回 429）。
    for (let attempt = 1; attempt < auth.ADMIN_LOGIN_MAX_FAILURES; attempt += 1) {
        const { response } = await login(app, auth, { password: "wrong-password" })
        assert.equal(response.statusCode, 401, `第 ${attempt} 次失败应为 401`)
    }

    const locked = await login(app, auth, { password: "wrong-password" })
    assert.equal(locked.response.statusCode, 429)
    assert.equal(locked.response.headers["retry-after"] !== undefined, true)

    // 锁定期间即便口令正确也进不去。
    const correct = await login(app, auth)
    assert.equal(correct.response.statusCode, 429)

    // 另一个来源地址不受影响（锁定按来源地址分别计数）。
    const other = await app.inject({
        method: "POST",
        url: "/admin/login",
        remoteAddress: "203.0.113.9",
        headers: { "content-type": "application/json", accept: "application/json" },
        payload: { username: "admin", password: "wrong-password" },
    })
    assert.equal(other.statusCode, 401)

    // 未登录访问后台依然被挡（锁定不影响闸门本身）。
    const blocked = await apiRequest(app, "/api/server/status")
    assert.equal(blocked.statusCode, 401)
})
