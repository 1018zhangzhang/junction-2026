"use strict";
// ============================================================================
// 【火山·一句话识别】豆包流式语音识别模型 2.0 · nostream 端点（wss）
// ----------------------------------------------------------------------------
// 为什么自己写 WebSocket：
//   1) 握手要带 X-Api-Key 自定义头 —— 浏览器/undici 的 WebSocket 不让带，只能
//      自己发 HTTP Upgrade 请求（node:tls + 手写帧协议），依赖为零；
//   2) 这套二进制帧协议和官方 Python demo 完全一致：
//        4 字节头：版本|头长，消息类型|标志，序列化|压缩，保留
//        full client request = gzip(JSON)，audio 帧 = gzip(音频块)
//        最后一帧 flags=NEG_SEQUENCE，服务端回整句 JSON。
//   3) 「一句话识别」是整句音频一次发完、回一次结果 —— 正好匹配我们
//      「说完一句 → 整段 wav → 精识别」的耳朵管线，不需要逐字上屏。
//
// 配置（llm.json → asr.final 数组里的一项）：
//   { "kind": "volc-sauc", "apiKey": "控制台 API Key", "timeoutMs": 4000 }
//   可选：resourceId（默认 volc.seedasr.sauc.duration）、endpoint、uid
// ============================================================================

const tls = require("node:tls");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const DEFAULT_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const DEFAULT_RESOURCE = "volc.seedasr.sauc.duration";
const HOST = "openspeech.bytedance.com";

// ---- v3 二进制协议常量（与官方 demo 一字不差） ----
const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;                 // 单位是 4 字节，1 = 4 字节
const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const ERROR_RESPONSE = 0b1111;
const NO_SEQUENCE = 0b0000;
const NEG_SEQUENCE = 0b0010;                // 最后一包
const SER_JSON = 0b0001;
const COMP_GZIP = 0b0001;

function header(msgType, flags) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (msgType << 4) | flags,
    (SER_JSON << 4) | COMP_GZIP,
    0x00,
  ]);
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** 从 wav 头里读采样率（读不到就按 16000）——TTS/录音设备产的不一定是 16k */
function wavRate(wav) {
  try {
    if (wav.length > 44 && wav.toString("ascii", 0, 4) === "RIFF") {
      const r = wav.readUInt32LE(24);
      if (r >= 8000 && r <= 48000) return r;
    }
  } catch (e) { /* 忽略 */ }
  return 16000;
}

/** full client request：gzip(JSON) */
function buildFullRequest(obj) {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8"));
  return Buffer.concat([header(FULL_CLIENT_REQUEST, NO_SEQUENCE), u32(payload.length), payload]);
}

/** audio 帧：gzip(音频块)；isLast 时 flags=NEG_SEQUENCE */
function buildAudio(chunk, isLast) {
  const payload = zlib.gzipSync(chunk);
  return Buffer.concat([header(AUDIO_ONLY_REQUEST, isLast ? NEG_SEQUENCE : NO_SEQUENCE), u32(payload.length), payload]);
}

/** 客户端→服务端的 WS 帧必须带掩码（RFC6455） */
function wsFrame(opcode, data) {
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** 从收发缓冲里解出一帧服务端消息（服务端帧不带掩码） */
function readWsFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4); off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, payload, rest: buf.subarray(off + len) };
}

/** 解 volc v3 帧：返回 {type, code, msg, json, isLast} */
function parseVolcFrame(frame) {
  const msgType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let payload = frame.subarray((frame[0] & 0x0f) * 4);
  // flags 0b0001/0b0011 表示头部带 4 字节 sequence
  if (flags === 0b0001 || flags === 0b0011) payload = payload.subarray(4);
  const isLast = (flags & 0b0010) !== 0;
  if (msgType === ERROR_RESPONSE) {
    const code = payload.readUInt32BE(0);
    const size = payload.readUInt32BE(4);
    let msg = payload.subarray(8, 8 + size);
    if (compression === COMP_GZIP) { try { msg = zlib.gunzipSync(msg); } catch (e) { /* 原样 */ } }
    return { type: "error", code, msg: msg.toString("utf8"), isLast };
  }
  if (msgType === FULL_SERVER_RESPONSE) {
    const size = payload.readUInt32BE(0);
    let body = payload.subarray(4, 4 + size);
    if (compression === COMP_GZIP) body = zlib.gunzipSync(body);
    return { type: "full", json: serialization === SER_JSON ? JSON.parse(body.toString("utf8")) : null, isLast };
  }
  return { type: "unknown-" + msgType, isLast };
}

/**
 * 一句话识别：整段 wav 一次发完，拿回整句文字。
 * @param {{apiKey?:string, appId?:string, accessToken?:string, endpoint?:string,
 *          resourceId?:string, uid?:string, timeoutMs?:number}} cfg
 * @param {Buffer} wav  16k(或服务端支持的采样率) 单声道 wav
 * @param {number} timeoutMs  整体超时
 * @param {string[]} vocab  热词表（提升菜名/口令识别）
 * @returns {Promise<string|null>}
 */
async function transcribeSauc(cfg, wav, timeoutMs, vocab) {
  const key = String(cfg.apiKey || "");
  const hasOld = cfg.appId && cfg.accessToken;
  if (!key && !hasOld) throw new Error("no-credentials");
  const urlPath = (() => {
    try { return new URL(cfg.endpoint || DEFAULT_URL).pathname || "/api/v3/sauc/bigmodel_nostream"; }
    catch (e) { return "/api/v3/sauc/bigmodel_nostream"; }
  })();

  const requestId = "cook-" + crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) { /* 忽略 */ }
      fn(val);
    };
    const timer = setTimeout(() => finish(reject, new Error("timeout")), timeoutMs || 4000);

    const socket = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
      const keyB64 = crypto.randomBytes(16).toString("base64");
      const lines = [
        "GET " + urlPath + " HTTP/1.1",
        "Host: " + HOST,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: " + keyB64,
        "Sec-WebSocket-Version: 13",
        // 网关会拦不带 User-Agent 的裸握手（403），必须带一个
        "User-Agent: cook-app/1.0",
      ];
      if (key) lines.push("X-Api-Key: " + key);
      else {
        lines.push("X-Api-App-Key: " + String(cfg.appId));
        lines.push("X-Api-Access-Key: " + String(cfg.accessToken));
      }
      lines.push("X-Api-Resource-Id: " + String(cfg.resourceId || DEFAULT_RESOURCE));
      lines.push("X-Api-Request-Id: " + requestId);
      lines.push("", "");
      socket.write(lines.join("\r\n"));
    });

    let stage = "handshake";   // handshake → ws
    let rx = Buffer.alloc(0); // ws 阶段的收包缓冲
    let wsBuf = Buffer.alloc(0);

    const sendAll = () => {
      const req = {
        user: { uid: String(cfg.uid || "cook-demo") },
        audio: { format: "wav", codec: "raw", rate: wavRate(wav), bits: 16, channel: 1 },
        request: { model_name: "bigmodel", enable_punc: true, enable_itn: true },
      };
      const words = (vocab || []).filter((w) => w && String(w).trim()).slice(0, 100);
      if (words.length) req.request.corpus = { hotwords: words.map((w) => ({ word: String(w).trim() })) };
      socket.write(wsFrame(0x2, buildFullRequest(req)));
      // 音频整段发送：64KB 一帧（服务端自己按 VAD 分句，不需要按真实语速喂）
      const CHUNK = 65536;
      for (let off = 0; off < wav.length; off += CHUNK) {
        const isLast = off + CHUNK >= wav.length;
        socket.write(wsFrame(0x2, buildAudio(wav.subarray(off, Math.min(wav.length, off + CHUNK)), isLast)));
      }
    };

    socket.on("data", (chunk) => {
      if (stage === "handshake") {
        wsBuf = Buffer.concat([wsBuf, chunk]);
        const idx = wsBuf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = wsBuf.subarray(0, idx).toString("utf8");
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          finish(reject, new Error("handshake " + (head.split("\r\n")[0] || "").slice(0, 60)));
          return;
        }
        stage = "ws";
        rx = wsBuf.subarray(idx + 4);
        wsBuf = Buffer.alloc(0);
        sendAll();
        drain();
        return;
      }
      rx = Buffer.concat([rx, chunk]);
      drain();
    });

    function drain() {
      while (true) {
        const f = readWsFrame(rx);
        if (!f) return;
        rx = f.rest;
        if (f.opcode === 0x8) { finish(resolve, null); return; }          // close
        if (f.opcode === 0x9) { socket.write(wsFrame(0xA, f.payload)); continue; } // ping→pong
        if (f.opcode !== 0x2 && f.opcode !== 0x0) continue;               // 只要二进制
        let volc;
        try { volc = parseVolcFrame(f.payload); }
        catch (e) { finish(reject, new Error("bad-frame")); return; }
        if (volc.type === "error") {
          // 45000030 = 服务没开通；20000003 = 没人说话
          finish(reject, new Error("volc-" + volc.code + (volc.msg ? ":" + volc.msg.slice(0, 80) : "")));
          return;
        }
        if (volc.type === "full") {
          const p = volc.json || {};
          if (p.code && p.code !== 0) {
            finish(reject, new Error("volc-" + p.code + ":" + String(p.message || "").slice(0, 80)));
            return;
          }
          const text = p.result && p.result.text ? String(p.result.text).trim() : "";
          if (volc.isLast || p.is_last_package) { finish(resolve, text || null); return; }
        }
      }
    }

    socket.on("error", (e) => finish(reject, new Error("network:" + (e && e.code || e && e.message || "error"))));
  });
}

module.exports = { transcribeSauc, parseVolcFrame, buildFullRequest, buildAudio };
