#!/usr/bin/env node
// check-test-patterns.mjs —— 工作流里那些 grep 模式，拿本机真实测试输出对一遍。
//
// 为什么值得单独一个脚本：工作流里写的是 `grep -q "119 passed"`，模式写错
// （大小写、空格、被中文包围）会让这一步**永远通过**或**永远失败**，而两种
// 情况在 CI 上都只是"一条日志"，很容易被当成 flaky 忽略掉。
// 这里用 MSVC 产出的真实输出做判据；clang 产出的格式由同一份 printf 决定。

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const root = process.argv[2] || ".";
const cases = [
  ["test_fft", "", "119 passed"],
  ["test_json", "matcher_golden_pkg", "84 passed"],
  ["test_script", "matcher_golden_pkg/pkg", "56 passed"],
  ["test_matcher", "matcher_golden", "13 passed"],
  ["test_matcher_neg", "matcher_golden_neg", "18 passed"],
  ["test_package", "matcher_golden_pkg", "21 passed"],
  ["test_engine", "matcher_golden_pkg/pkg", "60 passed"],
];

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
console.log(`\n合计 ${total} 例，${bad} 个不匹配。`);
console.log(bad === 0 ? "工作流里的 grep 模式与真实输出一致。" : "工作流里的模式需要修正。");
process.exit(bad === 0 ? 0 : 1);
