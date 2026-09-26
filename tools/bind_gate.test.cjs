"use strict"

// P4 服务端绑定闸门 —— 契约 C3 / CC-1 / 卡 A5。
//
// 覆盖：关闸逐字节一致（golden 模板）、开闸未绑定 → 517 + sp_binding + body 文案、
// 已绑定 active 放行且响应形状不变、pending/grant 过期/无映射 → BIND_REQUIRED、
// disabled → ACCOUNT_DISABLED、iOS 与 Android 的日志区分、env 非法 fail-closed、
// 以及闸门开着时 /sp-auth/* 的 DEVICE_TAKEN / RATE_LIMITED 不受影响。
//
// 全程跑在一次性 DATA_DIR 上，不碰共享 `.database/`。
//
// Run:  node --test tools/bind_gate.test.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { Writable } = require("node:stream")
const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bind-gate-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { installBundledGameplaySnapshot } =
    require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

const binding = require("../src/data/domains/account-binding")
const { getAccountSessionsOfTypeSync } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const bindGate = require("../src/lib/bind-gate")
const cnToolRoutes = require("../src/routes/cn/tool").default
const spAuthRoutes = require("../src/routes/sp-auth/index.ts").default
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

// ---------------------------------------------------------------------------
// clock / env / console 捕获
// ---------------------------------------------------------------------------

const BASE_NOW_MS = Date.UTC(2026, 8, 24, 0, 0, 0)
const BASE_NOW_ISO = "2026-09-24T00:00:00.000Z"
let nowOffsetMs = 0
const realDateNow = Date.now
Date.now = () => BASE_NOW_MS + nowOffsetMs

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

function advance(ms) {
    nowOffsetMs += ms
}

function resetClock() {
    nowOffsetMs = 0
}

/** `delete` 而不是赋 undefined，避免污染成字符串 "undefined"。 */
function setGate(value) {
    if (value === undefined) delete process.env.BIND_GATE_ENABLED
    else process.env.BIND_GATE_ENABLED = value
}

function setExempt(value) {
    if (value === undefined) delete process.env.BIND_GATE_EXEMPT_UDIDS
    else process.env.BIND_GATE_EXEMPT_UDIDS = value
}

/** 闸门用全局 console.log 记录拦截；测试捕获它，顺便验证「关闸不打日志」。 */
const consoleLines = []
const realConsoleLog = console.log
console.log = (...args) => {
    consoleLines.push(args.map(item => String(item)).join(" "))
}

function gateLogLines() {
    return consoleLines.filter(line => line.startsWith("[BIND-GATE]"))
}

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
    return 8_200_000 + deviceSequence
}

let usernameSequence = 0
/** `SP_AUTH_USERNAME_PATTERN` = 4-20 字符且不能以数字开头。 */
function nextUsername() {
    usernameSequence += 1
    return `bgu${String(usernameSequence).padStart(4, "0")}`
}

let platformUidSequence = 0
function nextPlatformUid() {
    platformUidSequence += 1
    return String(530_000_000 + platformUidSequence)
}

const SIGNUP_URL = "/api/index.php/tool/signup"

function signupRequest(deviceId, headers = {}) {
    return app.inject({
        method: "POST",
        url: SIGNUP_URL,
        headers,
        payload: { device_id: deviceId, channelNo: "test" },
    })
}

/** cn 路由的响应是 msgpack（onSend 钩子按 content-type 打包），解出来是对象或 JSON 串。 */
function decodeMsgpack(response) {
    assert.equal(response.statusCode, 200, `期望 HTTP 200，实际 ${response.statusCode}`)
    assert.equal(response.headers["content-type"], "application/x-msgpack")
    const raw = unpack(Buffer.from(response.body, "base64"))
    return typeof raw === "string" ? JSON.parse(raw) : raw
}

function accountRow(accountId) {
    return getDb().prepare(
        "SELECT id, username, bind_state FROM accounts WHERE id = ?",
    ).get(accountId)
}

function accountCount() {
    return getDb().prepare("SELECT COUNT(*) AS count FROM accounts").get().count
}

function deviceBindingRow(deviceId) {
    return getDb().prepare(
        "SELECT device_id, account_id FROM device_bindings WHERE device_id = ?",
    ).get(deviceId)
}

function deviceGrantRow(deviceId) {
    return getDb().prepare(
        "SELECT device_id, account_id, token, expires_at FROM device_grants WHERE device_id = ?",
    ).get(deviceId)
}

function sessionAccountForViewer(viewerId, accountId) {
    // sessions 表的主键是 token（没有 id 列），所以直接用领域函数核对归属。
    return getAccountSessionsOfTypeSync(accountId, SessionType.VIEWER)
        .some(session => session.token === String(viewerId))
}

function gateRejectAudits() {
    return getDb().prepare(
        "SELECT action, account_id, actor, detail FROM bind_audit WHERE action = 'gate_reject' ORDER BY id",
    ).all()
}

/** 走 P3 的 /sp-auth/register 建 pending 账号（闸门认可的「已发码未绑定」状态）。 */
async function registerViaSpAuth(deviceId = nextDeviceId()) {
    const response = await app.inject({
        method: "POST",
        url: "/sp-auth/register",
        payload: {
            username: nextUsername(),
            password: "Passw0rdA1",
            device_id: deviceId,
            version: "1.8.1",
        },
    })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.payload)
    assert.equal(body.ok, true, `register 失败：${response.payload}`)
    const grant = deviceGrantRow(deviceId)
    assert.ok(grant, "register 必须同时写 device_grants")
    assert.ok(deviceBindingRow(deviceId), "register 必须同时写 device_bindings")
    return { deviceId, accountId: grant.account_id, data: body.data }
}

/** 把 pending 账号变成 active（bot 的绑定动作）。 */
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
    registerCnMsgpackOnSend(app)
    await app.register(cnToolRoutes, { prefix: "/api/index.php/tool" })
    await app.register(spAuthRoutes, { prefix: "/sp-auth" })
    await app.ready()
})

test.after(async () => {
    Date.now = realDateNow
    console.log = realConsoleLog
    await app?.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    setGate(undefined)
    setExempt(undefined)
})

test.beforeEach(() => {
    resetClock()
    setGate(undefined)
    setExempt(undefined)
    consoleLines.length = 0
    // 每个用例从空审计表开始，这样「本次拒绝写了几条」是精确断言而不是累计值。
    getDb().prepare("DELETE FROM bind_audit").run()
})

// ---------------------------------------------------------------------------
// ① 关闸：行为与本包之前逐字节一致
// ---------------------------------------------------------------------------

/** 把三个随机/时钟字段换成占位符，其余（键名、键序、类型、字面量）参与逐字节比较。 */
function normalizeSignupBody(body) {
    const clone = JSON.parse(JSON.stringify(body))
    clone.data_headers.viewer_id = "<VIEWER_ID>"
    clone.data_headers.servertime = "<SERVERTIME>"
    clone.data.login_token = "<LOGIN_TOKEN>"
    clone.data.roleName = "<PLAYER>"
    clone.data.accountName = "<PLAYER>"
    return clone
}

test("关闸（缺省）：/signup 响应逐字节等于 P4 之前的模板", async () => {
    const { deviceId, accountId, data: registerData } = await registerViaSpAuth()
    assert.equal(accountRow(accountId).bind_state, "pending", "前置：这是一个未绑定账号")

    const response = await signupRequest(deviceId)
    const body = decodeMsgpack(response)

    // 键序 + 字面量：data_headers 六键（generateDataHeaders 默认 fields，注意没有 udid），
    // data 八键照抄既有响应字面量，createDate 是冻结时钟的 ISO（证明没有任何额外字段混进来）。
    assert.equal(
        JSON.stringify(normalizeSignupBody(body)),
        JSON.stringify({
            data_headers: {
                force_update: false,
                asset_update: false,
                short_udid: 0,
                viewer_id: "<VIEWER_ID>",
                servertime: "<SERVERTIME>",
                result_code: 1,
            },
            data: {
                login_token: "<LOGIN_TOKEN>",
                newAccount: 0,
                roleName: "<PLAYER>",
                accountName: "<PLAYER>",
                sign: "dummy_sign",
                createDate: BASE_NOW_ISO,
                serverName: "StarPoint CN",
                serverId: 1,
            },
        }),
    )
    assert.deepEqual(
        Object.keys(body.data_headers),
        ["force_update", "asset_update", "short_udid", "viewer_id", "servertime", "result_code"],
    )
    assert.deepEqual(
        Object.keys(body.data),
        ["login_token", "newAccount", "roleName", "accountName", "sign", "createDate", "serverName", "serverId"],
    )
    assert.match(body.data.login_token, /^[a-z0-9]{32}$/)
    assert.equal(body.data.createDate, BASE_NOW_ISO)
    // 已知设备分支照旧复用 register 建的那个 viewer_id（放行路径没被闸门改道）。
    assert.equal(body.data_headers.viewer_id, registerData.viewer_id)
    assert.equal(body.data.newAccount, 0)
    assert.ok(sessionAccountForViewer(body.data_headers.viewer_id, accountId))

    // 关闸时闸门一个副作用都不许有。
    assert.equal(gateRejectAudits().length, 0, "关闸不得写 gate_reject 审计")
    assert.equal(gateLogLines().length, 0, "关闸不得打 [BIND-GATE] 日志")
})

test("关闸（缺省）：全新设备仍走既有建号流程（不是 517）", async () => {
    const deviceId = nextDeviceId()
    const accountsBefore = accountCount()

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 1)
    assert.equal(body.data.newAccount, 1)
    assert.equal(accountCount() - accountsBefore, 1)
    assert.ok(deviceBindingRow(deviceId), "既有新设备分支照旧写 device_bindings")
    assert.equal(gateLogLines().length, 0)
})

test("关闸（显式 0）：开着闸门拦过的同一个 pending 设备，关闸后照旧放行", async () => {
    const { deviceId } = await registerViaSpAuth()
    setGate("0")
    const body = decodeMsgpack(await signupRequest(deviceId))
    assert.equal(body.data_headers.result_code, 1)
    assert.equal(body.data.sp_binding, undefined)
})

// ---------------------------------------------------------------------------
// ② 开闸：拒绝路径（517 + sp_binding）
// ---------------------------------------------------------------------------

test("开闸：pending（已发码未绑定）→ 517 + data_headers.sp_binding + body 文案", async () => {
    setGate("1")
    const { deviceId, accountId } = await registerViaSpAuth()
    const accountsBefore = accountCount()

    const body = decodeMsgpack(await signupRequest(deviceId, {
        udid: "a1b2c3d4e5f6",
        "user-agent": "Dalvik/2.1.0 (Linux; U; Android 11; SM-G991B)",
    }))

    assert.equal(body.data_headers.result_code, 517)
    assert.deepEqual(body.data_headers.sp_binding, {
        ok: false,
        code: "BIND_REQUIRED",
        message: "该账号尚未完成 QQ/KOOK 绑定。",
    })
    // body 里的兜底文案（客户端拿不到头部时用）
    assert.equal(body.data.result_code, 517)
    assert.equal(body.data.code, "BIND_REQUIRED")
    assert.equal(body.data.message, "该账号尚未完成 QQ/KOOK 绑定。")
    assert.deepEqual(body.data.sp_binding, body.data_headers.sp_binding)
    // 拒绝路径绝不下发可登录凭据
    assert.equal(body.data.login_token, undefined)
    assert.equal(body.data_headers.viewer_id, 0)
    assert.equal(accountCount(), accountsBefore, "拒绝路径不得建号")
    assert.equal(accountRow(accountId).bind_state, "pending")

    // 审计 + 日志：服主能从日志里认出设备、原因与平台
    const audits = gateRejectAudits()
    assert.equal(audits.length, 1)
    assert.equal(audits[0].account_id, accountId)
    assert.equal(audits[0].actor, "bind-gate")
    const detail = JSON.parse(audits[0].detail)
    assert.equal(detail.event, "bind_gate_reject")
    assert.equal(detail.contract, "C3")
    assert.equal(detail.result_code, 517)
    assert.equal(detail.reason, "bind_state_pending")
    assert.equal(detail.client, "android")
    assert.equal(detail.device_id, deviceId)
    assert.equal(detail.udid, "a1b2c3d4e5f6")
    assert.equal(detail.bind_state, "pending")
    assert.equal(detail.source, "device_binding")
    assert.equal(detail.hint, null)

    const jsonLine = gateLogLines().find(line => line.includes("\"event\":\"bind_gate_reject\""))
    assert.ok(jsonLine, `缺少闸门日志：${JSON.stringify(gateLogLines())}`)
    assert.equal(JSON.parse(jsonLine.slice("[BIND-GATE] ".length)).result_code, 517)
})

test("开闸：设备完全没有映射（既无 device_bindings 也无 grant）→ 517", async () => {
    setGate("1")
    const deviceId = nextDeviceId()
    const accountsBefore = accountCount()

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 517)
    assert.equal(body.data.code, "BIND_REQUIRED")
    assert.equal(accountCount(), accountsBefore)
    assert.equal(JSON.parse(gateRejectAudits()[0].detail).reason, "device_unmapped")
})

test("开闸：grant 已过期且没有 device_bindings → 517（grant_expired）", async () => {
    const { deviceId } = await registerViaSpAuth()
    getDb().prepare("DELETE FROM device_bindings WHERE device_id = ?").run(deviceId)
    advance(31 * DAY_MS)
    setGate("1")

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 517)
    assert.equal(JSON.parse(gateRejectAudits()[0].detail).reason, "grant_expired")
})

test("开闸：bind_state='disabled' → 517 + ACCOUNT_DISABLED", async () => {
    setGate("1")
    const { deviceId, accountId } = await registerViaSpAuth()
    binding.setAccountBindStateSync(accountId, "disabled", "admin")

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 517)
    assert.deepEqual(body.data_headers.sp_binding, {
        ok: false,
        code: "ACCOUNT_DISABLED",
        message: "该账号已被停用，请联系管理员。",
    })
    assert.equal(JSON.parse(gateRejectAudits()[0].detail).reason, "bind_state_disabled")
    assert.equal(JSON.parse(gateRejectAudits()[0].detail).bind_state, "disabled")
})

test("开闸：device_id 非法（字符串 / 负数）→ fail-closed 517", async () => {
    setGate("1")
    for (const deviceId of ["not-a-number", -7, 1.5]) {
        consoleLines.length = 0
        const body = decodeMsgpack(await signupRequest(deviceId))
        assert.equal(body.data_headers.result_code, 517, `device_id=${deviceId} 必须被拦`)
        assert.equal(body.data.code, "BIND_REQUIRED")
        assert.equal(JSON.parse(gateRejectAudits().at(-1).detail).reason, "device_id_invalid")
    }
})

test("开闸：开关值非法（BIND_GATE_ENABLED=maybe）→ fail-closed，pending 设备被拦", async () => {
    setGate("maybe")
    const { deviceId } = await registerViaSpAuth()

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 517, "看不懂的开关值必须当作「开」")
    // 服主能从启动横幅/日志看出配置有问题
    bindGate.reportBindGateMode({ BIND_GATE_ENABLED: "maybe" })
    assert.ok(gateLogLines().some(line => line.includes("fail-closed")))
})

test("开闸 + iOS（dummy udid + AdobeAIR UA）：517 且日志一眼认出 iOS 玩家", async () => {
    setGate("1")
    const { deviceId } = await registerViaSpAuth()

    const body = decodeMsgpack(await signupRequest(deviceId, {
        udid: "10000001",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AdobeAIR",
    }))

    assert.equal(body.data_headers.result_code, 517)
    const jsonLine = gateLogLines().find(line => line.includes("\"event\":\"bind_gate_reject\""))
    const record = JSON.parse(jsonLine.slice("[BIND-GATE] ".length))
    assert.equal(record.client, "ios")
    assert.match(record.hint, /人工绑定/, "iOS 必须带 R3 人工绑定提示")
    assert.ok(
        gateLogLines().some(line => line.includes("iOS 玩家被拦")),
        `iOS 必须多打一行中文提示：${JSON.stringify(gateLogLines())}`,
    )
    assert.equal(JSON.parse(gateRejectAudits()[0].detail).client, "ios")
})

// ---------------------------------------------------------------------------
// ③ 开闸：放行路径（已绑定 active）
// ---------------------------------------------------------------------------

test("开闸：bind_state='active' → 正常放行，响应形状不变且回同一账号的 viewer_id", async () => {
    const { deviceId, accountId, data: registerData } = await registerViaSpAuth()
    bindPrimary(accountId)
    assert.equal(accountRow(accountId).bind_state, "active")
    setGate("1")

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 1)
    assert.equal("sp_binding" in body.data_headers, false, "放行不得带 sp_binding")
    assert.deepEqual(
        Object.keys(body.data_headers),
        ["force_update", "asset_update", "short_udid", "viewer_id", "servertime", "result_code"],
    )
    assert.equal(body.data.newAccount, 0, "已知设备分支必须复用既有账号")
    assert.equal(body.data.roleName, `Player${accountId}`)
    assert.equal(body.data_headers.viewer_id, registerData.viewer_id)
    assert.ok(sessionAccountForViewer(body.data_headers.viewer_id, accountId))
    // 放行不写审计、不打闸门日志
    assert.equal(gateRejectAudits().length, 0)
    assert.equal(gateLogLines().length, 0)
})

test("开闸：存量玩家（只有 device_bindings、没有 device_grants）active → 放行", async () => {
    const { deviceId, accountId } = await registerViaSpAuth()
    bindPrimary(accountId)
    getDb().prepare("DELETE FROM device_grants WHERE device_id = ?").run(deviceId)
    setGate("1")

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 1, "P2 之前的历史账号不得被闸门误伤")
    assert.equal(body.data.roleName, `Player${accountId}`)
})

test("开闸：只有未过期 grant、没有 device_bindings 的 active 设备 → 放行（source=grant）", async () => {
    const { deviceId, accountId } = await registerViaSpAuth()
    bindPrimary(accountId)
    getDb().prepare("DELETE FROM device_bindings WHERE device_id = ?").run(deviceId)
    setGate("1")

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 1)
    assert.equal(gateRejectAudits().length, 0)
})

test("开闸：BIND_GATE_EXEMPT_UDIDS 白名单放行（服主自测口子）", async () => {
    setGate("1")
    const { deviceId, accountId } = await registerViaSpAuth()
    setExempt(`${nextDeviceId()}, ${deviceId}`)

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 1, "白名单设备必须放行")
    assert.equal(body.data.roleName, `Player${accountId}`)
    assert.equal(gateRejectAudits().length, 0)
})

test("开闸：白名单 token 不匹配时仍然拦截（垃圾 token 不得变成万能钥匙）", async () => {
    setGate("1")
    setExempt("12345, ,,foo-bar")
    const { deviceId } = await registerViaSpAuth()

    const body = decodeMsgpack(await signupRequest(deviceId))

    assert.equal(body.data_headers.result_code, 517)
})

// ---------------------------------------------------------------------------
// ④ 闸门开着时 /sp-auth/* 的判定不受影响（P3 契约回归）
// ---------------------------------------------------------------------------

test("开闸：/sp-auth/register 的 RATE_LIMITED / DEVICE_TAKEN 路径不受闸门影响", async () => {
    setGate("1")
    const { deviceId, accountId } = await registerViaSpAuth()

    // 60 秒窗口内的第二次注册（pending + 未过期码）→ RATE_LIMITED
    const repeat = JSON.parse((await app.inject({
        method: "POST",
        url: "/sp-auth/register",
        payload: { username: nextUsername(), password: "Passw0rdA1", device_id: deviceId },
    })).payload)
    assert.equal(repeat.ok, false)
    assert.equal(repeat.code, "RATE_LIMITED")

    // 绑定后设备已被占用 → DEVICE_TAKEN（且不返回可登录凭据）
    bindPrimary(accountId)
    const taken = JSON.parse((await app.inject({
        method: "POST",
        url: "/sp-auth/register",
        payload: { username: nextUsername(), password: "Passw0rdA1", device_id: deviceId },
    })).payload)
    assert.equal(taken.ok, false)
    assert.equal(taken.code, "DEVICE_TAKEN")
    assert.equal(taken.data.username, accountRow(accountId).username)

    // 闸门只管 /tool/signup，/sp-auth/* 不写 gate_reject
    assert.equal(gateRejectAudits().length, 0)
})

// ---------------------------------------------------------------------------
// ⑤ 单元：纯函数与环境变量表
// ---------------------------------------------------------------------------

const ENABLED_CONFIG = { enabled: true, invalidValue: null, exemptTokens: [] }

function subjectLookup(bindState, source = "device_binding") {
    return () => ({
        subject: {
            accountId: 7,
            bindState,
            source,
            grantExpiresAt: source === "grant" ? new Date(BASE_NOW_MS + DAY_MS).toISOString() : null,
        },
        missing: null,
    })
}

test("单元：resolveBindGateConfig 取值表（缺省/空/0/off 关；1/on/yes 开；非法 = 开 + invalidValue）", () => {
    const cases = [
        [undefined, false, null],
        ["", false, null],
        ["   ", false, null],
        ["0", false, null],
        [" false ", false, null],
        ["OFF", false, null],
        ["no", false, null],
        ["1", true, null],
        ["true", true, null],
        ["on", true, null],
        ["YES", true, null],
        ["maybe", true, "maybe"],
        ["2", true, "2"],
    ]
    for (const [value, enabled, invalidValue] of cases) {
        const config = bindGate.resolveBindGateConfig(
            value === undefined ? {} : { BIND_GATE_ENABLED: value },
        )
        assert.equal(config.enabled, enabled, `BIND_GATE_ENABLED=${String(value)}`)
        assert.equal(config.invalidValue, invalidValue, `BIND_GATE_ENABLED=${String(value)}`)
    }
    assert.deepEqual(bindGate.resolveBindGateConfig({}).exemptTokens, [])
    assert.deepEqual(
        bindGate.resolveBindGateConfig({ BIND_GATE_EXEMPT_UDIDS: " a , b ,, a " }).exemptTokens,
        ["a", "b"],
    )
})

test("单元：关闸时 evaluateBindGate 在读任何表之前返回（查库函数根本不会被调用）", () => {
    const decision = bindGate.evaluateBindGate(
        { deviceId: "not-a-number", env: {} },
        { resolveSubject: () => { throw new Error("关闸时不得查库") } },
    )
    assert.equal(decision.allow, true)
    assert.equal(decision.reason, "gate_disabled")
    assert.equal(decision.resultCode, null)
    assert.equal(decision.code, null)
})

test("单元：注入 deps 的三态判定与 fail-closed 分支", () => {
    const allowed = bindGate.evaluateBindGate({ deviceId: 5, config: ENABLED_CONFIG }, { resolveSubject: subjectLookup("active") })
    assert.equal(allowed.allow, true)
    assert.equal(allowed.reason, "bind_state_active")

    const pending = bindGate.evaluateBindGate({ deviceId: 5, config: ENABLED_CONFIG }, { resolveSubject: subjectLookup("pending") })
    assert.equal(pending.allow, false)
    assert.equal(pending.reason, "bind_state_pending")
    assert.equal(pending.code, "BIND_REQUIRED")
    assert.equal(pending.resultCode, 517)

    const disabled = bindGate.evaluateBindGate({ deviceId: 5, config: ENABLED_CONFIG }, { resolveSubject: subjectLookup("disabled") })
    assert.equal(disabled.allow, false)
    assert.equal(disabled.code, "ACCOUNT_DISABLED")
    assert.equal(disabled.resultCode, 517)

    for (const missing of ["device_unmapped", "device_orphaned", "grant_expired"]) {
        const decision = bindGate.evaluateBindGate(
            { deviceId: 5, config: ENABLED_CONFIG },
            { resolveSubject: () => ({ subject: null, missing }) },
        )
        assert.equal(decision.allow, false, missing)
        assert.equal(decision.reason, missing)
        assert.equal(decision.code, "BIND_REQUIRED")
    }

    const invalid = bindGate.evaluateBindGate({ deviceId: "abc", config: ENABLED_CONFIG })
    assert.equal(invalid.allow, false)
    assert.equal(invalid.reason, "device_id_invalid")
})

test("单元：iOS / Android 判定（dummy udid、iOS; UA、AdobeAIR、CFNetwork、requestedby）", () => {
    assert.equal(bindGate.resolveBindGateClient({ udid: "10000001" }), "ios")
    assert.equal(bindGate.resolveBindGateClient({ udid: "10000001", userAgent: "Dalvik/2.1.0" }), "ios")
    assert.equal(bindGate.resolveBindGateClient({ userAgent: "Game/1.0 (iOS; 17.0)" }), "ios")
    assert.equal(bindGate.resolveBindGateClient({ userAgent: "MyApp/1.0 CFNetwork/1494.0.7 Darwin/23.0.0" }), "ios")
    assert.equal(bindGate.resolveBindGateClient({ requestedBy: "ios" }), "ios")
    assert.equal(bindGate.resolveBindGateClient({ requestedBy: "IOS" }), "ios")
    assert.equal(bindGate.resolveBindGateClient({ udid: "a1b2c3d4", userAgent: "Dalvik/2.1.0 (Linux; U; Android 11)" }), "android")
    assert.equal(bindGate.resolveBindGateClient({}), "android")
})

test("单元：buildBindGateRejection 形状固定（517 + sp_binding + data 兜底）", () => {
    const decision = bindGate.evaluateBindGate(
        { deviceId: 9, config: ENABLED_CONFIG },
        { resolveSubject: subjectLookup("pending") },
    )
    const payload = bindGate.buildBindGateRejection(decision)

    assert.equal(payload.data_headers.result_code, 517)
    assert.deepEqual(
        Object.keys(payload.data_headers),
        ["force_update", "asset_update", "short_udid", "viewer_id", "servertime", "result_code", "sp_binding"],
    )
    assert.equal(payload.data_headers.viewer_id, 0)
    assert.deepEqual(payload.data_headers.sp_binding, {
        ok: false,
        code: "BIND_REQUIRED",
        message: "该账号尚未完成 QQ/KOOK 绑定。",
    })
    assert.deepEqual(payload.data, {
        result_code: 517,
        code: "BIND_REQUIRED",
        message: "该账号尚未完成 QQ/KOOK 绑定。",
        sp_binding: { ok: false, code: "BIND_REQUIRED", message: "该账号尚未完成 QQ/KOOK 绑定。" },
    })
    assert.throws(() => bindGate.buildBindGateRejection({ ...decision, allow: true }), /rejection decision/)
})

test("单元：reportBindGateMode 三态各打一行（含非法值告警）", () => {
    bindGate.reportBindGateMode({})
    bindGate.reportBindGateMode({ BIND_GATE_ENABLED: "1" })
    bindGate.reportBindGateMode({ BIND_GATE_ENABLED: "maybe" })

    const lines = gateLogLines()
    assert.equal(lines.length, 3)
    assert.match(lines[0], /disabled/)
    assert.match(lines[0], /未绑定账号可直接进游戏/)
    assert.match(lines[1], /enabled/)
    assert.match(lines[2], /fail-closed/)
})
