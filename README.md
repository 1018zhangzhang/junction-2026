# 灶边提词器 · CookFrame

> 对着眼镜说一句「番茄炒蛋」，接下来每一步都有人在你耳边告诉你该干什么。
> 手上有油、眼睛离不开锅的时候，菜谱不用翻页，语音就能翻。

**版本**：v35 &nbsp;|&nbsp; **平台**：IrisView 智能眼镜（640×480 单片显示）&nbsp;|&nbsp; **识别**：纯本机 Vosk，断网可用

---

## 它解决什么问题

做菜时最大的摩擦不是不会做，而是**手是脏的**。手机、平板、纸质菜谱都需要动手翻，一翻页就断了节奏，还容易糊锅。

灶边提词器把菜谱拆成一步步的口令，通过语音交互完成全部操作：

| 你在做菜 | 你说 | 它做的 |
|---|---|---|
| 不知道做什么 | 「推荐」「番茄炒蛋」 | 报菜名，进入跟做 |
| 做菜中 | 「下一步」「上一步」 | 翻页，同时播报要点 |
| 手感不对 | 「太咸了」「糊了」「油冒烟了」 | 识别故障意图，给救场建议 |
| 忘了火候 | 「多大火」「一共几步」 | 回答当前步骤的关键信息 |
| 中途变了主意 | 「换菜」「开始计时」「再说一遍」 | 切换 / 计时 / 重播 |

不需要唤醒词，不需要联网，不需要腾出手。

---

## 技术架构

```
麦克风 PCM
   │
   ▼
asr-service（本机识别服务，HTTP :5001）   只负责「声音 → 文字」
   │  Vosk 小模型中文，离线运行
   ▼
cook-frame/src/engine.js                  只负责「文字 → 意图」
   │  规则引擎 + 词表，纯逻辑、可单测
   ▼
界面渲染（640×480）                        只负责「意图 → 显示」
```

**分层的关键**：识别服务不做任何语义判断，`engine.js` 不碰音频。所以改说法只需要动 `engine.js` 和词表，换识别引擎也不影响业务逻辑。

### 三个值得说的地方

1. **离线优先**：识别全在本机（Vosk + 端口 5001），比赛现场没网也能跑完整链路，不依赖任何云服务。
2. **一次授权、连说多句**：平台每次录音都要用户确认（单次最长 60 秒）。我们没有反复弹窗，而是把一次会话内的多句话切分处理，交互不被打断。
3. **判断「没听清」还是「没听懂」**：三层日志分别记录识别结果、进入处理的文字、界面实际渲染的内容。出问题看日志就知道断在哪一层，不用猜。

---

## 目录结构

```
cook-frame/            主应用（当前 v35）
├── src/index.js       界面、菜单、口令分发
├── src/engine.js      ★ 语义理解核心：翻页 / 救场 / 改量 / 提问
├── src/voice.js       收音、静音判断、切句
├── src/asr.js         与识别服务的 HTTP 接口
├── src/recipe.js      11 道菜的菜谱数据
└── tools/
    ├── test-engine.js     48 条核心口令回归测试
    └── eval-corpus.js     189 条真实语料评测（当前准确率 95.8%）

asr-service/           本机语音识别服务
├── asr_server.py      Flask 服务，端口 5001
└── extra_vocab.txt    领域重点词表（改完即时生效，无需重启）

docs/开发手册.md        踩坑记录与开发约定，接手前先看这个
kitchen-tips/          厨房小贴士（独立应用）
my-focus-break/        专注休息小应用（独立应用）
```

---

## 快速开始

> **代码不能开箱即跑**：仓库只含源码。运行还需要平台工具链、语音模型和 Python 依赖，这三样都在仓库之外，下面逐项说明。

### 一、环境要求

| 依赖 | 版本 / 获取方式 | 是否随仓库提供 |
|---|---|---|
| WSL2 + Ubuntu | 应用必须跑在 **Linux 文件系统**（`~/...`），**不能放在 `/mnt/c`、`/mnt/d` 下直接运行** | 否 |
| IrisView Developer Kit | v1.0.0（提供 `irisview` 命令） | 否 |
| Node.js | **24.13.0**（`node -v` 必须完全一致） | 否 |
| Python | 3.10 以上，需 `flask`、`vosk`（见 `asr-service/requirements.txt`） | 是 |
| Vosk 中文模型 | `vosk-model-small-cn-0.22`，66 MB | **否** |

### 二、下载语音模型（必做，否则识别服务起不来）

```bash
cd asr-service
# 从 alphacephei.com/vosk/models 下载 vosk-model-small-cn-0.22.zip
unzip vosk-model-small-cn-0.22.zip -d .
ls vosk-model-small-cn-0.22   # 确认目录存在
```

### 三、自检

```bash
irisview --version                       # 工具链装好了吗
node -v                                  # 应为 v24.13.0
python3 --version                        # 3.10+
ls asr-service/vosk-model-small-cn-0.22  # 模型在不在
```

四项都正常再往下走。任何一项缺失，后面会出现「没有报错但就是不工作」的情况。

### 四、可选配置（不配也能跑）

`cook-frame` 默认走本机识别，**不需要配置**。若要用在线识别或大模型兜底，在 `cook-frame/` 下新建 `config.json`（参考 `kitchen-tips/config.example.json`）。该文件已被 `.gitignore` 排除，**密钥不会上传**。

### 五、启动（两个终端）

**终端 1 — 识别服务**

```bash
cd asr-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 asr_server.py
```

看到 `Running on http://0.0.0.0:5001` 即成功。验证：

```bash
curl http://127.0.0.1:5001/ping
# {"ok":true,"model":"vosk-model-small-cn-0.22"}
```

**终端 2 — 构建并运行主应用**

```bash
cd cook-frame
# 先把 FusionUIApp.json 的 versionCode 改成比本机已有包更大的数字（如 100）
irisview build .
irisview package . --output ../cook-frame.fuiapp --debug-unsigned
irisview run ../cook-frame.fuiapp --allow-debug-unsigned --display-mode mono
```

界面左上角显示 **v35** 表示运行的是当前版本。

### 六、回归测试

改完 `engine.js` 或词表后必须跑，48 条核心口令全过才算好：

```bash
cd cook-frame
node tools/test-engine.js
```

---

## 评测数据

| 项目 | 结果 |
|---|---|
| 核心口令回归 | 48 / 48 通过 |
| 真实语料评测 | 189 条，准确率 **95.8%** |
| 菜谱覆盖 | 11 道菜 |
| 识别链路 | 本机离线，不依赖网络 |

---

## 已知限制

- 界面为 640×480 固定坐标布局，各行间距很紧，调整文字位置需要检查是否压到相邻行。
- Vosk 小模型对近音词敏感：词表不是越多越好，一次加 3–5 个词，看日志再决定去留。
- 每次启动录音仍需平台侧一次用户确认（系统限制，无法绕过）。

---

## 团队

2026 Junction 参赛作品。开发约定与踩坑记录见 [`docs/开发手册.md`](docs/开发手册.md)。
