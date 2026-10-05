import { randomBytes } from "node:crypto"

/**
 * Channel alphabet of the client's party-code input dialog
 * (`pinball/dialog/partyCode/PartyCodeInputDialog.as:118`):
 *
 *     ^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty]{6,}$
 *
 * The characters left out are the ones a human misreads when copying the code
 * out of chat: 0, I, O, S, Z, and the lowercase c e i k l m n o p s u v w x z.
 * A code containing any of them can never be typed into the dialog, so this set
 * is not a style choice — it is the only set the player can actually redeem.
 */
export const PARTY_CODE_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty"

/** Length of a published code. Six is what the official dummy remote returns ("0faHzM"). */
export const PARTY_CODE_LENGTH = 6

/**
 * How long a code stays redeemable. In-memory only: a restart drops every code,
 * which is the same failure the player already understands from an expired link.
 */
export const PARTY_CODE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Upper bound on live codes. Each entry holds one party, so this is a memory
 * ceiling for a griefing player who publishes in a loop rather than a product
 * limit; the oldest entry is evicted first.
 */
export const PARTY_CODE_CAPACITY = 4096

/** One battle party slot exactly as `/party/publish` receives it from the client. */
export interface PartyCodeCharacter {
    readonly id: number
    readonly evolutionLevel: number
    readonly exp: number
    readonly overLimitStep: number
    readonly manaNodeIds: readonly number[]
    readonly illustrationSettings: readonly number[] | null
    readonly exBoost: { readonly statusId: number; readonly abilityIdList: readonly number[] } | null
}

export interface PartyCodeEquipment {
    readonly equipmentId: number
    readonly level: number
}

export interface PartyCodePayload {
    readonly name: string
    readonly characters: readonly (PartyCodeCharacter | null)[]
    readonly unisonCharacters: readonly (PartyCodeCharacter | null)[]
    readonly equipments: readonly (PartyCodeEquipment | null)[]
    readonly abilitySoulIds: readonly (number | null)[]
}

export interface PartyCodeRecord {
    readonly code: string
    readonly ownerPlayerId: number
    readonly party: PartyCodePayload
    readonly createdAtMs: number
}

/**
 * How long a code lives, and where it lives: in process memory, never in SQLite.
 * A shared party is a transient hand-off between two players who are already
 * talking to each other, so it must not survive a server restart and must not
 * show up in a save export.
 */
export class PartyCodeRegistry {
    private readonly byCode = new Map<string, PartyCodeRecord>()
    private sequence = 0

    publish(input: {
        ownerPlayerId: number
        party: PartyCodePayload
        nowMs: number
    }): PartyCodeRecord | null {
        this.sweep(input.nowMs)
        const code = this.nextCode()
        if (code === null) return null
        const record: PartyCodeRecord = {
            code,
            ownerPlayerId: input.ownerPlayerId,
            party: input.party,
            createdAtMs: input.nowMs,
        }
        this.byCode.set(code, record)
        this.evictOverCapacity()
        return record
    }

    /** Redeems a code. Codes are compared case-sensitively, as the client types them. */
    lookUp(code: string, nowMs: number): PartyCodeRecord | null {
        const record = this.byCode.get(code)
        if (record === undefined) return null
        if (this.isExpired(record, nowMs)) {
            this.byCode.delete(code)
            return null
        }
        return record
    }

    clear(): void {
        this.byCode.clear()
        this.sequence = 0
    }

    get size(): number {
        return this.byCode.size
    }

    private isExpired(record: PartyCodeRecord, nowMs: number): boolean {
        return nowMs - record.createdAtMs >= PARTY_CODE_TTL_MS
    }

    private sweep(nowMs: number): void {
        for (const [code, record] of this.byCode) {
            if (this.isExpired(record, nowMs)) this.byCode.delete(code)
        }
    }

    private evictOverCapacity(): void {
        while (this.byCode.size > PARTY_CODE_CAPACITY) {
            // Map iteration is insertion ordered, so the first key is the oldest.
            const oldest = this.byCode.keys().next()
            if (oldest.done === true) return
            this.byCode.delete(oldest.value)
        }
    }

    /**
     * Codes are random, not derived from the sequence: a guessable code would let
     * any player pull a stranger's party, and the sequence only exists to break a
     * (vanishingly unlikely) collision instead of looping forever.
     */
    private nextCode(): string | null {
        for (let attempt = 0; attempt < 32; attempt += 1) {
            this.sequence += 1
            const bytes = randomBytes(PARTY_CODE_LENGTH)
            let code = ""
            for (let index = 0; index < PARTY_CODE_LENGTH; index += 1) {
                code += PARTY_CODE_ALPHABET[bytes[index] % PARTY_CODE_ALPHABET.length]
            }
            if (!this.byCode.has(code)) return code
        }
        return null
    }
}

/** Process-wide registry, shared by `/party/publish` and `/party/refer`. */
export const partyCodeRegistry = new PartyCodeRegistry()
