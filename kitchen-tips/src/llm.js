"use strict";

// 模型接入层：只做两件事 —— 口述 → 结构化步骤；PCM → 文字。
// 全部用 Node 24 自带的 fetch / FormData / Blob，没有任何 npm 依赖。
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const PROMPT_FILE = path.join(__dirname, "prompt.txt");
const DEFAULT_PROMPT =
  '把用户口述的做菜需求整理成可执行步骤。只输出 JSON，形如 {"dish":"菜名","steps":[{"action":"动作","usage":"用量","durationSec":0,"fire":"火候"}]}，不要解释，不要 markdown。';

function loadPrompt() {
  try {
    const raw = fs.readFileSync(PROMPT_FILE, "utf8");
    // 允许在提示词文件里用 # 写注释，注释不会被当成提示词发出去
    const lines = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
      .trim();
    return lines || DEFAULT_PROMPT;
  } catch (error) {
    return DEFAULT_PROMPT;
  }
}

function hintFor(code) {
  switch (code) {
    case "NO_CONFIG":
      return "未配置模型地址或模型名，检查 LLM_ENDPOINT / LLM_MODEL";
    case "TIMEOUT":
      return "模型响应超时，可以说「重来」";
    case "NETWORK":
      return "网络不通，改用文字输入或稍后再试";
    case "AUTH":
      return "密钥无效或没有权限，检查 LLM_API_KEY";
    case "RATE":
      return "调用过于频繁，稍等几秒再说";
    case "SERVER":
      return "模型服务暂时不可用，稍后再试";
    case "SCHEMA":
      return "模型返回格式不对，已重试一次，可以说「重来」";
    default:
      return "处理失败，可以说「重来」或改用文字输入";
  }
}

function fail(code, message, startedAt, extra) {
  return Object.assign(
    {
      ok: false,
      errorCode: code,
      message: message || code,
      hint: hintFor(code),
      latencyMs: Math.round(performance.now() - startedAt)
    },
    extra || {}
  );
}

// 模型经常在 JSON 外面套 ```json 或者多说一句客套话，这里做容错提取
function extractJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/\r/g, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(cleaned);

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch (error) {
      // 换下一个候选
    }
  }
  return null;
}

function normalizeRecipe(parsed, limits) {
  if (!parsed || typeof parsed !== "object") return null;
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!rawSteps || rawSteps.length === 0) return null;

  const steps = rawSteps
    .map((item, index) => {
      const action = typeof item === "string" ? item : item && item.action;
      if (typeof action !== "string" || !action.trim()) return null;
      return {
        no: index + 1,
        action: action.trim().slice(0, 40),
        usage: typeof item.usage === "string" ? item.usage.trim().slice(0, 20) : "",
        durationSec: Number.isFinite(Number(item.durationSec)) ? Math.max(0, Math.round(Number(item.durationSec))) : 0,
        fire: typeof item.fire === "string" ? item.fire.trim().slice(0, 10) : ""
      };
    })
    .filter(Boolean);

  if (steps.length === 0) return null;
  if (steps.length < limits.minSteps || steps.length > limits.maxSteps) {
    // 步数不合适也接受，但要截断，保证不溢出屏幕
    if (steps.length > limits.maxSteps) steps.length = limits.maxSteps;
  }
  return {
    dish: typeof parsed.dish === "string" && parsed.dish.trim() ? parsed.dish.trim().slice(0, 16) : "未命名",
    steps
  };
}

async function postJson(config, body, startedAt) {
  if (!config.llmReady) {
    return { error: fail("NO_CONFIG", "missing endpoint or model", startedAt) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (config.llm.apiKey) headers.Authorization = "Bearer " + config.llm.apiKey;

    const response = await fetch(config.llm.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      let code = "HTTP";
      if (response.status === 401 || response.status === 403) code = "AUTH";
      else if (response.status === 429) code = "RATE";
      else if (response.status >= 500) code = "SERVER";
      return { error: fail(code, "HTTP " + response.status, startedAt, { raw: text.slice(0, 400) }) };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = null;
    }
    return { parsed, text };
  } catch (error) {
    const name = error && error.name ? error.name : "";
    const code = name === "AbortError" ? "TIMEOUT" : "NETWORK";
    return { error: fail(code, String((error && error.message) || error), startedAt) };
  } finally {
    clearTimeout(timer);
  }
}

// 兼容 OpenAI 风格与少见的 output.text 风格
function readContent(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  if (choice && choice.message && typeof choice.message.content === "string") return choice.message.content;
  if (choice && typeof choice.text === "string") return choice.text;
  if (typeof parsed.output_text === "string") return parsed.output_text;
  if (parsed.output && typeof parsed.output.text === "string") return parsed.output.text;
  if (typeof parsed.response === "string") return parsed.response;
  return "";
}

async function parseRecipe(text, config, options) {
  const startedAt = performance.now();
  const limits = config.behavior;
  const prompt = loadPrompt();
  const context = options && options.context ? String(options.context) : "";
  const userContent = context ? "已知上下文：\n" + context + "\n\n新的口述：\n" + text : text;

  const body = {
    model: config.llm.model,
    temperature: config.llm.temperature,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userContent }
    ]
  };

  let lastError = null;
  const attempts = 1 + Math.max(0, Math.round(config.llm.retries || 0));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await postJson(config, body, startedAt);
    if (result.error) {
      lastError = result.error;
      const retryable = ["TIMEOUT", "NETWORK", "RATE", "SERVER"].includes(result.error.errorCode);
      if (retryable && attempt < attempts - 1) continue;
      return result.error;
    }
    const content = readContent(result.parsed);
    const json = extractJson(content);
    const recipe = normalizeRecipe(json, limits);
    if (recipe) {
      return {
        ok: true,
        data: recipe,
        latencyMs: Math.round(performance.now() - startedAt),
        attempts: attempt + 1,
        rawText: content.slice(0, 500)
      };
    }
    lastError = fail("SCHEMA", "model output is not a valid recipe", startedAt, { raw: content.slice(0, 400) });
    if (attempt < attempts - 1) continue;
  }
  return lastError || fail("SCHEMA", "unreachable", startedAt);
}

// 16 kHz / 单声道 / s16le 的 PCM 片段封装成标准 WAV，才能交给识别服务
function pcmToWav(chunks, sampleRate) {
  const rate = sampleRate || 16000;
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + total, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);       // PCM
  header.writeUInt16LE(1, 22);       // 单声道
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(total, 40);
  return Buffer.concat([header].concat(chunks), 44 + total);
}

async function transcribe(wavBuffer, config) {
  const startedAt = performance.now();
  if (!config.asrReady) {
    return fail("NO_CONFIG", "missing ASR endpoint or model", startedAt);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.asr.timeoutMs);
  try {
    const form = new FormData();
    form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "speech.wav");
    form.append("model", config.asr.model);
    if (config.asr.language) form.append("language", config.asr.language);

    const headers = {};
    if (config.asr.apiKey) headers.Authorization = "Bearer " + config.asr.apiKey;

    const response = await fetch(config.asr.endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      let code = "HTTP";
      if (response.status === 401 || response.status === 403) code = "AUTH";
      else if (response.status === 429) code = "RATE";
      else if (response.status >= 500) code = "SERVER";
      return fail(code, "ASR HTTP " + response.status, startedAt, { raw: text.slice(0, 300) });
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = null;
    }
    const words = readTranscript(parsed);
    if (!words) {
      return fail("SCHEMA", "ASR returned no text", startedAt, { raw: text.slice(0, 300) });
    }
    return { ok: true, text: words, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    const name = error && error.name ? error.name : "";
    const code = name === "AbortError" ? "TIMEOUT" : "NETWORK";
    return fail(code, "ASR " + String((error && error.message) || error), startedAt);
  } finally {
    clearTimeout(timer);
  }
}

function readTranscript(parsed) {
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed.trim();
  if (typeof parsed.text === "string") return parsed.text.trim();
  if (typeof parsed.result === "string") return parsed.result.trim();
  if (parsed.data && typeof parsed.data.text === "string") return parsed.data.text.trim();
  if (Array.isArray(parsed.segments) && parsed.segments.length) {
    return parsed.segments
      .map((segment) => (typeof segment.text === "string" ? segment.text : ""))
      .join("")
      .trim();
  }
  return "";
}

module.exports = { parseRecipe, transcribe, pcmToWav, extractJson, loadPrompt };
