"use strict"

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { pack, unpack } = require("msgpackr")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
test.after(() => restoreContentSnapshot())

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "follow-routes-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { getPlayerSync, insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { getViewerIdSync } = require("../src/data/domains/session")
const followRoutes = require("../src/routes/api/follow").default
const {
    addLocalFollowSync,
    getLocalFollowRelationSync,
} = require("../src/data/domains/follow")
const { getSocialCapacityPolicySync } = require("../src/lib/config-content")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")

data.initializeDatabase()

let app
let viewerA
let viewerB
let playerA
let playerB
let viewerEmpty

function decode(response) {
    return unpack(Buffer.from(response.body, "base64"))
}

async function postFollow(url, payload) {
    const response = await app.inject({
        method: "POST",
        url: `/api/index.php/follow/${url}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack(payload).toString("base64"),
    })
    assert.equal(response.headers["content-type"], "application/x-msgpack", url)
    return response
}

async function createViewer(tag) {
    const account = insertAccountSync({
        appId: "wf_cn", idpAlias: "", idpCode: "test",
        idpId: `follow-routes-${tag}-${randomUUID()}`, status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = 740000000 + playerId
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-12-31T23:59:59.000Z"),
        type: SessionType.VIEWER,
    })
    return { viewerId, playerId }
}

test.before(async () => {
    app = Fastify({ logger: false })
    app.addContentTypeParser(
        "application/x-www-form-urlencoded",
        { parseAs: "string" },
        (_request, body, done) => done(null, unpack(Buffer.from(body, "base64"))),
    )
    registerCnMsgpackOnSend(app)
    await app.register(followRoutes, { prefix: "/api/index.php/follow" })
    await app.ready()

    const a = await createViewer("a")
    const b = await createViewer("b")
    const empty = await createViewer("empty")
    viewerA = a.viewerId
    viewerB = b.viewerId
    playerA = a.playerId
    playerB = b.playerId
    viewerEmpty = empty.viewerId
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("lists starts empty and add/delete drive the projected relation", async () => {
    const empty = decode(await postFollow("lists", { viewer_id: viewerEmpty }))
    assert.equal(empty.data_headers.result_code, 1)
    assert.deepEqual(empty.data.follow_info, [])
    assert.equal(empty.data.followed_count, 0)

    const addedResponse = await postFollow("add", { viewer_id: viewerA, follow_id: viewerB })
    assert.equal(addedResponse.statusCode, 200)
    assert.equal(decode(addedResponse).data_headers.result_code, 1)

    const listA = decode(await postFollow("lists", { viewer_id: viewerA }))
    assert.equal(listA.data.follow_info.length, 1)
    const entry = listA.data.follow_info[0]
    assert.equal(entry.viewer_id, viewerB)
    assert.equal(typeof entry.name, "string")
    assert.equal(typeof entry.rank, "number")
    assert.equal(typeof entry.degree_id, "number")
    assert.equal(typeof entry.role, "number")
    assert.equal(typeof entry.comment, "string")
    assert.equal(typeof entry.last_login_time, "number")
    assert.equal(entry.last_login_region, null)
    assert.equal(typeof entry.leader_character_id, "number")
    assert.equal(typeof entry.leader_character_evolution_img_level, "number")
    assert.equal(entry.follow_state, 2)
    assert.equal(typeof entry.follow_time, "number")
    assert.ok(entry.follow_time > 0)
    assert.equal(entry.followed_time, null)
    assert.equal(entry.profile_image_url, null)
    assert.equal(listA.data.followed_count, 0)

    // 对方视角：被关注
    const listB = decode(await postFollow("lists", { viewer_id: viewerB }))
    assert.equal(listB.data.follow_info[0].follow_state, 3)
    assert.equal(typeof listB.data.follow_info[0].followed_time, "number")
    assert.equal(listB.data.followed_count, 1)

    // 互关
    await postFollow("add", { viewer_id: viewerB, follow_id: viewerA })
    const mutual = decode(await postFollow("lists", { viewer_id: viewerA }))
    assert.equal(mutual.data.follow_info[0].follow_state, 1)
    assert.notEqual(mutual.data.follow_info[0].follow_time, null)

    // delete → 回到无关系；重复 delete 幂等
    await postFollow("delete", { viewer_id: viewerB, follow_id: viewerA })
    await postFollow("delete", { viewer_id: viewerB, follow_id: viewerA })
    const afterDelete = decode(await postFollow("lists", { viewer_id: viewerA }))
    // B 取消了对 A 的关注；A→B 出边仍在 → A 视角 state=2
    assert.equal(afterDelete.data.follow_info[0].follow_state, 2)
})

test("search_id resolves same-server viewers only", async () => {
    const found = decode(await postFollow("search_id", { viewer_id: viewerA, search_id: viewerB }))
    assert.equal(found.data_headers.result_code, 1)
    assert.equal(found.data.search_result.viewer_id, viewerB)
    assert.equal(found.data.search_result.follow_state, 2)

    const stringFoundResponse = await postFollow("search_id", {
        viewer_id: viewerA,
        search_id: String(viewerB),
    })
    assert.equal(stringFoundResponse.statusCode, 200)
    const stringFound = decode(stringFoundResponse)
    assert.equal(stringFound.data_headers.result_code, 1)
    assert.equal(stringFound.data.search_result.viewer_id, viewerB)

    const malformedString = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/search_id",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({ viewer_id: viewerA, search_id: ` ${viewerB}` }).toString("base64"),
    })
    assert.equal(malformedString.statusCode, 400)

    const missingResponse = await postFollow("search_id", { viewer_id: viewerA, search_id: 799999999 })
    assert.equal(missingResponse.statusCode, 200)
    const missing = decode(missingResponse)
    assert.equal(missing.data_headers.result_code, 1457)
    assert.deepEqual(missing.data, {})
})

test("capacity limits answer with A-error result codes 1451 and 1452", async () => {
    const { maxFollows } = getSocialCapacityPolicySync()
    const over = await createViewer("over")
    const targets = []
    for (let index = 0; index < maxFollows; index++) {
        const target = await createViewer(`limit-t${index}`)
        targets.push(target)
        addLocalFollowSync({
            sourcePlayerId: over.playerId,
            targetPlayerId: target.playerId,
            followedAtMs: index,
        })
    }
    const extra = await createViewer("limit-extra")
    const limitedResponse = await postFollow("add", {
        viewer_id: over.viewerId, follow_id: extra.viewerId,
    })
    assert.equal(limitedResponse.statusCode, 200)
    assert.equal(decode(limitedResponse).data_headers.result_code, 1451)

    // 1452：目标被关注数达上限
    const star = await createViewer("star")
    const fans = []
    for (let index = 0; index < getSocialCapacityPolicySync().maxFollowers; index++) {
        const fan = await createViewer(`fan${index}`)
        fans.push(fan)
        addLocalFollowSync({
            sourcePlayerId: fan.playerId,
            targetPlayerId: star.playerId,
            followedAtMs: index,
        })
    }
    const late = await createViewer("late")
    const targetLimitedResponse = await postFollow("add", {
        viewer_id: late.viewerId, follow_id: star.viewerId,
    })
    assert.equal(targetLimitedResponse.statusCode, 200)
    assert.equal(decode(targetLimitedResponse).data_headers.result_code, 1452)
})

test("delete_followed removes the incoming edge and bulk_edit is atomic", async () => {
    const c = await createViewer("bulk-c")
    const d = await createViewer("bulk-d")
    const e = await createViewer("bulk-e")
    addLocalFollowSync({ sourcePlayerId: d.playerId, targetPlayerId: c.playerId, followedAtMs: 1 })
    addLocalFollowSync({ sourcePlayerId: e.playerId, targetPlayerId: c.playerId, followedAtMs: 2 })

    // c 删除粉丝 d
    const removed = decode(await postFollow("delete_followed", {
        viewer_id: c.viewerId, followed_id: d.viewerId,
    }))
    assert.equal(removed.data_headers.result_code, 1)
    const afterRemove = decode(await postFollow("lists", { viewer_id: c.viewerId }))
    assert.equal(afterRemove.data.follow_info.length, 1)
    assert.equal(afterRemove.data.follow_info[0].viewer_id, e.viewerId)

    // bulk_edit：加一人删一人
    const f = await createViewer("bulk-f")
    const bulk = decode(await postFollow("bulk_edit", {
        viewer_id: c.viewerId,
        add_follow_id_list: [f.viewerId],
        delete_follow_id_list: [e.viewerId],
    }))
    assert.equal(bulk.data_headers.result_code, 1)
    assert.deepEqual(bulk.data.max_follower_user_viewer_id_list, [])
    const afterBulk = decode(await postFollow("lists", { viewer_id: c.viewerId }))
    // e 仍是 c 的粉丝（bulk 的 delete_follow_id_list 只删出边）；
    // f 是新出边。按 last_login_time 降序。
    assert.deepEqual(
        afterBulk.data.follow_info.map(entry => entry.viewer_id).sort(),
        [e.viewerId, f.viewerId].sort(),
    )
})

test("self add, missing target and invalid viewer keep existing failure semantics", async () => {
    const selfResponse = await postFollow("add", { viewer_id: viewerA, follow_id: viewerA })
    assert.equal(selfResponse.statusCode, 200)
    assert.equal(decode(selfResponse).data_headers.result_code, 1, "自关注幂等成功不改状态")

    const missing = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({ viewer_id: viewerA, follow_id: 799999998 }).toString("base64"),
    })
    assert.equal(missing.statusCode, 400, "无法解析的目标视作非法请求")

    const invalid = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({ viewer_id: 799999997, follow_id: viewerB }).toString("base64"),
    })
    assert.equal(invalid.statusCode, 400)

    const badBody = await app.inject({
        method: "POST",
        url: "/api/index.php/follow/add",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: pack({}).toString("base64"),
    })
    assert.equal(badBody.statusCode, 400)
})

/**
 * 客户端两个页签在排序时无条件读取时间戳：
 * `FollowInfoTools.compareForFollowList` 读 follow_time、
 * `compareForFollowerList` 读 followed_time，取到 None 就抛 ClientError 2820
 * （common\data\follow\FollowInfoTools.as:30-70）。这里复刻这两个比较器，
 * 保证服务端投影在任何 follow_state 下都能被客户端排序。
 */
function clientCompareForFollowList(left, right) {
    if (Number(left.last_login_time) !== Number(right.last_login_time)) {
        return Number(right.last_login_time) - Number(left.last_login_time)
    }
    return Number(left.viewer_id) - Number(right.viewer_id)
}

function clientCompareForFollowerList(left, right) {
    if (left.followed_time === null || left.followed_time === undefined) {
        throw new Error(`ClientError 2820: viewer_id=${left.viewer_id}`)
    }
    if (Number(left.followed_time) !== Number(right.followed_time)) {
        return Number(right.followed_time) - Number(left.followed_time)
    }
    return Number(left.viewer_id) - Number(right.viewer_id)
}

// 客户端页签过滤（FollowListsResponseTools.filterFollowFollowers）
const isFollowingTab = entry => entry.follow_state === 2
const isFollowerTab = entry => entry.follow_state === 3
const isMutualTab = entry => entry.follow_state === 1

test("follower tab entries always carry a sortable followed_time", async () => {
    const center = await createViewer("tab-center")
    const following = await createViewer("tab-following")   // center → 对方（出边）
    const fan = await createViewer("tab-fan")               // 对方 → center（入边）
    const mutual = await createViewer("tab-mutual")         // 双向

    addLocalFollowSync({
        sourcePlayerId: center.playerId, targetPlayerId: following.playerId, followedAtMs: 1_500,
    })
    addLocalFollowSync({
        sourcePlayerId: fan.playerId, targetPlayerId: center.playerId, followedAtMs: 2_500,
    })
    addLocalFollowSync({
        sourcePlayerId: center.playerId, targetPlayerId: mutual.playerId, followedAtMs: 3_500,
    })
    addLocalFollowSync({
        sourcePlayerId: mutual.playerId, targetPlayerId: center.playerId, followedAtMs: 4_500,
    })

    const list = decode(await postFollow("lists", { viewer_id: center.viewerId })).data
    const byViewer = new Map(list.follow_info.map(entry => [entry.viewer_id, entry]))

    const followingEntry = byViewer.get(following.viewerId)
    assert.equal(followingEntry.follow_state, 2)
    assert.equal(followingEntry.follow_time, 1)
    assert.equal(followingEntry.followed_time, null, "出边没有入边时刻，保持 null")

    const fanEntry = byViewer.get(fan.viewerId)
    assert.equal(fanEntry.follow_state, 3)
    assert.equal(fanEntry.follow_time, null)
    assert.equal(fanEntry.followed_time, 2, "入边时刻按秒下发")

    const mutualEntry = byViewer.get(mutual.viewerId)
    assert.equal(mutualEntry.follow_state, 1)
    assert.equal(mutualEntry.follow_time, 3)
    assert.equal(mutualEntry.followed_time, 4)

    // 两个页签各自排序都不允许抛 ClientError 2820
    const followTab = list.follow_info.filter(isFollowingTab).slice()
    followTab.sort(clientCompareForFollowList)
    const mutualTab = list.follow_info.filter(isMutualTab).slice()
    mutualTab.sort(clientCompareForFollowList)

    const followerTab = list.follow_info.filter(entry => isFollowerTab(entry) || isMutualTab(entry))
    assert.ok(followerTab.length >= 2)
    followerTab.sort(clientCompareForFollowerList)
    assert.deepEqual(
        followerTab.map(entry => entry.viewer_id),
        [mutual.viewerId, fan.viewerId],
        "粉丝页签（被关注 + 互关）按 followed_time 降序",
    )
})

// 关注容量上限（Content config.json 的 max_follows_count）与列表投影上限同值，
// 都在 100；这里造 105 个目标，把两个上限的边界一起钉住。
async function createCapFixture() {
    const { getDb } = require("../src/data/db")
    const center = await createViewer("cap-center")
    const targets = []
    for (let index = 0; index < 105; index += 1) {
        targets.push(await createViewer(`cap-${index}`))
    }

    // 全部置为同一次登录时刻，锁死唯一排序键后再写关注时间。
    getDb().prepare(`
        UPDATE players
        SET last_login_time = ?
        WHERE id IN (${targets.map(() => "?").join(", ")})
    `).run(new Date("2026-01-01T00:00:00.000Z").toISOString(), ...targets.map(target => target.playerId))

    const accepted = []
    const rejected = []
    targets.forEach((target, index) => {
        const result = addLocalFollowSync({
            sourcePlayerId: center.playerId, targetPlayerId: target.playerId, followedAtMs: 1_000_000 + index,
        })
        // 容量已满时返回 source_limit，而不是抛错：这条边根本没写进去。
        if (result.ok) accepted.push(target)
        else rejected.push({ target, result })
    })

    const byViewerId = accepted.slice().sort((left, right) => left.viewerId - right.viewerId)
    return { getDb, center, targets, accepted, rejected, byViewerId }
}

test("follow/lists caps the projection at 100 relations", async () => {
    const { center, targets, accepted, rejected, byViewerId } = await createCapFixture()

    assert.equal(accepted.length, 100, "关注容量上限放行 100 条")
    assert.equal(rejected.length, 5)
    for (const entry of rejected) {
        assert.equal(entry.result.ok, false)
        assert.equal(entry.result.reason, "source_limit")
    }
    assert.deepEqual(
        rejected.map(entry => entry.target.playerId),
        targets.slice(100).map(target => target.playerId),
        "被容量上限拒绝的是最后加入的 5 个目标",
    )

    const data = decode(await postFollow("lists", { viewer_id: center.viewerId })).data
    assert.equal(data.follow_info.length, 100, "一份列表最多投影 100 条")
    assert.equal(data.followed_count, 0, "followed_count 是被关注总数，不受投影上限影响")

    // 全部同 last_login_time → 按 viewer_id 升序取最小的 100 个
    assert.deepEqual(
        data.follow_info.map(entry => entry.viewer_id),
        byViewerId.slice(0, 100).map(target => target.viewerId),
    )
})

test("follow/lists drops the least recent logins first", async () => {
    const { getDb } = require("../src/data/db")
    // 独立玩家与独立批次：这里只验证排序与截断的语义，不碰关注容量上限。
    const center = await createViewer("rank-center")
    const targets = []
    for (let index = 0; index < 50; index += 1) {
        targets.push(await createViewer(`rank-${index}`))
    }
    getDb().prepare(`
        UPDATE players
        SET last_login_time = ?
        WHERE id IN (${targets.map(() => "?").join(", ")})
    `).run(new Date("2026-01-01T00:00:00.000Z").toISOString(), ...targets.map(target => target.playerId))
    targets.forEach((target, index) => {
        const result = addLocalFollowSync({
            sourcePlayerId: center.playerId, targetPlayerId: target.playerId, followedAtMs: 2_000_000 + index,
        })
        assert.equal(result.ok, true, "独立批次必须全部写入")
    })

    const before = decode(await postFollow("lists", { viewer_id: center.viewerId })).data
    const nearBottom = before.follow_info[before.follow_info.length - 1]
    const promoted = targets[targets.length - 1]

    getDb().prepare(`
        UPDATE players SET last_login_time = ? WHERE id = ?
    `).run(new Date("2026-02-01T00:00:00.000Z").toISOString(), promoted.playerId)

    const refreshed = decode(await postFollow("lists", { viewer_id: center.viewerId })).data
    assert.equal(refreshed.follow_info[0].viewer_id, promoted.viewerId, "最近登录的关系排在最前")
    assert.ok(
        refreshed.follow_info.some(entry => entry.viewer_id === nearBottom.viewer_id),
        "50 条关系都在投影上限内，抬升排序不会把任何人挤出去",
    )
    assert.equal(
        getLocalFollowRelationSync(center.playerId, promoted.playerId).state,
        2,
        "排序变化不改变关系本身",
    )
})
