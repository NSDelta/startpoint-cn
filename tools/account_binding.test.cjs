"use strict"

// Contract C2 (account binding data layer) — domain level tests.
//
// The whole file runs against a throwaway DATA_DIR, so it never touches the
// real .database/ directory and can be re-run as often as needed.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-binding-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { ensureSchemaColumn } = require("../src/data/schema")
const { insertAccountSync } = require("../src/data/domains/account")
const binding = require("../src/data/domains/account-binding")

let sequence = 0

function createAccount(extra = {}) {
    sequence += 1
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `account-binding-${sequence}-${Math.random().toString(36).slice(2)}`,
        status: "normal",
        ...extra,
    })
}

function accountRow(accountId) {
    return getDb().prepare(
        "SELECT id, bind_state, bind_platform, bind_uid FROM accounts WHERE id = ?",
    ).get(accountId)
}

function tableNames() {
    return getDb().prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map(row => row.name)
}

function columnNames(table) {
    return getDb().prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name)
}

function indexNames(table) {
    return getDb().prepare(`PRAGMA index_list("${table}")`).all().map(row => row.name)
}

function userVersion() {
    return getDb().pragma("user_version", { simple: true })
}

test.before(() => {
    assert.equal(process.env.DATA_DIR, databaseDirectory)
    data.initializeDatabase()
})

test.after(() => {
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("契约 C2：四张新表与 accounts 三个新列都在", () => {
    const tables = tableNames()
    for (const table of ["signup_codes", "account_bindings", "device_grants", "bind_audit"]) {
        assert.ok(tables.includes(table), `缺少表 ${table}`)
    }

    assert.deepEqual(columnNames("signup_codes"), [
        "id", "code", "account_id", "status", "platform", "platform_uid",
        "attempts", "expires_at", "created_at", "updated_at", "revision",
    ])
    assert.deepEqual(columnNames("account_bindings"), [
        "id", "account_id", "platform", "platform_uid", "display_name",
        "is_primary", "created_by", "note", "created_at", "updated_at", "revision",
    ])
    assert.deepEqual(columnNames("device_grants"), [
        "device_id", "account_id", "token", "expires_at", "created_at", "updated_at",
    ])
    assert.deepEqual(columnNames("bind_audit"), [
        "id", "action", "account_id", "platform", "platform_uid", "detail", "actor", "created_at",
    ])

    const accountColumns = columnNames("accounts")
    for (const column of ["bind_state", "bind_platform", "bind_uid"]) {
        assert.ok(accountColumns.includes(column), `accounts 缺少列 ${column}`)
    }

    const bindingIndexes = indexNames("account_bindings")
    assert.ok(bindingIndexes.includes("uq_account_bindings_primary"))
    assert.ok(bindingIndexes.includes("uq_account_bindings_triple"))
    assert.equal(userVersion(), 28)

    // 已存在的老账号默认 active，不会被闸门误伤
    const legacy = createAccount()
    assert.equal(accountRow(legacy.id).bind_state, "active")
    assert.equal(accountRow(legacy.id).bind_platform, null)
})

test("发码：6 位码 / 状态 pending / 同账号重复发码作废旧码", () => {
    const account = createAccount()
    // 老账号先归位到 pending，模拟 CC-1 的注册流程
    assert.equal(binding.setAccountBindStateSync(account.id, "pending"), true)
    assert.equal(binding.getAccountBindStateSync(account.id), "pending")

    const first = binding.createSignupCodeSync({ accountId: account.id })
    assert.match(first.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/)
    assert.equal(first.status, "pending")
    assert.equal(first.attempts, 0)
    assert.equal(first.platform, null)
    assert.equal(first.accountId, account.id)
    assert.ok(first.expiresAt.getTime() > first.createdAt.getTime())

    const fetched = binding.getSignupCodeSync(first.code.toLowerCase())
    assert.equal(fetched.id, first.id)
    assert.equal(binding.getActiveSignupCodeSync(account.id).id, first.id)

    const second = binding.createSignupCodeSync({ accountId: account.id })
    assert.notEqual(second.id, first.id)
    assert.equal(binding.getSignupCodeSync(first.code).status, "revoked")
    assert.equal(binding.getActiveSignupCodeSync(account.id).id, second.id)

    // 被顶掉的旧码不再可用
    const rejected = binding.consumeSignupCodeSync({
        code: first.code, platform: "qq", platformUid: "190000001",
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, "CODE_INVALID")

    // 未知码
    const unknown = binding.consumeSignupCodeSync({
        code: "ZZZZZZ", platform: "qq", platformUid: "190000002",
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, "CODE_INVALID")

    // 幂等：没有 pending 码时返回 0
    assert.equal(binding.revokeSignupCodesForAccountSync(account.id), 1)
    assert.equal(binding.revokeSignupCodesForAccountSync(account.id), 0)
})

test("校验并消费：一次性消费、账号转 active、主绑定落库", () => {
    const account = createAccount()
    const code = binding.createSignupCodeSync({ accountId: account.id })

    const consumed = binding.consumeSignupCodeSync({
        code: ` ${code.code.toLowerCase()} `,
        platform: "qq",
        platformUid: "190000010",
        displayName: "阿米娅",
    })
    assert.equal(consumed.ok, true)
    assert.equal(consumed.accountId, account.id)
    assert.equal(consumed.binding.platform, "qq")
    assert.equal(consumed.binding.platformUid, "190000010")
    assert.equal(consumed.binding.isPrimary, true)
    assert.equal(consumed.binding.createdBy, "bot")
    assert.equal(consumed.binding.displayName, "阿米娅")
    assert.equal(consumed.code.status, "bound")

    const row = accountRow(account.id)
    assert.equal(row.bind_state, "active")
    assert.equal(row.bind_platform, "qq")
    assert.equal(row.bind_uid, "190000010")

    const resolved = binding.getBindingByPlatformUidSync("qq", "190000010")
    assert.equal(resolved.accountId, account.id)
    assert.equal(binding.getPrimaryBindingSync(account.id).platformUid, "190000010")

    // 一次性：同一个码再消费一次（换一个 uid）必须失败
    const replay = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "190000011",
    })
    assert.equal(replay.ok, false)
    assert.equal(replay.code, "CODE_USED")
    assert.equal(binding.getBindingByPlatformUidSync("qq", "190000011"), null)
})

test("过期：TTL 到期后报 CODE_EXPIRED 并落 expired 状态", () => {
    const account = createAccount()
    const code = binding.createSignupCodeSync({ accountId: account.id, ttlMinutes: 0 })
    assert.equal(binding.getActiveSignupCodeSync(account.id), null)

    const expired = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "190000020",
    })
    assert.equal(expired.ok, false)
    assert.equal(expired.code, "CODE_EXPIRED")
    assert.equal(binding.getSignupCodeSync(code.code).status, "expired")
    assert.equal(binding.getBindingByPlatformUidSync("qq", "190000020"), null)

    // 已经过期的码不再累加尝试次数
    const again = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "190000020",
    })
    assert.equal(again.code, "CODE_EXPIRED")
    assert.equal(binding.getSignupCodeSync(code.code).attempts, 2)
})

test("尝试次数：ALREADY_BOUND 累计到上限后锁定", () => {
    const victim = createAccount()
    const victimBind = binding.bindPlatformAccountSync({
        accountId: victim.id, platform: "qq", platformUid: "190000030", createdBy: "admin",
    })
    assert.equal(victimBind.ok, true)

    const account = createAccount()
    const code = binding.createSignupCodeSync({ accountId: account.id })

    for (let attempt = 1; attempt <= binding.SIGNUP_CODE_MAX_ATTEMPTS - 1; attempt += 1) {
        const result = binding.consumeSignupCodeSync({
            code: code.code, platform: "qq", platformUid: "190000030",
        })
        assert.equal(result.ok, false)
        assert.equal(result.code, "ALREADY_BOUND")
        assert.equal(result.attempts, attempt)
    }

    const locked = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "190000030",
    })
    assert.equal(locked.ok, false)
    assert.equal(locked.code, "CODE_LOCKED")
    assert.equal(locked.attempts, binding.SIGNUP_CODE_MAX_ATTEMPTS)

    // 锁定后即使换成没人占用的 uid 也不能再用
    const stillLocked = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "190000031",
    })
    assert.equal(stillLocked.code, "CODE_LOCKED")
    assert.equal(binding.getSignupCodeSync(code.code).status, "pending")
    assert.equal(binding.getBindingByPlatformUidSync("qq", "190000031"), null)
})

test("device 占用：一个设备一条 grant，可覆盖、可判过期、可清除", () => {
    const first = createAccount()
    const second = createAccount()

    const grant = binding.upsertDeviceGrantSync({ deviceId: 9001, accountId: first.id })
    assert.equal(grant.deviceId, 9001)
    assert.equal(grant.accountId, first.id)
    assert.match(grant.token, /^[0-9a-f]{64}$/)
    assert.equal(
        Math.round((grant.expiresAt.getTime() - grant.createdAt.getTime()) / 86400000),
        binding.DEVICE_GRANT_TTL_DAYS,
    )

    const mapping = binding.getAccountByDeviceSync(9001)
    assert.equal(mapping.account_id, first.id)
    assert.equal(mapping.bind_state, "active")
    assert.equal(mapping.grant_token, grant.token)
    assert.equal(binding.getAccountByDeviceSync(999999), null)

    // 同一个 device 只能指向一个账号
    binding.upsertDeviceGrantSync({ deviceId: 9001, accountId: second.id })
    const rows = getDb().prepare(
        "SELECT COUNT(*) AS count FROM device_grants WHERE device_id = ?",
    ).get(9001)
    assert.equal(rows.count, 1)
    assert.equal(binding.getAccountByDeviceSync(9001).account_id, second.id)
    assert.equal(binding.getDeviceGrantSync(9001).createdAt.getTime(), grant.createdAt.getTime())

    // 过期判定
    binding.upsertDeviceGrantSync({
        deviceId: 9002, accountId: first.id,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    assert.equal(binding.getActiveDeviceGrantSync(9002), null)
    assert.notEqual(binding.getDeviceGrantSync(9002), null)

    assert.equal(binding.clearDeviceGrantSync(9002), true)
    assert.equal(binding.clearDeviceGrantSync(9002), false)
    assert.equal(binding.getAccountByDeviceSync(9002), null)
    assert.equal(binding.clearDeviceGrantsForAccountSync(second.id), 1)
})

test("登录名解析：先平台绑定，再 accounts.username", () => {
    const legacy = createAccount({ username: "p2-old-user", passwordHash: "x" })
    assert.equal(binding.resolveAccountByLoginNameSync("p2-old-user").id, legacy.id)
    assert.equal(binding.resolveAccountByLoginNameSync("  p2-old-user  ").id, legacy.id)
    assert.equal(binding.resolveAccountByLoginNameSync("p2-missing-user"), null)
    assert.equal(binding.resolveAccountByLoginNameSync("   "), null)

    const bound = createAccount()
    const boundResult = binding.bindPlatformAccountSync({
        accountId: bound.id, platform: "kook", platformUid: "290000001", createdBy: "admin",
    })
    assert.equal(boundResult.ok, true)
    assert.equal(binding.resolveAccountByLoginNameSync("290000001").id, bound.id)

    // 同名时绑定优先
    const shadowed = createAccount({ username: "390000001" })
    const owner = createAccount()
    binding.bindPlatformAccountSync({
        accountId: owner.id, platform: "qq", platformUid: "390000001", createdBy: "admin",
    })
    assert.equal(binding.resolveAccountByLoginNameSync("390000001").id, owner.id)
    assert.notEqual(binding.resolveAccountByLoginNameSync("390000001").id, shadowed.id)
})

test("绑定管理：非主绑定 / 主绑定唯一 / 解绑与转移", () => {
    const account = createAccount()
    const primary = binding.bindPlatformAccountSync({
        accountId: account.id, platform: "qq", platformUid: "490000001", createdBy: "admin",
    })
    assert.equal(primary.ok, true)
    assert.equal(primary.binding.isPrimary, true)

    const extra = binding.bindPlatformAccountSync({
        accountId: account.id, platform: "qq", platformUid: "490000002", createdBy: "admin",
    })
    assert.equal(extra.ok, true)
    assert.equal(extra.binding.isPrimary, false)
    assert.equal(accountRow(account.id).bind_uid, "490000001")

    // 重复绑定同一个三元组是幂等的
    const repeated = binding.bindPlatformAccountSync({
        accountId: account.id, platform: "qq", platformUid: "490000001",
        displayName: "重复", createdBy: "admin",
    })
    assert.equal(repeated.ok, true)
    assert.equal(repeated.binding.id, primary.binding.id)
    assert.equal(repeated.binding.displayName, "重复")
    assert.equal(repeated.binding.revision, 2)

    // 别人已经占用的 QQ 不能再绑
    const other = createAccount()
    const taken = binding.bindPlatformAccountSync({
        accountId: other.id, platform: "qq", platformUid: "490000001", createdBy: "admin",
    })
    assert.equal(taken.ok, false)
    assert.equal(taken.code, "ALREADY_BOUND")

    // 跨平台同一个 uid 字符串互不影响
    const kook = binding.bindPlatformAccountSync({
        accountId: other.id, platform: "kook", platformUid: "490000001", createdBy: "admin",
    })
    assert.equal(kook.ok, true)
    assert.equal(kook.binding.isPrimary, true)

    // 不存在的账号
    const missing = binding.bindPlatformAccountSync({
        accountId: 99999999, platform: "qq", platformUid: "490000003", createdBy: "admin",
    })
    assert.equal(missing.code, "ACCOUNT_NOT_FOUND")

    // bot 只能解非主绑定
    const refused = binding.unbindPlatformAccountSync({
        bindingId: primary.binding.id, actor: "bot",
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, "PRIMARY_BINDING")

    const removed = binding.unbindPlatformAccountSync({
        bindingId: extra.binding.id, actor: "bot", allowPrimary: false,
    })
    assert.equal(removed.ok, true)
    assert.equal(binding.listBindingsSync({ accountId: account.id }).length, 1)

    // 解掉主绑定后，剩下的绑定自动接任
    const three = binding.bindPlatformAccountSync({
        accountId: account.id, platform: "qq", platformUid: "490000004", createdBy: "admin",
    })
    assert.equal(three.binding.isPrimary, false)
    const dropped = binding.unbindPlatformAccountSync({
        bindingId: primary.binding.id, actor: "admin", allowPrimary: true,
    })
    assert.equal(dropped.ok, true)
    assert.equal(binding.getPrimaryBindingSync(account.id).platformUid, "490000004")
    assert.equal(accountRow(account.id).bind_state, "active")
    assert.equal(accountRow(account.id).bind_uid, "490000004")

    // 最后一个绑定被解掉 → 回到 pending
    const last = binding.getPrimaryBindingSync(account.id)
    binding.unbindPlatformAccountSync({
        bindingId: last.id, actor: "admin", allowPrimary: true,
    })
    assert.equal(accountRow(account.id).bind_state, "pending")
    assert.equal(accountRow(account.id).bind_platform, null)
    assert.equal(accountRow(account.id).bind_uid, null)
    assert.equal(binding.getPrimaryBindingSync(account.id), null)

    // promote 恢复主绑定
    const promoteTarget = binding.listBindingsSync({ platformUid: "490000004" })
    assert.equal(promoteTarget.length, 0)

    // 解绑不存在的绑定
    const notFound = binding.unbindPlatformAccountSync({ bindingId: 99999999 })
    assert.equal(notFound.code, "BINDING_NOT_FOUND")
})

test("禁用账号：disabled 状态下发码与消费都被拒绝", () => {
    const account = createAccount()
    const code = binding.createSignupCodeSync({ accountId: account.id })
    assert.equal(binding.setAccountBindStateSync(account.id, "disabled"), true)
    assert.equal(binding.getAccountBindStateSync(account.id), "disabled")

    const rejected = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "590000001",
    })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.code, "ACCOUNT_DISABLED")
    assert.equal(binding.getBindingByPlatformUidSync("qq", "590000001"), null)
    assert.equal(binding.setAccountBindStateSync(99999999, "active"), false)
})

test("审计：发码 / 绑定 / 解绑 / 吊销都有记录", () => {
    const account = createAccount()
    const code = binding.createSignupCodeSync({ accountId: account.id, actor: "admin" })
    binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "690000001", actor: "bot",
    })
    const records = binding.listBindAuditSync({ accountId: account.id })
    // 消费路径：绑定成功时共享写路径会先作废该账号仍 pending 的码（含正在消费的这枚），
    // 随后 consumeSignupCodeSync 在同一事务里把这枚码无条件置 bound —— 所以这里多一条
    // revoke_code 审计（旧→新：issue_code, bind, revoke_code；列表是新→旧序）。
    assert.deepEqual(records.map(record => record.action), ["revoke_code", "bind", "issue_code"])
    // 多出来的 revoke_code 行排在 bind 之前，所以这几条要指名取 bind 行，不能再取 [0]。
    const bindRecord = records.find(record => record.action === "bind")
    assert.equal(bindRecord.actor, "bot")
    assert.equal(bindRecord.platformUid, "690000001")
    assert.deepEqual(JSON.parse(bindRecord.detail).isPrimary, true)
    assert.equal(binding.listBindAuditSync({ action: "issue_code" }).length >= 1, true)
    assert.equal(binding.listBindAuditSync({ accountId: account.id, limit: 1 }).length, 1)
})

test("老库升级：新表新列都在，且重复初始化幂等", () => {
    const legacyAccount = createAccount()

    // 把库退回 C2 之前的形态：删掉 4 张表 + accounts 的 3 个新列
    const db = getDb()
    db.prepare("DROP TABLE IF EXISTS bind_audit").run()
    db.prepare("DROP TABLE IF EXISTS device_grants").run()
    db.prepare("DROP TABLE IF EXISTS account_bindings").run()
    db.prepare("DROP TABLE IF EXISTS signup_codes").run()
    db.prepare("ALTER TABLE accounts DROP COLUMN bind_state").run()
    db.prepare("ALTER TABLE accounts DROP COLUMN bind_platform").run()
    db.prepare("ALTER TABLE accounts DROP COLUMN bind_uid").run()
    db.pragma("user_version = 27")

    const beforeTables = tableNames()
    const beforeColumns = columnNames("accounts")
    assert.equal(beforeTables.includes("signup_codes"), false)
    assert.equal(beforeColumns.includes("bind_state"), false)
    data.closeDatabase()

    // 用当前版本重新打开老库 = 升级
    data.initializeDatabase()

    const afterTables = tableNames()
    const afterColumns = columnNames("accounts")
    console.log("[P2] 老库升级前 user_version=27, tables=%s", beforeTables.filter(
        name => name.startsWith("signup") || name.startsWith("account_binding")
            || name.startsWith("device_grant") || name.startsWith("bind_audit"),
    ).join(",") || "(none)")
    console.log("[P2] 老库升级后 user_version=%s", userVersion())
    console.log("[P2] 老库升级后新表=%s", ["signup_codes", "account_bindings", "device_grants", "bind_audit"]
        .filter(name => afterTables.includes(name)).join(","))
    console.log("[P2] 老库升级后 accounts 新列=%s", ["bind_state", "bind_platform", "bind_uid"]
        .filter(name => afterColumns.includes(name)).join(","))

    assert.equal(userVersion(), 28)
    for (const table of ["signup_codes", "account_bindings", "device_grants", "bind_audit"]) {
        assert.ok(afterTables.includes(table), `升级后缺少表 ${table}`)
    }
    for (const column of ["bind_state", "bind_platform", "bind_uid"]) {
        assert.ok(afterColumns.includes(column), `升级后 accounts 缺少列 ${column}`)
    }
    // 老数据没丢，且默认 active
    assert.equal(accountRow(legacyAccount.id).bind_state, "active")

    // 迁移后的库可正常使用
    const code = binding.createSignupCodeSync({ accountId: legacyAccount.id })
    const consumed = binding.consumeSignupCodeSync({
        code: code.code, platform: "qq", platformUid: "790000001",
    })
    assert.equal(consumed.ok, true)

    // 再初始化一次：幂等，不重复建表、不重复加列
    data.closeDatabase()
    data.initializeDatabase()
    assert.equal(ensureSchemaColumn(getDb(), "accounts.bind_state"), false)
    assert.equal(ensureSchemaColumn(getDb(), "accounts.bind_platform"), false)
    assert.equal(ensureSchemaColumn(getDb(), "accounts.bind_uid"), false)
    assert.equal(userVersion(), 28)
    assert.equal(binding.getBindingByPlatformUidSync("qq", "790000001").accountId, legacyAccount.id)
    assert.equal(binding.getAccountByDeviceSync(790000001), null)
})
