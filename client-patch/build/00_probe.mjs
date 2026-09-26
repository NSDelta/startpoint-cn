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
import { deflateRawSync, inflateRawSync, inflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAIN_SWF_IN_APK = "assets/worldflipper_android_release.swf";
const PROBE_TAG = "SP_CN_P0_PROBE_TAG_1";
const PROBE_SENTINEL = "abcde001_P0PROBE"; // static const 的值，回读时用来证明改动真的落进了 ABC

// ────────────────────────────────────────────────────────────── 参数

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) {
      out[m[1]] = m[2];
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[m[1]] = argv[i + 1];
      i += 1;
    } else {
      out[m[1]] = true;
    }
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
  if (p.includes("true")) {
    console.error(`ERROR ${name} 解析成了布尔值（参数写成了 "--x" 而不是 "--x <值>"）：${p}`);
    process.exit(2);
  }
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
  // Windows 上 Node ≥20 直接 spawnSync 一个 .bat/.cmd 会抛 EINVAL，必须经 cmd.exe 转发
  let realCmd = cmd;
  let realArgs = cmdArgs.map(String);
  if (/\.(bat|cmd)$/i.test(cmd)) {
    realCmd = process.env.ComSpec || "cmd.exe";
    realArgs = ["/c", cmd, ...realArgs];
  }
  log("$", realCmd, ...realArgs.map(a => (String(a).includes(" ") ? JSON.stringify(a) : a)));
  const r = spawnSync(realCmd, realArgs, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
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
      // 必须 deflateRawSync：deflateSync 会加 zlib 头/adler32，ZIP method=8 要的是裸 deflate 流
      e.raw = deflateRawSync(newData, { level: 9 });
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
  // -dumpAS3 走 stdout，必须显式捕获（run() 只回显 tail）
  const r = spawnSync(JAVA, ["-Xmx4g", "-Djava.awt.headless=true", "-jar", FFDEC, "-air", "-onerror", "abort", "-dumpAS3", D.swfIn], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`-dumpAS3 退出码 ${r.status}：${(r.stderr || "").split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")}`);
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
  log(`${D.asBefore} = ${fs.statSync(D.asBefore).size} B`);
}

/**
 * 改一处**既有方法体**（这正是 P6 的用法：只动既有类的既有方法，不新增类、不新增签名）。
 *   ① 加一个 static const（可观测特征）
 *   ② 把 ChannelSDKDummy.startLoginServer 的 `param1("")` 改成 `param1(P0_PROBE_TAG)`
 * 刻意**不**碰 userId 默认值 —— 这样除 target 方法外的类内差异，就纯粹是 FFDec
 * 「整类重编译」带来的副作用（见报告 §4 的 P-code 对照）。
 */
function stagePatch() {
  step("4/8 改靶类（改既有方法 startLoginServer 的返回串 + 一个 static const）");
  let text = fs.readFileSync(D.asBefore, "utf8");
  const beforeBody = /public function startLoginServer\(param1:Function\) : void\s*\{\s*param1\(""\);\s*\}/;
  if (!beforeBody.test(text)) throw new Error(`靶类里找不到 startLoginServer 目标体，锚点不匹配：${D.asBefore}`);
  text = text.replace(beforeBody, m => m.replace('param1("")', `param1(${PROBE_TAG})`));
  const classAnchor = /public class ChannelSDKDummy extends RealRemoteService implements ChannelSDKImpl\s*\{\s*\n/;
  if (!classAnchor.test(text)) throw new Error("靶类类声明锚点不匹配，无法插入静态常量");
  text = text.replace(
    classAnchor,
    m => `${m}      public static const ${PROBE_TAG}:String = "${PROBE_SENTINEL}";\n      \n`
  );
  if (!text.includes(`param1(${PROBE_TAG})`)) throw new Error("改写后没找到新方法体");
  const oldCount = (text.match(/param1\(""\)/g) || []).length;
  fs.writeFileSync(D.asBefore, text, "utf8");
  log(
    `改后 .as = ${Buffer.byteLength(text)} B：startLoginServer → param1(${PROBE_TAG})，` +
      `static const ${PROBE_TAG}="${PROBE_SENTINEL}"，残留 param1("") = ${oldCount}（原 2 处）`
  );
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

/** 回读断言：新特征串在 / 类数不变 / DevConfig 指纹不变 / 非靶类 P-code 无语义漂移。 */
function stageVerify(baseListFp) {
  step("6/8 回读断言");
  const failures = [];
  const fpOut = {};

  // ── 6a. 靶类回读（改动必须真的落进 ABC）
  fs.rmSync(D.expAfter, { recursive: true, force: true });
  fs.mkdirSync(D.expAfter, { recursive: true });
  ffdec(["-selectclass", CLASS, "-export", "script", D.expAfter, D.swfPatched]);
  const afterText = fs.existsSync(D.asAfter) ? fs.readFileSync(D.asAfter, "utf8") : "";
  fpOut.newBodyPresent = afterText.includes(`param1(${PROBE_TAG})`);
  fpOut.newSentinelPresent = afterText.includes(PROBE_SENTINEL);
  fpOut.residualOldBodies = (afterText.match(/param1\(""\)/g) || []).length;
  fpOut.userIdDefaultIntact = afterText.includes('userId = "abcde001"');
  if (!fpOut.newBodyPresent) failures.push(`回读 AS3 里没有改动后的 startLoginServer 体 param1(${PROBE_TAG})`);
  if (!fpOut.newSentinelPresent) failures.push(`回读 AS3 里没有 static const 的值 "${PROBE_SENTINEL}"`);
  if (fpOut.residualOldBodies !== 1) failures.push(`param1("") 残留 ${fpOut.residualOldBodies} 处（期望 1：sdkLoginManual 那处未动）`);
  if (!fpOut.userIdDefaultIntact) failures.push("顺带被改坏了：userId 默认值不再等于 abcde001");

  // ── 6b. 类清单（类数 + 逐行）
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
  if (afterList.count !== baseListFp.count) failures.push(`类数变了：${baseListFp.count} → ${afterList.count}`);
  if (afterList.sha256 !== baseListFp.sha256) {
    const only = afterList.lines.filter(l => !baseListFp.lines.includes(l));
    failures.push(`类清单哈希变了（新增/缺失 ${only.length} 行，例：${only.slice(0, 5).join(" ; ")}）`);
  }

  // ── 6c. DevConfig 指纹：pinball.config 整包 selectclass 回读（快，比全量导出省 18 分钟）
  step("6c/8 pinball.config 整包回读（DevConfig 指纹不变）");
  const cfgBase = path.join(WORK, "cfg_base");
  const cfgAfter = path.join(WORK, "cfg_after");
  for (const [dir, swf] of [[cfgBase, D.swfIn], [cfgAfter, D.swfPatched]]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    ffdec(["-selectclass", "pinball.config.++", "-export", "script", dir, swf]);
  }
  const fpCfgBase = fingerprintAs3(path.join(cfgBase, "scripts"));
  const fpCfgAfter = fingerprintAs3(path.join(cfgAfter, "scripts"));
  fpOut.devConfigCount = fpCfgBase.count;
  fpOut.devConfigShaBefore = fpCfgBase.sha256;
  fpOut.devConfigShaAfter = fpCfgAfter.sha256;
  fpOut.devConfigUnchanged = fpCfgBase.sha256 === fpCfgAfter.sha256;
  if (!fpOut.devConfigUnchanged) {
    const ch = [...fpCfgBase.perClass.keys()].filter(k => fpCfgBase.perClass.get(k) !== fpCfgAfter.perClass.get(k));
    failures.push(`pinball/config/** 指纹变了（${ch.length} 个文件，例：${ch.slice(0, 5).join(" ; ")}）`);
  }

  // ── 6d. P-code 对照：非靶类只允许「方法表下标整体平移」，不允许出现真语义差异
  step("6d/8 P-code 对照（非靶类零语义漂移）");
  const pcSel = `${CLASS},pinball.config.++`;
  const pcBase = path.join(WORK, "pc_base");
  const pcAfter = path.join(WORK, "pc_after");
  for (const [dir, swf] of [[pcBase, D.swfIn], [pcAfter, D.swfPatched]]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    ffdec(["-format", "script:pcode", "-selectclass", pcSel, "-export", "script", dir, swf]);
  }
  const norm = t =>
    t
      .split(/\r?\n/)
      .map(l => (/^(newfunction|newclass|newcatch)\s+\d+$/.test(l.trim()) ? l.replace(/\d+$/, "#") : l))
      .join("\n");
  const scan = root => {
    const m = new Map();
    (function w(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) w(p);
        else m.set(path.relative(root, p).split(path.sep).join("/"), p);
      }
    })(root);
    return m;
  };
  const pa = scan(path.join(pcBase, "scripts"));
  const pb = scan(path.join(pcAfter, "scripts"));
  const targetPcode = CLASS.replace(/\./g, "/") + ".pcode";
  const rawChanged = [];
  const semanticChanged = [];
  for (const [k, p] of pa) {
    if (!pb.has(k)) {
      semanticChanged.push(`${k}（丢失）`);
      continue;
    }
    const ta = fs.readFileSync(p, "utf8");
    const tb = fs.readFileSync(pb.get(k), "utf8");
    if (ta !== tb) {
      rawChanged.push(k);
      if (norm(ta) !== norm(tb)) semanticChanged.push(k);
    }
  }
  fpOut.pcodeFilesCompared = pa.size;
  fpOut.pcodeRawChanged = rawChanged;
  fpOut.pcodeSemanticChanged = semanticChanged;
  fpOut.indexOnlyRenumbering = rawChanged.filter(k => !semanticChanged.includes(k));
  const unexpected = semanticChanged.filter(k => k !== targetPcode);
  if (unexpected.length) {
    failures.push(`非靶类出现 P-code 语义差异：${unexpected.slice(0, 5).join(" ; ")}`);
  }
  if (!semanticChanged.includes(targetPcode)) {
    failures.push(`靶类 P-code 没变（改动没落进字节码）：${targetPcode}`);
  }

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

// ══════════════════════════════════════════════════════════════ 路线 B：P-code 方法体级替换
//
// 动机：AS3 `-replace` 会把**整类重编译**（并重排全局方法表，见 stageVerify 6d 的 newfunction
// 下标平移）。FFDec 还支持另一种替换：只换**某一个方法体**，
//     -replace <in.swf> <out.swf> <scriptName> <pcodeFile> <methodBodyIndex>
// 其中 methodBodyIndex 是相对「拥有该脚本包的 DoABC tag」的 method_body 下标。
// 本段自己实现 AVM2 方法体索引（FFDec 的 pcode 导出不打印这个下标），用来：
//   ① 定位 startLoginServer 的 body index；② 替换后证明**其它方法体的字节码与下标全部不变**。
//
// 算法与 `D:\wfspcn\startpoint-cn\client-patch\dual-form-v1\abc_methods.py` 同构（只读参考，未抄代码）。

class AbcError extends Error {}

class AbcReader {
  constructor(data, label) {
    this.data = data;
    this.label = label;
    this.pos = 0;
  }
  remaining() {
    return this.data.length - this.pos;
  }
  _need(n) {
    if (n < 0 || this.pos + n > this.data.length) {
      throw new AbcError(`truncated ${this.label} at 0x${this.pos.toString(16)}: need ${n} bytes`);
    }
  }
  u8() {
    this._need(1);
    return this.data[this.pos++];
  }
  u16() {
    this._need(2);
    const v = this.data.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this._need(4);
    const v = this.data.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u30() {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const b = this.u8();
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) {
        if (v > 0x3fffffff) throw new AbcError(`invalid u30 in ${this.label} at 0x${this.pos.toString(16)}`);
        return v >>> 0;
      }
      shift += 7;
    }
    throw new AbcError(`unterminated u30 in ${this.label} at 0x${this.pos.toString(16)}`);
  }
  varint32() {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const b = this.u8();
      v |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return v >>> 0;
      shift += 7;
    }
    return v >>> 0;
  }
  take(n) {
    this._need(n);
    const v = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  skip(n) {
    this.take(n);
  }
}

/** FWS 直接用；CWS 先 zlib 解压。返回 tag 流（已跳过 Rect + frameRate + frameCount）。 */
function swfTagStream(buf, label) {
  const sig = buf.subarray(0, 3).toString("latin1");
  let body;
  if (sig === "FWS") body = buf.subarray(8);
  else if (sig === "CWS") body = inflateSync(buf.subarray(8));
  else throw new AbcError(`${label} 不是 SWF（signature=${sig}）`);
  const r = new AbcReader(body, `SWF body ${label}`);
  const nbits = body[0] >> 3;
  r.skip(Math.ceil((5 + 4 * nbits) / 8));
  r.skip(4); // frameRate(2) + frameCount(2)
  return body.subarray(r.pos);
}

function* iterDoAbc(tagStream, label) {
  const r = new AbcReader(tagStream, `SWF tags ${label}`);
  let abcIndex = 0;
  while (r.remaining() >= 2) {
    const header = r.u16();
    const tagCode = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) length = r.u32();
    const payload = r.take(length);
    if (tagCode === 82) {
      const pr = new AbcReader(payload, `DoABC[${abcIndex}]`);
      pr.u32(); // flags
      const nameBytes = [];
      for (;;) {
        const b = pr.u8();
        if (b === 0) break;
        nameBytes.push(b);
      }
      const name = Buffer.from(nameBytes).toString("utf8");
      yield [abcIndex, name, payload.subarray(pr.pos)];
      abcIndex += 1;
    }
    if (tagCode === 0) break;
  }
}

const poolCount = r => Math.max(0, r.u30() - 1);

function readConstantPool(r) {
  // 注意：poolCount(r) 有副作用（消费一个 u30），必须**先求值一次**再循环，
  // 不能写成 `for (i=0; i<poolCount(r); i++)`（那会每次迭代都重读一遍计数）。
  let n = poolCount(r);
  for (let i = 0; i < n; i += 1) r.varint32(); // int
  n = poolCount(r);
  for (let i = 0; i < n; i += 1) r.varint32(); // uint
  n = poolCount(r);
  r.skip(8 * n); // double
  n = poolCount(r);
  const strings = [""];
  for (let i = 0; i < n; i += 1) {
    const size = r.u30();
    strings.push(r.take(size).toString("utf8"));
  }
  n = poolCount(r);
  const namespaces = [[0, 0]];
  for (let i = 0; i < n; i += 1) namespaces.push([r.u8(), r.u30()]);
  n = poolCount(r);
  for (let i = 0; i < n; i += 1) {
    const members = r.u30();
    for (let k = 0; k < members; k += 1) r.u30();
  }
  n = poolCount(r);
  const multinames = [[0, 0, 0]];
  for (let i = 0; i < n; i += 1) {
    const kind = r.u8();
    if (kind === 0x07 || kind === 0x0d) multinames.push([kind, r.u30(), r.u30()]);
    else if (kind === 0x0f || kind === 0x10) multinames.push([kind, 0, r.u30()]);
    else if (kind === 0x11 || kind === 0x12) multinames.push([kind, 0, 0]);
    else if (kind === 0x09 || kind === 0x0e) {
      const nameIndex = r.u30();
      r.u30();
      multinames.push([kind, 0, nameIndex]);
    } else if (kind === 0x1b || kind === 0x1c) {
      r.u30();
      multinames.push([kind, 0, 0]);
    } else if (kind === 0x1d) {
      const qnameIndex = r.u30();
      const n = r.u30();
      for (let k = 0; k < n; k += 1) r.u30();
      multinames.push([kind, 0, qnameIndex]);
    } else {
      throw new AbcError(`unsupported multiname kind 0x${kind.toString(16)} in ${r.label}`);
    }
  }
  return { strings, namespaces, multinames };
}

function qualifiedMultiname(index, strings, namespaces, multinames) {
  if (index <= 0 || index >= multinames.length) return ["", ""];
  const [kind, namespaceIndex, nameIndex] = multinames[index];
  const name = nameIndex >= 0 && nameIndex < strings.length ? strings[nameIndex] : "";
  if (kind !== 0x07 && kind !== 0x0d) return ["", name];
  let namespace = "";
  if (namespaceIndex > 0 && namespaceIndex < namespaces.length) {
    const stringIndex = namespaces[namespaceIndex][1];
    if (stringIndex >= 0 && stringIndex < strings.length) namespace = strings[stringIndex];
  }
  return [namespace, name];
}

function readTraits(r) {
  const result = [];
  const n = r.u30();
  for (let i = 0; i < n; i += 1) {
    const traitName = r.u30();
    const kindAndAttributes = r.u8();
    const kind = kindAndAttributes & 0x0f;
    let methodIndex = null;
    if (kind === 0 || kind === 6) {
      r.u30();
      r.u30();
      const valueIndex = r.u30();
      if (valueIndex) r.u8();
    } else if (kind === 1 || kind === 2 || kind === 3) {
      r.u30();
      methodIndex = r.u30();
    } else if (kind === 4 || kind === 5) {
      r.u30();
      r.u30();
    } else {
      throw new AbcError(`unsupported trait kind ${kind} in ${r.label}`);
    }
    if (kindAndAttributes & 0x40) {
      const m = r.u30();
      for (let k = 0; k < m; k += 1) r.u30();
    }
    result.push([kind, traitName, methodIndex]);
  }
  return result;
}

function parseAbc(abcIndex, abcName, data) {
  const r = new AbcReader(data, `ABC[${abcIndex}] ${abcName}`);
  r.u16();
  r.u16();
  const { strings, namespaces, multinames } = readConstantPool(r);

  const methodNames = [];
  const methodCount = r.u30();
  for (let i = 0; i < methodCount; i += 1) {
    const paramCount = r.u30();
    r.u30();
    for (let k = 0; k < paramCount; k += 1) r.u30();
    const nameIndex = r.u30();
    if (nameIndex >= strings.length) throw new AbcError(`method name string index ${nameIndex} out of range in ${r.label}`);
    methodNames.push(strings[nameIndex]);
    const flags = r.u8();
    if (flags & 0x08) {
      const n = r.u30();
      for (let k = 0; k < n; k += 1) {
        r.u30();
        r.u8();
      }
    }
    if (flags & 0x80) for (let k = 0; k < paramCount; k += 1) r.u30();
  }

  const metaCount = r.u30();
  for (let i = 0; i < metaCount; i += 1) {
    r.u30();
    const itemCount = r.u30();
    for (let k = 0; k < itemCount; k += 1) r.u30();
    for (let k = 0; k < itemCount; k += 1) r.u30();
  }

  const classCount = r.u30();
  const instances = [];
  for (let i = 0; i < classCount; i += 1) {
    const className = r.u30();
    r.u30();
    const flags = r.u8();
    if (flags & 0x08) r.u30();
    const ifaceCount = r.u30();
    for (let k = 0; k < ifaceCount; k += 1) r.u30();
    const initializer = r.u30();
    instances.push([className, initializer, readTraits(r)]);
  }
  const classTraits = [];
  for (let i = 0; i < classCount; i += 1) {
    const initializer = r.u30();
    classTraits.push([initializer, readTraits(r)]);
  }
  const scriptTraits = [];
  const scriptCount = r.u30();
  for (let i = 0; i < scriptCount; i += 1) {
    const initializer = r.u30();
    scriptTraits.push([initializer, readTraits(r)]);
  }

  const aliasesByMethod = new Map();
  const addAlias = (mi, alias) => {
    if (!aliasesByMethod.has(mi)) aliasesByMethod.set(mi, new Set());
    aliasesByMethod.get(mi).add(alias);
  };
  methodNames.forEach((raw, mi) => {
    if (raw) addAlias(mi, raw);
  });
  const addTraitAliases = (classPrefix, traits) => {
    for (const [, traitNameIndex, methodIndex] of traits) {
      if (methodIndex === null) continue;
      const [, leaf] = qualifiedMultiname(traitNameIndex, strings, namespaces, multinames);
      if (leaf) addAlias(methodIndex, `${classPrefix}/${leaf}`);
    }
  };
  instances.forEach(([classNameIndex, initializer, traits], classIndex) => {
    const [pkg, cls] = qualifiedMultiname(classNameIndex, strings, namespaces, multinames);
    const classPrefix = pkg ? `${pkg}:${cls}` : cls;
    if (!classPrefix) return;
    addAlias(initializer, `${classPrefix}/${cls}`);
    addTraitAliases(classPrefix, traits);
    const [classInitializer, staticTraits] = classTraits[classIndex];
    addAlias(classInitializer, `${classPrefix}/$cinit`);
    addTraitAliases(classPrefix, staticTraits);
  });
  scriptTraits.forEach(([initializer, traits], scriptIndex) => {
    const prefix = `${abcName}#$script${scriptIndex}`;
    addAlias(initializer, `${prefix}/$init`);
    addTraitAliases(prefix, traits);
  });

  const refs = [];
  const bodyCount = r.u30();
  for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex += 1) {
    const methodInfoIndex = r.u30();
    if (methodInfoIndex >= methodNames.length) {
      throw new AbcError(`body ${bodyIndex} method_info ${methodInfoIndex} out of range in ${r.label}`);
    }
    r.u30(); // max_stack
    r.u30(); // local_count
    r.u30(); // init_scope_depth
    r.u30(); // max_scope_depth
    const code = r.take(r.u30());
    const excCount = r.u30();
    for (let k = 0; k < excCount; k += 1) {
      r.u30();
      r.u30();
      r.u30();
      r.u30();
      r.u30();
    }
    readTraits(r);
    const aliases = [...(aliasesByMethod.get(methodInfoIndex) || new Set())].sort();
    const primary = methodNames[methodInfoIndex] || aliases[0] || `${abcName}#method_info_${methodInfoIndex}`;
    refs.push({
      abcIndex,
      abcName,
      methodName: primary,
      aliases,
      methodInfoIndex,
      bodyIndex,
      id: `${abcIndex}#${bodyIndex}`,
      codeSha: createHash("sha256").update(code).digest("hex"),
      codeLen: code.length,
      code,
    });
  }
  if (r.remaining() !== 0) throw new AbcError(`unparsed trailing bytes in ${r.label}: ${r.remaining()}`);
  return { refs, methodCount, bodyCount };
}

/** 索引整份 SWF 的方法体。返回 { refs, abcCount, bodyCount, byName } */
function indexSwfMethods(swfPath) {
  const buf = fs.readFileSync(swfPath);
  const tagStream = swfTagStream(buf, swfPath);
  const refs = [];
  let abcCount = 0;
  let bodyCount = 0;
  for (const [abcIndex, abcName, data] of iterDoAbc(tagStream, swfPath)) {
    const parsed = parseAbc(abcIndex, abcName, data);
    refs.push(...parsed.refs);
    bodyCount += parsed.bodyCount;
    abcCount += 1;
  }
  if (!abcCount) throw new AbcError(`没有 DoABC tag：${swfPath}`);
  const byName = new Map();
  for (const ref of refs) {
    for (const alias of ref.aliases) {
      if (!byName.has(alias)) byName.set(alias, []);
      byName.get(alias).push(ref);
    }
  }
  return { refs, abcCount, bodyCount, byName };
}

function requireRef(index, name) {
  const m = index.byName.get(name) || [];
  if (m.length !== 1) throw new AbcError(`期望 ${name} 恰好 1 个方法体，实际 ${m.length} 个`);
  return m[0];
}

/**
 * 从整类 pcode 文本里抽出某个方法的可回填块。
 * 与 `abc_methods.py`/`pcode_tools.py` 的 `extract_method_block` 同构：
 * 起于 `trait method QName(...,"<leaf>")` 行，止于同缩进的 `end ; method` 行。
 * **不能**从 `public function ...` 起——FFDec 导入时会报 `Invalid instruction name:public`。
 */
function extractMethodBlock(pcodeText, traitKind, traitName) {
  const lines = pcodeText.split(/\r?\n/);
  const uniq = new RegExp(`^(\\s*)trait\\s+${traitKind}\\s+.*,"${traitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)\\s*$`);
  const matches = [];
  lines.forEach((l, i) => {
    if (uniq.test(l)) matches.push(i);
  });
  if (matches.length !== 1) throw new AbcError(`期望恰好 1 个 ${traitKind} trait "${traitName}"，实际 ${matches.length} 个`);
  const start = matches[0];
  let methodLine = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "method") {
      methodLine = i;
      break;
    }
    if (lines[i].trimStart().startsWith("trait ")) break;
  }
  if (methodLine < 0) throw new AbcError(`trait "${traitName}" 后面找不到 method 段`);
  const methodIndent = lines[methodLine].match(/^\s*/)[0];
  let endLine = -1;
  for (let i = methodLine + 1; i < lines.length; i += 1) {
    if (lines[i] === `${methodIndent}end ; method`) {
      endLine = i;
      break;
    }
  }
  if (endLine < 0) throw new AbcError(`method 段 "${traitName}" 没有 end ; method`);
  return { text: lines.slice(start, endLine + 1).join("\n") + "\n", startLine: start + 1, endLine: endLine + 1 };
}

const PCODE_TAG = "SP_CN_P0_PCODE_TAG_1";

/**
 * 路线 B 探针：只替换**单个既有方法体**（不改类结构、不重编译整类）。
 * 断言核心：替换后**其它所有方法体的 body index 与字节码必须逐字节不变**。
 */
function stagePcode(baseListFp) {
  step("B1/4 索引基座 SWF 的 AVM2 方法体");
  const idxBase = indexSwfMethods(D.swfIn);
  log(`DoABC tag = ${idxBase.abcCount}  方法体总数 = ${idxBase.bodyCount}`);
  const clsParts = CLASS.split(".");
  const clsLeaf = clsParts[clsParts.length - 1];
  const clsPkg = clsParts.slice(0, -1).join(".");
  const targetName = `${clsPkg}:${clsLeaf}/startLoginServer`;
  const ref = requireRef(idxBase, targetName);
  log(`靶方法 ${targetName} → bodyIndex=${ref.bodyIndex}  code=${ref.codeLen} B  code_sha256=${ref.codeSha.slice(0, 16)}…`);
  if (ref.codeLen > 64) throw new AbcError(`startLoginServer 的字节码异常地长（${ref.codeLen} B），锚点可能已失效`);

  step("B2/4 导出整类 pcode 并抽出该方法块");
  const pcDir = path.join(WORK, "pcode_route");
  fs.rmSync(pcDir, { recursive: true, force: true });
  fs.mkdirSync(pcDir, { recursive: true });
  ffdec(["-format", "script:pcode", "-selectclass", CLASS, "-export", "script", pcDir, D.swfIn]);
  const pcFile = path.join(pcDir, "scripts", ...CLASS.split(".")) + ".pcode";
  if (!fs.existsSync(pcFile)) throw new AbcError(`pcode 导出缺文件：${pcFile}`);
  const block = extractMethodBlock(fs.readFileSync(pcFile, "utf8"), "method", "startLoginServer");
  log(`方法块 = ${pcFile}:${block.startLine}-${block.endLine}`);
  if (!block.text.includes('pushstring ""')) throw new AbcError("方法块里找不到 pushstring \"\" 锚点");
  const patchedBlock = block.text.replace('pushstring ""', `pushstring "${PCODE_TAG}"`);
  if (patchedBlock === block.text) throw new AbcError("pcode 方法块没被改动");
  const blockFile = path.join(WORK, "pcode_startLoginServer.pcode");
  fs.writeFileSync(blockFile, patchedBlock, "utf8");
  log(`改后方法块 → ${blockFile}（pushstring "" → pushstring "${PCODE_TAG}"）`);

  step("B3/4 -replace 单个方法体（body index 版）");
  const swfPcode = path.join(WORK, "pcode_patched.swf");
  ffdec(["-replace", D.swfIn, swfPcode, CLASS, blockFile, String(ref.bodyIndex)]);
  if (!fs.existsSync(swfPcode)) throw new AbcError("P-code 替换没产出 SWF");
  log(`pcode_patched.swf = ${fs.statSync(swfPcode).size} B（基座 ${fs.statSync(D.swfIn).size} B，Δ${fs.statSync(swfPcode).size - fs.statSync(D.swfIn).size}）`);
  log(`sha256 = ${sha256File(swfPcode)}`);

  step("B4/4 回读断言：其余方法体必须逐字节不变");
  const idxAfter = indexSwfMethods(swfPcode);
  const failures = [];
  const changed = [];
  if (idxAfter.bodyCount !== idxBase.bodyCount) failures.push(`方法体总数变了：${idxBase.bodyCount} → ${idxAfter.bodyCount}`);
  if (idxAfter.abcCount !== idxBase.abcCount) failures.push(`DoABC 数变了：${idxBase.abcCount} → ${idxAfter.abcCount}`);
  // 按 id（abcIndex#bodyIndex）对齐比较，靶方法体自己排除在外
  const afterById = new Map(idxAfter.refs.map(x => [x.id, x]));
  for (const a of idxBase.refs) {
    if (a.id === ref.id) continue; // 靶方法体，本来就该变
    const b = afterById.get(a.id);
    if (!b) {
      changed.push(`#${a.id} 在 patched 里找不到了（方法体表重排？）`);
    } else if (a.methodInfoIndex !== b.methodInfoIndex) {
      changed.push(`#${a.id} ${a.methodName} method_info 下标变了 ${a.methodInfoIndex} → ${b.methodInfoIndex}`);
    } else if (a.codeSha !== b.codeSha) {
      changed.push(`#${a.id} ${a.methodName} 字节码变了`);
    }
  }
  const baseById = new Set(idxBase.refs.map(x => x.id));
  for (const b of idxAfter.refs) {
    if (!baseById.has(b.id)) changed.push(`#${b.id} 是新增的方法体`);
  }
  const targetAfter = requireRef(idxAfter, targetName);
  const targetChanged = targetAfter.codeSha !== ref.codeSha;
  // 新串是**字符串常量池**里的，不会出现在 code 字节里 —— 直接查整份 SWF 的字节
  const tagInSwf = fs.readFileSync(swfPcode).includes(Buffer.from(PCODE_TAG, "utf8"));
  log(`其它方法体变化数 = ${changed.length}（期望 0）`);
  log(`靶方法体变化 = ${targetChanged}；SWF 里含新串 = ${tagInSwf}`);

  // 最硬的一条：从 patched.swf 重新导出该类 pcode，确认渲染出来就是新串
  const pcDir2 = path.join(WORK, "pcode_route_after");
  fs.rmSync(pcDir2, { recursive: true, force: true });
  fs.mkdirSync(pcDir2, { recursive: true });
  ffdec(["-format", "script:pcode", "-selectclass", CLASS, "-export", "script", pcDir2, swfPcode]);
  const pcAfter = fs.readFileSync(path.join(pcDir2, "scripts", ...CLASS.split(".")) + ".pcode", "utf8");
  const blockAfter = extractMethodBlock(pcAfter, "method", "startLoginServer");
  const roundTripOk = blockAfter.text.includes(`pushstring "${PCODE_TAG}"`) && !blockAfter.text.includes('pushstring ""');
  log(`回读靶方法块 = ${pcDir2}\\...\\ChannelSDKDummy.pcode:${blockAfter.startLine}-${blockAfter.endLine}`);
  log(`回读 pcode 里出现 pushstring "${PCODE_TAG}" 且旧串消失 = ${roundTripOk}`);

  if (changed.length) failures.push(`非靶方法体被改动：${changed.slice(0, 5).join(" ; ")}`);
  if (!targetChanged) failures.push("靶方法体字节码没变（替换没生效）");
  if (!tagInSwf) failures.push(`patched.swf 里没有新串 ${PCODE_TAG}`);
  if (!roundTripOk) failures.push(`回读 pcode 未渲染出新串 ${PCODE_TAG}（或旧串仍在）`);

  // 类清单不变
  const r = spawnSync(JAVA, ["-Xmx4g", "-Djava.awt.headless=true", "-jar", FFDEC, "-air", "-onerror", "abort", "-dumpAS3", swfPcode], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const dumpPc = path.join(WORK, "dumpAS3_pcode.txt");
  fs.writeFileSync(dumpPc, r.stdout || "");
  const listPc = fingerprintClassList(dumpPc);
  if (listPc.count !== baseListFp.count || listPc.sha256 !== baseListFp.sha256) {
    failures.push(`类清单变了：${baseListFp.count}/${baseListFp.sha256.slice(0, 8)} → ${listPc.count}/${listPc.sha256.slice(0, 8)}`);
  }

  const fpOut = {
    route: "B: pcode-method-body-replace",
    abc_tags: idxBase.abcCount,
    method_bodies: idxBase.bodyCount,
    target_method: targetName,
    target_body_index: ref.bodyIndex,
    base_code_sha256: ref.codeSha,
    patched_code_sha256: targetAfter.codeSha,
    tag_in_patched_swf: tagInSwf,
    pcode_roundtrip_ok: roundTripOk,
    other_bodies_changed: changed.length,
    other_bodies_changed_examples: changed.slice(0, 10),
    class_count_unchanged: listPc.count === baseListFp.count && listPc.sha256 === baseListFp.sha256,
    patched_swf: { path: swfPcode, sha256: sha256File(swfPcode), bytes: fs.statSync(swfPcode).size },
  };
  log("P-code 路线断言结果:\n" + JSON.stringify(fpOut, null, 2));
  if (failures.length) {
    console.error("FAIL P-code 路线断言未通过：");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUTDIR, "sp-cn-p0-pcode-report.json"), JSON.stringify({ ...fpOut, failures: [], generated_at: new Date().toISOString() }, null, 2), "utf8");
  return fpOut;
}

// ────────────────────────────────────────────────────────────── 主流程

function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(OUTDIR, { recursive: true });
  const t0 = Date.now();
  const all = STAGE === "all";
  const doStage = s => all || STAGE === s;

  // 路线 B 独立入口：--stage pcode（不跑路线 A 的重活）
  if (STAGE === "pcode") {
    if (!fs.existsSync(D.swfIn)) stageExtract();
    const fpBase = fs.existsSync(D.dumpBase) ? fingerprintClassList(D.dumpBase) : stageDumpBase();
    stagePcode(fpBase);
    log(`DONE 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

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
