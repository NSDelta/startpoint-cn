// B0 iOS 端点改写核心（纯函数，无 IO / 无 JVM）—— 便于离线回归与断言复用。
//
// 红线（为什么只能"原地等长覆盖"）：
// 主二进制里的 URL 字面量有三种容器，全都**不允许改变字节长度**，否则容器解析错位：
//   1. `__TEXT,__cstring` 的 NUL 分隔串表；2. ObjC 方法/常量区里背靠背的串；
//   3. AIR/ABC 的 U30 长度前缀常量池（见 ios-abc.mjs）。
// 因此本模块只做一件事：把匹配到的 `scheme://authority` 原地覆盖成**字节数完全相同**的新串，
// 长度富裕时用 userinfo（`0…@`，服务端忽略）补齐 —— 绝不缩短、绝不搬移、绝不插入/删除字节。
//
// 两种改写模式（工具按输入包自动选择，也可 --mode 强制）：
//   url —— 输入是**官方包**：改 `https?://<leiting|roguelike|cl2009 域名>`（官方 1.8.4 实测 150 处，
//          其中 137 处长度 ≥ 25 可改，13 处 (22–24 字节) 装不下 `http://<18 字符 host:port>` ⇒ 跳过）。
//   bare —— 输入是**已被第三方改过的包**：改裸 `IP:port` 字面量（等长 18 → 18）。
//
// 前提勘误（写在代码里，避免下次又有人踩）：任务单称"官方 Mach-O 里 8.133.209.122:7001 出现 137 处"。
// 实测官方包（apkipa/iOS-1.8.4.ipa）内该串 **0 处**；137 处出现在一份**第三方已打过补丁**的产物里
// （D:\wfspcn\tools\tmp_ipa\...\worldflipper，sha256:5c0b67e0d327d070…），且其形态是
// `http://0000000@8.133.209.122:7001/` —— `0…@` 正是 patch-ipa.mjs 的 userinfo 填充签名。
// 官方包内真正的可改写站点数是 **137**（150 个域名站点 − 13 个过短站点），与本任务单那个数字巧合一致。

/** 官方包内置的**域名**端点族（URL 站点模式的目标）。 */
export const OFFICIAL_HOST_SUFFIXES = ["leiting.com", "roguelike.com", "cl2009.com"]

/** 官方 URL 站点正则（只吃 scheme+authority，绝不吃 path；`g` 由调用方按需重建）。 */
export const OFFICIAL_URL_RE = new RegExp(
    String.raw`https?:\/\/([A-Za-z0-9.-]+\.(?:${OFFICIAL_HOST_SUFFIXES.map(s => s.replace(/\./g, "\\.")).join("|")}))(?::\d+)?`,
    "g",
)

/** 任务单前提里的字样（**不是**官方包内容，仅用于 premise 复核）。 */
export const PREMISE_ENDPOINT = "8.133.209.122:7001"

/** 官方 1.8.4 主二进制实测站点统计（断言基线，变更即报警）。 */
export const OFFICIAL_SITE_TOTAL = 150
export const OFFICIAL_SITE_REWRITEABLE = 137
export const OFFICIAL_SITE_TOO_SHORT = 13

/** 待替换端点的固定长度（等长红线：目标端点的 `host:port` 必须也是 18 字符）。 */
export const ENDPOINT_LENGTH = 18

/** `http://` + hostPort 的最小可容纳长度（比这短的原始站点只能跳过）。 */
export function minReplacementLength(hostPort, { scheme = "http" } = {}) {
    return `${scheme}://${hostPort}`.length
}

export function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function countOccurrences(buffer, needle) {
    if (!needle) return 0
    let count = 0
    let index = buffer.indexOf(needle)
    while (index !== -1) {
        count += 1
        index = buffer.indexOf(needle, index + needle.length)
    }
    return count
}

/**
 * 构造**与 origLen 等长**的替换串。
 * origLen === min ⇒ `http://HOST:PORT`（无填充）
 * origLen >  min ⇒ `http://000…@HOST:PORT`（userinfo 填充，服务端忽略 userinfo）
 * origLen <  min ⇒ 抛错（调用方据此跳过该站点；本函数不接受任何"变通"）
 */
export function buildPaddedReplacement(origLen, hostPort, { scheme = "http", fill = "0" } = {}) {
    const bare = `${scheme}://${hostPort}`
    const deficit = origLen - bare.length
    if (deficit < 0) throw new Error(`target ${bare} (${bare.length}) is longer than original (${origLen})`)
    if (deficit === 0) return bare
    return `${scheme}://${fill.repeat(deficit - 1)}@${hostPort}`
}

/** 裸端点模式的等长替换：`IP:port`(18) → `host:port`(18)，不涉及 scheme。 */
export function buildBareReplacement(origLen, hostPort) {
    if (hostPort.length !== origLen) {
        throw new Error(`bare endpoint replacement ${hostPort} (${hostPort.length}) must equal original (${origLen})`)
    }
    return hostPort
}

function bareEndpointRe(endpoint) {
    return new RegExp(`(?<![\\w.])${escapeRegExp(endpoint)}(?![\\w.])`, "g")
}

/**
 * 扫描可改写目标（只读，不改 buffer）。
 * 返回 { sites:[{offset,length,text,kind,host}], byKind, lengthHistogram }。
 * kind: "url"（官方域名站点）| "bare-endpoint"（裸 IP:port）。
 */
export function scanTargets(buffer, { fromEndpoint = PREMISE_ENDPOINT, includeBare = true } = {}) {
    const text = buffer.toString("latin1")
    const sites = []

    const urlRe = new RegExp(OFFICIAL_URL_RE.source, "g")
    let match
    while ((match = urlRe.exec(text)) !== null) {
        sites.push({
            offset: match.index,
            length: match[0].length,
            text: match[0],
            kind: "url",
            host: match[1],
        })
        urlRe.lastIndex = match.index + match[0].length
    }

    if (includeBare && fromEndpoint) {
        const bareRe = bareEndpointRe(fromEndpoint)
        while ((match = bareRe.exec(text)) !== null) {
            sites.push({ offset: match.index, length: match[0].length, text: match[0], kind: "bare-endpoint", host: fromEndpoint })
        }
    }

    sites.sort((left, right) => left.offset - right.offset || left.length - right.length)
    const byKind = {}
    const lengthHistogram = {}
    for (const site of sites) {
        byKind[site.kind] = (byKind[site.kind] ?? 0) + 1
        const key = site.kind === "url" ? `url:${site.length}` : `bare:${site.length}`
        lengthHistogram[key] = (lengthHistogram[key] ?? 0) + 1
    }
    return { sites, byKind, lengthHistogram }
}

/**
 * 就地把站点改写成 `http://[000…@]hostPort`（url 模式）或 `hostPort`（bare 模式）。
 * 长度不足的站点**只记录不修改**（宁缺毋滥，禁止缩短）。
 * 返回 { changed:[{offset,length,original,replacement,kind}], skipped:[string] }。
 */
export function applyRewrite(buffer, { sites, hostPort, scheme = "http", fill = "0" } = {}) {
    if (!hostPort) throw new Error("hostPort is required")
    const min = minReplacementLength(hostPort, { scheme })
    const changed = []
    const skipped = []

    for (const site of sites) {
        let replacement
        try {
            replacement = site.kind === "url"
                ? buildPaddedReplacement(site.length, hostPort, { scheme, fill })
                : buildBareReplacement(site.length, hostPort)
        } catch (error) {
            skipped.push(`${site.text} (${site.kind}, ${site.length} B < ${site.kind === "url" ? min : ENDPOINT_LENGTH} B) — ${error.message}`)
            continue
        }
        if (Buffer.byteLength(replacement, "latin1") !== site.length) {
            throw new Error(`internal: replacement length ${replacement.length} != site length ${site.length} @ ${site.offset}`)
        }
        Buffer.from(replacement, "latin1").copy(buffer, site.offset)
        changed.push({ offset: site.offset, length: site.length, original: site.text, replacement, kind: site.kind })
    }

    changed.sort((left, right) => left.offset - right.offset)
    return { changed, skipped }
}

/** 改写后仍**可改写**的官方 URL 站点数（用于"残留 0 处"断言；过短站点不算残留）。 */
export function countRewriteableUrlSites(buffer, { hostPort, scheme = "http" } = {}) {
    const min = minReplacementLength(hostPort, { scheme })
    return scanTargets(buffer, { includeBare: false }).sites.filter(site => site.length >= min).length
}

/** 合并相邻/重叠范围。 */
export function mergeRanges(ranges) {
    const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])
    const merged = []
    for (const range of sorted) {
        const last = merged[merged.length - 1]
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
        else merged.push([...range])
    }
    return merged
}

/** 两个**等长** buffer 之间所有连续变化段（绝对偏移：base + 段内位置）。 */
export function byteDiffRanges(before, after, base = 0) {
    if (before.length !== after.length) {
        throw new Error(`byteDiffRanges needs equal length (${before.length} vs ${after.length})`)
    }
    const raw = []
    let start = -1
    for (let index = 0; index <= before.length; index += 1) {
        const differs = index < before.length && before[index] !== after[index]
        if (differs && start === -1) start = index
        if (!differs && start !== -1) {
            raw.push([base + start, base + index])
            start = -1
        }
    }
    return raw
}

/**
 * 计划改动的**精确**字节范围（只含真正变化的字节，且按"连续变化段"切分）。
 * 为什么要逐字节切分而不能用站点整段：等长替换里常有连续相同字节
 * （`https://x` → `http://0@x` 的第 0–3 字节 `http` 相同，第 6 字节 `/` 也相同），
 * 不切分会让"实际差异 = 计划范围"这条断言永远对不上，也会掩盖真正的越界写入。
 */
export function plannedRanges(changed) {
    const raw = []
    for (const entry of changed) {
        const before = Buffer.from(entry.original, "latin1")
        const after = Buffer.from(entry.replacement, "latin1")
        if (before.length !== after.length) {
            throw new Error(`internal: length mismatch at ${entry.offset} (${before.length} -> ${after.length})`)
        }
        raw.push(...byteDiffRanges(before, after, entry.offset))
    }
    return mergeRanges(raw)
}

/** 找出两个 buffer 之间所有不同的字节范围（逐字节比较，相邻合并）。 */
export function diffRanges(before, after) {
    if (before.length !== after.length) {
        throw new Error(`length changed: ${before.length} -> ${after.length}`)
    }
    const ranges = []
    let start = -1
    for (let index = 0; index < before.length; index += 1) {
        const differs = before[index] !== after[index]
        if (differs && start === -1) start = index
        if (!differs && start !== -1) {
            ranges.push([start, index])
            start = -1
        }
    }
    if (start !== -1) ranges.push([start, before.length])
    return mergeRanges(ranges)
}

/** 计划范围是否与实际差异范围完全一致。 */
export function rangesEqual(left, right) {
    if (left.length !== right.length) return false
    return left.every((range, index) => range[0] === right[index][0] && range[1] === right[index][1])
}
