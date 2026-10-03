#!/usr/bin/env node
// make-fake-dylib.mjs —— 造一个**结构合法但没有代码**的 64 位 Mach-O dylib。
//
// 用途只有一个：在没有 macOS/clang 的机器上验证 inject-dylib.mjs 的全链路
// （插 LC_LOAD_DYLIB、ncmds/sizeofcmds 递增、文件长度不变、复核读回）。
// 它**不能**在设备上跑 —— 没有 __TEXT 代码、没有签名、没有导出符号。
//
// 用法: node make-fake-dylib.mjs <输出路径> [install-name]
import fs from "node:fs";

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_SUBTYPE_ARM64_ALL = 0;
const MH_DYLIB = 0x6;
const MH_NOUNDEFS = 0x1;
const MH_DYLDLINK = 0x4;
const MH_TWOLEVEL = 0x80;
const MH_PIE = 0x200000;
const LC_SEGMENT_64 = 0x19;
const LC_ID_DYLIB = 0xd;
const LC_BUILD_VERSION = 0x32;
const LC_CODE_SIGNATURE = 0x1d;
const PLATFORM_IOS = 2;

const SEG_ALIGN = 0x4000;

function align(v, a) { return (v + a - 1) & ~(a - 1); }

function segment(name, vmaddr, vmsize, fileoff, filesize, maxprot, initprot) {
  const b = Buffer.alloc(72);
  b.writeUInt32LE(LC_SEGMENT_64, 0);
  b.writeUInt32LE(72, 4);
  b.write(name, 8, 16, "ascii");
  b.writeBigUInt64LE(BigInt(vmaddr), 24);
  b.writeBigUInt64LE(BigInt(vmsize), 32);
  b.writeBigUInt64LE(BigInt(fileoff), 40);
  b.writeBigUInt64LE(BigInt(filesize), 48);
  b.writeUInt32LE(maxprot, 56);
  b.writeUInt32LE(initprot, 60);
  b.writeUInt32LE(0, 64);          // nsects
  b.writeUInt32LE(0, 68);          // flags
  return b;
}

function idDylib(installName) {
  const raw = Buffer.from(installName, "utf8");
  const size = (8 + 4 + 4 + 4 + 4 + raw.length + 1 + 7) & ~7;
  const b = Buffer.alloc(size);
  b.writeUInt32LE(LC_ID_DYLIB, 0);
  b.writeUInt32LE(size, 4);
  b.writeUInt32LE(24, 8);
  b.writeUInt32LE(0, 12);
  b.writeUInt32LE(0x00010000, 16);
  b.writeUInt32LE(0x00010000, 20);
  raw.copy(b, 24);
  b[24 + raw.length] = 0;
  return b;
}

function buildVersion() {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(LC_BUILD_VERSION, 0);
  b.writeUInt32LE(24, 4);
  b.writeUInt32LE(PLATFORM_IOS, 8);
  b.writeUInt32LE(0x000f0000, 12);   // minos 15.0
  b.writeUInt32LE(0x00120000, 16);   // sdk 18.0
  b.writeUInt32LE(0, 20);            // ntools
  return b;
}

function main() {
  const outPath = process.argv[2];
  if (!outPath) { console.error("用法: node make-fake-dylib.mjs <输出路径> [install-name]"); process.exit(1); }
  const installName = process.argv[3] || "@rpath/AMAutoClick.dylib";

  const cmds = [
    segment("__TEXT", 0, 0x4000, 0, 0x4000, 5, 5),
    segment("__DATA_CONST", 0x4000, 0x4000, 0x4000, 0x4000, 3, 3),
    segment("__LINKEDIT", 0x8000, 0x4000, 0x8000, 0x4000, 1, 1),
    idDylib(installName),
    buildVersion()
  ];
  const sizeofcmds0 = cmds.reduce((s, c) => s + c.length, 0);
  const headerEnd = 32 + sizeofcmds0;
  const textEnd = align(headerEnd, SEG_ALIGN);

  // __TEXT 的第一页要留出空闲（好让 inject 工具往主二进制里插命令 —— 这里只是形式一致）
  const text = Buffer.alloc(textEnd);
  let p = 32;
  for (const c of cmds) { c.copy(text, p); p += c.length; }

  const fileSize = 0xC000;
  const total = Buffer.alloc(fileSize);
  text.copy(total, 0);

  // 头部字段
  total.writeUInt32LE(MH_MAGIC_64, 0);
  total.writeUInt32LE(CPU_TYPE_ARM64, 4);
  total.writeUInt32LE(CPU_SUBTYPE_ARM64_ALL, 8);
  total.writeUInt32LE(MH_DYLIB, 12);
  total.writeUInt32LE(cmds.length, 16);
  total.writeUInt32LE(sizeofcmds0, 20);
  total.writeUInt32LE(MH_NOUNDEFS | MH_DYLDLINK | MH_TWOLEVEL | MH_PIE, 24);
  total.writeUInt32LE(0, 28);

  fs.writeFileSync(outPath, total);
  console.log(`写了 ${outPath}（${total.length} B，ncmds=${cmds.length}，sizeofcmds=${sizeofcmds0}）`);
  console.log(`  注意：**这不是可运行的 dylib**，只用于验证注入器的头部算术。`);
}

main();
