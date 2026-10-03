#!/usr/bin/env node
// selftest-check-objc.mjs —— check-objc.mjs 自检。
//
// 为什么需要：一个「什么都报不出来」的检查器与「代码很干净」在输出上无法区分。
// 本脚本对每个检查项植入一个**已知必错**的变体，断言检查器确实报了出来，
// 然后还原。用 node 改文件而不是 PowerShell —— Get-Content -Raw / Set-Content
// 会给 UTF-8 文件加 BOM 并破坏中文注释（这个坑本项目踩过）。

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2] || ".";
const target = path.join(root, "ios", "AMTouch.m");
const targetH = path.join(root, "ios", "AMTouch.h");

const original = fs.readFileSync(target, "utf8");
const originalH = fs.readFileSync(targetH, "utf8");

const cases = [
  {
    name: "括号不配平（删一个 })",
    file: target, orig: original,
    mutate: (s) => s.replace(/\n\}\n/, "\n"),   // 删掉第一个顶格的 '}'
    expect: /括号/,
  },
  {
    name: "@end 缺失",
    file: target, orig: original,
    mutate: (s) => s.replace(/\n@end\n/, "\n"),
    expect: /@end/,
  },
  {
    name: "声明了但没实现",
    file: targetH, orig: originalH,
    // 注意：这里必须用头文件里**逐字**存在的声明（第一版写成 `- (nullable NSString *)backendName;`
    // 而真身是 `- (NSString *)backendName;`，替换没生效 ⇒ 自检 "MISS" 其实是探针自己的 bug）。
    mutate: (s) => s.replace(/- \(nullable NSString \*\)describeHitAtPoint:\(CGPoint\)pointInWindow;/,
                             "- (nullable NSString *)describeHitAtPointXX:(CGPoint)pointInWindow;"),
    expect: /没找到实现/,
  },
  {
    name: "CRLF",
    file: target, orig: original,
    mutate: (s) => s.replace(/\n/g, "\r\n"),
    expect: /CRLF/,
  },
];

let bad = 0;
for (const c of cases) {
  fs.writeFileSync(c.file, c.mutate(c.orig));
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(root, "tools", "check-objc.mjs"), root],
                       { encoding: "utf8" });
  } catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  fs.writeFileSync(c.file, c.orig);
  const caught = c.expect.test(out);
  if (!caught) bad += 1;
  console.log(`${caught ? "ok  " : "MISS"}  ${c.name}${caught ? "" : "  (检查器没报出来)"}`);
}

// 还原后必须干净
fs.writeFileSync(target, original);
fs.writeFileSync(targetH, originalH);
let clean = "";
try {
  clean = execFileSync(process.execPath, [path.join(root, "tools", "check-objc.mjs"), root],
                       { encoding: "utf8" });
} catch (e) { clean = (e.stdout || "") + (e.stderr || ""); }
const ok = /结构检查通过/.test(clean);
if (!ok) bad += 1;
console.log(`${ok ? "ok  " : "FAIL"}  还原后应当干净${ok ? "" : "（有误报）"}`);

console.log(bad === 0 ? "\n自检通过：检查器对这些已知错误都能报出来。" : `\n自检失败 ${bad} 项。`);
process.exit(bad === 0 ? 0 : 1);
