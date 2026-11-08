"use strict";
/* 耳朵自测：云端精识别优先、失败/超时自动退回本地，且本地流式那一路不受影响。
   用法：node tools/test-asr.js （起两个本地假服务，不联网、不花钱） */
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookasr-"));
fs.copyFileSync(path.join(SRC, "asr.js"), path.join(tmp, "asr.js"));
delete process.env.FUSIONUI_APP_DATA_DIR;
// 测试日志另开一份：以前测试直接往 /tmp/cook-mic.log 里写，
// 把真机现场那些 401/timeout 的假记录混进去了，排查时限难分真假。
process.env.COOK_LOG_FILE = path.join(tmp, "test-asr.log");

const state = { cloudHits: 0, localHits: 0, lastCloudBody: "", lastLocalBody: "", cloudMode: "ok" };

function startServer(kind) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (kind === "cloud") {
        state.cloudHits += 1;
        state.lastCloudBody = body;
        if (state.cloudMode === "auth") { res.writeHead(401); res.end("{}"); return; }
        if (state.cloudMode === "slow") { setTimeout(() => { try { res.writeHead(200); res.end(JSON.stringify({ text: "太咸了" })); } catch (e) {} }, 500); return; }
        if (state.cloudMode === "empty") { res.writeHead(200); res.end(JSON.stringify({ text: "" })); return; }
        if (state.cloudMode === "garbage") { res.writeHead(200); res.end(JSON.stringify({ text: "Okay." })); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "太咸了" }));
        return;
      }
      if (kind === "omni") {
        state.omniHits = (state.omniHits || 0) + 1;
        state.lastOmniBody = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "我想吃酸辣土豆丝" } }] }));
        return;
      }
      if (kind === "volc") {
        state.volcHits = (state.volcHits || 0) + 1;
        state.lastVolcBody = body;
        state.lastVolcHeaders = req.headers;
        const okHead = req.headers["x-api-app-key"] === "app-1"
          && req.headers["x-api-access-key"] === "tok-1"
          && req.headers["x-api-resource-id"] === "volc.bigasr.auc_turbo";
        if (!okHead) {
          res.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "45000001", "X-Api-Message": "bad-header" });
          res.end("{}");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "20000000" });
        res.end(JSON.stringify({ result: { text: "麻婆豆腐" } }));
        return;
      }
      if (kind === "volc-key") {
        // 新版控制台：只带一个 X-Api-Key，不带 appid/access-token
        state.lastVolcHeaders = req.headers;
        state.lastVolcBody = body;
        const okHead = req.headers["x-api-key"] === "key-abc"
          && !req.headers["x-api-app-key"]
          && req.headers["x-api-resource-id"] === "volc.bigasr.auc_turbo";
        if (!okHead) {
          res.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "45000001", "X-Api-Message": "bad-header" });
          res.end("{}");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "20000000" });
        res.end(JSON.stringify({ result: { text: "糖醋排骨" } }));
        return;
      }
      if (kind === "volc-silent") {
        res.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "20000003" });
        res.end("{}");
        return;
      }
      if (kind === "cloud2") {
        state.cloudHits2 = (state.cloudHits2 || 0) + 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "豆腐切块" }));
        return;
      }
      state.localHits += 1;
      state.lastLocalBody = body;
      if (req.url.indexOf("/ping") >= 0) { res.writeHead(200); res.end('{"ok":true}'); return; }
      if (req.url.indexOf("/stream/open") >= 0) { res.writeHead(200); res.end('{"id":"s1"}'); return; }
      if (req.url.indexOf("/stream/") >= 0) { res.writeHead(200); res.end('{"partial":"太咸"}'); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "好嘞咸腌" }));   // 本地小模型的典型误识
    });
  });
  return server;
}

const PCM = new Int16Array(3200).map((_, i) => Math.round(3000 * Math.sin(i / 8)));

function loadAsr(configObj) {
  const file = path.join(tmp, "cfg.json");
  fs.writeFileSync(file, JSON.stringify(configObj));
  process.env.COOK_ASR_CONFIG = file;
  delete require.cache[require.resolve(path.join(tmp, "asr.js"))];
  return require(path.join(tmp, "asr.js"));
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push("ok   " + name); }
  catch (e) { results.push("FAIL " + name + " → " + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  const cloud = startServer("cloud");
  const local = startServer("local");
  await new Promise((r) => cloud.listen(0, "127.0.0.1", r));
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const cloudUrl = "http://127.0.0.1:" + cloud.address().port + "/v1/audio/transcriptions";
  const localBase = "http://127.0.0.1:" + local.address().port;

  // ---- 1. 只配本地：行为和以前完全一样 ----
  await check("没配 asr.final → finalReady=false，走本地 /asr", async () => {
    const asr = loadAsr({ asr: { endpoint: localBase + "/asr", apiKey: "local", model: "vosk-small-cn" } });
    assert.strictEqual(asr.finalReady, false);
    assert.strictEqual(asr.streamConfig.endpoint, localBase + "/asr");
    const text = await asr.transcribe(PCM, 16000, ["太咸了", "下一步"]);
    assert.strictEqual(text, "好嘞咸腌");
    assert.strictEqual(state.cloudHits, 0, "不该碰云端");
    assert.ok(state.lastLocalBody.indexOf("vosk-small-cn") >= 0);
    assert.ok(state.lastLocalBody.indexOf("vocab") >= 0, "本地老路要把词表一起传");
  });

  // ---- 2. 配了云端：精识别走云端，且不带词表（OpenAI 接口不接受） ----
  await check("配 asr.final → 走云端，模型名/文件都对", async () => {
    state.cloudHits = 0;
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: { endpoint: cloudUrl, model: "FunAudioLLM/SenseVoiceSmall", apiKey: "sk-test-0000000000000000", timeoutMs: 3000 },
      },
    });
    assert.strictEqual(asr.finalReady, true);
    const text = await asr.transcribe(PCM, 16000, ["太咸了"]);
    assert.strictEqual(text, "太咸了", "应该用云端的准确结果，而不是本地的「好嘞咸腌」");
    assert.strictEqual(state.cloudHits, 1);
    assert.ok(state.lastCloudBody.indexOf("SenseVoiceSmall") >= 0);
    assert.ok(state.lastCloudBody.indexOf("filename=\"utterance.wav\"") >= 0);
    assert.strictEqual(state.lastCloudBody.indexOf("name=\"vocab\""), -1, "云端不该收到词表");
  });

  // ---- 3. 云端 401 → 自动退回本地 ----
  await check("云端 401 → 退回本地结果（不返回空）", async () => {
    state.cloudMode = "auth";
    state.localHits = 0;
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: { endpoint: cloudUrl, model: "m", apiKey: "sk-x", timeoutMs: 2000 },
      },
    });
    const text = await asr.transcribe(PCM, 16000, []);
    assert.strictEqual(text, "好嘞咸腌");
    assert.ok(state.localHits > 0, "本地兜底应该被调用");
    state.cloudMode = "ok";
  });

  // ---- 4. 云端超时 → 退回本地，且总耗时不失控 ----
  await check("云端超时 → 退回本地，总耗时 < 1.2s", async () => {
    state.cloudMode = "slow";
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: { endpoint: cloudUrl, model: "m", apiKey: "sk-x", timeoutMs: 250 },
      },
    });
    const t0 = Date.now();
    const text = await asr.transcribe(PCM, 16000, []);
    const ms = Date.now() - t0;
    assert.strictEqual(text, "好嘞咸腌");
    assert.ok(ms < 1200, "耗时 " + ms + "ms 太久");
    state.cloudMode = "ok";
  });

  // ---- 5. 云端返回空 → 也退回本地 ----
  await check("云端返回空文本 → 退回本地", async () => {
    state.cloudMode = "empty";
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: { endpoint: cloudUrl, model: "m", apiKey: "sk-x" },
      },
    });
    const text = await asr.transcribe(PCM, 16000, []);
    assert.strictEqual(text, "好嘞咸腌");
    state.cloudMode = "ok";
  });

  // ---- 6. 流式那一路永远留在本地（换云端不能把实时字幕弄坏） ----
  await check("流式/探活仍指向本地服务", async () => {
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: { endpoint: cloudUrl, model: "m", apiKey: "sk-x" },
      },
    });
    assert.strictEqual(await asr.ping(), true);
    const id = await asr.streamOpen(["太咸了"]);
    assert.strictEqual(id, "s1");
    const partial = await asr.streamFeed("s1", Buffer.from("abc"));
    assert.strictEqual(partial, "太咸");
  });

  // ---- 7. 一个文件同时管大脑和耳朵：llm.json 里 llm 平铺 + asr 段 ----
  await check("llm.json 一个文件同时配置大脑与耳朵", async () => {
    const asr = loadAsr({
      endpoint: "http://127.0.0.1:1/v1/chat/completions",
      model: "Qwen/Qwen3-8B",
      apiKey: "sk-x",
      asr: { final: { endpoint: cloudUrl, model: "FunAudioLLM/SenseVoiceSmall", apiKey: "sk-x" } },
    });
    assert.strictEqual(asr.finalReady, true);
    assert.strictEqual(asr.streamConfig.endpoint, "http://127.0.0.1:5001/asr", "没写 asr.stream 时默认本机 5001");
  });

  // ---- 8. 云端配两家：第一家 401，自动换第二家 ----
  await check("多路云端：第一家 401 → 第二家接住", async () => {
    const cloud2 = startServer("cloud2");
    await new Promise((r) => cloud2.listen(0, "127.0.0.1", r));
    const cloud2Url = "http://127.0.0.1:" + cloud2.address().port + "/v1/audio/transcriptions";
    state.cloudMode = "auth";
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: [
          { endpoint: cloudUrl, model: "first", apiKey: "sk-x", timeoutMs: 1500 },
          { endpoint: cloud2Url, model: "second", apiKey: "sk-x", timeoutMs: 1500 },
        ],
      },
    });
    assert.strictEqual(asr.finalReady, true);
    assert.strictEqual(asr.finalCount, 2, "应该识别出两路");
    const text = await asr.transcribe(PCM, 16000, []);
    assert.strictEqual(text, "豆腐切块", "第一家失败后应该用第二家的结果");
    assert.strictEqual(state.cloudHits2, 1);
    state.cloudMode = "ok";
    cloud2.close();
  });

  // ---- 9. 垃圾结果过滤："." "Okay." 不能当成"听清了" ----
  await check("垃圾结果过滤：句点/Okay 视为没听清", async () => {
    const asr = loadAsr({ asr: { final: { endpoint: cloudUrl, model: "m", apiKey: "sk-x" } } });
    assert.strictEqual(asr.validText(""), null);
    assert.strictEqual(asr.validText("   "), null);
    assert.strictEqual(asr.validText("."), null);
    assert.strictEqual(asr.validText("。"), null);
    assert.strictEqual(asr.validText("Okay."), null);
    assert.strictEqual(asr.validText("um"), null);
    assert.strictEqual(asr.validText("太咸了"), "太咸了");
    assert.strictEqual(asr.validText("九"), "九");
    assert.strictEqual(asr.validText("第 9 道"), "第 9 道");
  });

  // ---- 10. 云端返回 "Okay." → 不算结果，退回本地 ----
  await check("云端只回 Okay. → 退回本地结果", async () => {
    state.cloudMode = "garbage";
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: { endpoint: cloudUrl, model: "m", apiKey: "sk-x" },
      },
    });
    const text = await asr.transcribe(PCM, 16000, []);
    assert.strictEqual(text, "好嘞咸腌");
    state.cloudMode = "ok";
  });

  // ---- 11. 多模态大模型"直接听"：audio_url base64 走 chat/completions ----
  await check("chat-audio 路：音频 base64 交给大模型转写", async () => {
    const omni = startServer("omni");
    await new Promise((r) => omni.listen(0, "127.0.0.1", r));
    const omniUrl = "http://127.0.0.1:" + omni.address().port + "/v1/chat/completions";
    const asr = loadAsr({
      asr: {
        final: [{ kind: "chat-audio", endpoint: omniUrl, model: "Qwen/Qwen3-Omni-30B", apiKey: "sk-x", timeoutMs: 1500 }],
      },
    });
    const text = await asr.transcribe(PCM, 16000, []);
    assert.strictEqual(text, "我想吃酸辣土豆丝");
    assert.ok(state.lastOmniBody.indexOf("data:audio/wav;base64,") >= 0, "要把音频编成 data URL");
    assert.ok(state.lastOmniBody.indexOf("Qwen/Qwen3-Omni-30B") >= 0);
    omni.close();
  });

  // ---- 12. 火山（豆包同源）极速版：双凭据 + base64 + 热词表 ----
  await check("火山极速版：正确 header、base64 音频、热词表、解析 result.text", async () => {
    const volc = startServer("volc");
    await new Promise((r) => volc.listen(0, "127.0.0.1", r));
    const volcUrl = "http://127.0.0.1:" + volc.address().port + "/api/v3/auc/bigmodel/recognize/flash";
    const asr = loadAsr({
      asr: {
        final: [{ kind: "volc-flash", endpoint: volcUrl, appId: "app-1", accessToken: "tok-1", timeoutMs: 2000 }],
      },
    });
    assert.strictEqual(asr.finalReady, true, "有 appId+accessToken 就该启用");
    assert.strictEqual(asr.finalCount, 1);
    const text = await asr.transcribe(PCM, 16000, ["麻婆豆腐", "糖醋排骨", "太咸了"]);
    assert.strictEqual(text, "麻婆豆腐");
    const sent = JSON.parse(state.lastVolcBody);
    assert.ok(sent.audio.data.length > 100, "音频要 base64 直传");
    assert.strictEqual(sent.audio.format, "wav");
    assert.strictEqual(sent.request.model_name, "bigmodel");
    assert.ok(sent.request.corpus.context.indexOf("麻婆豆腐") >= 0, "热词表要带上菜名");
    assert.ok(sent.request.corpus.context.indexOf("太咸了") >= 0, "热词表要带上口令词");
    volc.close();
  });

  // ---- 13. 火山新版控制台：一个 API Key 就够（不用 appid）----
  await check("火山新版单 Key：只发 X-Api-Key，不带 appid/access-token", async () => {
    const srv = startServer("volc-key");
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + srv.address().port + "/api/v3/auc/bigmodel/recognize/flash";
    const asr = loadAsr({
      asr: { final: [{ kind: "volc-flash", endpoint: url, apiKey: "key-abc", timeoutMs: 2000 }] },
    });
    assert.strictEqual(asr.finalReady, true, "只填 apiKey 也该启用（新控制台写法）");
    const text = await asr.transcribe(PCM, 16000, ["糖醋排骨"]);
    assert.strictEqual(text, "糖醋排骨");
    assert.ok(state.lastVolcBody.indexOf("bigmodel") >= 0);
    srv.close();
  });

  // ---- 14. 火山说「没人说话」(20000003) → 当作空结果，退回本地，不算故障 ----
  await check("火山 20000003（没人说话）→ 退回本地结果", async () => {
    const silent = startServer("volc-silent");
    await new Promise((r) => silent.listen(0, "127.0.0.1", r));
    const url = "http://127.0.0.1:" + silent.address().port + "/x";
    const asr = loadAsr({
      asr: {
        stream: { endpoint: localBase + "/asr", model: "vosk-small-cn" },
        final: [{ kind: "volc-flash", endpoint: url, appId: "a", accessToken: "t", timeoutMs: 1500 }],
      },
    });
    const text = await asr.transcribe(PCM, 16000, []);
    assert.strictEqual(text, "好嘞咸腌", "应该退回本地整句识别");
    silent.close();
  });

  cloud.close();
  local.close();
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.indexOf("FAIL") === 0).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " 通过");
})();
