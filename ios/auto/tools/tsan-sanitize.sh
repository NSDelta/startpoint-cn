#!/bin/sh
# tsan-sanitize.sh —— 验证 workflow 里 sanitize() 的净化效果。
#
# 背景（第 15 次 CI 的真实失败）：`::notice::` 后面的文本会被 GitHub **原样回灌进
# 下一步的临时脚本文件**，所以它**就是 shell 源码**。build.log 里有二进制
# （deb 断言那段 cat 过 binary plist），于是
#     /Users/runner/work/_temp/<uuid>.sh: line 43: Binary: unbound variable
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
  LC_ALL=C tr -d '\000-\010\013\014\016-\037\134' | cut -c1-400 \
    | LC_ALL=C tr -cd '\040-\176' | LC_ALL=C tr '$`[]*?' '??????'
}

# 「被咬过的」真字节：NUL + 控制字符 + `$Binary` + 反引号里的命令替换 + 未配对方括号
raw=$(printf 'bplist00\000VFilter\000WBundles[Executables\000^com.leiting.wf\000\\worldflipper\010\013\022\027\037+<>$Binary`id`')
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
printf '%s\n' "$clean" > /tmp/_san_line.sh
printf '%s\n' "$raw"   > /tmp/_raw_line.sh
case "$(parse_err /tmp/_san_line.sh)" in
  *"unexpected EOF"*|*"syntax error"*|*"unbound variable"*) bad "净化后仍有解析期错误" ;;
  *) good "净化后没有解析期错误" ;;
esac
case "$(parse_err /tmp/_raw_line.sh)" in
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
printf 'id\n' > /tmp/_pos_line.sh
case "$(ran /tmp/_pos_line.sh)" in
  *"$sentinel"*) good "阳性对照：行首的 id 确实被执行（哨兵可见）" ;;
  *)             bad "阳性对照失败：哨兵在行首都没出现 ⇒ 判据 4 无效" ;;
esac
case "$(ran /tmp/_san_line.sh)" in
  *"$sentinel"*) bad "净化后注入的命令被执行了" ;;
  *)             good "净化后注入的命令没有执行" ;;
esac

echo
if [ "$fail" = "0" ]; then echo "tsan-sanitize：全部通过（净化有效）"; else echo "tsan-sanitize：$fail 项失败"; fi
exit 0
