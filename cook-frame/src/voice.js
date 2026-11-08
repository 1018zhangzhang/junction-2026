"use strict";

// ============================================================================
// 【耳朵】音频采集 + 流式识别编排 v3
// ----------------------------------------------------------------------------
// 平台 API（已对照 sdk/public-api/os/input.d.ts 核实）：
//   requestVoiceInput({mode:"audio"}) → 会话
//   session.takeEvent() → 三种事件：
//     {type:"state", state:"pending"|"recording"|"cancelling"}  pending=等用户授权
//     {type:"audio", data:Uint8Array(s16le 16kHz 单声道, 每帧320样本=20ms)}
//     {type:"end",  status:"completed"|"cancelled"|"error"}     权威结束事件
//   规则：必须消费到 end 才能开下一次会话；60 秒上限；64 帧排队上限。
//
// 重要经验：平台自己的静音检测很激进，说话中途一停顿就 end(completed) 切一刀。
// 因此本模块的策略是【流式识别】：
//   · 录音帧全量缓存，每攒 200ms 就喂给 asr.js 的流式接口（服务端 Vosk 保持上下文）
//   · 部分文字通过 onPartial 实时回调 → 界面实时显示"正在说的字"
//   · 平台切会话【不关闭识别流】，静音够久（短口令约 1 秒、长句最多 2.5 秒）才收尾 → onText(完整句子)
//   · 流式不可用（服务没开）时自动退回旧路径：整句 PCM → onUtterance(pcm)
// ============================================================================

const input = require("@irisview/osx/os/input");
const asr = require("./asr");

// 调试文件日志：同时写终端和 /tmp/cook-mic.log，方便远程直接读
const fs = require("node:fs");
const LOG_PATH = "/tmp/cook-mic.log";
function flog(msg) {
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString().slice(11, 23) + " " + msg + "\n"); } catch (e) { /* 忽略 */ }
}

// 参数
const P = {
  hiLevel: 0.03,      // 超过它 = 有声音（统计/音量条用）
  /* ★ 起说门槛（"分贝要求"就是这个数）。数越大越不灵敏、越不容易被环境噪音带跑。
   *   0.012 → 0.008（当时为了让小声说话也能进）→ 0.02（v58c 调回来）：
   *   0.008 时实测日志里 level=0.0002~0.0075 的底噪一直在刷新 lastVoiceAt，
   *   于是永远等不到"说完了"，一句能录 28 秒不断句，
   *   本地小模型就在长流里一路瞎猜（partial 越滚越长）。
   *   觉得还是不灵敏就改回 0.012；觉得还是太敏感就加到 0.03。 */
  vadLevel: 0.02,
  silenceMs: 900,     // 有声后安静这么久 → 自己出句（仅退回模式用；700→900 少切碎句子）
  minSpeechMs: 300,   // 比这短的"发声"当噪音丢掉（200→300，咳嗽/碰桌子不再当一句话）
  maxUtterMs: 12000,  // 单句保护上限
  feedEveryMs: 200,   // 每攒 200ms 音频喂一次流
  // ★ 说完一句话后，静音多久算「这句说完了」→ 出整句文字交给程序执行
  //   不是固定值：短口令（"下一步""可乐鸡翅"）等 1 秒就出，长句子最多等 2.5 秒
  //   公式：700 + 120 × 已识别字数，夹在 [minIdleMs, maxIdleMs] 之间
  //   想让整体更快：调小 minIdleMs；想让整体更宽容：调大 maxIdleMs
  // ★ 1000 → 1500：实测「我想吃…酸辣土豆丝」中间那一顿会被当成说完了，
  //   只录到前半句（日志里出现过 0.2 秒的音频），云端自然只能瞎猜。
  minIdleMs: 1500,
  maxIdleMs: 2800,
  vocab: null         // 开流时推给 ASR 服务的词表（菜名/食材/指令词，index.js 注入）
};

const st = {
  session: null,
  state: "idle",      // idle | pending | recording | ending
  reason: "none",
  lastError: "",
  // 批量退回模式的 VAD 运行时
  chunks: [],         // 录音期间的 PCM 帧集合（Uint8Array，全量缓存）
  sentChunks: [],     // 当前这句话的 PCM（每次收尾后清空，用来做二次精识别）
  voicedMs: 0,
  trailingMs: 0,
  lastNow: 0,
  level: 0,
  lastLevelLogAt: 0,
  // 流式识别状态
  stream: {
    id: null,         // 服务端识别流 id（null = 未开）
    opening: false,
    healthy: false,   // 至少成功喂过一次
    buf: [],          // 待喂的 PCM 字节块
    bufSamples: 0,
    feeding: false,
    feedStartedAt: 0, // 本次喂流开始时间（卡死看门狗用）
    lastAudioAt: 0,   // 最后一次收到音频的时间（performance.now）
    openedAt: 0,      // 本条流打开的时间
    lastVoiceAt: 0,   // ★ 最后一次「听见人说话」的时间（静音计时从这里算）
    voicedMs: 0,      // 本条流累计有声时长
    hadSpeech: false, // 本条流里有没有说过话（决定空结果要不要提示重说）
    failures: 0,
    retryAt: 0        // 连续失败后，下一次允许重试的时间（服务重启后能自己接回来）
  },
  // 回调（由 index.js 注入，必须通过 setter）
  onUtterance: null,  // 退回模式：整句 PCM
  onPartial: null,    // 流式：部分文字实时回调
  onText: null,       // 流式：最终整句文字
  onLevel: null,
  onState: null
};

function probe() {
  try {
    const a = input.getVoiceInputAvailability("audio");
    return { supported: !!a.supported, declared: !!a.declared, canRequest: !!a.canRequest, ready: !!a.ready, reason: a.reason };
  } catch (error) {
    return { supported: false, error: String((error && error.message) || error) };
  }
}

function setState(s, reason) {
  if (st.state !== s) {
    st.state = s;
    st.reason = reason || "none";
    flog("COOK_MIC state=" + s + " reason=" + st.reason);
    if (st.onState) { try { st.onState(st.state, st.reason); } catch (e) { flog("COOK_MIC onState " + e); } }
  }
}

/** 申请一次采集会话（用户确认权限后开始推流）。 */
function request() {
  if (st.session) return false;
  try {
    st.session = input.requestVoiceInput({ mode: "audio" });
    setState("pending", "none");
    resetVad();
    return true;
  } catch (error) {
    st.lastError = (error && error.code) || String((error && error.message) || error);
    flog("COOK_MIC request failed: " + st.lastError);
    setState("idle", st.lastError);
    return false;
  }
}

function resetVad() { st.chunks = []; st.voicedMs = 0; st.trailingMs = 0; }

/** 把缓冲的 PCM 帧拼成完整的 Int16Array（批量模式 / 整句精识别共用）。 */
function buildPcm(list) {
  const frames = list || st.chunks;
  let total = 0;
  for (const c of frames) total += Math.floor(c.byteLength / 2);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const c of frames) {
    const part = new Int16Array(c.buffer, c.byteOffset, Math.floor(c.byteLength / 2));
    pcm.set(part, off);
    off += part.length;
  }
  return pcm;
}

/** 拼接若干 Uint8Array（流式喂给服务用）。 */
function concatBytes(list) {
  let total = 0;
  for (const b of list) total += b.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.byteLength; }
  return out;
}

// ---------------------------------------------------------------------------
// 流式识别
// ---------------------------------------------------------------------------

function streamEnsureOpen() {
  const s = st.stream;
  if (s.id || s.opening) return;
  // 连续失败后不是永久放弃：5 秒后再试一次（服务可能刚被拉起来，没必要重启应用）
  if (s.failures >= 3 && (st.lastNow || 0) < (s.retryAt || 0)) return;
  s.opening = true;
  asr.streamOpen(P.vocab)
    .then((id) => {
      s.id = id;
      s.opening = false;
      s.healthy = true;
      s.failures = 0;
      // 新的一条流：静音计时、有声统计全部归零重来
      s.openedAt = st.lastNow || 0;
      s.lastVoiceAt = s.openedAt;
      s.voicedMs = 0;
      s.hadSpeech = false;
      flog("COOK_STREAM opened " + id);
    })
    .catch((error) => {
      s.opening = false;
      s.failures++;
      s.retryAt = (st.lastNow || 0) + 5000;
      flog("COOK_STREAM open failed (" + s.failures + "): " + ((error && error.message) || error));
    });
}

function streamFlush() {
  const s = st.stream;
  if (!s.id || s.feeding || s.bufSamples < P.feedEveryMs * 16) return; // 16样本=1ms
  const data = concatBytes(s.buf);
  s.buf = [];
  s.bufSamples = 0;
  s.feeding = true;
  s.feedStartedAt = st.lastNow;
  asr.streamFeed(s.id, data)
    .then((partial) => {
      s.feeding = false;
      s.healthy = true;
      s.failures = 0;
      // 识别出了新内容 = 刚才确实有人在说话 → 静音计时重新开始
      // （只靠音量判断会漏掉说话比较轻的情况，这里用文字变化兜底）
      if (partial && partial !== s.partial) {
        s.lastVoiceAt = st.lastNow;
        s.hadSpeech = true;
      }
      s.partial = partial;
      if (st.onPartial) { try { st.onPartial(partial); } catch (e) { /* 界面回调别影响主流程 */ } }
    })
    .catch((error) => {
      s.feeding = false;
      s.failures++;
      flog("COOK_STREAM feed failed (" + s.failures + "): " + ((error && error.message) || error));
      if (s.failures >= 3) {
        // 流式彻底不可用 → 关流，退回批量模式
        flog("COOK_STREAM giving up, fallback to batch mode");
        s.id = null;
        s.healthy = false;
        s.partial = "";
        if (st.onPartial) { try { st.onPartial(""); } catch (e) { /* 忽略 */ } }
      }
    });
}

/** 多久没声音算「这句说完了」：按已识别的字数自适应。
 *  短口令（下一步 / 可乐鸡翅）1 秒左右就出句；长句子最多等到 maxIdleMs。
 *  这样既有反应速度，又不会把说到一半的长句切断。 */
/** 识别结果会把同一句重复堆一遍（"可乐鸡翅可乐鸡翅"），去掉这种重复后再数字数 */
function effectiveLen(text) {
  const t = String(text || "");
  const half = t.length / 2;
  if (Number.isInteger(half) && half > 0 && t.slice(0, half) === t.slice(half)) return half;
  return t.length;
}

function idleThreshold(s) {
  // 字数按 12 封顶，免得因为字多白白多等一秒
  const len = Math.min(effectiveLen(s.partial), 12);
  return Math.min(P.maxIdleMs, Math.max(P.minIdleMs, 900 + len * 120));
}

function streamFinalize(now, force, why) {
  const s = st.stream;
  if (!s.id || s.feeding || s.opening) return;
  const base = s.lastVoiceAt || s.openedAt || now;
  const idle = now - base;
  const need = idleThreshold(s);
  if (!force) {
    // 一句都没听见 → 流保持打开，别反复开关（省掉一次开流延迟）
    if (!s.hadSpeech) return;
    if (idle < need) return;
  }
  const hadSpeech = s.hadSpeech;
  // 这句话的音频（用来重新精识别一次：整句喂给识别器比流式拼接准得多）
  const pcm = st.sentChunks.length ? buildPcm(st.sentChunks) : null;
  st.sentChunks = [];
  const pcmMs = pcm ? Math.round(pcm.length / 16) : 0;   // 16kHz 单声道：1ms = 16 个采样
  flog("COOK_STREAM closing " + (why || (force ? "force" : Math.round(idle) + "ms idle"))
    + " | need=" + need + "ms speech=" + s.voicedMs + "ms audio=" + pcmMs + "ms");
  const id = s.id;
  s.id = null;
  s.partial = "";
  s.buf = [];
  s.bufSamples = 0;
  s.voicedMs = 0;
  s.hadSpeech = false;
  if (st.onPartial) { try { st.onPartial(""); } catch (e) { /* 忽略 */ } }

  // 两路并行：①关掉流式会话拿到粗略结果 ②整句音频重新识别一遍拿精结果
  const closeP = asr.streamClose(id).catch((error) => {
    flog("COOK_STREAM close failed: " + ((error && error.message) || error));
    return null;
  });
  const batchP = (pcm && pcm.length >= 2400)
    ? Promise.resolve(asr.transcribe(pcm, 16000, P.vocab)).catch(() => null)
    : Promise.resolve(null);
  // ★ 云端精识别最慢，不能让它拖住整句响应：最多等 2.6 秒，超时先用本地流式结果顶上。
  //   （云端若之后才回来，这一句已经执行过了，不再重复触发，避免"一句话做两步"。）
  let batchTimedOut = false;
  const cappedP = Promise.race([
    batchP,
    new Promise((resolve) => setTimeout(() => { batchTimedOut = true; resolve(null); }, 3200)),
  ]);

  Promise.all([closeP, cappedP]).then(([streamText, batchText]) => {
    // 优先用整句精识别的结果；它没结果时才退回流式的
    // ★ 两路结果都要过「有没有意义」的筛子：Vosk 没听清会给 "Okay." / "."，
    //   以前这种会被当成"听清了"，界面就显示「听到「.」· 没对上」。
    const clean = (v) => (typeof asr.validText === "function" ? asr.validText(v) : (v || ""));
    const text = clean(batchText) || clean(streamText) || "";
    if (batchTimedOut) flog("COOK_STREAM batch timeout " + 3200 + "ms → 用流式结果");
    flog("COOK_STREAM final " + JSON.stringify(text)
      + " | batch=" + JSON.stringify(batchText) + " stream=" + JSON.stringify(streamText));
    // ★ 回调没注入的话，识别结果会全部丢掉（界面上就是「能识别但不执行、也没字」）
    if (!st.onText) { flog("COOK_STREAM no-onText handler, dropped " + JSON.stringify(text)); return; }
    if (text) {
      try { st.onText(text); } catch (error) { flog("COOK_STREAM onText " + error); }
    } else if (hadSpeech) {
      // 说了话但一个字都没认出来 → 让界面上「再说一遍」
      try { st.onText(""); } catch (error) { flog("COOK_STREAM onText " + error); }
    }
  });
}

// ---------------------------------------------------------------------------
// 音频处理
// ---------------------------------------------------------------------------

/** 处理一帧 PCM：算音量 + 缓存 + 喂流。 */
function handleAudio(bytes, now) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; sum += v * v; }
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768;
  st.level = rms;
  if (st.onLevel) { try { st.onLevel(rms); } catch (e) { /* 忽略 */ } }

  if (st.state !== "recording") return; // pending 阶段的帧不进缓存

  // 1) 全量缓存（流式喂送 + 批量退回共用）
  const copy = new Uint8Array(bytes);
  st.chunks.push(copy);
  const voiced = rms >= P.hiLevel;
  if (voiced) { st.voicedMs += 20; st.trailingMs = 0; }
  else { st.trailingMs += 20; }

  // 2) 说话检测 + 流式：攒够 200ms 喂一次
  //    ★ 平台会一直录下去不主动收尾，所以「这句说完了」只能靠这里判断：
  //      有声音就把 lastVoiceAt 刷新，安静够 idleThreshold() 才算说完
  if (rms >= P.vadLevel) {
    st.stream.lastVoiceAt = now;
    st.stream.voicedMs += 20;
    st.stream.hadSpeech = true;
  }
  st.stream.buf.push(copy);
  st.stream.bufSamples += samples.length;
  st.stream.lastAudioAt = now;
  st.sentChunks.push(copy);   // 这句话的原始音频，收尾时再整体精识别一遍

  // 3) 批量退回模式的自家 VAD（流式健康时不走这条路）
  if (!st.stream.healthy) {
    if (st.voicedMs >= P.minSpeechMs && st.trailingMs >= P.silenceMs) emitUtterance();
    else if (st.chunks.length >= P.maxUtterMs / 20) emitUtterance();
  }
}

/** 批量模式：一句话结束，把缓冲 PCM 交给回调。 */
function emitUtterance() {
  if (!st.chunks.length) { resetVad(); return; }
  const pcm = buildPcm();
  resetVad();
  if (pcm.length < 2400) return;            // <150ms 当噪音丢掉
  if (!st.onUtterance) return;
  flog("COOK_MIC utterance(batch) " + pcm.length + " samples (" + Math.round(pcm.length / 16) + "ms)");
  try {
    if (st.session) { try { st.session.finish(); } catch (e) { /* 忽略 */ } }
    st.onUtterance(pcm);
  } catch (error) {
    flog("COOK_MIC onUtterance " + error);
  }
}

/** 每帧调用（rAF 循环里）。now = performance.now()。 */
function poll(now) {
  st.lastNow = now;
  const session = st.session;
  // 消费事件（每帧限量，防阻塞）
  if (session) {
    for (let i = 0; i < 16; i++) {
      let ev = null;
      try { ev = session.takeEvent(); } catch (error) {
        st.lastError = String((error && error.message) || error);
        break;
      }
      if (!ev) break;
      if (ev.type === "state") {
        setState(ev.state, ev.reason);
      } else if (ev.type === "audio") {
        handleAudio(ev.data, now);
      } else if (ev.type === "end") {
        flog("COOK_MIC end " + ev.status + " " + ev.reason
          + " | streamHealthy=" + st.stream.healthy + " chunks=" + st.chunks.length);
        st.session = null;
        if (st.stream.healthy) {
          setState("idle", ev.reason);
          // 用户在语音界面上点了「终止」按钮 → status=cancelled → 立刻收尾执行；
          // 平台自己中途切刀是 completed，不在这收尾（等静音够 idleThreshold 再说整句）
          if (ev.status && ev.status !== "completed") streamFinalize(st.lastNow, true);
        } else {
          // 批量退回：整段缓冲交出去
          const pcm = st.chunks.length ? buildPcm() : null;
          resetVad();
          setState("idle", ev.reason);
          if (pcm && pcm.length >= 2400 && ev.status === "completed" && st.onUtterance) {
            flog("COOK_MIC utterance(platform-end) " + pcm.length + " samples");
            try { st.onUtterance(pcm); } catch (error) { flog("COOK_MIC onUtterance " + error); }
          }
        }
        break;
      }
    }
  }
  // 流式驱动：开流 → 喂流 → 静音收尾
  // ★ 失败 3 次不再永久关死：到 retryAt 会再试一次，服务重启后 5 秒内自动接回
  if (st.stream.healthy || st.stream.failures < 3 || now >= (st.stream.retryAt || 0)) {
    // 看门狗：喂流请求卡住超 4 秒 → 强制解锁当失败（防止 feeding 永久卡死）
    if (st.stream.feeding && now - st.stream.feedStartedAt > 4000) {
      st.stream.feeding = false;
      st.stream.failures++;
      flog("COOK_STREAM feed watchdog triggered (stuck >4s)");
    }
    if (st.state === "recording" && !st.stream.id) streamEnsureOpen();
    if (st.stream.id) {
      streamFlush();
      // ★ 不再等平台结束会话：说话停止够久就自己收尾出整句
      //   （平台会一直录到 60 秒上限，等它等于永远不执行）
      streamFinalize(now);
    }
  }
  // 音量心跳：每 2 秒报告一次
  if (session && now - st.lastLevelLogAt > 2000) {
    st.lastLevelLogAt = now;
    flog("COOK_MIC heartbeat level=" + st.level.toFixed(4) + " state=" + st.state
      + " chunks=" + st.chunks.length + " partial=" + JSON.stringify(st.stream.partial));
  }
}

/** 应用进后台/销毁时调用。 */
function stop() {
  if (st.session) { try { st.session.cancel(); } catch (e) { /* 忽略 */ } }
  const s = st.stream;
  if (s.id) {
    const id = s.id;
    s.id = null;
    asr.streamClose(id).then((text) => {
      if (text && st.onText) { try { st.onText(text); } catch (e) { /* 忽略 */ } }
    }).catch(() => { /* 后台了，放弃 */ });
  }
  resetVad();
  st.sentChunks = [];
  setState("idle", "none");
}

function configure(overrides) {
  if (overrides && typeof overrides === "object") Object.assign(P, overrides);
}

module.exports = {
  probe, request, poll, stop, configure,
  log: flog,   // 让 index.js 也能把关键事件写进同一个日志文件（console.log 只到终端，抓不到）
  get state() { return st.state; },
  get level() { return st.level; },
  get lastError() { return st.lastError; },
  // ★ 回调必须走 setter 写进内部状态 st，直接赋值模块对象是无效的（血泪教训）
  //   getter 用来在启动时自检「回调到底注入成功了没有」
  get onText() { return st.onText; },
  get onPartial() { return st.onPartial; },
  set onUtterance(fn) { st.onUtterance = fn; },
  set onPartial(fn) { st.onPartial = fn; },
  set onText(fn) { st.onText = fn; },
  set onLevel(fn) { st.onLevel = fn; },
  set onState(fn) { st.onState = fn; }
};
