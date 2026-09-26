#!/usr/bin/env node
/**
 * rename-package.mjs — StarPoint CN 客户端共存（改包名 / Bundle ID）
 * ============================================================================
 * 目的（验收 A10）：让自研客户端与官方客户端**装在同一台手机上**。
 * 官方安装身份是 `com.leiting.wf`（14 字符，Android `package` 与 iOS
 * `CFBundleIdentifier` 同值），本工具把它改成等长的自有 id，从而：
 *   1. 两个 APK / 两个 IPA 的安装身份不同 ⇒ 可共存、互不覆盖；
 *   2. AIR 存档按应用 id 隔离 ⇒ 新包 = 全新存档
 *      （Android：/data/data/<新包名>/files/...；iOS：各自沙箱）。
 *
 * 【为什么必须等长】`classes.dex` 里有一个 `"com.leiting.wf"` 字符串，是壳
 * （packer，类 `s.h.e.l.l.A`）在构造时写入字段 `packageName` 并传给 native
 * 类加载器 `al(ClassLoader, ApplicationInfo, packageName, orignAppName)` 的
 * 安装身份串。dex 的 `string_data_item` = uleb128(utf16 长度) + MUTF-8 + 0x00，
 * 且 `string_ids` 表里存的是**绝对文件偏移**；长度一变，其后所有数据整体错位，
 * 只能整体重建 dex（还要满足 AOSP 校验器对 string_data 区连续性与 MUTF-8 排序
 * 的要求）——风险不可接受。等长则一切都是**原地字节替换**，0 偏移变动。
 * 因此本工具**默认拒绝不等长包名**（可用 --allow-unequal-length 显式放行，
 * 代价是放弃 dex 身份串改写，见 §风险）。
 *
 * 【等长的连带好处】改完之后四个被改 ZIP 条目的**解压后大小全部不变**
 * （AndroidManifest.xml / resources.arsc / classes.dex / application.xml），
 * 只有 deflate 压缩后长度变化 ⇒ 改动面最小化。
 *
 * 用法
 * ----
 *   # 只读侦察：打印官方包名 / 所有需要改的位置 / 残留分类
 *   node client-patch/tools/rename-package.mjs --in <apk> --inspect
 *
 *   # Android
 *   node client-patch/tools/rename-package.mjs \
 *     --in  out/sp-cn-lan.apk \
 *     --out out/sp-cn-lan-coexist.apk \
 *     --package com.starpoints
 *
 *   # iOS（改 CFBundleIdentifier + AIR application.xml <id>）
 *   node client-patch/tools/rename-package.mjs \
 *     --in apkipa/iOS-1.8.4.ipa --out out/sp-cn-coexist.ipa --package com.starpoints
 *
 * 幂等：对已经改过的输入再跑一次 ⇒ 识别为 noop，退出码 0，并（若给了 --out）
 * 原样复制到输出。任一断言失败 ⇒ 硬失败（退出码非 0）并打印原因。
 *
 * 本文件是 P12 的独占写入集；`client-patch/build/**` 归 P7，本工具不写那边。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 官方安装身份的**默认**值（仅用于兜底/文档）。
 *
 * 注意：两个平台的安装身份**不保证同值**，实测：
 *   - Android `安卓v15.2.apk`  → `AndroidManifest.xml` 的 package = `com.leiting.wf`
 *   - iOS `iOS-1.8.4.ipa`      → `CFBundleIdentifier`           = `com.leiting.wf`
 *   - iOS `苹果v15.2.ipa`      → `CFBundleIdentifier`           = `com.kulo.wf`
 * ⇒ 本工具**从不假设** `from`，一律从产物里现读（见 renameApk / renameIpa）。
 */
export const OFFICIAL_PACKAGE = 'com.leiting.wf';
/** iOS v15.2 分支的官方 Bundle ID（实测值；仅用于文档与 inspect 兜底展示）。 */
export const OFFICIAL_BUNDLE_ID_IOS_15_2 = 'com.kulo.wf';
/** 默认共存包名（派工卡 A14 暂定值）。14 字符 ⇒ 与 `com.leiting.wf` 等长。 */
export const DEFAULT_COEXIST_PACKAGE = 'cn.starpoint.a';
/** 默认共存显示名（iOS `CFBundleDisplayName`，便于与官方客户端区分）。 */
export const DEFAULT_DISPLAY_NAME = '星点弹射';
/**
 * 等长（14 字符）替代候选，任选其一都满足全部安全性质（AXML 字符串池原地替换）：
 *   cn.starpoint.a / com.starpoints / com.star.point / com.spcn.games / starpoint.wfcn
 */
export const EQUAL_LENGTH_CANDIDATES = [
  'cn.starpoint.a',
  'com.starpoints',
  'com.star.point',
  'com.spcn.games',
  'starpoint.wfcn',
];

/**
 * 已编译类型的 FQN / 计费 SKU **保护规则**：逐字保留，它们不是安装身份。
 * 必须按 `from` 现构造：iOS v15.2 的 `from` 是 `com.kulo.wf`，
 * `air.com.kulo.wf.AppEntry` 与 `com.kulo.wf.stonepack_*` 同样受保护。
 */
export function protectedRe(from = OFFICIAL_PACKAGE) {
  const esc = from.replace(/\./g, '\\.');
  return new RegExp(
    `air\\.${esc}\\.AppEntry|com\\.leiting\\.sdk\\.[A-Za-z0-9_$]+|${esc}\\.(?:stonepack_[A-Za-z0-9_]+|weekly_set_[0-9]+)`,
    'g',
  );
}

/** AIR 主类 FQN（唯一被保留的 `air.<id>.AppEntry`）。 */
function appEntryOf(from) {
  return `air.${from}.AppEntry`;
}

/** AIR FileProvider 的 URI authority 模板串——必须排在 `from` 之前替换。 */
function airFileProviderOf(from) {
  return `air.${from}.fileprovider`;
}

const AXML_MAGIC = 0x0003;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE_TYPE = 0x0200;

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const APK_SIG_BLOCK_MAGIC = Buffer.from('APK Sig Block 42');

/** v1 JAR 签名文件——改名后必然失效，默认剥掉（旧 Android 5/6 上留着就是装不上）。 */
const V1_SIGNATURE_RE = /^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$/i;

export class RenameError extends Error {
  constructor(message, { usage = false } = {}) {
    super(message);
    this.name = 'RenameError';
    this.usage = usage;
    /** 退出码：2 = 用法错误，1 = 业务失败 */
    this.exitCode = usage ? 2 : 1;
  }
}

function fail(message) {
  throw new RenameError(message);
}

/** 用法错误（退出码 2）——未知参数 / 参数缺值 / 缺少 --in。 */
function usageFail(message) {
  throw new RenameError(message, { usage: true });
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (((b << 16) | a) >>> 0);
}

function sha1(buf) {
  return createHash('sha1').update(buf).digest();
}

function align4(n) {
  return (n + 3) & ~3;
}

function readUleb128(buf, off) {
  let result = 0;
  let shift = 0;
  let size = 0;
  for (;;) {
    const byte = buf[off + size];
    if (byte === undefined) fail(`uleb128 越界读取 @${off}`);
    result |= (byte & 0x7f) << shift;
    size++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (size > 5) fail(`uleb128 过长 @${off}`);
  }
  return { value: result >>> 0, size };
}

/** UTF-16 与 MUTF-8 对 ASCII 一致；本工具只改 ASCII 串，非 ASCII 原样保留。 */
function isAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** 校验包名 / Bundle ID 合法性（Android 段首字母 + [a-z0-9_]；iOS 反向 DNS）。 */
export function validatePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) fail('包名不能为空');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(name)) {
    fail(`包名不合法（需 ≥2 段、每段以字母开头、仅 [A-Za-z0-9_]）：${name}`);
  }
  if (name.length > 127) fail(`包名过长（>127 字符，arsc 定长字段装不下）：${name}`);
  return name;
}

/** 非抛出版本，供 CLI 预判 `--rename-package` 后跟的可选目标名。 */
export function isValidPackageName(name) {
  try {
    validatePackageName(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造"安装身份串 → 新值"的映射函数。**长的先替换**，并整体跳过保护串。
 * 返回 null 表示该串不需要改（或受保护，必须逐字保留）。
 *
 * 规则顺序是关键：`air.<from>.fileprovider` 必须排在裸 `<from>` 之前，
 * 否则 `air.com.leiting.wf.fileprovider` 会被先拆成 `air.cn.starpoint.a.fileprovider`。
 */
export function makeStringMapper({ from = OFFICIAL_PACKAGE, to, extra = [] }) {
  const re = protectedRe(from);
  const rules = [
    [airFileProviderOf(from), `${to}.fileprovider`],
    ...extra,
    [from, to],
  ];
  return (s) => {
    if (typeof s !== 'string' || s.length === 0) return null;
    re.lastIndex = 0;
    // 保护串整体跳过：AppEntry 类 FQN / leiting SDK FQN / 计费 SKU
    if (re.test(s)) return null;
    let out = s;
    for (const [a, b] of rules) {
      if (a && out.includes(a)) out = out.split(a).join(b);
    }
    return out === s ? null : out;
  };
}

// ---------------------------------------------------------------------------
// AXML —— 二进制 AndroidManifest.xml
// ---------------------------------------------------------------------------
// chunk 链从 XML header 的 headerSize（偏移 2 处 u16）开始，不是 0。
// 字符串池两种编码（UTF-8 / UTF-16）都实现；本 APK 是纯 UTF-16、未排序、无 style。

function decodeStringItem(buf, off, isUtf8) {
  if (isUtf8) {
    let len = buf[off];
    let prefix = 1;
    if (len & 0x80) {
      len = ((len & 0x7f) << 8) | buf[off + 1];
      prefix = 2;
    }
    const str = buf.subarray(off + prefix, off + prefix + len).toString('utf8');
    // 之后是 utf16 长度（1~2 字节）+ 0x00 终止
    let p = off + prefix + len;
    if (buf[p] & 0x80) p += 2;
    else p += 1;
    const total = p + 1 - off;
    return { str, total };
  }
  let len = buf.readUInt16LE(off);
  let prefix = 2;
  if (len & 0x8000) {
    len = ((len & 0x7fff) << 16) | buf.readUInt16LE(off + 2);
    prefix = 4;
  }
  const str = buf.subarray(off + prefix, off + prefix + len * 2).toString('utf16le');
  return { str, total: prefix + len * 2 + 2 };
}

function encodeStringItem(str, isUtf8) {
  if (!isAscii(str)) fail(`AXML 重建只支持 ASCII 串（遇到非 ASCII：${JSON.stringify(str)}）`);
  if (isUtf8) {
    const bytes = Buffer.from(str, 'utf8');
    if (bytes.length >= 0x8000) fail('AXML UTF-8 串过长');
    const head = bytes.length < 0x80 ? Buffer.from([bytes.length]) : Buffer.from([0x80 | (bytes.length >> 8), bytes.length & 0xff]);
    const utf16Len = str.length;
    const tailLen = utf16Len < 0x80 ? Buffer.from([utf16Len]) : Buffer.from([0x80 | (utf16Len >> 8), utf16Len & 0xff]);
    return Buffer.concat([head, bytes, tailLen, Buffer.from([0])]);
  }
  const body = Buffer.from(str, 'utf16le');
  const n = str.length;
  const head = n < 0x8000 ? Buffer.alloc(2) : Buffer.alloc(4);
  if (n < 0x8000) head.writeUInt16LE(n, 0);
  else {
    head.writeUInt16LE(0x8000 | (n >> 16), 0);
    head.writeUInt16LE(n & 0xffff, 2);
  }
  return Buffer.concat([head, body, Buffer.from([0, 0])]);
}

/** 解析 AXML：返回 header / 字符串池 / 全部 chunk 与元素树（用于验证）。 */
export function parseAxml(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== AXML_MAGIC) fail('不是 AXML（magic != 0x0003）');
  const headerSize = buf.readUInt16LE(2);
  const totalSize = buf.readUInt32LE(4);
  if (totalSize > buf.length) fail(`AXML 声明大小 ${totalSize} 超过缓冲 ${buf.length}`);

  const chunks = [];
  let off = headerSize;
  while (off + 8 <= totalSize) {
    const type = buf.readUInt16LE(off);
    const hs = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > totalSize) fail(`AXML chunk @${off} size=${size} 越界`);
    chunks.push({ type, headerSize: hs, size, off });
    off += size;
  }

  const poolChunk = chunks.find((c) => c.type === CHUNK_STRING_POOL);
  if (!poolChunk) fail('AXML 缺少 STRING_POOL');

  const pool = parseStringPool(buf, poolChunk);

  // 元素树（只解析 start/end element 与属性，够验证用）
  const elements = [];
  const stack = [];
  for (const c of chunks) {
    if (c.type === 0x0102) {
      const line = buf.readUInt32LE(c.off + 8);
      const nameIdx = buf.readUInt32LE(c.off + 20);
      const attrStart = buf.readUInt16LE(c.off + 24);
      const attrSize = buf.readUInt16LE(c.off + 26);
      const attrCount = buf.readUInt16LE(c.off + 28);
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const a = c.off + 16 + attrStart + i * attrSize;
        const nsIdx = buf.readInt32LE(a);
        const nIdx = buf.readUInt32LE(a + 4);
        const rawIdx = buf.readInt32LE(a + 8);
        const typeByte = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        attrs.push({
          ns: nsIdx >= 0 ? pool.strings[nsIdx] : null,
          name: pool.strings[nIdx],
          type: typeByte,
          raw: rawIdx >= 0 ? pool.strings[rawIdx] : null,
          value: typeByte === 0x03 ? pool.strings[data] : data,
        });
      }
      const el = { name: pool.strings[nameIdx], line, attrs, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(el);
      else elements.push(el);
      stack.push(el);
    } else if (c.type === 0x0103) {
      stack.pop();
    }
  }

  return { headerSize, totalSize, chunks, poolChunk, pool, elements };
}

function parseStringPool(buf, chunk) {
  const off = chunk.off;
  const stringCount = buf.readUInt32LE(off + 8);
  const styleCount = buf.readUInt32LE(off + 12);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const stylesStart = buf.readUInt32LE(off + 24);
  const isUtf8 = (flags & 0x100) !== 0;
  const offsets = [];
  for (let i = 0; i < stringCount; i++) offsets.push(buf.readUInt32LE(off + chunk.headerSize + i * 4));
  const strings = [];
  const items = [];
  for (let i = 0; i < stringCount; i++) {
    const abs = off + stringsStart + offsets[i];
    const { str, total } = decodeStringItem(buf, abs, isUtf8);
    strings.push(str);
    items.push({ abs, total });
  }
  return { off, size: chunk.size, headerSize: chunk.headerSize, stringCount, styleCount, flags, stringsStart, stylesStart, isUtf8, offsets, strings, items };
}

/**
 * 改 AXML 里的字符串。
 * - 全部改动等字节长 ⇒ **原地替换**，池大小、字符串池偏移、后续 chunk 全部不变。
 * - 存在不等长改动 ⇒ 重建字符串池并平移后续 chunk（受保护串逐字节拷贝原文，保证保真）。
 */
export function patchAxml(buf, { mapper }) {
  const parsed = parseAxml(buf);
  const { pool, poolChunk } = parsed;

  const changes = [];
  for (let i = 0; i < pool.strings.length; i++) {
    const next = mapper(pool.strings[i]);
    if (next !== null && next !== pool.strings[i]) {
      changes.push({ index: i, from: pool.strings[i], to: next, was: pool.strings[i] });
    }
  }
  if (changes.length === 0) return { buf, changes: [], mode: 'noop', parsed };

  const oldItems = changes.map((c) => encodeStringItem(c.from, pool.isUtf8));
  const newItems = changes.map((c) => encodeStringItem(c.to, pool.isUtf8));
  const allEqual = oldItems.every((b, i) => b.length === newItems[i].length);

  if (allEqual) {
    const out = Buffer.from(buf);
    changes.forEach((c, i) => {
      const item = pool.items[c.index];
      const enc = newItems[i];
      const derived = item.total;
      if (enc.length !== derived) {
        fail(`AXML 原地替换长度不符（串#${c.index}）：编码 ${enc.length} != 原始 ${derived}`);
      }
      enc.copy(out, item.abs);
    });
    // 回读验证
    const re = parseAxml(out);
    for (const c of changes) {
      if (re.pool.strings[c.index] !== c.to) fail(`AXML 原地替换回读失败：串#${c.index}`);
    }
    return { buf: out, changes, mode: 'in-place', parsed: re };
  }

  // 重建路径
  if (pool.styleCount !== 0) fail('AXML 不等长改名不支持带 style 的字符串池');
  const changedIdx = new Map(changes.map((c, i) => [c.index, i]));
  const pieces = [];
  const newOffsets = [];
  let cursor = 0;
  for (let i = 0; i < pool.strings.length; i++) {
    newOffsets.push(cursor);
    let item;
    if (changedIdx.has(i)) {
      item = newItems[changedIdx.get(i)];
    } else {
      const it = pool.items[i];
      item = buf.subarray(it.abs, it.abs + it.total);
    }
    pieces.push(item);
    cursor += item.length;
  }
  const stringsStart = 28 + pool.stringCount * 4 + pool.styleCount * 4;
  const body = Buffer.concat(pieces);
  const padded = align4(stringsStart + body.length);
  const padBuf = Buffer.alloc(padded - stringsStart - body.length);
  const poolSize = padded;
  const poolHead = Buffer.alloc(28);
  poolHead.writeUInt16LE(CHUNK_STRING_POOL, 0);
  poolHead.writeUInt16LE(28, 2);
  poolHead.writeUInt32LE(poolSize, 4);
  poolHead.writeUInt32LE(pool.stringCount, 8);
  poolHead.writeUInt32LE(pool.styleCount, 12);
  poolHead.writeUInt32LE(pool.flags, 16);
  poolHead.writeUInt32LE(stringsStart, 20);
  poolHead.writeUInt32LE(0, 24);
  const offsetBuf = Buffer.alloc(pool.stringCount * 4);
  newOffsets.forEach((o, i) => offsetBuf.writeUInt32LE(o, i * 4));
  const newPool = Buffer.concat([poolHead, offsetBuf, body, padBuf]);

  const delta = newPool.length - poolChunk.size;
  const head = Buffer.from(buf.subarray(0, parsed.headerSize));
  head.writeUInt32LE(parsed.totalSize + delta, 4);
  const after = buf.subarray(poolChunk.off + poolChunk.size, parsed.totalSize);
  const out = Buffer.concat([head, newPool, after]);

  const re = parseAxml(out);
  for (const c of changes) {
    if (re.pool.strings[c.index] !== c.to) fail(`AXML 重建回读失败：串#${c.index}`);
  }
  return { buf: out, changes, mode: 'rebuild', parsed: re };
}

/** 从 AXML 里读 `manifest` 的 `package` 属性（只读侦察用）。 */
export function readAxmlPackage(buf) {
  const parsed = parseAxml(buf);
  const manifest = parsed.elements[0];
  if (!manifest || manifest.name !== 'manifest') fail('AXML 根元素不是 manifest');
  const attr = manifest.attrs.find((a) => a.name === 'package');
  if (!attr) fail('AndroidManifest.xml 缺少 package 属性');
  return { packageName: attr.value, attr, parsed };
}

// ---------------------------------------------------------------------------
// resources.arsc —— 包里只有一处包名字段，且是定长 256 字节 UTF-16
// ---------------------------------------------------------------------------
// ResTable_package 头：type(0x0200) / headerSize(288) / size / id / name[128] u16。
// name 是定长缓冲 ⇒ 任意 ≤127 字符的名字都能原地写，chunk size 不变。

export function findArscPackageChunks(buf) {
  if (buf.length < 12 || buf.readUInt16LE(0) !== RES_TABLE_TYPE) fail('不是 resources.arsc（RES_TABLE magic 缺失）');
  const headerSize = buf.readUInt16LE(2);
  const totalSize = buf.readUInt32LE(4);
  const found = [];
  let off = headerSize;
  const end = Math.min(totalSize, buf.length);
  while (off + 8 <= end) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > end) fail(`arsc chunk @${off} size=${size} 越界`);
    if (type === RES_TABLE_PACKAGE_TYPE) {
      const nameBuf = buf.subarray(off + 12, off + 12 + 256);
      const name = nameBuf.toString('utf16le').replace(/\0.*$/s, '');
      found.push({ off, size, id: buf.readUInt32LE(off + 8), name });
    }
    off += size;
  }
  return found;
}

export function patchArscPackageName(buf, { from, to }) {
  const chunks = findArscPackageChunks(buf);
  // 幂等：from === to 时"回读仍有旧值"的断言恒真，会把一次无害的重跑判成失败。
  if (from === to) return { buf, found: chunks, changes: [] };
  const targets = chunks.filter((c) => c.name === from);
  const changes = [];
  let out = buf;
  if (targets.length) {
    out = Buffer.from(buf);
    for (const c of targets) {
      const enc = Buffer.from(to, 'utf16le');
      if (enc.length > 256) fail(`包名过长（>127 字符）：${to}`);
      out.fill(0, c.off + 12, c.off + 12 + 256);
      enc.copy(out, c.off + 12);
      changes.push({ kind: 'arsc-package', offset: c.off, from: c.name, to });
      if (out.readUInt32LE(c.off + 4) !== c.size) fail('arsc 包名改写意外改变了 chunk size');
    }
    const re = findArscPackageChunks(out);
    if (re.some((c) => c.name === from)) fail('arsc 包名回读仍有旧值');
    if (!re.some((c) => c.name === to)) fail('arsc 包名回读未见新值');
  }
  return { buf: out, found: chunks, changes };
}

// ---------------------------------------------------------------------------
// classes.dex —— 壳的安装身份串
// ---------------------------------------------------------------------------
// string_data_item = uleb128(utf16 长度) + MUTF-8 + 0x00；string_ids 存绝对偏移。
// 等长 ⇒ 原地替换；之后必须重算 signature(SHA-1) 与 checksum(Adler-32)。
// 另注：dex 要求 string_ids 按 MUTF-8 排序，`com.*` → `com.*` 的改名不破坏排序。

export function patchDexString(buf, { from, to }) {
  if (buf.length < 112 || buf.subarray(0, 4).toString('ascii') !== 'dex\n') fail('不是 dex（magic 缺失）');
  const fileSize = buf.readUInt32LE(32);
  if (fileSize !== buf.length) fail(`dex file_size=${fileSize} 与实际 ${buf.length} 不符`);
  const stringIdsSize = buf.readUInt32LE(56);
  const stringIdsOff = buf.readUInt32LE(60);

  if (Buffer.byteLength(from, 'utf8') !== Buffer.byteLength(to, 'utf8')) {
    fail(`dex 字符串改名必须等字节长：${from}(${Buffer.byteLength(from)}) vs ${to}(${Buffer.byteLength(to)})`);
  }

  const hits = [];
  for (let i = 0; i < stringIdsSize; i++) {
    const dataOff = buf.readUInt32LE(stringIdsOff + i * 4);
    const { value: utf16Len, size: prefix } = readUleb128(buf, dataOff);
    const bytes = Buffer.from(buf.subarray(dataOff + prefix, dataOff + prefix + utf16Len));
    if (bytes.toString('utf8') === from) hits.push({ index: i, dataOff, prefix, utf16Len });
  }
  if (hits.length === 0) return { buf, hits: [], changes: [] };

  const out = Buffer.from(buf);
  const changes = [];
  for (const h of hits) {
    Buffer.from(to, 'utf8').copy(out, h.dataOff + h.prefix);
    out.writeUInt8(0, h.dataOff + h.prefix + h.utf16Len);
    changes.push({ kind: 'dex-string', index: h.index, offset: h.dataOff, from, to });
  }
  // 重算 signature / checksum
  sha1(out.subarray(32)).copy(out, 12);
  out.writeUInt32LE(adler32(out.subarray(12)), 8);
  // 回读验证
  const re = Buffer.from(out.subarray(hits[0].dataOff + hits[0].prefix, hits[0].dataOff + hits[0].prefix + hits[0].utf16Len)).toString('utf8');
  if (re !== to) fail(`dex 字符串回读失败：期望 ${to}，实得 ${re}`);
  if (adler32(out.subarray(12)) !== out.readUInt32LE(8)) fail('dex checksum 自检失败');
  if (!sha1(out.subarray(32)).equals(out.subarray(12, 32))) fail('dex signature 自检失败');
  return { buf: out, hits, changes };
}

/** 读取 dex 字符串表（只读侦察 / 幂等判定用）。 */
export function readDexStrings(buf) {
  if (buf.length < 112 || buf.subarray(0, 4).toString('ascii') !== 'dex\n') fail('不是 dex（magic 缺失）');
  const stringIdsSize = buf.readUInt32LE(56);
  const stringIdsOff = buf.readUInt32LE(60);
  const out = [];
  for (let i = 0; i < stringIdsSize; i++) {
    const dataOff = buf.readUInt32LE(stringIdsOff + i * 4);
    const { value, size } = readUleb128(buf, dataOff);
    out.push(buf.subarray(dataOff + size, dataOff + size + value).toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 纯文本补丁（AIR application.xml / iOS Info.plist）
// ---------------------------------------------------------------------------

/**
 * 改 AIR 的 `application.xml`（明文 XML）。
 * `from` **必须传入**：iOS v15.2 的 app id 是 `com.kulo.wf`，写死 `com.leiting.wf` 会一字不改、
 * 却因为后续断言拿 `to` 去匹配而失败（或更糟：静默漏改）。
 */
export function patchAirDescriptor(buf, { mapper, from = OFFICIAL_PACKAGE }) {
  const text = buf.toString('utf8');
  if (!text.startsWith('<?xml')) fail('AIR application.xml 不是明文 XML？');
  const re = protectedRe(from);
  const esc = from.replace(/\./g, '\\.');
  const scan = new RegExp(
    `air\\.${esc}\\.AppEntry|com\\.leiting\\.sdk\\.[A-Za-z0-9_$]+|air\\.${esc}\\.fileprovider|${esc}(?:\\.(?:stonepack_[A-Za-z0-9_]+|weekly_set_[0-9]+))?`,
    'g',
  );
  const changes = [];
  const seen = new Set();
  const out = text.replace(scan, (m) => {
    re.lastIndex = 0;
    if (re.test(m)) {
      if (!seen.has(`keep:${m}`)) {
        seen.add(`keep:${m}`);
        changes.push({ kind: 'keep', value: m, reason: '受保护（类 FQN / SDK FQN / 计费 SKU）' });
      }
      return m;
    }
    const next = mapper(m);
    const value = next === null ? m : next;
    const key = `set:${m}->${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      changes.push({ kind: next === null ? 'keep' : 'replace', from: m, to: value });
    }
    return value;
  });
  if (out === text) return { buf, changes: [], mode: 'noop' };
  return { buf: Buffer.from(out, 'utf8'), changes, mode: 'text' };
}

// ---------------------------------------------------------------------------
// 二进制 plist（bplist00）—— 零依赖编解码器
// ---------------------------------------------------------------------------
// 实测：`苹果v15.2.ipa` 的 Info.plist 是 **二进制 plist**（`bplist00`，4319 B，212 对象），
// 而 `iOS-1.8.4.ipa` 是 XML。官方 plist 里 `CFBundleIdentifier` 长度任选，
// 旧实现"只支持等字节长原地改"对 `com.kulo.wf`(11) → `cn.starpoint.a`(14) 直接做不到，
// 且其长度前缀硬编码 0x0f（=ASCII 串长 15）在本仓任何真实产物上都不成立。
// ⇒ 这里做**完整解码 → 改值 → 重新编码**，再用"解码回来逐键比对"做硬断言。

const BPLIST_MAGIC = 'bplist00';

/** bplist 的字符串是 **big-endian** UTF-16；Node 只认 utf16le，故读后/写前 swap16。 */
function readUtf16BE(buf, start, units) {
  const b = Buffer.from(buf.subarray(start, start + units * 2));
  b.swap16();
  return b.toString('utf16le');
}

function writeUtf16BE(str) {
  const b = Buffer.from(str, 'utf16le');
  b.swap16();
  return b;
}

function decodeBplistObject(buf, off, info) {
  const marker = buf[off];
  const hi = marker >> 4;
  const lo = marker & 0x0f;
  const readLen = (p) => {
    if (lo !== 0x0f) return { len: lo, size: 0 };
    const m2 = buf[p];
    if ((m2 >> 4) !== 0x1) fail(`bplist 长度标记非法 @${p}`);
    const n = 1 << (m2 & 0x0f);
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + 1 + i];
    return { len, size: 1 + n };
  };

  switch (hi) {
    case 0x0: {
      if (marker === 0x08) return { value: false, end: off + 1 };
      if (marker === 0x09) return { value: true, end: off + 1 };
      if (marker === 0x00) return { value: null, end: off + 1 };
      fail(`bplist 未知简单对象 0x${marker.toString(16)} @${off}`);
      break;
    }
    case 0x1: {
      const n = 1 << lo;
      return { value: Number(buf.readBigUInt64BE(off + 1, Math.min(n, 8))) === 0 ? 0 : readInt(buf, off + 1, n), end: off + 1 + n };
    }
    case 0x2: {
      if (lo !== 3 || buf.length < off + 9) fail(`bplist 不支持 real 长度 ${lo} @${off}`);
      return { value: buf.readDoubleBE(off + 1), end: off + 9 };
    }
    case 0x3: {
      if (lo !== 3) fail(`bplist 不支持 date 长度 ${lo} @${off}`);
      return { value: new Date(Math.round((buf.readDoubleBE(off + 1) + 978307200) * 1000)), end: off + 9, isDate: true };
    }
    case 0x4: {
      const { len, size } = readLen(off + 1);
      const start = off + 1 + size;
      return { value: Buffer.from(buf.subarray(start, start + len)), end: start + len, isData: true };
    }
    case 0x5: {
      const { len, size } = readLen(off + 1);
      const start = off + 1 + size;
      return { value: buf.subarray(start, start + len).toString('latin1'), end: start + len, isAsciiString: true };
    }
    case 0x6: {
      const { len, size } = readLen(off + 1);
      const start = off + 1 + size;
      return { value: readUtf16BE(buf, start, len), end: start + len * 2 };
    }
    case 0xa: {
      const { len, size } = readLen(off + 1);
      const start = off + 1 + size;
      const out = [];
      for (let i = 0; i < len; i++) out.push(buf.readUIntBE(start + i * info.refSize, info.refSize));
      return { value: { __refs: out, __kind: 'array' }, end: start + len * info.refSize };
    }
    case 0xd: {
      const { len, size } = readLen(off + 1);
      const start = off + 1 + size;
      const out = [];
      for (let i = 0; i < len; i++) {
        out.push(buf.readUIntBE(start + i * info.refSize, info.refSize));
        out.push(buf.readUIntBE(start + (len + i) * info.refSize, info.refSize));
      }
      return { value: { __refs: out, __kind: 'dict' }, end: start + len * 2 * info.refSize };
    }
    default:
      fail(`bplist 未知对象类型 0x${hi.toString(16)} @${off}`);
  }
  return null;
}

function readInt(buf, off, n) {
  let v = 0n;
  for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(buf[off + i]);
  if (n === 8 && v >= 1n << 63n) v -= 1n << 64n;
  return Number(v);
}

/** 解码 bplist00 → 纯 JS 值（dict/array/string/number/bool/Date/Buffer）。 */
export function decodeBplist(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== BPLIST_MAGIC) fail('不是二进制 plist（magic != bplist00）');
  const t = buf.subarray(buf.length - 32);
  const info = {
    offsetIntSize: t[6],
    refSize: t[7],
    numObjects: Number(t.readBigUInt64BE(8)),
    topObject: Number(t.readBigUInt64BE(16)),
    offsetTableOffset: Number(t.readBigUInt64BE(24)),
  };
  if (info.offsetIntSize < 1 || info.offsetIntSize > 8) fail(`bplist offsetIntSize 非法：${info.offsetIntSize}`);
  if (info.refSize < 1 || info.refSize > 8) fail(`bplist refSize 非法：${info.refSize}`);
  if (info.numObjects < 1 || info.numObjects > 1e7) fail(`bplist numObjects 非法：${info.numObjects}`);
  if (info.offsetTableOffset + info.numObjects * info.offsetIntSize > buf.length) fail('bplist 偏移表越界');

  const offsets = [];
  for (let i = 0; i < info.numObjects; i++) {
    offsets.push(buf.readUIntBE(info.offsetTableOffset + i * info.offsetIntSize, info.offsetIntSize));
  }

  const memo = new Map();
  const resolve = (ref) => {
    if (ref < 0 || ref >= offsets.length) fail(`bplist 对象引用越界：${ref}`);
    if (memo.has(ref)) return memo.get(ref);
    const node = decodeBplistObject(buf, offsets[ref], info);
    if (node.value && node.value.__refs) {
      // 先占位再填充，容忍 plist 里理论上的环
      const isDict = node.value.__kind === 'dict';
      const holder = isDict ? {} : [];
      memo.set(ref, holder);
      if (isDict) {
        for (let i = 0; i < node.value.__refs.length; i += 2) {
          holder[String(resolve(node.value.__refs[i]))] = resolve(node.value.__refs[i + 1]);
        }
      } else {
        for (const r of node.value.__refs) holder.push(resolve(r));
      }
      return holder;
    }
    memo.set(ref, node.value);
    return node.value;
  };

  return { value: resolve(info.topObject), info, objects: offsets.length };
}

/** 把纯 JS 值编码为 bplist00。 */
export function encodeBplist(value) {
  const objects = [];
  const indexOfKey = new Map();
  const keyOf = (v) => `${typeof v}:${v instanceof Date ? `d${v.getTime()}` : v instanceof Buffer ? `b${v.toString('base64')}` : String(v)}`;

  const addObject = (v) => {
    const body = encodeBplistObject(v, objects);
    objects.push(body);
    return objects.length - 1;
  };

  // 自底向上：先给子对象分配编号，再编码父对象
  const build = (v) => {
    if (v === null || v === undefined) return addObject(null);
    if (Array.isArray(v)) {
      const refs = v.map(build);
      return addObject({ __kind: 'array', refs });
    }
    if (v instanceof Date) return addObject({ __kind: 'date', value: v });
    if (Buffer.isBuffer(v)) return addObject({ __kind: 'data', value: v });
    if (typeof v === 'object') {
      // ⚠ bplist 的 dict 布局是 **先全部 key 引用、再全部 value 引用**（各 count 个），
      //   交错写 [k0,v0,k1,v1,...] 会让任何标准解析器把后半段 value 当 key 读 —— 不报错，
      //   只是静默解出一棵错树。必须分两组收集。
      const keys = [];
      const vals = [];
      for (const k of Object.keys(v)) {
        keys.push(keyIndexOf(k));
        vals.push(build(v[k]));
      }
      return addObject({ __kind: 'dict', refs: [...keys, ...vals] });
    }
    return addObject({ __kind: 'scalar', value: v });
  };
  const keyIndexOf = (k) => {
    if (indexOfKey.has(`s:${k}`)) return indexOfKey.get(`s:${k}`);
    const i = addObject({ __kind: 'scalar', value: k });
    indexOfKey.set(`s:${k}`, i);
    return i;
  };

  const top = build(value);

  const numObjects = objects.length;
  const refSize = Math.max(1, Math.ceil(Math.log2(numObjects + 1) / 8));

  // 编码所有对象，收集偏移
  const chunks = [];
  const offsets = [];
  let cursor = 8; // bplist00 + 1 字节填充
  for (let i = 0; i < numObjects; i++) {
    offsets.push(cursor);
    const b = renderBplistObject(objects[i], refSize);
    chunks.push(b);
    cursor += b.length;
  }
  const offsetTableOffset = cursor;
  const offsetIntSize = Math.max(1, Math.ceil(Math.log2(cursor + 1) / 8));

  const head = Buffer.alloc(8);
  head.write(BPLIST_MAGIC, 0, 'latin1');
  const body = Buffer.concat(chunks);
  const offTab = Buffer.alloc(numObjects * offsetIntSize);
  offsets.forEach((o, i) => offTab.writeUIntBE(o, i * offsetIntSize, offsetIntSize));

  const trailer = Buffer.alloc(32);
  trailer[6] = offsetIntSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(numObjects), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);

  return Buffer.concat([head, body, offTab, trailer]);
}

function encodeBplistObject(v, _objects) {
  if (v === null || v === undefined) return { __kind: 'scalar', value: null };
  if (typeof v === 'object' && v.__kind) return v;
  return { __kind: 'scalar', value: v };
}

function intMarker(n) {
  if (n < 0) return null;
  if (n <= 0xff) return { marker: 0x10, size: 1 };
  if (n <= 0xffff) return { marker: 0x11, size: 2 };
  if (n <= 0xffffffff) return { marker: 0x12, size: 4 };
  return { marker: 0x13, size: 8 };
}

/**
 * bplist 的长长度前缀：低半字节 0xF 之后跟一个**整数对象**（marker `0x1n` + n 字节），
 * 而不是 `0xF0|pow` 那种自造格式 —— 后者能骗过自己却让任何标准解析器（含本文件的解码器）报错。
 * 仅在 len >= 15 时调用；返回含 marker 的完整前缀。
 */
function lenPrefix(len) {
  if (len < 15) return Buffer.alloc(0);
  const size = len <= 0xff ? 1 : len <= 0xffff ? 2 : len <= 0xffffffff ? 4 : 8;
  const pow = size === 1 ? 0 : size === 2 ? 1 : size === 4 ? 2 : 3;
  const b = Buffer.alloc(1 + size);
  b[0] = 0x10 | pow;
  if (size === 8) b.writeBigUInt64BE(BigInt(len), 1);
  else b.writeUIntBE(len, 1, size);
  return b;
}

function renderBplistObject(o, refSize) {
  if (o.__kind === 'scalar') {
    const v = o.value;
    if (v === null || v === undefined) return Buffer.from([0x00]);
    if (v === true) return Buffer.from([0x09]);
    if (v === false) return Buffer.from([0x08]);
    if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        const m = intMarker(v);
        if (m) {
          const b = Buffer.alloc(1 + m.size);
          b[0] = m.marker;
          if (m.size === 8) b.writeBigUInt64BE(BigInt(v), 1);
          else b.writeUIntBE(v, 1, m.size);
          return b;
        }
      }
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(v, 1);
      return b;
    }
    if (typeof v === 'string') {
      if (isAscii(v)) {
        const body = Buffer.from(v, 'latin1');
        return Buffer.concat([Buffer.from([0x50 | (body.length < 15 ? body.length : 0x0f)]), body.length < 15 ? Buffer.alloc(0) : lenPrefix(body.length), body]);
      }
      const body = writeUtf16BE(v);
      return Buffer.concat([Buffer.from([0x60 | (v.length < 15 ? v.length : 0x0f)]), v.length < 15 ? Buffer.alloc(0) : lenPrefix(v.length), body]);
    }
    fail(`bplist 编码不支持的类型：${typeof v}`);
  }
  if (o.__kind === 'date') {
    const b = Buffer.alloc(9);
    b[0] = 0x33;
    b.writeDoubleBE(o.value.getTime() / 1000 - 978307200, 1);
    return b;
  }
  if (o.__kind === 'data') {
    const body = o.value;
    return Buffer.concat([Buffer.from([0x40 | (body.length < 15 ? body.length : 0x0f)]), body.length < 15 ? Buffer.alloc(0) : lenPrefix(body.length), body]);
  }
  if (o.__kind === 'array') {
    const n = o.refs.length;
    const head = Buffer.concat([Buffer.from([0xa0 | (n < 15 ? n : 0x0f)]), n < 15 ? Buffer.alloc(0) : lenPrefix(n)]);
    const body = Buffer.alloc(n * refSize);
    o.refs.forEach((r, i) => body.writeUIntBE(r, i * refSize, refSize));
    return Buffer.concat([head, body]);
  }
  if (o.__kind === 'dict') {
    const n = o.refs.length / 2;
    const head = Buffer.concat([Buffer.from([0xd0 | (n < 15 ? n : 0x0f)]), n < 15 ? Buffer.alloc(0) : lenPrefix(n)]);
    const body = Buffer.alloc(o.refs.length * refSize);
    o.refs.forEach((r, i) => body.writeUIntBE(r, i * refSize, refSize));
    return Buffer.concat([head, body]);
  }
  fail(`bplist 编码遇到未知对象种类 ${o.__kind}`);
  return null;
}

/** 结构比对：返回所有"路径 → 值"扁平表，用于改写前后逐键核对。 */
export function flattenPlist(value, prefix = '') {
  const out = new Map();
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      for (const [k, x] of flattenPlist(v, `${prefix}[${i}]`)) out.set(k, x);
    });
    return out;
  }
  if (value instanceof Date || Buffer.isBuffer(value) || value === null || typeof value !== 'object') {
    out.set(prefix, value instanceof Date ? `date:${value.toISOString()}` : Buffer.isBuffer(value) ? `data:${value.toString('base64')}` : `${typeof value}:${value}`);
    return out;
  }
  for (const k of Object.keys(value)) {
    for (const [kk, x] of flattenPlist(value[k], prefix ? `${prefix}.${k}` : k)) out.set(kk, x);
  }
  return out;
}

/** 从 Info.plist（XML 明文 或 bplist00）读出 Bundle ID —— iOS 没有统一身份，必须实测。 */
export function readBundleIdFromPlist(buf) {
  const head = buf.subarray(0, 8).toString('latin1');
  if (head === BPLIST_MAGIC) {
    const root = decodeBplist(buf).value;
    const id = root?.CFBundleIdentifier;
    if (typeof id !== 'string') fail('二进制 plist 内 CFBundleIdentifier 缺失');
    return { id, kind: 'bplist' };
  }
  const text = buf.toString('utf8');
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  if (!m) fail('Info.plist 未找到 CFBundleIdentifier');
  return { id: m[1], kind: 'xml' };
}

/** 旧 Info.plist（XML 明文 或 bplist00）。二进制走完整解码 → 改值 → 重新编码。 */
export function patchInfoPlist(buf, { from, to, displayName = null }) {
  const head = buf.subarray(0, 8).toString('latin1');

  if (head === BPLIST_MAGIC) {
    const before = decodeBplist(buf);
    const root = before.value;
    if (root === null || typeof root !== 'object' || Array.isArray(root)) fail('二进制 plist 顶层不是字典');
    const flatBefore = flattenPlist(root);

    const changes = [];
    if (root.CFBundleIdentifier !== from) {
      fail(`Info.plist CFBundleIdentifier 期望 ${from}，实得 ${root.CFBundleIdentifier}`);
    }
    root.CFBundleIdentifier = to;
    changes.push({ kind: 'cfbundleidentifier', from, to });

    // CFBundleURLName 与 Bundle ID 同值时一并改（URL scheme 的展示名，不是安装身份，但保持自洽）
    for (const t of Array.isArray(root.CFBundleURLTypes) ? root.CFBundleURLTypes : []) {
      if (t && t.CFBundleURLName === from) {
        t.CFBundleURLName = to;
        changes.push({ kind: 'cfbundleurlname', from, to });
      }
    }
    if (displayName && typeof root.CFBundleDisplayName === 'string') {
      const was = root.CFBundleDisplayName;
      if (was !== displayName) {
        root.CFBundleDisplayName = displayName;
        changes.push({ kind: 'cfbundledisplayname', from: was, to: displayName });
      }
    }

    const out = encodeBplist(root);

    // ---- 回读断言：解码回来逐路径比对，除被改的键外必须逐一相同 ----
    const after = decodeBplist(out);
    const flatAfter = flattenPlist(after.value);
    const changedPaths = new Set(['CFBundleIdentifier']);
    if (changes.some((c) => c.kind === 'cfbundledisplayname')) changedPaths.add('CFBundleDisplayName');
    for (let i = 0; i < (Array.isArray(root.CFBundleURLTypes) ? root.CFBundleURLTypes.length : 0); i++) {
      if (root.CFBundleURLTypes[i]?.CFBundleURLName === to) changedPaths.add(`CFBundleURLTypes[${i}].CFBundleURLName`);
    }

    const diffs = [];
    for (const [k, v] of flatBefore) {
      if (changedPaths.has(k)) continue;
      if (!flatAfter.has(k)) diffs.push(`丢失键 ${k}`);
      else if (flatAfter.get(k) !== v) diffs.push(`${k}: ${v} → ${flatAfter.get(k)}`);
    }
    for (const k of flatAfter.keys()) if (!flatBefore.has(k)) diffs.push(`新增键 ${k}`);
    if (diffs.length) fail(`二进制 plist 回读比对失败（非预期改动）：\n  - ${diffs.slice(0, 10).join('\n  - ')}`);
    // 比对扁平表时值是带类型前缀的标签，这里直接查解码后的对象，避免拿标签跟裸值比
    if (after.value.CFBundleIdentifier !== to) fail(`二进制 plist 回读 CFBundleIdentifier != ${to}（实得 ${after.value.CFBundleIdentifier}）`);
    if (flatAfter.size !== flatBefore.size) fail(`二进制 plist 回读键数变化：${flatBefore.size} → ${flatAfter.size}`);

    return { buf: out, changes, mode: 'bplist-reencode', decoded: after.value };
  }

  const text = buf.toString('utf8');
  const changes = [];
  const swap = (key, value) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    const m = re.exec(text);
    if (!m) return false;
    if (m[2] === value) return true;
    changes.push({ kind: key.toLowerCase(), from: m[2], to: value });
    text = text.replace(re, (_a, a, _b, c) => `${a}${value}${c}`);
    return true;
  };
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  if (!m) fail('Info.plist 未找到 CFBundleIdentifier');
  if (m[1] !== from) fail(`Info.plist CFBundleIdentifier 期望 ${from}，实得 ${m[1]}`);

  let text2 = text;
  const replaceKey = (key, value) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    const mm = re.exec(text2);
    if (!mm || mm[2] === value) return false;
    changes.push({ kind: key.toLowerCase(), from: mm[2], to: value });
    text2 = text2.replace(re, (_a, a, _b, c) => `${a}${value}${c}`);
    return true;
  };

  replaceKey('CFBundleIdentifier', to);
  replaceKey('CFBundleURLName', to);
  if (displayName) replaceKey('CFBundleDisplayName', displayName);

  const leftover = text2.split(from).length - 1;
  if (leftover !== 0) fail(`Info.plist 改写后仍残留旧 Bundle ID ${from} × ${leftover} 处`);
  return { buf: Buffer.from(text2, 'utf8'), changes, mode: 'plist-xml' };
}

// ---------------------------------------------------------------------------
// ZIP（读写都自己来：仓库里 unzipper 只能读；且需要 span 级最小差分重写）
// ---------------------------------------------------------------------------

export function parseZip(buf) {
  const eocdSearchStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= eocdSearchStart; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('找不到 EOCD');
  const entriesTotal = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (entriesTotal === 0xffff || cdOff === 0xffffffff) fail('ZIP64 不支持（本包非 ZIP64）');
  if (cdOff + cdSize > buf.length) fail('中央目录越界');

  const entries = [];
  let off = cdOff;
  while (off < cdOff + cdSize) {
    if (buf.readUInt32LE(off) !== ZIP_CD_SIG) fail(`中央目录条目签名错误 @${off}`);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const e = {
      name: buf.subarray(off + 46, off + 46 + nlen).toString('utf8'),
      cdOff: off,
      cdRecordLen: 46 + nlen + elen + clen,
      flags: buf.readUInt16LE(off + 8),
      method: buf.readUInt16LE(off + 10),
      crc: buf.readUInt32LE(off + 16),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      lho: buf.readUInt32LE(off + 42),
    };
    entries.push(e);
    off += e.cdRecordLen;
  }
  if (entries.length !== entriesTotal) fail(`中央目录条目数 ${entries.length} != EOCD 声明 ${entriesTotal}`);

  // 本地头解析 + span 计算（按 lho 排序，span 含 data descriptor / 尾部未声明数据）
  for (const e of entries) {
    const lho = e.lho;
    if (buf.readUInt32LE(lho) !== ZIP_LOCAL_SIG) fail(`本地头签名错误：${e.name} @${lho}`);
    e.localFlags = buf.readUInt16LE(lho + 6);
    e.localMethod = buf.readUInt16LE(lho + 8);
    e.localModTime = buf.readUInt16LE(lho + 10);
    e.localModDate = buf.readUInt16LE(lho + 12);
    e.localCrc = buf.readUInt32LE(lho + 14);
    e.localCsize = buf.readUInt32LE(lho + 18);
    e.localUsize = buf.readUInt32LE(lho + 22);
    e.localNameLen = buf.readUInt16LE(lho + 26);
    e.localExtraLen = buf.readUInt16LE(lho + 28);
    e.localExtra = buf.subarray(lho + 30 + e.localNameLen, lho + 30 + e.localNameLen + e.localExtraLen);
    e.dataOff = lho + 30 + e.localNameLen + e.localExtraLen;
  }
  const byOffset = [...entries].sort((a, b) => a.lho - b.lho);
  byOffset.forEach((e, i) => {
    e.spanEnd = i + 1 < byOffset.length ? byOffset[i + 1].lho : cdOff;
    if (e.spanEnd < e.dataOff) fail(`span 计算异常：${e.name}`);
  });

  return { buf, eocd, entriesTotal, cdSize, cdOff, commentLen, entries, byOffset };
}

function readEntryData(zip, entry) {
  const raw = zip.buf.subarray(entry.dataOff, entry.dataOff + entry.csize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRaw(raw, entry.name);
  fail(`不支持的压缩方法 ${entry.method}（${entry.name}）`);
}

function inflateRaw(raw, name) {
  try {
    return zlib.inflateRawSync(raw);
  } catch (err) {
    fail(`解压失败（${name}）：${err.message}`);
  }
}

function deflateRaw(data) {
  return zlib.deflateRawSync(data, { level: 9 });
}

/** 探测 APK Signing Block（v2/v3）；返回其起始偏移或 null。 */
export function findApkSigningBlock(buf, cdOff) {
  const mi = buf.lastIndexOf(APK_SIG_BLOCK_MAGIC, cdOff);
  if (mi < 0 || mi + 16 !== cdOff) return null;
  const size = Number(buf.readBigUInt64LE(mi - 8));
  const start = cdOff - 8 - size;
  if (start < 0 || buf.readBigUInt64LE(start) !== BigInt(size)) return null;
  const pairs = [];
  let p = start + 8;
  while (p < mi - 8) {
    const len = Number(buf.readBigUInt64LE(p));
    pairs.push({ id: buf.readUInt32LE(p + 8), len });
    p += 8 + len;
  }
  return { start, end: cdOff, size, pairs };
}

/**
 * ZIP 最小差分重写。
 * - 未改动条目按 span 原样拷贝 ⇒ 字节保真，且其数据偏移是否 4 对齐完全可控。
 * - 改动的条目重新压缩，并通过**本地 extra 字段补白**保证
 *   `(新span长 - 原span长) % 4 === 0` ⇒ 后续所有条目（含 1527 个 STORED 条目）
 *   的 `dataOff % 4` 不变（zipalign -c -v 4 仍然全绿）。
 * - STORED 且等长的改动走**纯原地字节替换**（连 span 长度都不变）。
 */
export function rewriteZip(zip, { transforms = new Map(), drop = new Set(), trailingTrim = null } = {}) {
  const { buf } = zip;
  const deltaByEntry = new Map();
  let delta = 0;
  const pieces = [];
  const cdRecords = [];
  const warnings = [];
  const changed = [];

  const byOffset = zip.byOffset;
  const lastIndex = byOffset.length - 1;

  for (let i = 0; i < byOffset.length; i++) {
    const e = byOffset[i];
    const origSpan = buf.subarray(e.lho, e.spanEnd);
    const isLast = i === lastIndex;

    // 剥离必须排在尾部裁剪之前判断：最后一个条目若同时要剥离，整段 span
    // （含紧随其后的 APK Signing Block）一起消失，正是想要的效果。
    if (drop.has(e.name)) {
      // 只有当其后不再有"原样拷贝"的条目时才能真的删字节，否则会破坏 4 字节对齐。
      const laterUntouched = byOffset.slice(i + 1).some((x) => !drop.has(x.name) && !transforms.has(x.name));
      if (laterUntouched) {
        pieces.push({ lho: e.lho + delta, bytes: origSpan });
        warnings.push(`保留已剥离条目 ${e.name} 的字节（其后仍有原样条目，删字节会破坏 4 字节对齐）`);
      } else {
        delta -= origSpan.length;
        warnings.push(`剥离条目 ${e.name}（${origSpan.length} 字节${isLast && trailingTrim ? '，含 APK Signing Block' : ''}）`);
      }
      continue;
    }

    if (trailingTrim && isLast && trailingTrim.from >= e.lho) {
      // 尾部签名块裁剪（无对齐风险：它之后没有任何条目数据）
      const kept = buf.subarray(e.lho, trailingTrim.from);
      pieces.push({ lho: e.lho + delta, bytes: kept });
      cdRecords.push(patchCdRecord(buf, e, { lho: e.lho + delta }));
      delta -= origSpan.length - kept.length;
      warnings.push(`裁剪尾部 APK Signing Block：${origSpan.length - kept.length} 字节`);
      continue;
    }

    const t = transforms.get(e.name);
    if (!t) {
      if (delta % 4 !== 0) {
        fail(`内部错误：条目 ${e.name} 之前累计位移 ${delta} 不是 4 的倍数，会破坏其数据对齐`);
      }
      pieces.push({ lho: e.lho + delta, bytes: origSpan });
      cdRecords.push(patchCdRecord(buf, e, { lho: e.lho + delta }));
      continue;
    }

    const before = readEntryData(zip, e);
    const newData = t.run(before, e);
    if (!Buffer.isBuffer(newData)) fail(`转换器未返回 Buffer：${e.name}`);

    if (e.method === 0 && newData.length === e.usize) {
      // STORED 等长 ⇒ 原地补丁（span 长度不变，delta 不变）
      const span = Buffer.from(origSpan);
      newData.copy(span, e.dataOff - e.lho);
      const crc = crc32(newData);
      span.writeUInt32LE(crc, 14);
      pieces.push({ lho: e.lho + delta, bytes: span });
      cdRecords.push(patchCdRecord(buf, e, { lho: e.lho + delta, crc, csize: e.csize, usize: e.usize }));
      changed.push({ name: e.name, mode: 'stored-in-place', before: { csize: e.csize, usize: e.usize, crc: e.crc }, after: { csize: e.csize, usize: e.usize, crc }, strings: t.changes ?? [] });
      continue;
    }

    const compressed = e.method === 8 ? deflateRaw(newData) : newData;
    const crc = crc32(newData);
    const nameLen = e.localNameLen;
    const dataDesc = (buf.readUInt16LE(e.lho + 6) & 0x08) ? Buffer.alloc(16) : Buffer.alloc(0);
    if (dataDesc.length) {
      dataDesc.writeUInt32LE(crc, 0);
      dataDesc.writeUInt32LE(compressed.length, 4);
      dataDesc.writeUInt32LE(newData.length, 8);
    }
    // 对齐目标：新 span 长度与原 span 长度同余（mod 4），这样其后所有条目的
    // dataOff % 4 保持不变（zipalign -c -v 4 依旧全绿）。
    // 追加 extraPad 字节时：newSpanLen - origSpanLen = extraPad + fixedDelta。
    const base = 30 + nameLen + e.localExtraLen;
    const fixedDelta = base + compressed.length + dataDesc.length - origSpan.length;
    const need = (((-fixedDelta) % 4) + 4) % 4;
    // 合法 extra 字段最小 4 字节（id 2 + size 2 + 0 数据），故 need∈{1,2,3} 时补 need+4。
    const extraPad = need === 0 ? 0 : need + 4;
    const extra = extraPad === 0 ? e.localExtra : Buffer.concat([e.localExtra, makePaddingExtra(extraPad)]);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(ZIP_LOCAL_SIG, 0);
    header.writeUInt16LE(buf.readUInt16LE(e.lho + 4), 4);
    header.writeUInt16LE(buf.readUInt16LE(e.lho + 6), 6);
    header.writeUInt16LE(e.method, 8);
    header.writeUInt16LE(buf.readUInt16LE(e.lho + 10), 10);
    header.writeUInt16LE(buf.readUInt16LE(e.lho + 12), 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(newData.length, 22);
    header.writeUInt16LE(nameLen, 26);
    header.writeUInt16LE(extra.length, 28);
    const nameBuf = buf.subarray(e.lho + 30, e.lho + 30 + nameLen);
    const newSpan = Buffer.concat([header, nameBuf, extra, compressed, dataDesc]);
    if ((newSpan.length - origSpan.length) % 4 !== 0) {
      fail(`内部错误：条目 ${e.name} 补白后位移 ${newSpan.length - origSpan.length} 仍非 4 的倍数`);
    }
    deltaByEntry.set(e.name, newSpan.length - origSpan.length);
    pieces.push({ lho: e.lho + delta, bytes: newSpan });
    cdRecords.push(
      patchCdRecord(buf, e, {
        lho: e.lho + delta,
        crc,
        csize: compressed.length,
        usize: newData.length,
        flags: e.flags,
      }),
    );
    delta += newSpan.length - origSpan.length;
    changed.push({
      name: e.name,
      mode: 'recompressed',
      before: { csize: e.csize, usize: e.usize, crc: e.crc },
      after: { csize: compressed.length, usize: newData.length, crc },
      padBytes: extraPad,
      strings: t.changes ?? [],
    });
  }

  const body = Buffer.concat(pieces.map((p) => p.bytes));
  const cd = Buffer.concat(cdRecords);
  const eocd = Buffer.alloc(22 + zip.commentLen);
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdRecords.length, 8);
  eocd.writeUInt16LE(cdRecords.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  eocd.writeUInt16LE(zip.commentLen, 20);
  if (zip.commentLen) buf.copy(eocd, 22, zip.eocd + 22, zip.eocd + 22 + zip.commentLen);

  return { buf: Buffer.concat([body, cd, eocd]), changed, warnings, cdOffset: body.length };
}

/** 生成总计 `padLen` 字节的合法 extra 字段（id=0x0000，size=padLen-4，内容全 0）。 */
function makePaddingExtra(padLen) {
  if (padLen === 0) return Buffer.alloc(0);
  if (padLen < 4) fail(`内部错误：extra 补白 ${padLen} 字节无法构成合法 extra 字段`);
  const dataLen = padLen - 4;
  const b = Buffer.alloc(padLen);
  b.writeUInt16LE(0x0000, 0);
  b.writeUInt16LE(dataLen, 2);
  return b;
}

function patchCdRecord(buf, e, { crc, csize, usize, lho, flags }) {
  const rec = Buffer.from(buf.subarray(e.cdOff, e.cdOff + e.cdRecordLen));
  if (crc !== undefined) rec.writeUInt32LE(crc >>> 0, 16);
  if (csize !== undefined) rec.writeUInt32LE(csize >>> 0, 20);
  if (usize !== undefined) rec.writeUInt32LE(usize >>> 0, 24);
  if (lho !== undefined) rec.writeUInt32LE(lho >>> 0, 42);
  if (flags !== undefined) rec.writeUInt16LE(flags & 0xffff, 8);
  return rec;
}

// ---------------------------------------------------------------------------
// 残留扫描 / 分类
// ---------------------------------------------------------------------------

const RESIDUAL_RE = new RegExp(
  `air\\.com\\.leiting\\.wf\\.AppEntry|com\\.leiting\\.sdk\\.[A-Za-z0-9_$]+|com\\.leiting\\.wf\\.(?:stonepack_[A-Za-z0-9_]+|weekly_set_[0-9]+)|${OFFICIAL_PACKAGE.replace(/\./g, '\\.')}`,
  'g',
);

/**
 * 残留扫描用的正则。**必须按实际旧身份生成**：iOS v15.2 的 app id 是 `com.kulo.wf`，
 * 写死 `com.leiting.wf` 会让 `identity` 恒为 0 —— 假绿，改名是否真生效无从验证。
 */
export function residualRe(from = OFFICIAL_PACKAGE) {
  const esc = from.replace(/\./g, '\\.');
  return new RegExp(
    `air\\.${esc}\\.AppEntry|com\\.leiting\\.sdk\\.[A-Za-z0-9_$]+|${esc}\\.(?:stonepack_[A-Za-z0-9_]+|weekly_set_[0-9]+)|${esc}`,
    'g',
  );
}

/** 把一个条目解压后的内容按类别统计旧包名出现次数。 */
export function classifyResiduals(data, { from = OFFICIAL_PACKAGE } = {}) {
  const text = data.toString('latin1');
  const out = { identity: [], protected: [], outOfScope: [] };
  const re = residualRe(from);
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[0];
    if (v === from) out.identity.push({ offset: m.index, value: v });
    else if (v.startsWith(`${from}.`)) out.outOfScope.push({ offset: m.index, value: v });
    else out.protected.push({ offset: m.index, value: v });
  }
  return out;
}

export function scanResiduals(zip, { skip = new Set(), from = OFFICIAL_PACKAGE, maxEntrySize = 512 * 1024 * 1024 } = {}) {
  const per = {};
  const totals = { identity: 0, protected: 0, outOfScope: 0 };
  for (const e of zip.entries) {
    if (skip.has(e.name)) continue;
    // 上限 512MB：iOS 主二进制实测 192MB，旧的 64MB 上限会把它静默跳过
    // ⇒ iOS 的残留统计变成假绿（二进制里的 AppEntry / 计费 SKU 全看不见）。
    if (e.usize > maxEntrySize) continue;
    let data;
    try {
      data = readEntryData(zip, e);
    } catch {
      continue;
    }
    const r = classifyResiduals(data, { from });
    if (r.identity.length || r.protected.length || r.outOfScope.length) {
      per[e.name] = {
        identity: r.identity.length,
        protected: r.protected.length,
        outOfScope: r.outOfScope.length,
        sampleIdentity: r.identity.slice(0, 3),
        sampleProtected: [...new Set(r.protected.map((x) => x.value))].slice(0, 5),
        sampleOutOfScope: [...new Set(r.outOfScope.map((x) => x.value))].slice(0, 5),
      };
      totals.identity += r.identity.length;
      totals.protected += r.protected.length;
      totals.outOfScope += r.outOfScope.length;
    }
  }
  return { totals, perEntry: per };
}

// ---------------------------------------------------------------------------
// 主二进制身份串分类（只读；iOS 特有风险）
// ---------------------------------------------------------------------------

/**
 * 主二进制里出现的身份串**不是**安装身份，改不了也不该改，但必须让调用方看见。
 *
 * 实测 `苹果v15.2.ipa` 的 `Payload/worldflipper.app/worldflipper`（192MB）：
 *   `com.kulo.wf` × 0（与 Info.plist 一致 ⇒ 按 from 扫是"干净"的）
 *   `com.leiting.wf` × 122，分三类：
 *     · sku      `com.leiting.wf.stonepack_*` / `weekly_set_*` —— 计费 SKU，**改了就是改商品 ID**，禁改
 *     · keychain `<string>RUH384Q4E8.com.leiting.wf</string>` —— entitlements 的 keychain access group
 *     · bare     `com.leiting.wf`
 * ⇒ 只按 Info.plist 的 from 扫会给出"0 残留"的假绿，而二进制里其实躺着 122 处旧身份。
 */
export function classifyBinaryIdentities(data, { from, other = OFFICIAL_PACKAGE } = {}) {
  const text = data.toString('latin1');
  const ids = [...new Set([from, other].filter((x) => typeof x === 'string' && x))];
  const out = { bytes: text.length, ids: {} };
  for (const id of ids) {
    const count = text.split(id).length - 1;
    const rec = { count, kinds: { sku: 0, keychain: 0, bare: 0, other: 0 }, samples: { sku: [], keychain: [], other: [] } };
    if (count > 0) {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`[\\x20-\\x7e]{0,48}${esc}[\\x20-\\x7e]{0,36}`, 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const ctx = m[0];
        const at = ctx.indexOf(id);
        const tail = ctx.slice(at + id.length);
        const head = ctx.slice(0, at);
        if (/^\.(?:stonepack_|weekly_set_)/.test(tail)) {
          rec.kinds.sku++;
          const v = id + tail.match(/^\.(?:stonepack_|weekly_set_)[A-Za-z0-9_]*/)[0];
          if (rec.samples.sku.length < 8 && !rec.samples.sku.includes(v)) rec.samples.sku.push(v);
        } else if (/[A-Z0-9]{10}\.$/.test(head)) {
          rec.kinds.keychain++;
          const v = head.match(/[A-Z0-9]{10}\.$/)[0] + id;
          if (rec.samples.keychain.length < 4 && !rec.samples.keychain.includes(v)) rec.samples.keychain.push(v);
        } else if (tail === '' || /^[^\x20-\x7e]/.test(tail)) {
          rec.kinds.bare++;
        } else {
          rec.kinds.other++;
          const v = `${head.slice(-24)}${id}${tail.slice(0, 16)}`;
          if (rec.samples.other.length < 4) rec.samples.other.push(v);
        }
      }
    }
    out.ids[id] = rec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 只读侦察
// ---------------------------------------------------------------------------

export function inspect(filePath) {
  const buf = readFileSync(filePath);
  const zip = parseZip(buf);
  const isIpa = zip.entries.some((e) => e.name.startsWith('Payload/') && e.name.endsWith('.app/Info.plist'));
  const report = { file: filePath, size: buf.length, platform: isIpa ? 'ios' : 'android', entries: zip.entries.length };

  report.signingBlock = findApkSigningBlock(buf, zip.cdOff);
  report.v1SignatureEntries = zip.entries.filter((e) => V1_SIGNATURE_RE.test(e.name)).map((e) => e.name);

  if (isIpa) {
    const plistEntry = zip.entries.find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
    const plistBuf = readEntryData(zip, plistEntry);
    const { id, kind } = readBundleIdFromPlist(plistBuf);
    report.plistFormat = kind;
    report.bundleId = id;
    report.bundleIdLength = id.length;
    report.from = id;
    const appXml = zip.entries.find((e) => /^Payload\/[^/]+\.app\/META-INF\/AIR\/application\.xml$/.test(e.name));
    if (appXml) {
      const ax = readEntryData(zip, appXml).toString('utf8');
      report.airId = /<id>([^<]*)<\/id>/.exec(ax)?.[1] ?? null;
      report.airIdMatchesPlist = report.airId === id;
    }
    if (kind === 'bplist') {
      const root = decodeBplist(plistBuf).value;
      report.bundleDisplayName = root?.CFBundleDisplayName ?? null;
      // plist 里 Extensions 是 **dict（id → 版本）**，不是数组；早期实现对 dict 调 .map 直接 TypeError。
      const ext = root?.Extensions;
      report.extensionIds = Array.isArray(ext)
        ? ext.map((e) => e?.CFBundleIdentifier).filter(Boolean)
        : Object.keys(ext ?? {});
    }
  } else {
    const ax = zip.entries.find((e) => e.name === 'AndroidManifest.xml');
    const parsed = readAxmlPackage(readEntryData(zip, ax));
    report.package = parsed.packageName;
    report.packageLength = parsed.packageName.length;
    report.from = parsed.packageName;
    report.manifestStringsToRename = parsed.parsed.pool.strings
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s.includes(parsed.packageName) && !protectedRe(parsed.packageName).test(s));
    report.manifestProtectedStrings = parsed.parsed.pool.strings.filter((s) => {
      const re = protectedRe(parsed.packageName);
      re.lastIndex = 0;
      return re.test(s);
    });
    const arsc = zip.entries.find((e) => e.name === 'resources.arsc');
    if (arsc) report.arscPackages = findArscPackageChunks(readEntryData(zip, arsc));
    const dex = zip.entries.find((e) => /^classes\d*\.dex$/.test(e.name));
    if (dex) {
      const d = readEntryData(zip, dex);
      const ids = d.readUInt32LE(56);
      const off = d.readUInt32LE(60);
      report.dexStrings = [];
      for (let i = 0; i < ids; i++) {
        const p = d.readUInt32LE(off + i * 4);
        const { value, size } = readUleb128(d, p);
        const s = d.subarray(p + size, p + size + value).toString('utf8');
        if (s.includes('leiting')) report.dexStrings.push({ i, s });
      }
    }
  }
  report.residuals = scanResiduals(zip, { from: report.from });
  return report;
}

// ---------------------------------------------------------------------------
// Android APK 改名
// ---------------------------------------------------------------------------

export async function renameApk({
  inPath,
  outPath,
  packageName = DEFAULT_COEXIST_PACKAGE,
  allowUnequalLength = false,
  stripV1Signature = true,
  stripSigningBlock = true,
  extraRenames = [],
  dryRun = false,
} = {}) {
  if (!inPath) fail('缺少 --in');
  if (!existsSync(inPath)) fail(`输入不存在：${inPath}`);
  validatePackageName(packageName);
  const to = packageName;
  const warnings = [];
  const checks = [];
  const degraded = [];

  const buf = readFileSync(inPath);
  const zip = parseZip(buf);
  const signingBlock = findApkSigningBlock(buf, zip.cdOff);
  if (signingBlock) {
    warnings.push(
      `输入含 APK Signing Block（v2，${signingBlock.size} 字节）——改名后必然失效；输出为**未签名** APK，必须重新 apksigner 签名`,
    );
  }

  const axEntry = zip.entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!axEntry) fail('APK 内没有 AndroidManifest.xml');
  const axBuf = readEntryData(zip, axEntry);
  const from = readAxmlPackage(axBuf).packageName;

  const equalLength = Buffer.byteLength(from) === Buffer.byteLength(to);
  const mapper = makeStringMapper({ from, to, extra: extraRenames });

  // ---- 幂等短路：目标名 == 现有名 ⇒ 零改动（但照常产出产物） ----
  // 不加这一条，第二跑会拿 `to` 当 `from` 去扫残留，把已经正确的包判成"残留 4 处"而硬失败。
  if (from === to) {
    if (!dryRun && outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
    }
    return {
      ok: true,
      platform: 'android',
      noop: true,
      in: inPath,
      out: outPath ?? null,
      dryRun: Boolean(dryRun),
      from,
      to,
      equalLength: true,
      changedEntries: [],
      droppedEntries: [],
      plan: {},
      checks: [{ name: 'identity.already-target', ok: true, detail: `输入已是 ${to}，零改动` }],
      degraded: [],
      residuals: scanResiduals(zip, { from }),
      warnings: [],
      unsigned: true,
      resignCommands: [],
    };
  }

  if (!equalLength && !allowUnequalLength) {
    fail(
      `包名长度不等：官方 ${from}（${Buffer.byteLength(from)} 字符） vs 目标 ${to}（${Buffer.byteLength(to)} 字符）。\n` +
        `  等长是硬要求：classes.dex 的安装身份串是 uleb128 前缀 + 定长 MUTF-8，且 string_ids 存绝对偏移，\n` +
        `  长度一变其后全部数据错位（只能整体重建 dex，风险不可接受）。\n` +
        `  请改用 14 字符包名（候选：${EQUAL_LENGTH_CANDIDATES.join(' / ')}），\n` +
        `  或显式 --allow-unequal-length（代价：放弃 dex 身份串改写，壳的 packageName 将停留在旧值）。`,
    );
  }
  if (!equalLength) {
    warnings.push(
      `不等长改名：${from}(${Buffer.byteLength(from)}) → ${to}(${Buffer.byteLength(to)})。` +
        `classes.dex 的壳安装身份串**保持旧值**（dex 无法安全重构）——这是 R10「装上了但启动即崩」的头号嫌疑，必须真机验证。`,
    );
  }

  // ---- 逐条目转换器 ----
  const transforms = new Map();
  const perEntry = {};

  // 1) AndroidManifest.xml
  {
    const res = patchAxml(axBuf, { mapper });
    perEntry['AndroidManifest.xml'] = { mode: res.mode, changes: res.changes };
    if (res.changes.length) transforms.set('AndroidManifest.xml', { run: () => res.buf, changes: res.changes.map((c) => `${c.from} → ${c.to}`) });
    const re = res.mode === 'noop' ? parseAxml(axBuf) : res.parsed;
    const pkgAttr = re.elements[0].attrs.find((a) => a.name === 'package');
    checks.push({ name: 'manifest.package', ok: pkgAttr.value === to, detail: `${pkgAttr.value}` });
    const leftovers = re.pool.strings.filter((s) => mapper(s) !== null);
    checks.push({ name: 'manifest.identity-leftover', ok: leftovers.length === 0, detail: leftovers.slice(0, 5).join(',') });
  }

  // 2) resources.arsc（定长字段，原地改）
  {
    const e = zip.entries.find((x) => x.name === 'resources.arsc');
    if (e) {
      const data = readEntryData(zip, e);
      const res = patchArscPackageName(data, { from, to });
      perEntry['resources.arsc'] = { mode: res.changes.length ? 'in-place' : 'noop', found: res.found.map((c) => c.name) };
      if (res.changes.length) transforms.set('resources.arsc', { run: () => res.buf, changes: res.changes.map((c) => `${c.from} → ${c.to}`) });
    } else {
      warnings.push('APK 内没有 resources.arsc');
    }
  }

  // 3) classes.dex（壳身份串；不等长时跳过）
  {
    const e = zip.entries.find((x) => /^classes\d*\.dex$/.test(x.name));
    if (e) {
      const data = readEntryData(zip, e);
      const strings = readDexStrings(data);
      const hasFrom = strings.includes(from);
      const hasTo = strings.includes(to);
      if (!equalLength) {
        // 降级项，**不进 `checks`**：`checks` 里任何 ok:false 都会被下面的聚合直接 `fail()`，
        // 而 `--allow-unequal-length` 的语义恰恰是"明知 dex 身份串改不了、仍要出包"。
        // 放进 degraded 是为了让它照常出现在报告里，而不是被静默吞掉。
        perEntry[e.name] = { mode: 'skipped-unequal-length', hasFrom, hasTo };
        degraded.push({ name: 'dex.identity-string', detail: `不等长 ⇒ 跳过改写（hasFrom=${hasFrom} hasTo=${hasTo}，残留 1 处）` });
      } else if (hasFrom) {
        const res = patchDexString(data, { from, to });
        perEntry[e.name] = { mode: 'in-place', hits: res.hits.length };
        transforms.set(e.name, { run: () => res.buf, changes: [`string#${res.hits[0].index}: ${from} → ${to}`] });
        checks.push({ name: 'dex.identity-string', ok: true, detail: `原地改写 ${res.hits.length} 条（string#${res.hits.map((h) => h.index).join(',')}）` });
      } else {
        perEntry[e.name] = { mode: 'noop', hits: 0 };
        checks.push({ name: 'dex.identity-string', ok: hasTo, detail: hasTo ? '已是新包名（幂等 noop）' : 'dex 内既无旧值也无新值' });
      }
    }
  }

  // 4) AIR 描述符
  {
    const name = 'assets/META-INF/AIR/application.xml';
    const e = zip.entries.find((x) => x.name === name);
    if (e) {
      const data = readEntryData(zip, e);
      const res = patchAirDescriptor(data, { mapper });
      perEntry[name] = { mode: res.mode, changes: res.changes };
      if (res.changes.length && res.mode !== 'noop') {
        transforms.set(name, { run: () => res.buf, changes: res.changes.filter((c) => c.kind === 'replace').map((c) => `${c.from} → ${c.to}`) });
      }
      const text = (res.mode === 'noop' ? data : res.buf).toString('utf8');
      checks.push({ name: 'air.appid', ok: new RegExp(`<id>${to.replace(/\./g, '\\.')}</id>`).test(text), detail: /<id>([^<]*)<\/id>/.exec(text)?.[1] });
      const appEntry = appEntryOf(from);
      if (data.includes(appEntry)) {
        checks.push({ name: 'air.appentry-preserved', ok: text.includes(appEntry), detail: appEntry });
      }
    }
  }

  // 5) 其它需要剥离的
  const drop = new Set();
  if (stripV1Signature) {
    for (const e of zip.entries) if (V1_SIGNATURE_RE.test(e.name)) drop.add(e.name);
    if (drop.size) warnings.push(`剥离残留 v1 JAR 签名：${[...drop].join(', ')}（改名后必然校验失败；输出必须重签名）`);
  }

  let trailingTrim = null;
  if (signingBlock && stripSigningBlock) {
    trailingTrim = { from: signingBlock.start };
  }

  const result = rewriteZip(zip, { transforms, drop, trailingTrim });

  // ---- 回读验证 ----
  const outZip = parseZip(result.buf);
  const verify = [];
  {
    const e = outZip.entries.find((x) => x.name === 'AndroidManifest.xml');
    const parsed = readAxmlPackage(readEntryData(outZip, e));
    verify.push({ name: 'out.manifest.package', ok: parsed.packageName === to, detail: parsed.packageName });
  }
  {
    const e = outZip.entries.find((x) => x.name === 'resources.arsc');
    if (e) {
      const chunks = findArscPackageChunks(readEntryData(outZip, e));
      verify.push({ name: 'out.arsc.package', ok: chunks.some((c) => c.name === to) && !chunks.some((c) => c.name === from), detail: chunks.map((c) => c.name).join(',') });
    }
  }
  if (equalLength) {
    const e = outZip.entries.find((x) => /^classes\d*\.dex$/.test(x.name));
    if (e) {
      const d = readEntryData(outZip, e);
      const ids = d.readUInt32LE(56);
      const off = d.readUInt32LE(60);
      let hasNew = false;
      let hasOld = false;
      for (let i = 0; i < ids; i++) {
        const p = d.readUInt32LE(off + i * 4);
        const { value, size } = readUleb128(d, p);
        const s = d.subarray(p + size, p + size + value).toString('utf8');
        if (s === to) hasNew = true;
        if (s === from) hasOld = true;
      }
      verify.push({ name: 'out.dex.identity-string', ok: hasNew && !hasOld, detail: `new=${hasNew} old=${hasOld}` });
    }
  }
  {
    const e = outZip.entries.find((x) => x.name === 'assets/META-INF/AIR/application.xml');
    if (e) {
      const text = readEntryData(outZip, e).toString('utf8');
      const id = /<id>([^<]*)<\/id>/.exec(text)?.[1];
      verify.push({ name: 'out.air.appid', ok: id === to, detail: id });
    }
  }

  const residuals = scanResiduals(outZip, { from });
  // 不等长时 classes.dex 的壳身份串**故意**保留旧值（dex 无法安全重构），
  // 所以"残留 identity 必须为 0"这个断言在允许不等长的模式下恒假。
  // 它是用户显式 --allow-unequal-length 换来的已知代价，登记为降级项而非硬失败。
  const residualDetail = `identity=${residuals.totals.identity} protected=${residuals.totals.protected} outOfScope(SKU)=${residuals.totals.outOfScope}`;
  if (!equalLength) {
    degraded.push({ name: 'out.residual.identity', detail: `${residualDetail}（不等长模式下 dex 旧身份串保留，属已知代价）` });
  } else {
    verify.push({ name: 'out.residual.identity', ok: residuals.totals.identity === 0, detail: residualDetail });
  }
  // 剩下的残留必须是**受保护串**或（不等长时）dex 身份串，不能是任意东西
  {
    const unexplained = Object.entries(residuals.perEntry)
      .filter(([n, v]) => v.identity > 0 && !(n === 'classes.dex' && !equalLength))
      .map(([n, v]) => `${n}:identity=${v.identity}`);
    verify.push({ name: 'out.residual.explained', ok: unexplained.length === 0, detail: unexplained.join(',') || '全部残留均可解释' });
  }

  // 未改动条目字节保真 + 对齐不变
  {
    let drift = 0;
    let misalign = 0;
    for (const e of outZip.entries) {
      const orig = zip.entries.find((x) => x.name === e.name);
      if (!orig || transforms.has(e.name)) continue;
      if (orig.dataOff % 4 !== e.dataOff % 4) misalign++;
      const a = buf.subarray(orig.dataOff, orig.dataOff + orig.csize);
      const b = result.buf.subarray(e.dataOff, e.dataOff + e.csize);
      if (!a.equals(b)) drift++;
    }
    verify.push({ name: 'out.untouched-fidelity', ok: drift === 0 && misalign === 0, detail: `内容漂移=${drift} 对齐漂移=${misalign}` });
  }

  const failed = [...checks, ...verify].filter((c) => !c.ok);
  if (failed.length) {
    fail(`回读验证失败：\n  - ${failed.map((c) => `${c.name}: ${c.detail}`).join('\n  - ')}`);
  }

  if (!dryRun && outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.buf);
  }

  return {
    ok: true,
    platform: 'android',
    in: inPath,
    out: outPath ?? null,
    dryRun: Boolean(dryRun),
    from,
    to,
    equalLength,
    changedEntries: result.changed,
    droppedEntries: [...drop],
    plan: perEntry,
    checks: [...checks, ...verify],
    degraded,
    residuals,
    warnings: [...warnings, ...result.warnings],
    unsigned: true,
    resignCommands: [
      'zipalign -p -f 4 <out.apk> <out-aligned.apk>',
      'apksigner sign --ks sp-cn.keystore --ks-key-alias <alias> --v1-signing-enabled true --v2-signing-enabled true --out <out-signed.apk> <out-aligned.apk>',
      'apksigner verify --print-certs <out-signed.apk>',
    ],
  };
}

// ---------------------------------------------------------------------------
// iOS IPA 改名
// ---------------------------------------------------------------------------

export async function renameIpa({
  inPath,
  outPath,
  bundleId = DEFAULT_COEXIST_PACKAGE,
  displayName = null,
  extraRenames = [],
  dryRun = false,
} = {}) {
  if (!inPath) fail('缺少 --in');
  if (!existsSync(inPath)) fail(`输入不存在：${inPath}`);
  validatePackageName(bundleId);
  const buf = readFileSync(inPath);
  const zip = parseZip(buf);
  const plistEntry = zip.entries.find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
  if (!plistEntry) fail('IPA 内没有 Payload/*.app/Info.plist');
  const appDir = plistEntry.name.replace(/\/Info\.plist$/, '');
  const binaryPath = `${appDir}/${appDir.replace(/^Payload\//, '').replace(/\.app$/, '')}`;

  // ⚠ iOS 的 app id 不是常量：`苹果v15.2.ipa` 是 com.kulo.wf，`iOS-1.8.4.ipa` 是 com.leiting.wf。
  //   写死旧值 = 一字不改却仍按新值断言 → 只能靠实测读取。
  const plistBuf = readEntryData(zip, plistEntry);
  const fromRead = readBundleIdFromPlist(plistBuf);
  const from = fromRead.id;
  const warnings = [];
  if (from === bundleId && !displayName) {
    // 幂等：已是目标 Bundle ID 且没要求改显示名 ⇒ 零改动（照常产出产物）。
    // 早期实现直接 fail，会让"同一份产物跑第二遍"这种正常流水线步骤无故中断。
    if (!dryRun && outPath) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
    }
    return {
      ok: true,
      platform: 'ios',
      noop: true,
      in: inPath,
      out: outPath ?? null,
      dryRun: Boolean(dryRun),
      from,
      to: bundleId,
      equalLength: true,
      changedEntries: [],
      droppedEntries: [],
      plan: {},
      checks: [{ name: 'identity.already-target', ok: true, detail: `Info.plist 已是 ${bundleId}，零改动` }],
      degraded: [],
      warnings: [],
      resignCommands: [],
    };
  }
  warnings.push(`iOS 旧 Bundle ID 实测为 ${from}（Info.plist 格式：${fromRead.kind}）`);
  const mapper = makeStringMapper({ from, to: bundleId, extra: extraRenames });

  const transforms = new Map();
  const perEntry = {};
  const checks = [];

  {
    const res = patchInfoPlist(plistBuf, { from, to: bundleId, displayName });
    perEntry[plistEntry.name] = { mode: res.mode, source: fromRead.kind, changes: res.changes };
    transforms.set(plistEntry.name, {
      run: () => res.buf,
      changes: res.changes.map((c) => `${c.kind}: ${c.from} → ${c.to}`),
    });
  }
  {
    const e = zip.entries.find((x) => x.name === `${appDir}/META-INF/AIR/application.xml`);
    if (e) {
      const raw = readEntryData(zip, e);
      const airIdBefore = /<id>([^<]*)<\/id>/.exec(raw.toString('utf8'))?.[1] ?? null;
      if (airIdBefore !== from) {
        warnings.push(`AIR application.xml 的 <id>=${airIdBefore} 与 Info.plist 的 ${from} 不一致 —— 按 application.xml 自身的值改写，Air 运行时以 <id> 为准`);
      }
      const res = patchAirDescriptor(raw, { mapper, from: airIdBefore ?? from });
      perEntry[e.name] = { mode: res.mode, changes: res.changes };
      if (res.mode !== 'noop') transforms.set(e.name, { run: () => res.buf, changes: res.changes.filter((c) => c.kind === 'replace').map((c) => `${c.from} → ${c.to}`) });
      const text = (res.mode === 'noop' ? raw : res.buf).toString('utf8');
      checks.push({ name: 'air.appid', ok: new RegExp(`<id>${bundleId.replace(/\./g, '\\.')}</id>`).test(text), detail: /<id>([^<]*)<\/id>/.exec(text)?.[1] });
    } else {
      warnings.push('IPA 内没有 META-INF/AIR/application.xml');
    }
  }

  const result = rewriteZip(zip, { transforms });
  const outZip = parseZip(result.buf);

  const verify = [];
  {
    const e = outZip.entries.find((x) => x.name === plistEntry.name);
    const outBuf = readEntryData(outZip, e);
    const { id, kind } = readBundleIdFromPlist(outBuf);
    verify.push({ name: 'out.cfbundleidentifier', ok: id === bundleId, detail: `${id}（${kind}）` });
    // 二进制 plist 重新编码后必须还能被解出全部键（patchInfoPlist 已比对，这里再核一次大小合理性）
    if (fromRead.kind === 'bplist') {
      const okSize = outBuf.length > 32 && outBuf.subarray(outBuf.length - 32).length === 32;
      verify.push({ name: 'out.plist.trailer', ok: okSize, detail: `${plistBuf.length} → ${outBuf.length} 字节` });
    }
    if (displayName) {
      const shown = /<key>CFBundleDisplayName<\/key>\s*<string>([^<]*)<\/string>/.exec(outBuf.toString('utf8'))?.[1]
        ?? decodeBplist(outBuf).value?.CFBundleDisplayName;
      verify.push({ name: 'out.cfbundledisplayname', ok: shown === displayName, detail: shown });
    }
  }
  const residuals = scanResiduals(outZip, { skip: new Set([binaryPath]), from });
  verify.push({
    name: 'out.residual.identity',
    ok: residuals.totals.identity === 0,
    detail: `identity=${residuals.totals.identity} protected=${residuals.totals.protected} outOfScope(SKU)=${residuals.totals.outOfScope}（按 from=${from} 统计）`,
  });
  // 主二进制单独统计（只读报告，不改）
  {
    const e = zip.entries.find((x) => x.name === binaryPath);
    if (e) {
      const r = classifyResiduals(readEntryData(zip, e), { from });
      perEntry[binaryPath] = {
        mode: 'not-modified',
        identity: r.identity.length,
        protected: r.protected.length,
        outOfScope: r.outOfScope.length,
        sampleOutOfScope: [...new Set(r.outOfScope.map((x) => x.value))].slice(0, 12),
        note: '计费 SKU + 代码签名（CodeDirectory identifier / entitlements application-identifier）都在二进制内；重签时由 ldid/Sideloadly 重新生成，本工具不碰二进制',
      };
    }
  }

  const failed = [...checks, ...verify].filter((c) => !c.ok);
  if (failed.length) fail(`回读验证失败：\n  - ${failed.map((c) => `${c.name}: ${c.detail}`).join('\n  - ')}`);

  if (!dryRun && outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.buf);
  }

  return {
    ok: true,
    platform: 'ios',
    in: inPath,
    out: outPath ?? null,
    dryRun: Boolean(dryRun),
    from,
    to: bundleId,
    plistFormat: fromRead.kind,
    changedEntries: result.changed,
    plan: perEntry,
    checks: [...checks, ...verify],
    residuals,
    warnings: [
      ...warnings,
      'iOS 主二进制内的代码签名（CodeDirectory identifier + entitlements application-identifier）在重签时重新生成；本工具不碰二进制',
      '若该包使用推送 / keychain access group，重签后 entitlements 的 application-identifier 前缀可能仍指向旧 id——交 P10-A 处理',
      'AIR 存档（SharedObject）按 app id 隔离：改 Bundle ID 后旧存档不可见，这是预期行为',
    ],
    unsigned: true,
    resignCommands: [
      '# 越狱（iOS 15.8.3 / Dopamine rootless）：解包后对主二进制伪签名',
      `ldid -S ${binaryPath}`,
      '# 重新打包为 ipa 后安装；或用 Sideloadly（非越狱，自带重签 + bundle id 覆盖）',
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { extraRenames: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usageFail(`参数 ${a} 缺少值`);
      return v;
    };
    switch (a) {
      case '--in': args.inPath = next(); break;
      case '--out': args.outPath = next(); break;
      case '--rename-package': {
        // 主开关。值可省略：`--rename-package` 单独出现 ⇒ 用默认目标 cn.starpoint.a
        args.renamePackage = true;
        const peek = argv[i + 1];
        // 只要不是下一个旗标就吃掉它——**不在这里做合法性预判**，
        // 否则 `--rename-package 1bad` 会把非法名漏给外层，报成"未知参数 1bad"，
        // 而用户真正需要看到的是"包名不合法（需 ≥2 段…）：1bad"。
        if (peek !== undefined && !peek.startsWith('-')) {
          i++;
          args.packageName = peek;
        }
        break;
      }
      case '--no-rename-package': args.renamePackage = false; break;
      case '--package':
      case '--bundle-id':
      // P7 的 build-client.mjs 自己的旗标就叫 --rename-to，这里收作别名，
      // 让 P7 可以把自己的旗标原样透传，不必做名字映射。
      case '--rename-to': {
        // 显式给出目标名 = 明确的改名意图（与 --rename-package 等价）
        args.packageName = next();
        if (args.renamePackage === undefined) args.renamePackage = true;
        break;
      }
      case '--display-name': args.displayName = next(); break;
      case '--extra': {
        const [k, v] = next().split('=');
        if (!k || !v) fail('--extra 需要 old=new');
        args.extraRenames.push([k, v]);
        break;
      }
      case '--allow-unequal-length': args.allowUnequalLength = true; break;
      case '--keep-v1-signature': args.stripV1Signature = false; break;
      case '--keep-signing-block': args.stripSigningBlock = false; break;
      case '--dry-run': args.dryRun = true; break;
      case '--inspect': args.inspect = true; break;
      case '--json': args.json = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default: usageFail(`未知参数 ${a}`);
    }
  }
  return args;
}

const HELP = `rename-package.mjs — StarPoint CN 客户端共存（改包名 / Bundle ID）

  ⚠ 默认关：不指定 --rename-package / --package / --bundle-id 时，本工具
     **不改任何字节**，产物与输入逐字节一致（脚本内部断言，不一致即退出码 2）。

  --in <path>               输入 APK / IPA（只读）
  --out <path>              输出路径（省略 = 只分析不写）
  --rename-package [name]   主开关。省略 name ⇒ 用默认目标 ${DEFAULT_COEXIST_PACKAGE}
  --package <name>          Android 新包名（等价于 --rename-package <name>）
  --bundle-id <name>        iOS 新 Bundle ID（同上）
  --rename-to <name>        --package 的别名（P7 build-client.mjs 的旗标名）
  --display-name <name>     iOS 同时改 CFBundleDisplayName（默认不改；共存时便于区分图标）
  --extra <old=new>         额外精确串替换（可重复，用于改 URL scheme 等）
  --allow-unequal-length    放行不等长包名（放弃 dex 身份串改写，需真机验证）
  --keep-v1-signature       保留残留 v1 JAR 签名文件（默认剥离）
  --keep-signing-block      保留 APK Signing Block（默认剥离；输出反正必须重签名）
  --dry-run                 只验证不写文件
  --inspect                 只读侦察：打印实测身份 / 待改位置 / 残留分类
  --json                    以 JSON 打印结果
  -h, --help                本帮助

退出码：0 = 成功（含默认关的零改动透传、幂等 noop）
        1 = 业务失败（断言不通过 / 找不到身份串 / 输入非法）
        2 = 用法错误（未知参数、参数缺值、缺少 --in）
`;

/** 默认关（未要求改名）时的零改动路径：产物必须与输入逐字节一致，并自证。 */
export function passthroughCopy({ inPath, outPath } = {}) {
  if (!inPath) fail('缺少 --in');
  if (!existsSync(inPath)) fail(`输入不存在：${inPath}`);
  const buf = readFileSync(inPath);
  const digest = (b) => createHash('sha256').update(b).digest('hex');
  const sha256 = digest(buf);

  let wrote = false;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    const back = readFileSync(outPath);
    if (!back.equals(buf) || digest(back) !== sha256) {
      fail(`默认关（未指定 --rename-package）时产物与输入不逐字节一致：${outPath}`);
    }
    wrote = true;
  }

  const zip = parseZip(buf);
  const isIpa = zip.entries.some((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));

  return {
    ok: true,
    renamed: false,
    platform: isIpa ? 'ios' : 'android',
    in: inPath,
    out: outPath ?? null,
    bytes: buf.length,
    sha256,
    byteIdentical: true,
    writesFile: wrote,
    changedEntries: [],
    checks: [
      { name: 'default-off.no-rewrite', ok: true, detail: '未指定 --rename-package ⇒ 不进入任何改写路径' },
      { name: 'default-off.byte-identical', ok: true, detail: outPath ? `sha256 ${sha256}（输出=输入，已回读校验）` : `sha256 ${sha256}（未写文件）` },
    ],
    warnings: [],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    process.stdout.write(HELP);
    return { ok: true, help: true };
  }
  if (!args.inPath) usageFail('缺少 --in');

  if (args.inspect) {
    const report = inspect(args.inPath);
    printInspect(report, args.json);
    return report;
  }

  const emit = (report) => {
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printReport(report);
    return report;
  };

  // ---- 默认关：不做任何改写 ----
  if (args.renamePackage !== true) {
    return emit(passthroughCopy(args));
  }

  // 先判存在再读：否则 `--in <不存在的路径>` 会以裸 ENOENT 崩栈，
  // P7 拿到的是一句 Node 内部错误而不是可判断的契约文案。
  if (!existsSync(args.inPath)) fail(`输入不存在：${args.inPath}`);
  const buf = readFileSync(args.inPath);
  const zip = parseZip(buf);
  const isIpa = zip.entries.some((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
  const target = args.packageName ?? DEFAULT_COEXIST_PACKAGE;
  const report = isIpa
    ? await renameIpa({ ...args, bundleId: target, displayName: args.displayName ?? null })
    : await renameApk({ ...args, packageName: target });

  return emit(report);
}

function printInspect(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const L = [];
  L.push(`文件：${report.file}`);
  L.push(`平台：${report.platform}   条目数：${report.entries}   大小：${report.size}`);
  if (report.platform === 'ios') {
    L.push(`CFBundleIdentifier：${report.bundleId}（${report.bundleIdLength} 字符）`);
    L.push(`AIR <id>：${report.airId}`);
  } else {
    L.push(`package：${report.package}（${report.packageLength} 字符）`);
    L.push(`manifest 待改字符串：${report.manifestStringsToRename.map((x) => `[${x.i}] ${x.s}`).join(' | ')}`);
    L.push(`manifest 保护字符串：${report.manifestProtectedStrings.length} 条`);
    L.push(`arsc 包名块：${JSON.stringify(report.arscPackages)}`);
    L.push(`dex 相关字符串：${report.dexStrings.map((x) => `[${x.i}] ${x.s}`).join(' | ')}`);
  }
  L.push(`v1 签名条目：${report.v1SignatureEntries.join(', ') || '（无）'}`);
  L.push(`APK Signing Block：${report.signingBlock ? JSON.stringify(report.signingBlock.pairs) : '（无）'}`);
  L.push(`残留统计：identity=${report.residuals.totals.identity} protected=${report.residuals.totals.protected} outOfScope=${report.residuals.totals.outOfScope}`);
  for (const [k, v] of Object.entries(report.residuals.perEntry)) {
    L.push(`  ${k}: identity=${v.identity} protected=${v.protected} outOfScope=${v.outOfScope}`);
  }
  process.stdout.write(`${L.join('\n')}\n`);
}

function printReport(report) {
  const L = [];
  if (report.noop) {
    L.push(`[rename-package] 幂等：${report.platform} 已是 ${report.to}——零改动`);
    L.push(`  ${report.in}`);
    if (report.out) L.push(`  已写出（逐字节等于输入）：${report.out}`);
    else L.push('  （只分析，未写文件）');
    process.stdout.write(`${L.join('\n')}\n`);
    return;
  }
  if (report.renamed === false) {
    L.push(`[rename-package] 默认关（未指定 --rename-package）——零改动透传`);
    L.push(`  ${report.platform}  ${report.in}`);
    L.push(`  字节数：${report.bytes}   sha256：${report.sha256}`);
    if (report.out) L.push(`  已写出（逐字节等于输入，已回读校验）：${report.out}`);
    else L.push('  （未指定 --out，未写文件）');
    process.stdout.write(`${L.join('\n')}\n`);
    return;
  }
  L.push(`[rename-package] ${report.platform} ${report.from} → ${report.to}${report.equalLength === false ? '  ⚠ 不等长' : ''}`);
  for (const c of report.changedEntries) {
    L.push(`  改 ${c.name}: csize ${c.before.csize}→${c.after.csize} usize ${c.before.usize}→${c.after.usize}（${c.mode}）`);
  }
  L.push(`  残留：identity=${report.residuals.totals.identity} protected=${report.residuals.totals.protected} outOfScope=${report.residuals.totals.outOfScope}`);
  for (const d of report.degraded ?? []) L.push(`  ⚠ 降级：${d.name} — ${d.detail}`);
  for (const w of report.warnings) L.push(`  ⚠ ${w}`);
  if (report.out) L.push(`  已写出：${report.out}`);
  else L.push('  （只分析，未写文件）');
  L.push('  签名（输出必须重签）：');
  for (const c of report.resignCommands) L.push(`    ${c}`);
  process.stdout.write(`${L.join('\n')}\n`);
}

const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('client-patch/tools/rename-package.mjs');
if (isDirectRun) {
  main().catch((err) => {
    const code = err?.exitCode ?? 1;
    process.stderr.write(`[rename-package] FAIL(${code}): ${err.message}\n`);
    if (code === 2) process.stderr.write('[rename-package] 用法：node client-patch/tools/rename-package.mjs --help\n');
    if (process.env.P12_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exitCode = code;
  });
}
