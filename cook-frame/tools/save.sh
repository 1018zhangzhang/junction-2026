#!/usr/bin/env bash
# ============================================================================
# 存档一个可回滚的版本（每改完一步就跑一次）
# ----------------------------------------------------------------------------
# 用法：
#   bash tools/save.sh v59 "状态徽章 + 输入通道标签"
#   bash tools/save.sh v59              # 只给版本号也行
#
# 它做四件事：
#   1) 先跑密钥扫描 —— 带密钥的存档一律不让进仓库
#   2) 把当前所有改动（含新文件）提交
#   3) 打一个 cook-vXX 标签（和屏幕右上角的 APP_VER 对齐）
#   4) 打印「怎么回到这个版本」的两条命令
#
# 回滚：
#   git reset --hard cook-v58        # 整个工作区回到那一刻（丢弃之后所有改动）
#   git checkout cook-v58 -- src/    # 只把 src/ 恢复成那一刻，别的保留
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-}"
MSG="${2:-}"
if [ -z "$VER" ]; then
  echo "用法: bash tools/save.sh <版本号，如 v59> [说明]" >&2
  exit 2
fi

# 屏幕上的版本号（APP_VER）和标签不一致时提醒，不拦
APP_VER="$(grep -o 'APP_VER = "[^"]*"' src/index.js | head -1 | sed 's/.*"\(.*\)"/\1/')"
if [ -n "$APP_VER" ] && [ "$APP_VER" != "$VER" ]; then
  echo "[warn] 源码里 APP_VER=$APP_VER，跟这次存档的 $VER 不一致（界面会显示旧版本号）"
fi

# 1) 密钥扫描：有密钥就不许提交
if [ -f tools/check-secrets.js ]; then
  node tools/check-secrets.js >/tmp/save-secrets.out 2>&1 || {
    cat /tmp/save-secrets.out
    echo "[stop] 发现疑似密钥，已中止存档（先清理再重跑）" >&2
    exit 1
  }
  cat /tmp/save-secrets.out
fi

# 2) 有没有东西要存
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files -o --exclude-standard)" ]; then
  echo "[skip] 没有任何改动，不需要存档"
  exit 0
fi

# 3) 提交
git add -A
if [ -n "$MSG" ]; then
  git commit -q -m "$VER: $MSG"
else
  git commit -q -m "$VER"
fi

# 4) 打标签（已存在就覆盖，方便"同一个版本号重存一次"）
git tag -f "cook-$VER" >/dev/null

echo
echo "[ok] 已存档 cook-$VER  $(git rev-parse --short HEAD)"
git log --oneline -1
echo "最近存档：$(git tag --list 'cook-v*' | sort -V | tail -5 | tr '\n' ' ')"
echo
echo "回滚整个工作区： git reset --hard cook-$VER"
echo "只回滚源码：     git checkout cook-$VER -- src/ tools/"
