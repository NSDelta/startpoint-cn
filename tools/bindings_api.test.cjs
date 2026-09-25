"use strict"

// Contract 3.5 (`/api/bindings/*`) — admin binding console routes.
//
// Runs against a throwaway DATA_DIR so the shared .database/ directory is
// never touched. The routes are exercised through fastify.inject() and every
// read goes back through `/api/bindings` itself; the only direct SQL below
// seeds accounts and viewer sessions, which have no admin HTTP surface here.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { Writable } = require("node:stream")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bindings-api-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const bindingRoutes = require("../src/routes/web_api/binding").default

const logLines = []
const logStream = new Writable({
    write(chunk, _encoding, done) {
        logLines.push(String(chunk))
        done()
    },
})

let app
let sequence = 0

function createAccount(extra = {}) {
    sequence += 1
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bindings-api-${sequence}-${Math.random().toString(36).slice(2)}`,
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

async function inject(method, url, payload) {
    const response = await app.inject(payload === undefined
        ? { method, url }
        : { method, url, payload })
    return {
        status: response.statusCode,
        body: response.payload === "" ? null : JSON.parse(response.payload),
    }
}

async function addBinding(payload) {
    return inject("POST", "/api/bindings", payload)
}

test.before(async () => {
    assert.equal(process.env.DATA_DIR, databaseDirectory)
    data.initializeDatabase()
    app = Fastify({ logger: { level: "error", stream: logStream } })
    app.register(bindingRoutes, { prefix: "/api/bindings" })
    await app.ready()
})

test.after(async () => {
    if (app !== undefined) await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("GET /api/bindings 返回分页外壳", async () => {
    const response = await inject("GET", "/api/bindings")
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { page: 1, pageSize: 20, totalCount: 0, rows: [] })
})

test("POST /api/bindings 首条绑定自动成为主绑定并回填账号信息", async () => {
    const account = createAccount({ username: "p5-first" })
    setViewerId(account.id, 900001)

    const response = await addBinding({
        accountId: account.id,
        platform: "qq",
        platformUid: "310000001",
        displayName: "服主",
        note: "手动补绑",
    })
    assert.equal(response.status, 201)
    assert.equal(response.body.accountId, account.id)
    assert.equal(response.body.username, "p5-first")
    assert.equal(response.body.viewerId, 900001)
    assert.equal(response.body.bindState, "active")
    assert.equal(response.body.platform, "qq")
    assert.equal(response.body.platformUid, "310000001")
    assert.equal(response.body.displayName, "服主")
    assert.equal(response.body.note, "手动补绑")
    assert.equal(response.body.isPrimary, true)
    assert.equal(response.body.createdBy, "admin")
    assert.equal(typeof response.body.createdAt, "string")
    assert.equal(typeof response.body.revision, "number")
})

test("POST /api/bindings 同一 QQ 追加账号时默认非主绑定（A7）", async () => {
    const primary = createAccount({ username: "p5-primary" })
    const extra = createAccount({ username: "p5-extra" })
    const uid = "310000010"

    const first = await addBinding({ accountId: primary.id, platform: "qq", platformUid: uid })
    assert.equal(first.status, 201)
    assert.equal(first.body.isPrimary, true)

    // A7: the platform identity stays primary for the first account, the second
    // account is attached as a non-primary binding.
    const second = await addBinding({ accountId: extra.id, platform: "qq", platformUid: uid })
    assert.equal(second.status, 201)
    assert.equal(second.body.accountId, extra.id)
    assert.equal(second.body.isPrimary, false)
    assert.equal(second.body.createdBy, "admin")

    const list = await inject("GET", `/api/bindings?query=${uid}`)
    assert.equal(list.body.totalCount, 2)
    const rows = new Map(list.body.rows.map(row => [row.accountId, row]))
    assert.equal(rows.get(primary.id).isPrimary, true)
    assert.equal(rows.get(extra.id).isPrimary, false)

    // The primary identity of the shared uid must not move.
    const primaryRow = getDb().prepare(
        "SELECT bind_state, bind_platform, bind_uid FROM accounts WHERE id = ?",
    ).get(primary.id)
    assert.equal(primaryRow.bind_state, "active")
    assert.equal(primaryRow.bind_platform, "qq")
    assert.equal(primaryRow.bind_uid, uid)

    // Asking for a second primary on the same uid is still refused (A6).
    const extraAccount = createAccount({ username: "p5-extra-2" })
    const forcedPrimary = await addBinding({
        accountId: extraAccount.id,
        platform: "qq",
        platformUid: uid,
        isPrimary: true,
    })
    assert.equal(forcedPrimary.status, 409)

    // Adding a second account is idempotent for the same triple.
    const repeated = await addBinding({ accountId: extra.id, platform: "qq", platformUid: uid })
    assert.equal(repeated.status, 201)
    assert.equal(repeated.body.id, second.body.id)
    assert.equal(repeated.body.isPrimary, false)
})

test("POST /api/bindings 强制第二个主绑定被拒且跨平台 uid 互不影响", async () => {
    const owner = createAccount({ username: "p5-owner" })
    const other = createAccount({ username: "p5-other" })
    const uid = "310000020"

    assert.equal((await addBinding({ accountId: owner.id, platform: "kook", platformUid: uid })).status, 201)

    // A6: one uid has exactly one primary; asking for a second one is refused.
    const conflict = await addBinding({
        accountId: other.id,
        platform: "kook",
        platformUid: uid,
        isPrimary: true,
    })
    assert.equal(conflict.status, 409)
    assert.equal(typeof conflict.body.error, "string")

    const list = await inject("GET", `/api/bindings?query=${uid}&platform=kook`)
    assert.equal(list.body.totalCount, 1)
    assert.equal(list.body.rows[0].accountId, owner.id)
    assert.equal(list.body.rows[0].isPrimary, true)

    // The same uid string on another platform is an unrelated identity.
    const crossPlatform = await addBinding({ accountId: other.id, platform: "qq", platformUid: uid })
    assert.equal(crossPlatform.status, 201)
    assert.equal(crossPlatform.body.platform, "qq")
    assert.equal(crossPlatform.body.isPrimary, true)
})

test("POST /api/bindings 参数非法与未知账号的响应", async () => {
    const account = createAccount()
    const invalidPlatform = await addBinding({ accountId: account.id, platform: "wechat", platformUid: "1" })
    assert.equal(invalidPlatform.status, 400)
    assert.equal(typeof invalidPlatform.body.error, "string")

    const missingUid = await addBinding({ accountId: account.id, platform: "qq" })
    assert.equal(missingUid.status, 400)

    const blankUid = await addBinding({ accountId: account.id, platform: "qq", platformUid: "   " })
    assert.equal(blankUid.status, 400)

    const badAccount = await addBinding({ accountId: 0, platform: "qq", platformUid: "1" })
    assert.equal(badAccount.status, 400)

    const unknownAccount = await addBinding({ accountId: 999999, platform: "qq", platformUid: "1" })
    assert.equal(unknownAccount.status, 404)
    assert.equal(typeof unknownAccount.body.error, "string")
})

test("GET /api/bindings 支持平台 / 状态 / 关键字过滤与分页", async () => {
    const account = createAccount({ username: "p5-filter" })
    const uid = "310000030"
    assert.equal((await addBinding({
        accountId: account.id,
        platform: "qq",
        platformUid: uid,
        displayName: "筛选目标",
    })).status, 201)

    const byPlatform = await inject("GET", "/api/bindings?platform=qq&query=p5-filter")
    assert.equal(byPlatform.status, 200)
    assert.equal(byPlatform.body.totalCount, 1)

    const wrongPlatform = await inject("GET", "/api/bindings?platform=kook&query=p5-filter")
    assert.equal(wrongPlatform.body.totalCount, 0)

    const byState = await inject("GET", "/api/bindings?state=active&query=p5-filter")
    assert.equal(byState.body.totalCount, 1)

    const pendingOnly = await inject("GET", "/api/bindings?state=pending&query=p5-filter")
    assert.equal(pendingOnly.body.totalCount, 0)

    const byDisplayName = await inject("GET", "/api/bindings?query=筛选目标")
    assert.equal(byDisplayName.body.totalCount, 1)

    const byUid = await inject("GET", `/api/bindings?query=${uid}`)
    assert.equal(byUid.body.totalCount, 1)

    const noMatch = await inject("GET", "/api/bindings?query=不存在的账号")
    assert.equal(noMatch.body.totalCount, 0)

    const paginated = await inject("GET", "/api/bindings?query=p5-filter&page=1&pageSize=1")
    assert.equal(paginated.body.page, 1)
    assert.equal(paginated.body.pageSize, 1)
    assert.equal(paginated.body.totalCount, 1)
    assert.equal(paginated.body.rows.length, 1)

    const secondPage = await inject("GET", "/api/bindings?query=p5-filter&page=2&pageSize=1")
    assert.equal(secondPage.body.rows.length, 0)

    const badState = await inject("GET", "/api/bindings?state=unknown")
    assert.equal(badState.status, 400)

    const badPage = await inject("GET", "/api/bindings?page=0")
    assert.equal(badPage.status, 400)

    const badPageSize = await inject("GET", "/api/bindings?pageSize=abc")
    assert.equal(badPageSize.status, 400)
})

test("POST /api/bindings/:id/primary 提升并回退旧主绑定", async () => {
    const account = createAccount({ username: "p5-promote" })
    const first = await addBinding({ accountId: account.id, platform: "qq", platformUid: "310000040" })
    assert.equal(first.body.isPrimary, true)
    const second = await addBinding({ accountId: account.id, platform: "qq", platformUid: "310000041" })
    assert.equal(second.body.isPrimary, false)

    const promoted = await inject("POST", `/api/bindings/${second.body.id}/primary`, {})
    assert.equal(promoted.status, 200)
    assert.equal(promoted.body.id, second.body.id)
    assert.equal(promoted.body.isPrimary, true)
    assert.equal(promoted.body.accountId, account.id)

    const list = await inject("GET", "/api/bindings?query=p5-promote")
    assert.equal(list.body.totalCount, 2)
    const rows = new Map(list.body.rows.map(row => [row.id, row]))
    assert.equal(rows.get(second.body.id).isPrimary, true)
    assert.equal(rows.get(first.body.id).isPrimary, false)

    const accountRow = getDb().prepare(
        "SELECT bind_state, bind_platform, bind_uid FROM accounts WHERE id = ?",
    ).get(account.id)
    assert.equal(accountRow.bind_state, "active")
    assert.equal(accountRow.bind_platform, "qq")
    assert.equal(accountRow.bind_uid, "310000041")

    const missing = await inject("POST", "/api/bindings/999999/primary", {})
    assert.equal(missing.status, 404)
    const malformed = await inject("POST", "/api/bindings/not-a-number/primary", {})
    assert.equal(malformed.status, 404)
})

test("DELETE /api/bindings/:id 解绑非主绑定后主绑定不变", async () => {
    const account = createAccount({ username: "p5-unbind-extra" })
    const primary = await addBinding({ accountId: account.id, platform: "kook", platformUid: "320000001" })
    const extra = await addBinding({ accountId: account.id, platform: "kook", platformUid: "320000002" })
    assert.equal(primary.body.isPrimary, true)
    assert.equal(extra.body.isPrimary, false)

    const removed = await inject("DELETE", `/api/bindings/${extra.body.id}`)
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.body, { ok: true })

    const list = await inject("GET", "/api/bindings?query=p5-unbind-extra")
    assert.equal(list.body.totalCount, 1)
    assert.equal(list.body.rows[0].id, primary.body.id)
    assert.equal(list.body.rows[0].isPrimary, true)

    const repeated = await inject("DELETE", `/api/bindings/${extra.body.id}`)
    assert.equal(repeated.status, 404)
    const malformed = await inject("DELETE", "/api/bindings/abc")
    assert.equal(malformed.status, 404)
})

test("DELETE /api/bindings/:id 解绑主绑定后账号回到待绑定", async () => {
    const account = createAccount({ username: "p5-unbind-primary" })
    const primary = await addBinding({ accountId: account.id, platform: "qq", platformUid: "310000050" })
    assert.equal(primary.body.isPrimary, true)

    const removed = await inject("DELETE", `/api/bindings/${primary.body.id}`)
    assert.equal(removed.status, 200)

    const list = await inject("GET", "/api/bindings?query=p5-unbind-primary")
    assert.equal(list.body.totalCount, 0)

    const accountRow = getDb().prepare(
        "SELECT bind_state, bind_platform, bind_uid FROM accounts WHERE id = ?",
    ).get(account.id)
    assert.equal(accountRow.bind_state, "pending")
    assert.equal(accountRow.bind_platform, null)
    assert.equal(accountRow.bind_uid, null)
})

test("GET /api/bindings/codes 列出绑定码并支持过滤", async () => {
    const account = createAccount({ username: "p5-codes" })
    const created = await inject("POST", "/api/bindings/codes", { accountId: account.id, platform: "qq" })
    assert.equal(created.status, 201)
    assert.equal(created.body.accountId, account.id)
    assert.equal(created.body.username, "p5-codes")
    assert.equal(created.body.status, "pending")
    assert.equal(created.body.platform, "qq")
    assert.equal(created.body.attempts, 0)
    assert.match(created.body.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/)

    const all = await inject("GET", "/api/bindings/codes")
    assert.equal(all.status, 200)
    assert.ok(all.body.totalCount >= 1)
    assert.ok(all.body.rows.some(row => row.id === created.body.id))

    const byAccount = await inject("GET", `/api/bindings/codes?accountId=${account.id}`)
    assert.equal(byAccount.body.totalCount, 1)
    assert.equal(byAccount.body.rows[0].code, created.body.code)

    const pending = await inject("GET", "/api/bindings/codes?status=pending")
    assert.ok(pending.body.rows.every(row => row.status === "pending"))

    const revoked = await inject("GET", "/api/bindings/codes?status=revoked")
    assert.ok(revoked.body.rows.every(row => row.status === "revoked"))

    const limited = await inject("GET", "/api/bindings/codes?limit=1")
    assert.equal(limited.body.rows.length, 1)

    const badStatus = await inject("GET", "/api/bindings/codes?status=nope")
    assert.equal(badStatus.status, 400)
    const badAccount = await inject("GET", "/api/bindings/codes?accountId=0")
    assert.equal(badAccount.status, 400)
})

test("POST /api/bindings/codes 补发码会顶掉同账号旧码", async () => {
    const account = createAccount({ username: "p5-reissue" })
    const first = await inject("POST", "/api/bindings/codes", { accountId: account.id })
    assert.equal(first.status, 201)
    assert.equal(first.body.platform, null)

    const second = await inject("POST", "/api/bindings/codes", { accountId: account.id, platform: "kook" })
    assert.equal(second.status, 201)
    assert.notEqual(second.body.code, first.body.code)

    const list = await inject("GET", `/api/bindings/codes?accountId=${account.id}`)
    assert.equal(list.body.totalCount, 2)
    const byStatus = new Map(list.body.rows.map(row => [row.code, row.status]))
    assert.equal(byStatus.get(second.body.code), "pending")
    assert.equal(byStatus.get(first.body.code), "revoked")
})

test("POST /api/bindings/codes 参数非法与未知账号的响应", async () => {
    const account = createAccount()
    assert.equal((await inject("POST", "/api/bindings/codes", { accountId: account.id, platform: "x" })).status, 400)
    assert.equal((await inject("POST", "/api/bindings/codes", { accountId: account.id, ttlMinutes: 0 })).status, 400)
    assert.equal((await inject("POST", "/api/bindings/codes", { accountId: account.id, ttlMinutes: 2000 })).status, 400)
    assert.equal((await inject("POST", "/api/bindings/codes", {})).status, 400)

    const unknown = await inject("POST", "/api/bindings/codes", { accountId: 999999 })
    assert.equal(unknown.status, 404)

    const ttl = await inject("POST", "/api/bindings/codes", { accountId: account.id, ttlMinutes: 5 })
    assert.equal(ttl.status, 201)
    const created = new Date(ttl.body.createdAt).getTime()
    const expires = new Date(ttl.body.expiresAt).getTime()
    assert.equal(Math.round((expires - created) / 60000), 5)
})

test("POST /api/bindings/codes/:id/revoke 吊销绑定码", async () => {
    const account = createAccount({ username: "p5-revoke" })
    const created = await inject("POST", "/api/bindings/codes", { accountId: account.id })

    const revoked = await inject("POST", `/api/bindings/codes/${created.body.id}/revoke`, {})
    assert.equal(revoked.status, 200)
    assert.deepEqual(revoked.body, { ok: true })

    const list = await inject("GET", `/api/bindings/codes?accountId=${account.id}`)
    assert.equal(list.body.rows[0].status, "revoked")

    const repeated = await inject("POST", `/api/bindings/codes/${created.body.id}/revoke`, {})
    assert.equal(repeated.status, 404)

    const missing = await inject("POST", "/api/bindings/codes/999999/revoke", {})
    assert.equal(missing.status, 404)

    const malformed = await inject("POST", "/api/bindings/codes/abc/revoke", {})
    assert.equal(malformed.status, 404)
})

test("已绑定的平台账号可以回填到新增绑定列表里", async () => {
    const account = createAccount({ username: "p5-bound-state" })
    const code = await inject("POST", "/api/bindings/codes", { accountId: account.id, platform: "qq" })
    const consumed = await inject("POST", "/api/bindings", {
        accountId: account.id,
        platform: "qq",
        platformUid: "310000060",
        displayName: "机器人绑定",
    })
    assert.equal(consumed.status, 201)
    assert.equal(consumed.body.isPrimary, true)

    const codes = await inject("GET", `/api/bindings/codes?accountId=${account.id}`)
    assert.equal(codes.body.rows.find(row => row.id === code.body.id).status, "pending")

    const list = await inject("GET", "/api/bindings?state=active&query=p5-bound-state")
    assert.equal(list.body.totalCount, 1)
    assert.equal(list.body.rows[0].platformUid, "310000060")
})
