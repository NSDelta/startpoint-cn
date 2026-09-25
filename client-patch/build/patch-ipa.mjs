#!/usr/bin/env node
// 世界弹射物语 iOS (AIR AOT) IPA 补丁工具 —— iOS 版 patch-apk.mjs
//
// ★ 本文件是 iOS 补丁线的**基线脚本**（服主提供，原用于在服务端打包出可安装的 IPA），
//   也是 A1b 重基线后**唯一入口**：后续所有 iOS 补丁工具都**基于本文件增改**，不要另起炉灶
//   重写：里面的功能补丁地址（实名提示 / 全新安装登录弹窗 / 欢迎横幅 / 使用许可协议+隐私政策门 /
//   Bundle ID 资源校验 / sohu 外发屏蔽）与 guard 处理都是**真机验证过**的，重写会丢掉这些能力。
//   B0 期间临时写的 `patch-ios-ipa.mjs` 已在 A1b 重基线时**并入本文件**，那个文件现在只剩一个
//   "已废弃"墓碑（零补丁逻辑），不再是第二条入口。合并清单见分工文档 §4-P10-A1b。
//
// ★ A1b 并入的三项能力（原先只在 B0 派生件里）：
//   ① lib/ios-abc.mjs 的 **ABC 常量池等长改写**。功能性必需：AS3 的 `DevConfig_gf_ios.apiServer`
//      编译进 Mach-O 后是 ABC 池里的 `Custom("https","shijtswygamegf.leiting.com")` 一对条目，
//      运行期由 `ApiServerKindTools.getServerBasePath` 的 `case 9`(Custom) 拼成
//      `params[0] + "://" + params[1]`。只改 `__cstring` 里的 URL 站点**不够** —— 运行期 API 基址
//      仍会走 https://shijtswygamegf.leiting.com。这对条目 scheme 5→4 字符、authority 26→27 字符，
//      成对字节数守恒（33 B）。
//   ② **回读断言 + `<out>.build-report.json`**：断言硬失败（退出码 2），绝不允许"带伤出包"。
//      B0 派生件的教训：它静默丢了上面六项功能补丁，产物看上去一切正常，装机却卡在 SDK 弹窗。
//   ③ lib/zip-ipa.mjs **替代 `jar uf0`**：`jar` 会把整包重写成 STORED + madeBy=0x000a(FAT) +
//      externalAttr=0，等于丢掉主二进制的 Unix 可执行位（0o100755 → 0o0）⇒ AltStore/AltServer
//      的严格 IPA 解析直接拒绝："The app is in an invalid format."（Sideloadly 尚能容忍）
//
// iOS 是 AOT 编译：AS3（DevConfig.sdkDummy / DevConfig_gf_ios.apiServer / FileReader）
// 被编译进原生 Mach-O，无法用 FFDec -replace 修改。因此通过二进制补丁直接改写
// Mach-O 中嵌入的 URL 字符串常量，指向本地服务器（scheme https->http, host->HOST:PORT），
// 原地覆盖、空字节填充到原长度。这是国服客户端补丁理念（直接改客户端，不走代理/WireGuard）。
//
//   https://<x>.leiting.com<path>   ->   http://HOST:PORT<path>\0...   （长度够用时）
//
// 游戏 API 地址不直接改写 —— 它从已改写的 update.leiting.com → version.dis（本地提供）→
// 本地 apiPath 获取。登录走本地服务器 leiting 模拟。资源缺失（FileReader）崩溃由启动器
// 提供完整 CDN 避免，不依赖代码补丁。
//
// 补丁后 Mach-O 签名失效 —— IPA 必须重签（Sideloadly 用你的 Apple ID 安装时自动完成，
// 对补丁后的二进制重新哈希）。cryptid=0（解密 dump）确认可重签。
//
// 用法: node patch-ipa.mjs --ipa=in.ipa --host=192.168.x.x --port=8001 --out=out.ipa
//        node patch-ipa.mjs --bin=worldflipper --host=... --port=... --out=patched.bin
//      空格分隔形式同样支持（`--ipa in.ipa --host 192.168.x.x`）—— A1b 新增，见下方 ARGV 规范化。
//      其它: --guard-mode=launch|all|none（默认 all；联调 SOP 用 launch）
//            --agreement=false / --privacy=false 关闭协议门补丁
//            --app=<App 名> 显式指定 Payload/<App>.app/<App>（默认自动探测）
//            --dry-run 只算不写（不产出 IPA，回读断言不执行）
//      旧参数 --jar= / --res= / --work= 已随 jar 一起废弃（无人使用则忽略）。

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// ── A1b 新增依赖（全部零外部包，只用 node 内置 + 本目录 lib/）──
import {
  ENDPOINT_LENGTH, OFFICIAL_SITE_REWRITEABLE, OFFICIAL_SITE_TOO_SHORT, OFFICIAL_SITE_TOTAL, PREMISE_ENDPOINT,
  byteDiffRanges, countOccurrences, countRewriteableUrlSites, diffRanges, mergeRanges, minReplacementLength,
  rangesEqual, scanTargets,
} from './lib/ios-endpoint.mjs';
import { ABC_API_HOST, ABC_API_PAIR_OFFSET, ABC_API_SCHEME, applyApiBaseRewrite, findSchemeHostPair } from './lib/ios-abc.mjs';
import { OFFICIAL_IOS_184, findMainBinaryEntry, parseMachOHeader } from './lib/ios-macho.mjs';
import { crc32, madeByHost, readEntryData, readZipEntries, replaceEntryData, unixMode, writeZipEntries } from './lib/zip-ipa.mjs';
import { createAssertions, hexRange, hexRanges, sha256Hex, writeBuildReport } from './lib/build-report.mjs';

// A1b 增补：兼容 `--key value`（空格分隔）形式。基线解析器只认 `--key=value`，而 ios/README.md
// 的联调 SOP 与 tools/ios_ipa_patch.test.cjs 用的都是空格形式（基线会把 `--ipa a.ipa` 解析成
// args.ipa=true → readFileSync(true) 直接抛错）。这里**先**把空格形式规范化成 `--key=value`，
// 再交给下面**原有的**解析器 —— 语义完全不变（裸开关仍是 true，`--key=value` 仍是字符串）。
const ARGV = [];
for (let i = 0; i < process.argv.length - 2; i++) {
  const tok = process.argv[2 + i], nxt = process.argv[3 + i];
  if (/^--[^=]+$/.test(tok) && nxt !== undefined && !nxt.startsWith('--')) { ARGV.push(`${tok}=${nxt}`); i++; }
  else ARGV.push(tok);
}
const args = Object.fromEntries(ARGV.map(a => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const HOST = args.host, PORT = args.port, OUT = args.out;
const GUARD_MODE = args['guard-mode'] || 'all';      // launch|all|none，默认 all（处理所有 guard）
const fail = m => { console.log('ERROR ' + m); process.exit(1); };
if (!HOST || !PORT || !OUT || (!args.ipa && !args.bin)) fail('需要 --ipa(或 --bin) --host --port --out');

const HOST_PORT = `${HOST}:${PORT}`;                // e.g. 192.168.1.10:8001（示例值必须是 hygiene 白名单里的 192.168.1.10，勿改成真实局域网 IP）
const TARGET = `http://${HOST_PORT}`;               // replacement scheme+authority (e.g. 26 bytes)
const HOST_RE = /https?:\/\/[A-Za-z0-9.-]+\.(?:leiting\.com|roguelike\.com|cl2009\.com)(?::\d+)?/;
// optional whitelist: only redirect URLs whose host contains one of these substrings
const HOSTS = args.hosts ? String(args.hosts).split(',').filter(Boolean) : null;

// Redirect every leiting/roguelike/cl2009 endpoint in the Mach-O by replacing ONLY the
// authority (scheme://host[:port]) in place, padded to the EXACT original authority length.
//
// WHY authority-only + same-length (the load-black fix): the URLs live in two storage forms —
// (a) null-terminated C-strings, and (b) AIR's SEQUENTIAL length-prefixed constant pool, where
// pooled strings sit back-to-back each preceded by a u30 length byte (e.g. update.leiting.com is
// followed immediately by [0x0e]"onQuerySuccess"...). The old patcher SHORTENED the string and
// rewrote buf[off-1]; for a pooled string that shifts everything downstream AND desyncs the
// sequential parser (it then reads the next string's length from the wrong offset) → the whole
// pool corrupts → AIR content-load THROWS → black screen before any network request. The
// buf[off-1] heuristic also false-positives on any preceding data byte that equals the length.
// By overwriting exactly authLen bytes and never shifting/padding/prefix-touching, the pool stays
// byte-for-byte in sync and C-strings are equally valid. Length is preserved via userinfo padding
// (http://0000@host:port/...), which the server ignores and which is safe before a path (so base
// URLs that the client concatenates onto still resolve to host:port).
function patchBuffer(buf) {
  const s = buf.toString('latin1');
  const re = new RegExp(HOST_RE.source, 'g');        // AUTHORITY ONLY — never the greedy path
  let m, patched = 0, skipped = [], seen = new Set();
  while ((m = re.exec(s))) {
    const auth = m[0], off = m.index;
    if (HOSTS && !HOSTS.some(h => auth.includes(h))) continue;   // whitelist: skip non-listed hosts
    const authLen = Buffer.byteLength(auth, 'latin1');
    const deficit = authLen - TARGET.length;         // spare bytes to absorb via userinfo padding
    if (deficit < 0) {                               // target authority longer than original → would shift, skip
      const host = auth.replace(/^https?:\/\//, '');
      if (!seen.has(host)) { skipped.push(`${host} (auth ${authLen} < ${TARGET.length})`); seen.add(host); }
      continue;
    }
    // Build a replacement authority of EXACTLY authLen bytes. deficit==0 → plain TARGET; else pad
    // userinfo: "http://" + (deficit-1 filler) + "@" + HOST_PORT  ⇒ 7 + deficit + len(HOST_PORT) = authLen.
    const paddedAuth = deficit === 0 ? TARGET
      : `http://${'0'.repeat(deficit - 1)}@${HOST_PORT}`;
    Buffer.from(paddedAuth, 'latin1').copy(buf, off);   // overwrite authority in place — same length, nothing shifts
    patched++;
  }
  return { patched, skipped };
}

// 屏蔽不可重定向的外部域名（如 pv.sohu.com IP 地理定位查询，其 authority 太短无法等长改写
// 到我们的局域网服务器）。将其 authority 原地改写为同长度的死循环地址 → 设备端请求直接
// ECONNREFUSED → SDK 回退到默认值 → 零外部流量离开手机。完全本地/离线保证。
const BLOCK_RE = /https?:\/\/[A-Za-z0-9.-]+\.sohu\.com(?::\d+)?/;
const DEAD_HOST_PORT = '127.0.0.1:1';              // nothing listens on :1 → fast connection-refused
const DEAD_TARGET = `http://${DEAD_HOST_PORT}`;    // 18 bytes
function patchBlock(buf) {
  const s = buf.toString('latin1');
  const re = new RegExp(BLOCK_RE.source, 'g');
  let m, blocked = 0, hosts = new Set();
  while ((m = re.exec(s))) {
    const auth = m[0], off = m.index, authLen = Buffer.byteLength(auth, 'latin1');
    const deficit = authLen - DEAD_TARGET.length;
    if (deficit < 0) continue;                       // sohu authority is always >= 18
    const padded = deficit === 0 ? DEAD_TARGET : `http://${'0'.repeat(deficit - 1)}@${DEAD_HOST_PORT}`;
    Buffer.from(padded, 'latin1').copy(buf, off);    // same length, nothing shifts
    blocked++; hosts.add(auth.replace(/^https?:\/\//, ''));
  }
  return { blocked, hosts: [...hosts] };
}

// 清除应用故意的"致命中止"模式 —— 重签后在启动时崩溃（完整性/权限校验）。
// 模式：MOVZ X8,#0 (0xd2800008)，然后在 3 条指令内对 [X8] 写（向地址 0 写入 0xDEADBEEF =
// 故意崩溃，iOS 从不映射第 0 页）。我们 NOP 掉 store，中止变成空操作，执行继续。
// 只匹配刚清零 X8 后的 store → 不会误伤正常写操作。
// mode: 'launch' = 仅 NOP 0xb00c 处启动计时器 guard（最小改动，已验证不破坏 AIR 加载）;
//        'all' = NOP 每个安全回退的中止点; 'none' = 跳过。
function deguardBuffer(buf, mode) {
  if (mode === 'none') return 0;
  if (mode === 'launch') {                    // only the launch guard — avoid disturbing content-load
    if (buf.readUInt32LE(0xb00c) === 0xb9000109) { buf.writeUInt32LE(0xd503201f, 0xb00c); return 1; }
    return 0;
  }
  const NOP = 0xd503201f, RET = 0xd65f03c0; let n = 0, skipped = 0; const len = buf.length & ~3;
  const isStoreToX8 = (w) => (((w >>> 5) & 31) === 8) &&
    [0xB9000000, 0xF9000000, 0x39000000, 0x79000000].includes((w & 0xFFC00000) >>> 0);
  // Only NOP an abort whose fall-through is SAFE: a RET (or unconditional B) appears within a few
  // words after the store. NOPping an abort with code after it would run that code with the bad
  // state the abort guarded against — risking exactly the black-screen we're chasing.
  const safeFallthrough = (strOff) => {
    for (let j = 1; j <= 6; j++) {
      const w = buf.readUInt32LE(strOff + 4 * j);
      if (w === RET) return true;
      if ((w & 0xFC000000) >>> 0 === 0x14000000) return true;   // B (tail branch)
      if ((w >>> 24) === 0xa8 || (w >>> 24) === 0xa9) continue;  // LDP epilogue → keep scanning
    }
    return false;
  };
  for (let o = 0; o + 28 <= len; o += 4) {
    if (buf.readUInt32LE(o) !== 0xd2800008) continue;       // MOVZ X8,#0
    for (let k = 1; k <= 3; k++) {
      const w = buf.readUInt32LE(o + 4 * k);
      if (isStoreToX8(w)) {
        if (safeFallthrough(o + 4 * k)) { buf.writeUInt32LE(NOP, o + 4 * k); n++; }
        else skipped++;
        break;
      }
      if ((w & 31) === 8) break;                            // X8 reloaded → not a null-store
    }
  }
  if (skipped) console.log(`  （跳过 ${skipped} 处不安全回退的中止点 —— 保持原样）`);
  return n;
}

// 抑制雷霆首次登录实名提示（实名提示 / FirstLoginTipsView）。
// LTLoginManager -shouldShowFirstLoginTip 是控制弹窗的 BOOL 谓词；强制返回 NO
// (mov w0,#0 ; ret)，SDK 跳过提示直接进入游戏。
// 用方法序言签名守卫 (stp x22,x21,[sp,#-0x30]! = 0xa9bd57f6)，避免错误修改 → 不匹配则跳过。
function patchFirstLoginTip(buf) {
  const OFF = 0x6ae0dc;
  if (OFF + 8 > buf.length || buf.readUInt32LE(OFF) !== 0xa9bd57f6) return 0;
  buf.writeUInt32LE(0x52800000, OFF);       // mov w0, #0
  buf.writeUInt32LE(0xd65f03c0, OFF + 4);   // ret
  return 1;
}

// 全新安装时跳过雷霆登录弹窗（无已存凭证）。SDK 的登录决策（sub @0x68e7xx）在 token
// 为 nil/空/"(null)" 时弹出对话框 (homeViewWithCallbackCancel:)；否则走自动登录路径
// (checkLogin:callback:)，我们的模拟服务器接受任意凭证。NOP 掉 3 个弹窗跳转分支，
// 新启动直接进入自动登录 → 游客登录成功，无弹窗。已内存验证：新状态到达 handleLoginSuccess，
// 无弹窗、无崩溃。对正常（已有 token）情况安全：有真实 token 时这些分支永远不触发。
// 每处用指令签名守卫 (cbz/cbnz 编码)，避免错误修改。
function patchLoginDialog(buf) {
  const NOP = 0xd503201f;
  const sites = [[0x68e878, 0xb4000820], [0x68e898, 0xb40006a0], [0x68e8d8, 0x35000538]];
  let n = 0;
  for (const [off, want] of sites) {
    if (off + 4 <= buf.length && buf.readUInt32LE(off) === want) { buf.writeUInt32LE(NOP, off); n++; }
  }
  return n;   // 3 = fully applied
}

// 抑制雷霆登录后欢迎横幅（"…，欢迎入园。"浮动 toast，每次登录后短暂显示脱敏账号名）。
// Frida 探测（probe-discover-ui.js）证实实际弹出的横幅由实例方法
// -[LTLoginManager showWelcomeView:] (rva 0x6adb14) 绘制，该方法派发 block 调用
// +[LTWelcomeView showMoleWelcomeView:] 构建。
// （之前尝试改同名类方法 +[LTWelcomeView showWelcomeView:] @0x64b238 — 错误对象，无效。）
// 三处均为纯展示、无副作用、不影响流程；每处用签名守卫。
function patchWelcomeBanner(buf) {
  let n = 0;
  // (1) THE real one: stub -[LTLoginManager showWelcomeView:] entry -> return nil (sub sp,#0x50 = 0xd10143ff)
  const MAIN = 0x6adb14;
  if (MAIN + 8 <= buf.length && buf.readUInt32LE(MAIN) === 0xd10143ff) {
    buf.writeUInt32LE(0xd2800000, MAIN);      // mov x0, #0
    buf.writeUInt32LE(0xd65f03c0, MAIN + 4);  // ret
    n++;
  }
  // (2) also stub +[LTWelcomeView showWelcomeView:] (sub sp,#0x1c0 = 0xd10703ff) — a second banner
  // path; harmless defense-in-depth.
  const CLS = 0x64b238;
  if (CLS + 8 <= buf.length && buf.readUInt32LE(CLS) === 0xd10703ff) {
    buf.writeUInt32LE(0xd2800000, CLS);       // mov x0, #0
    buf.writeUInt32LE(0xd65f03c0, CLS + 4);   // ret
    n++;
  }
  // (3) NOP the +[LTWelcomeView showWelcomeView:] call in the login-success path (0x634890).
  const CALL = 0x634890;
  if (CALL + 4 <= buf.length && buf.readUInt32LE(CALL) === 0x9546daf4) {
    buf.writeUInt32LE(0xd503201f, CALL);      // nop
    n++;
  }
  return n;   // 3 = all applied
}

// 修改 sub_100312230（AIR 启动流程），立即返回 0，跳过基于 Bundle Identifier
// 的资源查找。修改 CFBundleIdentifier 实现多开（TrollStore）时，AIR 的 Mach-O 解析器
// 无法找到新 Bundle ID 对应的资源 → SIGSEGV 崩溃。此补丁直接跳过该查找。
function patchBundleIdCheck(buf) {
  const OFF = 0x312230;
  // 序言签名: STP X28,X27,[SP,#-0x30]!  (0xa9bd6ffc)
  if (OFF + 16 > buf.length || buf.readUInt32LE(OFF) !== 0xa9bd6ffc) return 0;
  buf.writeUInt32LE(0xd2800000, OFF);       // MOV X0, #0
  buf.writeUInt32LE(0xd65f03c0, OFF + 4);   // RET
  buf.writeUInt32LE(0xd503201f, OFF + 8);   // NOP
  buf.writeUInt32LE(0xd503201f, OFF + 12);  // NOP
  return 1;
}

// 全新安装时跳过雷霆协议弹窗，直接进入游戏。
// (A) 使用许可协议 (class ShowProtocolView，登录后通过 -showLicenseView:callbackBean:
//     @0x6c6c78 展示)。0x6c6cfc 已有跳转到"已同意"跳过目标 0x6c6ddc 的分支（该目标调用
//     与同意后回调相同的 -showNoticeTip:callbackBean:）。强制该分支为无条件 (tbnz→b)
//     → 始终走已同意路径。设备验证通过：EULA 不再出现，游戏正常进入。
// (B) 隐私政策弹窗 (class ProtocolPrivacyPopView，由原生 AS3-AOT show 函数
//     @0x68dd30 & @0x698b08 通过 -initWithType: 首先展示)。对两个 show 函数打桩为
//     `mov x0,#0 ; ret`，弹窗永不构建。均用签名守卫。
function patchAgreementDialogs(buf) {
  let n = 0;
  // (A) EULA gate: 0x6c6cfc tbnz w0,#0,0x6c6ddc (0x37000700) -> b 0x6c6ddc (0x14000038).
  //     Gated behind --agreement while we confirm it isn't what broke the standalone build's
  //     boot networking (ResVer.null / no server requests). Default OFF for a safe working build.
  const EULA = 0x6c6cfc;
  if (PATCH_AGREEMENT && EULA + 4 <= buf.length && buf.readUInt32LE(EULA) === 0x37000700) { buf.writeUInt32LE(0x14000038, EULA); n++; }
  // (B) privacy popup (ProtocolPrivacyPopView). SAFE approach = patch the "should I show privacy?"
  //     GATE predicates to return NO (already-agreed / returning-user path) so the caller never calls
  //     the show-funcs (0x68dd30/0x698b08) — which also register the boot observer/view-stack, so
  //     stubbing THEM broke boot networking. Returning NO from the gate = returning-user behavior
  //     (boots fine). Two BOOL predicates (prologue stp x20,x19,[sp,#-0x20]! = 0xa9be4ff4):
  //     -[LeitingSDK needShowPrivacy]@0x698990 and +[GDPRManage needShowPrivacyProtocolView]@0x60f15c.
  //     Gated behind --privacy until full-flow validated on the STANDALONE build.
  if (PATCH_PRIVACY) {
    for (const off of [0x698990, 0x60f15c]) {
      if (off + 8 <= buf.length && buf.readUInt32LE(off) === 0xa9be4ff4) {
        buf.writeUInt32LE(0x52800000, off);      // mov w0, #0  (return NO)
        buf.writeUInt32LE(0xd65f03c0, off + 4);  // ret
        n++;
      }
    }
  }
  return n;   // 0 = no agreement; 1 = EULA; 3 = EULA + both privacy gates (--privacy)
}
// EULA skip (0x6c6cfc) is DEVICE-VERIFIED SAFE on the standalone build (game enters full-flow),
// so it is default-ON. Pass --agreement=false to disable. Privacy stub stays default-OFF (it broke
// boot networking — see patchAgreementDialogs note).
const PATCH_AGREEMENT = args['agreement'] !== 'false' && args['agreement'] !== false;
// Privacy GATE approach (needShowPrivacy/needShowPrivacyProtocolView -> NO) is DEVICE-VERIFIED SAFE
// on the standalone build (full-flow: no privacy popup, game enters). Default-ON. --privacy=false to disable.
const PATCH_PRIVACY = args['privacy'] !== 'false' && args['privacy'] !== false;

const MACHO_REL = 'Payload/worldflipper.app/worldflipper';

// ═══════════════════════════ A1b 新增：断言 / 计划窗口 / 构建报告 ═══════════════════════════
// 设计要点（为什么这么做，而不是"打印数字让人看"）：
//   · 输入指纹：主二进制 sha256 + 长度 + ncmds/sizeofcmds + cryptid —— 只要不是官方 1.8.4 原始件
//     就硬失败。任务单明确警告过 `D:\wfspcn\tools\tmp_ipa\…` 那份第三方已打补丁的产物
//     （sha256 5c0b67e0…）不能用来出包；指纹断言是这条红线的机器化形式。
//   · "改动字节范围 = 声明窗口"：把所有**可能被写**的字节窗口列出来（六项功能补丁的固定偏移 +
//     全部域名站点 + sohu 站点 + ABC 池 + guard 扫描窗），然后断言 `diffRanges(before, after)`
//     完全落在这些窗口内。任何一次越界写入（例如正则贪吃、off-by-N）都会在这里被抓出来，
//     而不是靠人眼比对两个 108 MB 文件。
//   · 计数断言（137 / 138 / 3 / 1 …）与窗口断言互补：窗口管"没写错地方"，计数管"没漏写"。
const OFFICIAL = OFFICIAL_IOS_184;
const NOP_INS = 0xd503201f;
const hex = (n) => `0x${(n >>> 0).toString(16)}`;

// 基线六项功能补丁 + 诊断开关的**声明写入窗口**（[start, end)）。偏移是对上面各 patchXxx()
// 内部常量的**故意重复**：单一来源就无法交叉校验，重复才能发现"改了偏移忘了改断言"。
const FIXED_WINDOWS = [
  [0x6ae0dc, 0x6ae0dc + 8],      // patchFirstLoginTip
  [0x68e878, 0x68e878 + 4],      // patchLoginDialog ①
  [0x68e898, 0x68e898 + 4],      // patchLoginDialog ②
  [0x68e8d8, 0x68e8d8 + 4],      // patchLoginDialog ③
  [0x6adb14, 0x6adb14 + 8],      // patchWelcomeBanner ①
  [0x64b238, 0x64b238 + 8],      // patchWelcomeBanner ②
  [0x634890, 0x634890 + 4],      // patchWelcomeBanner ③
  [0x312230, 0x312230 + 16],     // patchBundleIdCheck
  [0x6c6cfc, 0x6c6cfc + 4],      // patchAgreementDialogs (A) EULA
  [0x698990, 0x698990 + 8],      // patchAgreementDialogs (B) 隐私 gate ①
  [0x60f15c, 0x60f15c + 8],      // patchAgreementDialogs (B) 隐私 gate ②
  [ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes],   // ABC 池条目对
  [0x57d834c, 0x57d834c + 4],    // --crash-longjmp 诊断写点
];

/** guard 可能写入的窗口：launch 只写 0xb00c；all 模式扫 MOVZ X8,#0 后 3 词内的 store。 */
function guardWindows(buffer, mode) {
  if (mode === 'none') return [];
  if (mode === 'launch') return [[0xb00c, 0xb010]];
  const windows = [];
  const len = buffer.length & ~3;
  for (let offset = 0; offset + 28 <= len; offset += 4) {
    if (buffer.readUInt32LE(offset) === 0xd2800008) windows.push([offset, offset + 16]);
  }
  return windows;
}

/** 全部域名站点 + sohu 站点的窗口（过短站点也列进去：它们本来就不该被写，列进去反而是更强的约束）。 */
function authorityWindows(pristine) {
  const windows = scanTargets(pristine, { includeBare: false }).sites.map(site => [site.offset, site.offset + site.length]);
  const text = pristine.toString('latin1');
  const re = new RegExp(BLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) windows.push([m.index, m.index + m[0].length]);
  return windows;
}

/** 把"声明窗口内真正变化的字节"切成合并后的范围（窗口外一律不算）。 */
function windowDiffRanges(before, after, windows) {
  const raw = [];
  for (const [start, end] of windows) {
    if (start >= end || end > before.length) continue;
    raw.push(...byteDiffRanges(before.subarray(start, end), after.subarray(start, end), start));
  }
  return mergeRanges(raw);
}

/** 输入指纹断言（--bin 与 --ipa 两条路径共用）。 */
function assertOfficialInput(A, bin, label = '输入主二进制') {
  A.check(`${label} = 官方 iOS 1.8.4 原始件（sha256 ${OFFICIAL.binSha256.slice(0, 16)}…）`,
    sha256Hex(bin) === OFFICIAL.binSha256, `实测 sha256 ${sha256Hex(bin)}`);
  A.check(`${label}长度 = ${OFFICIAL.binBytes} B`, bin.length === OFFICIAL.binBytes, `实测 ${bin.length} B`);
  const mh = parseMachOHeader(bin);
  A.check(`输入 Mach-O：ncmds = ${OFFICIAL.ncmds} / sizeofcmds = ${OFFICIAL.sizeofcmds}`,
    mh.ncmds === OFFICIAL.ncmds && mh.sizeofcmds === OFFICIAL.sizeofcmds,
    `ncmds=${mh.ncmds} sizeofcmds=${mh.sizeofcmds}（未加段、未动 LC 区）`);
  A.check('输入包 cryptid = 0（解密 dump，可重签）', !!mh.encryption && mh.encryption.cryptid === 0,
    mh.encryption ? `cryptoff=${mh.encryption.cryptoff} cryptsize=${mh.encryption.cryptsize} cryptid=${mh.encryption.cryptid}` : '缺 LC_ENCRYPTION_64');
  return mh;
}

/** 补丁结果断言（两条路径共用；ctx 由各自分支提供）。返回 { actual, windows }。 */
function assertPatchResults(A, ctx) {
  const { r, blk, guards, abc, tip, dlg, wel, agr, bid, buf, pristine, mhIn, rewriteable } = ctx;
  A.check('URL 站点改写数 = 可改写站点数', r.patched === rewriteable,
    `${r.patched} / ${rewriteable}（过短跳过 ${r.skipped.length} 个：${r.skipped.slice(0, 4).join(' | ') || '无'}）`);
  A.check('基线六项 ① 实名提示 shouldShowFirstLoginTip -> NO', tip === 1,
    tip ? `${hex(0x6ae0dc)}: mov w0,#0 ; ret` : `签名 0xa9bd57f6 不匹配（${hex(pristine.readUInt32LE(0x6ae0dc))}）`);
  A.check('基线六项 ② 全新安装登录弹窗 3/3 分支 NOP', dlg === 3, `命中 ${dlg}/3`);
  A.check('基线六项 ③ 欢迎入园横幅 3/3 处', wel === 3, `命中 ${wel}/3`);
  A.check('基线六项 ④ Bundle ID 资源校验 -> return 0', bid === 1,
    bid ? `${hex(0x312230)}: MOV X0,#0 ; RET ; NOP ; NOP` : `签名 0xa9bd6ffc 不匹配（${hex(pristine.readUInt32LE(0x312230))}）`);
  const expectAgr = (PATCH_AGREEMENT ? 1 : 0) + (PATCH_PRIVACY ? 2 : 0);
  A.check('基线六项 ⑤ 协议门（EULA + 隐私 gate）', agr === expectAgr,
    `命中 ${agr}/${expectAgr}（--agreement=${PATCH_AGREEMENT} --privacy=${PATCH_PRIVACY}）`);
  A.check('基线六项 ⑥ sohu 外发屏蔽（等长改写为 127.0.0.1:1）', blk.blocked === 1,
    `命中 ${blk.blocked} 处${blk.hosts.length ? '：' + blk.hosts.join(', ') : ''}`);
  if (GUARD_MODE === 'launch') {
    A.check('guard-mode=launch：只 NOP 0xb00c 一处', guards === 1 && buf.readUInt32LE(0xb00c) === NOP_INS,
      `0xb00c = ${hex(buf.readUInt32LE(0xb00c))}`);
  } else {
    A.check(`guard-mode=${GUARD_MODE}：已 NOP ${guards} 处致命中止`, GUARD_MODE !== 'none' || guards === 0,
      `模式 ${GUARD_MODE}`);
  }
  A.check(`ABC 池 ${ABC_API_SCHEME} + ${ABC_API_HOST} ⇒ ${abc.applied ? abc.apiBase : '未改写'}（${OFFICIAL.abcPairBytes} B 守恒）`,
    abc.applied === 1 && abc.totalBytes === OFFICIAL.abcPairBytes, abc.reason);
  const residue = countRewriteableUrlSites(buf, { hostPort: HOST_PORT });
  A.check('补丁后：可改写旧站点残留 = 0 处', residue === 0, `残留 ${residue} 处`);
  const premiseLeft = countOccurrences(buf, PREMISE_ENDPOINT);
  A.check(`补丁后：${PREMISE_ENDPOINT} 残留 = 0 处`, premiseLeft === 0, `残留 ${premiseLeft} 处`);
  const postEndpoints = countOccurrences(buf, HOST_PORT);
  A.check(`补丁后：新端点 = ${OFFICIAL.endpointOccurrencesAfter} 处（${OFFICIAL_SITE_REWRITEABLE} URL + 1 ABC）`,
    postEndpoints === OFFICIAL.endpointOccurrencesAfter, `实测 ${postEndpoints} 处`);
  A.check(`补丁后：主二进制长度不变 = ${OFFICIAL.binBytes} B`, buf.length === OFFICIAL.binBytes, `${pristine.length} B -> ${buf.length} B`);
  const mhOut = parseMachOHeader(buf);
  A.check('补丁后：ncmds / sizeofcmds 不变（未加段、未动 LC 区）',
    mhOut.ncmds === mhIn.ncmds && mhOut.sizeofcmds === mhIn.sizeofcmds && mhOut.ncmds === OFFICIAL.ncmds && mhOut.sizeofcmds === OFFICIAL.sizeofcmds,
    `ncmds=${mhOut.ncmds} sizeofcmds=${mhOut.sizeofcmds}`);
  // 越界写入检查
  const windows = [...FIXED_WINDOWS, ...authorityWindows(pristine), ...guardWindows(pristine, GUARD_MODE)];
  const actual = diffRanges(pristine, buf);
  const planned = windowDiffRanges(pristine, buf, windows);
  const stray = actual.filter(range => !planned.some(p => p[0] <= range[0] && p[1] >= range[1]));
  const changedBytes = actual.reduce((sum, [s, e]) => sum + (e - s), 0);
  A.check('改动字节范围 = 计划范围（无越界写入）', rangesEqual(actual, planned) && stray.length === 0,
    `${actual.length} 段 / ${changedBytes} 字节；声明窗口 ${windows.length} 个${stray.length ? `；越界段 ${hexRanges(stray, 3)}` : ''}`);
  return { actual, planned, windows, changedBytes, residue, postEndpoints };
}

/** 断言小结 + 硬失败（退出码 2；产物是否已写出由调用方在消息里说明）。 */
function finishAssertions(A, { outPath, wroteOutput }) {
  console.log('');
  console.log(`断言：${A.passed.length} PASS / ${A.failed.length} FAIL`);
  if (A.failed.length === 0) return true;
  console.log('FAILED —— 以下断言未通过：');
  for (const f of A.failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  if (wroteOutput) console.log(`产物 ${outPath} **不可交付**（断言未过），请删除或修好后重跑。`);
  else console.log('未写出任何产物。');
  process.exit(2);
}

if (args.bin) {
  // 测试模式：直接补丁裸 Mach-O 文件
  const buf = readFileSync(args.bin);
  const pristine = Buffer.from(buf);                // A1b：只读对照（Buffer.from(Buffer) 是拷贝，共享内存的坑不会踩）
  const A = createAssertions();
  const mhIn = assertOfficialInput(A, pristine);
  const minLen = minReplacementLength(HOST_PORT);
  const rewriteable = scanTargets(pristine, { includeBare: false }).sites.filter(s => s.length >= minLen).length;
  const r = patchBuffer(buf);
  const blk = patchBlock(buf);
  const guards = deguardBuffer(buf, GUARD_MODE);
  const abc = applyApiBaseRewrite(buf, { hostPort: HOST_PORT });
  const tip = patchFirstLoginTip(buf);
  const dlg = patchLoginDialog(buf);
  const wel = patchWelcomeBanner(buf);
  const agr = patchAgreementDialogs(buf);
  const bid = patchBundleIdCheck(buf);
  if (blk.blocked) console.log(`已屏蔽 ${blk.blocked} 个外部请求 -> 死循环（零外部流量）: ${blk.hosts.join(', ')}`);
  console.log(tip ? '  已抑制实名提示 (shouldShowFirstLoginTip -> NO)' : '  [!] 实名提示补丁签名不匹配 —— 已跳过');
  console.log(dlg === 3 ? '  已跳过全新安装登录弹窗（强制自动登录，3/3 分支已 NOP）' : `  [!] 登录弹窗补丁仅匹配 ${dlg}/3 分支 —— 已跳过`);
  console.log(wel === 3 ? '  已抑制欢迎入园横幅 (LTLoginManager showWelcomeView: + 2 处，3/3)' : `  [!] 欢迎横幅补丁仅匹配 ${wel}/3 处 —— 已跳过`);
  console.log(agr===0 ? '  协议弹窗保持原样' : ('  已跳过使用许可协议' + (agr>=3 ? ' + 隐私政策弹窗' : '') + ` [${agr} 处]`));
  console.log(bid ? '  sub_100312230 -> return 0（跳过 Bundle ID 资源校验，多开安全）' : '  [!] Bundle ID 校验补丁签名不匹配 —— 已跳过');
  console.log(abc.applied ? `  ABC 池 API 基址 -> ${abc.apiBase}（${abc.totalBytes} B 守恒 @${hex(abc.offset)}）` : `  [!] ABC 池改写未生效：${abc.reason}`);
  if (args['crash-longjmp'] && buf.readUInt32LE(0x57d834c) === 0xb0005190) { buf.writeUInt32LE(0xd4200000, 0x57d834c); console.log('  [诊断] _longjmp 桩 -> BRK'); }
  const res = assertPatchResults(A, { r, blk, guards, abc, tip, dlg, wel, agr, bid, buf, pristine, mhIn, rewriteable });
  writeFileSync(OUT, buf);
  console.log(`已改写 ${r.patched} 个 URL 常量 -> ${TARGET}`);
  console.log(`已清除 ${guards} 个故意中止 guard（0xDEADBEEF 空写入）`);
  if (r.skipped.length) console.log(`已跳过（太长，${r.skipped.length} 个）: ` + r.skipped.slice(0, 12).join(', '));
  console.log('DONE  ' + OUT);
  console.log(`（--bin 测试模式：改动 ${res.actual.length} 段 / ${res.changedBytes} 字节；不写 build-report）`);
  finishAssertions(A, { outPath: OUT, wroteOutput: true });
} else {
  // IPA 模式（A1b 重基线）：零依赖 zip 引擎读写 IPA —— 不再复制到临时目录、不再调用 `jar xf/uf0`。
  // 六项功能补丁 + guard 处理与基线逐行一致；新增 ABC 池改写、断言与构建报告。
  const TOTAL = 5; let step = 0;
  const progress = (label) => {
    const m = `STEP ${++step}/${TOTAL} ${label}`;
    process.stdout.write(m + String.fromCharCode(10));
    return m;
  };
  const A = createAssertions();
  const DRY_RUN = !!args['dry-run'];

  progress('读取输入 IPA（零依赖 zip 引擎）');
  if (!existsSync(args.ipa)) fail('找不到输入 IPA：' + args.ipa);
  if (path.resolve(String(args.ipa)) === path.resolve(String(OUT))) fail('--out 不能与 --ipa 相同（会就地毁掉官方原始件）');
  if (path.resolve(String(OUT)) === path.resolve(MACHO_REL)) fail('--out 指向主二进制相对路径，请改用绝对/相对输出路径');
  const inBytes = readFileSync(String(args.ipa));
  const inSha256 = sha256Hex(inBytes);
  const inEntries = readZipEntries(inBytes);
  const mainEntry = findMainBinaryEntry(inEntries, args.app ? String(args.app) : '');
  const mainName = mainEntry.name;
  const inSnapshot = inEntries.map(e => ({ name: e.name, method: e.method, versionMadeBy: e.versionMadeBy, externalAttr: e.externalAttr, mtime: e.mtime, mdate: e.mdate, raw: e.raw }));
  const pristine = readEntryData(mainEntry);          // 官方原始主二进制（对照用，永不改写）
  const buf = Buffer.from(pristine);                  // 就地改写的工作副本
  console.log(`  ${args.ipa}：${inBytes.length} B / ${inEntries.length} entries / sha256 ${inSha256}`);
  console.log(`  主二进制 ${mainName}：${pristine.length} B / sha256 ${sha256Hex(pristine)}`);

  const mhIn = assertOfficialInput(A, pristine);
  A.check(`目标 authority 长度 = ${ENDPOINT_LENGTH}（冻结地址 ${HOST}:${PORT} / 分工文档 §C2）`,
    HOST_PORT.length === ENDPOINT_LENGTH, `${HOST_PORT} = ${HOST_PORT.length} 字符（期望 ${ENDPOINT_LENGTH}）`);
  const scan = scanTargets(pristine, { includeBare: false });
  const minLen = minReplacementLength(HOST_PORT);
  const tooShortSites = scan.sites.filter(s => s.length < minLen);
  const rewriteableSites = scan.sites.filter(s => s.length >= minLen);
  A.check(`官方站点统计：总 ${OFFICIAL_SITE_TOTAL} = 可改写 ${OFFICIAL_SITE_REWRITEABLE} + 过短 ${OFFICIAL_SITE_TOO_SHORT}`,
    scan.sites.length === OFFICIAL_SITE_TOTAL && rewriteableSites.length === OFFICIAL_SITE_REWRITEABLE && tooShortSites.length === OFFICIAL_SITE_TOO_SHORT,
    `实测 总 ${scan.sites.length}：可改写 ${rewriteableSites.length} / 过短 ${tooShortSites.length}（最短站点 ${Math.min(...scan.sites.map(s => s.length))} B < 目标 ${minLen} B ⇒ 跳过不缩短）`);
  const premiseIn = countOccurrences(pristine, PREMISE_ENDPOINT);
  A.check(`任务单前提复核：${PREMISE_ENDPOINT} 在官方件里 0 处`, premiseIn === 0,
    `实测 ${premiseIn} 处（该字样只属于第三方已打补丁的产物，官方件没有）`);
  const pair = findSchemeHostPair(pristine);
  A.check(`ABC 池条目对唯一且偏移 = ${hex(ABC_API_PAIR_OFFSET)}`,
    !!pair && pair.occurrences === 1 && pair.offset === ABC_API_PAIR_OFFSET && pair.totalBytes === OFFICIAL.abcPairBytes,
    pair ? `offset=${hex(pair.offset)} occurrences=${pair.occurrences} totalBytes=${pair.totalBytes}` : `未找到 ${ABC_API_SCHEME} + ${ABC_API_HOST}`);
  A.check('输入 0xb00c = 0xb9000109（启动 guard 签名）', pristine.readUInt32LE(0xb00c) === 0xb9000109,
    `${hex(pristine.readUInt32LE(0xb00c))}`);

  progress('原地改写端点 URL + ABC 池 API 基址 + 六项功能补丁 + 解除 guard');
  const r = patchBuffer(buf);
  const blk = patchBlock(buf);
  const guards = deguardBuffer(buf, GUARD_MODE);
  const abc = applyApiBaseRewrite(buf, { hostPort: HOST_PORT });
  const tip = patchFirstLoginTip(buf);
  const dlg = patchLoginDialog(buf);
  const wel = patchWelcomeBanner(buf);
  const agr = patchAgreementDialogs(buf);
  const bid = patchBundleIdCheck(buf);
  if (blk.blocked) console.log(`已屏蔽 ${blk.blocked} 个外部请求 -> 死循环（零外部流量）: ${blk.hosts.join(', ')}`);
  console.log(tip ? '  已抑制实名提示 (shouldShowFirstLoginTip -> NO)' : '  [!] 实名提示补丁签名不匹配 —— 已跳过');
  console.log(dlg === 3 ? '  已跳过全新安装登录弹窗（强制自动登录，3/3 分支已 NOP）' : `  [!] 登录弹窗补丁仅匹配 ${dlg}/3 分支 —— 已跳过`);
  console.log(wel === 3 ? '  已抑制欢迎入园横幅 (LTLoginManager showWelcomeView: + 2 处，3/3)' : `  [!] 欢迎横幅补丁仅匹配 ${wel}/3 处 —— 已跳过`);
  console.log(agr===0 ? '  协议弹窗保持原样' : ('  已跳过使用许可协议' + (agr>=3 ? ' + 隐私政策弹窗' : '') + ` [${agr} 处]`));
  console.log(bid ? '  sub_100312230 -> return 0（跳过 Bundle ID 资源校验，多开安全）' : '  [!] Bundle ID 校验补丁签名不匹配 —— 已跳过');
  console.log(abc.applied ? `  ABC 池 API 基址（DevConfig_gf_ios.apiServer）-> ${abc.apiBase}（${abc.totalBytes} B 守恒 @${hex(abc.offset)}）` : `  [!] ABC 池改写未生效：${abc.reason}`);
  if (args['crash-longjmp'] && buf.readUInt32LE(0x57d834c) === 0xb0005190) { buf.writeUInt32LE(0xd4200000, 0x57d834c); console.log('  [诊断] _longjmp 桩 -> BRK'); }
  const res = assertPatchResults(A, { r, blk, guards, abc, tip, dlg, wel, agr, bid, buf, pristine, mhIn, rewriteable: rewriteableSites.length });
  console.log(`已改写 ${r.patched} 个 URL 常量 -> ${TARGET}`);
  console.log(`已清除 ${guards} 个故意中止 guard（0xDEADBEEF 空写入）`);
  if (r.skipped.length) console.log(`已跳过（${r.skipped.length} 个不重要，太短）: ` + r.skipped.slice(0, 8).join(', '));

  if (A.failed.length) {
    // 阶段一就失败：**不写出产物**，只留报告（避免"带伤的包"流到装机环节）
    writeBuildReport(String(OUT), {
      task: 'P10-A / A1b iOS IPA 补丁构建报告', phase: 'pre-write（未写出产物）',
      tool: 'client-patch/build/patch-ipa.mjs', generatedAt: new Date().toISOString(),
      input: { ipa: args.ipa, bytes: inBytes.length, sha256: inSha256, entries: inEntries.length },
      binary: { entry: mainName, bytes: pristine.length, sha256Before: sha256Hex(pristine), sha256After: sha256Hex(buf) },
      assertions: A.list, ok: false,
    });
    finishAssertions(A, { outPath: OUT, wroteOutput: false });
  }

  progress('回写 IPA（逐条保留 method/versionMadeBy/externalAttr，替代 jar uf0）');
  const replaced = replaceEntryData(inEntries, mainName, buf);
  const outBytes = writeZipEntries(inEntries);
  console.log(`  主二进制重新 deflate：${replaced.compressedBytes} B（沿用 method=${replaced.method}）`);
  console.log(`  产出 IPA：${outBytes.length} B（输入 ${inBytes.length} B，差 ${inBytes.length - outBytes.length} B）`);
  if (DRY_RUN) console.log('  [DRY-RUN] 未写出任何文件；回读断言不执行');
  else writeFileSync(String(OUT), outBytes);

  progress('回读产出 IPA 逐条断言');
  let readback = null;
  if (DRY_RUN) {
    console.log('  [DRY-RUN] 跳过');
  } else {
    const outBytes2 = readFileSync(String(OUT));
    const outEntries = readZipEntries(outBytes2);
    const outMain = outEntries.find(e => e.name === mainName);
    const outBin = readEntryData(outMain);
    const outBinSha = sha256Hex(outBin);
    A.check('回读：主二进制与内存补丁结果逐字节一致（sha256）', outBinSha === sha256Hex(buf), `sha256 ${outBinSha}`);
    A.check(`回读：主二进制长度不变 = ${OFFICIAL.binBytes} B`, outBin.length === OFFICIAL.binBytes, `${outBin.length} B`);
    const rbResidue = countRewriteableUrlSites(outBin, { hostPort: HOST_PORT });
    A.check('回读：可改写旧站点残留 = 0 处', rbResidue === 0, `残留 ${rbResidue} 处`);
    const rbEndpoints = countOccurrences(outBin, HOST_PORT);
    A.check(`回读：新端点 = ${OFFICIAL.endpointOccurrencesAfter} 处`, rbEndpoints === OFFICIAL.endpointOccurrencesAfter, `实测 ${rbEndpoints} 处`);
    const rbAbc = outBin.toString('latin1', ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes);
    A.check(`回读：ABC 池 API 基址已改写（${OFFICIAL.abcPairBytes} B 守恒）`, rbAbc === abc.newBytes, JSON.stringify(rbAbc));
    A.check('回读：guard NOP 已落盘', GUARD_MODE !== 'launch' || outBin.readUInt32LE(0xb00c) === NOP_INS, `0xb00c = ${hex(outBin.readUInt32LE(0xb00c))}`);
    const mhRb = parseMachOHeader(outBin);
    A.check('回读：ncmds / sizeofcmds 不变', mhRb.ncmds === OFFICIAL.ncmds && mhRb.sizeofcmds === OFFICIAL.sizeofcmds, `ncmds=${mhRb.ncmds} sizeofcmds=${mhRb.sizeofcmds}`);
    const attrBad = [], rawBad = [];
    if (outEntries.length !== inSnapshot.length) attrBad.push(`entry 数 ${outEntries.length} != ${inSnapshot.length}`);
    for (let i = 0; i < inSnapshot.length && i < outEntries.length; i++) {
      const a = inSnapshot[i], b = outEntries[i];
      if (a.name !== b.name || a.method !== b.method || a.versionMadeBy !== b.versionMadeBy || a.externalAttr !== b.externalAttr || a.mtime !== b.mtime || a.mdate !== b.mdate) attrBad.push(b.name);
      if (a.name !== mainName && !a.raw.equals(b.raw)) rawBad.push(b.name);
    }
    A.check('回读：entry 数与逐条属性保持不变（method/versionMadeBy/externalAttr/mtime/mdate）', attrBad.length === 0,
      attrBad.length ? attrBad.slice(0, 3).join(', ') : `${outEntries.length} 条全部保留`);
    A.check(`回读：未改动 entry 逐字节相同 ${inSnapshot.length - 1}/${inSnapshot.length}`, rawBad.length === 0,
      rawBad.length ? `${rawBad.length} 条不同：${rawBad.slice(0, 3).join(', ')}` : '除主二进制外全部原样搬运（jar uf0 会重写整包，这就是它的坑）');
    A.check('回读：主二进制 entry 属性 = method 8 / madeBy 0x1300 / externalAttr 0x81ed0000 / mode 0o100755',
      outMain.method === OFFICIAL.mainEntryAttrs.method && outMain.versionMadeBy === OFFICIAL.mainEntryAttrs.versionMadeBy &&
      outMain.externalAttr === OFFICIAL.mainEntryAttrs.externalAttr && unixMode(outMain) === OFFICIAL.mainEntryAttrs.unixMode,
      `method=${outMain.method} madeBy=${hex(outMain.versionMadeBy)} host=${madeByHost(outMain)} externalAttr=${hex(outMain.externalAttr)} mode=0o${unixMode(outMain).toString(8)}`);
    let crcOk = 0; const crcBad = [];
    for (const entry of outEntries) {
      try {
        const data = readEntryData(entry);
        if (data.length === entry.usize && crc32(data) === entry.crc) crcOk++; else crcBad.push(entry.name);
      } catch (error) { crcBad.push(`${entry.name}(${error.message})`); }
    }
    A.check(`回读：整包 ${outEntries.length} 条 entry CRC 交叉校验`, crcBad.length === 0 && crcOk === outEntries.length,
      `通过 ${crcOk}/${outEntries.length}${crcBad.length ? `；失败 ${crcBad.slice(0, 3).join(', ')}` : ''}`);
    A.check('输入 IPA 未被改动（sha256 与读取时一致）', sha256Hex(readFileSync(String(args.ipa))) === inSha256, inSha256);
    readback = { ipa: String(OUT), bytes: outBytes2.length, sha256: sha256Hex(outBytes2), entries: outEntries.length, binSha256: outBinSha, crcOk };
  }

  progress('写构建报告');
  const report = {
    task: 'P10-A / A1b —— iOS「纯改 IPA」线补丁构建报告（基线 patch-ipa.mjs 重基线后）',
    phase: 'complete', tool: 'client-patch/build/patch-ipa.mjs', generatedAt: new Date().toISOString(),
    argv: process.argv.slice(2), dryRun: DRY_RUN,
    input: { ipa: String(args.ipa), bytes: inBytes.length, sha256: inSha256, entries: inEntries.length },
    output: readback,
    binary: { entry: mainName, bytes: pristine.length, sha256Before: sha256Hex(pristine), sha256After: sha256Hex(buf) },
    official: {
      expectedBinSha256: OFFICIAL.binSha256, expectedBinBytes: OFFICIAL.binBytes,
      expectedNcmds: OFFICIAL.ncmds, expectedSizeofcmds: OFFICIAL.sizeofcmds,
      matched: sha256Hex(pristine) === OFFICIAL.binSha256,
    },
    premise: {
      claim: `任务单：官方件里 ${PREMISE_ENDPOINT} 出现 137 处，恰好 18 字符`,
      checked: PREMISE_ENDPOINT, occurrencesInInput: premiseIn,
      verdict: '官方包内不存在该字面量；137 处属于第三方已打过补丁的产物（其形态 http://0000000@…:7001）',
      officialSiteStats: { urlSites: scan.sites.length, rewriteable: rewriteableSites.length, tooShortSkipped: tooShortSites.length, lengthHistogram: scan.lengthHistogram },
    },
    endpoint: { mode: 'url', to: String(HOST), port: String(PORT), toAuthority: TARGET, authorityLength: HOST_PORT.length, expectedLength: ENDPOINT_LENGTH },
    apiBase: {
      enabled: true, applied: abc.applied, schemeHost: `${ABC_API_SCHEME} + ${ABC_API_HOST}`,
      expectedOffset: hex(ABC_API_PAIR_OFFSET), offset: hex(abc.offset || 0), totalBytes: abc.totalBytes,
      newBytes: abc.newBytes, apiBaseUrl: abc.apiBase, reason: abc.reason,
    },
    guard: { mode: GUARD_MODE, offset: hex(0xb00c), applied: guards, expected: GUARD_MODE === 'launch' ? 1 : null },
    patches: {
      urlRewritten: r.patched, urlSkippedTooShort: r.skipped.length, sohuBlocked: blk.blocked, sohuHosts: blk.hosts,
      firstLoginTip: tip, loginDialog: dlg, welcomeBanner: wel, agreementDialogs: agr, bundleIdCheck: bid,
      agreement: PATCH_AGREEMENT, privacy: PATCH_PRIVACY,
    },
    counts: {
      urlSites: scan.sites.length, urlSitesRewriteable: rewriteableSites.length, urlSitesTooShort: tooShortSites.length,
      rewritten: r.patched, skipped: r.skipped.length, residueRewriteable: res.residue,
      postOldOccurrences: res.residue, postEndpointOccurrences: res.postEndpoints,
    },
    changedBytes: res.changedBytes, changedRanges: res.actual.map(hexRange), declaredNetworkWindows: res.windows.length,
    assertions: A.list, ok: A.failed.length === 0,
  };
  const reportInfo = writeBuildReport(String(OUT), report);
  console.log(`  ${reportInfo.file}（${reportInfo.bytes} B，${A.passed.length} PASS / ${A.failed.length} FAIL）`);
  finishAssertions(A, { outPath: OUT, wroteOutput: !DRY_RUN });
  console.log(`DONE  ${OUT}  (host=${HOST}:${PORT}; 重签: Sideloadly 用你的 Apple ID 安装时会重新签名补丁后的二进制)`);
}
