import { getTimeOffset, realDateFromServerTime, realToVirtual } from "../utils"

// 这两个数必须与客户端自己的渲染模型一致。客户端
// (pinball.common.data.player.PlayerLogic.get_currentPooledExp) 按
//   min(max_pool_exp, pooled_exp + gain_value * floor(elapsed / gain_seconds))
// 渲染经验池，并把渲染值当作注入额发给服务端（expod/inject_exp）。服务端若用另一套
// 参数，客户端算出的值会一直高于服务端余额，注入永远命中 INSUFFICIENT_EXP；客户端
// 不解析该响应体、只做本地乐观升级，于是下次 load 回滚成「等级退回 + 经验返还」。
//
// 节奏 = 1 exp / 60 秒：2026-10-17 线上实测（客户端 192.168.0.100 请求注入 126860，
// 库里池 105000、锚点 15.2 天未推进）反解出累积 ≈ 21822，只有「1/分钟」能对上
// （15.2 天 ≈ 21823 分钟）；若按 1/秒，客户端会渲染到自己的上限、请求量级为六位数
// 上限值而不是 126860。注意 <DATA_DIR>/content/store/objects/*.json 里那份带
// pool_exp_gain_seconds=1 的 CN 配置副本自注为「已知参考值」（其 hash 未命中 entity
// list），实测行为与它不一致，不可作 oracle。
// 上限 max_pool_exp：2026-10-20 按业主口径从 999999 提到 **999999999**（原值偏小：
// 客户端实测渲染 126860 时我们还在按 999999 夹，池子一过 999999 下一次 load 就被退回
// 999999，玩家看到的就是「经验值涨到 999999 就停住」）。这是**服务端**的夹取点，
// 客户端还有一份自己的 max_pool_exp（master 配置）——两边都得够大才不会互相打回。
export const EXP_POOL_GAIN_INTERVAL_MS = 60_000
export const EXP_POOL_MAX = 999_999_999

/**
 * 锚点修复用的「最大可回溯跨度」：**故意钉在旧上限 999999 的量级**（≈ 694 天）。
 *
 * 它只参与「这个时间锚点像不像模拟时钟」的判定（见 normalizeImportedExpPoolAnchor），
 * 与池上限无关。跟着 EXP_POOL_MAX 一起放大 1000 倍会把「锚点 15 天没推进」
 * 「客户端偏移 −442 天」这类判据一起废掉（2026-10-17 真机踩过的坑）。
 */
const EXP_POOL_CATCH_UP_REFERENCE_EXP = 999_999
const MAX_CATCH_UP_MS = EXP_POOL_CATCH_UP_REFERENCE_EXP * EXP_POOL_GAIN_INTERVAL_MS
const LEGACY_ANCHOR_TOLERANCE_MS = 5 * EXP_POOL_GAIN_INTERVAL_MS

export interface PooledExpCalculation {
    readonly expPool: number
    readonly expPooledTime: Date
    readonly earned: number
    readonly repaired: boolean
}

export function normalizeImportedExpPoolAnchor(
    persistedTime: Date,
    realNow: Date,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): Date {
    const nowMs = realNow.getTime()
    const rawAnchorMs = persistedTime.getTime()
    if (!Number.isFinite(nowMs) || !Number.isFinite(rawAnchorMs)) return new Date(nowMs)

    const offsetMs = offsetOrZero(timeOffsetMs)
    const realElapsedMs = nowMs - rawAnchorMs
    const virtualElapsedMs = nowMs + offsetMs - rawAnchorMs
    if (offsetMs !== 0
        && virtualElapsedMs >= 0
        && virtualElapsedMs <= MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS
        && Math.abs(realElapsedMs) > MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS) {
        return new Date(rawAnchorMs - offsetMs)
    }
    if (realElapsedMs < 0) return new Date(nowMs)
    if (offsetMs !== 0
        && realElapsedMs > MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS
        && virtualElapsedMs < 0
        && isVirtualDomainAnchor(rawAnchorMs, nowMs, offsetMs)) {
        return new Date(nowMs)
    }
    return persistedTime
}

/**
 * Whether an anchor is better explained as a virtual-domain (client clock)
 * timestamp than as a real one, judged by its distance to both clocks.
 *
 * The accumulator must grant at least what the client renders: the client
 * computes `now - anchor` on its own clock and sends that value as the inject
 * amount, so a server-side reset to "now" (granting nothing) makes every
 * injection fail with INSUFFICIENT_EXP while the client keeps its optimistic
 * level-up - which the next load rolls back. A simulated clock far from real
 * time used to trigger exactly that reset for perfectly valid real anchors
 * (2026-10-17: offset -442 days, anchor 15 days old, pool stuck at 105000 while
 * the client rendered 126860). Only anchors that really look virtual are reset.
 */
function isVirtualDomainAnchor(rawAnchorMs: number, realNowMs: number, offsetMs: number): boolean {
    const realDistance = Math.abs(realNowMs - rawAnchorMs)
    const virtualDistance = Math.abs(realNowMs + offsetMs - rawAnchorMs)
    return virtualDistance < realDistance
}

function offsetOrZero(offsetMs: number | null | undefined): number {
    return offsetMs ?? 0
}

/**
 * Calculates passive EXP using the real clock while keeping the client-facing
 * timestamp in the virtual server-time domain.
 *
 * Existing databases stored this field in the virtual domain. A legacy anchor
 * is migrated only when its virtual interpretation is recent but its real
 * interpretation is far outside the pool's catch-up window. Ambiguous or
 * future anchors are reset to now and keep the current balance - but only when
 * they really look virtual (see isVirtualDomainAnchor): a reset grants nothing
 * and therefore breaks parity with the client, which keeps accruing from the
 * anchor it was last sent.
 */
export function calculatePooledExpAtRealTime(
    expPool: number,
    expPooledTime: Date,
    realNow: Date,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): PooledExpCalculation {
    const nowMs = realNow.getTime()
    const rawAnchorMs = expPooledTime.getTime()
    const offsetMs = offsetOrZero(timeOffsetMs)

    if (!Number.isFinite(nowMs) || !Number.isFinite(rawAnchorMs)) {
        return {
            expPool,
            expPooledTime: new Date(nowMs),
            earned: 0,
            repaired: true,
        }
    }

    const virtualNowMs = nowMs + offsetMs
    const realElapsedMs = nowMs - rawAnchorMs
    const virtualElapsedMs = virtualNowMs - rawAnchorMs

    const normalizedAnchor = normalizeImportedExpPoolAnchor(expPooledTime, realNow, timeOffsetMs)
    let anchorMs = normalizedAnchor.getTime()
    let repaired = false

    if (anchorMs !== rawAnchorMs) {
        repaired = true
    } else if (realElapsedMs < 0) {
        // A clock adjustment or imported save placed the anchor in the future.
        anchorMs = nowMs
        repaired = true
    } else if (
        offsetMs !== 0
        && realElapsedMs > MAX_CATCH_UP_MS + LEGACY_ANCHOR_TOLERANCE_MS
        && virtualElapsedMs < 0
        && isVirtualDomainAnchor(rawAnchorMs, nowMs, offsetMs)
    ) {
        // A prior virtual date and a later server-time rollback cannot be
        // reconstructed safely. Preserve the balance and start a new anchor.
        anchorMs = nowMs
        repaired = true
    }

    const elapsedMs = Math.max(0, nowMs - anchorMs)
    const earned = elapsedMs < EXP_POOL_GAIN_INTERVAL_MS
        ? 0
        : Math.floor(elapsedMs / EXP_POOL_GAIN_INTERVAL_MS)
    const rawBalance = Math.max(0, expPool)
    const nextExpPool = Math.min(EXP_POOL_MAX, rawBalance + earned)
    // 越界余额（导入存档、邮件或管理工具可能写入高于上限的值，负数同理）必须夹紧并
    // 落地：否则上限会吃掉全部 earned，earned 恒为 0，下面的早退分支让越界值永久留在
    // 库里，而客户端仍按自己的模型在它之上继续累积 → 注入永久 INSUFFICIENT_EXP。
    const clamped = rawBalance !== expPool || rawBalance > EXP_POOL_MAX

    if (earned === 0 && !repaired && !clamped) {
        return {
            expPool,
            expPooledTime,
            earned: 0,
            repaired: false,
        }
    }

    return {
        expPool: nextExpPool,
        expPooledTime: new Date(nowMs),
        earned: Math.max(0, nextExpPool - rawBalance),
        repaired: repaired || clamped,
    }
}

export function expPoolRealDateToClientTimestamp(
    realDate: Date,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): number {
    if (timeOffsetMs === undefined) return realToVirtual(realDate)
    return Math.floor((realDate.getTime() + offsetOrZero(timeOffsetMs)) / 1000)
}

export function clientTimestampToExpPoolRealDate(
    clientTimestamp: number,
    timeOffsetMs: number | null | undefined = getTimeOffset(),
): Date {
    if (timeOffsetMs === undefined) return realDateFromServerTime(clientTimestamp)
    return new Date(clientTimestamp * 1000 - offsetOrZero(timeOffsetMs))
}
