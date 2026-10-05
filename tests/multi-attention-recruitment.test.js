"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const { RecruitmentRegistry } = require("../src/multi/recruitment/registry")
const {
    requestsRandomRecruitment,
} = require("../src/multi/recruitment/attention")
const {
    collectAttentionRecruitments,
} = require("../src/multi/recruitment/query")

const T0 = 1_700_000_000_000
const HOST_VIEWER = 501
const GUEST_VIEWER = 502
const HOST_PLAYER = 9001
const SWORD_CHARACTER = 141001

function shareInput(nowMs, overrides = {}) {
    return {
        recruited: true,
        nowMs,
        room: {
            roomNumber: "126523",
            category: 19,
            questId: 500009002,
            hostViewerId: HOST_VIEWER,
            ...overrides,
        },
    }
}

/** Second room, used to prove two recruitments never contaminate each other. */
const SECOND_ROOM_NUMBER = "222"
const SECOND_HOST_VIEWER = 777

function secondHostShareInput(nowMs) {
    return shareInput(nowMs, {
        roomNumber: SECOND_ROOM_NUMBER,
        hostViewerId: SECOND_HOST_VIEWER,
    })
}

function secondHostRoomStatus() {
    return roomStatus({
        roomNumber: SECOND_ROOM_NUMBER,
        host: identity(SECOND_HOST_VIEWER),
    })
}

/** A one-off room share with an explicit room number and host. */
function shareFor(nowMs, roomNumber, hostViewerId) {
    return shareInput(nowMs, { roomNumber, hostViewerId })
}

/**
 * Room statuses in the order the query will ask for them (newest share first),
 * so a queue-based coordinator stub stays aligned with the polling order.
 */
function statusesFor(registry, nowMs = T0 + 1_000) {
    return registry.listVisible(nowMs).map(record => roomStatus({
        roomNumber: record.roomNumber,
        host: identity(record.hostViewerId),
    }))
}

/** Minimal ParticipantIdentity stub; the real one is branded. */
function identity(viewerId) {
    return { nodeSessionId: "embedded", viewerId }
}

function roomStatus(overrides = {}) {
    return {
        roomNumber: "126523",
        accessToken: "token",
        category: 19,
        questId: 500009002,
        hostEntryTime: 1_719_622_252,
        roomSequence: 1,
        raisingState: 2,
        shareRoomOptions: {},
        hostMainCharacterId: SWORD_CHARACTER,
        isNpcMode: false,
        hostOnline: true,
        host: identity(HOST_VIEWER),
        members: [identity(HOST_VIEWER)],
        compatibility: {},
        ...overrides,
    }
}

function collect(registry, options = {}) {
    // `??` matters: an explicitly passed `undefined` must still fall back.
    const viewerId = options.viewerId ?? GUEST_VIEWER
    const requesterPlayerId = options.requesterPlayerId ?? 7002
    const holdingNumber = options.holdingNumber ?? 3
    const nowMs = options.nowMs ?? T0 + 1_000
    const responses = options.responses ?? []
    const hostFacts = options.hostFacts ?? {
        hostPlayerId: HOST_PLAYER,
        mainCharacterId: SWORD_CHARACTER,
        rankLevel: 138,
        isNewbie: false,
    }
    const calls = []
    const queue = [...responses]
    const coordinator = {
        getRoomStatus: async input => {
            calls.push(input)
            if (queue.length === 0) return { ok: false, error: "ROOM_NOT_FOUND" }
            const next = queue.shift()
            // A bare room status is shorthand for a successful lookup.
            return typeof next.ok === "boolean" ? next : { ok: true, value: next }
        },
    }
    const participantCalls = []
    const query = collectAttentionRecruitments(
        { viewerId, requesterPlayerId, holdingNumber },
        {
            registry,
            coordinator,
            resolveHost: options.resolveHost ?? (async () => hostFacts),
            participantFor: id => {
                participantCalls.push(id)
                return options.participants ? options.participants(id) : identity(id)
            },
            resolveEstablisherFollow: options.resolveEstablisherFollow ?? (() => 0),
            nowMs: () => nowMs,
            onResolveError: options.onResolveError,
        },
    )
    return query.then(list => ({ list, calls, participantCalls }))
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test("share_type_list decides whether the room is recruiting", () => {
    assert.equal(requestsRandomRecruitment([3]), true)
    assert.equal(requestsRandomRecruitment([1, 3]), true)
    assert.equal(requestsRandomRecruitment(["3"]), true)
    assert.equal(requestsRandomRecruitment([1, 2]), false)
    assert.equal(requestsRandomRecruitment([]), false)
    assert.equal(requestsRandomRecruitment(undefined), false)
    assert.equal(requestsRandomRecruitment(null), false)
    assert.equal(requestsRandomRecruitment("3"), false)
})

test("repeated shares refresh one recruitment instead of creating a second", () => {
    const registry = new RecruitmentRegistry()
    const first = registry.share(shareInput(T0))
    const second = registry.share(shareInput(T0 + 15_000))
    const third = registry.share(shareInput(T0 + 30_000))

    assert.equal(registry.size, 1)
    assert.equal(second.attentionKey, first.attentionKey)
    assert.equal(third.attentionKey, first.attentionKey)
    assert.equal(third.firstSharedAtMs, T0)
    assert.equal(third.lastSharedAtMs, T0 + 30_000)
    assert.equal(third.shareCount, 3)
})

test("a share without share_type keeps advertising an existing recruitment", () => {
    const registry = new RecruitmentRegistry()
    const opened = registry.share({ ...shareInput(T0), recruited: true })
    const refreshed = registry.share({ ...shareInput(T0 + 1_000), recruited: true })

    assert.equal(registry.size, 1)
    assert.equal(refreshed.attentionKey, opened.attentionKey)
})

test("cancelling then reopening the room mints a new key", () => {
    const registry = new RecruitmentRegistry()
    const opened = registry.share(shareInput(T0))
    assert.equal(registry.share({ ...shareInput(T0 + 1_000), recruited: false }), null)
    assert.equal(registry.size, 0)

    const reopened = registry.share(shareInput(T0 + 2_000))
    assert.equal(registry.size, 1)
    assert.notEqual(reopened.attentionKey, opened.attentionKey)
})

test("a recruitment disappears once the host stops refreshing it", () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    assert.equal(registry.listVisible(T0 + 29_000).length, 1)
    assert.equal(registry.listVisible(T0 + 31_000).length, 0)
    assert.equal(registry.size, 0)
})

test("a recruitment disappears when the client has exhausted its redeliveries", () => {
    const registry = new RecruitmentRegistry()
    let last = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
        last = registry.share(shareInput(T0 + attempt * 15_000))
    }

    assert.equal(last.shareCount, 20)
    assert.equal(registry.listVisible(T0 + 19 * 15_000).length, 0)
})

test("close() is what a disbanded room uses", () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    assert.equal(registry.close("126523"), true)
    assert.equal(registry.close("126523"), false)
    assert.equal(registry.listVisible(T0 + 1_000).length, 0)
})

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

test("a visible recruitment becomes a client-shaped bell", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    const { list, calls } = await collect(registry, {
        responses: [roomStatus()],
        resolveEstablisherFollow: () => 1,
    })

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].participant, identity(GUEST_VIEWER))
    assert.equal(calls[0].roomNumber, "126523")
    assert.equal(list.multi.length, 1)
    assert.deepEqual(list.multi[0], {
        attention_key: registry.get("126523").attentionKey,
        quest_info: {
            category_id: 19,
            quest_id: 500009002,
            room_number: "126523",
            establisher_character: SWORD_CHARACTER,
            establisher_character_evolution_img_level: 0,
            establisher_follow: 1,
            establisher_rank: 138,
            host_entry_time: 1_719_622_252,
            is_newbie: false,
        },
    })
})

test("every contract field has the type the client's parser asserts", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    const { list } = await collect(registry, { responses: [roomStatus()] })

    const entry = list.multi[0]
    // The client aborts with ClientError 8700-8707 on any mismatch.
    assert.equal(typeof entry.attention_key, "string")
    assert.equal(typeof entry.quest_info.room_number, "string")
    assert.equal(typeof entry.quest_info.category_id, "number")
    assert.equal(typeof entry.quest_info.quest_id, "number")
    assert.equal(typeof entry.quest_info.establisher_character, "number")
    assert.equal(typeof entry.quest_info.establisher_character_evolution_img_level, "number")
    assert.equal(typeof entry.quest_info.establisher_follow, "number")
    assert.equal(typeof entry.quest_info.establisher_rank, "number")
    assert.equal(typeof entry.quest_info.host_entry_time, "number")
    assert.equal(typeof entry.quest_info.is_newbie, "boolean")
    assert.ok(Number.isInteger(entry.quest_info.establisher_character))
    assert.ok(Number.isInteger(entry.quest_info.establisher_follow))
    assert.ok(Number.isInteger(entry.quest_info.establisher_rank))
})

test("an empty bell list is still an array, never a missing key", async () => {
    const { list } = await collect(new RecruitmentRegistry())
    assert.deepEqual(list, { multi: [] })
    assert.ok(Array.isArray(list.multi))
})

test("the host never receives a bell for its own room", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    const { list, calls } = await collect(registry, { viewerId: HOST_VIEWER })
    assert.deepEqual(list.multi, [])
    assert.equal(calls.length, 0)
})

test("a full room stops advertising but keeps the bell for its own members", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    const full = roomStatus({
        members: [identity(HOST_VIEWER), identity(600), identity(601)],
    })

    const outsider = await collect(registry, { responses: [full] })
    assert.deepEqual(outsider.list.multi, [])

    const inside = await collect(registry, {
        responses: [full],
        viewerId: 600,
    })
    assert.equal(inside.list.multi.length, 1)
})

test("a room that no longer exists produces no bell", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    const errors = []

    const { list } = await collect(registry, {
        responses: [{ ok: false, error: "ROOM_NOT_FOUND" }],
        onResolveError: (roomNumber, error) => errors.push([roomNumber, error]),
    })

    assert.deepEqual(list.multi, [])
    // A missing room is the normal disband race, not something to log.
    assert.deepEqual(errors, [])
})

test("a coordinator failure drops the bell and is reported", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    const errors = []

    const { list } = await collect(registry, {
        responses: [{ ok: false, error: "HUB_UNAVAILABLE" }],
        onResolveError: (roomNumber, error) => errors.push([roomNumber, error]),
    })

    assert.deepEqual(list.multi, [])
    assert.equal(errors.length, 1)
    assert.equal(errors[0][0], "126523")
    assert.equal(errors[0][1], "HUB_UNAVAILABLE")
})

test("a room whose live quest changed is not advertised", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    const { list } = await collect(registry, {
        responses: [roomStatus({ questId: 500009003 })],
    })
    assert.deepEqual(list.multi, [])
})

test("a room that changed host is not advertised", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    const { list } = await collect(registry, {
        responses: [roomStatus({ host: identity(999) })],
    })
    assert.deepEqual(list.multi, [])
})

test("a host that cannot be resolved produces no bell", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    const { list } = await collect(registry, {
        responses: [roomStatus()],
        resolveHost: async () => null,
    })
    assert.deepEqual(list.multi, [])
})

test("holding_number caps the list and zero means the client is saturated", async () => {
    const registry = new RecruitmentRegistry()
    // Three independent recruitments: distinct room numbers AND distinct hosts,
    // because one host only ever advertises one room at a time.
    registry.share(shareFor(T0, "111", 601))
    registry.share(shareFor(T0 + 10, "222", 602))
    registry.share(shareFor(T0 + 20, "333", 603))

    const all = await collect(registry, { responses: statusesFor(registry) })
    assert.equal(all.list.multi.length, 3)
    assert.deepEqual(
        all.calls.map(call => call.roomNumber),
        ["333", "222", "111"],
    )

    const none = await collect(registry, { holdingNumber: 0 })
    assert.deepEqual(none.list.multi, [])
    assert.equal(none.calls.length, 0)

    // A malformed/absent holding_number must not silently disable recruitment.
    const unspecified = await collect(registry, {
        holdingNumber: undefined,
        responses: statusesFor(registry),
    })
    assert.equal(unspecified.list.multi.length, 3)

    const one = await collect(registry, {
        holdingNumber: 1,
        responses: [roomStatus({ roomNumber: "333", host: identity(603) })],
    })
    assert.equal(one.list.multi.length, 1)
    assert.equal(one.list.multi[0].quest_info.room_number, "333")
    // Newest first: the most recently refreshed room wins the remaining slot.
    assert.deepEqual(one.calls.map(call => call.roomNumber), ["333"])
})

test("the requester identity is resolved once for the whole poll", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareFor(T0, "111", 601))
    registry.share(shareFor(T0 + 10, "222", 603))

    const { participantCalls } = await collect(registry, {
        responses: statusesFor(registry),
    })
    assert.deepEqual(participantCalls, [GUEST_VIEWER])
})

test("two rooms on the same quest keep separate recruitments", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    registry.share(secondHostShareInput(T0 + 10))

    const { calls, list } = await collect(registry, {
        responses: [secondHostRoomStatus(), roomStatus()],
    })

    assert.deepEqual(calls.map(call => call.roomNumber), [SECOND_ROOM_NUMBER, "126523"])
    assert.equal(list.multi.length, 2)
    const keys = new Set(list.multi.map(entry => entry.attention_key))
    assert.equal(keys.size, 2)
    assert.deepEqual(
        list.multi.map(entry => entry.quest_info.room_number),
        [SECOND_ROOM_NUMBER, "126523"],
    )
})

test("a host that left mid-poll drops out without failing the rest", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    registry.share(secondHostShareInput(T0 + 10))

    const { list, calls } = await collect(registry, {
        responses: [
            // Polls newest first: room 222 is gone, room 126523 is still alive.
            { ok: false, error: "ROOM_NOT_FOUND" },
            roomStatus(),
        ],
    })

    assert.deepEqual(calls.map(call => call.roomNumber), [SECOND_ROOM_NUMBER, "126523"])
    assert.equal(list.multi.length, 1)
    assert.equal(list.multi[0].quest_info.room_number, "126523")
})

test("establisher_follow is computed per room", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))
    registry.share(secondHostShareInput(T0 + 10))

    const follows = []
    const { list } = await collect(registry, {
        responses: [secondHostRoomStatus(), roomStatus()],
        resolveEstablisherFollow: input => {
            follows.push([input.hostViewerId, input.hostPlayerId])
            return input.hostViewerId === SECOND_HOST_VIEWER ? 1 : 0
        },
    })

    assert.deepEqual(follows, [[SECOND_HOST_VIEWER, HOST_PLAYER], [HOST_VIEWER, HOST_PLAYER]])
    assert.equal(list.multi[0].quest_info.establisher_follow, 1)
    assert.equal(list.multi[1].quest_info.establisher_follow, 0)
})

test("a non-integer host character falls back to a parsable id", async () => {
    const registry = new RecruitmentRegistry()
    registry.share(shareInput(T0))

    const { list } = await collect(registry, {
        hostFacts: {
            hostPlayerId: HOST_PLAYER,
            mainCharacterId: 0,
            rankLevel: 1,
            isNewbie: true,
        },
        responses: [roomStatus()],
    })

    // The client asserts Int here, so 0/null would abort the whole poll.
    assert.equal(list.multi[0].quest_info.establisher_character, 1)
    assert.equal(list.multi[0].quest_info.is_newbie, true)
})
