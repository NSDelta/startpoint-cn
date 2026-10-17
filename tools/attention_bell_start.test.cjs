"use strict"

// multi /start（quest/start multi）铃铛进房解析语义回归：
// resolveBellRecruitmentForStart 接受 open 招募，或**停止招募后仍在宽限窗内**的
// 关闭行（对齐参考实现 Ku1o/startpoint-cn-kulo 的 stopped-notice），两者都要求
// (room_number, 房主) 与当前战斗完全一致、且该 viewer 持有效投递行（T2 门票，
// 批次一：delivered/accepted 持票、declined/缺失无票——attention_key 只经 check
// 下发，无票即伪造）；防伪 key / 跨房间 key / 过期 / 宽限窗外一律 fail-open 为 null
// （退回实时 isNewbieHostSync 判定，不影响正常开战）。

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const restore = require("./helpers/install-bundled-gameplay-snapshot.cjs").installBundledGameplaySnapshot()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attention-bell-start-"))
process.env.WDFP_DATABASE_DIR = dir
let db

function cleanup() {
    if (db?.open) db.close()
    restore()
    fs.rmSync(dir, { recursive: true, force: true })
}
process.once("exit", cleanup)

const { initializeDatabase } = require("../src/data")
const { getDb } = require("../src/data/db")
initializeDatabase()
db = getDb()

const {
    STOPPED_NOTICE_GRACE_MS,
    buildEstablisherSnapshot,
    closeRecruitmentForRoom,
    deliverOpenRecruitmentsToViewer,
    getOrCreateRecruitmentForRoom,
    recordResponse,
} = require("../src/data/domains/attention")
const { resolveBellRecruitmentForStart } = require("../src/multi/http/battle")
// 被测代码内部用 getServerTime()*1000（虚拟钟）取时，测试造数必须同域，
// 否则一旦测试环境设置 timeOffset 就会以"招募过期"的方式碎掉
const { getServerTime } = require("../src/utils")

const HOST_VIEWER = 9501
const HOST_PID = 501
const ROOM = "998877"
const GUEST_VIEWER = 9500
const nowMs = getServerTime() * 1000

const recruitment = getOrCreateRecruitmentForRoom({
    hostPid: HOST_PID,
    hostViewerId: HOST_VIEWER,
    category: 1,
    questId: 1001001,
    roomNumber: ROOM,
    isNewbieHost: true,
    establisherJson: buildEstablisherSnapshot({ character: 341005, rankLevel: 42, hostEntryTime: 1700 }),
    nowMs,
})

// guest 轮询 check 领票（惰性投递造有效投递行）
const delivered = deliverOpenRecruitmentsToViewer(GUEST_VIEWER, nowMs + 1, 3)
assert.equal(delivered.length, 1, "guest 轮询即收到本房铃铛")

// null / 空 key → null
assert.equal(resolveBellRecruitmentForStart(null, ROOM, HOST_VIEWER, GUEST_VIEWER), null)

// 未知 key → null（防伪造）
assert.equal(resolveBellRecruitmentForStart("attention_000000_1", ROOM, HOST_VIEWER, GUEST_VIEWER), null)

// 有效 key + 投递行 + 房间/房主一致 → 招募
const matched = resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, GUEST_VIEWER)
assert.ok(matched !== null)
assert.equal(matched.id, recruitment.id)
assert.equal(matched.isNewbieHost, true, "cond92 冻结来源必须是招募行的 is_newbie_host")

// 无投递行的 viewer 持同一 key → null（T2：key 不可转借）
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, 9599), null,
    "无投递行的 key 是伪造票")

// declined → 无票
recordResponse(recruitment.id, GUEST_VIEWER, "declined", nowMs + 2)
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, GUEST_VIEWER), null,
    "declined 拒绝过的不算有效门票")

// 房间号不一致（拿 A 房 key 开 B 房）→ null
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, "112233", HOST_VIEWER, GUEST_VIEWER), null)

// 房主不一致（拿 A 房主的 key 加入 B 房主）→ null；B 房投递行持有者正常
const otherHost = getOrCreateRecruitmentForRoom({
    hostPid: 502, hostViewerId: 9502, category: 1, questId: 1001001,
    roomNumber: "445566", isNewbieHost: false, establisherJson: "{}", nowMs,
})
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, "445566", 9502, GUEST_VIEWER), null)
const otherGuest = 9503
const otherDelivered = deliverOpenRecruitmentsToViewer(otherGuest, nowMs + 3, 3)
assert.ok(otherDelivered.some(bell => bell.id === otherHost.id), "其他 guest 可领到 B 房铃铛")
assert.ok(
    resolveBellRecruitmentForStart(otherHost.attentionKey, "445566", 9502, otherGuest) !== null,
    "持 B 房投递行的 guest 正常进房",
)

// 宽限窗不等于免票：ROOM 的 guest 此前已 declined，关闭后仍是 null
closeRecruitmentForRoom(HOST_VIEWER, ROOM, nowMs)
assert.equal(resolveBellRecruitmentForStart(recruitment.attentionKey, ROOM, HOST_VIEWER, GUEST_VIEWER), null,
    "declined 过的 viewer 不因宽限窗获得门票")

// 停止招募 → 宽限窗内仍可进房（对齐参考实现 Ku1o/startpoint-cn-kulo 的
// stopped-notice：房主停铃与 guest 点击之间存在真实竞态，立即失效会让
// "点了却进不去"的玩家看到通用失败），窗口外彻底失效。
closeRecruitmentForRoom(9502, "445566", nowMs)
const withinGrace = resolveBellRecruitmentForStart(otherHost.attentionKey, "445566", 9502, otherGuest)
assert.ok(withinGrace !== null, "停止招募后宽限窗内，已投递 guest 仍可凭 key 进房")
assert.equal(withinGrace.status, "closed", "宽限票来自已关闭的招募行")
assert.equal(
    resolveBellRecruitmentForStart(
        otherHost.attentionKey, "445566", 9502, otherGuest,
        nowMs + STOPPED_NOTICE_GRACE_MS + 1,
    ),
    null,
    "宽限窗结束后该 key 必须失效",
)

// 停止招募后不再新投递（宽限只服务"已经收到铃铛的人"）
const lateGuest = 9504
assert.equal(
    deliverOpenRecruitmentsToViewer(lateGuest, nowMs + 5, 3).some(bell => bell.id === otherHost.id),
    false,
    "已关闭的招募不得再次投递给新的 guest",
)

console.log("attention bell start: all assertions passed")
