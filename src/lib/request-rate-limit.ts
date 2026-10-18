/**
 * 极简固定窗口限流器（2026-10-18 加固）。
 *
 * 为什么需要它：`src/cn-server.ts` 里原本只有 `/crash` 一个限流点
 * （`rateLimitMap`，30 次/60 秒），`/sp-auth/*`（登录、注册、找回密码）
 * 与 `/api/index.php/take_over*`（账号转移）**完全没有上限** —— bcrypt 校验
 * 又刻意慢（cost 10），于是这两处既是口令爆破面，也是廉价的 CPU 打点。
 *
 * 刻意保持极简：进程内存、固定窗口、按 key（一般用 `request.ip`）计数、
 * 定期清理过期桶。它防的是「单机脚本狂刷」，不承诺分布式精确；多实例部署
 * 需要换成共享存储时，替换本文件的实现即可（调用方只依赖 `check()`）。
 */

export interface RateLimitRule {
    /** 窗口内允许的次数 */
    limit: number
    windowMs: number
}

export class RequestRateLimiter {
    private readonly buckets = new Map<string, { count: number, resetAt: number }>()
    private readonly now: () => number
    private lastSweepAt = 0

    constructor(private readonly rule: RateLimitRule, now: () => number = Date.now) {
        if (!Number.isSafeInteger(rule.limit) || rule.limit <= 0) {
            throw new RangeError("rate limit must be a positive integer")
        }
        if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
            throw new RangeError("rate limit window must be positive")
        }
        this.now = now
    }

    /** true = 放行；false = 已超限（调用方负责回错误） */
    check(key: string): boolean {
        const nowMs = this.now()
        this.sweep(nowMs)
        const bucket = this.buckets.get(key)
        if (bucket === undefined || bucket.resetAt <= nowMs) {
            this.buckets.set(key, { count: 1, resetAt: nowMs + this.rule.windowMs })
            return true
        }
        bucket.count += 1
        return bucket.count <= this.rule.limit
    }

    /** 距离窗口重置还有多久（毫秒），给日志/响应头用 */
    retryAfterMs(key: string): number {
        const bucket = this.buckets.get(key)
        if (bucket === undefined) return 0
        return Math.max(0, bucket.resetAt - this.now())
    }

    /** 只清过期的桶：桶数上限与「活跃 key 数」同阶，不会无限增长 */
    private sweep(nowMs: number): void {
        if (nowMs - this.lastSweepAt < this.rule.windowMs) return
        this.lastSweepAt = nowMs
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= nowMs) this.buckets.delete(key)
        }
    }
}
