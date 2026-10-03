#!/usr/bin/env node
// 极简 YAML 体检：本机没有 yaml 库，所以只做「能抓住真实错误」的那几项检查。
// 不是通用 YAML validator，故意保守：宁可漏报也不要误报。
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const src = fs.readFileSync(process.argv[2], "utf8");
const lines = src.split(/\r?\n/);
const issues = [];

lines.forEach((l, i) => {
  const ln = i + 1;
  if (/\t/.test(l)) issues.push(`${ln}: 含 TAB（YAML 禁止 tab 缩进）`);
  const open = (l.match(/\$\{\{/g) || []).length;
  const close = (l.match(/\}\}/g) || []).length;
  if (open !== close) issues.push(`${ln}: \${{ }} 不配对 -> ${l.trim().slice(0, 70)}`);
  // 行尾多余空格在 YAML 里无害，但块标量（run: |）里会破坏缩进语义，提一下
  if (/:\s*\|\s*$/.test(l) && /\s$/.test(l)) issues.push(`${ln}: 块标量声明行尾有空格`);
});

// 缩进必须是 2 的倍数（本文件全用 2 空格），且不能出现 1/3 空格混合缩进
lines.forEach((l, i) => {
  if (!l.trim() || l.trim().startsWith("#")) return;
  const m = /^( +)/.exec(l);
  if (m && m[1].length % 2 !== 0) issues.push(`${i + 1}: 缩进 ${m[1].length} 不是 2 的倍数 -> ${l.trim().slice(0, 60)}`);
});

// 顶层键（缩进 0 且不是注释/空行）
const topKeys = lines.filter((l) => /^[A-Za-z_][^:]*:/.test(l)).map((l) => l.split(":")[0]);
console.log(`文件行数 : ${lines.length}`);
console.log(`顶层键   : ${topKeys.join(", ")}`);

// 关键锚点：这些漏了就等于工作流静默失效
const anchors = [
  ["name: ios-autoclick", "workflow 名"],
  ["pkg: [tweak, dylib]", "matrix 两个交付物"],
  ['scheme: ["rootless", ""]', "matrix 两个 scheme"],
  ["secrets.GITHUB_TOKEN", "诊断分支推送的 token（不能用 $GITHUB_TOKEN）"],
  ["permissions:", "contents: write"],
  ["matrix.pkg == 'tweak'", "tweak 专属步骤的条件"],
  ["exit 0", "诊断步骤必须显式成功"],
  ["cp \"$RUNNER_TEMP/build.log\"", "日志落地到 runner.temp（不在工作树里）"],
];
let miss = 0;
for (const [k, why] of anchors) {
  const ok = lines.some((l) => l.includes(k));
  if (!ok) miss += 1;
  console.log(`${ok ? "ok  " : "MISS"}  ${k}   —— ${why}`);
}

// 危险写法：目录级 git add（遇到被忽略的路径会整体失败）
const dirAdd = lines.filter((l) => /git add -f --? "\$DIAG_DIR"\s*$|git add -A|git add \./.test(l));
if (dirAdd.length) issues.push(`目录级 git add（应为逐文件）：${dirAdd.join(" | ")}`);

// ★ 块标量（`run: |`）里出现**第 0 列的非空行** = 该行不再是 run 的内容。
//   真踩过（第 16 次 CI 之后）：内联的 `python3 -c '` 多行脚本被顶到第 0 列，
//   python 语句里的 `d = …` 被 YAML 当成「顶层 mapping 的 key」，PyYAML 直接报
//   `while scanning a simple key … could not find expected ':'`。用了 15 轮
//   CI 才第一次撞上，因为这是唯一一处把脚本内容内联进 `run:` 的地方。
//   判据：**第 0 列的行若「拥有」一个缩进更深的后续行**，它就必须像一个 YAML 键
//   （或列表项 `- …`）；否则一定是从某个块标量里脱出来的。这样
//   `.github/…`、`ios/…` 这类不带缩进的裸路径行不会误报。
const TOP_KEYS = ["name", "on", "permissions", "jobs", "env", "defaults", "concurrency", "run-name"];
lines.forEach((l, i) => {
  if (!l.trim() || /^\s/.test(l)) return;
  if (/^(?:-\s|[A-Za-z_][\w.-]*:(?:\s|$))/.test(l)) return;   // 像 YAML 键 / 列表项
  const k = lines.findIndex((s, j) => j > i && s.trim() !== "");
  if (k > i && /^\s/.test(lines[k])) {
    issues.push(`${i + 1}: 第 0 列内容却带着缩进更深的后续行 —— 从块标量里脱出来了 -> ${l.trim().slice(0, 50)}`);
  }
});
{ // 顶层键白名单（脱出来的 python 语句若含 `:` 会被当成键）
  for (const [i, l] of lines.entries()) {
    if (!/^[A-Za-z_][\w.-]*:/.test(l)) continue;
    const key = l.split(":")[0];
    if (!TOP_KEYS.includes(key)) issues.push(`${i + 1}: 顶层键 ${JSON.stringify(key)} 不在白名单（块标量脱出？）-> ${l.trim().slice(0, 50)}`);
  }
}

console.log("");
if (issues.length) {
  console.log(`发现 ${issues.length} 个问题：`);
  for (const s of issues) console.log("  " + s);
  process.exit(1);
}
console.log(miss === 0 ? "结构体检通过，关键锚点齐全。" : `结构体检通过，但有 ${miss} 个锚点缺失。`);

// ── `--selftest`：阳性对照 ──────────────────────────────────────────────────
// ★ 一个「什么都报不出来」的检查器与「工作流很干净」在输出上完全无法区分。
//   这一段把**已知必错**的变异注进一份内存副本，断言体检**确实报了错**。
//   没有这一步，上面那句「结构体检通过」什么都证明不了。
//   实测抓到的真事：块标量脱出那条规则第一版写成
//   `/^\s*(?:-\s+)?[A-Za-z_][\w.-]*:\s*[|>][-+0-9]*\s*$/`，在 JS 字面量里
//   `\s*$` 的 `$` 前面被多打了一个反斜杠（`\$` = 字面美元符），于是**一条都没匹配**，
//   而它对坏文件照样打印「结构体检通过」。
if (process.argv.includes("--selftest")) {
  const probe = (mutate) => {
    const copy = src.split(/\r?\n/);
    mutate(copy);
    const tmp = `${process.env.TEMP || process.env.TMPDIR || "/tmp"}/am-lint-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`;
    fs.writeFileSync(tmp, copy.join("\n"), "utf8");
    const r = spawnSync(process.execPath, [process.argv[1], tmp], { encoding: "utf8" });
    try { fs.unlinkSync(tmp); } catch {}
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const cases = [
    ["块标量脱出（python 顶到第 0 列）", (c) => {
      const i = c.findIndex((l) => /^\s+set -u/.test(l));
      c.splice(i + 1, 0, "import plistlib, sys", 'd = plistlib.load(open(sys.argv[1], "rb"))');
    }],
    ["块标量脱出（shell 顶到第 0 列）", (c) => {
      const i = c.findIndex((l) => /^\s+set -u/.test(l));
      c.splice(i + 1, 0, "echo hello");
    }],
    ["顶层键白名单", (c) => {
      const i = c.findIndex((l) => /^\s+set -u/.test(l));
      c.splice(i + 1, 0, "BogusKey: 1", "  nested: 2");
    }],
    ["目录级 git add", (c) => { c.push("      run: git add -A"); }],
    ["\${{ }} 不配对", (c) => { c.push("      run: echo \${{ github.sha"); }],
  ];
  let ok = 0;
  console.log("");
  console.log("── --selftest：阳性对照（每个变异都必须被报出来）");
  for (const [name, mutate] of cases) {
    const r = probe(mutate);
    const good = r.code !== 0;
    if (good) ok += 1;
    console.log(`${good ? "ok  " : "MISS"}  ${name}  -> 体检退出码 ${r.code}`);
    if (!good) console.log(`      （体检没有报错，输出尾部：${r.out.trim().split("\n").slice(-3).join(" / ")}）`);
  }
  console.log(`阳性对照 ${ok}/${cases.length} 命中`);
  if (ok !== cases.length) process.exit(1);
}
