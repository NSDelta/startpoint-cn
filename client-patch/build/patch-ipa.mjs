#!/usr/bin/env node
// 世界弹射物语 iOS (AIR AOT) IPA 补丁工具 —— iOS 版 patch-apk.mjs
//
// ★ 本文件是 iOS 补丁线的**基线脚本**（服主提供，原用于在服务端打包出可安装的 IPA），
//   也是 A1b 重基线后**唯一入口**：后续所有 iOS 补丁工具都**基于本文件增改**，不要另起炉灶
//   重写：里面的功能补丁地址（实名提示 / 全新安装登录弹窗 / 欢迎横幅 / 使用许可协议+隐私政策门 /
//   Bundle ID 资源校验 / sohu 外发屏蔽）与 guard 处理都是**真机验证过**的，重写会丢掉这些能力。
//   B0 期间临时写的那个 iOS 派生脚本已在 A1b 重基线时**并入本文件**，并且**已从仓库删除**
//   （`tools/ios_ipa_patch.test.cjs` 的 CLI 用例现在指向本文件）⇒ 本文件是唯一入口。
//   合并清单见分工文档 §4-P10-A1b，验收数字见 D:\wfcnmod\报告-P10-A-iOS.md。
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
//   ③ lib/zip-ipa.mjs 取代 `jar uf0`：**不再依赖外部 `jar`/JDK**，整个回写在 Node 进程内完成，
//      并且能逐条回读校验（CRC 交叉校验 + 未改动 entry 逐字节比对 + entry 属性比对）。
//      ⚠️ 实测勘误（P10-A，2026-09）：任务书里「`jar uf0` 会把整包写成 STORED / 丢 0o100755 /
//      madeBy=0x000a ⇒ AltStore 报 invalid format」这一条，在 B0 的 `jar` 产物上**不复现** ——
//      B0 产物与官方件逐条比对 3568 个 entry，method/versionMadeBy/externalAttr/mtime 差异为 **0**。
//      所以换掉 jar 的真实理由是上面的三条工程收益，**不是**修好了 AltStore；
//      没有任何证据表明 AltStore 拒绝由 jar 造成（B0 产物的真实缺陷是漏了六项功能补丁，见 ②）。
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
//   ★ A1b 修正：上面这段是 B0 期的理解。实测（见 ①）运行期的 API 基址来自 ABC 池里
//     `Custom("https","shijtswygamegf.leiting.com")` 那一对条目 ⇒ 只改 `__cstring` 站点不够，
//     所以现在两条路都改（cstring 站点 + ABC 常量池对），并各自带长度守恒断言。
//
// 补丁后 Mach-O 签名失效 —— IPA 必须重签（Sideloadly 用你的 Apple ID 安装时自动完成，
// 对补丁后的二进制重新哈希）。cryptid=0（解密 dump）确认可重签。
//
// 用法: node patch-ipa.mjs --ipa=in.ipa --host=192.168.x.x --port=8001 --out=out.ipa
//        node patch-ipa.mjs --bin=worldflipper --host=... --port=... --out=patched.bin
//      空格分隔形式同样支持（`--ipa in.ipa --host 192.168.x.x`）—— A1b 新增，见下方 ARGV 规范化。
//      其它: --guard-mode=launch|all|none（默认 all；联调 SOP 用 launch）
//            --endpoint=rewrite|none（默认 rewrite）—— **越狱线开关**，见下方「端点模式」段
//            --sohu-block=false 关闭 sohu 外发屏蔽（六项功能补丁 ⑥，它也是"改 URL"）
//            --agreement=false / --privacy=false 关闭协议门补丁
//            --app=<App 名> 显式指定 Payload/<App>.app/<App>（默认自动探测）
//            --dry-run 只算不写（不产出 IPA，回读断言不执行）
//            --allow-foreign-base 显式豁免"输入基座指纹前置校验"（仅合成夹具 / 测试用，见下）
//      旧参数 --jar= / --res= / --work= 已随 jar 一起废弃（无人使用则忽略）。
//
// ★★ 输入基座指纹前置校验（吸收 wfcore tools/patch-ipa.mjs:100-114 的「补丁纪律」）：
//   在**真正写入任何字节之前**，校验输入 IPA 与主二进制的 sha256 + 字节数是否等于官方 iOS 1.8.4 基线。
//   为什么前置而不是"打完再断言"：一份第三方已打过补丁的产物（例如 sha256 5c0b67e0… 那份）本身就是
//   被改写过的基座，在它上面再打一遍会得到"看似成功、实际双重补丁"的包 —— 而既有断言全部是**正向**
//   断言（改了多少处、长度没变），它们无法识别"基座本身就不对"。所以这里做成一道**独立的闸**：
//   · 一致 ⇒ 打印 `输入基座指纹 ✓ …`，不新增任何断言（保持既有 PASS 计数与措辞逐字不变）；
//   · 不一致且未豁免 ⇒ 打印逐条 `… 字节数/sha256 不匹配 expected=… actual=…` 并 `process.exit(1)`，
//     **一个字节都不写**（此时连 build-report 都不产出，因为没有可信的构建结果可记录）；
//   · 不一致但显式 `--allow-foreign-base` ⇒ 只 WARN + 新增 1 条断言（证明"本次豁免了校验"），
//     供合成夹具的端到端测试使用。
//   注意：`--bin` 路径与 `--ipa` 路径**都**过这道闸；`--bin` 时没有整包 IPA 可比，只校验主二进制。
//
// ★ 端点模式（R27：iOS 补丁只允许一条代码路径，所以越狱线不再另写脚本）：
//   · `--endpoint=rewrite`（默认）＝ 既有行为，一个字节都不变：改 `__cstring` 站点 + ABC 常量池。
//   · `--endpoint=none` ＝ 越狱线：**跳过 ABC 常量池改写与全部 `__cstring` URL 站点改写**，
//     URL 交给越狱 dylib 在运行期接管。此时 `--host/--port` **不再必需**（给了也只 warn、不改一字节）。
//   两种模式下六项功能补丁与 `--guard-mode` 完全一致（`none` 只是不碰 URL，不是"什么都不打"）。
//   ⚠️ `--endpoint=none` **不等于**当年那份临时脚本 `D:\wfcnmod\tmp\make-jb-ipa.mjs` 的产物：
//     那个脚本只做 deguard（`all` 分支）+ 回写，六项功能补丁一个都没打；本开关刻意保留六项功能补丁
//     （它们才是"去闪退 / 不弹窗"的主线），且 SOP 用 `--guard-mode=launch`（脚本走的是 `all`）。
//     要严格做到"连 sohu 那个 URL 都不动"，再叠加 `--sohu-block=false`。
//   `none` 模式不是靠把旧断言 `if` 掉，而是**新增正向断言**：__cstring 站点逐点与基线比对、ABC 池
//   区域 sha256 与基线一致、官方域名出现次数 = 基线值、新端点出现次数 = 0、且"官方站点窗口 + ABC
//   池窗口内零字节改动"（逐字节证明）。

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// ── A1b 新增依赖（全部零外部包，只用 node 内置 + 本目录 lib/）──
import {
  ENDPOINT_LENGTH, OFFICIAL_HOST_SUFFIXES, OFFICIAL_SITE_REWRITEABLE, OFFICIAL_SITE_TOO_SHORT, OFFICIAL_SITE_TOTAL,
  PREMISE_ENDPOINT, byteDiffRanges, countOccurrences, countRewriteableUrlSites, diffRanges, mergeRanges,
  minReplacementLength, rangesEqual, scanTargets,
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
// 端点模式：rewrite（默认＝既有行为：改 __cstring 站点 + ABC 常量池）| none（越狱线：一个 URL 都不动）
const ENDPOINT_MODE = args.endpoint === undefined ? 'rewrite' : String(args.endpoint).toLowerCase();
const REWRITE_ENDPOINT = ENDPOINT_MODE === 'rewrite';
// sohu 外发屏蔽（六项功能补丁 ⑥）本身也改一个 URL；默认 true 保持既有行为，要"一个 URL 都不动"时显式 --sohu-block=false
const PATCH_SOHU = args['sohu-block'] !== 'false' && args['sohu-block'] !== false;
const fail = m => { console.log('ERROR ' + m); process.exit(1); };
if (ENDPOINT_MODE !== 'rewrite' && ENDPOINT_MODE !== 'none') fail(`--endpoint 只接受 rewrite|none（收到 ${JSON.stringify(args.endpoint)}）`);
if (!OUT || (!args.ipa && !args.bin)) fail('需要 --ipa(或 --bin) --out');
if (REWRITE_ENDPOINT && (!HOST || !PORT)) fail('需要 --ipa(或 --bin) --host --port --out');
if (!REWRITE_ENDPOINT && (HOST || PORT)) console.log(`WARN --endpoint=none：已忽略 --host/--port（${HOST || '-'}:${PORT || '-'}），本模式不改写任何 URL`);

// A1c 新增：输入基座指纹前置校验的**显式豁免开关**。默认 false ⇒ 不是官方 1.8.4 基座就直接拒绝出包。
// 只有合成夹具 / 单元测试才该传它；它**不**放宽 assertOfficialInput 那几条既有断言（那些在 --bin 路径上另有
// 各自的措辞与计数要求），只负责打开"前置拒绝"这道闸。详见下方「输入基座指纹」段。
const ALLOW_FOREIGN_BASE = args['allow-foreign-base'] === true;

const HOST_PORT = `${HOST}:${PORT}`;                // e.g. 192.168.1.10:8001（示例值必须是 hygiene 白名单里的 192.168.1.10，勿改成真实局域网 IP）
const TARGET = REWRITE_ENDPOINT ? `http://${HOST_PORT}` : null;   // replacement scheme+authority (e.g. 26 bytes)；none 模式无目标端点
// 站点直方图的"统计用 hostPort"：none 模式没有目标端点，用 ENDPOINT_LENGTH 个占位字符复算 150/137/13 的站点分类，
// 它只进 minReplacementLength()，绝不参与任何写入；rewrite 模式下恒等于 HOST_PORT ⇒ 零行为变化。
const STAT_HOST_PORT = (HOST && PORT) ? HOST_PORT : '0'.repeat(ENDPOINT_LENGTH);
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
// 幂等三态用的"已经是目标态"探针：前次跑法把 authority 原地改成了 `http://000…@127.0.0.1:1`
// （或 deficit===0 时的裸 `http://127.0.0.1:1`）。这些站点已不再匹配 BLOCK_RE，必须单独认出来，
// 否则「已屏蔽」会被当成「命中 0 处 = 真不匹配」。
const BLOCKED_RE = /https?:\/\/0*@?127\.0\.0\.1:1/g;
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
  // `s` 是改写前的快照 ⇒ 这里数到的只可能是**本来就已是**死循环地址的站点（幂等重跑的痕迹）。
  const alreadyBlocked = (s.match(BLOCKED_RE) || []).length;
  return { blocked, hosts: [...hosts], alreadyBlocked };
}

// 清除应用故意的"致命中止"模式 —— 重签后在启动时崩溃（完整性/权限校验）。
// 模式：MOVZ X8,#0 (0xd2800008)，然后在 3 条指令内对 [X8] 写（向地址 0 写入 0xDEADBEEF =
// 故意崩溃，iOS 从不映射第 0 页）。我们 NOP 掉 store，中止变成空操作，执行继续。
// 只匹配刚清零 X8 后的 store → 不会误伤正常写操作。
// mode: 'launch' = 仅 NOP 0xb00c 处启动计时器 guard（最小改动，已验证不破坏 AIR 加载）;
//        'all' = NOP 每个安全回退的中止点; 'none' = 跳过。
/** 从 strOff 往后找「安全回退」：6 词内出现 RET 或尾 B 才算安全（A1c 从 deguardBuffer 提出，
 *  供 collectGuardSites 与 deguardBuffer 共用 —— 两边必须给出同一结论，否则站点计数会对不上）。 */
function safeFallthroughAt(buf, strOff) {
  for (let j = 1; j <= 6; j++) {
    const w = buf.readUInt32LE(strOff + 4 * j);
    if (w === RET_INS) return true;
    if ((w & 0xFC000000) >>> 0 === 0x14000000) return true;   // B (tail branch)
    if ((w >>> 24) === 0xa8 || (w >>> 24) === 0xa9) continue;  // LDP epilogue → keep scanning
  }
  return false;
}

function deguardBuffer(buf, mode, collector = null) {
  if (mode === 'none') return 0;
  if (mode === 'launch') {                    // only the launch guard — avoid disturbing content-load
    const site = { ...EXPECTED_LAUNCH_GUARD, actual: buf.readUInt32LE(EXPECTED_LAUNCH_GUARD.offset) };
    if (collector) collector.write = (s) => { if (s.actual !== EXPECTED_LAUNCH_GUARD.expect) return false; buf.writeUInt32LE(NOP_INS, EXPECTED_LAUNCH_GUARD.offset); return true; };
    if (collector) return collector.hit(site) ? 1 : 0;
    if (buf.readUInt32LE(0xb00c) === 0xb9000109) { buf.writeUInt32LE(NOP_INS, 0xb00c); return 1; }
    return 0;
  }
  const NOP = NOP_INS, RET = RET_INS; let n = 0, skipped = 0; const len = buf.length & ~3;
  const isStoreToX8 = isStoreToX8Signature;
  // Only NOP an abort whose fall-through is SAFE: a RET (or unconditional B) appears within a few
  // words after the store. NOPping an abort with code after it would run that code with the bad
  // state the abort guarded against — risking exactly the black-screen we're chasing.
  const safeFallthrough = (strOff) => safeFallthroughAt(buf, strOff);
  for (let o = 0; o + 28 <= len; o += 4) {
    if (buf.readUInt32LE(o) !== 0xd2800008) continue;       // MOVZ X8,#0
    for (let k = 1; k <= 3; k++) {
      const w = buf.readUInt32LE(o + 4 * k);
      if (isStoreToX8(w)) {
        const strOff = o + 4 * k, safe = safeFallthrough(strOff);
        if (collector) collector.write = (s) => { if (!s.safeFallthrough) return false; buf.writeUInt32LE(NOP, strOff); return true; };
        if (collector) {
          if (collector.hit({ kind: 'scan', offset: strOff, movzOffset: o, expect: w, want: NOP, actual: w, safeFallthrough: safe })) n++;
          else if (!safe) { skipped++; collector.skip({ kind: 'scan', offset: strOff, movzOffset: o, expect: w, want: NOP, actual: w, reason: '不安全回退（store 后 6 词内无 RET/尾 B）' }); }
        } else if (safe) { buf.writeUInt32LE(NOP, strOff); n++; }
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
  return satisfiedWords(buf, 0x6ae0dc, 0xa9bd57f6, [0x52800000, 0xd65f03c0], 'shouldShowFirstLoginTip');
}

// 全新安装时跳过雷霆登录弹窗（无已存凭证）。SDK 的登录决策（sub @0x68e7xx）在 token
// 为 nil/空/"(null)" 时弹出对话框 (homeViewWithCallbackCancel:)；否则走自动登录路径
// (checkLogin:callback:)，我们的模拟服务器接受任意凭证。NOP 掉 3 个弹窗跳转分支，
// 新启动直接进入自动登录 → 游客登录成功，无弹窗。已内存验证：新状态到达 handleLoginSuccess，
// 无弹窗、无崩溃。对正常（已有 token）情况安全：有真实 token 时这些分支永远不触发。
// 每处用指令签名守卫 (cbz/cbnz 编码)，避免错误修改。
function patchLoginDialog(buf) {
  const sites = [[0x68e878, 0xb4000820], [0x68e898, 0xb40006a0], [0x68e8d8, 0x35000538]];
  let n = 0;
  for (const [off, want] of sites) n += satisfiedWords(buf, off, want, NOP_INS, `loginDialog@${hex(off)}`);
  return n;   // 3 = fully applied（幂等重跑同样返回 3）
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
  n += satisfiedWords(buf, MAIN, 0xd10143ff, [0xd2800000, RET_INS], `welcomeBanner-main@${hex(MAIN)}`);   // mov x0,#0 ; ret
  // (2) also stub +[LTWelcomeView showWelcomeView:] (sub sp,#0x1c0 = 0xd10703ff) — a second banner
  // path; harmless defense-in-depth.
  const CLS = 0x64b238;
  n += satisfiedWords(buf, CLS, 0xd10703ff, [0xd2800000, RET_INS], `welcomeBanner-cls@${hex(CLS)}`);     // mov x0,#0 ; ret
  // (3) NOP the +[LTWelcomeView showWelcomeView:] call in the login-success path (0x634890).
  const CALL = 0x634890;
  n += satisfiedWords(buf, CALL, 0x9546daf4, NOP_INS, `welcomeBanner-call@${hex(CALL)}`);               // nop
  return n;   // 3 = all applied（幂等重跑同样返回 3）
}

// 修改 sub_100312230（AIR 启动流程），立即返回 0，跳过基于 Bundle Identifier
// 的资源查找。修改 CFBundleIdentifier 实现多开（TrollStore）时，AIR 的 Mach-O 解析器
// 无法找到新 Bundle ID 对应的资源 → SIGSEGV 崩溃。此补丁直接跳过该查找。
function patchBundleIdCheck(buf) {
  const OFF = 0x312230;
  // 序言签名: STP X28,X27,[SP,#-0x30]!  (0xa9bd6ffc)
  // 目标态：MOV X0,#0 ; RET ; NOP ; NOP（4 词一起判，避免"改了一半"被当成幂等）
  return satisfiedWords(buf, OFF, 0xa9bd6ffc, [0xd2800000, RET_INS, NOP_INS, NOP_INS], `bundleIdCheck@${hex(OFF)}`);
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
  if (PATCH_AGREEMENT) n += satisfiedWords(buf, EULA, 0x37000700, 0x14000038, `agreement-EULA@${hex(EULA)}`);
  // (B) privacy popup (ProtocolPrivacyPopView). SAFE approach = patch the "should I show privacy?"
  //     GATE predicates to return NO (already-agreed / returning-user path) so the caller never calls
  //     the show-funcs (0x68dd30/0x698b08) — which also register the boot observer/view-stack, so
  //     stubbing THEM broke boot networking. Returning NO from the gate = returning-user behavior
  //     (boots fine). Two BOOL predicates (prologue stp x20,x19,[sp,#-0x20]! = 0xa9be4ff4):
  //     -[LeitingSDK needShowPrivacy]@0x698990 and +[GDPRManage needShowPrivacyProtocolView]@0x60f15c.
  //     Gated behind --privacy until full-flow validated on the STANDALONE build.
  if (PATCH_PRIVACY) {
    for (const off of [0x698990, 0x60f15c]) {
      n += satisfiedWords(buf, off, 0xa9be4ff4, [0x52800000, RET_INS], `agreement-privacy@${hex(off)}`);   // mov w0,#0 ; ret
    }
  }
  return n;   // 0 = no agreement; 1 = EULA; 3 = EULA + both privacy gates (--privacy)（幂等重跑同值）
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
const RET_INS = 0xd65f03c0;                          // A1c：从 deguardBuffer 提出来共用，值不变
const STORE_TO_X8_MASKS = [0xB9000000, 0xF9000000, 0x39000000, 0x79000000];   // A1c：同上
/** store 到 X8（"写 0 到 x8 指向处"）的签名判定 —— 与 deguardBuffer 里那份**故意重复**：
 *  单一来源就无法交叉校验，重复才能发现"改了扫描条件忘了改断言"。 */
const isStoreToX8Signature = (w) => (((w >>> 5) & 31) === 8) && STORE_TO_X8_MASKS.includes((w & 0xFFC00000) >>> 0);
/** launch guard 的期望原指令（官方 1.8.4 基线）：0xb00c 处 MOV W9,#... 形态的启动守卫。 */
const EXPECTED_LAUNCH_GUARD = { offset: 0xb00c, expect: 0xb9000109, want: NOP_INS, kind: 'launch' };

/** 逐点「期望字节」fail-fast 校验：对 collectGuardSites() 收上来的每个站点，拿 pristine 的原值比对。
 *  返回格式照 wfcore tools/lib/patch.mjs:180-199 —— `原指令不匹配 file=0x… expected=0x… actual=0x…`。
 *  @param alreadyNop  Set<offset>：pristine 上**已经是目标值**的偏移（幂等重跑），这些不算不匹配。 */
function guardSiteMismatches(sites, verifyBytes, bufLen, alreadyNop = null) {
  const idle = alreadyNop instanceof Set ? alreadyNop : new Set();
  const bad = [];
  for (const s of sites) {
    if (idle.has(s.offset)) continue;
    if (s.offset + 4 > bufLen) { bad.push(`${s.kind}@${hex(s.offset)} 站点越界（文件 ${bufLen} B）`); continue; }
    const actual = verifyBytes.readUInt32LE(s.offset);
    if (actual !== s.expect) bad.push(`${s.kind} 原指令不匹配 file=${hex(s.offset)} expected=${hex(s.expect)} actual=${hex(actual)}`);
  }
  return bad;
}

/** A1c：把站点记录统一成同一套字段与进制，供 build-report 的三处数组共用。
 *  为什么需要它：改之前 `guardSites.sites` 用 `{offset:'0xb00c', actualBefore:'0x…'}`（hex 字符串），
 *  而 `guardSites.applied` / `skippedSites` 却是 `{offset:45068, actual:…}`（十进制数字）—— 同一份报告里
 *  两套口径，人读要换算、机器读要分支。统一后三处数组同构，且全部为 hex 字符串。 */
function normalizeSite(s) {
  return {
    kind: s.kind,
    offset: hex(s.offset),
    movzOffset: s.movzOffset === undefined || s.movzOffset === null ? null : hex(s.movzOffset),
    expect: hex(s.expect), want: hex(s.want),
    actualBefore: hex(s.actualBefore === undefined ? s.actual : s.actualBefore),
    applied: !!s.applied,
    safeFallthrough: s.safeFallthrough === undefined ? null : !!s.safeFallthrough,
    ...(s.reason ? { reason: s.reason } : {}),
  };
}

/** 扫描出**全部**将被 guard 处理的站点（只读，不改一个字节）—— 供断言/报告计数与逐点校验共用。 */
function collectGuardSites(pristine, mode) {
  if (mode === 'none') return [];
  if (mode === 'launch') return [{ ...EXPECTED_LAUNCH_GUARD, actual: pristine.readUInt32LE(EXPECTED_LAUNCH_GUARD.offset), applied: false }];
  const sites = [];
  const len = pristine.length & ~3;
  for (let o = 0; o + 28 <= len; o += 4) {
    if (pristine.readUInt32LE(o) !== 0xd2800008) continue;         // MOVZ X8,#0
    for (let k = 1; k <= 3; k++) {
      const w = pristine.readUInt32LE(o + 4 * k);
      if (isStoreToX8Signature(w)) {
        const off = o + 4 * k;
        sites.push({ kind: 'scan', offset: off, movzOffset: o, expect: w, want: NOP_INS, actual: w, applied: false, safeFallthrough: safeFallthroughAt(pristine, off) });
        break;
      }
      if ((w & 31) === 8) break;                                   // X8 被重载 → 不是空写
    }
  }
  return sites;
}

// ── 幂等三态（吸收 wfcore tools/lib/patch.mjs:191 `if (actual === value) continue;` 的纪律）──
// 为什么必须在**补丁器层**就分三态、而不是只在断言层放宽：断言层拿到的 `tip/dlg/…` 是"改了几处"，
// 一旦恒为 0 就与"明明不符却装作没事"（真 mismatch）不可区分 —— 那是把 fail-fast 换成静默放过。
// 三态把二者分开：`fresh` = 原值就是期望签名（真写）／`idle` = 原值**已经是目标字节**（幂等重跑，
// 一个字节都不写）／`bad` = 两者都不是（真不匹配，返回 0 ⇒ 既有断言照旧红）。
// 计数语义保持"**满足该站点约束的站点数**"：fresh 与 idle 同样 +1 ⇒ 新鲜跑法的 PASS 计数逐位不变；
// 同时 patch-ipa.mjs:462 那条站点级三态（== want 幂等 / == expect 新鲜 / 其余 mismatch）在此得到同一结论。
const PATCH_SITE_STATES = [];
const idleSitesIn = (...offsets) => PATCH_SITE_STATES.filter(s => s.state === 'idle' && offsets.includes(s.offset)).length;

/** 逐词三态判定 + 写入。@param fresh 期望的**原值**（新鲜签名）；@param target 幂等时允许的**现目标值**。 */
function satisfiedWords(buf, offset, fresh, target, label, kind = 'patch') {
  const targets = Array.isArray(target) ? target : [target];
  const words = Array.isArray(fresh) ? fresh : [fresh];
  // 边界按"要写多少个词"（targets）算，读判定也要覆盖全部 targets —— 与原实现 `OFF + 16 > buf.length` 同口径。
  if (offset + 4 * Math.max(words.length, targets.length) > buf.length) return 0;
  const now = targets.map((_, k) => buf.readUInt32LE(offset + 4 * k));
  // fresh：只校验签名词前缀（与原实现"只比签名词、然后整块写目标词"逐位等价）
  const isFresh = words.every((w, k) => now[k] === w);
  // idle：**全部**目标词都已是目标值才算幂等（改了一半 ⇒ bad，照旧红）
  const isIdle = targets.every((t, k) => now[k] === t);
  const state = isFresh ? 'fresh' : isIdle ? 'idle' : 'bad';
  PATCH_SITE_STATES.push({ label, kind, offset, state, now, expect: words, want: targets });
  if (state === 'fresh') {
    for (let k = 0; k < targets.length; k++) buf.writeUInt32LE(targets[k], offset + 4 * k);
    return 1;
  }
  return state === 'idle' ? 1 : 0;      // idle：约束已满足，保留计数；bad：真不匹配 ⇒ 照旧 0
}

/** deguardBuffer 的采集器：只记录"打算改哪、原值多少、改没改"，不参与任何写入判定。 */
function createGuardCollector(mode) {
  const sites = [], skippedSites = [];
  return {
    mode, sites, skippedSites, applied: 0, alreadyNop: 0,
    hit(site) {
      const applied = this.write && this.write(site);
      if (applied) { this.applied++; site.applied = true; } else { this.alreadyNop++; }
      sites.push({ ...site, actualBefore: site.actual, applied: !!applied });
      return applied;
    },
    /** 只登记、不写：供 collectGuardSites 之外的"已跳过"路径使用。 */
    note(site) { sites.push({ ...site, actualBefore: site.actual, applied: false }); },
    skip(site) { skippedSites.push({ ...site }); },
    summary() {
      const appliedList = sites.filter(s => s.applied);
      return {
        mode, sites, skippedSites, applied: appliedList,
        total: appliedList.length, skipped: skippedSites.length, sitesFound: sites.length,
        alreadyNop: sites.length - appliedList.length,
        mismatches: sites.filter(s => s.actualBefore !== s.want && s.actualBefore !== s.expect).map(s => s.offset),
      };
    },
  };
}


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

// --endpoint=none：ABC 池一个字节都不该动 ⇒ 干脆把它从**声明窗口**里摘掉。这不是放宽而是收紧：
// 计划窗口里没有它，任何写进 ABC 池的字节都会被下面的 stray/越界断言当场抓出来。
const FIXED_WINDOWS_NO_ENDPOINT = FIXED_WINDOWS.filter(([start]) => start !== ABC_API_PAIR_OFFSET);

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

/** 全部官方域名站点的窗口（过短站点也列进去：它们本来就不该被写，列进去反而是更强的约束）。 */
function officialAuthorityWindows(pristine) {
  return scanTargets(pristine, { includeBare: false }).sites.map(site => [site.offset, site.offset + site.length]);
}

/** sohu 站点的窗口（patchBlock 的写入范围）。 */
function sohuAuthorityWindows(pristine) {
  const windows = [];
  const text = pristine.toString('latin1');
  const re = new RegExp(BLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) windows.push([m.index, m.index + m[0].length]);
  return windows;
}

/** 全部域名站点 + sohu 站点的窗口（rewrite 模式的声明窗口；顺序与内容与既有实现逐字一致）。 */
function authorityWindows(pristine) {
  return [...officialAuthorityWindows(pristine), ...sohuAuthorityWindows(pristine)];
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

/** 只读探测：输入基座是否**已经是本工具的补丁后产物**（幂等重跑）。
 *  做法是在一份**拷贝**上跑一遍纯补丁函数、读站点三态，然后把站点台账回滚 —— 调用方缓冲区一个字节都不动。
 *  判定：有站点是 `idle`（原值已是目标字节）且**没有**站点是 `bad`（没有真不匹配）。
 *  只在 sha 与官方不一致、且显式 --allow-foreign-base 时才会被调用（官方基座零开销、零行为变化）。 */
function probeAlreadyPatched(buf) {
  const copy = Buffer.from(buf);
  const mark = PATCH_SITE_STATES.length;
  patchFirstLoginTip(copy); patchLoginDialog(copy); patchWelcomeBanner(copy);
  patchBundleIdCheck(copy); patchAgreementDialogs(copy);
  const states = PATCH_SITE_STATES.splice(mark, PATCH_SITE_STATES.length - mark);   // 取走 + 回滚台账
  return {
    total: states.length,
    idle: states.filter(s => s.state === 'idle').length,
    bad: states.filter(s => s.state === 'bad').length,
  };
}

/** 输入指纹断言（--bin 与 --ipa 两条路径共用）。 */
function assertOfficialInput(A, bin, label = '输入主二进制') {
  const binSha = sha256Hex(bin);
  const shaOk = binSha === OFFICIAL.binSha256;
  // 三态：`fresh` = 输入就是官方原始件（照旧 PASS，措辞逐字不变）；
  //        `idle` = 输入不是官方件、但**已经是补丁后目标态**且显式 --allow-foreign-base ⇒ 幂等重跑 PASS；
  //        `bad`  = 其余（真外来基座）⇒ 照旧 FAIL。
  // 不加 --allow-foreign-base 时一律不探测（保持"外来基座必须显式豁免"这条闸门不被绕过）。
  const idem = (!shaOk && ALLOW_FOREIGN_BASE) ? probeAlreadyPatched(bin) : null;
  const idemOk = !!idem && idem.bad === 0 && idem.idle > 0;
  A.check(`${label} = 官方 iOS 1.8.4 原始件（sha256 ${OFFICIAL.binSha256.slice(0, 16)}…）`,
    shaOk || idemOk,
    idemOk ? `幂等重跑：输入已是补丁后产物（实测 sha256 ${binSha}；站点 ${idem.idle}/${idem.total} 已是目标字节、0 处不匹配）`
      : `实测 sha256 ${binSha}`);
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
  const { r, blk, guards, abc, tip, dlg, wel, agr, bid, buf, pristine, mhIn, rewriteable, fprint, guardDetails } = ctx;
  if (REWRITE_ENDPOINT) {
    A.check('URL 站点改写数 = 可改写站点数', r.patched === rewriteable,
      `${r.patched} / ${rewriteable}（过短跳过 ${r.skipped.length} 个：${r.skipped.slice(0, 4).join(' | ') || '无'}）`);
  } else {
    // 正向断言 ①：不是"少写了"，而是**逐点证明一个站点都没变**（偏移 / 长度 / 文本三者全等）。
    const sitesIn = scanTargets(pristine, { includeBare: false }).sites;
    const sitesOut = scanTargets(buf, { includeBare: false }).sites;
    const drift = sitesIn.filter((site, i) => {
      const now = sitesOut[i];
      return !now || now.offset !== site.offset || now.length !== site.length || now.text !== site.text;
    });
    A.check(`endpoint=none：URL 站点改写数 = 0（${OFFICIAL_SITE_TOTAL} 个站点逐点比对偏移/长度/文本，全等于基线）`,
      r.patched === 0 && sitesOut.length === sitesIn.length && sitesOut.length === OFFICIAL_SITE_TOTAL && drift.length === 0,
      `改写 ${r.patched} 处；逐点一致 ${sitesOut.length - drift.length}/${sitesIn.length}${drift.length ? `；漂移 ${hexRanges(drift.map(s => [s.offset, s.offset + s.length]), 3)}` : ''}`);
  }
  A.check('基线六项 ① 实名提示 shouldShowFirstLoginTip -> NO', tip === 1,
    tip ? `${hex(0x6ae0dc)}: mov w0,#0 ; ret${idleSitesIn(0x6ae0dc) ? `（幂等重跑：原值已是目标字节 ${hex(pristine.readUInt32LE(0x6ae0dc))}，未写一个字节）` : ''}`
      : `签名 0xa9bd57f6 不匹配（${hex(pristine.readUInt32LE(0x6ae0dc))}）`);
  A.check('基线六项 ② 全新安装登录弹窗 3/3 分支 NOP', dlg === 3, `命中 ${dlg}/3`);
  A.check('基线六项 ③ 欢迎入园横幅 3/3 处', wel === 3, `命中 ${wel}/3`);
  A.check('基线六项 ④ Bundle ID 资源校验 -> return 0', bid === 1,
    bid ? `${hex(0x312230)}: MOV X0,#0 ; RET ; NOP ; NOP${idleSitesIn(0x312230) ? `（幂等重跑：原值已是目标字节 ${hex(pristine.readUInt32LE(0x312230))}，未写一个字节）` : ''}`
      : `签名 0xa9bd6ffc 不匹配（${hex(pristine.readUInt32LE(0x312230))}）`);
  const expectAgr = (PATCH_AGREEMENT ? 1 : 0) + (PATCH_PRIVACY ? 2 : 0);
  A.check('基线六项 ⑤ 协议门（EULA + 隐私 gate）', agr === expectAgr,
    `命中 ${agr}/${expectAgr}（--agreement=${PATCH_AGREEMENT} --privacy=${PATCH_PRIVACY}）`);
  // ⑥ 三态：里面那处 sohu 站点在前次跑法里已被原地改写成死循环地址 ⇒ 本次能写的命中数是 0，
  // 但约束**已经满足**（幂等重跑）。真不匹配（既没有可改写的 sohu 站点、也没有已屏蔽痕迹）照旧 FAIL。
  const sohuIdle = PATCH_SOHU && blk.blocked === 0 && (blk.alreadyBlocked || 0) > 0;
  A.check('基线六项 ⑥ sohu 外发屏蔽（等长改写为 127.0.0.1:1）',
    blk.blocked === (PATCH_SOHU ? 1 : 0) || sohuIdle,
    `命中 ${blk.blocked} 处${blk.hosts.length ? '：' + blk.hosts.join(', ') : ''}（--sohu-block=${PATCH_SOHU}）`
      + (sohuIdle ? `；幂等重跑：另有 ${blk.alreadyBlocked} 处**已是** 127.0.0.1:1 死循环地址，未写一个字节` : ''));
  if (GUARD_MODE === 'launch') {
    A.check('guard-mode=launch：只 NOP 0xb00c 一处', guards === 1 && buf.readUInt32LE(0xb00c) === NOP_INS,
      `0xb00c = ${hex(buf.readUInt32LE(0xb00c))}`);
  } else {
    A.check(`guard-mode=${GUARD_MODE}：已 NOP ${guards} 处致命中止`, GUARD_MODE !== 'none' || guards === 0,
      `模式 ${GUARD_MODE}`);
  }
  if (!REWRITE_ENDPOINT) {
    // 正向断言 ⑥：none 模式下"守卫仍然生效"必须显式成立 —— 把 tmp 脚本当年那条硬校验
    // （`if (buf.readUInt32LE(0xb00c) !== NOP) throw new Error('0xb00c 未被 NOP')`）正式收编。
    A.check(`endpoint=none：0xb00c 启动 guard 已落 NOP（guard-mode=${GUARD_MODE}）`,
      GUARD_MODE === 'none' ? guards === 0 : buf.readUInt32LE(0xb00c) === NOP_INS,
      `0xb00c = ${hex(buf.readUInt32LE(0xb00c))}（期望 ${hex(NOP_INS)}）`);
    // guard-mode=all 时旧断言是弱断言（只查 none 模式为 0），这里补一条"真的扫到并 NOP 了"的计数断言。
    // 幂等重跑（基座本身就是目标态）时 guards=0 但 alreadyNop>0 —— 约束同样满足，故一并放行；
    // 若两者都是 0（站点根本没命中）则照旧 FAIL。
    if (GUARD_MODE === 'all') A.check(`endpoint=none：guard-mode=all 实际命中 ${guards + guardDetails.alreadyNop} 处致命中止（> 0 才算守卫生效）`,
      guards + guardDetails.alreadyNop > 0,
      `命中 ${guards + guardDetails.alreadyNop} 处（本次新 NOP ${guards} + 已幂等 ${guardDetails.alreadyNop}）`);
  }
  if (REWRITE_ENDPOINT) {
    A.check(`ABC 池 ${ABC_API_SCHEME} + ${ABC_API_HOST} ⇒ ${abc.applied ? abc.apiBase : '未改写'}（${OFFICIAL.abcPairBytes} B 守恒）`,
      abc.applied === 1 && abc.totalBytes === OFFICIAL.abcPairBytes, abc.reason);
  } else {
    // 正向断言 ②：ABC 常量池区域（33 B @0x5a0e14b）与基线**逐字节**相同，并且 sha256 也相同。
    const poolIn = pristine.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes);
    const poolOut = buf.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes);
    const hashIn = sha256Hex(poolIn), hashOut = sha256Hex(poolOut);
    A.check(`endpoint=none：ABC 常量池区域 sha256 = 基线值（${OFFICIAL.abcPairBytes} B @${hex(ABC_API_PAIR_OFFSET)}）`,
      poolOut.equals(poolIn) && hashOut === hashIn && abc.applied === 0,
      `基线 ${hashIn} / 实测 ${hashOut}；applied=${abc.applied}；原文 ${JSON.stringify(poolIn.toString('latin1'))}`);
  }
  const residue = countRewriteableUrlSites(buf, { hostPort: STAT_HOST_PORT });
  if (REWRITE_ENDPOINT) {
    A.check('补丁后：可改写旧站点残留 = 0 处', residue === 0, `残留 ${residue} 处`);
  } else {
    // 正向断言 ③：可改写站点残留数**原样保持** = 137，即"137 个站点一个都没被改写"的计数形式。
    A.check(`endpoint=none：可改写旧站点残留 = 基线值 ${OFFICIAL_SITE_REWRITEABLE} 处（一个都没被改写）`,
      residue === OFFICIAL_SITE_REWRITEABLE, `残留 ${residue} 处（基线 ${OFFICIAL_SITE_REWRITEABLE}）`);
  }
  const premiseLeft = countOccurrences(buf, PREMISE_ENDPOINT);
  A.check(`补丁后：${PREMISE_ENDPOINT} 残留 = 0 处`, premiseLeft === 0, `残留 ${premiseLeft} 处`);
  const postEndpoints = (HOST && PORT) ? countOccurrences(buf, HOST_PORT) : 0;
  if (REWRITE_ENDPOINT) {
    A.check(`补丁后：新端点 = ${OFFICIAL.endpointOccurrencesAfter} 处（${OFFICIAL_SITE_REWRITEABLE} URL + 1 ABC）`,
      postEndpoints === OFFICIAL.endpointOccurrencesAfter, `实测 ${postEndpoints} 处`);
  } else {
    // 正向断言 ④：输出里**新端点出现次数 = 0**（给了 --host/--port 也不许出现一次）。
    // 正向断言 ⑤：官方域名出现次数 = 基线值（逐域名 before/after 计数，任何一处被改写都会掉数）。
    A.check(`endpoint=none：新端点出现次数 = 0 处（${HOST && PORT ? HOST_PORT : '未提供 --host/--port'}）`,
      postEndpoints === 0, `实测 ${postEndpoints} 处`);
    const domains = OFFICIAL_HOST_SUFFIXES.map(suffix =>
      ({ suffix, before: countOccurrences(pristine, suffix), after: countOccurrences(buf, suffix) }));
    A.check('endpoint=none：官方域名出现次数 = 基线值（逐域名 before/after）', domains.every(d => d.before === d.after),
      domains.map(d => `${d.suffix} ${d.before}->${d.after}`).join(' / '));
    const padIn = countOccurrences(pristine, '://0'), padOut = countOccurrences(buf, '://0');
    A.check('endpoint=none：userinfo 填充签名（http://0…@host:port）不得新增', padOut === padIn, `基线 ${padIn} 处 -> 实测 ${padOut} 处`);
  }
  A.check(`补丁后：主二进制长度不变 = ${OFFICIAL.binBytes} B`, buf.length === OFFICIAL.binBytes, `${pristine.length} B -> ${buf.length} B`);
  const mhOut = parseMachOHeader(buf);
  A.check('补丁后：ncmds / sizeofcmds 不变（未加段、未动 LC 区）',
    mhOut.ncmds === mhIn.ncmds && mhOut.sizeofcmds === mhIn.sizeofcmds && mhOut.ncmds === OFFICIAL.ncmds && mhOut.sizeofcmds === OFFICIAL.sizeofcmds,
    `ncmds=${mhOut.ncmds} sizeofcmds=${mhOut.sizeofcmds}`);
  // 越界写入检查
  const windows = REWRITE_ENDPOINT
    ? [...FIXED_WINDOWS, ...authorityWindows(pristine), ...guardWindows(pristine, GUARD_MODE)]
    : [...FIXED_WINDOWS_NO_ENDPOINT, ...(PATCH_SOHU ? sohuAuthorityWindows(pristine) : []), ...guardWindows(pristine, GUARD_MODE)];
  const actual = diffRanges(pristine, buf);
  const planned = windowDiffRanges(pristine, buf, windows);
  const stray = actual.filter(range => !planned.some(p => p[0] <= range[0] && p[1] >= range[1]));
  const changedBytes = actual.reduce((sum, [s, e]) => sum + (e - s), 0);
  A.check(REWRITE_ENDPOINT ? '改动字节范围 = 计划范围（无越界写入）'
    : 'endpoint=none：改动字节范围 = 计划范围（只含六项功能补丁 + guard；计划窗口已剔除 URL 站点与 ABC 池）',
  rangesEqual(actual, planned) && stray.length === 0,
  `${actual.length} 段 / ${changedBytes} 字节；声明窗口 ${windows.length} 个${stray.length ? `；越界段 ${hexRanges(stray, 3)}` : ''}`);
  if (!REWRITE_ENDPOINT) {
    // 正向断言 ⑦：**逐字节**证明"URL 一个字节都没动" —— 官方站点窗口 ∪ ABC 池窗口 与 实际改动范围
    // 的交集必须为空。这里的 forbidden 是**全量**集合（不像 windows 已被刻意剔除），因此即使将来有人
    // 误把某个站点窗口从计划里删掉，这条断言也仍然独立成立。
    const forbidden = [...officialAuthorityWindows(pristine), [ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes]];
    const violated = actual.filter(range => forbidden.some(([start, end]) => range[0] < end && range[1] > start));
    A.check(`endpoint=none：官方 URL 站点窗口 ∪ ABC 池窗口共 ${forbidden.length} 个窗口内零字节改动`,
      violated.length === 0,
      violated.length ? `违规段 ${hexRanges(violated, 3)}` : `${changedBytes} 个改动字节全部落在功能补丁/守卫窗口内`);
  }
  // ── A1c 新增：guard 站点计数 + 逐点「期望字节」fail-fast（吸收 wfcore patchNativeWords() 的三态纪律）──
  // 为什么必须"逐点"而不是只查 0xb00c：`guard-mode=all` 的扫描会在 14 个站点真写字节，只硬校验其中
  // 一个 ⇒ 另外 13 个即使原指令已被别的东西改过（基座不对/偏移漂移）也会被当成"已改成功"静默写下去。
  // verifyAgainst = pristine（官方原始件）：拿 buf 验会永远通过（buf 上已经是 NOP 了）＝等于没验。
  const gSites = collectGuardSites(pristine, GUARD_MODE);
  const gAlreadyNop = new Set(gSites.filter(s => pristine.readUInt32LE(s.offset) === s.want).map(s => s.offset));
  const gBad = guardSiteMismatches(gSites, pristine, pristine.length, gAlreadyNop);
  A.check(`guard 站点：扫描命中 ${gSites.length} = 已改 ${guardDetails.applied.length} + 已幂等 ${guardDetails.alreadyNop}；另跳过 ${guardDetails.skipped}（guard-mode=${GUARD_MODE}）`,
    gSites.length === guardDetails.sitesFound && guardDetails.skippedSites.length === guardDetails.skipped,
    `命中 ${gSites.length} / 已改 ${guardDetails.applied.length} / 已幂等 ${guardDetails.alreadyNop} / 跳过 ${guardDetails.skipped}${guardDetails.skipped ? `（${guardDetails.skippedSites.map(s => `${hex(s.offset)}：${s.reason}`).join('；')}）` : ''}`);
  A.check(`guard 站点逐点「期望字节」校验（${gSites.length} 个站点，fail-fast）`, gBad.length === 0,
    gBad.length ? gBad.slice(0, 4).join(' | ') : `${gSites.length}/${gSites.length} 与期望原值一致：${gSites.map(s => `${s.kind}@${hex(s.offset)} ${hex(s.expect)}->${hex(s.want)}`).join('、')}`);
  // A1c：指纹断言（只在显式豁免且确有差异时新增 1 条；非豁免路径断言数与措辞逐字不变）
  assertInputFingerprint(A, fprint);
  return { actual, planned, windows, changedBytes, residue, postEndpoints };
}

/** A1c：内置的**官方输入基线**（与 OFFICIAL_IOS_184 同源，但这里刻意再写一遍字面量）。
 *  这是"补丁纪律"的数据面：单一来源就无法交叉校验 —— 若哪天 OFFICIAL_IOS_184 被误改，
 *  下面的启动自检会当场把工具打死，而不是安静地用错误基线放过一份异物。 */
const OFFICIAL_IPA_FINGERPRINT = {
  role: 'ipa', label: '输入 IPA',
  bytes: 139212360,
  sha256: '5241e51b40bd9d7e2ad92bae9b85e4dc31cd19cd68a637d363c5dcca3eae0a3a',
};
const OFFICIAL_BIN_FINGERPRINT = {
  role: 'bin', label: '输入主二进制',
  bytes: OFFICIAL.binBytes,
  sha256: OFFICIAL.binSha256,
};
// 启动自检：常量本身必须与任务书/文档写死的值一致（防止"改了基线忘了改校验"）。
if (OFFICIAL_BIN_FINGERPRINT.bytes !== 108757200 ||
  OFFICIAL_BIN_FINGERPRINT.sha256 !== 'ccf9d309e55e2824c636a2ef0febf38d898b83a74694a08e69ab79a1e26b3429') {
  fail(`内置主二进制基线与任务书不一致：bytes=${OFFICIAL_BIN_FINGERPRINT.bytes} sha256=${OFFICIAL_BIN_FINGERPRINT.sha256}`);
}
if (OFFICIAL_IPA_FINGERPRINT.bytes !== 139212360 ||
  OFFICIAL_IPA_FINGERPRINT.sha256 !== '5241e51b40bd9d7e2ad92bae9b85e4dc31cd19cd68a637d363c5dcca3eae0a3a') {
  fail(`内置 IPA 基线与任务书不一致：bytes=${OFFICIAL_IPA_FINGERPRINT.bytes} sha256=${OFFICIAL_IPA_FINGERPRINT.sha256}`);
}

/** 逐条差异的打印文本（wfcore 风格 `expected=… actual=…`）。 */
function fingerprintMismatchText(m) {
  return `${m.where} ${m.field} 不匹配 expected=${m.expected} actual=${m.actual}`;
}

/** 只读地采集输入指纹并与内置基线比对（**不写盘、不退出**，便于调用方决定拒绝还是豁免）。
 *  @param {{ipaPath?:string, ipaBytes?:Buffer, bin?:Buffer}} input */
function collectInputFingerprint(input) {
  const allowForeignBase = ALLOW_FOREIGN_BASE;
  const findings = [], mismatches = [];
  const add = (where, field, expected, actual) => {
    const f = { where, field, expected, actual };
    findings.push(f);
    if (actual !== expected) mismatches.push(f);
  };
  let ipa = null;
  if (input.ipaBytes) {
    const sha = sha256Hex(input.ipaBytes);
    add(OFFICIAL_IPA_FINGERPRINT.label, '字节数', OFFICIAL_IPA_FINGERPRINT.bytes, input.ipaBytes.length);
    add(OFFICIAL_IPA_FINGERPRINT.label, 'sha256', OFFICIAL_IPA_FINGERPRINT.sha256, sha);
    ipa = { path: input.ipaPath ? String(input.ipaPath) : null, bytes: input.ipaBytes.length, sha256: sha, expectedBytes: OFFICIAL_IPA_FINGERPRINT.bytes, expectedSha256: OFFICIAL_IPA_FINGERPRINT.sha256 };
  }
  let bin = null;
  if (input.bin) {
    const sha = sha256Hex(input.bin);
    const where = `${OFFICIAL_BIN_FINGERPRINT.label}（${MACHO_REL}）`;
    add(where, '字节数', OFFICIAL_BIN_FINGERPRINT.bytes, input.bin.length);
    add(where, 'sha256', OFFICIAL_BIN_FINGERPRINT.sha256, sha);
    bin = { entry: MACHO_REL, bytes: input.bin.length, sha256: sha, expectedBytes: OFFICIAL_BIN_FINGERPRINT.bytes, expectedSha256: OFFICIAL_BIN_FINGERPRINT.sha256 };
  }
  return { allowForeignBase, ipa, bin, findings, mismatches: mismatches.length };
}

/** 前置闸门：在**写入任何字节之前**决定放行还是拒绝。豁免时只 WARN（真正的记录交给断言侧）。 */
function enforceInputFingerprint(check) {
  if (check.mismatches === 0) {
    console.log(`  输入基座指纹 ✓ 与官方 1.8.4 基线一致（IPA ${check.ipa ? check.ipa.bytes + ' B' : '未提供'} / 主二进制 ${check.bin ? check.bin.bytes + ' B' : '未提供'}）`);
    return check;
  }
  if (!check.allowForeignBase) {
    console.log(`ERROR 输入基座指纹不匹配（${check.mismatches} 项）—— 默认拒绝出包，未写入任何字节：`);
    for (const m of check.findings.filter(f => f.actual !== f.expected)) console.log(`  - ${fingerprintMismatchText(m)}`);
    console.log(`  若这确实是你要的合成夹具/自有基座，显式加 --allow-foreign-base 越过本闸（会留一条断言存证）。`);
    process.exit(1);
  }
  console.log(`WARN --allow-foreign-base：跳过输入基座指纹前置校验（${check.mismatches} 项差异）—— 仅供合成夹具使用：`);
  for (const m of check.findings.filter(f => f.actual !== f.expected)) console.log(`  - ${fingerprintMismatchText(m)}`);
  return check;
}

/** A1c：输入基座指纹的断言侧（与 enforceInputFingerprint 的"前置拒绝"互补）。
 *  只在**显式豁免**且**确有差异**时才新增 1 条断言 ⇒ 既有的 PASS 计数与措辞逐字不变。
 *  为什么不无条件加一条：非豁免路径上指纹已经一致，"校验通过"这件事由 enforceInputFingerprint 的
 *  打印行负责；再加一条断言就会改动既有 PASS 计数（红线要求逐字不变）。
 *  为什么必须先把 `mismatches === 0` 挡掉：`[].every()` 恒真 —— 官方基座 + 该开关同时出现时，
 *  旧写法会记下一条 FAIL「无差异（该开关此时是空操作）」，等于让"空开关"也能把构建判死。
 *  ok 判据用 `mismatches > 0`：本条断言是**豁免存证**（证明"本次确实豁免了校验"），而这件事由上面
 *  那道早退**保证**成立。旧写法 `findings.every(f => f.actual !== f.expected)` 要求"每个指纹字段都不同"，
 *  只有 sha 不同、字节数相同（例：等长补丁后的基座）时它会记 FAIL ⇒ 幂等重跑被误判不可交付。 */
function assertInputFingerprint(A, check, label = '输入基座') {
  if (!check || !check.allowForeignBase) return;
  if (check.mismatches === 0) return;                  // 开关是空操作 ⇒ 不记任何断言
  A.check(`${label}：显式豁免指纹前置校验（--allow-foreign-base）—— 本次不校验官方 1.8.4 基线`,
    check.mismatches > 0,
    check.findings.map(f => `${f.field} expected=${f.expected} actual=${f.actual}`).join('；'));
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
  const fprint = enforceInputFingerprint(collectInputFingerprint({ bin: pristine }));
  const mhIn = assertOfficialInput(A, pristine);
  const minLen = minReplacementLength(STAT_HOST_PORT);
  const rewriteable = scanTargets(pristine, { includeBare: false }).sites.filter(s => s.length >= minLen).length;
  const r = REWRITE_ENDPOINT ? patchBuffer(buf) : { patched: 0, skipped: [] };
  const blk = PATCH_SOHU ? patchBlock(buf) : { blocked: 0, hosts: [], alreadyBlocked: 0 };
  const guardCollector = createGuardCollector(GUARD_MODE);
  const guards = deguardBuffer(buf, GUARD_MODE, guardCollector);
  const guardDetails = guardCollector.summary();
  const abc = REWRITE_ENDPOINT ? applyApiBaseRewrite(buf, { hostPort: HOST_PORT })
    : { applied: 0, reason: '--endpoint=none：跳过 ABC 常量池改写', offset: null, totalBytes: 0, apiBase: null, diffRanges: [], oldBytes: null, newBytes: null };
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
  console.log(abc.applied ? `  ABC 池 API 基址 -> ${abc.apiBase}（${abc.totalBytes} B 守恒 @${hex(abc.offset)}）`
    : REWRITE_ENDPOINT ? `  [!] ABC 池改写未生效：${abc.reason}` : `  · ${abc.reason}`);
  if (args['crash-longjmp'] && buf.readUInt32LE(0x57d834c) === 0xb0005190) { buf.writeUInt32LE(0xd4200000, 0x57d834c); console.log('  [诊断] _longjmp 桩 -> BRK'); }
  const res = assertPatchResults(A, { r, blk, guards, abc, tip, dlg, wel, agr, bid, buf, pristine, mhIn, rewriteable, fprint, guardDetails });
  writeFileSync(OUT, buf);
  console.log(REWRITE_ENDPOINT ? `已改写 ${r.patched} 个 URL 常量 -> ${TARGET}` : 'endpoint=none：URL 常量一处未改（交给越狱 dylib 在运行期接管）');
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

  // A1c 前置闸门：整包 IPA 与主二进制**两项**都在写盘前过闸（拒绝时一个字节都不写）。
  const fprint = enforceInputFingerprint(collectInputFingerprint({ ipaPath: String(args.ipa), ipaBytes: inBytes, bin: pristine }));
  const mhIn = assertOfficialInput(A, pristine);
  const scan = scanTargets(pristine, { includeBare: false });
  const minLen = minReplacementLength(STAT_HOST_PORT);
  const tooShortSites = scan.sites.filter(s => s.length < minLen);
  const rewriteableSites = scan.sites.filter(s => s.length >= minLen);
  if (REWRITE_ENDPOINT) {
    A.check(`目标 authority 长度 = ${ENDPOINT_LENGTH}（冻结地址 ${HOST}:${PORT} / 分工文档 §C2）`,
      HOST_PORT.length === ENDPOINT_LENGTH, `${HOST_PORT} = ${HOST_PORT.length} 字符（期望 ${ENDPOINT_LENGTH}）`);
  } else {
    // none 模式没有目标端点，"目标 authority 长度"这条断言不适用；换成一条**只有 none 模式才成立**、
    // 同样正向的事实：官方站点在扫描器眼里仍然全部处于"可改写原状"（一个都没被动过）。
    A.check(`endpoint=none：无目标端点（--host/--port ${HOST || PORT ? '已给出但被忽略' : '未给出'}）⇒ ${OFFICIAL_SITE_REWRITEABLE} 个站点保持可改写原状`,
      rewriteableSites.length === OFFICIAL_SITE_REWRITEABLE && tooShortSites.length === OFFICIAL_SITE_TOO_SHORT,
      `可改写 ${rewriteableSites.length} / 过短 ${tooShortSites.length}（本模式不写 URL 一个字节）`);
  }
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

  progress(REWRITE_ENDPOINT ? '原地改写端点 URL + ABC 池 API 基址 + 六项功能补丁 + 解除 guard'
    : '（--endpoint=none）跳过端点 URL 与 ABC 池，只打六项功能补丁 + 解除 guard');
  const r = REWRITE_ENDPOINT ? patchBuffer(buf) : { patched: 0, skipped: [] };
  const blk = PATCH_SOHU ? patchBlock(buf) : { blocked: 0, hosts: [], alreadyBlocked: 0 };
  const guardCollector = createGuardCollector(GUARD_MODE);
  const guards = deguardBuffer(buf, GUARD_MODE, guardCollector);
  const guardDetails = guardCollector.summary();
  const abc = REWRITE_ENDPOINT ? applyApiBaseRewrite(buf, { hostPort: HOST_PORT })
    : { applied: 0, reason: '--endpoint=none：跳过 ABC 常量池改写', offset: null, totalBytes: 0, apiBase: null, diffRanges: [], oldBytes: null, newBytes: null };
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
  console.log(abc.applied ? `  ABC 池 API 基址（DevConfig_gf_ios.apiServer）-> ${abc.apiBase}（${abc.totalBytes} B 守恒 @${hex(abc.offset)}）`
    : REWRITE_ENDPOINT ? `  [!] ABC 池改写未生效：${abc.reason}` : `  · ${abc.reason}`);
  if (!PATCH_SOHU) console.log('  · --sohu-block=false：sohu 外发屏蔽已关闭（该外发 URL 也保持原样）');
  if (args['crash-longjmp'] && buf.readUInt32LE(0x57d834c) === 0xb0005190) { buf.writeUInt32LE(0xd4200000, 0x57d834c); console.log('  [诊断] _longjmp 桩 -> BRK'); }
  const res = assertPatchResults(A, { r, blk, guards, abc, tip, dlg, wel, agr, bid, buf, pristine, mhIn, rewriteable: rewriteableSites.length, fprint, guardDetails });
  console.log(REWRITE_ENDPOINT ? `已改写 ${r.patched} 个 URL 常量 -> ${TARGET}` : 'endpoint=none：URL 常量一处未改（交给越狱 dylib 在运行期接管）');
  console.log(`已清除 ${guards} 个故意中止 guard（0xDEADBEEF 空写入）`);
  if (r.skipped.length) console.log(`已跳过（${r.skipped.length} 个不重要，太短）: ` + r.skipped.slice(0, 8).join(', '));

  if (A.failed.length) {
    // 阶段一就失败：**不写出产物**，只留报告（避免"带伤的包"流到装机环节）
    writeBuildReport(String(OUT), {
      task: 'P10-A / A1b iOS IPA 补丁构建报告', phase: 'pre-write（未写出产物）',
      tool: 'client-patch/build/patch-ipa.mjs', generatedAt: new Date().toISOString(),
      input: { ipa: args.ipa, bytes: inBytes.length, sha256: inSha256, entries: inEntries.length },
      binary: { entry: mainName, bytes: pristine.length, sha256Before: sha256Hex(pristine), sha256After: sha256Hex(buf) },
      inputFingerprint: fprint,
      guardSites: { mode: guardDetails.mode, sitesFound: guardDetails.sitesFound, applied: guardDetails.applied.map(normalizeSite), skippedSites: guardDetails.skippedSites.map(normalizeSite), mismatches: guardDetails.mismatches.map(hex) },
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
    const rbResidue = countRewriteableUrlSites(outBin, { hostPort: STAT_HOST_PORT });
    const rbEndpoints = (HOST && PORT) ? countOccurrences(outBin, HOST_PORT) : 0;
    if (REWRITE_ENDPOINT) {
      A.check('回读：可改写旧站点残留 = 0 处', rbResidue === 0, `残留 ${rbResidue} 处`);
      A.check(`回读：新端点 = ${OFFICIAL.endpointOccurrencesAfter} 处`, rbEndpoints === OFFICIAL.endpointOccurrencesAfter, `实测 ${rbEndpoints} 处`);
    } else {
      // 正向断言 ⑧/⑨：落盘后的产物同样必须"URL 一个字节都没动"（内存里对了 ≠ 盘上对了）。
      A.check(`endpoint=none：回读可改写旧站点残留 = 基线值 ${OFFICIAL_SITE_REWRITEABLE} 处（盘上同样一个都没改）`,
        rbResidue === OFFICIAL_SITE_REWRITEABLE, `残留 ${rbResidue} 处（基线 ${OFFICIAL_SITE_REWRITEABLE}）`);
      A.check(`endpoint=none：回读新端点出现次数 = 0 处（${HOST && PORT ? HOST_PORT : '未提供 --host/--port'}）`,
        rbEndpoints === 0, `实测 ${rbEndpoints} 处`);
    }
    const rbAbc = outBin.toString('latin1', ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes);
    if (REWRITE_ENDPOINT) {
      A.check(`回读：ABC 池 API 基址已改写（${OFFICIAL.abcPairBytes} B 守恒）`, rbAbc === abc.newBytes, JSON.stringify(rbAbc));
    } else {
      const rbAbcBuf = outBin.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes);
      const inAbcBuf = pristine.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes);
      A.check('endpoint=none：回读 ABC 池区域 sha256 = 基线值（盘上 33 B 逐字节未动）',
        rbAbcBuf.equals(inAbcBuf) && sha256Hex(rbAbcBuf) === sha256Hex(inAbcBuf),
        `${sha256Hex(inAbcBuf)} -> ${sha256Hex(rbAbcBuf)}`);
    }
    A.check('回读：guard NOP 已落盘', GUARD_MODE !== 'launch' || outBin.readUInt32LE(0xb00c) === NOP_INS, `0xb00c = ${hex(outBin.readUInt32LE(0xb00c))}`);
    if (!REWRITE_ENDPOINT) {
      A.check(`endpoint=none：回读 0xb00c = NOP（守卫在盘上生效，guard-mode=${GUARD_MODE}）`,
        GUARD_MODE === 'none' ? outBin.readUInt32LE(0xb00c) === 0xb9000109 : outBin.readUInt32LE(0xb00c) === NOP_INS,
        `0xb00c = ${hex(outBin.readUInt32LE(0xb00c))}`);
    }
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
      rawBad.length ? `${rawBad.length} 条不同：${rawBad.slice(0, 3).join(', ')}` : '除主二进制外全部原样搬运（纯 Node 回写 + 逐条比对，不依赖 jar）');
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
    // A1c 新增：整包级回读 —— 盘上那份 IPA 必须与**内存里刚拼出来的**字节完全一致。
    // 为什么需要它：上面那些回读断言都是"从盘上读回来再检查某个性质"，即使 writeFileSync 少写一截、
    // 或 zip 引擎在第二次解析时得到不同结果，只要性质仍成立就会通过；这里直接比全量字节与 sha256。
    A.check(`回读：产出 IPA 与内存结果逐字节一致（sha256 ${sha256Hex(outBytes).slice(0, 16)}…）`,
      outBytes2.equals(outBytes) && sha256Hex(outBytes2) === sha256Hex(outBytes),
      `${outBytes2.length} B / sha256 ${sha256Hex(outBytes2)}`);
    readback = {
      ipa: String(OUT), bytes: outBytes2.length, sha256: sha256Hex(outBytes2), entries: outEntries.length,
      binSha256: outBinSha, crcOk, matchesInMemory: outBytes2.equals(outBytes),
      counts: {
        entries: outEntries.length, crcPassed: crcOk, crcFailed: crcBad.length,
        entriesAttrBad: attrBad.length, rewriteableResidue: rbResidue, endpointOccurrences: rbEndpoints,
      },
      guardSitesOnDisk: collectGuardSites(outBin, GUARD_MODE).map(s => ({ kind: s.kind, offset: hex(s.offset), actualBefore: hex(s.actual) })),
    };
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
    endpoint: REWRITE_ENDPOINT
      ? { mode: 'url', to: String(HOST), port: String(PORT), toAuthority: TARGET, authorityLength: HOST_PORT.length, expectedLength: ENDPOINT_LENGTH }
      : {
        mode: 'none', reason: '--endpoint=none：不改写任何 URL 与 ABC 池（交给越狱 dylib 在运行期接管）',
        hostPortIgnored: (HOST || PORT) ? HOST_PORT : null, urlSitesChanged: 0, sohuBlocked: PATCH_SOHU,
        poolSha256Before: sha256Hex(pristine.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes)),
        poolSha256After: sha256Hex(buf.subarray(ABC_API_PAIR_OFFSET, ABC_API_PAIR_OFFSET + OFFICIAL.abcPairBytes)),
      },
    apiBase: REWRITE_ENDPOINT ? {
      enabled: true, applied: abc.applied, schemeHost: `${ABC_API_SCHEME} + ${ABC_API_HOST}`,
      expectedOffset: hex(ABC_API_PAIR_OFFSET), offset: hex(abc.offset || 0), totalBytes: abc.totalBytes,
      newBytes: abc.newBytes, apiBaseUrl: abc.apiBase, reason: abc.reason,
    } : {
      enabled: false, applied: 0, schemeHost: `${ABC_API_SCHEME} + ${ABC_API_HOST}`,
      expectedOffset: hex(ABC_API_PAIR_OFFSET), offset: null, totalBytes: 0,
      newBytes: null, apiBaseUrl: null, reason: abc.reason,
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
      // A1c：计数断言（任务 3）—— 命中/跳过站点、断言总数、改动区间与字节数
      guardSitesFound: guardDetails.sitesFound, guardSitesApplied: guardDetails.applied.length,
      guardSitesSkipped: guardDetails.skipped, guardSitesAlreadyNop: guardDetails.alreadyNop,
      assertionsTotal: A.list.length, changedRangeCount: res.actual.length, changedBytes: res.changedBytes,
      declaredNetworkWindows: res.windows.length,
    },
    // A1c：输入基座指纹（任务 1）—— 前置校验的完整留档，便于事后回答"这份包是在什么基座上打的"
    inputFingerprint: fprint,
    // A1c：guard 站点台账（任务 2/3）—— sites/applied/skippedSites 统一成同一套字段与进制
    // （原来 sites 用 hex 字符串 + actualBefore、applied/skippedSites 用十进制 + actual，两套口径）
    guardSites: {
      mode: guardDetails.mode,
      sitesFound: guardDetails.sitesFound, total: guardDetails.total,
      applied: guardDetails.applied.map(normalizeSite), skipped: guardDetails.skipped,
      skippedSites: guardDetails.skippedSites.map(normalizeSite), alreadyNop: guardDetails.alreadyNop,
      mismatches: guardDetails.mismatches.map(hex),
      sites: guardDetails.sites.map(normalizeSite),
      verifyAgainst: 'pristine（官方原始件）—— 拿 buf 验会永远通过（buf 上已是 NOP），等于没验',
    },
    assertionsTotal: A.list.length,
    changedBytes: res.changedBytes, changedRanges: res.actual.map(hexRange), declaredNetworkWindows: res.windows.length,
    assertions: A.list, ok: A.failed.length === 0,
  };
  const reportInfo = writeBuildReport(String(OUT), report);
  console.log(`  ${reportInfo.file}（${reportInfo.bytes} B，${A.passed.length} PASS / ${A.failed.length} FAIL）`);
  finishAssertions(A, { outPath: OUT, wroteOutput: !DRY_RUN });
  console.log(REWRITE_ENDPOINT
    ? `DONE  ${OUT}  (host=${HOST}:${PORT}; 重签: Sideloadly 用你的 Apple ID 安装时会重新签名补丁后的二进制)`
    : `DONE  ${OUT}  (endpoint=none：URL 一处未改${HOST && PORT ? `，已忽略 --host/--port ${HOST}:${PORT}` : ''}${PATCH_SOHU ? '' : '，sohu 屏蔽亦已 --sohu-block=false 关闭'}; 重签: Sideloadly 用你的 Apple ID 安装时会重新签名补丁后的二进制)`);
}
