#!/usr/bin/env node
/**
 * 游戏 API 登录令牌硬化（`src/lib/game-auth.ts`）的回归测试。
 *
 * 覆盖：模式解析（缺省 enforce / 未知值也收敛到 enforce）、令牌签发与三态校验
 * （match / mismatch / missing / unset）、轮换后旧令牌失效、audit 只记录不拦、
 * enforce 拦下并回 result_code 516、signup 引导路径豁免、以及 viewer_id 没有
 * 对应账号时不掺和（交给路由自己回它该回的错）。
 *
 * 跑法：node tools/game_auth_token.test.cjs
 */

"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

// 必须在 require 生产模块之前把 DATA_DIR 指到临时库
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "game-auth-"))
process.env.DATA_DIR = dataDir
process.env.SP_LOG_LEVEL = "silent"

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { ensureViewerSession } = require("../src/lib/sp-auth/session-viewer")
const {
    GAME_AUTH_REJECT_RESULT_CODE,
    LOGIN_TOKEN_HEADER,
    installGameAuthGuard,
    issueLoginTokenSync,
    readLoginTokenHeader,
    resolveGameAuthMode,
    rotateLoginTokenSync,
    verifyLoginTokenSync,
} = require("../src/lib/game-auth")
const { installCnBodyParsers } = require("../src/runtime/cn-body-parsers")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

const GAME_START_PATH = "/api/index.php/single_battle_quest/start"
const SIGNUP_PATH = "/api/index.php/tool/signup"

let accountSeq = 0

function createAccount() {
    accountSeq += 1
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `game-auth-${accountSeq}-${Date.now()}`,
        status: "normal",
    })
}

/** 与真实入口同样的装法：生产实现 `installCnBodyParsers` + 生产 preHandler。 */
async function buildApp(mode) {
    const app = Fastify({ logger: false })
    installCnBodyParsers(app)
    // 与真实入口同样装 onSend：application/x-msgpack 的回复会被编码成 base64 msgpack
    registerCnMsgpackOnSend(app)
    installGameAuthGuard(app, { GAME_AUTH_MODE: mode })
    // 探针路由：不碰业务，只证明「请求有没有走到路由里」
    app.post(SIGNUP_PATH, async () => ({ probe: "signup" }))
    app.post(GAME_START_PATH, async () => ({ probe: "start" }))
    await app.ready()
    return app
}

function parseBody(response) {
    const text = response.rawPayload.toString("utf8")
    const contentType = String(response.headers["content-type"] ?? "")
    if (contentType.includes("msgpack")) {
        // 生产实现：onSend 把 data_headers 编成 base64 的 msgpack
        return unpack(Buffer.from(text, "base64"))
    }
    return JSON.parse(text)
}

function auditRejections() {
    return getDb().prepare(`SELECT COUNT(*) AS total FROM bind_audit WHERE action = 'gate_reject'`)
        .get().total
}

// ---------------------------------------------------------------- 模式解析

test("GAME_AUTH_MODE 缺省为 enforce —— 拼错的值也收敛到「拦」，不会静默降级", () => {
    assert.equal(resolveGameAuthMode({}), "enforce")
    assert.equal(resolveGameAuthMode({ GAME_AUTH_MODE: "" }), "enforce")
    assert.equal(resolveGameAuthMode({ GAME_AUTH_MODE: "audit" }), "audit")
    assert.equal(resolveGameAuthMode({ GAME_AUTH_MODE: "enforce" }), "enforce")
    assert.equal(resolveGameAuthMode({ GAME_AUTH_MODE: "off" }), "off")
    assert.equal(resolveGameAuthMode({ GAME_AUTH_MODE: "ENFORCE " }), "enforce")
    assert.equal(resolveGameAuthMode({ GAME_AUTH_MODE: "yes-please" }), "enforce")
})

test("令牌头只认客户端真发的那个名字（大小写与别名）", () => {
    assert.equal(readLoginTokenHeader({ login_token: "abc" }), "abc")
    assert.equal(readLoginTokenHeader({ LOGIN_TOKEN: "def" }), "def")
    assert.equal(readLoginTokenHeader({ "x-login-token": "ghi" }), "ghi")
    assert.equal(readLoginTokenHeader({ login_token: "" }), null)
    assert.equal(readLoginTokenHeader({}), null)
})

// ------------------------------------------------------------ 签发与校验

test("签发的令牌是 32 字节随机 hex，库里存的就是它（随机值，不是用户口令）", () => {
    const account = createAccount()
    const token = issueLoginTokenSync(account.id)

    assert.match(token, /^[0-9a-f]{64}$/, "32 bytes as hex")
    const stored = getDb().prepare(`SELECT login_token FROM accounts WHERE id = ?`)
        .get(account.id).login_token
    assert.equal(stored, token)

    assert.equal(verifyLoginTokenSync(account.id, token), "match")
    assert.equal(verifyLoginTokenSync(account.id, `${token.slice(0, 63)}0`), "mismatch")
    assert.equal(verifyLoginTokenSync(account.id, null), "missing")
})

test("没领过令牌的账号是 unset（上线即放行，等它下次 signup 补上）", () => {
    const account = createAccount()
    assert.equal(verifyLoginTokenSync(account.id, null), "unset")
    assert.equal(verifyLoginTokenSync(account.id, "whatever"), "unset")
})

test("只有显式轮换（rotateLoginTokenSync）才让旧令牌失效——签发本身不轮换", () => {
    const account = createAccount()
    const first = issueLoginTokenSync(account.id)
    assert.equal(issueLoginTokenSync(account.id), first, "重复签发必须拿回同一个令牌，否则启动期会自锁")

    const second = rotateLoginTokenSync(account.id)
    assert.notEqual(first, second)
    assert.equal(verifyLoginTokenSync(account.id, first), "mismatch")
    assert.equal(verifyLoginTokenSync(account.id, second), "match")
})

// ------------------------------------------------------------------ 守卫

test("audit：令牌不匹配只记录，请求照常进路由", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    issueLoginTokenSync(account.id)
    const before = auditRejections()

    const app = await buildApp("audit")
    try {
        const response = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: viewerId },
            headers: { [LOGIN_TOKEN_HEADER]: "deadbeef" },
        })
        assert.equal(response.statusCode, 200)
        assert.deepEqual(parseBody(response), { probe: "start" })
        assert.equal(auditRejections(), before + 1, "audit 模式要留下审计行")
    } finally {
        await app.close()
    }
})

test("enforce：令牌不匹配 → 200 + result_code 516，且不进路由", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    issueLoginTokenSync(account.id)

    const app = await buildApp("enforce")
    try {
        const rejected = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: viewerId },
            headers: { [LOGIN_TOKEN_HEADER]: "deadbeef" },
        })
        assert.equal(rejected.statusCode, 200)
        const body = parseBody(rejected)
        assert.equal(body.data_headers.result_code, GAME_AUTH_REJECT_RESULT_CODE)
        assert.equal(body.data_headers.result_code, 516)
        assert.equal(body.data.probe, undefined, "被拦的请求不得进路由")
    } finally {
        await app.close()
    }
})

test("enforce：带对令牌放行；缺令牌、别人账号的令牌都拦", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    const token = issueLoginTokenSync(account.id)

    const other = createAccount()
    const otherToken = issueLoginTokenSync(other.id)

    const app = await buildApp("enforce")
    try {
        const ok = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: viewerId },
            headers: { [LOGIN_TOKEN_HEADER]: token },
        })
        assert.deepEqual(parseBody(ok), { probe: "start" })

        const missing = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: viewerId },
        })
        assert.equal(parseBody(missing).data_headers.result_code, 516)

        const foreign = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: viewerId },
            headers: { [LOGIN_TOKEN_HEADER]: otherToken },
        })
        assert.equal(parseBody(foreign).data_headers.result_code, 516)
    } finally {
        await app.close()
    }
})

test("enforce：signup 引导路径豁免（令牌就是它发的）", async () => {
    const app = await buildApp("enforce")
    try {
        const response = await app.inject({
            method: "POST",
            url: SIGNUP_PATH,
            payload: { device_id: "device-bootstrap", viewer_id: 900000001 },
        })
        assert.equal(response.statusCode, 200)
        assert.deepEqual(parseBody(response), { probe: "signup" })
    } finally {
        await app.close()
    }
})

test("enforce：viewer_id 没有对应账号、请求体没有 viewer_id 都不掺和", async () => {
    const app = await buildApp("enforce")
    try {
        const unknownViewer = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: 987654321 },
            headers: { [LOGIN_TOKEN_HEADER]: "deadbeef" },
        })
        assert.deepEqual(parseBody(unknownViewer), { probe: "start" })

        const noViewer = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { device_id: "x" },
            headers: { [LOGIN_TOKEN_HEADER]: "deadbeef" },
        })
        assert.deepEqual(parseBody(noViewer), { probe: "start" })
    } finally {
        await app.close()
    }
})

test("off：完全不装守卫，连审计行都不写", async () => {
    const account = createAccount()
    const viewerId = await ensureViewerSession(account.id)
    issueLoginTokenSync(account.id)
    const before = auditRejections()

    const app = await buildApp("off")
    try {
        const response = await app.inject({
            method: "POST",
            url: GAME_START_PATH,
            payload: { viewer_id: viewerId },
            headers: { [LOGIN_TOKEN_HEADER]: "deadbeef" },
        })
        assert.deepEqual(parseBody(response), { probe: "start" })
        assert.equal(auditRejections(), before, "off 模式不该有任何副作用")
    } finally {
        await app.close()
    }
})
