"use strict";

// ============================================================================
// 【嘴→耳桥】ASR 语音转文字插座
// ----------------------------------------------------------------------------
// 给队友的接口契约（实现下面这个函数即可接入）：
//
//   transcribe(pcmInt16, sampleRate) → Promise<string|null>
//     pcmInt16   : Int16Array，16kHz 单声道，一句话的完整 PCM
//     返回       : 识别出的文字；识别不出返回 null
//
// 内置实现 v1：
//   · config.json 里有 asr.endpoint + asr.apiKey + asr.model
//     → 自动用 OpenAI 兼容的 /audio/transcriptions 接口（硅基流动格式，
//       PCM 现场打包成 WAV 上传，模型填 FunAudioLLM/SenseVoiceSmall 这类）
//   · 没配置 → 返回 null，界面提示"语音转文字未接入"
//   · 队友的本地/自研 ASR：直接替换本文件的 transcribe 实现即可，
//     其余代码一行不用动。
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

function loadConfig() {
  const candidates = [
    path.join(__dirname, "..", "config.json"),
    path.join(__dirname, "config.json")
  ];
  const appDir = process.env.FUSIONUI_APP_DATA_DIR;
  if (appDir) candidates.unshift(path.join(appDir, "config.json"));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.log("COOK_ASR bad config: " + file);
    }
  }
  return null;
}

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

const config = loadConfig();
const asr = (config && config.asr) || {};

// 没有配置文件时，默认指向本机 Vosk 识别服务（asr-service/asr_server.py，端口 5001）
const DEFAULT_LOCAL_ASR = {
  endpoint: "http://127.0.0.1:5001/asr",
  apiKey: "local",
  model: "vosk-small-cn",
  timeoutMs: 8000
};
const effective = asr.endpoint ? asr : DEFAULT_LOCAL_ASR;
const remoteReady = Boolean(effective.endpoint && effective.apiKey && effective.model);
if (remoteReady) console.log("COOK_ASR ready: " + effective.model + " -> " + effective.endpoint);
else console.log("COOK_ASR no endpoint configured, transcribe() will return null");

/** 唯一对外入口。队友替换这一个函数即可。 */
async function transcribe(pcm, sampleRate, vocab) {
  const rate = sampleRate || 16000;
  if (!remoteReady) return null;
  const wav = toWav(pcm, rate);
  // 调试用：把最近一次录到的音频落盘，可直接播放检查采集质量
  try {
    const dumpPath = (process.env.FUSIONUI_APP_DATA_DIR
      ? process.env.FUSIONUI_APP_DATA_DIR + "/"
      : "/tmp/") + "cook-last-utterance.wav";
    fs.writeFileSync(dumpPath, Buffer.from(wav));
  } catch (e) { /* 落盘失败不影响识别 */ }
  const timeoutMs = effective.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append("model", effective.model);
    if (effective.language) form.append("language", effective.language);
    // 把当前菜谱/指令词表一起推过去，服务端两种认法都用它打分
    if (vocab && vocab.length) form.append("vocab", JSON.stringify(vocab));
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    const response = await fetch(effective.endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + effective.apiKey },
      body: form,
      signal: controller.signal
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const text = data.text || (data.data && data.data.text) || "";
    return String(text || "").trim() || null;
  } catch (error) {
    console.log("COOK_ASR failed: " + ((error && error.message) || error));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 流式识别（实时上屏用）----
// 服务端保持同一个识别器上下文，小块持续喂，平台切会话不影响句子完整性。
const STREAM_BASE = effective.endpoint.replace(/\/asr$/, "");

/** 带 超时 的 fetch：任何请求卡死都能自动断开（绝不挂起识别管线）。 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function streamOpen(vocab) {
  const headers = { Authorization: "Bearer " + effective.apiKey };
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
    headers: { Authorization: "Bearer " + effective.apiKey, "Content-Type": "application/octet-stream" },
    body: pcmBytes
  }, 3000);
  if (!response.ok) throw new Error("feed HTTP " + response.status);
  const data = await response.json();
  return String(data.partial || "");
}

/** 收尾：返回最终整句文字。 */
async function streamClose(id) {
  const response = await fetchWithTimeout(STREAM_BASE + "/stream/" + id + "/end", {
    method: "POST",
    headers: { Authorization: "Bearer " + effective.apiKey }
  }, 6000);
  if (!response.ok) throw new Error("close HTTP " + response.status);
  const data = await response.json();
  return String(data.text || "").trim();
}

module.exports = { transcribe, remoteReady, streamOpen, streamFeed, streamClose };
