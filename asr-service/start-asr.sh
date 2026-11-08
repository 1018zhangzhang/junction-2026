#!/usr/bin/env bash
# ============================================================================
# 一键启动识别服务（端口 5001）
#   用法：在 WSL 终端里  bash start-asr.sh
#   停：Ctrl+C
# 说明：电脑睡眠 / 关机后这个进程会消失，重新开机就要再跑一次这个脚本。
# ============================================================================
set -e
cd "$(dirname "$0")"

# 1) 虚拟环境不在就重建（换机器、误删都能自愈）
if [ ! -f .venv/bin/activate ]; then
  echo "没有虚拟环境，正在创建..."
  python3 -m venv .venv
fi
source .venv/bin/activate

# 2) 依赖缺失才装（flask / vosk）
if ! python -c "import flask, vosk" >/dev/null 2>&1; then
  echo "依赖不全，正在安装 requirements.txt ..."
  pip install -r requirements.txt
fi

# 3) 模型检查（缺了服务起不来，提前说清楚）
if [ ! -d vosk-model-small-cn-0.22 ]; then
  echo "❌ 缺少识别模型目录 vosk-model-small-cn-0.22"
  echo "   下载：https://alphacephei.com/vosk/models  small-cn-0.22"
  exit 1
fi

echo "启动识别服务 http://127.0.0.1:5001  （另开终端 curl http://127.0.0.1:5001/ping 自检）"
exec python3 asr_server.py
