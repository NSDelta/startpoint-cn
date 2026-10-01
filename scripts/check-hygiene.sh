#!/usr/bin/env bash
# 提交卫生检查:阻止个人 IP+真实内网 IP / 家目录 / 个人邮箱 / .env / 大二进制 进入提交或仓库。
# 用法:
#   bash scripts/check-hygiene.sh          # 检查已暂存(pre-commit 钩子用)
#   bash scripts/check-hygiene.sh --all     # 检查整树(CI 用)
set -uo pipefail

MODE="${1:-staged}"
fail=0
note() { echo "  [x] $*"; fail=1; }

# 必须关掉 core.quotepath：默认情况下非 ASCII 文件名会被输出成 "\344\273\223..." 这种
# 带引号的八进制转义形式，下方 [ -f "$f" ] 判定于是永远失败、文件被静默 continue 掉 ——
# 中文名文件（本仓文档大量如此）等于完全没被扫过。
# (2026-10-01 实证：含真实内网地址的 docs/仓库迁移通知.md 提交后 hygiene 仍判 PASS，
#  根因即此；关掉后同一文件立刻被扫并命中。)
if [ "$MODE" = "--all" ]; then
    files=$(git -c core.quotepath=false ls-files)
else
    files=$(git -c core.quotepath=false diff --cached --name-only --diff-filter=ACM)
fi
[ -z "$files" ] && exit 0

IP_RE='192\.168\.[0-9]+\.[0-9]+'
# 172.16.0.0/12 同属 RFC1918 真实内网段,本仓一律不得出现,不设白名单。
# (2026-09-30 补:此前有 6 处该段真实地址长期漏网 —— 因为 IP_RE 只盯 192.168.*。
#  注:本文件自身在下方 case 中跳过,但注释也不写真实地址,避免二次泄漏。)
IP172_RE='172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+'
HOME_RE='/Users/[A-Za-z0-9_]+'
EMAIL_RE='[A-Za-z0-9._%+-]+@(qq|gmail|163|126|outlook|hotmail|foxmail|yahoo)\.com'
# 有意保留的通用占位示例(白名单)
IP_ALLOW='192\.168\.1\.10'

while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -f "$f" ] || continue
    case "$f" in
        scripts/check-hygiene.sh|scripts/hooks/*|.github/workflows/hygiene.yml) continue ;;
    esac

    if [ "$f" = ".env" ]; then note ".env 不得提交(仅提交 .env.example)"; continue; fi

    sz=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$sz" -gt 1048576 ]; then
        case "$f" in
            *.json|*.csv|*.md) ;;                 # 允许大数据/文档
            *) note "大文件 >1MB(二进制不应入库,改用生成脚本): $f" ;;
        esac
    fi

    # 仅扫描文本文件
    if grep -Iq . "$f" 2>/dev/null; then
        if grep -nE "$IP_RE" "$f" 2>/dev/null | grep -vE "$IP_ALLOW" | grep -q .; then
            note "个人 IP: $f"; grep -nE "$IP_RE" "$f" | grep -vE "$IP_ALLOW" | head -3 | sed 's/^/      /'
        fi
        if grep -nqE "$IP172_RE" "$f" 2>/dev/null; then
            note "内网 IP(172.16/12): $f"; grep -nE "$IP172_RE" "$f" | head -3 | sed 's/^/      /'
        fi
        if grep -nqE "$HOME_RE" "$f" 2>/dev/null; then
            note "家目录路径: $f"; grep -nE "$HOME_RE" "$f" | head -3 | sed 's/^/      /'
        fi
        if grep -niqE "$EMAIL_RE" "$f" 2>/dev/null; then
            note "个人邮箱: $f"; grep -niE "$EMAIL_RE" "$f" | head -3 | sed 's/^/      /'
        fi
    fi
done <<< "$files"

if [ "$fail" -ne 0 ]; then
    echo ""
    echo "提交卫生检查失败:请清除上述 个人 IP / 内网 IP(172.16/12) / 家目录 / 个人邮箱 / .env / 大二进制 后再提交。"
    echo "(host/port 用 env 或 request.headers.host;路径用相对/__dirname;确为占位示例则加入白名单)"
    exit 1
fi
exit 0
