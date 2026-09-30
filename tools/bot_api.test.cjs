"use strict"

// Contract 3.4 (`/api/bot/{bind,status,unbind}`) — bot control plane.
//
// Runs against a throwaway DATA_DIR so the shared .database/ directory is never
// touched. Three fastify instances share one database: the happy one (token
// configured), one without any token (CC-4 fail closed) and one whose header is
// wrong. The 403 assertions below are deliberately paranoid: they compare the
// whole body *and* grep the raw payload for account data and for the token.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { Writable } = require("node:stream")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-api-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    SIGNUP_CODE_MAX_ATTEMPTS,
    bindPlatformAccountSync,
    createSignupCodeSync,
    getSignupCodeSync,
    listBindingsSync,
    setAccountBindStateSync,
} = require("../src/data/domains/account-binding")
const {
    BOT_RATE_LIMIT_MAX_REQUESTS,
    BOT_TOKEN_HEADER,
    botTokenMatches,
    resolveBotApiToken,
} = require("../src/routes/web_api/bot")
const botRoutes = require("../src/routes/web_api/bot").default

const BOT_TOKEN = "p5-bot-token-9f2c"

const logLines = []
const logStream = new Writable({
    write(chunk, _encoding, done) {
        logLines.push(String(chunk))
        done()
    },
})

let app
let tokenlessApp
let sequence = 0

function createAccount(extra = {}) {
    sequence += 1
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bot-api-${sequence}-${Math.random().toString(36).slice(2)}`,
        status: "normal",
        ...extra,
    })
}

/** Gives an account the viewer id that `getViewerIdSync` reads back. */
function setViewerId(accountId, viewerId) {
    getDb().prepare(
        "INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, 2)",
    ).run(String(viewerId), accountId, new Date(Date.now() + 86400000).toISOString())
}

async function post(url, payload, options = {}) {
    const target = options.app ?? app
    const headers = {}
    if (options.token !== null) headers[BOT_TOKEN_HEADER] = options.token ?? BOT_TOKEN
    const response = await target.inject({ method: "POST", url, payload, headers })
    return {
        status: response.statusCode,
        body: response.payload === "" ? null : JSON.parse(response.payload),
        raw: response.payload,
    }
}

const bind = (payload, options) => post("/api/bot/bind", payload, options)
const status = (payload, options) => post("/api/bot/status", payload, options)
const unbind = (payload, options) => post("/api/bot/unbind", payload, options)

/** Creates a pending signup code for the account and returns its plaintext. */
function issueCode(accountId, extra = {}) {
    return createSignupCodeSync({ accountId, ...extra })
}

function expireCode(codeId) {
    getDb().prepare("UPDATE signup_codes SET expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), codeId)
}

function lockCode(codeId) {
    getDb().prepare("UPDATE signup_codes SET attempts = ? WHERE id = ?")
        .run(SIGNUP_CODE_MAX_ATTEMPTS, codeId)
}

/** Seeds a non-primary binding, which only the admin console can create. */
function seedSharedBinding(accountId, platform, platformUid, displayName = null) {
    const nowIso = new Date().toISOString()
    getDb().prepare(`
        INSERT INTO account_bindings (
            account_id, platform, platform_uid, display_name, is_primary,
            created_by, note, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, 0, 'admin', NULL, ?, ?, 1)
    `).run(accountId, platform, platformUid, displayName, nowIso, nowIso)
}

async function newApp(options) {
    const instance = Fastify({ logger: { level: "error", stream: logStream } })
    instance.register(botRoutes, { prefix: "/api/bot", ...options })
    await instance.ready()
    return instance
}

test.before(async () => {
    assert.equal(process.env.DATA_DIR, databaseDirectory)
    data.initializeDatabase()
    app = await newApp({ env: { BOT_API_TOKEN: BOT_TOKEN } })
    tokenlessApp = await newApp({ env: {} })
})

test.after(async () => {
    if (app !== undefined) await app.close()
    if (tokenlessApp !== undefined) await tokenlessApp.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("缺少 BOT_API_TOKEN 时整组端点 403（fail closed）", async () => {
    const account = createAccount({ username: "bot-secret-owner" })
    const viewerId = 940_001
    setViewerId(account.id, viewerId)
    const code = issueCode(account.id)
    bindPlatformAccountSync({
        accountId: account.id,
        platform: "qq",
        platformUid: "bot-closed-1",
        createdBy: "admin",
        actor: "admin",
    })

    const calls = [
        await bind({ platform: "qq", uid: "bot-closed-1", code: code.code }, { app: tokenlessApp }),
        await status({ platform: "qq", uid: "bot-closed-1" }, { app: tokenlessApp }),
        await unbind({ platform: "qq", uid: "bot-closed-1", code: code.code }, { app: tokenlessApp }),
    ]

    for (const call of calls) {
        assert.equal(call.status, 403)
        // Hard assertion: the whole body is the frozen FORBIDDEN envelope.
        assert.deepEqual(call.body, { ok: false, code: "FORBIDDEN" })
        // No account data may appear anywhere in the response, and the
        // configured token must not be echoed back either.
        assert.equal(call.raw.includes("bot-secret-owner"), false)
        assert.equal(call.raw.includes(String(viewerId)), false)
        assert.equal(call.raw.includes(String(account.id)), false)
        assert.equal(call.raw.includes(code.code), false)
        assert.equal(call.raw.includes(BOT_TOKEN), false)
    }

    // A right token against a server without a configured token is still 403.
    const withHeader = await status(
        { platform: "qq", uid: "bot-closed-1" },
        { app: tokenlessApp, token: BOT_TOKEN },
    )
    assert.equal(withHeader.status, 403)
    assert.deepEqual(withHeader.body, { ok: false, code: "FORBIDDEN" })
})

test("请求头缺失或令牌错误时 403 且不泄漏绑定信息", async () => {
    const account = createAccount({ username: "bot-header-owner" })
    setViewerId(account.id, 940_002)
    bindPlatformAccountSync({
        accountId: account.id,
        platform: "kook",
        platformUid: "bot-header-1",
        createdBy: "admin",
        actor: "admin",
    })

    const missing = await status({ platform: "kook", uid: "bot-header-1" }, { token: null })
    assert.equal(missing.status, 403)
    assert.deepEqual(missing.body, { ok: false, code: "FORBIDDEN" })
    assert.equal(missing.raw.includes("bot-header-owner"), false)

    const wrong = await status({ platform: "kook", uid: "bot-header-1" }, { token: "p5-wrong-token" })
    assert.equal(wrong.status, 403)
    assert.deepEqual(wrong.body, { ok: false, code: "FORBIDDEN" })
    assert.equal(wrong.raw.includes("bot-header-owner"), false)
    assert.equal(wrong.raw.includes("940002"), false)
    assert.equal(wrong.raw.includes(BOT_TOKEN), false)

    // A prefix of the real token and a longer token must both be rejected.
    for (const candidate of [BOT_TOKEN.slice(0, 8), `${BOT_TOKEN}x`, BOT_TOKEN.toUpperCase()]) {
        const attempt = await status({ platform: "kook", uid: "bot-header-1" }, { token: candidate })
        assert.equal(attempt.status, 403)
        assert.deepEqual(attempt.body, { ok: false, code: "FORBIDDEN" })
    }
})

test("令牌读取遵循 CC-4 注入式规则（缺失 / 空白即关闭）", () => {
    assert.equal(resolveBotApiToken({}), null)
    assert.equal(resolveBotApiToken({ BOT_API_TOKEN: "" }), null)
    assert.equal(resolveBotApiToken({ BOT_API_TOKEN: "   " }), null)
    assert.equal(resolveBotApiToken({ BOT_API_TOKEN: "  spaced  " }), "spaced")
    assert.equal(resolveBotApiToken({ BOT_API_TOKEN: BOT_TOKEN }), BOT_TOKEN)

    // Constant-time comparison over hashes: unequal lengths must not throw.
    assert.equal(botTokenMatches(BOT_TOKEN, BOT_TOKEN), true)
    assert.equal(botTokenMatches("short", "a-much-longer-token-value"), false)
    assert.equal(botTokenMatches(undefined, BOT_TOKEN), false)
    assert.equal(botTokenMatches(12345, BOT_TOKEN), false)
    assert.equal(botTokenMatches(` ${BOT_TOKEN} `, BOT_TOKEN), true)
})

test("POST /api/bot/bind 绑定成功后返回账号资料", async () => {
    const account = createAccount({ username: "bot-bind-ok" })
    setViewerId(account.id, 941_001)
    const code = issueCode(account.id)

    const response = await bind({
        platform: "qq",
        uid: "bot-bind-1",
        code: code.code,
        display_name: "测试昵称",
    })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
        ok: true,
        data: {
            account_id: account.id,
            viewer_id: 941_001,
            username: "bot-bind-ok",
            is_primary: true,
        },
    })

    const stored = getSignupCodeSync(code.code)
    assert.equal(stored.status, "bound")
    assert.equal(stored.platformUid, "bot-bind-1")
    assert.equal(stored.platform, "qq")

    const binding = listBindingsSync({ platform: "qq", platformUid: "bot-bind-1" })[0]
    assert.equal(binding.accountId, account.id)
    assert.equal(binding.displayName, "测试昵称")
    assert.equal(binding.createdBy, "bot")
})

test("POST /api/bot/bind 同一 uid 再过码返回 ALREADY_BOUND 并带已知账号", async () => {
    const owner = createAccount({ username: "bot-owner" })
    setViewerId(owner.id, 941_002)
    const first = issueCode(owner.id)
    const bound = await bind({ platform: "qq", uid: "bot-already-1", code: first.code })
    assert.equal(bound.body.ok, true)

    const intruder = createAccount({ username: "bot-intruder" })
    setViewerId(intruder.id, 941_003)
    const second = issueCode(intruder.id)
    const conflict = await bind({ platform: "qq", uid: "bot-already-1", code: second.code })

    assert.equal(conflict.status, 200)
    assert.equal(conflict.body.ok, false)
    assert.equal(conflict.body.code, "ALREADY_BOUND")
    // Contract 3.4 `username` / `viewer_id` keep their exact meaning; `message`
    // and `viewer_id_tail` are the pure addition that lets the bot answer a
    // repeated `/bind` with a sentence instead of guessing.
    assert.deepEqual(conflict.body.data, {
        username: "bot-owner",
        viewer_id: 941_002,
        viewer_id_tail: "1002",
        message: "这个 QQ 已经绑定过游戏账号「bot-owner」（ID 尾号 1002），无需重复绑定；换号请先在游戏内解绑。",
    })
    assert.equal(conflict.body.data.viewer_id_tail, "1002")
    // The full platform uid (a QQ / KOOK number) is never echoed back.
    assert.equal(conflict.raw.includes("bot-already-1"), false)

    // The intruder's account was not touched.
    const bindings = listBindingsSync({ platform: "qq", platformUid: "bot-already-1" })
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].accountId, owner.id)
})

test("POST /api/bot/bind ALREADY_BOUND 在账号无名无 viewer_id 时仍给出可读文案", async () => {
    // `describeOwner` legitimately reports `username: null` / `viewer_id: 0`
    // here — that emptiness is exactly what the bot cannot phrase itself.
    const owner = createAccount()
    const first = issueCode(owner.id)
    const bound = await bind({ platform: "kook", uid: "bot-noname-1", code: first.code })
    assert.equal(bound.body.ok, true)

    const intruder = createAccount({ username: "bot-noname-intruder" })
    const second = issueCode(intruder.id)
    const conflict = await bind({ platform: "kook", uid: "bot-noname-1", code: second.code })

    assert.equal(conflict.body.code, "ALREADY_BOUND")
    // The frozen pair is unchanged — still null / 0, not "fixed up".
    assert.equal(conflict.body.data.username, null)
    assert.equal(conflict.body.data.viewer_id, 0)
    assert.equal(conflict.body.data.viewer_id_tail, null)
    assert.equal(
        conflict.body.data.message,
        "这个 KOOK 已经绑定过游戏账号，无需重复绑定；换号请先在游戏内解绑。",
    )
})

test("POST /api/bot/bind 用绑定前发出的旧码 ⇒ CODE_INVALID（CC-2，且 attempts 被烧）", async () => {
    // The hole CC-2 closes, seen from the frozen bot surface: the account is
    // bound behind the code's back (admin path), so the code it still had in
    // flight must not be spendable by a second platform identity.
    const account = createAccount({ username: "bot-stale-owner" })
    const stale = issueCode(account.id)
    assert.equal(getSignupCodeSync(stale.code).status, "pending")

    const bound = bindPlatformAccountSync({
        accountId: account.id,
        platform: "qq",
        platformUid: "bot-stale-admin-1",
        createdBy: "admin",
        actor: "admin",
    })
    assert.equal(bound.ok, true)
    assert.equal(getSignupCodeSync(stale.code).status, "revoked")

    const rejected = await bind({ platform: "kook", uid: "bot-stale-thief-1", code: stale.code })
    assert.equal(rejected.body.ok, false)
    assert.equal(rejected.body.code, "CODE_INVALID")
    // Spending a revoked code still burns an attempt.
    assert.equal(getSignupCodeSync(stale.code).attempts, 1)
    // It did not take effect on the second identity.
    assert.equal(listBindingsSync({ platform: "kook", platformUid: "bot-stale-thief-1" }).length, 0)
    assert.equal(listBindingsSync({ platform: "qq", platformUid: "bot-stale-admin-1" })[0].accountId, account.id)
})

test("POST /api/bot/bind 失败码：CODE_INVALID / CODE_EXPIRED / CODE_USED", async () => {
    const account = createAccount({ username: "bot-codes" })

    const unknown = await bind({ platform: "qq", uid: "bot-codes-1", code: "ZZZZZZ" })
    assert.equal(unknown.status, 200)
    assert.deepEqual(unknown.body, { ok: false, code: "CODE_INVALID" })

    const expired = issueCode(account.id)
    expireCode(expired.id)
    const expiredResponse = await bind({ platform: "qq", uid: "bot-codes-1", code: expired.code })
    assert.deepEqual(expiredResponse.body, { ok: false, code: "CODE_EXPIRED" })

    const used = issueCode(account.id)
    const okResponse = await bind({ platform: "qq", uid: "bot-codes-2", code: used.code })
    assert.equal(okResponse.body.ok, true)
    const reused = await bind({ platform: "qq", uid: "bot-codes-3", code: used.code })
    assert.deepEqual(reused.body, { ok: false, code: "CODE_USED" })
})

test("POST /api/bot/bind 失败码：CODE_LOCKED / ACCOUNT_DISABLED", async () => {
    const lockedAccount = createAccount({ username: "bot-locked" })
    const locked = issueCode(lockedAccount.id)
    lockCode(locked.id)
    const lockedResponse = await bind({ platform: "qq", uid: "bot-locked-1", code: locked.code })
    assert.deepEqual(lockedResponse.body, { ok: false, code: "CODE_LOCKED" })

    const disabledAccount = createAccount({ username: "bot-disabled" })
    assert.equal(setAccountBindStateSync(disabledAccount.id, "disabled", "test"), true)
    const code = issueCode(disabledAccount.id)
    const disabledResponse = await bind({ platform: "qq", uid: "bot-disabled-1", code: code.code })
    assert.deepEqual(disabledResponse.body, { ok: false, code: "ACCOUNT_DISABLED" })
})

test("POST /api/bot/bind 请求体非法返回 CODE_INVALID 且不消耗绑定码", async () => {
    const account = createAccount({ username: "bot-malformed" })
    const code = issueCode(account.id)

    const cases = [
        {},
        { platform: "telegram", uid: "bot-bad-1", code: code.code },
        { platform: "qq", uid: "", code: code.code },
        { platform: "qq", uid: "bot-bad-1" },
        { platform: "qq", uid: "bot-bad-1", code: "" },
        { platform: "qq", uid: "bot-bad-1", code: code.code, display_name: 42 },
        [],
        [1, 2, 3],
    ]
    for (const payload of cases) {
        const response = await bind(payload)
        assert.equal(response.status, 400)
        assert.deepEqual(response.body, { ok: false, code: "CODE_INVALID" })
    }

    // A JSON scalar is not a request object either.
    const scalar = await app.inject({
        method: "POST",
        url: "/api/bot/bind",
        payload: JSON.stringify("not-an-object"),
        headers: { [BOT_TOKEN_HEADER]: BOT_TOKEN, "content-type": "application/json" },
    })
    assert.equal(scalar.statusCode, 400)
    assert.deepEqual(JSON.parse(scalar.payload), { ok: false, code: "CODE_INVALID" })

    // None of the rejected calls may have touched the code.
    const stored = getSignupCodeSync(code.code)
    assert.equal(stored.status, "pending")
    assert.equal(stored.attempts, 0)
})

test("POST /api/bot/bind 同 uid 超过频率上限返回 RATE_LIMITED", async () => {
    const uid = "bot-rate-1"
    for (let index = 0; index < BOT_RATE_LIMIT_MAX_REQUESTS; index += 1) {
        const allowed = await bind({ platform: "qq", uid, code: "AAAAAA" })
        assert.equal(allowed.body.code, "CODE_INVALID")
    }
    const limited = await bind({ platform: "qq", uid, code: "AAAAAA" })
    assert.equal(limited.status, 200)
    assert.deepEqual(limited.body, { ok: false, code: "RATE_LIMITED" })

    // Another uid is unaffected by the window of the first one.
    const other = await bind({ platform: "qq", uid: "bot-rate-2", code: "AAAAAA" })
    assert.deepEqual(other.body, { ok: false, code: "CODE_INVALID" })
})

test("POST /api/bot/status 返回该平台 uid 的全部绑定（主绑定优先）", async () => {
    const owner = createAccount({ username: "bot-status-owner" })
    const member = createAccount({ username: "bot-status-member" })
    setViewerId(owner.id, 942_001)
    setViewerId(member.id, 942_002)
    const ownerCode = issueCode(owner.id)
    assert.equal((await bind({ platform: "kook", uid: "bot-status-1", code: ownerCode.code })).body.ok, true)
    seedSharedBinding(member.id, "kook", "bot-status-1", "小号")

    const response = await status({ platform: "kook", uid: "bot-status-1" })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const bindings = response.body.data.bindings
    assert.equal(bindings.length, 2)
    assert.deepEqual(bindings.map(item => item.account_id), [owner.id, member.id])
    assert.deepEqual(bindings.map(item => item.is_primary), [true, false])
    assert.equal(bindings[0].username, "bot-status-owner")
    assert.equal(bindings[0].viewer_id, 942_001)
    assert.equal(bindings[1].viewer_id, 942_002)
    for (const item of bindings) {
        assert.deepEqual(Object.keys(item).sort(), [
            "account_id",
            "created_at",
            "is_primary",
            "username",
            "viewer_id",
        ])
        assert.equal(Number.isNaN(Date.parse(item.created_at)), false)
    }

    const empty = await status({ platform: "qq", uid: "bot-status-none" })
    assert.deepEqual(empty.body, { ok: true, data: { bindings: [] } })

    const malformed = await status({ platform: "kook" })
    assert.equal(malformed.status, 400)
    assert.deepEqual(malformed.body, { ok: false, code: "BAD_REQUEST" })
})

test("POST /api/bot/unbind 拒绝解绑主绑定（主绑定只能由管理员处理）", async () => {
    const account = createAccount({ username: "bot-primary" })
    const code = issueCode(account.id)
    assert.equal((await bind({ platform: "qq", uid: "bot-primary-1", code: code.code })).body.ok, true)

    // The code that bound this identity is also proof of ownership.
    const response = await unbind({ platform: "qq", uid: "bot-primary-1", code: code.code })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { ok: false, code: "PRIMARY_BINDING" })

    const bindings = listBindingsSync({ platform: "qq", platformUid: "bot-primary-1" })
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].isPrimary, true)

    // A live pending code for the same account is refused the same way.
    const pending = issueCode(account.id)
    const pendingResponse = await unbind({ platform: "qq", uid: "bot-primary-1", code: pending.code })
    assert.deepEqual(pendingResponse.body, { ok: false, code: "PRIMARY_BINDING" })
})

test("POST /api/bot/unbind 解绑非主绑定并吊销所持绑定码", async () => {
    const owner = createAccount({ username: "bot-unbind-owner" })
    const member = createAccount({ username: "bot-unbind-member" })
    setViewerId(member.id, 943_001)
    bindPlatformAccountSync({
        accountId: owner.id,
        platform: "qq",
        platformUid: "bot-unbind-1",
        createdBy: "admin",
        actor: "admin",
    })
    seedSharedBinding(member.id, "qq", "bot-unbind-1")

    const code = issueCode(member.id)
    const response = await unbind({ platform: "qq", uid: "bot-unbind-1", code: code.code })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
        ok: true,
        data: {
            account_id: member.id,
            viewer_id: 943_001,
            username: "bot-unbind-member",
            is_primary: false,
        },
    })

    const remaining = listBindingsSync({ platform: "qq", platformUid: "bot-unbind-1" })
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].accountId, owner.id)
    assert.equal(remaining[0].isPrimary, true)

    // The live code was spent by the unbind it authorised.
    assert.equal(getSignupCodeSync(code.code).status, "revoked")

    // Repeating the unbind cannot succeed twice.
    const repeated = await unbind({ platform: "qq", uid: "bot-unbind-1", code: code.code })
    assert.deepEqual(repeated.body, { ok: false, code: "CODE_INVALID" })
})

test("POST /api/bot/unbind 码校验与 BINDING_NOT_FOUND", async () => {
    const account = createAccount({ username: "bot-unbind-codes" })

    const unknown = await unbind({ platform: "qq", uid: "bot-unbind-2", code: "QQQQQQ" })
    assert.deepEqual(unknown.body, { ok: false, code: "CODE_INVALID" })

    const expired = issueCode(account.id)
    expireCode(expired.id)
    const expiredResponse = await unbind({ platform: "qq", uid: "bot-unbind-2", code: expired.code })
    assert.deepEqual(expiredResponse.body, { ok: false, code: "CODE_EXPIRED" })

    const locked = issueCode(account.id)
    lockCode(locked.id)
    const lockedResponse = await unbind({ platform: "qq", uid: "bot-unbind-2", code: locked.code })
    assert.deepEqual(lockedResponse.body, { ok: false, code: "CODE_LOCKED" })

    const platformBound = issueCode(account.id, { platform: "kook" })
    const mismatch = await unbind({ platform: "qq", uid: "bot-unbind-2", code: platformBound.code })
    assert.deepEqual(mismatch.body, { ok: false, code: "CODE_INVALID" })

    const disabledAccount = createAccount({ username: "bot-unbind-disabled" })
    setAccountBindStateSync(disabledAccount.id, "disabled", "test")
    const disabledCode = issueCode(disabledAccount.id)
    const disabled = await unbind({
        platform: "qq",
        uid: "bot-unbind-2",
        code: disabledCode.code,
    })
    assert.deepEqual(disabled.body, { ok: false, code: "ACCOUNT_DISABLED" })

    // Valid code, but this account has no binding for that uid.
    const unbound = issueCode(account.id)
    const missing = await unbind({ platform: "qq", uid: "bot-unbind-2", code: unbound.code })
    assert.deepEqual(missing.body, { ok: false, code: "BINDING_NOT_FOUND" })

    const malformed = await unbind({ platform: "qq", uid: "bot-unbind-2" })
    assert.equal(malformed.status, 400)
    assert.deepEqual(malformed.body, { ok: false, code: "BAD_REQUEST" })
})

test("绑定码只在其绑定的 uid 上可作所有权证明", async () => {
    const account = createAccount({ username: "bot-uid-proof" })
    const code = issueCode(account.id)
    assert.equal((await bind({ platform: "qq", uid: "bot-uid-a", code: code.code })).body.ok, true)

    const wrongUid = await unbind({ platform: "qq", uid: "bot-uid-b", code: code.code })
    assert.deepEqual(wrongUid.body, { ok: false, code: "CODE_INVALID" })

    const otherPlatform = await unbind({ platform: "kook", uid: "bot-uid-a", code: code.code })
    assert.deepEqual(otherPlatform.body, { ok: false, code: "CODE_INVALID" })
})

test("index 插件把 /api/bindings 与 /api/bot 挂在真实前缀下", async () => {
    const indexRoutes = require("../src/routes/web_api/index").default
    const instance = Fastify({ logger: { level: "error", stream: logStream } })
    instance.register(indexRoutes, { prefix: "/api", botApiEnv: { BOT_API_TOKEN: BOT_TOKEN } })
    await instance.ready()
    try {
        // The admin console needs no credentials (deployment-level boundary).
        const listing = await instance.inject({ method: "GET", url: "/api/bindings" })
        assert.equal(listing.statusCode, 200)
        const page = JSON.parse(listing.payload)
        assert.equal(typeof page.totalCount, "number")
        assert.equal(Array.isArray(page.rows), true)

        const authorized = await instance.inject({
            method: "POST",
            url: "/api/bot/status",
            headers: { [BOT_TOKEN_HEADER]: BOT_TOKEN },
            payload: { platform: "qq", uid: "bot-index-none" },
        })
        assert.equal(authorized.statusCode, 200)
        assert.deepEqual(JSON.parse(authorized.payload), { ok: true, data: { bindings: [] } })

        // The bot token never leaks onto the admin surface.
        const botWithNoToken = await instance.inject({
            method: "POST",
            url: "/api/bot/status",
            payload: { platform: "qq", uid: "bot-index-none" },
        })
        assert.equal(botWithNoToken.statusCode, 403)
        assert.deepEqual(JSON.parse(botWithNoToken.payload), { ok: false, code: "FORBIDDEN" })
    } finally {
        await instance.close()
    }
})
