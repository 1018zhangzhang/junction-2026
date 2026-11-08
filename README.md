# 灶边提词器

说菜名 → 眼镜上一步步提词 → 可喊停 / 跳过 / 换菜 / 救场。当前版本 **v35**。

语音链路：

```
麦克风 PCM → 本机识别服务(端口 5001) → 文字 → cook-frame/src/engine.js 理解 → 界面
```

## 目录结构

| 目录 | 说明 |
|---|---|
| `cook-frame/` | 主应用：菜单、跟做提词、口令分发（界面显示 v35） |
| `cook-frame/src/engine.js` | 语义理解核心（翻页/救场/改量/提问），纯逻辑可测 |
| `asr-service/` | 本机语音识别服务（Vosk，端口 5001，离线可用） |
| `kitchen-tips/` | 厨房小贴士应用（走在线 LLM，密钥放 config.json，不提交） |
| `my-focus-break/` | 专注休息小应用 |

## 快速开始

### 1. 前置检查（Ubuntu / WSL）

```bash
irisview --version
python3 --version        # 3.10+
ls asr-service/vosk-model-small-cn-0.22   # 模型不在就去 alphacephei.com/vosk/models 下载（66MB）
```

### 2. 启动识别服务（终端 1）

```bash
cd asr-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 asr_server.py
# 验证: curl http://127.0.0.1:5001/ping
```

### 3. 构建运行主应用（终端 2）

```bash
cd cook-frame
# 先把 FusionUIApp.json 里的 versionCode 改成比本机已有包更大的数字
irisview build .
irisview package . --output ../cook-frame.fuiapp --debug-unsigned
irisview run ../cook-frame.fuiapp --allow-debug-unsigned --display-mode mono
```

## 开发须知

- 改完 `engine.js` 或词表后必须跑：`cd cook-frame && node tools/test-engine.js`（48 条核心口令全过才算好）
- `asr-service/extra_vocab.txt` 重点词表，一次加 3-5 个，改完不用重启
- `versionCode` 不升级的话平台会复用旧包（改了白改）
- 界面是 640x480 固定坐标，各文字行紧挨着，调整位置注意别互相压住

详细踩坑指南见交接文档。
