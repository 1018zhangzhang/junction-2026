"use strict";
// ============================================================================
// 联网 / 大模型预留位（默认全程不联网）
//
// 现状：这个文件已经被 require 也不会产生任何网络请求 —— 没配置就直接返回
//       { ok:false, reason:"not-configured" }。它是"接口占位"，不是功能。
//
// 想启用时的三步：
//   1) 在应用数据目录放一个 llm.json：
//        { "endpoint": "https://xxx/v1/chat/completions",
//          "model": "xxx", "apiKey": "sk-...", "timeoutMs": 8000 }
//   2) （可选）在启动时调一下 llmBridge.statusText() 看看有没有读到配置
//   3) 想让它真的参与：在 index.js 的 handleMenuUtterance 里，matchDish 返回 -1
//      的时候加两行：
//        llmBridge.parseDish(t).then((r) => { if (r.ok) showImportedDish(r.dish); });
//      —— 加之前务必确认比赛规则允许联网，否则保持现状（纯离线）。
//
// 设计原则：网络永远只做"锦上添花"。断网、超时、返回乱码，都必须退回本地菜谱，
//          绝不能让做饭流程卡在"正在请求"。
// ============================================================================
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 8000;

function dataDirectory() {
  try {
    return require("./application-data").applicationDataDirectory();
  } catch (error) {
    return null;
  }
}

/** 读配置。没有配置文件 / 缺字段 → null。 */
function loadConfig() {
  const dir = dataDirectory();
  if (!dir) return null;
  const file = path.join(dir, "llm.json");
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || !raw.endpoint || !raw.model) return null;
    return {
      endpoint: String(raw.endpoint),
      model: String(raw.model),
      apiKey: raw.apiKey ? String(raw.apiKey) : "",
      timeoutMs: Number.isFinite(raw.timeoutMs) ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
    };
  } catch (error) {
    return null;
  }
}

function ready() {
  return loadConfig() !== null;
}

/** 给人看的当前状态（界面上那行提示用）。 */
function statusText() {
  const cfg = loadConfig();
  if (!cfg) return "未配置联网（纯离线运行）";
  return "已配置联网 · 模型 " + cfg.model;
}

/**
 * 发一次对话请求。
 * @returns {Promise<{ok:true,text:string}|{ok:false,reason:string}>}
 */
async function ask(messages, options) {
  const cfg = loadConfig();
  if (!cfg) return { ok: false, reason: "not-configured" };

  const opts = options || {};
  const body = {
    model: cfg.model,
    messages: Array.isArray(messages) ? messages : [{ role: "user", content: String(messages || "") }],
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.3,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  // fetch 在平台运行时里有；没有的话直接认输，别抛出去
  if (typeof fetch !== "function") return { ok: false, reason: "no-fetch" };

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), cfg.timeoutMs) : null;

  try {
    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = "Bearer " + cfg.apiKey;
    const response = await fetch(cfg.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) return { ok: false, reason: "http-" + response.status };
    const data = await response.json();
    const text = data
      && data.choices
      && data.choices[0]
      && data.choices[0].message
      && data.choices[0].message.content;
    if (!text) return { ok: false, reason: "empty" };
    return { ok: true, text: String(text) };
  } catch (error) {
    return { ok: false, reason: String((error && error.name) || (error && error.message) || error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从模型返回的文本里抠出 JSON（容忍 ```json 围栏和前后废话）。 */
function extractJson(text) {
  const s = String(text || "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

const PARSE_PROMPT = [
  "你是一个中餐菜谱助手。把用户说的菜整理成可执行的步骤，只输出 JSON，不要解释。",
  "格式：{\"title\":\"菜名\",\"steps\":[{\"ask\":\"这一步做什么（不超过30字）\",\"detail\":\"补充提示\",\"phase\":\"prep|cook|seasoning|finish\",\"timeMs\":毫秒数}]}",
  "要求：3 到 7 步；timeMs 只在这一步确实需要等待时才写（比如焖 10 分钟写 600000），不需要等待就写 0。",
].join("\n");

/**
 * 说一个本地菜谱库里没有的菜 → 交给模型整理成菜谱。
 * 返回的菜还会过一次本地校验（和用户导入共用 normalize），不合格就当失败。
 */
async function parseDish(text) {
  if (!ready()) return { ok: false, reason: "not-configured" };
  const reply = await ask([
    { role: "system", content: PARSE_PROMPT },
    { role: "user", content: String(text || "") },
  ], { json: true });
  if (!reply.ok) return reply;
  const parsed = extractJson(reply.text);
  if (!parsed) return { ok: false, reason: "bad-json" };
  const dish = require("./dishes-extra").normalize(parsed, 0);
  if (!dish) return { ok: false, reason: "bad-dish" };
  dish.subtitle = "刚刚生成的";
  return { ok: true, dish };
}

module.exports = { loadConfig, ready, statusText, ask, extractJson, parseDish, PARSE_PROMPT };
