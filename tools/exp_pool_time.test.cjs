"use strict"

const assert = require("node:assert/strict")

require("ts-node/register/transpile-only")

const {
    calculatePooledExpAtRealTime,
    clientTimestampToExpPoolRealDate,
    expPoolRealDateToClientTimestamp,
    EXP_POOL_GAIN_INTERVAL_MS,
    EXP_POOL_MAX,
} = require("../src/lib/exp-pool-time")

const REAL_NOW = Date.parse("2026-08-20T00:00:00.000Z")
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function dateAt(offsetMs) {
    return new Date(REAL_NOW + offsetMs)
}

// 池的节奏必须与客户端自己的渲染模型一致：1 exp / 60 秒（上游注释亦为「已过分钟数」）。
// 2026-10-17 线上事故反解：客户端请求 126860 = 库里 105000 + 约 21862 分钟累积 ⇒ 1/分钟；
// 若按 1/秒，客户端会直接顶到自己的上限、请求量级为上限值而不是 126860。
// 上限必须大于客户端能渲染出的值（实测 126860 > 旧上限 100000）。
assert.equal(EXP_POOL_GAIN_INTERVAL_MS, MINUTE, "pool gains 1 exp per minute (client model)")
assert.equal(EXP_POOL_MAX, 999999, "pool cap must exceed the client-rendered 126860")

assert.deepEqual(
    calculatePooledExpAtRealTime(10, dateAt(-10 * MINUTE), dateAt(0), 365 * 24 * 60 * MINUTE),
    {
        expPool: 20,
        expPooledTime: dateAt(0),
        earned: 10,
        repaired: false,
    },
    "pool growth must use real elapsed time even while virtual time is shifted",
)

assert.deepEqual(
    calculatePooledExpAtRealTime(42, dateAt(24 * HOUR), dateAt(0), -365 * 24 * 60 * MINUTE),
    {
        expPool: 42,
        expPooledTime: dateAt(0),
        earned: 0,
        repaired: true,
    },
    "a future anchor must be repaired without removing the existing balance",
)

// 迁移分支的闸门是 |realElapsed| > MAX_CATCH_UP_MS(= 上限 × 节奏 ≈ 694 天)：用 800 天的
// 虚拟时钟偏移让闸门成立，锚点仍是「虚拟域里 2 分钟前写的」，迁移后只补这 2 分钟。
const legacyOffset = 800 * 24 * 60 * MINUTE
const legacyVirtualAnchor = dateAt(0).getTime() + legacyOffset - 2 * MINUTE
const legacyResult = calculatePooledExpAtRealTime(
    7,
    new Date(legacyVirtualAnchor),
    dateAt(0),
    legacyOffset,
)
assert.deepEqual(
    legacyResult,
    {
        expPool: 9,
        expPooledTime: dateAt(0),
        earned: 2,
        repaired: true,
    },
    "old virtual anchors must migrate to the real clock without a huge catch-up grant",
)

const clientTimestamp = expPoolRealDateToClientTimestamp(dateAt(-2 * MINUTE), legacyOffset)
assert.equal(
    clientTimestampToExpPoolRealDate(clientTimestamp, legacyOffset).getTime(),
    dateAt(-2 * MINUTE).getTime(),
    "client timestamps must round-trip through the virtual clock",
)

// 2026-10-17 线上事故：库里被写到 105000（高于当时写死的上限 100000），上限吃掉了
// 全部 earned，earned 归零后早退分支不落地，越界值永久留存；而客户端在 105000 之上
// 继续累积 → 注入永远 INSUFFICIENT_EXP（表现为等级乐观升级、下次 load 回滚）。
assert.deepEqual(
    calculatePooledExpAtRealTime(105000, dateAt(0), dateAt(0), 0),
    {
        expPool: 105000,
        expPooledTime: dateAt(0),
        earned: 0,
        repaired: false,
    },
    "a balance below the cap is untouched when no interval has elapsed",
)

assert.deepEqual(
    calculatePooledExpAtRealTime(1_050_000, dateAt(0), dateAt(0), 0),
    {
        expPool: EXP_POOL_MAX,
        expPooledTime: dateAt(0),
        earned: 0,
        repaired: true,
    },
    "a balance above the cap must be clamped and persisted even without accrual",
)

const caughtUp = calculatePooledExpAtRealTime(105000, dateAt(-15 * DAY), dateAt(0), 0)
assert.equal(caughtUp.expPool, 105000 + 15 * 24 * 60, "15 days of accrual is 21600 exp at 1/minute")
assert.equal(caughtUp.earned, 15 * 24 * 60, "the reported gain is the real pool growth")
assert.equal(caughtUp.repaired, false, "a normal catch-up is not a repair")

const saturated = calculatePooledExpAtRealTime(105000, dateAt(-700 * DAY), dateAt(0), 0)
assert.equal(saturated.expPool, EXP_POOL_MAX, "a long catch-up saturates at the cap")
assert.equal(saturated.earned, EXP_POOL_MAX - 105000, "the gain stops at the cap")
assert.equal(saturated.repaired, false, "a saturating catch-up is still not a repair")

// 2026-10-17 线上事故：服务端模拟时钟被设在 2025-08-01（offset≈-442 天），库里池被写到
// 105000（高于当时写死的上限 100000）而锚点 15 天未推进；客户端从自己最后收到的锚点
// 按 1/分钟累积到 126860 ⇒ 服务端必须把这段真实累积整额补上，否则注入被
// INSUFFICIENT_EXP 拒绝，客户端只做乐观升级、下次 load 回滚（用户报的「等级退回」）。
const SERVER_OFFSET_MS = -38192498512
const incident = calculatePooledExpAtRealTime(
    105000,
    new Date(REAL_NOW - 15 * DAY),
    dateAt(0),
    SERVER_OFFSET_MS,
)
assert.equal(incident.repaired, false, "a real anchor must not be rewritten when the clock is shifted")
assert.equal(incident.expPool, 105000 + 15 * 24 * 60, "the whole real catch-up must be granted")
assert.equal(incident.earned, 15 * 24 * 60, "the grant must match the client's render (126860 ±drift)")

console.log("exp pool time tests passed")
