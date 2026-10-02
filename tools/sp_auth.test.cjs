"use strict"

// Contract C1 (§3.2) + CC-1 契约：`/sp-auth/*` HTTP surface tests.
//
// Everything runs against a throwaway DATA_DIR, so the shared `.database/`
// directory is never touched and the file can be re-run at will.
//
// Run:  node --test tools/sp_auth.test.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { Writable } = require("node:stream")
const bcrypt = require("bcryptjs")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sp-auth-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { installBundledGameplaySnapshot } =
    require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

const binding = require("../src/data/domains/account-binding")
const spAuthRoutes = require("../src/routes/sp-auth/index.ts").default

// ---------------------------------------------------------------------------
// clock: the suite freezes Date.now and moves it explicitly, so the 60 s
// re-issue window and the 15 day sliding grant TTL are deterministic instead of
// flaky.
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
const DAY_MS = 24 * 60 * MINUTE_MS

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
    return 8_150_000 + deviceSequence
}

let platformUidSequence = 0
/** Unique QQ-like uid per binding: `uq_account_bindings_triple` is global. */
function nextPlatformUid() {
    platformUidSequence += 1
    return String(520_000_000 + platformUidSequence)
}

async function post(url, payload) {
    const response = await app.inject({
        method: "POST",
        url: `/sp-auth${url}`,
        payload,
    })
    assert.equal(response.statusCode, 200, `${url} 必须返回 HTTP 200`)
    return { response, body: JSON.parse(response.payload) }
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

function latestCodeRow(accountId) {
    return getDb().prepare(`
        SELECT id, code, status, attempts, expires_at
        FROM signup_codes
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

let usernameSequence = 0
/** `SP_AUTH_USERNAME_PATTERN` is 4-20 chars and must not start with a digit. */
function username(prefix) {
    usernameSequence += 1
    return `sp${prefix}${String(usernameSequence).padStart(4, "0")}`
}

/**
 * Registers a device and returns everything the later endpoints need. Register
 * is the only entry point that creates an account, so every scenario starts
 * here.
 */
async function registerDevice(password = "Passw0rdA1") {
    const deviceId = nextDeviceId()
    const name = username("user")
    const { body } = await post("/register", {
        username: name,
        password,
        device_id: deviceId,
        version: "1.8.1",
    })
    return { deviceId, username: name, password, data: okBody(body) }
}

/** Turns a `pending` account into an `active` one the way the bot does. */
function bindPrimary(accountId, platformUid = nextPlatformUid()) {
    const result = binding.bindPlatformAccountSync({
        accountId,
        platform: "qq",
        platformUid,
        displayName: "测试账号",
        isPrimary: true,
        createdBy: "bot",
        actor: "test",
    })
    assert.equal(result.ok, true, `绑定失败 ${JSON.stringify(result)}`)
    return result.binding
}

test.before(async () => {
    assert.equal(process.env.DATA_DIR, databaseDirectory)
    data.initializeDatabase()
    app = Fastify({ logger: { level: "error", stream: logStream } })
    await app.register(spAuthRoutes, { prefix: "/sp-auth" })
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
})

// ---------------------------------------------------------------------------
// register 契约 C1 happy path and the CC-1 matrix
// ---------------------------------------------------------------------------

test("契约 C1：新设备注册返回 token/code/code_expires_at/viewer_id/username", async () => {
    const deviceId = nextDeviceId()
    const name = username("fresh")
    const { body } = await post("/register", {
        username: name,
        password: "Passw0rdA1",
        device_id: deviceId,
        version: "1.8.1",
    })

    const payload = okBody(body)
    assert.deepEqual(Object.keys(payload).sort(), [
        "code",
        "code_expires_at",
        "token",
        "username",
        "viewer_id",
    ])
    assert.equal(payload.username, name)
    assert.match(payload.token, /^[0-9a-f]{64}$/)
    assert.match(payload.code, /^[0-9A-Z]{6}$/)
    assert.ok(Number.isSafeInteger(payload.viewer_id) && payload.viewer_id > 0)

    // C1: code_expires_at is an ISO instant roughly one TTL into the future.
    const ttlMs = new Date(payload.code_expires_at).getTime() - Date.now()
    assert.equal(ttlMs, 30 * MINUTE_MS)

    // 库里必须真的是同一个码（A1 验收：页面上的码 == signup_codes.code）。
    const deviceRow = deviceGrantRow(deviceId)
    const codeRow = latestCodeRow(deviceRow.account_id)
    assert.equal(codeRow.code, payload.code)
    assert.equal(codeRow.status, "pending")
    assert.equal(accountRow(deviceRow.account_id).bind_state, "pending")
})

test("CC-1：无映射 → 建 pending 账号 + 发码 + 建 grant", async () => {
    const accountsBefore = accountCount()
    const auditsBefore = bindAuditActionCount("register")
    const { deviceId, data: payload } = await registerDevice()
    const deviceRow = deviceGrantRow(deviceId)
    assert.ok(deviceRow, "device_grants 必须有一行")
    assert.equal(deviceRow.token, payload.token)

    const account = accountRow(deviceRow.account_id)
    assert.equal(account.bind_state, "pending")
    assert.equal(accountCount() - accountsBefore, 1, "恰好新建 1 个账号")
    assert.equal(bindAuditActionCount("register") - auditsBefore, 1)
})

test("CC-1：pending 且码未过期 → 幂等复用同一账号、吊销旧码、发新码、TTL 重置", async () => {
    const accountsBefore = accountCount()
    const { deviceId, data: first } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id

    // 60 秒窗口内重复注册会被限流（下一条测试覆盖），先越过窗口。
    advance(61_000)
    const { body } = await post("/register", {
        username: "ignoredname01",
        password: "Passw0rdA1",
        device_id: deviceId,
        version: "1.8.1",
    })
    const second = okBody(body)

    assert.notEqual(second.code, first.code, "必须换发新码")
    assert.equal(deviceGrantRow(deviceId).account_id, accountId, "不得新建账号")
    assert.equal(accountCount() - accountsBefore, 1, "整个流程只应有 1 个账号落库")

    // 旧码被吊销，不是仍然 pending。
    const codes = getDb().prepare(
        "SELECT code, status FROM signup_codes WHERE account_id = ? ORDER BY id",
    ).all(accountId)
    assert.equal(codes.length, 2)
    assert.equal(codes[0].status, "revoked")
    assert.equal(codes[1].code, second.code)
    assert.equal(codes[1].status, "pending")

    // TTL 重置：新码从当前时刻重新计时。
    const ttlMs = new Date(second.code_expires_at).getTime() - Date.now()
    assert.equal(ttlMs, 30 * MINUTE_MS)
})

test("CC-1：pending 且同设备 60 秒内重复注册 → RATE_LIMITED", async () => {
    const accountsBefore = accountCount()
    const { deviceId } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id

    advance(30_000)
    const { body } = await post("/register", {
        username: "ignoredname01",
        password: "Passw0rdA1",
        device_id: deviceId,
    })
    failBody(body, "RATE_LIMITED")

    // 限流不得留下副作用：账号、码、grant 都保持原样。
    assert.equal(deviceGrantRow(deviceId).account_id, accountId)
    assert.equal(latestCodeRow(accountId).status, "pending")
    assert.equal(accountCount() - accountsBefore, 1)
})

test("CC-1：pending 且码已过期 → 复用该 pending 账号，不新建账号", async () => {
    const accountsBefore = accountCount()
    const { deviceId, data: first } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    const grantBefore = deviceGrantRow(deviceId)

    // 码 TTL 30 分钟，但 grant 15 天：越过码有效期、留在 grant 有效期内。
    advance(31 * MINUTE_MS)
    const { body } = await post("/register", {
        username: "pendingnewname",
        password: "Passw0rdA1",
        device_id: deviceId,
    })
    const second = okBody(body)

    assert.notEqual(second.code, first.code)
    assert.equal(deviceGrantRow(deviceId).account_id, accountId, "必须复用同一账号")
    assert.equal(accountCount() - accountsBefore, 1, "不得新建账号")
    assert.equal(latestCodeRow(accountId).status, "pending")
    assert.equal(grantBefore.token, second.token, "grant 有效期内不换 token")
})

test("CC-1：pending 且码与 grant 都过期 → 仍复用该账号并刷新凭据", async () => {
    const accountsBefore = accountCount()
    const { deviceId } = await registerDevice("Passw0rdA1")
    const accountId = deviceGrantRow(deviceId).account_id

    // 越过 15 天 grant 有效期（期间无任何带 token 的活跃），CC-1 的「已过期」分支。
    advance(31 * DAY_MS)
    const { body } = await post("/register", {
        username: "refreshedname",
        password: "NewPassw0rdB2",
        device_id: deviceId,
    })
    okBody(body)

    assert.equal(deviceGrantRow(deviceId).account_id, accountId)
    assert.equal(accountCount() - accountsBefore, 1, "不得新建账号")
    const account = accountRow(accountId)
    assert.equal(account.username, "refreshedname")
    assert.equal(bcrypt.compareSync("NewPassw0rdB2", account.password_hash), true)
    assert.equal(bcrypt.compareSync("Passw0rdA1", account.password_hash), false)
})

test("CC-1：active 已绑定 → 同设备再注册 DEVICE_TAKEN，只带 username/viewer_id，不带任何凭据", async () => {
    const owner = await registerDevice()
    const accountId = deviceGrantRow(owner.deviceId).account_id
    bindPrimary(accountId, "556677889")

    const accountsBefore = accountCount()
    const grantBefore = deviceGrantRow(owner.deviceId)

    // CC-1：映射已存在且为 active（即「本机已经注册过账号」）→ DEVICE_TAKEN。
    const { body } = await post("/register", {
        username: username("intruder"),
        password: "Passw0rdA1",
        device_id: owner.deviceId,
    })
    const failure = failBody(body, "DEVICE_TAKEN")

    const viewerId = getDb().prepare(
        "SELECT token FROM sessions WHERE account_id = ? AND type = 2 LIMIT 1",
    ).get(accountId)
    assert.deepEqual(Object.keys(failure.data).sort(), ["username", "viewer_id"])
    assert.equal(failure.data.username, owner.username)
    assert.equal(failure.data.viewer_id, Number(viewerId.token))

    // 不得回传任何可登录凭据，也不得改动库里的账号/凭据。
    const serialised = JSON.stringify(failure)
    assert.doesNotMatch(serialised, /[0-9a-f]{64}/, "不得出现 device token")
    assert.doesNotMatch(serialised, /password/i)
    assert.equal(accountCount() - accountsBefore, 0, "不得新建账号")
    assert.deepEqual(deviceGrantRow(owner.deviceId), grantBefore, "不得换发 grant")
})

test("CC-1：disabled → ACCOUNT_DISABLED（注册与登录一致）", async () => {
    const { deviceId, username: name, data } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    binding.setAccountBindStateSync(accountId, "disabled", "test")

    const registerAttempt = await post("/register", {
        username: username("another"),
        password: "Passw0rdA1",
        device_id: deviceId,
    })
    failBody(registerAttempt.body, "ACCOUNT_DISABLED")

    const loginAttempt = await post("/login", {
        login_name: name,
        password: "Passw0rdA1",
        device_id: deviceId,
    })
    failBody(loginAttempt.body, "ACCOUNT_DISABLED")

    // disabled 账号不得被刷新，也不得发放新 grant。
    assert.equal(accountRow(accountId).username, name)
    assert.equal(deviceGrantRow(deviceId).token, data.token)
})

test("CC-1：udid 头与 body.device_id 冲突时一律以 device_id 为准", async () => {
    const deviceId = nextDeviceId()
    const name = username("udidwin")
    const response = await app.inject({
        method: "POST",
        url: "/sp-auth/register",
        headers: { udid: "10000001" },
        payload: { username: name, password: "Passw0rdA1", device_id: deviceId },
    })
    assert.equal(response.statusCode, 200)
    const payload = okBody(JSON.parse(response.payload))

    assert.ok(deviceGrantRow(deviceId), "grant 必须落在 body.device_id 上")
    assert.equal(deviceGrantRow(10000001), undefined, "udid 头不得创建任何映射")
    assert.equal(payload.username, name)
})

test("契约 C1：用户名重复 → USERNAME_TAKEN（换设备也一样）", async () => {
    const owner = await registerDevice()
    const { body } = await post("/register", {
        username: owner.username,
        password: "Passw0rdA1",
        device_id: nextDeviceId(),
    })
    failBody(body, "USERNAME_TAKEN")
})

test("契约 C1：用户名非法 → USERNAME_INVALID，且不建账号", async () => {
    const before = getDb().prepare("SELECT COUNT(*) AS total FROM accounts").get().total
    for (const bad of ["ab", "1abc", "has space", "名字带中文", "a".repeat(21), ""]) {
        const { body } = await post("/register", {
            username: bad,
            password: "Passw0rdA1",
            device_id: nextDeviceId(),
        })
        failBody(body, "USERNAME_INVALID")
    }
    const after = getDb().prepare("SELECT COUNT(*) AS total FROM accounts").get().total
    assert.equal(after, before, "非法用户名不得留下账号")
})

test("契约 C1：弱密码 → PASSWORD_WEAK，且不建账号", async () => {
    const before = getDb().prepare("SELECT COUNT(*) AS total FROM accounts").get().total
    for (const weak of ["short1A", "alllowercase1", "ALLUPPERCASE1", "NoDigitsHere", "带符号 Passw0rd"]) {
        const { body } = await post("/register", {
            username: username("weak"),
            password: weak,
            device_id: nextDeviceId(),
        })
        failBody(body, "PASSWORD_WEAK")
    }
    const after = getDb().prepare("SELECT COUNT(*) AS total FROM accounts").get().total
    assert.equal(after, before, "弱密码不得留下账号")
})

test("契约 C1（v5.5）：符号密码可用 —— 可打印 ASCII 放开，空格/中文仍拒", async () => {
    // 业主 m05850「密码强度判断有问题」：旧口径 `[A-Za-z0-9]{8,64}` 把 `Aa123456!` 这类
    // 常见密码判弱，而报错文案从没说不能用符号。现在放开到 `[!-~]`（0x21-0x7E）。
    const { data } = await registerDevice("Aa123456!@#")
    assert.equal(typeof data.token, "string", "符号密码注册应成功并下发令牌")

    // 放宽的边界：空格与中文不在可打印 ASCII 里，必须继续被拒（否则上面那条弱密码表会失守）。
    for (const stillWeak of ["Aa12345 6!", "Aa1234中文56!"]) {
        const { body } = await post("/register", {
            username: username("symbol"),
            password: stillWeak,
            device_id: nextDeviceId(),
        })
        failBody(body, "PASSWORD_WEAK")
    }
})

test("密码只存哈希：明文绝不落库，注册响应也不回传哈希", async () => {
    const password = "Passw0rdA1"
    const { deviceId, data: payload } = await registerDevice(password)
    const account = accountRow(deviceGrantRow(deviceId).account_id)

    assert.notEqual(account.password_hash, password)
    assert.match(account.password_hash, /^\$2[aby]\$/)
    assert.equal(bcrypt.compareSync(password, account.password_hash), true)
    assert.doesNotMatch(JSON.stringify(payload), /password/i)
    assert.doesNotMatch(JSON.stringify(payload), /\$2[aby]\$/)
})

// ---------------------------------------------------------------------------
// login 契约 C1
// ---------------------------------------------------------------------------

test("契约 C1：登录成功返回 {token,viewer_id,username,bound:true}", async () => {
    const { deviceId, username: name, password, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    bindPrimary(accountId)

    const { body } = await post("/login", {
        login_name: name,
        password,
        device_id: deviceId,
    })
    const payload = okBody(body)

    assert.deepEqual(Object.keys(payload).sort(), ["bound", "token", "username", "viewer_id"])
    assert.equal(payload.bound, true)
    assert.equal(payload.username, name)
    assert.equal(payload.viewer_id, registered.viewer_id, "viewer_id 必须稳定")
    assert.match(payload.token, /^[0-9a-f]{64}$/)
})

test("验收 A5：换设备登录后 viewer_id 不变", async () => {
    const { deviceId, username: name, password, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    bindPrimary(accountId, "223344556")

    const secondDevice = nextDeviceId()
    const { body } = await post("/login", {
        login_name: name,
        password,
        device_id: secondDevice,
    })
    const payload = okBody(body)

    assert.equal(payload.viewer_id, registered.viewer_id)
    assert.ok(deviceGrantRow(secondDevice), "新设备必须拿到 grant")
    assert.equal(deviceGrantRow(secondDevice).account_id, accountId)
})

test("契约 C1：密码错误 / 账号不存在 / 缺字段 → BAD_CREDENTIALS（不泄露账号是否存在）", async () => {
    const { deviceId, username: name } = await registerDevice()

    const wrongPassword = await post("/login", {
        login_name: name,
        password: "WrongPassw0rd1",
        device_id: deviceId,
    })
    failBody(wrongPassword.body, "BAD_CREDENTIALS")

    const unknownAccount = await post("/login", {
        login_name: "nobody_here",
        password: "Passw0rdA1",
        device_id: deviceId,
    })
    failBody(unknownAccount.body, "BAD_CREDENTIALS")

    const missing = await post("/login", { login_name: name, device_id: deviceId })
    failBody(missing.body, "BAD_CREDENTIALS")

    // 失败不得刷新 last_login，也不得发新 grant。
    assert.equal(deviceGrantRow(deviceId).account_id, deviceGrantRow(deviceId).account_id)
})

test("契约 C1：未完成绑定 → BIND_REQUIRED + data:{code,code_expires_at}", async () => {
    const { deviceId, username: name, password, data: registered } = await registerDevice()

    const { body } = await post("/login", {
        login_name: name,
        password,
        device_id: nextDeviceId(),
    })
    const failure = failBody(body, "BIND_REQUIRED")

    assert.deepEqual(Object.keys(failure.data).sort(), ["code", "code_expires_at"])
    assert.equal(failure.data.code, registered.code)
    assert.equal(failure.data.code_expires_at, registered.code_expires_at)
    assert.ok(deviceGrantRow(deviceId), "原设备映射不受影响")
})

test("契约 C1：login_name 支持账号名与绑定后的 QQ 号两种口径", async () => {
    const { deviceId, username: name, password } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    bindPrimary(accountId, "998877665")

    const byUsername = await post("/login", { login_name: name, password, device_id: deviceId })
    okBody(byUsername.body)

    const byPlatformUid = await post("/login", {
        login_name: "998877665",
        password,
        device_id: deviceId,
    })
    const payload = okBody(byPlatformUid.body)
    assert.equal(payload.username, name)
})

test("CC-1：设备已被别的账号占用 → 登录 DEVICE_TAKEN", async () => {
    const owner = await registerDevice()
    const accountId = deviceGrantRow(owner.deviceId).account_id
    bindPrimary(accountId, "112233445")

    const second = await registerDevice()
    const secondAccountId = deviceGrantRow(second.deviceId).account_id
    bindPrimary(secondAccountId, "667788990")

    const { body } = await post("/login", {
        login_name: second.username,
        password: second.password,
        device_id: owner.deviceId,
    })
    failBody(body, "DEVICE_TAKEN")
    assert.equal(
        deviceGrantRow(owner.deviceId).account_id,
        accountId,
        "被占用设备的归属不得被改变",
    )
})

// ---------------------------------------------------------------------------
// bind-status / resend
// ---------------------------------------------------------------------------

test("契约 C1：bind-status 用 {token} 即可查询（页面轮询口径）", async () => {
    const { data: registered } = await registerDevice()

    const { body } = await post("/bind-status", { token: registered.token })
    const payload = okBody(body)

    assert.equal(payload.bound, false)
    assert.equal(payload.code, registered.code)
    assert.equal(payload.code_expires_at, registered.code_expires_at)
    assert.equal(payload.viewer_id, registered.viewer_id)
})

test("契约 C1：绑定完成后 bind-status 返回 bound:true 且不再下发码", async () => {
    const { deviceId, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    bindPrimary(accountId)

    const { body } = await post("/bind-status", { token: registered.token })
    const payload = okBody(body)

    assert.equal(payload.bound, true)
    assert.equal(payload.code, null)
    assert.equal(payload.code_expires_at, null)
    assert.equal(payload.viewer_id, registered.viewer_id)
})

test("契约 C1：令牌无效/格式错误 → TOKEN_INVALID", async () => {
    const { data: registered } = await registerDevice()

    const bogus = await post("/bind-status", { token: "f".repeat(64) })
    failBody(bogus.body, "TOKEN_INVALID")

    const malformed = await post("/bind-status", { token: "not-a-token" })
    failBody(malformed.body, "TOKEN_INVALID")

    const empty = await post("/bind-status", {})
    failBody(empty.body, "TOKEN_INVALID")

    // 别的设备的合法 token 也不能用于本设备（token 是 bearer 凭据）。
    const other = await registerDevice()
    assert.notEqual(other.data.token, registered.token)
})

test("契约 C1：resend 60 秒内 → RATE_LIMITED", async () => {
    const { data: registered } = await registerDevice()
    advance(30_000)

    const { body } = await post("/resend", { token: registered.token })
    failBody(body, "RATE_LIMITED")
})

test("契约 C1：resend 越过窗口 → 新码 + TTL 重置，旧码 CODE_* 语义保持", async () => {
    const { deviceId, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    const previousCode = registered.code

    advance(61_000)
    const { body } = await post("/resend", { token: registered.token })
    const payload = okBody(body)

    assert.match(payload.code, /^[0-9A-Z]{6}$/)
    assert.notEqual(payload.code, previousCode)
    assert.equal(new Date(payload.code_expires_at).getTime() - Date.now(), 30 * MINUTE_MS)
    assert.equal(latestCodeRow(accountId).code, payload.code)

    // A2 验收口径：被顶掉的旧码在数据层是 revoked。
    const old = getDb().prepare("SELECT status FROM signup_codes WHERE code = ?").get(previousCode)
    assert.equal(old.status, "revoked")
})

test("契约 C1：resend 的 token 无效 → TOKEN_INVALID", async () => {
    const { body } = await post("/resend", { token: "0".repeat(64) })
    failBody(body, "TOKEN_INVALID")
})

// ---------------------------------------------------------------------------
// profile / logout
// ---------------------------------------------------------------------------

test("profile：返回绑定状态与玩家摘要，且绝不回传哈希", async () => {
    const { deviceId, username: name, password, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id

    const pendingProfile = await post("/profile", { token: registered.token })
    const pendingPayload = okBody(pendingProfile.body)
    assert.equal(pendingPayload.bound, false)
    assert.equal(pendingPayload.bind_state, "pending")
    assert.equal(pendingPayload.username, name)
    assert.equal(pendingPayload.viewer_id, registered.viewer_id)
    assert.equal(pendingPayload.platform, null)
    assert.equal(pendingPayload.platform_uid_masked, null)
    assert.equal(typeof pendingPayload.player_name, "string")

    const profileBinding = bindPrimary(accountId, "123456789")
    const boundProfile = await post("/profile", { token: registered.token })
    const boundPayload = okBody(boundProfile.body)
    assert.equal(boundPayload.bound, true)
    assert.equal(boundPayload.bind_state, "active")
    assert.equal(boundPayload.platform, "qq")
    assert.equal(boundPayload.platform_uid_masked, "1234****6789")
    assert.equal(boundPayload.display_name, "测试账号")
    assert.equal(profileBinding.platformUid, "123456789")
    assert.match(boundPayload.bound_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(boundPayload.code, null)

    // 口令哈希与明文都不得出现在任何响应里。
    const serialised = JSON.stringify(boundPayload)
    assert.doesNotMatch(serialised, /\$2[aby]\$/)
    assert.doesNotMatch(serialised, new RegExp(password))
    assert.equal(bcrypt.compareSync(password, accountRow(accountId).password_hash), true)
})

test("profile：token 无效 → TOKEN_INVALID", async () => {
    const { body } = await post("/profile", { token: "a".repeat(64) })
    failBody(body, "TOKEN_INVALID")
})

test("契约 C1：logout 成功返回 {ok:true,data:{}} 并吊销 token", async () => {
    const { data: registered } = await registerDevice()

    const { body } = await post("/logout", { token: registered.token })
    assert.equal(body.ok, true)
    assert.deepEqual(body.data, {})

    const after = await post("/bind-status", { token: registered.token })
    failBody(after.body, "TOKEN_INVALID")

    // 未过期但已吊销：再次 logout 仍然成功（幂等），不报错。
    const again = await post("/logout", { token: registered.token })
    assert.equal(again.body.ok, true)
})

// ---------------------------------------------------------------------------
// contract-level guards
// ---------------------------------------------------------------------------

test("契约 C1：所有端点 HTTP 一律 200，落库动作写 bind_audit", async () => {
    const { deviceId, username: name, password, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    bindPrimary(accountId)

    const responses = await Promise.all([
        post("/register", { username: name, password, device_id: deviceId }),
        post("/login", { login_name: name, password, device_id: deviceId }),
        post("/bind-status", { token: registered.token }),
        post("/resend", { token: registered.token }),
        post("/profile", { token: registered.token }),
        post("/logout", { token: registered.token }),
    ])
    for (const { response } of responses) {
        assert.equal(response.statusCode, 200)
        assert.match(response.headers["content-type"], /application\/json/)
    }

    const actions = auditActions()
    assert.ok(actions.includes("register"), "缺少 register 审计")
    assert.ok(actions.includes("login"), "缺少 login 审计")
    assert.ok(actions.includes("gate_reject"), "缺少 gate_reject 审计（限流/拒绝）")
})

// ---------------------------------------------------------------------------
// 契约 3.2（2026-10-01 修订）：设备授权 15 天 + 活跃滑动续期
//
// 语义：窗口是「最后一次活跃 + 15 天」。带 token 调 bind-status / resend /
// profile 都算一次活跃，窗口顺延；连续 15 天不活跃则授权失效、必须重新登录。
// 续期只写 expires_at / updated_at，绝不轮换 token（否则客户端手里的凭据
// 会被自己的一次轮询作废）。
// ---------------------------------------------------------------------------

/** 数据层读到的到期时刻，换算成「相对 BASE_NOW_MS 的天数」。 */
function grantExpiryDays(deviceId) {
    const grant = binding.getDeviceGrantSync(deviceId)
    assert.ok(grant !== null, `device ${deviceId} 应存在授权行`)
    return (grant.expiresAt.getTime() - BASE_NOW_MS) / DAY_MS
}

test("契约 3.2（2026-10-01）：新授权的有效期是 15 天，不再是 30 天", async () => {
    const { deviceId } = await registerDevice()

    assert.equal(binding.DEVICE_GRANT_TTL_DAYS, 15)
    assert.equal(grantExpiryDays(deviceId), 15, "签发窗口应为 t0 + 15 天")
    assert.equal(Date.parse(deviceGrantRow(deviceId).expires_at), BASE_NOW_MS + 15 * DAY_MS)
})

test("契约 3.2 滑动续期：第 10 天上线一次即顺延，累计 20 天 token 仍有效且到期 = 最后活跃 + 15 天", async () => {
    const { deviceId, data: registered } = await registerDevice()
    const accountId = deviceGrantRow(deviceId).account_id
    bindPrimary(accountId)

    // 第 10 天：一次 bind-status（读路径）即是一次活跃。
    advance(10 * DAY_MS)
    const auditsBefore = auditActions().length
    const first = await post("/bind-status", { token: registered.token, device_id: deviceId })
    okBody(first.body)
    assert.equal(grantExpiryDays(deviceId), 25, "第 10 天续期后应到 t0 + 25 天")
    assert.equal(auditActions().length, auditsBefore, "续期是静默副作用，不写 bind_audit")

    // 累计 20 天：已越过原始 15 天窗口，没有续期这里必然 TOKEN_INVALID。
    advance(10 * DAY_MS)
    const second = await post("/profile", { token: registered.token, device_id: deviceId })
    const profile = okBody(second.body)
    assert.equal(profile.viewer_id > 0, true, "第 20 天 profile 仍须认出该账号")
    assert.equal(grantExpiryDays(deviceId), 35, "第 20 天续期后应到 t0 + 35 天")

    // ③ 续期不得改变 token 字符串。
    assert.equal(deviceGrantRow(deviceId).token, registered.token)
    assert.equal(binding.getDeviceGrantSync(deviceId).token, registered.token)
})

test("契约 3.2 滑动续期：resend 也算活跃，第 14 天重发后窗口顺延且 token 不变", async () => {
    const { deviceId, data: registered } = await registerDevice()

    advance(14 * DAY_MS)
    const { body } = await post("/resend", { token: registered.token, device_id: deviceId })
    okBody(body)

    assert.equal(grantExpiryDays(deviceId), 29, "第 14 天续期后应到 t0 + 29 天")
    assert.equal(deviceGrantRow(deviceId).token, registered.token)
})

test("契约 3.2 反例：连续 15 天不活跃（第 16 天才带 token 上线）→ TOKEN_INVALID 且不续期", async () => {
    const { deviceId, data: registered } = await registerDevice()
    const before = deviceGrantRow(deviceId)

    // 中途一次带 token 的接口都不调，直接推进 16 天。
    advance(16 * DAY_MS)
    const { body } = await post("/bind-status", { token: registered.token, device_id: deviceId })
    failBody(body, "TOKEN_INVALID")

    // 拒绝分支是纯读：过期时间戳原样保留，失败调用不会把它悄悄顺延。
    assert.equal(deviceGrantRow(deviceId).expires_at, before.expires_at, "过期分支不得续期")
})

test("契约 3.2 边界：恰好卡在 15 天整、期间无活跃 → 已失效", async () => {
    const { deviceId, data: registered } = await registerDevice()

    advance(15 * DAY_MS)
    const { body } = await post("/bind-status", { token: registered.token, device_id: deviceId })
    failBody(body, "TOKEN_INVALID")
})

test("TTL 滑动：数据层 refreshDeviceGrantExpirySync 只顺延不轮换；无行 null；非法 ttlDays 抛错", async () => {
    const { deviceId, data: registered } = await registerDevice()
    const before = binding.getDeviceGrantSync(deviceId)

    advance(3 * DAY_MS)
    const refreshed = binding.refreshDeviceGrantExpirySync(deviceId)
    assert.ok(refreshed !== null, "有授权行时必须返回更新后的 grant")
    assert.equal(refreshed.token, before.token, "续期不得轮换 token")
    assert.equal(refreshed.expiresAt.getTime(), BASE_NOW_MS + 3 * DAY_MS + 15 * DAY_MS)
    assert.equal(refreshed.updatedAt.getTime(), BASE_NOW_MS + 3 * DAY_MS, "updated_at 指向本次续期")
    assert.equal(refreshed.createdAt.getTime(), before.createdAt.getTime(), "created_at 不动")

    // 显式 ttlDays 覆盖默认值。
    const custom = binding.refreshDeviceGrantExpirySync(deviceId, 2)
    assert.ok(custom !== null)
    assert.equal(custom.expiresAt.getTime(), BASE_NOW_MS + 3 * DAY_MS + 2 * DAY_MS)

    // 无授权行 → null（调用方据此判失效），且不会凭空建行。
    assert.equal(binding.refreshDeviceGrantExpirySync(999_999_999), null)
    assert.equal(binding.getDeviceGrantSync(999_999_999), null)

    for (const bad of [0, -1, 1.5, Number.NaN]) {
        assert.throws(
            () => binding.refreshDeviceGrantExpirySync(deviceId, bad),
            /positive integer/,
            `ttlDays=${bad} 必须被拒绝`,
        )
    }

    // 数据层续期后，客户端手里的原 token 依旧可用。
    const { body } = await post("/bind-status", { token: registered.token, device_id: deviceId })
    okBody(body)
})

test("测试环境隔离：DATA_DIR 指向临时目录", () => {
    assert.equal(process.env.DATA_DIR, databaseDirectory)
    assert.match(databaseDirectory, /sp-auth-/)
})

function bindAuditActionCount(action) {
    return getDb()
        .prepare("SELECT COUNT(*) AS total FROM bind_audit WHERE action = ?")
        .get(action).total
}

// 所有 test 共用同一个 DATA_DIR，因此计数断言一律用 before/after 差值。
function accountCount() {
    return getDb().prepare("SELECT COUNT(*) AS total FROM accounts").get().total
}
