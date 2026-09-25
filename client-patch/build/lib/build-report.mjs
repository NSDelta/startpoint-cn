// 构建报告 + 断言收集器 —— A1b 新增（lib/** 归 P10-A）。
//
// 红线：断言**硬失败**。任何一条 FAIL 都会让 patch-ipa.mjs 先落盘构建报告、再以退出码 2 结束，
// 绝不允许"带伤出包"（B0 的教训：派生件静默丢了六项功能补丁，产物看上去一切正常）。

import { writeFileSync } from "node:fs"
import { createHash } from "node:crypto"

/** 大文件哈希（流式没必要：调用方手上已经是完整 Buffer）。 */
export function sha256Hex(buffer) {
    return createHash("sha256").update(buffer).digest("hex")
}

/** 断言收集器：边收边打 `[PASS]/[FAIL] name — detail`，最后统一取失败清单。 */
export function createAssertions({ log = console.log } = {}) {
    const list = []
    return {
        list,
        get failed() {
            return list.filter((item) => !item.ok)
        },
        get passed() {
            return list.filter((item) => item.ok)
        },
        check(name, ok, detail = "") {
            const entry = { name, ok: !!ok, detail: String(detail) }
            list.push(entry)
            log(`  ${entry.ok ? "[PASS]" : "[FAIL]"} ${name}${entry.detail ? ` — ${entry.detail}` : ""}`)
            return entry.ok
        },
    }
}

/** `[start, end)` → `0x…..0x…`（报告里人眼可读）。 */
export function hexRange(range) {
    return `0x${range[0].toString(16)}..0x${range[1].toString(16)}`
}

export function hexRanges(ranges, limit = 0) {
    const shown = limit > 0 ? ranges.slice(0, limit) : ranges
    const text = shown.map(hexRange).join(" ")
    return ranges.length > shown.length ? `${text} …(+${ranges.length - shown.length})` : text
}

/**
 * 落盘 `<outPath>.build-report.json`（与产物同目录同名，便于"产物 + 证据"成对交付）。
 * 返回 { file, bytes }。
 */
export function writeBuildReport(outPath, report) {
    const file = `${outPath}.build-report.json`
    const text = `${JSON.stringify(report, null, 1)}\n`
    writeFileSync(file, text)
    return { file, bytes: Buffer.byteLength(text, "utf8") }
}
