"use strict";

// 语音采集：SDK 只提供麦克风（16 kHz / 单声道 / s16le PCM），不提供识别。
// 这里负责：开会话 → 收帧 → 用静音检测自动收尾 → 交出一个 WAV。
// 识别在 llm.transcribe 里做，两者分开，方便单独测。
const { performance } = require("node:perf_hooks");

const LOUD_RMS = 380;       // 说话阈值（s16le 幅度），低于它视为安静
const MIN_SPEECH_MS = 500;  // 至少录到这么久才允许因为静音结束

function rms(buffer) {
  if (!buffer || buffer.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < buffer.length; i += 4) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.sqrt(sum / count);
}

function createVoice(options) {
  const inputApi = options.inputApi;
  const config = options.config;
  const log = options.log;

  let session = null;
  const state = {
    active: false,
    finishing: false,
    chunks: [],
    sampleRate: 16000,
    startedAt: 0,
    lastLoudAt: 0,
    loudSeen: false,
    lastState: ""
  };

  function availability() {
    if (!inputApi || typeof inputApi.getVoiceInputAvailability !== "function") {
      return { supported: false, declared: false, canRequest: false, ready: false, reason: "unsupported" };
    }
    try {
      return inputApi.getVoiceInputAvailability("audio");
    } catch (error) {
      return { supported: false, declared: false, canRequest: false, ready: false, reason: "backend-error" };
    }
  }

  function start() {
    if (session) return { ok: false, reason: "busy" };
    const info = availability();
    if (!info.canRequest) return { ok: false, reason: info.reason || "unsupported" };

    try {
      session = inputApi.requestVoiceInput({ mode: "audio" });
    } catch (error) {
      session = null;
      const reason = (error && error.code) || "backend-error";
      return { ok: false, reason: String(reason) };
    }

    state.active = true;
    state.finishing = false;
    state.chunks = [];
    state.startedAt = performance.now();
    state.lastLoudAt = state.startedAt;
    state.loudSeen = false;
    state.lastState = "pending";
    log("voice_start", { available: info.ready });
    return { ok: true };
  }

  function finish() {
    if (!session || state.finishing) return;
    state.finishing = true;
    try {
      session.finish();
    } catch (error) {
      log("voice_finish_failed", { message: String((error && error.message) || error) });
    }
  }

  function cancel() {
    if (!session) return;
    state.finishing = true;
    try {
      session.cancel();
    } catch (error) {
      log("voice_cancel_failed", { message: String((error && error.message) || error) });
    }
  }

  // 每帧调用一次。返回值：
  //   null                          → 还要继续录
  //   { ok:true, wav, durationMs }  → 录完了，拿去识别
  //   { ok:false, reason }          → 失败或取消
  function pump() {
    if (!session) return null;

    for (let guard = 0; guard < 8; guard += 1) {
      const event = session.takeEvent();
      if (!event) break;

      if (event.type === "state") {
        if (event.state !== state.lastState) {
          state.lastState = event.state;
          log("voice_state", { state: event.state, reason: event.reason });
        }
        if (event.state === "recording") state.startedAt = performance.now();
        if (event.state === "cancelling") state.finishing = true;
        continue;
      }

      if (event.type === "audio") {
        const buffer = Buffer.from(event.data);
        state.chunks.push(buffer);
        const level = rms(buffer);
        if (level >= LOUD_RMS) {
          state.loudSeen = true;
          state.lastLoudAt = performance.now();
        }
        continue;
      }

      if (event.type === "end") {
        const chunks = state.chunks;
        const durationMs = Math.round((performance.now() - state.startedAt));
        session = null;
        state.active = false;
        state.finishing = false;
        state.chunks = [];
        log("voice_end", {
          status: event.status,
          reason: event.reason,
          frames: chunks.length,
          durationMs,
          loudSeen: state.loudSeen
        });
        if (event.status !== "completed") {
          return { ok: false, reason: event.reason || event.status };
        }
        if (!state.loudSeen || chunks.length === 0) {
          return { ok: false, reason: "no-speech" };
        }
        return { ok: true, chunks, durationMs, sampleRate: state.sampleRate };
      }
    }

    // 自动收尾：说完了就停，别让用户等 60 秒上限
    if (!session) return null;
    const now = performance.now();
    if (state.lastState === "recording" && !state.finishing) {
      if (state.loudSeen && now - state.lastLoudAt >= config.behavior.voiceSilenceMs) {
        log("voice_auto_finish", { silentMs: Math.round(now - state.lastLoudAt) });
        finish();
      } else if (now - state.startedAt >= config.behavior.voiceMaxMs) {
        log("voice_time_cap", { durationMs: Math.round(now - state.startedAt) });
        finish();
      }
    }
    return null;
  }

  function isActive() {
    return Boolean(session);
  }

  function reasonText(reason) {
    switch (reason) {
      case "not-declared":
        return "未声明 input.audio 权限，检查 FusionUIApp.json";
      case "permission-required":
        return "需要在 Client 里允许麦克风";
      case "permission-denied":
        return "麦克风权限被拒绝";
      case "device-unavailable":
        return "没有可用的麦克风";
      case "disconnected":
        return "模拟器连接断开";
      case "unsupported":
        return "当前环境不支持录音";
      case "busy":
        return "上一段录音还没结束";
      case "no-speech":
        return "没听到声音，请再说一次";
      case "user-cancelled":
        return "已取消录音";
      case "time-limit":
        return "录音超时";
      default:
        return "录音失败：" + String(reason || "unknown");
    }
  }

  return { start, pump, cancel, finish, isActive, availability, reasonText };
}

module.exports = { createVoice, rms, LOUD_RMS };
