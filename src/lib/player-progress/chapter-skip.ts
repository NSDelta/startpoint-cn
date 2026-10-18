import { getDb } from "../../data/db"
import {
    getPlayerQuestProgressSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} from "../../data/domains/quest"
import { getPlayerLastMainQuestIdSync, setPlayerLastMainQuestIdSync } from "../../data/domains/player"
import { MailType, insertMailSync } from "../../data/domains/mail"
import { clientSerializeDate } from "../../data/utils/date"
import { getVirtualNow } from "../../runtime/time/game-time"
import { QuestCategory } from "../types/quest"
import { getMainQuestIdsForChapter, getMainQuestSync } from "../quest-content"
import { RewardType } from "../types/rewards"
import type { Reward } from "../types/rewards"
import { recordPlayerHistoryMilestoneSync } from "../../data/domains/player-history-facts"
import type { PlayerQuestProgress } from "../../data/types"

/**
 * Bot `/skip chapter N` progression shortcut (contract 3.4 control plane).
 *
 * The client decides what a player may play entirely from quest progress:
 * `MainStageNodeLogic.isCleared` requires *every* quest of the stage node to be
 * finished, and a stage node only becomes viewable once the node named by its
 * `need_stage_node` is cleared. The server enforces the same ordering in
 * `singleBattleQuest/start` through `quest_prerequisites.json`, which is derived
 * from those same stage-node links. So `unlocked` alone changes nothing that the
 * player can see — the quests themselves have to be `finished`.
 *
 * Main progression is linear per chapter, therefore marking every main quest of
 * chapters 1..N-1 finished clears every stage-node dependency of chapter N. That
 * is the minimal set that is provably sufficient, and it needs no walk of the
 * stage-node graph.
 *
 * Two properties keep the shortcut honest:
 *
 * - **Forward only.** `players.last_main_quest_id` is monotonic (the client writes
 *   the quest it just started), so a target at or behind it means the save already
 *   passed that point; skipping would roll progress back, so it is refused and
 *   reported as `alreadyAhead`.
 * - **No lost rewards.** A normal clear grants the quest's `clearReward` on the
 *   first finish. A skipped quest is never fought, so this module mails the reward
 *   of every quest it flips — exactly the quests whose first clear it fabricates,
 *   which is also what makes the make-up idempotent: a quest that is already
 *   `finished` is not flipped again and therefore never mailed twice.
 */

/** Section of `players_quest_progress` that holds main story progress. */
export const MAIN_QUEST_SECTION = QuestCategory.MAIN

/** Highest main story chapter present in content; chapters are `id / 1_000_000`. */
export const MAX_MAIN_CHAPTER = 12

/** Chapter-level milestones live in slots 1..6 of aggregation targets 2 and 3. */
const EARLY_CHAPTER_MILESTONE_TARGET = 2
const LATE_CHAPTER_MILESTONE_TARGET = 3
const MILESTONE_SLOT_COUNT = 6
const EARLY_CHAPTER_MAX = 6

/** Main quest ids are `chapter * 1_000_000 + index`, so an id carries its chapter. */
const CHAPTER_ID_DIVISOR = 1_000_000

/**
 * The clear record a skipped quest carries.
 *
 * A real clear always writes all three numbers (`battle-quest-progress-plan.ts`:
 * `clearRank: input.clearRank ?? 5`, `bestElapsedTimeMs: input.clearTime`,
 * `highScore: input.score`), and the client parses `clear_rank` /
 * `best_elapsed_time_ms` straight out of the save. The 2026-06-13 C3212 incident
 * was exactly a `clear_rank: null` reaching a client that had classified the quest
 * as a battle quest, so a row that claims `finished` while those two are null reads
 * as "cleared but never played" and the client refuses it.
 *
 * 5 is SS — the same default the finish path applies when a battle reports no rank
 * (pure story nodes) — so a skipped node shows a normal crown instead of a gap.
 */
export const SKIPPED_QUEST_CLEAR_RANK = 5
export const SKIPPED_QUEST_CLEAR_TIME_MS = 0
export const SKIPPED_QUEST_HIGH_SCORE = 0

/** Make-up mails outlive a normal session, so a skipped reward is not lost to a TTL. */
const FIRST_CLEAR_MAKEUP_TTL_DAYS = 90

/** Mirrors `MAX_MAIL_ATTACHMENT_NUMBER` in `src/lib/mail-overflow.ts`. */
const MAX_MAIL_ATTACHMENT_NUMBER = 2_147_483_647

export class ChapterSkipError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ChapterSkipError"
    }
}

/** What the shortcut did with the first-clear rewards of the quests it finished. */
export interface ChapterSkipMailSummary {
    /** Mails created by this call, one per chapter and reward kind. */
    readonly mailCount: number
    /** Quests whose first-clear reward was mailed. */
    readonly quests: number
    /** Rewards with no mail counterpart, reported instead of silently dropped. */
    readonly unsupportedRewards: number
}

export interface ChapterSkipResult {
    /** The chapter the player now starts at. */
    readonly chapter: number
    /** Quests inspected across chapters 1..N-1. */
    readonly questTotal: number
    /** Quests that flipped from not-finished to finished. */
    readonly newlyFinished: number
    /** Chapters recorded in player history by this call (0 when already recorded). */
    readonly recordedChapters: number
    /**
     * Main quest the save now points at — the first quest of the target chapter,
     * or the untouched pointer for a chapter-1 no-op.
     */
    readonly lastMainQuestId: number | null
    /**
     * True when the save already reached the target chapter, in which case nothing
     * was written: the shortcut never moves a save backwards.
     */
    readonly alreadyAhead: boolean
    /**
     * Rows inside the skipped range whose clear record this call completed. A skip
     * that changes no progress still repairs fabricated clears written before the
     * clear-record fix (null rank/time), because the client rejects those (C3212).
     */
    readonly repaired: number
    readonly mailedRewards: ChapterSkipMailSummary
}

interface MailAttachmentPlan {
    readonly type: MailType
    readonly typeId: number | null
    readonly number: number
}

const NO_MAIL: ChapterSkipMailSummary = Object.freeze({
    mailCount: 0,
    quests: 0,
    unsupportedRewards: 0,
})

export function getMainQuestIdsForChapters(chapters: readonly number[]): readonly number[] {
    const ids: number[] = []
    for (const chapter of chapters) {
        for (const questId of getMainQuestIdsForChapter(chapter)) ids.push(questId)
    }
    return ids
}

/**
 * The quest a player standing at the start of `chapter` is on. Used both as the
 * current-quest pointer and as the value reported back to the bot, so the two
 * can never drift apart.
 */
export function getChapterStartQuestId(chapter: number): number | null {
    const ids = getMainQuestIdsForChapter(chapter)
    return ids.length === 0 ? null : Math.min(...ids)
}

function recordChapterMilestoneSync(
    playerId: number,
    chapter: number,
    occurredAtMs: number,
): boolean {
    const chapterQuestIds = getMainQuestIdsForChapter(chapter)
    if (chapterQuestIds.length === 0) return false
    // Mirrors `recordCompletedMainChapterMilestoneSync`: only the chapter's final
    // quest can complete a chapter. Here the whole chapter completes at once, so
    // the milestone date is the moment of the skip.
    return recordPlayerHistoryMilestoneSync(playerId, {
        aggregationTarget: chapter <= EARLY_CHAPTER_MAX
            ? EARLY_CHAPTER_MILESTONE_TARGET
            : LATE_CHAPTER_MILESTONE_TARGET,
        slot: chapter <= EARLY_CHAPTER_MAX ? chapter - 1 : chapter - 7,
        occurredAt: new Date(occurredAtMs),
    })
}

function rewardCount(reward: Reward): number {
    const count = (reward as { count?: unknown }).count
    return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 1
}

/**
 * The mail counterpart of a first-clear reward.
 *
 * Mirrors `standardReward()` in `src/lib/mail-reward-grant.ts`, which is what the
 * mailbox runs when the player claims the mail: a mailed reward therefore travels
 * the same grant path as a directly granted one, and the two can not drift apart.
 * `RewardType.ELEMENT` / `AETHER` have no mail type — no clear reward in content
 * uses them, and one that did would be counted instead of silently dropped.
 */
function rewardToMailAttachment(reward: Reward): MailAttachmentPlan | null {
    switch (reward.type) {
        case RewardType.ITEM:
            return reward.id === undefined
                ? null
                : { type: MailType.ITEM, typeId: reward.id, number: rewardCount(reward) }
        case RewardType.EQUIPMENT:
            return reward.id === undefined
                ? null
                : { type: MailType.EQUIPMENT, typeId: reward.id, number: rewardCount(reward) }
        case RewardType.CHARACTER:
            // The mailbox reads `number` on a character mail as "how many copies".
            return reward.id === undefined
                ? null
                : { type: MailType.CHARACTER, typeId: reward.id, number: 1 }
        case RewardType.BEADS:
            return { type: MailType.FREE_VMONEY, typeId: null, number: rewardCount(reward) }
        case RewardType.MANA:
            return { type: MailType.FREE_MANA, typeId: null, number: rewardCount(reward) }
        case RewardType.EXP:
            return { type: MailType.EXP_POOL, typeId: null, number: rewardCount(reward) }
        default:
            return null
    }
}

/**
 * Mails the first-clear rewards of the quests this call finished.
 *
 * `questIds` must be exactly the quests that flipped from not-finished to
 * finished; the caller collects them while writing progress, which is what ties
 * "mailed once" to "cleared once".
 *
 * Per chapter and reward kind, never per quest: a skip to chapter 12 fabricates
 * roughly a hundred first clears, and one mail per quest would bury every other
 * mail in the mailbox. Amounts of the same kind are summed, so the total is
 * exactly what the quests would have paid out.
 */
function mailFirstClearRewardsSync(
    playerId: number,
    questIds: readonly number[],
): ChapterSkipMailSummary {
    if (questIds.length === 0) return NO_MAIL

    const perChapter = new Map<number, Map<string, { plan: MailAttachmentPlan, number: number }>>()
    let quests = 0
    let unsupportedRewards = 0
    for (const questId of questIds) {
        const reward = getMainQuestSync(questId)?.clearReward
        if (reward === undefined) continue
        const plan = rewardToMailAttachment(reward)
        if (plan === null) {
            unsupportedRewards += 1
            continue
        }
        const chapter = Math.floor(questId / CHAPTER_ID_DIVISOR)
        let chapterMails = perChapter.get(chapter)
        if (chapterMails === undefined) {
            chapterMails = new Map()
            perChapter.set(chapter, chapterMails)
        }
        const key = `${plan.type}:${plan.typeId ?? 0}`
        const existing = chapterMails.get(key)
        if (existing === undefined) chapterMails.set(key, { plan, number: plan.number })
        else existing.number += plan.number
        quests += 1
    }

    const now = getVirtualNow()
    const createTime = clientSerializeDate(now)
    const rewardLimitTime = clientSerializeDate(new Date(
        now.getTime() + FIRST_CLEAR_MAKEUP_TTL_DAYS * 24 * 60 * 60 * 1000,
    ))
    let mailCount = 0
    for (const [chapter, attachments] of perChapter) {
        for (const { plan, number } of attachments.values()) {
            let remaining = number
            while (remaining > 0) {
                const chunk = Math.min(remaining, MAX_MAIL_ATTACHMENT_NUMBER)
                insertMailSync(playerId, {
                    reason_id: 0,
                    subject: `第 ${chapter} 章首通奖励补发`,
                    description: `跳章补发：第 ${chapter} 章的关卡首通奖励。`,
                    type: plan.type,
                    type_id: plan.typeId,
                    number: chunk,
                    receive_time: "0000-00-00 00:00:00",
                    create_time: createTime,
                    reward_period_limited: 1,
                    reward_limit_time: rewardLimitTime,
                })
                mailCount += 1
                remaining -= chunk
            }
        }
    }
    return { mailCount, quests, unsupportedRewards }
}

/**
 * Completes the clear record of quests an earlier skip wrote without one.
 *
 * A real clear can never leave `clear_rank` / `best_elapsed_time_ms` null — every
 * finish writes both — so a `finished` row missing them was fabricated by this
 * module before the clear-record fix, and the client rejects it (C3212). Only rows
 * that are already `finished` inside the skipped range are touched: progress, the
 * current-quest pointer and the make-up mails are all left exactly as they were.
 */
function repairSkippedQuestRecordsSync(
    playerId: number,
    existingProgress: readonly PlayerQuestProgress[],
    skippedQuestIds: ReadonlySet<number>,
): number {
    let repaired = 0
    for (const entry of existingProgress) {
        if (!entry.finished || !skippedQuestIds.has(entry.questId)) continue
        const clearRank = entry.clearRank
        const bestElapsedTimeMs = entry.bestElapsedTimeMs
        const highScore = entry.highScore
        if (clearRank != null && bestElapsedTimeMs != null && highScore != null) continue
        updatePlayerQuestProgressSync(playerId, MAIN_QUEST_SECTION, {
            questId: entry.questId,
            ...(clearRank == null ? { clearRank: SKIPPED_QUEST_CLEAR_RANK } : {}),
            ...(bestElapsedTimeMs == null ? { bestElapsedTimeMs: SKIPPED_QUEST_CLEAR_TIME_MS } : {}),
            ...(highScore == null ? { highScore: SKIPPED_QUEST_HIGH_SCORE } : {}),
        })
        repaired += 1
    }
    return repaired
}

/**
 * Marks chapters 1..chapter-1 finished so the player starts at `chapter`, and
 * mails the first-clear rewards of the quests it finished.
 *
 * `chapter` is bounded by what content actually has, because the caller reports
 * the chapter's current quest back to the bot: a chapter with no quests would
 * make that value meaningless. `1` is a valid no-op: nothing is left to clear, and
 * the current-quest pointer is left exactly as it was (a save that never left
 * chapter 1 keeps its null pointer rather than being handed a synthetic one).
 *
 * A save that already reached `chapter` is left untouched and reported through
 * `alreadyAhead` — the shortcut is forward-only.
 */
export function skipPlayerToChapterSync(
    playerId: number,
    chapter: number,
    options: { readonly occurredAtMs?: number } = {},
): ChapterSkipResult {
    if (!Number.isSafeInteger(playerId) || playerId <= 0) {
        throw new ChapterSkipError("playerId must be a positive safe integer")
    }
    if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > MAX_MAIN_CHAPTER) {
        throw new ChapterSkipError(
            `chapter must be an integer between 1 and ${MAX_MAIN_CHAPTER}`,
        )
    }
    const occurredAtMs = options.occurredAtMs ?? Date.now()
    if (!Number.isFinite(occurredAtMs)) {
        throw new ChapterSkipError("occurredAtMs must be a finite timestamp")
    }

    const currentQuestId = getPlayerLastMainQuestIdSync(playerId)
    const targetQuestId = getChapterStartQuestId(chapter)
    const completedChapters = chapter - 1
    // Chapter 1 has nothing to skip: the player is already standing on it, so the
    // set is empty and the call degenerates into a repair of older fabricated rows.
    const questIds = chapter === 1
        ? []
        : [...new Set(getMainQuestIdsForChapters(
            Array.from({ length: completedChapters }, (_unused, index) => index + 1),
        ))]
    const skippedQuestIds = new Set(questIds)
    const readExistingProgress = () => getPlayerQuestProgressSync(playerId, [MAIN_QUEST_SECTION])[
        String(MAIN_QUEST_SECTION)
    ] ?? []

    if (targetQuestId !== null && currentQuestId !== null && targetQuestId <= currentQuestId) {
        const repaired = getDb().transaction(() => repairSkippedQuestRecordsSync(
            playerId,
            readExistingProgress(),
            skippedQuestIds,
        ))()
        return {
            chapter,
            questTotal: 0,
            newlyFinished: 0,
            recordedChapters: 0,
            lastMainQuestId: currentQuestId,
            alreadyAhead: true,
            repaired,
            mailedRewards: NO_MAIL,
        }
    }

    return getDb().transaction((): ChapterSkipResult => {
        const existingProgress = readExistingProgress()
        const finished = new Set(
            existingProgress.filter(entry => entry.finished).map(entry => entry.questId),
        )
        const known = new Set(existingProgress.map(entry => entry.questId))
        const byQuestId = new Map(existingProgress.map(entry => [entry.questId, entry]))

        const newlyFinishedQuestIds: number[] = []
        let repaired = 0
        for (const questId of questIds) {
            const wasFinished = finished.has(questId)
            if (known.has(questId)) {
                const previous = byQuestId.get(questId)
                const previousClearRank = previous?.clearRank
                const previousClearTime = previous?.bestElapsedTimeMs
                const previousHighScore = previous?.highScore
                if (previousClearRank == null || previousClearTime == null || previousHighScore == null) {
                    repaired += 1
                }
                updatePlayerQuestProgressSync(playerId, MAIN_QUEST_SECTION, {
                    questId,
                    finished: true,
                    unlocked: true,
                    ...(previousClearRank == null ? { clearRank: SKIPPED_QUEST_CLEAR_RANK } : {}),
                    ...(previousClearTime == null ? { bestElapsedTimeMs: SKIPPED_QUEST_CLEAR_TIME_MS } : {}),
                    ...(previousHighScore == null ? { highScore: SKIPPED_QUEST_HIGH_SCORE } : {}),
                })
            } else {
                insertPlayerQuestProgressSync(playerId, MAIN_QUEST_SECTION, {
                    questId,
                    finished: true,
                    unlocked: true,
                    hostFinished: true,
                    clearRank: SKIPPED_QUEST_CLEAR_RANK,
                    bestElapsedTimeMs: SKIPPED_QUEST_CLEAR_TIME_MS,
                    highScore: SKIPPED_QUEST_HIGH_SCORE,
                })
            }
            if (!wasFinished) newlyFinishedQuestIds.push(questId)
        }

        let recordedChapters = 0
        for (let completed = 1; completed <= completedChapters; completed++) {
            if (recordChapterMilestoneSync(playerId, completed, occurredAtMs)) {
                recordedChapters += 1
            }
        }

        // The pointer means "the quest the player is on": the client writes the
        // quest it just started, so the first quest of the target chapter is the
        // value a normally-progressing save would hold at exactly this point.
        // Chapter 1 writes nothing — see the function doc.
        const lastMainQuestId = chapter === 1
            ? currentQuestId
            : getChapterStartQuestId(chapter)
        if (lastMainQuestId !== null) {
            setPlayerLastMainQuestIdSync(playerId, lastMainQuestId)
        }

        return {
            chapter,
            questTotal: questIds.length,
            newlyFinished: newlyFinishedQuestIds.length,
            recordedChapters,
            lastMainQuestId,
            alreadyAhead: false,
            repaired,
            mailedRewards: mailFirstClearRewardsSync(playerId, newlyFinishedQuestIds),
        }
    })()
}

/** Number of milestone slots a chapter maps to, exposed for tests and callers. */
export function getChapterMilestoneSlot(chapter: number): number | null {
    if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > MAX_MAIN_CHAPTER) return null
    const slot = chapter <= EARLY_CHAPTER_MAX ? chapter - 1 : chapter - 7
    return slot >= 0 && slot < MILESTONE_SLOT_COUNT ? slot : null
}
