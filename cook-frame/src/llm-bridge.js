"use strict";
// ============================================================================
// 大模型插座（OpenAI 兼容）—— 默认全程离线，密钥永不进代码、不进提交包
// ----------------------------------------------------------------------------
// 设计三条硬规矩：
//   1) 代码里不写任何密钥。密钥只从"外部配置文件"读，文件放在应用数据目录（
//      不进 .fuiapp 包），提交前 .gitignore 也只忽略它。
//   2) 没配置 = 完全离线。ready() 返回 false，上层压根不会发起网络请求。
//   3) 网络永远只做"锦上添花"。超时 / 401 / 返回乱码，都退回本地菜谱，
//      绝不让做饭流程卡在"正在请求"。
//
// 配置文件 llm.json 的三种放法（按优先级）：
//   ① 环境变量 COOK_LLM_CONFIG 指向的路径（调试用）
//   ② 应用数据目录 llm.json（真机 / 模拟器正式路径，推荐）
//   ③ 项目根 llm.json（开发期图省事）
//
// 文件内容：
//   { "endpoint": "https://api.siliconflow.cn/v1/chat/completions",
//     "model": "Qwen/Qwen3-8B", "apiKey": "sk-...", "timeoutMs": 8000 }
//
// 换服务商只改这三行 —— 硅基流动 / 智谱 / 阿里百炼 / 火山 / DeepSeek 全是这个格式。
// ============================================================================
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 8000;
const CONFIG_NAME = "llm.json";

/** 配置文件候选路径（按优先级） */
function candidatePaths() {
  const list = [];
  const explicit = process.env.COOK_LLM_CONFIG;
  if (explicit) list.push(path.resolve(explicit));
  const appDir = process.env.FUSIONUI_APP_DATA_DIR;
  if (appDir && path.isAbsolute(appDir)) list.push(path.join(appDir, CONFIG_NAME));
  list.push(path.join(__dirname, "..", CONFIG_NAME));   // 项目根（开发期）
  return list;
}

/** 推荐用户放置配置的路径（提示文案用） */
function hintPath() {
  const appDir = process.env.FUSIONUI_APP_DATA_DIR;
  if (appDir && path.isAbsolute(appDir)) return path.join(appDir, CONFIG_NAME);
  return path.join(__dirname, "..", CONFIG_NAME);
}

/** 读配置。没文件 / 格式不对 / 缺必填 → null（等同于离线） */
function loadConfig() {
  const files = candidatePaths();
  for (const file of files) {
    let raw;
    try {
      if (!fs.existsSync(file)) continue;
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.log("COOK_LLM bad config: " + file);
      continue;
    }
    if (!raw || !raw.endpoint || !raw.model) continue;
    return {
      endpoint: String(raw.endpoint),
      model: String(raw.model),
      apiKey: raw.apiKey ? String(raw.apiKey) : "",
      timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
      // false = 强制关思考；true = 强制开；不写 = 由模型名自动判断（qwen3 关、其它不动）
      enableThinking: typeof raw.enableThinking === "boolean" ? raw.enableThinking : undefined,
      source: file,
    };
  }
  return null;
}

function ready() {
  return loadConfig() !== null;
}

/** 密钥只露尾巴，日志/界面里永远不出全串 */
function maskKey(key) {
  const s = String(key || "");
  if (!s) return "（无密钥）";
  if (s.length <= 8) return "••••";
  return s.slice(0, 3) + "••••" + s.slice(-4);
}

/** 给人看的状态（界面/日志用，绝不含完整密钥） */
function statusText() {
  const cfg = loadConfig();
  if (!cfg) return "未配置联网（纯离线运行）";
  return "已配置联网 · 模型 " + cfg.model + " · 密钥 " + maskKey(cfg.apiKey);
}

/** 结构化状态（启动时打一条日志用） */
function describe() {
  const cfg = loadConfig();
  if (!cfg) return { ready: false, model: "", source: "", hint: hintPath() };
  return { ready: true, model: cfg.model, source: cfg.source, hint: hintPath() };
}

// ---- 传输层：优先 fetch；没有 fetch 就走 node:http(s)（运行时万一带裁剪） ----
function postJsonHttp(url, headers, bodyText, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const secure = u.protocol === "https:";
    const mod = require(secure ? "node:https" : "node:http");
    const payload = Buffer.from(bodyText, "utf8");
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: (u.pathname || "/") + (u.search || ""),
      method: "POST",
      headers: Object.assign({}, headers, { "Content-Length": payload.length }),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function postJsonFetch(url, headers, bodyText, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) { /* 忽略 */ } }, timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller ? controller.signal : undefined,
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  /* ★ 关掉「思考模式」——这是本版最关键的一行。
   *   Qwen3 系列默认 enable_thinking=true：模型先写几百字推理过程才给答案，
   *   实测「回两个字」要 8~15 秒，我们的 4~8 秒超时必然失败，看上去就是"没反应"。
   *   关掉后同一个模型 0.77 秒。判断规则：
   *     · 配置里写了 enableThinking 就听配置
   *     · 没写时：模型名带 qwen3 才自动关（别的家不认这个字段，发了会 400）
   *   火山方舟（豆包 doubao/seed 系列）的关法不一样：body 里传 thinking:{type:"disabled"}。
   */
  const wantNoThink = cfg.enableThinking === false
    || (cfg.enableThinking === undefined && /qwen3/i.test(String(cfg.model || "")));
  const isDoubao = /doubao|seed/i.test(String(cfg.model || ""));
  if (wantNoThink) body.enable_thinking = false;
  if (wantNoThink && isDoubao) body.thinking = { type: "disabled" };
  const bodyText = JSON.stringify(body);

  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  if (cfg.apiKey) headers.Authorization = "Bearer " + cfg.apiKey;

  // 单次请求可以自带更短的超时（灶台边的随口问答不该等 8 秒）
  const waitMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : cfg.timeoutMs;

  let res;
  try {
    res = typeof fetch === "function"
      ? await postJsonFetch(cfg.endpoint, headers, bodyText, waitMs)
      : await postJsonHttp(cfg.endpoint, headers, bodyText, waitMs);
  } catch (error) {
    const name = String((error && error.name) || "");
    const msg = String((error && error.message) || error || "");
    if (name === "AbortError" || /timeout|aborted/i.test(msg)) return { ok: false, reason: "timeout" };
    // 只记原因类型，不记 URL 里的任何参数（有的服务商会把 key 放 query）
    return { ok: false, reason: "network" };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
  if (res.status === 429) return { ok: false, reason: "rate-limit" };
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: "http-" + res.status };

  let data;
  try { data = JSON.parse(res.text); } catch (error) { return { ok: false, reason: "bad-response" }; }
  const text = data
    && data.choices
    && data.choices[0]
    && data.choices[0].message
    && data.choices[0].message.content;
  if (!text) return { ok: false, reason: "empty" };
  return { ok: true, text: String(text) };
}

/** 从模型返回的文本里抠出 JSON（容忍 ```json 围栏和前后废话） */
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
  "要求：4 到 5 步（不要更多）；detail 不超过 15 字，能省就省。",
  "timeMs 只在这一步确实需要等待时才写（比如焖 10 分钟写 600000），不需要等待就写 0。",
  "全部用简体中文，步骤要能直接照着做。输出必须是一行紧凑 JSON，不要缩进、不要换行、不要代码块。",
].join("\n");

/**
 * 说一个本地菜谱库里没有的菜 → 交给模型整理成菜谱。
 * 返回的菜还会过一次本地校验（和用户导入共用 normalize），不合格就当失败。
 */
async function parseDish(text, options) {
  if (!ready()) return { ok: false, reason: "not-configured" };
  const opts = options || {};
  const reply = await ask([
    { role: "system", content: PARSE_PROMPT },
    { role: "user", content: String(text || "") },
  ], {
    json: true,
    temperature: 0.2,
    // 生成整份菜谱要吐几百个 token，比随口问答慢得多，默认放宽到 15 秒；
    // 但配置里明确写了更短/更长就以配置为准（测试用短超时验证掐断行为）
    timeoutMs: Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : Math.max(Number(loadConfig().timeoutMs) || 0, 15000),
  });
  if (!reply.ok) return reply;
  const parsed = extractJson(reply.text);
  if (!parsed) return { ok: false, reason: "bad-json" };
  const dish = require("./dishes-extra").normalize(parsed, 0);
  if (!dish) return { ok: false, reason: "bad-dish" };
  if (!dish.subtitle || dish.subtitle === "自建菜谱") dish.subtitle = "刚刚生成的";
  return { ok: true, dish };
}

/* ─────────────── 灶台边的随口问答（对话式，只要一句话） ───────────────
 * 场景：用户在做菜过程中说「太咸了」「这个要煮多久」「能不能换成牛肉」。
 * 本地引擎只认有限的词表，词表外的句子以前一律「没听懂」，界面上什么都不动 ——
 * 用户的感觉就是「你听懂了但你没动作」。这一路就是把那些句子交给模型，
 * 换回一句能马上照做的话，显示在屏幕下方，当前那一步不动。
 *
 * 硬要求：一句话、30 字内。不做菜谱、不写小作文 —— 用户正拿着锅铲。
 */
const ADVISE_PROMPT = [
  "你在灶台边帮人做菜。用户正在做一道菜，说到一半突然问了一句。",
  "根据「菜名 / 当前步骤 / 用户原话」，用一句话给出马上能照做的处理办法。",
  "规则：",
  "1. 最多 30 个汉字，只说要做什么，不要解释原理，不要客套，不要重复步骤内容；",
  "2. 涉及食品安全（夹生、糊锅冒烟、生熟不分）先说要紧的动作；",
  "3. 实在拿不准就给最常见的通用做法，别反问你；",
  "4. 只输出这一句话本身：不要引号、不要编号、不要 markdown、不要换行。",
].join("\n");

/** 把模型的话收拾成"一行"：去围栏、去编号、去引号、截断 */
function cleanAdvice(text) {
  let t = String(text || "");
  t = t.replace(/```[a-zA-Z]*\s?/g, " ");           // 只去掉围栏标记，内容要留着
  t = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(" ");  // 多行压成一行
  t = t.replace(/^(回答|建议|答案)[:：]\s*/, "");
  t = t.replace(/^[-*•·\d]+[.、)）]?\s*/, "");        // 行首编号/项目符号
  t = t.replace(/^["'“”「『]+/, "").replace(/["'“”」』]+$/, "");
  if (t.length > 60) t = t.slice(0, 60).replace(/[，、,；;]$/, "") + "…";
  return t.trim() || null;
}

/**
 * 随口问答：把"当前处境 + 用户这句话"交给模型，换回一句能马上照做的话。
 * @param {{dish?:string, stepIndex?:number, total?:number, step?:string,
 *          detail?:string, said:string, local?:string, timeoutMs?:number}} ctx
 * @returns {Promise<{ok:true,text:string}|{ok:false,reason:string}>}
 */
async function advise(ctx) {
  if (!ready()) return { ok: false, reason: "not-configured" };
  const c = ctx || {};
  const lines = [
    "菜：" + (c.dish || "（不确定）"),
    "当前第 " + ((Number(c.stepIndex) || 0) + 1) + " 步（共 " + (Number(c.total) || 0) + " 步）：" + (c.step || ""),
  ];
  if (c.detail) lines.push("这一步的补充：" + c.detail);
  if (c.local) lines.push("离线方案（可参考、可改写得更具体）：" + c.local);
  lines.push("用户说：" + String(c.said || ""));

  const reply = await ask([
    { role: "system", content: ADVISE_PROMPT },
    { role: "user", content: lines.join("\n") },
  ], { temperature: 0.4, timeoutMs: Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 6000 });

  if (!reply.ok) return reply;
  const text = cleanAdvice(reply.text);
  if (!text) return { ok: false, reason: "empty" };
  return { ok: true, text };
}

/* ─────────────── 听错纠正（把同音字纠正成菜名/口令） ───────────────
 * 场景：语音识别把「酸辣土豆丝」听成「酸辣土豆丝儿」「沙辣土豆丝」，
 * 或把「上一步」听成「上色几步」。本地同音容错兜不住时，让模型在
 * 「菜单里的菜」和「固定口令」这两个封闭集合里做一次归类。
 *
 * 关键约束（为什么不是"让模型自由发挥"）：
 *   ① 只许从候选里原样照抄 —— 模型不能自己造菜名，否则会开出一道不存在的菜；
 *   ② 拿不准就返回 other —— 宁可当没听懂，也不能猜错把锅带偏；
 *   ③ 3 秒超时 —— 灶台边说一句等 3 秒已经是上限，超时就当没这回事。
 */
const INTERPRET_PROMPT = [
  "你是厨房语音助手的「听错纠正」环节。用户的语音被识别成了一句可能有同音错字的话。",
  "请判断他实际想要哪一个，只能三选一：",
  "A) 菜单里的一道菜 → {\"type\":\"dish\",\"value\":\"菜名\"}",
  "B) 一个操作口令 → {\"type\":\"cmd\",\"value\":\"口令\"}",
  "C) 都不是（在提问/闲聊/说菜的状态）→ {\"type\":\"other\",\"value\":\"\"}",
  "硬规矩：",
  "1) value 必须从我给你的候选里原样照抄，一个字都不能改，不许自己造；拿不准就选 other。",
  "2) 只有原话和候选**读音几乎一样、只是个别字被听错**时才允许纠正（例：沙辣土豆丝→酸辣土豆丝、马婆豆腐→麻婆豆腐、汤醋排骨→糖醋排骨、蛋炒范→蛋炒饭）。",
  "3) 绝不许把一道菜换成菜单里相似的另一道菜：红烧茄子 ≠ 红烧肉，番茄牛腩 ≠ 番茄炒蛋，青椒肉丝 ≠ 麻婆豆腐。原话里有候选没有的食材（茄子/牛腩/青椒/土豆…）就一律选 other。",
  "4) 多一个字或少一个字（红烧肉肉）算听错；换了主料、换了做法的不算听错。",
  "只输出一行 JSON，不要解释、不要代码块。",
].join("\n");

/**
 * @param {string} said 识别出来的原话
 * @param {{dishes?:string[], commands?:string[], timeoutMs?:number}} opts
 * @returns {Promise<{ok:true,type:"dish"|"cmd"|"other",value:string}|{ok:false,reason:string}>}
 */
async function interpret(said, opts) {
  if (!ready()) return { ok: false, reason: "not-configured" };
  const o = opts || {};
  const dishes = (Array.isArray(o.dishes) ? o.dishes : []).filter(Boolean).slice(0, 80);
  const commands = (Array.isArray(o.commands) ? o.commands : []).filter(Boolean).slice(0, 40);
  const user = [
    "候选菜：" + dishes.join("、"),
    "候选口令：" + commands.join("、"),
    "用户原话：" + String(said || ""),
  ].join("\n");

  const reply = await ask([
    { role: "system", content: INTERPRET_PROMPT },
    { role: "user", content: user },
  ], {
    temperature: 0,
    json: true,
    timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 3000,
  });
  if (!reply.ok) return reply;

  const parsed = extractJson(reply.text);
  if (!parsed || !parsed.type) return { ok: false, reason: "bad-json" };
  const type = String(parsed.type);
  const value = String(parsed.value == null ? "" : parsed.value).trim();
  if (type === "dish") {
    const hit = dishes.find((d) => d === value);
    return hit ? { ok: true, type: "dish", value: hit } : { ok: true, type: "other", value: "" };
  }
  if (type === "cmd") {
    const hit = commands.find((c) => c === value);
    return hit ? { ok: true, type: "cmd", value: hit } : { ok: true, type: "other", value: "" };
  }
  return { ok: true, type: "other", value: "" };
}

module.exports = {
  CONFIG_NAME, DEFAULT_TIMEOUT_MS,
  candidatePaths, hintPath, loadConfig, ready, statusText, describe, maskKey,
  ask, extractJson, parseDish, PARSE_PROMPT,
  advise, cleanAdvice, ADVISE_PROMPT,
  interpret, INTERPRET_PROMPT,
};
