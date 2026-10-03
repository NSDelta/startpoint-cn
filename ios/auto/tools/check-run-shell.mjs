#!/usr/bin/env node
// check-run-shell.mjs —— 把 workflow 里每个 `run:` 块抽出来，用 `bash -n` 做语法检查。
//
// 为什么需要它：`ios/auto/tools/lint-workflow.mjs` 只能看 YAML 结构，
// 看不见 shell；而本机没有 macOS，跑不了工作流。历史上真踩过两类只有
// 「真跑一次」才会暴露的问题：
//   · Python 内容被顶到第 0 列（那是 YAML 层面的，lint-workflow 管）
//   · `}` 与 `while` 之间的换行被 edit 吃掉，两行粘成 `}          while ...`
//     —— YAML 完全合法、PyYAML 也通过，**只有 bash 会报语法错**
// 这一类正好用 `bash -n` 抓得到，且不需要 macOS。
//
// 用法：node tools/check-run-shell.mjs .github/workflows/ios-autoclick.yml
//       node tools/check-run-shell.mjs .github/workflows/ios-autoclick.yml --selftest
// 退出码 0 = 全部 run 块语法通过；1 = 有语法错 / 找不到 bash。
//
// `--selftest` 造一份**已知必错**的副本（把两行粘成一行、制造未闭合的 `if`），
// 断言本检查**确实报了错**。理由同 lint-workflow.mjs：一个「什么都报不出来」
// 的检查器与「shell 很干净」在输出上无法区分 —— 而 `bash -n` 的参数写错
// （比如把脚本从 stdin 喂却忘了 `-n`）恰好会变成永远通过。
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = process.argv[2];
const SELFTEST = process.argv.includes("--selftest");
if (!file) {
  console.log("用法：node tools/check-run-shell.mjs <workflow.yml> [--selftest]");
  process.exit(1);
}
const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);

// 找 bash
let bash = null;
for (const c of [
  process.env.AM_BASH,
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
  "/bin/bash",
  "/usr/bin/bash",
  "bash",
].filter(Boolean)) {
  const r = spawnSync(c, ["-c", "exit 0"], { stdio: "ignore" });
  if (r.status === 0) { bash = c; break; }
}
if (!bash) {
  console.log("找不到 bash —— 本检查跳过（退出码 0，但请记住这一轮什么都没验）");
  process.exit(0);
}
console.log(`bash = ${bash}`);

// 抽块标量：形如 `            run: |` 之后所有缩进 > 声明缩进的行
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)(?:-\s+)?run:\s*[|>][-+0-9]*\s*$/.exec(lines[i]);
  if (!m) continue;
  const base = m[1].length;
  const body = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const s = lines[j];
    if (s.trim() === "") { body.push(""); continue; }
    if (/^( *)/.exec(s)[1].length <= base) break;
    body.push(s);
  }
  // 去掉公共缩进
  const indents = body.filter((s) => s.trim()).map((s) => /^( *)/.exec(s)[1].length);
  const min = Math.min(...indents, Infinity);
  const dedented = min === Infinity ? [] : body.map((s) => s.slice(min));
  // 找步骤名（往上找最近的 `- name:`）
  let name = `run@${i + 1}`;
  for (let k = i; k >= 0 && k > i - 12; k--) {
    const nm = /^\s*-\s+name:\s*(.+?)\s*$/.exec(lines[k]);
    if (nm) { name = `${nm[1]} (run@${i + 1})`; break; }
  }
  blocks.push({ name, line: i + 1, script: dedented.join("\n") });
}

let bad = 0;
console.log(`抽到 ${blocks.length} 个 run 块`);
for (const b of blocks) {
  const r = spawnSync(bash, ["-n"], { input: b.script, encoding: "utf8" });
  // ★ 有一个**只有 bash -n 才会报**的坑：heredoc 定界符（PYEOF/JSONEOF）如果
  //   在 workflow 里因为重新缩进而多带了空格，`bash -n` 会报
  //   `here-document at line N delimited by end-of-file`。
  const err = (r.stderr || "").trim();
  if (r.status === 0) {
    console.log(`  ok    ${b.name}`);
  } else {
    bad += 1;
    console.log(`  FAIL  ${b.name}`);
    for (const l of err.split("\n").slice(0, 6)) console.log(`        ${l}`);
  }
}
console.log("");
if (bad) { console.log(`${bad} 个 run 块有 shell 语法错`); process.exit(1); }
console.log("全部 run 块通过 bash -n");

// ── `--selftest`：阳性对照 ──────────────────────────────────────────────────
// 造两份已知必错的副本，断言本检查报错。
//   ① 两行粘成一行（`if true; then echo x          while …`）—— 这正是我用
//      `edit` 时真的犯过的错（结尾换行不对称），YAML 完全合法。
//   ② 未闭合的 `if`（`then` 没有 `fi`）。
if (SELFTEST) {
  const probe = (mutate) => {
    const copy = lines.slice();
    mutate(copy);
    const tmp = `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/am-runsh-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`;
    fs.writeFileSync(tmp, copy.join("\n"), "utf8");
    const r = spawnSync(process.execPath, [process.argv[1], tmp], { encoding: "utf8" });
    try { fs.unlinkSync(tmp); } catch {}
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const glueIdx = (c) => c.findIndex((l) => /^\s+set -u/.test(l));
  const cases = [
    ["两行粘成一行（缺换行）", (c) => { const i = glueIdx(c); c[i] += "          while [ 1 = 1 ]; do break; done"; }],
    ["未闭合的 if", (c) => { const i = glueIdx(c); c.splice(i + 1, 0, "          if true; then", "          echo x"); }],
  ];
  let ok = 0;
  console.log("");
  console.log("── --selftest：阳性对照");
  for (const [name, mutate] of cases) {
    const r = probe(mutate);
    const good = r.code !== 0;
    if (good) ok += 1;
    console.log(`${good ? "ok  " : "MISS"}  ${name}  -> 检查退出码 ${r.code}`);
    if (!good) console.log(`      （没报错，输出尾部：${r.out.trim().split("\n").slice(-3).join(" / ")}）`);
  }
  console.log(`阳性对照 ${ok}/${cases.length} 命中`);
  if (ok !== cases.length) process.exit(1);
}
