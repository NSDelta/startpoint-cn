"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    DegreeComputer,
    allFacts,
    buildDegreeRuleCatalog,
    createSession,
    getMissionCatalog,
    installGlobalRepository,
    repositoryWith,
} = require("./helpers/mission-degree-session-fixture.cjs")

test("all 1288 Degree rules build and compute without post-context external access", () => {
    let tableCalls = 0
    const repository = repositoryWith({}, "all-degree-characterization")
    const countedRepository = {
        ...repository,
        table(tableName) {
            tableCalls++
            return repository.table(tableName)
        },
    }
    const catalog = getMissionCatalog(countedRepository)
    const missionIds = catalog.getMissionIds(5)
    const rules = buildDegreeRuleCatalog(catalog).rules
    assert.equal(rules.size, 1288)
    assert.equal([...rules.values()].filter(rule => rule.kind === "persisted").length, 100)
    // 上游 2026-10-03 cond20/92 救援计数器落地后,原先 6 条 unsupported 变成可算的 metric(97 -> 103):
    // 这里跟着上游行为更新计数,并显式钉住 metric 条数,避免"少了 6 条"被悄悄吞掉
    assert.equal([...rules.values()].filter(rule => rule.kind === "unsupported").length, 0)
    assert.equal([...rules.values()].filter(rule => rule.kind === "metric").length, 103)
    assert.equal([...rules.values()].filter(rule => !["persisted", "unsupported"].includes(rule.kind)).length, 1188)

    const loaderCalls = []
    const session = createSession(catalog, missionIds, allFacts(), loaderCalls)
    const context = DegreeComputer.buildContextFromSession(session, 5, missionIds)
    const tableCallsAfterContext = tableCalls
    const loaderCallsAfterContext = loaderCalls.length
    installGlobalRepository(repositoryWith({}, "global-after-context"))
    const sessionPrototype = Object.getPrototypeOf(session)
    const catalogPrototype = Object.getPrototypeOf(catalog)
    const sessionGetFact = sessionPrototype.getFact
    const sessionGetFactFromPlan = sessionPrototype.getFactFromPlan
    const catalogGetDefinition = catalogPrototype.getDefinition
    sessionPrototype.getFact = () => { throw new Error("Session getter used during compute") }
    sessionPrototype.getFactFromPlan = () => { throw new Error("Session getter used during compute") }
    catalogPrototype.getDefinition = () => { throw new Error("Catalog getter used during compute") }
    try {
        for (const missionId of missionIds) {
            assert.doesNotThrow(() => DegreeComputer.compute(missionId, context, 0))
            assert.doesNotThrow(() => DegreeComputer.compute(missionId, context, 7))
        }
    } finally {
        sessionPrototype.getFact = sessionGetFact
        sessionPrototype.getFactFromPlan = sessionGetFactFromPlan
        catalogPrototype.getDefinition = catalogGetDefinition
    }
    assert.equal(tableCalls, tableCallsAfterContext)
    assert.equal(loaderCalls.length, loaderCallsAfterContext)
})
