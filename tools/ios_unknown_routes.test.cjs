"use strict"

// 平台/设备埋点裸路由的「最小吞掉」回归（真机取证 2026-09-29 12:59:58，iPhone 7 Plus /
// iOS 15.8.3，客户端为局域网内手机，地址按仓库隐私约定写作 <LAN_IP>）。
//
// 背景：该次真机启动共 155 条请求 / 26 种 route×status，其中 35 条落在
// `setNotFoundHandler`（src/runtime/admin.ts:121/:133）产生的 404 上。本文件覆盖被实现的
// 4 条（占 27 条）；剩余 8 条 `protocols/leiting/sensitive/part/*.txt` 是**已定稿决策**保持
// 404，其钉子测试在 tools/ios_leiting_route.test.cjs:267-278 与 tools/combined_startup.test.cjs:124-126，
// 本文件**不**重复断言那 8 条（避免两处结论各自漂移）。
//
// 取证路径取自 D:\wfcnmod\tmp\server-lan.log 的原始请求行（**不是**文档表格里的简写）：
//   POST /behavior_log/report                                                                12x
//   GET  /api/micro/micro_red/enter_position?channelNo=210009&game=wf&token=(null)&userId=(null)  8x
//   POST /api/device/report                                                                   4x
//   POST /api/iplog/report                                                                    3x

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const iosLeitingRoutes = require("../src/routes/cn/ios-leiting").default

// 与 ios_leiting_route.test.cjs 同法：身份材料走环境变量（源码不写死）。本文件不做登录断言，
// 仅需插件能注册成功，故给最小可用值。
process.env.IOS_SDK_BEAN_KEY = "#LeitingAESKey#!"
process.env.IOS_SDK_BEAN_IV = "LeitingAESIVKEY!"
process.env.IOS_SDK_IDENTITY_SECRET = "ios-unknown-routes-test-secret"

/** 真机实际请求行里的路径（含 micro_red 的完整查询串）。 */
const TELEMETRY_POST_PATHS = [
    "/behavior_log/report",
    "/api/device/report",
    "/api/iplog/report",
]

const ENTER_POSITION_PATH = "/api/micro/micro_red/enter_position"

/** 真机那 8 条的原始查询串：token/userId 是字面串 `(null)`，不是省略。 */
const ENTER_POSITION_QUERY = "?channelNo=210009&game=wf&token=(null)&userId=(null)"

/**
 * 体形态矩阵。**必须**用 Buffer payload + 显式 content-type 头：
 * `app.inject` 对「对象体」会自动补 `content-type: application/json`
 * （node_modules/light-my-request/lib/request.js:164-170）—— 原提交的测试因此在
 * 「路由命中后 Fastify 先跑 body 解析器」这条路上只覆盖了 JSON 一种形态，
 * 漏掉了「没有解析器的 content-type + 非空体 ⇒ 415」这个缺口。
 *
 * 缺口的性质：404 兜底路径**不跑** body 解析器，所以 415 只在路由被实现**之后**才出现
 * —— 即这次改动如果不带兜底解析器，真机二进制上报拿到的不是 404 而是 415，噪声照旧。
 */
const TELEMETRY_BODY_SHAPES = [
    {
        label: "application/octet-stream + 二进制体",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff]),
    },
    {
        label: "multipart/form-data; boundary=…",
        headers: { "content-type": "multipart/form-data; boundary=----spTelemetryBoundary" },
        payload: Buffer.from(
            '------spTelemetryBoundary\r\nContent-Disposition: form-data; name="d"\r\n\r\n1\r\n------spTelemetryBoundary--\r\n',
        ),
    },
    {
        label: "完全不带 Content-Type 的非空体",
        headers: {},
        payload: Buffer.from('{"noContentType":true}'),
    },
    {
        label: "application/json（合法）",
        headers: { "content-type": "application/json" },
        payload: Buffer.from('{"appId":"x","bundleId":"y"}'),
    },
    {
        label: "application/json（**非法** JSON，不得 400）",
        headers: { "content-type": "application/json" },
        payload: Buffer.from("这不是 JSON，真机埋点体形状未知"),
    },
    {
        label: "application/x-www-form-urlencoded",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: Buffer.from("channelNo=210009&game=wf"),
    },
    {
        label: "application/x-www-form-urlencoded + 非 UTF-8 字节",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: Buffer.from([0xc1, 0xff, 0x00, 0x80]),
    },
    {
        label: "text/plain",
        headers: { "content-type": "text/plain" },
        payload: Buffer.from("a plain telemetry line"),
    },
    {
        label: "application/x-msgpack（SDK 同族私有二进制类型）",
        headers: { "content-type": "application/x-msgpack" },
        payload: Buffer.from([0x81, 0xa1, 0x61, 0x01]),
    },
    {
        label: "空体 + Content-Length: 0",
        headers: { "content-type": "application/octet-stream", "content-length": "0" },
        payload: Buffer.from(""),
    },
    {
        label: "无体、无 Content-Type",
        headers: {},
        payload: undefined,
    },
]

/** 三方对照：同样的体形态打在**同级**路由上，必须保持改动前的 415 语义。 */
const ENCAPSULATION_NEIGHBOURS = [
    "/sync_data",
    "/logmonitor/api/advert!getNewConfig.action",
    "/api/mg_log!addMgLoginLog.action",
]

async function createApp() {
    const app = Fastify({ logger: false })
    await app.register(iosLeitingRoutes, {})
    await app.ready()
    return app
}

test("the 3 telemetry report routes answer 200 with {code:0} instead of 404", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of TELEMETRY_POST_PATHS) {
        const response = await app.inject({ method: "POST", url, payload: {} })
        assert.equal(response.statusCode, 200, url)
        assert.match(response.headers["content-type"], /^application\/json/, url)
        assert.deepEqual(response.json(), { code: 0 }, url)
    }
})

test("telemetry report routes swallow unknown and missing bodies without changing the ack", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 埋点体形状未知（8001 抓头代理 capture.jsonl 里没有这 4 条的记录）⇒ 任何体都必须照样 200。
    const bodies = [
        { payload: {} },
        { payload: { anything: [1, 2, 3], nested: { deep: "x".repeat(500) } } },
        { payload: "" },
        { payload: undefined },
    ]

    for (const url of TELEMETRY_POST_PATHS) {
        for (const body of bodies) {
            const response = await app.inject({ method: "POST", url, ...body })
            assert.equal(response.statusCode, 200, `${url} ${JSON.stringify(body.payload)}`)
            assert.deepEqual(response.json(), { code: 0 }, url)
        }
    }
})

test("telemetry report routes answer 200 to EVERY content-type / body shape (never 415)", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 契约：真机埋点体形状**未知**（capture.jsonl 里没有这 3 条的记录）⇒ 不能赌它是 JSON。
    // 光「不读 body」不够：路由一旦匹配，Fastify 会**先**跑 body 解析器，遇到「没有解析器的
    // content-type + 非空体」直接回 415（FST_ERR_CTP_INVALID_MEDIA_TYPE），而 404 兜底路径
    // 不跑解析器 ⇒ 不做兜底的话，这次改动只是把 404 噪声换成 415 噪声。
    for (const url of TELEMETRY_POST_PATHS) {
        for (const shape of TELEMETRY_BODY_SHAPES) {
            const response = await app.inject({
                method: "POST",
                url,
                headers: shape.headers,
                payload: shape.payload,
            })
            const where = `${url} [${shape.label}]`
            assert.equal(response.statusCode, 200, where)
            assert.match(response.headers["content-type"], /^application\/json/, where)
            assert.deepEqual(response.json(), { code: 0 }, where)
        }
    }
})

test("the wildcard body parser stays inside the telemetry scope: neighbours keep their 415", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 「零泄漏」钉子：兜底解析器是用 fastify.register 收进独立子作用域的，**不得**泄漏给
    // 同级路由。若有人图省事把 `addContentTypeParser("*", …)` 挪到插件顶层，
    // /sync_data 等路径既有的 415 语义会被一起抹掉 —— 本断言就是拦这个的。
    // 只取「在窄作用域宿主（裸 app）与生产宿主（cn-server 顶层带 urlencoded/json 解析器）
    // 下都为 415」的形态，避免把测试宿主的装配差异当成契约写死。
    const nonJsonShapes = TELEMETRY_BODY_SHAPES.filter(shape =>
        shape.label.startsWith("application/octet-stream")
        || shape.label.startsWith("multipart/form-data")
        || shape.label.startsWith("完全不带 Content-Type")
        || shape.label.startsWith("application/x-msgpack"))

    assert.equal(nonJsonShapes.length, 4, "筛选条件应命中 4 种非 JSON 形态")

    for (const url of ENCAPSULATION_NEIGHBOURS) {
        for (const shape of nonJsonShapes) {
            const response = await app.inject({
                method: "POST",
                url,
                headers: shape.headers,
                payload: shape.payload,
            })
            const where = `${url} [${shape.label}]`
            assert.equal(response.statusCode, 415, `${where} 必须仍是 415（兜底解析器泄漏了）`)
            assert.equal(response.json().code, "FST_ERR_CTP_INVALID_MEDIA_TYPE", where)
        }
    }

    // 钉子本身：验收标准点名的那一条。
    const syncOctet = await app.inject({
        method: "POST",
        url: "/sync_data",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    })
    assert.equal(syncOctet.statusCode, 415, "POST /sync_data + octet-stream 非空体实测必须仍是 415")

    // 反过来确认真的打在了解析器上（而不是被 404 兜底吃掉）：同一条 /sync_data 换 JSON 体仍 200。
    const syncJson = await app.inject({
        method: "POST",
        url: "/sync_data",
        headers: { "content-type": "application/json" },
        payload: Buffer.from('{"a":1}'),
    })
    assert.equal(syncJson.statusCode, 200, "同一条 /sync_data 换 JSON 体应仍 200")
    assert.deepEqual(syncJson.json(), { code: 0 })
})

test("enter_position answers 200 to the real query string including the literal (null) identity", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const response = await app.inject({
        method: "GET",
        url: ENTER_POSITION_PATH + ENTER_POSITION_QUERY,
    })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"], /^application\/json/)
    assert.deepEqual(response.json(), { code: 0, data: {} })

    // 无查询串时也同样应答（客户端可能不带参数重试）
    const bare = await app.inject({ method: "GET", url: ENTER_POSITION_PATH })
    assert.equal(bare.statusCode, 200)
    assert.deepEqual(bare.json(), { code: 0, data: {} })
})

test("enter_position performs no identity lookup: an arbitrary token/userId changes nothing", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 真机送的是字面 `(null)`；这里额外确认「送真值也一样」⇒ 证明实现里没有任何身份分支。
    const withRealLookingIdentity = await app.inject({
        method: "GET",
        url: `${ENTER_POSITION_PATH}?channelNo=210009&game=wf&token=sp-deadbeef&userId=90000001`,
    })
    const withNullIdentity = await app.inject({
        method: "GET",
        url: ENTER_POSITION_PATH + ENTER_POSITION_QUERY,
    })

    assert.equal(withRealLookingIdentity.statusCode, 200)
    assert.deepEqual(withRealLookingIdentity.json(), withNullIdentity.json())
    assert.deepEqual(withRealLookingIdentity.json(), { code: 0, data: {} })
})

test("the 4 new routes reject the wrong method instead of silently answering", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 反向保护：吞掉的是**确证过的那个方法**，不是任意方法。
    for (const url of TELEMETRY_POST_PATHS) {
        const response = await app.inject({ method: "GET", url })
        assert.equal(response.statusCode, 404, `GET ${url} must stay unimplemented`)
    }

    const postEnterPosition = await app.inject({
        method: "POST",
        url: ENTER_POSITION_PATH + ENTER_POSITION_QUERY,
        payload: {},
    })
    assert.equal(postEnterPosition.statusCode, 404, "POST enter_position must stay unimplemented")
})

test("unrelated paths and the frozen protocol version files still 404", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 防止把 404 兜底整体改成 200：既有「未知端点」语义必须原样保留。
    for (const url of [
        "/api/index.php/definitely_not_a_route",
        "/behavior_log/not_report",
        "/api/device/report/extra",
        "/misclog",
    ]) {
        const response = await app.inject({ method: "POST", url, payload: {} })
        assert.equal(response.statusCode, 404, url)
    }

    // 已定稿决策：协议版本文件没有权威 payload ⇒ 保持未实现（本文件只守卫，不改它）。
    // 权威钉子断言仍在 tools/ios_leiting_route.test.cjs:267-278。
    for (const url of [
        "/protocols/leiting/sensitive/part/wf_version.txt",
        "/protocols/leiting/sensitive/part/common_version.txt",
        "/protocols/leiting/sensitive/part/wf-text_version.txt",
        "/protocols/leiting/sensitive/part/common-text_version.txt",
    ]) {
        const response = await app.inject({ method: "GET", url })
        assert.equal(response.statusCode, 404, url)
    }
})

test("the 4 new routes do not disturb the neighbouring SDK stubs", async t => {
    const app = await createApp()
    t.after(() => app.close())

    // 回归：新增路由不得改变既有同族端点的响应形状。
    const sync = await app.inject({ method: "POST", url: "/sync_data", payload: {} })
    assert.equal(sync.statusCode, 200)
    assert.deepEqual(sync.json(), { code: 0 })

    const advert = await app.inject({
        method: "POST",
        url: "/logmonitor/api/advert!getNewConfig.action",
        payload: {},
    })
    assert.equal(advert.statusCode, 200)
    assert.deepEqual(advert.json(), { code: 0, data: {} })

    const skan = await app.inject({ method: "GET", url: "/api/skan/query_detail" })
    assert.equal(skan.statusCode, 200)
    assert.deepEqual(skan.json(), { code: 0, data: {} })

    const mgLog = await app.inject({ method: "POST", url: "/api/mg_log!addMgLoginLog.action", payload: {} })
    assert.equal(mgLog.statusCode, 200)
    assert.deepEqual(mgLog.json(), { code: 0, message: "success" })
})
