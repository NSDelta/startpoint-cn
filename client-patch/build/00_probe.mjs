#!/usr/bin/env node
// P0 探针：AS3「整类替换」回编译可行性（Android / 1.8.1 基座）
//
// 回答的问题（卡 A1）：
//   在 1.8.1 基座上「改一个**已存在**的 AS3 类 → FFDec 导回 SWF → 重封 APK → 重签名」
//   这条链在本机是否可复现？
//
// 全链（每一步都有回读断言，任何一步失败即 abort，不产出「看起来成功」的包）：
//   1) 从基座 APK 取出 assets/worldflipper_android_release.swf（并记 sha256）
//   2) FFDec -dumpAS3 记类清单指纹（类数 + 每行哈希）
//   3) FFDec -selectclass <靶类> -export script .../scripts 出单个 .as
//   4) 改一处**可观测但无害**的东西 = 追加静态常量 P0_PROBE_TAG（纯新增，不动任何逻辑行）
//   5) FFDec -replace <in.swf> <out.swf> <类名> <改后的.as>   ← 会让 FFDec 重写整份 ABC
//   6) 回读断言：新特征串在 / 旧特征串不在 / DevConfig 指纹不变 / 类数不变 / 全量 AS3 指纹
//   7) 重封 APK（零依赖 ZIP 重写，只换 SWF，抹掉旧签名）→ zipalign -p -f 4 → apksigner sign
//   8) apksigner verify --verbose + 产物 sha256 写 <out>.build-report.json
//
// 为什么不用 -importScript：项目测试 client-patch/tests/test_pcode_roundtrip.py:272-283
//   有硬断言 test_pure_build_never_invokes_import_script（`-importScript` 与 `.as` 都不许出现）。
//   本脚本同样只用 -replace。
//
// 为什么必须 -Djava.awt.headless=true：无显示环境下 FFDec 会因 AWT 初始化失败/挂住。
// 为什么 APK 必须先拷到纯 ASCII 路径：中文/空格路径会让 java 的 -jar 与临时目录处理出问题。
//
// 用法：
//   node 00_probe.mjs --stage all  --base <APK> --work <目录> --out <目录>
//        [--class pinball.channels.dummy.ChannelSDKDummy]
//        [--ffdec <ffdec.jar>] [--java <java>] [--zipalign <exe>] [--apksigner <bat|cmd>]
//        [--ks <keystore>] [--ks-pass-env SP_P0_KS_PASS] [--uncompressed-swf]
//   分步：--stage extract | dumpbase | export | patch | replace | verify | apk | report
//
// 退出码：0 = 全链通过；1 = 断言失败（stderr 里给 `文件:行` 与原始报错）。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync, inflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAIN_SWF_IN_APK = "assets/worldflipper_android_release.swf";
const PROBE_TAG = "SP_CN_P0_PROBE_TAG_1";
const PROBE_SENTINEL = "abcde001_P0PROBE"; // 改前是 "abcde001"（userId 默认值），改后带上后缀

// ────────────────────────────────────────────────────────────── 参数

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const STAGE = String(args.stage || "all");
const CLASS = String(args.class || "pinball.channels.dummy.ChannelSDKDummy");
const FFDEC = String(args.ffdec || "D:\\starview-windows\\starview-windows\\ffdec\\ffdec.jar");
const JAVA = String(args.java || "java");
const ZIPALIGN = String(args.zipalign || "D:\\starview-windows\\starview-windows\\build-tools\\zipalign.exe");
const APKSIGNER = String(
  args.apksigner || "D:\\starview-windows\\starview-windows\\build-tools\\apksigner.bat"
);
const BASE = args.base ? path.resolve(String(args.base)) : null;
const WORK = args.work ? path.resolve(String(args.work)) : null;
const OUTDIR = args.out ? path.resolve(String(args.out)) : null;
const KS = args.ks ? path.resolve(String(args.ks)) : null;
const KS_PASS_ENV = String(args.ks_pass_env || "SP_P0_KS_PASS");
const UNCOMPRESSED_SWF = args["uncompressed-swf"] !== undefined;

if (!BASE || !WORK || !OUTDIR) {
  console.error("ERROR 需要 --base <APK> --work <目录> --out <目录>（--stage all）");
  process.exit(2);
}
// 纯 ASCII 路径硬断言（分工文档 §2.3 三条坑之一）
for (const [name, p] of [["--base", BASE], ["--work", WORK], ["--out", OUTDIR]]) {
  if (!/^[\x20-\x7e]+$/.test(p)) {
    console.error(`ERROR ${name} 含非 ASCII 字符，FFDec/java 会出错：${p}`);
    process.exit(2);
  }
}

const D = {
  swfIn: path.join(WORK, "base.swf"),
  dumpBase: path.join(WORK, "dumpAS3_base.txt"),
  expBefore: path.join(WORK, "export_before"),
  expAfter: path.join(WORK, "export_after"),
  as3Before: path.join(WORK, "as3_before"),
  as3After: path.join(WORK, "as3_after"),
  asBefore: null, // 运行时填
  asAfter: null,
  swfPatched: path.join(WORK, "patched.swf"),
  unsigned: path.join(WORK, "unsigned.apk"),
  aligned: path.join(WORK, "aligned.apk"),
  signed: path.join(OUTDIR, "sp-cn-p0-probe.apk"),
  report: path.join(OUTDIR, "sp-cn-p0-probe.apk.build-report.json"),
};
D.asBefore = path.join(D.expBefore, "scripts", ...CLASS.split(".")) + ".as";
D.asAfter = path.join(D.expAfter, "scripts", ...CLASS.split(".")) + ".as";

const log = (...a) => console.log("[probe]", ...a);
const step = s => log(`── ${s}`);

function sha256File(p) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

function run(cmd, cmdArgs, opts = {}) {
  log("$", cmd, ...cmdArgs.map(a => (String(a).includes(" ") ? JSON.stringify(a) : a)));
  const r = spawnSync(cmd, cmdArgs.map(String), { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
  const tail = (r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
  if (r.error) throw new Error(`spawn 失败 ${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} 退出码 ${r.status}（原始 stderr：${(r.stderr || "").split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")}）`
    );
  }
  return { ...r, tail };
}

/** FFDec 统一调用：必须 headless；-air 让 AS3 编译器用 airglobal.swc。 */
function ffdec(ffArgs) {
  return run(JAVA, ["-Xmx4g", "-Djava.awt.headless=true", "-jar", FFDEC, "-air", "-onerror", "abort", ...ffArgs]);
}

// ────────────────────────────────────────────────────────────── 零依赖 ZIP（APK 重写）

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readZipEntries(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP EOCD 找不到（不是 zip/APK？）");
  const total = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < total; n += 1) {
    if (buf.readUInt32LE(cd) !== SIG_CENTRAL) throw new Error(`central directory 损坏 @${cd}`);
    const versionMadeBy = buf.readUInt16LE(cd + 4);
    const method = buf.readUInt16LE(cd + 10);
    const mtime = buf.readUInt16LE(cd + 12);
    const mdate = buf.readUInt16LE(cd + 14);
    const crc = buf.readUInt32LE(cd + 16);
    const csize = buf.readUInt32LE(cd + 20);
    const usize = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const externalAttr = buf.readUInt32LE(cd + 38);
    const lho = buf.readUInt32LE(cd + 42);
    const name = buf.toString("latin1", cd + 46, cd + 46 + nameLen);
    if (csize === 0xffffffff || usize === 0xffffffff) throw new Error(`zip64 不受支持：${name}`);
    const lnameLen = buf.readUInt16LE(lho + 26);
    const lextraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    entries.push({
      name,
      method,
      mtime,
      mdate,
      crc,
      usize,
      versionMadeBy,
      externalAttr,
      raw: Buffer.from(buf.subarray(dataStart, dataStart + csize)),
    });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(e) {
  if (e.method === 0) return Buffer.from(e.raw);
  if (e.method === 8) return inflateRawSync(e.raw);
  throw new Error(`不支持的压缩方法 ${e.method}：${e.name}`);
}

/** APK 签名成员：v1 的 META-INF/*.(RSA|DSA|EC|SF) + MANIFEST.MF（新签名会重新生成）。 */
function isSignatureMember(name) {
  if (!name.startsWith("META-INF/")) return false;
  const base = name.slice("META-INF/".length);
  if (base.includes("/")) return false;
  return /\.(RSA|DSA|EC|SF)$/i.test(base) || base.toUpperCase() === "MANIFEST.MF";
}

/**
 * 重写 APK：逐条搬运原始压缩字节与属性，只把主 SWF 换成新内容；抹掉 v1 签名成员。
 * method 显式重建（STORED 直存 / DEFLATE 用确定的 level=9），偏移由本函数统一计算，
 * 因此同一输入的产物 sha256 稳定（zipalign 之前）。
 */
function rewriteApk(basePath, outPath, swapName, newData, forceStored) {
  const entries = readZipEntries(fs.readFileSync(basePath));
  const kept = entries.filter(e => !isSignatureMember(e.name));
  const dropped = entries.filter(e => isSignatureMember(e.name)).map(e => e.name);
  let swapped = 0;
  for (const e of kept) {
    if (e.name !== swapName) continue;
    swapped += 1;
    e.usize = newData.length;
    e.crc = crc32(newData);
    if (forceStored) {
      e.method = 0;
      e.raw = Buffer.from(newData);
    } else if (e.method === 0) {
      e.raw = Buffer.from(newData);
    } else {
      e.method = 8;
      e.raw = deflateSync(newData, { level: 9 });
    }
  }
  if (swapped !== 1) throw new Error(`期望恰好 1 个 ${swapName}，实际 ${swapped}`);

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of kept) {
    const name = Buffer.from(e.name, "latin1");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(e.mtime, 10);
    lh.writeUInt16LE(e.mdate, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.raw.length, 18);
    lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.raw);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(e.versionMadeBy, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(e.mtime, 12);
    ch.writeUInt16LE(e.mdate, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.raw.length, 20);
    ch.writeUInt32LE(e.usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(e.externalAttr, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + e.raw.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(kept.length, 8);
  eocd.writeUInt16LE(kept.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([localBuf, centralBuf, eocd]));
  return { kept: kept.length, dropped, swapMethod: kept.find(e => e.name === swapName).method };
}

// ────────────────────────────────────────────────────────────── 指纹

/** 全量 AS3 指纹：按相对路径排序，逐文件哈希进一个滚动哈希。 */
function fingerprintAs3(root) {
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".as")) files.push(p);
    }
  })(root);
  files.sort();
  const h = createHash("sha256");
  const perClass = new Map();
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    const fh = createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    perClass.set(rel, fh);
    h.update(rel).update("\0").update(fh).update("\n");
  }
  return { count: files.length, sha256: h.digest("hex"), perClass };
}

function fingerprintSubset(fp, prefix) {
  const names = [...fp.perClass.keys()].filter(n => n.startsWith(prefix)).sort();
  const h = createHash("sha256");
  for (const n of names) h.update(n).update("\0").update(fp.perClass.get(n)).update("\n");
  return { count: names.length, sha256: h.digest("hex"), names };
}

/** 类清单指纹：-dumpAS3 的每一行（类名 + 方法数）排序后整体哈希。 */
function fingerprintClassList(dumpFile) {
  const lines = fs.readFileSync(dumpFile, "utf8").split(/\r?\n/).filter(Boolean);
  const sorted = [...lines].sort();
  const h = createHash("sha256");
  for (const l of sorted) h.update(l).update("\n");
  return { count: lines.length, sha256: h.digest("hex"), lines };
}

// ────────────────────────────────────────────────────────────── 阶段

function stageExtract() {
  step("1/8 从基座 APK 取主 SWF");
  const entries = readZipEntries(fs.readFileSync(BASE));
  const hits = entries.filter(e => e.name === MAIN_SWF_IN_APK);
  if (hits.length !== 1) throw new Error(`基座里 ${MAIN_SWF_IN_APK} 命中 ${hits.length} 个（期望 1）`);
  const data = readEntryData(hits[0]);
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(D.swfIn, data);
  log(`base.swf = ${data.length} B  sha256=${sha256File(D.swfIn)}（APK 内 method=${hits[0].method}）`);
}

function stageDumpBase() {
  step("2/8 -dumpAS3 记基座类清单");
  ffdec(["-dumpAS3", D.swfIn], { stdio: ["ignore", "pipe", "pipe"] });
  // -dumpAS3 走 stdout，上面 run() 已捕获；重跑一次落盘
  const r = spawnSync(JAVA, ["-Xmx4g", "-Djava.awt.headless=true", "-jar", FFDEC, "-air", "-onerror", "abort", "-dumpAS3", D.swfIn], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  fs.writeFileSync(D.dumpBase, r.stdout || "");
  const fp = fingerprintClassList(D.dumpBase);
  log(`基座类数 = ${fp.count}  清单 sha256=${fp.sha256}`);
  return fp;
}

function stageExportBefore() {
  step("3/8 -selectclass 出靶类 .as");
  fs.rmSync(D.expBefore, { recursive: true, force: true });
  fs.mkdirSync(D.expBefore, { recursive: true });
  ffdec(["-selectclass", CLASS, "-export", "script", D.expBefore, D.swfIn]);
  if (!fs.existsSync(D.asBefore)) throw new Error(`导出缺文件：${D.asBefore}`);
  log(`${D.asBefore} = ${fs.statSync(D.asBefore).length} B`);
}

/** 改一处可观测但无害的东西：追加静态常量 + 改 userId 默认值后缀（纯新增/字面量改动）。 */
function stagePatch() {
  step("4/8 改靶类（追加静态常量 P0_PROBE_TAG + userId 默认值加后缀）");
  let text = fs.readFileSync(D.asBefore, "utf8");
  if (!text.includes('userId = "abcde001"')) {
    throw new Error(`靶类里找不到 userId 默认值锚点，无法做最小改动：${D.asBefore}`);
  }
  text = text.replace('userId = "abcde001";', `userId = "${PROBE_SENTINEL}";`);
  // 静态常量：放在类体最前（字段声明区），不触碰任何可执行逻辑
  const classAnchor = /public class ChannelSDKDummy extends RealRemoteService implements ChannelSDKImpl\r?\n\{\r?\n/;
  if (!classAnchor.test(text)) throw new Error("靶类类声明锚点不匹配，无法插入静态常量");
  text = text.replace(
    classAnchor,
    m => `${m}      public static const P0_PROBE_TAG:String = "${PROBE_TAG}";\n      \n`
  );
  fs.writeFileSync(D.asBefore, text, "utf8");
  log(`改后 .as = ${Buffer.byteLength(text)} B（新增特征串 "${PROBE_TAG}" / "${PROBE_SENTINEL}"）`);
}

function stageReplace() {
  step("5/8 -replace 单类回写 SWF（FFDec 会重写整份 ABC）");
  ffdec(["-replace", D.swfIn, D.swfPatched, CLASS, D.asBefore]);
  if (!fs.existsSync(D.swfPatched)) throw new Error("patched.swf 未生成");
  log(
    `base.swf ${fs.statSync(D.swfIn).size} B → patched.swf ${fs.statSync(D.swfPatched).size} B  ` +
      `sha256=${sha256File(D.swfPatched)}`
  );
}

/** 回读断言：新串在 / 旧串不在 / 类数不变 / DevConfig 与全量 AS3 指纹比对。 */
function stageVerify(baseListFp) {
  step("6/8 回读断言");
  const failures = [];
  const fpOut = {};

  fs.rmSync(D.expAfter, { recursive: true, force: true });
  fs.mkdirSync(D.expAfter, { recursive: true });
  ffdec(["-selectclass", CLASS, "-export", "script", D.expAfter, D.swfPatched]);
  const afterText = fs.existsSync(D.asAfter) ? fs.readFileSync(D.asAfter, "utf8") : "";
  fpOut.newTagPresent = afterText.includes(PROBE_TAG);
  fpOut.newSentinelPresent = afterText.includes(PROBE_SENTINEL);
  fpOut.oldUserIdGone = !afterText.includes('userId = "abcde001"');
  if (!fpOut.newTagPresent) failures.push(`回读 AS3 里没有新特征串 "${PROBE_TAG}"`);
  if (!fpOut.newSentinelPresent) failures.push(`回读 AS3 里没有新特征串 "${PROBE_SENTINEL}"`);
  if (!fpOut.oldUserIdGone) failures.push("回读 AS3 里旧默认值 userId=\"abcde001\" 仍在");

  const r = spawnSync(JAVA, ["-Xmx4g", "-Djava.awt.headless=true", "-jar", FFDEC, "-air", "-onerror", "abort", "-dumpAS3", D.swfPatched], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const dumpAfter = path.join(WORK, "dumpAS3_patched.txt");
  fs.writeFileSync(dumpAfter, r.stdout || "");
  const afterList = fingerprintClassList(dumpAfter);
  fpOut.classCountBefore = baseListFp.count;
  fpOut.classCountAfter = afterList.count;
  fpOut.classListShaBefore = baseListFp.sha256;
  fpOut.classListShaAfter = afterList.sha256;
  if (afterList.count !== baseListFp.count) {
    failures.push(`类数变了：${baseListFp.count} → ${afterList.count}`);
  }
  if (afterList.sha256 !== baseListFp.sha256) {
    const only = afterList.lines.filter(l => !baseListFp.lines.includes(l));
    failures.push(`类清单哈希变了（新增/缺失 ${only.length} 行，例：${only.slice(0, 5).join(" ; ")}）`);
  }

  // 全量 AS3 回读：DevConfig 指纹必须逐字节不变（分工文档硬要求）
  step("6b/8 全量 AS3 导出做指纹比对（耗时最长的一步）");
  fs.rmSync(D.as3Before, { recursive: true, force: true });
  fs.rmSync(D.as3After, { recursive: true, force: true });
  ffdec(["-format", "script:as", "-export", "script", D.as3Before, D.swfIn]);
  ffdec(["-format", "script:as", "-export", "script", D.as3After, D.swfPatched]);
  const fpBefore = fingerprintAs3(path.join(D.as3Before, "scripts"));
  const fpAfter = fingerprintAs3(path.join(D.as3After, "scripts"));
  const devBefore = fingerprintSubset(fpBefore, "pinball/config/");
  const devAfter = fingerprintSubset(fpAfter, "pinball/config/");
  const pinBefore = fingerprintSubset(fpBefore, "pinball/");
  const pinAfter = fingerprintSubset(fpAfter, "pinball/");

  fpOut.as3CountBefore = fpBefore.count;
  fpOut.as3CountAfter = fpAfter.count;
  fpOut.as3ShaBefore = fpBefore.sha256;
  fpOut.as3ShaAfter = fpAfter.sha256;
  fpOut.devConfigCount = devBefore.count;
  fpOut.devConfigShaBefore = devBefore.sha256;
  fpOut.devConfigShaAfter = devAfter.sha256;
  fpOut.devConfigUnchanged = devBefore.sha256 === devAfter.sha256;
  fpOut.pinballShaBefore = pinBefore.sha256;
  fpOut.pinballShaAfter = pinAfter.sha256;

  if (fpBefore.count !== fpAfter.count) {
    failures.push(`导出文件数变了：${fpBefore.count} → ${fpAfter.count}`);
  }
  if (!fpOut.devConfigUnchanged) failures.push("pinball/config/** 指纹变了（DevConfig 被重序列化影响）");

  // 逐文件差异清单：谁被 FFDec 重写坏了 / 谁只是无害重排
  const changed = [];
  for (const [rel, h] of fpBefore.perClass) {
    const h2 = fpAfter.perClass.get(rel);
    if (h2 === undefined) changed.push(`${rel}（丢失）`);
    else if (h2 !== h) changed.push(rel);
  }
  for (const rel of fpAfter.perClass.keys()) if (!fpBefore.perClass.has(rel)) changed.push(`${rel}（新增）`);
  fpOut.changedAs3Files = changed;
  fpOut.changedAs3Count = changed.length;

  return { fpOut, failures, dumpAfter };
}

function stageApk() {
  step("7/8 重封 APK + zipalign + apksigner");
  const patched = fs.readFileSync(D.swfPatched);
  const info = rewriteApk(BASE, D.unsigned, MAIN_SWF_IN_APK, patched, UNCOMPRESSED_SWF);
  log(`重封：保留 ${info.kept} 条，抹掉签名成员 ${info.dropped.length} 条，SWF method=${info.swapMethod}`);
  run(ZIPALIGN, ["-p", "-f", "4", D.unsigned, D.aligned]);

  if (!KS) {
    log("未给 --ks：跳过签名，保留 unsigned/aligned 供人工签名");
    return { info, signedPath: null, verifyOutput: null };
  }
  if (!process.env[KS_PASS_ENV]) throw new Error(`环境变量 ${KS_PASS_ENV} 未设置（keystore 口令只走 env，不入命令行/仓库）`);
  fs.mkdirSync(OUTDIR, { recursive: true });
  run(APKSIGNER, [
    "sign",
    "--v4-signing-enabled",
    "false",
    "--ks",
    KS,
    "--ks-pass",
    `env:${KS_PASS_ENV}`,
    "--out",
    D.signed,
    D.aligned,
  ]);
  const v = run(APKSIGNER, ["verify", "--verbose", D.signed]);
  log("apksigner verify:\n" + (v.stdout || "").trim());
  return { info, signedPath: D.signed, verifyOutput: (v.stdout || "").trim() };
}

function buildReport(files, extra) {
  const report = {
    schema_version: 1,
    probe: "P0 · AS3 整类替换回编译可行性（Android 1.8.1）",
    generated_at: new Date().toISOString(),
    toolchain: {
      ffdec: FFDEC,
      java: JAVA,
      zipalign: ZIPALIGN,
      apksigner: APKSIGNER,
      stage: STAGE,
    },
    target_class: CLASS,
    marker: { tag: PROBE_TAG, sentinel: PROBE_SENTINEL },
    base_apk: { path: BASE, sha256: sha256File(BASE), bytes: fs.statSync(BASE).size },
    base_swf: { path: D.swfIn, sha256: sha256File(D.swfIn), bytes: fs.statSync(D.swfIn).size },
    patched_swf: {
      path: D.swfPatched,
      sha256: sha256File(D.swfPatched),
      bytes: fs.statSync(D.swfPatched).size,
      delta_bytes: fs.statSync(D.swfPatched).size - fs.statSync(D.swfIn).size,
    },
    ...extra,
  };
  return report;
}

// ────────────────────────────────────────────────────────────── 主流程

function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(OUTDIR, { recursive: true });
  const t0 = Date.now();
  const all = STAGE === "all";
  const doStage = s => all || STAGE === s;

  let files = {};
  let baseListFp = null;

  if (doStage("extract")) stageExtract();
  if (doStage("dumpbase")) baseListFp = stageDumpBase();
  if (doStage("export")) stageExportBefore();
  if (doStage("patch")) stagePatch();
  if (doStage("replace")) stageReplace();

  let verify = null;
  if (doStage("verify")) {
    if (!baseListFp) baseListFp = fingerprintClassList(D.dumpBase);
    verify = stageVerify(baseListFp);
  }

  let apk = null;
  if (doStage("apk")) apk = stageApk();

  if (doStage("report") || all) {
    step("8/8 写 build-report");
    const extra = {
      assert: verify ? verify.fpOut : null,
      assert_failures: verify ? verify.failures : [],
      apk: {
        unsigned: { path: D.unsigned, sha256: sha256File(D.unsigned), bytes: fs.statSync(D.unsigned).size },
        aligned: { path: D.aligned, sha256: sha256File(D.aligned), bytes: fs.statSync(D.aligned).size },
        signed: apk && apk.signedPath ? { path: apk.signedPath, sha256: sha256File(apk.signedPath), bytes: fs.statSync(apk.signedPath).size } : null,
        entries_kept: apk ? apk.info.kept : null,
        signature_members_dropped: apk ? apk.info.dropped : null,
        swf_stored_method: apk ? apk.info.swapMethod : null,
        apksigner_verify: apk ? apk.verifyOutput : null,
      },
      device_test: {
        status: "PENDING-需真机",
        note: "本机 adb 无连接设备（`adb devices` 空）；真机步骤见 报告-P0.md 第 3/8 节。未验证项一律标注 [未验证-需真机]。",
      },
      elapsed_ms: Date.now() - t0,
    };
    const report = buildReport(files, extra);
    fs.writeFileSync(D.report, JSON.stringify(report, null, 2), "utf8");
    log(`build-report → ${D.report}`);
    log(JSON.stringify(verify ? verify.fpOut : {}, null, 2));
  }

  if (verify && verify.failures.length) {
    console.error("FAIL 回读断言未通过：");
    for (const f of verify.failures) console.error("  - " + f);
    process.exit(1);
  }
  log(`DONE 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
