"use strict"

// B0/W2 补丁工具链回归：这套工具的红线是「等长覆盖」与「属性保持」，
// 所以测试只钉这两件事（外加一个曾经踩过的 diff 断言坑）：
// 1) 目标串比站点短时必须抛错/跳过，绝不缩短或搬移（容器长度前缀错位 = 启动黑屏）；
// 2) ABC 常量池那一对条目改写后，条目后面的字节必须一个都不动（串池索引全部保持）；
// 3) ZIP 引擎逐条保留 method / versionMadeBy / externalAttr（否则 AltStore 拒装）；
// 4) 「实际差异范围 = 计划范围」必须在替换串内部存在相同字节时依然成立。

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
    // 属性逐项保持——这是 AltStore 拒装 `jar uf0` 产物的根因
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
    const cli = path.join(__dirname, "..", "client-patch", "build", "patch-ios-ipa.mjs")
    const result = spawnSync(process.execPath, [cli, "--ipa", __filename, "--out", "out/nope.ipa"], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
    })
    assert.notEqual(result.status, 0)
    assert.match(String(result.stderr || result.stdout), /--host/)
})
