"use strict";

// 配置读取：优先环境变量，其次配置文件。
// 这里刻意不把任何地址、模型名、密钥写死在代码里 —— 赛题要求提交包不得包含密钥。
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  llmTimeoutMs: 20000,
  llmTemperature: 0.2,
  llmRetries: 1,
  asrTimeoutMs: 15000,
  asrLanguage: "zh",
  minSteps: 3,
  maxSteps: 12,
  voiceSilenceMs: 800,
  voiceMaxMs: 9000
};

// 配置文件查找顺序：应用私有目录（推荐，不进提交包）→ 应用内 src/config.json → 项目根（仅开发期）
function configFileCandidates() {
  const list = [];
  const appDir = process.env.FUSIONUI_APP_DATA_DIR;
  if (appDir && path.isAbsolute(appDir)) list.push(path.join(appDir, "config.json"));
  list.push(path.join(__dirname, "config.json"));
  list.push(path.join(__dirname, "..", "config.json"));
  return list;
}

function readFirstExisting() {
  for (const file of configFileCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return { file, data: parsed };
    } catch (error) {
      // 配置写坏不应该让应用起不来，退化成"未配置"并留下日志
      console.log("CONFIG_READ_FAILED " + JSON.stringify({ file, message: String(error && error.message) }));
    }
  }
  return { file: null, data: {} };
}

function str(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function num(fallback, ...values) {
  for (const value of values) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function load() {
  const found = readFirstExisting();
  const file = found.data || {};
  const fileLlm = file.llm || {};
  const fileAsr = file.asr || {};
  const fileBehavior = file.behavior || {};

  const config = {
    source: found.file || "env-only",
    llm: {
      endpoint: str(process.env.LLM_ENDPOINT, fileLlm.endpoint),
      apiKey: str(process.env.LLM_API_KEY, fileLlm.apiKey),
      model: str(process.env.LLM_MODEL, fileLlm.model),
      timeoutMs: num(DEFAULTS.llmTimeoutMs, process.env.LLM_TIMEOUT_MS, fileLlm.timeoutMs),
      temperature: num(DEFAULTS.llmTemperature, fileLlm.temperature),
      retries: num(DEFAULTS.llmRetries, fileLlm.retries)
    },
    asr: {
      endpoint: str(process.env.ASR_ENDPOINT, fileAsr.endpoint),
      apiKey: str(process.env.ASR_API_KEY, fileAsr.apiKey),
      model: str(process.env.ASR_MODEL, fileAsr.model),
      language: str(process.env.ASR_LANGUAGE, fileAsr.language, DEFAULTS.asrLanguage),
      timeoutMs: num(DEFAULTS.asrTimeoutMs, process.env.ASR_TIMEOUT_MS, fileAsr.timeoutMs)
    },
    behavior: {
      minSteps: num(DEFAULTS.minSteps, fileBehavior.minSteps),
      maxSteps: num(DEFAULTS.maxSteps, fileBehavior.maxSteps),
      voiceSilenceMs: num(DEFAULTS.voiceSilenceMs, fileBehavior.voiceSilenceMs),
      voiceMaxMs: num(DEFAULTS.voiceMaxMs, fileBehavior.voiceMaxMs)
    }
  };

  config.llmReady = Boolean(config.llm.endpoint && config.llm.model);
  config.asrReady = Boolean(config.asr.endpoint && config.asr.model);
  return config;
}

// 只暴露"配没配"，不暴露密钥本体 —— 这条日志会进提交材料
function summarize(config) {
  return {
    source: config.source,
    llm: config.llmReady ? "ready" : "missing",
    llmEndpointHost: safeHost(config.llm.endpoint),
    llmModel: config.llm.model || "",
    asr: config.asrReady ? "ready" : "missing",
    asrEndpointHost: safeHost(config.asr.endpoint)
  };
}

function safeHost(endpoint) {
  if (!endpoint) return "";
  try {
    return new URL(endpoint).host;
  } catch (error) {
    return "invalid-url";
  }
}

module.exports = { load, summarize, DEFAULTS };
