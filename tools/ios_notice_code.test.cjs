"use strict"

// P10-C：iOS 公告通道的绑定验证码提供者（`src/lib/ios-notice-code.ts`）。
//
// 覆盖：未绑定账号首次请求拿到真码、**连续两次请求码不变**（反复打开公告不得换码）、
// 已绑定账号不发新码、查不到设备/账号回 null 且端点仍 200 + 兜底文案、
// 账号解析与绑定闸门同源（存量玩家只有 device_bindings 也认）、
// CC-1 60 秒窗口内不会因为公告请求换码。
//
// 全程跑在一次性 DATA_DIR 上，不碰共享 `.database/`。
//
// Run:  node --test tools/ios_notice_code.test.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { Writable } = require("node:stream")
const Fastify = require("fastify")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ios-notice-code-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

require("ts-node/register/transpile-only")

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { installBundledGameplaySnapshot } =
    require("./helpers/install-bundled-gameplay-snapshot.cjs")
const restoreContentSnapshot = installBundledGameplaySnapshot()

const binding = require("../src/data/domains/account-binding")
const iosNoticeCode = require("../src/lib/ios-notice-code")
const iosLeitingRoutes = require("../src/routes/cn/ios-leiting").default
const spAuthRoutes = require("../src/routes/sp-auth/index.ts").default

// SDK 登录 mock 的身份派生材料由 env 提供（照 tools/ios_leiting_route.test.cjs 的样板）。
process.env.IOS_SDK_BEAN_KEY = "#LeitingAESKey#!"
process.env.IOS_SDK_BEAN_IV = "LeitingAESIVKEY!"
process.env.IOS_SDK_IDENTITY_SECRET = "ios-notice-code-test-secret"

// ---------------------------------------------------------------------------
// 冻结时钟：CC-1 的 60 秒窗口与 30 分钟 TTL 必须可确定地推进
// ---------------------------------------------------------------------------

const BASE_NOW_MS = Date.UTC(2026, 8, 24, 0, 0, 0)
let nowOffsetMs = 0
const realDateNow = Date.now
Date.now = () => BASE_NOW_MS + nowOffsetMs

const MINUTE_MS = 60_000
const SECOND_MS = 1_000

function advance(ms) {
    nowOffsetMs += ms
}

function resetClock() {
    nowOffsetMs = 0
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const logLines = []
const logStream = new Writable({
    write(chunk, _encoding, callback) {
        logLines.push(chunk.toString())
        callback()
    },
})

let app
let deviceSequence = 0
function nextDeviceId() {
    deviceSequence += 1
    return 8_300_000 + deviceSequence
}

let usernameSequence = 0
function nextUsername() {
    usernameSequence += 1
    return `iosc${String(usernameSequence).padStart(4, "0")}`
}

let platformUidSequence = 0
function nextPlatformUid() {
    platformUidSequence += 1
    return String(540_000_000 + platformUidSequence)
}

const NOTICE_URL = "/sdk_v3/get_notice.do"
function hasCodeShapedToken(text) {
    return text.split(/[^0-9A-Z]+/).some((token) => /^[0-9A-Z]{6}$/.test(token))
}

/** 兜底文案的特征片段（`buildIosNoticeContent(null)`，见 src/routes/cn/ios-leiting.ts:525）。 */
const FALLBACK_MARKER = "请先在 QQ 群里向 bot 发送 /bind"

function noticeResponse(uid, deviceId) {
    const payload = {}
    if (uid !== undefined) payload.uid = uid
    if (deviceId !== undefined) payload.deviceId = deviceId
    return app.inject({ method: "POST", url: NOTICE_URL, payload })
}

/**
 * 走 P3 的 /sp-auth/register 建 pending 账号（= 闸门认可的「已发码未绑定」状态），
 * 然后按设备号问公告端点要码。这是 iOS 玩家的真实路径。
 */
async function registerDevice() {
    const deviceId = nextDeviceId()
    const name = nextUsername()
    const response = await app.inject({
        method: "POST",
        url: "/sp-auth/register",
        payload: { username: name, password: "Passw0rdA1", device_id: deviceId, version: "1.8.1" },
    })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.payload)
    assert.equal(body.ok, true, `register 失败：${response.payload}`)
    const grant = getDb().prepare(
        "SELECT device_id, account_id FROM device_grants WHERE device_id = ?",
    ).get(deviceId)
    assert.ok(grant, "register 必须写 device_grants")
    return { deviceId, accountId: grant.account_id, username: name, registerData: body.data }
}

/** 抽出公告响应里的话术字段（霰弹：同一段话术出现在所有候选键上）。 */
function noticeText(response) {
    assert.equal(response.statusCode, 200, `公告端点必须永远 200，实际 ${response.statusCode}`)
    return response.json().NOTICECONTENT
}

function activeCodeRow(accountId) {
    return getDb().prepare(`
        SELECT id, code, status, platform, platform_uid
        FROM signup_codes
        WHERE account_id = ? AND status = 'pending'
        ORDER BY id DESC
        LIMIT 1
    `).get(accountId)
}

function allCodeRows(accountId) {
    return getDb().prepare(
        "SELECT id, code, status FROM signup_codes WHERE account_id = ? ORDER BY id",
    ).all(accountId)
}

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
    // 关键：注册处像生产 cn-server.ts 一样注入 provideCode（而不是靠测试里手写一个假的）。
    await app.register(iosLeitingRoutes, {
        notice: { provideCode: iosNoticeCode.createIosNoticeCodeProvider({ log: () => {} }) },
    })
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
// ① 未绑定账号 ⇒ 返回真码，且与数据层里那条 pending 码一致
// ---------------------------------------------------------------------------

test("未绑定的 iOS 玩家打开公告看到的是 6 位真码（与数据层 pending 码一致）", async () => {
    const { deviceId, accountId } = await registerDevice()

    const text = noticeText(await noticeResponse(String(accountId), String(deviceId)))
    const row = activeCodeRow(accountId)
    assert.ok(row, "register 之后必须有一条 pending 码")
    assert.match(row.code, /^[0-9A-Z]{6}$/, "验证码必须是 6 位（大写字母数字，已去混淆字符 0/O/1/I）")
    assert.ok(text.includes(row.code), `公告话术必须含真码 ${row.code}：${text}`)
    assert.ok(!text.includes(FALLBACK_MARKER), "拿到真码时不该出现兜底文案")
})

// ---------------------------------------------------------------------------
// ② 同一账号连续两次请求 ⇒ 码不变（反复打开公告不得换码）
// ---------------------------------------------------------------------------

test("反复打开公告不换码：连续三次请求拿到同一个码，且库里只有一条 pending 码", async () => {
    const { deviceId, accountId } = await registerDevice()
    const uid = String(accountId)
    const id = String(deviceId)

    const first = noticeText(await noticeResponse(uid, id))
    const second = noticeText(await noticeResponse(uid, id))
    const third = noticeText(await noticeResponse(uid, id))

    assert.equal(first, second, "第二次请求必须看到与第一次逐字相同的话术")
    assert.equal(first, third, "第三次请求同样不得换码")

    const row = activeCodeRow(accountId)
    assert.ok(first.includes(row.code))
    assert.equal(allCodeRows(accountId).length, 1, "反复请求不得产生第二条码")
})

test("60 秒窗口内既不换码也不报错（CC-1 不适用于公告读取）", async () => {
    const { deviceId, accountId } = await registerDevice()
    const before = activeCodeRow(accountId).code

    advance(10 * SECOND_MS)
    const text = noticeText(await noticeResponse(String(accountId), String(deviceId)))

    assert.ok(text.includes(before), "窗口内的公告请求必须复用同一个码")
    assert.equal(allCodeRows(accountId).length, 1)
})

test("活码过期后公告请求补发新码（而不是永远回兜底话术）", async () => {
    const { deviceId, accountId } = await registerDevice()
    const expired = activeCodeRow(accountId).code

    // 默认 TTL 30 分钟；推 31 分钟把码推过期。
    advance(31 * MINUTE_MS)

    const text = noticeText(await noticeResponse(String(accountId), String(deviceId)))
    const rows = allCodeRows(accountId)
    assert.equal(rows.length, 2, "过期后必须补发一条新码")
    const fresh = rows[rows.length - 1].code
    assert.match(fresh, /^[0-9A-Z]{6}$/)
    assert.notEqual(fresh, expired)
    assert.ok(text.includes(fresh), `补发的码必须显示出来：${text}`)
})

// ---------------------------------------------------------------------------
// ③ 已绑定账号 ⇒ 不返回新码
// ---------------------------------------------------------------------------

test("已绑定账号不返回新码：回兜底文案，且库里不再新增 pending 码", async () => {
    const { deviceId, accountId } = await registerDevice()
    // 玩家在游戏里看到码、发给 bot 绑定（bot 走 consumeSignupCodeSync 的等价领域调用）。
    bindPrimary(accountId)
    const codesAfterBind = allCodeRows(accountId).length

    const text = noticeText(await noticeResponse(String(accountId), String(deviceId)))

    assert.ok(!hasCodeShapedToken(text), `已绑定玩家不该再看到 6 位码：${text}`)
    assert.ok(text.includes(FALLBACK_MARKER), "已绑定场景走兜底文案")
    // 关键断言：已绑定玩家不得被**发新码**（码总数不变、记录不被替换）。
    assert.equal(allCodeRows(accountId).length, codesAfterBind, "已绑定不得再发新码")
    const stillPending = activeCodeRow(accountId)
    if (stillPending !== undefined) {
        // 注册时发的那条码可能还挂在 pending 上（绑定路径不影响 signup_codes）；
        // 它必须没被公告请求碰过，且其码值不出现在公告里。
        assert.ok(!text.includes(stillPending.code), "已绑定玩家的旧码绝不能被展示出来")
    }
})

test("已绑定但 bind_state 被人工退回 pending 时仍不发新码（平台绑定行还在）", async () => {
    const { deviceId, accountId } = await registerDevice()
    bindPrimary(accountId)
    // 人工把 bind_state 退回 pending（setAccountBindStateSync 是既有人工出口）。
    binding.setAccountBindStateSync(accountId, "pending", "admin")
    const codesBefore = allCodeRows(accountId).length

    const resolution = iosNoticeCode.resolveIosNoticeCode({
        deviceId: String(deviceId),
    })
    assert.equal(resolution.outcome, "already_bound")
    assert.equal(resolution.code, null)
    assert.equal(allCodeRows(accountId).length, codesBefore, "不得因为管理动作而多发一条码")
})

// ---------------------------------------------------------------------------
// ④ 查不到设备/账号 ⇒ null ⇒ 端点 200 + 兜底文案
// ---------------------------------------------------------------------------

test("查不到设备：公告端点仍然 200 + 兜底文案，不 5xx", async () => {
    for (const payload of [
        ["999999999", "8399999"],   // uid 存在、设备号无映射
        ["999999998", undefined],   // 只有 uid
        [undefined, undefined],     // 什么都没有
        [undefined, "not-a-number"],// 设备号不是数字
    ]) {
        const response = await noticeResponse(payload[0], payload[1])
        const text = noticeText(response)
        assert.equal(response.json().code, 0)
        assert.ok(text.includes(FALLBACK_MARKER), `期望兜底文案，实际：${text}`)
    }
})

test("device_grants 过期：与闸门一致地按「查不到」处理", async () => {
    const { deviceId, accountId } = await registerDevice()
    // 推过 30 天 grant 有效期（闸门 resolveBindGateSubject 的 grant 分支判 expires_at）。
    advance(31 * 24 * 60 * MINUTE_MS)

    // 先把 device_bindings 那条删掉，逼解析走 grant 分支 —— 这正是闸门会判过期的路径。
    getDb().prepare("DELETE FROM device_bindings WHERE device_id = ?").run(deviceId)

    const resolution = iosNoticeCode.resolveIosNoticeCode({ deviceId: String(deviceId) })
    assert.equal(resolution.code, null)
    assert.equal(resolution.outcome, "unbound_device")

    const text = noticeText(await noticeResponse(String(accountId), String(deviceId)))
    assert.ok(text.includes(FALLBACK_MARKER))
})

test("账号解析与绑定闸门同源：只有 device_bindings 的存量玩家也能拿到码", async () => {
    // 存量玩家：P2 之前没有 device_grants，只有 device_bindings（闸门为此专门退让过）。
    const deviceId = nextDeviceId()
    const bindingDomain = require("../src/data/domains/account-binding")
    const accountDomain = require("../src/data/domains/account")
    const sessionDomain = require("../src/data/domains/session")
    const created = accountDomain.insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "legacy", idpId: `legacy:${deviceId}`, status: "normal",
    })
    bindingDomain.setAccountBindStateSync(created.id, "pending", "test")
    // 注意：device_bindings 的写入在 session 域（bind-gate.ts:18 也是从那里取 getDeviceBindingSync）。
    sessionDomain.insertDeviceBindingSync(deviceId, created.id)
    require("../src/lib/signup-code").issueSignupCode(created.id)

    const resolution = iosNoticeCode.resolveIosNoticeCode({ deviceId: String(deviceId) })
    assert.equal(resolution.accountId, created.id, "必须认得出只有 device_bindings 的存量玩家")
    assert.equal(resolution.outcome, "code")
    assert.match(resolution.code, /^[0-9A-Z]{6}$/)
})

// ---------------------------------------------------------------------------
// ⑤ provider 语义：绝不抛错（端点仍 200 + 兜底文案）
// ---------------------------------------------------------------------------

test("provider 从不为「查不到人」抛错，返回值恒为 string | null", async () => {
    const provider = iosNoticeCode.createIosNoticeCodeProvider({ log: () => {} })
    for (const ids of [
        {},
        { deviceId: "nope" },
        { uid: "1", deviceId: "0" },
        { uid: "1", deviceId: "-5" },
        { uid: "1", deviceId: "99999999999" },
        { deviceId: "8399999" },
    ]) {
        const value = await provider(ids)
        assert.ok(value === null || typeof value === "string", `非法返回值：${String(value)}`)
        if (value !== null) assert.match(value, /^[0-9A-Z]{6}$/, "非 null 时必须是一个真验证码")
    }
})

test("内部异常被收成 null（回兜底）而不是把请求打挂", async () => {
    // 用一个必然抛错的假 provider 验证处理器那道网仍然在（回归，防止有人把 try/catch 删掉）。
    const boom = Fastify({ logger: false })
    await boom.register(iosLeitingRoutes, {
        notice: {
            provideCode: () => {
                throw new Error("code store offline")
            },
        },
    })
    await boom.ready()
    const response = await boom.inject({ method: "POST", url: NOTICE_URL, payload: {} })
    assert.equal(response.statusCode, 200)
    assert.ok(response.json().NOTICECONTENT.includes(FALLBACK_MARKER))
    await boom.close()
})
