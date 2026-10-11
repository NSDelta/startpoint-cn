"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const {
    prepareFailureRaisingState,
    projectRoomRaisingState,
    restoreRoomUnavailableRaisingState,
    roomUnavailableRaisingState,
} = require("../src/multi/http/join-result.ts")
const {
    createRoom,
    disbandRoom,
    getRoom,
    updateRoomState,
} = require("../src/multi/room/manager")
const { sessionManager } = require("../src/multi/state/SessionManager")
const { RoomState } = require("../src/multi/types")
const { multiBattleRoutes } = require("../src/multi/http/register")
const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const {
    EMBEDDED_COMPATIBILITY,
    EmbeddedMultiCoordinator,
} = require("../src/multi/coordinator/embedded")

const HOST_VIEWER = 8100001
const GUEST_VIEWER = 8100002
const STRANGER_VIEWER = 8100003

function participant(viewerId) {
    return { nodeSessionId: "embedded", viewerId }
}

function roomStatus(overrides = {}) {
    return {
        roomNumber: "8100001",
        accessToken: "token",
        category: 1,
        questId: 5101,
        hostEntryTime: 0,
        roomSequence: 1,
        raisingState: 1,
        shareRoomOptions: 0,
        hostMainCharacterId: 1,
        isNpcMode: false,
        hostOnline: false,
        host: participant(HOST_VIEWER),
        members: [],
        compatibility: EMBEDDED_COMPATIBILITY,
        ...overrides,
    }
}

function createOwnerRoom(t) {
    const room = createRoom(8100001, 1, 1, 1, 5101, 0, 1, true)
    t.after(() => disbandRoom(room.room_number))
    return room
}

// CN 1.8.1 MultiBattleQuestPrepareRealRemote：raising_state 仅 1/2/9 合法
//（3/4/7/8/10/11/12/13 抛 ClientError 5001）；其余失败走 A-error
// 4503/4507/4509 → RoomDataNotFound/Failure/RoomDataPeriodOutdated。
test("prepare failure mapping never emits a fatal raising_state", () => {
    assert.equal(prepareFailureRaisingState("ROOM_NOT_FOUND"), 9)
    assert.equal(prepareFailureRaisingState("ROOM_FULL"), null, "满房必须走 4507 A-error，不得回 raising_state 3")
    assert.equal(prepareFailureRaisingState("ROOM_MEMBER_MISMATCH"), null)
    assert.equal(prepareFailureRaisingState("HUB_UNAVAILABLE"), null)
    assert.equal(prepareFailureRaisingState("QUEST_NOT_AVAILABLE"), null)
})

// CN 1.8.1 MultiBattleQuestSelectRoomRealRemote：1/2/3/4/7/8/9/10/11/12 全部合法
//（3=Filled、7=NotPlayable、13 才致命）。
test("select_room failure mapping keeps client-legal states", () => {
    assert.equal(roomUnavailableRaisingState("ROOM_NOT_FOUND"), 9)
    assert.equal(roomUnavailableRaisingState("ROOM_FULL"), 3)
    assert.equal(roomUnavailableRaisingState("ROOM_MEMBER_MISMATCH"), 7)
    assert.equal(roomUnavailableRaisingState("QUEST_NOT_AVAILABLE"), 7)
})

// CN 1.8.1 MultiBattleQuestRestoreRoomRealRemote：9=Disbanded、13=NotMate 合法。
test("restore_room failure mapping uses disbanded and not-mate states", () => {
    assert.equal(restoreRoomUnavailableRaisingState("ROOM_NOT_FOUND"), 9)
    assert.equal(restoreRoomUnavailableRaisingState("ROOM_FULL"), 13)
    assert.equal(restoreRoomUnavailableRaisingState("ROOM_MEMBER_MISMATCH"), 13)
})

test("multi HTTP sources use the endpoint-specific mappings", () => {
    const roomSource = fs.readFileSync(
        path.join(__dirname, "../src/multi/http/room.ts"), "utf8")
    const lobbySource = fs.readFileSync(
        path.join(__dirname, "../src/multi/http/lobby.ts"), "utf8")

    // prepare 只接受 ROOM_NOT_FOUND 的 9；其余错误一律 4507 result_code
    assert.match(roomSource, /prepareFailureRaisingState\(/)
    assert.doesNotMatch(
        roomSource.split("fastify.post(\"/summon\"")[0],
        /ROOM_NOT_FOUND" \|\| error === "ROOM_FULL"/,
        "prepareFailure 不得再把 ROOM_FULL 映射为 raising_state",
    )
    // select_room 保持通用映射（3/7/9 对该端点合法）
    assert.match(lobbySource, /roomUnavailableRaisingState\(room\.error\)/)
    // restore_room 使用 9/13 专用映射
    assert.match(roomSource, /restoreRoomUnavailableRaisingState\(/)
    // 三处回房投影（prepare / restore_room / select_room）都必须走 projectRoomRaisingState，
    // 否则「已在房内的成员」还是会拿到 2，并在 15 秒后判 Failure。
    assert.equal(
        (roomSource.match(/projectRoomRaisingState\(/g) ?? []).length >= 2,
        true,
        "prepare 与 restore_room 都必须用共享的投影",
    )
    assert.match(lobbySource, /projectRoomRaisingState\(/)
    assert.doesNotMatch(
        roomSource.split("fastify.post(\"/summon\"")[0],
        /data\.raising_state = 2/,
        "不得再手写 raising_state 2 的等待分支",
    )
})

test("room owner persists only raising_state 1/2/4 through the state machine", t => {
    const room = createOwnerRoom(t)
    assert.equal(room.raising_state, 2)
    const machine = sessionManager.getRoomState(room.room_number)
    assert.equal(machine.getState(), RoomState.Filled)

    assert.equal(updateRoomState(room.room_number, 1), true)
    assert.equal(room.raising_state, 1)
    assert.equal(machine.getState(), RoomState.Ready)

    assert.equal(updateRoomState(room.room_number, 4), true)
    assert.equal(room.raising_state, 4)
    assert.equal(machine.getState(), RoomState.Battle)

    assert.equal(updateRoomState(room.room_number, 1), true)
    assert.equal(room.raising_state, 1)
    assert.equal(machine.getState(), RoomState.Ready)

    assert.equal(updateRoomState(room.room_number, 1), true, "same-state rewrite stays legal")
})

test("unknown raising states fail closed without touching the room or machine", t => {
    const room = createOwnerRoom(t)
    assert.equal(updateRoomState(room.room_number, 4), true)
    const machine = sessionManager.getRoomState(room.room_number)
    const raisingBefore = room.raising_state
    const machineBefore = machine.getState()

    for (const bad of [0, 3, 7, 9, 13, 99, 2.5, Number.NaN, "4", null, undefined]) {
        assert.equal(
            updateRoomState(room.room_number, bad),
            false,
            `state=${String(bad)} must fail closed`,
        )
        assert.equal(room.raising_state, raisingBefore, `state=${String(bad)} must not touch the room`)
        assert.equal(machine.getState(), machineBefore, `state=${String(bad)} must not touch the machine`)
    }
})

test("room owner keeps the persistable state union exhaustive and typed", () => {
    const managerSource = fs.readFileSync(
        path.join(__dirname, "../src/multi/room/manager.ts"), "utf8")
    assert.match(managerSource, /PersistentRaisingState/)
    assert.doesNotMatch(
        managerSource,
        /export function updateRoomState\(roomNumber: string, state: number\)/,
        "updateRoomState must not accept an untyped state",
    )
})

// ---- 回房（return to room）投影 ----
// 战斗中客户端会主动断掉房间 socket（只有房间场景保活），队长必然被判 hostOnline=false。
// 若回来的队友仍被投影成 2，客户端轮询 5 次(约 15 秒)后判 Failure → 上报
// multi_battle_quest/create_room_failure → 该路由缺失时 404 → 玩家看到 (No.H404)。
test("returning members are admitted instead of polling for an offline host", () => {
    const member = roomStatus({ members: [participant(GUEST_VIEWER)] })

    assert.deepEqual(projectRoomRaisingState(member, HOST_VIEWER), {
        raisingState: 1,
        hostOffline: false,
        returningMember: false,
    })
    assert.deepEqual(projectRoomRaisingState(member, GUEST_VIEWER), {
        raisingState: 1,
        hostOffline: false,
        returningMember: true,
    })
    // 真正的新加入者维持原语义：等队长上线
    assert.deepEqual(projectRoomRaisingState(member, STRANGER_VIEWER), {
        raisingState: 2,
        hostOffline: true,
        returningMember: false,
    })

    // 房间停在 4（战斗释放中，prepare 流里 4 会抛 ClientError 5001）时成员照样放行
    const releasing = roomStatus({
        raisingState: 4,
        members: [participant(GUEST_VIEWER)],
    })
    assert.equal(projectRoomRaisingState(releasing, GUEST_VIEWER).raisingState, 1)
    // 新加入者在队长离线时仍然是 2（等待语义原样保留；房间自身的 4 不投影给等待者）
    const waiting = projectRoomRaisingState(releasing, STRANGER_VIEWER)
    assert.equal(waiting.raisingState, 2)
    assert.equal(waiting.hostOffline, true)

    // 队长在线时非成员沿用房间自身状态（不引入新的 1/2 抖动）
    const online = roomStatus({ hostOnline: true, raisingState: 4 })
    assert.deepEqual(projectRoomRaisingState(online, STRANGER_VIEWER), {
        raisingState: 4,
        hostOffline: false,
        returningMember: false,
    })
})

test("a real room status admits the returning guest while the host has no lobby client", async t => {
    const coordinator = new EmbeddedMultiCoordinator()
    const created = await coordinator.createRoom({
        requestId: "raising-state-returning-member",
        participant: participant(HOST_VIEWER),
        localPlayerId: 1,
        partyId: 1,
        category: 19,
        questId: 5_000_090_002,
        leaderCharacterId: 1,
        compatibility: EMBEDDED_COMPATIBILITY,
    })
    assert.equal(created.ok, true, JSON.stringify(created))
    const roomNumber = created.value.roomNumber
    t.after(() => coordinator.disbandRoom({ participant: participant(HOST_VIEWER), roomNumber }))

    // 队友仍登记在房内（战斗中不会掉出成员表），而队长此刻没有任何 lobby socket。
    getRoom(roomNumber).member_participants.push(participant(GUEST_VIEWER))

    const status = await coordinator.getRoomStatus({
        participant: participant(GUEST_VIEWER),
        roomNumber,
    })
    assert.equal(status.ok, true, JSON.stringify(status))
    assert.equal(status.value.hostOnline, false, "队长在战斗中必然被判 host offline")
    assert.equal(status.value.raisingState, created.value.raisingState)
    assert.deepEqual(projectRoomRaisingState(status.value, GUEST_VIEWER), {
        raisingState: 1,
        hostOffline: false,
        returningMember: true,
    })
    assert.equal(
        projectRoomRaisingState(status.value, STRANGER_VIEWER).raisingState,
        2,
    )
})

// 客户端在「回房间失败」时用 sendOnlyUserRequest 上报这条(不解析响应体,但 4xx 仍会
// 变成玩家可见的错误弹窗)。缺它 → 404 → 「发生意想不到的错误 回到登录界面 (No.H404)」。
test("create_room_failure is served as an ack so a failed return never becomes No.H404", async t => {
    const app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app)
    // 这条路由只做 ack，不碰 context，用最小桩即可。
    app.register(multiBattleRoutes, {
        prefix: "/api/index.php/multi_battle_quest",
        context: {},
    })
    await app.ready()
    t.after(() => app.close())

    for (const payload of [{ viewer_id: HOST_VIEWER, type: "prepare" }, {}, { viewer_id: "8100001" }]) {
        const response = await app.inject({
            method: "POST",
            url: "/api/index.php/multi_battle_quest/create_room_failure",
            payload,
        })
        assert.equal(response.statusCode, 200, `${JSON.stringify(payload)} → ${response.body}`)
        assert.match(response.headers["content-type"], /application\/x-msgpack/)
        const body = unpack(Buffer.from(response.body, "base64"))
        assert.equal(body.data_headers.result_code, 1)
        assert.deepEqual(body.data, {})
    }
})
