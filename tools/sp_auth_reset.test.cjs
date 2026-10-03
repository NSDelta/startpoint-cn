"use strict"

// 契约 C1「忘记密码」：`/sp-auth/reset-request` → `/api/bot/reset` → `/sp-auth/reset-confirm`
// 三个抓手的端到端测试（网页发码 → 群里 QQ 确认 → 网页改密并踢掉旧设备）。
//
// Everything runs against a throwaway DATA_DIR, so the shared `.database/`
// directory is never touched and the file can be re-run at will.
//
// Run:  node --test tools/sp_auth_reset.test.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { Writable } = require("node:stream")
const bcrypt = require("bcryptjs")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sp-auth-reset-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { installBundledGameplaySnapshot } =
    require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

const binding = require("../src/data/domains/account-binding")
const { getViewerIdSync } = require("../src/data/domains/session")
const contract = require("../src/lib/sp-auth/contract")
const { clearResetRequestRateState } = require("../src/lib/sp-auth/reset")
const spAuthRoutes = require("../src/routes/sp-auth/index.ts").default
const botRoutes = require("../src/routes/web_api/bot").default

// 群里那枚机器人令牌：和 tools/bot_api.test.cjs 用的是同一个假值。
const BOT_TOKEN = "p5-bot-token-9f2c"

// ---------------------------------------------------------------------------
// clock: the suite freezes Date.now and moves it explicitly, so the 60 s
// re-issue window and the 15 minute reset TTL are deterministic.
// ---------------------------------------------------------------------------

const BASE_NOW_MS = Date.UTC(2026, 8, 24, 0, 0, 0)
let nowOffsetMs = 0
const realDateNow = Date.now
Date.now = () => BASE_NOW_MS + nowOffsetMs

function advance(ms) {
    nowOffsetMs += ms
}

function resetClock() {
    nowOffsetMs = 0
}

const MINUTE_MS = 60_000

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let app
const logLines = []
const logStream = new Writable({
    write(chunk, _encoding, callback) {
        logLines.push(chunk.toString())
        callback()
    },
})

let deviceSequence = 0
function nextDeviceId() {
    deviceSequence += 1
    return 8_260_000 + deviceSequence
}

let platformUidSequence = 0
/** Unique QQ-like uid per binding: `uq_account_bindings_triple` is global. */
function nextPlatformUid() {
    platformUidSequence += 1
    return String(530_000_000 + platformUidSequence)
}

let usernameSequence = 0
/** `SP_AUTH_USERNAME_PATTERN` is 4-20 chars and must not start with a digit. */
function username(prefix) {
    usernameSequence += 1
    return `rs${prefix}${String(usernameSequence).padStart(4, "0")}`
}

async function post(url, payload) {
    const response = await app.inject({ method: "POST", url: `/sp-auth${url}`, payload })
    assert.equal(response.statusCode, 200, `${url} 必须返回 HTTP 200`)
    return { response, body: JSON.parse(response.payload) }
}

async function postBot(payload, token = BOT_TOKEN) {
    const headers = token === null ? {} : { "x-bot-token": token }
    const response = await app.inject({
        method: "POST",
        url: "/api/bot/reset",
        headers,
        payload,
    })
    return { response, statusCode: response.statusCode, body: JSON.parse(response.payload) }
}

function okBody(body) {
    assert.equal(body.ok, true, `期望成功，实际 ${JSON.stringify(body)}`)
    return body.data
}

function failBody(body, code) {
    assert.equal(body.ok, false, `期望失败，实际 ${JSON.stringify(body)}`)
    assert.equal(body.code, code)
    assert.equal(typeof body.message, "string")
    assert.ok(body.message.length > 0, "失败响应必须带 message")
    return body
}

function accountRow(accountId) {
    return getDb().prepare(
        "SELECT id, username, password_hash, bind_state FROM accounts WHERE id = ?",
    ).get(accountId)
}

function passwordResetCodeRow(code) {
    return getDb().prepare(`
        SELECT id, code, account_id, status, attempts, expires_at,
               confirmed_at, confirmed_qq, used_at
        FROM password_reset_codes
        WHERE code = ?
    `).get(code)
}

function latestPasswordResetCodeRow(accountId) {
    return getDb().prepare(`
        SELECT id, code, status, attempts, expires_at, confirmed_at, confirmed_qq, used_at
        FROM password_reset_codes
        WHERE account_id = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(accountId)
}

function deviceGrantRow(deviceId) {
    return getDb().prepare(
        "SELECT device_id, account_id, token, expires_at FROM device_grants WHERE device_id = ?",
    ).get(deviceId)
}

function auditActions() {
    return getDb().prepare("SELECT action FROM bind_audit ORDER BY id").all()
        .map(row => row.action)
}

/**
 * Registers a device and binds a QQ number the way the bot does, so the account
 * is exactly the state `reset-request` requires (bind_state = active + a qq row).
 */
async function boundAccount(password = "Passw0rdA1") {
    const deviceId = nextDeviceId()
    const name = username("user")
    const { body } = await post("/register", {
        username: name,
        password,
        device_id: deviceId,
        version: "1.8.1",
    })
    const registered = okBody(body)
    const accountId = deviceGrantRow(deviceId).account_id
    const qq = nextPlatformUid()
    const result = binding.bindPlatformAccountSync({
        accountId,
        platform: "qq",
        platformUid: qq,
        displayName: "测试账号",
        isPrimary: true,
        createdBy: "bot",
        actor: "test",
    })
    assert.equal(result.ok, true, `绑定失败 ${JSON.stringify(result)}`)
    return { deviceId, username: name, password, accountId, qq, registered }
}

async function requestReset(account) {
    const { body } = await post("/reset-request", { account })
    return okBody(body)
}

async function login(loginName, password, deviceId = nextDeviceId()) {
    const { body } = await post("/login", { login_name: loginName, password, device_id: deviceId })
    return body
}

test.before(async () => {
    assert.equal(process.env.DATA_DIR, databaseDirectory)
    data.initializeDatabase()
    app = Fastify({ logger: { level: "error", stream: logStream } })
    await app.register(spAuthRoutes, { prefix: "/sp-auth" })
    await app.register(botRoutes, { prefix: "/api/bot", env: { BOT_API_TOKEN: BOT_TOKEN } })
    await app.ready()
})

test.after(async () => {
    Date.now = realDateNow
    await app?.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test.beforeEach(() => {
    resetClock()
    // The per-IP window is process-local; without this a long file would throttle
    // its own later scenarios (they all inject from 127.0.0.1).
    clearResetRequestRateState()
})

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test("契约 C1 忘记密码：发码 → 群里 /reset 确认 → 改密 → 新密码能登录、旧密码与旧设备失效", async () => {
    const account = await boundAccount()
    const oldHash = accountRow(account.accountId).password_hash
    assert.ok(getViewerIdSync(account.accountId) > 0, "注册后应已有 viewer 会话")

    // ① 网页请求重置码：账号名口径。
    const requestView = await requestReset(account.username)
    assert.deepEqual(Object.keys(requestView).sort(), ["account", "code", "expiresInSec"])
    assert.equal(requestView.account, account.username)
    assert.match(requestView.code, /^[0-9A-Z]{6}$/)
    assert.equal(requestView.expiresInSec, 900, "重置码 TTL 必须是 15 分钟")

    const issued = passwordResetCodeRow(requestView.code)
    assert.equal(issued.account_id, account.accountId)
    assert.equal(issued.status, "pending")
    assert.equal(issued.attempts, 0)
    assert.equal(issued.confirmed_at, null)
    assert.equal(issued.used_at, null)
    assert.equal(new Date(issued.expires_at).getTime() - Date.now(), 15 * MINUTE_MS)

    // ② 还没在群里确认就想改密：必须先被拦住。
    const premature = await post("/reset-confirm", {
        account: account.username,
        code: requestView.code,
        password: "NewPassw0rdB2",
    })
    failBody(premature.body, "RESET_NOT_CONFIRMED")
    assert.equal(passwordResetCodeRow(requestView.code).attempts, 1, "未确认的尝试要计数")
    assert.equal(accountRow(account.accountId).password_hash, oldHash, "被拦下时密码不得改变")

    // ③ 群里的 QQ 机器人确认这枚码。
    const confirmed = await postBot({ qq: account.qq, code: requestView.code })
    assert.equal(confirmed.statusCode, 200)
    const confirmedData = okBody(confirmed.body)
    assert.deepEqual(Object.keys(confirmedData).sort(), ["account", "state"])
    assert.equal(confirmedData.account, account.username)
    assert.equal(confirmedData.state, "confirmed")

    const afterConfirm = passwordResetCodeRow(requestView.code)
    assert.equal(afterConfirm.status, "confirmed")
    assert.equal(afterConfirm.confirmed_qq, account.qq)
    assert.equal(typeof afterConfirm.confirmed_at, "string")

    // ④ 网页带新密码提交：改密成功。
    const done = await post("/reset-confirm", {
        account: account.username,
        code: requestView.code,
        password: "NewPassw0rdB2",
    })
    const doneData = okBody(done.body)
    assert.deepEqual(Object.keys(doneData), ["account"])
    assert.equal(doneData.account, account.username)

    const newHash = accountRow(account.accountId).password_hash
    assert.notEqual(newHash, oldHash, "密码哈希必须被改写")
    assert.equal(bcrypt.compareSync("NewPassw0rdB2", newHash), true)
    assert.equal(bcrypt.compareSync(account.password, newHash), false)

    const spent = passwordResetCodeRow(requestView.code)
    assert.equal(spent.status, "used")
    assert.equal(typeof spent.used_at, "string")

    // ⑤ 旧的设备凭证 / 会话全被撤销：旧 token 失效，viewer 会话清空。
    assert.equal(deviceGrantRow(account.deviceId), undefined, "旧设备授权应被删除")
    assert.equal(getViewerIdSync(account.accountId), 0, "viewer 会话应被撤销")
    const staleProfile = await post("/profile", { token: account.registered.token })
    failBody(staleProfile.body, "TOKEN_INVALID")

    // ⑥ 新密码能登录、旧密码不能；重新登录会拿到新的 viewer id。
    const oldPasswordLogin = await login(account.username, account.password)
    failBody(oldPasswordLogin, "BAD_CREDENTIALS")
    const newPasswordLogin = await login(account.username, "NewPassw0rdB2")
    const loggedIn = okBody(newPasswordLogin)
    assert.equal(loggedIn.username, account.username)
    assert.ok(Number.isSafeInteger(loggedIn.viewer_id) && loggedIn.viewer_id > 0)

    // ⑦ 同一枚码不能再用：网页口径与群里口径都必须拒绝。
    const reuse = await post("/reset-confirm", {
        account: account.username,
        code: requestView.code,
        password: "ThirdPassw0rdC3",
    })
    failBody(reuse.body, "RESET_CODE_INVALID")
    const reuseBot = await postBot({ qq: account.qq, code: requestView.code })
    failBody(reuseBot.body, "CODE_NOT_FOUND")

    // ⑧ 审计留痕，且重置码不落明文日志。
    const actions = auditActions()
    assert.ok(actions.includes("reset_request"), "缺 reset_request 审计")
    assert.ok(actions.includes("reset_confirm"), "缺 reset_confirm 审计")
    assert.ok(actions.includes("reset_password"), "缺 reset_password 审计")
    assert.ok(!logLines.join("").includes(requestView.code), "重置码不得出现在日志里")
})

test("契约 C1 忘记密码：reset-request 与 reset-confirm 都接受已绑定的 QQ 号", async () => {
    const account = await boundAccount()

    const view = await requestReset(account.qq)
    assert.equal(view.account, account.username, "account 字段回填规范化后的账号名")

    const confirmed = await postBot({ qq: account.qq, code: view.code })
    okBody(confirmed.body)

    const done = await post("/reset-confirm", {
        account: account.qq,
        code: view.code,
        password: "QqPassw0rdD4",
    })
    assert.equal(okBody(done.body).account, account.username)
    okBody(await login(account.username, "QqPassw0rdD4"))
})

// ---------------------------------------------------------------------------
// reset-request 失败路径
// ---------------------------------------------------------------------------

test("CC-1 矩阵：reset-request 查不到账号 → ACCOUNT_NOT_FOUND（空账号也一样）", async () => {
    const unknown = await post("/reset-request", { account: username("ghost") })
    failBody(unknown.body, "ACCOUNT_NOT_FOUND")

    const empty = await post("/reset-request", { account: "   " })
    failBody(empty.body, "ACCOUNT_NOT_FOUND")

    const missing = await post("/reset-request", {})
    failBody(missing.body, "ACCOUNT_NOT_FOUND")
})

test("CC-1 矩阵：账号没有绑定 QQ → RESET_NO_QQ（pending 账号 / 只绑了 KOOK）", async () => {
    // 没绑定过的账号：bind_state = pending。
    const deviceId = nextDeviceId()
    const name = username("unbound")
    okBody((await post("/register", {
        username: name,
        password: "Passw0rdA1",
        device_id: deviceId,
        version: "1.8.1",
    })).body)

    const pending = await post("/reset-request", { account: name })
    failBody(pending.body, "RESET_NO_QQ")

    // bind_state = active 但只有 KOOK 绑定：同样没有 QQ 能替它确认。
    const accountId = deviceGrantRow(deviceId).account_id
    const kook = binding.bindPlatformAccountSync({
        accountId,
        platform: "kook",
        platformUid: nextPlatformUid(),
        displayName: "测试账号",
        isPrimary: true,
        createdBy: "bot",
        actor: "test",
    })
    assert.equal(kook.ok, true)
    assert.equal(accountRow(accountId).bind_state, "active")

    const kookOnly = await post("/reset-request", { account: name })
    failBody(kookOnly.body, "RESET_NO_QQ")
})

test("CC-1 矩阵：同一账号 60 秒内第二次 reset-request → RATE_LIMITED，新码作废旧码", async () => {
    const account = await boundAccount()
    const first = await requestReset(account.username)

    const tooSoon = await post("/reset-request", { account: account.username })
    failBody(tooSoon.body, "RATE_LIMITED")
    assert.equal(passwordResetCodeRow(first.code).status, "pending", "被限流时旧码仍然有效")

    advance(61_000)
    const second = await requestReset(account.username)
    assert.notEqual(second.code, first.code)
    assert.equal(passwordResetCodeRow(first.code).status, "revoked", "同一账号只保留一枚有效码")
    assert.equal(passwordResetCodeRow(second.code).status, "pending")
    assert.equal(passwordResetCodeRow(second.code).attempts, 0)
})

// ---------------------------------------------------------------------------
// /api/bot/reset 失败路径
// ---------------------------------------------------------------------------

test("CC-1 矩阵：/api/bot/reset 确认别家账号的码 → QQ_MISMATCH（码保持 pending）", async () => {
    const owner = await boundAccount()
    const stranger = await boundAccount()
    const view = await requestReset(owner.username)

    const { statusCode, body } = await postBot({ qq: stranger.qq, code: view.code })
    assert.equal(statusCode, 200)
    failBody(body, "QQ_MISMATCH")

    const row = passwordResetCodeRow(view.code)
    assert.equal(row.status, "pending", "QQ 不匹配不得把码确认掉")
    assert.equal(row.confirmed_qq, null)

    // 码还在，正确的 QQ 仍然能确认。
    okBody((await postBot({ qq: owner.qq, code: view.code })).body)
})

test("CC-1 矩阵：/api/bot/reset 不认识的码 → CODE_NOT_FOUND；账号没有 QQ 绑定 → BIND_REQUIRED", async () => {
    const unknownCode = await postBot({ qq: "530000001", code: "ZZZZZZ" })
    failBody(unknownCode.body, "CODE_NOT_FOUND")

    const malformed = await postBot({ qq: "530000001" })
    assert.equal(malformed.statusCode, 400)
    failBody(malformed.body, "CODE_NOT_FOUND")

    // 发码之后把 QQ 解绑：确认时就找不到「替它说话的 QQ」了。
    const account = await boundAccount()
    const view = await requestReset(account.username)
    const bound = binding.getBoundPlatformBindingSync(account.accountId, "qq")
    const unbound = binding.unbindPlatformAccountSync({
        bindingId: bound.id,
        allowPrimary: true,
        actor: "test",
    })
    assert.equal(unbound.ok, true, `解绑失败 ${JSON.stringify(unbound)}`)

    const orphan = await postBot({ qq: account.qq, code: view.code })
    failBody(orphan.body, "BIND_REQUIRED")
    assert.equal(passwordResetCodeRow(view.code).status, "pending")
})

test("CC-1 矩阵：/api/bot/reset 仍受机器人令牌保护（缺令牌 / 错令牌 → 403 FORBIDDEN）", async () => {
    const account = await boundAccount()
    const view = await requestReset(account.username)

    const noToken = await postBot({ qq: account.qq, code: view.code }, null)
    assert.equal(noToken.statusCode, 403)
    assert.equal(noToken.body.code, "FORBIDDEN")

    const wrongToken = await postBot({ qq: account.qq, code: view.code }, "not-the-token")
    assert.equal(wrongToken.statusCode, 403)
    assert.equal(wrongToken.body.code, "FORBIDDEN")

    assert.equal(passwordResetCodeRow(view.code).status, "pending", "未授权请求不得改状态")
})

// ---------------------------------------------------------------------------
// reset-confirm 失败路径
// ---------------------------------------------------------------------------

test("CC-1 矩阵：未确认就改密连错 5 次 → 锁成 RATE_LIMITED（attempts 记账）", async () => {
    const account = await boundAccount()
    const view = await requestReset(account.username)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const { body } = await post("/reset-confirm", {
            account: account.username,
            code: view.code,
            password: "LockedPassw0rdE5",
        })
        failBody(body, "RESET_NOT_CONFIRMED")
        assert.equal(passwordResetCodeRow(view.code).attempts, attempt)
    }

    const fifth = await post("/reset-confirm", {
        account: account.username,
        code: view.code,
        password: "LockedPassw0rdE5",
    })
    failBody(fifth.body, "RATE_LIMITED")
    assert.equal(passwordResetCodeRow(view.code).attempts, 5)

    const sixth = await post("/reset-confirm", {
        account: account.username,
        code: view.code,
        password: "LockedPassw0rdE5",
    })
    failBody(sixth.body, "RATE_LIMITED")

    // 即便群里确认了，锁死的码也不能再改密码。
    okBody((await postBot({ qq: account.qq, code: view.code })).body)
    const stillLocked = await post("/reset-confirm", {
        account: account.username,
        code: view.code,
        password: "LockedPassw0rdE5",
    })
    failBody(stillLocked.body, "RATE_LIMITED")
})

test("CC-1 矩阵：弱密码 → PASSWORD_WEAK，且不消耗已验证的重置码", async () => {
    const account = await boundAccount()
    const oldHash = accountRow(account.accountId).password_hash
    const view = await requestReset(account.username)
    okBody((await postBot({ qq: account.qq, code: view.code })).body)

    for (const weak of ["12345678", "abcdefgh", "!!!!!!!!", "qq 123456"]) {
        const { body } = await post("/reset-confirm", {
            account: account.username,
            code: view.code,
            password: weak,
        })
        failBody(body, "PASSWORD_WEAK")
    }

    const row = passwordResetCodeRow(view.code)
    assert.equal(row.status, "confirmed", "弱密码不得把码用掉")
    assert.equal(row.attempts, 0, "弱密码不得计尝试次数")
    assert.equal(accountRow(account.accountId).password_hash, oldHash)

    // 换成合格密码后，同一枚码照常可用。
    const done = await post("/reset-confirm", {
        account: account.username,
        code: view.code,
        password: "StrongPassw0rdF6",
    })
    okBody(done.body)
    okBody(await login(account.username, "StrongPassw0rdF6"))
})

test("CC-1 矩阵：15 分钟后重置码过期 → /api/bot/reset CODE_EXPIRED、reset-confirm CODE_EXPIRED", async () => {
    const account = await boundAccount()
    const view = await requestReset(account.username)

    advance(14 * MINUTE_MS)
    assert.equal(passwordResetCodeRow(view.code).status, "pending", "14 分钟时仍然有效")

    advance(61_000)
    const botExpired = await postBot({ qq: account.qq, code: view.code })
    failBody(botExpired.body, "CODE_EXPIRED")

    const confirmExpired = await post("/reset-confirm", {
        account: account.username,
        code: view.code,
        password: "ExpiredPassw0rdG7",
    })
    failBody(confirmExpired.body, "CODE_EXPIRED")
    assert.equal(passwordResetCodeRow(view.code).status, "pending", "过期只是过期，不是被使用")
})

test("CC-1 矩阵：别人的码 / 不存在的码 / 已用过的码 → RESET_CODE_INVALID", async () => {
    const alice = await boundAccount()
    const bob = await boundAccount()
    const view = await requestReset(alice.username)

    // 码属于 Alice，Bob 拿它改自己的密码 → 直接无效。
    const crossed = await post("/reset-confirm", {
        account: bob.username,
        code: view.code,
        password: "CrossPassw0rdH8",
    })
    failBody(crossed.body, "RESET_CODE_INVALID")

    const ghost = await post("/reset-confirm", {
        account: bob.username,
        code: "ZZZZZZ",
        password: "CrossPassw0rdH8",
    })
    failBody(ghost.body, "RESET_CODE_INVALID")

    const unknownAccount = await post("/reset-confirm", {
        account: username("nobody"),
        code: view.code,
        password: "CrossPassw0rdH8",
    })
    failBody(unknownAccount.body, "ACCOUNT_NOT_FOUND")

    // 正常流程用掉之后，同一枚码再提交 → 无效。
    okBody((await postBot({ qq: alice.qq, code: view.code })).body)
    okBody((await post("/reset-confirm", {
        account: alice.username,
        code: view.code,
        password: "CrossPassw0rdH8",
    })).body)
    const usedAgain = await post("/reset-confirm", {
        account: alice.username,
        code: view.code,
        password: "CrossPassw0rdH8",
    })
    failBody(usedAgain.body, "RESET_CODE_INVALID")
    assert.equal(passwordResetCodeRow(view.code).status, "used")
})

// ---------------------------------------------------------------------------
// frozen dictionary
// ---------------------------------------------------------------------------

test("契约 C1：忘记密码的 6 个新错误码都进了冻结字典且有中文话术", () => {
    const expected = {
        ACCOUNT_NOT_FOUND: "没有找到这个账号，请检查登录名或 QQ 号是否填对。",
        RESET_NO_QQ: "该账号还没有绑定 QQ，无法自助重置密码，请联系管理员。",
        RESET_CODE_INVALID: "重置码不正确，请照抄群里的那串字母数字。",
        RESET_NOT_CONFIRMED: "还没有在群里发送 /reset 确认，请先发一次再提交新密码。",
        CODE_NOT_FOUND: "重置码不存在或已被使用，请在网页上重新获取。",
        QQ_MISMATCH: "发命令的 QQ 与该账号绑定的 QQ 不一致。",
    }
    for (const [code, message] of Object.entries(expected)) {
        assert.ok(contract.SP_AUTH_ERROR_CODES.includes(code), `${code} 未进 SP_AUTH_ERROR_CODES`)
        assert.equal(contract.SP_AUTH_ERROR_MESSAGES[code], message)
    }
    // 既有 14 个码一个不动。
    assert.equal(contract.SP_AUTH_ERROR_CODES.length, 20)
    assert.equal(contract.SP_AUTH_ERROR_MESSAGES.BIND_REQUIRED, "该账号尚未完成 QQ/KOOK 绑定。")
    assert.equal(contract.SP_AUTH_ERROR_MESSAGES.CODE_EXPIRED, "验证码已过期，请在游戏里重新获取。")
    assert.equal(contract.SP_AUTH_ERROR_MESSAGES.BAD_CREDENTIALS, "登录名或密码不正确。")
})

test("契约 C1：password_reset_codes 只有一枚有效码，且同一账号的旧码被撤销", async () => {
    const account = await boundAccount()
    const first = await requestReset(account.username)
    advance(61_000)
    const second = await requestReset(account.username)
    advance(61_000)
    const third = await requestReset(account.username)

    const rows = getDb().prepare(`
        SELECT code, status, attempts FROM password_reset_codes
        WHERE account_id = ?
        ORDER BY id ASC
    `).all(account.accountId)
    assert.deepEqual(rows, [
        { code: first.code, status: "revoked", attempts: 0 },
        { code: second.code, status: "revoked", attempts: 0 },
        { code: third.code, status: "pending", attempts: 0 },
    ])
    assert.equal(latestPasswordResetCodeRow(account.accountId).code, third.code)
})
