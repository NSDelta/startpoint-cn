const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

function routeSource(relativePath) {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8")
}

const sharedValues = routeSource("src/lib/quest/finish/battle-settlement-values.ts")
for (const [name, settlementPath, valueAdapterPath, responsePath] of [
    ["单人", "src/lib/quest/finish/single-settlement-writes.ts", "src/lib/quest/finish/single-settlement-value-plan.ts", "src/lib/quest/finish/single-response-projector.ts"],
    ["联机", "src/multi/settlement/orchestrator.ts", "src/multi/settlement/value-plan.ts", "src/multi/settlement/response.ts"],
]) {
    test(`${name}结算复用同一服务器时间并接入奖励活动倍率`, () => {
        const source = routeSource(settlementPath)
        const valueAdapter = routeSource(valueAdapterPath)
        const responseSource = routeSource(responsePath)
        assert.match(valueAdapter, /const settlementTime = new Date\(getServerTime\(\) \* 1000\)/)
        assert.match(
            valueAdapter,
            /getRewardCampaignRates\([\s\S]*?settlementTime,?\s*\)/,
        )
        assert.match(valueAdapter, /createBattleSettlementValuePlan\s*\(/)
        assert.match(sharedValues, /calculateFixedQuestMana\s*\(/)
        assert.match(sharedValues, /calculateFixedQuestPoolExp\s*\(/)
        assert.match(sharedValues, /calculateCharacterBattleExp\s*\(/)
        assert.match(source, /\{\s*settlementTime,\s*valuePlan\s*\}/)
        assert.match(source, /rewardCampaignRates[,\n]/)
        assert.match(source, /rewardDate:\s*settlementTime/)
        // 上游 2026-10-05（b2e40c3f）只把**单人**结算的实参改成对象字面量：LoseBattle
        // 败北通关时用 battleFactsAccomplished 覆盖 questAccomplished，保持真实败北语义
        // （不计通关/SS）。联机结算仍是 (finishCtx, settlementTime) 两参形态。两者语义
        // 相同（都用同一个 settlementTime 记账）⇒ 断言按形态分别写，不锁死单一写法。
        const battleFactsPattern = name === "单人"
            ? /recordMissionBattleFacts\(\{[\s\S]*?\.\.\.finishCtx[\s\S]*?\},\s*settlementTime\)/
            : /recordMissionBattleFacts\(finishCtx,\s*settlementTime\)/
        assert.match(source, battleFactsPattern)
        assert.match(source, /\.\.\.playerValues/)
        assert.match(responseSource, /"reward_pool_exp":\s*fixedPoolExpReward/)
    })
}
