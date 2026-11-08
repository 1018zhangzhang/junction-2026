"use strict";
// ============================================================================
// 用队友的语料（corpus.jsonl / holdout / blind）评我们的引擎
// ----------------------------------------------------------------------------
// 为什么要有这个：队友的 189 条语料是「真实说法」的样本，拿它跑我们的
// parseUtterance + 选菜匹配，能量化出「我们到底漏了哪些说法」，比凭感觉补词准。
//
// 用法：
//   node tools/eval-corpus.js /path/to/backend/tests
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");
const { parseUtterance, createSession } = require("../src/engine");
const { DISHES } = require("../src/recipe");

// 只认「整句就是在报编号」的短句（"3" / "第三道" / "我要 3"）。
// 以前这里借 menu.pickByNumber，可那套是按「4 道一页」算的，只认 1-4，
// 评估时 5 往后的编号全被判错。现在直接对整个菜单取号。
const CN_NUM = { "一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10 };
function pickByNumber(text) {
  const t = String(text || "");
  if (t.length > 12) return -1;          // 太长多半是在说话，不是在报数
  for (const ch of t) {
    const n = /[0-9]/.test(ch) ? Number(ch) : CN_NUM[ch];
    if (n && n >= 1 && n <= DISHES.length) return n - 1;
  }
  return -1;
}

const corpusDir = process.argv[2] || ".";
const files = [
  { name: "主语料", file: "corpus.jsonl" },
  { name: "留出集", file: "corpus_holdout.jsonl" },
  { name: "盲测集", file: "corpus_blind.jsonl" }
];

// 我们的意图 → 队友的意图族（判分用；一个 expect 可接受多个 type）
const ACCEPT_TYPE = {
  next_step: ["NEXT", "SKIP", "ACCEPT", "FINISH"],
  prev_step: ["BACK"],
  repeat: ["REPEAT"],
  ask_heat: ["ASK"],
  ask_duration: ["ASK"],
  ask_doneness: ["ASK", "RESCUE"],
  ask_amount: ["ASK", "CORRECT"],
  ask_technique: ["ASK"],
  ask_order: ["ASK"],
  ask_global: ["ASK"],
  modify: ["SKIP", "CORRECT", "ASK", "NEXT"],
  control: ["DEFER", "FINISH", "RETRACT", "UNKNOWN", "ACCEPT"],
  // 「还没好 / 先别下一步 / 我不想做」= 什么都不该做
  unknown: ["UNKNOWN", "DEFER", "FALLBACK", "ACCEPT"],
  error_report: ["RESCUE", "CORRECT"]
};

// 和 index.js 的 matchDish 同逻辑（菜单层，不在 engine 里）
function dishNegated(text, pos) {
  if (pos <= 0) return false;
  const head = String(text).slice(Math.max(0, pos - 3), pos);
  return /(不要|不想|不用|不吃|不做|别|算了)/.test(head);
}
function matchDish(text) {
  const t = String(text);
  for (let i = 0; i < DISHES.length; i++) {
    const at = t.indexOf(DISHES[i].title);
    if (at >= 0 && !dishNegated(t, at)) return i;
  }
  for (let i = 0; i < DISHES.length; i++) {
    for (const w of (DISHES[i].vocab || [])) {
      const at = t.indexOf(w);
      if (at >= 0 && !dishNegated(t, at)) return i;
    }
  }
  return pickByNumber(t);
}

const session = createSession(DISHES[0]);
const step = session.currentStep();

function judge(row) {
  const text = String(row.text || "");
  if (row.expect === "select_dish") {
    const hit = matchDish(text);
    return { ok: hit >= 0, got: hit >= 0 ? "select_dish:" + DISHES[hit].title : "no_dish" };
  }
  const u = parseUtterance(text, step);
  return { ok: (ACCEPT_TYPE[row.expect] || []).includes(u.type), got: u.type };
}

let total = 0;
let allOk = 0;
const report = [];

for (const { name, file } of files) {
  const p = path.join(corpusDir, file);
  if (!fs.existsSync(p)) { console.log("跳过（找不到）: " + p); continue; }
  const rows = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  let ok = 0;
  const miss = [];
  for (const r of rows) {
    const res = judge(r);
    if (res.ok) ok += 1;
    else miss.push(r.text + "  [" + r.expect + " → " + res.got + "]");
  }
  total += rows.length;
  allOk += ok;
  const rate = ((ok / rows.length) * 100).toFixed(1);
  report.push({ name, n: rows.length, ok, rate });
  console.log("\n" + name + ": " + ok + "/" + rows.length + " = " + rate + "%");
  if (miss.length) console.log("  未命中 " + miss.length + " 条：\n    " + miss.slice(0, 25).join("\n    "));
}

console.log("\n================ 合计 ================");
for (const r of report) console.log(r.name + "\t" + r.ok + "/" + r.n + "\t" + r.rate + "%");
console.log("总计\t" + allOk + "/" + total + "\t" + ((allOk / total) * 100).toFixed(1) + "%");
