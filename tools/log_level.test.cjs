"use strict"

// 服务端日志开关（src/runtime/log-level.ts）的行为与契约测试。
//
// 四类断言：
//   1. 解析 —— 认识的名字/别名/大小写/空格，以及**不认识就返回 null**（绝不猜）。
//   2. 优先级 —— SP_LOG_LEVEL > LOG_LEVEL > 缺省 info（缺省必须等于历史行为）。
//   3. 落盘路径 —— 缺省 / `0` 关掉 / 相对按 projectRoot / 绝对原样。
//   4. 改道 —— warn 档：log 进文件、warn 进窗口；silent 档 + 不落盘：窗口全静；
//              close() 必须把 console 原样还回来（否则测试会污染后续用例）。
//
// 运行：node tools/log_level.test.cjs

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { setTimeout: delay } = require("node:timers/promises")

require("ts-node/register/transpile-only")

const repositoryRoot = path.resolve(__dirname, "..")
const logLevelPath = path.join(repositoryRoot, "src/runtime/log-level.ts")

const {
    DEFAULT_SERVER_LOG_MAX_BYTES,
    installConsoleLogGate,
    isServerLogEnabled,
    isServerLogLevel,
    parseServerLogLevel,
    resolveServerLogFilePath,
    resolveServerLogLevel,
} = require(logLevelPath)

/** 把 process.stdout/stderr 换成收集器，返回 { lines, restore }。 */
function captureStdio() {
    const lines = []
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    const collect = chunk => {
        lines.push(String(chunk))
        return true
    }
    process.stdout.write = collect
    process.stderr.write = collect
    return {
        lines,
        text: () => lines.join(""),
        restore: () => {
            process.stdout.write = stdoutWrite
            process.stderr.write = stderrWrite
        },
    }
}

function tempDir(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sp-log-level-${name}-`))
    return dir
}

test("parseServerLogLevel：认识的名字与别名", () => {
    assert.equal(parseServerLogLevel("info"), "info")
    assert.equal(parseServerLogLevel("debug"), "debug")
    assert.equal(parseServerLogLevel("warn"), "warn")
    assert.equal(parseServerLogLevel("error"), "error")
    assert.equal(parseServerLogLevel("silent"), "silent")

    // 大小写与空白
    assert.equal(parseServerLogLevel("  WARN  "), "warn")
    assert.equal(parseServerLogLevel("Info"), "info")

    // 别名
    assert.equal(parseServerLogLevel("warning"), "warn")
    assert.equal(parseServerLogLevel("off"), "silent")
    assert.equal(parseServerLogLevel("none"), "silent")
    assert.equal(parseServerLogLevel("verbose"), "debug")
    assert.equal(parseServerLogLevel("trace"), "debug")
})

test("parseServerLogLevel：不认识的值一律 null（不静默降级）", () => {
    assert.equal(parseServerLogLevel(""), null)
    assert.equal(parseServerLogLevel("   "), null)
    assert.equal(parseServerLogLevel("banana"), null)
    assert.equal(parseServerLogLevel("inf"), null)
    assert.equal(parseServerLogLevel(undefined), null)
    assert.equal(parseServerLogLevel(null), null)
    assert.equal(parseServerLogLevel(3), null)
    assert.equal(parseServerLogLevel({}), null)
})

test("isServerLogLevel：类型守卫只认五个名字", () => {
    for (const level of ["silent", "error", "warn", "info", "debug"]) {
        assert.equal(isServerLogLevel(level), true)
    }
    for (const bad of ["", "quiet", "INFO", "warnings"]) {
        assert.equal(isServerLogLevel(bad), false)
    }
})

test("resolveServerLogLevel：SP_LOG_LEVEL 优先，其次 LOG_LEVEL，最后 info", () => {
    assert.equal(resolveServerLogLevel({ SP_LOG_LEVEL: "warn" }), "warn")
    assert.equal(resolveServerLogLevel({ LOG_LEVEL: "error" }), "error")
    assert.equal(resolveServerLogLevel({ SP_LOG_LEVEL: "warn", LOG_LEVEL: "error" }), "warn")
    assert.equal(resolveServerLogLevel({}), "info")
    // 非法值不能把级别带偏：SP 非法就看 LOG_LEVEL，两个都非法才回 info
    assert.equal(resolveServerLogLevel({ SP_LOG_LEVEL: "banana", LOG_LEVEL: "debug" }), "debug")
    assert.equal(resolveServerLogLevel({ SP_LOG_LEVEL: "banana", LOG_LEVEL: "banana" }), "info")
    assert.equal(resolveServerLogLevel({ SP_LOG_LEVEL: "off" }), "silent")
})

test("isServerLogEnabled：档位矩阵", () => {
    assert.equal(isServerLogEnabled("debug", "debug"), true)
    assert.equal(isServerLogEnabled("info", "debug"), false)
    assert.equal(isServerLogEnabled("info", "info"), true)
    assert.equal(isServerLogEnabled("warn", "info"), false)
    assert.equal(isServerLogEnabled("warn", "warn"), true)
    assert.equal(isServerLogEnabled("error", "warn"), false)
    assert.equal(isServerLogEnabled("error", "error"), true)
    // silent 连 error 都关
    assert.equal(isServerLogEnabled("silent", "error"), false)
})

test("resolveServerLogFilePath：缺省 / 关闭 / 相对 / 绝对", () => {
    const root = path.join("C:", "spcn")
    assert.equal(resolveServerLogFilePath({}, root), path.join(root, "logs", "server.log"))
    assert.equal(resolveServerLogFilePath({ SP_LOG_FILE: "" }, root), path.join(root, "logs", "server.log"))
    for (const off of ["0", "off", "none", "false", " OFF "]) {
        assert.equal(resolveServerLogFilePath({ SP_LOG_FILE: off }, root), null)
    }
    assert.equal(resolveServerLogFilePath({ SP_LOG_FILE: "logs/custom.log" }, root), path.join(root, "logs", "custom.log"))
    const absolute = path.join(root, "elsewhere", "srv.log")
    assert.equal(resolveServerLogFilePath({ SP_LOG_FILE: absolute }, root), absolute)
})

test("installConsoleLogGate：warn 档把 console.log 改道落盘，warn 仍进窗口", async () => {
    const dir = tempDir("warn")
    const file = path.join(dir, "server.log")
    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "warn", filePath: file })
    try {
        console.log("[LOBBY] should go to the file")
        console.info("[TCP] connection accepted")
        console.warn("[WARN] stays on screen")
        console.error("[ERR] stays on screen")
    } finally {
        gate.close()
        capture.restore()
    }
    await delay(50)

    const written = fs.readFileSync(file, "utf8")
    assert.match(written, /\[LOBBY\] should go to the file/)
    assert.match(written, /\[TCP\] connection accepted/)
    // 落盘行带 ISO 时间戳前缀
    assert.match(written, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/m)

    const onScreen = capture.text()
    assert.match(onScreen, /\[WARN\] stays on screen/)
    assert.match(onScreen, /\[ERR\] stays on screen/)
    assert.doesNotMatch(onScreen, /\[LOBBY\] should go to the file/)
    assert.doesNotMatch(onScreen, /\[TCP\] connection accepted/)
})

test("installConsoleLogGate：silent 档 + 不落盘 = 窗口全静", () => {
    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "silent", filePath: null })
    try {
        console.log("dropped")
        console.info("dropped")
        console.debug("dropped")
        console.warn("dropped")
        console.error("dropped")
        assert.equal(capture.text(), "")
    } finally {
        gate.close()
        capture.restore()
    }
})

test("installConsoleLogGate：close 后 console 复原", () => {
    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "silent", filePath: null })
    gate.close()
    try {
        console.log("[BACK] original console works again")
        assert.match(capture.text(), /\[BACK\] original console works again/)
    } finally {
        capture.restore()
    }
})

test("installConsoleLogGate：info 档下 log/info 不动，debug 被挡", () => {
    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "info", filePath: null, quiet: { log: false, info: false, debug: true } })
    try {
        console.log("[INFO] still on screen")
        console.debug("[DEBUG] gated because info < debug")
        assert.match(capture.text(), /\[INFO\] still on screen/)
        assert.doesNotMatch(capture.text(), /\[DEBUG\]/)
    } finally {
        gate.close()
        capture.restore()
    }
})

test("installConsoleLogGate：落盘打不开时退回窗口（宁可吵，不可丢）", () => {
    const dir = tempDir("broken")
    const blocker = path.join(dir, "not-a-dir")
    fs.writeFileSync(blocker, "occupied", "utf8")
    // 父路径是文件 ⇒ mkdirSync 直接抛 ENOTDIR ⇒ 门闩降级为「落盘失败」
    const file = path.join(blocker, "nested", "server.log")

    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "warn", filePath: file })
    try {
        console.log("[FALLBACK] file sink is broken")
        assert.match(capture.text(), /\[FALLBACK\] file sink is broken/)
    } finally {
        gate.close()
        capture.restore()
    }
})

test("installConsoleLogGate：超过上限先归档成 .1 再重开", async () => {
    const dir = tempDir("rotate")
    const file = path.join(dir, "server.log")
    fs.writeFileSync(file, "x".repeat(64), "utf8")

    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "warn", filePath: file, maxBytes: 32 })
    try {
        console.log("[AFTER-ROTATE] fresh file")
    } finally {
        gate.close()
        capture.restore()
    }
    await delay(50)

    assert.equal(fs.existsSync(`${file}.1`), true)
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(64))
    const fresh = fs.readFileSync(file, "utf8")
    assert.match(fresh, /\[AFTER-ROTATE\] fresh file/)
    assert.ok(fresh.length < 64 + 200, `rotated file should start fresh, got ${fresh.length} bytes`)
})

test("installConsoleLogGate：目录会被自动创建（logs/ 不存在也能落盘）", async () => {
    const dir = tempDir("mkdir")
    const file = path.join(dir, "nested", "logs", "server.log")
    const capture = captureStdio()
    const gate = installConsoleLogGate({ level: "warn", filePath: file })
    try {
        console.log("[NESTED] made the directory")
    } finally {
        gate.close()
        capture.restore()
    }
    await delay(50)
    assert.match(fs.readFileSync(file, "utf8"), /\[NESTED\] made the directory/)
})

test("缺省上限是个像样的数字（16MB）", () => {
    assert.equal(DEFAULT_SERVER_LOG_MAX_BYTES, 16 * 1024 * 1024)
})
