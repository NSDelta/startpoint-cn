#!/usr/bin/env node
// 世界弹射物语 iOS (AIR AOT) IPA 补丁工具 —— iOS 版 patch-apk.mjs
//
// ★ 本文件是 iOS 补丁线的**基线脚本**（服主提供，原用于在服务端打包出可安装的 IPA）。
//   后续所有 iOS 补丁工具都**基于本文件增改**，不要另起炉灶重写：里面的功能补丁地址
//   （实名提示 / 全新安装登录弹窗 / 欢迎横幅 / 使用许可协议+隐私政策门 / Bundle ID 资源校验 /
//   sohu 外发屏蔽）与 guard 处理都是**真机验证过**的，重写会丢掉这些能力。
//   B0 期间临时写的 `patch-ios-ipa.mjs` 需按本文件重做基线（合并清单见分工文档 §4-P10-A1）。
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

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
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

if (args.bin) {
  // 测试模式：直接补丁裸 Mach-O 文件
  const buf = readFileSync(args.bin);
  const r = patchBuffer(buf);
  const blk = patchBlock(buf);
  const guards = deguardBuffer(buf, GUARD_MODE);
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
  if (args['crash-longjmp'] && buf.readUInt32LE(0x57d834c) === 0xb0005190) { buf.writeUInt32LE(0xd4200000, 0x57d834c); console.log('  [诊断] _longjmp 桩 -> BRK'); }
  writeFileSync(OUT, buf);
  console.log(`已改写 ${r.patched} 个 URL 常量 -> ${TARGET}`);
  console.log(`已清除 ${guards} 个故意中止 guard（0xDEADBEEF 空写入）`);
  if (r.skipped.length) console.log(`已跳过（太长，${r.skipped.length} 个）: ` + r.skipped.slice(0, 12).join(', '));
  console.log('DONE  ' + OUT);
} else {
  // IPA 模式：复制 IPA -> jar x 解出 Mach-O -> 补丁 -> jar uf0 写回（store 存储）。
  const { execFileSync } = await import('node:child_process');
  const TOTAL = 4; let step = 0;
  const progress = (label) => {
    const m = `STEP ${++step}/${TOTAL} ${label}`;
    process.stdout.write(m + String.fromCharCode(10));
    return m;
  };
  const RES = args.res || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'resources');
  const JAR = args.jar || path.join(RES, 'jdk', 'bin', 'jar.exe');
  if (!existsSync(JAR)) fail(`找不到 jar.exe：${JAR}(用 --jar= 指定)`);
  const WORK = args.work || path.join(os.tmpdir(), 'wf-ipa-patch');
  rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
  progress('复制 IPA');
  const ipaCopy = path.join(WORK, 'in.ipa');
  copyFileSync(args.ipa, ipaCopy);
  progress('解出原生二进制');
  const ex = path.join(WORK, 'ex'); mkdirSync(ex, { recursive: true });
  execFileSync(JAR, ['xf', ipaCopy, MACHO_REL], { cwd: ex });
  const binPath = path.join(ex, MACHO_REL);
  if (!existsSync(binPath)) fail('IPA 内找不到 Mach-O：' + MACHO_REL);
  progress('改写端点 URL + 解除防重签 guard');
  const buf = readFileSync(binPath);
  const r = patchBuffer(buf);
  const blk = patchBlock(buf);
  const guards = deguardBuffer(buf, GUARD_MODE);
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
  if (args['crash-longjmp'] && buf.readUInt32LE(0x57d834c) === 0xb0005190) { buf.writeUInt32LE(0xd4200000, 0x57d834c); console.log('  [诊断] _longjmp 桩 -> BRK'); }
  writeFileSync(binPath, buf);
  console.log(`已改写 ${r.patched} 个 URL 常量 -> ${TARGET}`);
  console.log(`已清除 ${guards} 个故意中止 guard（0xDEADBEEF 空写入）`);
  if (r.skipped.length) console.log(`已跳过（${r.skipped.length} 个不重要，太短）: ` + r.skipped.slice(0, 8).join(', '));
  progress('重组 IPA');
  copyFileSync(ipaCopy, OUT);
  execFileSync(JAR, ['uf0', path.resolve(OUT), MACHO_REL], { cwd: ex });
  rmSync(WORK, { recursive: true, force: true });
  console.log(`DONE  ${OUT}  (host=${HOST}:${PORT}; 重签: Sideloadly 用你的 Apple ID 安装时会重新签名补丁后的二进制)`);
}
