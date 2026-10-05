/**
 * 服务端日志开关（运维用）—— 让窗口安静下来，同时一行都不丢。
 *
 * 两个环境变量（都来自 `tools/start_cn.cjs` 用 `process.loadEnvFile` 加载的 `.env`）：
 *  - `SP_LOG_LEVEL` = `info`（缺省，行为与未打补丁时一致）| `warn` | `error` | `silent` | `debug`
 *  - `SP_LOG_FILE`  = 低于 info 时 `console.log/info/debug` 的落盘文件；
 *                     缺省 `<projectRoot>/logs/server.log`，写 `0` 表示丢弃不落盘。
 *
 * 语义（窗口里能看到什么）：
 *  - `warn`   ⇒ Fastify 不再逐请求刷屏（只留 4xx/5xx），`console.log/info` 改道落盘，
 *               `console.warn/error` 照常进窗口 —— 出问题不会被吞掉。
 *  - `error`  ⇒ 窗口只剩错误；`warn` 也改道落盘。
 *  - `silent` ⇒ 窗口全静，落盘文件保留（除非 `SP_LOG_FILE=0`）。
 *  - `debug`  ⇒ 与 info 相同，另放开 `console.debug`。
 *
 * 为什么「改道」而不是「删日志」：崩现场（例如 `Fatal process out of memory: Zone`）前后的行
 * 只能靠日志回溯，而 cmd 窗口的回滚缓冲区又小又会被刷掉；落盘文件才查得动。
 *
 * 注意：本模块必须在任何业务日志之前安装（`src/cn-server.ts` 顶层、建 Fastify 之前）。
 * `process.loadEnvFile` 已在 `tools/start_cn.cjs` 里跑过，所以这里读到的 env 是最终值。
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { format } from "node:util"

export type ServerLogLevel = "silent" | "error" | "warn" | "info" | "debug"

const SERVER_LOG_LEVELS: readonly ServerLogLevel[] = ["silent", "error", "warn", "info", "debug"]

const SERVER_LOG_LEVEL_RANK: Record<ServerLogLevel, number> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
}

/** 常见写法归一：`off`/`none` 当 silent、`warning` 当 warn、`verbose`/`trace` 当 debug。 */
const SERVER_LOG_LEVEL_ALIASES: Record<string, ServerLogLevel> = {
    off: "silent",
    none: "silent",
    warning: "warn",
    verbose: "debug",
    trace: "debug",
}

/** 缺省落盘上限：超过就把当前文件改名成 `<file>.1` 重新开始（只保留一代）。 */
export const DEFAULT_SERVER_LOG_MAX_BYTES = 16 * 1024 * 1024

/** 缺省落盘路径（相对 projectRoot）。 */
export const DEFAULT_SERVER_LOG_RELATIVE_PATH = join("logs", "server.log")

export function isServerLogLevel(value: string): value is ServerLogLevel {
    return SERVER_LOG_LEVELS.some(level => level === value)
}

/** 解析单个取值；不认识（含空串/非字符串）返回 null —— 交给调用方决定回退，绝不猜。 */
export function parseServerLogLevel(raw: unknown): ServerLogLevel | null {
    if (typeof raw !== "string") return null
    const normalized = raw.trim().toLowerCase()
    if (normalized.length === 0) return null
    if (isServerLogLevel(normalized)) return normalized
    return SERVER_LOG_LEVEL_ALIASES[normalized] ?? null
}

/** `SP_LOG_LEVEL` 优先，其次通用 `LOG_LEVEL`，都无效则 `info`（= 保持历史行为）。 */
export function resolveServerLogLevel(env: NodeJS.ProcessEnv = process.env): ServerLogLevel {
    const fromSp = parseServerLogLevel(env.SP_LOG_LEVEL)
    if (fromSp !== null) return fromSp
    return parseServerLogLevel(env.LOG_LEVEL) ?? "info"
}

/** 该级别下，`at` 这一档是否还该输出。 */
export function isServerLogEnabled(level: ServerLogLevel, at: Exclude<ServerLogLevel, "silent">): boolean {
    return SERVER_LOG_LEVEL_RANK[level] >= SERVER_LOG_LEVEL_RANK[at]
}

/**
 * `SP_LOG_FILE` 解析：空 = 缺省 `<projectRoot>/logs/server.log`；
 * `0`/`off`/`none`/`false` = 不落盘；相对路径按 projectRoot 解析，绝对路径原样用。
 */
export function resolveServerLogFilePath(env: NodeJS.ProcessEnv = process.env, projectRoot: string): string | null {
    const raw = (env.SP_LOG_FILE ?? "").trim()
    const lowered = raw.toLowerCase()
    if (lowered === "0" || lowered === "off" || lowered === "none" || lowered === "false") return null
    if (raw.length === 0) return join(projectRoot, DEFAULT_SERVER_LOG_RELATIVE_PATH)
    return isAbsolute(raw) ? raw : join(projectRoot, raw)
}

export interface ConsoleLogGateOptions {
    readonly level: ServerLogLevel
    /** null / 省略 = 只静默不落盘。 */
    readonly filePath?: string | null
    readonly maxBytes?: number
    /** 需要改道的档位；缺省按 level 推导（info 档不动 console.log/info）。 */
    readonly quiet?: Partial<Record<"log" | "info" | "debug" | "warn" | "error", boolean>>
}

export interface ConsoleLogGate {
    readonly level: ServerLogLevel
    readonly filePath: string | null
    /** 复原 console 并关掉落盘文件（测试与降级用）。 */
    close(): void
}

interface FileLogSink {
    /** 返回 false = 这一行没写进去（调用方应回退到窗口输出）。 */
    write(line: string): boolean
    close(): void
}

function createFileSink(filePath: string, maxBytes: number): FileLogSink {
    let stream: ReturnType<typeof createWriteStream> | null = null
    let bytes = 0
    let broken = false

    const open = (): void => {
        try {
            mkdirSync(dirname(filePath), { recursive: true })
            bytes = existsSync(filePath) ? statSync(filePath).size : 0
            if (maxBytes > 0 && bytes >= maxBytes) {
                const archived = `${filePath}.1`
                if (existsSync(archived)) rmSync(archived, { force: true })
                renameSync(filePath, archived)
                bytes = 0
            }
            const created = createWriteStream(filePath, { flags: "a" })
            created.on("error", () => { broken = true; stream = null })
            stream = created
        } catch {
            broken = true
            stream = null
        }
    }

    open()

    return {
        write(line) {
            if (broken || stream === null) return false
            const payload = `${line}\n`
            try {
                stream.write(payload)
            } catch {
                broken = true
                stream = null
                return false
            }
            bytes += Buffer.byteLength(payload)
            return true
        },
        close() {
            const current = stream
            stream = null
            current?.end()
        },
    }
}

/**
 * 安装 console 改道。**只动本进程的 console**，返回的门闩可 `close()` 复原（测试用）。
 * 落盘失败自动退回窗口输出 —— 宁可吵，不可丢。
 */
export function installConsoleLogGate(options: ConsoleLogGateOptions): ConsoleLogGate {
    const level = options.level
    const filePath = options.filePath ?? null
    const maxBytes = options.maxBytes ?? DEFAULT_SERVER_LOG_MAX_BYTES

    const original = {
        log: console.log.bind(console) as (...data: unknown[]) => void,
        info: console.info.bind(console) as (...data: unknown[]) => void,
        debug: console.debug.bind(console) as (...data: unknown[]) => void,
        warn: console.warn.bind(console) as (...data: unknown[]) => void,
        error: console.error.bind(console) as (...data: unknown[]) => void,
    }

    let sink: FileLogSink | null = filePath === null ? null : createFileSink(filePath, maxBytes)
    const quiet = {
        log: options.quiet?.log ?? !isServerLogEnabled(level, "info"),
        info: options.quiet?.info ?? !isServerLogEnabled(level, "info"),
        debug: options.quiet?.debug ?? !isServerLogEnabled(level, "debug"),
        warn: options.quiet?.warn ?? !isServerLogEnabled(level, "warn"),
        error: options.quiet?.error ?? !isServerLogEnabled(level, "error"),
    }

    const route = (fallback: (...data: unknown[]) => void) => (...args: unknown[]): void => {
        // 明确不落盘（filePath=null）⇒ 这一档就是要静默，直接丢弃。
        if (sink === null) return
        const line = `${new Date().toISOString()} ${format(...args)}`
        if (sink.write(line)) return
        // 落盘失败（目录建不出来 / 磁盘满）⇒ 退回窗口输出：宁可吵，不可丢。
        fallback(...args)
    }

    if (quiet.log) console.log = route(original.log)
    if (quiet.info) console.info = route(original.info)
    if (quiet.debug) console.debug = route(original.debug)
    if (quiet.warn) console.warn = route(original.warn)
    if (quiet.error) console.error = route(original.error)

    return {
        level,
        filePath,
        close() {
            console.log = original.log
            console.info = original.info
            console.debug = original.debug
            console.warn = original.warn
            console.error = original.error
            sink?.close()
            sink = null
        },
    }
}
