"use strict"

// A *successful* bind ends the life of every signup code the account still has
// in flight.
//
// Before this, `bindPlatformAccountSync` never touched `signup_codes`: a code
// issued before the bind stayed `pending` for the rest of its TTL and could be
// consumed afterwards by a *different* platform identity (another QQ / KOOK
// number), which is exactly the confusion this card removes.
//
// Deliberately frozen and asserted below as untouched: SIGNUP_CODE_ALPHABET,
// SIGNUP_CODE_LENGTH, SIGNUP_CODE_TTL_MINUTES and `normalizeSignupCode()`.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

// Throwaway DATA_DIR so the shared .database/ directory is never touched.
const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "signup-code-revoke-"))
process.env.DATA_DIR = databaseDirectory

const { getDb } = require("../src/data/db")
const { initializeDatabase } = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const {
    SIGNUP_CODE_ALPHABET,
    SIGNUP_CODE_LENGTH,
    SIGNUP_CODE_MAX_ATTEMPTS,
    SIGNUP_CODE_TTL_MINUTES,
    bindPlatformAccountSync,
    consumeSignupCodeSync,
    createSignupCodeSync,
    getSignupCodeSync,
    listBindAuditSync,
    listBindingsSync,
    normalizeSignupCode,
    setAccountBindStateSync,
} = require("../src/data/domains/account-binding")

let sequence = 0

// This is a pure domain test: no fastify instance is booted, so the schema has
// to be created explicitly before the first write.
initializeDatabase()

function createAccount(extra = {}) {
    sequence += 1
    return insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `revoke-on-bind-${sequence}-${Math.random().toString(36).slice(2)}`,
        status: "normal",
        ...extra,
    })
}

/** Status of a code as stored, failing loudly if the row vanished. */
function statusOf(code) {
    const row = getSignupCodeSync(code)
    assert.notEqual(row, null, `signup code ${code} disappeared`)
    return row.status
}

function issueCode(accountId) {
    return createSignupCodeSync({ accountId })
}

function revokeAuditCount(accountId) {
    return listBindAuditSync({ accountId })
        .filter(record => record.action === "revoke_code")
        .length
}

function lockCode(codeId) {
    getDb().prepare("UPDATE signup_codes SET attempts = ? WHERE id = ?")
        .run(SIGNUP_CODE_MAX_ATTEMPTS, codeId)
}

test("绑定成功后，绑定前发出的旧码不再能被消费", () => {
    const account = createAccount({ username: "revoke-owner" })
    const stale = issueCode(account.id)
    assert.equal(statusOf(stale.code), "pending")
    assert.equal(revokeAuditCount(account.id), 0)

    // A bind that does not go through the code: the straggler stays behind.
    const bound = bindPlatformAccountSync({
        accountId: account.id,
        platform: "qq",
        platformUid: "revoke-bind-1",
        createdBy: "admin",
        actor: "admin",
    })
    assert.equal(bound.ok, true)

    // The straggler is dead, and the revocation is audited.
    assert.equal(statusOf(stale.code), "revoked")
    assert.equal(revokeAuditCount(account.id), 1)

    // The point of the card: it can no longer be spent by another identity.
    const stolen = consumeSignupCodeSync({
        code: stale.code,
        platform: "kook",
        platformUid: "revoke-thief-1",
        actor: "bot",
    })
    assert.equal(stolen.ok, false)
    assert.equal(stolen.code, "CODE_INVALID")
    // The attempt is still burned: spending a revoked code counts as a failed
    // guess, so a stolen code cannot be used as a free probe.
    assert.equal(getSignupCodeSync(stale.code).attempts, 1)
    assert.equal(listBindingsSync({ platform: "kook", platformUid: "revoke-thief-1" }).length, 0)
    assert.equal(listBindingsSync({ platform: "qq", platformUid: "revoke-bind-1" }).length, 1)
})

test("bot 正常消费路径：被消费的码终态是 bound（不是 revoked），审计顺序正确", () => {
    const account = createAccount({ username: "revoke-consume-owner" })
    const code = issueCode(account.id)
    assert.equal(revokeAuditCount(account.id), 0)

    const consumed = consumeSignupCodeSync({
        code: code.code,
        platform: "qq",
        platformUid: "revoke-consume-1",
        actor: "bot",
    })
    assert.equal(consumed.ok, true)
    assert.equal(consumed.accountId, account.id)

    // The revocation inside `bindPlatformAccountSync` hits this very code too,
    // but the consume path re-marks it `status = 'bound'` in the same
    // transaction right afterwards, so its one-time semantics are intact.
    const spent = getSignupCodeSync(code.code)
    assert.equal(spent.status, "bound")
    assert.equal(spent.platform, "qq")
    assert.equal(spent.platformUid, "revoke-consume-1")

    assert.equal(listBindingsSync({ platform: "qq", platformUid: "revoke-consume-1" }).length, 1)
    assert.equal(listBindingsSync({ platform: "qq", platformUid: "revoke-consume-1" })[0].isPrimary, true)

    // Newest first: the revoke row written by the shared write path, then the
    // bind, then the original issue.
    assert.deepEqual(
        listBindAuditSync({ accountId: account.id }).map(record => record.action),
        ["revoke_code", "bind", "issue_code"],
    )
    assert.equal(listBindAuditSync({ accountId: account.id, action: "bind" })[0].actor, "bot")

    // A second attempt is the frozen CODE_USED, not CODE_INVALID.
    const again = consumeSignupCodeSync({
        code: code.code,
        platform: "kook",
        platformUid: "revoke-consume-2",
        actor: "bot",
    })
    assert.equal(again.ok, false)
    assert.equal(again.code, "CODE_USED")
    assert.equal(listBindingsSync({ platform: "kook", platformUid: "revoke-consume-2" }).length, 0)
})

test("作废范围只限该账号：副账号与其他玩家的码不受影响", () => {
    // The schema links accounts to a platform identity, not to a human, so
    // "same player's second account" and "another player's account" are both
    // just other accounts here — neither may be touched.
    const owner = createAccount({ username: "revoke-scope-owner" })
    const secondAccount = createAccount({ username: "revoke-scope-second" })
    const otherPlayer = createAccount({ username: "revoke-scope-other" })
    const secondCode = issueCode(secondAccount.id)
    const otherCode = issueCode(otherPlayer.id)
    // Two codes of the bound account: only the pending one is in flight.
    const ownerCode = issueCode(owner.id)

    const bound = bindPlatformAccountSync({
        accountId: owner.id,
        platform: "qq",
        platformUid: "revoke-scope-1",
        createdBy: "admin",
        actor: "admin",
    })
    assert.equal(bound.ok, true)

    assert.equal(statusOf(ownerCode.code), "revoked")
    assert.equal(revokeAuditCount(owner.id), 1)
    assert.equal(statusOf(secondCode.code), "pending")
    assert.equal(statusOf(otherCode.code), "pending")
    assert.equal(revokeAuditCount(secondAccount.id), 0)
    assert.equal(revokeAuditCount(otherPlayer.id), 0)

    // Both are still spendable, and each binds its own account.
    const secondUse = consumeSignupCodeSync({
        code: secondCode.code,
        platform: "qq",
        platformUid: "revoke-scope-second-1",
        actor: "bot",
    })
    assert.equal(secondUse.ok, true)
    assert.equal(secondUse.accountId, secondAccount.id)

    const otherUse = consumeSignupCodeSync({
        code: otherCode.code,
        platform: "kook",
        platformUid: "revoke-scope-other-1",
        actor: "bot",
    })
    assert.equal(otherUse.ok, true)
    assert.equal(otherUse.accountId, otherPlayer.id)
})

test("绑定失败路径不作废任何码：ALREADY_BOUND / ACCOUNT_DISABLED / CODE_LOCKED", () => {
    const owner = createAccount({ username: "revoke-fail-owner" })
    bindPlatformAccountSync({
        accountId: owner.id,
        platform: "qq",
        platformUid: "revoke-fail-taken",
        createdBy: "admin",
        actor: "admin",
    })

    // (a) The uid is already owned: the intruder's own pending code survives
    //     its failed attempt, because the early `ALREADY_BOUND` return happens
    //     before the revocation.
    const intruder = createAccount({ username: "revoke-fail-intruder" })
    const intruderCode = issueCode(intruder.id)
    const conflict = consumeSignupCodeSync({
        code: intruderCode.code,
        platform: "qq",
        platformUid: "revoke-fail-taken",
        actor: "bot",
    })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, "ALREADY_BOUND")
    assert.equal(statusOf(intruderCode.code), "pending")
    assert.equal(revokeAuditCount(intruder.id), 0)

    // (b) A disabled account is rejected before any binding is attempted.
    const disabled = createAccount({ username: "revoke-fail-disabled" })
    const disabledCode = issueCode(disabled.id)
    setAccountBindStateSync(disabled.id, "disabled")
    const blocked = consumeSignupCodeSync({
        code: disabledCode.code,
        platform: "qq",
        platformUid: "revoke-fail-disabled-1",
        actor: "bot",
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, "ACCOUNT_DISABLED")
    assert.equal(statusOf(disabledCode.code), "pending")
    assert.equal(revokeAuditCount(disabled.id), 0)

    // (c) A locked code never reaches the bind path at all.
    const locked = createAccount({ username: "revoke-fail-locked" })
    const lockedCode = issueCode(locked.id)
    lockCode(lockedCode.id)
    const lockedResponse = consumeSignupCodeSync({
        code: lockedCode.code,
        platform: "qq",
        platformUid: "revoke-fail-locked-1",
        actor: "bot",
    })
    assert.equal(lockedResponse.ok, false)
    assert.equal(lockedResponse.code, "CODE_LOCKED")
    assert.equal(statusOf(lockedCode.code), "pending")
    assert.equal(revokeAuditCount(locked.id), 0)

    // The successful bind above is the only binding that exists.
    assert.equal(listBindingsSync({ platform: "qq", platformUid: "revoke-fail-taken" })[0].accountId, owner.id)
})

test("bindPlatformAccountSync 直接失败出口同样不作废：ACCOUNT_NOT_FOUND / ALREADY_BOUND", () => {
    const owner = createAccount({ username: "revoke-direct-owner" })
    bindPlatformAccountSync({
        accountId: owner.id,
        platform: "qq",
        platformUid: "revoke-direct-taken",
        createdBy: "admin",
        actor: "admin",
    })

    const target = createAccount({ username: "revoke-direct-target" })
    const targetCode = issueCode(target.id)

    const missing = bindPlatformAccountSync({
        accountId: 987_654_321,
        platform: "qq",
        platformUid: "revoke-direct-ghost",
        createdBy: "admin",
        actor: "admin",
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, "ACCOUNT_NOT_FOUND")

    const taken = bindPlatformAccountSync({
        accountId: target.id,
        platform: "qq",
        platformUid: "revoke-direct-taken",
        createdBy: "admin",
        actor: "admin",
    })
    assert.equal(taken.ok, false)
    assert.equal(taken.code, "ALREADY_BOUND")

    assert.equal(statusOf(targetCode.code), "pending")
    assert.equal(revokeAuditCount(target.id), 0)
    assert.equal(listBindingsSync({ platform: "qq", platformUid: "revoke-direct-taken" })[0].accountId, owner.id)
})

test("冻结契约未动：码的字母表 / 长度 / TTL / 归一化", () => {
    assert.equal(SIGNUP_CODE_ALPHABET, "23456789ABCDEFGHJKLMNPQRSTUVWXYZ")
    assert.equal(SIGNUP_CODE_LENGTH, 6)
    assert.equal(SIGNUP_CODE_TTL_MINUTES, 30)
    assert.equal(SIGNUP_CODE_MAX_ATTEMPTS, 5)
    assert.equal(normalizeSignupCode(" ab-c d "), "ABCD")
    assert.equal(normalizeSignupCode("a2c4e6"), "A2C4E6")

    const account = createAccount({ username: "revoke-shape" })
    const code = issueCode(account.id)
    const prefix = code.code.slice(0, SIGNUP_CODE_LENGTH)
    assert.equal(prefix.length, SIGNUP_CODE_LENGTH)
    for (const character of prefix) {
        assert.ok(SIGNUP_CODE_ALPHABET.includes(character), `unexpected character ${character}`)
    }
})
