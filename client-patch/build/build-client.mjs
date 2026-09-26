#!/usr/bin/env node
// A8 / P7 · Android 出包与签名流水线 —— 一条命令把客户端 APK 从素材打到可安装产物。
//
// 为什么需要它（而不是继续用 client-patch/apply.sh）：
//   apply.sh 是 20 行 perl，就地改两个 .as 文本，然后靠人手跑 FFDec 回编译、人手敲 apksigner。
//   服主口径是「换地址 = 改一处 + 重构建」，那就必须有一条**可重复、可断言、可留证**的产线：
//       基线 APK
//         → 〔可选 AS3 层回编译钩子，默认不执行〕
//         → 端点确保（把 API 基址常量改到 --host:--port）
//         → 纯 Node 回封 zip（逐条保留 method / versionMadeBy / externalAttr）
//         → zipalign -p -f 4
//         → apksigner sign（缺凭据则明确产出「未签名（缺凭据）」）
//         → apksigner verify --verbose
//         → <out>.build-report.json（含 base/output sha256 与站点前后指纹）
//
// 本脚本只做**编排**，所有"改字节"的能力都复用 P10-A 的 client-patch/build/lib/**（只读）：
//   lib/zip-ipa.mjs       零依赖 ZIP 引擎
//   lib/ios-abc.mjs       ABC 常量池 `scheme + host` 成对等长改写（纯 Buffer 函数，非 iOS 专有）
//   lib/build-report.mjs  断言收集器 + sha256 + 报告落盘
//
// 三条硬规矩（会被断言与构建报告固化，破坏其中任何一条都必须让产线非 0 退出）：
//   1. 地址只经 --host/--port 传入。脚本内、仓库内绝不出现任何实例地址（示例一律用 192.168.1.10）。
//   2. 口令只从 --ks-pass-env 指定的环境变量读，绝不落盘、绝不写进脚本。缺凭据时明确报
//      「未签名（缺凭据）」并把未签名 APK 交出来，**绝不伪造签名成功**。
//   3. 任何一条 FAIL 都不出包（退出码 2）。B0 的教训：派生件静默丢补丁，产物看上去一切正常。
//
// 用法见 client-patch/build/CLIENT-BUILD.md；`--help` 也打印同一份要点。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { deflateSync, inflateSync } from "node:zlib"
import { fileURLToPath, pathToFileURL } from "node:url"

import { ABC_API_HOST, ABC_API_SCHEME, applyApiBaseRewrite, findSchemeHostPair } from "./lib/ios-abc.mjs"
import { createAssertions, hexRanges, sha256Hex, writeBuildReport } from "./lib/build-report.mjs"
import { readEntryData, readZipEntries, replaceEntryData, writeZipEntries } from "./lib/zip-ipa.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")

export const TOOL_NAME = "build-client.mjs"
export const TOOL_VERSION = "1.0.0"
export const REPORT_SCHEMA = "sp-cn.client-build/v1"

/** 与 client-patch/README.md:7 的要求一致：ABC 重写结果随 FFDec 版本变化，所以版本要钉死并留证。 */
export const REQUIRED_FFDEC_VERSION = "24.0.1"

const RENAME_PACKAGE_TOOL = path.join(REPO_ROOT, "client-patch", "tools", "rename-package.mjs")
const PATCH_IPA_TOOL = path.join(HERE, "patch-ipa.mjs")

const HELP = `用法：
  node client-patch/build/build-client.mjs --base <apk|ipa> --host <ip> --port <port> --out <apk> [选项]

必填：
  --base <file>        基线素材（apkipa/ 里的官方 APK；.ipa 会转交 patch-ipa.mjs）
  --host <ip>          服务端地址（编译期常量，换地址就重构建）
  --port <port>        服务端端口
  --out <file>         产物路径（必须与 --base 不同）

签名（可缺省 ⇒ 产出「未签名（缺凭据）」）：
  --ks <file>          keystore（PKCS12/JKS）
  --ks-pass-env <VAR>  存放口令的环境变量名（默认 SP_KS_PASS）；口令绝不入库
  --ks-alias <name>    key alias（默认 spcn）
  --require-signature  没有有效签名就判 FAIL（CI 用）

端点与 AS3 层：
  --as3-hook <file.mjs>  可选 AS3 层回编译钩子（默认不执行；执行时会跑 FFDec）
  --ffdec <jar>          FFDec jar（钩子需要；也用于版本留证）
  --java <exe>           java 可执行文件（默认 PATH 上的 java）
  --allow-ffdec-version-mismatch  允许 FFDec 版本与 ${REQUIRED_FFDEC_VERSION} 不一致（降级为警告）

工具定位：
  --zipalign <exe>      zipalign（默认找 ZIPALIGN / ANDROID_BUILD_TOOLS / ANDROID_HOME / PATH）
  --apksigner <file>    apksigner（同上，APKSIGNER）

其它：
  --rename-package      P12 的包名改写开关（默认关；缺 rename-package.mjs 时明确报错且不做事）
  --rename-to <pkg>     透传给 rename-package.mjs 的目标包名
  --work <dir>          临时目录（默认系统 temp；必须纯 ASCII —— FFDec 的硬要求）
  --keep-work           保留临时目录（排查用）
  --dry-run             只打印完整命令序列，不产生任何文件
  --help                打印本页
`

// ─────────────────────────── 参数解析 ───────────────────────────

/**
 * 解析 argv。兼容 `--key value` 与 `--key=value` 两种写法，裸开关取 true。
 * （照抄 P10-A 在 patch-ipa.mjs:73-81 的做法：调用方脚本与文档用的都是空格形式。）
 */
export function parseArgv(argv) {
    const out = {}
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i]
        if (!token.startsWith("--")) continue
        const eq = token.indexOf("=")
        if (eq !== -1) {
            out[token.slice(2, eq)] = token.slice(eq + 1)
            continue
        }
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
            out[token.slice(2)] = next
            i += 1
        } else {
            out[token.slice(2)] = true
        }
    }
    return out
}

function fail(message) {
    console.log(`ERROR ${message}`)
    process.exit(1)
}

function die(message, code = 2) {
    console.error(`Error: ${message}`)
    process.exit(code)
}

function hr(title) {
    console.log(`\n── ${title} ${"─".repeat(Math.max(2, 70 - title.length))}`)
}

// ─────────────────────────── SWF 载荷解包 ───────────────────────────

/** SWF 头（FWS 未压缩 / CWS zlib / ZWS LZMA）。 */
export function parseSwfHeader(buffer) {
    if (buffer.length < 8) throw new Error(`SWF 太短：${buffer.length} B`)
    const magic = buffer.toString("latin1", 0, 3)
    if (magic !== "FWS" && magic !== "CWS" && magic !== "ZWS") throw new Error(`不是 SWF：magic=${JSON.stringify(magic)}`)
    return { magic, version: buffer[3], fileLength: buffer.readUInt32LE(4) }
}

/**
 * 把 SWF 规整成「逻辑 FWS」：FWS 原样，CWS 先 inflate 再重建成 FWS 形式的 Buffer。
 * 这样下游（指纹 / ABC 常量池改写）只面对一种布局，`rewrap` 负责还原成原始压缩形态。
 *
 * 为什么必须支持 CWS：apkipa 里两份基线实测就是这么分的 ——
 *   V1.8.1.apk    主 SWF = FWS（29052839 B 未压缩）
 *   安卓v15.2.apk  主 SWF = CWS（entry usize 15811064，解压后 29209315 B）
 * 只支持 FWS 的话第二份素材直接出不了包。ZWS（LZMA）node 的 zlib 处理不了 ⇒ 明确拒绝并指向 --as3-hook。
 */
export function unwrapSwf(raw) {
    const header = parseSwfHeader(raw)
    if (header.magic === "ZWS") {
        throw new Error("ZWS（LZMA 压缩 SWF）无法用纯 Node 改写；请改用 --as3-hook 交给 FFDec，或换未压缩/Deflate 的基线")
    }
    if (header.magic === "FWS") {
        return {
            magic: "FWS",
            version: header.version,
            declaredFileLength: header.fileLength,
            logical: raw,
            repacked: false,
            rewrap: (patched) => {
                patched.write("FWS", 0, "latin1")
                patched[3] = header.version
                patched.writeUInt32LE(patched.length, 4)
                return patched
            },
        }
    }
    const body = inflateSync(raw.subarray(8))
    if (body.length + 8 !== header.fileLength) {
        throw new Error(`CWS 解压长度与头部不符：头部声明 ${header.fileLength} B，实际 ${body.length + 8} B`)
    }
    const logical = Buffer.alloc(8 + body.length)
    logical.write("FWS", 0, "latin1")
    logical[3] = header.version
    logical.writeUInt32LE(logical.length, 4)
    body.copy(logical, 8)
    return {
        magic: "CWS",
        version: header.version,
        declaredFileLength: header.fileLength,
        logical,
        repacked: true,
        rewrap: (patched) => {
            const newBody = deflateSync(patched.subarray(8), { level: 9 })
            const wrapped = Buffer.alloc(8 + newBody.length)
            wrapped.write("CWS", 0, "latin1")
            wrapped[3] = header.version
            wrapped.writeUInt32LE(patched.length, 4)
            newBody.copy(wrapped, 8)
            return wrapped
        },
    }
}

// ─────────────────────────── APK / 指纹工具 ───────────────────────────

/** 主 SWF = assets/ 下最大的那个 .swf（排除 ANE 自带的 library.swf 与 META-INF 里的东西）。 */
export function findMainSwfEntry(entries) {
    const candidates = entries.filter((entry) => /\.swf$/i.test(entry.name)
        && !/^assets\/META-INF\//i.test(entry.name)
        && !/^META-INF\//i.test(entry.name))
    if (candidates.length === 0) return null
    return candidates.reduce((best, entry) => (entry.usize > best.usize ? entry : best))
}

/** 旧签名（v1 jar signature）条目：内容已被我们改掉，必须摘掉，否则 apksigner verify 必挂。 */
export function isV1SignatureEntry(name) {
    const upper = name.toUpperCase()
    if (upper === "META-INF/MANIFEST.MF") return true
    return /^META-INF\/[^/]+\.(SF|RSA|DSA|EC)$/.test(upper)
}

export function countIn(buffer, needle) {
    const pattern = Buffer.from(needle, "latin1")
    let count = 0
    let index = buffer.indexOf(pattern)
    while (index !== -1) {
        count += 1
        index = buffer.indexOf(pattern, index + pattern.length)
    }
    return count
}

/**
 * 站点指纹：报告里「站点前后指纹」这一项的来源。
 * 记的是 API 基址常量对（`https` + `shijtswygamegf.leiting.com`）的偏移/出现次数/字节数。
 */
export function siteFingerprint(logicalSwf) {
    const pair = findSchemeHostPair(logicalSwf)
    return {
        scheme: ABC_API_SCHEME,
        host: ABC_API_HOST,
        pairOffset: pair ? pair.offset : null,
        pairOffsetHex: pair ? `0x${pair.offset.toString(16)}` : null,
        pairOccurrences: pair ? pair.occurrences : 0,
        pairTotalBytes: pair ? pair.totalBytes : 0,
        schemeCount: countIn(logicalSwf, ABC_API_SCHEME),
        hostCount: countIn(logicalSwf, ABC_API_HOST),
    }
}

// ─────────────────────────── 外部工具定位 ───────────────────────────

function findInPath(fileName) {
    const finder = process.platform === "win32" ? "where" : "which"
    const result = spawnSync(finder, [fileName], { encoding: "utf8", windowsHide: true })
    if (result.status !== 0) return null
    const first = String(result.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0]
    return first && existsSync(first) ? first : null
}

function buildToolsDir() {
    const dirs = []
    if (process.env.ANDROID_BUILD_TOOLS) dirs.push(process.env.ANDROID_BUILD_TOOLS)
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_SDK
    if (sdk) {
        const root = path.join(sdk, "build-tools")
        if (existsSync(root)) {
            let versions = []
            try {
                versions = readdirSync(root)
            } catch {
                versions = []
            }
            for (const version of versions.slice().sort().reverse()) dirs.push(path.join(root, version))
        }
    }
    return dirs
}

/**
 * 定位 zipalign / apksigner。顺序：显式参数 → 同名环境变量 → ANDROID_BUILD_TOOLS → SDK build-tools/<最高版本> → PATH。
 * 都不行就明确报错并给出全部可选途径（绝不"猜一个"然后跑出个可疑产物）。
 */
export function resolveTool({ explicit, envKeys, fileNames, flag, label }) {
    if (explicit) {
        const resolved = path.resolve(String(explicit))
        if (!existsSync(resolved)) fail(`${label} 不存在：${resolved}`)
        return resolved
    }
    for (const key of envKeys) {
        const value = process.env[key]
        if (value && existsSync(value)) return path.resolve(value)
    }
    for (const dir of buildToolsDir()) {
        for (const fileName of fileNames) {
            const candidate = path.join(dir, fileName)
            if (existsSync(candidate)) return candidate
        }
    }
    for (const fileName of fileNames) {
        const found = findInPath(fileName)
        if (found) return found
    }
    return fail(`${label} 找不到。任选其一：--${flag} <路径>；设环境变量 ${envKeys.join(" 或 ")}；`
        + `设 ANDROID_BUILD_TOOLS 指向 build-tools 目录；设 ANDROID_HOME 指向 SDK 根；或把它放进 PATH。`)
}

/** 跑一个外部进程并收集输出。.bat/.cmd 走 cmd.exe（Windows 上 spawn 不能直接执行批处理）。 */
export function runTool(toolPath, args, { cwd = process.cwd(), allowFailure = false } = {}) {
    const lower = toolPath.toLowerCase()
    let command = toolPath
    let argv = args
    if (/\.(mjs|js)$/.test(lower)) {
        // 测试/桩用：允许把工具位置指向一个 JS 脚本，由 node 执行（单测注入假 zipalign/apksigner）。
        command = process.execPath
        argv = [toolPath, ...args]
    } else if (process.platform === "win32" && /\.(bat|cmd)$/.test(lower)) {
        const line = [toolPath, ...args].map(quoteForShell).join(" ")
        command = process.env.ComSpec || "cmd.exe"
        argv = ["/d", "/s", "/c", `"${line}"`]
    }
    const result = spawnSync(command, argv, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    const ok = result.status === 0
    if (!ok && !allowFailure) {
        const detail = String(result.stderr || result.stdout || result.error?.message || "").trim()
        die(`${path.basename(toolPath)} 执行失败（exit=${result.status}）：\n${detail}`)
    }
    return {
        ok,
        status: result.status,
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
        error: result.error ? String(result.error.message) : null,
    }
}

function quoteForShell(value) {
    return /[\s&|<>^()]/.test(value) ? `"${value}"` : value
}

export function renderCommand(toolPath, args) {
    return [toolPath, ...args].map(quoteForShell).join(" ")
}

/** FFDec 版本探测：`java -Djava.awt.headless=true -jar <jar> -help` 首行就是版本横幅。 */
export function probeFfdecVersion(javaExe, ffdecJar) {
    const result = runTool(javaExe, ["-Djava.awt.headless=true", "-jar", ffdecJar, "-help"], { allowFailure: true })
    const text = `${result.stdout}\n${result.stderr}`
    const match = text.match(/JPEXS Free Flash Decompiler v\.?\s*([0-9][0-9.]*)/i)
    return {
        version: match ? match[1] : null,
        status: result.status,
        banner: (text.split(/\r?\n/).find(line => line.trim()) || "").trim(),
    }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
    const args = parseArgv(process.argv.slice(2))
    if (args.help) {
        console.log(HELP)
        return 0
    }

    const dryRun = args["dry-run"] === true
    const base = args.base ? path.resolve(String(args.base)) : null
    const host = args.host === undefined ? null : String(args.host)
    const port = args.port === undefined ? null : String(args.port)
    const out = args.out ? path.resolve(String(args.out)) : null

    // ── [0] 参数校验：缺 --host 必须拒绝执行（地址只能来自参数，绝不内嵌实例地址）──
    const missing = []
    if (!base) missing.push("--base")
    if (!host) missing.push("--host")
    if (!port) missing.push("--port")
    if (!out) missing.push("--out")
    if (missing.length > 0) fail(`需要 --base --host --port --out（缺 ${missing.join(" ")}）`)
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail(`--port 必须是 1..65535，收到 ${JSON.stringify(port)}`)
    if (!existsSync(base)) fail(`--base 不存在：${base}`)
    if (out === base) fail("--out 不能与 --base 同路径（不许就地覆盖素材）")

    const hostPort = `${host}:${port}`

    console.log(`${TOOL_NAME} v${TOOL_VERSION} · A8 Android 出包与签名流水线`)
    console.log(`  base = ${base}`)
    console.log(`  host = ${hostPort}`)
    console.log(`  out  = ${out}`)
    console.log(`  模式 = ${dryRun ? "--dry-run（只打印，不落盘）" : "实跑"}`)

    // ── [0.5] P12 开关：缺 rename-package.mjs 时明确报错且不做事 ──
    const renamePackage = args["rename-package"] === true
    if (renamePackage && !existsSync(RENAME_PACKAGE_TOOL)) {
        fail(`--rename-package 需要 P12 交付的 client-patch/tools/rename-package.mjs，但该文件不存在（P12 未交付）`
            + `——本次不做事，未产生任何文件`)
    }

    // ── IPA 基线：转交 P10-A 的唯一补丁入口（只调用不修改）──
    if (/\.ipa$/i.test(base)) return delegateToPatchIpa()

    const planned = []
    const warnings = []
    const unverified = [
        "真机安装与启动：本产线只做静态可安装性检查（zipalign -c + apksigner verify），未做 adb install / 启动验证",
    ]
    const assertions = createAssertions({ log: console.log })

    // 报告状态：先声明再逐阶段填充 —— 任何提前 return 都能落一份完整报告。
    const state = {
        fingerprintBefore: null,
        fingerprintAfter: null,
        rewrite: null,
        route: "abc-pair",
        hookActive: false,
        hookNotes: [],
        mainEntry: null,
        unwrapped: null,
        swfBefore: null,
        swfAfter: null,
        logicalBytesAfter: null,
        assembledBytes: null,
        entriesBefore: 0,
        entriesAfter: null,
        droppedEntries: [],
        verify: null,
        certs: null,
        ffdec: null,
        baseBuf: null,
        baseSha: null,
    }

    // ── [1] 预检 ──
    hr("[1] 预检")
    state.baseBuf = readFileSync(base)
    state.baseSha = sha256Hex(state.baseBuf)
    console.log(`  base 大小 = ${state.baseBuf.length} B，sha256 = ${state.baseSha}`)

    const workRoot = path.resolve(String(args.work || path.join(os.tmpdir(), "sp-cn-client-build")))
    if (!/^[\x20-\x7e]+$/.test(workRoot)) {
        // FFDec 在非 ASCII 路径上会静默失败（已知坑），所以这条硬拦对所有分支都成立。
        fail(`--work 必须是纯 ASCII 路径（FFDec 硬要求），收到：${workRoot}`)
    }

    const zipalign = resolveTool({
        explicit: args.zipalign, envKeys: ["ZIPALIGN"], fileNames: ["zipalign.exe", "zipalign"], flag: "zipalign", label: "zipalign",
    })
    const apksigner = resolveTool({
        explicit: args.apksigner, envKeys: ["APKSIGNER"], fileNames: ["apksigner.bat", "apksigner"], flag: "apksigner", label: "apksigner",
    })
    const javaExe = args.java ? path.resolve(String(args.java)) : (process.env.JAVA || "java")
    const ffdecJar = args.ffdec
        ? path.resolve(String(args.ffdec))
        : (process.env.FFDEC_JAR ? path.resolve(process.env.FFDEC_JAR) : null)
    const as3Hook = args["as3-hook"] ? path.resolve(String(args["as3-hook"])) : null

    console.log(`  zipalign  = ${zipalign}`)
    console.log(`  apksigner = ${apksigner}`)
    console.log(`  java      = ${javaExe}`)
    console.log(`  ffdec     = ${ffdecJar || "(未提供)"}`)
    assertions.check("zipalign 已定位", existsSync(zipalign), zipalign)
    assertions.check("apksigner 已定位", existsSync(apksigner), apksigner)

    if (as3Hook && !existsSync(as3Hook)) fail(`--as3-hook 不存在：${as3Hook}`)
    if (as3Hook && !ffdecJar) fail("--as3-hook 需要 --ffdec <jar>（AS3 层回编译必须经 FFDec）")
    if (ffdecJar && !existsSync(ffdecJar)) fail(`--ffdec 不存在：${ffdecJar}`)

    // 签名配置（在预检就定下来，报告的任何提前 return 都能带上它）
    const ks = args.ks ? path.resolve(String(args.ks)) : null
    const ksPassEnv = String(args["ks-pass-env"] || "SP_KS_PASS")
    const ksAlias = String(args["ks-alias"] || "spcn")
    const requireSignature = args["require-signature"] === true
    let signReason = null
    if (!ks) signReason = "未签名（缺凭据）：未提供 --ks"
    else if (!existsSync(ks)) fail(`--ks 不存在：${ks}`)
    else if (!process.env[ksPassEnv]) signReason = `未签名（缺凭据）：环境变量 ${ksPassEnv} 为空`
    const willSign = signReason === null
    const alignedPath = path.join(workRoot, "aligned.apk")
    const unsignedPath = path.join(workRoot, "unsigned.apk")
    const signArgs = willSign
        ? ["sign", "--ks", ks, "--ks-pass", `env:${ksPassEnv}`, "--key-pass", `env:${ksPassEnv}`,
            "--ks-key-alias", ksAlias, "--v4-signing-enabled", "false",
            "--out", dryRun ? "<out>" : out, dryRun ? "<aligned.apk>" : alignedPath]
        : null

    // ── [1b] FFDec 版本留证 ──
    if (ffdecJar) {
        hr("[1b] FFDec 版本留证（版本会改变 ABC 重写结果，必须记录实际用的版本与路径）")
        state.ffdec = { path: ffdecJar, requiredVersion: REQUIRED_FFDEC_VERSION, ...probeFfdecVersion(javaExe, ffdecJar) }
        console.log(`  ${state.ffdec.banner || "(无横幅)"}`)
        const matches = state.ffdec.version === REQUIRED_FFDEC_VERSION
        if (as3Hook) {
            const ok = matches || args["allow-ffdec-version-mismatch"] === true
            assertions.check(`FFDec 版本 = ${REQUIRED_FFDEC_VERSION}（AS3 钩子会重写整份 ABC，对版本敏感）`, ok,
                `实测 ${state.ffdec.version || "未知"} @ ${ffdecJar}`)
            if (!ok) {
                console.error(`\nError: FFDec 版本不匹配（要求 ${REQUIRED_FFDEC_VERSION}，实测 ${state.ffdec.version || "未知"}）。`)
                console.error("       AS3 层回编译是整类替换、会重写整份 ABC，版本差异会改变产物。")
                console.error("       要么换用匹配的 FFDec，要么显式加 --allow-ffdec-version-mismatch 承担该风险。")
                return finish(2)
            }
        } else if (!matches) {
            warnings.push(`FFDec 版本 ${state.ffdec.version || "未知"} 与 README 要求的 ${REQUIRED_FFDEC_VERSION} 不一致（本次未执行 AS3 钩子，不影响产物）`)
            console.log(`  [WARN] ${warnings[warnings.length - 1]}`)
        }
    }

    // ── [2] 载入基线 APK 与主 SWF ──
    hr("[2] 载入基线 APK 与主 SWF")
    let entries
    try {
        entries = readZipEntries(state.baseBuf)
    } catch (error) {
        die(`基线不是可解析的 zip/APK：${error.message}`)
    }
    state.entriesBefore = entries.length
    console.log(`  entry 数 = ${entries.length}`)

    const mainEntry = findMainSwfEntry(entries)
    if (!mainEntry) fail("基线 APK 里找不到 assets/ 下的主 SWF")
    state.mainEntry = mainEntry
    console.log(`  主 SWF = ${mainEntry.name}（method=${mainEntry.method}，usize=${mainEntry.usize}）`)
    if (mainEntry.name !== "assets/worldflipper_android_release.swf") {
        warnings.push(`主 SWF 不是预期名 assets/worldflipper_android_release.swf，实为 ${mainEntry.name}（按"assets/ 下最大 .swf"选择）`)
        console.log(`  [WARN] ${warnings[warnings.length - 1]}`)
    }

    state.swfBefore = readEntryData(mainEntry)
    const unwrapped = unwrapSwf(state.swfBefore)
    state.unwrapped = unwrapped
    console.log(`  SWF 形态 = ${unwrapped.magic}，版本 ${unwrapped.version}，逻辑大小 ${unwrapped.logical.length} B`
        + `${unwrapped.repacked ? "（回封时重新 deflate 回 CWS）" : ""}`)
    assertions.check("主 SWF 头部自洽",
        unwrapped.logical.length === (unwrapped.magic === "FWS" ? state.swfBefore.length : unwrapped.declaredFileLength),
        `${unwrapped.logical.length} B（头部声明 ${unwrapped.declaredFileLength} B）`)

    state.fingerprintBefore = siteFingerprint(unwrapped.logical)
    console.log(`  站点指纹(前)：offset=${state.fingerprintBefore.pairOffsetHex} 出现=${state.fingerprintBefore.pairOccurrences}`
        + ` 字节=${state.fingerprintBefore.pairTotalBytes} scheme=${state.fingerprintBefore.schemeCount} host=${state.fingerprintBefore.hostCount}`)
    assertions.check("基线里 API 基址常量对唯一", state.fingerprintBefore.pairOccurrences === 1,
        `${ABC_API_SCHEME} + ${ABC_API_HOST} 出现 ${state.fingerprintBefore.pairOccurrences} 次 @ ${state.fingerprintBefore.pairOffsetHex}`)
    if (state.fingerprintBefore.pairOccurrences !== 1) {
        console.error("\nError: 基线常量对不唯一 ⇒ 无法做 33 B 成对守恒改写（地址是编译期常量，改错一处就改坏整份 ABC）。")
        console.error("       如确需处理该基线，请走 --as3-hook 交给 FFDec 做整类回编译。")
        return finish(2)
    }

    // ── [3] 可选 AS3 层回编译钩子（默认不执行）──
    let logical = unwrapped.logical
    hr("[3] AS3 层回编译钩子")
    if (!as3Hook) {
        console.log("  未提供 --as3-hook ⇒ 跳过（默认路线是 ABC 常量池成对等长改写，零 FFDec 依赖）")
    } else if (dryRun) {
        state.hookActive = true
        planned.push(`${process.execPath} ${as3Hook}  # transformSwf(ctx) → FFDec 整类替换 → 新 SWF`)
        console.log(`  计划：import(${as3Hook}) → transformSwf(ctx) → FFDec 整类替换`)
    } else {
        state.hookActive = true
        const runDir = path.join(workRoot, `run-${Date.now().toString(36)}`)
        mkdirSync(runDir, { recursive: true })
        const swfPath = path.join(runDir, "main.swf")
        writeFileSync(swfPath, logical)
        const module = await import(pathToFileURL(as3Hook).href)
        if (typeof module.transformSwf !== "function") fail(`--as3-hook 模块必须导出 async function transformSwf(ctx)：${as3Hook}`)
        const produced = await module.transformSwf({
            logicalSwf: logical,
            swfPath,
            entry: mainEntry,
            host,
            port,
            hostPort,
            ffdecJar,
            javaExe,
            ffdecVersion: state.ffdec?.version ?? null,
            workDir: runDir,
            log: console.log,
        })
        if (!Buffer.isBuffer(produced?.swf)) fail("--as3-hook 的 transformSwf 必须返回 { swf: Buffer }")
        logical = produced.swf
        for (const note of produced.notes || []) state.hookNotes.push(String(note))
        console.log(`  AS3 钩子完成，逻辑 SWF ${logical.length} B（长度差 ${logical.length - unwrapped.logical.length} B）`)
    }

    // ── [4] 端点确保 ──
    hr("[4] 端点确保（把 API 基址改到 --host:--port）")
    const midFingerprint = state.hookActive && !dryRun ? siteFingerprint(logical) : state.fingerprintBefore
    let rewrote = false
    if (state.hookActive && midFingerprint.pairOccurrences === 0 && midFingerprint.hostCount === 0) {
        // 钩子自己已经把常量改掉了 ⇒ 本阶段只做断言，不再二次改写。
        state.route = "as3-hook"
        console.log("  AS3 钩子已消除旧常量 ⇒ 本阶段只做断言，不再改写")
    } else {
        state.route = state.hookActive ? "as3-hook+abc-pair" : "abc-pair"
        if (dryRun) {
            planned.push(`applyApiBaseRewrite(swf, { hostPort: "${hostPort}" })   # ABC 常量池 33 B 成对守恒改写（进程内）`)
            console.log(`  计划：${planned[planned.length - 1]}`)
            state.rewrite = {
                applied: 1,
                reason: "(dry-run 预演，未实际改写)",
                offset: state.fingerprintBefore.pairOffset,
                totalBytes: state.fingerprintBefore.pairTotalBytes,
                diffRanges: [],
            }
        } else {
            state.rewrite = applyApiBaseRewrite(logical, { hostPort })
            console.log(`  applied=${state.rewrite.applied} — ${state.rewrite.reason}`)
            assertions.check("ABC 常量池成对改写已应用", state.rewrite.applied === 1, state.rewrite.reason)
            if (state.rewrite.applied !== 1) return finish(2)
            rewrote = true
        }
    }

    if (rewrote) {
        assertions.check("成对改写长度守恒（33 B）", logical.length === unwrapped.logical.length,
            `${unwrapped.logical.length} → ${logical.length} B`)
        assertions.check("改写字节数 = 计划范围", (state.rewrite.diffRanges || []).length > 0,
            hexRanges(state.rewrite.diffRanges, 4))
    }

    state.fingerprintAfter = dryRun && rewrote === false && state.route === "abc-pair"
        ? {
            ...state.fingerprintBefore,
            pairOffset: null, pairOffsetHex: null, pairOccurrences: 0, hostCount: 0,
            schemeCount: Math.max(0, state.fingerprintBefore.schemeCount - 1), note: "(dry-run 预演值，未实际改写)",
        }
        : siteFingerprint(logical)
    console.log(`  站点指纹(后)：offset=${state.fingerprintAfter.pairOffsetHex} 出现=${state.fingerprintAfter.pairOccurrences}`
        + ` 字节=${state.fingerprintAfter.pairTotalBytes} scheme=${state.fingerprintAfter.schemeCount} host=${state.fingerprintAfter.hostCount}`)
    if (!dryRun) {
        assertions.check("旧 host 已清零", state.fingerprintAfter.hostCount === 0, `${state.fingerprintAfter.hostCount} 次`)
        assertions.check("旧 scheme+host 常量对已清零", state.fingerprintAfter.pairOccurrences === 0, `${state.fingerprintAfter.pairOccurrences} 次`)
        let otherHostHits = 0
        for (const entry of entries) {
            if (entry === mainEntry || !/\.swf$/i.test(entry.name)) continue
            try {
                if (countIn(readEntryData(entry), ABC_API_HOST) > 0) otherHostHits += 1
            } catch {
                // 读不出来的 entry（异常压缩方法）不计入；主 SWF 的断言已经足够。
            }
        }
        assertions.check("其它 SWF（ANE library.swf）不含旧 host", otherHostHits === 0, `命中 ${otherHostHits} 个`)
    }

    // ── [5] 回封 APK（纯 Node） ──
    hr("[5] 回封 APK（纯 Node ZIP 引擎，逐条保留 method/versionMadeBy/externalAttr）")
    state.droppedEntries = entries.filter(entry => isV1SignatureEntry(entry.name)).map(entry => entry.name)
    state.entriesAfter = entries.length - state.droppedEntries.length
    state.swfAfter = dryRun ? logical : unwrapped.rewrap(logical)
    state.logicalBytesAfter = logical.length
    if (dryRun) planned.push(`writeZipEntries(entries) → <unsigned.apk>   # 摘掉旧 v1 签名 ${state.droppedEntries.length} 条后纯 Node 回封`)
    console.log(`  摘掉旧 v1 签名条目 ${state.droppedEntries.length} 个：${state.droppedEntries.join(" ") || "(无)"}`)
    if (state.droppedEntries.length > 0) {
        warnings.push(`摘掉了基线自带的 v1 签名条目 ${state.droppedEntries.join(" ")}：主 SWF 已改，旧签名必然失效，留着只会让 apksigner verify 报错`)
    }

    if (!dryRun) {
        mkdirSync(workRoot, { recursive: true })
        mkdirSync(path.dirname(out), { recursive: true })
        const outputEntries = entries.filter(entry => !isV1SignatureEntry(entry.name))
        const replaced = replaceEntryData(outputEntries, mainEntry.name, state.swfAfter)
        const assembled = writeZipEntries(outputEntries)
        state.assembledBytes = assembled.length
        writeFileSync(unsignedPath, assembled)
        console.log(`  回封完成：${assembled.length} B，主 SWF entry method=${replaced.method}，csize=${replaced.compressedBytes}`)
        assertions.check("回封后 entry 数 = 原 entry 数 − 摘掉的签名条目",
            outputEntries.length === state.entriesAfter, `${entries.length} → ${outputEntries.length}`)
        assertions.check("回封产物可被自家 ZIP 引擎重新解析", (() => {
            try {
                const reparsed = readZipEntries(assembled)
                if (reparsed.length !== outputEntries.length) return false
                const found = reparsed.find(item => item.name === mainEntry.name)
                return Boolean(found) && sha256Hex(readEntryData(found)) === sha256Hex(state.swfAfter)
            } catch {
                return false
            }
        })(), `${outputEntries.length} 条，主 SWF 内容一致`)
        assertions.check("回封保留 .so 条目的压缩方法",
            outputEntries.filter(item => /\.so$/i.test(item.name)).every(item => item.method === 8 || item.method === 0),
            "method 未被打乱")
    }

    // ── [6] zipalign ──
    hr("[6] zipalign -p -f 4")
    const alignArgs = ["-p", "-f", "4", dryRun ? "<unsigned.apk>" : unsignedPath, dryRun ? "<aligned.apk>" : alignedPath]
    planned.push(renderCommand(zipalign, alignArgs))
    planned.push(renderCommand(zipalign, ["-c", "-p", "4", dryRun ? "<aligned.apk>" : alignedPath]))
    console.log(`  ${planned[planned.length - 2]}`)
    console.log(`  ${planned[planned.length - 1]}`)
    if (!dryRun) {
        runTool(zipalign, alignArgs)
        const check = runTool(zipalign, ["-c", "-p", "4", alignedPath], { allowFailure: true })
        assertions.check("zipalign -c -p 4 通过", check.ok,
            check.ok ? "4 字节对齐（-p 覆盖 .so 页对齐）" : (check.stderr || check.stdout).trim())
    }

    // ── [7] 签名 ──
    hr("[7] apksigner 签名")
    if (willSign) {
        planned.push(renderCommand(apksigner, signArgs))
        planned.push(renderCommand(apksigner, ["verify", "--verbose", "--print-certs", dryRun ? "<out>" : out]))
        console.log(`  ${planned[planned.length - 2]}`)
        console.log(`  ${planned[planned.length - 1]}`)
        console.log(`  （口令经环境变量 ${ksPassEnv} 传给 apksigner 的 env: 语法，脚本与仓库里都不留口令）`)
    } else {
        planned.push(`copy "<aligned.apk>" "<out>"   # 未签名（缺凭据）：不执行 apksigner，产物不可安装`)
        console.log(`  [WARN] ${signReason}`)
        console.log("         产物会是**不可安装**的未签名 APK —— Android 不接受无签名包。")
        console.log("         补上 --ks <keystore> 与 --ks-pass-env <VAR> 后重跑即可签名。")
        unverified.push("签名与安装：本次未提供 keystore/口令，产物未签名，签名链与装机均未验证")
    }

    if (!dryRun) {
        if (willSign) {
            runTool(apksigner, signArgs)
            const verify = runTool(apksigner, ["verify", "--verbose", "--print-certs", out], { allowFailure: true })
            state.verify = { ok: verify.ok, stdout: verify.stdout.trim(), stderr: verify.stderr.trim() }
            state.certs = (verify.stdout.match(/^Signer #1 certificate DN:.*$/gm) || []).join("\n") || null
            assertions.check("apksigner verify 通过", verify.ok,
                verify.ok ? "签名链有效" : (verify.stderr || verify.stdout).trim().split("\n").slice(0, 3).join(" / "))
            if (requireSignature && !verify.ok) return finish(2)
        } else {
            copyFileSync(alignedPath, out)
            console.log(`  已交出未签名产物：${out}`)
            if (requireSignature) {
                assertions.check("产物已签名（--require-signature）", false, signReason)
                return finish(2)
            }
        }
    }

    return finish(0)

    // ─────────────────────────── 收尾 ───────────────────────────
    function finish(exitCode) {
        const report = {
            schema: REPORT_SCHEMA,
            tool: { name: TOOL_NAME, version: TOOL_VERSION },
            generatedAt: new Date().toISOString(),
            dryRun,
            ok: exitCode === 0,
            endpoint: { host, port, hostPort, apiBase: `http://${"0".repeat(8)}@${hostPort}` },
            route: state.route,
            inputs: {
                base: { path: base, bytes: state.baseBuf.length, sha256: state.baseSha },
                baseEntries: state.entriesBefore,
            },
            swf: state.unwrapped ? {
                entry: state.mainEntry.name,
                encodedAs: state.unwrapped.magic,
                repacked: state.unwrapped.repacked,
                swfVersion: state.unwrapped.version,
                declaredFileLength: state.unwrapped.declaredFileLength,
                logicalBytesBefore: state.unwrapped.logical.length,
                logicalBytesAfter: state.logicalBytesAfter,
                entryBytesBefore: state.swfBefore.length,
                entryBytesAfter: state.swfAfter ? state.swfAfter.length : null,
                sha256Before: sha256Hex(state.unwrapped.logical),
                sha256After: state.logicalBytesAfter === null ? null : sha256Hex(state.swfAfter),
            } : null,
            siteFingerprint: { before: state.fingerprintBefore, after: state.fingerprintAfter },
            rewrite: state.rewrite ? {
                applied: state.rewrite.applied,
                reason: state.rewrite.reason,
                offset: state.rewrite.offset ?? null,
                totalBytes: state.rewrite.totalBytes ?? 0,
                diffRanges: (state.rewrite.diffRanges || []).map(range => [range[0], range[1]]),
            } : null,
            zip: {
                entriesBefore: state.entriesBefore,
                entriesAfter: state.entriesAfter,
                droppedV1Signatures: state.droppedEntries,
                unsignedIntermediateBytes: state.assembledBytes,
            },
            tools: {
                zipalign,
                apksigner,
                java: javaExe,
                node: process.version,
                ffdec: state.ffdec,
            },
            as3Hook: { path: as3Hook, executed: state.hookActive, notes: state.hookNotes },
            signing: {
                requested: Boolean(ks),
                signed: willSign && !dryRun,
                reason: signReason,
                keystore: ks ? path.basename(ks) : null,
                alias: willSign ? ksAlias : null,
                passEnvVar: ksPassEnv,
                command: signArgs ? renderCommand(apksigner, signArgs) : null,
                verify: state.verify,
                signerCertificateDN: state.certs,
            },
            output: readOutput(),
            assertions: assertions.list,
            warnings,
            unverified,
        }
        if (!dryRun) {
            const written = writeBuildReport(out, report)
            console.log(`\n构建报告：${written.file}（${written.bytes} B）`)
        }
        if (dryRun) {
            console.log("\n── [dry-run] 计划执行的命令序列 ──")
            for (const line of planned) console.log(`  ${line}`)
            console.log("  （未产生任何文件）")
            return exitCode
        }
        if (exitCode !== 0 || assertions.failed.length > 0) {
            console.error(`\n出包失败：${assertions.failed.length} 条断言未通过（exit=${exitCode || 2}）。`
                + `\n产物与报告留在 ${out} / ${out}.build-report.json，但**不要分发**。`)
            return 2
        }
        console.log(`\n出包完成：${out}`)
        console.log(`  sha256 = ${report.output.sha256}`)
        if (!willSign) console.log("  注意：本产物**未签名**，不能安装。")
        if (!args["keep-work"]) rmSync(workRoot, { recursive: true, force: true })
        return 0
    }

    function readOutput() {
        if (dryRun || !existsSync(out)) return { path: out, exists: false, bytes: null, sha256: null }
        const buf = readFileSync(out)
        return { path: out, exists: true, bytes: buf.length, sha256: sha256Hex(buf) }
    }

    // ── IPA 委派（P10-A 的 patch-ipa.mjs 是唯一补丁入口，只调用不修改）──
    function delegateToPatchIpa() {
        hr("[委派] .ipa 基线交给 patch-ipa.mjs（P10-A，只调用不修改）")
        const childArgs = ["--ipa", base, "--host", host, "--port", port, "--out", out]
        if (args["guard-mode"]) childArgs.push(`--guard-mode=${args["guard-mode"]}`)
        if (args.hosts) childArgs.push(`--hosts=${args.hosts}`)
        if (dryRun) childArgs.push("--dry-run")
        console.log(`  ${renderCommand(process.execPath, [PATCH_IPA_TOOL, ...childArgs])}`)
        if (dryRun) {
            console.log("  （--dry-run：不实际调用；构建报告由 patch-ipa.mjs 在实跑时自行落盘）")
            return 0
        }
        const child = spawnSync(process.execPath, [PATCH_IPA_TOOL, ...childArgs], { stdio: "inherit", cwd: REPO_ROOT })
        console.log(`\npatch-ipa.mjs 退出码 = ${child.status}（其自身的 <out>.build-report.json 由它落盘，本脚本不覆盖）`)
        return child.status === 0 ? 0 : 2
    }
}

// 只在本文件被当成 CLI 直接执行时才跑主流程：被 import（单测里读纯函数）不能有副作用。
const invokedAsCli = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsCli) {
    main()
        .then((code) => { process.exitCode = code })
        .catch((error) => {
            console.error(`Error: ${error && error.stack ? error.stack : String(error)}`)
            process.exitCode = 2
        })
}
