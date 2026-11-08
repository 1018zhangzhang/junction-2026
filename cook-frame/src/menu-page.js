"use strict";
// ============================================================================
// 菜单翻页（纯函数，不碰 IrisView API，可直接用 node 测）
// ----------------------------------------------------------------------------
// 为什么要翻页：一页只摆得下 12 行（6 行 × 2 列），而「做完说加进去」的菜会越
// 攒越多，第 13 道开始就没地方放了。以前的做法是「满了就顶掉最后一道」——
// 用户实测反馈：新菜把内置菜挤没了，而且说了「算了」也还在。
//
// 现在的规则：
//   · 一页 12 道，多出来的进第 2、3 页，靠说「下一页 / 上一页」翻；
//   · **编号按本页算**（本页第 3 道就说「3」）—— 识别词表里只有「一…十二」，
//     说「十三」小模型根本拼不出来，按页编号才能一直说下去；
//   · 菜名永远能跨页找到（不依赖页码）。
// ============================================================================

const PAGE_SIZE = 12;          // 一页 12 行（6 行 × 2 列），和界面控件数一致

/** 一共几页（空菜单也算 1 页，免得除零和「0/0 页」） */
function pageCount(total) {
  const t = Math.max(0, Number(total) || 0);
  return Math.max(1, Math.ceil(t / PAGE_SIZE));
}

/** 页码循环：翻到最后一页再翻回第一页，永远不会"翻丢" */
function clamp(page, total) {
  const n = pageCount(total);
  return ((Math.round(Number(page) || 0) % n) + n) % n;
}

/** 第 index 道菜落在第几页 */
function pageOf(index, total) {
  const i = Math.max(0, Number(index) || 0);
  return clamp(Math.floor(i / PAGE_SIZE), total);
}

/** 本页第一道菜的全局下标 */
function startOf(page, total) {
  return clamp(page, total) * PAGE_SIZE;
}

/** 本页有几道菜（最后一页可能不满） */
function countOn(page, total) {
  const t = Math.max(0, Number(total) || 0);
  const start = startOf(page, t);
  return Math.max(0, Math.min(PAGE_SIZE, t - start));
}

/** 全局下标 → 本页行号（0 ~ 11）；不在本页返回 -1 */
function localOf(index, page, total) {
  const start = startOf(page, total);
  const local = Number(index) - start;
  return local >= 0 && local < countOn(page, total) ? local : -1;
}

/** 本页行号 + 页内编号（1 起） → 全局下标；越界返回 -1 */
function globalOf(local, page, total) {
  const i = Number(local);
  if (!(i >= 0) || i >= countOn(page, total)) return -1;
  return startOf(page, total) + i;
}

module.exports = { PAGE_SIZE, pageCount, clamp, pageOf, startOf, countOn, localOf, globalOf };
