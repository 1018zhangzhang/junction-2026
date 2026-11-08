"use strict";
// 菜单分页：纯函数，不碰任何 IrisView API，可以直接用 node 测。
// 为什么需要：菜多起来以后，「1 番茄炒蛋 · 2 可乐鸡翅 · …」一行放不下，
// 屏幕上会挤成一坨。所以每页只放 4 道，页内编号从 1 开始。
const PAGE_SIZE = 4;

function pageCount(total) {
  return Math.max(1, Math.ceil((total || 0) / PAGE_SIZE));
}

// 页码循环：翻到最后一页再翻回到第一页，用户永远不会"翻丢"
function clampPage(page, total) {
  const n = pageCount(total);
  return ((Math.round(page || 0) % n) + n) % n;
}

// 当前页包含哪些全局下标
function indicesOf(page, total) {
  const p = clampPage(page, total);
  const out = [];
  for (let i = p * PAGE_SIZE; i < Math.min(total, (p + 1) * PAGE_SIZE); i += 1) out.push(i);
  return out;
}

// 菜单正文：页内编号 + 菜名
function line(titles, page, total) {
  return indicesOf(page, total)
    .map((globalIndex, k) => (k + 1) + " " + titles[globalIndex])
    .join("  ·  ");
}

// 翻页提示：只有一页就不提示，免得占地方
function pageHint(page, total) {
  const n = pageCount(total);
  if (n <= 1) return "";
  return "第 " + (clampPage(page, total) + 1) + "/" + n + " 页 · 说「下一页」翻";
}

const NUM = { "一": 1, "二": 2, "三": 3, "四": 4, "1": 1, "2": 2, "3": 3, "4": 4 };

// 说「二」「第二个」「就第 2 道」→ 选中当前页第 2 个（返回全局下标，没选中返回 -1）
function pickByNumber(text, page, total) {
  const t = String(text || "");
  if (t.length > 10) return -1;          // 太长的话多半是在说话，不是在报数
  const list = indicesOf(page, total);
  for (const ch of t) {
    const n = NUM[ch];
    if (!n) continue;
    const idx = list[n - 1];
    if (idx !== undefined) return idx;
  }
  return -1;
}

module.exports = { PAGE_SIZE, pageCount, clampPage, indicesOf, line, pageHint, pickByNumber };
