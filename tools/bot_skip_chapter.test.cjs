"use strict"

// Bot `/skip chapter N` — `POST /api/bot/skip_chapter`.
//
// The feature exists to fast-forward a bound save to the start of a chapter.
// The important property is not the HTTP shape but that the save really becomes
// playable: the client (`MainStageNodeLogic.isCleared`) and
// `singleBattleQuest/start` both require *every* prerequisite quest to be
// `finished`, so these tests assert on `getQuestPrerequisites` from the bundled
// content and on the raw `players_quest_progress` rows rather than on the
// response body alone. A response that says "ok" while leaving the chapter
// locked would pass a body-only test and fail the player.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

require("ts-node/register/transpile-only")

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-skip-chapter-"))
const previousDataDirectory = process.env.DATA_DIR
process.env.DATA_DIR = databaseDirectory

const Fastify = require("fastify")
const data = require("../src/data")
const { getDb } = require("../src/data/db")
const { insertAccountSync } = require("../src/data/domains/account")
const { bindPlatformAccountSync } = require("../src/data/domains/account-binding")
const { insertDefaultPlayerSync } = require("../src/data/domains/player")
const {
    getPlayerSingleQuestProgressSync,
    getPlayerQuestProgressSync,
    insertPlayerQuestProgressSync,
} = require("../src/data/domains/quest")
const { getPlayerHistoryMilestonesSync } = require("../src/data/domains/player-history-facts")
const { BOT_TOKEN_HEADER } = require("../src/routes/web_api/bot")
const botRoutes = require("../src/routes/web_api/bot").default
const { getMainQuestIdsForChapter } = require("../src/lib/quest-content")
const { getQuestPrerequisites } = require("../src/lib/quest-entry-content")
const { MAIN_QUEST_SECTION, MAX_MAIN_CHAPTER } = require("../src/lib/player-progress/chapter-skip")
const { installBundledGameplaySnapshot } = require("./helpers/install-bundled-gameplay-snapshot.cjs")

const BOT_TOKEN = "p5-skip-token-4d19"
const API = "/api/bot/skip_chapter"

let app
let restoreContentSnapshot
let sequence = 0
let viewerSequence = 950_000_000

function createViewer(label) {
    sequence += 1
    viewerSequence += 1
    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bot-skip-${sequence}-${label}`,
        status: "normal",
    })
    const playerId = insertDefaultPlayerSync(account.id).id
    getDb().prepare(
        "INSERT INTO sessions (token, account_id, expires, type) VALUES (?, ?, ?, 2)",
    ).run(
        String(viewerSequence),
        account.id,
        new Date(Date.now() + 86400000).toISOString(),
    )
    return { accountId: account.id, playerId, viewerId: viewerSequence }
}

function bindIdentity(accountId, uid, platform = "qq", isPrimary = true) {
    bindPlatformAccountSync({
        accountId,
        platform,
        platformUid: uid,
        createdBy: "admin",
        actor: "admin",
    })
    assert.equal(isPrimary, true)
}

function seedSharedBinding(accountId, platform, platformUid) {
    const nowIso = new Date().toISOString()
    getDb().prepare(`
        INSERT INTO account_bindings (
            account_id, platform, platform_uid, display_name, is_primary,
            created_by, note, created_at, updated_at, revision
        ) VALUES (?, ?, ?, NULL, 0, 'admin', NULL, ?, ?, 1)
    `).run(accountId, platform, platformUid, nowIso, nowIso)
}

async function post(payload, options = {}) {
    const headers = {}
    if (options.token !== null) headers[BOT_TOKEN_HEADER] = options.token ?? BOT_TOKEN
    const response = await app.inject({ method: "POST", url: API, payload, headers })
    return {
        status: response.statusCode,
        body: JSON.parse(response.payload),
    }
}

const skip = (payload, options) => post(payload, options)

function firstQuestOf(chapter) {
    const ids = getMainQuestIdsForChapter(chapter)
    return ids.length === 0 ? null : Math.min(...ids)
}

/**
 * The prerequisite quests of `chapter` that the save has not finished. This
 * mirrors `singleBattleQuest/start` (`src/routes/api/singleBattleQuest.ts:257-273`),
 * which refuses when any listed prerequisite is not `finished`.
 *
 * Main quests live under `QuestCategory.MAIN` (= 1) even though a quest id's
 * leading digits are its *chapter*; EX quests of the same chapter are category 4.
 * The table is keyed by that category, so the lookup uses `MAIN_QUEST_SECTION`
 * for main quests while each prerequisite carries its own category.
 */
function unfinishedPrerequisites(playerId, chapter) {
    const missing = []
    for (const questId of getMainQuestIdsForChapter(chapter)) {
        for (const prerequisite of getQuestPrerequisites(MAIN_QUEST_SECTION, questId) ?? []) {
            const progress = getPlayerSingleQuestProgressSync(
                playerId,
                prerequisite.category,
                prerequisite.questId,
            )
            if (progress?.finished !== true) {
                missing.push(`${prerequisite.category}_${prerequisite.questId}`)
            }
        }
    }
    return missing
}

/**
 * Whether `chapter` is playable, judged the way the player experiences it.
 *
 * The raw prerequisite table is not a usable oracle: it contains intra-chapter
 * links such as `1_3001001 -> 3001001` (chapter 3's own first node citing
 * itself), so a literal "no unfinished prerequisite" check reports chapter 3 as
 * unreachable even after chapters 1 and 2 are fully cleared — which is all
 * chapter 3's entry really needs (`1_3001001 -> 2009001..2009007`, the last node
 * of chapter 2). Only cross-chapter prerequisites are trustworthy: those are the
 * ones that guard the first node of a chapter.
 */
function chapterIsPlayable(playerId, chapter) {
    const missing = unfinishedPrerequisites(playerId, chapter).filter(entry => {
        const questId = Number(entry.split("_")[1])
        return Number.isSafeInteger(questId) && Math.floor(questId / 1_000_000) < chapter
    })
    return { playable: missing.length === 0, missing }
}

function getPlayerLastMainQuestIdOf(playerId) {
    const row = getDb().prepare("SELECT last_main_quest_id FROM players WHERE id = ?").get(playerId)
    return row.last_main_quest_id
}

function chapterMilestones(playerId) {
    return getPlayerHistoryMilestonesSync(playerId)
        .filter(milestone => milestone.aggregationTarget === 2 || milestone.aggregationTarget === 3)
        .map(milestone => [milestone.aggregationTarget, milestone.slot])
        .sort((left, right) => left[0] - right[0] || left[1] - right[1])
}

test.before(async () => {
    restoreContentSnapshot = installBundledGameplaySnapshot()
    data.initializeDatabase()
    app = Fastify({ logger: false })
    app.register(botRoutes, { prefix: "/api/bot", env: { BOT_API_TOKEN: BOT_TOKEN } })
    await app.ready()
})

test.after(async () => {
    if (app !== undefined) await app.close()
    data.closeDatabase()
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
    restoreContentSnapshot?.()
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

test("skip to a chapter makes that chapter playable", async () => {
    const viewer = createViewer("fresh")
    bindIdentity(viewer.accountId, "skip-fresh-1")

    // A brand new save cannot enter chapter 3 …
    assert.equal(chapterIsPlayable(viewer.playerId, 3).playable, false)

    const response = await skip({ platform: "qq", uid: "skip-fresh-1", chapter: 3 })

    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const result = response.body.data
    assert.equal(result.account_id, viewer.accountId)
    assert.equal(result.viewer_id, viewer.viewerId)
    assert.equal(result.chapter, 3)
    // The current quest is the one the player is about to play, not the last one
    // they skipped past — that is what a normally progressing save holds.
    assert.equal(result.last_main_quest_id, firstQuestOf(3))
    assert.equal(result.current_quest, firstQuestOf(3))
    assert.equal(result.finished_quests > 0, true)
    assert.equal(result.recorded_chapters, 2)

    // … and it can afterwards: nothing chapter 3 still needs is un-finished.
    assert.deepEqual(chapterIsPlayable(viewer.playerId, 3).missing, [])
    // Chapters 1..3 are playable too, which is what "start at chapter 3" means.
    assert.deepEqual(chapterIsPlayable(viewer.playerId, 2).missing, [])
    assert.deepEqual(chapterIsPlayable(viewer.playerId, 1).missing, [])
})

test("skipped quests are finished and unlocked, and the pointer is persisted", async () => {
    const viewer = createViewer("rows")
    bindIdentity(viewer.accountId, "skip-rows-1")

    const response = await skip({ platform: "qq", uid: "skip-rows-1", chapter: 4 })
    assert.equal(response.body.ok, true)

    const expected = [1, 2, 3].flatMap(chapter => getMainQuestIdsForChapter(chapter))
    assert.equal(expected.length > 0, true)
    for (const questId of expected) {
        const progress = getPlayerSingleQuestProgressSync(viewer.playerId, MAIN_QUEST_SECTION, questId)
        assert.notEqual(progress, null, `quest ${questId} has no progress row`)
        assert.equal(progress.finished, true, `quest ${questId} is not finished`)
        assert.equal(progress.unlocked, true, `quest ${questId} is not unlocked`)
    }

    // The current-quest pointer lives on the player row, not in quest progress.
    assert.equal(getPlayerLastMainQuestIdOf(viewer.playerId), firstQuestOf(4))

    // Chapter 4 itself was not played — skipping to a chapter must not finish it.
    for (const questId of getMainQuestIdsForChapter(4)) {
        const progress = getPlayerSingleQuestProgressSync(viewer.playerId, MAIN_QUEST_SECTION, questId)
        assert.equal(progress?.finished === true, false, `quest ${questId} of chapter 4 was finished`)
    }
})

test("skipping to chapter 1 is a no-op that only moves the pointer", async () => {
    const viewer = createViewer("noop")
    bindIdentity(viewer.accountId, "skip-noop-1")

    const before = getPlayerQuestProgressSync(viewer.playerId, [MAIN_QUEST_SECTION])[
        String(MAIN_QUEST_SECTION)
    ] ?? []
    const response = await skip({ platform: "qq", uid: "skip-noop-1", chapter: 1 })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.data.chapter, 1)
    assert.equal(response.body.data.last_main_quest_id, null)
    assert.equal(response.body.data.current_quest, firstQuestOf(1))

    const after = getPlayerQuestProgressSync(viewer.playerId, [MAIN_QUEST_SECTION])[
        String(MAIN_QUEST_SECTION)
    ] ?? []
    assert.equal(after.length, before.length)
    assert.equal(after.some(entry => entry.finished), false)
    // Chapter 2 needs the last node of chapter 1, which skipping to chapter 1
    // deliberately does not clear — the player plays chapter 1 themselves.
    assert.equal(chapterIsPlayable(viewer.playerId, 2).playable, false)
})

test("a partially played save keeps its clears and gains the missing ones", async () => {
    const viewer = createViewer("partial")
    bindIdentity(viewer.accountId, "skip-partial-1")

    // The player cleared all of chapter 1, then stopped in the middle of chapter 2.
    const chapterOne = getMainQuestIdsForChapter(1)
    for (const questId of chapterOne) {
        insertPlayerQuestProgressSync(viewer.playerId, MAIN_QUEST_SECTION, {
            questId,
            finished: true,
            unlocked: true,
        })
    }
    const chapterTwo = getMainQuestIdsForChapter(2).slice().sort((left, right) => left - right)
    const clearedInChapterTwo = chapterTwo.slice(0, 3)
    for (const questId of clearedInChapterTwo) {
        insertPlayerQuestProgressSync(viewer.playerId, MAIN_QUEST_SECTION, {
            questId,
            finished: true,
            unlocked: true,
            clearRank: 3,
            highScore: 12345,
        })
    }

    const response = await skip({ platform: "qq", uid: "skip-partial-1", chapter: 3 })
    assert.equal(response.body.ok, true)

    // Whatever the player really cleared keeps its own values.
    for (const questId of clearedInChapterTwo) {
        const progress = getPlayerSingleQuestProgressSync(viewer.playerId, MAIN_QUEST_SECTION, questId)
        assert.equal(progress.finished, true)
        assert.equal(progress.clearRank, 3)
        assert.equal(progress.highScore, 12345)
    }
    assert.deepEqual(chapterIsPlayable(viewer.playerId, 3).missing, [])
})

test("skipping twice is idempotent after the first call moves the pointer", async () => {
    const viewer = createViewer("twice")
    bindIdentity(viewer.accountId, "skip-twice-1")

    const first = await skip({ platform: "qq", uid: "skip-twice-1", chapter: 5 })
    assert.equal(first.body.ok, true)
    assert.equal(first.body.data.recorded_chapters, 4)

    const second = await skip({ platform: "qq", uid: "skip-twice-1", chapter: 5 })
    assert.equal(second.body.ok, true)
    // Nothing new to record the second time …
    assert.equal(second.body.data.finished_quests, 0)
    assert.equal(second.body.data.recorded_chapters, 0)
    // … and the outcome is identical.
    assert.equal(second.body.data.last_main_quest_id, first.body.data.last_main_quest_id)
})

test("every chapter in content can be reached", async () => {
    const viewer = createViewer("all")
    bindIdentity(viewer.accountId, "skip-all-1")

    const response = await skip({ platform: "qq", uid: "skip-all-1", chapter: MAX_MAIN_CHAPTER })
    assert.equal(response.body.ok, true)
    assert.equal(response.body.data.chapter, MAX_MAIN_CHAPTER)
    assert.equal(response.body.data.last_main_quest_id, firstQuestOf(MAX_MAIN_CHAPTER))
    assert.deepEqual(chapterIsPlayable(viewer.playerId, MAX_MAIN_CHAPTER).missing, [])
    // Chapter 12 itself stays untouched: skipping puts the player at its start.
    const savedRows = new Set(
        (getPlayerQuestProgressSync(viewer.playerId, [MAIN_QUEST_SECTION])[
            String(MAIN_QUEST_SECTION)
        ] ?? []).map(entry => entry.questId),
    )
    assert.equal(getMainQuestIdsForChapter(MAX_MAIN_CHAPTER).some(id => savedRows.has(id)), false)
    // Chapters 1..6 and 7..12 use separate milestone targets with six slots each.
    assert.deepEqual(chapterMilestones(viewer.playerId), [
        [2, 0], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5],
        [3, 0], [3, 1], [3, 2], [3, 3], [3, 4],
    ])
})

test("an out-of-range or malformed chapter is refused and changes nothing", async () => {
    const viewer = createViewer("invalid")
    bindIdentity(viewer.accountId, "skip-invalid-1")

    const cases = [
        { chapter: 0, status: 400, code: "BAD_REQUEST" },
        { chapter: MAX_MAIN_CHAPTER + 1, status: 400, code: "INVALID_CHAPTER" },
        { chapter: -3, status: 400, code: "BAD_REQUEST" },
    ]
    for (const item of cases) {
        const response = await skip({ platform: "qq", uid: "skip-invalid-1", chapter: item.chapter })
        assert.equal(response.status, item.status)
        assert.deepEqual(response.body, { ok: false, code: item.code })
    }

    for (const chapter of [undefined, null, "3", 3.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
        const response = await skip({ platform: "qq", uid: "skip-invalid-1", chapter })
        assert.equal(response.status, 400)
        assert.deepEqual(response.body, { ok: false, code: "BAD_REQUEST" })
    }

    // A wrong platform and a malformed uid are request errors too.
    for (const payload of [
        { platform: "telegram", uid: "skip-invalid-1", chapter: 3 },
        { platform: "qq", uid: "", chapter: 3 },
        { platform: "qq", chapter: 3 },
        [],
    ]) {
        const response = await skip(payload)
        assert.equal(response.status, 400)
        assert.deepEqual(response.body, { ok: false, code: "BAD_REQUEST" })
    }

    assert.equal(getPlayerLastMainQuestIdOf(viewer.playerId), null)
    const rows = getPlayerQuestProgressSync(viewer.playerId, [MAIN_QUEST_SECTION])[
        String(MAIN_QUEST_SECTION)
    ] ?? []
    assert.equal(rows.some(row => row.finished), false)
})

test("an unbound platform identity cannot skip anything", async () => {
    const response = await skip({ platform: "qq", uid: "skip-nobody-1", chapter: 3 })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { ok: false, code: "NO_BINDING" })

    const account = insertAccountSync({
        appId: "wf_cn",
        idpAlias: "",
        idpCode: "test",
        idpId: `bot-skip-noplayer-${Math.random().toString(36).slice(2)}`,
        status: "normal",
    })
    bindIdentity(account.id, "skip-noplayer-1")
    const noPlayer = await skip({ platform: "qq", uid: "skip-noplayer-1", chapter: 3 })
    assert.equal(noPlayer.status, 200)
    assert.deepEqual(noPlayer.body, { ok: false, code: "NO_PLAYER" })
})

test("a platform identity with several bindings needs a primary one", async () => {
    // Two non-primary bindings for one uid are ambiguous: skipping the wrong
    // save would be unrecoverable, so the endpoint refuses instead of guessing.
    const first = createViewer("ambiguous-a")
    const second = createViewer("ambiguous-b")
    seedSharedBinding(first.accountId, "kook", "skip-ambiguous-1")
    seedSharedBinding(second.accountId, "kook", "skip-ambiguous-1")

    const ambiguous = await skip({ platform: "kook", uid: "skip-ambiguous-1", chapter: 3 })
    assert.deepEqual(ambiguous.body, { ok: false, code: "NO_BINDING" })
    assert.equal(getPlayerLastMainQuestIdOf(first.playerId), null)
    assert.equal(getPlayerLastMainQuestIdOf(second.playerId), null)

    // With a primary binding the target becomes unambiguous again.
    const owner = createViewer("ambiguous-owner")
    bindIdentity(owner.accountId, "skip-primary-1", "kook")
    seedSharedBinding(second.accountId, "kook", "skip-primary-1")
    const owned = await skip({ platform: "kook", uid: "skip-primary-1", chapter: 2 })
    assert.equal(owned.body.ok, true)
    assert.equal(owned.body.data.account_id, owner.accountId)
    assert.equal(getPlayerLastMainQuestIdOf(owner.playerId), firstQuestOf(2))
    assert.equal(getPlayerLastMainQuestIdOf(second.playerId), null)
})

test("the bot token still gates the endpoint", async () => {
    const viewer = createViewer("auth")
    bindIdentity(viewer.accountId, "skip-auth-1")

    const missing = await skip({ platform: "qq", uid: "skip-auth-1", chapter: 3 }, { token: null })
    assert.equal(missing.status, 403)
    assert.deepEqual(missing.body, { ok: false, code: "FORBIDDEN" })

    const wrong = await skip({ platform: "qq", uid: "skip-auth-1", chapter: 3 }, { token: "nope" })
    assert.equal(wrong.status, 403)
    assert.deepEqual(wrong.body, { ok: false, code: "FORBIDDEN" })

    assert.equal(getPlayerLastMainQuestIdOf(viewer.playerId), null)
})
