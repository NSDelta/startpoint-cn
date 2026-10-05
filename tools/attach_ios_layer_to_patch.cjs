#!/usr/bin/env node
"use strict"

/*
 * 给已装好的补丁包补一条 iOS 层（`archive-ios-diff/<inner>.zip` + manifest 里 `layer:"ios"` 的条目）。
 *
 * 用途：安卓的 diff 层本来就是 22 B 空壳，iOS 侧同样是空壳占位，两边形状一致。此前 iOS 空壳
 * 只落在基线目录 `<CDN_DIR>/cn/archive-ios-diff/`，现在一并放进补丁包
 * `<CDN_DIR>/patches/<版本>/archive-ios-diff/`，让 iOS 也能从 patches 里下到这条边的 diff。
 *
 * 语义保证（详见 src/content/cdn/{patch-manifest,patch-overlay,ios-compat}.ts）：
 *   - manifest 是**唯一的 layer 白名单**：只认 common/medium/android/ios；不放进 manifest 的
 *     文件既不会报错也不会被下发（`readPackage` 只忽略版本目录根部的散落文件）。
 *   - `ios` 层不进 Android Catalog（`scanPatchOverlay` 把它记进 ignoredPaths），
 *     只由 iOS 平台视图（`findIosPatchArchives`）拾取 —— 与 `archive-android-diff` 互不串味。
 *   - `bytes`/`sha256` 由**磁盘上的真实文件**反填，绝不信手写：iOS 归档不在 Overlay 扫描范围内，
 *     启动期的 SHA-256 校验不会覆盖它，所以清单必须与字节严格一致。
 *   - `relativePath` 的 inner 名字必须带版本边，且 toVersion == 包目录名（目标版本）；
 *     否则 `readPackageIosArchives` 会静默跳过（这是 iOS 视图侧的二次过滤，不是报错）。
 *
 * 用法：
 *   node tools/attach_ios_layer_to_patch.cjs --patches <patches 根> [--dry-run]
 *   node tools/attach_ios_layer_to_patch.cjs --patches <patches 根> --stubs <空壳目录>
 *
 * 缺空壳时按 `tools/make_ios_stub_archives.cjs` 的同一形状现造（111 B 单条目 ZIP），
 * 因此幂等：重复运行得到的字节与 sha256 完全一致。
 */

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const { buildStubArchive, innerZipName } = require("./make_ios_stub_archives.cjs")

const IOS_DIFF_DIRECTORY = "archive-ios-diff"
const PATCH_MANIFEST_FILE_NAME = "patch-manifest.json"
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const STUB_TOKEN_LENGTH = 8
const VALID_LAYERS = ["common", "medium", "android", "ios"]

/** 与生成器同源：每条边一个确定性 MS-DOS 时间戳 ⇒ 确定性字节 ⇒ 确定性 sha256 / token。 */
function stubDateForEdge(fromVersion, toVersion) {
    const [fromMajor, fromMinor, fromPatch] = fromVersion.split(".").map(Number)
    const [toMajor, toMinor, toPatch] = toVersion.split(".").map(Number)
    const days = Date.UTC(2020, 0, 1) / 86400000
        + fromMajor * 4096 + fromMinor * 256 + fromPatch * 16
        + toMajor * 8 + toMinor * 2 + toPatch
    const seconds = (
        (fromMajor % 24) * 3600 + (fromMinor % 60) * 60 + (fromPatch % 60)
        + (toMajor + toMinor + toPatch) * 2
    ) % 86400
    return new Date(days * 86400000 + seconds * 1000)
}

function sha256Of(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * inner ZIP 名字 → 版本边 + 分卷序号。与 `src/content/cdn/patch-manifest.ts` 的
 * `parsePatchArchiveName` 同一套口径（三段版本不许前导零）；序号 `index` 是
 * **服务端去重用的槽位**（`archiveSlotKey` = `<from>-<to>-<index>`），不是清单里的 `order`。
 */
function parseInnerZipName(fileName) {
    const match = /^(?:pinball|asset)-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-(\d+)-[a-fA-F0-9]+\.zip$/.exec(fileName)
    if (match === null) return null
    return { fromVersion: match[1], toVersion: match[2], index: Number(match[3]) }
}

/** 现造空壳（与生成器同形状），返回 { fileName, bytes }。 */
function makeStub(fromVersion, toVersion) {
    const bytes = buildStubArchive(stubDateForEdge(fromVersion, toVersion))
    const token = sha256Of(bytes).slice(0, STUB_TOKEN_LENGTH)
    return { fileName: innerZipName(fromVersion, toVersion, token), bytes }
}

function attachPackage(options, packageDirectory) {
    const packageRoot = path.join(options.patchesRoot, packageDirectory)
    const manifestPath = path.join(packageRoot, PATCH_MANIFEST_FILE_NAME)
    const report = { package: packageDirectory, action: "skipped", reason: null, entry: null }

    if (!VERSION_PATTERN.test(packageDirectory)) {
        report.reason = "目录名不是三段版本号"
        return report
    }
    let manifest
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    } catch (error) {
        report.reason = `读不到 ${PATCH_MANIFEST_FILE_NAME}: ${error.message}`
        return report
    }
    if (manifest.targetVersion !== packageDirectory) {
        report.reason = `manifest.targetVersion(${manifest.targetVersion}) 与目录名不一致`
        return report
    }
    if (!Array.isArray(manifest.archives)) {
        report.reason = "manifest.archives 不是数组"
        return report
    }
    for (const archive of manifest.archives) {
        if (!VALID_LAYERS.includes(archive.layer)) {
            report.reason = `已存在未知层 ${archive.layer}`
            return report
        }
    }

    const baseVersion = manifest.baseVersion
    let iosEntry = manifest.archives.find(archive => archive.layer === "ios")
    let fileName
    if (iosEntry !== undefined) {
        fileName = path.posix.basename(iosEntry.relativePath)
    } else {
        if (typeof baseVersion !== "string" || !VERSION_PATTERN.test(baseVersion)) {
            report.reason = "manifest 没有可用的 baseVersion，无法推导版本边"
            return report
        }
        if (options.stubsDirectory !== null) {
            const candidate = fs.readdirSync(options.stubsDirectory)
                .filter(name => name.toLowerCase().endsWith(".zip"))
                .find(name => {
                    const parsed = parseInnerZipName(name)
                    return parsed !== null
                        && parsed.fromVersion === baseVersion
                        && parsed.toVersion === packageDirectory
                })
            if (candidate !== undefined) fileName = candidate
        }
        if (fileName === undefined) {
            fileName = makeStub(baseVersion, packageDirectory).fileName
        }
    }

    const parsed = parseInnerZipName(fileName)
    if (parsed === null || parsed.toVersion !== packageDirectory) {
        report.reason = `空壳名与版本边不符: ${fileName}`
        return report
    }

    const directoryPath = path.join(packageRoot, IOS_DIFF_DIRECTORY)
    const filePath = path.join(directoryPath, fileName)
    let bytes
    if (fs.existsSync(filePath)) {
        bytes = fs.readFileSync(filePath)
    } else {
        bytes = makeStub(parsed.fromVersion, parsed.toVersion).bytes
        if (!options.dryRun) {
            fs.mkdirSync(directoryPath, { recursive: true })
            fs.writeFileSync(filePath, bytes)
        }
        report.action = options.dryRun ? "would-create" : "created"
    }

    const rebuilt = {
        relativePath: `${IOS_DIFF_DIRECTORY}/${fileName}`,
        layer: "ios",
        // 清单 order 一律跟文件名的分卷序号对齐：服务端按 `<from>-<to>-<index>` 去重并重排 order，
        // 清单里给别的号只会让「清单说的顺序」与「计划里的顺序」不一致（同名同槽位去重仍按文件名走）。
        order: parsed.index,
        bytes: bytes.length,
        sha256: sha256Of(bytes),
    }
    if (iosEntry !== undefined
        && iosEntry.relativePath === rebuilt.relativePath
        && iosEntry.bytes === rebuilt.bytes
        && iosEntry.sha256 === rebuilt.sha256) {
        report.action = "unchanged"
        report.entry = rebuilt
        return report
    }

    const archives = manifest.archives.filter(archive => archive.layer !== "ios")
    archives.push(rebuilt)
    const updated = {
        schema: manifest.schema,
        baseVersion: manifest.baseVersion,
        targetVersion: manifest.targetVersion,
        compatibleClient: manifest.compatibleClient,
        archives,
    }
    if (!options.dryRun) fs.writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`)
    if (report.action === "skipped") report.action = options.dryRun ? "would-update" : "updated"
    report.entry = rebuilt
    return report
}

function parseArguments(argv) {
    const options = { patchesRoot: null, stubsDirectory: null, dryRun: false }
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]
        if (flag === "--patches") options.patchesRoot = argv[++index] ?? null
        else if (flag === "--stubs") options.stubsDirectory = argv[++index] ?? null
        else if (flag === "--dry-run") options.dryRun = true
        else throw new Error(`unknown argument: ${flag}`)
    }
    if (options.patchesRoot === null) throw new Error("--patches <patches root> is required")
    if (path.basename(options.patchesRoot) !== "patches") {
        throw new Error("--patches 必须指向名为 patches 的目录（与 CDN 布局一致）")
    }
    return options
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv)
    if (options.stubsDirectory !== null && !fs.existsSync(options.stubsDirectory)) {
        throw new Error(`--stubs 目录不存在: ${options.stubsDirectory}`)
    }
    const packages = fs.readdirSync(options.patchesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    if (packages.length === 0) throw new Error(`patches 根下没有版本目录: ${options.patchesRoot}`)

    const reports = []
    const failures = []
    for (const packageDirectory of packages) {
        const report = attachPackage(options, packageDirectory)
        reports.push(report)
        if (report.action === "skipped") failures.push(`${packageDirectory}: ${report.reason}`)
    }

    for (const report of reports) {
        const detail = report.entry === null
            ? report.reason
            : `${report.entry.relativePath} (${report.entry.bytes} B, sha256 ${report.entry.sha256.slice(0, 16)}…)`
        process.stdout.write(`  ${report.package}: ${report.action} — ${detail}\n`)
    }
    if (failures.length > 0) {
        process.stderr.write(`失败 ${failures.length} 个包:\n${failures.map(item => `  ${item}`).join("\n")}\n`)
        process.exitCode = 1
        return
    }
    process.stdout.write(`${JSON.stringify({
        status: options.dryRun ? "dry-run" : "ok",
        patchesRoot: options.patchesRoot,
        packageCount: reports.length,
        iosArchives: reports.filter(report => report.entry !== null).length,
    })}\n`)
}

if (require.main === module) {
    try {
        main()
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    }
}

module.exports = { attachPackage, parseInnerZipName, stubDateForEdge }
