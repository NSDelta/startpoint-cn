"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const assetPlugin = require("../src/routes/cn/asset").default
const assetInTitlePlugin = require("../src/routes/cn/assetInTitle").default
const cdnFilesPlugin = require("../src/routes/cn/cdnFiles").default
const { getIosArchiveLocations, prepareIosCompat, resolveIosEntityList } = require("../src/content/cdn/ios-compat")

const SHA = "a".repeat(64)

function archive(relativePath, compressedBytes, order = 1) {
    return { relativePath, compressedBytes, sha256: SHA, layer: "common", order }
}

function edge(fromVersion, toVersion, archives) {
    return {
        fromVersion,
        toVersion,
        platform: "android",
        assetSizeKind: "fulfill",
        archives,
    }
}

function createSnapshot() {
    return Object.freeze({
        cdn: Object.freeze({
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: "1.4.54",
            installedBytes: 987_654,
            entityListsRelativePath: "EntityLists/android_medium.csv",
            edges: Object.freeze([
                edge(null, "1.4.0", [archive("archive-common-full/base.zip", 100)]),
                edge("1.4.0", "1.4.53", [archive("archive-common-diff/first.zip", 53)]),
                edge("1.4.53", "1.4.54", [archive("archive-common-diff/latest.zip", 54)]),
            ]),
        }),
    })
}

const IOS_COMPAT = { enabled: true, apiHost: "10.0.0.5:8001", apiScheme: "http" }

// 真实生产格式：官方实体表没有表头，首行即数据行
// （.cdn/cn/EntityLists/10939-ios_medium.csv 首行为
//  "production/upload/00/00401ec42e20c5704dd17f0c612519bf65e586,1.4.0,353,...,common"）。
// Android 侧规范解析器（catalog-builder.parseEntityListInstalledBytes）早就把表头当可选；
// iOS 侧曾强制首行为表头 ⇒ 真实实体表一律被判非法。夹具与生产格式一致，避免再次漏网。
// ios_medium.csv 的 size 列之和 = 3000（installedBytes 语义）
const IOS_ENTITY_LIST = [
    "pinball-a,1.4.0,1000,hash-a,common",
    "pinball-b,1.4.0,2000,hash-b,common",
].join("\n")

// 带显式表头的等价实体表（历史夹具格式）：表头必须被跳过，不得计入 size 之和。
const IOS_ENTITY_LIST_WITH_HEADER = [
    "path,version,size,hash,layer",
    ...IOS_ENTITY_LIST.split("\n"),
].join("\n")

function buildIosFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-test-"))
    const cn = path.join(tempRoot, "cn")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    // 覆盖 Catalog 全部 edge（full + 两个 diff），保证 iOS 视图 ready
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.53-1.4.54-1-cccccc.zip"), Buffer.from("latest-diff"))
    // 诱饵：匹配不到任何版本的边 → 不在 iOS 目录视图/allowlist 中
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-9.9.9-1-deadbe.zip"), Buffer.from("decoy"))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), IOS_ENTITY_LIST)
    return { tempRoot, cn }
}

// 用给定实体表内容覆盖 fixture 的 ios_medium.csv。
// 每个 fixture 的 cdnRoot 唯一（mkdtemp）⇒ ios-compat 的模块级缓存互不干扰。
function buildIosFixtureWithEntityList(content) {
    const fixture = buildIosFixture()
    fs.writeFileSync(path.join(fixture.cn, "EntityLists", "ios_medium.csv"), content)
    return fixture
}

async function createAssetApp(options = {}) {
    const app = Fastify({ logger: false })
    app.register(assetPlugin, {
        prefix: "/asset",
        getSnapshot: options.getSnapshot ?? (() => createSnapshot()),
        env: options.env ?? {},
        warn: options.warn,
        logError: options.logError,
        resolveListenHost: options.resolveListenHost,
        iosCompat: options.iosCompat,
    })
    await app.ready()
    return app
}

test("version_info mirrors Android semantics: empty recovery list and installed bytes", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 200)
    const data = response.json().data
    // 不宣称逐文件可恢复：files_list 指向空恢复清单
    assert.ok(data.files_list.includes("/recovery/empty.csv"))
    // total_size 使用未压缩 installedBytes（实体表 size 列之和），而非 ZIP 压缩下载量
    assert.equal(data.total_size, 3000)
    assert.ok(data.base_url.startsWith("http://10.0.0.5:8001/"))
})

test("version_info returns explicit unavailable when ios assets are missing", async t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-empty-"))
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("degraded ios view: an edge without an ios archive keeps serving a plan (never android platform archives)", async t => {
    // fixture 缺少 1.4.53 -> 1.4.54 的 iOS diff（Catalog 中存在该 diff edge）。
    // 旧语义：整条 iOS 视图判 unavailable ⇒ 客户端拿 503（真机 m06219 的「h503 / 卡在半路」）。
    // 新语义：视图 ready 但 degraded —— 该 edge 只带 common/quality，其余 edge 照常走 iOS 归档。
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-edge-"))
    const cn = path.join(tempRoot, "cn")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), IOS_ENTITY_LIST)
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const state = prepareIosCompat(createSnapshot(), cn)
    assert.equal(state.kind, "ready")
    assert.equal(state.degraded, true)
    assert.equal(state.missingPlatformEdges, 1)

    const info = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(info.statusCode, 200)
    assert.equal(info.json().data.total_size, 3000)

    // 初始客户端（无 RES_VER）：full 带 iOS full 归档；1.4.53→1.4.54 这条 diff 只剩 common 归档。
    const plan = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(plan.statusCode, 200)
    const data = plan.json().data
    const locations = [
        ...(data.full ? data.full.archive : []),
        ...(data.diff ?? []).flatMap(item => item.archive),
    ].map(item => item.location)
    assert.ok(locations.some(location => location.endsWith("archive-ios-full/pinball-1.4.0-1-abc123.zip")))
    assert.ok(locations.some(location => location.endsWith("archive-ios-diff/pinball-1.4.0-1.4.53-1-def456.zip")))
    assert.ok(locations.some(location => location.endsWith("archive-common-diff/latest.zip")))
    // 缺 iOS 归档的那条 edge 不再带 platform 层；任何 Android platform 归档都不得出现在 iOS 计划里
    assert.ok(!locations.some(location => location.includes("archive-ios-diff/pinball-1.4.53-1.4.54")))
    assert.ok(!locations.some(location => location.includes("archive-android-")))
})

test("get_path plans ios-full archives for an iOS device and android archives otherwise", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const iosResponse = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(iosResponse.statusCode, 200)
    const iosData = iosResponse.json().data
    assert.equal(iosData.full.version, "1.4.0")
    const fullArchive = iosData.full.archive.find(item => item.location.includes("archive-ios-full/pinball-1.4.0-1-abc123.zip"))
    assert.ok(fullArchive)
    assert.equal(
        fullArchive.sha256,
        crypto.createHash("sha256").update(Buffer.from("full-archive")).digest("hex"),
    )
    assert.ok(iosData.full.archive[0].location.startsWith("http://10.0.0.5:8001/patch/cn/"))

    // Android 设备不受影响（仍然用 android 归档）
    const androidResponse = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "2" },
        payload: {},
    })
    assert.equal(androidResponse.statusCode, 200)
    assert.ok(androidResponse.json().data.full.archive[0].location.includes("archive-common-full/base.zip"))
})

test("get_path returns explicit unavailable when ios assets are missing", async t => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-empty-"))
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("version_info returns unavailable when the iOS entity list is duplicated", async t => {
    const fixture = buildIosFixture()
    fs.writeFileSync(path.join(fixture.cn, "EntityLists", "extra-ios_medium.csv"), IOS_ENTITY_LIST)
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("version_info returns unavailable when the iOS entity list is malformed", async t => {
    const fixture = buildIosFixture()
    fs.writeFileSync(path.join(fixture.cn, "EntityLists", "ios_medium.csv"), "not,a,valid,entity,list")
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001" },
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE")
})

test("cdnFiles serves only allowlisted archive-ios-* files and honors Range", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = Fastify({ logger: false })
    app.register(cdnFilesPlugin, {
        getSnapshot: () => createSnapshot(),
        paths: {
            cdnRoot: fixture.cn,
            patchesRoot: path.join(fixture.tempRoot, "patches"),
        },
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    // allowlist 内（冻结 iOS 目录视图解析出的归档）→ 200
    const full = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-full/pinball-1.4.0-1-abc123.zip" })
    assert.equal(full.statusCode, 200)
    assert.equal(full.body, "full-archive")

    // Range → 206
    const ranged = await app.inject({
        method: "GET",
        url: "/patch/cn/archive-ios-full/pinball-1.4.0-1-abc123.zip",
        headers: { range: "bytes=0-3" },
    })
    assert.equal(ranged.statusCode, 206)
    assert.equal(ranged.body, "full")
    assert.match(ranged.headers["content-range"], /^bytes 0-3\/12$/)

    // 目录名前缀匹配但不在 allowlist（未解析来源）→ 404，不直接放行
    const decoy = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-diff/pinball-1.4.0-9.9.9-1-deadbe.zip" })
    assert.equal(decoy.statusCode, 404)
})

test("title entry (assetintitle) keeps responding with iosCompat enabled", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = Fastify({ logger: false })
    const { registerCnMsgpackOnSend } = require("../src/routes/cn/msgpack")
    registerCnMsgpackOnSend(app)
    app.register(assetInTitlePlugin, {
        prefix: "/assetintitle",
        getSnapshot: () => createSnapshot(),
        env: { CDN_DIR: fixture.tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" },
        resolveListenHost: () => "10.0.0.5",
    })
    await app.ready()
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/assetintitle/version_info_in_title",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 200)
    assert.ok(Buffer.isBuffer(response.rawPayload), "msgpack payload expected")
    assert.ok(response.rawPayload.length > 0)
})

// ---------------------------------------------------------------------------
// iOS 视图不可用时的 get_path 兜底（src/routes/cn/asset.ts）：
//   - 计划不含任何归档（客户端已在快照目标版本）→ 200，响应里没有任何归档 URL；
//   - 计划含归档 / 计划无法判定 → 维持 503 IOS_ASSETS_UNAVAILABLE（绝不降级下发 Android 归档）。
// ---------------------------------------------------------------------------

const ANDROID_BASE = "http://10.0.0.5:8001/patch/cn"

// 空 CDN 目录（无 cn/ 子树）⇒ prepareIosCompat 判定 unavailable
function createUnavailableIosRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-fallback-"))
}

function localEnv(tempRoot) {
    return { CDN_DIR: tempRoot, CN_LISTEN_PORT: "8001", CN_PUBLIC_HOST: "10.0.0.5" }
}

async function createUnavailableIosApp(t) {
    const tempRoot = createUnavailableIosRoot()
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
    const app = await createAssetApp({
        env: localEnv(tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())
    return app
}

// servertime 每请求取 Date.now()，是唯一时钟字段；比较逐字节相等前归零。
function normalizeBody(body) {
    const parsed = JSON.parse(body)
    if (parsed.data_headers && "servertime" in parsed.data_headers) parsed.data_headers.servertime = 0
    return JSON.stringify(parsed)
}

function bodyMentionsArchives(value) {
    const text = JSON.stringify(value)
    return text.includes(".zip") || text.includes("archive-")
}

test("get_path rejects DEVICE:1 while iosCompat is disabled (pre-fix behavior preserved)", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const app = await createAssetApp({
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
    })
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, "UNSUPPORTED_PLATFORM")
})

test("get_path Android bodies are unchanged by the iosCompat switch (frozen protocol plan)", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))
    const env = localEnv(fixture.tempRoot)

    const disabled = await createAssetApp({ env, resolveListenHost: () => "10.0.0.5" })
    const enabled = await createAssetApp({ env, resolveListenHost: () => "10.0.0.5", iosCompat: IOS_COMPAT })
    t.after(() => disabled.close())
    t.after(() => enabled.close())

    const cases = [{ device: "2" }, {}, { device: "android" }, { device: "2", res_ver: "1.4.54" }]
    for (const headers of cases) {
        const off = await disabled.inject({ method: "POST", url: "/asset/get_path", headers, payload: {} })
        const on = await enabled.inject({ method: "POST", url: "/asset/get_path", headers, payload: {} })
        assert.equal(off.statusCode, 200, JSON.stringify(headers))
        assert.equal(on.statusCode, 200, JSON.stringify(headers))
        // Android 设备在两种开关下必须逐字节相同（唯一时钟字段 servertime 归零后比较）
        assert.equal(normalizeBody(on.body), normalizeBody(off.body), JSON.stringify(headers))
    }

    // 冻结 Android 计划的 data 体（无时钟字段，可逐字节冻结）
    const initial = await disabled.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "2" },
        payload: {},
    })
    assert.deepEqual(initial.json().data, {
        info: {
            client_asset_version: "",
            target_asset_version: "1.4.54",
            eventual_target_asset_version: "1.4.54",
            is_initial: true,
        },
        full: {
            version: "1.4.0",
            archive: [{ location: `${ANDROID_BASE}/archive-common-full/base.zip`, size: 100, sha256: SHA }],
        },
        diff: [
            {
                original_version: "1.4.0",
                version: "1.4.53",
                archive: [{ location: `${ANDROID_BASE}/archive-common-diff/first.zip`, size: 53, sha256: SHA }],
            },
            {
                original_version: "1.4.53",
                version: "1.4.54",
                archive: [{ location: `${ANDROID_BASE}/archive-common-diff/latest.zip`, size: 54, sha256: SHA }],
            },
        ],
        asset_version_hash: "",
        delayed_assets_size: 0,
    })

    const upToDate = await disabled.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "2", res_ver: "1.4.54" },
        payload: {},
    })
    assert.deepEqual(upToDate.json().data, {
        info: {
            client_asset_version: "1.4.54",
            target_asset_version: "1.4.54",
            eventual_target_asset_version: "1.4.54",
            is_initial: false,
        },
        full: null,
        diff: null,
        asset_version_hash: "",
        delayed_assets_size: 0,
    })
})

test("get_path serves an empty plan to an iOS device when the ios view is unavailable", async t => {
    const app = await createUnavailableIosApp(t)

    for (const device of ["1", "ios"]) {
        const response = await app.inject({
            method: "POST",
            url: "/asset/get_path",
            headers: { device, res_ver: "1.4.54" },
            payload: {},
        })
        assert.equal(response.statusCode, 200, device)
        const data = response.json().data
        assert.equal(data.info.is_initial, false, device)
        assert.equal(data.info.client_asset_version, "1.4.54", device)
        assert.equal(data.info.target_asset_version, "1.4.54", device)
        assert.equal(data.full, null, device)
        assert.equal(data.diff, null, device)
        // 空计划不得包含任何归档 URL（否则就是把 Android platform 归档发给了 iOS）
        assert.equal(bodyMentionsArchives(data), false, device)
        assert.equal(response.json().data_headers.asset_update, true, device)
    }
})

test("get_path keeps 503 for an iOS device when the unavailable ios view would download archives", async t => {
    const app = await createUnavailableIosApp(t)

    // RES_VER 落后于目标版本 ⇒ 增量计划含归档；无 RES_VER ⇒ initial 计划含 full 归档
    const cases = [
        { device: "1", res_ver: "1.4.0" },
        { device: "ios", res_ver: "1.4.53" },
        { device: "1" },
    ]
    for (const headers of cases) {
        const response = await app.inject({ method: "POST", url: "/asset/get_path", headers, payload: {} })
        assert.equal(response.statusCode, 503, JSON.stringify(headers))
        assert.equal(response.json().code, "IOS_ASSETS_UNAVAILABLE", JSON.stringify(headers))
        assert.equal(bodyMentionsArchives(response.json()), false, JSON.stringify(headers))
    }
})

test("get_path keeps 503 (never a new 400) when the ios view is unavailable and RES_VER is unknown", async t => {
    const app = await createUnavailableIosApp(t)

    const ios = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1", res_ver: "9.9.9" },
        payload: {},
    })
    assert.equal(ios.statusCode, 503)
    assert.equal(ios.json().code, "IOS_ASSETS_UNAVAILABLE")

    // 对照：Android 设备同样的未知 RES_VER 仍然是 400 UNKNOWN_CURRENT_VERSION（不受影响）
    const android = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "2", res_ver: "9.9.9" },
        payload: {},
    })
    assert.equal(android.statusCode, 400)
    assert.equal(android.json().code, "UNKNOWN_CURRENT_VERSION")
})

test("get_path logs a warning when it falls back to an empty plan on an unavailable ios view", async t => {
    const tempRoot = createUnavailableIosRoot()
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const lines = []
    const app = Fastify({ logger: { level: "warn", stream: { write: line => lines.push(String(line)) } } })
    app.register(assetPlugin, {
        prefix: "/asset",
        getSnapshot: () => createSnapshot(),
        env: localEnv(tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    const response = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1", res_ver: "1.4.54" },
        payload: {},
    })
    assert.equal(response.statusCode, 200)
    assert.ok(
        lines.some(line => line.includes("serving an empty asset update plan")),
        `expected an empty-plan fallback warning, got: ${lines.join("")}`,
    )
    assert.ok(
        lines.some(line => line.includes("missing ios archive directories") || line.includes("missing ios entity list")),
        `expected the unavailable reason in the warning, got: ${lines.join("")}`,
    )
})

// ---------------------------------------------------------------------------
// 实体表格式回归（真实生产格式 = 无表头）：
// src/content/cdn/ios-compat.ts 曾强制实体表首行为 "path,version,size,hash,layer"，
// 而官方实体表没有表头 ⇒ readEntityListInstalledBytes 恒返回 null ⇒ iOS 视图恒为
// unavailable("invalid ios entity list") ⇒ 所有需要归档的 iOS get_path 恒 503
// IOS_ASSETS_UNAVAILABLE（iOS 资源更新功能永远不可用）。
// 现改为与 Android 同源：复用 catalog-builder.parseEntityListInstalledBytes。
// ---------------------------------------------------------------------------

test("real (header-less) ios entity list keeps the ios view ready and sums the size column", async t => {
    const fixture = buildIosFixture() // 默认夹具即真实生产格式：无表头、5 列
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    // 解析层：ready 且 installedBytes = size 列之和（未压缩字节），不是 ZIP 压缩下载量
    const state = prepareIosCompat(createSnapshot(), fixture.cn)
    assert.equal(state.kind, "ready")
    assert.equal(state.installedBytes, 3000)

    const app = await createAssetApp({
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const info = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(info.statusCode, 200)
    assert.equal(info.json().data.total_size, 3000)

    // 需要归档的 iOS 请求不再 503（旧实现这里恒为 503 IOS_ASSETS_UNAVAILABLE）
    const plan = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(plan.statusCode, 200)
    assert.ok(
        plan.json().data.full.archive.some(item =>
            item.location.includes("archive-ios-full/pinball-1.4.0-1-abc123.zip")),
        `expected an ios-full archive in the plan, got: ${plan.body}`,
    )
})

test("a header-ed ios entity list stays ready with the same installedBytes (header is skipped)", async t => {
    const fixture = buildIosFixtureWithEntityList(IOS_ENTITY_LIST_WITH_HEADER)
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    // 表头不得计入 size 之和：仍为 3000（而不是表头被当数据行后的非法/多加）
    const state = prepareIosCompat(createSnapshot(), fixture.cn)
    assert.equal(state.kind, "ready")
    assert.equal(state.installedBytes, 3000)

    const app = await createAssetApp({
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const info = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(info.statusCode, 200)
    assert.equal(info.json().data.total_size, 3000)
})

test("a UTF-8 BOM header-less ios entity list is tolerated", async t => {
    const fixture = buildIosFixtureWithEntityList(`\uFEFF${IOS_ENTITY_LIST}`)
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const state = prepareIosCompat(createSnapshot(), fixture.cn)
    assert.equal(state.kind, "ready")
    assert.equal(state.installedBytes, 3000)

    const app = await createAssetApp({
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const info = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(info.statusCode, 200)
    assert.equal(info.json().data.total_size, 3000)
})

// ---------------------------------------------------------------------------
// 目录名漂移兜底（真机 m06219）：快照清单写 EntityLists/10939-android_medium.csv，
// 而社区 CDN 磁盘上的目录叫 entities/ —— 不是大小写差异，是另一个名字，
// readdir 直接 ENOENT ⇒ 整个 iOS 视图被判「没有 iOS 实体表」⇒ iOS 资源更新恒 503。
// ---------------------------------------------------------------------------

test("entity list directory drift (entities/ instead of EntityLists/) still resolves the ios entity list", async t => {
    const fixture = buildIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))
    fs.renameSync(path.join(fixture.cn, "EntityLists"), path.join(fixture.cn, "entities"))

    assert.equal(resolveIosEntityList(createSnapshot().cdn, fixture.cn), "entities/ios_medium.csv")

    const state = prepareIosCompat(createSnapshot(), fixture.cn)
    assert.equal(state.kind, "ready")
    assert.equal(state.installedBytes, 3000)

    const app = await createAssetApp({
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    t.after(() => app.close())

    const info = await app.inject({
        method: "POST",
        url: "/asset/version_info",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(info.statusCode, 200)
    assert.equal(info.json().data.total_size, 3000)

    const plan = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(plan.statusCode, 200)
    assert.ok(
        plan.json().data.full.archive.some(item =>
            item.location.includes("archive-ios-full/pinball-1.4.0-1-abc123.zip")),
        `expected an ios-full archive in the plan, got: ${plan.body}`,
    )
})

test("a degraded ios view still allowlists every ios archive it references (cdnFiles 200)", async t => {
    // 与 degraded 用例同一夹具：缺 1.4.53 -> 1.4.54 的 iOS diff ⇒ 视图 ready+degraded。
    // 关键：degraded 不得把白名单清空——否则计划里引用的 iOS 归档全部 404（真机就是下到 5.96% 停住）。
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-degraded-files-"))
    const cn = path.join(tempRoot, "cn")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), IOS_ENTITY_LIST)
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

    const app = Fastify({ logger: false })
    app.register(cdnFilesPlugin, {
        getSnapshot: () => createSnapshot(),
        paths: { cdnRoot: cn, patchesRoot: path.join(tempRoot, "patches") },
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    const full = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-full/pinball-1.4.0-1-abc123.zip" })
    assert.equal(full.statusCode, 200)
    assert.equal(full.body, "full-archive")

    const diff = await app.inject({ method: "GET", url: "/patch/cn/archive-ios-diff/pinball-1.4.0-1.4.53-1-def456.zip" })
    assert.equal(diff.statusCode, 200)
    assert.equal(diff.body, "diff-archive")
})

test("invalid ios entity list rows yield unavailable(invalid ios entity list), never a throw", async t => {
    const cases = [
        { label: "four columns", content: "pinball-a,1.4.0,1000,hash-a" },
        { label: "non-numeric size column", content: "pinball-a,1.4.0,abc,hash-a,common" },
        { label: "empty size column", content: "pinball-a,1.4.0,,hash-a,common" },
    ]
    for (const item of cases) {
        const fixture = buildIosFixtureWithEntityList(item.content)
        t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

        // 解析层：绝不向上抛（parseEntityListInstalledBytes 抛 CatalogValidationError，
        // 必须被 readEntityListInstalledBytes 吞掉）→ 一律 unavailable + 固定 reason
        const state = prepareIosCompat(createSnapshot(), fixture.cn)
        assert.equal(state.kind, "unavailable", item.label)
        assert.equal(state.reason, "invalid ios entity list", item.label)
        assert.equal(state.installedBytes, undefined, item.label)

        const app = await createAssetApp({
            env: localEnv(fixture.tempRoot),
            resolveListenHost: () => "10.0.0.5",
            iosCompat: IOS_COMPAT,
        })
        t.after(() => app.close())

        // HTTP 层：需要归档 ⇒ 503 明确不可用（既不降级下发 Android 归档，也不 500）
        const stale = await app.inject({
            method: "POST",
            url: "/asset/get_path",
            headers: { device: "1", res_ver: "1.4.0" },
            payload: {},
        })
        assert.equal(stale.statusCode, 503, item.label)
        assert.equal(stale.json().code, "IOS_ASSETS_UNAVAILABLE", item.label)

        const info = await app.inject({
            method: "POST",
            url: "/asset/version_info",
            headers: { device: "1" },
            payload: {},
        })
        assert.equal(info.statusCode, 503, item.label)
        assert.equal(info.json().code, "IOS_ASSETS_UNAVAILABLE", item.label)
    }
})

// 一次 /get_path 响应里所有会下载的归档路径。
// 首装计划把 full 边放 `data.full`（带 `archive`），增量链放 `data.diff` ——
// 注意 `data.diff` 是**边数组**（每项 `{original_version, version, archive}`），不是单个对象。
function planArchiveLocations(payload) {
    const archives = [
        ...(payload?.data?.full?.archive ?? []),
        ...(payload?.data?.diff ?? []).flatMap(edge => edge?.archive ?? []),
    ]
    return archives.map(item => String(item.location))
}

// ---------------------------------------------------------------------------
// 补丁的 iOS 层（patches/<版本>/patch-manifest.json 里 layer:"ios"）
//
// 背景：Android Catalog 刻意不接受 iOS 归档（`archive-ios-*` 不进 catalog-builder 的
// ARCHIVE_DIRECTORIES），所以补丁的 iOS 层只能由 ios-compat 单独拾取并**顶掉同一条
// 版本边的官方基线 iOS 归档**。没有这层拾取，CDN 作者给补丁写 `layer:"ios"` 只是让启动
// 校验通过，iOS 客户端永远拿不到那些字节。
// ---------------------------------------------------------------------------

const PATCH_IOS_BASELINE_BODY = "baseline-ios-bytes!"
const PATCH_IOS_BODY = "patched-ios-bytes"
const PATCH_BASELINE_EDGE_FROM = "1.4.53"
const PATCH_TARGET_VERSION = "1.4.99"
// 夹具让基线与补丁**只差 token**（同一槽位 `<from>-<to>-1`，两条都在，order 各自独立编号）：
// 视图按槽位去重、补丁胜出，所以计划里只剩补丁那一条；被顶掉的基线那条不再被引用
// （allowlist 仍可寻址它 —— 见下方"已知可接受残留"注释）。
// 实盘 1.4.55/1.4.56 里两边的 token 恰好相同（同名同字节），同样收敛成一条。
const PATCHED_BASELINE_RELATIVE_PATH =
    `archive-ios-diff/pinball-${PATCH_BASELINE_EDGE_FROM}-${PATCH_TARGET_VERSION}-1-cccccc.zip`

// 与 `_inspect/build_ios_layer.py` 产出的实盘补丁同形：目录名 = manifest.targetVersion，
// archives 多层齐（common 给 Android 目录视图，ios 由本模块拾取），
// 且 **iOS 归档的文件名版本边 = 补丁引入的那条边的 toVersion = targetVersion**
// （`readPackageIosArchives` 要求 `parsePatchArchiveName(...).toVersion === manifest.targetVersion`）。
function writeIosPatchPackage(patchesRoot, {
    targetVersion = PATCH_TARGET_VERSION,
    fromVersion = PATCH_BASELINE_EDGE_FROM,
    token = "b04f3ee8",
    body = PATCH_IOS_BODY,
} = {}) {
    const packageRoot = path.join(patchesRoot, targetVersion)
    const archiveName = `pinball-${fromVersion}-${targetVersion}-1-${token}.zip`
    fs.mkdirSync(path.join(packageRoot, "archive-ios-diff"), { recursive: true })
    const bytes = Buffer.byteLength(body)
    fs.writeFileSync(path.join(packageRoot, "archive-ios-diff", archiveName), Buffer.from(body))
    fs.writeFileSync(path.join(packageRoot, "patch-manifest.json"), JSON.stringify({
        schema: 1,
        baseVersion: fromVersion,
        targetVersion,
        compatibleClient: "CN 1.8.1",
        archives: [
            {
                relativePath: `archive-common-diff/pinball-${fromVersion}-${targetVersion}-1-c0ffee00.zip`,
                layer: "common",
                order: 1,
                bytes: 1,
                sha256: "b".repeat(64),
            },
            {
                relativePath: `archive-ios-diff/${archiveName}`,
                layer: "ios",
                order: 1,
                bytes,
                sha256: crypto.createHash("sha256").update(Buffer.from(body)).digest("hex"),
            },
        ],
    }, null, 2))
    return { packageRoot, archiveName, relativePath: `archive-ios-diff/${archiveName}` }
}

// 带补丁边的快照替身：基线到此为止 1.4.53，补丁把它推到 1.4.99，
// 那条新边的 platform 层由补丁自带的 iOS 归档顶替。
// 形状取自真实 Release —— `snapshot.archiveSources` 只覆盖 Android Catalog 归档，
// iOS 归档**永远不出现在 `cdn.edges[].archives` 里**（catalog-builder 不收 `archive-ios-*`），
// 所以 ios-compat 只能靠"标成 patch 的路径"甄别落点。
function createPatchBackedSnapshot() {
    return Object.freeze({
        cdn: Object.freeze({
            schemaVersion: 1,
            fullBaseVersion: "1.4.0",
            targetVersion: PATCH_TARGET_VERSION,
            installedBytes: 987_654,
            entityListsRelativePath: "EntityLists/android_medium.csv",
            edges: Object.freeze([
                edge(null, "1.4.0", [archive("archive-common-full/base.zip", 100)]),
                edge("1.4.0", "1.4.53", [archive("archive-common-diff/first.zip", 53)]),
                edge(PATCH_BASELINE_EDGE_FROM, PATCH_TARGET_VERSION, [
                    archive(`archive-common-diff/pinball-${PATCH_BASELINE_EDGE_FROM}-${PATCH_TARGET_VERSION}-1-5f083b4d.zip`, 8611),
                ]),
            ]),
        }),
        archiveSources: Object.freeze({
            schemaVersion: 1,
            archives: Object.freeze([
                { relativePath: "archive-common-full/base.zip", source: Object.freeze({ kind: "baseline" }) },
                { relativePath: "archive-common-diff/first.zip", source: Object.freeze({ kind: "baseline" }) },
                { relativePath: `archive-common-diff/pinball-${PATCH_BASELINE_EDGE_FROM}-${PATCH_TARGET_VERSION}-1-5f083b4d.zip`, source: Object.freeze({ kind: "patch", targetVersion: PATCH_TARGET_VERSION }) },
            ]),
        }),
    })
}

// 与 buildIosFixture 同一形状，但基线 iOS 覆盖到补丁边为止，
// 且补丁那条边的基线 iOS 归档写成可辨认的字节，便于断言"回的是补丁字节还是基线字节"。
function buildPatchedIosFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cn-ios-patch-"))
    const cn = path.join(tempRoot, "cn")
    const patchesRoot = path.join(tempRoot, "patches")
    fs.mkdirSync(path.join(cn, "archive-ios-full"), { recursive: true })
    fs.mkdirSync(path.join(cn, "archive-ios-diff"), { recursive: true })
    fs.mkdirSync(path.join(cn, "EntityLists"), { recursive: true })
    fs.writeFileSync(path.join(cn, "archive-ios-full", "pinball-1.4.0-1-abc123.zip"), Buffer.from("full-archive"))
    fs.writeFileSync(path.join(cn, "archive-ios-diff", "pinball-1.4.0-1.4.53-1-def456.zip"), Buffer.from("diff-archive"))
    fs.writeFileSync(path.join(cn, PATCHED_BASELINE_RELATIVE_PATH), Buffer.from(PATCH_IOS_BASELINE_BODY))
    fs.writeFileSync(path.join(cn, "EntityLists", "android_medium.csv"), "path,version,size,hash,layer\n")
    fs.writeFileSync(path.join(cn, "EntityLists", "ios_medium.csv"), IOS_ENTITY_LIST)
    fs.mkdirSync(patchesRoot, { recursive: true })
    const pkg = writeIosPatchPackage(patchesRoot)
    // common 层也真的落盘：快照把它标成 patch 来源，`getIosArchiveLocations` 对 patch 来源
    // 的路径只认补丁根（这正是"补丁文件不见了就别再发"的那条门禁）。
    // 真实发布里它必然在（`scanPatchOverlay` 启动时就会校验存在性与 sha256），
    // 夹具少这一个文件会让整个补丁边从 iOS 计划里消失 —— 那是夹具失真，不是产品行为。
    fs.mkdirSync(path.join(pkg.packageRoot, "archive-common-diff"), { recursive: true })
    fs.writeFileSync(
        path.join(pkg.packageRoot, `archive-common-diff/pinball-${PATCH_BASELINE_EDGE_FROM}-${PATCH_TARGET_VERSION}-1-5f083b4d.zip`),
        Buffer.from("patched-common-bytes"),
    )
    return { tempRoot, cn, patchesRoot, pkg }
}

test("a patch ios layer shadows the baseline ios archive for the same version edge", async t => {
    const fixture = buildPatchedIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const snapshot = createPatchBackedSnapshot()
    const app = Fastify({ logger: false })
    app.register(cdnFilesPlugin, {
        getSnapshot: () => snapshot,
        paths: { cdnRoot: fixture.cn, patchesRoot: fixture.patchesRoot },
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    // 目录视图：补丁 iOS 层替换掉该边的 platform 层
    const state = prepareIosCompat(snapshot, fixture.cn, fixture.patchesRoot)
    assert.equal(state.kind, "ready")
    assert.deepEqual(state.patchIosArchives, [fixture.pkg.relativePath])
    const patchedEdge = state.catalog.edges.find(item => item.toVersion === PATCH_TARGET_VERSION)
    assert.ok(patchedEdge, "the patched edge must exist in the ios view")
    assert.ok(
        patchedEdge.archives.some(item =>
            item.relativePath === fixture.pkg.relativePath && item.layer === "platform"),
        `patch ios archive must take the platform layer, got: ${JSON.stringify(patchedEdge.archives)}`,
    )
    // 补丁优先级 + 按路径去重：补丁与基线**各自目录内独立从 1 编号**（实盘两条都是 order 1），
    // 撞号不能靠 order 消重（实盘基线 order 是 readdir 序号，往往也不撞），
    // 所以按相对路径去重、补丁胜出 —— 被顶掉的基线条目**从视图里消失**，
    // 否则同一个文件会被下两遍。基线归档本身仍在（别的边还要用）。
    const platformEntries = patchedEdge.archives.filter(item => item.layer === "platform")
    assert.equal(
        platformEntries.length,
        1,
        `the shadowed baseline entry must leave the platform layer, got: ${JSON.stringify(platformEntries)}`,
    )
    assert.equal(
        platformEntries[0].relativePath,
        fixture.pkg.relativePath,
        `the patch archive must lead the platform layer, got: ${JSON.stringify(platformEntries)}`,
    )
    assert.equal(
        platformEntries.filter(item => item.relativePath === fixture.pkg.relativePath).length,
        1,
        "the patch archive must appear exactly once",
    )
    assert.deepEqual(
        platformEntries.map(item => item.order),
        [1],
        "the platform layer must be renumbered contiguously from 1",
    )

    // allowlist：补丁路径落点在 patches/<版本> 且 pinned；同边基线路径不再可服务
    const locations = getIosArchiveLocations(snapshot, fixture.cn, fixture.patchesRoot)
    const patchLocation = locations.get(fixture.pkg.relativePath)
    assert.ok(patchLocation, "the patch ios archive must be allowlisted")
    assert.equal(patchLocation.kind, "patch")
    assert.equal(patchLocation.targetVersion, PATCH_TARGET_VERSION)
    assert.equal(patchLocation.physicalRoot, fs.realpathSync(fixture.pkg.packageRoot))
    assert.equal(patchLocation.pinned, true)
    assert.equal(patchLocation.expectedIdentity !== null, true)
    // 别的边的基线归档照旧放行。
    assert.ok(locations.get("archive-ios-diff/pinball-1.4.0-1.4.53-1-def456.zip"))
    // 被同槽位去重顶掉的基线那条：视图里不再引用它 ⇒ allowlist 里也没有它（allowlist 只收
    // 视图引用到的路径），GET 会落到"不是 zip 就发 baseline 目录"的老路径上并因文件不在
    // cdnRoot 下而 404。这是预期的：客户端按计划下载，计划里已经没有它了。
    assert.equal(
        locations.get(PATCHED_BASELINE_RELATIVE_PATH),
        undefined,
        "the shadowed baseline archive must leave the allowlist",
    )

    // 补丁那条必须回补丁字节
    const patched = await app.inject({ method: "GET", url: `/patch/cn/${fixture.pkg.relativePath}` })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.body, PATCH_IOS_BODY)
    // 被顶掉的基线那条不再可服务（视图不再引用它）
    const shadowed = await app.inject({ method: "GET", url: `/patch/cn/${PATCHED_BASELINE_RELATIVE_PATH}` })
    assert.equal(shadowed.statusCode, 404, "the shadowed baseline path must no longer be served")
})

test("get_path prefers the patch ios archive and never falls back to the android platform layer", async t => {
    // 与上一条同一夹具，走完整 HTTP 计划链路（这是真机实际走的那条）。
    const fixture = buildPatchedIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const snapshot = createPatchBackedSnapshot()
    const app = Fastify({ logger: false })
    app.register(assetPlugin, {
        prefix: "/asset",
        getSnapshot: () => snapshot,
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    const ios = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "1" },
        payload: {},
    })
    assert.equal(ios.statusCode, 200)
    const iosArchives = planArchiveLocations(ios.json())
    assert.ok(
        iosArchives.some(location => location.endsWith(fixture.pkg.relativePath)),
        `the ios plan must carry the patch archive, got: ${JSON.stringify(iosArchives.slice(-6))}`,
    )
    assert.equal(
        iosArchives.some(location => location.includes("archive-android-")),
        false,
        `the ios plan must never reference android platform archives, got: ${JSON.stringify(iosArchives)}`,
    )
    // 计划里的 iOS platform 层只该剩补丁那一条（基线被同槽位去重顶掉）：
    // 槽位 = `<from>-<to>-<index>`，token 不参与判定，所以两条不同 token 的同一槽位收敛成一条。
    const patchedDiffArchives = (ios.json().data.diff ?? [])
        .filter(edge => edge.version === PATCH_TARGET_VERSION)
        .flatMap(edge => edge.archive.map(item => item.location))
    assert.deepEqual(
        patchedDiffArchives,
        [
            `${ANDROID_BASE}/archive-common-diff/pinball-1.4.53-1.4.99-1-5f083b4d.zip`,
            `${ANDROID_BASE}/${fixture.pkg.relativePath}`,
        ],
        `the patched edge must lead with the patch platform archive and drop the shadowed baseline, got: ${JSON.stringify(patchedDiffArchives)}`,
    )

    // 同一个快照，Android 设备走的是 Android 目录视图：拿到的是 archive-android-diff
    const android = await app.inject({
        method: "POST",
        url: "/asset/get_path",
        headers: { device: "2" },
        payload: {},
    })
    assert.equal(android.statusCode, 200)
    const androidArchives = planArchiveLocations(android.json())
    assert.ok(
        androidArchives.some(location => location.includes("archive-common-diff/pinball-1.4.53-1.4.99-1-5f083b4d.zip")),
        `the android plan must keep using the catalog archives, got: ${JSON.stringify(androidArchives.slice(-6))}`,
    )
    assert.equal(
        androidArchives.some(location => location.includes("archive-ios-diff/")),
        false,
        "the android plan must never reference ios archives",
    )
})

test("a redeployed ios patch layer is picked up without a restart", async t => {
    // 缓存键带"补丁存在性指纹"（各版本 patch-manifest.json 的 size:mtimeMs）：
    // 运维往 patches/ 里重新投放同一个版本包后，下一次请求就该重建 iOS 视图与 allowlist
    // （旧进程里 allowlist 的 expectedIdentity 会钉住旧 inode，不重建就会一直 404 或发旧字节）。
    const fixture = buildPatchedIosFixture()
    t.after(() => fs.rmSync(fixture.tempRoot, { recursive: true, force: true }))

    const snapshot = createPatchBackedSnapshot()
    const app = Fastify({ logger: false })
    app.register(assetPlugin, {
        prefix: "/asset",
        getSnapshot: () => snapshot,
        env: localEnv(fixture.tempRoot),
        resolveListenHost: () => "10.0.0.5",
        iosCompat: IOS_COMPAT,
    })
    app.register(cdnFilesPlugin, {
        getSnapshot: () => snapshot,
        paths: { cdnRoot: fixture.cn, patchesRoot: fixture.patchesRoot },
        iosCompat: IOS_COMPAT,
    })
    await app.ready()
    t.after(() => app.close())

    const before = await app.inject({ method: "POST", url: "/asset/get_path", headers: { device: "1" }, payload: {} })
    assert.equal(before.statusCode, 200)
    assert.ok(
        planArchiveLocations(before.json()).some(location => location.includes(fixture.pkg.archiveName)),
        `the plan must reference the installed patch archive, got: ${before.body.slice(0, 400)}`,
    )
    const servedBefore = await app.inject({ method: "GET", url: `/patch/cn/${fixture.pkg.relativePath}` })
    assert.equal(servedBefore.statusCode, 200)
    assert.equal(servedBefore.body, PATCH_IOS_BODY)

    // 重新投放：删掉旧包目录，落一份新的（归档字节不同；正是运维的 Copy-Item -Force）
    const redeployedBody = "patched-ios-bytes-v2"
    fs.rmSync(fixture.pkg.packageRoot, { recursive: true, force: true })
    const pkg2 = writeIosPatchPackage(fixture.patchesRoot, { body: redeployedBody })
    assert.equal(pkg2.relativePath, fixture.pkg.relativePath, "same edge, same token ⇒ same relative path")

    const after = await app.inject({ method: "POST", url: "/asset/get_path", headers: { device: "1" }, payload: {} })
    assert.equal(after.statusCode, 200)
    assert.ok(
        planArchiveLocations(after.json()).some(location => location.includes(fixture.pkg.archiveName)),
        `the plan must still reference the archive after redeploy, got: ${after.body.slice(0, 400)}`,
    )
    const servedAfter = await app.inject({ method: "GET", url: `/patch/cn/${fixture.pkg.relativePath}` })
    assert.equal(servedAfter.statusCode, 200)
    assert.equal(servedAfter.body, redeployedBody, "the new bytes must be served without a restart")
})
