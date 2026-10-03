#!/bin/sh
# check-plist.sh —— 判一个 iOS 过滤器 plist 是否是目标 App 的。
#
# 用法：sh tools/check-plist.sh <plist 路径>
#   退出码 0 = 解析成功且里面同时有目标 bundle id 与可执行名
#   退出码 1 = 用法错误 / 文件不存在 / 找不到任何解析器
#   退出码 3 = 解析成功但没找到目标条目
#   退出码 4 = 三种格式都解析失败
#
# ★ 为什么要单独放一个脚本文件，而不是把 python 内联在 workflow 的 `run: |` 里：
#   内联多行 python 时，脚本内容必须整体缩进到块标量之内；我那次把它们顶到了
#   **第 0 列**，于是 python 的 `d = plistlib.load(...)` 被 YAML 当成「顶层 mapping
#   的 key」，PyYAML 直接报 `while scanning a simple key … could not find expected ':'`。
#   单独成文件之后：(1) 没有缩进问题；(2) 可以在本机用真 plist 直接跑。
#   `ios/auto/tools/lint-workflow.mjs` 现在也有一条规则专门抓「块标量脱出」。
#
# ★★ 这里有一件**只有拿真文件试过才知道**的事（先说结论）：
#   `ios/auto/tweak/AMAutoClick.plist` 是 **NeXTSTEP 风格的旧 ASCII plist**：
#       { Filter = { Bundles = ( "com.leiting.wf" ); Executables = ( "worldflipper" ); }; }
#   `plistlib`（CPython 3.x）**只认 XML 与 binary 两种**，对这种格式一律
#   `InvalidFileException: Invalid file`。写了半天的「python 解析 + 判据」在真文件上
#   直接退出码 4 —— 而 CI 上那一步的输出只有一行 `bad 过滤器 plist 检查失败`，
#   看起来像「plist 内容不对」，其实只是**格式不在 plistlib 的支持列表里**。
#   ⇒ 判据必须三级降级，**每一级都要能独立判出「有没有目标 bundle id」**：
#       ① 旧 ASCII 格式：逐行 grep（这个格式就是纯文本，grep 是可靠的；
#          注意不能只 grep 顶层，要确认 `com.leiting.wf` 出现在 `Bundles` 段里）
#       ② XML / binary：plistlib
#       ③ 兜底：macOS 的 `plutil -convert json -o - -- <file>`（它能读三种格式），
#          输出再喂给 plistlib / 退化成 grep
#   为什么不用 `plutil` 唱主角：本机（Windows）没有它，而我要能在本机复跑。
#
# ★ 两条硬要求（都是 CI 上真踩过的）：
#   ① **输出必须是纯文本**。这一段 stdout 会经 tee 进 build.log，而 step
#      「错误注解」会把 build.log 的每一行发成 `::notice`，GitHub 再把它回灌进
#      下一步的临时脚本 —— 也就是**当 shell 源码执行**。第 15 次 CI 就是
#      binary plist 里的 `$Binary` 变成了未定义变量（`Binary: unbound variable`），
#      第 16 次是同一批字节让 `cut` 报 `Illegal byte sequence`。
#      ⇒ 任何时候都过一遍 `LC_ALL=C tr -cd '\040-\176\012'`。
#   ② **判据不要建在二进制上**。bplist 里字符串带长度前缀，`grep 'com.leiting.wf'`
#      直接在 binary plist 上跑本来就不可靠 —— 只有 ① 那种纯文本格式才适合 grep。

PLIST="$1"
if [ -z "$PLIST" ]; then
  echo "用法：sh tools/check-plist.sh <plist 路径>" >&2
  exit 1
fi
if [ ! -f "$PLIST" ]; then
  echo "找不到 $PLIST" >&2
  exit 1
fi

sanitize() { LC_ALL=C tr -cd '\040-\176\012'; }

# ── 格式判定 ────────────────────────────────────────────────────────────────
# 旧 ASCII plist：第一个非空白字节是 `{` 或 `(`，且不含二进制的 `bplist00` 魔数。
magic=$(LC_ALL=C head -c 8 "$PLIST" | sanitize)
first=$(LC_ALL=C tr -d ' \t\r\n' < "$PLIST" | head -c 1)
is_binary=no
case "$magic" in bplist00*) is_binary=yes ;; esac

echo "=== check-plist：$PLIST"
echo "    前 8 字节 = [$magic]   首个非空白字节 = [$first]   二进制 = $is_binary"

# ── 找 python ───────────────────────────────────────────────────────────────
# Windows 的 `python3` 有时是 Microsoft Store 的占位程序 —— 跑得起来但没有输出，
# 所以不能只看 `command -v`，还要真的 import 一次。
PY=""
for c in python3 py python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys, plistlib' >/dev/null 2>&1; then PY="$c"; break; fi
done
echo "    python = ${PY:-（没有）}"

pyout=$(mktemp) || { echo "mktemp 失败" >&2; exit 1; }
trap 'rm -f "$pyout"' EXIT INT TERM

rc=0
how=""

# ── ① 旧 ASCII 格式：本来就该用 grep（这一支**不依赖 python**）────────────
try_grep_ascii() {
  # 只在 `Bundles = (` 到对应的 `)` 之间找。够用且不会把 Executables 段的内容
  # 误当成 Bundles 命中。
  flat=$(LC_ALL=C tr -d '\r' < "$PLIST")
  bundles=$(printf '%s\n' "$flat" | awk '
    /Bundles[ \t]*=[ \t]*\(/ { inside=1 }
    inside { print }
    inside && /\)/ { exit }')
  execs=$(printf '%s\n' "$flat" | awk '
    /Executables[ \t]*=[ \t]*\(/ { inside=1 }
    inside { print }
    inside && /\)/ { exit }')
  echo "    [① 旧 ASCII plist] Bundles 段 = $(printf '%s' "$bundles" | sanitize | tr '\n' ' ')"
  echo "    [① 旧 ASCII plist] Executables 段 = $(printf '%s' "$execs" | sanitize | tr '\n' ' ')"
  hit=0
  printf '%s' "$bundles" | grep -q 'com\.leiting\.wf' && hit=1
  printf '%s' "$execs"   | grep -q 'worldflipper'     && hit=1
  [ "$hit" = "1" ] || return 1
  echo "    命中：旧 ASCII 格式里同时有 com.leiting.wf 与 worldflipper"
  return 0
}

# ── ② XML / binary：plistlib ────────────────────────────────────────────────
try_python() {
  [ -n "$PY" ] || return 1
  "$PY" - "$PLIST" >"$pyout" 2>&1 <<'PYEOF'
import plistlib, sys

path = sys.argv[1]
try:
    d = plistlib.load(open(path, "rb"))
except Exception as e:
    print("plistlib 解析失败：%s" % e)
    sys.exit(4)

print("plistlib 内容（ascii 转义，纯文本）：%s" % ascii(d))
flt = d.get("Filter") or {}
bundles = flt.get("Bundles") or []
execs = flt.get("Executables") or []
print("Bundles     = %s" % ascii(bundles))
print("Executables = %s" % ascii(execs))

# ★ 两条判据都要过：只判其中一条会让「Executables 写错但 Bundles 对」漏过去，
#   而那正是「装上了但什么都不发生」的经典成因（过滤器是或语义，两条都能兜住）。
ok_b = "com.leiting.wf" in bundles
ok_e = "worldflipper" in execs
print("Bundles 命中     = %s" % ok_b)
print("Executables 命中 = %s" % ok_e)
sys.exit(0 if (ok_b and ok_e) else 3)
PYEOF
  return $?
}

# ── ③ 兜底：plutil（macOS 有，能读三种格式）─────────────────────────────────
try_plutil() {
  command -v plutil >/dev/null 2>&1 || return 1
  json=$(plutil -convert json -o - -- "$PLIST" 2>/dev/null | sanitize)
  [ -n "$json" ] || return 1
  echo "    [③ plutil 转 JSON] $(printf '%s' "$json" | cut -c1-300)"
  printf '%s' "$json" | grep -q 'com\.leiting\.wf' || return 1
  printf '%s' "$json" | grep -q 'worldflipper'     || return 1
  echo "    命中：plutil 转出的 JSON 里同时有 com.leiting.wf 与 worldflipper"
  return 0
}

if [ "$is_binary" = "no" ] && { [ "$first" = "{" ] || [ "$first" = "(" ]; }; then
  how="① 旧 ASCII plist（grep）"
  try_grep_ascii || rc=3
else
  how="② plistlib"
  try_python; rc=$?
  if [ "$rc" = "4" ] || [ "$rc" = "1" ]; then
    echo "    plistlib 不认识这种格式，改用 plutil 兜底"
    how="③ plutil"
    try_plutil || rc=4
  fi
fi

# 无论走哪条路，都把候选输出打出来（纯文本化），便于事后核对
if [ -s "$pyout" ]; then LC_ALL=C tr -cd '\040-\176\012' < "$pyout"; fi

echo "    （判定走的是 $how）"
if [ "$rc" = "0" ]; then
  echo "ok  过滤器 plist 同时覆盖了 bundle id 与可执行名"
else
  echo "bad 过滤器 plist 检查失败（退出码 $rc：1=环境，3=没命中，4=解析失败）"
fi
exit $rc
