"use strict"
// A8 / P7 · build-client.mjs 的回归测试。
//
// 纪律（照抄 tools/ios_ipa_patch.test.cjs 的路子）：
//   - 全程用**合成夹具**（自造 SWF + 自造 APK + 假 zipalign/apksigner/java 桩），绝不碰 apkipa/ 里的真素材；
//   - 地址一律用 172.16.10.105:8001（18 字符）。不用 192.168.x.y：仓库里禁写个人 IP（scripts/check-hygiene.sh 只放行 192.168.1.10）；
//   - 断言的是**行为契约**：缺 --host 必须拒、报告结构必须齐、地址必须真的落到 SWF 里、缺凭据必须明说「未签名」而不是假装成功。

const assert = require("node:assert/strict")
const { test, before, after } = require("node:test")
const { spawnSync } = require("node:child_process")
const { deflateRawSync, deflateSync, inflateSync } = require("node:zlib")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

const REPO = path.join(__dirname, "..")
const CLI = path.join(REPO, "client-patch", "build", "build-client.mjs")
const MAIN_SWF = "assets/worldflipper_android_release.swf"
const RENAME_TOOL = path.join(REPO, "client-patch", "tools", "rename-package.mjs")

const HOST = "172.16.10.105"
const PORT = "8001"
const HOST_PORT = `${HOST}:${PORT}`
const OLD_HOST = "shijtswygamegf.leiting.com"
const NEW_AUTHORITY = `${"0".repeat(8)}@${HOST_PORT}`

let ROOT = null
let fx = null

// ───────────────────────── 夹具 ─────────────────────────

/** 确定性伪随机填充：让 FWS 与 CWS 两种形态的体积都随 pad 线性增长（防止 deflate 把夹具压成几十字节）。 */
function filler(length, seed) {
    const buffer = Buffer.alloc(length)
    let x = seed >>> 0
    for (let i = 0; i < length; i += 1) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0
        buffer[i] = (x >>> 24) & 0xff
    }
    return buffer
}

/** 合成一份「逻辑 FWS」：只有 ABC 常量池里的 scheme+host 对是真的，其余是填充。 */
function syntheticSwf({ host = OLD_HOST, pad = 4096, seed = 1 } = {}) {
    const parts = [filler(pad, seed)]
    if (host) {
        parts.push(Buffer.from([0x05]), Buffer.from("https", "latin1"), Buffer.from([0x1a]), Buffer.from(host, "latin1"))
    }
    parts.push(filler(pad, seed + 977))
    const body = Buffer.concat(parts)
    const header = Buffer.alloc(8)
    header.write("FWS", 0, "latin1")
    header[3] = 44
    header.writeUInt32LE(8 + body.length, 4)
    return Buffer.concat([header, body])
}

/** 把逻辑 FWS 包成 CWS（第二份基线 安卓v15.2.apk 就是这个形态）。 */
function toCws(logical) {
    const packed = deflateSync(logical.subarray(8), { level: 9 })
    const header = Buffer.alloc(8)
    header.write("CWS", 0, "latin1")
    header[3] = logical[3]
    header.writeUInt32LE(logical.length, 4)
    return Buffer.concat([header, packed])
}

function swfHostCount(entryData) {
    const logical = entryData.toString("latin1", 0, 3) === "CWS"
        ? Buffer.concat([Buffer.from("FWS", "latin1"), entryData.subarray(3, 8), inflateSync(entryData.subarray(8))])
        : entryData
    const count = (needle) => {
        const pattern = Buffer.from(needle, "latin1")
        let hits = 0
        let at = logical.indexOf(pattern)
        while (at !== -1) {
            hits += 1
            at = logical.indexOf(pattern, at + pattern.length)
        }
        return hits
    }
    return { logical, old: count(OLD_HOST), authority: count(NEW_AUTHORITY), scheme: count("https") }
}

/** 用仓库自己的零依赖 ZIP 引擎造一个合成 APK（保住 method/versionMadeBy/externalAttr 的真实性）。 */
async function buildFixtureApk(zip, dir, { encoding = "fws" } = {}) {
    const logical = syntheticSwf()
    const mainSwf = encoding === "cws" ? toCws(logical) : logical
    const worker = toCws(syntheticSwf({ host: null, pad: 8, seed: 50021 }))
    const entries = []
    const add = (name, data, method = 8, versionMadeBy = 0x14, externalAttr = 0) => {
        const raw = method === 8 ? deflateRawSync(data, { level: 9 }) : data
        entries.push({
            name, method, flags: 0, mtime: 0x6000, mdate: 0x5000,
            crc: zip.crc32(data), csize: raw.length, usize: data.length,
            versionMadeBy, externalAttr, raw,
        })
    }
    add(MAIN_SWF, mainSwf)
    add("AndroidManifest.xml", Buffer.from("<manifest package=\"com.leiting.wf\"/>", "utf8"), 8, 0x0, 0)
    add("assets/BackgroundWorker.swf", worker, 8, 0x0a, 0)
    add("lib/arm64-v8a/libCore.so", Buffer.alloc(4096, 7), 8, 0x14, 0x81a40000)
    add("META-INF/MANIFEST.MF", Buffer.from("Manifest-Version: 1.0\r\n\r\n", "utf8"))
    add("META-INF/1.SF", Buffer.from("Signature-Version: 1.0\r\n\r\n", "utf8"))
    add("META-INF/1.RSA", Buffer.alloc(64, 3))
    // 这两个是 Play/Oppo 的市场元数据，不是签名件 —— 产线绝不许摘掉它们
    add("META-INF/com.android.tools.metadata/drm/com.google.play/metadata.bin", Buffer.alloc(134, 9), 0, 0x300, 0x81a40000)
    const file = path.join(dir, `base-${encoding}.apk`)
    fs.writeFileSync(file, zip.writeZipEntries(entries))
    return { file, entries, mainSwf, logical, worker }
}

const FAKE_ZIPALIGN = `#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs"
const argv = process.argv.slice(2)
if (argv.includes("-c")) { console.log("Verification succesful"); process.exit(0) }
const [src, dst] = argv.slice(-2)
if (!existsSync(src)) { console.error("fake zipalign: 输入不存在 " + src); process.exit(1) }
copyFileSync(src, dst)
console.log("fake zipalign: " + dst)
`

const FAKE_APKSIGNER = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs"
const MARK = Buffer.from("SPCN-FAKE-SIGNATURE")
const argv = process.argv.slice(2)
const cmd = argv[0]
const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1] }
const fail = (m) => { console.error(m); process.exit(1) }

if (cmd === "sign") {
  const pass = value("--ks-pass")
  if (!value("--ks")) fail("fake apksigner: 缺少 --ks")
  if (!pass || !pass.startsWith("env:")) fail("fake apksigner: 口令必须走 env: 语法，收到 " + String(pass))
  if (!process.env[pass.slice(4)]) fail("fake apksigner: 环境变量 " + pass.slice(4) + " 为空")
  const input = argv[argv.length - 1]
  if (!existsSync(input)) fail("fake apksigner: 输入不存在 " + input)
  writeFileSync(value("--out"), Buffer.concat([readFileSync(input), MARK]))
  console.log("fake apksigner: signed " + value("--out"))
  process.exit(0)
}

if (cmd === "verify") {
  const target = argv[argv.length - 1]
  if (!existsSync(target)) fail("fake apksigner: 目标不存在 " + target)
  if (!readFileSync(target).includes(MARK)) {
    console.error("DOES NOT VERIFY")
    console.error("ERROR: Missing signature (fake apksigner: 没有 SPCN-FAKE-SIGNATURE 标记)")
    process.exit(1)
  }
  console.log("Verifies")
  console.log("Verified using v2 scheme (APK Signature Scheme v2): true")
  console.log("Signer #1 certificate DN: CN=StartPoint CN Launcher, O=StartPoint, C=TW")
  process.exit(0)
}

fail("fake apksigner: 未知子命令 " + String(cmd))
`

// --java 桩：只负责吐 FFDec 版本横幅（真 java 跑 dummy jar 会直接报错，版本抓不到）
const FAKE_JAVA = `#!/usr/bin/env node
console.log("JPEXS Free Flash Decompiler v." + (process.env.FAKE_FFDEC_VERSION || "24.0.1"))
`

const FAKE_HOOK = `export async function transformSwf(ctx) {
    return { swf: ctx.logicalSwf, notes: ["fake-hook：原样返回（夹具用）"] }
}
`

function writeStubs(dir) {
    const zipalign = path.join(dir, "fake-zipalign.mjs")
    const apksigner = path.join(dir, "fake-apksigner.mjs")
    const java = path.join(dir, "fake-java.mjs")
    const hook = path.join(dir, "fake-as3-hook.mjs")
    const jar = path.join(dir, "ffdec-jar-placeholder.jar")
    const keystore = path.join(dir, "fake.keystore")
    fs.writeFileSync(zipalign, FAKE_ZIPALIGN)
    fs.writeFileSync(apksigner, FAKE_APKSIGNER)
    fs.writeFileSync(java, FAKE_JAVA)
    fs.writeFileSync(hook, FAKE_HOOK)
    fs.writeFileSync(jar, "not a real jar")
    fs.writeFileSync(keystore, "not a real keystore")
    return { zipalign, apksigner, java, hook, jar, keystore }
}

let tools = null

function run(argv, { env = {} } = {}) {
    return spawnSync(process.execPath, [CLI, ...argv], {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, ...env },
    })
}

function out(name) {
    return path.join(fx.dir, name)
}

function workDir(name) {
    return path.join(fx.dir, `work-${name}`)
}

/** 拼一条最常见的实跑命令（假工具 + 不签名）。 */
function baseArgs(name, extra = []) {
    return [
        "--base", fx.fws.file,
        "--host", HOST,
        "--port", PORT,
        "--out", out(`${name}.apk`),
        "--work", workDir(name),
        "--zipalign", tools.zipalign,
        "--apksigner", tools.apksigner,
        ...extra,
    ]
}

function readReport(file) {
    return JSON.parse(fs.readFileSync(`${file}.build-report.json`, "utf8"))
}

before(async () => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "spcn-build-test-"))
    assert.match(ROOT, /^[\x20-\x7e]+$/, "夹具根目录必须是纯 ASCII（FFDec 硬要求，脚本会硬拦）")
    tools = writeStubs(ROOT)
    const zip = await import(pathToFileURL(path.join(REPO, "client-patch", "build", "lib", "zip-ipa.mjs")).href)
    fx = { dir: path.join(ROOT, "fx"), zip }
    fs.mkdirSync(fx.dir, { recursive: true })
    fx.fws = await buildFixtureApk(zip, fx.dir, { encoding: "fws" })
    fx.cws = await buildFixtureApk(zip, fx.dir, { encoding: "cws" })
})

after(() => {
    if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true })
})

// ───────────────────────── 1. 参数契约 ─────────────────────────

test("缺 --host 时拒绝执行并以非 0 退出（地址只能来自参数，绝不内嵌实例地址）", () => {
    const result = run(["--base", fx.fws.file, "--port", PORT, "--out", out("nope.apk")])
    assert.notEqual(result.status, 0)
    assert.match(String(result.stderr || result.stdout), /--host/)
})

test("缺 --out / --port 时同样拒绝，且指出缺的是哪一个", () => {
    const noOut = run(["--base", fx.fws.file, "--host", HOST, "--port", PORT])
    assert.notEqual(noOut.status, 0)
    assert.match(String(noOut.stderr || noOut.stdout), /--out/)

    const noPort = run(["--base", fx.fws.file, "--host", HOST, "--out", out("nope2.apk")])
    assert.notEqual(noPort.status, 0)
    assert.match(String(noPort.stderr || noPort.stdout), /--port/)
})

test("--out 与 --base 同路径被拒（不许就地覆盖素材）", () => {
    const result = run(["--base", fx.fws.file, "--host", HOST, "--port", PORT, "--out", fx.fws.file])
    assert.notEqual(result.status, 0)
    assert.match(String(result.stderr || result.stdout), /同路径|不能与 --base/)
})

test("--port 非法值被拒", () => {
    const result = run(["--base", fx.fws.file, "--host", HOST, "--port", "70000", "--out", out("nope3.apk")])
    assert.notEqual(result.status, 0)
    assert.match(String(result.stderr || result.stdout), /--port/)
})

test("--rename-package 在 P12 未交付时给出清晰报错且不做事", { skip: fs.existsSync(RENAME_TOOL) ? "P12 已交付 rename-package.mjs，改由集成验证透传" : false }, () => {
    const result = run([...baseArgs("rename"), "--rename-package"])
    assert.notEqual(result.status, 0)
    const text = String(result.stderr || result.stdout)
    assert.match(text, /rename-package/)
    assert.match(text, /P12/)
    assert.equal(fs.existsSync(out("rename.apk")), false, "报错路径绝不产出文件")
})

// ───────────────────────── 2. dry-run ─────────────────────────

test("--dry-run 打印完整命令序列且不产生任何文件", () => {
    const before2 = fs.readdirSync(fx.dir).slice().sort()
    const result = run([...baseArgs("dry"), "--dry-run"])
    assert.equal(result.status, 0, result.stderr)

    const stdout = String(result.stdout)
    // 完整序列 = 常量改写 + 回封 + zipalign(对齐/校验) + 签名或未签名说明
    assert.match(stdout, /applyApiBaseRewrite\(swf, \{ hostPort: "172\.16\.10\.105:8001" \}\)/)
    assert.match(stdout, /writeZipEntries\(entries\)/)
    assert.match(stdout, /fake-zipalign\.mjs -p -f 4/)
    assert.match(stdout, /fake-zipalign\.mjs -c -p 4/)
    assert.match(stdout, /未签名（缺凭据）/)
    assert.match(stdout, /未产生任何文件/)

    assert.deepEqual(fs.readdirSync(fx.dir).slice().sort(), before2, "dry-run 之后目录内容必须逐项不变")
    assert.equal(fs.existsSync(out("dry.apk")), false)
    assert.equal(fs.existsSync(`${out("dry.apk")}.build-report.json`), false)
    assert.equal(fs.existsSync(workDir("dry")), false, "dry-run 连临时目录都不该建")
})

test("--dry-run 里的计划命令一律用占位符指代中间产物", () => {
    const result = run([...baseArgs("dry2"), "--dry-run"])
    assert.equal(result.status, 0, result.stderr)
    assert.match(String(result.stdout), /"<unsigned\.apk>"/)
    assert.match(String(result.stdout), /"<aligned\.apk>"/)
})

// ───────────────────────── 3. 未签名路径 ─────────────────────────

test("缺凭据时产出未签名 APK 并明确报「未签名（缺凭据）」，不伪造签名成功", () => {
    const target = out("unsigned.apk")
    const result = run(baseArgs("unsigned"))
    assert.equal(result.status, 0, result.stderr)

    const stdout = String(result.stdout)
    assert.match(stdout, /\[WARN\] 未签名（缺凭据）：未提供 --ks/)
    assert.match(stdout, /不可安装/)
    assert.equal(fs.existsSync(target), true, "未签名路径也要交出产物")

    const report = readReport(target)
    assert.equal(report.signing.signed, false)
    assert.equal(report.signing.requested, false)
    assert.match(report.signing.reason, /未签名（缺凭据）/)
    assert.equal(report.signing.verify, null)
    assert.equal(report.ok, true, "未签名默认不算失败（除非 --require-signature）")
    assert.equal(report.assertions.failed, 0, JSON.stringify(report.assertions.list.filter(item => !item.ok)))
    assert.ok(report.unverified.some(line => /签名与安装/.test(line)), "未验证项里必须挂上签名/装机这一条")
})

test("--require-signature 把「未签名」升级为硬失败（退出码 2）", () => {
    const result = run(baseArgs("require", ["--require-signature"]))
    assert.equal(result.status, 2)
    assert.match(String(result.stderr) + String(result.stdout), /未签名（缺凭据）/)
    const report = readReport(out("require.apk"))
    assert.equal(report.ok, false)
    assert.ok(report.assertions.failed >= 1, "断言里必须记一条失败")
})

// ───────────────────────── 4. 报告结构与地址落盘 ─────────────────────────

test("构建报告结构齐备，host/port 真的落到 SWF 里（站点前后指纹可对照）", async () => {
    const target = out("report.apk")
    const result = run(baseArgs("report"))
    assert.equal(result.status, 0, result.stderr)

    const report = readReport(target)
    assert.equal(report.schema, "sp-cn.client-build/v1")
    assert.equal(report.tool.name, "build-client.mjs")
    assert.equal(report.dryRun, false)
    assert.equal(report.ok, true)
    assert.equal(report.endpoint.host, HOST)
    assert.equal(report.endpoint.port, PORT)
    assert.equal(report.endpoint.hostPort, HOST_PORT, "host/port 必须拼成 host:port 一处产出")
    assert.equal(report.endpoint.apiBase, `http://${NEW_AUTHORITY}`)

    // 输入侧：sha256 必须与素材逐字节一致
    assert.equal(report.inputs.base.sha256, (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(fx.fws.file)).digest("hex"))
    assert.equal(report.inputs.baseEntries, fx.fws.entries.length)

    // SWF 侧
    assert.equal(report.swf.entry, MAIN_SWF)
    assert.equal(report.swf.encodedAs, "FWS")
    assert.equal(report.swf.repacked, false)
    assert.equal(report.swf.swfVersion, 44)
    assert.equal(report.swf.logicalBytesBefore, fx.fws.logical.length)
    assert.equal(report.swf.logicalBytesAfter, fx.fws.logical.length, "33 B 成对改写必须长度守恒")
    assert.notEqual(report.swf.sha256Before, report.swf.sha256After,
        "改写前后哈希必须不同 —— applyApiBaseRewrite 会就地改写 Buffer，惰性计算会把改写后的值当成改写前的")

    // 站点指纹前后对照
    assert.equal(report.siteFingerprint.before.hostCount, 1)
    assert.equal(report.siteFingerprint.before.pairOccurrences, 1)
    assert.equal(report.siteFingerprint.before.pairTotalBytes, 33)
    assert.equal(report.siteFingerprint.after.hostCount, 0)
    assert.equal(report.siteFingerprint.after.pairOccurrences, 0)
    assert.equal(report.route, "abc-pair")
    assert.equal(report.rewrite.applied, 1)
    assert.ok(report.rewrite.diffRanges.length > 0)

    // v1 签名摘掉、市场元数据保留
    assert.deepEqual(report.zip.droppedV1Signatures.slice().sort(), ["META-INF/1.RSA", "META-INF/1.SF", "META-INF/MANIFEST.MF"])
    assert.equal(report.zip.entriesAfter, fx.fws.entries.length - 3)

    // 产物侧：主 SWF 里旧 host 清零、新 authority 就位，其它 entry 原样
    const outEntries = fx.zip.readZipEntries(fs.readFileSync(target))
    const names = outEntries.map(entry => entry.name)
    assert.equal(names.includes("META-INF/1.RSA"), false)
    assert.equal(names.includes("META-INF/com.android.tools.metadata/drm/com.google.play/metadata.bin"), true, "市场元数据不是签名件，绝不能摘")
    assert.equal(names.length, fx.fws.entries.length - 3)

    const main = outEntries.find(entry => entry.name === MAIN_SWF)
    const manifest = outEntries.find(entry => entry.name === "AndroidManifest.xml")
    const so = outEntries.find(entry => entry.name === "lib/arm64-v8a/libCore.so")
    assert.equal(main.method, 8, "压缩方法必须沿用基线的 deflate")
    assert.equal(manifest.method, 8)
    assert.equal(so.method, 8)
    assert.equal(so.versionMadeBy, 0x14, "versionMadeBy 必须逐条保留")
    assert.equal(so.externalAttr, 0x81a40000, "externalAttr 必须逐条保留（它决定 unix 权限位）")

    const patched = fx.zip.readEntryData(main)
    const counts = swfHostCount(patched)
    assert.equal(counts.old, 0, "旧 host 必须消失")
    assert.equal(counts.authority, 1, "新 authority 必须出现且只出现一次")
    assert.equal(patched.length, fx.fws.mainSwf.length, "entry 字节长度守恒")

    // 产物 sha256 = 报告里记的 sha256
    assert.equal(report.output.sha256, (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(target)).digest("hex"))
    assert.equal(report.output.bytes, fs.statSync(target).size)

    // ANE/BackgroundWorker 不含旧 host ⇒ 断言应当通过且被记进报告
    assert.ok(report.assertions.list.some(item => /其它 SWF/.test(item.name) && item.ok))
})

test("CWS（Deflate 压缩 SWF）基线同样能出包 —— 安卓v15.2.apk 就是这个形态", () => {
    const target = out("cws.apk")
    const args = baseArgs("cws").map(item => (item === fx.fws.file ? fx.cws.file : item))
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)

    const report = readReport(target)
    assert.equal(report.swf.encodedAs, "CWS")
    assert.equal(report.swf.repacked, true)
    assert.equal(report.swf.logicalBytesBefore, fx.cws.logical.length)
    assert.equal(report.swf.logicalBytesAfter, fx.cws.logical.length, "CWS 回封后逻辑长度仍守恒")
    assert.equal(report.siteFingerprint.after.hostCount, 0)

    const main = fx.zip.readZipEntries(fs.readFileSync(target)).find(entry => entry.name === MAIN_SWF)
    const patched = fx.zip.readEntryData(main)
    assert.equal(patched.toString("latin1", 0, 3), "CWS", "回封后必须还是 CWS，不能悄悄变成 FWS")
    assert.equal(patched.readUInt32LE(4), fx.cws.logical.length, "CWS 头部 fileLength 要指向解压后长度")
    const counts = swfHostCount(patched)
    assert.equal(counts.old, 0)
    assert.equal(counts.authority, 1)
})

// ───────────────────────── 5. 签名路径（假 apksigner） ─────────────────────────

test("给了 keystore + 口令环境变量时走完整签名链，并把 verify 结果写进报告", () => {
    const target = out("signed.apk")
    const result = run(baseArgs("signed", ["--ks", tools.keystore, "--ks-pass-env", "SPCN_TEST_KS_PASS"]), {
        env: { SPCN_TEST_KS_PASS: "fixture-passphrase" },
    })
    assert.equal(result.status, 0, result.stderr)

    const stdout = String(result.stdout)
    assert.equal(/未签名（缺凭据）/.test(stdout), false, "有凭据就不该再喊未签名")

    const report = readReport(target)
    assert.equal(report.signing.requested, true)
    assert.equal(report.signing.signed, true)
    assert.equal(report.signing.reason, null)
    assert.equal(report.signing.keystore, path.basename(tools.keystore), "报告只记 keystore 文件名，不记路径也不记口令")
    assert.equal(report.signing.passEnvVar, "SPCN_TEST_KS_PASS")
    assert.equal(report.signing.verify.ok, true)
    assert.match(report.signing.signerCertificateDN, /StartPoint CN Launcher/)
    assert.equal(JSON.stringify(report).includes("fixture-passphrase"), false, "口令绝不进报告")
    assert.equal(report.assertions.failed, 0, JSON.stringify(report.assertions.list.filter(item => !item.ok)))
    assert.equal(fs.readFileSync(target).includes(Buffer.from("SPCN-FAKE-SIGNATURE")), true)
})

test("口令环境变量为空时不签名，也不假装成功（只记原因）", () => {
    const target = out("nopass.apk")
    const result = run(baseArgs("nopass", ["--ks", tools.keystore, "--ks-pass-env", "SPCN_TEST_KS_PASS"]))
    assert.equal(result.status, 0, result.stderr)
    assert.match(String(result.stdout), /未签名（缺凭据）：环境变量 SPCN_TEST_KS_PASS 为空/)
    const report = readReport(target)
    assert.equal(report.signing.signed, false)
    assert.match(report.signing.reason, /SPCN_TEST_KS_PASS/)
})

// ───────────────────────── 6. FFDec 版本与 AS3 钩子 ─────────────────────────

test("FFDec 版本不匹配 + AS3 钩子 ⇒ 拒绝执行（整类替换会重写整份 ABC，版本敏感）", () => {
    const result = run(baseArgs("mismatch", [
        "--ffdec", tools.jar, "--java", tools.java, "--as3-hook", tools.hook,
    ]), { env: { FAKE_FFDEC_VERSION: "26.2.1" } })
    assert.equal(result.status, 2)
    assert.match(String(result.stderr), /FFDec 版本不匹配/)
    assert.match(String(result.stderr), /24\.0\.1/)
    assert.equal(fs.existsSync(out("mismatch.apk")), false, "拒绝执行就不该有产物")
})

test("--allow-ffdec-version-mismatch 显式承担风险后才继续（钩子被真的调用）", () => {
    const target = out("hook.apk")
    const result = run(baseArgs("hook", [
        "--ffdec", tools.jar, "--java", tools.java, "--as3-hook", tools.hook, "--allow-ffdec-version-mismatch",
    ]), { env: { FAKE_FFDEC_VERSION: "26.2.1" } })
    assert.equal(result.status, 0, result.stderr)

    const report = readReport(target)
    assert.equal(report.as3Hook.executed, true)
    assert.equal(report.tools.ffdec.version, "26.2.1")
    assert.equal(report.tools.ffdec.path, tools.jar, "报告必须记录实际用的 FFDec 路径")
    assert.deepEqual(report.as3Hook.notes, ["fake-hook：原样返回（夹具用）"])
    assert.equal(report.route, "as3-hook+abc-pair", "钩子没改地址 ⇒ 端点确保阶段照样兜底改写")
    assert.equal(report.siteFingerprint.after.hostCount, 0)
})

test("版本不匹配但没开 AS3 钩子时只降级为警告（默认路线不依赖 FFDec）", () => {
    const result = run(baseArgs("warnonly", ["--ffdec", tools.jar, "--java", tools.java]), { env: { FAKE_FFDEC_VERSION: "26.2.1" } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(String(result.stdout), /\[WARN\] FFDec 版本 26\.2\.1/)
    const report = readReport(out("warnonly.apk"))
    assert.equal(report.as3Hook.executed, false)
    assert.ok(report.warnings.some(line => /FFDec 版本/.test(line)))
})

test("--as3-hook 缺 --ffdec 时在预检就拒绝", () => {
    const result = run(baseArgs("nohook", ["--as3-hook", tools.hook]))
    assert.notEqual(result.status, 0)
    assert.match(String(result.stderr || result.stdout), /--ffdec/)
})

// ───────────────────────── 7. 夹具自检（防止测试自身失效） ─────────────────────────

test("夹具自检：合成 SWF 的常量对唯一且可成对改写", async () => {
    const { findSchemeHostPair, applyApiBaseRewrite } = await import(
        pathToFileURL(path.join(REPO, "client-patch", "build", "lib", "ios-abc.mjs")).href)
    const pair = findSchemeHostPair(fx.fws.logical)
    assert.equal(pair.occurrences, 1)
    assert.equal(pair.totalBytes, 33)
    const applied = applyApiBaseRewrite(fx.fws.logical, { hostPort: HOST_PORT })
    assert.equal(applied.applied, 1)
    assert.equal(applied.reason.includes("33 B 守恒"), true)
})

test("夹具自检：假 APK 能被自家 ZIP 引擎读回，v1 签名件识别得出来", async () => {
    const mod = await import(pathToFileURL(CLI).href)
    const entries = fx.zip.readZipEntries(fs.readFileSync(fx.fws.file))
    assert.equal(mod.isV1SignatureEntry("META-INF/MANIFEST.MF"), true)
    assert.equal(mod.isV1SignatureEntry("META-INF/1.SF"), true)
    assert.equal(mod.isV1SignatureEntry("META-INF/1.RSA"), true)
    assert.equal(mod.isV1SignatureEntry("META-INF/com.android.tools.metadata/drm/com.google.play/metadata.bin"), false)
    assert.equal(mod.isV1SignatureEntry("assets/worldflipper_android_release.swf"), false)
    assert.equal(mod.isV1SignatureEntry("META-INF/ANE/Android-ARM64/library.swf"), false)
    assert.equal(mod.findMainSwfEntry(entries).name, MAIN_SWF)
    const cws = mod.unwrapSwf(fx.cws.mainSwf)
    assert.equal(cws.magic, "CWS")
    assert.equal(cws.logical.length, fx.cws.logical.length)
    assert.throws(() => mod.unwrapSwf(Buffer.concat([Buffer.from("ZWS", "latin1"), fx.cws.mainSwf.subarray(3)])), /ZWS/)
    const argv = mod.parseArgv(["--base", "a.apk", "--host=1.2.3.4", "--dry-run", "--rename-package"])
    assert.deepEqual(argv, { base: "a.apk", host: "1.2.3.4", "dry-run": true, "rename-package": true })
})

// ─────────── 8. 改名回读的两条边界（P7c 端到端实跑逼出来的断言 bug，静态读代码发现不了） ───────────

const OLD_PKG = "com.leiting.wf"
const NEW_PKG = "cn.starpoint.a"

/**
 * 造一个只含 manifest（可指定 UTF-16LE）+ 可选 application.xml 的最小 APK。
 * AIR 的真实形态是 manifest 里**必然**带 `air.<旧包名>.AppEntry`（入口类名，改名工具按规矩逐字保留），
 * 所以回读逻辑必须能区分「标识符开头」与「更长标识符内部」两种命中。
 */
function renameFixtureApk({ manifestText, manifestUtf16 = true, applicationXml = null }) {
    const add = (name, data, entries) => entries.push({
        name, method: 8, flags: 0, mtime: 0x6000, mdate: 0x5000,
        crc: fx.zip.crc32(data), csize: deflateRawSync(data, { level: 9 }).length, usize: data.length,
        versionMadeBy: 0x14, externalAttr: 0, raw: deflateRawSync(data, { level: 9 }),
    })
    const entries = []
    add("AndroidManifest.xml", Buffer.from(manifestText, manifestUtf16 ? "utf16le" : "utf8"), entries)
    if (applicationXml !== null) add("assets/META-INF/AIR/application.xml", Buffer.from(applicationXml, "utf8"), entries)
    return fx.zip.writeZipEntries(entries)
}

test("改名回读：air.<旧包名>.AppEntry 是受保护串，不算身份残留（朴素 substring 会误杀正确产物）", async () => {
    const mod = await import(pathToFileURL(CLI).href)
    const manifest = `<manifest package="${NEW_PKG}">`
        + `<provider android:authorities="${NEW_PKG}.fileprovider"/>`
        + `<application android:name="air.${OLD_PKG}.AppEntry"/>`
        + `</manifest>`
    const result = mod.checkRenamedApk(renameFixtureApk({ manifestText: manifest }), { from: OLD_PKG, to: NEW_PKG })
    assert.equal(result.hasManifest, true)
    assert.equal(result.manifestHasTo, true)
    // 陷阱本身也钉住：朴素 substring 必然命中 AppEntry 内部那一段 —— 这正是旧断言判死正确产物的原因。
    assert.equal(result.manifestHasFrom, true, "整串 substring 仍会出现（AppEntry 内部），所以不能直接拿它当判据")
    assert.equal(result.manifestFromResidues, 0, "但「落在标识符开头」的残留必须为 0")
    assert.deepEqual(result.manifestFromResidueSamples, [])
})

test("改名回读：真正没改干净的旧包名（落在标识符开头）必须被抓到并给出样例", async () => {
    const mod = await import(pathToFileURL(CLI).href)
    const manifest = `<manifest package="${NEW_PKG}">`
        + `<provider android:authorities="${OLD_PKG}.fileprovider"/>`
        + `<application android:name="air.${OLD_PKG}.AppEntry"/>`
        + `</manifest>`
    const result = mod.checkRenamedApk(renameFixtureApk({ manifestText: manifest }), { from: OLD_PKG, to: NEW_PKG })
    assert.equal(result.manifestFromResidues, 1, "只有真残留被计数，AppEntry 不计")
    assert.deepEqual(result.manifestFromResidueSamples, [`${OLD_PKG}.fileprovider`])
})

test("改名回读：UTF-8 变体 manifest 与 application.xml 的 <id> 一并核对", async () => {
    const mod = await import(pathToFileURL(CLI).href)
    const apk = renameFixtureApk({
        manifestText: `<manifest package="${OLD_PKG}"/>`,
        manifestUtf16: false,
        applicationXml: `<application><id>${OLD_PKG}</id></application>`,
    })
    const result = mod.checkRenamedApk(apk, { from: OLD_PKG, to: NEW_PKG })
    assert.equal(result.hasApplicationXml, true)
    assert.equal(result.manifestFromResidues, 1, "package=\" 后面的命中落在标识符开头 ⇒ 计数")
    assert.equal(result.manifestHasTo, false)
    assert.equal(result.applicationXmlHasFrom, true)
    assert.equal(result.applicationXmlHasTo, false)
})

// ─────────── 8b. 身份残留计数器的字节级契约（isIdentByte / countIdentityResidues 未导出，全经 checkRenamedApk 观察） ───────────
//
// E17：`--rename-package` 后统计旧包名残留，**只有落在标识符开头的命中才算残留**；出现在更长标识符
// 内部的（AIR 入口类 air.<旧包名>.AppEntry，前一个字节是 `.`）是受保护串。判定只看命中**左侧一个字节**
// 是否属于 isIdentByte（0-9 A-Z a-z _ $ . -），右侧只影响样例文本的截断。
// 下面每个用例都用一份独立的合成 manifest，避免一处命中污染另一处。

/** 造一份只含 manifest 的夹具并回读；manifestUtf16=false 时走 UTF-8 变体（另一条编码分支）。 */
async function residueProbe({ manifestText, manifestUtf16 = true }) {
    const mod = await import(pathToFileURL(CLI).href)
    return mod.checkRenamedApk(renameFixtureApk({ manifestText, manifestUtf16 }), { from: OLD_PKG, to: NEW_PKG })
}

test("残留计数：独立出现的旧包名（前后都不是标识符字节）必须计数，样例不被吞长", async () => {
    const result = await residueProbe({ manifestText: `<manifest package="${OLD_PKG}"/>` })
    // 朴素 substring 在这里也命中 —— 这是「必须计数」的正向钉子：判定收得过紧就会漏报真残留。
    assert.equal(result.manifestHasFrom, true, "整串 substring 确实还在（但这一项不是判据）")
    assert.equal(result.manifestFromResidues, 1)
    assert.deepEqual(result.manifestFromResidueSamples, [OLD_PKG], "右侧紧跟 「\"」（0x22）不是标识符字节 ⇒ 样例到命中末尾为止")
})

test("残留计数：air.<旧包名>.AppEntry 单独出现时一处都不计数（前一个字节是 `.`，属于更长标识符）", async () => {
    const entry = `air.${OLD_PKG}.AppEntry`
    const result = await residueProbe({ manifestText: `<application android:name="${entry}"/>` })
    assert.equal(result.manifestHasFrom, true, `整串 substring 仍在（藏在 ${entry} 内部）`)
    assert.equal(result.manifestFromResidues, 0, "受保护串：入口类名被逐字保留是正确产物，不能判死")
    assert.deepEqual(result.manifestFromResidueSamples, [], "不计数就不给样例")
})

test("残留计数：紧邻字母/数字/下划线/$/-/. 时按「更长标识符内部」不计数，紧邻其它字节则计数", async () => {
    for (const prev of ["A", "z", "0", "9", "_", "$", ".", "-"]) {
        const result = await residueProbe({ manifestText: `<m v="${prev}${OLD_PKG}"/>` })
        assert.equal(result.manifestHasFrom, true, `prev=${JSON.stringify(prev)}：substring 确实在`)
        assert.equal(result.manifestFromResidues, 0, `prev=${JSON.stringify(prev)} 是标识符字节 ⇒ 不得计数`)
        assert.deepEqual(result.manifestFromResidueSamples, [], `prev=${JSON.stringify(prev)} 不计数就不给样例`)
    }
    for (const prev of [" ", "/", ":", ">", "@", "[", "`", "{"]) {
        const result = await residueProbe({ manifestText: `<m v="${prev}${OLD_PKG}"/>` })
        assert.equal(result.manifestFromResidues, 1, `prev=${JSON.stringify(prev)} 不是标识符字节 ⇒ 必须计数`)
        assert.deepEqual(result.manifestFromResidueSamples, [OLD_PKG], `prev=${JSON.stringify(prev)}`)
    }
})

test("残留计数：命中落在缓冲区首字节或正好收尾时都要计数（越界保护不得吞掉边界命中）", async () => {
    const atStart = await residueProbe({ manifestText: `${OLD_PKG}/>` })      // index === 0 ⇒ left < 0 分支
    assert.equal(atStart.manifestFromResidues, 1)
    assert.deepEqual(atStart.manifestFromResidueSamples, [OLD_PKG])

    const atEnd = await residueProbe({ manifestText: `<m v="${OLD_PKG}` })    // 命中正好顶到 buffer 末尾，右侧无字节可读
    assert.equal(atEnd.manifestFromResidues, 1)
    assert.deepEqual(atEnd.manifestFromResidueSamples, [OLD_PKG], "末尾没有可并入的字节 ⇒ 样例不外溢")
})

test("残留计数：同一行真残留与 AppEntry 混合时，计数 = 真残留处数（受保护串贡献 0）", async () => {
    const manifest = `<manifest package="${OLD_PKG}">`
        + `<provider android:authorities="${OLD_PKG}.fileprovider"/>`
        + `<application android:name="air.${OLD_PKG}.AppEntry"/>`
        + `</manifest>`
    const mixed = await residueProbe({ manifestText: manifest })
    assert.equal(mixed.manifestHasFrom, true)
    assert.equal(mixed.manifestFromResidues, 2, "package= 1 处 + authorities 1 处；AppEntry 那处不计")
    assert.deepEqual(mixed.manifestFromResidueSamples, [OLD_PKG, `${OLD_PKG}.fileprovider`],
        "样例按出现顺序给出，且右侧标识符字节（.fileprovider）并入样例")

    // 与上一份一一对照：把真残留减到 1 处，计数必须跟着变成 1（不是「只要有 AppEntry 就固定值」）。
    const single = `<manifest package="${NEW_PKG}"><application android:name="air.${OLD_PKG}.AppEntry"/>`
        + `<provider android:authorities="${OLD_PKG}.vp"/></manifest>`
    const one = await residueProbe({ manifestText: single })
    assert.equal(one.manifestFromResidues, 1, "1 处真残留 + 1 处 AppEntry ⇒ 1")
    assert.deepEqual(one.manifestFromResidueSamples, [`${OLD_PKG}.vp`])
})

test("残留计数：isIdentByte 的字节集合由样例右边界暴露（0-9 A-Z a-z _ $ . - 是，其余截断）", async () => {
    const IDENT = ["0", "9", "A", "Z", "a", "z", "_", "$", ".", "-"]
    const NON_IDENT = [" ", "\t", "\"", "/", ":", "@", "[", "]", "^", "`", "{", "|", "}", "~",
        "+", "=", ",", ";", "!", "?", "%", "&", "*", "(", ")", "#", "<", ">", "\\", "'"]
    const hex = (c) => `0x${c.charCodeAt(0).toString(16)}`
    for (const c of IDENT) {
        const result = await residueProbe({ manifestText: `<m v="${OLD_PKG}${c}X"/>` })
        assert.equal(result.manifestFromResidues, 1, `c=${hex(c)}（左侧是 " 不影响计数）`)
        assert.deepEqual(result.manifestFromResidueSamples, [`${OLD_PKG}${c}X`], `c=${hex(c)} 是标识符字节 ⇒ 样例继续并入 X`)
    }
    for (const c of NON_IDENT) {
        const result = await residueProbe({ manifestText: `<m v="${OLD_PKG}${c}X"/>` })
        assert.equal(result.manifestFromResidues, 1, `c=${hex(c)}`)
        assert.deepEqual(result.manifestFromResidueSamples, [OLD_PKG], `c=${hex(c)} 不是标识符字节 ⇒ 样例在它之前截断`)
    }
    // 非 ASCII 字节（UTF-8 的 0xE4…）不在集合里：标识符集合是纯 ASCII 的。
    const nonAscii = await residueProbe({ manifestText: `<m v="${OLD_PKG}中X"/>`, manifestUtf16: false })
    assert.equal(nonAscii.manifestFromResidues, 1)
    assert.deepEqual(nonAscii.manifestFromResidueSamples, [OLD_PKG], "0xE4 不是标识符字节 ⇒ 截断")
})

test("残留计数：真残留超过 8 处时 count 照实累加、samples 只留前 8 条（报告样例有上限）", async () => {
    const manifest = Array.from({ length: 9 }, () => `<x a="${OLD_PKG}"/>`).join("")
    const result = await residueProbe({ manifestText: manifest })
    assert.equal(result.manifestFromResidues, 9, "count 不受样例上限影响")
    assert.equal(result.manifestFromResidueSamples.length, 8, "samples 上限 8")
    assert.equal(result.manifestFromResidueSamples.every(sample => sample === OLD_PKG), true)
})

// ─────────── 8c. 改名判据的端到端 PASS/FAIL（4 个 authorities 的 AIR 真实形态 + 三份变异体） ───────────
//
// 8/8b 钉的是 checkRenamedApk 这个**回读函数**的返回值；这一节钉的是**整条改名段**的判据：
// 走真 CLI（--rename-package）＋ 桩改名工具写产物，断言 [5.5] 那几条断言的 PASS/FAIL 与失败原因文本。
// 为什么非要到这一层：生产上 exit 2 就是照 assertions.list 判的（name = 哪一项，detail = 残留样例），
// 光看回读函数的返回值证明不了「这一项坏了就会被点名」。

const ZIP_ENGINE_URL = pathToFileURL(path.join(REPO, "client-patch", "build", "lib", "zip-ipa.mjs")).href

// 断言名按**片段**匹配：整名是「改名后 AndroidManifest.xml 的 package 已是目标包名」等，
// 取足以唯一区分的片段，免得改文案就把测试碰碎。注意不能只写「无旧包名残留」——
// application.xml 那条同名断言（夹具无该 entry 时恒 PASS）会先被匹配到。
const A_PACKAGE = "AndroidManifest.xml 的 package 已是目标包名"
const A_RESIDUE = "AndroidManifest.xml 无旧包名残留"
const A_ENTRIES = "改名未增删 zip 条目"

/** 真实包里的 4 个 provider：authorities 全部按 applicationId 派生（与 tools/rename_package.test.cjs 同一组后缀）。 */
const AUTHORITY_SUFFIXES = [".fileprovider", ".ltshare.fileprovider", ".provider", ".sobot_fileprovider"]

/**
 * 造一份「像真的」改名后 manifest（纯文本 XML —— 回读只做字节扫描，编码分支见 8b）：
 * package = 目标包名、4 个 authorities 都带目标前缀、**只**留 AIR 入口类 air.<旧包名>.AppEntry。
 * 三个具名开关分别用来做三份变异体。
 */
function renamedManifest({
    pkg = NEW_PKG,
    authorities = AUTHORITY_SUFFIXES.map(suffix => `${NEW_PKG}${suffix}`),
    appEntry = `air.${OLD_PKG}.AppEntry`,
    extra = "",
} = {}) {
    return `<manifest package="${pkg}">`
        + authorities.map(authority => `<provider android:authorities="${authority}"/>`).join("")
        + `<application android:name="${appEntry}"/>`
        + extra
        + `</manifest>`
}

/**
 * 桩改名工具：把 --in 的 AndroidManifest.xml 换成 SPCN_STUB_MANIFEST（其余 entry 原样搬过去，
 * 压缩方法/属性由 replaceEntryData 沿用），再按真工具的契约吐一行 JSON。
 * 有了它，**不改实现**就能把「改对了 / 改错了」喂进真实的 [5.5] 判定。
 */
const RENAME_STUB = `import { readFileSync, writeFileSync } from "node:fs"
import { readZipEntries, replaceEntryData, writeZipEntries } from ${JSON.stringify(ZIP_ENGINE_URL)}
const argv = process.argv.slice(2)
const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1] }
const manifest = process.env.SPCN_STUB_MANIFEST
if (!manifest) { console.error("rename-stub: 缺 SPCN_STUB_MANIFEST"); process.exit(1) }
const entries = readZipEntries(readFileSync(value("--in")))
replaceEntryData(entries, "AndroidManifest.xml", Buffer.from(manifest, "utf8"))
writeFileSync(value("--out"), writeZipEntries(entries))
console.log(JSON.stringify({ ok: true, from: "com.leiting.wf", to: value("--rename-to"), noop: false, equalLength: false }))
`

let renameStubPath = null
function renameStub() {
    if (renameStubPath === null) {
        renameStubPath = path.join(fx.dir, "rename-stub.mjs")
        fs.writeFileSync(renameStubPath, RENAME_STUB)
    }
    return renameStubPath
}

/** 走一次完整的 --rename-package 路线；manifestText = 桩写进产物的那份 manifest。 */
function runRenameRoute(name, manifestText, extra = []) {
    const result = run(baseArgs(name, ["--rename-package", "--rename-tool", renameStub(), ...extra]),
        { env: { SPCN_STUB_MANIFEST: manifestText } })
    return { result, report: readReport(out(`${name}.apk`)) }
}

/** 报告里没通过的断言名 —— 「失败原因能看出是哪一项」就靠它。 */
function failedAssertions(report) {
    return report.assertions.list.filter(item => !item.ok).map(item => item.name)
}

function assertionNamed(report, fragment) {
    const item = report.assertions.list.find(entry => String(entry.name).includes(fragment))
    assert.ok(item, `报告里应有含「${fragment}」的断言；实际：${report.assertions.list.map(e => e.name).join(" / ")}`)
    return item
}

/**
 * 取 detail 里「残留样例：…」那一段（0 处残留时该段不存在，返回空串）。
 * 不能直接拿整条 detail 判 —— detail 里**固定**写着「受保护串，如 air.com.leiting.wf.AppEntry」。
 */
function residueSamplesOf(item) {
    const marker = "残留样例："
    const at = String(item.detail).indexOf(marker)
    return at === -1 ? "" : String(item.detail).slice(at + marker.length)
}

test("改名判据（端到端）：package + 4 个 authorities 全带目标前缀、只留 air.<旧包名>.AppEntry ⇒ PASS（exit 0）", async () => {
    const manifest = renamedManifest()
    // 陷阱就在这份「改对了」的产物里：整串 substring 必然命中（air.com.leiting.wf.AppEntry 内部）。
    assert.equal(manifest.includes(`air.${OLD_PKG}.AppEntry`), true, "受保护串必须在产物里（否则这条用例没有陷阱）")
    const { result, report } = runRenameRoute("rename-ok", manifest, ["--keep-work"])
    assert.equal(result.status, 0, `exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`)
    assert.equal(report.ok, true)
    assert.deepEqual(failedAssertions(report), [], "改对了就不该有任何 FAIL")
    assert.equal(assertionNamed(report, A_PACKAGE).ok, true)
    assert.equal(assertionNamed(report, A_ENTRIES).ok, true)
    const residue = assertionNamed(report, A_RESIDUE)
    assert.equal(residue.ok, true)
    assert.match(residue.detail, /身份残留\(标识符开头\)=0 处/,
        "产物里明明有旧包名子串（AppEntry），残留却是 0 ⇒ 正确判据放行了受保护串")
    assert.equal(/残留样例/.test(residue.detail), false, "0 处残留就不该给样例")

    // 落到**真产物**（CLI 判过的那份 renamed.apk）上做对照：朴素 substring 判据说 true、正确判据说 0。
    // 这一条比拿夹具文本推理硬 —— 它证明的是「差一点被判死的正是这份产物」。
    const renamed = fs.readFileSync(path.join(workDir("rename-ok"), "renamed.apk"))
    const mod = await import(pathToFileURL(CLI).href)
    const probe = mod.checkRenamedApk(renamed, { from: OLD_PKG, to: NEW_PKG })
    assert.equal(probe.manifestHasFrom, true, "整串 substring 在产物里确实还在（air.<旧包名>.AppEntry 内部）")
    assert.equal(probe.manifestFromResidues, 0, "身份残留 0 处 —— 「不能朴素子串扫描」的全部要点")
    assert.equal(probe.manifestHasTo, true)
    assert.equal(probe.entryCount, report.zip.entriesAfter)
})

test("改名判据（端到端）：变异体 1 —— 坏掉 package 必须 FAIL，且失败原因点名到具体那一处", () => {
    // 1a：其余都对，只有 package 还是旧包名 ⇒ 必须 FAIL。
    // 注意失败落在「无旧包名残留」这项而不是「package 已是目标包名」：后者的实现是**整串 substring**
    // （hasEither(manifest, to)），4 个 authorities 已经带目标前缀，所以那一项看不出 package 没改。
    // 这是判别据实现的上界，本次任务不改实现，在报告里如实记着（见交付报告「发现」一节）。
    const stillOld = runRenameRoute("rename-oldpkg", renamedManifest({ pkg: OLD_PKG }))
    assert.equal(stillOld.result.status, 2, `exit=${stillOld.result.status}\nstdout=${stillOld.result.stdout}`)
    assert.equal(stillOld.report.ok, false)
    assert.deepEqual(failedAssertions(stillOld.report), [assertionNamed(stillOld.report, A_RESIDUE).name],
        "package 值落在标识符开头 ⇒ 由「无旧包名残留」这项抓，且只该有这一项亮红")
    assert.equal(residueSamplesOf(assertionNamed(stillOld.report, A_RESIDUE)), OLD_PKG,
        "样例正好是 package=\"…\" 那一处（而不是空话一句「有残留」）")

    // 1b：package 与 4 个 authorities 全都没改（改名整段没生效）⇒ package 项自己也要亮红，
    // 且 detail 能看出目标包名是哪个。
    const untouched = runRenameRoute("rename-untouched",
        renamedManifest({ pkg: OLD_PKG, authorities: AUTHORITY_SUFFIXES.map(suffix => `${OLD_PKG}${suffix}`) }))
    assert.equal(untouched.result.status, 2)
    const pkgItem = assertionNamed(untouched.report, A_PACKAGE)
    assert.equal(pkgItem.ok, false)
    assert.match(pkgItem.detail, /to=cn\.starpoint\.a/, "失败原因要能看出目标包名是哪个")
    assert.equal(failedAssertions(untouched.report).includes(pkgItem.name), true,
        "整段没生效时 package 项自己也要亮红（不能只靠残留项兜）")
})

test("改名判据（端到端）：变异体 2 —— 4 个 authorities 里有一个还是旧前缀必须 FAIL，样例点名那一个", () => {
    const broken = `${OLD_PKG}.ltshare.fileprovider`
    const authorities = AUTHORITY_SUFFIXES.map(suffix =>
        suffix === ".ltshare.fileprovider" ? broken : `${NEW_PKG}${suffix}`)
    const { result, report } = runRenameRoute("rename-badauth", renamedManifest({ authorities }))
    assert.equal(result.status, 2, `exit=${result.status}\nstdout=${result.stdout}`)
    assert.equal(report.ok, false)
    assert.deepEqual(failedAssertions(report), [assertionNamed(report, A_RESIDUE).name],
        "package 与条目数都还是对的 ⇒ 只该有「无旧包名残留」这一项失败")
    assert.equal(residueSamplesOf(assertionNamed(report, A_RESIDUE)), broken,
        "样例要点名坏掉的那一个 authority")
    assert.equal(residueSamplesOf(assertionNamed(report, A_RESIDUE)).includes("AppEntry"), false,
        "受保护串不该混进残留样例（否则就说不清到底坏在哪一处）")
})

test("改名判据（端到端）：变异体 3 —— 多一处真残留必须 FAIL，且受保护的只有 air. 前缀那一种", () => {
    // 3a：正文里多一处旧包名（别处都对）⇒ 残留 1 处、样例点名它。
    const extraResidue = runRenameRoute("rename-extra",
        renamedManifest({ extra: `<meta-data android:value="${OLD_PKG}"/>` }))
    assert.equal(extraResidue.result.status, 2, `exit=${extraResidue.result.status}\nstdout=${extraResidue.result.stdout}`)
    assert.equal(extraResidue.report.ok, false)
    assert.deepEqual(failedAssertions(extraResidue.report), [assertionNamed(extraResidue.report, A_RESIDUE).name])
    assert.match(assertionNamed(extraResidue.report, A_RESIDUE).detail, /身份残留\(标识符开头\)=1 处/)
    assert.equal(residueSamplesOf(assertionNamed(extraResidue.report, A_RESIDUE)), OLD_PKG)

    // 3b：把 AIR 入口类写成不带 air. 前缀的 `com.leiting.wf.AppEntry` ⇒ 前一个字节是引号，
    // 落在标识符开头 ⇒ **必须**计数。保护的是「更长标识符内部」这个位置，不是 AppEntry 这个名字。
    const bareEntry = runRenameRoute("rename-bareentry",
        renamedManifest({ appEntry: `${OLD_PKG}.AppEntry` }))
    assert.equal(bareEntry.result.status, 2, `exit=${bareEntry.result.status}\nstdout=${bareEntry.result.stdout}`)
    assert.equal(assertionNamed(bareEntry.report, A_RESIDUE).ok, false)
    assert.equal(residueSamplesOf(assertionNamed(bareEntry.report, A_RESIDUE)), `${OLD_PKG}.AppEntry`,
        "少了 air. 前缀就不是受保护串了：allowlist 不能退化成「凡 AppEntry 一律放行」")
})

// ─────────── 9. 钩子合法改变 SWF 长度（长度守恒的参照 = 改写前那一刻，不是基线） ───────────

const GROWING_HOOK = `export async function transformSwf(ctx) {
    const grown = Buffer.concat([ctx.logicalSwf, Buffer.alloc(1024, 0)])
    grown.writeUInt32LE(grown.length, 4)   // SWF 头的 fileLength 一并改对，做成「合法」的长度变化
    return { swf: grown, notes: ["growing-hook：尾部追加 1024 B（模拟 P6 登录页 pcode 块 +14,572 B）"] }
}
`

test("AS3 钩子合法改变 SWF 长度时必须被接受（拿基线长度当参照会把真干活的钩子判死）", () => {
    const hook = path.join(fx.dir, "growing-hook.mjs")
    fs.writeFileSync(hook, GROWING_HOOK)
    const target = out("growing.apk")
    const result = run(baseArgs("growing", ["--ffdec", tools.jar, "--java", tools.java, "--as3-hook", hook]))
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`)
    const report = readReport(target)
    assert.equal(report.ok, true)
    assert.equal(report.assertions.failed, 0)
    assert.match(report.route, /as3-hook/)
    assert.equal(report.swf.logicalBytesAfter - report.swf.logicalBytesBefore, 1024)
    const lenAssertion = report.assertions.list.find(item => String(item.name).includes("成对改写长度守恒"))
    assert.equal(lenAssertion.ok, true, JSON.stringify(lenAssertion))
    assert.match(String(lenAssertion.detail), /AS3 钩子另行贡献 1024 B/)
})

// ─────────── 10. Windows 批处理工具（apksigner.bat）必须真能跑起来 ───────────

test("Windows 上 .bat 工具真的被调用（自己拼引号喂 spawn 会让 cmd 报「不是内部或外部命令」）", {
    skip: process.platform === "win32" ? false : "仅 Windows 有 cmd.exe 批处理语义",
}, async () => {
    const mod = await import(pathToFileURL(CLI).href)
    // 目录名故意带空格：这正是朴素拼引号会炸的形态。
    const batDir = path.join(fx.dir, "bat dir")
    fs.mkdirSync(batDir, { recursive: true })
    const bat = path.join(batDir, "fake-apksigner.bat")
    fs.writeFileSync(bat, "@echo off\r\necho BAT-OK %*\r\nexit /b 0\r\n")
    const result = mod.runTool(bat, ["sign", "--ks-pass", "env:SOME_VAR", "out.apk"])
    assert.equal(result.ok, true, `stderr=${result.stderr}`)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /BAT-OK sign --ks-pass env:SOME_VAR out\.apk/)
})
