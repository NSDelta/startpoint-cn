#!/usr/bin/env node
/**
 * 转移账号（take-over）链路的所有权闸门（2026-10-18 加固）回归测试。
 *
 * 加固前：`take_over_register/get_take_over_setting` 与 `…/register_take_over_data`
 * 只凭 `viewer_id` 就能调用 —— viewer_id 在私服里是公开可见的数字句柄，于是任何人都能
 * 把别人的账号锁到自己设备上（`takeover_udid`，此后真主人自己全被 516 拒），
 * 再走 `take_over/take_over_by_take_over_data` 把账号搬走。
 *
 * 加固后：这两个接口必须带上该账号的 `login_token`（客户端每次启动从 `tool/signup`
 * 拿到，见 `src/lib/game-auth.ts`），并按客户端 IP 限流。
 *
 * 跑法：node tools/takeover_hardening.test.cjs
 */

"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

// 必须在 require 生产模块之前把 DATA_DIR 指到临时库
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "takeover-harden-"))
process.env.DATA_DIR = dataDir
process.env.SP_LOG_LEVEL = "silent"

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { ensureViewerSession } = require("../src/lib/sp-auth/session-viewer")
const { LOGIN_TOKEN_HEADER, issueLoginTokenSync } = require("../src/lib/game-auth")
const { installCnBodyParsers } = require("../src/runtime/cn-body-parsers")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

const PREFIX = "/api/index.php"
const REGISTER_PATH = `${PREFIX}/take_over_register/register_take_over_data`
const SETTING_PATH = `${PREFIX}/take_over_register/get_take_over_setting`
const LOOKUP_PATH = `${PREFIX}/take_over/get_user_data_by_take_over_data`

const UDID = "0123456789abcdef"
const PASSWORD = "Abcd1234"

let accountSeq = 0

function createAccount() {
    accountSeq += 1
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `takeover-harden-${accountSeq}-${Date.now()}`,
        status: "normal",
    })
}

async function buildApp() {
    const app = Fastify({ logger: false })
    installCnBodyParsers(app)
    registerCnMsgpackOnSend(app)
    app.register(require("../src/routes/cn/takeOver").default, { prefix: PREFIX })
    await app.ready()
    return app
}

function parseBody(response) {
    const text = response.rawPayload.toString("utf8")
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("msgpack")) {
        return unpack(Buffer.from(text, "base64"))
    }
    return JSON.parse(text)
}

function resultCode(response) {
    return parseBody(response).data_headers.result_code
}

function takeoverRow(accountId) {
    return getDb().prepare(`
        SELECT takeover_password_hash, takeover_udid FROM accounts WHERE id = ?
    `).get(accountId)
}

// ------------------------------------------------------- 写接口：必须有所有权证明

test("register_take_over_data：不带登录令牌 → 3203，且一个字节都不写库", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    issueLoginTokenSync(account.id)

    const app = await buildApp()
    try {
        const response = await app.inject({
            method: "POST",
            url: REGISTER_PATH,
            payload: { viewer_id: viewerId, input_password: PASSWORD },
            headers: { udid: UDID },
        })
        assert.equal(response.statusCode, 200)
        assert.equal(resultCode(response), 3203)
        const row = takeoverRow(account.id)
        assert.equal(row.takeover_password_hash, null, "未认证不得改写转移密码")
        assert.equal(row.takeover_udid, null, "未认证不得把账号锁到调用者的设备上")
    } finally {
        await app.close()
    }
})

test("register_take_over_data：令牌不匹配（只知道 viewer_id 的攻击者）→ 3203 且不写库", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    issueLoginTokenSync(account.id)

    const app = await buildApp()
    try {
        const response = await app.inject({
            method: "POST",
            url: REGISTER_PATH,
            payload: { viewer_id: viewerId, input_password: PASSWORD },
            headers: { udid: UDID, [LOGIN_TOKEN_HEADER]: "deadbeef" },
        })
        assert.equal(resultCode(response), 3203)
        const row = takeoverRow(account.id)
        assert.equal(row.takeover_password_hash, null)
        assert.equal(row.takeover_udid, null)
    } finally {
        await app.close()
    }
})

test("register_take_over_data：令牌匹配 → 正常玩家照常登记（密码仍要过强度校验）", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    const token = issueLoginTokenSync(account.id)

    const app = await buildApp()
    try {
        const weak = await app.inject({
            method: "POST",
            url: REGISTER_PATH,
            payload: { viewer_id: viewerId, input_password: "short" },
            headers: { udid: UDID, [LOGIN_TOKEN_HEADER]: token },
        })
        assert.equal(resultCode(weak), 3204, "密码强度校验不能被闸门绕过")

        const ok = await app.inject({
            method: "POST",
            url: REGISTER_PATH,
            payload: { viewer_id: viewerId, input_password: PASSWORD },
            headers: { udid: UDID, [LOGIN_TOKEN_HEADER]: token },
        })
        assert.equal(resultCode(ok), 1)
        assert.equal(parseBody(ok).data.registered_viewer_id, Number(viewerId))

        const row = takeoverRow(account.id)
        assert.match(row.takeover_password_hash, /^\$2[aby]\$/, "bcrypt 哈希")
        assert.equal(row.takeover_udid, UDID)
    } finally {
        await app.close()
    }
})

// --------------------------------------------------- 读接口：不再泄漏账号设置状态

test("get_take_over_setting：没有令牌 → 3203（不再能探测别人是否设过转移密码）", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    const token = issueLoginTokenSync(account.id)

    const app = await buildApp()
    try {
        const anonymous = await app.inject({
            method: "POST",
            url: SETTING_PATH,
            payload: { viewer_id: viewerId },
        })
        assert.equal(resultCode(anonymous), 3203)
        assert.equal(parseBody(anonymous).data.exists_user_take_over_data, undefined)

        const owner = await app.inject({
            method: "POST",
            url: SETTING_PATH,
            payload: { viewer_id: viewerId },
            headers: { [LOGIN_TOKEN_HEADER]: token },
        })
        assert.equal(resultCode(owner), 1)
        assert.equal(parseBody(owner).data.exists_user_take_over_data, false)
    } finally {
        await app.close()
    }
})

// ---------------------------------------------------------------------- 限流

test("转移相关接口按客户端 IP 限流：刷过 30 次/分钟即被拒（3204）", async () => {
    const app = await buildApp()
    try {
        let limited = 0
        for (let attempt = 0; attempt < 70; attempt += 1) {
            const response = await app.inject({
                method: "POST",
                url: LOOKUP_PATH,
                payload: { viewer_id: "999999999", input_password: "Deadbeef1" },
            })
            if (resultCode(response) === 3204) limited += 1
        }
        assert.ok(limited > 0, "刷过阈值后必须出现限流响应")
        assert.ok(limited >= 30, `限流应挡住后续请求（实际 ${limited}/70）`)
    } finally {
        await app.close()
    }
})
