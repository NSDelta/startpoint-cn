'use strict';
// 端到端：补齐 `--endpoint=none` 的**两条未验证路径**，并给「补丁纪律」做反向自证。
//
// 为什么单独一个文件（而不是塞进 ios_ipa_patch.test.cjs）：后者已经 8 例、跑 24 s，且它的用例
// 是「一条命令一个断言组」的线性结构；本文件要覆盖的是**交互组合**（endpoint=none × guard-mode=all、
// 以及 --bin 这条独立入口），并且特意包含**负向**用例（必须红），放一起会让"红了"这件事变得含混。
//
// 覆盖矩阵（每条都是真跑 CLI，不 mock）：
//   ① --endpoint=none --guard-mode=all  官方 IPA   → 45 PASS，产物 sha/字节数逐位固定 + 报告计数自洽
//   ② --bin（直接给主二进制）--guard-mode=all      → 走 --bin 入口，脱离 zip 引擎
//   ③ 指纹闸门：非官方基座（合成 IPA）**默认拒绝** → 退出码 1 + expected=… actual=…
//   ④ 负向自证：官方主二进制 @0xb00c 被改成 0xdeadbeef → 逐点 fail-fast 必须红（退出码 2）
//
// 说明：① 把"CLI 输出层"与"build-report 层"的断言合并在**同一次真跑**里。原因是这份 139 MB 基座
// 的单次运行要 ~6 s 且峰值内存高（IPA 139 MB + 主二进制 108 MB ×2 + zip 回写缓冲）；拆成两次跑
// 会在测试运行器里触发偶发的子进程被杀（实测 status=-1），而合并后既省一半时间又消除该抖动。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const CLI = path.join(REPO, 'client-patch', 'build', 'patch-ipa.mjs');
const FIXTURE = path.join(REPO, 'apkipa', 'iOS-1.8.4.ipa');
const FIXTURE_BYTES = 139212360;
const FIXTURE_OK = fs.existsSync(FIXTURE) && fs.statSync(FIXTURE).size === FIXTURE_BYTES;
const FIXTURE_SKIP = FIXTURE_OK ? false : `缺少官方夹具 ${FIXTURE}（${FIXTURE_BYTES} B）—— 跳过真跑用例`;

const MACHO_REL = 'Payload/worldflipper.app/worldflipper';
const OFFICIAL_BIN_BYTES = 108757200;
// 官方 IPA 在 --endpoint=none --guard-mode=all 下的产物指纹（与 ios_ipa_patch.test.cjs 里
// rewrite / none+launch 两条基线同源，都是"写入行为不许动"的机器化形式）
const NONE_ALL_IPA_BYTES = 135629633;
const NONE_ALL_IPA_SHA256 = '975eca976427021844417bf24df3dd149a207317203478b9c841567f4b9a82d8';
const GUARD_NOP = 0xd503201f;
const GUARD_EXPECT = 0xb9000109;

const zipLib = require(path.join(REPO, 'client-patch', 'build', 'lib', 'zip-ipa.mjs'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function runCli(argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  });
}
const cliLog = (res) => String(res.stdout || '') + String(res.stderr || '');
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// 官方主二进制（解压 108 MB，较慢 ⇒ 全文件只做一次并缓存）
let mainBinCache = null;
function officialMainBinary() {
  if (mainBinCache) return mainBinCache;
  const entries = zipLib.readZipEntries(fs.readFileSync(FIXTURE));
  const entry = entries.find((e) => e.name === MACHO_REL);
  assert.ok(entry, `官方 IPA 里应存在 ${MACHO_REL}`);
  // ⚠️ 主二进制 entry 是 method 8（deflate）：entry.raw 只有 ~38 MB 压缩字节，
  //    必须 readEntryData() 解压才是 108,757,200 B 的 Mach-O（拿 .raw 会得到 magic=0x7809bdec）。
  mainBinCache = zipLib.readEntryData(entry);
  assert.strictEqual(mainBinCache.length, OFFICIAL_BIN_BYTES, '解压后的主二进制长度');
  return mainBinCache;
}

// ── ① --endpoint=none --guard-mode=all（官方 IPA，真跑；这是本任务要补的第一条未验证路径）──
test('--endpoint=none --guard-mode=all：官方 IPA 真跑，产物 sha 逐位固定且报告计数自洽', { skip: FIXTURE_SKIP }, () => {
  const outDir = mkTmp('ipa-none-all-');
  try {
    const out = path.join(outDir, 'out.ipa');
    const res = runCli(['--ipa', FIXTURE, '--endpoint=none', '--guard-mode=all', '--out', out]);
    const log = cliLog(res);
    assert.strictEqual(res.status, 0, `应成功退出，实际 status=${res.status} signal=${res.signal}\n${log}`);
    assert.ok(!/\[FAIL\]|FAILED/.test(log), `不应有失败断言\n${log}`);
    // 指纹闸门：官方基座必须放行（这条同时证明闸门没把正常路径挡死）
    assert.match(log, /输入基座指纹 ✓ 与官方 1\.8\.4 基线一致/);
    // all 模式必须真的扫到并 NOP 了致命中止点，且逐点校验过期望字节
    assert.match(log, /guard 站点：扫描命中 \d+ = 已改 \d+ \+ 已幂等 \d+；另跳过 \d+（guard-mode=all）/);
    assert.match(log, /guard 站点逐点「期望字节」校验（\d+ 个站点，fail-fast）/);
    const bytes = fs.readFileSync(out);
    assert.strictEqual(bytes.length, NONE_ALL_IPA_BYTES, '产物字节数');
    assert.strictEqual(sha256(bytes), NONE_ALL_IPA_SHA256, '产物 sha256 必须与基线逐位一致');

    // ── 报告层（同一次真跑的产物，不再重复跑一遍）──
    const reportPath = `${out}.build-report.json`;
    assert.ok(fs.existsSync(reportPath), `应产出 build-report：${reportPath}`);
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    // 任务 1：输入基座指纹必须留档，且两项都真实比对过
    assert.ok(r.inputFingerprint, '报告应含 inputFingerprint');
    assert.strictEqual(r.inputFingerprint.mismatches, 0, '官方基座不应有差异');
    assert.strictEqual(r.inputFingerprint.ipa.bytes, FIXTURE_BYTES);
    assert.strictEqual(r.inputFingerprint.bin.bytes, OFFICIAL_BIN_BYTES);

    // 任务 2：guard 站点台账 —— sites/applied/skippedSites 三处数组同构（normalizeSite）且全 hex
    const gs = r.guardSites;
    assert.ok(gs, '报告应含 guardSites');
    assert.strictEqual(gs.mode, 'all');
    assert.strictEqual(gs.sitesFound, gs.sites.length, 'sitesFound 应等于 sites 台账长度');
    assert.strictEqual(gs.total, gs.applied.length, 'total 应等于 applied 长度');
    assert.strictEqual(gs.applied.length + gs.alreadyNop, gs.sites.length, '已改 + 已幂等 = 命中总数');
    assert.strictEqual(gs.skipped, gs.skippedSites.length, 'skipped 应等于 skippedSites 长度');
    assert.deepStrictEqual(gs.mismatches, [], '官方基座上不应有任何站点不匹配');
    assert.match(String(gs.verifyAgainst), /pristine/, 'verifyAgainst 应说明是拿 pristine 校验的');
    for (const s of gs.sites) {
      assert.match(s.offset, /^0x[0-9a-f]+$/, 'offset 应为 hex 字符串');
      assert.match(s.expect, /^0x[0-9a-f]+$/, 'expect 应为 hex 字符串');
      assert.match(s.want, /^0x[0-9a-f]+$/, 'want 应为 hex 字符串');
      assert.match(s.actualBefore, /^0x[0-9a-f]+$/, 'actualBefore 应为 hex 字符串（与 sites/applied 同构）');
    }

    // 任务 3：计数断言字段齐全且互相自洽
    const c = r.counts;
    for (const k of ['guardSitesFound', 'guardSitesApplied', 'guardSitesSkipped', 'assertionsTotal', 'changedRangeCount', 'changedBytes']) {
      assert.strictEqual(typeof c[k], 'number', `counts.${k} 应为数字`);
    }
    assert.strictEqual(c.guardSitesFound, gs.sitesFound);
    assert.strictEqual(c.guardSitesApplied, gs.applied.length);
    assert.strictEqual(c.guardSitesSkipped, gs.skipped);
    assert.strictEqual(r.assertionsTotal, r.assertions.length, 'assertionsTotal 应等于断言清单长度');
    assert.strictEqual(c.assertionsTotal, r.assertions.length);
    assert.strictEqual(r.changedRanges.length, c.changedRangeCount, 'changedRanges 长度应与计数一致');
    assert.strictEqual(c.changedBytes, r.changedBytes);

    // 写后回读：盘上产物与内存结果逐字节一致
    assert.strictEqual(r.output.matchesInMemory, true, '回读应证明盘上产物 == 内存结果');
    assert.strictEqual(r.output.sha256, NONE_ALL_IPA_SHA256);
    assert.strictEqual(r.output.bytes, NONE_ALL_IPA_BYTES);
    assert.strictEqual(r.output.counts.crcFailed, 0, '整包 CRC 不应有失败项');
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

// ── ② --bin 入口（这是本任务要补的第二条未验证路径；不走 zip 引擎，直接补裸 Mach-O）──
test('--bin：直接给主二进制真跑，产物不做 zip 回写、长度不变且 guard 落 NOP', { skip: FIXTURE_SKIP }, () => {
  const outDir = mkTmp('ipa-bin-');
  try {
    const binIn = path.join(outDir, 'main.bin');
    const binOut = path.join(outDir, 'main.patched.bin');
    fs.writeFileSync(binIn, officialMainBinary());
    const res = runCli(['--bin', binIn, '--endpoint=none', '--guard-mode=all', '--out', binOut]);
    const log = cliLog(res);
    assert.strictEqual(res.status, 0, `--bin 应成功退出，实际 status=${res.status} signal=${res.signal}\n${log}`);
    assert.ok(!/\[FAIL\]|FAILED/.test(log), `不应有失败断言\n${log}`);
    // --bin 是"测试模式"：不写 build-report，但要自报改动段数/字节数
    assert.match(log, /（--bin 测试模式：改动 \d+ 段 \/ \d+ 字节；不写 build-report）/);
    assert.match(log, /输入基座指纹 ✓ 与官方 1\.8\.4 基线一致/);
    const out = fs.readFileSync(binOut);
    assert.strictEqual(out.length, OFFICIAL_BIN_BYTES, '--bin 产物长度必须不变（原地等长补丁）');
    assert.strictEqual(out.readUInt32LE(0xb00c), GUARD_NOP, '0xb00c 启动 guard 应已落 NOP');
    assert.strictEqual(fs.readFileSync(binIn).readUInt32LE(0xb00c), GUARD_EXPECT, '输入文件本身不应被改写');
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

// ── ③ 指纹闸门：非官方基座**默认拒绝**，且拒绝发生在写盘之前 ──
test('指纹前置校验：非官方基座默认拒绝（退出码 1 + expected=/actual=），且不产出任何文件', () => {
  const outDir = mkTmp('ipa-foreign-');
  try {
    const fakeIpa = path.join(outDir, 'fake.ipa');
    // 合成极小 IPA：闸门在 Mach-O 断言**之前**执行，所以内容无需是真 Mach-O
    fs.writeFileSync(fakeIpa, zipLib.writeZipEntries([{
      name: MACHO_REL, method: 0, flags: 0, mtime: 0, mdate: 0,
      crc: 0, csize: 16, usize: 16, raw: Buffer.alloc(16, 0x41),
    }]));
    const out = path.join(outDir, 'out.ipa');
    const res = runCli(['--ipa', fakeIpa, '--endpoint=none', '--out', out]);
    const log = cliLog(res);
    assert.strictEqual(res.status, 1, `默认应拒绝（退出码 1），实际 status=${res.status} signal=${res.signal}\n${log}`);
    assert.match(log, /输入基座指纹不匹配/, '应打印拒绝原因');
    assert.match(log, /expected=\d+ actual=\d+/, '应给出 expected=… actual=… 形态的逐条差异');
    assert.match(log, /expected=[0-9a-f]{64} actual=[0-9a-f]{64}/, 'sha256 也应逐条列出');
    assert.ok(!fs.existsSync(out), '被拒绝时不得写出任何产物');
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

// ── ④ 负向自证：把 0xb00c 改成非期望值 ⇒ 逐点「期望字节」fail-fast 必须红 ──
// 这条用例的价值不在"绿"，而在**证明红线真的会响**：没有它，前面所有"fail-fast 断言"都可能是摆设。
// 用 --allow-foreign-base 是为了越过指纹闸门、把失败**逼到 guard 站点校验那一层**（否则只会看到指纹拒绝）。
test('负向自证：0xb00c 被改成 0xdeadbeef 时逐点断言必须红（退出码 2 + 原指令不匹配）', { skip: FIXTURE_SKIP }, () => {
  const outDir = mkTmp('ipa-corrupt-');
  try {
    const binIn = path.join(outDir, 'corrupt.bin');
    const buf = Buffer.from(officialMainBinary());
    buf.writeUInt32LE(0xdeadbeef, 0xb00c);          // 故意破坏期望字节
    fs.writeFileSync(binIn, buf);
    const res = runCli(['--bin', binIn, '--endpoint=none', '--guard-mode=launch',
      '--allow-foreign-base', '--out', path.join(outDir, 'corrupt.out.bin')]);
    const log = cliLog(res);
    assert.strictEqual(res.status, 2, `断言失败应以退出码 2 结束，实际 status=${res.status} signal=${res.signal}\n${log}`);
    // 文案格式照 wfcore tools/lib/patch.mjs:180-199
    assert.match(log, /原指令不匹配 file=0xb00c expected=0xb9000109 actual=0xdeadbeef/,
      '必须给出 原指令不匹配 file=… expected=… actual=… 的逐点诊断');
    assert.match(log, /FAILED —— 以下断言未通过/, '应打印失败断言清单');
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
