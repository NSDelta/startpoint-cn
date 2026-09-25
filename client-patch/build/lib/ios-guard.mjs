// 官方 iOS 包（AIR AOT）里"故意的致命中止"清除 —— 只保留 --guard-mode=launch 一处。
//
// 模式：`MOVZ X8,#0`（0xd2800008）之后 3 条指令内对 [X8] 写入 ⇒ 向地址 0 写入 = 故意崩溃
// （iOS 从不映射第 0 页）。重签后若不处理，启动即崩。
//
// `--guard-mode=launch` 只 NOP **0xb00c 一处**（启动计时器 guard，已验证不破坏 AIR 加载）；
// 其余"安全回退中止点"的批量 NOP（参考实现的 `all` 模式）**本工具不实现** ——
// 那是针对第三方服务器产物的调优，本任务只需要能启动的最小改动。

export const LAUNCH_GUARD_OFFSET = 0xb00c
export const LAUNCH_GUARD_EXPECTED = 0xb9000109 // STR W9,[X8]
export const NOP = 0xd503201f

/**
 * 清除启动 guard。返回 { applied, reason, offset }。
 * 签名不匹配 ⇒ 不改任何字节并把原因写清楚（调用方据此判定断言通过/失败）。
 */
export function clearLaunchGuard(buffer, mode = "launch") {
    if (mode === "none") return { applied: 0, reason: "guard-mode=none（未做任何 NOP）", offset: null }
    if (mode !== "launch") {
        throw new Error(`unsupported guard-mode: ${mode}（本工具只实现 launch / none）`)
    }
    if (LAUNCH_GUARD_OFFSET + 4 > buffer.length) {
        return { applied: 0, reason: "文件太短，0xb00c 越界", offset: LAUNCH_GUARD_OFFSET }
    }
    const actual = buffer.readUInt32LE(LAUNCH_GUARD_OFFSET)
    if (actual !== LAUNCH_GUARD_EXPECTED) {
        return {
            applied: 0,
            reason: `0xb00c 签名不匹配：期望 0x${LAUNCH_GUARD_EXPECTED.toString(16)}，实际 0x${actual.toString(16)}`,
            offset: LAUNCH_GUARD_OFFSET,
        }
    }
    buffer.writeUInt32LE(NOP, LAUNCH_GUARD_OFFSET)
    return { applied: 1, reason: "已 NOP 启动 guard", offset: LAUNCH_GUARD_OFFSET }
}

/**
 * 计数：文件里还有多少处"MOVZ X8,#0 后紧跟对 [X8] 的写"（=潜在致命中止）。
 * 只用于报告（不是补丁），让人知道还有多少处**没有**被处理。
 */
export function countAbortStores(buffer) {
    const len = buffer.length & ~3
    const isStoreToX8 = word => ((word >>> 5) & 31) === 8
        && [0xb9000000, 0xf9000000, 0x39000000, 0x79000000].includes((word & 0xffc00000) >>> 0)
    let count = 0
    for (let offset = 0; offset + 28 <= len; offset += 4) {
        if (buffer.readUInt32LE(offset) !== 0xd2800008) continue
        for (let step = 1; step <= 3; step += 1) {
            const word = buffer.readUInt32LE(offset + 4 * step)
            if (isStoreToX8(word)) { count += 1; break }
            if ((word & 31) === 8) break
        }
    }
    return count
}
