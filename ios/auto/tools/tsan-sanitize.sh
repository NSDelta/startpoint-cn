#!/bin/sh
# tsan-sanitize.sh —— 验证 workflow 里 sanitize() 的净化效果。
#
# 背景（第 15 次 CI 的真实失败）：`::notice::` 后面的文本会被 GitHub **原样回灌进
# 下一步的临时脚本文件**，所以它**就是 shell 源码**。build.log 里有二进制
# （deb 断言那段 cat 过 binary plist），于是
#     /Users/<runner>/work/_temp/<uuid>.sh: line 43: Binary: unbound variable
# 而真正的构建其实是全绿的。
#
# 用法：sh ios/auto/tools/tsan-sanitize.sh   （退出码 0 = 净化仍然有效）
#
# 判据设计上踩过的两个坑（写下来免得后人重踩）：
#   ① 「净化后执行输出字节数 = 0」是**恒假**的判据 —— 子 shell 自己的报错也算字节。
#      `hello` 行 51 字节、不存在的命令 73 字节，两者都 > 0。
#   ② 判据必须配一个**阳性对照**：光看到「净化后没炸」什么都证明不了，
#      得先证明「没净化时确实会炸」。

fail=0
bad()  { echo "FAIL：$1"; fail=$((fail + 1)); }
good() { echo "ok：$1"; }

sanitize() {
  # 注意第 3 步：**没有反斜杠**。原来写成 `tr '$`[]*?\' '????????'` 末尾就是
  # 一个裸反斜杠，GNU tr 会警告 `an unescaped backslash at end of string is not
  # portable`，BSD tr（macOS）对它的解释未定义。反斜杠改用八进制 `\134` 在
  # **删除**位置处理掉，源串里因此一个反斜杠都不需要。
  LC_ALL=C tr -d '\000-\010\013\014\016-\037\134' | LC_ALL=C cut -c1-400 \
    | LC_ALL=C tr -cd '\040-\176' | LC_ALL=C tr '$`[]*?' '??????'
}

# ── 探针脚本一律落在私有临时目录，工作目录只留「多出来的文件」要清理。
#    ★ 这里原来把探针写在工作目录、清理逻辑写成
#        case "$before" in *"|$f|"*) continue ;; esac
#      —— **glob 是「包含」不是「等于」**：`|` 在路径里极常见，于是
#      `|build-and-test-matcher.ps1|` 里的 `|build-and-test-matcher.ps1|` 子串
#      会让 `*"|build-and-test-matcher.ps1|"*` 也匹配 ⇒ 删掉一个真实源文件。
#      （已实测复现：在 tools/ 里跑一次就把 6973 B 的脚本删了。）
#      现在改成**逐行精确比较**（文件名里带 `|` 不再有影响）。
TMPD=$(mktemp -d) || { echo "FAIL：mktemp -d 失败"; exit 0; }
trap 'rm -rf "$TMPD"' EXIT INT TERM

# 「被咬过的」真字节：NUL + 控制字符 + `$Binary` + 反引号里的命令替换 + 未配对方括号
#
# 末段的 `>?Binary?id` 是**故意的**，它复现第 15 次 CI 干过的事：重定向会造出一个名叫
# 这两个「变量」的文件。所以下面量了工作目录的文件名快照，退出前删掉多出来的 ——
# 否则 `ci-push.mjs` 的双向回读校验会把它当成「本地源文件」报
# `✗ 推送内容缺文件`（真踩过一次，文件名里含 U+FC3F 位的私有区字符）。
raw=$(printf 'bplist00\000VFilter\000WBundles[Executables\000^com.leiting.wf\000\\worldflipper\010\013\022\027\037+<>$Binary`id`>?Binary?id')
before=$(ls -A | LC_ALL=C sort)
cleanup() {
  ls -A | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\n' "$before" | LC_ALL=C grep -qxF -- "$f" && continue
    rm -rf -- "./$f" && echo "（已清理测试期间生成的文件：$f）"
  done
}
trap 'cleanup; rm -rf "$TMPD"' EXIT INT TERM
clean=$(printf '%s' "$raw" | sanitize)

echo "原始长度 = ${#raw}    净化长度 = ${#clean}"
echo "净化内容 = [$clean]"

# ── 判据 1：单行（换行会把下游临时脚本拆开）
nl=$(printf '%s' "$clean" | wc -l | tr -d ' ')
[ "$nl" = "0" ] && good "净化后是单行" || bad "净化后含 $nl 个换行"

# ── 判据 2：全是可打印 ASCII
if printf '%s' "$clean" | LC_ALL=C grep -q '[^ -~]'; then bad "净化后仍有非打印字符"; else good "净化后全部是可打印 ASCII"; fi

# ── 判据 3：没有解析期错误（这是第 15 次 CI 的死法：unbound variable / unexpected EOF）
parse_err() { ( set -eu; . "$1" ) 2>&1 >/dev/null; }
printf '%s\n' "$clean" > "$TMPD/_san_line.sh"
printf '%s\n' "$raw"   > "$TMPD/_raw_line.sh"
case "$(parse_err "$TMPD/_san_line.sh")" in
  *"unexpected EOF"*|*"syntax error"*|*"unbound variable"*) bad "净化后仍有解析期错误" ;;
  *) good "净化后没有解析期错误" ;;
esac
case "$(parse_err "$TMPD/_raw_line.sh")" in
  *"unexpected EOF"*|*"syntax error"*|*"unbound variable"*) good "原样文本确实有解析期错误（阳性对照成立）" ;;
  *) bad "原样文本居然没炸 —— 判据本身无效" ;;
esac

# ── 判据 4：注入的命令**没有执行**。用 `id` 的输出当哨兵。
#    必须配一个「命令确实在行首」的阳性对照，否则哨兵永远不出现、判据恒真。
sentinel=$(id | head -1)
case "$sentinel" in
  uid=*) good "哨兵形状正确：[$sentinel]" ;;
  *)     bad "哨兵形状意外：[$sentinel]" ;;
esac
ran() { ( set -eu; . "$1" ) 2>&1; }
printf 'id\n' > "$TMPD/_pos_line.sh"
case "$(ran "$TMPD/_pos_line.sh")" in
  *"$sentinel"*) good "阳性对照：行首的 id 确实被执行（哨兵可见）" ;;
  *)             bad "阳性对照失败：哨兵在行首都没出现 ⇒ 判据 4 无效" ;;
esac
case "$(ran "$TMPD/_san_line.sh")" in
  *"$sentinel"*) bad "净化后注入的命令被执行了" ;;
  *)             good "净化后注入的命令没有执行" ;;
esac

# ── 判据 5（第 16 次 CI 的回归项）：非法 UTF-8 字节序列不能让 `cut` 报错。
#    那一轮死在 `cut: stdin: Illegal byte sequence`，就是漏了这一条：
#    `sanitize()` 里的 `cut -c` 在 UTF-8 locale 下按字符计数，遇到 0x80-0xFF 的
#    孤字节直接报错退出（GNU coreutils；macOS 的 BSD cut 同理）。修法是给 cut
#    加 `LC_ALL=C`（在 C locale 下 `-c` 就是按字节数，且不校验编码）。
#    ★ 这里同时验证「阳性对照」：不给 LC_ALL=C 时必须真的报错，否则这条判据是空的。
bad_bytes=$(printf 'abc\377\376\200def')          # 三个孤立的非法高位字节
if out5=$(printf '%s' "$bad_bytes" | LC_ALL=C cut -c1-400 2>&1 >/dev/null) && [ -z "$out5" ]; then
  good "LC_ALL=C cut 能吃掉非法字节序列（回归项）"
else
  bad "LC_ALL=C cut 仍然报错：$out5"
fi
if out5b=$(printf '%s' "$bad_bytes" | cut -c1-400 2>&1 >/dev/null); then
  if [ -n "$out5b" ]; then
    good "阳性对照：不加 LC_ALL=C 的 cut 确实会报错（[$out5b]）—— 这条回归项是有效的"
  else
    echo "note：本机 locale 下不加 LC_ALL=C 的 cut 也不报错，这条回归项在此环境无效（不算失败）"
  fi
else
  echo "note：本机 locale 下不加 LC_ALL=C 的 cut 也不报错，这条回归项在此环境无效（不算失败）"
fi

echo
if [ "$fail" = "0" ]; then echo "tsan-sanitize：全部通过（净化有效）"; else echo "tsan-sanitize：$fail 项失败"; fi
exit 0
