"use strict";
/* 大模型插座自测（不联网、不花钱）：起一个本地假的 OpenAI 兼容服务，
   验证「没配置=零请求」「正常返回能变菜谱」「401/超时/乱码都优雅退场」。
   用法：node tools/test-llm.js */
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookllm-"));
for (const f of ["llm-bridge.js", "dishes-extra.js", "application-data.js"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(tmp, f));
}
process.env.FUSIONUI_APP_DATA_DIR = tmp;

const GOOD_DISH = {
  title: "蒜蓉粉丝蒸虾",
  steps: [
    { ask: "粉丝用温水泡软", detail: "泡到能弯不断", phase: "prep", timeMs: 600000 },
    { ask: "虾开背去虾线，铺在粉丝上", detail: "", phase: "prep", timeMs: 0 },
    { ask: "铺蒜蓉酱，水开上锅蒸", phase: "cook", timeMs: 480000 },
    { ask: "出锅淋热油，撒葱花", phase: "finish", timeMs: 0 },
  ],
};

const state = { hits: 0, lastRequest: null, mode: "ok", adviceText: "加小半勺糖，翻匀再尝一口" };

const server = http.createServer((req, res) => {
  state.hits += 1;
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    try { state.lastRequest = { headers: req.headers, body: JSON.parse(body) }; } catch (e) { state.lastRequest = null; }
    if (state.mode === "auth") { res.writeHead(401); res.end(JSON.stringify({ error: "bad key" })); return; }
    if (state.mode === "slow") { setTimeout(() => { try { res.writeHead(200); res.end(payload()); } catch (e) {} }, 400); return; }
    if (state.mode === "garbage") { res.writeHead(200); res.end("今天想吃点好的"); return; }
    if (state.mode === "advice") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: state.adviceText } }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload());
  });
});

function payload() {
  return JSON.stringify({
    choices: [{ message: { role: "assistant", content: "```json\n" + JSON.stringify(GOOD_DISH) + "\n```" } }],
  });
}

function writeConfig(obj, name) {
  const file = path.join(tmp, name || "llm.json");
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push("ok   " + name); })
    .catch((e) => { results.push("FAIL " + name + " → " + (e && e.message)); process.exitCode = 1; });
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const endpoint = "http://127.0.0.1:" + port + "/v1/chat/completions";
  const llm = require(path.join(tmp, "llm-bridge.js"));

  // ---- 1. 没配置：一行请求都不该发 ----
  delete process.env.COOK_LLM_CONFIG;
  try { fs.unlinkSync(path.join(tmp, "llm.json")); } catch (e) {}
  await check("没配置时 ready()=false", () => {
    assert.strictEqual(llm.ready(), false);
  });
  await check("没配置时 ask/parseDish 直接返回 not-configured，零网络请求", async () => {
    const before = state.hits;
    const a = await llm.ask("做个什么");
    const b = await llm.parseDish("蒜蓉粉丝蒸虾");
    assert.strictEqual(a.ok, false);
    assert.strictEqual(a.reason, "not-configured");
    assert.strictEqual(b.reason, "not-configured");
    assert.strictEqual(state.hits, before, "不应该发出任何请求");
  });
  await check("状态文案是「纯离线」", () => {
    assert.ok(/离线/.test(llm.statusText()), llm.statusText());
  });

  // ---- 2. 正常返回：能变成一道合法菜谱 ----
  writeConfig({ endpoint, model: "Qwen/Qwen3-8B", apiKey: "sk-test-1234567890abcdef" });
  await check("正常返回 → 菜谱结构合法", async () => {
    state.mode = "ok";
    const r = await llm.parseDish("想吃蒜蓉粉丝蒸虾");
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.dish.title, "蒜蓉粉丝蒸虾");
    assert.strictEqual(r.dish.steps.length, 4);
    assert.strictEqual(r.dish.imported, true);
    assert.strictEqual(r.dish.steps[0].timer, true, "10 分钟的步骤应带计时");
    assert.strictEqual(r.dish.steps[1].timer, false);
    assert.strictEqual(r.dish.subtitle, "刚刚生成的");
  });
  await check("请求体是标准 OpenAI 格式（model/messages/json 模式）", () => {
    const req = state.lastRequest;
    assert.ok(req, "应该收到请求");
    assert.strictEqual(req.body.model, "Qwen/Qwen3-8B");
    assert.strictEqual(req.body.response_format.type, "json_object");
    assert.strictEqual(req.body.messages.length, 2);
    assert.strictEqual(req.body.messages[0].role, "system");
    assert.ok(req.headers.authorization.indexOf("Bearer ") === 0);
  });
  await check("状态文案只露密钥尾巴，不出现完整密钥", () => {
    const s = llm.statusText();
    assert.ok(s.indexOf("sk-test-1234567890abcdef") < 0, "不能出现完整密钥：" + s);
    assert.ok(/••••/.test(s), s);
    assert.strictEqual(llm.maskKey("sk-test-1234567890abcdef"), "sk-••••cdef");
  });

  // ---- 3. 各种失败都要优雅退场 ----
  await check("401 → reason=auth", async () => {
    state.mode = "auth";
    const r = await llm.parseDish("随便做点什么");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "auth");
  });
  await check("超时 → reason=timeout（不抛异常）", async () => {
    state.mode = "slow";
    writeConfig({ endpoint, model: "m", apiKey: "sk-x", timeoutMs: 120 });
    const t0 = Date.now();
    // parseDish 对"生成整份菜谱"有 15 秒地板（配置里 120ms 只用于普通请求），
    // 这条用例要验的是"能按超时掐断"，所以显式传短超时
    const r = await llm.parseDish("慢慢来", { timeoutMs: 120 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "timeout");
    assert.ok(Date.now() - t0 < 350, "超时应该按 timeoutMs 掐断");
  });
  await check("响应体不是 JSON → reason=bad-response（不崩）", async () => {
    state.mode = "garbage";
    writeConfig({ endpoint, model: "m", apiKey: "sk-x" });
    const r = await llm.parseDish("乱答");
    assert.strictEqual(r.reason, "bad-response");
  });
  await check("响应是 JSON 但模型没给 JSON 菜谱 → reason=bad-json", async () => {
    const http2 = require("node:http");
    const s3 = http2.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "今天想吃点好的，建议你自己定" } }] }));
    });
    await new Promise((r) => s3.listen(0, "127.0.0.1", r));
    writeConfig({ endpoint: "http://127.0.0.1:" + s3.address().port + "/v1/chat/completions", model: "m", apiKey: "sk-x" });
    const r = await llm.parseDish("乱答");
    assert.strictEqual(r.reason, "bad-json");
    s3.close();
  });
  await check("模型返回缺字段 → reason=bad-dish", async () => {
    state.mode = "ok";
    const http2 = require("node:http");
    const s2 = http2.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"title":"空菜","steps":[]}' } }] }));
    });
    await new Promise((r) => s2.listen(0, "127.0.0.1", r));
    writeConfig({ endpoint: "http://127.0.0.1:" + s2.address().port + "/v1/chat/completions", model: "m", apiKey: "sk-x" });
    const r = await llm.parseDish("空菜");
    assert.strictEqual(r.reason, "bad-dish");
    s2.close();
  });
  await check("配置缺 model → 视为未配置（不误发请求）", async () => {
    writeConfig({ endpoint, apiKey: "sk-x" });
    assert.strictEqual(llm.ready(), false);
  });
  await check("配置里 endpoint 是瞎写的 → network（不崩）", async () => {
    writeConfig({ endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "m", apiKey: "sk-x", timeoutMs: 300 });
    const r = await llm.parseDish("x");
    assert.strictEqual(r.ok, false);
    assert.ok(["network", "timeout"].indexOf(r.reason) >= 0, r.reason);
  });

  // ---- 4. 配置优先级 ----
  await check("COOK_LLM_CONFIG 优先级高于应用数据目录", () => {
    writeConfig({ endpoint, model: "appdir-model", apiKey: "sk-x" });
    const other = writeConfig({ endpoint, model: "explicit-model", apiKey: "sk-x" }, "explicit.json");
    process.env.COOK_LLM_CONFIG = other;
    assert.strictEqual(llm.loadConfig().model, "explicit-model");
    delete process.env.COOK_LLM_CONFIG;
    assert.strictEqual(llm.loadConfig().model, "appdir-model");
  });
  await check("推荐路径指向应用数据目录（提示用户往哪放）", () => {
    assert.strictEqual(llm.hintPath(), path.join(tmp, "llm.json"));
  });

  // ---- 5. 对话式随口问答（advise）----
  await check("advise 未配置 → not-configured（零请求）", async () => {
    fs.unlinkSync(path.join(tmp, "llm.json"));
    const r = await llm.advise({ said: "太咸了" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "not-configured");
  });
  await check("advise 正常：返回一句话，提示词里带上菜名和当前步骤", async () => {
    writeConfig({ endpoint, model: "m", apiKey: "sk-x", timeoutMs: 2000 });
    state.mode = "advice";
    const before = state.hits;
    const r = await llm.advise({
      dish: "麻婆豆腐", stepIndex: 2, total: 6,
      step: "下豆腐轻推", detail: "别用铲子翻", said: "太咸了", local: "加糖",
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.text, "加小半勺糖，翻匀再尝一口");
    assert.strictEqual(state.hits, before + 1);
    const sent = state.lastRequest.body.messages.map((m) => m.content).join("\n");
    assert.ok(sent.indexOf("麻婆豆腐") >= 0, "要带菜名");
    assert.ok(sent.indexOf("下豆腐轻推") >= 0, "要带当前步骤");
    assert.ok(sent.indexOf("太咸了") >= 0, "要带用户原话");
    assert.strictEqual(state.lastRequest.body.response_format, undefined, "随口问答不要 JSON 模式");
    state.mode = "ok";
  });
  await check("advise 401 → auth", async () => {
    state.mode = "auth";
    const r = await llm.advise({ said: "太咸了" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "auth");
    state.mode = "ok";
  });
  await check("advise 超时 → timeout（不会把灶台卡住）", async () => {
    state.mode = "slow";
    const t0 = Date.now();
    const r = await llm.advise({ said: "太咸了", timeoutMs: 150 });
    const used = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "timeout");
    assert.ok(used < 1200, "超时应该很快返回，实际 " + used + "ms");
    state.mode = "ok";
  });
  await check("advise 返回空/套话 → 当作没答上来", async () => {
    state.mode = "advice";
    state.adviceText = "   ";
    const r = await llm.advise({ said: "太咸了" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "empty");
    state.adviceText = "加小半勺糖，翻匀再尝一口";
    state.mode = "ok";
  });
  await check("cleanAdvice 收拾成一行：去围栏/引号/编号/换行", () => {
    assert.strictEqual(llm.cleanAdvice("```\n加半勺糖。\n```"), "加半勺糖。");
    assert.strictEqual(llm.cleanAdvice("“加半勺糖，再尝一口。”"), "加半勺糖，再尝一口。");
    assert.strictEqual(llm.cleanAdvice("1. 关小火"), "关小火");
    assert.strictEqual(llm.cleanAdvice("建议：把锅离火\n等十秒"), "把锅离火 等十秒");
    assert.strictEqual(llm.cleanAdvice(""), null);
    assert.strictEqual(llm.cleanAdvice("   "), null);
    assert.ok(llm.cleanAdvice("这".repeat(200)).length <= 61);
  });

  // ---- 6. 听错纠正（interpret）：同音字 → 菜名/口令，只许在候选里挑 ----
  await check("interpret：模型给出菜单里的菜 → type=dish", async () => {
    writeConfig({ endpoint, model: "m", apiKey: "sk-x", timeoutMs: 2000 });
    state.mode = "advice";
    state.adviceText = '{"type":"dish","value":"酸辣土豆丝"}';
    const r = await llm.interpret("酸辣土豆丝儿", { dishes: ["酸辣土豆丝", "番茄炒蛋"], commands: ["下一步"] });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.type, "dish");
    assert.strictEqual(r.value, "酸辣土豆丝");
    state.mode = "ok";
  });
  await check("interpret：模型给出候选里没有的菜 → other（绝不自己造菜）", async () => {
    state.mode = "advice";
    state.adviceText = '{"type":"dish","value":"佛跳墙"}';
    const r = await llm.interpret("随便来点", { dishes: ["酸辣土豆丝", "番茄炒蛋"], commands: ["下一步"] });
    assert.strictEqual(r.type, "other");
    state.mode = "ok";
  });
  await check("interpret：口令 → type=cmd", async () => {
    state.mode = "advice";
    state.adviceText = '{"type":"cmd","value":"上一步"}';
    const r = await llm.interpret("上色几步", { dishes: ["酸辣土豆丝"], commands: ["上一步", "下一步"] });
    assert.strictEqual(r.type, "cmd");
    assert.strictEqual(r.value, "上一步");
    state.mode = "ok";
  });
  await check("interpret：模型返回闲聊 → other；返回乱码 → bad-json", async () => {
    state.mode = "advice";
    state.adviceText = "这个我先不猜了";
    let r = await llm.interpret("嗯", { dishes: ["酸辣土豆丝"], commands: ["下一步"] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "bad-json");
    state.mode = "ok";
  });
  await check("interpret：提示词把候选菜/口令都带上（约束模型只能照抄）", async () => {
    state.mode = "advice";
    state.adviceText = '{"type":"other","value":""}';
    await llm.interpret("那个", { dishes: ["麻婆豆腐"], commands: ["换菜"] });
    const sent = state.lastRequest.body.messages.map((m) => m.content).join("\n");
    assert.ok(sent.indexOf("麻婆豆腐") >= 0, "候选菜要进提示词");
    assert.ok(sent.indexOf("换菜") >= 0, "候选口令要进提示词");
    assert.ok(/原样照抄/.test(sent), "要明确要求只许照抄");
    state.mode = "ok";
  });

  server.close();
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.indexOf("FAIL") === 0).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " 通过");
  if (failed) process.exitCode = 1;
})();
