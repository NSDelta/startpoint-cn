import { getDb } from "../../data/db"
import {
    getPlayerQuestProgressSync,
    insertPlayerQuestProgressSync,
    updatePlayerQuestProgressSync,
} from "../../data/domains/quest"
import { setPlayerLastMainQuestIdSync } from "../../data/domains/player"
import { QuestCategory } from "../types/quest"
import { getMainQuestIdsForChapter } from "../quest-content"
import { recordPlayerHistoryMilestoneSync } from "../../data/domains/player-history-facts"

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

export class ChapterSkipError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ChapterSkipError"
    }
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
     * Main quest set as the player's current quest — the first quest of the
     * target chapter, or null for a chapter-1 no-op.
     */
    readonly lastMainQuestId: number | null
}

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

/**
 * Marks chapters 1..chapter-1 finished so the player starts at `chapter`.
 *
 * `chapter` is bounded by what content actually has, because the caller reports
 * the chapter's current quest back to the bot: a chapter with no quests would
 * make that value meaningless. `1` is a valid no-op that only moves the
 * current-quest pointer.
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

    const completedChapters = chapter - 1
    const progressionQuests = getMainQuestIdsForChapters(
        Array.from({ length: completedChapters }, (_unused, index) => index + 1),
    )
    // Chapter 1 has nothing to skip: the player is already standing on it, and
    // the caller only needs the current-quest pointer moved.
    const questIds = chapter === 1
        ? []
        : [...new Set(progressionQuests)]

    return getDb().transaction((): ChapterSkipResult => {
        const existingProgress = getPlayerQuestProgressSync(playerId, [MAIN_QUEST_SECTION])[
            String(MAIN_QUEST_SECTION)
        ] ?? []
        const finished = new Set(
            existingProgress.filter(entry => entry.finished).map(entry => entry.questId),
        )
        const known = new Set(existingProgress.map(entry => entry.questId))

        let newlyFinished = 0
        for (const questId of questIds) {
            const wasFinished = finished.has(questId)
            if (known.has(questId)) {
                updatePlayerQuestProgressSync(playerId, MAIN_QUEST_SECTION, {
                    questId,
                    finished: true,
                    unlocked: true,
                })
            } else {
                insertPlayerQuestProgressSync(playerId, MAIN_QUEST_SECTION, {
                    questId,
                    finished: true,
                    unlocked: true,
                    hostFinished: true,
                })
            }
            if (!wasFinished) newlyFinished += 1
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
        const lastMainQuestId = chapter === 1 ? null : getChapterStartQuestId(chapter)
        if (lastMainQuestId !== null) {
            setPlayerLastMainQuestIdSync(playerId, lastMainQuestId)
        }

        return {
            chapter,
            questTotal: questIds.length,
            newlyFinished,
            recordedChapters,
            lastMainQuestId,
        }
    })()
}

/** Number of milestone slots a chapter maps to, exposed for tests and callers. */
export function getChapterMilestoneSlot(chapter: number): number | null {
    if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > MAX_MAIN_CHAPTER) return null
    const slot = chapter <= EARLY_CHAPTER_MAX ? chapter - 1 : chapter - 7
    return slot >= 0 && slot < MILESTONE_SLOT_COUNT ? slot : null
}
