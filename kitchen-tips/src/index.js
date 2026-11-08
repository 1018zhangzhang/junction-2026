"use strict";

// 应用入口：只做接线和事件分发，业务判断都在 state / intent / llm / voice 里。
// 主循环用官方推荐的 requestAnimationFrame，后台时暂停（lifecycle.html 的写法）。
const os = require("@irisview/osx/os");
const ui = require("@irisview/osx/fusionui");
const { performance } = require("node:perf_hooks");

const configModule = require("./config");
const stateModule = require("./state");
const intentModule = require("./intent");
const llm = require("./llm");
const voiceModule = require("./voice");
const { log } = require("./log");
const { createUI } = require("./ui");

const { PHASE, reduce, create, currentStep } = stateModule;

// 输入 API 在子路径里；取不到时给出明确日志，而不是静默失效
let inputApi = null;
try {
  inputApi = require("@irisview/osx/os/input");
} catch (error) {
  log("input_api_unavailable", { message: String((error && error.message) || error) });
  inputApi = null;
}

const view = {};
let config = null;
let state = create();
let uiLayer = null;
let voice = null;

let frame = null;
let active = false;
let reqSeq = 0;
let lastRender = -Infinity;
let lastTick = -Infinity;
let lastVoiceStopAt = 0;
let lastSpeechKey = "";
let lastSpeechAt = 0;
let booted = false;

const RENDER_INTERVAL_MS = 50;
const TICK_INTERVAL_MS = 200;
const VOICE_RESTART_GAP_MS = 700;

function contextSummary() {
  if (!state.steps.length) return "";
  const names = state.steps.slice(0, 6).map((step, index) => `${index + 1}. ${step.action}`);
  return `当前菜谱「${state.dish}」，共 ${state.steps.length} 步：\n${names.join("\n")}`;
}

function requestRecipe(text) {
  reqSeq += 1;
  const seq = reqSeq;
  state = reduce(state, { type: "REQUEST", seq, hint: "正在理解你的口述…" });
  log("request_start", { seq, chars: text.length });

  llm
    .parseRecipe(text, config, { context: contextSummary() })
    .then((result) => {
      if (result.ok) {
        state = reduce(state, { type: "PARSE_OK", seq, recipe: result.data, now: performance.now() });
        log("request_ok", {
          seq,
          dish: result.data.dish,
          steps: result.data.steps.length,
          latencyMs: result.latencyMs,
          dropped: state.note === "stale-dropped"
        });
      } else {
        state = reduce(state, {
          type: "PARSE_FAIL",
          seq,
          error: {
            title: "处理失败 · " + result.errorCode,
            hint: result.hint,
            code: result.errorCode
          }
        });
        log("request_fail", {
          seq,
          errorCode: result.errorCode,
          latencyMs: result.latencyMs,
          dropped: state.note === "stale-dropped"
        });
      }
    })
    .catch((error) => {
      state = reduce(state, {
        type: "PARSE_FAIL",
        seq,
        error: { title: "处理异常", hint: "可以说「重来」", code: "INTERNAL" }
      });
      log("request_throw", { seq, message: String((error && error.message) || error) });
    });
}

function handleInput(rawText, source) {
  const text = String(rawText || "").trim();
  if (!text) return;

  state = reduce(state, { type: "INPUT", text, source });
  const intent = intentModule.detect(text);
  log("input", { source, text: text.slice(0, 60), intent: intent.kind });

  // 语音识别出来的杂音不该被当成新需求，避免误触发
  if (source === "voice" && intent.kind === "new_recipe" && intent.fallback) {
    log("input_ignored", { source, reason: "voice-fallback" });
    state = reduce(state, { type: "INPUT", text, source });
    return;
  }

  switch (intent.kind) {
    case "next": {
      state = reduce(state, { type: "NEXT", now: performance.now() });
      break;
    }
    case "prev": {
      state = reduce(state, { type: "PREV", now: performance.now() });
      break;
    }
    case "confirm": {
      if (state.phase === PHASE.CONFIRM) {
        // 确认后把"待确认"变成"完成"，界面继续显示当前步骤
        state = reduce(state, { type: "NEXT", now: performance.now() });
        state.hint = "已确认，继续";
      } else {
        state = reduce(state, { type: "NEXT", now: performance.now() });
      }
      break;
    }
    case "cancel": {
      state = reduce(state, { type: "RESET" });
      log("cancelled", {});
      break;
    }
    case "layout": {
      state = reduce(state, { type: "SET_MODE", mode: intent.mode, hint: layoutHint(intent.mode) });
      log("layout_change", { mode: intent.mode });
      break;
    }
    case "content": {
      state = reduce(state, { type: "SET_FIELDS", fields: intent.fields });
      log("content_change", { fields: intent.fields });
      break;
    }
    case "correct": {
      state = reduce(state, { type: "CORRECT", from: intent.from, to: intent.to, now: performance.now() });
      log("correction", { from: intent.from, to: intent.to });
      break;
    }
    case "amend": {
      state = reduce(state, { type: "AMEND", object: intent.object, now: performance.now() });
      log("amend", { object: intent.object });
      break;
    }
    case "ambiguous": {
      state = reduce(state, {
        type: "ASK",
        question: intent.question || "你想改哪一步？说个关键词",
        hint: "回答后继续，或说「取消」"
      });
      log("ambiguous", { question: intent.question });
      break;
    }
    case "reset": {
      state = reduce(state, { type: "RESET" });
      log("reset", {});
      break;
    }
    case "new_recipe":
    default: {
      requestRecipe(text);
      break;
    }
  }
}

function layoutHint(mode) {
  if (mode === "timer") return "已放大计时，其余信息收起了";
  if (mode === "compact") return "只保留当前与下一步";
  return "已恢复完整布局";
}

function pollText() {
  if (!inputApi || typeof inputApi.takeTextInput !== "function") return;
  for (let guard = 0; guard < 4; guard += 1) {
    const item = inputApi.takeTextInput();
    if (!item || !item.text) return;
    handleInput(item.text, "text");
  }
}

function pollVoice(now) {
  if (!voice) return;
  const result = voice.pump();
  if (!result) return;

  if (!result.ok) {
    log("voice_abort", { reason: result.reason });
    if (result.reason === "no-speech") state.hint = "没听清，再说一次或改用文字";
    lastVoiceStopAt = now;
    return;
  }

  const wav = llm.pcmToWav(result.chunks, result.sampleRate);
  log("voice_captured", { durationMs: result.durationMs, bytes: wav.length });
  state.hint = "正在识别语音…";

  llm
    .transcribe(wav, config)
    .then((asr) => {
      lastVoiceStopAt = performance.now();
      if (!asr.ok) {
        state = reduce(state, {
          type: "PARSE_FAIL",
          seq: state.seq,
          error: {
            title: "语音识别失败 · " + asr.errorCode,
            hint: "请改用文字输入，或再说一次",
            code: asr.errorCode
          }
        });
        log("asr_fail", { errorCode: asr.errorCode, latencyMs: asr.latencyMs });
        return;
      }
      const text = String(asr.text || "").trim();
      log("asr_ok", { latencyMs: asr.latencyMs, chars: text.length });
      if (!text) {
        state.hint = "没听清，再说一次";
        return;
      }
      // 短时间内重复的同一句话，多半是采集重叠，直接丢掉
      const key = text.replace(/\s+/g, "");
      if (key === lastSpeechKey && performance.now() - lastSpeechAt < 2500) {
        log("asr_duplicate_dropped", { chars: text.length });
        return;
      }
      lastSpeechKey = key;
      lastSpeechAt = performance.now();
      handleInput(text, "voice");
    })
    .catch((error) => {
      lastVoiceStopAt = performance.now();
      log("asr_throw", { message: String((error && error.message) || error) });
    });
}

// 常驻倾听：一段说完自动收尾，识别完再开下一段，让"说一句就有反应"成立
function keepListening(now) {
  if (!voice || !config.asrReady) return;
  if (voice.isActive()) return;
  if (state.phase === PHASE.WORKING) return;
  if (now - lastVoiceStopAt < VOICE_RESTART_GAP_MS) return;
  const info = voice.availability();
  if (!info.canRequest) return;
  const started = voice.start();
  if (!started.ok) log("voice_start_skipped", { reason: started.reason });
}

function tick() {
  frame = null;
  if (!active || !view.window) return;

  try {
    const now = performance.now();
    pollText();

    if (now - lastTick >= TICK_INTERVAL_MS) {
      lastTick = now;
      state = reduce(state, { type: "TICK", now });
    }

    pollVoice(now);
    keepListening(now);

    if (now - lastRender >= RENDER_INTERVAL_MS) {
      lastRender = now;
      const display = Object.assign({}, state);
      if (voice && voice.isActive() && state.phase === PHASE.IDLE) {
        display.hint = "正在听…说一句想做的菜";
      } else if (voice && voice.isActive()) {
        display.hint = "正在听…";
      }
      uiLayer.render(display, now);
    }
  } catch (error) {
    // 单帧异常不能让整个应用停摆
    log("tick_error", { message: String((error && error.message) || error) });
  }

  if (active) frame = os.requestAnimationFrame(tick);
}

function start() {
  if (booted) return;
  booted = true;

  config = configModule.load();
  log("boot", configModule.summarize(config));

  // 把应用数据目录打出来：config.json 放这里最安全（不会被打进 .fuiapp）
  try {
    const { applicationDataDirectory } = require("./application-data");
    log("data_directory", { path: applicationDataDirectory() });
  } catch (error) {
    log("data_directory_unavailable", { message: String((error && error.message) || error) });
  }

  const property = os.WindowProperty.create();
  property.setTitle("做饭提词器");
  property.setSize([0.64, 0.48, 0.01]);
  view.window = os.Window.create(property);
  view.root = ui.FusionRoot.acquireFusionRootFromWindow(view.window);
  uiLayer = createUI(ui, view.root.getRootWidget());
  uiLayer.start();
  uiLayer.render(state, performance.now());

  if (!config.llmReady) {
    state = reduce(state, {
      type: "PARSE_FAIL",
      seq: state.seq,
      error: {
        title: "未配置模型",
        hint: "设置 LLM_ENDPOINT / LLM_MODEL 后重启应用",
        code: "NO_CONFIG"
      }
    });
    log("config_missing", { part: "llm" });
  }

  if (inputApi && typeof inputApi.getVoiceInputAvailability === "function") {
    voice = voiceModule.createVoice({ inputApi, config, log });
    const info = voice.availability();
    log("voice_availability", {
      supported: info.supported,
      declared: info.declared,
      canRequest: info.canRequest,
      ready: info.ready,
      reason: info.reason
    });
    if (!info.canRequest) {
      state.hint = voice.reasonText(info.reason);
    }
  } else {
    log("voice_unavailable", {});
  }

  resume();
}

function resume() {
  if (!view.window || active) return;
  active = true;
  lastRender = -Infinity;
  lastTick = -Infinity;
  lastVoiceStopAt = performance.now();
  frame = os.requestAnimationFrame(tick);
  log("resume", {});
}

function pause() {
  active = false;
  if (frame !== null) os.cancelAnimationFrame(frame);
  frame = null;
  if (voice && voice.isActive()) voice.cancel();
  log("pause", {});
}

os.App.createApp((event) => {
  if (event === os.AppLifecycle.ON_CREATE) start();
  else if (event === os.AppLifecycle.ON_FOREGROUND || event === os.AppLifecycle.ON_REOPEN) resume();
  else if (event === os.AppLifecycle.ON_BACKGROUND) pause();
  else if (event === os.AppLifecycle.ON_DESTROY) {
    pause();
    for (const key of Object.keys(view)) delete view[key];
    uiLayer = null;
    voice = null;
    booted = false;
  }
});
