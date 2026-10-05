/**
 * `/admin/login` 表单正文解析的契约测试（真实实现，非近似重写）。
 *
 * 背景 —— 这是一个"只有真实 HTTP 才会暴露"的 bug：
 * `src/cn-server.ts` 的 `application/x-www-form-urlencoded` 解析器原本无条件先做
 * `unpack(Buffer.from(body, "base64"))`（游戏客户端用 base64 msgpack）。而
 * `unpack("username=admin&password=…")` **不抛异常**，于是：
 *   - `URLSearchParams` fallback 永远轮不到 ⇒ `request.body` 是个垃圾对象；
 *   - `src/runtime/admin-auth.ts` 的 `fieldOf("username")` 取到 `""`；
 *   - 登录接口对**正确口令**也返回 401（服务端日志 `admin login rejected { username: "" }`）。
 *
 * 单元测试抓不到它，因为 `tools/admin_auth.test.cjs` 用的是测试自己装的身份解析器。
 * 所以这里直接 import 生产实现（`src/runtime/cn-body-parsers.ts`）—— 刻意**不** import
 * `src/cn-server.ts`，那个模块 import 即启动整台服务器（会抢端口、退出码被带跑）。
 *
 * 用法：node tools/cn_form_body.test.cjs
 */

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const Fastify = require("fastify")
const { pack } = require("msgpackr")

const { installCnBodyParsers } = require("../src/runtime/cn-body-parsers.ts")
const { installAdminAuth, resolveAdminAuthConfig } = require("../src/runtime/admin-auth.ts")

const PASSWORD = "starpoint-form-2026"
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded"

/** 与真实入口同样的装法：同一个 `installCnBodyParsers`，不是测试里另写一份。 */
function createApp(t, { password = PASSWORD, username = "admin" } = {}) {
    const app = Fastify({ logger: false })
    installCnBodyParsers(app)

    // 探针路由：把解析出来的正文原样回显，用来观察解析结果本身。
    app.post("/api/index.php/asset/get_path", async request => ({ body: request.body }))
    app.get("/admin/", async (_request, reply) => reply.type("text/html; charset=utf-8").send("admin shell"))

    installAdminAuth(app, {
        config: resolveAdminAuthConfig({ ADMIN_PASSWORD: password, ADMIN_USERNAME: username }),
        quiet: true,
    })
    t.after(() => app.close())
    return app
}

/** 从响应头里取会话 Cookie 值。 */
function sessionTokenOf(response) {
    const header = response.headers["set-cookie"]
    const raw = Array.isArray(header) ? header[0] : header
    const match = /spcn_admin_session=([^;]+)/.exec(raw ?? "")
    return match?.[1] ?? null
}

test("admin login accepts the login page's HTML form (urlencoded)", async t => {
    const app = createApp(t)
    const response = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "text/html" },
        payload: `username=admin&password=${PASSWORD}`,
    })

    assert.equal(response.statusCode, 303)
    assert.equal(response.headers.location, "/admin/")
    const token = sessionTokenOf(response)
    assert.ok(token !== null && token.length > 20, "session cookie must be issued")

    const guarded = await app.inject({
        method: "GET",
        url: "/admin/",
        headers: { accept: "text/html", cookie: `spcn_admin_session=${token}` },
    })
    assert.equal(guarded.statusCode, 200)
    assert.equal(guarded.body, "admin shell")
})

test("admin login keeps rejecting a wrong password through the same parser", async t => {
    const app = createApp(t)
    const response = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "text/html" },
        payload: "username=admin&password=definitely-not-it",
    })

    assert.equal(response.statusCode, 401)
    assert.equal(sessionTokenOf(response), null)
    assert.match(response.body, /用户名或口令不正确/)
})

test("admin login also accepts a JSON body sent under the form content-type", async t => {
    const app = createApp(t)
    const response = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "application/json" },
        payload: JSON.stringify({ username: "admin", password: PASSWORD }),
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().username, "admin")
    assert.ok(sessionTokenOf(response) !== null)
})

test("custom ADMIN_USERNAME is honoured for form logins", async t => {
    const app = createApp(t, { username: "owner" })
    const accepted = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "text/html" },
        payload: `username=owner&password=${PASSWORD}`,
    })
    assert.equal(accepted.statusCode, 303)

    const rejected = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "text/html" },
        payload: `username=admin&password=${PASSWORD}`,
    })
    assert.equal(rejected.statusCode, 401)
})

test("game routes still unpack base64 msgpack bodies (the original contract)", async t => {
    const app = createApp(t)
    const payload = { short_udid: 12345, viewer_id: 67890, api_count: 1 }
    const response = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/get_path",
        headers: { "content-type": FORM_CONTENT_TYPE },
        payload: pack(payload).toString("base64"),
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().body, payload)
})

test("a plain urlencoded body on a game route falls back instead of crashing", async t => {
    const app = createApp(t)
    const response = await app.inject({
        method: "POST",
        url: "/api/index.php/asset/get_path",
        headers: { "content-type": FORM_CONTENT_TYPE },
        payload: "app_ver=1.4.56&device=android",
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().body, { app_ver: "1.4.56", device: "android" })
})

test("cn-server installs the parsers from cn-body-parsers (guards the wiring)", async () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "cn-server.ts"), "utf8")
    assert.match(
        source,
        /installCnBodyParsers\(\s*fastify\s*\)/,
        "cn-server must install the shared parsers — otherwise this suite guards nothing",
    )
    assert.doesNotMatch(
        source,
        /addContentTypeParser\(\s*"application\/x-www-form-urlencoded"/,
        "the form parser must live in cn-body-parsers.ts, not be re-declared inline in cn-server.ts",
    )
})
