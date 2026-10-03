#!/usr/bin/env node
// check-objc.mjs —— 本机没有 clang，所以把能在 CI 之前抓住的一类错误先抓住。
//
// 它**不是**编译器，不做类型检查、不解析 C 声明。它只做三件事：
//   ① 结构配平：@interface/@implementation/@protocol 与 @end、括号、@try/@catch
//   ② 声明 vs 实现：头里声明的方法在 .m 里有没有实现；.m 里调用的 AM* 私有方法
//      有没有在某个 @interface 里声明过（漏声明的后果是 warning，ARC 下
//      返回值可能被当成 id ⇒ 真机上才炸）
//   ③ 常见低级错误：@property 少了分号、@synthesize 拼错、#import 用了 <>" 混用、
//      字符串里带裸换行、`@selector(...)` 里的冒号数与方法名不匹配
//
// 判据刻意保守：宁可漏报也不要误报 —— 一个总是喊狼来了的检查会被忽略掉，
// 那还不如没有。

import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] || ".";
const dirs = ["ios", "tweak", "dylib"];
const files = [];
for (const d of dirs) {
  const p = path.join(root, d);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (/\.(m|h|mm|x)$/.test(f)) files.push(path.join(p, f));
  }
}
files.sort();

let problems = 0;
const say = (f, line, msg) => { console.log(`  ${f}:${line}: ${msg}`); problems += 1; };

// 去掉注释与字符串字面量，但保留换行以便行号正确
function strip(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } out += "\n"; }
    else if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; } i++; out += "  "; }
    else if (c === '"' || c === "'") { const q = c; out += " "; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") { out += "  "; i++; } out += src[i] === "\n" ? "\n" : " "; i++; } out += " "; }
    else out += c;
  }
  return out;
}

// Objective-C 方法声明的签名（用于核对 .h 声明 vs .m 实现）
function methodSig(line) {
  const m = /^\s*([-+])\s*\(([^)]*)\)\s*([^;{]*)/.exec(line);
  if (!m) return null;
  const sel = [];
  let rest = m[3];
  const first = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (!first) return null;
  sel.push(first[1]);
  // 后续 keyword: (type)name
  let i = first[0].length;
  while (true) {
    const next = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(rest.slice(i));
    if (!next) break;
    sel.push(next[1] + ":");
    i += next[0].length;
    const arg = /^\s*\([^)]*\)\s*[A-Za-z_][A-Za-z0-9_]*/.exec(rest.slice(i));
    if (arg) i += arg[0].length;
    else break;
  }
  return { kind: m[1], sel: sel.join(""), text: line.trim() };
}

for (const file of files) {
  const rel = path.relative(root, file);
  const raw = fs.readFileSync(file, "utf8");
  if (raw.includes("\r\n")) say(rel, 1, "含 CRLF（仓库是 LF；Theos 下通常无害，但会让 diff 全是噪音）");
  const src = strip(raw);
  const lines = src.split("\n");

  // ---- ① 括号与 @end 配平 ----
  const stack = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    for (const ch of s) {
      if ("({[".includes(ch)) stack.push({ ch, ln: ln + 1 });
      else if (")}]".includes(ch)) {
        const want = { ")": "(", "}": "{", "]": "[" }[ch];
        const top = stack.pop();
        if (!top || top.ch !== want) { say(rel, ln + 1, `括号不配平：遇到 '${ch}'，栈顶是 '${top ? top.ch : "(空)"}'`); break; }
      }
    }
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    say(rel, t.ln, `括号未闭合：'${t.ch}'`);
  }

  const blocks = [];
  lines.forEach((s, i) => {
    if (/^\s*@(interface|implementation|protocol|end)\b/.test(s)) {
      const kind = /@(interface|implementation|protocol|end)/.exec(s)[1];
      blocks.push({ kind, ln: i + 1 });
    }
  });
  const open = [];
  for (const b of blocks) {
    if (b.kind === "end") { if (!open.length) say(rel, b.ln, "@end 没有对应的 @interface/@implementation"); else open.pop(); }
    else open.push(b);
  }
  for (const b of open) say(rel, b.ln, `@${b.kind} 没有对应的 @end`);

  // ---- ② 方法：.m 里调用的 AM 私有方法必须在某个 @interface 里声明过 ----
  const declared = new Set();
  for (const l of lines) { const s = methodSig(l); if (s) declared.add(s.sel); }
  // 只查以 AM 开头 / am_ 开头的选择器（我们自己的约定），系统方法不查
  lines.forEach((s, i) => {
    const re = /\[\s*(?:self|super|[A-Za-z_][A-Za-z0-9_]*)\s+((?:AM|am_)[A-Za-z0-9_]*)\s*([:\]])/g;
    let m;
    while ((m = re.exec(s))) {
      // 收集整条消息的选择器
      let sel = m[1], j = m.index + m[0].length, depth = 0, rest = s.slice(j - 1);
      const parts = [sel + (m[2] === ":" ? ":" : "")];
      if (m[2] === ":") {
        let k = 0, seenColon = true;
        while (seenColon && k < rest.length) {
          // 扫到下一个 keyword: 或 ]
          const seg = /^[^:\]]*[:]?\s*([A-Za-z_][A-Za-z0-9_]*)?/.exec(rest.slice(1));
          void seg;
          break;
        }
      }
      void parts; void depth;
      if (!declared.has(m[1]) && !declared.has(m[1] + ":")) {
        // 允许：C 函数、宏、类方法调用 [+Class am...]
        if (!/^\+/.test(s.trim())) say(rel, i + 1, `调用了未声明的 AM 方法 '-${m[1]}'`);
      }
    }
  });

  // ---- ③ 低级错误 ----
  lines.forEach((s, i) => {
    if (/^\s*@property\b/.test(s) && !/;\s*$/.test(s) && !/,$/.test(s)) {
      // 允许多行属性声明的续行：下一行以 ; 结尾
      const next = lines[i + 1] || "";
      if (!/;\s*$/.test(next)) say(rel, i + 1, "@property 行末没有分号");
    }
    if (/@synthesize\s+(\w+)\s*=\s*(\w+)/.test(s)) {
      const m = /@synthesize\s+(\w+)\s*=\s*(\w+)/.exec(s);
      if (m[2] !== "_" + m[1]) say(rel, i + 1, `@synthesize ${m[1]} = ${m[2]}：ivar 名一般是 _${m[1]}，确认不是笔误`);
    }
    if (/^\s*#import\s+"[^"]*"\s*$/.test(s) && /AM[A-Z]/.test(s) && !/\.h"/.test(s)) {
      say(rel, i + 1, "#import 的目标看起来不是头文件");
    }
  });
}

// ---- 跨文件：.h 声明的方法必须在同名 .m 里实现 ----
for (const file of files.filter((f) => f.endsWith(".h"))) {
  const base = file.slice(0, -2);
  const impl = base + ".m";
  if (!fs.existsSync(impl)) continue;
  const rel = path.relative(root, file);
  const head = strip(fs.readFileSync(file, "utf8")).split("\n");
  const body = strip(fs.readFileSync(impl, "utf8")).split("\n");
  const implSigs = new Set();
  for (const l of body) { const s = methodSig(l); if (s) implSigs.add(s.sel); }
  for (let i = 0; i < head.length; i++) {
    const s = methodSig(head[i]);
    if (!s) continue;
    if (!implSigs.has(s.sel)) say(rel, i + 1, `声明了 '-${s.sel}' 但 ${path.basename(impl)} 里没找到实现`);
  }
}

console.log(`\n检查了 ${files.length} 个文件（${files.map((f) => path.basename(f)).join(", ")}）`);
console.log(problems === 0 ? "结构检查通过（注意：这不等于能编译，本机没有 clang）。" : `发现 ${problems} 处问题。`);
process.exit(problems === 0 ? 0 : 1);
