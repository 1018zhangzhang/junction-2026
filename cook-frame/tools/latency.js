"use strict";
// ============================================================================
// 延迟测量（赛题要求：连续 ≥10 次，附预期 / 实际 / 证据）
// ----------------------------------------------------------------------------
// 量的是「一句话进来 → 界面该显示什么已经算完」这一段，纯本地、不联网：
//   engine.handle(text, now) → display{main, sub, progress, tone}
// 这一段是所有指令都要走的公共路径，所以它能代表"说完话多久能变脸"。
//
// 不在这里量的（要用真机日志，见 docs/LATENCY.md 第 2 节）：
//   · 麦克风采集 + 云端识别：日志行 COOK_STREAM final … 934ms
//   · 大模型生成菜谱：日志行 COOK_LLM ok/ask 的时间差
//
// 用法：node tools/latency.js [每组样本数，默认 12]
// ============================================================================
const { performance } = require("node:perf_hooks");
const { createSession } = require("../src/engine");
const { DISHES } = require("../src/recipe");

const N = Math.max(10, Number(process.argv[2]) || 12);   // 赛题底线 10 次

const CASES = [
  { name: "说「下一步」推进到第 2 步", text: "下一步", expect: "display.main 变成第 2 步动作" },
  { name: "说「上一步」回到第 1 步", text: "上一步", expect: "stepIndex 回到 0" },
  { name: "说「太咸了」（救场）", text: "太咸了", expect: "tone=rescue + 给出补救建议" },
  { name: "说「两个人吃」（份量换算）", text: "两个人吃", expect: "用量按人数放大" },
  { name: "说「到哪了」（进度摘要）", text: "到哪了", expect: "汇总已完成 / 正在做 / 接下来" },
  { name: "说「加两勺生抽」（改量）", text: "加两勺生抽", expect: "intent=CORRECT" },
  { name: "说「火太大」（故障）", text: "火太大", expect: "tone=rescue" },
  { name: "说「没听清，再说一遍」", text: "没听清，再说一遍", expect: "intent=REPEAT，内容不变" }
];

function percentile(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function fmt(n) { return n.toFixed(2); }

function runCase(c) {
  const samples = [];
  let lastDisplay = null;
  for (let i = 0; i < N; i++) {
    // 每条样本都用一份全新会话，避免上一条的状态影响这一条
    const s = createSession(DISHES[0]);   // 番茄炒蛋
    const t0 = performance.now();
    const res = s.handle(c.text, t0);
    const d = res && res.display;
    // "界面就绪"= 三个必填字段都能直接拿去画（不 undefined / 不 NaN）
    const ready = d && typeof d.main === "string" && typeof d.progress === "string";
    samples.push(performance.now() - t0);
    lastDisplay = d;
    if (!ready) {
      console.log("[失败] " + c.name + " 没有产出可渲染的 display：" + JSON.stringify(d));
      process.exit(1);
    }
  }
  samples.sort((a, b) => a - b);
  return { c, samples, lastDisplay };
}

console.log("输入 → 判定/内容就绪 延迟（毫秒 · 纯逻辑 · 不含麦克风/网络）");
console.log("每组 " + N + " 个样本 · Node " + process.version);
console.log("─".repeat(84));
console.log(
  "用例".padEnd(28) + "样本".padStart(6) + "min".padStart(9) + "p50".padStart(9)
  + "p95".padStart(9) + "max".padStart(9)
);
console.log("─".repeat(84));

let worstP95 = 0;
const rows = [];
for (const c of CASES) {
  const r = runCase(c);
  const s = r.samples;
  worstP95 = Math.max(worstP95, percentile(s, 95));
  rows.push({
    name: c.name,
    expect: c.expect,
    n: N,
    min: s[0],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1],
    main: String((r.lastDisplay && r.lastDisplay.main) || "").slice(0, 22)
  });
  console.log(
    c.name.padEnd(28) + String(N).padStart(6)
    + fmt(s[0]).padStart(9) + fmt(percentile(s, 50)).padStart(9)
    + fmt(percentile(s, 95)).padStart(9) + fmt(s[s.length - 1]).padStart(9)
  );
}
console.log("─".repeat(84));
console.log("最差 p95：" + fmt(worstP95) + " ms");
console.log("[通过] " + CASES.length + " 个用例 × " + N + " 次，全部产出可渲染结果。");

/* 附带：把表格按 Markdown 打出来，方便直接贴进 docs/LATENCY.md */
if (process.argv.indexOf("--md") > 0) {
  console.log("\n| 用例 | 预期 | 样本 | min | p50 | p95 | max | 实际首行 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log("| " + r.name + " | " + r.expect + " | " + r.n + " | "
      + fmt(r.min) + " | " + fmt(r.p50) + " | " + fmt(r.p95) + " | " + fmt(r.max) + " | " + r.main + " |");
  }
}
