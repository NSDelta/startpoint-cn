#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「最坏情形」的 binary plist，喂给 ios/auto/tools/check-plist.sh。

为什么要有这个脚本（而不是在 PowerShell 里临时拼 python -c）：
PowerShell 的反引号是转义字符、`$` 会插值，`python -c "...$Binary`id`..."` 这条
命令里的载荷**根本到不了 python** —— 我实测拿到的 plist 里是 `'\\id['`，
也就是说那次「危险数据通过测试」是假的，测的是一个被 PowerShell 改写过的字符串。
⇒ 危险数据必须从**文件**读，且生成脚本本身用 write 工具落盘（不经过任何 shell）。

用法：
    python ios/auto/tools/make-hostile-plist.py <输出路径> [--kind=good|nobundle|notplist]

退出码 0；文件写好后自行用
    sh ios/auto/tools/check-plist.sh <输出路径>
验证（期望：good → 0，nobundle → 3，notplist → 4）。
"""
import plistlib
import sys

# 这些正是第 15/16 次 CI 咬人的那几样东西：
#   $Binary        → 回灌进下游 shell 后是未定义变量（`Binary: unbound variable`）
#   `id`           → 回灌后是**命令替换**，会真的执行
#   [ ] 、{ }      → 回灌后是 glob / 花括号展开
#   \134 之类的控制字节由 plistlib 自己放进去（bplist 本来就含 NUL）
HOSTILE = "$Binary`id`[{a,b}]|;$(whoami)><>&*?\\"

TOP = [
    "name",
    "on",
    "permissions",
    "jobs",
    "env",
    "defaults",
    "concurrency",
    "run-name",
]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    out = sys.argv[1]
    kind = "good"
    for a in sys.argv[2:]:
        if a.startswith("--kind="):
            kind = a.split("=", 1)[1]

    if kind == "notplist":
        with open(out, "wb") as f:
            f.write(b"this is not a plist at all\n")
        print("wrote %s (kind=notplist)" % out)
        return 0

    if kind == "nobundle":
        bundles = ["com.example.other", HOSTILE]
        execs = ["someoneelse"]
    else:
        bundles = ["com.leiting.wf", HOSTILE]
        execs = ["worldflipper"]

    d = {
        "Filter": {"Bundles": bundles, "Executables": execs},
        # 顺带塞一份「若被 YAML 当成键就会炸」的行，模拟块标量脱出时的文本
        "note": "\n".join("%s: 1" % k for k in TOP),
    }
    with open(out, "wb") as f:
        plistlib.dump(d, f, fmt=plistlib.FMT_BINARY)
    b = open(out, "rb").read()
    print("wrote %s (kind=%s, %d bytes, magic=%s)" % (out, kind, len(b), b[:8].hex()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
