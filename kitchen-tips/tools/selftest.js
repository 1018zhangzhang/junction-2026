"use strict";

// 离线自测：不需要 IrisView 环境、不需要网络、不需要密钥。
// 用法：node tools/selftest.js
// 覆盖状态机、意图识别、JSON 容错、WAV 封装 —— 这几块最容易写完就错，而且评委看不到。
const stateModule = require("../src/state");
const intentModule = require("../src/intent");
const llm = require("../src/llm");
const configModule = require("../src/config");

const { PHASE, MODE, reduce, create, remainingSec } = stateModule;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("PASS  " + name);
  } else {
    failed += 1;
    console.log("FAIL  " + name + (detail ? "  -> " + detail : ""));
  }
}

function recipe() {
  return {
    dish: "番茄炒蛋",
    steps: [
      { no: 1, action: "打 3 个蛋，加一小勺盐", usage: "3 个", durationSec: 0, fire: "" },
      { no: 2, action: "热锅倒油，油热后倒蛋液", usage: "两勺", durationSec: 30, fire: "中火" },
      { no: 3, action: "炒散盛出，再炒番茄", usage: "", durationSec: 120, fire: "大火" }
    ]
  };
}

// ---------- 状态机 ----------
let s = create();
check("初始状态是待命", s.phase === PHASE.IDLE && s.steps.length === 0);

s = reduce(s, { type: "REQUEST", seq: 1 });
check("请求后进入处理中", s.phase === PHASE.WORKING && s.seq === 1);

s = reduce(s, { type: "PARSE_OK", seq: 1, recipe: recipe(), now: 1000 });
check("解析成功后进入完成", s.phase === PHASE.DONE && s.steps.length === 3);
check("无时长的首步不建计时", s.timer === null);

let stale = reduce(s, { type: "PARSE_OK", seq: 0, recipe: { dish: "旧结果", steps: [{ no: 1, action: "不该出现", usage: "", durationSec: 0, fire: "" }] }, now: 2000 });
check("旧结果不得覆盖新结果", stale.dish === "番茄炒蛋" && stale.steps.length === 3 && stale.note === "stale-dropped");
check("丢弃计数被记录", stale.droppedCount === 1);

const beforeTimer = s.timer;
s = reduce(s, { type: "NEXT", now: 5000 });
check("推进到第二步", s.stepIndex === 1);
check("切步骤后计时重建", s.timer !== null && s.timer.startedAt === 5000 && s.timer !== beforeTimer);

s = reduce(s, { type: "NEXT", now: 6000 });
s = reduce(s, { type: "NEXT", now: 7000 });
check("最后一步不再越界", s.stepIndex === 2 && s.hint === "已经是最后一步");

s = reduce(s, { type: "PREV", now: 8000 });
check("可以退回上一步", s.stepIndex === 1);

s = reduce(s, { type: "SET_MODE", mode: MODE.TIMER });
check("布局切换到计时放大", s.mode === MODE.TIMER);

s = reduce(s, { type: "SET_FIELDS", fields: ["usage", "duration"] });
check("内容调整只保留指定字段", Array.isArray(s.fields) && s.fields.length === 2);

s = reduce(s, { type: "CORRECT", from: "3 个蛋", to: "2 个蛋", now: 9000 });
check("纠正确实改写了步骤文本", s.steps[0].action.indexOf("2 个蛋") >= 0);

s = reduce(s, { type: "AMEND", object: "少许糖", now: 9500 });
check("补充调料进入用量", s.steps[1].usage.indexOf("少许糖") >= 0);

const expired = reduce(reduce(s, { type: "TICK", now: 70000 }), { type: "TICK", now: 70000 });
check("计时到点被标记", expired.timer === null || expired.timer.expired === true || expired.hint === "时间到");

const last = reduce(s, { type: "RESET" });
check("重置回到待命", last.phase === PHASE.IDLE && last.steps.length === 0);

// ---------- 意图识别 ----------
const cases = [
  ["做番茄炒蛋", "new_recipe"],
  ["红烧肉怎么做", "new_recipe"],
  ["下一步", "next"],
  ["好了", "next"],
  ["上一步", "prev"],
  ["不是三个蛋，是两个", "correct"],
  ["只保留用量和时长", "content"],
  ["把计时放大", "layout"],
  ["只显示接下来两步", "layout"],
  ["取消", "cancel"],
  ["重来", "reset"],
  ["加点那个", "ambiguous"]
];

for (const [text, expected] of cases) {
  const got = intentModule.detect(text);
  check("意图「" + text + "」→ " + expected, got.kind === expected, "实际 " + got.kind);
}

const layoutIntent = intentModule.detect("把计时放大");
check("放大计时映射到 timer 模式", layoutIntent.mode === "timer");
const contentIntent = intentModule.detect("只保留用量和时长");
check("内容指令解析出字段", contentIntent.fields.indexOf("usage") >= 0 && contentIntent.fields.indexOf("duration") >= 0);
const correctIntent = intentModule.detect("不是三个蛋，是两个");
check("纠正解析出前后值", correctIntent.from === "三个蛋" && correctIntent.to === "两个");

// ---------- JSON 容错 ----------
const fenced = llm.extractJson('好的，结果如下：\n```json\n{"dish":"粥","steps":[{"action":"洗米"}]}\n```\n请查收');
check("能抠出围栏里的 JSON", fenced && fenced.dish === "粥");
const noisy = llm.extractJson('{"dish":"面","steps":[{"action":"烧水"}]} 以上');
check("能抠出前后带废话的 JSON", noisy && noisy.dish === "面");
const broken = llm.extractJson("这不是 JSON");
check("非 JSON 返回 null", broken === null);

// ---------- WAV 封装 ----------
const wav = llm.pcmToWav([Buffer.alloc(640), Buffer.alloc(640)], 16000);
check("WAV 头是 RIFF", wav.slice(0, 4).toString("ascii") === "RIFF");
check("WAV 长度正确", wav.length === 44 + 1280);
check("WAV 采样率写入正确", wav.readUInt32LE(24) === 16000);

// ---------- 配置 ----------
const cfg = configModule.load();
check("未配置时 llmReady 为 false", cfg.llmReady === false);
const summary = configModule.summarize(cfg);
check("配置摘要不含密钥字段", !("apiKey" in summary));

// ---------- 汇总 ----------
console.log("");
console.log("PASS " + passed + " / FAIL " + failed);
if (failed > 0) process.exitCode = 1;
