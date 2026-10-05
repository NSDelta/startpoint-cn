#!/usr/bin/env node
"use strict"

/*
 * 生成 iOS 平台层的「占位空壳」归档（archive-ios-diff/*.zip）。
 *
 * 背景（实测结论，见 docs 与本次勘察记录）：
 *   - 官方 `.cdn/cn/archive-ios-diff/` 里的 10 个包全部是 111 B 的单条目 ZIP，
 *     条目名 `.empty`、内容单字节 `0`(0x30)、method=0(stored)、version-needed=10。
 *     它们与官方 `/get_path`（`.cdn/cn/path`）里带 `archive-ios-diff` 的那 10 条版本边
 *     一一对应，**SHA-256 与官方声明完全一致**（不是本地伪造）。
 *   - iOS 客户端需要的平台层差异包在官方发布里本来就是空壳占位（真正的 mod 内容
 *     走 common 层），所以补 iOS 边 = 生成同样形状的 111 B 空壳。
 *   - 官方 54 条基线边里只有 10 条带 iOS 包；其余 44 条 iOS 客户端只能拿到
 *     common/quality 层（服务器 ios-compat 会把这些边标记为 missingPlatform，
 *     目录视图降级但可用）。本工具可选地把这 44 条也补齐。
 *
 * 用法：
 *   node tools/make_ios_stub_archives.cjs --out <目录> [--cdn <cn 根>] [--edges <a-b,c-d>] [--fill-baseline]
 *
 * 输出：
 *   <out>/archive-ios-diff/<inner-zip>          生成的空壳包（可直接投放）
 *   <out>/ios-stubs.manifest.json                清单：边、文件名、大小、SHA-256、来源
 *
 * 只读保证：不修改 --cdn 指向的基线目录，只读取 path 来枚举版本边。
 */

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const IOS_DIFF_DIRECTORY = "archive-ios-diff"
const STUB_MEMBER_NAME = ".empty"
const STUB_MEMBER_DATA = Buffer.from("0", "binary")
const STUB_TOKEN_LENGTH = 8

/** ZIP 本地文件头里的 MS-DOS 时间戳（秒粒度：2 秒一档）。 */
function toDosDateTime(date) {
    const year = Math.min(Math.max(date.getFullYear(), 1980), 2107)
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff }
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
        let value = index
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
        }
        table[index] = value >>> 0
    }
    return table
})()

function crc32(buffer) {
    let value = 0xffffffff
    for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
    return (value ^ 0xffffffff) >>> 0
}

/**
 * 复刻官方空壳包的 ZIP 字节布局（111 B）：
 *   本地文件头(30) + 条目名(6) + 1 B 数据 + 中央目录头(46) + 条目名(6) + EOCD(22)
 * 服务器不解析归档内容（只用文件名推导版本边 + 校验大小与 SHA-256），
 * 但 iOS 客户端会真的解包，所以必须是合法 ZIP。
 */
function buildStubArchive(date = new Date()) {
    const nameBytes = Buffer.from(STUB_MEMBER_NAME, "binary")
    const crc = crc32(STUB_MEMBER_DATA)
    const size = STUB_MEMBER_DATA.length
    const { dosTime, dosDate } = toDosDateTime(date)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(10, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const localRecord = Buffer.concat([local, nameBytes, STUB_MEMBER_DATA])

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x033f, 4)
    central.writeUInt16LE(10, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(0, 42)
    const centralRecord = Buffer.concat([central, nameBytes])

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(centralRecord.length, 12)
    eocd.writeUInt32LE(localRecord.length, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([localRecord, centralRecord, eocd])
}

function readVersionEdgesFromPath(pathFile) {
    const parsed = JSON.parse(fs.readFileSync(pathFile, "utf8"))
    const diff = Array.isArray(parsed?.diff) ? parsed.diff : []
    const edges = []
    for (const entry of diff) {
        const from = entry?.original_version
        const to = entry?.version
        if (typeof from !== "string" || typeof to !== "string") continue
        const archives = Array.isArray(entry.archive) ? entry.archive : []
        const hasIos = archives.some(item => typeof item?.location === "string"
            && item.location.includes(`/${IOS_DIFF_DIRECTORY}/`))
        edges.push({ fromVersion: from, toVersion: to, hasIosArchive: hasIos })
    }
    return edges
}

function innerZipName(fromVersion, toVersion, token) {
    return `pinball-${fromVersion}-${toVersion}-1-${token}.zip`
}

/**
 * 每条边一个确定性的 MS-DOS 时间戳：官方空壳包之间唯一的字节差异就是本地/中央头里的
 * mtime+mdate，所以照此给每条边一个稳定且互不相同的戳，SHA-256 才会各自不同
 * （官方同名目录里的 10 个包也是 10 个不同 SHA-256），重复生成仍然幂等。
 */
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

function parseArguments(argv) {
    const options = { out: null, cdn: null, edges: [], fillBaseline: false }
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]
        if (flag === "--out") options.out = argv[++index] ?? null
        else if (flag === "--cdn") options.cdn = argv[++index] ?? null
        else if (flag === "--edges") options.edges.push(...String(argv[++index] ?? "").split(",").filter(Boolean))
        else if (flag === "--fill-baseline") options.fillBaseline = true
        else throw new Error(`unknown argument: ${flag}`)
    }
    if (!options.out) throw new Error("--out <directory> is required")
    return options
}

function resolveRequestedEdges(options) {
    const explicit = []
    for (const item of options.edges) {
        const match = /^(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)$/.exec(item.trim())
        if (!match) throw new Error(`--edges entry must look like 1.4.54-1.4.55: ${item}`)
        explicit.push({ fromVersion: match[1], toVersion: match[2], source: "explicit" })
    }
    if (!options.fillBaseline) return explicit
    if (!options.cdn) throw new Error("--fill-baseline needs --cdn <cn root> to enumerate baseline edges")
    const pathFile = path.join(options.cdn, "path")
    const baseline = readVersionEdgesFromPath(pathFile)
    const requested = new Set(explicit.map(edge => `${edge.fromVersion}-${edge.toVersion}`))
    const filled = []
    for (const edge of baseline) {
        if (edge.hasIosArchive) continue
        const key = `${edge.fromVersion}-${edge.toVersion}`
        if (requested.has(key)) continue
        filled.push({ fromVersion: edge.fromVersion, toVersion: edge.toVersion, source: "baseline-missing" })
    }
    return [...explicit.map(edge => ({ ...edge, source: "explicit" })), ...filled]
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv)
    const outRoot = path.resolve(options.out)
    const edgeRequests = resolveRequestedEdges(options)
    if (edgeRequests.length === 0) throw new Error("no version edges requested")
    const outputDirectory = path.join(outRoot, IOS_DIFF_DIRECTORY)
    fs.mkdirSync(outputDirectory, { recursive: true })

    const entries = []
    for (const edge of edgeRequests) {
        // 每条边一个确定性时间戳 → 确定性字节 → 确定性文件名 token，重复生成幂等。
        const stamp = stubDateForEdge(edge.fromVersion, edge.toVersion)
        const probe = buildStubArchive(stamp)
        const token = crypto.createHash("sha256").update(probe).digest("hex").slice(0, STUB_TOKEN_LENGTH)
        const fileName = innerZipName(edge.fromVersion, edge.toVersion, token)
        const bytes = probe
        const target = path.join(outputDirectory, fileName)
        fs.writeFileSync(target, bytes)
        entries.push({
            fromVersion: edge.fromVersion,
            toVersion: edge.toVersion,
            source: edge.source,
            layer: "ios",
            relativePath: `${IOS_DIFF_DIRECTORY}/${fileName}`,
            bytes: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        })
    }

    const manifest = {
        kind: "ios-platform-stub-archives",
        schema: 1,
        generatedAt: new Date().toISOString(),
        stubShape: {
            member: STUB_MEMBER_NAME,
            memberDataHex: STUB_MEMBER_DATA.toString("hex"),
            compressionMethod: 0,
            versionNeeded: 10,
            bytes: buildStubArchive().length,
        },
        archiveCount: entries.length,
        archives: entries.sort((left, right) => left.fromVersion.localeCompare(right.fromVersion)
            || left.toVersion.localeCompare(right.toVersion)),
    }
    fs.writeFileSync(
        path.join(outRoot, "ios-stubs.manifest.json"),
        `${JSON.stringify(manifest, null, 4)}\n`,
    )
    process.stdout.write(`${JSON.stringify({
        status: "ok",
        output: outputDirectory,
        archiveCount: entries.length,
        baselineFilled: entries.filter(entry => entry.source === "baseline-missing").length,
        explicit: entries.filter(entry => entry.source === "explicit").length,
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

module.exports = {
    IOS_DIFF_DIRECTORY,
    STUB_MEMBER_DATA,
    STUB_MEMBER_NAME,
    buildStubArchive,
    crc32,
    innerZipName,
    readVersionEdgesFromPath,
    resolveRequestedEdges,
}
