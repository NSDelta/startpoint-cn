"use strict"

/**
 * `party/publish` + `party/refer`: the party sharing code round trip.
 *
 * The client builds the share code from the publish response and never uploads
 * the party again, so the server is the only place a shared party can survive
 * between the sender and the redeemer. These tests pin that the code is usable
 * (matches the alphabet the party code dialog accepts), that the redeemer gets
 * the publisher's party back field for field, and that an unknown code fails the
 * way `PartyReferRemote.errorHandler` understands (A-error 3404).
 */

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")
const { unpack } = require("msgpackr")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "party-code-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const data = require("../src/data")
const { insertAccountSync } = require("../src/data/domains/account")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const { insertSessionWithToken } = require("../src/data/domains/session")
const { SessionType } = require("../src/data/types")
const partyRoutes = require("../src/routes/api/party").default
const { encodeCnMsgpackPayload, registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
const {
    PARTY_CODE_ALPHABET,
    PARTY_CODE_LENGTH,
    partyCodeRegistry,
} = require("../src/lib/party-code/registry")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const PUBLISH_URL = "/api/index.php/party/publish"
const REFER_URL = "/api/index.php/party/refer"

/** The dialog's own pattern (`PartyCodeInputDialog.as:118`). */
const CLIENT_PARTY_CODE_PATTERN = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty]{6,}$/

let app
let restoreContentSnapshot
let nextViewerId = 940000000

function createPlayer(label) {
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `${label}-${randomUUID()}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    const viewerId = nextViewerId++
    insertSessionWithToken({
        token: String(viewerId),
        accountId: account.id,
        expires: new Date("2099-01-01T00:00:00.000Z"),
        type: SessionType.VIEWER,
    })
    return { playerId, viewerId }
}

function readReply(response) {
    if (response.body.startsWith("{")) return JSON.parse(response.body)
    return unpack(Buffer.from(response.body, "base64"))
}

function character(id, overrides = {}) {
    return {
        id,
        evolution_level: 1,
        exp: 1234,
        over_limit_step: 2,
        mana_node_ids: [1001, 1002],
        illustration_settings: null,
        ex_boost: null,
        ...overrides,
    }
}

function battleParty() {
    return {
        characters: [
            character(151165, {
                exp: 342410,
                ex_boost: { status_id: 5, ability_id_list: [15, 39] },
            }),
            character(141063, { evolution_level: 0, illustration_settings: [1, 2] }),
            null,
        ],
        unison_characters: [
            character(241045, { over_limit_step: 6 }),
            null,
            null,
        ],
        equipments: [
            { equipment_id: 5040028, level: 5 },
            null,
            null,
        ],
        ability_soul_ids: [5010058, null, null],
    }
}

async function publish(viewerId, body = {}) {
    return app.inject({
        method: "POST",
        url: PUBLISH_URL,
        payload: {
            viewer_id: viewerId,
            party_name: "Party A",
            battle_party: battleParty(),
            ...body,
        },
    })
}

async function refer(viewerId, partyCode) {
    return app.inject({
        method: "POST",
        url: REFER_URL,
        payload: { viewer_id: viewerId, party_code: partyCode },
    })
}

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    data.initializeDatabase()
    app = Fastify({ logger: false })
    registerCnMsgpackOnSend(app, encodeCnMsgpackPayload)
    app.register(partyRoutes, { prefix: "/api/index.php/party" })
    await app.ready()
})

test.after(async () => {
    await app.close()
    data.closeDatabase()
    restoreContentSnapshot()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test.beforeEach(() => {
    partyCodeRegistry.clear()
})

test("publish returns a code the party code dialog can accept", async () => {
    const sender = createPlayer("publish-shape")
    const response = await publish(sender.viewerId)
    assert.equal(response.statusCode, 200, response.body)

    const payload = readReply(response)
    assert.equal(typeof payload.data.party_code, "string", response.body)
    // The old stub returned a URL: 120 characters containing ":" and "/", which
    // the dialog rejects, so no player could ever redeem it.
    assert.match(payload.data.party_code, CLIENT_PARTY_CODE_PATTERN)
    assert.equal(payload.data.party_code.length, PARTY_CODE_LENGTH)
    for (const character of payload.data.party_code) {
        assert.ok(PARTY_CODE_ALPHABET.includes(character), `unusable character: ${character}`)
    }
})

test("publish issues a distinct code per call", async () => {
    const sender = createPlayer("publish-distinct")
    const first = readReply(await publish(sender.viewerId)).data.party_code
    const second = readReply(await publish(sender.viewerId)).data.party_code
    assert.notEqual(first, second)
    assert.equal(partyCodeRegistry.size, 2)
})

test("refer hands the publisher's party back field for field", async () => {
    const sender = createPlayer("refer-sender")
    const redeemer = createPlayer("refer-redeemer")
    const code = readReply(await publish(sender.viewerId, { party_name: "Shared Party" }))
        .data.party_code

    const response = await refer(redeemer.viewerId, code)
    assert.equal(response.statusCode, 200, response.body)
    const payload = readReply(response)
    assert.deepEqual(payload.data, {
        party_name: "Shared Party",
        battle_party: battleParty(),
    })
})

test("refer reports an unknown code as A-error 3404", async () => {
    const redeemer = createPlayer("refer-missing")
    const response = await refer(redeemer.viewerId, "9zYxWv")
    assert.equal(response.statusCode, 200, response.body)
    const payload = readReply(response)
    assert.equal(payload.data_headers.result_code, 3404)
    assert.deepEqual(payload.data, {})
})

test("refer treats codes as case sensitive", async () => {
    const sender = createPlayer("refer-case-sender")
    const redeemer = createPlayer("refer-case-redeemer")
    const code = readReply(await publish(sender.viewerId)).data.party_code
    // Swap the case of the first *letter*: the alphabet mixes cases on purpose
    // (misreadable characters are excluded), so "9g4C4n" has digits up front.
    const letterIndex = [...code].findIndex(character => /[A-Za-z]/.test(character))
    const swapped = code.slice(0, letterIndex)
        + (code[letterIndex] === code[letterIndex].toUpperCase()
            ? code[letterIndex].toLowerCase()
            : code[letterIndex].toUpperCase())
        + code.slice(letterIndex + 1)
    assert.notEqual(swapped, code)
    const payload = readReply(await refer(redeemer.viewerId, swapped))
    assert.equal(payload.data_headers.result_code, 3404)
})

test("refer is refused for a malformed request", async () => {
    const redeemer = createPlayer("refer-bad-request")
    for (const partyCode of [undefined, "", 123456, null]) {
        const response = await refer(redeemer.viewerId, partyCode)
        assert.equal(response.statusCode, 400, response.body)
        assert.equal(readReply(response).message, "Invalid request body.")
    }
})

test("publish rejects a party whose character growth is not integral", async () => {
    const sender = createPlayer("publish-bad-party")
    const party = battleParty()
    party.characters[0].evolution_level = "1"
    const response = await publish(sender.viewerId, { battle_party: party })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(readReply(response).message, "Invalid battle party.")
    assert.equal(partyCodeRegistry.size, 0)
})

test("publish keeps an absent ex_boost absent instead of zeroing it", async () => {
    // `status_id: 0` is not a valid `ex_status` master id; the client feeds it
    // straight into ExStatusLogic, so a zero would crash the party editor.
    const sender = createPlayer("publish-ex-boost")
    const party = battleParty()
    party.characters[0].ex_boost = { status_id: 0, ability_id_list: [] }
    const code = readReply(await publish(sender.viewerId, { battle_party: party })).data.party_code
    const payload = readReply(await refer(sender.viewerId, code))
    assert.equal(payload.data.battle_party.characters[0].ex_boost, null)
})

test("publish preserves slot positions and lengths", async () => {
    const sender = createPlayer("publish-slots")
    const code = readReply(await publish(sender.viewerId)).data.party_code
    const payload = readReply(await refer(sender.viewerId, code))
    const party = payload.data.battle_party
    assert.equal(party.characters.length, 3)
    assert.equal(party.unison_characters.length, 3)
    assert.equal(party.equipments.length, 3)
    assert.equal(party.ability_soul_ids.length, 3)
    assert.equal(party.characters[2], null)
    assert.equal(party.equipments[1], null)
    assert.equal(party.ability_soul_ids[1], null)
})

test("publish truncates an over long party name", async () => {
    const sender = createPlayer("publish-long-name")
    const code = readReply(await publish(sender.viewerId, { party_name: "N".repeat(40) }))
        .data.party_code
    const payload = readReply(await refer(sender.viewerId, code))
    assert.equal(payload.data.party_name.length, 20)
})

test("an expired code stops resolving", async () => {
    const sender = createPlayer("expired-code")
    const code = readReply(await publish(sender.viewerId)).data.party_code
    const registry = require("../src/lib/party-code/registry")
    const record = registry.partyCodeRegistry.lookUp(code, Date.now())
    assert.notEqual(record, null)

    // Re-publish through the registry so the clock can be moved past the TTL
    // without waiting a day.
    registry.partyCodeRegistry.clear()
    const republished = registry.partyCodeRegistry.publish({
        ownerPlayerId: sender.playerId,
        party: record.party,
        nowMs: Date.now() - registry.PARTY_CODE_TTL_MS - 1,
    })
    assert.equal(registry.partyCodeRegistry.lookUp(republished.code, Date.now()), null)
    assert.equal(registry.partyCodeRegistry.size, 0)
})
