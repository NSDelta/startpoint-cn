#!/usr/bin/env node
// check-test-patterns.mjs —— 工作流里那些 grep 模式，拿本机真实测试输出对一遍。
//
// 为什么值得单独一个脚本：工作流里写的是 `grep -q "125 passed"`，模式写错
// （大小写、空格、被中文包围）会让这一步**永远通过**或**永远失败**，而两种
// 情况在 CI 上都只是"一条日志"，很容易被当成 flaky 忽略掉。
// 这里用 MSVC 产出的真实输出做判据；clang 产出的格式由同一份 printf 决定。
//
// ★ 模式**从工作流里现读**，不在这里另抄一份表。
//   起初这里是一张硬编码的表，于是它自己变成了第三个需要同步的地方：
//   test_fft 从 119 涨到 125 那次，工作流改了、这张表没改，脚本报的是
//   「工作流里的模式需要修正」—— 而工作流其实是对的。**判据抄一份就多一个
//   会漂的副本**，所以现在解析工作流里的 `run <exe> "<dir>" "<want>"` 行。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || ".";
const wf = process.argv[3] || path.join(root, "..", "..", ".github", "workflows", "ios-autoclick.yml");

if (!fs.existsSync(wf)) {
  console.error(`找不到工作流：${wf}`);
  process.exit(2);
}

// 形如：  run test_fft          ""                    "125 passed" || true
//   ★ 行尾的 `|| true` 是承重的（不再用守卫式写法的那个教训），所以模式**不能**
//     以 `$` 结尾 —— 第一版写了 `\s*$`，于是 7 行一条都匹配不上。
//     当时的报错信息是「工作流里没解析出任何 run 行」，那是**症状**：真正的原因是
//     我为 `[ 条件 ] && 动作` 加 `|| true` 时改了工作流、没改这个模式。
//   ★ 结尾的 `\s*(?:#.*)?$` 允许行尾注释，别再把注释当成不匹配。
const re = /^\s*run\s+(\S+)\s+"([^"]*)"\s+"([^"]+)"[^\n]*$/gm;
const cases = [];
for (const m of fs.readFileSync(wf, "utf8").matchAll(re)) {
  cases.push([m[1], m[2], m[3]]);
}
// 期望至少 7 条（七套测试）。★ 这条上界是承重的：模式一旦失配，脚本会打印
// 「0 个不匹配 / 工作流里的 grep 模式与真实输出一致」—— **全绿而什么都没验**。
// 少一条就说明我又改了工作流的写法而没改模式，必须停下来看一眼。
if (cases.length < 7) {
  console.error(`工作流里只解析出 ${cases.length} 条 run 行（至少应有 7 条）：${wf}`);
  console.error(`模式：${re}`);
  process.exit(2);
}

let bad = 0, total = 0;
for (const [exe, dir, want] of cases) {
  const p = `${root}/tests/build/${exe}.exe`;
  if (!fs.existsSync(p)) { console.log(`SKIP  ${exe}（没编出来）`); continue; }
  let out, rc = 0;
  try {
    out = execFileSync(p, dir ? [dir] : [], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
    rc = e.status ?? -1;
  }
  const hit = out.includes(want);
  const m = /(\d+) passed/.exec(out);
  const n = m ? Number(m[1]) : 0;
  total += n;
  if (!hit || rc !== 0) bad += 1;
  console.log(`${hit && rc === 0 ? "ok  " : "FAIL"}  ${exe.padEnd(17)} want="${want}" got=${n} rc=${rc}`);
  if (!hit) {
    const tail = out.trim().split("\n").slice(-3).join(" | ");
    console.log(`       实际结尾：${tail}`);
  }
}
console.log(`\n合计 ${total} 例，${bad} 个不匹配（模式读自 ${path.basename(wf)}）。`);
console.log(bad === 0 ? "工作流里的 grep 模式与真实输出一致。" : "工作流里的模式需要修正。");

// ── `--selftest`：阴性对照 ──────────────────────────────────────────────────
// ★ 本脚本的正面结论是「0 个不匹配」，而**这正是它失配时也会打印的东西**
//   （上面的 `cases.length < 7` 是为此加的）。所以还要一条反过来的断言：
//   把工作流里每个期望值改成一个绝不可能出现的数字，断言本脚本**确实报错**。
//   两层加起来才说明「0 个不匹配」是有意义的。
//   注意：先 `process.exit` 放在最前面，是因为下面会 spawn 自己；
//   spawn 出来的那一份没有 `--selftest`，所以不会递归。
if (process.argv.includes("--selftest")) {
  const text = fs.readFileSync(wf, "utf8");
  let mutated = text;
  for (const [, , want] of cases) {
    mutated = mutated.replace(`"${want}"`, '"1 passed"');
  }
  const tmp = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp",
    `am-patterns-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
  fs.writeFileSync(tmp, mutated, "utf8");
  let rc = 0, out = "";
  try {
    out = execFileSync(process.execPath, [process.argv[1], root, tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    rc = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || "");
  }
  fs.unlinkSync(tmp);
  const good = rc !== 0;
  console.log("");
  console.log("── --selftest：阴性对照（把 7 个期望值都改成 `1 passed`，必须报错）");
  console.log(`${good ? "ok  " : "MISS"}  变异后的工作流 -> 检查退出码 ${rc}`);
  if (!good) console.log(`      （没报错，输出尾部：${out.trim().split("\n").slice(-3).join(" / ")}）`);
  console.log(`阴性对照 ${good ? "1/1" : "0/1"} 命中`);
  process.exit(good ? 0 : 1);
}
process.exit(bad === 0 ? 0 : 1);
