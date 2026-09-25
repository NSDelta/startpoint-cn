"use strict"

// B0 探针回归：探针是"只看不改"的，这个测试同时钉住三件事——
// 1) 默认关闭（SP_PROBE_UDID 未设置时不注册任何钩子）；
// 2) 开启后每请求一行 JSON，身份头原样落盘；
// 3) 不落请求体内容（只落键名）、不改响应、不改请求对象。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const Fastify = require("fastify")

require("ts-node/register/transpile-only")

const {
    PROBE_ENV_FLAG,
    PROBE_ENV_LOG_PATH,
    buildUdidProbeRecord,
    installUdidProbe,
    installUdidProbeFromEnv,
} = require("../src/lib/udid-probe")

function withoutProbeEnv(run) {
    const savedFlag = process.env[PROBE_ENV_FLAG]
    const savedLog = process.env[PROBE_ENV_LOG_PATH]
    delete process.env[PROBE_ENV_FLAG]
    delete process.env[PROBE_ENV_LOG_PATH]
    try {
        return run()
    } finally {
        if (savedFlag === undefined) delete process.env[PROBE_ENV_FLAG]
        else process.env[PROBE_ENV_FLAG] = savedFlag
        if (savedLog === undefined) delete process.env[PROBE_ENV_LOG_PATH]
        else process.env[PROBE_ENV_LOG_PATH] = savedLog
    }
}

function captureStdout(run) {
    const lines = []
    const original = console.log
    console.log = message => { lines.push(String(message)) }
    try {
        run()
    } finally {
        console.log = original
    }
    return lines
}

// stdout 兜底是异步路径：探针行在 inject 时才写，捕获窗口必须覆盖到 inject 之后。
async function captureStdoutAsync(run) {
    const lines = []
    const original = console.log
    console.log = message => { lines.push(String(message)) }
    try {
        await run()
    } finally {
        console.log = original
    }
    return lines
}

test("probe stays off unless the environment flag is exactly 1", async () => {
    await withoutProbeEnv(async () => {
        const app = Fastify({ logger: false })
        assert.equal(installUdidProbeFromEnv(app), false)
        app.post("/signup", async () => ({ ok: true }))
        await app.ready()
        // 没有钩子 ⇒ 请求照样通，且没有任何输出
        const lines = captureStdout(() => {})
        const response = await app.inject({
            method: "POST",
            url: "/signup",
            headers: { udid: "should-not-be-logged" },
            payload: { device_id: 1 },
        })
        assert.equal(response.statusCode, 200)
        assert.deepEqual(lines, [])
        await app.close()
    })
})

test("probe writes one JSON line per request with raw identity headers", async () => {
    await withoutProbeEnv(async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "udid-probe-"))
        const logPath = path.join(directory, "probe.log")
        process.env[PROBE_ENV_FLAG] = "1"
        process.env[PROBE_ENV_LOG_PATH] = logPath

        const app = Fastify({ logger: false })
        let sawProbeOnRoutes = false
        const banner = captureStdout(() => {
            sawProbeOnRoutes = installUdidProbeFromEnv(app)
        })
        assert.equal(sawProbeOnRoutes, true)
        assert.match(banner.join("\n"), /identity probe active/)
        app.post("/api/index.php/tool/signup", async request => ({ udid: request.headers.udid ?? null }))
        await app.ready()

        const withUdid = await app.inject({
            method: "POST",
            url: "/api/index.php/tool/signup?k=v",
            headers: { udid: "probe-test-udid", "short-udid": "12345", "user-agent": "ios-probe/1.0" },
            payload: { device_id: 123, channelNo: "leiting" },
        })
        const withoutUdid = await app.inject({
            method: "POST",
            url: "/api/index.php/tool/signup",
            headers: { "user-agent": "ios-probe/1.0" },
            payload: { device_id: 124 },
        })
        assert.equal(withUdid.statusCode, 200)
        assert.equal(withoutUdid.statusCode, 200)
        // 不改行为：路由看到的头就是客户端发来的头
        assert.deepEqual(withUdid.json(), { udid: "probe-test-udid" })

        const lines = fs.readFileSync(logPath, "utf8").trim().split("\n")
        assert.equal(lines.length, 2)
        const first = JSON.parse(lines[0])
        assert.equal(first.method, "POST")
        assert.equal(first.url, "/api/index.php/tool/signup?k=v")
        assert.equal(first.udid, "probe-test-udid")
        assert.equal(first.short_udid, "12345")
        assert.equal(first.user_agent, "ios-probe/1.0")
        assert.equal(first.has_session, false)
        assert.deepEqual(first.body_keys, ["channelNo", "device_id"])
        assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/)
        assert.equal(typeof first.ip, "string")
        const second = JSON.parse(lines[1])
        assert.equal(second.udid, null)
        assert.equal(second.short_udid, null)

        await app.close()
        fs.rmSync(directory, { recursive: true, force: true })
    })
})

// 真机取证最怕「零证据」：请求被 body 解析阶段拒掉（415，例如未注册的 content-type）
// 时它到不了 preHandler。onResponse 兜底必须照样把身份头落盘，且每请求仍然只有一行。
test("probe still records requests rejected before the body is parsed", async () => {
    await withoutProbeEnv(async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "udid-probe-415-"))
        const logPath = path.join(directory, "probe.log")
        process.env[PROBE_ENV_FLAG] = "1"
        process.env[PROBE_ENV_LOG_PATH] = logPath

        const app = Fastify({ logger: false })
        installUdidProbeFromEnv(app)
        app.post("/api/index.php/tool/signup", async () => ({ ok: true }))
        await app.ready()

        const rejected = await app.inject({
            method: "POST",
            url: "/api/index.php/tool/signup",
            headers: { "content-type": "application/x-msgpack", udid: "device-udid-msgpack" },
            payload: Buffer.from([0x81, 0xa1, 0x61, 0x01]),
        })
        assert.equal(rejected.statusCode, 415)

        const lines = fs.readFileSync(logPath, "utf8").trim().split("\n")
        assert.equal(lines.length, 1)
        const record = JSON.parse(lines[0])
        assert.equal(record.udid, "device-udid-msgpack")
        assert.equal(record.url, "/api/index.php/tool/signup")
        assert.equal(record.body_keys, null)

        await app.close()
        fs.rmSync(directory, { recursive: true, force: true })
    })
})

test("probe falls back to stdout and never logs request body contents", async () => {
    await withoutProbeEnv(async () => {
        const app = Fastify({ logger: false })
        process.env[PROBE_ENV_FLAG] = "1"
        const secret = "super-secret-body-value"
        const lines = await captureStdoutAsync(async () => {
            installUdidProbeFromEnv(app)
            app.post("/api/index.php/tool/signup", async () => ({ ok: true }))
            await app.ready()

            await app.inject({
                method: "POST",
                url: "/api/index.php/tool/signup",
                headers: { udid: "abc" },
                payload: { device_id: 9, secret },
            })
        })

        const payloadLines = lines.filter(line => line.startsWith("{"))
        assert.equal(payloadLines.length, 1)
        const record = JSON.parse(payloadLines[0])
        assert.deepEqual(record.body_keys, ["device_id", "secret"])
        assert.equal(payloadLines[0].includes(secret), false)
        await app.close()
    })
})

test("probe leaves session presence and array headers observable without transforming them", async () => {
    await withoutProbeEnv(async () => {
        const app = Fastify({ logger: false })
        const records = []
        installUdidProbe(app, { writeLine: line => { records.push(JSON.parse(line)) } })
        app.post("/signup", async () => ({ ok: true }))
        await app.ready()

        await app.inject({
            method: "POST",
            url: "/signup",
            headers: { udid: "  padded  ", cookie: "session=token", "content-type": "application/json" },
            payload: {},
        })

        assert.equal(records.length, 1)
        assert.equal(records[0].udid, "padded")
        assert.equal(records[0].has_session, true)
        assert.deepEqual(records[0].body_keys, [])
        await app.close()
    })
})

test("buildUdidProbeRecord is a pure reader over the request", () => {
    const request = {
        method: "POST",
        url: "/signup",
        originalUrl: "/signup?x=1",
        ip: "127.0.0.1",
        headers: { udid: ["first", "second"], "short-udid": "77" },
        body: { device_id: 1, b: 2 },
    }
    const record = buildUdidProbeRecord(request, new Date("2024-01-01T00:00:00.000Z"))
    assert.deepEqual(record, {
        ts: "2024-01-01T00:00:00.000Z",
        method: "POST",
        url: "/signup?x=1",
        ip: "127.0.0.1",
        udid: "first",
        short_udid: "77",
        user_agent: null,
        has_session: false,
        body_keys: ["b", "device_id"],
    })
    assert.deepEqual(request.headers.udid, ["first", "second"])
})
