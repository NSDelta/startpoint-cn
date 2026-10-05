import { createHash, timingSafeEqual } from "crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { getDatabaseStatus } from "../../data"
import { resolvePlayerIdSync } from "../../data/activeAccount"
import { getAccountSync } from "../../data/domains/account"
import {
    SIGNUP_CODE_MAX_ATTEMPTS,
    consumeSignupCodeSync,
    getAccountBindStateSync,
    getBindingByPlatformUidSync,
    getSignupCodeSync,
    listBindingsSync,
    revokeSignupCodeSync,
    unbindPlatformAccountSync,
} from "../../data/domains/account-binding"
import { getViewerIdSync } from "../../data/domains/session"
import { getRealNow } from "../../runtime/time/game-time"
import {
    ChapterSkipError,
    MAX_MAIN_CHAPTER,
    getChapterStartQuestId,
    skipPlayerToChapterSync,
} from "../../lib/player-progress/chapter-skip"
import type { BindingPlatform } from "../../data/types"

// Bot control plane of contract 3.4 (`/api/bot`), owned by contract C4/C8.
//
// Authentication is a shared secret in the `X-Bot-Token` header, compared with
// `crypto.timingSafeEqual` against `BOT_API_TOKEN`. A missing server token
// fails the whole group closed with 403 (CC-4) and never leaks account data.

export const BOT_TOKEN_HEADER = "x-bot-token"
export const BOT_RATE_LIMIT_WINDOW_MS = 60_000
export const BOT_RATE_LIMIT_MAX_REQUESTS = 20

const MAX_UID_LENGTH = 64
const MAX_CODE_LENGTH = 64
const MAX_DISPLAY_NAME_LENGTH = 128
const MAX_BINDINGS_PER_UID = 500

/** The single 403 body: no account data, no echo of the presented token. */
const FORBIDDEN_BODY = { ok: false, code: "FORBIDDEN" } as const

export interface BotApiRoutesOptions {
    /**
     * Injected environment (CC-4 pattern, see `src/lib/udid-probe.ts`): the
     * token is read once at registration from this object, so tests can pass a
     * fake environment instead of mutating `process.env`.
     */
    readonly env?: NodeJS.ProcessEnv
}

/**
 * Reads `BOT_API_TOKEN`; returns null when it is missing or blank so callers
 * can fail closed. Never touches `process.env` directly.
 */
export function resolveBotApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = env.BOT_API_TOKEN
    if (typeof raw !== "string") return null
    const token = raw.trim()
    return token === "" ? null : token
}

/**
 * Constant-time token comparison. Both sides are hashed first so that
 * `timingSafeEqual` always receives equal-length buffers and the length of the
 * configured token is not observable.
 */
export function botTokenMatches(candidate: unknown, token: string): boolean {
    if (typeof candidate !== "string") return false
    const provided = createHash("sha256").update(candidate.trim(), "utf8").digest()
    const expected = createHash("sha256").update(token, "utf8").digest()
    return timingSafeEqual(provided, expected)
}

interface BotRateLimiter {
    /** Returns false when the caller exceeded its window. */
    check(key: string): boolean
}

function createBotRateLimiter(
    windowMs: number = BOT_RATE_LIMIT_WINDOW_MS,
    maximum: number = BOT_RATE_LIMIT_MAX_REQUESTS,
): BotRateLimiter {
    const hits = new Map<string, number[]>()
    return {
        check(key: string): boolean {
            const now = Date.now()
            if (hits.size > 512) {
                for (const [candidate, timestamps] of hits) {
                    if (timestamps.every(at => now - at >= windowMs)) hits.delete(candidate)
                }
            }
            const recent = (hits.get(key) ?? []).filter(at => now - at < windowMs)
            if (recent.length >= maximum) {
                hits.set(key, recent)
                return false
            }
            recent.push(now)
            hits.set(key, recent)
            return true
        },
    }
}

class BotRequestError extends Error {
    constructor() {
        super("Invalid bot request")
        this.name = "BotRequestError"
    }
}

interface BotBindRequest {
    readonly platform: BindingPlatform
    readonly uid: string
    readonly code: string
    readonly displayName: string | null
}

function requireBody(body: unknown): Record<string, unknown> {
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BotRequestError()
    return body as Record<string, unknown>
}

function requirePlatform(value: unknown): BindingPlatform {
    if (value !== "qq" && value !== "kook") throw new BotRequestError()
    return value
}

function requireUid(value: unknown): string {
    if (typeof value !== "string") throw new BotRequestError()
    const trimmed = value.trim()
    if (trimmed === "" || trimmed.length > MAX_UID_LENGTH) throw new BotRequestError()
    return trimmed
}

function requireCode(value: unknown): string {
    if (typeof value !== "string") throw new BotRequestError()
    const trimmed = value.trim()
    if (trimmed === "" || trimmed.length > MAX_CODE_LENGTH) throw new BotRequestError()
    return trimmed
}

function optionalDisplayName(value: unknown): string | null {
    if (value === undefined || value === null) return null
    if (typeof value !== "string") throw new BotRequestError()
    const trimmed = value.trim()
    if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) throw new BotRequestError()
    return trimmed === "" ? null : trimmed
}

function readBotBindRequest(body: unknown): BotBindRequest {
    const raw = requireBody(body)
    return {
        platform: requirePlatform(raw.platform),
        uid: requireUid(raw.uid),
        code: requireCode(raw.code),
        displayName: optionalDisplayName(raw.display_name),
    }
}

function readStatusRequest(body: unknown): { platform: BindingPlatform, uid: string } {
    const raw = requireBody(body)
    return { platform: requirePlatform(raw.platform), uid: requireUid(raw.uid) }
}

function readUnbindRequest(body: unknown): { platform: BindingPlatform, uid: string, code: string } {
    const raw = requireBody(body)
    return {
        platform: requirePlatform(raw.platform),
        uid: requireUid(raw.uid),
        code: requireCode(raw.code),
    }
}

function readSkipChapterRequest(body: unknown): { platform: BindingPlatform, uid: string, chapter: number } {
    const raw = requireBody(body)
    const chapter = raw.chapter
    if (typeof chapter !== "number" || !Number.isSafeInteger(chapter) || chapter < 1) {
        throw new BotRequestError()
    }
    return { platform: requirePlatform(raw.platform), uid: requireUid(raw.uid), chapter }
}

/**
 * The account a platform identity may act on: its primary binding, or the
 * single binding it has. Several bindings without a primary one are ambiguous,
 * and guessing could skip a chapter on the wrong save, so it is refused.
 */
function resolveBoundAccountId(platform: BindingPlatform, uid: string): number | null {
    const bindings = listBindingsSync({
        platform,
        platformUid: uid,
        limit: MAX_BINDINGS_PER_UID,
    })
    if (bindings.length === 1) return bindings[0].accountId
    return bindings.find(binding => binding.isPrimary)?.accountId ?? null
}

function readUsername(accountId: number): string | null {
    return getAccountSync(accountId)?.username ?? null
}

/**
 * Describes the account that already owns this platform identity, for the
 * `ALREADY_BOUND` payload frozen in contract 3.4.
 */
function describeOwner(platform: BindingPlatform, uid: string): { username: string | null, viewer_id: number } {
    const occupied = getBindingByPlatformUidSync(platform, uid)
    if (occupied === null) return { username: null, viewer_id: 0 }
    return { username: readUsername(occupied.accountId), viewer_id: getViewerIdSync(occupied.accountId) }
}

/** Player-facing name of a platform identity, used only in bot chat copy. */
const PLATFORM_LABEL: Record<BindingPlatform, string> = { qq: "QQ", kook: "KOOK" }

/**
 * Player-readable description of the account that already owns a platform
 * identity, added to the `ALREADY_BOUND` payload as a pure extension: the
 * frozen `username` / `viewer_id` pair keeps its meaning untouched.
 *
 * The message is written so the bot can render it verbatim, which is what a
 * repeated `/bind` needs — `describeOwner` legitimately reports `username:
 * null` / `viewer_id: 0` for an account that has no username or no viewer id
 * yet, and the bot cannot turn that emptiness into a sentence on its own.
 * Only the *tail* of the viewer id is surfaced here; the full platform uid
 * (a QQ / KOOK number) is never echoed back into a chat group.
 */
export function buildAlreadyBoundNotice(
    platform: BindingPlatform,
    owner: { username: string | null, viewer_id: number },
): { message: string, viewer_id_tail: string | null } {
    const tail = owner.viewer_id > 0 ? String(owner.viewer_id).slice(-4) : null
    const who = owner.username === null ? "游戏账号" : `游戏账号「${owner.username}」`
    const id = tail === null ? "" : `（ID 尾号 ${tail}）`
    return {
        message: `这个 ${PLATFORM_LABEL[platform]} 已经绑定过${who}${id}，无需重复绑定；换号请先在游戏内解绑。`,
        viewer_id_tail: tail,
    }
}

type UnbindResolution =
    | { readonly ok: true, readonly accountId: number, readonly pendingCode: boolean }
    | { readonly ok: false, readonly code: string }

/**
 * Resolves which account a self-service unbind refers to.
 *
 * The `code` is the proof of ownership: either a live signup code issued for
 * the account, or the code that originally bound this platform identity. Every
 * other state maps onto the frozen failure codes of contract 3.4.
 */
function resolveUnbindAccount(platform: BindingPlatform, uid: string, code: string): UnbindResolution {
    const row = getSignupCodeSync(code)
    if (row === null || row.status === "revoked") return { ok: false, code: "CODE_INVALID" }
    if (row.status === "expired") return { ok: false, code: "CODE_EXPIRED" }
    if (row.status === "bound") {
        // The code that originally bound this identity is the strongest proof,
        // but only for the platform identity it actually bound.
        if (row.platformUid !== uid || row.platform !== platform) {
            return { ok: false, code: "CODE_INVALID" }
        }
        return { ok: true, accountId: row.accountId, pendingCode: false }
    }
    if (row.attempts >= SIGNUP_CODE_MAX_ATTEMPTS) return { ok: false, code: "CODE_LOCKED" }
    if (row.platform !== null && row.platform !== platform) return { ok: false, code: "CODE_INVALID" }
    if (row.expiresAt.getTime() <= getRealNow().getTime()) return { ok: false, code: "CODE_EXPIRED" }
    if (getAccountBindStateSync(row.accountId) === "disabled") {
        return { ok: false, code: "ACCOUNT_DISABLED" }
    }
    return { ok: true, accountId: row.accountId, pendingCode: true }
}

function isDatabaseReady(): boolean {
    return getDatabaseStatus().ready
}

function sendBotError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    if (error instanceof BotRequestError) {
        return reply.status(400).send({ ok: false, code: "BAD_REQUEST" })
    }
    request.log.error({ err: error }, "bot api route failed")
    return reply.status(500).send({ ok: false, code: "INTERNAL_ERROR" })
}

const routes = async (fastify: FastifyInstance, options: BotApiRoutesOptions = {}) => {
    const env = options.env ?? process.env
    const token = resolveBotApiToken(env)
    const limiter = createBotRateLimiter()

    fastify.addHook("preHandler", async (request, reply) => {
        if (token === null) return reply.status(403).send(FORBIDDEN_BODY)
        if (!botTokenMatches(request.headers[BOT_TOKEN_HEADER], token)) {
            return reply.status(403).send(FORBIDDEN_BODY)
        }
    })

    fastify.post("/bind", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ ok: false, code: "SERVICE_UNAVAILABLE" })
        let body: BotBindRequest
        try {
            body = readBotBindRequest(request.body)
        } catch (error) {
            // Bind keeps its frozen failure vocabulary even for malformed input.
            if (error instanceof BotRequestError) {
                return reply.status(400).send({ ok: false, code: "CODE_INVALID" })
            }
            throw error
        }
        if (!limiter.check(`${body.platform}:${body.uid}`)) {
            return reply.status(200).send({ ok: false, code: "RATE_LIMITED" })
        }
        try {
            const result = consumeSignupCodeSync({
                code: body.code,
                platform: body.platform,
                platformUid: body.uid,
                displayName: body.displayName,
                actor: "bot",
            })
            if (!result.ok) {
                if (result.code === "ALREADY_BOUND") {
                    const owner = describeOwner(body.platform, body.uid)
                    return reply.status(200).send({
                        ok: false,
                        code: "ALREADY_BOUND",
                        data: { ...owner, ...buildAlreadyBoundNotice(body.platform, owner) },
                    })
                }
                return reply.status(200).send({ ok: false, code: result.code })
            }
            const accountId = result.accountId
            return reply.status(200).send({
                ok: true,
                data: {
                    account_id: accountId,
                    viewer_id: getViewerIdSync(accountId),
                    username: readUsername(accountId),
                    is_primary: result.binding.isPrimary,
                },
            })
        } catch (error) {
            return sendBotError(request, reply, error)
        }
    })

    fastify.post("/status", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ ok: false, code: "SERVICE_UNAVAILABLE" })
        try {
            const { platform, uid } = readStatusRequest(request.body)
            const bindings = listBindingsSync({
                platform,
                platformUid: uid,
                limit: MAX_BINDINGS_PER_UID,
            })
                .slice()
                .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || left.id - right.id)
                .map(binding => ({
                    account_id: binding.accountId,
                    username: readUsername(binding.accountId),
                    viewer_id: getViewerIdSync(binding.accountId),
                    is_primary: binding.isPrimary,
                    created_at: binding.createdAt.toISOString(),
                }))
            return reply.status(200).send({ ok: true, data: { bindings } })
        } catch (error) {
            return sendBotError(request, reply, error)
        }
    })

    fastify.post("/unbind", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ ok: false, code: "SERVICE_UNAVAILABLE" })
        let body: { platform: BindingPlatform, uid: string, code: string }
        try {
            body = readUnbindRequest(request.body)
        } catch (error) {
            if (error instanceof BotRequestError) {
                return reply.status(400).send({ ok: false, code: "BAD_REQUEST" })
            }
            throw error
        }
        if (!limiter.check(`${body.platform}:${body.uid}`)) {
            return reply.status(200).send({ ok: false, code: "RATE_LIMITED" })
        }
        try {
            const resolved = resolveUnbindAccount(body.platform, body.uid, body.code)
            if (!resolved.ok) return reply.status(200).send({ ok: false, code: resolved.code })

            const binding = listBindingsSync({
                accountId: resolved.accountId,
                platform: body.platform,
                platformUid: body.uid,
                limit: 1,
            })[0]
            if (binding === undefined) return reply.status(200).send({ ok: false, code: "BINDING_NOT_FOUND" })
            if (binding.isPrimary) return reply.status(200).send({ ok: false, code: "PRIMARY_BINDING" })

            const result = unbindPlatformAccountSync({
                bindingId: binding.id,
                allowPrimary: false,
                actor: "bot",
            })
            if (!result.ok) {
                return reply.status(200).send({
                    ok: false,
                    code: result.code === "PRIMARY_BINDING" ? "PRIMARY_BINDING" : "BINDING_NOT_FOUND",
                })
            }
            // A live code is spent by the unbind it authorised.
            if (resolved.pendingCode) revokeSignupCodeSync({ code: body.code, actor: "bot" })
            return reply.status(200).send({
                ok: true,
                data: {
                    account_id: result.binding.accountId,
                    viewer_id: getViewerIdSync(result.binding.accountId),
                    username: readUsername(result.binding.accountId),
                    is_primary: false,
                },
            })
        } catch (error) {
            return sendBotError(request, reply, error)
        }
    })

    /**
     * `/skip chapter N` on the bot side: fast-forwards the bound save to the
     * start of chapter N by marking chapters 1..N-1 finished.
     *
     * Story progress is a boolean per quest (`players_quest_progress.finished`),
     * and both the client (`MainStageNodeLogic.isCleared`) and
     * `singleBattleQuest/start` require the whole prerequisite stage node to be
     * cleared before a later chapter is playable, so unlocking alone would not
     * let the player in. `N = 1` is a valid no-op, and `N = MAX_MAIN_CHAPTER + 1`
     * means "everything in content". The action targets the caller's own bound
     * save and needs no confirmation code: it can only move that save forward.
     */
    fastify.post("/skip_chapter", async (request, reply) => {
        if (!isDatabaseReady()) return reply.status(503).send({ ok: false, code: "SERVICE_UNAVAILABLE" })
        let body: { platform: BindingPlatform, uid: string, chapter: number }
        try {
            body = readSkipChapterRequest(request.body)
        } catch (error) {
            if (error instanceof BotRequestError) {
                return reply.status(400).send({ ok: false, code: "BAD_REQUEST" })
            }
            throw error
        }
        if (body.chapter > MAX_MAIN_CHAPTER) {
            return reply.status(400).send({ ok: false, code: "INVALID_CHAPTER" })
        }
        if (!limiter.check(`${body.platform}:${body.uid}`)) {
            return reply.status(200).send({ ok: false, code: "RATE_LIMITED" })
        }
        try {
            const accountId = resolveBoundAccountId(body.platform, body.uid)
            if (accountId === null) return reply.status(200).send({ ok: false, code: "NO_BINDING" })
            const playerId = resolvePlayerIdSync(accountId)
            if (playerId === null) return reply.status(200).send({ ok: false, code: "NO_PLAYER" })

            const result = skipPlayerToChapterSync(playerId, body.chapter)
            return reply.status(200).send({
                ok: true,
                data: {
                    account_id: accountId,
                    viewer_id: getViewerIdSync(accountId),
                    username: readUsername(accountId),
                    chapter: result.chapter,
                    // The quest the player is now on: the first quest of the
                    // chapter, which is also what was written as the persisted
                    // current-quest pointer.
                    last_main_quest_id: result.lastMainQuestId,
                    current_quest: getChapterStartQuestId(result.chapter),
                    finished_quests: result.newlyFinished,
                    recorded_chapters: result.recordedChapters,
                },
            })
        } catch (error) {
            if (error instanceof ChapterSkipError) {
                return reply.status(400).send({ ok: false, code: "INVALID_CHAPTER" })
            }
            return sendBotError(request, reply, error)
        }
    })
}

export default routes
