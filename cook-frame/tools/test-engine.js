"use strict";
// ============================================================================
// 引擎回归测试（改词表/改正则之后必须跑一遍）
// ----------------------------------------------------------------------------
//   node tools/test-engine.js
//
// 覆盖：翻页/回退/跳过、否定句、救场、提问、重听、改量，
// 以及「怎么知道好了」这类容易误判成翻页的长句。
// 期望值来自厨房场景的真实行为，不是某一套语料的标注口径。
// ============================================================================

const { parseUtterance, createSession } = require("../src/engine");
const { DISHES } = require("../src/recipe");

const session = createSession(DISHES[0]);
const step = session.currentStep();

const CASES = [
  // 推进
  ["下一步", "NEXT"], ["好了", "NEXT"], ["可以了", "NEXT"], ["做好了", "NEXT"],
  ["行了", "NEXT"], ["然后呢", "NEXT"], ["接着做", "NEXT"], ["这步做完了", "NEXT"],
  // 收尾只认明确的
  ["完成了", "FINISH"], ["都做完了", "FINISH"], ["出锅了", "FINISH"], ["收工", "FINISH"],
  // 回退
  ["上一步", "BACK"], ["退回去", "BACK"], ["回到前面", "BACK"], ["刚才那步", "BACK"],
  // 跳过
  ["跳过", "SKIP"], ["略过", "SKIP"], ["这步不用了", "SKIP"],
  // 否定：一个字都不能推进
  ["还没好", "DEFER"], ["先别下一步", "DEFER"], ["等一下", "DEFER"],
  ["不用继续了", "UNKNOWN"], ["我不想做这一步", "UNKNOWN"],
  // 否定指向别的动作时，要放行
  ["别停继续", "NEXT"],
  // 救场
  ["太咸了", "RESCUE"], ["淡了", "RESCUE"], ["糊了", "RESCUE"], ["油冒烟了", "RESCUE"],
  ["糖放多了", "RESCUE"], ["盐放多了", "RESCUE"], ["还没熟", "RESCUE"],
  // 提问（原来全灭的火候/时长/进度/熟度）
  ["盐放多少", "ASK"], ["怎么知道好了", "ASK"], ["多大火", "ASK"], ["几分钟", "ASK"],
  ["一共几步", "ASK"], ["怎么切", "ASK"], ["要煮三分钟吗", "ASK"], ["熟了没", "ASK"],
  // 重听
  ["再说一遍", "REPEAT"], ["没听清", "REPEAT"], ["念一遍", "REPEAT"], ["你说啥", "REPEAT"],
  // 改量
  ["我说错了 半勺", "CORRECT"], ["改成两勺", "CORRECT"], ["不对，半勺", "CORRECT"],
  // 无关句子不动作
  ["今天天气不错", "UNKNOWN"],
  // 指令被听错一个字（同音容错第二遍）：只有第一遍没听懂时才纠
  ["吓一步", "NEXT"], ["号了", "NEXT"], ["太闲了", "RESCUE"],
  ["呼了", "RESCUE"], ["挺一下", "DEFER"], ["火太大了", "RESCUE"],
  // 容错不能把正常句子改坏：这些必须保持原判断
  ["吓我一跳", "UNKNOWN"], ["号码是多少", "ASK"], ["我还没号呢", "DEFER"],
  ["别停继续", "NEXT"]
];

let bad = 0;
for (const [text, expect] of CASES) {
  const u = parseUtterance(text, step);
  if (u.type !== expect) {
    bad += 1;
    console.log("✗ " + text.padEnd(12) + " → " + u.type + "  (期望 " + expect + ")  归一后:" + u.corrected);
  }
}
console.log((bad ? "✗ 失败 " : "✓ 全部通过 ") + (CASES.length - bad) + "/" + CASES.length);
process.exit(bad ? 1 : 0);
