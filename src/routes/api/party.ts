import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getSession } from "../../data/domains/session"
import { playerOwnsCharacterSync } from "../../data/domains/character"
import { getPlayerEquipmentListSync } from "../../data/domains/equipment"
import { getPlayerItemsSync } from "../../data/domains/item"
import { getPlayerPartyLoadoutSync, updatePlayerPartySync } from "../../data/domains/party"
import { getDb } from "../../data/db"
import { incrementActiveMissionPartyActionCountsSync } from "../../data/domains/active_mission_counters"
import { generateDataHeaders, getServerTime } from "../../utils";
import { PartyCategory, PROFILE_FAVORITE_PARTY_CATEGORY } from "../../data/types";
import { resolvePlayerIdSync } from "../../data/activeAccount";
import { hasValidPartyCategory, isGlobalPartyIdAllowedForCategory, parseGlobalPartyId } from "../../lib/special-event-parties";
import { getMailArrivedSync } from "../../lib/mail-notification";
import {
    getRaidSetEditMissionIds,
    recordRaidSetEditMissionFactsSync,
} from "../../lib/mission/event-entry-facts";
import { validatePartyLoadouts } from "../../lib/party-loadout-validation";
import { settleAbilitySoulEquipFactsSync } from "../../lib/mission/operation-fact-settlement";
import { settleMissionCategories, type MissionSettlementResult } from "../../lib/mission/settlement";
import { mergeMissionSettlementResponse } from "../../lib/mission/response";
import { publishActiveMissionOwnerStateWithinTransaction } from "../../lib/mission/active-publication-owner";
import { mergeCommonResponseFragments } from "../../lib/common-response/merge";
import {
    partyCodeRegistry,
    type PartyCodeCharacter,
    type PartyCodeEquipment,
    type PartyCodePayload,
} from "../../lib/party-code/registry";

interface PartyInfoListItem {
    party_edited: boolean
    party_category: number
    party_name: string
    party_id: number
    unison_character_ids: (number | null)[]
    equipment_ids: (number | null)[]
    character_ids: (number | null)[]
    ability_soul_ids: (number | null)[]
    options: {
        allow_other_players_to_heal_me: boolean
    }
    current_battle_power?: number
    before_battle_power?: number
}

interface EditBody {
    use_party_group_edit: boolean,
    main_party_id: number,
    viewer_id: number,
    ignore_ngword: boolean,
    api_count: number,
    party_info_list: PartyInfoListItem[]
}

function hasEditablePartyCategory(
    value: unknown,
): value is { party_category: PartyCategory } {
    if (value !== null
        && typeof value === "object"
        && "party_category" in value
        && (value as { party_category: unknown }).party_category === PROFILE_FAVORITE_PARTY_CATEGORY) {
        return true
    }
    return hasValidPartyCategory(value)
}

function isProfileFavoriteParty(info: PartyInfoListItem): boolean {
    return info.party_category === PROFILE_FAVORITE_PARTY_CATEGORY
}

function summarizePartyEditRequest(body: Partial<EditBody>, viewerId: unknown) {
    const partyInfoList = Array.isArray(body.party_info_list) ? body.party_info_list : []
    return {
        viewerValid: Number.isSafeInteger(viewerId) && (viewerId as number) > 0,
        mainPartyId: Number.isSafeInteger(body.main_party_id) ? body.main_party_id : null,
        partyInfoCount: partyInfoList.length,
        partyRefs: partyInfoList.slice(0, 32).map(info => ({
            category: Number.isSafeInteger(info?.party_category) ? info.party_category : null,
            partyId: Number.isSafeInteger(info?.party_id) ? info.party_id : null,
        })),
    }
}

/*
{
    "api_count": 2,
    "party_name": "Party G",
    "battle_party": {
        "equipments": [
            {
                "equipment_id": 5040028,
                "level": 5
            },
            {
                "equipment_id": 5090023,
                "level": 5
            },
            {
                "equipment_id": 5040029,
                "level": 5
            }
        ],
        "ability_soul_ids": [
            5010058,
            5040029,
            5040029
        ],
        "unison_characters": [
            {
                "id": 241045,
                "ex_boost": {
                    "status_id": 5,
                    "ability_id_list": [
                        15,
                        39
                    ]
                },
                "over_limit_step": 6,
                "mana_node_ids": [
                    482090201,
                    482090202,
                    482090203,
                    482090204,
                    482090205,
                    482090206,
                    482090207,
                    482090208,
                    482090209,
                    482090210,
                    482090211,
                    482090212,
                    482090213,
                    482090214,
                    482090215,
                    482090216,
                    482090217,
                    482090218,
                    482090219,
                    482090220,
                    482090221,
                    482090222,
                    482090223,
                    482090401,
                    482090402,
                    482090403,
                    482090404,
                    482090405,
                    482090406,
                    482090407,
                    482090408,
                    482090409,
                    482090410,
                    482090411,
                    482090412,
                    482090413,
                    482090414,
                    482090415,
                    482090416,
                    482090417,
                    482090418
                ],
                "illustration_settings": null,
                "evolution_level": 1,
                "exp": 342410
            },
            {
                "id": 141063,
                "ex_boost": {
                    "status_id": 3,
                    "ability_id_list": [
                        7,
                        35
                    ]
                },
                "over_limit_step": 4,
                "mana_node_ids": [
                    282126201,
                    282126202,
                    282126203,
                    282126204,
                    282126205,
                    282126206,
                    282126207,
                    282126208,
                    282126209,
                    282126210,
                    282126211,
                    282126212,
                    282126213,
                    282126214,
                    282126215,
                    282126216,
                    282126217,
                    282126218,
                    282126219,
                    282126220,
                    282126221,
                    282126222,
                    282126223,
                    282126401,
                    282126402,
                    282126403,
                    282126404,
                    282126405,
                    282126406,
                    282126407,
                    282126408,
                    282126409,
                    282126410,
                    282126411,
                    282126412,
                    282126413,
                    282126414,
                    282126415,
                    282126416,
                    282126417,
                    282126418
                ],
                "illustration_settings": null,
                "evolution_level": 1,
                "exp": 379988
            },
            {
                "id": 341009,
                "ex_boost": {
                    "status_id": 3,
                    "ability_id_list": [
                        19,
                        52
                    ]
                },
                "over_limit_step": 8,
                "mana_node_ids": [
                    682018201,
                    682018202,
                    682018203,
                    682018204,
                    682018205,
                    682018206,
                    682018207,
                    682018208,
                    682018209,
                    682018210,
                    682018211,
                    682018212,
                    682018213,
                    682018214,
                    682018215,
                    682018216,
                    682018217,
                    682018218,
                    682018219,
                    682018220,
                    682018221,
                    682018222,
                    682018223,
                    682018401
                ],
                "illustration_settings": null,
                "evolution_level": 1,
                "exp": 308043
            }
        ],
        "characters": [
            {
                "id": 241069,
                "ex_boost": {
                    "status_id": 3,
                    "ability_id_list": [
                        9,
                        38
                    ]
                },
                "over_limit_step": 6,
                "mana_node_ids": [
                    482138201,
                    482138202,
                    482138203,
                    482138204,
                    482138205,
                    482138206,
                    482138207,
                    482138208,
                    482138209,
                    482138210,
                    482138211,
                    482138212,
                    482138213,
                    482138214,
                    482138215,
                    482138216,
                    482138217,
                    482138218,
                    482138219,
                    482138220,
                    482138221,
                    482138222,
                    482138223,
                    482138401,
                    482138402,
                    482138403,
                    482138404,
                    482138405,
                    482138406,
                    482138407,
                    482138408,
                    482138409,
                    482138410,
                    482138411,
                    482138412,
                    482138413,
                    482138414,
                    482138415,
                    482138416,
                    482138417,
                    482138418
                ],
                "illustration_settings": null,
                "evolution_level": 1,
                "exp": 342410
            },
            {
                "id": 141045,
                "ex_boost": {
                    "status_id": 3,
                    "ability_id_list": [
                        8,
                        41
                    ]
                },
                "over_limit_step": 4,
                "mana_node_ids": [
                    282090201,
                    282090202,
                    282090203,
                    282090204,
                    282090205,
                    282090206,
                    282090207,
                    282090208,
                    282090209,
                    282090210,
                    282090211,
                    282090212,
                    282090213,
                    282090214,
                    282090215,
                    282090216,
                    282090217,
                    282090218,
                    282090219,
                    282090220,
                    282090221,
                    282090222,
                    282090223,
                    282090401,
                    282090402,
                    282090403,
                    282090404,
                    282090405,
                    282090406,
                    282090407,
                    282090408,
                    282090409,
                    282090410,
                    282090411,
                    282090412,
                    282090413,
                    282090414,
                    282090415,
                    282090416,
                    282090417,
                    282090418
                ],
                "illustration_settings": null,
                "evolution_level": 1,
                "exp": 379988
            },
            {
                "id": 141141,
                "ex_boost": null,
                "over_limit_step": 4,
                "mana_node_ids": [
                    282282201,
                    282282202,
                    282282203,
                    282282204,
                    282282205,
                    282282206,
                    282282207,
                    282282208,
                    282282209,
                    282282210,
                    282282211,
                    282282212,
                    282282213,
                    282282214,
                    282282215,
                    282282216,
                    282282217,
                    282282218,
                    282282219,
                    282282220,
                    282282221,
                    282282222,
                    282282223
                ],
                "illustration_settings": null,
                "evolution_level": 1,
                "exp": 379988
            }
        ]
    },
    "viewer_id": 276818168
}
*/
interface PublishBody {
    party_name: string,
    battle_party: unknown,
    viewer_id: number
}

/** Refer result codes understood by `PartyReferRemote.errorHandler` (case 8). */
const PARTY_CODE_NOT_FOUND_RESULT_CODE = 3404

/**
 * Ceiling on the slots one `battle_party` list may carry. The editor only ever
 * sends a handful, so this exists to reject a hand-crafted payload that would
 * otherwise be copied straight into the process-wide code directory.
 */
const PARTY_CODE_MAX_SLOTS = 64

function readSafeInteger(value: unknown): number | null {
    return Number.isSafeInteger(value) ? value as number : null
}

/**
 * Reads one `Array<int>` of the client's battle party. `null` and a missing key
 * both mean "absent", which the client renders as `Option.None`.
 */
function readIntegerList(value: unknown): number[] | null {
    if (value === null || value === undefined) return null
    if (!Array.isArray(value)) return null
    const list: number[] = []
    for (const entry of value) {
        const parsed = readSafeInteger(entry)
        if (parsed === null) return null
        list.push(parsed)
    }
    return list
}

/**
 * Reads one `Array<Int or null>` slot list, such as `ability_soul_ids`, where an
 * empty battle slot is a `null` element rather than an absent entry.
 */
function readOptionalIntegerList(value: unknown): (number | null)[] | null {
    if (!Array.isArray(value) || value.length > PARTY_CODE_MAX_SLOTS) return null
    const list: (number | null)[] = []
    for (const entry of value) {
        if (entry === null || entry === undefined) {
            list.push(null)
            continue
        }
        const parsed = readSafeInteger(entry)
        if (parsed === null) return null
        list.push(parsed)
    }
    return list
}

/**
 * Reads one `ex_boost` slot. `status_id` must stay absent rather than fall back
 * to 0: the client feeds it straight into `ExStatusLogic`, whose master table
 * starts at id 1, so a zeroed status throws instead of degrading.
 */
function readExBoost(value: unknown): { statusId: number; abilityIdList: number[] } | null {
    if (value === null || value === undefined) return null
    if (typeof value !== "object") return null
    const raw = value as { status_id?: unknown; ability_id_list?: unknown }
    const statusId = readSafeInteger(raw.status_id)
    const abilityIdList = readIntegerList(raw.ability_id_list)
    if (statusId === null || statusId <= 0 || abilityIdList === null) return null
    return { statusId, abilityIdList }
}

function readPartyCharacter(value: unknown): PartyCodeCharacter | null {
    if (value === null || value === undefined) return null
    if (typeof value !== "object") return null
    const raw = value as Record<string, unknown>
    const id = readSafeInteger(raw.id)
    const evolutionLevel = readSafeInteger(raw.evolution_level)
    const exp = readSafeInteger(raw.exp)
    const overLimitStep = readSafeInteger(raw.over_limit_step)
    if (id === null || id <= 0
        || evolutionLevel === null || evolutionLevel < 0
        || exp === null || exp < 0
        || overLimitStep === null || overLimitStep < 0) {
        return null
    }
    return {
        id,
        evolutionLevel,
        exp,
        overLimitStep,
        // An empty array is honest here: the client only copies the ids it can
        // find in the redeemer's own party, so a fabricated node list is noise.
        manaNodeIds: readIntegerList(raw.mana_node_ids) ?? [],
        illustrationSettings: readIntegerList(raw.illustration_settings),
        exBoost: readExBoost(raw.ex_boost),
    }
}

function readPartySlot(
    value: unknown,
    read: (entry: unknown) => PartyCodeCharacter | null,
): (PartyCodeCharacter | null)[] | null {
    if (!Array.isArray(value) || value.length > PARTY_CODE_MAX_SLOTS) return null
    const slots: (PartyCodeCharacter | null)[] = []
    for (const entry of value) {
        if (entry === null || entry === undefined) {
            slots.push(null)
            continue
        }
        const character = read(entry)
        if (character === null) return null
        slots.push(character)
    }
    return slots
}

function readPartyEquipment(value: unknown): PartyCodeEquipment | null {
    if (value === null || value === undefined) return null
    if (typeof value !== "object") return null
    const raw = value as Record<string, unknown>
    const equipmentId = readSafeInteger(raw.equipment_id)
    const level = readSafeInteger(raw.level)
    if (equipmentId === null || equipmentId <= 0 || level === null || level < 0) return null
    return { equipmentId, level }
}

/**
 * Normalises the client's `party/publish` payload. Every list keeps the slot
 * count the client sent — the party editor renders slots positionally, so
 * trimming a trailing empty slot would shift the copied party.
 */
function readPartyCodePayload(body: PublishBody): PartyCodePayload | null {
    const name = typeof body.party_name === "string" ? body.party_name : ""
    const battleParty = body.battle_party
    if (battleParty === null || typeof battleParty !== "object") return null
    const raw = battleParty as Record<string, unknown>
    const characters = readPartySlot(raw.characters, readPartyCharacter)
    const unisonCharacters = readPartySlot(raw.unison_characters, readPartyCharacter)
    const equipments = Array.isArray(raw.equipments) && raw.equipments.length <= PARTY_CODE_MAX_SLOTS
        ? raw.equipments.map(readPartyEquipment)
        : null
    const abilitySoulIds = readOptionalIntegerList(raw.ability_soul_ids)
    if (characters === null || unisonCharacters === null
        || equipments === null || abilitySoulIds === null) {
        return null
    }
    return {
        name: name.substring(0, 20),
        characters,
        unisonCharacters,
        equipments,
        abilitySoulIds,
    }
}

/** Least-normalised view of a published party, in the client's own field names. */
function serializePartyCodeBattleParty(party: PartyCodePayload) {
    const character = (slot: PartyCodeCharacter | null) => slot === null ? null : {
        id: slot.id,
        evolution_level: slot.evolutionLevel,
        exp: slot.exp,
        over_limit_step: slot.overLimitStep,
        mana_node_ids: [...slot.manaNodeIds],
        illustration_settings: slot.illustrationSettings === null ? null : [...slot.illustrationSettings],
        ex_boost: slot.exBoost === null ? null : {
            status_id: slot.exBoost.statusId,
            ability_id_list: [...slot.exBoost.abilityIdList],
        },
    }
    return {
        characters: party.characters.map(character),
        unison_characters: party.unisonCharacters.map(character),
        equipments: party.equipments.map(slot => slot === null ? null : {
            equipment_id: slot.equipmentId,
            level: slot.level,
        }),
        ability_soul_ids: [...party.abilitySoulIds],
    }
}

const routes = async (fastify: FastifyInstance) => {
    /**
     * `party/publish` hands the *whole* party to the server: the client builds
     * the code from the response and then never sends the party again, so the
     * server is the only place the shared party can be kept between the sender
     * and the redeemer. It is deliberately not persisted — see
     * `src/lib/party-code/registry.ts`.
     */
    fastify.post("/publish", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as PublishBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
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

        const party = readPartyCodePayload(body)
        if (party === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid battle party."
        })
        const record = partyCodeRegistry.publish({
            ownerPlayerId: playerId,
            party,
            nowMs: Date.now(),
        })
        if (record === null) return reply.status(503).send({
            "error": "Service Unavailable",
            "message": "Party code generation failed."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "party_code": record.code
            }
        })

    })

    /**
     * `party/refer` redeems a code. The client compares the returned characters
     * against its own save and drops the ones the player does not own, so the
     * response carries the publisher's growth values rather than a converted
     * party: an unknown code (3404) is the only failure the player can act on.
     */
    fastify.post("/refer", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { party_code?: unknown; viewer_id?: unknown }

        const viewerId = body.viewer_id
        if (viewerId !== undefined && (!Number.isSafeInteger(viewerId) || (viewerId as number) <= 0)) {
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid request body."
            })
        }

        const rawCode = body.party_code
        if (typeof rawCode !== "string" || rawCode.length === 0) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const record = partyCodeRegistry.lookUp(rawCode, Date.now())
        if (record === null) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: Number.isSafeInteger(viewerId) ? viewerId as number : 0,
                    result_code: PARTY_CODE_NOT_FOUND_RESULT_CODE,
                }),
                "data": {}
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: Number.isSafeInteger(viewerId) ? viewerId as number : 0
            }),
            "data": {
                "party_name": record.party.name,
                "battle_party": serializePartyCodeBattleParty(record.party),
            }
        })

    })

    fastify.post("/edit", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as EditBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        if (!Array.isArray(body.party_info_list)
            || body.party_info_list.some(info => !hasEditablePartyCategory(info)
                || parseGlobalPartyId((info as PartyInfoListItem).party_id) === null
                || (!isProfileFavoriteParty(info as PartyInfoListItem)
                    && !isGlobalPartyIdAllowedForCategory(
                    (info as PartyInfoListItem).party_category as PartyCategory,
                    (info as PartyInfoListItem).party_id,
                )))) {
            console.warn(`[PARTY] edit rejected before session: ${JSON.stringify(summarizePartyEditRequest(body, viewerId))}`)
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid party category or party ID."
            })
        }

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        // get player
        const playerId = resolvePlayerIdSync(viewerIdSession.accountId)!
        const player = playerId !== null ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // update each slot
        const characterOwnedMap: Record<number, boolean> = {}

        const mapOwnedCharacters = (characterId: number | null): number | null => {
            let isOwned = characterId === null ? false : characterOwnedMap[characterId]
            if (isOwned === undefined) {
                isOwned = playerOwnsCharacterSync(playerId, characterId as number)
                characterOwnedMap[characterId as number] = isOwned
            }
            
            return isOwned ? characterId : null
        }

        const battlePartyInfoList = body.party_info_list.filter(info => !isProfileFavoriteParty(info))
        const existingLoadouts = battlePartyInfoList.map(updateInfo => {
            const parsed = parseGlobalPartyId(updateInfo.party_id)!
            const existing = getPlayerPartyLoadoutSync(
                playerId,
                parsed.groupId,
                parsed.slot,
                updateInfo.party_category as PartyCategory,
            )
            return {
                equipment_ids: existing?.equipmentIds ?? [],
                ability_soul_ids: existing?.abilitySoulIds ?? [],
            }
        })
        const loadoutValidation = validatePartyLoadouts(battlePartyInfoList, {
            equipments: getPlayerEquipmentListSync(playerId),
            items: getPlayerItemsSync(playerId),
        }, existingLoadouts)
        if (!loadoutValidation.ok) {
            console.warn(
                `[PARTY] edit rejected: viewer=${viewerId}`
                + ` reason=${loadoutValidation.reason} id=${loadoutValidation.id}`,
            )
            return reply.status(400).send({
                "error": "Bad Request",
                "message": "Invalid party equipment or ability soul inventory.",
            })
        }

        const mappedParties = body.party_info_list.map(updateInfo => {
            const parsed = parseGlobalPartyId(updateInfo.party_id)!
            return {
                parsed,
                party: {
                    name: updateInfo.party_name,
                    unisonCharacterIds: updateInfo.unison_character_ids.map(mapOwnedCharacters),
                    characterIds: updateInfo.character_ids.map(mapOwnedCharacters),
                    equipmentIds: [...updateInfo.equipment_ids],
                    abilitySoulIds: updateInfo.ability_soul_ids,
                    options: { allowOtherPlayersToHealMe: updateInfo.options.allow_other_players_to_heal_me },
                    edited: updateInfo.party_edited,
                    category: updateInfo.party_category as PartyCategory,
                    currentBattlePower: updateInfo.current_battle_power ?? 0,
                    beforeBattlePower: updateInfo.before_battle_power ?? 0,
                },
            }
        })
        const mappedBattleParties = mappedParties.filter(
            ({ party }) => party.category !== PROFILE_FAVORITE_PARTY_CATEGORY,
        )

        const evaluationTime = new Date(getServerTime() * 1000)
        const missionSettlements = getDb().transaction(() => {
            const settlements: MissionSettlementResult[] = []
            // Profile favorites are independent from the battle party selected by the player.
            if ((mappedParties.length === 0 || mappedBattleParties.length > 0)
                && player.partySlot !== body.main_party_id) {
                updatePlayerSync({
                    id: playerId,
                    partySlot: body.main_party_id,
                })
            }
            for (const { parsed, party } of mappedParties) {
                updatePlayerPartySync(playerId, parsed.slot, party, parsed.groupId)
            }
            if (mappedBattleParties.length > 0) {
                const abilitySoulSettlement = settleAbilitySoulEquipFactsSync(
                    playerId,
                    existingLoadouts.map(loadout => ({
                        abilitySoulIds: loadout.ability_soul_ids,
                    })),
                    mappedBattleParties.map(({ party }) => ({
                        abilitySoulIds: party.abilitySoulIds,
                    })),
                    evaluationTime,
                )
                if (abilitySoulSettlement.settlement) {
                    settlements.push(abilitySoulSettlement.settlement)
                }
                incrementActiveMissionPartyActionCountsSync(playerId, {
                    equipmentEquipCount: mappedBattleParties.some(({ party }) => party.equipmentIds.some(id => id !== null)) ? 1 : 0,
                    unisonSetCount: mappedBattleParties.some(({ party }) => party.unisonCharacterIds.some(id => id !== null)) ? 1 : 0,
                    partyCharacterSetCount: mappedBattleParties.some(({ party }) => party.characterIds.some(id => id !== null)) ? 1 : 0,
                })
                const raidSetParties = mappedBattleParties.map(({ parsed, party }) => ({
                    category: party.category,
                    groupId: parsed.groupId,
                    slot: parsed.slot,
                }))
                const raidSetMissionIds = getRaidSetEditMissionIds(
                    body.use_party_group_edit,
                    raidSetParties,
                    evaluationTime,
                )
                recordRaidSetEditMissionFactsSync(
                    playerId,
                    body.use_party_group_edit,
                    raidSetParties,
                    evaluationTime,
                )
                if (raidSetMissionIds.length > 0) {
                    settlements.push(settleMissionCategories(playerId, [{
                        category: 3,
                        missionIds: raidSetMissionIds,
                    }], evaluationTime))
                }
            }
            const activeMission = publishActiveMissionOwnerStateWithinTransaction({
                playerId,
                now: evaluationTime,
                source: "party/edit",
            })
            return { settlements, activeMissionList: activeMission.activeMissionList }
        })()

        reply.header("content-type", "application/x-msgpack")
        const responseData: Record<string, unknown> = {
            ...mergeCommonResponseFragments([{
                "mail_arrived": getMailArrivedSync(playerId)
            }]),
        }
        for (const settlement of missionSettlements.settlements) {
            mergeMissionSettlementResponse(responseData, settlement, viewerId)
        }
        responseData.active_mission_list = missionSettlements.activeMissionList
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": responseData
        })
    })

    fastify.post("/check_word", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, word: string }
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request", "message": "Invalid request body."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "check_passed": true }
        })
    })
}

export default routes;
