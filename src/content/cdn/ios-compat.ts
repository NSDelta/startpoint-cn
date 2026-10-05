// iOS 目录视图构建与冻结缓存（ios_medium.csv、archive-ios-full/diff）
// 由"灰"制作，基于 DontBeAlarmed/startpoint-cn@dev 提交 11d3bcf9。
// 社区适配：
//  - 实体表或目录整体缺失 → iOS 视图标记为明确"不可用"（503），不回退 Android platform 归档，
//    错误严格限制在 iOS 请求范围（不影响 Android）。
//  - **单条 edge 缺 iOS platform 归档不再让整个视图不可用**（真机 m06219：h503 / 进游戏卡在半路 /
//    资源卡在 5.96%）。旧语义下，社区 CDN 只要有一条 edge 没有 iOS 归档就恒 503——本机快照 110 条
//    edge 里 100 条没有（archive-ios-diff 只有 10 个 111 字节占位件），iOS 客户端因此永远拿不到计划。
//    降级策略：该 edge 只带 common/quality（shared）归档，**绝不把 Android platform 归档发给 iOS**；
//    iOS 视图标记 degraded 并给出 missingPlatformEdges 计数，供路由层打日志。
//  - 实体表所在目录名与快照清单不一致时（清单 EntityLists/… vs 磁盘 entities/…，不是大小写差异）
//    扫 cdnRoot 直属子目录取唯一含 iOS 实体表的那个。
//  - iOS 目录在启动/首次使用扫描一次并冻结（模块级缓存，缓存键含补丁存在性指纹），
//    不在每次请求中重扫磁盘。
//  - **补丁的 iOS 层（`patches/<版本>/patch-manifest.json` 里 `layer:"ios"` 的条目）并进
//    平台层**：没有这一步，CDN 作者给补丁加 iOS 层就只是让启动校验通过，iOS 客户端永远拿不到
//    那些字节（Android 目录视图刻意不接受 iOS 层）。补丁边优先于官方基线，安全边界不变——
//    仍然绝不把 Android platform 归档发给 iOS 客户端。
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { ContentSnapshot } from "../runtime/content-snapshot"
import { parseDiffArchiveName, parseEntityListInstalledBytes, parseFullArchiveName } from "./catalog-builder"
import { parsePatchArchiveName, parsePatchManifest } from "./patch-manifest"
import type { CatalogArchive, CatalogEdge, CdnCatalog } from "./types"

const IOS_FULL_DIRECTORY = "archive-ios-full"
const IOS_DIFF_DIRECTORY = "archive-ios-diff"
const PATCH_MANIFEST_FILE_NAME = "patch-manifest.json"
const EMPTY_ARCHIVE_LOCATIONS: ReadonlyMap<string, IosArchiveLocation> = Object.freeze(new Map())

/** 归档在磁盘上的根：官方基线在 CDN root，补丁在 `patches/<targetVersion>`。 */
export interface IosArchiveLocation {
    readonly kind: "baseline" | "patch"
    /** 补丁来源的版本目录；基线为 null。 */
    readonly targetVersion: string | null
    readonly logicalRoot: string
    /** 交给 sendFile 做"解析后仍在根内"复核的物理根。 */
    readonly physicalRoot: string
    readonly expectedSize: number
    /** 仅补丁来源带：打开前复核 dev/ino/size/mtime，挡住扫描后的原地替换。 */
    readonly expectedIdentity: PatchArchiveIdentity | null
    /** true = 按补丁归档处理（拒绝路径中的符号链接）。 */
    readonly pinned: boolean
}

export interface PatchArchiveIdentity {
    readonly dev: string
    readonly ino: string
    readonly size: string
    readonly mtimeMs: string
    readonly ctimeMs: string
}

interface IosPatchArchive {
    readonly archive: CatalogArchive
    readonly targetVersion: string
    readonly logicalRoot: string
    readonly physicalRoot: string
    readonly identity: PatchArchiveIdentity
}

export type IosCompatState =
    | {
        readonly kind: "ready"
        readonly catalog: CdnCatalog
        readonly installedBytes: number
        /**
         * true = 至少一条 edge 没有 iOS platform 归档，该 edge 只下发 common/quality。
         * 视图仍然可用（客户端能拿到 200 计划），但 iOS platform 层不会更新。
         */
        readonly degraded: boolean
        readonly missingPlatformEdges: number
        /** 并进平台层的补丁 iOS 归档路径（相对 CDN root），诊断用。 */
        readonly patchIosArchives: ReadonlyArray<string>
    }
    | {
        readonly kind: "unavailable"
        readonly reason: string
    }

function archive(relativePath: string, compressedBytes: number, sha256: string, order: number): CatalogArchive {
    return Object.freeze({
        relativePath,
        compressedBytes,
        sha256,
        layer: "platform" as const,
        order,
    })
}

function readZipArchives(cdnRoot: string, directory: string): ReadonlyArray<CatalogArchive> {
    const absoluteDirectory = path.join(cdnRoot, directory)
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            // iOS 目录缺失：返回空列表（整体可用性由 prepareIosCompat 判定，不在此抛错）。
            return []
        }
        throw error
    }
    return entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry, index) => {
            const bytes = fs.readFileSync(path.join(absoluteDirectory, entry.name))
            return archive(
                `${directory}/${entry.name}`,
                bytes.length,
                createHash("sha256").update(bytes).digest("hex"),
                index + 1,
            )
        })
}

function matchesDiffEdge(relativePath: string, fromVersion: string, toVersion: string): boolean {
    const parsed = parseDiffArchiveName(path.posix.basename(relativePath))
    return parsed !== null && parsed.fromVersion === fromVersion && parsed.toVersion === toVersion
}

interface ReplacedEdge {
    readonly edge: CatalogEdge
    /** platform 层没有对应 iOS 归档：该 edge 降级为「只带 shared（common/quality）」。 */
    readonly missingPlatform: boolean
}

/**
 * 归档在一条边里的槽位序号。解析一律走 catalog-builder 的解析器（`pinball-<from>-<to>-<n>-<token>.zip`
 * 与 full 形式的 `pinball-<version>-<n>-<token>.zip`）——自己写正则就会漂移：
 * 这里早先的 `/…-(\d+\.\d+\.\d+)-\d+-/` 只有两个捕获组，`match[3]` 恒为 undefined，
 * 于是排序键恒为 NaN（比较函数退化成"保持插入序"）、槽位键恒为 `…-undefined`
 * （整条边的候选挤成一槽）。
 */
function archiveOrderKey(candidate: CatalogArchive): number {
    const base = path.posix.basename(candidate.relativePath)
    return parseDiffArchiveName(base)?.order ?? parseFullArchiveName(base)?.order ?? Number.MAX_SAFE_INTEGER
}

/**
 * 归档槽位：`<from>-<to>-<index>` / full 形式的 `<to>-<index>`，故意**不含**文件名末尾的 token。
 * 同一条边的 platform 分卷由 index 区分；token 只是发布方派生值（实测与文件 sha256 无关），
 * 让 token 进键会把同一个槽位算成两槽。
 */
function archiveSlotKey(candidate: CatalogArchive): string {
    const base = path.posix.basename(candidate.relativePath)
    const diff = parseDiffArchiveName(base)
    if (diff !== null) return `${diff.fromVersion}-${diff.toVersion}-${diff.order}`
    const full = parseFullArchiveName(base)
    return full === null ? base : `${full.toVersion}-${full.order}`
}

/**
 * 一条边可下发的 iOS platform 归档。补丁自带的 iOS 层优先于官方基线：`compressedBytes`
 * 已经过补丁包内的 SHA-256 校验，而官方基线是逐文件读盘算出来的。
 *
 * 去重键是**归档槽位**——文件名里的 `<from>-<to>-<index>`，不是 `candidate.order`：
 * 补丁与基线各自目录内独立从 1 编号，基线的 order 只是 readdir 顺序，撞不撞号纯属巧合。
 * 同一个文件既能从 `patches/<版本>/archive-ios-diff/` 拿到、也能从 `cdn/cn/archive-ios-diff/`
 * 拿到（补丁给的基线空壳就是这种，实测两边**同名同字节**），只按 order 去重会漏掉它
 * ⇒ 客户端把同一个文件下两遍。token（文件名最后 8 位）不参与判定：发布方的 token 是派生值，
 * 同名同字节但 token 不同、或同 token 不同字节，都不该让同一槽位下发两次。
 *
 * 优先级与两轮顺序无关（补丁**后**写，所以补丁的声明即使 index 与基线不同也照样胜出）：
 * 先铺全部候选，再用补丁覆盖同槽位。最终 order 按槽位重排后**重新连续编号**：
 * 客户端按序应用，视图里不该出现空档。
 */
function platformArchiveCandidates(
    patches: ReadonlyArray<CatalogArchive>,
    baseline: ReadonlyArray<CatalogArchive>,
): ReadonlyArray<CatalogArchive> {
    const bySlot = new Map<string, CatalogArchive>()
    for (const candidate of baseline) bySlot.set(archiveSlotKey(candidate), candidate)
    for (const candidate of patches) bySlot.set(archiveSlotKey(candidate), candidate)
    return Object.freeze(
        [...bySlot.values()]
            .sort((left, right) => archiveOrderKey(left) - archiveOrderKey(right))
            .map((candidate, index) => (candidate.order === index + 1
                ? candidate
                : Object.freeze({ ...candidate, order: index + 1 }))),
    )
}

function replacePlatformArchives(
    edge: CatalogEdge,
    iosFull: ReadonlyArray<CatalogArchive>,
    iosDiff: ReadonlyArray<CatalogArchive>,
    patchIosArchivePaths: ReadonlySet<string>,
): ReplacedEdge {
    const shared = edge.archives.filter(candidate => candidate.layer !== "platform")
    const candidates = edge.fromVersion === null
        ? iosFull
        : iosDiff.filter(candidate => matchesDiffEdge(
            candidate.relativePath,
            edge.fromVersion as string,
            edge.toVersion,
        ))
    const platform = platformArchiveCandidates(
        candidates.filter(candidate => patchIosArchivePaths.has(candidate.relativePath)),
        candidates.filter(candidate => !patchIosArchivePaths.has(candidate.relativePath)),
    )
    // 缺 iOS platform 归档时**不再把整个 iOS 视图判为不可用**（旧语义会把 iOS 资源更新变成永久 503）：
    // 这条 edge 的 platform 层留空，客户端继续使用它已有的 iOS 资源，common/quality 照常下发。
    // 与旧语义的安全边界完全一致——绝不把 Android platform 归档发给 iOS 客户端。
    return {
        edge: Object.freeze({ ...edge, archives: Object.freeze([...shared, ...platform]) }),
        missingPlatform: platform.length === 0,
    }
}

// 冻结的 iOS 目录视图缓存：key = cdnRoot，扫描一次，之后不再重扫磁盘（含"不可用"状态）。
const iosCompatCache = new Map<string, IosCompatState>()

/**
 * 补丁来源的相对路径判定（`archive-ios-full/` 只可能来自官方基线）。
 */
function isPatchArchiveRelativePath(relativePath: string): boolean {
    return relativePath.startsWith(`${IOS_DIFF_DIRECTORY}/`)
}

function isMissingError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
}

function isDescendant(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate)
    return relative !== ""
        && !path.isAbsolute(relative)
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
}

function hasSymlinkComponent(root: string, segments: readonly string[]): boolean {
    let candidate = root
    for (const segment of segments) {
        candidate = path.join(candidate, segment)
        if (fs.lstatSync(candidate).isSymbolicLink()) return true
    }
    return false
}

function patchArchiveIdentity(stat: fs.Stats): PatchArchiveIdentity {
    return Object.freeze({
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mtimeMs: String(stat.mtimeMs),
        ctimeMs: String(stat.ctimeMs),
    })
}

/**
 * 一个补丁包里的 iOS 层归档：只接受磁盘上确实存在、且字节数与清单一致的普通文件。
 * 摘要不在这里重算（补丁包的整体校验由启动时的 Overlay 扫描负责，那里对每个 inner ZIP
 * 做完整 SHA-256）；这里挡住的是"磁盘上根本没有 / 大小对不上 / 路径穿根 / 符号链接"。
 */
function readPackageIosArchives(
    patchesRoot: string,
    packageDirectory: string,
): ReadonlyArray<IosPatchArchive> {
    const packageRoot = path.join(patchesRoot, packageDirectory)
    const manifestPath = path.join(packageRoot, PATCH_MANIFEST_FILE_NAME)
    let manifest: ReturnType<typeof parsePatchManifest>
    try {
        if (fs.lstatSync(manifestPath).isSymbolicLink()) return []
        manifest = parsePatchManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")))
    } catch {
        // 目录不存在 = 还没装完的包；manifest 非法 = 由启动时的 Overlay 扫描负责 fail closed。
        // 两条都只是"这个包没有可用的 iOS 层"，不影响其它包与官方基线。
        return []
    }
    if (manifest.targetVersion !== packageDirectory) return []

    const physicalRoot = fs.realpathSync(packageRoot)
    const collected: IosPatchArchive[] = []
    for (const entry of manifest.archives) {
        if (entry.layer !== "ios") continue
        const segments = entry.relativePath.split("/")
        if (!isPatchArchiveRelativePath(entry.relativePath) || segments.length !== 2) continue
        const absolutePath = path.join(packageRoot, ...segments)
        if (!isDescendant(packageRoot, absolutePath)) continue
        let stat: fs.Stats
        let physicalPath: string
        try {
            if (hasSymlinkComponent(packageRoot, segments)) continue
            stat = fs.lstatSync(absolutePath)
            if (!stat.isFile()) continue
            physicalPath = fs.realpathSync(absolutePath)
        } catch {
            continue
        }
        if (!isDescendant(physicalRoot, physicalPath)) continue
        if (stat.size !== entry.bytes) continue
        const parsed = parsePatchArchiveName(segments[1])
        if (parsed === null || parsed.toVersion !== manifest.targetVersion) continue
        collected.push({
            archive: archive(entry.relativePath, entry.bytes, entry.sha256, entry.order),
            targetVersion: manifest.targetVersion,
            logicalRoot: packageRoot,
            physicalRoot,
            identity: patchArchiveIdentity(stat),
        })
    }
    return collected
}

/**
 * `cdnRoot` → 补丁根。资产 CDN 的布局固定为 `<CDN_DIR>/cn` + `<CDN_DIR>/patches`
 * （与 `src/content/paths.ts` 的 `resolveContentPaths` 同源）。目录名不是 `cn` 时返回 null：
 * 宁可少并一层补丁，也不能把任意父目录当补丁根扫。
 */
function derivePatchesRoot(cdnRoot: string): string | null {
    return path.basename(cdnRoot) === "cn" ? path.join(path.dirname(cdnRoot), "patches") : null
}

/**
 * 扫描 `patches/<版本>/patch-manifest.json`，收集补丁自带的 iOS 层归档。
 * 与 `scanPatchOverlay` 的分工：这里只读、不做 TOCTOU 快照、不参与 Android Catalog，
 * 失败一律降级成「没有补丁 iOS 层」，绝不把 iOS 视图判死。
 */
export function findIosPatchArchives(patchesRoot: string | null): ReadonlyArray<IosPatchArchive> {
    if (patchesRoot === null) return []
    if (path.basename(patchesRoot) !== "patches") return []
    let rootStat: fs.Stats
    let entries: fs.Dirent[]
    try {
        rootStat = fs.lstatSync(patchesRoot)
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return []
        entries = fs.readdirSync(patchesRoot, { withFileTypes: true })
    } catch (error) {
        if (isMissingError(error)) return []
        throw error
    }
    const collected: IosPatchArchive[] = []
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory()) continue
        collected.push(...readPackageIosArchives(patchesRoot, entry.name))
    }
    return collected
}

/**
 * 冻结 iOS 视图的缓存键 = `cdnRoot` + 补丁存在性指纹。
 * 指纹只取"补丁目录里有哪些版本、manifest 多大／什么时候改的"，成本是几次 stat；
 * 运维往 `patches/` 里装包后**下一次请求**就会重建视图，不需要重启。
 */
function iosCompatCacheKey(cdnRoot: string, patchesRoot: string | null | undefined): string {
    if (patchesRoot === null || patchesRoot === undefined) return `${cdnRoot}\u0000`
    const entries: string[] = []
    try {
        if (path.basename(patchesRoot) === "patches" && !fs.lstatSync(patchesRoot).isSymbolicLink()) {
            for (const entry of fs.readdirSync(patchesRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue
                let manifestStamp = "none"
                try {
                    const stat = fs.lstatSync(path.join(patchesRoot, entry.name, PATCH_MANIFEST_FILE_NAME))
                    manifestStamp = `${stat.size}:${stat.mtimeMs}`
                } catch {
                    // 没有 manifest 的版本目录：指纹里留 "none"，装上 manifest 后自然变化。
                }
                entries.push(`${entry.name}=${manifestStamp}`)
            }
        }
    } catch {
        entries.length = 0
    }
    return `${cdnRoot}\u0000${entries.sort().join(",")}`
}

/**
 * 构建并冻结 iOS 目录视图（幂等，模块级缓存）。
 * - 实体表（ios_medium.csv）缺失、archive-ios-* 目录整体缺失/为空、
 *   或任一 edge 缺失 iOS 归档 → 明确"不可用"（不回退 Android platform 归档）。
 * - `patchesRoot` 存在时，补丁包声明的 iOS 层（`archive-ios-diff/`）也并进平台层；
 *   补丁的存在性指纹进缓存键，所以装机后无需重启即可生效。
 */
export function prepareIosCompat(
    snapshot: ContentSnapshot,
    cdnRoot: string,
    patchesRoot?: string | null,
): IosCompatState {
    const cacheKey = iosCompatCacheKey(cdnRoot, patchesRoot)
    const cached = iosCompatCache.get(cacheKey)
    if (cached !== undefined) return cached
    const resolvedPatchesRoot = patchesRoot ?? derivePatchesRoot(cdnRoot)

    const entityList = resolveIosEntityList(snapshot.cdn, cdnRoot)
    if (entityList === null) {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "missing ios entity list",
        })
        iosCompatCache.set(cacheKey, state)
        return state
    }

    let iosFull: ReadonlyArray<CatalogArchive>
    let iosDiff: ReadonlyArray<CatalogArchive>
    try {
        iosFull = readZipArchives(cdnRoot, IOS_FULL_DIRECTORY)
        iosDiff = readZipArchives(cdnRoot, IOS_DIFF_DIRECTORY)
    } catch {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "ios archive directory is unreadable",
        })
        iosCompatCache.set(cacheKey, state)
        return state
    }
    // 补丁自带的 iOS 层：只取磁盘上确实存在、且大小与清单一致的 inner ZIP。
    // 磁盘扫描失败（补丁目录不可读等）只当作「没有补丁 iOS 层」，不影响基线视图。
    let patchArchives: ReadonlyArray<IosPatchArchive> = []
    try {
        patchArchives = findIosPatchArchives(resolvedPatchesRoot)
    } catch {
        patchArchives = []
    }
    const patchIosArchivePaths: ReadonlySet<string> = new Set(
        patchArchives.map(candidate => candidate.archive.relativePath),
    )
    if (iosFull.length === 0 && iosDiff.length === 0 && patchArchives.length === 0) {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "missing ios archive directories",
        })
        iosCompatCache.set(cacheKey, state)
        return state
    }
    const mergedIosDiff: ReadonlyArray<CatalogArchive> = Object.freeze([
        ...iosDiff,
        ...patchArchives.map(candidate => candidate.archive),
    ])

    const replaced = snapshot.cdn.edges.map(edge => (
        replacePlatformArchives(edge, iosFull, mergedIosDiff, patchIosArchivePaths)
    ))
    const missingPlatformEdges = replaced.filter(item => item.missingPlatform).length
    const catalog = Object.freeze({
        ...snapshot.cdn,
        edges: Object.freeze(replaced.map(item => item.edge)),
    })
    const installedBytes = readEntityListInstalledBytes(cdnRoot, entityList)
    if (installedBytes === null) {
        const state: IosCompatState = Object.freeze({
            kind: "unavailable",
            reason: "invalid ios entity list",
        })
        iosCompatCache.set(cacheKey, state)
        return state
    }
    const state: IosCompatState = Object.freeze({
        kind: "ready",
        catalog,
        installedBytes,
        degraded: missingPlatformEdges > 0,
        missingPlatformEdges,
        patchIosArchives: Object.freeze([
            ...patchArchives
                .map(candidate => candidate.archive.relativePath)
                .sort((left, right) => left.localeCompare(right)),
        ]),
    })
    iosCompatCache.set(cacheKey, state)
    return state
}

function listIosEntityLists(cdnRoot: string, directory: string): string[] {
    const absoluteDirectory = path.join(cdnRoot, ...directory.split("/"))
    try {
        return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
            .filter(entry => entry.isFile()
                && (entry.name.toLowerCase() === "ios_medium.csv"
                    || /-ios_medium\.csv$/i.test(entry.name)))
            .map(entry => entry.name)
            .sort((left, right) => left.localeCompare(right))
    } catch {
        // 目录不存在：该目录没有 iOS 实体表（调用方据此判定不可用或换目录兜底）
        return []
    }
}

export function resolveIosEntityList(catalog: CdnCatalog, cdnRoot: string): string | null {
    const androidPath = catalog.entityListsRelativePath
    const directory = path.posix.dirname(androidPath)
    const direct = listIosEntityLists(cdnRoot, directory)
    if (direct.length === 1) return `${directory}/${direct[0]}`
    if (direct.length > 1) return null
    // 目录名漂移兜底（真机 m06219）：快照清单写 EntityLists/10939-android_medium.csv，而社区 CDN
    // 磁盘上的目录叫 entities/——不是大小写差异，是另一个名字，readdir 直接 ENOENT，整个 iOS 视图
    // 因此被判"没有 iOS 实体表"。这里扫 cdnRoot 的直属子目录，取唯一含 iOS 实体表的那个。
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(cdnRoot, { withFileTypes: true })
    } catch {
        return null
    }
    const candidates = entries
        .filter(entry => entry.isDirectory() && entry.name !== directory)
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right))
        .map(name => ({ name, files: listIosEntityLists(cdnRoot, name) }))
        .filter(item => item.files.length === 1)
    if (candidates.length !== 1) return null
    return `${candidates[0].name}/${candidates[0].files[0]}`
}

// 与 Android 侧同源：直接复用 catalog-builder 的规范解析器（表头可选、UTF-8 BOM 容忍、
// 引号感知的 CSV 切分、恰好 5 列、第三列 /^\d+$/），不再在 iOS 侧另写一份，避免两份
// 实现再次漂移。官方实体表实测无表头（首行即数据行），因此绝不能要求首行为表头——
// 旧实现 `lines.shift() !== ENTITY_LIST_HEADER` 把真实实体表一律判为非法。
// 调用方契约：任何解析失败（含 parseEntityListInstalledBytes 抛出的 CatalogValidationError）
// 一律返回 null（= iOS 视图不可用），绝不向上抛。
function readEntityListInstalledBytes(cdnRoot: string, entityList: string): number | null {
    // 与 Android installedBytes 语义一致：实体表 size 列之和（未压缩字节），
    // 不使用 ZIP 压缩下载量。
    const absolutePath = path.join(cdnRoot, ...entityList.split("/"))
    try {
        return parseEntityListInstalledBytes(fs.readFileSync(absolutePath))
    } catch {
        return null
    }
}

const iosAllowlistCache = new Map<string, ReadonlyMap<string, IosArchiveLocation>>()

/**
 * `archive-ios-*` 独立 ZIP allowlist：仅包含冻结 iOS 目录视图中解析出的归档
 * （relativePath → 磁盘落点与期望大小）。不按目录名前缀放行未解析来源。
 *
 * 基线 iOS 归档在 `<cdnRoot>/archive-ios-*`；补丁的 iOS 层在
 * `<patchesRoot>/<targetVersion>/archive-ios-diff`，两者由 `patchesRoot` 一起喂进来。
 */
export function getIosArchiveLocations(
    snapshot: ContentSnapshot,
    cdnRoot: string,
    patchesRoot?: string | null,
): ReadonlyMap<string, IosArchiveLocation> {
    const state = prepareIosCompat(snapshot, cdnRoot, patchesRoot)
    if (state.kind !== "ready") return EMPTY_ARCHIVE_LOCATIONS
    const cacheKey = iosCompatCacheKey(cdnRoot, patchesRoot)
    const cached = iosAllowlistCache.get(cacheKey)
    if (cached !== undefined) return cached

    // 只有**补丁来源**的路径需要甄别：`snapshot.archiveSources` 不含 iOS 归档
    // （Android Catalog 刻意不接受 iOS 层），所以不能反过来用它证明"这条是基线"。
    // 语义因此是：在 archiveSources 里被标成 patch 的走补丁根，其余一律按基线根解析。
    const patchSourced = new Set<string>()
    if (snapshot.archiveSources !== undefined) {
        for (const entry of snapshot.archiveSources.archives) {
            if (entry.source.kind === "patch") patchSourced.add(entry.relativePath)
        }
    }
    let physicalCdnRoot: string
    try {
        physicalCdnRoot = fs.realpathSync(cdnRoot)
    } catch {
        physicalCdnRoot = cdnRoot
    }
    const patches: ReadonlyArray<IosPatchArchive> = state.patchIosArchives.length === 0
        ? []
        : (() => {
            try {
                return findIosPatchArchives(patchesRoot ?? derivePatchesRoot(cdnRoot))
            } catch {
                return []
            }
        })()
    const patchByPath = new Map(patches.map(candidate => [candidate.archive.relativePath, candidate]))

    const allowlist = new Map<string, IosArchiveLocation>()
    for (const edge of state.catalog.edges) {
        for (const archive of edge.archives) {
            if (!isIosArchiveRelativePath(archive.relativePath)) continue
            if (allowlist.has(archive.relativePath)) continue
            const patch = patchByPath.get(archive.relativePath)
            if (patch !== undefined) {
                allowlist.set(archive.relativePath, Object.freeze({
                    kind: "patch" as const,
                    targetVersion: patch.targetVersion,
                    logicalRoot: patch.logicalRoot,
                    physicalRoot: patch.physicalRoot,
                    expectedSize: archive.compressedBytes,
                    expectedIdentity: patch.identity,
                    pinned: true,
                }))
                continue
            }
            // 标成补丁来源、却没在补丁目录里找到 → 宁可不放行，等下一次扫描。
            if (patchSourced.has(archive.relativePath)) continue
            allowlist.set(archive.relativePath, Object.freeze({
                kind: "baseline" as const,
                targetVersion: null,
                logicalRoot: cdnRoot,
                physicalRoot: physicalCdnRoot,
                expectedSize: archive.compressedBytes,
                expectedIdentity: null,
                pinned: false,
            }))
        }
    }
    const frozen: ReadonlyMap<string, IosArchiveLocation> = Object.freeze(allowlist)
    iosAllowlistCache.set(cacheKey, frozen)
    return frozen
}

export function isIosAssetDevice(device: string | undefined): boolean {
    const normalized = device?.toLowerCase()
    return normalized === "1" || normalized === "ios"
}

export function isSupportedCnAssetDevice(device: string | undefined): boolean {
    if (device === undefined) return true
    const normalized = device.toLowerCase()
    return normalized === "1"
        || normalized === "2"
        || normalized === "ios"
        || normalized === "android"
}

export function isIosArchiveRelativePath(relativePath: string): boolean {
    return relativePath.startsWith(`${IOS_FULL_DIRECTORY}/`)
        || relativePath.startsWith(`${IOS_DIFF_DIRECTORY}/`)
}
