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

/** 官方安装身份（Android package 与 iOS CFBundleIdentifier 同值）。 */
export const OFFICIAL_PACKAGE = 'com.leiting.wf';
/** 等长（14 字符）自有包名候选；默认值见报告 §新依赖理由/§做了什么。 */
export const DEFAULT_COEXIST_PACKAGE = 'com.starpoints';
/**
 * 等长替代候选（全部 14 字符，任选其一都满足全部安全性质）：
 *   com.star.point / com.spcn.games / starpoint.wfcn
 * 派工令里的 `com.starpoint.wfcn` 是 18 字符，只能用
 * --allow-unequal-length 走降级路径（放弃 dex 身份串改写）。
 */
export const EQUAL_LENGTH_CANDIDATES = ['com.starpoints', 'com.star.point', 'com.spcn.games', 'starpoint.wfcn'];

/** 已编译类型的 FQN / 计费 SKU：**逐字保留**，它们不是安装身份。 */
const PROTECTED_RE =
  /air\.com\.leiting\.wf\.AppEntry|com\.leiting\.sdk\.[A-Za-z0-9_$]+|com\.leiting\.wf\.(?:stonepack_[A-Za-z0-9_]+|weekly_set_[0-9]+)/g;

/** 唯一被改的 AIR 模板串（URI authority，不是类名）——必须排在 `com.leiting.wf` 之前替换。 */
const AIR_FILEPROVIDER = 'air.com.leiting.wf.fileprovider';

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
  constructor(message) {
    super(message);
    this.name = 'RenameError';
  }
}

function fail(message) {
  throw new RenameError(message);
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

/**
 * 构造"安装身份串 → 新值"的映射函数。**长的先替换**，并整体跳过保护串。
 * 返回 null 表示该串不需要改。
 */
export function makeStringMapper({ from = OFFICIAL_PACKAGE, to, extra = [] }) {
  const rules = [
    [AIR_FILEPROVIDER, `${to}.fileprovider`],
    ...extra,
    [from, to],
  ];
  return (s) => {
    if (typeof s !== 'string' || s.length === 0) return null;
    if (PROTECTED_RE.test(s)) {
      PROTECTED_RE.lastIndex = 0;
      // 保护串整体跳过：AppEntry 类 FQN / leiting SDK FQN / 计费 SKU
      return null;
    }
    PROTECTED_RE.lastIndex = 0;
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

export function patchAirDescriptor(buf, { mapper }) {
  const text = buf.toString('utf8');
  if (!text.startsWith('<?xml')) fail('AIR application.xml 不是明文 XML？');
  const changes = [];
  const seen = new Set();
  const out = text.replace(
    /air\.com\.leiting\.wf\.AppEntry|com\.leiting\.sdk\.[A-Za-z0-9_$]+|air\.com\.leiting\.wf\.fileprovider|com\.leiting\.wf(?:\.(?:stonepack_[A-Za-z0-9_]+|weekly_set_[0-9]+))?/g,
    (m) => {
      if (PROTECTED_RE.test(m)) {
        PROTECTED_RE.lastIndex = 0;
        if (!seen.has(`keep:${m}`)) {
          seen.add(`keep:${m}`);
          changes.push({ kind: 'keep', value: m, reason: '受保护（类 FQN / SDK FQN / 计费 SKU）' });
        }
        return m;
      }
      PROTECTED_RE.lastIndex = 0;
      const next = mapper(m);
      const value = next === null ? m : next;
      const key = `set:${m}->${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        changes.push({ kind: next === null ? 'keep' : 'replace', from: m, to: value });
      }
      return value;
    },
  );
  if (out === text) return { buf, changes: [], mode: 'noop' };
  return { buf: Buffer.from(out, 'utf8'), changes, mode: 'text' };
}

/** iOS Info.plist（XML 明文）。二进制 plist 只支持等长原地改。 */
export function patchInfoPlist(buf, { from, to }) {
  const head = buf.subarray(0, 8).toString('latin1');
  if (head.startsWith('bplist00')) {
    if (Buffer.byteLength(from) !== Buffer.byteLength(to)) {
      fail('Info.plist 是二进制 plist，只支持等字节长改名（本包是 XML plist，不应走到这里）');
    }
    const out = Buffer.from(buf);
    let n = 0;
    let idx = -1;
    while ((idx = out.indexOf(from, idx + 1)) >= 0) {
      if (out[idx - 1] !== 0x0f) continue; // ASCII 串长度前缀（≤14 用 1 字节 0x0f）
      Buffer.from(to).copy(out, idx);
      n++;
    }
    if (n === 0) fail('二进制 plist 未找到旧 Bundle ID');
    return { buf: out, changes: n, mode: 'bplist-inplace' };
  }
  const text = buf.toString('utf8');
  const re = /(<key>CFBundleIdentifier<\/key>\s*<string>)([^<]*)(<\/string>)/;
  const m = re.exec(text);
  if (!m) fail('Info.plist 未找到 CFBundleIdentifier');
  const old = m[2];
  if (old !== from) fail(`Info.plist CFBundleIdentifier 期望 ${from}，实得 ${old}`);
  let out = text.replace(re, (_all, a, _b, c) => `${a}${to}${c}`);
  // CFBundleURLName 等其它同值处一并改（Info.plist 内旧值出现 2 次）
  out = out.split(from).join(to);
  return { buf: Buffer.from(out, 'utf8'), changes: [{ kind: 'cfbundleidentifier', from: old, to }], mode: 'plist' };
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

/** 把一个条目解压后的内容按类别统计旧包名出现次数。 */
export function classifyResiduals(data) {
  const text = data.toString('latin1');
  const out = { identity: [], protected: [], outOfScope: [] };
  RESIDUAL_RE.lastIndex = 0;
  let m;
  while ((m = RESIDUAL_RE.exec(text)) !== null) {
    const v = m[0];
    if (v === OFFICIAL_PACKAGE) out.identity.push({ offset: m.index, value: v });
    else if (v.startsWith('com.leiting.wf.')) out.outOfScope.push({ offset: m.index, value: v });
    else out.protected.push({ offset: m.index, value: v });
  }
  return out;
}

export function scanResiduals(zip, { skip = new Set() } = {}) {
  const per = {};
  const totals = { identity: 0, protected: 0, outOfScope: 0 };
  for (const e of zip.entries) {
    if (skip.has(e.name)) continue;
    if (e.usize > 64 * 1024 * 1024) continue;
    let data;
    try {
      data = readEntryData(zip, e);
    } catch {
      continue;
    }
    const r = classifyResiduals(data);
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
    const plist = readEntryData(zip, plistEntry).toString('utf8');
    report.bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
    report.bundleIdLength = report.bundleId?.length ?? null;
    const appXml = zip.entries.find((e) => /^Payload\/[^/]+\.app\/META-INF\/AIR\/application\.xml$/.test(e.name));
    if (appXml) {
      const ax = readEntryData(zip, appXml).toString('utf8');
      report.airId = /<id>([^<]*)<\/id>/.exec(ax)?.[1] ?? null;
    }
  } else {
    const ax = zip.entries.find((e) => e.name === 'AndroidManifest.xml');
    const parsed = readAxmlPackage(readEntryData(zip, ax));
    report.package = parsed.packageName;
    report.packageLength = parsed.packageName.length;
    report.manifestStringsToRename = parsed.parsed.pool.strings
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s.includes(OFFICIAL_PACKAGE) && !/air\.com\.leiting\.wf\.AppEntry|com\.leiting\.sdk\./.test(s));
    report.manifestProtectedStrings = parsed.parsed.pool.strings.filter((s) => /air\.com\.leiting\.wf\.AppEntry|com\.leiting\.sdk\./.test(s));
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
  report.residuals = scanResiduals(zip);
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
        perEntry[e.name] = { mode: 'skipped-unequal-length', hasFrom, hasTo };
        checks.push({ name: 'dex.identity-string', ok: false, detail: `不等长 ⇒ 跳过改写（hasFrom=${hasFrom} hasTo=${hasTo}，残留 1 处）` });
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
      checks.push({ name: 'air.appentry-preserved', ok: text.includes('air.com.leiting.wf.AppEntry'), detail: 'air.com.leiting.wf.AppEntry' });
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

  const residuals = scanResiduals(outZip);
  verify.push({
    name: 'out.residual.identity',
    ok: residuals.totals.identity === 0,
    detail: `identity=${residuals.totals.identity} protected=${residuals.totals.protected} outOfScope(SKU)=${residuals.totals.outOfScope}`,
  });

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

  const plistBuf = readEntryData(zip, plistEntry);
  const plistText = plistBuf.toString('utf8');
  const from = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plistText)?.[1];
  if (!from) fail('Info.plist 未找到 CFBundleIdentifier');
  const mapper = makeStringMapper({ from, to: bundleId, extra: extraRenames });

  const transforms = new Map();
  const perEntry = {};
  const checks = [];

  {
    const res = patchInfoPlist(plistBuf, { from, to: bundleId });
    perEntry[plistEntry.name] = { mode: res.mode, changes: res.changes };
    transforms.set(plistEntry.name, { run: () => res.buf, changes: [`CFBundleIdentifier: ${from} → ${bundleId}`] });
  }
  {
    const e = zip.entries.find((x) => x.name === `${appDir}/META-INF/AIR/application.xml`);
    if (e) {
      const res = patchAirDescriptor(readEntryData(zip, e), { mapper });
      perEntry[e.name] = { mode: res.mode, changes: res.changes };
      if (res.mode !== 'noop') transforms.set(e.name, { run: () => res.buf, changes: res.changes.filter((c) => c.kind === 'replace').map((c) => `${c.from} → ${c.to}`) });
      const text = (res.mode === 'noop' ? readEntryData(zip, e) : res.buf).toString('utf8');
      checks.push({ name: 'air.appid', ok: new RegExp(`<id>${bundleId.replace(/\./g, '\\.')}</id>`).test(text), detail: /<id>([^<]*)<\/id>/.exec(text)?.[1] });
    }
  }

  const result = rewriteZip(zip, { transforms });
  const outZip = parseZip(result.buf);

  const verify = [];
  {
    const e = outZip.entries.find((x) => x.name === plistEntry.name);
    const text = readEntryData(outZip, e).toString('utf8');
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
    verify.push({ name: 'out.cfbundleidentifier', ok: id === bundleId, detail: id });
  }
  const residuals = scanResiduals(outZip, { skip: new Set([binaryPath]) });
  verify.push({
    name: 'out.residual.identity',
    ok: residuals.totals.identity === 0,
    detail: `identity=${residuals.totals.identity} protected=${residuals.totals.protected} outOfScope(SKU)=${residuals.totals.outOfScope}`,
  });
  // 主二进制单独统计（只读报告，不改）
  {
    const e = zip.entries.find((x) => x.name === binaryPath);
    if (e) {
      const r = classifyResiduals(readEntryData(zip, e));
      perEntry[binaryPath] = {
        mode: 'not-modified',
        identity: r.identity.length,
        protected: r.protected.length,
        outOfScope: r.outOfScope.length,
        note: '9 处计费 SKU + 5 处在代码签名（CodeDirectory identifier / entitlements application-identifier），重签时由 ldid/Sideloadly 重新生成',
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
    changedEntries: result.changed,
    plan: perEntry,
    checks: [...checks, ...verify],
    residuals,
    warnings: [
      'iOS 主二进制内的代码签名（CodeDirectory identifier + entitlements application-identifier）在重签时重新生成；本工具不碰二进制',
      '若该包使用推送 / keychain access group，重签后 entitlements 的 application-identifier 前缀可能仍指向旧 id——交 P10-A 处理',
    ],
    unsigignedNote: true,
    resignCommands: [
      `# 越狱（iOS 15.8.3 / Dopamine rootless）：解包后对主二进制伪签名`,
      `ldid -S ${binaryPath}`,
      `# 重新打包为 ipa 后安装；或用 Sideloadly（非越狱，自带重签 + bundle id 覆盖）`,
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
      if (v === undefined) fail(`参数 ${a} 缺少值`);
      return v;
    };
    switch (a) {
      case '--in': args.inPath = next(); break;
      case '--out': args.outPath = next(); break;
      case '--package':
      case '--bundle-id': args.packageName = next(); break;
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
      default: fail(`未知参数 ${a}`);
    }
  }
  return args;
}

const HELP = `rename-package.mjs — StarPoint CN 客户端共存（改包名 / Bundle ID）

  --in <path>               输入 APK / IPA（只读）
  --out <path>              输出路径（省略 = 只分析不写）
  --package <name>          Android 新包名（等长 14 字符，默认 ${DEFAULT_COEXIST_PACKAGE}）
  --bundle-id <name>        iOS 新 Bundle ID（同上；--package 亦可）
  --extra <old=new>         额外精确串替换（可重复，用于改 URL scheme 等）
  --allow-unequal-length    放行不等长包名（放弃 dex 身份串改写，需真机验证）
  --keep-v1-signature       保留残留 v1 JAR 签名文件（默认剥离）
  --keep-signing-block      保留 APK Signing Block（默认剥离；输出反正必须重签名）
  --dry-run                 只验证不写文件
  --inspect                 只读侦察：打印官方包名 / 待改位置 / 残留分类
  --json                    以 JSON 打印结果
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    process.stdout.write(HELP);
    return { ok: true, help: true };
  }
  if (!args.inPath) fail('缺少 --in');

  if (args.inspect) {
    const report = inspect(args.inPath);
    printInspect(report, args.json);
    return report;
  }

  const buf = readFileSync(args.inPath);
  const zip = parseZip(buf);
  const isIpa = zip.entries.some((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.name));
  const report = isIpa
    ? await renameIpa({ ...args, bundleId: args.packageName ?? DEFAULT_COEXIST_PACKAGE })
    : await renameApk(args);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
  return report;
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
  L.push(`[rename-package] ${report.platform} ${report.from} → ${report.to}${report.equalLength === false ? '  ⚠ 不等长' : ''}`);
  for (const c of report.changedEntries) {
    L.push(`  改 ${c.name}: csize ${c.before.csize}→${c.after.csize} usize ${c.before.usize}→${c.after.usize}（${c.mode}）`);
  }
  L.push(`  残留：identity=${report.residuals.totals.identity} protected=${report.residuals.totals.protected} outOfScope=${report.residuals.totals.outOfScope}`);
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
    process.stderr.write(`[rename-package] FAIL: ${err.message}\n`);
    if (process.env.P12_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
}
