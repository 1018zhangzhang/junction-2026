"use strict";
// ============================================================================
// 【联网问答】先自己答，答不上再查 —— 一个模型 + 一个搜索工具，就是"智能体"
// ----------------------------------------------------------------------------
// 为什么不是"再接一个大模型"：
//   ① 两套模型 = 两份密钥、两处提示词、两种延迟，还可能互相矛盾；
//   ② 真正缺的不是"第二个脑子"，是"它能不能查资料"。
// 所以这里只做一件事：同一个模型，按需跑两遍。
//   第 1 遍：凭常识答一句 —— 和原来的 llm.advise() 完全一样，6 秒内出结果；
//   第 2 遍：只在「它自己说不确定」或「这类问题它一定会瞎编」时才发生 ——
//            先搜 3 条网页，把摘要塞回提示词，再让它说一句。
//
// 三条纪律（和 llm-bridge 一脉相承）：
//   1) 没配 search = 完全保持原样：第一遍答完就返回，一行搜索请求都不发；
//   2) 搜索只是"锦上添花"：超时 / 401 / 搜不到 → 一律退回第一遍的答案，绝不空手而归；
//   3) 密钥只从外部 llm.json 读；日志里只出现 provider 名字，永不出现 key 和完整 URL。
//
// llm.json 里多一段（不写这段也能跑，行为等于现在）：
//   "search": { "provider": "bocha", "apiKey": "sk-...", "count": 3, "timeoutMs": 4000 }
//   provider：bocha（博查）/ tavily / serper / custom（自定义 endpoint，按通用格式解析）
// ============================================================================

const fs = require("node:fs");
const llm = require("./llm-bridge");

const SEARCH_TIMEOUT_MS = 4000;    // 搜索最多等 4 秒：锅还在火上，不能陪它等
const ANSWER_TIMEOUT_MS = 10000;   // 第二遍（带资料）多给一点，但也只给 10 秒
const TOTAL_BUDGET_MS = 16000;     // 从开口到出答案的总预算，超了就用手上已有的
const DEFAULT_COUNT = 3;

// ---- 这类问题模型一定会瞎编，别等它说"不确定"，直接查 ----
// 注意：故意不含"几分钟/多少度/怎么切"——那是厨房常识，模型答得又快又对，
// 查一遍只会白白多等 4 秒。
const MUST_LOOK_UP = [
  /多少钱|价格|几块钱|涨价|贵不贵|便宜吗/,                  // 价格随时变
  /哪个牌子|什么牌子|牌子好|推荐.{0,4}牌子/,                // 品牌口碑
  /最新|今年|最近|现在.{0,4}(流行|便宜|贵|好吃)|新出|上市/, // 时效
  /热量|卡路里|蛋白质|脂肪|碳水|维生素|营养成分/,           // 具体数值
  /保质期|产地|配料表|添加剂|标准|能不能吃|安全吗|有毒|致癌|甲醛/, // 事实核查
];

// ---- 模型自己承认没把握的信号 → 升级去查 ----
// 「不太确定 / 不大清楚 / 不好说」这类中间插字的口语一定要认，
// 否则模型明明在打太极，代码却当成笃定答案直接返回（踩过）。
const UNCERTAIN = /不(太|大|很|够|怎么)?确定|不(太|大)?清楚|不好说|说不好|视情况|看情况|取决于|查一下|建议查|无法判断|没有把握|没把握|不太了解|不知道/;

// ---- 搜索服务商适配（只做"发一个 POST，把结果摊平成 3 条"） ----
const PROVIDERS = {
  bocha: {
    endpoint: "https://api.bochaai.com/v1/web-search",
    build: (q, n) => ({ query: q, count: n, summary: true }),
    headers: (key) => ({ Authorization: "Bearer " + key }),
    pick: (d) => {
      const v = d && d.data && d.data.webPages && d.data.webPages.value;
      return Array.isArray(v) ? v.map((x) => ({ title: x.name, url: x.url, snippet: x.snippet || x.summary })) : [];
    },
  },
  tavily: {
    endpoint: "https://api.tavily.com/search",
    build: (q, n, key) => ({ api_key: key, query: q, max_results: n, search_depth: "basic" }),
    headers: (key) => ({ Authorization: "Bearer " + key }),
    pick: (d) => (Array.isArray(d && d.results)
      ? d.results.map((x) => ({ title: x.title, url: x.url, snippet: x.content })) : []),
  },
  serper: {
    endpoint: "https://google.serper.dev/search",
    build: (q, n) => ({ q: q, num: n }),
    headers: (key) => ({ "X-API-KEY": key }),
    pick: (d) => (Array.isArray(d && d.organic)
      ? d.organic.map((x) => ({ title: x.title, url: x.link, snippet: x.snippet })) : []),
  },
};

/** 读 llm.json 里的 search 段。走 llm-bridge 的同一套候选路径，避免两处逻辑打架 */
function loadSearchConfig() {
  for (const file of llm.candidatePaths()) {
    let data;
    try {
      if (!fs.existsSync(file)) continue;
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      continue;
    }
    const s = data && data.search;
    if (!s) continue;
    const provider = String(s.provider || "").toLowerCase();
    if (!provider) continue;
    if (provider === "custom" ? !s.endpoint : !PROVIDERS[provider]) continue;
    // 内置服务商都要 key：留空就当没配（否则每次"不确定"都白等 4 秒才 401 退回）。
    // custom 例外 —— 本地代理经常不需要鉴权。
    if (provider !== "custom" && !s.apiKey) continue;
    return {
      provider: provider,
      endpoint: provider === "custom" ? String(s.endpoint) : PROVIDERS[provider].endpoint,
      apiKey: s.apiKey ? String(s.apiKey) : "",
      count: Number(s.count) > 0 ? Math.min(Number(s.count), 5) : DEFAULT_COUNT,
      timeoutMs: Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : SEARCH_TIMEOUT_MS,
      source: file,
    };
  }
  return null;
}

/** 配了搜索才联网查；没配 = 老行为 */
function searchReady() {
  return loadSearchConfig() !== null;
}

/** 启动日志用：只说 provider，不碰 key */
function describeSearch() {
  const cfg = loadSearchConfig();
  if (!cfg) return { ready: false, provider: "" };
  return { ready: true, provider: cfg.provider, count: cfg.count };
}

function maskKey(key) {
  const s = String(key || "");
  if (!s) return "（无密钥）";
  if (s.length <= 8) return "••••";
  return s.slice(0, 3) + "••••" + s.slice(-4);
}

// ---- 带超时的 POST（和 asr 同款：超时就自杀，绝不挂住整条链路） ----
async function postJson(url, headers, body, timeoutMs) {
  if (typeof fetch !== "function") return { ok: false, reason: "no-fetch" };
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) { /* 忽略 */ } }, timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json" }, headers),
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
    if (response.status === 429) return { ok: false, reason: "rate-limit" };
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: "http-" + response.status };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch (error) {
      return { ok: false, reason: "bad-response" };
    }
  } catch (error) {
    const name = String((error && error.name) || "");
    const msg = String((error && error.message) || error || "");
    if (name === "AbortError" || /timeout|aborted/i.test(msg)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "network" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 网页摘要洗成一行：去脚本/样式/标签/实体，压空白，截断 */
function cleanSnippet(text, limit) {
  let t = String(text || "");
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  t = t.replace(/\s+/g, " ").trim();
  const max = Number(limit) > 0 ? Number(limit) : 160;
  return t.length > max ? t.slice(0, max).replace(/[，、,；;]$/, "") + "…" : t;
}

/** 备一套通用解析：自定义 endpoint 时先按已知结构挨个试 */
function genericPick(d) {
  const shapes = [PROVIDERS.bocha, PROVIDERS.tavily, PROVIDERS.serper];
  for (const p of shapes) {
    const list = p.pick(d);
    if (list.length) return list;
  }
  return [];
}

/**
 * 查一次。
 * @param {string} query 查询词（菜名 + 用户原话）
 * @returns {Promise<{ok:true,hits:Array}|{ok:false,reason:string}>}
 */
async function search(query, options) {
  const cfg = loadSearchConfig();
  if (!cfg) return { ok: false, reason: "not-configured" };
  const q = String(query || "").trim();
  if (q.length < 2) return { ok: false, reason: "empty-query" };

  const opts = options || {};
  const spec = PROVIDERS[cfg.provider];
  const endpoint = cfg.endpoint;
  const body = spec ? spec.build(q, cfg.count, cfg.apiKey) : { query: q, count: cfg.count };
  const headers = spec ? spec.headers(cfg.apiKey) : { Authorization: "Bearer " + cfg.apiKey };
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : cfg.timeoutMs;

  const res = await postJson(endpoint, headers, body, timeoutMs);
  if (!res.ok) {
    // 只记 provider 和原因类型：URL 里也可能带 key
    console.log("COOK_AGENT search fail " + cfg.provider + " " + res.reason);
    return res;
  }
  const raw = spec ? spec.pick(res.data) : genericPick(res.data);
  const hits = raw
    .map((h) => ({
      title: cleanSnippet(h.title, 40),
      snippet: cleanSnippet(h.snippet, 160),
      url: String(h.url || ""),
    }))
    .filter((h) => h.snippet)
    .slice(0, cfg.count);
  console.log("COOK_AGENT search ok " + cfg.provider + " hits=" + hits.length + " q=" + q.slice(0, 20));
  return { ok: true, hits: hits };
}

function buildQuery(ctx) {
  const c = ctx || {};
  const dish = String(c.dish || "").trim();
  const said = String(c.said || "").trim();
  if (!dish || said.indexOf(dish) >= 0) return said;
  // 「红烧肉」+「要不要焯水」→ 带上菜名去搜，结果更贴这一锅
  return dish + " " + said;
}

/** 该不该翻第二遍：模型自己虚了，或这类问题注定要查 */
function shouldLookUp(said, firstText) {
  const t = String(said || "");
  if (MUST_LOOK_UP.some((re) => re.test(t))) return true;
  if (firstText && UNCERTAIN.test(firstText)) return true;
  return false;
}

const FACTS_PROMPT = [
  "你在灶台边帮人做菜。用户正拿着一把锅铲，只等一句话。",
  "下面是从网上刚搜到的资料，可能不准、可能跑题、可能是广告。",
  "要求：",
  "1. 只用一句话回答，最多 30 个汉字，先说最要紧的动作；",
  "2. 资料和你的常识冲突时，以资料为准；资料跟问题无关就忽略它，按常识答；",
  "3. 不要提「根据资料」「搜索结果显示」，不要列点，不要换行，不要引号；",
  "4. 实在没法确定，就说最稳妥的通用做法，别反问用户。",
].join("\n");

function factsText(hits) {
  return hits.map((h, i) => "[" + (i + 1) + "] " + h.title + "：" + h.snippet).join("\n");
}

/**
 * 智能体的对外接口：和 llm.advise() 同一个形状，上层换一行就行。
 * @param {object} ctx {dish, stepIndex, total, step, detail, said, local, timeoutMs, onStage}
 * @returns {Promise<{ok:true,text:string,searched:boolean}|{ok:false,reason:string}>}
 */
async function answer(ctx) {
  const c = ctx || {};
  const said = String(c.said || "").trim();
  if (!said) return { ok: false, reason: "empty" };
  if (!llm.ready()) return { ok: false, reason: "not-configured" };

  const t0 = Date.now();
  const stage = typeof c.onStage === "function" ? c.onStage : function () {};
  const left = () => Math.max(1200, TOTAL_BUDGET_MS - (Date.now() - t0));

  // ---- 第 1 遍：凭常识答。和升级前完全一致，没配搜索时这就是终点 ----
  const first = await llm.advise(c);
  const firstText = first.ok ? first.text : "";

  if (first.ok && !shouldLookUp(said, firstText)) {
    return { ok: true, text: first.text, searched: false };
  }
  // 密钥错 / 没配 / 网络断：再搜一遍也是白等，直接把第一遍的结果交回去
  if (!searchReady() || (!first.ok && first.reason !== "empty")) {
    return first.ok ? { ok: true, text: first.text, searched: false } : first;
  }

  // ---- 第 2 遍：查一次，带着资料再说一句 ----
  stage("search");
  // 以 llm.json 里配的 timeoutMs 为准（默认 4 秒），再用总预算压一道 —— 
  // 别在这里写死 4000，否则用户配的 800ms 会被无声覆盖（测试抓到过）
  const sc = loadSearchConfig();
  const searchCap = sc && sc.timeoutMs > 0 ? sc.timeoutMs : SEARCH_TIMEOUT_MS;
  const found = await search(buildQuery(c), { timeoutMs: Math.min(searchCap, left()) });
  if (!found.ok || !found.hits.length) {
    return first.ok ? { ok: true, text: first.text, searched: false } : first;
  }

  stage("answer");
  const reply = await llm.ask([
    { role: "system", content: FACTS_PROMPT },
    {
      role: "user",
      content: [
        "菜：" + (c.dish || "（不确定）"),
        "当前第 " + ((Number(c.stepIndex) || 0) + 1) + " 步：" + (c.step || ""),
        "用户问：" + said,
        "资料：",
        factsText(found.hits),
      ].join("\n"),
    },
  ], { temperature: 0.2, timeoutMs: Math.min(ANSWER_TIMEOUT_MS, left()) });

  if (!reply.ok) {
    // 第二遍挂了不算失败：第一遍那句话还能用
    console.log("COOK_AGENT answer2 fail " + reply.reason);
    return first.ok ? { ok: true, text: first.text, searched: false } : reply;
  }
  const text = llm.cleanAdvice(reply.text);
  if (!text) return first.ok ? { ok: true, text: first.text, searched: false } : { ok: false, reason: "empty" };

  console.log("COOK_AGENT ok searched=1 used=" + (Date.now() - t0) + "ms");
  return { ok: true, text: text, searched: true, sources: found.hits.map((h) => h.url) };
}

module.exports = {
  SEARCH_TIMEOUT_MS, ANSWER_TIMEOUT_MS, TOTAL_BUDGET_MS,
  loadSearchConfig, searchReady, describeSearch, maskKey,
  search, buildQuery, shouldLookUp, cleanSnippet, factsText,
  answer, FACTS_PROMPT, MUST_LOOK_UP, UNCERTAIN,
};
