"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const crypto = require("node:crypto")

require("ts-node/register/transpile-only")

const Fastify = require("fastify")
const iosLeitingRoutes = require("../src/routes/cn/ios-leiting").default

// P10-B（卡 A12）：SDK 登录 mock 的身份派生材料不再写死在源码里，改由运维经环境变量提供
// （见 src/routes/cn/ios-leiting.ts 顶部「β 修复」注释）。此处注入测试用值；测试用 aes key/iv
// 是官方二进制里的公开协议常量，不是本项目的机密。secret 仅测试用。
const BEAN_KEY = "#LeitingAESKey#!"
const BEAN_IV = "LeitingAESIVKEY!"
const BEAN_SECRET = "ios-leiting-route-test-secret"

process.env.IOS_SDK_BEAN_KEY = BEAN_KEY
process.env.IOS_SDK_BEAN_IV = BEAN_IV
process.env.IOS_SDK_IDENTITY_SECRET = BEAN_SECRET

/** 解密响应里的 AES-128-CBC 游客 UserBean，用于断言「身份是按设备派生的」。 */
function decryptBean(data) {
    const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(BEAN_KEY, "utf8"), Buffer.from(BEAN_IV, "utf8"))
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()])
    return JSON.parse(plain.toString("utf8"))
}

const LOGIN_PATHS = [
    "/mobile!mobileLoginPubV2.action",
    "/login/mobile!mobileLoginPubV2.action",
    "/mobile!sdkLogin.action",
    "/login/mobile!sdkLogin.action",
    "/mobile!guestRegister.action",
    "/login/mobile!guestRegister.action",
    "/mobile!sdkCheckLogin.action",
    "/login/mobile!sdkCheckLogin.action",
    "/sdk/v3-3/code_login_v2.do",
    "/sdk/v3-3/code_login.do",
    "/sdk/v3-3/pwd_login.do",
    "/sdk/v3-3/check_login.do",
    "/sdk/v3-3/check_force.do",
    "/sdk/v3-3/taptap_login.do",
    "/sdk/auth_login.do",
    "/sdk/v3-3/auth_login.do",
]

const STUB_PATHS = [
    "/mobile_two!getRegisterCodeOnly.action",
    "/login/mobile_two!getRegisterCodeOnly.action",
    "/aes/message/send_phone_code",
    "/aes/message/send_login_verify_code",
    "/aes/message/send_bind_phone_login_code",
    "/aes/message/send_register_code",
]

const MG_LOG_PATHS = [
    "/api/mg_log!addMgActivateLog.action",
    "/api/mg_log!addMgCreateRoleLog.action",
    "/api/mg_log!addMgLoginLog.action",
    "/api/mg_log!addMgRegisterLog.action",
]

const SDK_LOG_PATHS = [
    "/api/sdk_log!addScreenLog",
    "/api/sdk_log!addScreenLog.action",
    "/api/sdk_api!getCaidNew",
    "/api/sdk_api!getCaidNew.action",
]

async function createApp(options = {}) {
    const app = Fastify({ logger: false })
    await app.register(iosLeitingRoutes, options)
    await app.ready()
    return app
}

test("all 16 SDK login paths and 6 stub paths are registered", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of [...LOGIN_PATHS, ...STUB_PATHS]) {
        const response = await app.inject({ method: "POST", url })
        assert.equal(response.statusCode, 200, url)
    }
})

test("SDK login mock responds on both methods with the expected structure", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of ["/sdk/v3-3/check_login.do", "/mobile!mobileLoginPubV2.action"]) {
        for (const method of ["GET", "POST"]) {
            const response = await app.inject({ method, url })
            assert.equal(response.statusCode, 200, `${method} ${url}`)
            assert.match(response.headers["content-type"], /^application\/json/)
            const body = response.json()
            assert.equal(body.status, "0")
            assert.equal(body.type, "0")
            assert.equal(body.message, "")
            assert.equal(typeof body.data, "string")
            assert.ok(body.data.length > 0, "AES guest UserBean blob must be present")
        }
    }
})

// ── P10-B β 修复回归：身份必须按设备派生，且不得退化成共享身份 ──────────────

test("two devices get different identities while one device stays byte-stable", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const inject = udid => app.inject({ method: "POST", url: "/sdk/v3-3/check_login.do", headers: { udid } })
    const firstA = await inject("p10b-device-a")
    const secondA = await inject("p10b-device-a")
    const firstB = await inject("p10b-device-b")

    for (const response of [firstA, secondA, firstB]) {
        assert.equal(response.statusCode, 200)
        assert.equal(response.json().status, "0")
        assert.equal(response.json().type, "0")
        assert.equal(response.json().message, "")
    }

    const beanA = decryptBean(firstA.json().data)
    const beanB = decryptBean(firstB.json().data)

    assert.match(beanA.userId, /^9\d{7}$/)
    assert.equal(beanA.uid, Number(beanA.userId))
    assert.equal(beanA.userName, `g_${beanA.userId}`)
    assert.notEqual(beanA.userId, "10000001", "the shared beta identity must be gone")
    assert.notEqual(beanB.userId, "10000001")
    assert.notEqual(beanA.userId, beanB.userId, "two devices must not share one identity")
    assert.notEqual(firstA.json().data, firstB.json().data)
    assert.equal(firstA.json().data, secondA.json().data, "the same device must be stable across logins")
})

test("every one of the 16 login paths derives the identity the same way", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of LOGIN_PATHS) {
        const a = await app.inject({ method: "POST", url, headers: { udid: "p10b-device-a" } })
        const b = await app.inject({ method: "POST", url, headers: { udid: "p10b-device-b" } })
        assert.equal(a.json().status, "0", url)
        assert.equal(b.json().status, "0", url)
        assert.notEqual(decryptBean(a.json().data).userId, decryptBean(b.json().data).userId, url)
    }
})

test("device identifier precedence follows udid header > body device_id", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const headerOnly = await app.inject({
        method: "POST",
        url: "/sdk/v3-3/check_login.do",
        headers: { udid: "p10b-device-a" },
    })
    const both = await app.inject({
        method: "POST",
        url: "/sdk/v3-3/check_login.do",
        headers: { udid: "p10b-device-a", "content-type": "application/json" },
        payload: { device_id: "p10b-device-b" },
    })
    const bodyOnly = await app.inject({
        method: "POST",
        url: "/sdk/v3-3/check_login.do",
        headers: { "content-type": "application/json" },
        payload: { device_id: "p10b-device-a" },
    })

    // udid 头优先：body 里的另一个 device_id 不改变结果
    assert.equal(both.json().data, headerOnly.json().data)
    // 没有 udid 头时，body.device_id 顶上来，且与同标识的头部来源得到同一身份
    assert.equal(bodyOnly.json().data, headerOnly.json().data)
})

test("missing identity config fails closed instead of issuing a shared identity", async t => {
    const app = await createApp({ env: {} })
    t.after(() => app.close())

    const login = await app.inject({ method: "POST", url: "/sdk/v3-3/check_login.do", headers: { udid: "p10b-device-a" } })
    assert.equal(login.statusCode, 200)
    assert.equal(login.json().status, "1")
    assert.equal(login.json().type, "0")
    assert.equal(login.json().message, "ios-sdk-login-unconfigured")
    assert.equal(login.json().data, "", "must not hand out any identity when unconfigured")

    // 验证码 stub 路径不受身份配置影响
    for (const url of STUB_PATHS) {
        const stub = await app.inject({ method: "POST", url })
        assert.equal(stub.statusCode, 200, url)
        assert.equal(stub.json().status, "0", url)
        assert.equal(stub.json().data, "", url)
    }
})

test("explicit sdkIdentity options take precedence over the environment", async t => {
    const envSecretApp = await createApp()
    t.after(() => envSecretApp.close())
    const optionSecretApp = await createApp({
        sdkIdentity: { aesKey: BEAN_KEY, aesIv: BEAN_IV, identitySecret: "another-test-secret" },
    })
    t.after(() => optionSecretApp.close())

    const inject = app => app.inject({ method: "POST", url: "/sdk/v3-3/check_login.do", headers: { udid: "p10b-device-a" } })
    const fromEnv = await inject(envSecretApp)
    const fromOptions = await inject(optionSecretApp)

    assert.equal(fromEnv.json().status, "0")
    assert.equal(fromOptions.json().status, "0")
    const beanEnv = decryptBean(fromEnv.json().data)
    const beanOptions = decryptBean(fromOptions.json().data)
    assert.match(beanOptions.userId, /^9\d{7}$/)
    assert.notEqual(beanOptions.userId, beanEnv.userId, "a different secret must derive a different identity")
})

test("SDK stub paths respond with the empty-data structure", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of ["/mobile_two!getRegisterCodeOnly.action", "/aes/message/send_phone_code"]) {
        const response = await app.inject({ method: "POST", url })
        assert.equal(response.statusCode, 200, url)
        const body = response.json()
        assert.equal(body.status, "0")
        assert.equal(body.statusCode, "0")
        assert.equal(body.data, "")
    }
})

test("mg_log accepts GET and POST on every path", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of MG_LOG_PATHS) {
        for (const method of ["GET", "POST"]) {
            const response = await app.inject({ method, url })
            assert.equal(response.statusCode, 200, `${method} ${url}`)
            assert.deepEqual(response.json(), { code: 0, message: "success" })
        }
    }
})

test("sdk_log/sdk_api endpoints accept both with and without .action", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of SDK_LOG_PATHS) {
        const response = await app.inject({ method: "POST", url })
        assert.equal(response.statusCode, 200, url)
        assert.equal(response.json().code, 0)
    }
})

test("myip returns the request ip", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const response = await app.inject({ method: "GET", url: "/myip" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, "127.0.0.1")
})

test("protocol version files remain unavailable without authoritative payloads", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of [
        "/protocols/leiting/sensitive/part/common_version.txt",
        "/protocols/leiting/sensitive/part/wf_version.txt",
    ]) {
        const response = await app.inject({ method: "GET", url })
        assert.equal(response.statusCode, 404, url)
    }
})

test("wf config reflects the configured iOS api host", async t => {
    const app = await createApp({ ios: { apiHost: "10.0.0.5:8001", apiScheme: "http" } })
    t.after(() => app.close())

    const response = await app.inject({ method: "GET", url: "/wf/210009_config_20200415.json" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
        default: { apiPath: "10.0.0.5:8001", apiScheme: "http" },
    })
})

test("area/config and sync_data respond successfully", async t => {
    const app = await createApp()
    t.after(() => app.close())

    const area = await app.inject({ method: "GET", url: "/area/config.json" })
    assert.equal(area.statusCode, 200)
    assert.equal(typeof area.json().area_list, "object")

    const sync = await app.inject({ method: "POST", url: "/sync_data", payload: {} })
    assert.equal(sync.statusCode, 200)
    assert.equal(sync.json().code, 0)
})

// ── P10-B：iOS 公告通道（把绑定验证码送到 SDK 原生弹窗）─────────────────────────
// 依据：P10-A 交付片段（交付片段/p10a/ios-notice.fragment.ts）。字段名静态无法确定 ⇒
// 第一版是「多别名霰弹」；provideCode 缺省恒 null ⇒ 兜底文案且**不得抛错**。

const NOTICE_PATHS = [
    "/sdk_v3/get_notice.do",
    "/login/sdk_v3/get_notice.do",
    "/api/sdk_v3/get_notice.do",
]

test("notice endpoints answer on all candidate prefixes with a shotgun payload", async t => {
    const app = await createApp()
    t.after(() => app.close())

    for (const url of NOTICE_PATHS) {
        const response = await app.inject({ method: "POST", url, payload: { uid: "90000001" } })
        assert.equal(response.statusCode, 200, url)
        const body = response.json()
        assert.equal(body.code, 0, url)
        assert.equal(body.noticeId, "sp-cn-bind-code", url)
        // 霰弹：同一段话术必须出现在所有候选字段名上，SDK 读哪个都能显示
        const text = body.NOTICECONTENT
        assert.equal(typeof text, "string")
        assert.ok(text.length > 0, url)
        for (const key of ["noticeContent", "content", "urgentNoticeContent", "announceMsg", "msg"]) {
            assert.equal(body[key], text, `${url} ${key}`)
        }
        assert.equal(body.data.noticeContent, text, url)
        assert.equal(body.data.NOTICECONTENT, text, url)
        // 没有 provideCode ⇒ 兜底文案，且必须仍然 200
        assert.ok(text.includes("/bind"), url)
    }
})

test("provideCode is injected with uid/deviceId and its failure never breaks the request", async t => {
    const seen = []
    const app = await createApp({
        notice: {
            provideCode: ids => {
                seen.push(ids)
                return "135790"
            },
        },
    })
    t.after(() => app.close())

    const ok = await app.inject({
        method: "POST",
        url: "/sdk_v3/get_notice.do",
        payload: { uid: 90000042, deviceId: "device-abc" },
    })
    assert.equal(ok.statusCode, 200)
    assert.ok(ok.json().NOTICECONTENT.includes("135790"))
    assert.deepEqual(seen[0], { uid: "90000042", deviceId: "device-abc", udid: "device-abc" })

    // 字符串 body（生产环境 urlencoded 解析器的产物形态之一）：走正则兜底提取
    const textBody = await app.inject({
        method: "POST",
        url: "/sdk_v3/get_notice.do",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify("uid=90000043&deviceId=device-def"),
    })
    assert.equal(textBody.statusCode, 200)
    assert.ok(textBody.json().NOTICECONTENT.includes("135790"))
    assert.deepEqual(seen[1], { uid: "90000043", deviceId: "device-def", udid: "device-def" })

    const boom = await createApp({
        notice: {
            provideCode: () => {
                throw new Error("code store offline")
            },
        },
    })
    t.after(() => boom.close())
    const failed = await boom.inject({ method: "POST", url: "/sdk_v3/get_notice.do", payload: {} })
    assert.equal(failed.statusCode, 200)
    assert.ok(failed.json().NOTICECONTENT.includes("/bind"))
})

test("shotgun:false narrows the payload to the confirmed field names", async t => {
    const app = await createApp({ notice: { shotgun: false, provideCode: () => "246810" } })
    t.after(() => app.close())

    const response = await app.inject({ method: "POST", url: "/sdk_v3/get_notice.do", payload: {} })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(Object.keys(response.json()).sort(), ["NOTICECONTENT", "code", "noticeId"])
    assert.ok(response.json().NOTICECONTENT.includes("246810"))
})

test("the notice probe stays off unless asked, and writes exactly one line per hit", async t => {
    const offLines = []
    const off = await createApp({ notice: { probe: false, probeWriteLine: line => offLines.push(line) } })
    t.after(() => off.close())
    await off.inject({ method: "POST", url: "/sdk_v3/get_notice.do", payload: {} })
    assert.equal(offLines.length, 0)

    const lines = []
    const app = await createApp({
        notice: { probe: true, probeWriteLine: line => lines.push(line) },
    })
    t.after(() => app.close())

    await app.inject({
        method: "POST",
        url: "/sdk/v3-3/check_login.do",
        headers: { "content-type": "application/json", cookie: "session=must-not-be-logged", udid: "9abcdef" },
        payload: { device_id: "device-xyz" },
    })
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.method, "POST")
    assert.equal(record.url, "/sdk/v3-3/check_login.do")
    assert.equal(record.status, 200)
    assert.equal(record.udid, "9abcdef")
    assert.deepEqual(record.body_keys, ["device_id"])
    assert.ok(record.response.includes("data"))
    assert.ok(!lines[0].includes("must-not-be-logged"), "probe must not copy cookies into the log")

    // 不在过滤范围内的请求（游戏资源面）不产生任何行
    await app.inject({ method: "POST", url: "/sync_data", payload: {} })
    assert.equal(lines.length, 1)
})

