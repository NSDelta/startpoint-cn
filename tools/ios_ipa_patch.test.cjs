"use strict"

// B0/W2 补丁工具链回归：这套工具的红线是「等长覆盖」与「属性保持」，
// 所以测试只钉这两件事（外加一个曾经踩过的 diff 断言坑）：
// 1) 目标串比站点短时必须抛错/跳过，绝不缩短或搬移（容器长度前缀错位 = 启动黑屏）；
// 2) ABC 常量池那一对条目改写后，条目后面的字节必须一个都不动（串池索引全部保持）；
// 3) ZIP 引擎逐条保留 method / versionMadeBy / externalAttr（否则 AltStore 拒装）；
// 4) 「实际差异范围 = 计划范围」必须在替换串内部存在相同字节时依然成立。
// 5) --endpoint=none（越狱线）：**URL 一个字节都不许改**，且这条线必须由 patch-ipa.mjs 自己承载
//    —— 风险登记册 R27 明令禁止第二条 iOS 补丁代码路径（当年那份 tmp/make-jb-ipa.mjs 已收编）。
//    所以越狱线只在参数层与"逐字节未改动"上做断言，绝不再写第二个补丁实现。

const assert = require("node:assert/strict")
const test = require("node:test")

const HOST_PORT = "172.16.10.105:8001" // 18 字符，与任务单目标长度一致（刻意不用 192.168.x.y：仓库内禁写个人 IP）
const MIN_LEN = `http://${HOST_PORT}`.length // 25

test("replacement stays the same length or refuses to patch at all", async () => {
    const { buildPaddedReplacement, buildBareReplacement, minReplacementLength, ENDPOINT_LENGTH } =
        await import("../client-patch/build/lib/ios-endpoint.mjs")

    assert.equal(ENDPOINT_LENGTH, HOST_PORT.length)
    assert.equal(minReplacementLength(HOST_PORT), MIN_LEN)

    // 恰好放得下 ⇒ 不填充
    assert.equal(buildPaddedReplacement(MIN_LEN, HOST_PORT), `http://${HOST_PORT}`)
    // 放得下且有富余 ⇒ userinfo 填充补齐（服务端忽略 userinfo）
    const padded = buildPaddedReplacement(MIN_LEN + 4, HOST_PORT)
    assert.equal(padded, `http://000@${HOST_PORT}`)
    assert.equal(padded.length, MIN_LEN + 4)
    // 放不下 ⇒ 抛错，不给任何"变通"余地
    assert.throws(() => buildPaddedReplacement(MIN_LEN - 1, HOST_PORT), /longer than original|cannot fit|deficit/i)

    assert.equal(buildBareReplacement(ENDPOINT_LENGTH, HOST_PORT), HOST_PORT)
    assert.throws(() => buildBareReplacement(ENDPOINT_LENGTH + 1, HOST_PORT), /must equal original|length|等长/i)
})

test("short sites are skipped untouched, long sites are rewritten in place", async () => {
    const { applyRewrite, scanTargets, countRewriteableUrlSites, diffRanges, plannedRanges, rangesEqual } =
        await import("../client-patch/build/lib/ios-endpoint.mjs")

    const shortSite = "https://a.leiting.com" // 21 B < 25 B ⇒ 只能跳过
    const longSite = "https://loginslave1.roguelike.com/some/api/path" // 够长
    const original = Buffer.from(`${shortSite}\u0000${longSite}\u0000`, "latin1")
    const buffer = Buffer.from(original)

    const scan = scanTargets(buffer, { includeBare: false })
    assert.equal(scan.byKind.url, 2)
    assert.equal(countRewriteableUrlSites(buffer, { hostPort: HOST_PORT }), 1)

    const before = Buffer.from(buffer)
    const { changed, skipped } = applyRewrite(buffer, { sites: scan.sites, hostPort: HOST_PORT })

    assert.equal(changed.length, 1)
    assert.equal(skipped.length, 1)
    assert.match(skipped[0], /https:\/\/a\.leiting\.com/)
    // 长度严格守恒 + 跳过者逐字节不动
    assert.equal(buffer.length, original.length)
    assert.equal(buffer.subarray(0, shortSite.length).toString("latin1"), shortSite)
    // 改写结果：authority 换成目标端点，**path 原样保留**，整段长度与站点一致
    const rewritten = buffer.subarray(shortSite.length + 1, shortSite.length + 1 + longSite.length).toString("latin1")
    assert.equal(rewritten.length, longSite.length)
    assert.ok(rewritten.startsWith("http://"), rewritten)
    assert.ok(rewritten.includes(HOST_PORT), rewritten)
    assert.ok(rewritten.endsWith("/some/api/path"), rewritten)

    // 回归：替换串内部有相同字节（"http" 前缀等）时，"实际差异 = 计划范围" 仍须成立
    assert.ok(rangesEqual(diffRanges(before, buffer), plannedRanges(changed)))
    const plannedBytes = plannedRanges(changed).reduce((sum, [start, end]) => sum + (end - start), 0)
    assert.ok(plannedBytes < longSite.length, `interior identical bytes expected (${plannedBytes} vs ${longSite.length})`)
})

test("ABC pool pair rewrite keeps every following byte at its original offset", async () => {
    const { ABC_API_HOST, ABC_API_SCHEME, applyApiBaseRewrite, buildApiAuthority, encodeU30, findSchemeHostPair } =
        await import("../client-patch/build/lib/ios-abc.mjs")

    const entry = (value) => Buffer.concat([encodeU30(Buffer.byteLength(value, "latin1")), Buffer.from(value, "latin1")])
    const pool = Buffer.concat([
        entry("review"),
        entry(ABC_API_SCHEME),
        entry(ABC_API_HOST),
        entry("production"),
    ])
    const buffer = Buffer.concat([Buffer.from([0xaa, 0xbb]), pool, Buffer.from([0xcc, 0xdd])])
    const pairOffset = 2 + entry("review").length
    const tail = Buffer.from(buffer.subarray(pairOffset + entry(ABC_API_SCHEME).length + entry(ABC_API_HOST).length))

    const pair = findSchemeHostPair(buffer)
    assert.equal(pair.offset, pairOffset)
    assert.equal(pair.occurrences, 1)
    assert.equal(pair.totalBytes, entry(ABC_API_SCHEME).length + entry(ABC_API_HOST).length)

    const result = applyApiBaseRewrite(buffer, { hostPort: HOST_PORT })
    assert.equal(result.applied, 1)
    assert.equal(result.totalBytes, pair.totalBytes)
    assert.match(String(result.reason), /33 B|守恒/)

    // 成对字节数守恒 ⇒ 后面所有池条目的偏移不变
    assert.deepEqual(Buffer.from(buffer.subarray(pairOffset + pair.totalBytes)), tail)
    const scheme = buffer.subarray(pairOffset + 1, pairOffset + 1 + 4).toString("latin1")
    assert.equal(scheme, "http")
    const authority = buffer.subarray(pairOffset + 6, pairOffset + pair.totalBytes).toString("latin1")
    assert.equal(authority.length, ABC_API_HOST.length + 1) // "https"(5) -> "http"(4) 让出的 1 字节
    assert.equal(authority, buildApiAuthority(HOST_PORT, authority.length))
    assert.ok(authority.endsWith(HOST_PORT))

    // 找不到该布局时明确拒绝，而不是瞎改
    const missing = applyApiBaseRewrite(Buffer.from("nothing here", "latin1"), { hostPort: HOST_PORT })
    assert.equal(missing.applied, 0)
    assert.match(missing.reason, /未找到/)
})

test("zip rewrite preserves entry attributes and payloads round-trip", async () => {
    const { crc32, madeByHost, readEntryData, readZipEntries, replaceEntryData, unixMode, writeZipEntries } =
        await import("../client-patch/build/lib/zip-ipa.mjs")
    const { deflateRawSync } = require("node:zlib")

    const payload = Buffer.from("worldflipper-payload", "utf8")
    const deflated = deflateRawSync(payload, { level: 9 })
    // 模拟真包里的主二进制：method=8、madeBy host=19(OSX)、unix 权限 0755
    const entry = {
        name: "Payload/worldflipper.app/worldflipper",
        method: 8,
        flags: 0,
        mtime: 0x1234,
        mdate: 0x5678,
        crc: crc32(payload),
        csize: deflated.length,
        usize: payload.length,
        versionMadeBy: 0x1300,
        externalAttr: 0x81ed0000,
        raw: deflated,
    }

    const archive = writeZipEntries([entry])
    const parsed = readZipEntries(archive)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].name, entry.name)
    assert.equal(parsed[0].method, 8)
    assert.equal(parsed[0].versionMadeBy, 0x1300)
    assert.equal(madeByHost(parsed[0]), 19)
    assert.equal(parsed[0].externalAttr, 0x81ed0000)
    assert.equal(unixMode(parsed[0]), 0o100755)
    assert.deepEqual(readEntryData(parsed[0]), payload)

    const patchedPayload = Buffer.from("worldflipper-payload-PATCHED", "utf8")
    const { entry: replacedEntry, method } = replaceEntryData(parsed, entry.name, patchedPayload)
    assert.equal(method, 8)
    const rewritten = writeZipEntries([replacedEntry])
    const reparsed = readZipEntries(rewritten)
    assert.equal(reparsed.length, 1)
    assert.deepEqual(readEntryData(reparsed[0]), patchedPayload)
    // 属性逐项保持——纯 Node 回写（lib/zip-ipa.mjs）会原样搬运这些字段。
    // 注：任务书曾把这里写成「AltStore 拒装 jar uf0 产物的根因」，P10-A 实测**未复现**该现象
    //（B0 的 jar 产物与官方件逐条比对 3568 个 entry 的 method/madeBy/externalAttr/时间戳差异为 0），
    // 所以这条断言只保证「我们自己不回退属性」，不声称修好了 AltStore。
    assert.equal(reparsed[0].method, 8)
    assert.equal(reparsed[0].versionMadeBy, 0x1300)
    assert.equal(reparsed[0].externalAttr, 0x81ed0000)
    assert.equal(unixMode(reparsed[0]), 0o100755)
})

// 工具本体必须能被独立执行（CLI 场景），且 --host 缺失时拒绝输出：
// 目标端点只能来自参数，绝不内嵌任何实例地址。
test("patch CLI refuses to run without an explicit host", async () => {
    const { spawnSync } = require("node:child_process")
    const path = require("node:path")
    const cli = path.join(__dirname, "..", "client-patch", "build", "patch-ipa.mjs")
    const result = spawnSync(process.execPath, [cli, "--ipa", __filename, "--out", "out/nope.ipa"], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
    })
    assert.notEqual(result.status, 0)
    assert.match(String(result.stderr || result.stdout), /--host/)
})

// ═══════════════ 越狱线 --endpoint=none（R27：只有 patch-ipa.mjs 一条补丁路径）═══════════════
// 需求：越狱线只去闪退、**一个 URL 都不许改**（URL 交给越狱 dylib 在运行期接管），
// 所以 --endpoint=none 必须跳过 __cstring 站点与 ABC 常量池改写，同时保留六项功能补丁与 --guard-mode。
// 下面两条是纯参数层用例（快、无夹具依赖）；再下面两条要真 IPA，缺夹具时自动 skip。

const path = require("node:path")
const fs = require("node:fs")
const os = require("node:os")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")

const REPO = path.join(__dirname, "..")
const CLI = path.join(REPO, "client-patch", "build", "patch-ipa.mjs")
const FIXTURE = path.join(REPO, "apkipa", "iOS-1.8.4.ipa")
const FIXTURE_BYTES = 139212360 // 与 lib/ios-macho.mjs 的 OFFICIAL_IOS_184.ipaBytes 一致
const FIXTURE_OK = fs.existsSync(FIXTURE) && fs.statSync(FIXTURE).size === FIXTURE_BYTES
const FIXTURE_SKIP = FIXTURE_OK ? false : `缺少夹具 apkipa/iOS-1.8.4.ipa（官方 1.8.4，${FIXTURE_BYTES} B，仓库不跟踪）`
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex")

function runCli(argv) {
    return spawnSync(process.execPath, [CLI, ...argv], {
        cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300000,
    })
}
const cliLog = (res) => String(res.stdout || "") + String(res.stderr || "")

test("--endpoint=none 不再要求 --host/--port（给了也明确 warn 且不改），非法取值直接拒绝", () => {
    const missing = path.join(REPO, "apkipa", "__absent__.ipa")
    const dummyOut = path.join(os.tmpdir(), "ios-ipa-patch-dummy.ipa")

    // ① 不给 --host/--port（空格分隔写法也要能解析）：参数校验必须放行，一路走到"找不到输入 IPA"。
    //    若 --host 仍是硬要求，这里会得到 "需要 --ipa(或 --bin) --host --port --out" —— 那正是回归。
    const bare = runCli(["--ipa", missing, "--out", dummyOut, "--endpoint", "none"])
    assert.notEqual(bare.status, 0)
    assert.match(cliLog(bare), /找不到输入 IPA/)
    assert.doesNotMatch(cliLog(bare), /--host/)

    // ② 给了 --host/--port：必须 warn，且明确声明本模式不改写任何 URL
    const withHost = runCli(["--ipa", missing, "--host", "172.16.10.105", "--port", "8001", "--out", dummyOut, "--endpoint=none"])
    assert.notEqual(withHost.status, 0)
    assert.match(cliLog(withHost), /WARN --endpoint=none：已忽略 --host\/--port/)
    assert.match(cliLog(withHost), /不改写任何 URL/)

    // ③ 非法取值：立刻报错退出（绝不静默退回 rewrite —— 那会把越狱线的包悄悄改成连内网端点）
    const bogus = runCli(["--ipa", __filename, "--out", dummyOut, "--endpoint=bogus"])
    assert.notEqual(bogus.status, 0)
    assert.match(cliLog(bogus), /--endpoint 只接受 rewrite\|none/)
    // 默认（缺省）仍必须是 rewrite：老命令缺 --host 的报错文案不变
    const dflt = runCli(["--ipa", __filename, "--out", dummyOut])
    assert.match(cliLog(dflt), /--host/)
})

test("--endpoint=none 的真 IPA 产物：URL 逐字节未动 + 守卫生效 + ZIP 结构合理", { skip: FIXTURE_SKIP }, async () => {
    const { readZipEntries, readEntryData, unixMode } = await import("../client-patch/build/lib/zip-ipa.mjs")
    const { scanTargets, countRewriteableUrlSites, diffRanges } = await import("../client-patch/build/lib/ios-endpoint.mjs")
    const { findMainBinaryEntry } = await import("../client-patch/build/lib/ios-macho.mjs")
    const { ABC_API_PAIR_OFFSET } = await import("../client-patch/build/lib/ios-abc.mjs")

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-ipa-none-"))
    const outIpa = path.join(outDir, "jb-none.ipa")
    try {
        // 越狱线 SOP：不给 --host/--port（URL 由 dylib 接管），守卫走 launch
        const res = runCli(["--ipa", "apkipa/iOS-1.8.4.ipa", "--out", outIpa, "--endpoint=none", "--guard-mode=launch"])
        const log = cliLog(res)
        assert.equal(res.status, 0, log.slice(-4000))
        assert.ok(!/\[FAIL\]/.test(log), log.slice(-4000))
        // 工具自己的**新增正向断言**必须逐条出现（而不是把旧断言 if 掉）
        for (const needle of [
            "endpoint=none：URL 站点改写数 = 0",
            "endpoint=none：ABC 常量池区域 sha256 = 基线值",
            "endpoint=none：可改写旧站点残留 = 基线值 137 处",
            "endpoint=none：新端点出现次数 = 0 处",
            "endpoint=none：官方域名出现次数 = 基线值",
            "endpoint=none：官方 URL 站点窗口 ∪ ABC 池窗口",
            "endpoint=none：回读 ABC 池区域 sha256 = 基线值",
            "endpoint=none：回读可改写旧站点残留 = 基线值 137 处",
            "0 FAIL",
        ]) assert.ok(log.includes(needle), `缺少断言输出：${needle}`)

        // ── 独立复核：不引用工具自己的窗口表，直接比对输入/输出两个 IPA 的主二进制 ──
        const inBin = readEntryData(findMainBinaryEntry(readZipEntries(fs.readFileSync(FIXTURE))))
        const outEntries = readZipEntries(fs.readFileSync(outIpa))
        const outMain = findMainBinaryEntry(outEntries)
        const outBin = readEntryData(outMain)

        assert.equal(outEntries.length, 3568, "ZIP 条目数应与官方件一致（结构未被破坏）")
        assert.equal(outBin.length, inBin.length, "主二进制长度必须严格不变")
        assert.notEqual(sha256(outBin), sha256(inBin), "功能补丁应确有写入（否则本用例是空转）")

        // ① 150 个 URL 站点：偏移/长度/字节三种口径全部一致
        const sites = scanTargets(inBin, { includeBare: false }).sites
        assert.equal(sites.length, 150)
        for (const site of sites) {
            assert.deepEqual(outBin.subarray(site.offset, site.offset + site.length),
                inBin.subarray(site.offset, site.offset + site.length), `URL 站点 @${site.offset} 被改动了`)
        }
        assert.equal(countRewriteableUrlSites(outBin, { hostPort: "0".repeat(18) }), 137)
        // ② ABC 常量池 33 B 逐字节一致
        assert.deepEqual(outBin.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + 33),
            inBin.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + 33), "ABC 常量池被改动了")
        // ③ 守卫仍生效（tmp 脚本当年那条硬校验）
        assert.equal(outBin.readUInt32LE(0xb00c), 0xd503201f, "0xb00c 未被 NOP —— 越狱线的去闪退失效")
        // ④ 逐字节：所有改动字节都不得落在任何 URL 站点窗口或 ABC 池窗口内
        const forbidden = [...sites.map(s => [s.offset, s.offset + s.length]), [ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + 33]]
        const diff = diffRanges(inBin, outBin)
        assert.ok(diff.length > 0)
        const violated = diff.filter(([a, b]) => forbidden.some(([s, e]) => a < e && b > s))
        assert.deepEqual(violated, [], `有改动落在 URL/ABC 窗口内：${JSON.stringify(violated)}`)
        // ⑤ ZIP 结构：主 entry 属性保持（否则 AltStore 拒装）
        assert.equal(outMain.method, 8)
        assert.equal(outMain.versionMadeBy, 0x1300)
        assert.equal(outMain.externalAttr, 0x81ed0000)
        assert.equal(unixMode(outMain), 0o100755)
    } finally {
        fs.rmSync(outDir, { recursive: true, force: true })
    }
})

test("默认模式（--endpoint=rewrite）老命令仍改写 138 处端点", { skip: FIXTURE_SKIP }, () => {
    const [host, port] = HOST_PORT.split(":")
    const res = runCli(["--ipa", "apkipa/iOS-1.8.4.ipa", "--host", host, "--port", port,
        "--out", path.join(os.tmpdir(), "ios-ipa-patch-rewrite.ipa"), "--guard-mode=launch", "--dry-run"])
    const log = cliLog(res)
    assert.equal(res.status, 0, log.slice(-4000))
    assert.ok(log.includes("URL 站点改写数 = 可改写站点数"))
    assert.ok(log.includes("补丁后：新端点 = 138 处"), log.slice(-2000))
    assert.ok(log.includes("0 FAIL"), log.slice(-2000))
})
