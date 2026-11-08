"use strict";
// ============================================================================
// 菜单翻页 · 纯函数单测（不碰 IrisView API）
// 覆盖：页数 / 页码循环 / 本页有几道 / 全局↔本页换算
// 为什么单独测：翻页错一位 = 说「3」选到别的菜，是最难现场解释的那种 bug
// ============================================================================

const mp = require("../src/menu-page");
let pass = 0, faild = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log("ok   " + name); }
  else { faild++; console.log("FAIL " + name + (extra ? "  → " + extra : "")); }
}

// ---- 页数 ----
t("0 道也算 1 页", mp.pageCount(0) === 1);
t("12 道 = 1 页", mp.pageCount(12) === 1);
t("13 道 = 2 页", mp.pageCount(13) === 2);
t("24 道 = 2 页", mp.pageCount(24) === 2);
t("25 道 = 3 页", mp.pageCount(25) === 3);
t("非法入参当 0", mp.pageCount(undefined) === 1 && mp.pageCount(-5) === 1);

// ---- 页码循环 ----
t("-1 → 最后一页", mp.clamp(-1, 25) === 2);
t("3 → 回到第 1 页", mp.clamp(3, 25) === 0);
t("2 → 第 3 页", mp.clamp(2, 25) === 2);

// ---- 本页几道 ----
t("13 道：第 1 页 12 道", mp.countOn(0, 13) === 12);
t("13 道：第 2 页 1 道", mp.countOn(1, 13) === 1);
t("11 道：唯一一页 11 道", mp.countOn(0, 11) === 11);
t("空菜单：0 道", mp.countOn(0, 0) === 0);

// ---- 全局 ↔ 本页 ----
t("index 0 → 第 1 页", mp.pageOf(0, 25) === 0);
t("index 12 → 第 2 页", mp.pageOf(12, 25) === 1);
t("index 24 → 第 3 页", mp.pageOf(24, 25) === 2);
t("第 2 页第一道 = 全局 12", mp.startOf(1, 25) === 12);
t("全局 12 在第 2 页是第 0 行", mp.localOf(12, 1, 25) === 0);
t("全局 12 不在第 1 页（-1）", mp.localOf(12, 0, 25) === -1);
t("第 2 页第 2 行 = 全局 13", mp.globalOf(1, 1, 25) === 13);
t("第 2 页第 12 行越界（-1）", mp.globalOf(12, 1, 25) === -1);
t("第 3 页只有 1 行，第 2 行越界", mp.globalOf(1, 2, 25) === -1);

// ---- 边界：说「本页第 12 号」但这一页只有 12 道 ----
t("13 道时第 2 页第 0 行 = 全局 12", mp.globalOf(0, 1, 13) === 12);
t("13 道时第 2 页第 1 行越界", mp.globalOf(1, 1, 13) === -1);

// ---- 一页 12 道：本页号和界面上印的号必须一一对应 ----
let aligned = true;
const total = 25;
for (let p = 0; p < mp.pageCount(total); p++) {
  for (let r = 0; r < mp.countOn(p, total); r++) {
    const g = mp.globalOf(r, p, total);
    if (mp.localOf(g, p, total) !== r) aligned = false;
    if (mp.pageOf(g, total) !== p) aligned = false;
  }
}
t("每一行「印的号 → 全局下标 → 行号」都能转回去（25 道全遍历）", aligned);

console.log("\n结果: " + pass + " 通过 / " + faild + " 失败");
process.exit(faild ? 1 : 0);
