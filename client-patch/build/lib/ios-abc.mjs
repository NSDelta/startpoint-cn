// B0 iOS 端点改写核心 · ABC 常量池分支（纯函数，无 IO）。
//
// 为什么单独一个模块：游戏 API 服务端基址在**游戏侧**（不是 SDK 侧）由 AS3 配置决定：
//   pinball/config/gbits/DevConfig_gf_android.as:21
//       apiServer = ApiServerKind.Custom("https","shijtswygamegf.leiting.com")
//   pinball/config/kind/ApiServerKindTools.as:80-107  getServerBasePath: case 9 (Custom) =>
//       param1.params[0] + "://" + param1.params[1]
//   pinball/config/core/DevConfig.as:658-661  getServerApiPath() => 上面 + get_apiBranchPath() + "/api/index.php"
// 编译进 ABC 后，这两个字符串是常量池里**两条相邻条目**（各带 U30 长度前缀，背靠背无空隙）：
//       ... 05 "https" | 1a "shijtswygamegf.leiting.com" ...
// 官方 1.8.4 主二进制实测：整串 `05 68 74 74 70 73 1a …` 唯一出现在 0x5a0e14b。
//
// 改写方式（长度守恒的关键）：**成对改写**，两条条目的总字节数不变 ⇒ 其后所有池条目偏移逐字节不变，
// 串池索引全部保持：
//       `05 "https"`(6 B) + `1a <26 B host>`(27 B) = 33 B
//    →  `04 "http"` (5 B) + `1b <27 B authority>`(28 B) = 33 B
// 其中 authority = `00000000@<LAN_IP>:8001`（8 个 0 做 userinfo 填充 + `@` + 18 字符 host:port；
// 真实地址只经 `--host`/`--port` 传入，仓库内一律用占位符）。
// 运行期拼出的基址 = `http://00000000@<LAN_IP>:8001`（userinfo 被 HTTP 客户端忽略）
// ⇒ `getApiBranchPath()` 对 Custom 返回 ""，最终 `…/api/index.php` 走明文 HTTP 打到内网服务端。

import { byteDiffRanges } from "./ios-endpoint.mjs"

export const ABC_API_SCHEME = "https"
export const ABC_API_HOST = "shijtswygamegf.leiting.com"
/** 官方 1.8.4 里该 scheme/host 对的起始偏移（断言基线）。 */
export const ABC_API_PAIR_OFFSET = 0x5a0e14b

/** U30（ABC 的变长长度前缀）编码。 */
export function encodeU30(value) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid U30 value: ${value}`)
    if (value < 0x80) return Buffer.from([value])
    const bytes = []
    let remaining = value
    bytes.push(remaining & 0x7f)
    remaining >>>= 7
    while (remaining > 0) {
        bytes.push((remaining & 0x7f) | 0x80)
        remaining >>>= 7
    }
    return Buffer.from(bytes.reverse())
}

/** 从 offset 读一条 U30 前缀字符串，返回 { length, prefixBytes, value, totalBytes }。 */
export function readPoolString(buffer, offset) {
    let length = 0
    let shift = 0
    let index = offset
    for (;;) {
        if (index >= buffer.length) throw new Error(`U30 prefix runs past end of buffer @ ${offset}`)
        const byte = buffer[index]
        length |= (byte & 0x7f) << shift
        index += 1
        if ((byte & 0x80) === 0) break
        shift += 7
    }
    const prefixBytes = index - offset
    return {
        length,
        prefixBytes,
        value: buffer.slice(index, index + length).toString("latin1"),
        totalBytes: prefixBytes + length,
    }
}

/** 找相邻的两条池条目：`scheme` 紧跟 `host`。返回 null 表示输入包不是这个布局。 */
export function findSchemeHostPair(buffer, { scheme = ABC_API_SCHEME, host = ABC_API_HOST } = {}) {
    const pattern = Buffer.concat([
        encodeU30(Buffer.byteLength(scheme, "latin1")),
        Buffer.from(scheme, "latin1"),
        encodeU30(Buffer.byteLength(host, "latin1")),
        Buffer.from(host, "latin1"),
    ])
    const offset = buffer.indexOf(pattern)
    if (offset === -1) return null
    const schemeEntry = readPoolString(buffer, offset)
    const hostEntry = readPoolString(buffer, offset + schemeEntry.totalBytes)
    const totalBytes = schemeEntry.totalBytes + hostEntry.totalBytes
    return { offset, schemeEntry, hostEntry, totalBytes, occurrences: countMatches(buffer, pattern) }
}

function countMatches(buffer, pattern) {
    let count = 0
    let index = buffer.indexOf(pattern)
    while (index !== -1) {
        count += 1
        index = buffer.indexOf(pattern, index + pattern.length)
    }
    return count
}

/** 构造给 `ApiServerKind.Custom` 第二参数用的 authority，恰好 byteLength 字节。 */
export function buildApiAuthority(hostPort, byteLength, { fill = "0" } = {}) {
    const pad = byteLength - 1 - Buffer.byteLength(hostPort, "latin1")
    if (pad < 0) throw new Error(`authority ${hostPort} cannot fit in ${byteLength} bytes`)
    return `${fill.repeat(pad)}@${hostPort}`
}

/**
 * 就地把 `Custom("https","shijtswygamegf.leiting.com")` 这对池条目改成指向 hostPort。
 * 只动这一对，且成对字节数守恒。返回 { applied, reason, offset, oldBytes, newBytes, totalBytes }。
 */
export function applyApiBaseRewrite(buffer, {
    hostPort,
    scheme = ABC_API_SCHEME,
    host = ABC_API_HOST,
    newScheme = "http",
    fill = "0",
} = {}) {
    const pair = findSchemeHostPair(buffer, { scheme, host })
    if (!pair) return { applied: 0, reason: `未找到 ${scheme} + ${host} 相邻池条目`, offset: null, totalBytes: 0 }
    if (pair.occurrences !== 1) {
        return { applied: 0, reason: `该池条目对出现 ${pair.occurrences} 次（期望唯一）`, offset: pair.offset, totalBytes: pair.totalBytes }
    }

    const authorityBytes = pair.hostEntry.length + (Buffer.byteLength(scheme, "latin1") - Buffer.byteLength(newScheme, "latin1"))
    const authority = buildApiAuthority(hostPort, authorityBytes, { fill })
    const schemePart = Buffer.concat([encodeU30(Buffer.byteLength(newScheme, "latin1")), Buffer.from(newScheme, "latin1")])
    const hostPart = Buffer.concat([encodeU30(Buffer.byteLength(authority, "latin1")), Buffer.from(authority, "latin1")])
    const replacement = Buffer.concat([schemePart, hostPart])

    if (replacement.length !== pair.totalBytes) {
        return {
            applied: 0,
            reason: `成对长度不守恒：${pair.totalBytes} B -> ${replacement.length} B`,
            offset: pair.offset,
            totalBytes: pair.totalBytes,
        }
    }

    // ⚠️ 必须 Buffer.from(...) 拷贝：Buffer.slice 是视图，写在 copy 之后会读到改后的字节
    const oldBytes = Buffer.from(buffer.slice(pair.offset, pair.offset + pair.totalBytes))
    replacement.copy(buffer, pair.offset)
    // 精确差异范围（只含真正变化的字节）——供"实际差异 = 计划范围"断言使用
    const diffRanges = byteDiffRanges(oldBytes, replacement, pair.offset)
    return {
        applied: 1,
        reason: `${scheme} + ${host} ⇒ ${newScheme} + ${authority}（${pair.totalBytes} B 守恒）`,
        offset: pair.offset,
        totalBytes: pair.totalBytes,
        diffRanges,
        oldBytes: oldBytes.toString("latin1"),
        newBytes: replacement.toString("latin1"),
        apiBase: `${newScheme}://${authority}`,
    }
}
