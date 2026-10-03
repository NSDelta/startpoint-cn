#!/usr/bin/env node
// 极简 YAML 体检：本机没有 yaml 库，所以只做「能抓住真实错误」的那几项检查。
// 不是通用 YAML validator，故意保守：宁可漏报也不要误报。
import fs from "node:fs";

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

console.log("");
if (issues.length) {
  console.log(`发现 ${issues.length} 个问题：`);
  for (const s of issues) console.log("  " + s);
  process.exit(1);
}
console.log(miss === 0 ? "结构体检通过，关键锚点齐全。" : `结构体检通过，但有 ${miss} 个锚点缺失。`);
