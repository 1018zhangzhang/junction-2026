"use strict";
// ============================================================================
// 救场（说"太咸了/糊了"这类）端到端回归
// ----------------------------------------------------------------------------
// 为什么要有这个测试：救场坏了有两个完全不同的原因，表象却一样（"说了没反应"）：
//   ① 引擎不认识这句话（判断层）—— 用 parseUtterance 能测出来
//   ② 识别词表里没有这些词，小模型拼不出来（耳朵）—— 真实现场就是这么坏的：
//      用户说「太咸了」，日志里识别成「好嘞咸腌」「生抽可乐」。
// 所以这个测试同时检查两头：每类故障至少有一个"能说出口"的词进了词表，
// 且引擎能把那个词判成救场，且每道菜都真的给得出答案。
//
// 跑法：node tools/test-rescue.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const { parseUtterance, createSession } = require("../src/engine");
const { DISHES } = require("../src/recipe");

const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");

// ---- 从 index.js 里抽出真实词表（不另抄一份，避免测得是假逻辑）----
const s0 = src.indexOf("const RESCUE_VOCAB");
const s1 = src.indexOf("];", s0);
if (s0 < 0 || s1 < 0) {
  console.error("✗ 抽取失败：index.js 里找不到 RESCUE_VOCAB");
  process.exit(1);
}
const RESCUE_VOCAB = src
  .slice(s0, s1)
  .replace(/^[\s\S]*?\[/, "")
  .split(",")
  .map((x) => x.trim().replace(/^["']|["']$/g, ""))
  .filter(Boolean);

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  ✗    " + name + (extra ? "   " + extra : "")); }
}

const sess = createSession(DISHES[0]);
const step = sess.currentStep();

// ---- 1) 词表覆盖：11 类故障，每类都得有能说出口的词 ----
const NEED = ["咸", "淡", "甜", "糊", "老", "生", "干", "油温", "油多", "油少", "油溅"];
const covered = {};
for (const w of RESCUE_VOCAB) {
  const u = parseUtterance(w, step);
  if (u.type === "RESCUE" && u.trouble && u.trouble.key) {
    (covered[u.trouble.key] = covered[u.trouble.key] || []).push(w);
  }
}
console.log("一、词表能否「说出口」（" + RESCUE_VOCAB.length + " 个救场词）");
for (const k of NEED) {
  ok("故障「" + k + "」有可用词", !!covered[k], JSON.stringify(covered[k] || []));
}

// ---- 2) 每道菜 × 每类故障：必须给出救场回答 ----
console.log("\n二、11 道菜 × 11 类故障的救场回答");
const cases = ["太咸了", "太淡了", "太甜了", "糊了", "太老了", "没熟", "粘锅", "油冒烟了", "油太多了", "油少了", "溅油"];
for (let d = 0; d < DISHES.length; d++) {
  const s = createSession(DISHES[d]);
  s.handle("下一步", 1000);          // 走到第一步，别停在开场
  let bad = 0;
  const detail = [];
  for (const t of cases) {
    const r = s.handle(t, 2000);
    const main = (r && r.display && r.display.main) || "";
    const isRescue = r && r.display && r.display.tone === "rescue";
    const answered = isRescue && main.length >= 6 && !/没准备答案/.test(main);
    if (!answered) { bad++; detail.push(t + "→" + JSON.stringify(main)); }
  }
  ok(DISHES[d].title + "（" + cases.length + " 类全有答）", bad === 0, detail.join(" | "));
}

// ---- 3) 别把正常口令误判成救场 ----
console.log("\n三、不该误判成救场的话");
for (const t of ["下一步", "好了", "上一步", "加半勺盐", "开小火", "翻面"]) {
  const u = parseUtterance(t, step);
  ok(t + " → " + u.type, u.type !== "RESCUE");
}

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
if (fail) process.exit(1);
console.log("✓ 救场链路（词表 + 引擎 + 答库）全部通过");
