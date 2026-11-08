"use strict";
/* 联网问答自测（不联网、不花钱）：起一个假的 OpenAI 兼容服务 + 一个假的博查搜索，
   验证「没配=0 请求」「答得笃定就不搜」「自己虚了/该查的才搜」「搜索挂了退回第一遍」。
   用法：node tools/test-agent.js */
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookagent-"));
for (const f of ["agent.js", "llm-bridge.js", "dishes-extra.js", "application-data.js"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
}
process.env.FUSIONUI_APP_DATA_DIR = tmp;
delete process.env.COOK_LLM_CONFIG;

const SURE = "冷水下锅焯三分钟，撇干净浮沫再捞";
const UNSURE = "这个我不太确定，不同做法差别挺大";
const FROM_WEB = "先冷水下锅焯三分钟，别用热水";

const llmState = { hits: 0, mode: "sure", bodies: [] };
const searchState = { hits: 0, mode: "ok", queries: [], auth: null };

const llmServer = http.createServer((req, res) => {
  llmState.hits += 1;
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) {}
    llmState.bodies.push(parsed);
    if (llmState.mode === "auth") { res.writeHead(401); res.end(JSON.stringify({ error: "bad key" })); return; }
    if (llmState.mode === "slow") { setTimeout(() => { try { res.writeHead(200); res.end(payload("慢")); } catch (e) {} }, 800); return; }
    const sent = parsed && parsed.messages ? parsed.messages.map((m) => m.content).join("\n") : "";
    // 带「资料：」的第二遍请求 → 回一句基于资料的答案
    const text = sent.indexOf("资料：") >= 0 ? FROM_WEB : (llmState.mode === "unsure" ? UNSURE : SURE);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload(text));
  });
});

function payload(text) {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] });
}

const searchServer = http.createServer((req, res) => {
  searchState.hits += 1;
  searchState.auth = req.headers.authorization || null;
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    try { searchState.queries.push(JSON.parse(body).query); } catch (e) { searchState.queries.push(null); }
    if (searchState.mode === "auth") { res.writeHead(401); res.end("{}"); return; }
    if (searchState.mode === "slow") { setTimeout(() => { try { res.writeHead(200); res.end(okBody()); } catch (e) {} }, 700); return; }
    if (searchState.mode === "empty") { res.writeHead(200); res.end(JSON.stringify({ code: 200, data: { webPages: { value: [] } } })); return; }
    if (searchState.mode === "garbage") { res.writeHead(200); res.end("不是 JSON"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(okBody());
  });
});

function okBody() {
  return JSON.stringify({
    code: 200,
    data: {
      webPages: {
        value: [
          { name: "焯水到底用冷水还是热水", url: "https://example.com/a", snippet: "<b>冷水下锅</b>，水开后撇沫，焯 3 分钟即可。" },
          { name: "红烧肉做法", url: "https://example.com/b", snippet: "&nbsp;焯水后再煸炒上色…" },
        ],
      },
    },
  });
}

function writeConfig(search, extra) {
  const cfg = Object.assign({
    endpoint: "http://127.0.0.1:" + llmServer.address().port + "/v1/chat/completions",
    model: "Qwen/Qwen3-8B",
    apiKey: "sk-llm-secret-123456",
    timeoutMs: 3000,
  }, extra || {});
  if (search) cfg.search = search;
  fs.writeFileSync(path.join(tmp, "llm.json"), JSON.stringify(cfg));
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push("ok   " + name); })
    .catch((e) => { results.push("FAIL " + name + " → " + (e && e.message)); process.exitCode = 1; });
}

(async () => {
  await new Promise((r) => llmServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => searchServer.listen(0, "127.0.0.1", r));
  const searchBlock = {
    provider: "custom",
    endpoint: "http://127.0.0.1:" + searchServer.address().port + "/v1/web-search",
    apiKey: "sk-search-secret-abcdef",
    count: 3,
    timeoutMs: 1500,
  };
  const agent = require(path.join(tmp, "agent.js"));
  const llm = require(path.join(tmp, "llm-bridge.js"));

  const ctx = { dish: "红烧肉", stepIndex: 0, step: "肉切块", said: "肉要不要焯水", local: "焯一下" };

  // ---- 1. 没配置 ----
  try { fs.unlinkSync(path.join(tmp, "llm.json")); } catch (e) {}
  await check("没配置 llm.json → not-configured，零请求", async () => {
    const before = llmState.hits + searchState.hits;
    const r = await agent.answer(ctx);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "not-configured");
    assert.strictEqual(llmState.hits + searchState.hits, before);
  });

  // ---- 2. 答得笃定就不搜（这是最省的一次，必须一行搜索都不发） ----
  writeConfig(null);
  await check("没配 search：只走一遍模型，零搜索请求", async () => {
    searchState.hits = 0;
    llmState.mode = "sure";
    const before = llmState.hits;
    const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.text, SURE);
    assert.strictEqual(r.searched, false);
    assert.strictEqual(searchState.hits, 0);
    assert.strictEqual(llmState.hits, before + 1);
    assert.strictEqual(agent.searchReady(), false);
  });

  // ---- 3. 配了 search，但第一遍答得很笃定 → 仍然不搜 ----
  writeConfig(searchBlock);
  await check("配了 search：答得笃定 → 不搜索（省 4 秒）", async () => {
    searchState.hits = 0;
    llmState.mode = "sure";
    const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
    assert.strictEqual(r.searched, false);
    assert.strictEqual(searchState.hits, 0);
    assert.strictEqual(agent.searchReady(), true);
  });

  // ---- 4. 模型自己虚了 → 搜一次，第二遍带资料 ----
  await check("模型说「不确定」→ 触发搜索，第二遍请求里带上了资料", async () => {
    searchState.hits = 0;
    llmState.mode = "unsure";
    llmState.bodies = [];
    const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.searched, true, "应该走完两遍");
    assert.strictEqual(r.text, FROM_WEB);
    assert.strictEqual(searchState.hits, 1);
    assert.strictEqual(llmState.bodies.length, 2, "应该调了两次模型");
    const sent = llmState.bodies[1].messages.map((m) => m.content).join("\n");
    assert.ok(sent.indexOf("冷水下锅") >= 0, "第二遍要带搜索结果");
    assert.ok(sent.indexOf("资料：") > 0, sent);
    assert.strictEqual(llmState.bodies[1].response_format, undefined, "别开 JSON 模式");
  });

  await check("查询词 = 菜名 + 原话（结果更贴这一锅）", async () => {
    assert.strictEqual(searchState.queries[0], "红烧肉 肉要不要焯水");
    assert.strictEqual(agent.buildQuery({ dish: "红烧肉", said: "红烧肉要不要焯水" }), "红烧肉要不要焯水");
    assert.strictEqual(agent.buildQuery({ dish: "", said: "要不要焯水" }), "要不要焯水");
  });

  // ---- 5. 这类问题注定要查：模型再笃定也得搜 ----
  await check("问价格 / 热量 → 不赌模型，直接查", async () => {
    assert.strictEqual(agent.shouldLookUp("这个多少钱", SURE), true);
    assert.strictEqual(agent.shouldLookUp("一盘红烧肉多少卡路里", SURE), true);
    assert.strictEqual(agent.shouldLookUp("肉要不要焯水", SURE), false, "厨房常识别浪费搜索");
    assert.strictEqual(agent.shouldLookUp("要不要焯水", UNSURE), true, "自己虚了才查");
  });

  // ---- 6. 搜索各种挂法都要退回第一遍 ----
  await check("搜索 401 → 退回第一遍答案（不空手）", async () => {
    searchState.mode = "auth";
    llmState.mode = "unsure";
    const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.searched, false);
    assert.strictEqual(r.text, UNSURE, "搜不了就用第一遍那句话");
    searchState.mode = "ok";
  });

  await check("搜索超时 → 按 timeoutMs 掐断，退回第一遍（总耗时可控）", async () => {
    searchState.mode = "slow";
    llmState.mode = "unsure";
    writeConfig(Object.assign({}, searchBlock, { timeoutMs: 150 }));
    const t0 = Date.now();
    const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
    const used = Date.now() - t0;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.searched, false);
    assert.ok(used < 2500, "不该被搜索拖住，实际 " + used + "ms");
    searchState.mode = "ok";
    writeConfig(searchBlock);
  });

  await check("搜索返回空 / 乱码 → 退回第一遍，不崩", async () => {
    llmState.mode = "unsure";
    for (const mode of ["empty", "garbage"]) {
      searchState.mode = mode;
      const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
      assert.strictEqual(r.ok, true, mode);
      assert.strictEqual(r.searched, false, mode);
    }
    searchState.mode = "ok";
  });

  // ---- 7. 模型本身挂了：不搜，直接报原因 ----
  await check("模型 401 → reason=auth，且不发搜索请求（省一次白等）", async () => {
    const before = searchState.hits;
    llmState.mode = "auth";
    const r = await agent.answer(Object.assign({}, ctx, { said: "肉要不要焯水" }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "auth");
    assert.strictEqual(searchState.hits, before);
    llmState.mode = "sure";
  });

  await check("空话不说 → reason=empty，零请求", async () => {
    const before = llmState.hits + searchState.hits;
    const r = await agent.answer({ said: "   " });
    assert.strictEqual(r.reason, "empty");
    assert.strictEqual(llmState.hits + searchState.hits, before);
  });

  // ---- 8. 工具函数 ----
  await check("cleanSnippet：去标签 / 去实体 / 压空白 / 截断", () => {
    assert.strictEqual(agent.cleanSnippet("<b>冷水</b>下锅&nbsp;焯 3 分钟"), "冷水 下锅 焯 3 分钟");
    assert.strictEqual(agent.cleanSnippet("<script>x</script>真话"), "真话");
    assert.ok(agent.cleanSnippet("字".repeat(300), 20).length <= 21);
    assert.strictEqual(agent.cleanSnippet(""), "");
  });

  await check("密钥不出现在日志里", () => {
    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      // 触发一次成功的搜索日志
      return agent.search("红烧肉").then(() => {
        console.log = orig;
        const all = logs.join("\n");
        assert.ok(all.indexOf("sk-search-secret-abcdef") < 0, "日志里出现了密钥：" + all);
        assert.ok(all.indexOf("127.0.0.1") < 0, "日志里出现了完整 URL：" + all);
      });
    } finally {
      console.log = orig;
    }
  });

  await check("describeSearch 只说 provider，不吐密钥", () => {
    const d = agent.describeSearch();
    assert.strictEqual(d.ready, true);
    assert.strictEqual(d.provider, "custom");
    assert.strictEqual(JSON.stringify(d).indexOf("secret"), -1);
    assert.strictEqual(agent.maskKey("sk-search-secret-abcdef"), "sk-••••cdef");
  });

  await check("provider 写错 / 内置服务商缺 key → 视为没配搜索（不会误发请求）", () => {
    writeConfig({ provider: "不存在的服务商", apiKey: "x" });
    assert.strictEqual(agent.searchReady(), false);
    writeConfig({ provider: "bocha", apiKey: "" });
    assert.strictEqual(agent.searchReady(), false, "内置服务商没 key 就是没配，别每次白等 4 秒");
    writeConfig({ provider: "custom", endpoint: searchBlock.endpoint, apiKey: "" });
    assert.strictEqual(agent.searchReady(), true, "自定义 endpoint 允许无鉴权（本地代理）");
    writeConfig(searchBlock);
  });

  llmServer.close();
  searchServer.close();
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.indexOf("FAIL") === 0).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " 通过");
  if (failed) process.exitCode = 1;
})();
