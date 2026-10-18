/**
 * 极简内存限流（2026-10-18 加固）：按来源 IP 记滑动窗口内的命中次数。
 *
 * 用途是给「以前完全没有限流、而单次请求就要花 CPU/磁盘/数据库」的端点上闸：
 * 登录口令比对（bcrypt 同步阻塞事件循环）、转移账号的三个接口、`/sdk_v3` 取码、
 * 排障日志追加。进程内计数即可 —— 本部署是单进程；多进程部署时它退化成
 * 「每进程 limit 次」，仍然是数量级的收敛，不是防线本身。
 *
 * `check()` 语义：**先记一次，再回答这次是否超限**（true = 放行）。
 */

export interface IpRateLimiterOptions {
    /** 窗口内允许的次数。 */
    readonly limit: number
    /** 窗口长度（毫秒）。 */
    readonly windowMs: number
}

export interface IpRateLimiter {
    /** 记一次命中并回答是否放行。key 传来源 IP（不要用调用方可控的请求头）。 */
    check(key: string): boolean
    /** 当前跟踪的键数量（测试与运维观察用）。 */
    size(): number
    /** 清空全部窗口（测试钩子；与 `sp-auth/reset.ts` 的 `clearResetRequestRateState` 同风格）。 */
    clear(): void
}

/** 键数量上限：超过就顺手清掉窗口已过期的键，避免伪造来源把内存撑爆。 */
const MAX_TRACKED_KEYS = 4096

export function createIpRateLimiter(options: IpRateLimiterOptions): IpRateLimiter {
    const limit = Math.max(1, Math.floor(options.limit))
    const windowMs = Math.max(1, Math.floor(options.windowMs))
    const hits = new Map<string, number[]>()

    return {
        check(key: string): boolean {
            const now = Date.now()
            const recent = (hits.get(key) ?? []).filter(at => now - at < windowMs)
            recent.push(now)
            hits.set(key, recent)
            if (hits.size >= MAX_TRACKED_KEYS) {
                for (const [candidate, stamps] of hits) {
                    if (stamps.every(at => now - at >= windowMs)) hits.delete(candidate)
                }
            }
            return recent.length <= limit
        },
        size(): number {
            return hits.size
        },
        clear(): void {
            hits.clear()
        },
    }
}
