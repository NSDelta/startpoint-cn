#!/usr/bin/env node
// B0/W2 —— 出「能连到我们服务器」的 iOS 包。
//
// ⚠️ 本文件是 B0 期间的**临时派生件**，基线选错了：正式基线是**同目录的 `patch-ipa.mjs`**
//    （服主提供的服务端打包脚本，真机验证过的功能补丁 + guard 处理都在里面）。
//    本文件**待重做基线**：以下内容可整段移植到 `patch-ipa.mjs` 上，其余一律以基线为准 ——
//      · lib/ios-abc.mjs —— 游戏 API 基址的 ABC 常量池等长改写（`https`+域名 一对 → 和守恒 33 B）；
//      · lib/zip-ipa.mjs —— 零依赖 ZIP 重写引擎，替换基线的 `jar uf0`（后者会让 AltStore 报
//        "The app is in an invalid format."）；
//      · lib/ios-guard.mjs + build-report + 回读断言（基线只有打印，没有断言）。
//    基线的 `patchBlock`(sohu 屏蔽) / `patchFirstLoginTip` / `patchLoginDialog` / `patchWelcomeBanner` /
//    `patchAgreementDialogs` / `patchBundleIdCheck` 本文件**没有**，重基线时必须保留。
//
// 做什么：读官方 IPA → 解出 `Payload/<App>.app/<App>` 主二进制 → 就地把客户端里的服务端基址
// 原地等长改写为 `http://<HOST>:<PORT>`（含游戏 API 服务端基址的 ABC 常量池那一对条目）→
// 清除启动 guard → 用自带零依赖 ZIP 引擎**保留全部条目属性**写回 → **回读产出 IPA** 做断言
// → 打印并落盘 `<out>.build-report.json`。
//
// 不做什么（红线，见任务单 §6）：
// - 不缩短/搬移任何字符串（容器长度前缀错位 = 启动黑屏）⇒ 只等长覆盖，长度不够就跳过并记录；
// - 不复制第三方服务器产物里的任何常量（改写目标只来自 --host/--port）；
// - 不改客户端业务代码 / 不改服务端契约；产出只允许落在 --out（约定 out/，已被 .gitignore 忽略）。
//
// 为什么不用 `jar uf0`：实测它会把主二进制写成 STORED + madeBy=0x000a(FAT) + externalAttr=0，
// 丢掉 Unix 可执行位（0o100755 → 0o0），AltStore/AltServer 会拒绝安装
// （"The app is in an invalid format."）。本工具改用 lib/zip-ipa.mjs 逐条保留属性的重写引擎。
//
// 用法:
//   node client-patch/build/patch-ios-ipa.mjs \
//     --ipa apkipa/iOS-1.8.4.ipa --host <LAN_IP> --port 8001 \
//     --guard-mode launch --out out/sp-cn-ios-lan.ipa
//
// 参数:
//   --ipa <path>        输入 IPA（默认 apkipa/iOS-1.8.4.ipa）
//   --host <ip|host>    目标服务器地址（必填；不内置默认值，避免把实例值固化进仓库）
//   --port <port>       目标服务器端口（默认 8001）
//   --guard-mode <m>    launch（默认，仅 NOP 0xb00c）| none
//   --out <path>        产出 IPA（默认 out/ios-<host>-<port>.ipa）⇒ 同时产出 <out>.build-report.json
//   --app <Name>        手动指定 app 名（默认从 IPA 里自动探测唯一 .app 目录）
//   --mode <m>          auto（默认）| url（官方域名站点）| bare（裸 IP:port 字面量）
//   --from <ip:port>    premise 复核字样 + bare 模式的待替换端点（默认 8.133.209.122:7001）
//   --allow-host <list> 只改这些域名（逗号分隔；默认全部 leiting/roguelike/cl2009 站点）
//   --no-api-base       不改 ABC 池里的游戏 API 服务端基址（只改 URL 站点）
//   --dry-run           只做检测与断言计算，不写任何产出
//   --keep-work         保留临时工作目录（排错用）

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import {
    ENDPOINT_LENGTH,
    OFFICIAL_SITE_REWRITEABLE,
    OFFICIAL_SITE_TOO_SHORT,
    OFFICIAL_SITE_TOTAL,
    PREMISE_ENDPOINT,
    applyRewrite,
    countOccurrences,
    countRewriteableUrlSites,
    diffRanges,
    mergeRanges,
    plannedRanges,
    rangesEqual,
    scanTargets,
} from "./lib/ios-endpoint.mjs"
import { ABC_API_HOST, ABC_API_PAIR_OFFSET, ABC_API_SCHEME, applyApiBaseRewrite } from "./lib/ios-abc.mjs"
import { LAUNCH_GUARD_OFFSET, clearLaunchGuard, countAbortStores } from "./lib/ios-guard.mjs"
import { madeByHost, readEntryData, readZipEntries, replaceEntryData, unixMode, writeZipEntries } from "./lib/zip-ipa.mjs"

const DEFAULT_IPA = "apkipa/iOS-1.8.4.ipa"
const DEFAULT_PORT = "8001"
const NOP = 0xd503201f

function parseArgs(argv) {
    const out = {}
    const assign = (key, value) => {
        out[key] = out[key] === undefined ? value : (Array.isArray(out[key]) ? [...out[key], value] : [out[key], value])
    }
    for (let index = 0; index < argv.length; index += 1) {
        const raw = argv[index]
        const inline = raw.match(/^--([^=]+)=(.*)$/)
        if (inline) {
            assign(inline[1], inline[2])
            continue
        }
        const key = raw.replace(/^--/, "")
        const next = argv[index + 1]
        if (next !== undefined && !next.startsWith("--")) {
            assign(key, next)
            index += 1
        } else {
            assign(key, true)
        }
    }
    return out
}

const args = parseArgs(process.argv.slice(2))
const dryRun = args["dry-run"] === true || args["dry-run"] === "true"
const keepWork = args["keep-work"] === true || args["keep-work"] === "true"
const withApiBase = !(args["no-api-base"] === true || args["no-api-base"] === "true")

function fail(message) {
    console.error(`ERROR ${message}`)
    process.exit(1)
}

const ipaPath = path.resolve(String(args.ipa ?? DEFAULT_IPA))
const host = args.host ? String(args.host) : ""
const port = String(args.port ?? DEFAULT_PORT)
const guardMode = String(args["guard-mode"] ?? "launch")
const fromEndpoint = String(args.from ?? PREMISE_ENDPOINT)
const modeArg = String(args.mode ?? "auto")
const allowHosts = args["allow-host"] ? String(args["allow-host"]).split(",").map(s => s.trim()).filter(Boolean) : []

if (!existsSync(ipaPath)) fail(`找不到输入 IPA：${ipaPath}`)
if (!host) fail("必须显式给 --host（本工具不内置任何服务器地址）")
if (!/^[A-Za-z0-9.-]+$/.test(host)) fail(`--host 只接受主机名或 IPv4 字面量：${host}`)
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) fail(`--port 非法：${port}`)
if (!["auto", "url", "bare"].includes(modeArg)) fail(`--mode 只能是 auto|url|bare：${modeArg}`)
if (!["launch", "none"].includes(guardMode)) fail(`--guard-mode 只能是 launch|none：${guardMode}`)

const hostPort = `${host}:${port}`
const targetAuthority = `http://${hostPort}`
const outPath = path.resolve(String(args.out ?? path.join("out", `ios-${host}-${port}.ipa`)))
const reportPath = `${outPath}.build-report.json`

const assertions = []
function assert(name, ok, detail) {
    assertions.push({ name, ok: Boolean(ok), detail })
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} —— ${detail}`)
    return Boolean(ok)
}

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex")
}

/** 从 zip entry 列表里确定主二进制（Payload/<X>.app/<X>）。 */
function detectBinaryEntry(entries) {
    const names = entries.map(entry => entry.name)
    if (args.app) {
        const wanted = `Payload/${String(args.app)}.app/${String(args.app)}`
        if (!names.includes(wanted)) fail(`IPA 里没有 ${wanted}`)
        return wanted
    }
    const candidates = names.filter(entry => /^Payload\/[^/]+\.app\/[^/]+$/.test(entry))
        .filter(entry => {
            const [bundle, binary] = entry.replace(/^Payload\//, "").split("/")
            return binary === bundle.replace(/\.app$/, "")
        })
    if (candidates.length !== 1) {
        fail(`无法自动确定主二进制（候选 ${candidates.length} 个：${candidates.slice(0, 5).join(", ")}）—— 用 --app <Name> 指定`)
    }
    return candidates[0]
}

function entryMeta(entry) {
    return {
        name: entry.name,
        method: entry.method,
        versionMadeBy: hex(entry.versionMadeBy),
        host: madeByHost(entry),
        externalAttr: `0x${entry.externalAttr.toString(16)}`,
        unixMode: `0o${unixMode(entry).toString(8)}`,
        size: entry.usize,
        compressedSize: entry.csize,
    }
}

const hex = value => `0x${value.toString(16)}`
const formatRanges = ranges => ranges.map(([start, end]) => `${hex(start)}..${hex(end)}`).join(", ")

// ————————————————————————————————— 主流程 —————————————————————————————————

const startedAt = new Date()
console.log("B0/W2 iOS IPA 服务端基址改写")
console.log(`  输入 IPA : ${ipaPath} (${statSync(ipaPath).size} B)`)
console.log(`  目标端点 : ${targetAuthority}  (authority ${hostPort.length} 字符)`)
console.log(`  模式     : guard-mode=${guardMode} / target-mode=${modeArg}${withApiBase ? " / api-base=on" : " / api-base=off"}${dryRun ? " / dry-run" : ""}`)
if (!dryRun) console.log(`  产出     : ${outPath}`)

const inputBytes = readFileSync(ipaPath)
const inputEntries = readZipEntries(inputBytes)
const binaryEntry = detectBinaryEntry(inputEntries)
const binaryEntryInput = inputEntries.find(entry => entry.name === binaryEntry)
const original = readEntryData(binaryEntryInput)
const working = Buffer.from(original)
const fileEntryCount = inputEntries.length

try {
    console.log(`  主二进制 : ${binaryEntry}`)
    console.log(`  zip      : ${fileEntryCount} 条 entry；主二进制 ${entryMeta(binaryEntryInput).unixMode} host=${entryMeta(binaryEntryInput).host} method=${binaryEntryInput.method}`)

    // —— premise 复核：任务单称官方包里 `8.133.209.122:7001` 有 137 处 ——
    const premiseCount = countOccurrences(working, fromEndpoint)
    const scan = scanTargets(working, { fromEndpoint })
    const urlSites = scan.sites.filter(site => site.kind === "url")
    const bareSites = scan.sites.filter(site => site.kind === "bare-endpoint")
    const minLen = `http://${hostPort}`.length
    const rewriteableUrlSites = urlSites.filter(site => site.length >= minLen)
    const tooShortUrlSites = urlSites.filter(site => site.length < minLen)

    const mode = modeArg === "auto" ? (bareSites.length > 0 ? "bare" : "url") : modeArg
    const targets = mode === "bare"
        ? bareSites
        : (allowHosts.length ? rewriteableUrlSites.filter(site => allowHosts.some(h => site.host.includes(h))) : rewriteableUrlSites)

    console.log(`  premise  : 输入包内 ${fromEndpoint} = ${premiseCount} 处`)
    console.log(`  站点扫描 : 域名 URL ${urlSites.length} 处（可改写 ${rewriteableUrlSites.length} / 过短跳过 ${tooShortUrlSites.length}）、裸端点 ${bareSites.length} 处 ⇒ mode=${mode}，本次目标 ${targets.length} 处`)

    // 断言 ① 补丁前目标计数
    const expectedPre = mode === "bare" ? OFFICIAL_SITE_REWRITEABLE : (allowHosts.length ? targets.length : OFFICIAL_SITE_REWRITEABLE)
    assert(
        mode === "bare"
            ? `${fromEndpoint} 计数 = ${OFFICIAL_SITE_REWRITEABLE}`
            : `可改写 URL 站点计数 = ${OFFICIAL_SITE_REWRITEABLE}`,
        targets.length === expectedPre,
        mode === "bare"
            ? `实测 ${targets.length} 处`
            : `实测 ${targets.length} 处（总站点 ${urlSites.length}：可改写 ${rewriteableUrlSites.length} + 过短 ${tooShortUrlSites.length} = ${OFFICIAL_SITE_TOTAL}）`,
    )

    // 断言 ② 目标 authority 长度 = 18（等长红线；bare 模式靠它保证 18→18）
    const authorityLength = Buffer.byteLength(hostPort, "latin1")
    assert(`目标 authority 长度 = ${ENDPOINT_LENGTH}`, authorityLength === ENDPOINT_LENGTH, `实测 ${authorityLength} 字符（${hostPort}）`)

    if (targets.length !== expectedPre) fail(`目标计数不符（期望 ${expectedPre}，实测 ${targets.length}）—— 拒绝继续`)
    if (authorityLength !== ENDPOINT_LENGTH) fail(`目标 authority 不是 ${ENDPOINT_LENGTH} 字符 —— 等长红线，拒绝继续`)

    // —— 改写 URL 站点（等长） ——
    const rewrite = applyRewrite(working, { sites: targets, hostPort })
    const planned = plannedRanges(rewrite.changed)
    console.log(`  改写     : ${rewrite.changed.length} 处 URL 站点（等长覆盖）`)
    if (rewrite.skipped.length) console.log(`  跳过     : ${rewrite.skipped.length} 处 —— ${rewrite.skipped.slice(0, 3).join(" | ")}${rewrite.skipped.length > 3 ? " | …" : ""}`)

    // —— 改写游戏 API 服务端基址（ABC 常量池 scheme/host 对，成对长度守恒） ——
    const apiBase = withApiBase
        ? applyApiBaseRewrite(working, { hostPort })
        : { applied: 0, reason: "--no-api-base", offset: null, totalBytes: 0 }
    const apiRanges = apiBase.applied && apiBase.diffRanges ? apiBase.diffRanges : []
    console.log(`  API 基址 : ${apiBase.applied ? `已改写 @ ${hex(apiBase.offset)} —— ${apiBase.newBytes}` : apiBase.reason}`)

    // —— guard ——
    const guard = clearLaunchGuard(working, guardMode)
    const guardApplied = guard.applied === 1
    const guardRanges = guardApplied ? [[LAUNCH_GUARD_OFFSET, LAUNCH_GUARD_OFFSET + 4]] : []
    if (!guardApplied && guardMode === "launch") console.log(`  [!] guard: ${guard.reason}`)

    // —— 差异必须恰好等于计划范围（不允许任何"顺手"改动） ——
    const allPlanned = mergeRanges([...planned, ...apiRanges, ...guardRanges])
    const actualDiff = diffRanges(original, working)
    assert("改动字节范围 = 计划范围（无越界写入）", rangesEqual(allPlanned, actualDiff), `${actualDiff.length} 段，共 ${actualDiff.reduce((sum, [s, e]) => sum + (e - s), 0)} 字节`)

    // —— 断言 ③ 补丁后回读 ——
    const residue = mode === "url" && !allowHosts.length
        ? countRewriteableUrlSites(working, { hostPort })
        : countRewriteableUrlSites(working, { hostPort })
    const postOld = countOccurrences(working, fromEndpoint)
    const postNew = countOccurrences(working, hostPort)
    const expectedNew = rewrite.changed.length + apiBase.applied
    assert(
        `补丁后：可改写旧站点 = 0 处、新端点 = ${rewrite.changed.length} 处`,
        residue === 0 && postNew === expectedNew,
        `残留旧站点 ${residue} 处；新端点 ${postNew} 处（URL 站点 ${rewrite.changed.length}${apiBase.applied ? ` + ABC 池 ${apiBase.applied}` : ""}）；${fromEndpoint} 残留 ${postOld} 处`,
    )

    // —— 断言 ④ guard NOP 只命中 0xb00c 一处 ——
    if (guardMode === "launch") {
        assert(`guard-mode=launch 的 NOP 只命中 ${hex(LAUNCH_GUARD_OFFSET)} 一处`, guardApplied, `${guard.reason}`)
    }

    // —— ABC 池成对字节数守恒 ——
    if (withApiBase) {
        assert("ABC 池 scheme/host 对成对长度守恒", apiBase.applied === 1, `${apiBase.reason}`)
    }

    const remainingAborts = countAbortStores(working)
    console.log(`  未处理的致命中止点（仅计数，未改动）: ${remainingAborts}`)

    const report = {
        task: "B0/W2 iOS IPA 服务端基址改写",
        generatedAt: startedAt.toISOString(),
        tool: "client-patch/build/patch-ios-ipa.mjs",
        input: { ipa: ipaPath, bytes: inputBytes.length, sha256: sha256(inputBytes), entries: fileEntryCount },
        premise: {
            claim: "任务单：官方 iOS Mach-O 里 8.133.209.122:7001 出现 137 处，恰好 18 字符",
            checked: fromEndpoint,
            occurrencesInInput: premiseCount,
            verdict: premiseCount > 0 ? "输入包确实是已打过补丁的产物（bare 模式）" : "官方包内不存在该字面量；137 处属于第三方已打过补丁的产物",
            officialSiteStats: {
                urlSites: urlSites.length,
                rewriteable: rewriteableUrlSites.length,
                tooShortSkipped: tooShortUrlSites.length,
                lengthHistogram: scan.lengthHistogram,
            },
        },
        output: dryRun ? null : { ipa: outPath, report: reportPath },
        binary: { entry: binaryEntry, bytes: original.length, sha256Before: sha256(original), sha256After: sha256(working) },
        endpoint: {
            mode,
            from: mode === "bare" ? fromEndpoint : null,
            fromPattern: mode === "url" ? "https?://<leiting|roguelike|cl2009 域名>" : fromEndpoint,
            to: host,
            port,
            toAuthority: targetAuthority,
            authorityLength,
            expectedLength: ENDPOINT_LENGTH,
        },
        counts: {
            premiseOccurrences: premiseCount,
            urlSites: urlSites.length,
            urlSitesRewriteable: rewriteableUrlSites.length,
            urlSitesTooShort: tooShortUrlSites.length,
            rewritten: rewrite.changed.length,
            skipped: rewrite.skipped.length,
            residueRewriteable: residue,
            postOldOccurrences: postOld,
            postEndpointOccurrences: postNew,
        },
        apiBase: {
            enabled: withApiBase,
            applied: apiBase.applied,
            schemeHost: `${ABC_API_SCHEME} + ${ABC_API_HOST}`,
            expectedOffset: hex(ABC_API_PAIR_OFFSET),
            offset: apiBase.offset === null ? null : hex(apiBase.offset),
            totalBytes: apiBase.totalBytes,
            newBytes: apiBase.newBytes ?? null,
            apiBaseUrl: apiBase.apiBase ?? null,
            reason: apiBase.reason,
        },
        guard: { mode: guardMode, offset: guard.offset === null ? null : hex(guard.offset), applied: guard.applied, reason: guard.reason, unhandledAbortStores: remainingAborts },
        changedRanges: actualDiff.map(([start, end]) => `${hex(start)}..${hex(end)}`),
        changedBytes: actualDiff.reduce((sum, [s, e]) => sum + (e - s), 0),
        skippedSites: rewrite.skipped,
        assertions,
        ok: false,
    }

    if (!dryRun) {
        mkdirSync(path.dirname(outPath), { recursive: true })
        // 用自带 ZIP 引擎重写：逐条保留原始属性，只把主二进制换成补丁后的内容（沿用其原压缩方法）
        const replaced = replaceEntryData(inputEntries, binaryEntry, working)
        writeFileSync(outPath, writeZipEntries(inputEntries))

        // 回读产出 IPA：验证"落盘的东西"而不是内存里的东西
        const verifyEntries = readZipEntries(readFileSync(outPath))
        const verifyEntry = verifyEntries.find(entry => entry.name === binaryEntry)
        const verifyBuffer = readEntryData(verifyEntry)
        const verifyResidue = countRewriteableUrlSites(verifyBuffer, { hostPort })
        const verifyOld = countOccurrences(verifyBuffer, fromEndpoint)
        const verifyNew = countOccurrences(verifyBuffer, hostPort)
        assert(`回读产出 IPA：可改写旧站点 = 0 处`, verifyResidue === 0, `实测 ${verifyResidue} 处`)
        assert(`回读产出 IPA：新端点 = ${expectedNew} 处`, verifyNew === expectedNew, `实测 ${verifyNew} 处`)
        assert("回读产出 IPA：二进制长度未变", verifyBuffer.length === original.length, `${original.length} B -> ${verifyBuffer.length} B`)
        assert("回读产出 IPA：guard NOP 已落盘", guardMode !== "launch" || verifyBuffer.readUInt32LE(LAUNCH_GUARD_OFFSET) === NOP, `${hex(LAUNCH_GUARD_OFFSET)} = ${hex(verifyBuffer.readUInt32LE(LAUNCH_GUARD_OFFSET))}`)
        assert("回读产出 IPA：二进制与内存补丁结果逐字节一致", sha256(verifyBuffer) === sha256(working), `sha256 ${sha256(verifyBuffer).slice(0, 16)}…`)
        assert(
            "回读产出 IPA：entry 数与主二进制属性保持不变",
            verifyEntries.length === fileEntryCount
            && verifyEntry.versionMadeBy === binaryEntryInput.versionMadeBy
            && verifyEntry.externalAttr === binaryEntryInput.externalAttr
            && verifyEntry.method === binaryEntryInput.method,
            `${verifyEntries.length}/${fileEntryCount} 条；主二进制 method=${verifyEntry.method} madeBy=${hex(verifyEntry.versionMadeBy)} host=${madeByHost(verifyEntry)} externalAttr=0x${verifyEntry.externalAttr.toString(16)} unixMode=0o${unixMode(verifyEntry).toString(8)}`,
        )
        if (withApiBase && apiBase.applied) {
            const verifyApi = verifyBuffer.slice(apiBase.offset, apiBase.offset + apiBase.totalBytes).toString("latin1")
            assert("回读产出 IPA：ABC 池 API 基址已改写", verifyApi === apiBase.newBytes, JSON.stringify(verifyApi))
        }
        report.verify = {
            binarySha256: sha256(verifyBuffer),
            residueRewriteable: verifyResidue,
            oldOccurrences: verifyOld,
            endpointOccurrences: verifyNew,
            bytes: verifyBuffer.length,
            entries: verifyEntries.length,
            binaryEntry: entryMeta(verifyEntry),
        }
        report.ipa = {
            entries: fileEntryCount,
            binaryEntryIn: entryMeta(binaryEntryInput),
            binaryEntryOut: entryMeta(verifyEntry),
            binaryMethod: replaced.method,
            binaryCompressedBytes: replaced.compressedBytes,
            inputBytes: inputBytes.length,
        }
        report.output.bytes = statSync(outPath).size
        console.log(`  产出包   : ${outPath} (${report.output.bytes} B)`)
    } else {
        console.log("  dry-run：未写任何产出")
    }

    report.ok = assertions.every(entry => entry.ok)
    if (!dryRun) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`  构建报告 : ${dryRun ? "(dry-run 不写)" : reportPath}`)
    console.log(report.ok ? "DONE  全部断言通过" : "FAIL  存在未通过断言")
    if (!report.ok) process.exitCode = 2
} finally {
    if (keepWork) console.log("  --keep-work：本工具不再使用临时工作目录")
}
