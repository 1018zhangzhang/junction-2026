"use strict";
/* 启动崩溃复现器：不依赖模拟器，用桩件替掉平台 API，
   把 index.js 的 ON_CREATE → start() → paintSession() → 若干帧 tick 完整跑一遍。
   用法：node tools/mock-boot.js
   src/index.js 被原样拷贝执行，报错行号与 src 完全一致。 */
const fs = require("node:fs");
const path = require("node:path");
const osPath = require("node:os");

const SRC = path.join(__dirname, "..", "src");
const tmp = fs.mkdtempSync(path.join(osPath.tmpdir(), "cookmock-"));

// 1) 拷贝真实业务模块（voice/asr 用桩替代，避免碰麦克风和网络）
//    ★ 自动发现，别再手写清单：新增一个模块忘了加进来，冒出来的是
//      "Cannot find module" 这种和真实 bug 完全无关的崩溃（agent.js 就撞过一次）
const STUBBED = new Set(["voice.js", "asr.js"]);
const REAL = fs.readdirSync(SRC).filter((f) => f.endsWith(".js") && !STUBBED.has(f));
for (const f of REAL) fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));

fs.writeFileSync(path.join(tmp, "voice.js"), `
"use strict";
const state = { probe: () => ({ ok: true, mode: "mock" }), configure: (o) => {
    const v = (o && o.vocab) ? o.vocab : [];
    console.log("[mock voice.configure] vocab=" + v.length + " 第一词=" + JSON.stringify(v[0]));
  },
  request: () => true, stop: () => {}, poll: () => {},
  state: "idle", level: 0, lastError: null,
  onPartial: null, onText: null, onUtterance: null,
  log: (m) => console.log("[cooklog] " + m) };
module.exports = state;
`);
fs.writeFileSync(path.join(tmp, "asr.js"), `
"use strict";
module.exports = { remoteReady: true,
  ping: () => Promise.resolve(true),
  transcribe: () => Promise.resolve("") };
`);

// 2) 平台 API 桩
const nm = path.join(tmp, "node_modules", "@irisview", "osx");
fs.mkdirSync(path.join(nm, "os"), { recursive: true });
fs.writeFileSync(path.join(nm, "package.json"),
  JSON.stringify({ name: "@irisview/osx", version: "0.0.0-mock" }));

let rafCb = null, rafId = 0;
fs.writeFileSync(path.join(nm, "os.js"), `
"use strict";
function anyObj(name) {
  const f = function () {};
  return new Proxy(f, { get: () => anyObj(name + "."), apply: () => anyObj(name + "()") });
}
globalThis.__logs = [];
{
  const __log = console.log.bind(console);
  console.log = (...a) => { try { globalThis.__logs.push(a.join(" ")); } catch (e) {} __log(...a); };
}

const os = {
  WindowProperty: { create: () => anyObj("WindowProperty") },
  Window: { create: () => anyObj("Window") },
  App: { createApp: (cb) => { globalThis.__lifecycle = cb; } },
  AppLifecycle: { ON_CREATE: "ON_CREATE", ON_FOREGROUND: "ON_FOREGROUND",
    ON_REOPEN: "ON_REOPEN", ON_BACKGROUND: "ON_BACKGROUND", ON_DESTROY: "ON_DESTROY" },
  requestAnimationFrame: (cb) => { globalThis.__raf = cb; return 1; },
  cancelAnimationFrame: () => { globalThis.__raf = null; },
};
module.exports = os;
`);
fs.writeFileSync(path.join(nm, "os", "input.js"), `
"use strict";
module.exports = { takeTextInput: () => {} };
`);
fs.writeFileSync(path.join(nm, "fusionui.js"), `
"use strict";
function rec(name) {
  // 万能控件桩：任何方法都能调，调用本身打印一行（可定位"哪句平台调用炸了"）
  const f = function (...a) {
    if (!rec.quiet) console.log("    [ui] " + name + "()");
    return rec(name + ".<ret>");
  };
  return new Proxy(f, { get: (t, k) => {
    if (k === Symbol.toPrimitive) return () => name;
    return rec(name + "." + String(k));
  }, apply: (t, self, a) => rec(name + "()") });
}
// ★ 严格桩：枚举/参数按真机校验，传 undefined 就抛（真机报 FacadeTypeMismatch）。
//   目的：让"把不存在的枚举成员传给平台"这类只在真机炸的错，在本地就跑不出来但能测出来。
//   TextAlign 是真机的九宫格枚举，注意没有 LEFT —— 曾经写成 ui.TextAlign.LEFT 导致真机动画全黑。
const TextAlignConst = {
  AUTO: 0, TOP_LEFT: 1, TOP_MID: 4, TOP_RIGHT: 3,
  LEFT_MID: 5, CENTER: 2, RIGHT_MID: 6,
  BOTTOM_LEFT: 7, BOTTOM_MID: 8, BOTTOM_RIGHT: 9,
};
function makeStyle() {
  let align = TextAlignConst.CENTER, font = null, color = null;
  return {
    setTextAlign(a) {
      if (typeof a !== "number") throw new Error("FacadeTypeMismatch: setTextAlign(" + String(a) + ")");
      align = a;
    },
    getTextAlign() { return align; },
    setTextFont(f) {
      if (!f || typeof f !== "object") throw new Error("FacadeTypeMismatch: setTextFont(" + String(f) + ")");
      font = f;
      if (globalThis.__fontSizes) globalThis.__fontSizes.push(f.size);
    },
    getTextFont() { return font; },
    setTextColor(c) { color = c; },
    getTextColor() { return color; },
    setBackgroundColor() {},
  };
}
const widget = () => ({
  setParent: () => {}, setIgnoreLayout: () => {},
  setPosition: (p) => {
    if (!Array.isArray(p) || p.length !== 3) throw new Error("FacadeTypeMismatch: setPosition");
    if (globalThis.__posY) globalThis.__posY.push(p[1]);
  },
  setSize: (s) => { if (!Array.isArray(s) || s.length !== 3) throw new Error("FacadeTypeMismatch: setSize"); },
  getLocalStyle: makeStyle,
  setText: (t) => { if (typeof t !== "string") throw new Error("FacadeTypeMismatch: setText"); },
});
module.exports = {
  FusionRoot: {
    acquireFusionRootFromWindow: () => ({
      getRootWidget: () => widget(),
      // 严格校验：动画帧必须主动提交呈现，否则真机上看不到过程（v44 教训）
      requestPresentation: () => { globalThis.__presN = (globalThis.__presN || 0) + 1; return { getState: () => "Presented", isAccepted: () => true }; },
    }),
  },
  Board: { create: widget },
  Text: { create: widget },
  Font: {
    getCachedFont: (path, size, bold, italic) => {
      if (typeof path !== "string") throw new Error("FacadeTypeMismatch: getCachedFont.path");
      if (typeof size !== "number" || !isFinite(size) || size <= 0) throw new Error("FacadeTypeMismatch: getCachedFont.fontSize=" + String(size));
      if (typeof bold !== "number" || typeof italic !== "number") throw new Error("FacadeTypeMismatch: getCachedFont.bold/italic");
      return { size, bold, italic };
    },
  },
  Color: { fromRGB8: (r, g, b) => ({ r, g, b }) },
  TextAlign: TextAlignConst,
};
`);

// 3) 跑起来
// ★ 必须先于 require(index.js)：把 perf_hooks.performance 换成可控时钟，否则动画永远判 0ms
try {
  const perfHooks = require("node:perf_hooks");
  const realPerf = perfHooks.performance;
  // ★ 只拦截 now()，其余成员（markResourceTiming 等，含原型链上的）原样转发给真对象 ——
  //   否则 Node 自带的 fetch(undici) 收响应时会调 performance.markResourceTiming 直接崩。
  const fakePerf = new Proxy(realPerf, {
    get(target, prop) {
      if (prop === "now") return () => fakeT;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  Object.defineProperty(perfHooks, "performance", {
    value: fakePerf, configurable: true, writable: true,
  });
} catch (e) { console.log("[mock clock] 覆盖失败: " + e.message); }
process.env.FUSIONUI_APP_DATA_DIR = tmp;
process.chdir(tmp);
let mod;
try {
  mod = require(path.join(tmp, "index.js"));
} catch (e) {
  console.log("\n[崩溃·模块加载期] " + e.stack);
  process.exit(1);
}

// 可控时钟：真机代码全靠 performance.now() 判断动画进度，桩里必须能快进。
// ★ index.js 用的是 require("node:perf_hooks").performance 的局部绑定，
//   改 globalThis.performance 没用，必须直接换掉 perf_hooks 模块上的对象。
let fakeT = 1000;

// ★ 桩 setInterval/clearInterval：v41 起选菜动画用 33ms 自驱动定时器，
//   快进帧时必须一并触发，否则测试测不到真实驱动路径
const __timers = new Map();
let __tid = 0;
globalThis.setInterval = (fn, ms) => {
  const id = ++__tid;
  __timers.set(id, { fn, ms, next: fakeT + ms });
  return id;
};
globalThis.clearInterval = (id) => { __timers.delete(id); };
function pumpTimers() {
  for (const t of [...__timers.values()]) {
    while (t.next <= fakeT) {
      t.next += t.ms;
      try { t.fn(); }
      catch (e) { console.log("[timer 崩] " + (e && e.message)); }
    }
  }
}

function frames(n) {
  for (let i = 0; i < n; i++) {
    fakeT += 33;
    pumpTimers();                     // 定时器先于帧回调（模拟真实节拍）
    const cb = globalThis.__raf;
    globalThis.__raf = null;
    if (!cb) return;
    cb(fakeT);
  }
}

console.log("\n== ON_CREATE ==");
try { globalThis.__lifecycle("ON_CREATE"); }
catch (e) { console.log("\n[崩溃·ON_CREATE] " + e.stack); process.exit(1); }

console.log("\n== ON_FOREGROUND + 30 帧 ==");
try {
  globalThis.__lifecycle("ON_FOREGROUND");
  recQuietToggle();
  frames(30);
  console.log("\n[通过] start + 30 帧全跑完，没炸。");
} catch (e) { console.log("\n[崩溃·主循环] " + e.stack); process.exit(1); }

// ---- 选菜动画：说「三号」后必须逐帧放大，而不是直接跳进做菜页 ----
console.log("\n== 选菜动画（说「三号」）==");
try {
  const voiceStub = require(path.join(tmp, "voice.js"));
  globalThis.__fontSizes = [];
  globalThis.__posY = [];
  // 读出源码里的动画开关：900 = 播动画，0 = 只高亮不提放大（降级模式）
  const srcTxt = require("fs").readFileSync(path.join(tmp, "index.js"), "utf8");
  const animMs = Number((srcTxt.match(/const PICK_ANIM_MS = (\d+)/) || [0, 900])[1]);
  globalThis.__presN = 0;
  voiceStub.onText("三号");
  frames(1);
  const during = globalThis.__fontSizes.slice();
  frames(30);                       // 跨过 900ms
  const sizes = globalThis.__fontSizes.filter((s) => s > 19 && s < 40);
  const uniq = [...new Set(sizes)].sort((a, b) => a - b);
  console.log("  PICK_ANIM_MS = " + animMs + (animMs > 0 ? "（播动画）" : "（降级：只换颜色）"));
  console.log("  动画期间设置过的字号: " + JSON.stringify(uniq));
  console.log("  第一帧后字号调用数: " + during.length);
  console.log("  位置 y 序列（去重前 12 个）: " + JSON.stringify(globalThis.__posY.slice(0, 12)));
  const entered = globalThis.__logs.some((l) => l.indexOf("COOK_PAINT mode=cooking") >= 0);
  if (animMs === 0) {
    // 降级模式：不该有任何字号变化，但必须照样进做菜页
    if (uniq.length !== 0) {
      console.log("\n[失败] 关掉动画后不该再有字号变化，却出现了 " + JSON.stringify(uniq));
      process.exit(1);
    }
    if (!entered) {
      console.log("\n[失败] 降级模式没有进入做菜页");
      process.exit(1);
    }
    console.log("\n[通过] 降级模式：不播动画、只把选中的菜换高亮色，停留后进入做菜页。");
  } else {
    // 动画模式：必须逐帧放大到接近 31px，且不得提前跳页
    if (uniq.length < 3) {
      console.log("\n[失败] 字号没有逐帧变化（动画帧没画出来）—— 真机上就是「点了直接跳转」");
      process.exit(1);
    }
    if (Math.max(...uniq) < 28) {
      console.log("\n[失败] 选中行没有放大到接近 31px，最大只到 " + Math.max(...uniq));
      process.exit(1);
    }
    if ((globalThis.__presN || 0) < 3) {
      console.log("\n[失败] 动画期间 requestPresentation 只调了 " + (globalThis.__presN || 0)
        + " 次 —— 真机上帧改了也不上屏，看起来还是瞬跳");
      process.exit(1);
    }
    console.log("\n[通过] 选菜动画逐帧放大到 " + Math.max(...uniq) + "px，提交呈现 "
      + (globalThis.__presN || 0) + " 次，未直接跳转。");
  }
} catch (e) { console.log("\n[崩溃·选菜动画] " + e.stack); process.exit(1); }

/* ---- 可选：大模型现场生成菜谱（COOK_MOCK_LLM=1 时运行）----
   真联网、真 fetch，但对面是本地假服务 —— 验证「说不认识的菜 → 生成 → 自动进做菜页」
   这整条链路，且验证没配置时一个请求都不发。 */
if (process.env.COOK_MOCK_LLM === "1") {
  (async () => {
    const http = require("node:http");
    let hits = 0;
    const dish = {
      title: "酸辣土豆丝",
      steps: [
        { ask: "土豆切细丝，清水冲掉淀粉", detail: "冲两遍水更脆", phase: "prep", timeMs: 300000 },
        { ask: "热锅下干辣椒和花椒爆香", phase: "cook", timeMs: 0 },
        { ask: "下土豆丝大火快炒，沿锅边淋醋", phase: "cook", timeMs: 120000 },
        { ask: "加盐出锅，撒葱花", phase: "finish", timeMs: 0 }
      ]
    };
    const server = http.createServer((req, res) => {
      hits += 1;
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        // 带 response_format = 要 JSON 菜谱；不带 = 灶台边随口问答，只回一句话
        let isJson = false;
        try { isJson = Boolean(JSON.parse(body).response_format); } catch (e) { /* 忽略 */ }
        // 请求里点了别的菜名时，返回同名菜谱（用来测"连续生成两道临时菜"）
        let payload = dish;
        if (isJson) {
          const m = body.match(/番茄牛腩/);
          if (m) payload = Object.assign({}, dish, { title: "番茄牛腩" });
        }
        const content = isJson ? JSON.stringify(payload) : "先关小火，把锅端离灶台十几秒";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";

    console.log("\n== 大模型现场生成菜谱 ==");
    const voiceStub = require(path.join(tmp, "voice.js"));

    // ① 先证明「没配 llm.json 时不联网」：此刻 tmp 里还没有 llm.json
    const before = hits;
    voiceStub.onText("换菜");
    frames(2);
    voiceStub.onText("想吃酸辣土豆丝");
    await new Promise((r) => setTimeout(r, 150));
    frames(2);
    if (hits !== before) {
      console.log("[失败] 没配置密钥却发出了网络请求（" + hits + " 次）");
      process.exit(1);
    }
    console.log("  ok   没配置 → 零请求（离线兜底提示）");

    // ② 放上配置，同一句话应该打通生成链路
    require("fs").writeFileSync(path.join(tmp, "llm.json"),
      JSON.stringify({ endpoint: url, model: "mock-model", apiKey: "sk-mock-0000000000000000", timeoutMs: 3000 }));
    const logsBefore = globalThis.__logs.length;
    voiceStub.onText("我想吃酸辣土豆丝");   // 换一句，避开「同句重复去重」
    await new Promise((r) => setTimeout(r, 400));
    // 桩件的帧链有时会在动画中途断掉（rAF 没续上），这里一直补帧直到进做菜页
    for (let i = 0; i < 40; i++) {
      frames(3);
      if (globalThis.__logs.slice(logsBefore).some((l) => l.indexOf("COOK_PAINT mode=cooking") >= 0)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const logs = globalThis.__logs.slice(logsBefore);
    const okLog = logs.find((l) => l.indexOf("COOK_LLM ok") >= 0);
    const cookLog = logs.find((l) => l.indexOf("COOK_PAINT mode=cooking") >= 0);
    if (hits <= before) {
      console.log("[失败] 配了密钥却没发请求");
      process.exit(1);
    }
    if (!okLog) {
      console.log("[失败] 模型返回的菜没能生成（日志里没有 COOK_LLM ok）");
      process.exit(1);
    }
    if (!cookLog || cookLog.indexOf("土豆丝") < 0) {
      console.log("  [调试] 最近日志：\n   " + logs.slice(-8).join("\n   "));
      console.log("[失败] 生成后没有自动进入这道菜的做菜页：" + (cookLog || "(无做菜页日志)"));
      process.exit(1);
    }
    if (globalThis.__logs.some((l) => l.indexOf("sk-mock-0000000000000000") >= 0)) {
      console.log("[失败] 日志里出现了完整密钥");
      process.exit(1);
    }
    console.log("  ok   " + okLog.replace("[cooklog] ", ""));
    console.log("  ok   自动进入做菜页：" + cookLog.replace("[cooklog] COOK_PAINT ", "").slice(0, 60) + "…");
    console.log("\n[通过] 不认识的菜 → 联网生成 → 自动开做；没配置则零请求。");
    await dialogTest(true);          // 顺手在同一份状态下验对话行（复用这个假服务）
    await wrapTest(true);            // 再做完了 → 库外菜应问「要不要存进菜单」
    await noSaveTest();              // ★ 说了「算了」必须真的撤掉，且不顶掉别的菜
    server.close();
  })().catch((e) => { console.log("\n[崩溃·大模型链路] " + e.stack); process.exit(1); });
}

function recQuietToggle() { /* 预留：需要静音桩日志时在这里关 */ }

/* ─────────── 对话行端到端（本版核心，线上线下都跑）───────────
   要证明三件事：
     ① 说「太咸了」→ 下面必须出现一句具体做法（以前答案只闪一帧，等于没反应）
     ② 出现答案的同时，「正在做的那一步」不能变（用户要求主界面不动）
     ③ 下一步 → 对话行让位，恢复正常步骤显示
   另外证明「说另一道菜」不再默默不动。 */
function pfield(line, key) {
  const m = String(line || "").match(new RegExp(" " + key + "=(\"(?:[^\"\\\\]|\\\\.)*\")"));
  if (!m) return "";
  try { return JSON.parse(m[1]); } catch (e) { return ""; }
}
function lastPaint(after) {
  const arr = globalThis.__logs.slice(after || 0).filter((l) => l.indexOf("COOK_PAINT mode=") >= 0);
  return arr.length ? arr[arr.length - 1] : "";
}

async function dialogTest(withLlm) {
  const voiceStub = require(path.join(tmp, "voice.js"));
  console.log("\n== 对话行（" + (withLlm ? "接大模型" : "纯离线") + "）==");

  // 先让画面出一次 paint 日志，作为"主步骤基线"
  const base = globalThis.__logs.length;
  frames(70);
  const baseMain = pfield(lastPaint(base), "main");
  if (!baseMain) {
    console.log("[失败] 拿不到当前步骤基线（做菜页没有 main）");
    process.exit(1);
  }

  // ① 说「太咸了」→ 救场答案必须出现在下面那行
  const t0 = globalThis.__logs.length;
  voiceStub.onText("太咸了");
  frames(3);
  const rescueLog = globalThis.__logs.slice(t0).find((l) => l.indexOf("COOK_REPLY rescue") >= 0);
  if (!rescueLog) {
    console.log("  [调试] " + globalThis.__logs.slice(t0).slice(-6).join("\n   "));
    console.log("[失败] 说了「太咸了」但在下面没出任何答案（COOK_REPLY rescue 没出现）");
    process.exit(1);
  }
  console.log("  ok   " + rescueLog.replace("[cooklog] ", ""));

  // ② 答案要"留得住"：跨 2 秒以上还得在，而且主步骤一个字没变
  frames(80);
  const p1 = lastPaint(t0);
  const sub1 = pfield(p1, "sub");
  const main1 = pfield(p1, "main");
  if (sub1.indexOf("半勺糖") < 0 && sub1.indexOf("糖") < 0) {
    console.log("[失败] 答案只闪了一下就没了（2 秒后 sub=" + JSON.stringify(sub1) + "）");
    process.exit(1);
  }
  if (main1 !== baseMain) {
    console.log("[失败] 出答案时把主步骤改掉了：\n   原来=" + JSON.stringify(baseMain) + "\n   现在=" + JSON.stringify(main1));
    process.exit(1);
  }
  console.log("  ok   2 秒后答案仍在：" + JSON.stringify(sub1.slice(0, 30)));
  console.log("  ok   主步骤没变：" + JSON.stringify(main1.slice(0, 24)));

  // ②.5 说完的那句话不能被本地小库的"空草稿 / 碎片"冲掉
  //      真机日志实证：COOK_STREAM final 之后紧跟 partial=""，一次就把 🗣 冲成空白，
  //      屏幕上看就是"有正在听、没有我说的句子"。
  voiceStub.onPartial("");
  voiceStub.onPartial("太咸");
  frames(6);
  const saidAfter = pfield(lastPaint(t0), "partial");
  if (saidAfter.indexOf("🗣") < 0) {
    console.log("[失败] 「我说的那句话」被草稿冲掉了：partial=" + JSON.stringify(saidAfter));
    process.exit(1);
  }
  console.log("  ok   空草稿/碎片没冲掉「我说的那句话」：" + JSON.stringify(saidAfter.slice(0, 20)));

  // ②.6 8 秒后那句自己收走（不能一直占着），但下面的答案还在（10 分钟）
  frames(250);   // 33ms/帧 ≈ 8.2 秒
  const afterExpire = lastPaint(t0);
  const saidGone = pfield(afterExpire, "partial");
  const subStill = pfield(afterExpire, "sub");
  if (saidGone.indexOf("🗣") >= 0) {
    console.log("[失败] 我说的话过了 8 秒还赖着：" + JSON.stringify(saidGone));
    process.exit(1);
  }
  if (subStill.indexOf("💬") < 0) {
    console.log("[失败] 8 秒后答案也被一起收走了：" + JSON.stringify(subStill));
    process.exit(1);
  }
  console.log("  ok   8 秒后「我说的」自动收走，答案仍在：" + JSON.stringify(subStill.slice(0, 22)));

  // ③ 说另一道菜 → 明确告诉怎么换，不再默默不动
  const t2 = globalThis.__logs.length;
  voiceStub.onText("麻婆豆腐");
  frames(3);
  const dishLog = globalThis.__logs.slice(t2).find((l) => l.indexOf("COOK_REPLY") >= 0);
  if (!dishLog || dishLog.indexOf("换菜") < 0) {
    console.log("[失败] 跟做中说另一道菜，界面没给出「怎么办」：" + (dishLog || "(无回答)"));
    process.exit(1);
  }
  console.log("  ok   " + dishLog.replace("[cooklog] ", ""));

  // ④ 接了大模型：模型那句话要顶上来（更贴这一锅），主步骤照样不动
  if (withLlm) {
    const t3 = globalThis.__logs.length;
    voiceStub.onText("这个能放牛肉吗");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      frames(2);
      if (globalThis.__logs.slice(t3).some((l) => l.indexOf("COOK_CHAT ok") >= 0)) break;
    }
    const chatLog = globalThis.__logs.slice(t3).find((l) => l.indexOf("COOK_CHAT ok") >= 0);
    if (!chatLog) {
      console.log("  [调试] " + globalThis.__logs.slice(t3).slice(-6).join("\n   "));
      console.log("[失败] 词表外的问题没有交给模型（COOK_CHAT ok 没出现）");
      process.exit(1);
    }
    frames(80);
    const p3 = lastPaint(t3);
    const sub3 = pfield(p3, "sub");
    if (sub3.indexOf("关小火") < 0) {
      console.log("[失败] 模型的回答没显示到下面那行（sub=" + JSON.stringify(sub3) + "）");
      process.exit(1);
    }
    if (pfield(p3, "main") !== baseMain) {
      console.log("[失败] 模型回答把主步骤顶掉了");
      process.exit(1);
    }
    console.log("  ok   " + chatLog.replace("[cooklog] ", ""));
    console.log("  ok   对话行已换成模型的话，主步骤仍然没变");
  }

  // ⑤ 「下一步」→ 对话行让位，恢复正常步骤
  const t4 = globalThis.__logs.length;
  voiceStub.onText("下一步");
  frames(80);
  const p4 = lastPaint(t4);
  const sub4 = pfield(p4, "sub");
  const main4 = pfield(p4, "main");
  if (main4 === baseMain) {
    console.log("[失败] 说「下一步」没推进");
    process.exit(1);
  }
  // ★ v56 起：答案要一直留到「下一次回答」，翻步骤不再撤掉（用户明确要求）
  if (sub4.indexOf("💬") < 0) {
    console.log("[失败] 进入下一步后答案被撤掉了（应保留到下一次回答）：" + JSON.stringify(sub4));
    process.exit(1);
  }
  console.log("  ok   下一步后主步骤推进 " + JSON.stringify(main4.slice(0, 16)) + "，答案仍留着");
  console.log("\n[通过] 说话有回答、答案留得住、主步骤不动、下一步自动收尾。");
}

/* ─────────── 收尾问答端到端（做完一道菜之后）───────────
   要证明：
     ① 说「完成了」→ 进入收尾流程（不是原地不动）
     ② 库外菜才问"要存进菜单吗"；内置菜直接问"还做下一道吗"
     ③ 说「要」→ 真的写进 custom-dishes.json
     ④ 说「不用」→ 出现收工总页
     ⑤ 说「再做一道」→ 回到菜单
   参数 expectSave：这道菜是不是 AI 现场生成（库外菜）。 */
async function wrapTest(expectSave) {
  const voiceStub = require(path.join(tmp, "voice.js"));
  console.log("\n== 收尾问答（" + (expectSave ? "库外菜 → 先问是否收藏" : "内置菜 → 不问收藏") + "）==");

  const fail = (msg) => { console.log("[失败] " + msg); process.exit(1); };

  const t0 = globalThis.__logs.length;
  voiceStub.onText("完成了");
  frames(70);                       // 跨过 2 秒，保证 COOK_PAINT 日志出来

  const startLog = globalThis.__logs.slice(t0).find((l) => l.indexOf("COOK_WRAP start") >= 0);
  if (!startLog) fail("说「完成了」没有进入收尾流程（COOK_WRAP start 没出现）");

  const canSave = startLog.indexOf("canSave=true") >= 0;
  if (canSave !== expectSave) {
    fail("收藏提问判断错了（期望 canSave=" + expectSave + "）：" + startLog.replace("[cooklog] ", ""));
  }

  const p1 = lastPaint(t0);
  if (p1.indexOf("mode=wrap") < 0) fail("收尾页没有上屏：" + p1);
  const main1 = pfield(p1, "main");
  if (expectSave && main1.indexOf("存进菜单") < 0) fail("没问「要不要存进菜单」：" + JSON.stringify(main1));
  if (!expectSave && main1.indexOf("下一道") < 0) fail("没问「要不要做下一道」：" + JSON.stringify(main1));
  console.log("  ok   " + startLog.replace("[cooklog] ", ""));
  console.log("  ok   收尾页：" + JSON.stringify(main1));

  if (expectSave) {
    const t1 = globalThis.__logs.length;
    // ★ v58e：第一问只认「明确要存」。「要」这类含糊词现在只回问一次，
    //   所以这里说「加进去」；含糊词的行为在 test-wrap.js 里单独测。
    voiceStub.onText("加进去");
    frames(70);
    const savedLog = globalThis.__logs.slice(t1).find((l) => l.indexOf("COOK_WRAP saved") >= 0);
    if (!savedLog) fail("说「加进去」没有把菜存进菜单（COOK_WRAP saved 没出现）");
    const file = path.join(tmp, "custom-dishes.json");
    if (!fs.existsSync(file)) fail("说「加进去」之后没有生成 " + file);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail("收藏文件不是合法 JSON"); }
    if (!saved || !Array.isArray(saved.dishes) || !saved.dishes.length) fail("收藏文件里没有菜");
    if (saved.dishes[0].title !== "酸辣土豆丝") fail("存进去的不是刚做的那道：" + saved.dishes[0].title);
    console.log("  ok   " + savedLog.replace("[cooklog] ", ""));
    console.log("  ok   已落盘：" + saved.dishes[0].title + " · " + saved.dishes[0].steps.length + " 步");

    const p2 = lastPaint(t1);
    if (pfield(p2, "main").indexOf("下一道") < 0) fail("收藏完没有接着问「还做下一道吗」");
    console.log("  ok   收藏后接着问下一道");
  }

  // 「不用」→ 收工总页
  const t2 = globalThis.__logs.length;
  voiceStub.onText("不用");
  frames(70);
  const sumLog = globalThis.__logs.slice(t2).find((l) => l.indexOf("COOK_WRAP summary") >= 0);
  if (!sumLog) fail("说「不用」没有出现收工页（COOK_WRAP summary 没出现）");
  const p3 = lastPaint(t2);
  if (p3.indexOf("mode=wrap") < 0) fail("收工页没有上屏");
  const main3 = pfield(p3, "main");
  if (main3.indexOf("收工") < 0) fail("收工页标题不对：" + JSON.stringify(main3));
  console.log("  ok   " + sumLog.replace("[cooklog] ", ""));
  console.log("  ok   收工页：" + JSON.stringify(main3));

  // 「再做一道」→ 回菜单
  const t3 = globalThis.__logs.length;
  voiceStub.onText("再做一道");
  frames(70);
  const p4 = lastPaint(t3);
  if (p4.indexOf("mode=menu") < 0) fail("说「再做一道」没有回到菜单：" + p4);
  console.log("  ok   回菜单：" + JSON.stringify(pfield(p4, "main")));

  // ★ v58e：菜多到超过一页时，说「下一页 / 上一页」必须真的翻
  const pagesNow = (globalThis.__logs.filter((l) => l.indexOf("COOK_MENU ") >= 0).slice(-1)[0] || "");
  if (pagesNow.indexOf("/") >= 0 && !/page=1\/1 /.test(pagesNow)) {
    const t4 = globalThis.__logs.length;
    voiceStub.onText("下一页");
    frames(20);
    const p5 = globalThis.__logs.slice(t4).filter((l) => l.indexOf("COOK_MENU ") >= 0).slice(-1)[0] || "";
    if (p5.indexOf("page=2/") < 0) fail("说「下一页」没翻页：" + (p5 || "(没有页码日志)"));
    const t5 = globalThis.__logs.length;
    voiceStub.onText("上一页");
    frames(20);
    const p6 = globalThis.__logs.slice(t5).filter((l) => l.indexOf("COOK_MENU ") >= 0).slice(-1)[0] || "";
    if (p6.indexOf("page=1/") < 0) fail("说「上一页」没翻回去：" + (p6 || "(没有页码日志)"));
    console.log("  ok   翻页：" + p5.replace("[cooklog] ", "") + " → " + p6.replace("[cooklog] ", ""));
  }
  console.log("\n[通过] 收尾问答：是否收藏 / 收工总页 / 再回菜单 / 翻页，全部走通。");
}

/* ─────────── 说了「算了」必须真的撤掉（v58e 修的两个 bug）───────────
   用户实测两件事：
     ① 收尾说「算了 / 不用」，菜还是留在菜单里，下次还能选中；
     ② 菜单满了 12 道，新生成的菜把内置菜（糖醋排骨）挤没了。
   这组用例就盯这两条：
     · 生成后 DISHES 必须变成 n+1（追加在末尾，index=n），不是替换掉第 12 格；
     · 说「算了」之后必须回到 n，并且收藏文件里不能多出这道菜。 */
async function noSaveTest() {
  const fail = (msg) => { console.log("[失败] " + msg); process.exit(1); };
  const voiceStub = require(path.join(tmp, "voice.js"));
  console.log("\n== 说「算了」→ 不能留在菜单；生成不能顶掉别的菜 ==");

  const menus = () => globalThis.__logs.filter((l) => l.indexOf("COOK_MENU ") >= 0);
  const beforeLog = menus().slice(-1)[0] || "";
  const m0 = beforeLog.match(/n=(\d+)/);
  if (!m0) fail("菜单没打过 COOK_MENU 日志，测不了菜数：" + beforeLog);
  const n0 = Number(m0[1]);

  // ① 生成一道新菜：必须"追加"（index=n0），不能顶掉任何一道
  const t0 = globalThis.__logs.length;
  voiceStub.onText("我想吃番茄牛腩");
  let okLog = null;
  for (let i = 0; i < 40; i++) {
    frames(3);
    okLog = globalThis.__logs.slice(t0).find((l) => l.indexOf("COOK_LLM ok") >= 0);
    if (okLog) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!okLog) fail("第二道菜没生成出来（COOK_LLM ok 没出现）");
  const idx = Number((okLog.match(/index=(\d+)/) || [0, -1])[1]);
  if (idx !== n0) {
    fail("生成的菜没追加到末尾（index=" + idx + "，菜单原本 " + n0 + " 道）—— 又去顶别人的位置了");
  }
  const afterGen = menus().slice(-1)[0] || "";
  const n1 = Number((afterGen.match(/n=(\d+)/) || [0, -1])[1]);
  if (n1 !== n0 + 1) fail("生成后菜数没变成 " + (n0 + 1) + "，实际 n=" + n1 + " —— 有菜被挤掉了");
  console.log("  ok   " + okLog.replace("[cooklog] ", "") + "（追加到末尾，没顶人）");
  console.log("  ok   " + afterGen.replace("[cooklog] ", ""));

  // ★ 等选菜动画走完（0.9 秒）再说话，否则「完成了」会落在菜单页被丢掉
  for (let i = 0; i < 40; i++) {
    frames(3);
    if (globalThis.__logs.slice(t0).some((l) => l.indexOf("COOK_PAINT mode=cooking") >= 0)) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  // ② 现在有 13 道菜（2 页）：回菜单，用「上一页 / 下一页」验真翻页
  voiceStub.onText("换菜");
  frames(20);
  const menusAfter = () => (globalThis.__logs.filter((l) => l.indexOf("COOK_MENU ") >= 0).slice(-1)[0] || "");
  if (menusAfter().indexOf("page=2/2") < 0) fail("13 道菜应该停在第 2 页：" + menusAfter());
  const tp = globalThis.__logs.length;
  voiceStub.onText("上一页");
  frames(20);
  const prevLog = menusAfter();
  if (prevLog.indexOf("page=1/2") < 0) fail("说「上一页」没翻回第 1 页：" + prevLog);
  const tp2 = globalThis.__logs.length;
  voiceStub.onText("下一页");
  frames(20);
  const nextLog = menusAfter();
  if (nextLog.indexOf("page=2/2") < 0) fail("说「下一页」没翻到第 2 页：" + nextLog);
  console.log("  ok   翻页：" + prevLog.replace("[cooklog] ", "") + " → " + nextLog.replace("[cooklog] ", ""));

  // ③ 在第 2 页按菜名把这道临时菜选回来（跨页选菜）
  const tsel = globalThis.__logs.length;
  voiceStub.onText("番茄牛腩");
  for (let i = 0; i < 40; i++) {
    frames(3);
    if (globalThis.__logs.slice(tsel).some((l) => l.indexOf("COOK_PAINT mode=cooking") >= 0)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const pickLog = globalThis.__logs.slice(tsel).find((l) => l.indexOf("COOK_PICK begin") >= 0);
  if (!pickLog || pickLog.indexOf("idx=12") < 0) fail("跨页按菜名没选中第 13 道：" + (pickLog || "(没进动画)"));

  // ④ 做完 → 问要不要存 → 说「算了」→ 必须撤出菜单
  const t1 = globalThis.__logs.length;
  voiceStub.onText("完成了");
  frames(70);
  const startLog = globalThis.__logs.slice(t1).find((l) => l.indexOf("COOK_WRAP start") >= 0);
  if (!startLog || startLog.indexOf("canSave=true") < 0) {
    fail("库外菜没问「要不要存进菜单」：" + (startLog || "(没进收尾)"));
  }
  const t2 = globalThis.__logs.length;
  voiceStub.onText("算了");
  frames(70);
  const seg = globalThis.__logs.slice(t2);
  const dropLog = seg.find((l) => l.indexOf("COOK_TEMP drop") >= 0);
  const skipLog = seg.find((l) => l.indexOf("COOK_WRAP skip") >= 0);
  if (!skipLog) fail("说「算了」没进「不存」分支");
  if (skipLog.indexOf("dropped=true") < 0) {
    fail("说「算了」只是没落盘，菜还留在菜单里：" + skipLog.replace("[cooklog] ", ""));
  }
  if (!dropLog) fail("没有 COOK_TEMP drop 日志（菜没被摘掉）");
  console.log("  ok   " + skipLog.replace("[cooklog] ", ""));
  console.log("  ok   " + dropLog.replace("[cooklog] ", ""));

  // ⑤ 回菜单：菜数必须回到原来的 n0
  voiceStub.onText("不用");
  frames(70);
  const t3 = globalThis.__logs.length;
  voiceStub.onText("再做一道");
  frames(70);
  const backLog = menus().slice(-1)[0] || "";
  const n2 = Number((backLog.match(/n=(\d+)/) || [0, -1])[1]);
  if (n2 !== n0) fail("说「算了」之后菜单菜数应该是 " + n0 + "，实际 n=" + n2);
  console.log("  ok   " + backLog.replace("[cooklog] ", "") + "（回到原来的 " + n0 + " 道）");

  // ⑥ 收藏文件里不能多出这道菜
  const file = path.join(tmp, "custom-dishes.json");
  if (fs.existsSync(file)) {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail("收藏文件坏了"); }
    const titles = (saved.dishes || []).map((d) => d.title);
    if (titles.indexOf("番茄牛腩") >= 0) fail("说了「算了」却把番茄牛腩写进了 custom-dishes.json");
    console.log("  ok   收藏文件里没有「番茄牛腩」：" + JSON.stringify(titles));
  }

  console.log("\n[通过] 说「算了」→ 菜真的撤出菜单，且生成时没有顶掉任何一道。");
}

if (process.env.COOK_MOCK_LLM !== "1") {
  dialogTest(false).then(() => wrapTest(false)).catch((e) => { console.log("\n[崩溃·对话行] " + e.stack); process.exit(1); });
}

