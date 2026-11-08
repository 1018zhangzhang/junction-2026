"use strict";
// ============================================================================
// 动态信息处理回归测试（进度摘要 / 份量换算 / 用量缩放）
//   node tools/test-dynamic.js
// 赛题「自动化」判定依据：摘要、筛选、计算都是现场算出来的，不是写死内容。
// ============================================================================

const { createSession, scaleAmounts } = require("../src/engine");
const { DISHES } = require("../src/recipe");

let bad = 0;
function t(name, cond) {
  if (!cond) { bad += 1; console.log("✗ " + name); }
}

// ---- scaleAmounts 单元测试 ----
t("两个鸡蛋×2 → 四个鸡蛋", scaleAmounts("打两个鸡蛋", 2).indexOf("四个鸡蛋") >= 0);
t("一撮盐×2 → 两撮盐", scaleAmounts("加一小撮盐", 2).indexOf("小撮") >= 0 && scaleAmounts("加一撮盐", 2).indexOf("两撮盐") >= 0);
t("时间不换算：十分钟不动", scaleAmounts("腌十分钟", 2).indexOf("十分钟") >= 0);
t("八分钟不动", scaleAmounts("大火蒸八分钟", 2).indexOf("八分钟") >= 0);
t("阿拉伯数字 2个×3 → 六个", scaleAmounts("放2个番茄", 3).indexOf("六个番茄") >= 0);
t("两面各划两刀×2 → 四刀", scaleAmounts("两面各划两刀", 2).indexOf("各划四刀") >= 0 || scaleAmounts("各划两刀", 2).indexOf("各划四刀") >= 0);
t("factor=1 原样返回", scaleAmounts("打两个鸡蛋", 1) === "打两个鸡蛋");
t("无数字文本不动", scaleAmounts("热锅倒油", 3) === "热锅倒油");
t("超过十用阿拉伯：3勺×5 → 15勺", /15|十五/.test(scaleAmounts("放3勺酱油", 5)));

// ---- 会话级：进度摘要 ----
const s = createSession(DISHES[0]);
s.handle("下一步", 1000);
s.handle("下一步", 1500);
let r = s.handle("现在到哪了", 2000);
t("进度 main = 已完成 2 步", r.display.main.indexOf("已完成 2 步") >= 0);
t("进度 sub 含接下来", (r.display.sub || "").indexOf("接下来") >= 0);
t("进度 actions", r.actions.indexOf("PROGRESS_SUMMARY") >= 0);
r = s.handle("上一步", 2500);
r = s.handle("做到哪了", 3000);
t("回退后摘要跟随", r.display.main.indexOf("已完成 1 步") >= 0);

// ---- 会话级：份量换算 ----
r = s.handle("两个人吃", 4000);
t("份量 main 提示人份", r.display.main.indexOf("人份") >= 0);
t("份量 actions", r.actions.indexOf("SERVINGS_SET") >= 0);
// 上一步后正停在「打三个鸡蛋」这一步（stepIndex=1）
r = s.present();
t("present 步骤用量已换算（六个鸡蛋）", (r.main + r.sub).indexOf("六个鸡蛋") >= 0);
r = s.handle("多做点", 5000);
t("多做点 → 四人份", /四|4/.test(r.display.main));
r = s.present();
t("四人份：12 个鸡蛋（超十用阿拉伯）", (r.main + r.sub).indexOf("12个鸡蛋") >= 0 || (r.main + r.sub).indexOf("十二个鸡蛋") >= 0);
r = s.handle("少做点", 6000);
t("少做点回到两人份", r.display.main.indexOf("两") >= 0);

// ---- 时间绝不翻倍（清蒸鲈鱼）----
const s2 = createSession(DISHES[7]);
s2.handle("两个人吃", 100);
const d2 = s2.present();
t("腌十分钟没翻倍", d2.main.indexOf("十分钟") >= 0 && d2.main.indexOf("二十分钟") < 0);
s2.handle("下一步", 200);
s2.handle("下一步", 300);           // 走到「大火蒸八分钟」
const d3b = s2.present();
t("蒸八分钟没翻倍", d3b.main.indexOf("八分钟") >= 0 && d3b.main.indexOf("十六分钟") < 0);

// ---- 原有口令不受影响 ----
const s3 = createSession(DISHES[0]);
r = s3.handle("下一步", 100);
t("下一步仍推进", r.actions.indexOf("STEP_ADVANCE") >= 0);
r = s3.handle("还没好", 200);
t("还没好仍 DEFER", r.actions.indexOf("DEFER_HOLD") >= 0);
r = s3.handle("太咸了怎么办", 300);
t("救场仍可用", r.actions.join(",").indexOf("RESCUE") >= 0 || r.display.tone === "rescue" || r.display.tone === "answer");

console.log(bad ? `✗ 失败 ${bad} 项` : "✓ 动态信息处理测试全部通过");
process.exit(bad ? 1 : 0);
