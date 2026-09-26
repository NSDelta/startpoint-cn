#!/usr/bin/env node
/**
 * tools/rename_package.test.cjs — P12 客户端共存（改包名 / Bundle ID）回归测试
 *
 * 全部用**自建 fixture**，不依赖 `apkipa/` 下的真实产物（那些是 170MB 级、且不随仓分发）：
 *   · 二进制 AXML（UTF-16 字符串池 + 元素树），手工按 AOSP 的 ResXMLTree 布局拼出来
 *   · `resources.arsc`（RES_TABLE + RES_TABLE_PACKAGE，包名是 256 字节定长 UTF-16 字段）
 *   · `classes.dex`（最小可用 dex：header + string_ids + string_data_item）
 *   · ZIP（deflate，标准 local header + 中央目录 + EOCD）
 *   · IPA（`Payload/x.app/Info.plist` + AIR `application.xml` + 一个假主二进制）
 *   · Info.plist 两种形态：XML 明文 与 **bplist00 二进制**（真机 v15.2 包就是后者）
 *
 * 覆盖的验收点（对应派工卡 A14）：
 *   1. 默认关 ⇒ 产物与输入逐字节一致（含 sha256）
 *   2. 等长改名 ⇒ AndroidManifest 的 package、application.xml 的 <id>、
 *      全部 ${applicationId} 派生的 provider authority / permission 同步改；
 *      旧串 0 处、新串与预期处数一致；保护串（SDK FQN / 计费 SKU）逐字保留
 *   3. 非等长 ⇒ 默认**明确拒绝**（不静默产出坏包）；显式 --allow-unequal-length 才放行，
 *      且 dex 身份串降级必须显式出现在报告里
 *   4. Info.plist 改写（XML + 二进制两种），且改写后**逐键比对**除目标键外零改动
 *   5. bplist 编解码器自身的往返一致性（真机上踩过的两个坑：长长度前缀、dict 引用分组）
 *   6. iOS 身份必须**实测读取**而非写死：把 fixture 的 app id 设成 `com.kulo.wf`
 *      （≠ OFFICIAL_PACKAGE），断言 application.xml 的 <id> 真的被改了
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const TOOL = path.join(REPO_ROOT, "client-patch", "tools", "rename-package.mjs");

const OFFICIAL = "com.leiting.wf"; // 14 字符
const TARGET = "cn.starpoint.a"; // 14 字符（等长）
const UNEQUAL = "cn.starpoint.coexist"; // 20 字符（不等长）
const IOS_15_2_ID = "com.kulo.wf"; // 真机 v15.2 的 app id，11 字符

let mod; // 动态 import 的 ESM 模块

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

let CRC_TABLE = null;
function crc32(buf) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** 最小 ZIP 写入器（deflate，无 data descriptor，无 extra）。 */
function buildZip(entries, { method = 8 } = {}) {
    const locals = [];
    const cds = [];
    let off = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, "utf8");
        const body = method === 8 ? zlib.deflateRawSync(data, { level: 9 }) : data;
        const crc = crc32(data);
        const lh = Buffer.alloc(30 + nameBuf.length);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4); // version needed
        lh.writeUInt16LE(0, 6); // flags
        lh.writeUInt16LE(method, 8);
        lh.writeUInt16LE(0, 10); // time
        lh.writeUInt16LE(0, 12); // date
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(body.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        nameBuf.copy(lh, 30);
        locals.push(lh, body);
        cds.push({ nameBuf, crc, csize: body.length, usize: data.length, lho: off, method });
        off += lh.length + body.length;
    }
    const cdParts = [];
    let cdSize = 0;
    for (const c of cds) {
        const rec = Buffer.alloc(46 + c.nameBuf.length);
        rec.writeUInt32LE(0x02014b50, 0);
        rec.writeUInt16LE(20, 4);
        rec.writeUInt16LE(20, 6);
        rec.writeUInt16LE(0, 8);
        rec.writeUInt16LE(c.method, 10);
        rec.writeUInt16LE(0, 12);
        rec.writeUInt16LE(0, 14);
        rec.writeUInt32LE(c.crc, 16);
        rec.writeUInt32LE(c.csize, 20);
        rec.writeUInt32LE(c.usize, 24);
        rec.writeUInt16LE(c.nameBuf.length, 28);
        rec.writeUInt16LE(0, 30);
        rec.writeUInt16LE(0, 32);
        rec.writeUInt16LE(0, 34);
        rec.writeUInt16LE(0, 36);
        rec.writeUInt32LE(0, 38);
        rec.writeUInt32LE(c.lho, 42);
        c.nameBuf.copy(rec, 46);
        cdParts.push(rec);
        cdSize += rec.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(cds.length, 8);
    eocd.writeUInt16LE(cds.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, ...cdParts, eocd]);
}

/** 读出 ZIP 内某条目的原始数据（测试用，独立于被测模块的实现）。 */
function readZipEntry(zipBuf, name) {
    let p = 0;
    while (p + 4 <= zipBuf.length && zipBuf.readUInt32LE(p) === 0x04034b50) {
        const method = zipBuf.readUInt16LE(p + 8);
        const csize = zipBuf.readUInt32LE(p + 18);
        const nl = zipBuf.readUInt16LE(p + 26);
        const el = zipBuf.readUInt16LE(p + 28);
        const nm = zipBuf.subarray(p + 30, p + 30 + nl).toString("utf8");
        const start = p + 30 + nl + el;
        const raw = zipBuf.subarray(start, start + csize);
        if (nm === name) return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
        p = start + csize;
    }
    throw new Error(`zip 内没有条目：${name}`);
}

/** 列出 ZIP 内所有条目名。 */
function listZipEntries(zipBuf) {
    const out = [];
    let p = 0;
    while (p + 4 <= zipBuf.length && zipBuf.readUInt32LE(p) === 0x04034b50) {
        const csize = zipBuf.readUInt32LE(p + 18);
        const nl = zipBuf.readUInt16LE(p + 26);
        const el = zipBuf.readUInt16LE(p + 28);
        out.push(zipBuf.subarray(p + 30, p + 30 + nl).toString("utf8"));
        p = p + 30 + nl + el + csize;
    }
    return out;
}

// ---- AXML 拼装（AOSP ResXMLTree 布局） ----

/** UTF-16 字符串项：u16 长度 + UTF-16LE 正文 + u16 NUL。 */
function axmlStringItem(s) {
    const body = Buffer.from(s, "utf16le");
    const head = Buffer.alloc(2);
    head.writeUInt16LE(s.length, 0);
    return Buffer.concat([head, body, Buffer.from([0, 0])]);
}

function axmlStringPool(strings) {
    const items = strings.map(axmlStringItem);
    const stringsStart = 28 + strings.length * 4; // 无 style
    const body = Buffer.concat(items);
    const total = Math.ceil((stringsStart + body.length) / 4) * 4;
    const pool = Buffer.alloc(total);
    pool.writeUInt16LE(0x0001, 0); // RES_STRING_POOL_TYPE
    pool.writeUInt16LE(28, 2); // headerSize
    pool.writeUInt32LE(total, 4);
    pool.writeUInt32LE(strings.length, 8);
    pool.writeUInt32LE(0, 12); // styleCount
    pool.writeUInt32LE(0, 16); // flags：UTF-16、未排序（真机 APK 就是这种）
    pool.writeUInt32LE(stringsStart, 20);
    pool.writeUInt32LE(0, 24); // stylesStart
    let cur = 0;
    strings.forEach((_, i) => {
        pool.writeUInt32LE(cur, 28 + i * 4);
        cur += items[i].length;
    });
    body.copy(pool, stringsStart);
    return pool;
}

/** 起止元素 chunk。attrs = [{ name: 串索引, value: 串索引, type?: 字节 }] */
function axmlElement(nameIdx, attrs, { end = false } = {}) {
    if (end) {
        const b = Buffer.alloc(16);
        b.writeUInt16LE(0x0103, 0);
        b.writeUInt16LE(16, 2);
        b.writeUInt32LE(16, 4);
        b.writeInt32LE(-1, 8);
        b.writeUInt32LE(nameIdx, 12);
        return b;
    }
    const raw = 16 + 20 + attrs.length * 20;
    const size = Math.ceil(raw / 4) * 4;
    const b = Buffer.alloc(size);
    b.writeUInt16LE(0x0102, 0);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(size, 4);
    b.writeUInt32LE(1, 8); // lineNumber
    b.writeInt32LE(-1, 12); // comment
    b.writeInt32LE(-1, 16); // ns
    b.writeUInt32LE(nameIdx, 20);
    b.writeUInt16LE(20, 24); // attributeStart
    b.writeUInt16LE(20, 26); // attributeSize
    b.writeUInt16LE(attrs.length, 28);
    b.writeUInt16LE(0, 30);
    b.writeUInt16LE(0, 32);
    b.writeUInt16LE(0, 34);
    attrs.forEach((a, i) => {
        const o = 36 + i * 20;
        b.writeInt32LE(-1, o); // ns
        b.writeUInt32LE(a.name, o + 4);
        b.writeInt32LE(-1, o + 8); // rawValue
        b.writeUInt16LE(8, o + 12);
        b.writeUInt8(0, o + 14);
        b.writeUInt8(a.type ?? 0x03, o + 15); // TYPE_STRING
        b.writeUInt32LE(a.value, o + 16);
    });
    return b;
}

/**
 * 造一份"像真的"AndroidManifest.xml：package + 4 个 ${applicationId} 派生的 provider
 * authorities + 一条 permission + 一条 uses-permission + 一条 meta-data 字面量，
 * 外加一个必须原样保留的 SDK FQN。
 */
function buildManifest(pkg) {
    const strings = [
        "manifest", "package", pkg,
        "application", "android:name", "com.leiting.sdk.LeitingApplication",
        "provider", "android:authorities",
        `${pkg}.fileprovider`,
        `${pkg}.ltshare.fileprovider`,
        `${pkg}.provider`,
        `${pkg}.sobot_fileprovider`,
        "permission", "android:name2", `${pkg}.permission.C2D_MESSAGE`,
        "uses-permission", "android:name3", `${pkg}.permission.C2D_MESSAGE`,
        "meta-data", "android:value2", pkg,
        "activity", "android:name4", `${pkg}.AppEntry`,
        "air.com.leiting.sdk.AppEntry",
    ];
    const I = {};
    strings.forEach((s, i) => { if (!(s in I)) I[s] = i; });
    const C = (n, v) => ({ name: I[n], value: I[v] });

    const chunks = [
        axmlStringPool(strings),
        axmlElement(I.manifest, [C("package", pkg)]),
        axmlElement(I["uses-permission"], [C("android:name3", `${pkg}.permission.C2D_MESSAGE`)]),
        axmlElement(I.permission, [C("android:name2", `${pkg}.permission.C2D_MESSAGE`)]),
        axmlElement(I.application, [C("android:name", "com.leiting.sdk.LeitingApplication")]),
        axmlElement(I.activity, [C("android:name4", `${pkg}.AppEntry`)]),
        axmlElement(I.activity, [], { end: true }),
        axmlElement(I.provider, [C("android:authorities", `${pkg}.fileprovider`)]),
        axmlElement(I.provider, [], { end: true }),
        axmlElement(I.provider, [C("android:authorities", `${pkg}.ltshare.fileprovider`)]),
        axmlElement(I.provider, [], { end: true }),
        axmlElement(I.provider, [C("android:authorities", `${pkg}.provider`)]),
        axmlElement(I.provider, [], { end: true }),
        axmlElement(I.provider, [C("android:authorities", `${pkg}.sobot_fileprovider`)]),
        axmlElement(I.provider, [], { end: true }),
        axmlElement(I["meta-data"], [C("android:value2", pkg)]),
        axmlElement(I["meta-data"], [], { end: true }),
        axmlElement(I.application, [], { end: true }),
        axmlElement(I.manifest, [], { end: true }),
    ];
    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(8);
    head.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
    head.writeUInt16LE(8, 2);
    head.writeUInt32LE(8 + body.length, 4);
    return Buffer.concat([head, body]);
}

/** RES_TABLE + 一个 RES_TABLE_PACKAGE（包名 = 256 字节定长 UTF-16 字段）。 */
function buildArsc(pkg) {
    const pkgSize = 288;
    const total = 12 + pkgSize;
    const b = Buffer.alloc(total);
    b.writeUInt16LE(0x0002, 0); // RES_TABLE_TYPE
    b.writeUInt16LE(12, 2);
    b.writeUInt32LE(total, 4);
    b.writeUInt32LE(1, 8); // packageCount
    const o = 12;
    b.writeUInt16LE(0x0200, o); // RES_TABLE_PACKAGE_TYPE
    b.writeUInt16LE(pkgSize, o + 2);
    b.writeUInt32LE(pkgSize, o + 4);
    b.writeUInt32LE(0x7f, o + 8); // id
    Buffer.from(pkg, "utf16le").copy(b, o + 12);
    return b;
}

/** 最小可用 dex：1 个 string_id。 */
function buildDex(strings) {
    const headerSize = 112;
    const idsOff = headerSize;
    const dataOff = idsOff + strings.length * 4;
    const items = strings.map((s) => {
        const body = Buffer.from(s, "utf8");
        const len = Buffer.alloc(1);
        len.writeUInt8(body.length, 0); // uleb128，<128 单字节
        return Buffer.concat([len, body, Buffer.from([0])]);
    });
    const data = Buffer.concat(items);
    const total = dataOff + data.length + 4;
    const b = Buffer.alloc(total);
    b.write("dex\n035\0", 0, "latin1");
    // checksum(8) / signature(12..32) 留空，patchDexString 会重算并自检
    b.writeUInt32LE(total, 32);
    b.writeUInt32LE(headerSize, 36);
    b.writeUInt32LE(0x12345678, 40); // endian_tag
    b.writeUInt32LE(0, 44);
    b.writeUInt32LE(0, 48);
    b.writeUInt32LE(0, 52); // map_off
    b.writeUInt32LE(strings.length, 56);
    b.writeUInt32LE(idsOff, 60);
    b.writeUInt32LE(dataOff, 104); // data_off
    b.writeUInt32LE(data.length, 108); // data_size
    let cur = dataOff;
    items.forEach((it, i) => {
        b.writeUInt32LE(cur, idsOff + i * 4);
        cur += it.length;
    });
    data.copy(b, dataOff);
    return b;
}

function buildApplicationXml(pkg) {
    return Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<application xmlns="http://ns.adobe.com/air/application/51.2">
  <id>${pkg}</id>
  <filename>x</filename>
  <versionNumber>1.8.4</versionNumber>
  <initialWindow><content>worldflipper_ios_release.swf</content></initialWindow>
  <android>
    <manifestAdditions><![CDATA[<manifest><application><provider android:authorities="${pkg}.fileprovider"/></application></manifest>]]></manifestAdditions>
    <extendsClass>${pkg}.AppEntry</extendsClass>
  </android>
  <extensions>
    <extensionID>com.distriqt.Core</extensionID>
    <extensionID>com.leiting.sdk.LeitingApplication</extensionID>
  </extensions>
  <sku>${pkg}.stonepack_MAIN</sku>
</application>
`,
        "utf8",
    );
}

function buildXmlPlist(bundleId) {
    return Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleURLTypes</key>
	<array><dict><key>CFBundleURLName</key><string>${bundleId}</string><key>CFBundleURLSchemes</key><array><string>worldflipper</string></array></dict></array>
	<key>CFBundleDisplayName</key>
	<string>世界弹射物语</string>
	<key>CFBundleExecutable</key>
	<string>worldflipper</string>
	<key>MinimumOSVersion</key>
	<string>12.0</string>
</dict>
</plist>
`,
        "utf8",
    );
}

/** 真机 v15.2 那种二进制 plist 的形状（含长串、嵌套 dict/array、bool、int、data、date）。 */
function samplePlistObject(bundleId) {
    return {
        CFBundleIdentifier: bundleId,
        CFBundleURLTypes: [
            { CFBundleURLName: bundleId, CFBundleURLSchemes: ["worldflipper", "wfcn"] },
        ],
        CFBundleDisplayName: "世界弹射物语",
        CFBundleExecutable: "worldflipper",
        CFBundleShortVersionString: "1.8.4",
        CFBundleVersion: "1.8.46",
        CTAirSdkVersion: "51.2.1.5",
        CTInitialWindowContent: "worldflipper_ios_release.swf",
        MinimumOSVersion: "12.0",
        UIDeviceFamily: [1, 2],
        DebugMode: false,
        TestMode: false,
        FromDumpDecrypter: true,
        Extensions: {
            "com.distriqt.Core": "3.0.0",
            "com.digitalstrawberry.ane.share": "1.0.0",
            "com.gibits.leitingaar": "2.0.0",
            "pinball.vibration": "1.0.0",
        },
        NSAttributedString: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
        LongKeyToForceMultiByteLengths: "x".repeat(300),
        Timestamp: new Date(1600000000000),
    };
}

// ---- 把 fixture 落盘 / 跑 CLI ----

let TMP;
function fixturePath(name) {
    return path.join(TMP, name);
}

function writeApk(name, pkg = OFFICIAL) {
    const p = fixturePath(name);
    fs.writeFileSync(
        p,
        buildZip([
            { name: "AndroidManifest.xml", data: buildManifest(pkg) },
            { name: "resources.arsc", data: buildArsc(pkg) },
            { name: "classes.dex", data: buildDex(["com.leiting.sdk.LeitingApplication", pkg, "Ljava/lang/Object;"]) },
            { name: "assets/META-INF/AIR/application.xml", data: buildApplicationXml(pkg) },
            { name: "res/layout/main.xml", data: Buffer.from("<x/>", "utf8") },
        ], { method: 8 }),
    );
    return p;
}

function writeIpa(name, pkg = OFFICIAL, { binary = true } = {}) {
    const p = fixturePath(name);
    const plist = binary
        ? mod.encodeBplist(samplePlistObject(pkg))
        : buildXmlPlist(pkg);
    fs.writeFileSync(
        p,
        buildZip([
            { name: "Payload/worldflipper.app/Info.plist", data: plist },
            { name: "Payload/worldflipper.app/META-INF/AIR/application.xml", data: buildApplicationXml(pkg) },
            { name: "Payload/worldflipper.app/worldflipper", data: Buffer.concat([Buffer.from("MACHO"), Buffer.alloc(64), Buffer.from(pkg, "utf8")]) },
            { name: "Payload/worldflipper.app/en.lproj/InfoPlist.strings", data: Buffer.from("hi", "utf8") },
        ], { method: 8 }),
    );
    return p;
}

/** 跑 main()，吞掉 stdout，返回 {report, out, error}。 */
async function runMain(argv) {
    const orig = process.stdout.write;
    let out = "";
    process.stdout.write = (s) => { out += s; return true; };
    try {
        const report = await mod.main(argv);
        return { report, out, error: null };
    } catch (error) {
        return { report: null, out, error };
    } finally {
        process.stdout.write = orig;
    }
}

test.before(async () => {
    mod = await import(`file://${TOOL.replace(/\\/g, "/")}`);
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), "p12-rename-"));
});

test.after(() => {
    if (TMP && fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. 默认关 ⇒ 逐字节一致
// ---------------------------------------------------------------------------

test("默认关：未指定 --rename-package ⇒ 产物与输入逐字节一致（APK）", async () => {
    const src = writeApk("d1.apk");
    const dst = fixturePath("d1.out.apk");
    const { report, error } = await runMain(["--in", src, "--out", dst]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.renamed, false);
    assert.equal(report.byteIdentical, true);
    assert.ok(fs.readFileSync(dst).equals(fs.readFileSync(src)), "产物必须与输入逐字节一致");
    assert.ok(report.checks.every((c) => c.ok));
});

test("默认关：IPA 同样零改动", async () => {
    const src = writeIpa("d2.ipa");
    const dst = fixturePath("d2.out.ipa");
    const { report, error } = await runMain(["--in", src, "--out", dst]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.renamed, false);
    assert.ok(fs.readFileSync(dst).equals(fs.readFileSync(src)));
});

test("默认关：--no-rename-package 显式关闭也走零改动路径", async () => {
    const src = writeApk("d3.apk");
    const { report, error } = await runMain(["--in", src, "--no-rename-package"]);
    assert.equal(error, null);
    assert.equal(report.renamed, false);
});

// ---------------------------------------------------------------------------
// 2. 等长改名 ⇒ 四处全改 + 回读断言
// ---------------------------------------------------------------------------

test("等长改名：package / <id> / provider authority / permission 全部同步，残留 0", async () => {
    const src = writeApk("e1.apk");
    const dst = fixturePath("e1.out.apk");
    const { report, error } = await runMain(["--in", src, "--out", dst, "--rename-package", TARGET]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.ok, true);
    assert.equal(report.from, OFFICIAL);
    assert.equal(report.to, TARGET);
    assert.equal(report.equalLength, true);
    assert.ok(report.checks.every((c) => c.ok), `断言全绿失败：${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
    assert.equal(report.degraded.length, 0);

    const outBuf = fs.readFileSync(dst);
    const outAx = readZipEntry(outBuf, "AndroidManifest.xml");
    const parsed = mod.readAxmlPackage(outAx);
    assert.equal(parsed.packageName, TARGET, "① AndroidManifest 的 package");

    // ② AIR application.xml 的 <id>
    const air = readZipEntry(outBuf, "assets/META-INF/AIR/application.xml").toString("utf8");
    assert.match(air, new RegExp(`<id>${TARGET.replace(/\./g, "\\.")}</id>`));

    // ③ ${applicationId} 派生的 provider authority + permission + uses-permission
    assert.match(air, new RegExp(`${TARGET.replace(/\./g, "\\.")}\\.fileprovider`));
    // 描述符里允许出现旧串的唯一位置是计费 SKU 与 SDK FQN（受保护），它们必须逐字保留
    const airOld = air.match(new RegExp(`${OFFICIAL.replace(/\./g, "\\.")}[A-Za-z0-9_.]*`, "g")) ?? [];
    assert.deepEqual(
        airOld.filter((s) => !/\.(?:stonepack_|weekly_set_)/.test(s) && !s.startsWith("com.leiting.sdk")),
        [],
        `AIR 描述符仍残留非保护的旧 id：${JSON.stringify(airOld)}`,
    );
    const axPool = mod.parseAxml(outAx).pool.strings;
    for (const suffix of [".fileprovider", ".ltshare.fileprovider", ".provider", ".sobot_fileprovider", ".permission.C2D_MESSAGE", ".AppEntry"]) {
        assert.ok(axPool.includes(`${TARGET}${suffix}`), `manifest 缺少改写后的 ${TARGET}${suffix}`);
        assert.ok(!axPool.includes(`${OFFICIAL}${suffix}`), `manifest 仍残留 ${OFFICIAL}${suffix}`);
    }

    // ④ meta-data 里的裸包名字面量 + 元素属性值
    const ax = mod.parseAxml(outAx);
    const pkgAttr = ax.elements[0].attrs.find((a) => a.name === "package");
    assert.equal(pkgAttr.value, TARGET);

    // 旧串 0 处 / 新串处数一致
    const oldHits = axPool.filter((s) => s.includes(OFFICIAL));
    assert.deepEqual(oldHits, [], `manifest 字符串池仍残留旧串：${JSON.stringify(oldHits)}`);
    const expected = axPool.filter((s) => s.includes(TARGET)).length;
    assert.equal(expected, 9, `新串处数应为 9（package + 4×authority + permission + uses-permission + AppEntry + meta-data）实得 ${expected}`);

    // 保护串逐字保留
    assert.ok(axPool.includes("com.leiting.sdk.LeitingApplication"), "SDK FQN 必须逐字保留");
    assert.ok(air.includes("com.leiting.sdk.LeitingApplication"), "AIR 描述符内 SDK FQN 必须逐字保留");
    assert.ok(air.includes(`${OFFICIAL}.stonepack_MAIN`), "计费 SKU 必须逐字保留（改了就是改商品 ID）");

    // arsc 定长包名字段
    const arsc = mod.findArscPackageChunks(readZipEntry(outBuf, "resources.arsc"));
    assert.equal(arsc.length, 1);
    assert.equal(arsc[0].name, TARGET);

    // 残留扫描
    assert.equal(report.residuals.totals.identity, 0, "残留 identity 必须为 0");
});

test("等长改名：--rename-to 是 --package 的别名（P7 透传用）", async () => {
    const src = writeApk("e2.apk");
    const { report, error } = await runMain(["--in", src, "--rename-to", TARGET]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.to, TARGET);
    assert.equal(report.from, OFFICIAL);
});

test("等长改名：--rename-package 不带值 ⇒ 用默认目标 cn.starpoint.a", async () => {
    const src = writeApk("e3.apk");
    const { report, error } = await runMain(["--in", src, "--rename-package"]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(mod.DEFAULT_COEXIST_PACKAGE, TARGET, "默认目标必须是卡 A14 指定的 cn.starpoint.a");
    assert.equal(report.to, TARGET);
});

test("--dry-run 不写文件", async () => {
    const src = writeApk("e4.apk");
    const dst = fixturePath("e4.out.apk");
    const { report, error } = await runMain(["--in", src, "--out", dst, "--rename-package", TARGET, "--dry-run"]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.dryRun, true);
    assert.equal(fs.existsSync(dst), false, "--dry-run 不得写文件");
});

test("幂等：对已改名的产物再跑一次 ⇒ 全绿且不改动", async () => {
    const src = writeApk("e5.apk");
    const mid = fixturePath("e5.mid.apk");
    const end = fixturePath("e5.end.apk");
    const a = await runMain(["--in", src, "--out", mid, "--rename-package", TARGET]);
    assert.equal(a.error, null);
    const b = await runMain(["--in", mid, "--out", end, "--rename-package", TARGET]);
    assert.equal(b.error, null, `幂等第二跑不应报错：${b.error?.message}`);
    assert.equal(b.report.from, TARGET);
    assert.equal(b.report.to, TARGET);
    assert.ok(fs.readFileSync(end).equals(fs.readFileSync(mid)), "幂等第二跑产物应与输入一致");
});

// ---------------------------------------------------------------------------
// 3. 非等长
// ---------------------------------------------------------------------------

test("非等长：默认明确拒绝（不静默产出坏包）", async () => {
    const src = writeApk("u1.apk");
    const dst = fixturePath("u1.out.apk");
    const { report, error } = await runMain(["--in", src, "--out", dst, "--rename-package", UNEQUAL]);
    assert.ok(error, "必须报错而不是静默出包");
    assert.match(error.message, /长度不等/);
    assert.match(error.message, /等长/);
    assert.equal(error.exitCode, 1);
    assert.equal(fs.existsSync(dst), false, "拒绝时不得留下半成品文件");
});

test("非等长：--allow-unequal-length 放行，但 dex 降级必须显式出现在报告里", async () => {
    const src = writeApk("u2.apk");
    const dst = fixturePath("u2.out.apk");
    const { report, error } = await runMain([
        "--in", src, "--out", dst, "--rename-package", UNEQUAL, "--allow-unequal-length",
    ]);
    assert.equal(error, null, `放行后不应报错：${error?.message}`);
    assert.equal(report.equalLength, false);
    // 降级项必须可见
    assert.ok(report.degraded.length >= 1, "dex 降级必须出现在 degraded 里");
    assert.match(report.degraded.map((d) => d.name).join(","), /dex\.identity-string/);
    assert.match(report.warnings.join("\n"), /不等长/);

    const outBuf = fs.readFileSync(dst);
    // AXML 走了字符串池重建路径
    assert.equal(report.plan["AndroidManifest.xml"].mode, "rebuild");
    const ax = mod.parseAxml(readZipEntry(outBuf, "AndroidManifest.xml"));
    assert.equal(ax.elements[0].attrs.find((a) => a.name === "package").value, UNEQUAL);
    assert.deepEqual(ax.pool.strings.filter((s) => s.includes(OFFICIAL)), []);
    // dex 明确记成"跳过"
    assert.equal(report.plan["classes.dex"].mode, "skipped-unequal-length");
    // arsc 定长字段照样改得动
    assert.equal(mod.findArscPackageChunks(readZipEntry(outBuf, "resources.arsc"))[0].name, UNEQUAL);
});

// ---------------------------------------------------------------------------
// 4. Info.plist（XML 与二进制两条路）
// ---------------------------------------------------------------------------

test("iOS：XML Info.plist 改写 CFBundleIdentifier + CFBundleURLName", async () => {
    const src = writeIpa("i1.ipa", OFFICIAL, { binary: false });
    const dst = fixturePath("i1.out.ipa");
    const { report, error } = await runMain(["--in", src, "--out", dst, "--rename-package", TARGET]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.platform, "ios");
    const out = readZipEntry(fs.readFileSync(dst), "Payload/worldflipper.app/Info.plist").toString("utf8");
    assert.match(out, new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${TARGET.replace(/\./g, "\\.")}</string>`));
    assert.equal((out.match(new RegExp(OFFICIAL.replace(/\./g, "\\."), "g")) || []).length, 0, "XML plist 不得残留旧 Bundle ID");
    assert.ok(out.includes("世界弹射物语"), "非 ASCII 值必须原样保留");
});

test("iOS：二进制 Info.plist（bplist00）改写并逐键回读", async () => {
    const src = writeIpa("i2.ipa", OFFICIAL, { binary: true });
    const dst = fixturePath("i2.out.ipa");
    const { report, error } = await runMain(["--in", src, "--out", dst, "--rename-package", TARGET]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.platform, "ios");

    const plistEntry = fs.readFileSync(dst);
    const outBuf = readZipEntry(plistEntry, "Payload/worldflipper.app/Info.plist");
    assert.equal(outBuf.subarray(0, 8).toString("latin1"), "bplist00", "输出必须仍是二进制 plist");

    const decoded = mod.decodeBplist(outBuf).value;
    assert.equal(decoded.CFBundleIdentifier, TARGET);
    assert.equal(decoded.CFBundleURLTypes[0].CFBundleURLName, TARGET);

    // 逐键比对：除目标键外零改动
    const before = mod.flattenPlist(samplePlistObject(OFFICIAL));
    const after = mod.flattenPlist(decoded);
    assert.equal(after.size, before.size, "键数不得变化");
    const changed = [];
    for (const [k, v] of before) {
        if (after.get(k) !== v) changed.push(k);
    }
    assert.deepEqual(changed.sort(), ["CFBundleIdentifier", "CFBundleURLTypes[0].CFBundleURLName"], "只允许这两个键变");
    // 非 ASCII / 长串 / 嵌套结构全部无损
    assert.equal(decoded.CFBundleDisplayName, "世界弹射物语");
    assert.equal(decoded.Extensions["com.gibits.leitingaar"], "2.0.0");
    assert.equal(decoded.LongKeyToForceMultiByteLengths.length, 300);
    assert.deepEqual(decoded.UIDeviceFamily, [1, 2]);
    assert.equal(decoded.DebugMode, false);
    assert.deepEqual(decoded.NSAttributedString, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    assert.equal(decoded.Timestamp.getTime(), 1600000000000);
});

test("iOS：--display-name 改 CFBundleDisplayName（共存时便于区分图标）", async () => {
    const src = writeIpa("i3.ipa", OFFICIAL, { binary: true });
    const dst = fixturePath("i3.out.ipa");
    const { error } = await runMain(["--in", src, "--out", dst, "--rename-package", TARGET, "--display-name", "星点弹射"]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    const decoded = mod.decodeBplist(readZipEntry(fs.readFileSync(dst), "Payload/worldflipper.app/Info.plist")).value;
    assert.equal(decoded.CFBundleDisplayName, "星点弹射");
    assert.equal(decoded.CFBundleIdentifier, TARGET);
});

test("iOS 身份必须实测读取：app id 是 com.kulo.wf（≠ OFFICIAL_PACKAGE）时也必须真改", async () => {
    // 这是真机 v15.2 包的情形。抢救版把 com.leiting.wf 写死在 AIR 描述符扫描里，
    // 结果是"一字不改却报成功"——本用例就是这个回归的守门人。
    const src = writeIpa("i4.ipa", IOS_15_2_ID, { binary: true });
    const dst = fixturePath("i4.out.ipa");
    const { report, error } = await runMain(["--in", src, "--out", dst, "--rename-package", TARGET]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.from, IOS_15_2_ID, "from 必须从 IPA 实测读出");

    const outZip = fs.readFileSync(dst);
    assert.equal(mod.decodeBplist(readZipEntry(outZip, "Payload/worldflipper.app/Info.plist")).value.CFBundleIdentifier, TARGET);
    const air = readZipEntry(outZip, "Payload/worldflipper.app/META-INF/AIR/application.xml").toString("utf8");
    assert.match(air, new RegExp(`<id>${TARGET.replace(/\./g, "\\.")}</id>`), "AIR <id> 必须真的被改（不能一字不改还报成功）");
    const airOld = air.match(new RegExp(`${IOS_15_2_ID.replace(/\./g, "\\.")}[A-Za-z0-9_.]*`, "g")) ?? [];
    assert.deepEqual(
        airOld.filter((s) => !/\.(?:stonepack_|weekly_set_)/.test(s)),
        [],
        `AIR 描述符不得残留非保护的旧 id：${JSON.stringify(airOld)}`,
    );
});

test("默认关：IPA 的 bplist 形态也逐字节一致", async () => {
    const src = writeIpa("i5.ipa", IOS_15_2_ID, { binary: true });
    const dst = fixturePath("i5.out.ipa");
    const { report, error } = await runMain(["--in", src, "--out", dst]);
    assert.equal(error, null);
    assert.equal(report.renamed, false);
    assert.ok(fs.readFileSync(dst).equals(fs.readFileSync(src)));
});

// ---------------------------------------------------------------------------
// 5. bplist 编解码器本身的往返一致性
// ---------------------------------------------------------------------------

test("bplist 往返：decode(encode(x)) 深等于 x", () => {
    const obj = samplePlistObject(OFFICIAL);
    const buf = mod.encodeBplist(obj);
    assert.equal(buf.subarray(0, 8).toString("latin1"), "bplist00");
    assert.deepStrictEqual(mod.decodeBplist(buf).value, obj);
});

test("bplist 往返：强制多字节长长度 + 200 个对象的大 dict（refSize > 1）", () => {
    const big = {};
    for (let i = 0; i < 200; i++) big[`key_${String(i).padStart(3, "0")}`] = "v".repeat(i + 1);
    big.empty = "";
    big.zero = 0;
    big.neg = -1;
    big.real = 1.5;
    big.deep = [big ? { a: [1, [2, [3, { b: "c" }]]] } : null];
    const buf = mod.encodeBplist(big);
    const back = mod.decodeBplist(buf).value;
    assert.deepStrictEqual(back, big);
    // refSize 必须真的因为对象数变多而 >1，否则这条测试没测到东西
    const trailer = buf.subarray(buf.length - 32);
    assert.ok(trailer[7] >= 1);
    assert.ok(Number(trailer.readBigUInt64BE(8)) > 200, "对象数应 >200");
});

test("bplist 往返：长 ASCII 串（>=15）走整数长度前缀，标准解析器能读", () => {
    for (const n of [14, 15, 16, 255, 256, 300]) {
        const obj = { s: "a".repeat(n) };
        assert.deepStrictEqual(mod.decodeBplist(mod.encodeBplist(obj)).value, obj, `长度 ${n} 往返失败`);
    }
});

test("bplist 往返：UTF-16 非 ASCII 串", () => {
    const obj = { zh: "世界弹射物语", mix: "abc世界def" };
    assert.deepStrictEqual(mod.decodeBplist(mod.encodeBplist(obj)).value, obj);
});

test("bplist 往返：空容器与嵌套 dict 的 key/value 分组正确", () => {
    const obj = { a: {}, b: [], c: { x: {}, y: { z: {} } }, d: [[], [[]]] };
    assert.deepStrictEqual(mod.decodeBplist(mod.encodeBplist(obj)).value, obj);
});

test("bplist 解码器：非 bplist00 明确报错而不是解出垃圾", () => {
    assert.throws(() => mod.decodeBplist(Buffer.from("<?xml version=\"1.0\"?>")), /不是二进制 plist/);
});

test("flattenPlist：路径化后可比对，且能发现键数变化", () => {
    const a = mod.flattenPlist({ x: { y: [1, 2] }, z: "s" });
    assert.equal(a.get("x.y[0]"), "number:1");
    assert.equal(a.get("x.y[1]"), "number:2");
    assert.equal(a.get("z"), "string:s");
    assert.equal(a.size, 3);
});

// ---------------------------------------------------------------------------
// 6. 主二进制身份串分类（iOS 侧 R10 风险的可见化）
// ---------------------------------------------------------------------------

test("classifyBinaryIdentities：计费 SKU 与 keychain group 必须分类出来（且不许改）", () => {
    const data = Buffer.from(
        `sku1\u0000${OFFICIAL}.stonepack_MAIN\u0000sku2\u0000${OFFICIAL}.weekly_set_1\u0000` +
        `<string>RUH384Q4E8.${OFFICIAL}</string>\u0000` +
        `${OFFICIAL}\u0000`,
        "latin1",
    );
    const r = mod.classifyBinaryIdentities(data, { from: IOS_15_2_ID });
    assert.equal(r.ids[IOS_15_2_ID].count, 0, "from（com.kulo.wf）在二进制里应为 0，正是产生假绿的原因");
    const other = r.ids[OFFICIAL];
    assert.equal(other.kinds.sku, 2, `计费 SKU 应识别为 2 处，实得 ${JSON.stringify(other.kinds)}`);
    assert.equal(other.kinds.keychain, 1, `keychain group 应识别为 1 处，实得 ${JSON.stringify(other.kinds)}`);
    assert.ok(other.samples.sku.includes(`${OFFICIAL}.stonepack_MAIN`));
    assert.ok(other.samples.keychain.includes(`RUH384Q4E8.${OFFICIAL}`));
});

test("protectedRe / makeStringMapper：保护串整体跳过，不产生任何替换", () => {
    const re = mod.protectedRe(OFFICIAL);
    assert.ok(re.test(`${OFFICIAL}.stonepack_MAIN`));
    re.lastIndex = 0;
    assert.ok(re.test("com.leiting.sdk.LeitingApplication"));
    re.lastIndex = 0;
    assert.ok(re.test(`air.${OFFICIAL}.AppEntry`));
    const mapper = mod.makeStringMapper({ from: OFFICIAL, to: TARGET });
    assert.equal(mapper(`${OFFICIAL}.stonepack_MAIN`), null);
    assert.equal(mapper("com.leiting.sdk.LeitingApplication"), null);
    assert.equal(mapper(`${OFFICIAL}.provider`), `${TARGET}.provider`);
    assert.equal(mapper("nothing.here"), null);
});

// ---------------------------------------------------------------------------
// 7. CLI 契约（P7 按这个透传）
// ---------------------------------------------------------------------------

test("CLI：未知参数 ⇒ 退出码 2（用法错误）", async () => {
    const src = writeApk("c1.apk");
    const { error } = await runMain(["--in", src, "--nope"]);
    assert.ok(error);
    assert.equal(error.exitCode, 2);
});

test("CLI：缺少 --in ⇒ 退出码 2", async () => {
    const { error } = await runMain(["--rename-package", TARGET]);
    assert.ok(error);
    assert.equal(error.exitCode, 2);
});

test("CLI：非法包名 ⇒ 明确报错", async () => {
    const src = writeApk("c2.apk");
    const { error } = await runMain(["--in", src, "--rename-package", "1bad"]);
    assert.ok(error);
    assert.match(error.message, /包名不合法/);
});

test("CLI：输入不存在 ⇒ 明确报错而不是崩栈", async () => {
    const { error } = await runMain(["--in", fixturePath("nope.apk"), "--rename-package", TARGET]);
    assert.ok(error);
    assert.match(error.message, /输入不存在/);
});

test("CLI：--inspect 只读，不改任何字节且报告实测身份", async () => {
    const src = writeApk("c3.apk");
    const before = fs.readFileSync(src);
    const { report, error } = await runMain(["--in", src, "--inspect", "--json"]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.platform, "android");
    assert.equal(report.package, OFFICIAL);
    assert.equal(report.packageLength, OFFICIAL.length);
    assert.ok(fs.readFileSync(src).equals(before), "--inspect 不得改动输入");
});

test("CLI：--inspect 在 bplist IPA 上也能读出身份（旧版会报 CFBundleIdentifier 未找到）", async () => {
    const src = writeIpa("c4.ipa", IOS_15_2_ID, { binary: true });
    const { report, error } = await runMain(["--in", src, "--inspect", "--json"]);
    assert.equal(error, null, `不应报错：${error?.message}`);
    assert.equal(report.platform, "ios");
    assert.equal(report.bundleId, IOS_15_2_ID);
    assert.equal(report.plistFormat, "bplist");
    assert.equal(report.airId, IOS_15_2_ID);
    assert.equal(report.airIdMatchesPlist, true);
});

// ---------------------------------------------------------------------------
// 8. 真实产物冒烟（apkipa/ 不在场时跳过，不伪造证据）
// ---------------------------------------------------------------------------

const REAL_APK = path.join(REPO_ROOT, "apkipa", "安卓v15.2.apk");
const REAL_IPA = path.join(REPO_ROOT, "apkipa", "苹果v15.2.ipa");

test("真机包冒烟：安卓v15.2.apk 的实测身份是 com.leiting.wf（在场才跑）", { skip: !fs.existsSync(REAL_APK) }, () => {
    const r = mod.inspect(REAL_APK);
    assert.equal(r.platform, "android");
    assert.equal(r.package, OFFICIAL);
    assert.equal(r.packageLength, 14);
});

test("真机包冒烟：苹果v15.2.ipa 的实测 app id 是 com.kulo.wf（在场才跑）", { skip: !fs.existsSync(REAL_IPA) }, () => {
    const r = mod.inspect(REAL_IPA);
    assert.equal(r.platform, "ios");
    assert.equal(r.bundleId, IOS_15_2_ID);
    assert.equal(r.plistFormat, "bplist");
});
