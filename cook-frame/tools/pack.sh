#!/usr/bin/env bash
# ============================================================================
# 一键重打包（在 WSL 里跑；Windows 侧跑不了，因为 kit 的 node 是 Linux 版）
# ----------------------------------------------------------------------------
# 用法：
#   bash tools/pack.sh              # test → build → package → verify
#   bash tools/pack.sh --run        # 打完直接丢进模拟器
#
# 为什么必须重新 package：只 build 不 package，模拟器跑的还是旧包。
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
PROJ="$(pwd)"

KIT="${KIT:-$HOME/IrisView/LLVISION/IrisView-Developer-Kit-v1.0.0}"
CLI="$KIT/bin/irisview"
OUT="${OUT:-$HOME/IrisView-Developer-Kit-Data/cook-frame.fuiapp}"

if [ ! -x "$CLI" ]; then
  echo "[stop] 找不到 kit：$CLI" >&2
  echo "       用 KIT=/你的/kit/路径 bash tools/pack.sh" >&2
  exit 2
fi

APP_VER="$(grep -o 'APP_VER = "[^"]*"' src/index.js | head -1 | sed 's/.*"\(.*\)"/\1/')"
echo "== 源码版本 APP_VER=$APP_VER · 输出 $OUT =="

run() {
  echo
  echo "---- $* ----"
  "$@" || { echo "[fail] $*" >&2; exit 1; }
}

run "$CLI" test .
run "$CLI" build .
run "$CLI" package . --output "$OUT" --debug-unsigned
# ★ verify 不能走 run()：run 里失败会 exit 1，把整个脚本带走 ——
#   而 --debug-unsigned 的包 kit 本来就拒绝 verify（"trust is not allowed"），
#   包其实已经生成好了，这里只提醒、不退出。
echo
echo "---- $CLI verify $OUT ----"
"$CLI" verify "$OUT" || echo "[warn] verify 没通过（--debug-unsigned 的包 kit 拒绝校验，属正常），包已生成"

echo
echo "[ok] 包已生成：$OUT  ($(date '+%H:%M:%S') · $APP_VER)"

if [ "${1:-}" = "--run" ]; then
  echo
  echo "---- 启动模拟器 ----"
  LOG="$PROJ/dist/run.log"
  : > "$LOG"
  # --allow-debug-replace：同 id 调试包必须显式允许替换已装版本，
  #   否则平台可能继续跑注册表里的旧包（官方示例包的 build-and-run.sh 也带它）。
  "$CLI" run "$OUT" --allow-debug-unsigned --allow-debug-replace 2>&1 | tee "$LOG"
  echo
  echo "[log] 运行日志：$LOG"
fi
