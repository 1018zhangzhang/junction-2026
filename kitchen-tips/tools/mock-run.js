"use strict";

// 无环境联调：用假的 @irisview/osx 模块把应用跑起来，验证接线是否正确。
// 这一步能在没有 Ubuntu / 模拟器的电脑上抓掉大部分"一启动就崩"的问题。
// 用法：node tools/mock-run.js
const Module = require("node:module");

process.env.LLM_ENDPOINT = "https://mock.local/v1/chat/completions";
process.env.LLM_MODEL = "mock-model";
process.env.LLM_API_KEY = ["mock", "not-a-real", "key"].join("-");

const RECIPE = {
  dish: "番茄炒蛋",
  steps: [
    { action: "打 3 个蛋，加一小勺盐", usage: "3 个", durationSec: 0, fire: "" },
    { action: "热锅倒油，倒入蛋液", usage: "两勺", durationSec: 30, fire: "中火" },
    { action: "炒散盛出，再炒番茄", usage: "两个", durationSec: 120, fire: "大火" }
  ]
};

const seenTexts = new Set();
const created = [];
let pendingFrame = null;
let appCallback = null;
const queue = [];

function style() {
  return {
    setTextColor() {},
    setTextFont() {},
    setTextAlign() {},
    setBackgroundColor() {},
    setTextOpacity() {}
  };
}

function widget(kind) {
  const node = {
    kind,
    text: "",
    hidden: false,
    setParent() {},
    setIgnoreLayout() {},
    setPosition() {},
    setSize() {},
    setText(value) {
      node.text = String(value);
      if (node.text) seenTexts.add(node.text);
    },
    setHidden(value) {
      node.hidden = Boolean(value);
    },
    getLocalStyle() {
      return style();
    },
    setLongMode() {},
    setHeightByLineCount() {}
  };
  created.push(node);
  return node;
}

const fusionui = {
  Board: { create: () => widget("board") },
  View: { create: () => widget("view") },
  Text: Object.assign({ create: () => widget("text") }, { LongMode: { LONG_WRAP: 0, LONG_DOT_END: 3 } }),
  Color: { fromRGB8: (r, g, b) => ({ r, g, b }) },
  Font: { getCachedFont: () => ({ size: 0 }), getDefault: () => ({}) },
  TextAlign: { AUTO: 0, LEFT_MID: 4, CENTER: 5, RIGHT_MID: 6 },
  FusionRoot: { acquireFusionRootFromWindow: () => ({ getRootWidget: () => widget("root") }) }
};

const os = {
  App: {
    createApp: (callback) => {
      appCallback = callback;
    }
  },
  AppLifecycle: { ON_CREATE: 0, ON_DESTROY: 1, ON_FOREGROUND: 2, ON_BACKGROUND: 3, ON_REOPEN: 4 },
  WindowProperty: { create: () => ({ setTitle() {}, setSize() {} }) },
  Window: { create: () => ({}) },
  requestAnimationFrame: (callback) => {
    pendingFrame = callback;
    return 1;
  },
  cancelAnimationFrame: () => {
    pendingFrame = null;
  }
};

const input = {
  takeTextInput: () => (queue.length ? { source: "keyboard", text: queue.shift() } : null),
  getVoiceInputAvailability: () => ({
    supported: true,
    declared: true,
    canRequest: false,
    ready: false,
    reason: "permission-required"
  }),
  requestVoiceInput: () => {
    const error = new Error("not allowed in mock");
    error.code = "permission-required";
    throw error;
  }
};

const originalLoad = Module._load;
Module._load = function patched(request) {
  if (request === "@irisview/osx/os") return os;
  if (request === "@irisview/osx/fusionui") return fusionui;
  if (request === "@irisview/osx/os/input") return input;
  return originalLoad.apply(this, arguments);
};

// 假模型接口：返回标准 OpenAI 结构，验证"返回 → 校验 → 渲染"整条链路
global.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(RECIPE) } }]
    })
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function step() {
  const callback = pendingFrame;
  pendingFrame = null;
  if (typeof callback === "function") callback();
  else return false;
  return true;
}

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

async function main() {
  require("../src/index.js");

  check("注册了应用生命周期回调", typeof appCallback === "function");
  appCallback(0); // ON_CREATE
  check("创建了画布与文字控件", created.length >= 10, "控件数 " + created.length);
  check("待命文案已渲染", seenTexts.has("等待指令"));

  await sleep(80);
  step();
  check("帧循环被驱动", pendingFrame !== null);
  check("提示语显示在界面上", [...seenTexts].some((text) => text.indexOf("番茄炒蛋") >= 0));

  // 注入一条文字输入，走完整的"输入 → 意图 → 模型 → 渲染"
  queue.push("做番茄炒蛋");
  step();
  await sleep(120);
  step();

  check("模型结果渲染成步骤", [...seenTexts].some((text) => text.indexOf("打 3 个蛋") >= 0));
  check("步骤计数已显示", [...seenTexts].some((text) => text.indexOf("第 1/3 步") >= 0));
  check("下一步预告已显示", [...seenTexts].some((text) => text.indexOf("下一步") >= 0));

  // 连续调整一：先推进到有计时的步骤，再放大大计时（真实演示也是这个顺序）
  queue.push("下一步");
  step();
  await sleep(80);
  step();

  queue.push("把计时放大");
  step();
  await sleep(80);
  step();
  check("布局调整后计时区变大", created.some((node) => node.kind === "text" && node.text && /^\d+:\d{2}$/.test(node.text)));

  // 连续调整二：改内容
  queue.push("只保留用量和时长");
  step();
  await sleep(80);
  step();
  check("内容调整后仍有步骤文案", [...seenTexts].some((text) => text.indexOf("打 3 个蛋") >= 0));

  // 旧结果作废：先发新请求，再让旧请求回来
  queue.push("下一步");
  step();
  await sleep(80);
  step();

  // 异常路径：把模型地址改坏，确认能落到"异常"状态而不是卡死
  queue.push("重来");
  step();
  await sleep(60);
  step();
  check("重置后回到待命文案", [...seenTexts].some((text) => text.indexOf("等待指令") >= 0));

  console.log("");
  console.log("PASS " + passed + " / FAIL " + failed);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.log("MOCK_RUN_FAILED " + String((error && error.stack) || error));
  process.exitCode = 1;
});
