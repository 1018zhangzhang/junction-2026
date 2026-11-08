# 做饭提词器 · IrisView ARUI 应用

戴着眼镜做饭，双手是油的，掏手机不现实。这个应用把口述变成**分步骤提词卡**，屏幕上永远只有「当前这一步 + 下一步」，说话或打字都能推进和修改。

- 视口：640×480，单目（`--display-mode mono`）
- 一屏三行：状态条 / 当前步骤 / 下一步预告
- 五种状态可观察：待命 · 处理中 · 待确认 · 完成 · 异常

---

## 1 跑起来（约 5 分钟）

前置：WSL2 + Ubuntu、Kit v1.0.0、Node 24.13.0（`node -v` 必须显示 `v24.13.0`）。

```bash
export KIT="$HOME/IrisView/LLVISION/IrisView-Developer-Kit-v1.0.0"
export PROJECT="$HOME/IrisView-Developer-Kit-Data/kitchen-tips"

# 1 拷到 Linux 文件系统（绝对不能放在 /mnt/e 或 /mnt/c 下直接跑）
mkdir -p "$(dirname "$PROJECT")"
rm -rf "$PROJECT"
cp -r /mnt/e/kitchen-tips "$PROJECT"
cd "$PROJECT"

# 2 装依赖（本项目 dependencies 为空，这条只是生成 node_modules 结构）
npm ci --offline --ignore-scripts --no-audit --no-fund

# 3 测试 → 构建 → 打包 → 校验
"$KIT/bin/irisview" test "$PROJECT"
"$KIT/bin/irisview" build "$PROJECT"
"$KIT/bin/irisview" package "$PROJECT" --debug-unsigned --output "$PROJECT.fuiapp"
"$KIT/bin/irisview" verify "$PROJECT.fuiapp" --allow-debug-unsigned

# 4 运行（会弹出 Client + Simulator 两个窗口）
"$KIT/bin/irisview" run "$PROJECT.fuiapp" --allow-debug-unsigned --display-mode mono
```

跑起来先看到的是**待命**：灰色状态点 + 「等待指令」。这时候如果没配模型，界面会直接进**异常**并提示「未配置模型」—— 这是故意的，不是 bug。

---

## 2 配置模型（必须做，否则只能看到异常状态）

应用**不内置任何地址和密钥**，因为提交包里不能出现密钥。配置按优先级读：

1. 环境变量 `LLM_ENDPOINT` / `LLM_API_KEY` / `LLM_MODEL`
2. **应用数据目录**里的 `config.json`（推荐）
3. `src/config.json`（只在开发期用，提交前必须删）

### 推荐做法：放进应用数据目录

第一次运行后，终端里会有一行：

```
KITCHEN {"event":"data_directory","path":"/home/xxx/.local/share/..."}
```

把 `config.example.json` 复制成那个目录下的 `config.json`，填三个值，然后**重启应用**（Client 里「结束应用」再「启动」）：

```bash
cp "$PROJECT/config.example.json" "<上一步打印的路径>/config.json"
nano "<上一步打印的路径>/config.json"
```

必填三项：

| 字段 | 说明 | 例 |
|---|---|---|
| `llm.endpoint` | OpenAI 兼容的对话接口 | `https://api.siliconflow.cn/v1/chat/completions` |
| `llm.apiKey` | 密钥 | `sk-...` |
| `llm.model` | 模型名 | `Qwen/Qwen2.5-7B-Instruct` |

语音识别要另外填 `asr.endpoint` / `asr.apiKey` / `asr.model`（OpenAI 兼容的 `/v1/audio/transcriptions`）。**不填 ASR 也能演示全部文字流程**，只是语音不可用。

配好后终端会打出 `KITCHEN {"event":"boot","llm":"ready","asr":"ready"}`，说明读到了。

---

## 3 输入从哪来

| 方式 | 怎么操作 |
|---|---|
| **文字** | Client 右侧详情区的文字输入框，输入后提交（走 `takeTextInput`，最多 4096 字节） |
| **语音** | 应用**常驻倾听**：说一句 → 静音 0.8 秒自动收尾 → 识别 → 执行 → 再开下一段。首次会弹麦克风授权，必须点允许 |

语音不需要按键，是为了让「双手在忙」这个场景成立。如果你不想让它一直听，把 `behavior.voiceMaxMs` 调小或断掉 ASR 配置即可。

---

## 4 演示动作表（对着念就行）

| 要证明什么 | 说什么 / 输入什么 | 屏幕上应该看到 |
|---|---|---|
| 新需求 | 做番茄炒蛋 | 处理中（青色，点闪烁）→ 完成，显示第 1 步 |
| 推进 | 下一步 / 好了 | 切到第 2 步，计时从 0:30 开始 |
| **内容修改** | 只保留用量和时长 | 副行条目变少，只剩用量与时长 |
| **重点/布局修改** | 把计时放大 | 计时变成 64 号居中大字，其余信息收起 |
| 退回 | 上一步 | 回到上一步，计时重建 |
| **跨方式** | 语音说「下一步」，再用文字输入「上一步」 | 两种方式操作同一份菜谱 |
| **独立纠正** | 不是三个蛋，是两个 | 步骤里的用量被改掉，后续相关步骤同步改 |
| **歧义澄清** | 加点那个 | 进入**待确认**（黄色），主行反问「加什么？盐、糖，还是别的？」 |
| 取消 | 取消 | 回到待命 |
| 重来 | 重来 | 清空，回到待命 |
| **显示边界** | 做佛跳墙 / 做满汉全席 | 主行最多三行，超出的内容截断不溢出 |

### 三种布局

| 模式 | 触发 | 长什么样 |
|---|---|---|
| `full` | 默认 | 主行 + 用量火候 + 计时 + 下一步 |
| `compact` | 「只显示接下来两步」 | 隐藏分割与计时，下一步放大成第二主角 |
| `timer` | 「把计时放大」 | 计时 64 号居中，主行缩成小字 |

---

## 5 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `irisview` 报 Ubuntu 版本不支持 | 官方只白名单 22.04/26.04 | 按资源包说明给 `developer_kit_host.py` 的版本白名单加 `24.04` |
| `npm ci` 卡住 / 符号链接失败 | 项目放在了 `/mnt/*` 下 | 必须放 `~/` 下 |
| build 或 package 失败，提示版本 | `versionCode` 没递增 | 每次改代码把 `FusionUIApp.json` 的 `versionCode` +1 |
| 界面变了但模拟器没变 | 跑的是旧的 `.fuiapp` | `build` 之后必须重新 `package`，再 `run` 新包 |
| 界面直接显示「未配置模型」 | 没找到 config.json | 看 `KITCHEN data_directory` 那行路径，把 config.json 放进去 |
| 日志 `input_api_unavailable` | SDK 子路径取不到 | 确认 Kit 是 v1.0.0 且项目在 `~/` 下 |
| 语音立刻失败，原因是 `not-declared` | 能力没声明 | `FusionUIApp.json` 的 `capabilities` 必须含 `input.audio` |
| 语音失败原因是 `permission-required` | 还没授权 | 在 Client 弹窗点允许，或检查系统麦克风权限 |
| 模型返回格式不对（`SCHEMA`） | 模型没按 JSON 输出 | 换更强模型，或调 `src/prompt.txt`；应用已自动重试一次 |
| 说话没反应，但文字可以 | ASR 没配或网络不通 | 看日志 `asr_fail`；演示时可直接改用文字 |

---

## 6 文件说明

```
kitchen-tips/
├── FusionUIApp.json        应用身份与能力声明（input.text + input.audio）
├── fusionui.config.json    构建配置
├── package.json            依赖为空，引擎锁 24.13.0
├── config.example.json     配置模板（复制成 config.json 再填）
├── src/
│   ├── index.js            入口：生命周期、主循环、事件分发
│   ├── ui.js               渲染：五状态配色、三种布局、三行文案
│   ├── state.js            纯状态机：转移白名单、旧结果作废、计时
│   ├── intent.js           意图识别（纯规则，毫秒级）
│   ├── llm.js              模型调用 + JSON 容错 + 校验 + 语音识别
│   ├── voice.js            语音采集：会话、帧累积、静音自动收尾
│   ├── config.js           配置加载（环境变量 > 应用目录 > 开发期文件）
│   ├── log.js              结构化日志（KITCHEN {...}）
│   ├── prompt.txt          提示词（# 开头是注释，不会发出去）
│   ├── application-data.js 官方模板自带，取应用私有目录，不要改
│   └── XRManifest.xml      包描述
└── tools/
    ├── selftest.js         离线单测：状态机/意图/JSON/WAV（39 项）
    └── mock-run.js         无环境联调：用假 SDK 把应用跑起来（11 项）
```

---

## 7 提交前自测（不需要模拟器）

```bash
cd /mnt/e/kitchen-tips
node tools/selftest.js    # 期望 PASS 39 / FAIL 0
node tools/mock-run.js    # 期望 PASS 11 / FAIL 0
```

这两条能覆盖：状态转移、旧结果作废、纠正、布局与内容切换、意图识别、JSON 容错、WAV 封装、配置读取、UI 接线。**它们不能替代模拟器运行**，但能在改代码后 2 秒内发现"改崩了"。

---

## 8 三条纪律

1. **`versionCode` 每次改代码必须 +1**，否则 build 出来的还是旧包。
2. **不要覆盖 `src/application-data.js`**，渲染与配置依赖它。
3. **任何情况下不要把密钥写进 `src/`**。提交冻结包前执行一遍：

```bash
grep -rniE "sk-|api[_-]?key" . --include="*.js" --include="*.json" --include="*.md" | grep -v example
```

有任何输出就先处理，再打包提交。
