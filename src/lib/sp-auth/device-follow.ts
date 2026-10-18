/**
 * 「并号」——让**游戏那把设备号**跟着**门里最后一次成功登录的账号**走。
 *
 * ## 为什么需要它
 * 服务端按 `body.device_id` 认账号（`/api/index.php/tool/signup` → `device_bindings`）。
 * 门的 `/sp-auth/login` 只会把**门自己那把**设备号改绑到账号上；游戏用的是它自己那把
 * （真机实测：门 163547048904175 / 游戏 3045366652924），所以玩家在门里换账号后，
 * 游戏仍然进旧号 —— 这是业主 2026-10-18 报的症状。
 *
 * 根上的修法是让门自己读到游戏那把号（`f3a929…_device`）。真机上两条线索（v5.22 的
 * 候选路径扫描、v5.24 的诊断清单、业主在 Documents 里的手搜）都表明那个文件**不在**
 * 我们能猜到的位置上（iOS 上很可能压根没落成文件）。于是换一条不需要那个文件的修法：
 * **服务端把两条本来就有的记录并起来**——
 *
 *   · 游戏每次开屏报到：`/tool/signup` 带 `device_id` + `storage_directory_path` + 来源 IP；
 *   · 门每次登录：`/sp-auth/login|register` 带来源 IP（v5.25 起还带 `client_key`＝容器标识）。
 *
 * 同一台机器这两条记录的来源必然一致，于是：
 *
 *   ① 门登录成功后 → 认领（改绑）同一来源此前报到过的设备号（`claimReportedDevices`）；
 *   ② 游戏报到时 → 若同一来源刚有门登录（TTL 内），直接改绑到那个账号
 *      （`followAccountForSignup`，覆盖旧绑定 —— 与 fork 既有语义「新的 register/login
 *      赢下映射」一致，见 `login.ts` 的 2026-02 device rebind 注释）。
 *
 * 两条规则任一先到都能收敛，所以「先登录后开游戏」和「先开游戏后登录」都对。
 *
 * ## 来源键
 * `client_key`（门的容器标识，iOS = `NSHomeDirectory()` 末段 UUID）比 IP 硬：同一户
 * 两个玩家走同一个 NAT 时，IP 会把两人的设备并到一起。客户端 v5.25 起会带上它；
 * 老客户端（含安卓）只有 IP 可用 —— 单机/家庭私服够用，这是刻意的降级。
 *
 * ## 边界
 * 只在 TTL（缺省 30 分钟）内、且来源一致时生效；每一次改绑都写 `bind_audit`
 * （`device_rebind` + `source:"device-follow"`），可回溯可撤销。开关 `SP_DEVICE_FOLLOW`
 * 缺省**开**（这是修 bug 的路径，不是可选项）；置 `0|false|no|off` 关闭，其余值按开处理。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, isAbsolute, join } from "path"

import { appendBindAuditSync } from "../../data/domains/account-binding"
import { getAccountSync } from "../../data/domains/account"
import { getDeviceBindingSync, insertDeviceBindingSync } from "../../data/domains/session"
import { resolveRuntimeDataPaths } from "../../runtime/data-paths"
import { getRealNow, getRealNowMs } from "../../runtime/time/game-time"

/** 认领窗口：门登录后这么久内到达的报到算同一台机器。 */
const DEFAULT_TTL_MS = 30 * 60 * 1000
/** 只能靠 IP 认出同一台机器时（老客户端没有容器标识）用的**短**窗口： */
const DEFAULT_IP_TTL_MS = 5 * 60 * 1000
/** 两张表都只保留最近这么多条（内存态，重启即清）。 */
const MAX_ROWS = 256
/** `bind_audit.detail.source`：一眼看出这行是谁改的绑。 */
const AUDIT_SOURCE = "device-follow"
/** `device_bindings.name` 标记，便于人工排查「这台设备是谁并过来的」。 */
export const DEVICE_FOLLOW_NAME = "device-follow"

interface SignupReport {
    deviceId: number
    ip: string
    path: string
    at: number
}

interface GateLogin {
    accountId: number
    ip: string
    key: string
    at: number
}

const reports: SignupReport[] = []
const logins: GateLogin[] = []

/** `SP_DEVICE_FOLLOW` 缺省开；只有明确的否定值才关。 */
export function deviceFollowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = (env.SP_DEVICE_FOLLOW ?? "").trim().toLowerCase()
    if (raw === "") return true
    return !["0", "false", "no", "off"].includes(raw)
}

function ttlMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.SP_DEVICE_FOLLOW_TTL_MS ?? "")
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS
}

function ipTtlMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env.SP_DEVICE_FOLLOW_IP_TTL_MS ?? "")
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IP_TTL_MS
}

function push<T>(list: T[], row: T): void {
    list.push(row)
    if (list.length > MAX_ROWS) list.splice(0, list.length - MAX_ROWS)
}

/* ------------------------------------------------------------------ *
 * 报到记录落盘（2026-10-18 补的冷启动洞）
 *
 * 原来两张表都只在内存里 ⇒ 服务器一重启，「门登录」还在（玩家刚操作），但**报到记录**没了
 * ⇒ 认领空手，玩家换号后游戏仍进旧号。业主真机就是这个情况：游戏最后一次报到在重启之前。
 * 报到记录带 `storage_directory_path`（里面有容器 UUID）⇒ 落盘后还能跟门的 `client_key`
 * 精确对上；门的登录记录也一起落盘，这样窗口内的「刚在门里换过账号」不会因为重启丢失。
 * 路径：`<DATA_DIR>/device-follow-state.json`（`SP_DEVICE_FOLLOW_STORE` 可覆盖成绝对路径）。
 * 读写全部 best-effort：出错只 WARN，绝不影响游戏请求。
 * ------------------------------------------------------------------ */

const STORE_VERSION = 1
const STORE_FILE_NAME = "device-follow-state.json"
let storeLoaded = false

function storeFilePath(): string | null {
    const override = (process.env.SP_DEVICE_FOLLOW_STORE ?? "").trim()
    if (override.length > 0) return isAbsolute(override) ? override : null
    try {
        return join(resolveRuntimeDataPaths().dataDir, STORE_FILE_NAME)
    } catch (error) {
        console.warn(`[DEVICE-FOLLOW] 状态文件路径不可用：${(error as Error).message}`)
        return null
    }
}

function loadStoreOnce(): void {
    if (storeLoaded) return
    storeLoaded = true
    const file = storeFilePath()
    if (file === null || !existsSync(file)) return
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
            version?: number
            reports?: SignupReport[]
            logins?: GateLogin[]
        }
        if (parsed.version !== STORE_VERSION) return
        const now = getRealNowMs()
        const ttl = ttlMs()
        if (Array.isArray(parsed.reports)) {
            for (const row of parsed.reports) {
                if (row === null || typeof row !== "object") continue
                if (!Number.isFinite(row.deviceId) || row.deviceId <= 0) continue
                if (!Number.isFinite(row.at) || now - row.at > ttl) continue
                push(reports, {
                    deviceId: row.deviceId,
                    ip: normalizeIp(row.ip),
                    path: typeof row.path === "string" ? row.path : "",
                    at: row.at,
                })
            }
        }
        if (Array.isArray(parsed.logins)) {
            for (const row of parsed.logins) {
                if (row === null || typeof row !== "object") continue
                if (!Number.isFinite(row.accountId) || row.accountId <= 0) continue
                if (!Number.isFinite(row.at) || now - row.at > ttl) continue
                push(logins, {
                    accountId: row.accountId,
                    ip: normalizeIp(row.ip),
                    key: typeof row.key === "string" ? row.key : "",
                    at: row.at,
                })
            }
        }
        if (reports.length > 0 || logins.length > 0) {
            console.log(
                `[DEVICE-FOLLOW] 从磁盘恢复 ${reports.length} 条游戏报到 + ${logins.length} 条门登录（跨重启并号）`,
            )
        }
    } catch (error) {
        console.warn(`[DEVICE-FOLLOW] 状态文件读取失败（忽略）：${(error as Error).message}`)
    }
}

function persistStore(): void {
    const file = storeFilePath()
    if (file === null) return
    try {
        mkdirSync(dirname(file), { recursive: true })
        const temporary = `${file}.tmp`
        writeFileSync(
            temporary,
            JSON.stringify({ version: STORE_VERSION, reports, logins }),
            "utf8",
        )
        renameSync(temporary, file)
    } catch (error) {
        console.warn(`[DEVICE-FOLLOW] 状态文件落盘失败（忽略）：${(error as Error).message}`)
    }
}

/** 归一化来源 IP（Fastify 可能给 `::ffff:127.0.0.1`）。 */
export function normalizeIp(ip: string | undefined | null): string {
    if (typeof ip !== "string" || ip.length === 0) return ""
    return ip.startsWith("::ffff:") ? ip.slice(7) : ip
}

/** 归一化容器标识：只留最后一段（UUID/包名），去掉路径分隔与大小写差异。 */
function normalizeKey(key: string | undefined | null): string {
    if (typeof key !== "string") return ""
    const trimmed = key.trim()
    if (trimmed.length === 0) return ""
    const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0)
    return (parts.length > 0 ? parts[parts.length - 1] : trimmed).toLowerCase()
}

/**
 * 容器标识是否**够专属**、可以当身份用：必须是「安装级」的随机串（iOS 容器的
 * `12345678-1234-1234-1234-123456789abc` 形态）。
 * 反例：包名（`com.leiting.wf`）、安卓数据目录末段（`local store`）—— 这些在所有玩家那里
 * 都一样，拿它们当键会把同一台服务器上的玩家并成同一个账号，所以一律不认，
 * 退回按来源 IP 的短窗口（同一 NAT 下才会误并，且只有几分钟）。
 */
function isContainerKey(key: string): boolean {
    return /^[0-9a-z-]{16,}$/.test(key)
}

/**
 * 门登录能不能另外用**来源 IP** 去认设备。
 *
 * 能：登录记录没带容器标识 —— 这时 IP 是唯一线索，并号正是靠它工作的（iOS、老客户端）。
 *
 * 不能：登录记录带了容器标识 —— 我们已经知道它来自哪个容器，那么「IP 相同、容器对不上」
 *      的报到属于同一台机器上的**另一个容器**（桌面多开的一个实例），不是同一份存档。
 *      继续按 IP 认会把两个实例的账号对调（A 实例的门登录认领 B 实例的设备号，
 *      B 实例的报到又跟去 A 账号），所以带键的登录一律只认容器。
 *      见 `docs/` 里桌面启动器的多开说明。
 */
function ipFallbackAllowed(loginKey: string): boolean {
    return !isContainerKey(loginKey)
}

/** 来源是否一致：容器标识能对上（最硬）或 IP 相同。返回**怎么对上的**： */
interface OriginLike {
    ip: string
    key?: string
    path?: string
}

type OriginMatch = "key" | "ip" | null

function matchOrigin(a: OriginLike, b: OriginLike): OriginMatch {
    const aKey = normalizeKey(a.key)
    const aPath = (a.path ?? "").toLowerCase()
    const bKey = normalizeKey(b.key)
    const bPath = (b.path ?? "").toLowerCase()
    if (isContainerKey(aKey) && (aKey === bKey || bPath.includes(aKey))) return "key"
    if (isContainerKey(bKey) && aPath.includes(bKey)) return "key"
    if (a.ip.length > 0 && a.ip === b.ip) return "ip"
    return null
}

/** 游戏报到时记一笔（`/tool/signup` 每次都调，无论建号还是复用）。 */
export function noteSignupDevice(input: {
    deviceId: number
    ip?: string | null
    path?: string | null
}): void {
    if (!deviceFollowEnabled()) return
    if (!Number.isFinite(input.deviceId) || input.deviceId <= 0) return
    loadStoreOnce()
    push(reports, {
        deviceId: input.deviceId,
        ip: normalizeIp(input.ip),
        path: typeof input.path === "string" ? input.path : "",
        at: getRealNowMs(),
    })
    persistStore()
}

/** 门登录/注册成功时记一笔。 */
export function noteGateLogin(input: {
    accountId: number
    ip?: string | null
    key?: string | null
}): void {
    if (!deviceFollowEnabled()) return
    loadStoreOnce()
    push(logins, {
        accountId: input.accountId,
        ip: normalizeIp(input.ip),
        key: normalizeKey(input.key),
        at: getRealNowMs(),
    })
    persistStore()
}

/**
 * 报到时该认哪个账号：同一来源在 TTL 内有过门登录 ⇒ 返回那个账号，否则 `null`。
 * 调用方（`/tool/signup`）用它覆盖 `device_bindings` 里的旧绑定。
 */
export function followAccountForSignup(input: {
    deviceId: number
    ip?: string | null
    path?: string | null
    env?: NodeJS.ProcessEnv
}): number | null {
    const env = input.env ?? process.env
    if (!deviceFollowEnabled(env)) return null
    const now = getRealNowMs()
    const ttl = ttlMs(env)
    const ipTtl = ipTtlMs(env)
    const origin = { ip: normalizeIp(input.ip), key: "", path: typeof input.path === "string" ? input.path : "" }
    for (let index = logins.length - 1; index >= 0; index -= 1) {
        const login = logins[index]
        if (now - login.at > ttl) break
        const match = matchOrigin(login, origin)
        if (match === null) continue
        if (match === "ip") {
            if (!ipFallbackAllowed(normalizeKey(login.key))) continue
            if (now - login.at > ipTtl) continue
        }
        const account = getAccountSync(login.accountId)
        if (account === null || account === undefined) continue
        return login.accountId
    }
    return null
}

/**
 * 门登录成功后认领同一来源报到过的设备号；返回被改绑的 device_id（新→旧无关，按认领顺序）。
 * 已经是该账号的设备不动（不写审计、不重复改绑）。
 */
export function claimReportedDevices(input: {
    accountId: number
    ip?: string | null
    key?: string | null
    loginName?: string | null
    env?: NodeJS.ProcessEnv
}): number[] {
    const env = input.env ?? process.env
    if (!deviceFollowEnabled(env)) return []
    const now = getRealNowMs()
    const ttl = ttlMs(env)
    const ipTtl = ipTtlMs(env)
    const origin = { ip: normalizeIp(input.ip), key: normalizeKey(input.key) }
    const claimed: number[] = []
    const seen = new Set<number>()
    for (const report of reports) {
        if (now - report.at > ttl) continue
        const match = matchOrigin(origin, report)
        if (match === null) continue
        if (match === "ip") {
            if (!ipFallbackAllowed(origin.key)) continue
            if (now - report.at > ipTtl) continue
        }
        if (seen.has(report.deviceId)) continue
        seen.add(report.deviceId)
        const binding = getDeviceBindingSync(report.deviceId)
        if (binding !== null && binding.account_id === input.accountId) continue
        insertDeviceBindingSync(report.deviceId, input.accountId, DEVICE_FOLLOW_NAME)
        appendBindAuditSync({
            action: "login",
            accountId: input.accountId,
            detail: {
                reason: "device_rebind",
                source: AUDIT_SOURCE,
                device_id: report.deviceId,
                previous_account_id: binding === null ? null : binding.account_id,
                login_name: input.loginName ?? null,
            },
            actor: "sp-auth",
            createdAt: getRealNow().toISOString(),
        })
        claimed.push(report.deviceId)
        console.log(
            `[DEVICE-FOLLOW] 认领 device_id=${report.deviceId} -> account_id=${input.accountId} (match=${match})`,
        )
    }
    return claimed
}

/**
 * 游戏侧请求统一入口（`/tool/signup`、`/load` 等带 `device_id` + `storage_directory_path` 的都在用）：
 *
 *   ① 记下这次报到（落盘，跨重启还在）；
 *   ② 同一来源刚有门登录（TTL 内）⇒ 把这台设备改绑到那个账号；
 *   ③ 返回**这台设备现在归属的账号** —— 调用方据此纠正「按 viewer 会话解析出来的旧账号」。
 *
 * 返回 `null` = 不需要纠正（没绑定、或绑的就是会话那个账号）。
 */
export function followDeviceOnGameRequest(input: {
    deviceId: number
    ip?: string | null
    path?: string | null
    sessionAccountId?: number | null
    label?: string | null
}): number | null {
    if (!deviceFollowEnabled()) return null
    if (!Number.isFinite(input.deviceId) || input.deviceId <= 0) return null
    const label = input.label ?? "game"
    noteSignupDevice({ deviceId: input.deviceId, ip: input.ip, path: input.path })
    const followed = followAccountForSignup({
        deviceId: input.deviceId,
        ip: input.ip,
        path: input.path,
    })
    if (followed !== null) {
        const before = getDeviceBindingSync(input.deviceId)
        if (before === null || before.account_id !== followed) {
            insertDeviceBindingSync(input.deviceId, followed, DEVICE_FOLLOW_NAME)
            appendBindAuditSync({
                action: "login",
                accountId: followed,
                detail: {
                    reason: "device_rebind",
                    source: AUDIT_SOURCE,
                    via: label,
                    device_id: input.deviceId,
                    previous_account_id: before === null ? null : before.account_id,
                },
                actor: "sp-auth",
                createdAt: getRealNow().toISOString(),
            })
            console.log(
                `[DEVICE-FOLLOW] 报到改绑 device_id=${input.deviceId} -> account_id=${followed} (via=${label})`,
            )
        }
    }
    const binding = getDeviceBindingSync(input.deviceId)
    if (binding === null) return null
    if (input.sessionAccountId === null || input.sessionAccountId === undefined) {
        return binding.account_id
    }
    if (binding.account_id === input.sessionAccountId) return null
    console.log(
        `[DEVICE-FOLLOW] 设备优先纠正（via=${label}）device_id=${input.deviceId} `
        + `会话账号=${input.sessionAccountId} -> 设备账号=${binding.account_id}`,
    )
    return binding.account_id
}

/** 测试/排障用：清空内存态。 */
export function resetDeviceFollowStateForTest(): void {
    reports.length = 0
    logins.length = 0
}

/** 启动横幅：让服主在日志第一屏就能看到并号开没开、两个窗口多大（由 `src/cn-server.ts` 调用）。 */
export function reportDeviceFollowMode(env: NodeJS.ProcessEnv = process.env): boolean {
    if (!deviceFollowEnabled(env)) {
        console.log(
            "[DEVICE-FOLLOW] disabled（SP_DEVICE_FOLLOW=关）：门里换账号后游戏仍会进旧账号（换号不生效）",
        )
        return false
    }
    const minutes = (ms: number): number => Math.round(ms / 60000)
    console.log(
        "[DEVICE-FOLLOW] enabled: 门登录/注册成功后认领同一来源报到过的设备号；游戏报到时若同一来源"
        + `刚有门登录则直接改绑（容器标识窗口 ${minutes(ttlMs(env))}min，`
        + `只靠来源 IP 时 ${minutes(ipTtlMs(env))}min；客户端带 client_key 则按容器精确匹配）`,
    )
    return true
}

/** 排障用：当前内存态快照（`/sp-auth/diag` 或人工调用）。 */
export function deviceFollowSnapshot(): { reports: SignupReport[], logins: GateLogin[] } {
    return { reports: [...reports], logins: [...logins] }
}
