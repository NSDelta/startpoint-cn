/**
 * P6 工具：把 AS3 源里的非 ASCII 字符转成 \uXXXX 转义。
 *
 * 为什么需要：
 *   FFDec 的 AS3 编译器读 .as 时的字符集判定不完全可控；而共享树
 *   work/swf/as3_v181/scripts/** 里的中文就是因为编码问题被破坏过（UTF-8 字节
 *   被按 GBK 重解码，且吃掉收尾引号，直接喂 FFDec 会报
 *   "COMMA or PARENT_CLOSE expected but RETURN found"）。
 *   把非 ASCII 全部转义后，喂给 FFDec 的文件是纯 ASCII，编码问题彻底消失。
 *
 * 用法：node p6-escape.mjs <in.as> <out.as>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node p6-escape.mjs <in.as> <out.as>");
  process.exit(2);
}

const src = readFileSync(inPath, "utf8");
let out = "";
let n = 0;
for (const ch of src) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) {
    out += ch;
    continue;
  }
  n++;
  if (cp > 0xffff) {
    // 代理对：分别转义（AS3 字符串就是 UTF-16，两个 \uXXXX 等价）
    const v = cp - 0x10000;
    const hi = 0xd800 + (v >> 10);
    const lo = 0xdc00 + (v & 0x3ff);
    out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
  } else {
    out += "\\u" + cp.toString(16).padStart(4, "0");
  }
}
// 统一 LF（避免 CRLF 在 FFDec 里引发诡异问题），并去掉 BOM
out = out.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
writeFileSync(outPath, out, "ascii");
console.log(`[escape] ${inPath} -> ${outPath}  escaped=${n} chars, bytes=${Buffer.byteLength(out, "ascii")}, ascii_only=${/^[\x00-\x7F]*$/.test(out)}`);
