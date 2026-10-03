#!/usr/bin/env node
// inject-dylib.mjs —— 往已解包的 iOS .app 里注入一个 dylib
//
// 做三件事，缺一不可：
//   ① 把 dylib 复制进 <App>.app/Frameworks/
//   ② 在**主二进制的 Mach-O 头**里插一条 LC_LOAD_DYLIB，指向
//      @executable_path/Frameworks/<名字>
//   ③ 断言：ncmds +1、sizeofcmds 只增加新命令的长度、**文件长度一个字节都没变**
//
// 为什么第 ③ 条是硬断言而不是"顺手打个日志"：
//   dyld 与 AIR 的 AOT 加载器都按偏移读文件。插命令只能占用 header 页里的
//   空闲字节（命令区末尾到第一页边界之间）。一旦越界就得把整个文件往后挪，
//   那样 __TEXT 之后所有段的 fileoff 都得改 —— 这正是 client-patch 那边
//   反复踩过的"启动黑屏"来源（见 client-patch/build/lib/ios-macho.mjs 的文件头）。
//   所以这里宁可**直接失败**，也不做移位。
//
// 用法：
//   node inject-dylib.mjs --app=<解包后的 .app 目录> [--dylib=<路径>] [--name=AMAutoClick]
//   node inject-dylib.mjs --app=... --check          # 只检查，不写盘
//
// 之后必须做的事（本脚本不代劳，因为签名要看设备/证书）：
//   · 重新签名整个 .app（ldid -S 或 Sideloadly/AltStore 会自动做）
//   · 若 IPA 是加密的（cryptid != 0）则**无法**注入 —— 主二进制解不开，
//     改了头也没用（见下面 cryptid 判定）。

import fs from "node:fs";
import path from "node:path";

const MH_MAGIC_64 = 0xfeedfacf;
const LC_REQ_DYLD = 0x80000000;
const LC_SEGMENT_64 = 0x19;
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x18 | LC_REQ_DYLD;
const LC_REEXPORT_DYLIB = 0x1f | LC_REQ_DYLD;
const LC_ID_DYLIB = 0xd;
const LC_ENCRYPTION_64 = 0x2c;
const LC_CODE_SIGNATURE = 0x1d;

const DYLIB_CMDS = new Set([LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_ID_DYLIB]);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { app: "", dylib: "", name: "AMAutoClick", check: false, force: false };
  for (const a of argv) {
    if (a.startsWith("--app=")) out.app = a.slice(6);
    else if (a.startsWith("--dylib=")) out.dylib = a.slice(8);
    else if (a.startsWith("--name=")) out.name = a.slice(7);
    else if (a === "--check") out.check = true;
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法: node inject-dylib.mjs --app=<.app 目录> [--dylib=<路径>] [--name=AMAutoClick] [--check] [--force]");
      process.exit(0);
    } else fail(`不认识的参数：${a}`);
  }
  if (!out.app) fail("必须给 --app=<解包后的 .app 目录>");
  return out;
}

/** 读 Mach-O 头与命令表。任何结构异常直接抛错 —— 不在可疑文件上打补丁。 */
function parseMachO(buf) {
  if (buf.length < 32) throw new Error(`文件太小：${buf.length} B`);
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC_64) throw new Error(`不是 64 位 Mach-O：magic=0x${magic.toString(16)}`);
  const cputype = buf.readUInt32LE(4);
  const filetype = buf.readUInt32LE(12);
  const ncmds = buf.readUInt32LE(16);
  const sizeofcmds = buf.readUInt32LE(20);
  const commandsEnd = 32 + sizeofcmds;
  if (commandsEnd > buf.length) throw new Error(`命令区越界：32+${sizeofcmds} > ${buf.length}`);

  const commands = [];
  let cur = 32;
  for (let i = 0; i < ncmds; i += 1) {
    if (cur + 8 > commandsEnd) throw new Error(`命令 #${i} 越界 @0x${cur.toString(16)}`);
    const cmd = buf.readUInt32LE(cur);
    const cmdsize = buf.readUInt32LE(cur + 4);
    if (cmdsize < 8 || cur + cmdsize > commandsEnd) throw new Error(`命令 #${i} 尺寸非法：${cmdsize}`);
    const entry = { cmd, cmdsize, offset: cur };
    if (cmd === LC_SEGMENT_64) {
      entry.segname = buf.toString("ascii", cur + 8, cur + 24).replace(/\0.*$/, "");
      entry.fileoff = Number(buf.readBigUInt64LE(cur + 40));
      entry.filesize = Number(buf.readBigUInt64LE(cur + 48));
    } else if (DYLIB_CMDS.has(cmd)) {
      const nameOff = buf.readUInt32LE(cur + 8);
      const start = cur + nameOff;
      let end = start;
      while (end < cur + cmdsize && buf[end] !== 0) end += 1;
      entry.name = buf.toString("utf8", start, end);
    }
    commands.push(entry);
    cur += cmdsize;
  }

  const find = (c) => commands.find((e) => e.cmd === c);
  const enc = find(LC_ENCRYPTION_64);
  const sig = find(LC_CODE_SIGNATURE);
  const firstSeg = commands.find((e) => e.cmd === LC_SEGMENT_64 && e.filesize > 0);

  return {
    cputype, filetype, ncmds, sizeofcmds, commandsEnd, commands,
    encryption: enc
      ? { cryptid: buf.readUInt32LE(enc.offset + 16), cryptoff: buf.readUInt32LE(enc.offset + 8) }
      : null,
    codeSignature: sig
      ? { dataoff: buf.readUInt32LE(sig.offset + 8), datasize: buf.readUInt32LE(sig.offset + 12) }
      : null,
    firstSegFileStart: firstSeg ? firstSeg.fileoff : 0,
  };
}

/** 从 Info.plist（XML 或 binary plist）里取 CFBundleExecutable。取不到返回 ""。 */
function readBundleExecutable(plistPath) {
  const raw = fs.readFileSync(plistPath);

  // XML plist：直接正则
  const xmlHead = raw.toString("utf8", 0, Math.min(raw.length, 64));
  if (xmlHead.includes("<?xml")) {
    const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(raw.toString("utf8"));
    return m ? m[1] : "";
  }

  // binary plist（bplist00）：走一遍 key 引用表，只为了拿一个字符串。
  // 写这么一段而不用 plutil，是因为这个工具要在 Windows 上跑。
  if (raw.toString("latin1", 0, 8) === "bplist00") {
    const trailer = raw.length - 32;
    const offsetIntSize = raw[trailer + 6];
    const objectRefSize = raw[trailer + 7];
    const numObjects = Number(raw.readBigUInt64BE(trailer + 8));
    const topObject = Number(raw.readBigUInt64BE(trailer + 16));
    const offsetTableOff = Number(raw.readBigUInt64BE(trailer + 24));

    const readSized = (off, size) => {
      let v = 0;
      for (let i = 0; i < size; i += 1) v = v * 256 + raw[off + i];
      return v;
    };
    const objOffset = (idx) => readSized(offsetTableOff + idx * offsetIntSize, offsetIntSize);

    /** 读一个对象，返回 {type, value, next} —— 只实现字典/数组/字符串/整数/布尔。 */
    const readObject = (off) => {
      const marker = raw[off];
      const type = marker >> 4;
      let len = marker & 0x0f;
      let p = off + 1;
      if (len === 0x0f) {
        const intMarker = raw[p];
        const intLen = 1 << (intMarker & 0x0f);
        len = readSized(p + 1, intLen);
        p += 1 + intLen;
      }
      if (type === 0x0d) {                        // dict
        const keys = [];
        const vals = [];
        for (let i = 0; i < len; i += 1) keys.push(readSized(p + i * objectRefSize, objectRefSize));
        for (let i = 0; i < len; i += 1) vals.push(readSized(p + len * objectRefSize + i * objectRefSize, objectRefSize));
        return { type: "dict", keys, vals, next: p + len * objectRefSize * 2 };
      }
      if (type === 0x0a) {                        // array
        const items = [];
        for (let i = 0; i < len; i += 1) items.push(readSized(p + i * objectRefSize, objectRefSize));
        return { type: "array", items, next: p + len * objectRefSize };
      }
      if (type === 0x05) {                        // ASCII 字符串
        return { type: "string", value: raw.toString("ascii", p, p + len), next: p + len };
      }
      if (type === 0x06) {                        // UTF-16BE 字符串
        const chars = [];
        for (let i = 0; i < len; i += 1) chars.push(raw.readUInt16BE(p + i * 2));
        return { type: "string", value: String.fromCharCode(...chars), next: p + len * 2 };
      }
      return { type: "other", next: p };
    };

    const root = readObject(objOffset(topObject));
    if (root.type !== "dict") return "";
    for (let i = 0; i < root.keys.length; i += 1) {
      const k = readObject(objOffset(root.keys[i]));
      if (k.type === "string" && k.value === "CFBundleExecutable") {
        const v = readObject(objOffset(root.vals[i]));
        return v.type === "string" ? v.value : "";
      }
    }
    return "";
  }
  return "";
}

function buildLoadDylib(installName) {
  const raw = Buffer.from(installName, "utf8");
  const nameLen = raw.length + 1;              // 含结尾 NUL
  const cmdsize = (8 + 4 + 4 + 4 + 4 + nameLen + 7) & ~7;   // 8 字节对齐
  const b = Buffer.alloc(cmdsize);
  b.writeUInt32LE(LC_LOAD_DYLIB, 0);
  b.writeUInt32LE(cmdsize, 4);
  b.writeUInt32LE(24, 8);                       // name offset（相对命令起点）
  b.writeUInt32LE(0, 12);                       // timestamp
  b.writeUInt32LE(0x00010000, 16);              // current_version 1.0.0
  b.writeUInt32LE(0x00010000, 20);              // compatibility_version 1.0.0
  raw.copy(b, 24);
  b[24 + raw.length] = 0;
  return { bytes: b, size: cmdsize };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(args.app);
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) fail(`不是一个目录：${appDir}`);

  // 主二进制 = <app 名>.app/<app 名>，或 Info.plist 里的 CFBundleExecutable。
  // 以 Info.plist 为准（重签过的包常把 .app 目录改名，而可执行文件名不动）。
  const appBase = path.basename(appDir, ".app");
  let exeName = appBase;
  const plistPath = path.join(appDir, "Info.plist");
  if (fs.existsSync(plistPath)) {
    const fromPlist = readBundleExecutable(plistPath);
    if (fromPlist) exeName = fromPlist;
    else console.log(`⚠️ 没能从 Info.plist 读出 CFBundleExecutable，按目录名猜：${exeName}`);
  }
  const exePath = path.join(appDir, exeName);
  if (!fs.existsSync(exePath)) fail(`找不到主二进制：${exePath}（Info.plist 里 CFBundleExecutable=${exeName}）`);

  const installName = `@executable_path/Frameworks/${args.name}.dylib`;
  const buf = fs.readFileSync(exePath);
  const origLen = buf.length;

  let hdr;
  try {
    hdr = parseMachO(buf);
  } catch (e) {
    fail(`解析 ${exeName} 失败：${e.message}`);
  }

  console.log(`主二进制   : ${exePath}`);
  console.log(`  大小     : ${origLen} B`);
  console.log(`  ncmds    : ${hdr.ncmds}  sizeofcmds: ${hdr.sizeofcmds}`);
  console.log(`  命令区末尾: 0x${hdr.commandsEnd.toString(16)}`);

  if (hdr.encryption && hdr.encryption.cryptid !== 0) {
    fail(`主二进制是**加密**的（cryptid=${hdr.encryption.cryptid}）。\n` +
         `  必须先解密（越狱设备上用 dumpdecrypted / frida-ios-dump 之类）才能注入，` +
         `  否则改完头部的文件在设备上会被解密器拒绝。`);
  }
  console.log(`  加密状态 : ${hdr.encryption ? `LC_ENCRYPTION_INFO_64 cryptid=${hdr.encryption.cryptid}（已解密）` : "无 LC_ENCRYPTION_INFO_64"}`);

  // 幂等：已经注入过就不重复插
  const already = hdr.commands.find((e) => DYLIB_CMDS.has(e.cmd) && e.name === installName);
  if (already) {
    console.log(`\n✓ 已经注入过了（命令 #${hdr.commands.indexOf(already)} -> ${installName}），不改动。`);
    const dst = path.join(appDir, "Frameworks", `${args.name}.dylib`);
    console.log(fs.existsSync(dst) ? `  Frameworks/${args.name}.dylib 也在。` : `  ⚠️ 但 Frameworks/${args.name}.dylib 不存在。`);
    process.exit(0);
  }

  const { bytes: lc, size: lcSize } = buildLoadDylib(installName);

  // ★ 能放下的条件：命令区 + 新命令 不越过第一页边界。
  //   第一页里 [命令区末尾, 第一页边界) 是空闲区；某些工具（如 DumpDecrypter）
  //   会往里塞东西，所以还要确认那段是零。
  const pageEnd = 0x4000;
  const need = hdr.commandsEnd + lcSize;
  if (need > pageEnd) {
    fail(`放不下：命令区末尾 0x${hdr.commandsEnd.toString(16)} + 新命令 ${lcSize} B = 0x${need.toString(16)} ` +
         `越过了第一页边界 0x${pageEnd.toString(16)}。\n` +
         `  这条路的兜底做法是"把整个文件往后挪、改所有段的 fileoff"，` +
         `  但那会动到 __TEXT 之后的每一个偏移，AIR 的 AOT 加载器对这种事极度敏感。` +
         `  本工具刻意不实现它 —— 请先确认这个二进制是不是被人加了段。`);
  }
  for (let i = hdr.commandsEnd; i < need; i += 1) {
    if (buf[i] !== 0) fail(`要用的空闲字节 @0x${i.toString(16)} 不是 0（值 0x${buf[i].toString(16)}）—— 那里有别的工具留下的数据，不能覆盖。`);
  }
  console.log(`\n空闲区     : 0x${hdr.commandsEnd.toString(16)}..0x${pageEnd.toString(16)}（${pageEnd - hdr.commandsEnd} B），新命令 ${lcSize} B`);

  if (args.check) {
    console.log(`\n✓ --check：一切就绪，可以注入 ${installName}（未写盘）。`);
    process.exit(0);
  }

  // ── 写盘 ───────────────────────────────────────────────────────────────────
  const out = Buffer.from(buf);          // 整份拷贝，写坏了也不会留下半个文件
  lc.copy(out, hdr.commandsEnd);
  out.writeUInt32LE(hdr.ncmds + 1, 16);
  out.writeUInt32LE(hdr.sizeofcmds + lcSize, 20);

  // 断言：只动了头部
  if (out.length !== origLen) fail(`内部错误：长度变了（${origLen} -> ${out.length}）`);
  let firstDiff = -1;
  for (let i = 0; i < origLen; i += 1) {
    if (out[i] !== buf[i]) { firstDiff = i; break; }
  }
  if (firstDiff >= pageEnd) {
    fail(`内部错误：改动越过了第一页（第一个差异 @0x${firstDiff.toString(16)}）`);
  }

  // ★ 先备齐 dylib 再动主二进制：把"参数不全"这种失败留在写盘之前。
  //   （第一版把这段放在备份之后，结果缺 --dylib 时已经留下了一个 .orig 备份
  //     和一个空的 Frameworks/ 目录 —— 失败路径也不该有副作用。）
  const frameworks = path.join(appDir, "Frameworks");
  const dstDylib = path.join(frameworks, `${args.name}.dylib`);
  let dylibBytes = 0;
  if (args.dylib) {
    const src = path.resolve(args.dylib);
    if (!fs.existsSync(src)) fail(`找不到 dylib：${src}`);
    dylibBytes = fs.statSync(src).size;
    fs.mkdirSync(frameworks, { recursive: true });
    fs.copyFileSync(src, dstDylib);
    console.log(`已复制 dylib -> Frameworks/${args.name}.dylib（${dylibBytes} B）`);
  } else if (fs.existsSync(dstDylib)) {
    dylibBytes = fs.statSync(dstDylib).size;
    console.log(`沿用已存在的 Frameworks/${args.name}.dylib（${dylibBytes} B）`);
  } else {
    fail(`没有给 --dylib，且 Frameworks/${args.name}.dylib 还不存在。\n` +
         `  （顺序上这一步在改主二进制之前 —— 头一旦改过，原签名就失效了，` +
         `   半途失败会留下一个既没签名也没 dylib 的包。）`);
  }

  const backup = `${exePath}.orig`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(exePath, backup);
    console.log(`已备份原文件 -> ${path.basename(backup)}`);
  } else if (!args.force) {
    console.log(`（备份已存在，保留不覆盖：${path.basename(backup)}）`);
  }

  fs.writeFileSync(exePath, out);

  // 复核：重新读一遍，确认头改对了
  const verify = parseMachO(fs.readFileSync(exePath));
  const okN = verify.ncmds === hdr.ncmds + 1;
  const okS = verify.sizeofcmds === hdr.sizeofcmds + lcSize;
  const okL = fs.statSync(exePath).size === origLen;
  const okD = verify.commands.some((e) => e.name === installName);
  if (!(okN && okS && okL && okD)) {
    fail(`写入后复核失败：ncmds+1=${okN} sizeofcmds=${okS} 长度不变=${okL} 命令可见=${okD}`);
  }

  console.log(`\n✓ 注入完成`);
  console.log(`  ncmds      : ${hdr.ncmds} -> ${verify.ncmds}`);
  console.log(`  sizeofcmds : ${hdr.sizeofcmds} -> ${verify.sizeofcmds}（+${lcSize}）`);
  console.log(`  文件长度   : ${origLen} B（未变）`);
  console.log(`  载入路径   : ${installName}`);
  console.log(`\n下一步：`);
  console.log(`  1. 重新签名整个 .app（ldid -S 或侧载工具自动完成）—— 改过头部，原签名已失效。`);
  console.log(`  2. 打包回 IPA 并侧载。`);
  console.log(`  3. 首次启动看 Console 里的 [AMAutoClick] / [AMCapture] 日志确认 hook 生效。`);
}

main();
