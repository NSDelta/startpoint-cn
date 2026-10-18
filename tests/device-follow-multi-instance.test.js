require("ts-node/register/transpile-only")

// 「并号」（`src/lib/sp-auth/device-follow.ts`）在**一台机器上跑多个实例**时的行为守卫。
//
// 桌面启动器每个实例有独立的容器键（`<slot>-<12 位十六进制>`）：AIR 的 application id 是
// `com.leiting.wf.<容器键>`，存档目录、设备号、CDN 联接全在那个 id 下面，而门登录时同一个
// 键会作为 `client_key` 发给服务端。于是同一台机器上的两个实例有两个不同的容器键，
// 但**来源 IP 是同一个**。
//
// 并号有两条规则：门登录后认领同一来源报到过的设备号（`claimReportedDevices`），
// 游戏报到时跟随同一来源最近的门登录（`followAccountForSignup`）。两条都既看容器键
// 又看 IP，而 IP 在多实例下必然相同 —— 如果没有「带容器键的登录一律不按 IP 认」这条
// 规则，A 实例的门登录会认领 B 实例的设备号、B 实例的报到又会跟去 A 的账号，
// 两个实例的账号当场对调。
//
// 这里不碰数据库：持久层整体打桩，只验证配对规则。

const assert = require("node:assert/strict")
const os = require("node:os")
const path = require("node:path")
const fs = require("node:fs")
const test = require("node:test")

const repoRoot = path.resolve(__dirname, "..")

/* ------------------------------------------------------------------ 打桩 -- */

const bindings = new Map()
const audits = []
const accounts = new Set([101, 202])
let nowMs = 1_700_000_000_000

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-follow-test-"))

function stubModule(relative, exports) {
    const resolved = require.resolve(path.join(repoRoot, relative))
    const cached = require.cache[resolved]
    if (cached) {
        Object.assign(cached.exports, exports)
        return resolved
    }
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        children: [],
        paths: [],
        exports,
    }
    return resolved
}

stubModule("src/data/domains/account-binding", {
    appendBindAuditSync: (row) => { audits.push(row) },
})
stubModule("src/data/domains/account", {
    getAccountSync: (id) => (accounts.has(id) ? { id } : null),
})
stubModule("src/data/domains/session", {
    getDeviceBindingSync: (deviceId) => bindings.get(deviceId) ?? null,
    insertDeviceBindingSync: (deviceId, accountId) => {
        bindings.set(deviceId, { account_id: accountId })
    },
})
stubModule("src/runtime/data-paths", {
    resolveRuntimeDataPaths: () => ({ dataDir: storeDir }),
})
stubModule("src/runtime/time/game-time", {
    getRealNowMs: () => nowMs,
    getRealNow: () => new Date(nowMs),
})

const {
    claimReportedDevices,
    followAccountForSignup,
    noteGateLogin,
    noteSignupDevice,
    resetDeviceFollowStateForTest,
} = require("../src/lib/sp-auth/device-follow")

/* --------------------------------------------------------------- 固件数据 -- */

/** 同一台机器、同一个出口 IP —— 多开时两个实例就是这样。 */
const MACHINE_IP = "203.0.113.7"
const KEY_A = "slot01-a1b2c3d4e5f6"
const KEY_B = "slot02-0f1e2d3c4b5a"
const STORE_A = `C:\\Users\\x\\AppData\\Roaming\\com.leiting.wf.${KEY_A}\\Local Store`
const STORE_B = `C:\\Users\\x\\AppData\\Roaming\\com.leiting.wf.${KEY_B}\\Local Store`
const DEV_A = 111_111_111_111
const DEV_B = 222_222_222_222
const ACC_A = 101
const ACC_B = 202

function reset() {
    bindings.clear()
    audits.length = 0
    resetDeviceFollowStateForTest()
}

function bindingOf(deviceId) {
    const row = bindings.get(deviceId)
    return row === undefined ? null : row.account_id
}

/* ----------------------------------------------------------------- 用例 -- */

test("门登录认领设备时，带容器键就只认自己的容器", () => {
    reset()
    noteSignupDevice({ deviceId: DEV_A, ip: MACHINE_IP, path: STORE_A })
    noteSignupDevice({ deviceId: DEV_B, ip: MACHINE_IP, path: STORE_B })

    const claimed = claimReportedDevices({ accountId: ACC_A, ip: MACHINE_IP, key: KEY_A })

    assert.deepEqual(claimed, [DEV_A], "只该认领 A 实例的设备号")
    assert.equal(bindingOf(DEV_A), ACC_A)
    assert.equal(bindingOf(DEV_B), null, "B 实例的设备号必须原样不动")
})

test("A、B 两个实例各自登录，各自的设备号各自归位", () => {
    reset()
    noteSignupDevice({ deviceId: DEV_A, ip: MACHINE_IP, path: STORE_A })
    noteSignupDevice({ deviceId: DEV_B, ip: MACHINE_IP, path: STORE_B })

    assert.deepEqual(claimReportedDevices({ accountId: ACC_A, ip: MACHINE_IP, key: KEY_A }), [DEV_A])
    assert.deepEqual(claimReportedDevices({ accountId: ACC_B, ip: MACHINE_IP, key: KEY_B }), [DEV_B])

    assert.equal(bindingOf(DEV_A), ACC_A)
    assert.equal(bindingOf(DEV_B), ACC_B)
    assert.equal(audits.length, 2)
})

test("游戏报到时，带容器键的门登录不会把别的实例拉过去", () => {
    reset()
    noteGateLogin({ accountId: ACC_B, ip: MACHINE_IP, key: KEY_B })

    assert.equal(
        followAccountForSignup({ deviceId: DEV_A, ip: MACHINE_IP, path: STORE_A }),
        null,
        "A 实例的报到不该跟随 B 实例的门登录",
    )
    assert.equal(
        followAccountForSignup({ deviceId: DEV_B, ip: MACHINE_IP, path: STORE_B }),
        ACC_B,
        "同一个容器的报到必须跟随",
    )
})

test("没带容器键的老客户端仍然按来源 IP 并号（iOS 那条路不能被弄坏）", () => {
    reset()
    noteGateLogin({ accountId: ACC_A, ip: MACHINE_IP })
    assert.equal(
        followAccountForSignup({ deviceId: DEV_A, ip: MACHINE_IP, path: "" }),
        ACC_A,
        "无键的门登录 + 同 IP 的报到 = 原来的并号行为",
    )

    reset()
    noteSignupDevice({ deviceId: DEV_A, ip: MACHINE_IP, path: "" })
    assert.deepEqual(
        claimReportedDevices({ accountId: ACC_A, ip: MACHINE_IP }),
        [DEV_A],
        "无键的门登录仍要认领同 IP 报到过的设备号",
    )
})

test("容器键的形状是有意义的：太短会被当成没带键，退回按 IP 匹配", () => {
    reset()
    noteSignupDevice({ deviceId: DEV_B, ip: MACHINE_IP, path: STORE_B })

    // 包名/数据目录末段这类「所有玩家都一样」的串 —— `isContainerKey` 不认，
    // 于是退回按 IP 认领。桌面启动器的 `<slot>-<12 位十六进制>` 必须 ≥16 位、
    // 全小写，否则多开会串号（见 launcher 的 `client_key_of`）。
    assert.deepEqual(
        claimReportedDevices({ accountId: ACC_A, ip: MACHINE_IP, key: "com.leiting.wf" }),
        [DEV_B],
    )
})

test("超出「只靠 IP」的窗口就不再配对，容器匹配不受这个窗口限制", () => {
    reset()
    const gateAt = nowMs
    noteGateLogin({ accountId: ACC_A, ip: MACHINE_IP })

    const ipTtlRaw = process.env.SP_DEVICE_FOLLOW_IP_TTL_MS
    process.env.SP_DEVICE_FOLLOW_IP_TTL_MS = "1000"
    try {
        nowMs = gateAt + 5000
        assert.equal(
            followAccountForSignup({ deviceId: DEV_A, ip: MACHINE_IP, path: "" }),
            null,
            "过了 IP 窗口就不该再按 IP 跟随",
        )
    } finally {
        if (ipTtlRaw === undefined) delete process.env.SP_DEVICE_FOLLOW_IP_TTL_MS
        else process.env.SP_DEVICE_FOLLOW_IP_TTL_MS = ipTtlRaw
        nowMs = 1_700_000_000_000
    }
})
