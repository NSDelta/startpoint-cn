"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
    projectStarCrumbExchangeRefusalResponse,
    projectStarCrumbExchangeResponse,
    STALE_CLIENT_VIEW_RESULT_CODE,
} = require("../src/lib/star-crumb-exchange/response-projector")
const {
    projectBondTokenExchangeResponse,
} = require("../src/lib/bond-token-exchange/response-projector")

const fullEquipment = {
    equipment_id: 5010005,
    protection: false,
    level: 1,
    enhancement_level: 0,
    stack: 0,
}

function starCrumbResult(overrides = {}) {
    return {
        ok: true,
        playerId: 17,
        exchangeId: 1,
        product: { kind: "item", targetId: 10002 },
        starCrumbAfter: 400,
        freeManaAfter: null,
        characters: [],
        rewardItems: { 10002: 1 },
        equipment: [],
        itemOverflowDispositions: [],
        ...overrides,
    }
}

test("star crumb projection keeps frozen nulls and applies entity whitelists", () => {
    const response = projectStarCrumbExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: starCrumbResult({
            equipment: [{ ...fullEquipment, junk_field: "leak" }],
        }),
        characterList: [{ character_id: 111001, stack: 0, junk_field: "leak" }],
        mailArrived: false,
    }).data
    assert.deepEqual(response.user_info, { star_crumb: 400 })
    assert.deepEqual(response.character_list, [{ character_id: 111001, stack: 0 }])
    assert.deepEqual(response.item_list, { 10002: 1 })
    assert.deepEqual(response.equipment_list, [fullEquipment])
    assert.equal(response.mission_info, null)
    assert.equal(response.over_max, null)
    assert.equal(response.mail_arrived, false)
    assert.equal(response.active_mission_list, null)
    assert.equal(response.config, null)
    assert.equal(response.user_daily_challenge_point_list, null)
    assert.equal(response.encyclopedia_info, null)
    assert.equal(response.fund_receive_list, null)
    assert.equal(response.monthly_charge_bonus_info, null)
    assert.equal(response.crazy_gacha_result_list, null)
})

test("star crumb refusal projection carries the stale-view result code and unchanged facts", () => {
    // 2053 = ItemShopPeriodError：CN 1.8.1 客户端在 star crumb 兑换这条 remote 上
    // 唯一能温和提示的结果码（见 ExchangeStarCrumbRealRemote.errorHandler 的 kind 8
    // 分支），用于「余额不足 / 已持有 / 条目未知」这类本地视图过期。响应体必须与成功
    // 响应同形，但不含任何增量，避免客户端误判为兑换成功。
    assert.equal(STALE_CLIENT_VIEW_RESULT_CODE, 2053)
    const response = projectStarCrumbExchangeRefusalResponse({
        dataHeaders: { viewer_id: 900, result_code: STALE_CLIENT_VIEW_RESULT_CODE },
        starCrumb: 1000,
        mailArrived: false,
    })
    assert.equal(response.data_headers.result_code, 2053)
    assert.deepEqual(response.data.user_info, { star_crumb: 1000 })
    assert.deepEqual(response.data.character_list, [])
    assert.deepEqual(response.data.item_list, {})
    assert.deepEqual(response.data.equipment_list, [])
    assert.equal(response.data.mission_info, null)
    assert.equal(response.data.over_max, null)
    assert.equal(response.data.mail_arrived, false)
    assert.equal(response.data.active_mission_list, null)
    assert.equal(response.data.config, null)
    assert.equal(response.data.user_daily_challenge_point_list, null)
    assert.equal(response.data.encyclopedia_info, null)
    assert.equal(response.data.fund_receive_list, null)
    assert.equal(response.data.monthly_charge_bonus_info, null)
    assert.equal(response.data.crazy_gacha_result_list, null)
})

test("star crumb projection rejects non-canonical entity identity", () => {
    assert.throws(() => projectStarCrumbExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: starCrumbResult(),
        characterList: [{ character_id: 0 }],
        mailArrived: false,
    }), TypeError)
    assert.throws(() => projectStarCrumbExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: starCrumbResult({
            equipment: [{ equipment_id: 5010005, stack: 0 }],
        }),
        characterList: [],
        mailArrived: false,
    }), TypeError)
})

function bondTokenResult(overrides = {}) {
    return {
        ok: true,
        playerId: 17,
        product: { kind: "equipment", equipmentId: 5010005 },
        bondTokenAfter: 50,
        exchangeCount: 1,
        equipment: [fullEquipment],
        ...overrides,
    }
}

test("bond token projection keeps frozen nulls and complete equipment entities", () => {
    const response = projectBondTokenExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: bondTokenResult(),
        mailArrived: true,
    }).data
    assert.deepEqual(response.user_info, { bond_token: 50 })
    assert.deepEqual(response.equipment_list, [fullEquipment])
    assert.equal(response.character_list, null)
    assert.equal(response.item_list, null)
    assert.equal(response.mission_info, null)
    assert.equal(response.over_max, null)
    assert.equal(response.mail_arrived, true)
    assert.throws(() => projectBondTokenExchangeResponse({
        dataHeaders: { viewer_id: 900, result_code: 1 },
        result: bondTokenResult({
            equipment: [{ equipment_id: 5010005, junk_field: "leak" }],
        }),
        mailArrived: true,
    }), TypeError)
})

test("exchange response projection modules are dependency-free from DB, Content, and routes", () => {
    for (const module of [
        "../src/lib/star-crumb-exchange/response-projector",
        "../src/lib/bond-token-exchange/response-projector",
    ]) {
        const source = fs.readFileSync(
            path.join(__dirname, "..", module.replace("../", "") + ".ts"),
            "utf8",
        )
        assert.doesNotMatch(
            source,
            /(?:from\s+["'][^"']*(?:\/data|\/content|\/routes)|require\([^)]*(?:\/data|\/content|\/routes))/i,
            module,
        )
    }
    const loaded = Object.keys(require.cache)
    assert.equal(
        loaded.some(file => /\/src\/(data|content|routes)\//.test(file)),
        false,
    )
})
