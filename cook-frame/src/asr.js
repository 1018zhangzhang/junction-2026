"use strict";

// ============================================================================
// 【耳朵】语音转文字 · 云端优先 + 本地兜底
// ----------------------------------------------------------------------------
// 对外契约（voice.js 只用这几个）：
//   transcribe(pcmInt16, sampleRate, vocab) → Promise<string|null>
//   ping() / streamOpen(vocab) / streamFeed(id, bytes) / streamClose(id)
//
// 两条识别路，各管一段：
//   ① 流式（本地 Vosk，5001）：边说边出字，负责界面上的实时字幕 —— 快，但小模型不准
//   ② 精识别（可选云端）：一句话说完，把整段 WAV 再送云端识别一次 —— 慢 0.5~1.5s，
//      但中文准确率高得多。voice.js 优先用它，云端超时/失败/空结果就自动退回①的结果。
//
// 配置（都写在同一个 llm.json 里，一个文件管"脑子"和"耳朵"）：
//   {
//     "endpoint": "...", "model": "...", "apiKey": "sk-...",     ← 大模型（llm-bridge 用）
//     "asr": {
//       "stream": { "endpoint": "http://127.0.0.1:5001/asr", "model": "vosk-small-cn" },
//       "final":  { "endpoint": "https://api.siliconflow.cn/v1/audio/transcriptions",
//                   "model": "FunAudioLLM/SenseVoiceSmall", "apiKey": "sk-...", "timeoutMs": 5000 }
//     }
//   }
//   ★ 不写 asr.final = 完全保持原来的本地行为（零网络依赖）。
//   ★ 密钥只从外部文件读，代码里一个字都没有。
//
// 兼容老写法：config.json 里的 { asr: { endpoint, apiKey, model } } 仍然认（= 本地那一路）。
// ============================================================================

const fs = require("node:fs");
// 与 voice.js 同一个日志文件：云端识别的关键证据必须能事后查到
function flog(msg) {
  console.log(msg);
  // 测试可以改到别的文件：跑测试时往真机日志里写，会把现场证据冲掉（踩过）
  const file = process.env.COOK_LOG_FILE || "/tmp/cook-mic.log";
  if (file === "off") return;
  try { fs.appendFileSync(file, new Date().toISOString().slice(11, 23) + " " + msg + "\n"); } catch (e) { /* 忽略 */ }
}
const path = require("node:path");

// ---- PCM(Int16) → WAV 封装（ASR 服务一般只收 wav/mp3 等容器格式） ----
function toWav(pcm, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) view.setInt16(off, pcm[i], true);
  return new Uint8Array(buffer);
}

// ---- 配置读取 ----
const DEFAULT_LOCAL_ASR = {
  endpoint: "http://127.0.0.1:5001/asr",
  apiKey: "local",
  model: "vosk-small-cn",
  timeoutMs: 8000,
};

function loadAsrBlocks() {
  const files = [];
  const explicit = process.env.COOK_ASR_CONFIG;
  if (explicit) files.push(path.resolve(explicit));
  const appDir = process.env.FUSIONUI_APP_DATA_DIR;
  if (appDir && path.isAbsolute(appDir)) {
    files.push(path.join(appDir, "llm.json"));
    files.push(path.join(appDir, "config.json"));
  }
  files.push(path.join(__dirname, "..", "llm.json"));
  files.push(path.join(__dirname, "..", "config.json"));
  const blocks = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && data.asr) blocks.push(data.asr);
    } catch (error) {
      flog("COOK_ASR bad config: " + file);
    }
  }
  return blocks;
}

const ASR_BLOCKS = loadAsrBlocks();
/** ① 本地那一路（流式 + 老的整句识别）：asr.stream，或老写法的 asr.endpoint */
const STREAM_CFG = ASR_BLOCKS.map((b) => b.stream || b).find((c) => c && c.endpoint) || DEFAULT_LOCAL_ASR;
/** ② 云端精识别：只有 endpoint + model + apiKey 三项都填了才启用
 *  （模板里 apiKey 留空 = 默认关闭，用户填上才走云端 —— 不会一装上就白等超时） */
/* ② 云端精识别：可以配**多家**，按顺序试，第一个给出有效文本的胜出。
 *    写法二选一： "final": {…}   或   "final": [ {…}, {…} ]
 *    每家都必须 endpoint + model + apiKey 齐全才启用（apiKey 留空 = 没配，不会白等超时）。
 *    例：硅基流动 SenseVoice 打头，阿里 paraformer 兜底 —— 一家抽风还有一家。*/
function pickFinal(block) {
  if (!block) return [];
  const list = Array.isArray(block) ? block : [block];
  return list.filter((c) => {
    if (!c) return false;
    // 火山（豆包语音）：两种鉴权都认
    //   旧控制台：AppID + AccessToken（X-Api-App-Key + X-Api-Access-Key）
    //   新控制台：一个 API Key 就够（X-Api-Key），不用 appid —— 2026 年起新建的账号都是这种
    if (c.kind === "volc-flash" || c.kind === "volc-sauc") {
      c.appId = c.appId || c.appKey || c.appid;
      c.accessToken = c.accessToken || c.accessKey || c.token;
      c.apiKey = c.apiKey || c.api_key;
      return Boolean(c.apiKey || (c.appId && c.accessToken));
    }
    return Boolean(c.endpoint && c.model && c.apiKey);
  });
}
const FINAL_LIST = ASR_BLOCKS.reduce((acc, b) => acc.concat(pickFinal(b.final)), []);
const finalReady = FINAL_LIST.length > 0;

if (finalReady) {
  flog("COOK_ASR final=cloud " + FINAL_LIST.length + " 路 ["
    + FINAL_LIST.map((c, i) => (i + 1) + "." + (c.kind === "volc-flash" || c.kind === "volc-sauc" ? "火山豆包" + (c.kind === "volc-sauc" ? "一句话" : "极速版") : c.model)).join(" | ") + "]");
} else flog("COOK_ASR final=local " + STREAM_CFG.model + " -> " + STREAM_CFG.endpoint);

/** 识别结果是不是"有意义的文字"。
 *  本地 Vosk 没听清时会给一个英文句点或 "Okay."，云端偶尔返空串；
 *  这种结果当成"听清了"会让界面显示「听到「.」· 没对上」，比不识别更气人。 */
function validText(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return null;
  const core = t.replace(/[\s\p{P}\p{S}]/gu, "");
  if (!core) return null;                              // 只有标点/符号
  /* ★ v58c：外语噪声拦截。
   *   SenseVoice 这类多语种模型是"自动判语种"的：一段 1.4 秒的噪音（锅响、风扇、
   *   椅子响）会被判成日语，返回「どうてですね。」，界面就当成"听懂了"去执行，
   *   结果就是"听不懂话 + 屏幕上冒出日语"。这里按字符比例拦：假名/韩文占比超过 1/4
   *   就认为不是中文命令，丢掉换下一路。中英混说、个别错字不受影响。 */
  const kana = (core.match(/[\u3040-\u30FF]/g) || []).length;
  const hangul = (core.match(/[\uAC00-\uD7AF\u1100-\u11FF]/g) || []).length;
  if ((kana + hangul) / core.length > 0.25 && !/[\u3400-\u9FFF]/.test(core)) {
    flog("COOK_ASR reject-foreign " + JSON.stringify(t.slice(0, 24)));
    return null;
  }
  const hasCJK = /[\u3400-\u9FFF]/.test(core);
  if (!hasCJK && /^[A-Za-z0-9']+$/.test(core)) {
    // 纯英文/数字：厨房场景几乎没有这种话，多半是模型没听清的噪声
    if (core.length <= 3 || /^(ok|okay|oh|um|uh|hey|hi|no|yes|the|a|and|yeah|yep|hmm|mm|ah|well|so)$/i.test(core)) return null;
  }
  // ★ 去掉句首的英文口头噪声：云端模型常给「Yeah。我想吃酸辣土豆丝。」，
  //   这个前缀不影响人看，但会让「菜名匹配」从头就错位，所以先摘掉。
  const trimmed = t.replace(/^(?:(?:yeah|yep|okay|ok|oh|well|hmm|um|uh|so|mm|ah)[\s.,。、!?…]*)+/i, "").trim();
  if (trimmed && /[\u3400-\u9FFF]/.test(trimmed)) return trimmed;
  return t;
}

/** 调试用：把最近一次录到的音频落盘，可直接播放检查采集质量 */
function dumpWav(wav) {
  try {
    const dumpPath = (process.env.FUSIONUI_APP_DATA_DIR
      ? process.env.FUSIONUI_APP_DATA_DIR + "/"
      : "/tmp/") + "cook-last-utterance.wav";
    fs.writeFileSync(dumpPath, Buffer.from(wav));
  } catch (e) { /* 落盘失败不影响识别 */ }
}

async function postWav(url, cfg, wav, extraFields, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append("model", cfg.model);
    for (const [k, v] of Object.entries(extraFields || {})) {
      if (v !== undefined && v !== null && v !== "") form.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    }
    form.append("response_format", cfg.responseFormat || "json");
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    const headers = {};
    if (cfg.apiKey) headers.Authorization = "Bearer " + cfg.apiKey;
    const response = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const text = data.text
      || (data.data && data.data.text)
      || (data.result && data.result.text)
      || "";
    return String(text || "").trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

/** 第三类"耳朵"：把音频直接交给能听的多模态大模型（Qwen3-Omni 等），
 *  走 /chat/completions 的 audio_url（base64 data URL）。
 *  好处：它同时"看到"我们的场景提示（做饭、菜名、指令词），歧义句更容易听对；
 *  代价：比专用 ASR 慢，所以放在多路里当兜底或主力都行，由配置顺序决定。 */
async function transcribeChatAudio(cfg, wav, timeoutMs) {
  const b64 = Buffer.from(wav).toString("base64");
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: 64,
    messages: [{
      role: "user",
      content: [
        { type: "audio_url", audio_url: { url: "data:audio/wav;base64," + b64 } },
        { type: "text", text: cfg.prompt
          || "把这段中文语音逐字转写成文字，只输出听到的内容本身，不要解释、不要翻译、不要加引号。" },
      ],
    }],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content;
    return String(content || "").trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────── 火山引擎（豆包同源）录音文件识别·极速版 ──────────────
 *  为什么单独写：它不走 OpenAI 协议（双凭据 + 自定义 header），但它是豆包 App
 *  背后同一套大模型识别，中文口语/短句/同音字明显强于小模型；还支持热词表，
 *  把「麻婆豆腐、糖醋排骨、太咸了」这些词喂进去，厨房场景的准确率提升最大。
 *  同步 HTTP + base64 直传，正好适合我们本地录好的 wav，不需要公网 URL。
 *  免费额度：新用户 20 小时 / 半年，比赛够用。
 */
const VOLC_FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";

function requestId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* 忽略 */ }
  return "cook-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2, 10);
}

async function transcribeVolcFlash(cfg, wav, timeoutMs, vocab) {
  if (typeof fetch !== "function") throw new Error("no-fetch");
  const body = {
    user: { uid: String(cfg.uid || cfg.appId || "cook-demo") },
    audio: { format: "wav", data: Buffer.from(wav).toString("base64") },
    request: { model_name: "bigmodel", enable_punc: true, enable_itn: true },
  };
  // 热词表：一行一个词。菜名、调料、口令全喂进去——这是提准确率最有效的一招
  const words = (vocab || []).filter((w) => w && String(w).trim()).slice(0, 200);
  if (words.length) body.request.corpus = { context: words.join("\n") };

  // 鉴权：新版控制台只给一个 API Key（X-Api-Key），旧版是 AppID + AccessToken 两个头
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["X-Api-Key"] = String(cfg.apiKey);
  else {
    headers["X-Api-App-Key"] = String(cfg.appId);
    headers["X-Api-Access-Key"] = String(cfg.accessToken);
  }
  headers["X-Api-Resource-Id"] = cfg.resourceId || "volc.bigasr.auc_turbo";
  headers["X-Api-Request-Id"] = requestId();
  headers["X-Api-Sequence"] = "-1";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.endpoint || VOLC_FLASH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const status = res.headers && res.headers.get ? res.headers.get("X-Api-Status-Code") : "";
    const msg = res.headers && res.headers.get ? res.headers.get("X-Api-Message") : "";
    const data = await res.json().catch(() => null);
    if (status && status !== "20000000") {
      // 20000003 = 这段音频里没人说话（正常情况，不是故障）
      if (status === "20000003") return null;
      // 45000030 = Key 是真的，但「录音文件识别极速版」这个服务没开通（控制台点一下「试用」）
      if (status === "45000030") throw new Error("volc-45000030:还没开通「录音文件识别-极速版」");
      throw new Error("volc-" + status + (msg ? ":" + msg : ""));
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const r = data && data.result;
    const text = (r && (r.text || (Array.isArray(r) && r[0] && r[0].text))) || "";
    return String(text || "").trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

/** 云端精识别：OpenAI 兼容 /v1/audio/transcriptions，多路依次尝试 */
async function transcribeCloud(wav, vocab) {
  for (let i = 0; i < FINAL_LIST.length; i++) {
    const cfg = FINAL_LIST[i];
    // 单路超时压到 2.2s：voice.js 那边总共最多等 2.6s，配多家时也不会把响应拖死
    const timeoutMs = cfg.timeoutMs || 2200;
    const t0 = Date.now();
    try {
      const raw = cfg.kind === "volc-flash"
        ? await transcribeVolcFlash(cfg, wav, timeoutMs, vocab)
        : cfg.kind === "volc-sauc"
          ? await require("./asr-volc-ws").transcribeSauc(cfg, wav, timeoutMs, vocab)
          : cfg.kind === "chat-audio"
            ? await transcribeChatAudio(cfg, wav, timeoutMs)
            : await postWav(cfg.endpoint, cfg, wav,
                { language: cfg.language || "zh" }, timeoutMs);
      /* ★ v58c：language 不再留空。
       *   SenseVoice 的 language 参数留空 = auto（自动判语种），短噪音就会被判成日语/
       *   韩语，日志里出现过 「どうてですね。」。固定成 zh 之后，同一段噪音只会输出
       *   中文乱码或空串，不会再把界面带到外语去。想恢复自动识别：config.json 里
       *   给这一路写 "language": "auto"。 */
      const text = validText(raw);
      flog("COOK_ASR_CLOUD[" + (i + 1) + "] " + (text ? "ok" : "empty")
        + " " + (Date.now() - t0) + "ms " + JSON.stringify(String(raw || "").slice(0, 24)));
      if (text) return text;                 // 这家听出来了就用它，不再问下一家
    } catch (error) {
      const name = String((error && error.name) || "");
      const msg = String((error && error.message) || error || "");
      flog("COOK_ASR_CLOUD[" + (i + 1) + "] fail "
        + (name === "AbortError" || /timeout|abort/i.test(msg) ? "timeout" : msg)
        + " " + (Date.now() - t0) + "ms → 换下一路/本地兜底");
    }
  }
  return null;
}

/** 本地精识别（老路）：整句 WAV + 词表 → 本机识别服务 /asr */
async function transcribeLocal(wav, vocab) {
  const timeoutMs = STREAM_CFG.timeoutMs || 15000;
  return postWav(STREAM_CFG.endpoint, STREAM_CFG, wav, { language: STREAM_CFG.language, vocab }, timeoutMs);
}

/** 唯一对外入口：云优先，云不可用/失败就交回本地（voice.js 还会再退回流式结果） */
async function transcribe(pcm, sampleRate, vocab) {
  const rate = sampleRate || 16000;
  const wav = toWav(pcm, rate);
  dumpWav(wav);
  if (finalReady) {
    const cloud = await transcribeCloud(wav, vocab);
    if (cloud) return cloud;
    return validText(await transcribeLocal(wav, vocab).catch(() => null));
  }
  return validText(await transcribeLocal(wav, vocab).catch((error) => {
    flog("COOK_ASR failed: " + ((error && error.message) || error));
    return null;
  }));
}

// ---- 流式识别（实时上屏用）----
// 服务端保持同一个识别器上下文，小块持续喂，平台切会话不影响句子完整性。
const STREAM_BASE = STREAM_CFG.endpoint.replace(/\/asr$/, "");

/** 带超时的 fetch：任何请求卡死都能自动断开（绝不挂起识别管线）。 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** 探活：识别服务到底在不在。1.5 秒超时，绝不拖慢主循环。
 *  服务没起时以前会一路「没听清，请再说一遍」，把人误导成麦克风坏了。 */
async function ping(timeoutMs) {
  try {
    const response = await fetchWithTimeout(STREAM_BASE + "/ping", {
      method: "GET",
      headers: { Authorization: "Bearer " + STREAM_CFG.apiKey },
    }, timeoutMs || 1500);
    return !!response.ok;
  } catch (error) {
    return false;
  }
}

async function streamOpen(vocab) {
  const headers = { Authorization: "Bearer " + STREAM_CFG.apiKey };
  const options = { method: "POST", headers };
  // 有词表就以 JSON 推给服务（服务端用它限定识别范围，小模型准确率更高）
  if (Array.isArray(vocab) && vocab.length) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({ vocab });
  }
  const response = await fetchWithTimeout(STREAM_BASE + "/stream/open", options, 4000);
  if (!response.ok) throw new Error("open HTTP " + response.status);
  const data = await response.json();
  return data.id;
}

/** 喂一小块 PCM（Uint8Array，s16le），返回当前部分文字。 */
async function streamFeed(id, pcmBytes) {
  const response = await fetchWithTimeout(STREAM_BASE + "/stream/" + id, {
    method: "POST",
    headers: { Authorization: "Bearer " + STREAM_CFG.apiKey, "Content-Type": "application/octet-stream" },
    body: pcmBytes,
  }, 3000);
  if (!response.ok) throw new Error("feed HTTP " + response.status);
  const data = await response.json();
  return String(data.partial || "");
}

/** 收尾：返回最终整句文字。 */
async function streamClose(id) {
  const response = await fetchWithTimeout(STREAM_BASE + "/stream/" + id + "/end", {
    method: "POST",
    headers: { Authorization: "Bearer " + STREAM_CFG.apiKey },
  }, 6000);
  if (!response.ok) throw new Error("close HTTP " + response.status);
  const data = await response.json();
  return String(data.text || "").trim();
}

module.exports = {
  transcribe,
  validText,                 // voice.js 也要用它过滤流式结果的垃圾
  finalReady,
  finalCount: FINAL_LIST.length,
  streamConfig: { endpoint: STREAM_CFG.endpoint, model: STREAM_CFG.model },
  remoteReady: true,   // 流式那一路永远有默认地址，兼容旧字段
  ping, streamOpen, streamFeed, streamClose,
};
