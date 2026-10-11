"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const playerDomain = require("../src/data/domains/player")
const exp = require("../src/lib/character-growth/commands/inject-exp")
const rewardExp = require("../src/lib/character-growth/commands/grant-character-exp")
const stack = require("../src/lib/character-growth/commands/stack-to-exp")
const bulk = require("../src/lib/character-growth/commands/bulk-stack-to-exp")
const { createCharacterGrowthC4Fixture } = require("./helpers/character-growth-c4-fixture.cjs")

test("C4 EXP commands expose the approved Growth entry points", () => {
    assert.equal(typeof exp.executeInjectCharacterExp, "function")
    assert.equal(typeof rewardExp.grantCharacterExpWithinTransactionSync, "function")
    assert.equal(typeof stack.executeStackToExp, "function")
    assert.equal(typeof bulk.executeBulkStackToExp, "function")
})

test("inject_exp spends the pool, caps character EXP, and returns overflow to the pool", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 1000 })
        const first = exp.executeInjectCharacterExp({
            playerId,
            characterId: 1,
            addExp: 1000,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(first.expPool, 0)
        assert.equal(fixture.setPlayer(playerId, {}).expPool, 0)
        assert.equal(first.after.exp, 1010)

        for (const addExp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(
                () => exp.executeInjectCharacterExp({
                    playerId,
                    characterId: 1,
                    addExp,
                    evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
                }),
                error => error.code === "INVALID_REQUEST",
            )
        }

        fixture.setPlayer(playerId, { expPool: 0 })
        fixture.addCharacter(playerId, 341003, { exp: 37241, overLimitStep: 0 })
        const overflow = rewardExp.grantCharacterExp({
            playerId,
            characterIds: [341003],
            amount: 20,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(overflow.add_exp_list[0].after_exp, 37241)
        assert.equal(overflow.add_exp_list[0].add_exp_pool, 20)
        assert.equal(overflow.exp_pool, 20)
    } finally {
        fixture.cleanup()
    }
})

test("reward EXP trusts an explicit zero pool and reads a standalone player only once", () => {
    const fixture = createCharacterGrowthC4Fixture()
    const originalGetPlayerSync = playerDomain.getPlayerSync
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 1000 })
        let playerReads = 0
        playerDomain.getPlayerSync = (...args) => {
            playerReads += 1
            return originalGetPlayerSync(...args)
        }
        const explicit = fixture.db.transaction(() => rewardExp.grantCharacterExpWithinTransactionSync({
            playerId,
            characterIds: [1],
            amount: 1,
            knownExpPool: 0,
        }))()
        assert.equal(playerReads, 0)
        assert.equal(explicit.exp_pool, 0)

        fixture.addCharacter(playerId, 341003, { exp: 37241, overLimitStep: 0 })
        const standalone = rewardExp.grantCharacterExp({
            playerId,
            characterIds: [341003],
            amount: 20,
        })
        assert.equal(playerReads, 1)
        assert.equal(standalone.exp_pool, 1020)
        assert.equal(fixture.setPlayer(playerId, {}).expPool, 1020)
    } finally {
        playerDomain.getPlayerSync = originalGetPlayerSync
        fixture.cleanup()
    }
})

test("reward EXP rejects raw persisted Growth corruption before writing", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.db.prepare(`
            UPDATE players_characters
            SET protection = 2
            WHERE player_id = ? AND id = 1
        `).run(playerId)
        const before = fixture.db.prepare(`
            SELECT exp, update_time
            FROM players_characters
            WHERE player_id = ? AND id = 1
        `).get(playerId)

        assert.throws(
            () => rewardExp.grantCharacterExp({
                playerId,
                characterIds: [1],
                amount: 1,
                knownExpPool: 0,
            }),
            error => error.code === "INVALID_GROWTH_STATE"
                && /protection must be 0 or 1/.test(error.message),
        )
        assert.deepEqual(fixture.db.prepare(`
            SELECT exp, update_time
            FROM players_characters
            WHERE player_id = ? AND id = 1
        `).get(playerId), before)
    } finally {
        fixture.cleanup()
    }
})

test("reward EXP keeps character and bond-token reads before its single batch write", () => {
    const source = fs.readFileSync(path.join(
        __dirname,
        "../src/lib/character-growth/commands/grant-character-exp.ts",
    ), "utf8")
    const seedRead = source.indexOf("const seeds = readProjectionSeeds(")
    const batchWrite = source.indexOf("updateCharacterGrowthRowsSync(command.playerId, updates)")

    assert.ok(seedRead >= 0 && batchWrite > seedRead)
    assert.equal((source.match(/getPlayerSync\(/g) ?? []).length, 1)
    assert.equal((source.match(/getPlayerCharactersWithStoredGrowthByIdsSync\(/g) ?? []).length, 1)
    assert.match(source, /storedCharactersSnapshot:\s*seeds\.storedCharacters/)
    assert.match(source, /bondTokenSnapshots:\s*seeds\.bondTokens/)
    assert.doesNotMatch(source.slice(batchWrite), /getPlayerCharactersWithStoredGrowthByIdsSync\(/)
    assert.doesNotMatch(source.slice(batchWrite), /getPlayerSync\(/)
})

test("inject_exp leaves the save untouched when the pool is insufficient", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, { expPool: 100 })
        fixture.addCharacter(playerId, 1, { exp: 50 })

        const characterBefore = fixture.db.prepare(
            "SELECT exp FROM players_characters WHERE player_id = ? AND id = ?",
        ).get(playerId, 1)
        const countersBefore = fixture.db.prepare(
            "SELECT * FROM players_active_mission_counters WHERE player_id = ?",
        ).get(playerId)

        assert.throws(
            () => exp.executeInjectCharacterExp({
                playerId,
                characterId: 1,
                addExp: 101,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            error => error.code === "INSUFFICIENT_EXP",
        )

        assert.equal(fixture.setPlayer(playerId, {}).expPool, 100, "经验池不得被扣减")
        assert.deepEqual(
            fixture.db.prepare(
                "SELECT exp FROM players_characters WHERE player_id = ? AND id = ?",
            ).get(playerId, 1),
            characterBefore,
            "角色经验不得被写入",
        )
        assert.deepEqual(
            fixture.db.prepare(
                "SELECT * FROM players_active_mission_counters WHERE player_id = ?",
            ).get(playerId),
            countersBefore,
            "Active Mission 注入计数不得被推进",
        )
    } finally {
        fixture.cleanup()
    }
})

// 回归(用户实测):「角色升级时,把经验值用光后,等级会重置为使用前状态」。
// 经验池按真实时间每分钟累积,但累积只在登录/基础响应里落地;客户端按
// exp_pool + 已过分钟数自行渲染池。扣款前不结算这段累积时,玩家点「全部」整额
// 注入客户端渲染值必然大于库内值 ⇒ 被判超额 ⇒ 以未变更事实回滚,玩家看到等级
// 退回使用前状态。修复:注入事务内先 collectPlayerDataPooledExpSync。
test("inject_exp settles the real-time pool accrual before spending", () => {
    const fixture = createCharacterGrowthC4Fixture()
    try {
        // 3 星角色 + 界限突破 4 档:经验帽 125223,本用例不触发溢出
        const playerId = fixture.createPlayer()
        fixture.setPlayer(playerId, {
            expPool: 1000,
            expPooledTime: new Date(Date.now() - 10 * 60 * 1000),
        })
        fixture.addCharacter(playerId, 341005, { exp: 10, overLimitStep: 4 })
        const anchorBefore = fixture.setPlayer(playerId, {}).expPooledTime.getTime()

        // 客户端渲染值 = 1000 + 10 分钟累积 = 1010:必须能整额注入并恰好花光
        const settled = exp.executeInjectCharacterExp({
            playerId,
            characterId: 341005,
            addExp: 1010,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(settled.addExpList[0].add_exp, 1010, "客户端渲染值必须能整额注入")
        assert.equal(settled.expPool, 0, "结算累积后必须恰好花光经验池")
        const after = fixture.setPlayer(playerId, {})
        assert.equal(after.expPool, 0, "库内经验池必须为 0,而不是负数")
        assert.ok(
            after.expPooledTime.getTime() > anchorBefore,
            "结算后锚点必须推进到本次注入",
        )
        assert.equal(
            fixture.db.prepare(
                "SELECT exp FROM players_characters WHERE player_id = ? AND id = ?",
            ).get(playerId, 341005).exp,
            1020,
            "角色经验必须整额加上 1010",
        )

        // 对照:锚点在当下时,超额注入仍旧整体拒绝(未变更事实的既有契约)
        const strictPlayer = fixture.createPlayer()
        fixture.setPlayer(strictPlayer, { expPool: 100, expPooledTime: new Date() })
        fixture.addCharacter(strictPlayer, 341005, { exp: 50, overLimitStep: 4 })
        assert.throws(
            () => exp.executeInjectCharacterExp({
                playerId: strictPlayer,
                characterId: 341005,
                addExp: 101,
                evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
            }),
            error => error.code === "INSUFFICIENT_EXP",
        )
        assert.equal(fixture.setPlayer(strictPlayer, {}).expPool, 100, "被拒时经验池不得被扣减")

        // 实盘形态:池 105000 已越过上限 100000 ⇒ 累积恒为 0、锚点冻结,
        // 客户端显示被自身上限夹在 100000 ⇒「用光」仍需可整额注入
        const cappedPlayer = fixture.createPlayer()
        fixture.setPlayer(cappedPlayer, {
            expPool: 105000,
            expPooledTime: new Date(Date.now() - 10 * 60 * 1000),
        })
        fixture.addCharacter(cappedPlayer, 341005, { exp: 10, overLimitStep: 4 })
        const capped = exp.executeInjectCharacterExp({
            playerId: cappedPlayer,
            characterId: 341005,
            addExp: 100000,
            evaluationTime: new Date("2026-08-31T00:00:00.000Z"),
        })
        assert.equal(capped.overflowExp, 0, "上限内注入不得溢出")
        assert.equal(capped.expPool, 5000, "超上限池注入后必须保留超出的 5000")
    } finally {
        fixture.cleanup()
    }
})
