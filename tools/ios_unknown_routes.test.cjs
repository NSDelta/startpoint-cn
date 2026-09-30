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
