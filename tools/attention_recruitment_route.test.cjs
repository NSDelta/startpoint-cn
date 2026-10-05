"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "attention-recruitment-route-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const attentionRoutes = require("../src/routes/api/attention").default
const { multiBattleRoutes } = require("../src/multi/http/register")
const { RecruitmentRegistry } = require("../src/multi/recruitment/registry")
const { EMBEDDED_COMPATIBILITY, EmbeddedMultiCoordinator } = require("../src/multi/coordinator/embedded")
const { createEmbeddedMultiHttpContext } = require("../src/multi/http/context")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const API = "/api/index.php"
const ATTENTION_CHECK = `${API}/attention/check`
const SHARE_ROOM = `${API}/multi_battle_quest/share_room`

// Any positive ints work here: the coordinator does not consult quest content on
// room creation, and the attention query compares the advertised ids against the
// live room rather than against a quest table.
const CATEGORY = 19
const QUEST_ID = 5_000_090_002

const HOST_VIEWER = 920_100_001
const GUEST_VIEWER = 920_100_002
const THIRD_VIEWER = 920_100_003
const STRANGER_VIEWER = 920_100_004

let app
let restoreContentSnapshot
let coordinator
let recruitmentRegistry
let multiContext
let hostPlayerId

/** One shared node session is what the embedded coordinator puts on every participant. */
function participant(viewerId) {
    return multiContext.snapshotProvider.getParticipant(viewerId)
}

function readData(response) {
    return unpack(Buffer.from(response.body, "base64")).data
}

/** Error replies are plain JSON; only success bodies go through the msgpack hook. */
function readReply(response) {
    if (response.body.startsWith("{")) return JSON.parse(response.body)
    return readData(response)
}

async function createAccount(viewerId) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `attention-recruitment-${viewerId}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    await insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return playerId
}

// The guest's room, rebuilt per test so the suite never shares board state.
let boardRoomNumber = null

/**
 * Creates a live 2-player room (host + guest) and returns the host's bells.
 * The room is created directly through the coordinator: HTTP room creation is a
 * different seam and is already covered elsewhere.
 */
async function openRecruitingRoom({ extraMembers = [] } = {}) {
    const created = await coordinator.createRoom({
        requestId: `attention-route-${randomUUID()}`,
        participant: participant(HOST_VIEWER),
        localPlayerId: hostPlayerId,
        partyId: 1,
        category: CATEGORY,
        questId: QUEST_ID,
        leaderCharacterId: 1,
        compatibility: EMBEDDED_COMPATIBILITY,
    })
    assert.equal(created.ok, true)
    boardRoomNumber = created.value.roomNumber

    if (extraMembers.length > 0) {
        const room = require("../src/multi/room/manager").getRoom(boardRoomNumber)
        for (const viewerId of extraMembers) {
            room.member_participants.push({ nodeSessionId: "embedded", viewerId })
        }
    }

    // `[3]` is the client's random-recruitment channel (MultiBattleRoomScene.shareRequestAPI).
    const shared = await app.inject({
        method: "POST",
        url: SHARE_ROOM,
        payload: {
            viewer_id: HOST_VIEWER,
            room_number: boardRoomNumber,
            category: CATEGORY,
            quest_id: QUEST_ID,
            share_type_list: [3],
            api_count: 1,
        },
    })
    assert.equal(shared.statusCode, 200, shared.body)
    return boardRoomNumber
}

async function check(viewerId, holdingNumber = 3) {
    const response = await app.inject({
        method: "POST",
        url: ATTENTION_CHECK,
        payload: { viewer_id: viewerId, holding_number: holdingNumber, retry_count: 0, request_number: 3 },
    })
    assert.equal(response.statusCode, 200, response.body)
    return readData(response)
}

async function disband(roomNumber) {
    await coordinator.disbandRoom({
        participant: participant(HOST_VIEWER),
        roomNumber,
    })
    boardRoomNumber = null
}

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    data.initializeDatabase()
    hostPlayerId = await createAccount(HOST_VIEWER)
    await createAccount(GUEST_VIEWER)
    await createAccount(THIRD_VIEWER)
    await createAccount(STRANGER_VIEWER)

    // Share the registry between the coordinator's disband hook and the HTTP
    // context, exactly like the production composition does.
    const registry = new RecruitmentRegistry()
    coordinator = new EmbeddedMultiCoordinator({
        onRoomDisband: roomNumber => registry.close(roomNumber),
    })
    multiContext = createEmbeddedMultiHttpContext({
        coordinator,
        recruitmentRegistry: registry,
    })
    recruitmentRegistry = registry

    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    app.register(attentionRoutes, {
        prefix: `${API}/attention`,
        multiContext: () => multiContext,
    })
    app.register(multiBattleRoutes, {
        prefix: `${API}/multi_battle_quest`,
        context: multiContext,
    })
    await app.ready()
})

test.afterEach(async () => {
    if (boardRoomNumber !== null) await disband(boardRoomNumber)
    recruitmentRegistry.clear()
})

test.after(async () => {
    await app.close()
    restoreContentSnapshot?.()
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("serves an empty multi list when nothing is recruiting", async () => {
    const payload = await check(GUEST_VIEWER)

    // A missing key would make the client treat the whole response as "no data";
    // an empty array is the documented "nothing right now".
    assert.deepEqual(payload.multi, [])
})

test("delivers the host's bell to another player after share_room", async () => {
    const roomNumber = await openRecruitingRoom()

    const payload = await check(GUEST_VIEWER)

    assert.equal(payload.multi.length, 1)
    const [notification] = payload.multi
    assert.match(notification.attention_key, /^wfcn-[0-9a-z]+-[0-9a-z]+-[0-9a-f]{8}$/)
    assert.equal(typeof notification.quest_info.host_entry_time, "number")
    assert.deepEqual(notification.quest_info, {
        category_id: CATEGORY,
        quest_id: QUEST_ID,
        room_number: roomNumber,
        // Default player: leaderCharacterId 1, rankPoint 0 -> rank level 1, tutorial not cleared.
        establisher_character: 1,
        establisher_character_evolution_img_level: 0,
        establisher_follow: 0,
        establisher_rank: 1,
        // Number, not string: the client's parser demands Float (ClientError 8701 otherwise).
        host_entry_time: notification.quest_info.host_entry_time,
        is_newbie: false,
    })
    assert.deepEqual(
        Object.keys(notification.quest_info).sort(),
        [
            "category_id",
            "establisher_character",
            "establisher_character_evolution_img_level",
            "establisher_follow",
            "establisher_rank",
            "host_entry_time",
            "is_newbie",
            "quest_id",
            "room_number",
        ],
    )

    // The advertised entry time is the live room's, not a value from the share call.
    const status = await coordinator.getRoomStatus({ participant: participant(HOST_VIEWER), roomNumber })
    assert.equal(status.ok, true)
    assert.equal(notification.quest_info.host_entry_time, status.value.hostEntryTime)
})

test("never shows a player their own recruiting room", async () => {
    await openRecruitingRoom()

    const payload = await check(HOST_VIEWER)

    assert.deepEqual(payload.multi, [])
})

test("respects the client's attention slot budget", async () => {
    await openRecruitingRoom()

    const full = await check(GUEST_VIEWER, 0)
    // The real client sends holding_number=3 and stops polling when its
    // three slots are occupied; a full bar must not be handed more bells.
    assert.deepEqual(full.multi, [])

    const roomy = await check(GUEST_VIEWER, 3)
    assert.equal(roomy.multi.length, 1)
})

test("hides a room that already has three players", async () => {
    await openRecruitingRoom({ extraMembers: [GUEST_VIEWER, THIRD_VIEWER] })

    const stranger = await check(STRANGER_VIEWER)
    assert.deepEqual(stranger.multi, [])

    // A player already inside keeps the bell, otherwise accepting/leaving the
    // room would tear down the host's card for them.
    const insider = await check(GUEST_VIEWER)
    assert.equal(insider.multi.length, 1)
})

test("a share without channel 3 retracts the bell", async () => {
    const roomNumber = await openRecruitingRoom()

    const closed = await app.inject({
        method: "POST",
        url: SHARE_ROOM,
        payload: {
            viewer_id: HOST_VIEWER,
            room_number: roomNumber,
            share_type_list: [],
            api_count: 1,
        },
    })
    assert.equal(closed.statusCode, 200, closed.body)

    const payload = await check(GUEST_VIEWER)
    assert.deepEqual(payload.multi, [])
})

test("keeps the same attention key while the host keeps re-sharing", async () => {
    const roomNumber = await openRecruitingRoom()
    const first = await check(GUEST_VIEWER)
    const key = first.multi[0].attention_key

    const reshared = await app.inject({
        method: "POST",
        url: SHARE_ROOM,
        payload: {
            viewer_id: HOST_VIEWER,
            room_number: roomNumber,
            share_type_list: [3],
            api_count: 2,
        },
    })
    assert.equal(reshared.statusCode, 200, reshared.body)

    const after = await check(GUEST_VIEWER)
    assert.equal(after.multi.length, 1)
    // The client matches EnterRoom notifications by key; a refresh must not
    // orphan a bell the player is already holding.
    assert.equal(after.multi[0].attention_key, key)
})

test("drops the bell when the room is disbanded", async () => {
    const roomNumber = await openRecruitingRoom()
    assert.equal((await check(GUEST_VIEWER)).multi.length, 1)

    await disband(roomNumber)

    assert.deepEqual((await check(GUEST_VIEWER)).multi, [])
})

test("rejects a share that advertises a different quest", async () => {
    const created = await coordinator.createRoom({
        requestId: `attention-route-mismatch-${randomUUID()}`,
        participant: participant(HOST_VIEWER),
        localPlayerId: hostPlayerId,
        partyId: 1,
        category: CATEGORY,
        questId: QUEST_ID,
        leaderCharacterId: 1,
        compatibility: EMBEDDED_COMPATIBILITY,
    })
    assert.equal(created.ok, true)
    boardRoomNumber = created.value.roomNumber

    const response = await app.inject({
        method: "POST",
        url: SHARE_ROOM,
        payload: {
            viewer_id: HOST_VIEWER,
            room_number: boardRoomNumber,
            share_type_list: [3],
            quest_id: QUEST_ID + 1,
            api_count: 1,
        },
    })

    assert.equal(response.statusCode, 400)
    assert.equal(readReply(response).message, "Room quest mismatch.")
    // A rejected share must not have opened a bell.
    assert.deepEqual((await check(GUEST_VIEWER)).multi, [])
})
