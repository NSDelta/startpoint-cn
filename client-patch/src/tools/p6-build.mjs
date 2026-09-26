#!/usr/bin/env node
/**
 * P6 构建链（路线 B：只换既有方法体）+ 强制回读校验。
 *
 *   AS3 源（可读中文）
 *     → p6-escape.mjs 转义为非 ASCII 全 \uXXXX 的纯 ASCII 源
 *     → 路线 A：-replace <base.swf> <stageA.swf> <FQCN> <ascii.as>     （把 FFDec 当 AS3 编译器用）
 *     → -format script:pcode -selectclass <FQCN> -export script        （导出整类 pcode）
 *     → 按 trait 名抽出每个靶方法块
 *     → 路线 B：逐个 -replace <in.swf> <out.swf> <FQCN> <block.pcode> <bodyIndex>   回填**原始** base.swf
 *     → 回读校验（见 verify()）：空体判 FAIL、其它方法体逐字节不变、方法体/DoABC 计数不变、pcode 往返一致
 *
 * 复用 P0 探针（client-patch/build/00_probe.mjs）里已经过实测的 ABC 解析与 pcode 抽块函数：
 * 该文件本身是 CLI（末尾直接 main()），本脚本在临时目录生成一份「去掉末尾 main() 并补 export」的
 * shim 再 import，从而**不复制**解析代码，也不改动 P0 的领地。
 *
 * 用法：
 *   node p6-build.mjs [--base <swf>] [--out <swf>] [--work <目录>] [--ffdec <jar>] [--list]
 *   --list 只解析并打印靶方法的 bodyIndex，不编译不替换。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const PROBE = path.join(REPO, "client-patch", "build", "00_probe.mjs");
const SRC = path.join(REPO, "client-patch", "src", "pinball", "channels", "dummy", "ChannelSDKDummy.as");
const ESCAPE = path.join(HERE, "p6-escape.mjs");

const FQCN = "pinball.channels.dummy.ChannelSDKDummy";
const PKG = "pinball.channels.dummy";
const LEAF = "ChannelSDKDummy";
/** 靶方法体（全部是既有方法；顺序 = 路线 B 的链式替换顺序） */
const TARGETS = ["startLoginServer", "testLogin", "testLoginReport", "testHeartbeat", "dispose"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) out[m[1]] = m[2];
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[m[1]] = argv[++i];
    else out[m[1]] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const BASE = path.resolve(String(args.base || "D:\\wfcnmod\\tmp\\p0\\work\\base.swf"));
const WORK = path.resolve(String(args.work || "D:\\wfcnmod\\tmp\\p6\\build"));
const OUT = path.resolve(String(args.out || "D:\\wfcnmod\\tmp\\p6\\out\\sp-cn-p6-pcode.swf"));
const FFDEC_JAR = String(args.ffdec || "D:\\wfcnmod\\server\\work\\tools\\ffdec.jar");
const LIST_ONLY = args.list !== undefined;

for (const [n, p] of [["base", BASE], ["work", WORK], ["out", OUT], ["ffdec", FFDEC_JAR]]) {
  if (!/^[\x20-\x7e]+$/.test(p)) {
    console.error(`ERROR ${n} 含非 ASCII 字符（FFDec/java 会出错）：${p}`);
    process.exit(2);
  }
}

const log = (...a) => console.log("[p6]", ...a);
const step = (s) => console.log(`\n=== ${s} ===`);
const sha256File = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const failures = [];
const assert = (cond, msg) => {
  if (cond) log("PASS", msg);
  else {
    failures.push(msg);
    console.error("FAIL", msg);
  }
  return !!cond;
};

/** 载入 P0 探针的函数（不改其文件，用临时 shim） */
async function loadProbe() {
  const src = fs.readFileSync(PROBE, "utf8");
  if (!/\nmain\(\);\s*$/.test(src)) throw new Error("探针结构变了：找不到末尾的 main(); 调用");
  const shim = src.replace(/\nmain\(\);\s*$/, "\n") +
    "\nexport { indexSwfMethods, requireRef, extractMethodBlock, ffdec, run, sha256File };\n";
  const shimPath = path.join(WORK, "probe-shim.mjs");
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(shimPath, shim, "utf8");
  // 探针顶层会校验 --base/--work/--out（只校验，不执行 main），这里补上合法 ASCII 值
  process.argv.push("--base", BASE, "--work", WORK, "--out", WORK, "--ffdec", FFDEC_JAR);
  return import(pathToFileURL(shimPath).href + "?t=" + Date.now());
}

/** 去掉 debug 行后逐行比较：路线 B 往返不保证 debug 行号一致，但指令必须一致 */
function normalizeBlock(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("debug "))
    .join("\n");
}

const main = async () => {
  step("0/6 环境");
  log(`repo=${REPO}`);
  log(`base=${BASE} (${fs.existsSync(BASE) ? `${fs.statSync(BASE).size} B sha256=${sha256File(BASE).slice(0, 16)}…` : "缺失!"})`);
  log(`src=${SRC}`);
  log(`ffdec=${FFDEC_JAR}`);
  if (!fs.existsSync(BASE)) throw new Error(`base SWF 不存在：${BASE}`);
  if (!fs.existsSync(SRC)) throw new Error(`源文件不存在：${SRC}`);
  if (!fs.existsSync(PROBE)) throw new Error(`探针不存在：${PROBE}`);
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const probe = await loadProbe();

  step("1/6 索引基座 SWF，解析靶方法 bodyIndex");
  const idxBase = probe.indexSwfMethods(BASE);
  log(`DoABC tag=${idxBase.abcCount}  方法体总数=${idxBase.bodyCount}`);
  const refs = {};
  for (const t of TARGETS) {
    refs[t] = probe.requireRef(idxBase, `${PKG}:${LEAF}/${t}`);
    log(`  ${t} → abcIndex=${refs[t].abcIndex} bodyIndex=${refs[t].bodyIndex} 原字节码=${refs[t].codeLen} B sha=${refs[t].codeSha.slice(0, 12)}…`);
  }
  const targetIds = new Set(Object.values(refs).map((r) => r.id));
  const baseByld = new Map(idxBase.refs.map((r) => [r.id, r]));
  assert(Object.keys(refs).length === TARGETS.length, `解析到 ${TARGETS.length} 个靶方法体`);

  if (LIST_ONLY) {
    console.log(JSON.stringify({
      base: { path: BASE, bytes: fs.statSync(BASE).size, sha256: sha256File(BASE) },
      abc_count: idxBase.abcCount,
      body_count: idxBase.bodyCount,
      targets: Object.fromEntries(TARGETS.map((t) => [t, { abcIndex: refs[t].abcIndex, bodyIndex: refs[t].bodyIndex, codeLen: refs[t].codeLen }])),
    }, null, 2));
    return;
  }

  step("2/6 转义非 ASCII（源 → 纯 ASCII，喂 FFDec）");
  const ascii = path.join(WORK, `${LEAF}.ascii.as`);
  probe.run(process.execPath, [ESCAPE, SRC, ascii]);
  assert(fs.existsSync(ascii), "生成 ASCII 源");
  assert(/^[\x00-\x7F]*$/.test(fs.readFileSync(ascii, "ascii")), "ASCII 源无非 ASCII 字节");

  step("3/6 路线 A：把 FFDec 当 AS3 编译器（产出 stageA.swf，仅用于取 pcode）");
  const stageA = path.join(WORK, "stageA.swf");
  fs.rmSync(stageA, { force: true });
  let routeAOk = true;
  try {
    probe.ffdec(["-replace", BASE, stageA, FQCN, ascii]);
  } catch (e) {
    routeAOk = false;
    console.error(String(e.message || e));
  }
  assert(routeAOk && fs.existsSync(stageA), "路线 A 编译通过并产出 stageA.swf");

  step("4/6 导出整类 pcode 并抽块");
  const pcDir = path.join(WORK, "pcode_stageA");
  fs.rmSync(pcDir, { recursive: true, force: true });
  probe.ffdec(["-format", "script:pcode", "-selectclass", FQCN, "-export", "script", pcDir, stageA]);
  const pcFile = path.join(pcDir, "scripts", ...FQCN.split(".")) + ".pcode";
  if (!fs.existsSync(pcFile)) throw new Error(`pcode 导出缺文件：${pcFile}`);
  const pcText = fs.readFileSync(pcFile, "utf8");
  log(`pcode=${pcFile} (${pcText.length} chars)`);
  const blocks = {};
  const blkDir = path.join(WORK, "blocks");
  fs.rmSync(blkDir, { recursive: true, force: true });
  fs.mkdirSync(blkDir, { recursive: true });
  for (const t of TARGETS) {
    const blk = probe.extractMethodBlock(pcText, "method", t);
    blocks[t] = blk.text;
    const f = path.join(blkDir, `${t}.pcode`);
    fs.writeFileSync(f, blk.text, "utf8");
    const nonEmpty = /end ; code/.test(blk.text) && blk.text.replace(/\s/g, "").length > 200;
    log(`  块 ${t}: 行 ${blk.startLine}-${blk.endLine}  ${Buffer.byteLength(blk.text, "utf8")} B  非空=${nonEmpty}`);
    assert(nonEmpty, `块 ${t} 非空且含 end ; code`);
  }

  step("5/6 路线 B：逐个靶方法体回填到原始 base.swf（链式）");
  let cur = BASE;
  const chain = [];
  TARGETS.forEach((t, i) => {
    const out = path.join(WORK, `stageB${i + 1}_${t}.swf`);
    fs.rmSync(out, { force: true });
    probe.ffdec(["-replace", cur, out, FQCN, path.join(blkDir, `${t}.pcode`), String(refs[t].bodyIndex)]);
    const ok = fs.existsSync(out) && fs.statSync(out).size > 0;
    assert(ok, `路线 B 第 ${i + 1} 步（${t}, bodyIndex=${refs[t].bodyIndex}）产出 SWF`);
    chain.push({ method: t, bodyIndex: refs[t].bodyIndex, out, bytes: ok ? fs.statSync(out).size : 0 });
    cur = out;
  });
  fs.copyFileSync(cur, OUT);
  log(`最终 SWF → ${OUT}`);

  step("6/6 回读校验（只看 exit code 是不允许的）");
  const idxFinal = probe.indexSwfMethods(OUT);
  assert(idxFinal.abcCount === idxBase.abcCount, `DoABC tag 数不变（${idxBase.abcCount} → ${idxFinal.abcCount}）`);
  assert(idxFinal.bodyCount === idxBase.bodyCount, `方法体总数不变（${idxBase.bodyCount} → ${idxFinal.bodyCount}）`);
  assert(fs.statSync(OUT).size > fs.statSync(BASE).size, `产物比 base 大（${fs.statSync(BASE).size} → ${fs.statSync(OUT).size} B，反例：块缺失会被写成空体且变小）`);

  const finalById = new Map(idxFinal.refs.map((r) => [r.id, r]));
  const changedOther = [];
  let missing = 0;
  for (const [id, r] of baseByld) {
    if (targetIds.has(id)) continue;
    const f = finalById.get(id);
    if (!f) {
      missing += 1;
      continue;
    }
    if (f.codeSha !== r.codeSha) changedOther.push(id);
  }
  assert(missing === 0, `基座全部方法体在产物中仍存在（缺失 ${missing}）`);
  assert(changedOther.length === 0, `除靶方法外其它方法体逐字节不变（变了 ${changedOther.length} 个${changedOther.length ? "：" + changedOther.slice(0, 8).join(",") : ""}）`);

  // 靶方法：产物中必须能被完整回读成与注入块一致的 pcode（空体在此判死）
  const pcDir2 = path.join(WORK, "pcode_final");
  fs.rmSync(pcDir2, { recursive: true, force: true });
  probe.ffdec(["-format", "script:pcode", "-selectclass", FQCN, "-export", "script", pcDir2, OUT]);
  const pc2 = fs.readFileSync(path.join(pcDir2, "scripts", ...FQCN.split(".")) + ".pcode", "utf8");
  for (const t of TARGETS) {
    const blk = probe.extractMethodBlock(pc2, "method", t);
    const same = normalizeBlock(blk.text) === normalizeBlock(blocks[t]);
    const len = blk.text.replace(/\s/g, "").length;
    assert(same, `靶方法 ${t} 回读 pcode 与注入块逐行一致（归一化去 debug 行；块长度 ${len}）`);
    const refF = finalById.get(refs[t].id);
    assert(refF && refF.codeLen > 64, `靶方法 ${t} 产物字节码非空（${refF ? refF.codeLen : "?"} B，基座原为 ${refs[t].codeLen} B）`);
  }
  const report = {
    generated_at: new Date().toISOString(),
    route: "B: pcode-method-body-replace",
    fqcn: FQCN,
    base: { path: BASE, bytes: fs.statSync(BASE).size, sha256: sha256File(BASE), abc_count: idxBase.abcCount, body_count: idxBase.bodyCount },
    source: { path: SRC, ascii: ascii, ascii_bytes: fs.statSync(ascii).size },
    targets: TARGETS.map((t) => ({
      method: `${PKG}:${LEAF}/${t}`,
      abcIndex: refs[t].abcIndex,
      bodyIndex: refs[t].bodyIndex,
      base_code_bytes: refs[t].codeLen,
      final_code_bytes: finalById.get(refs[t].id) ? finalById.get(refs[t].id).codeLen : null,
      block_bytes: Buffer.byteLength(blocks[t], "utf8"),
    })),
    chain,
    output: { path: OUT, bytes: fs.statSync(OUT).size, sha256: sha256File(OUT) },
    assertions: { failures },
  };
  const repPath = path.join(WORK, "p6-build-report.json");
  fs.writeFileSync(repPath, JSON.stringify(report, null, 2), "utf8");
  log(`report → ${repPath}`);
  console.log(JSON.stringify(report.targets, null, 2));
  if (failures.length) {
    console.error(`\nFAIL P6 构建链断言未通过（${failures.length} 条）`);
    process.exit(1);
  }
  log("\nALL PASS");
};

main().catch((e) => {
  console.error("ABORT", e && e.stack ? e.stack : e);
  process.exit(1);
});
