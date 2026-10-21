import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MailType, insertMailSync, insertReceiveHistorySync } from "../../data/domains/mail"
import { getMailArrivedSync } from "../../lib/mail-notification"
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import {
    getPlayerTriggeredTutorialsSync,
    getTutorialStepReceiptSync,
    insertPlayerTriggeredTutorialsSync,
    upsertTutorialStepReceiptSync,
} from "../../data/domains/tutorial"
import { getPlayerCharacterSync } from "../../data/domains/character"
import { getSession } from "../../data/domains/session"
import { getDb } from "../../data/db"
import { executeRewardGrantExecutionPlanAsTransactionOwnerSync } from "../../lib/reward-grant"
import { createRewardGrantItemOverflowPolicy } from "../../lib/reward-grant-item-overflow"
import { projectCharacterPatch } from "../../lib/common-response/entities"
import { mergeCommonResponseFragments } from "../../lib/common-response/merge"
import { projectItemOverflowCommonResponse } from "../../lib/item-overflow/common-response"
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { generateDataHeaders, getServerTime } from "../../utils";
import { getGachaCatalog } from "../../lib/gacha-catalog";
import { rewardPlayerGachaDrawResultSync } from "../../lib/gacha";
import { givePlayerCharacterSync } from "../../lib/character";
import { randomInt } from "crypto";
import { GachaCharacterDraw } from "../../lib/types";
import { publishCharacterGrowthOwnerStateBestEffort } from "../../lib/character-growth/owner-publication";
import { getRealNow, getVirtualNow } from "../../runtime/time/game-time";
import {
    getTutorialEffectiveNextStep,
    TUTORIAL_END_EFFECTIVE_STEP,
    TUTORIAL_GACHA_CHARACTER_IDS,
    TUTORIAL_GACHA_EFFECTIVE_STEP,
    TUTORIAL_PRESENT_EFFECTIVE_STEP,
} from "../../lib/start-tutorial-state";
import {
    characterGrowthProjectionStateFromPlayerCharacter,
    projectCharacterGrowthEntry,
} from "../../lib/character-growth/response-projector"

interface UpdateStepBody {
    viewer_id: number
    step: number
    api_count: number
    skip: boolean
    statistics: Object
    name?: string
    gacha_id?: number
}

interface FinishTriggerBody {
    api_count: number,
    tutorial_ids: number[],
    viewer_id: number
}

const freeTutorialCharacterId = 243001

function serializeTutorialReplayCharacter(
    viewerId: number,
    characterId: number,
    character: NonNullable<ReturnType<typeof getPlayerCharacterSync>>,
) {
    return projectCharacterGrowthEntry({
        characterId,
        character,
        state: characterGrowthProjectionStateFromPlayerCharacter(characterId, character),
        viewerId,
        fields: [
            "entry_count",
            "evolution_level",
            "over_limit_step",
            "protection",
            "join_time",
            "update_time",
            "exp",
            "stack",
            "mana_board_index",
            "bond_token_list",
            "ex_boost",
        ],
    })
}

function buildTutorialGachaReplayData(
    playerId: number,
    viewerId: number,
    gachaId: number,
    effectiveNextStep: number,
) {
    const player = getPlayerSync(playerId)
    const characterId = player?.tutorialGachaCharacterId
    if (player === null || characterId === null || characterId === undefined) {
        throw new Error("Tutorial gacha step is missing its persisted draw result")
    }

    const character = getPlayerCharacterSync(playerId, characterId)
    return {
        "step": effectiveNextStep,
        ...mergeCommonResponseFragments([{
            "user_info": {
                "free_vmoney": player.freeVmoney,
            },
            "character_list": character === null
                ? []
                : [projectCharacterPatch(
                    serializeTutorialReplayCharacter(viewerId, characterId, character),
                )],
            "item_list": {},
            "mail_arrived": getMailArrivedSync(playerId),
        }]),
        "gacha": {
            "draw": [{
                "character_id": characterId,
                "entry_count": character?.entryCount ?? 1,
                "movie_id": "normal_guarantee",
                "seed": 10007656,
            }],
            "gacha_info_list": [{
                "gacha_id": gachaId,
                "is_account_first": false,
                "is_daily_first": false,
            }],
        },
        "encyclopedia_info": [],
        "start_time": getServerTime(),
    }
}

function buildTutorialPresentReplayData(
    playerId: number,
    effectiveNextStep: number,
) {
    const player = getPlayerSync(playerId)
    if (player === null) throw new Error("Tutorial player disappeared during replay")
    const character = getPlayerCharacterSync(playerId, freeTutorialCharacterId)

    return {
        "step": effectiveNextStep,
        ...mergeCommonResponseFragments([{
            "user_info": {
                "free_vmoney": player.freeVmoney,
            },
            "character_list": character === null
                ? []
                : [projectCharacterPatch(
                    serializeTutorialReplayCharacter(0, freeTutorialCharacterId, character),
                )],
            "item_list": {},
            "mail_arrived": getMailArrivedSync(playerId),
        }]),
        "encyclopedia_info": {
            [`1${freeTutorialCharacterId}01`]: {
                "read": false,
            },
        },
        "start_time": getServerTime(),
    }
}

/**
 * 教程收尾响应。
 *
 * 2026-10-20 真机事故：玩家「继续教程」后闪退、重进又回到同一处（设备 2191721912002 /
 * 账号 41）。崩溃载荷是 G3000（reproduce 校验失败），而库里 `players_tutorial_step_receipts`
 * 存下的正是这份响应 —— 四个列表字段全是 `null`。客户端把教程收尾数据并回本地存档时，
 * 这几个字段是当数组遍历的（`/api/index.php/load` 那条路一直给 `[]`），`null` 直接把它打崩，
 * 于是「崩 → 重进 → 再走同一步 → 再崩」。
 *
 * 因此这里与 load 对齐：列表字段一律给空数组，标量保持 null。
 */
function buildTutorialEndData() {
    return {
        "bonus_index_list": [],
        "premium_bonus_index_list": [],
        "premium_bonus_mailed_item_list": [],
        "login_bonus_received_at": null,
        "start_dash_exchange_campaign_list": [],
        "start_time": getServerTime(),
    }
}

/** 旧收尾响应里的 `null` 列表字段就地纠正（已经落库的 receipt 也会被修好，无需清库）。 */
const TUTORIAL_LIST_FIELDS = [
    "bonus_index_list",
    "premium_bonus_index_list",
    "premium_bonus_mailed_item_list",
    "start_dash_exchange_campaign_list",
] as const

function normalizeTutorialListFields(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...data }
    for (const field of TUTORIAL_LIST_FIELDS) {
        if (result[field] === null) result[field] = []
    }
    return result
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/finish_trigger", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as FinishTriggerBody

        const viewerId = body.viewer_id
        const tutorialIds = body.tutorial_ids
        if (!Number.isSafeInteger(viewerId)
            || viewerId <= 0
            || !Array.isArray(tutorialIds)
            || tutorialIds.some(tutorialId => !Number.isSafeInteger(tutorialId) || tutorialId <= 0)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        if (playerId === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // Mark tutorial as having been completed (skip already triggered)
        const existing = new Set(getPlayerTriggeredTutorialsSync(playerId))
        const pending = [...new Set(tutorialIds)].filter(tutorialId => !existing.has(tutorialId))
        if (pending.length > 0) insertPlayerTriggeredTutorialsSync(playerId, pending)

        reply.header("content-type", "application/x-msgpack")
        reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": []
        })
    })

    fastify.post("/update_step", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateStepBody

        const viewerId = body.viewer_id
        const completedStep = body.step
        const skip = body.skip || false
        if (!viewerId || isNaN(completedStep) || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const storedNextStep = completedStep + 1
        const effectiveNextStep = getTutorialEffectiveNextStep(completedStep, skip)
        const gachaId = effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP
            && body.gacha_id !== undefined
            && !isNaN(body.gacha_id)
            ? body.gacha_id
            : null
        const gachaData = gachaId === null
            ? null
            : getGachaCatalog().banners[String(gachaId)]?.definition ?? null
        const tutorialGachaCost = gachaData?.page.kind === 0 || gachaData?.page.kind === 8
            ? gachaData.page.singleCost
            : null

        let deferredCharacterSampledLog: (() => void) | undefined
        const result = getDb().transaction(() => {
            const currentPlayer = getPlayerSync(playerId)
            if (currentPlayer === null) throw new Error("Tutorial player disappeared during update")

            const tutorialBranchAlreadyChosen = currentPlayer.tutorialStep !== 0
                || currentPlayer.tutorialSkipFlag !== null
            if (
                tutorialBranchAlreadyChosen
                && Boolean(currentPlayer.tutorialSkipFlag) !== skip
            ) {
                return {
                    ok: false,
                    message: "Tutorial branch does not match the persisted progress.",
                } as const
            }

            const receipt = getTutorialStepReceiptSync(playerId)
            if (
                receipt !== null
                && receipt.completedStep === completedStep
                && receipt.skip === skip
                && (
                    currentPlayer.tutorialStep === storedNextStep
                    || (
                        currentPlayer.tutorialStep === null
                        && effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP
                    )
                )
            ) {
                return {
                    ok: true,
                    data: normalizeTutorialListFields(receipt.responseData),
                } as const
            }

            if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP
                && (gachaData === null || tutorialGachaCost === null)) {
                return {
                    ok: false,
                    message: gachaId === null
                        ? "Tutorial gacha step requires a valid gacha id."
                        : `Gacha with id '${body.gacha_id}' does not exist.`,
                } as const
            }

            if (currentPlayer.tutorialStep === null) {
                if (effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP) {
                    return { ok: true, data: buildTutorialEndData() } as const
                }
                // 2026-10-20 真机事故（设备 2191721912002 / 账号 41「clown」）：教程**已经完成**
                // 的玩家重走一遍时，这里原来直接回「Tutorial already completed.」⇒ 客户端收到
                // 400，卡在「继续教程」里闪退、重进再走同一处。已完成就一律按「回放」应答，
                // 形状与下面 isReplay 的三种分支对齐，绝不回错误。
                if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP
                    && gachaId !== null
                    && gachaData !== null
                    && tutorialGachaCost !== null) {
                    return {
                        ok: true,
                        data: buildTutorialGachaReplayData(
                            playerId,
                            viewerId,
                            gachaId,
                            effectiveNextStep,
                        ),
                    } as const
                }
                if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {
                    return {
                        ok: true,
                        data: buildTutorialPresentReplayData(playerId, effectiveNextStep),
                    } as const
                }
                return {
                    ok: true,
                    data: {
                        "step": effectiveNextStep,
                        "mail_arrived": getMailArrivedSync(playerId),
                        "start_time": getServerTime(),
                    },
                } as const
            }

            const isReplay = currentPlayer.tutorialStep === storedNextStep
            if (!isReplay && currentPlayer.tutorialStep !== completedStep) {
                return {
                    ok: false,
                    message: "Tutorial step does not match the persisted progress.",
                } as const
            }

            if (isReplay) {
                if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                    return {
                        ok: true,
                        data: buildTutorialGachaReplayData(
                            playerId,
                            viewerId,
                            gachaId!,
                            effectiveNextStep,
                        ),
                    } as const
                }
                if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {
                    return {
                        ok: true,
                        data: buildTutorialPresentReplayData(playerId, effectiveNextStep),
                    } as const
                }
                return {
                    ok: true,
                    data: {
                        "step": effectiveNextStep,
                        ...(body.name === undefined ? {} : { "name": currentPlayer.name }),
                        "mail_arrived": getMailArrivedSync(playerId),
                        "start_time": getServerTime(),
                    },
                } as const
            }

            if (effectiveNextStep === TUTORIAL_GACHA_EFFECTIVE_STEP) {
                const randomCharacterIndex = randomInt(0, TUTORIAL_GACHA_CHARACTER_IDS.length)
                const randomCharacterId = TUTORIAL_GACHA_CHARACTER_IDS[randomCharacterIndex]
                const rewardResult = rewardPlayerGachaDrawResultSync(
                    playerId,
                    gachaData!,
                    [randomCharacterId],
                    undefined,
                    undefined,
                    {
                        ownerGrant: plan => executeRewardGrantExecutionPlanAsTransactionOwnerSync(
                            playerId,
                            plan,
                            {
                                playerId: currentPlayer.id,
                                freeMana: currentPlayer.freeMana,
                                freeVmoney: currentPlayer.freeVmoney,
                                expPool: currentPlayer.expPool,
                            },
                            { itemOverflow: createRewardGrantItemOverflowPolicy(playerId) },
                        ),
                        deferCharacterSampledLog: log => { deferredCharacterSampledLog = log },
                    },
                )
                insertReceiveHistorySync(playerId, {
                    type: MailType.CHARACTER,
                    type_id: randomCharacterId,
                    number: 1,
                })

                const newFreeVmoney = currentPlayer.freeVmoney - tutorialGachaCost!
                updatePlayerSync({
                    id: playerId,
                    tutorialStep: storedNextStep,
                    tutorialSkipFlag: skip,
                    tutorialGachaCharacterId: randomCharacterId,
                    freeVmoney: newFreeVmoney,
                    name: body.name,
                })

                const draw = rewardResult.draw[0] as GachaCharacterDraw
                draw.movie_id = "normal_guarantee"
                draw.seed = 10007656

                const existingCharacterList = rewardResult.characters.filter(
                    (character): character is Record<string, unknown> =>
                        character !== undefined
                        && character !== null
                        && typeof character === "object"
                        && !Array.isArray(character)
                )
                const characterList = existingCharacterList.length > 0
                    ? (() => {
                        return publishCharacterGrowthOwnerStateBestEffort(
                            playerId,
                            [randomCharacterId],
                            [existingCharacterList],
                            {},
                            "tutorial/gacha",
                            getVirtualNow(),
                        ).characterList
                    })()
                    : existingCharacterList

                const overMax = rewardResult.itemOverflowDispositions === undefined
                    ? undefined
                    : projectItemOverflowCommonResponse(rewardResult.itemOverflowDispositions)
                const data = {
                    "step": effectiveNextStep,
                    ...mergeCommonResponseFragments([{
                        "user_info": {
                            "free_vmoney": newFreeVmoney,
                            ...(rewardResult.playerAfter === undefined
                                ? {}
                                : { "free_mana": rewardResult.playerAfter.freeMana }),
                        },
                        "character_list": characterList.map(entry => projectCharacterPatch(entry)),
                        "item_list": rewardResult.items,
                        "mail_arrived": getMailArrivedSync(playerId),
                        ...(overMax === undefined || overMax.length === 0
                            ? {}
                            : { "over_max": overMax }),
                    }]),
                    "gacha": {
                        "draw": rewardResult.draw,
                        "gacha_info_list": [
                            {
                                "gacha_id": gachaId,
                                "is_account_first": false,
                                "is_daily_first": false,
                            }
                        ],
                    },
                    "encyclopedia_info": [],
                    "start_time": getServerTime(),
                }
                upsertTutorialStepReceiptSync(playerId, {
                    completedStep,
                    skip,
                    responseData: data,
                })
                return { ok: true, data } as const
            }

            if (effectiveNextStep === TUTORIAL_PRESENT_EFFECTIVE_STEP) {
                const newVMoney = currentPlayer.freeVmoney + 1500
                insertReceiveHistorySync(playerId, {
                    type: MailType.FREE_VMONEY,
                    type_id: null,
                    number: 1500,
                })

                const giveResult = givePlayerCharacterSync(playerId, freeTutorialCharacterId)
                const existingCharacterList: Record<string, unknown>[] = giveResult?.character
                    ? [giveResult.character as Record<string, unknown>]
                    : []
                const itemList = giveResult?.item
                    ? { [giveResult.item.id]: giveResult.item.count }
                    : {}
                insertReceiveHistorySync(playerId, {
                    type: MailType.CHARACTER,
                    type_id: freeTutorialCharacterId,
                    number: 1,
                })

                insertMailSync(playerId, {
                    reason_id: 0,
                    subject: null,
                    description: null,
                    type: MailType.FREE_VMONEY,
                    type_id: null,
                    number: 500,
                    receive_time: "0000-00-00 00:00:00",
                    create_time: getRealNow().toISOString().replace("T", " ").substring(0, 19),
                    reward_period_limited: 0,
                    reward_limit_time: null,
                })
                updatePlayerSync({
                    id: playerId,
                    tutorialStep: storedNextStep,
                    tutorialSkipFlag: skip,
                    freeVmoney: newVMoney,
                    name: body.name,
                })

                const characterList = existingCharacterList.length > 0
                    ? (() => {
                        return publishCharacterGrowthOwnerStateBestEffort(
                            playerId,
                            [freeTutorialCharacterId],
                            [existingCharacterList],
                            {},
                            "tutorial/free-character",
                            getVirtualNow(),
                        ).characterList
                    })()
                    : existingCharacterList

                const data = {
                    "step": effectiveNextStep,
                    ...mergeCommonResponseFragments([{
                        "user_info": {
                            "free_vmoney": newVMoney,
                        },
                        "character_list": characterList.map(entry => projectCharacterPatch(entry)),
                        "item_list": itemList,
                        "mail_arrived": true,
                    }]),
                    "encyclopedia_info": {
                        [`1${freeTutorialCharacterId}01`]: {
                            "read": false
                        }
                    },
                    "start_time": getServerTime()
                }
                upsertTutorialStepReceiptSync(playerId, {
                    completedStep,
                    skip,
                    responseData: data,
                })
                return { ok: true, data } as const
            }

            const isTutorialEnd = effectiveNextStep === TUTORIAL_END_EFFECTIVE_STEP
            updatePlayerSync({
                id: playerId,
                tutorialStep: isTutorialEnd ? null : storedNextStep,
                tutorialSkipFlag: skip,
                name: body.name,
            })
            if (isTutorialEnd) {
                const data = buildTutorialEndData()
                upsertTutorialStepReceiptSync(playerId, {
                    completedStep,
                    skip,
                    responseData: data,
                })
                return { ok: true, data } as const
            }
            const data = {
                "step": effectiveNextStep,
                ...(body.name === undefined ? {} : { "name": body.name }),
                "mail_arrived": getMailArrivedSync(playerId),
                "start_time": getServerTime(),
            }
            upsertTutorialStepReceiptSync(playerId, {
                completedStep,
                skip,
                responseData: data,
            })
            return { ok: true, data } as const
        })()

        deferredCharacterSampledLog?.()

        if (!result.ok) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": result.message,
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": result.data,
        })
    })
}

export default routes;
