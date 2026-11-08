"use strict";
// ============================================================================
// 收尾问答（做完一道菜之后的两个问题）
// ----------------------------------------------------------------------------
//   ① 这道菜不在菜谱库里 → 要加进菜单吗？（只有 AI 现场生成的菜才会问）
//   ② 还要做下一道吗？ 要 → 回菜单；不用 → 收工总结页
//
// 这里只放"听懂的是要还是不要"的判定，不碰界面、不碰存储 ——
// 好处是能用纯 node 跑测试（tools/test-wrap.js），不用模拟器。
// ============================================================================

/* 肯定词：用户表达"加进去 / 继续做"。
 * ★ 判定顺序是"先否定后肯定"：「不要加」里既有"不要"也有"加"，
 *   必须先命中否定，否则会被"加"抢走 —— 这正是以前菜单那层犯过的错。 */
const YES_WORDS = [
  "加进去", "加进", "加上", "加吧", "加入", "加", "保存", "存起来", "存下来", "存进",
  "留下", "要", "好的", "好", "可以", "行", "嗯", "对", "是", "需要", "继续",
];
/* 否定词：说"算了 / 不用 / 不要"就是不存、不做了。
 * 「蒜了 / 酸了」是"算了"被 ASR 听错的常见样子 —— 在收尾场景里它们没有别的意思，
 * 所以放心当"算了"用（跟做中可不能这么干，那时"酸了"是真在说味道）。 */
const NO_WORDS = [
  "不用了", "不用", "不要了", "不要", "不必", "不加了", "不加", "不存", "别加", "别存",
  "不需要", "不想", "算了", "蒜了", "酸了", "不了", "先不", "不行", "不做", "免了", "不啦",
];
/* 「真的要存进菜单」的明确说法。
 * ★ 为什么要单独列一张表：第一问里说「好」「要」「可以」是**含糊**的 ——
 *   用户可能是回答"做好了""等下"（ASR 把「算了」听成「好了」也很常见），
 *   以前这些都被 isYes 判成"存"，于是"说了算了还是存进去了"。
 *   现在只认这张表里的明确说法，含糊的一律回问一次，宁可多问一句不误存。 */
const SAVE_WORDS = [
  "加进去", "加进", "加上", "加入", "加吧", "加一个", "加",
  "存进", "存起来", "存下来", "存着", "保存", "存",
  "留下", "留着", "记下来", "收录", "列入",
];

/* 明确"我要走 / 换一道"的说法：这一问里直接算不存 + 回菜单。
 * ★ 只收明确的，"继续 / 下一道"这类在一问里含糊（可能是回答"做好了"），不收。 */
const LEAVE_WORDS = ["换菜", "换个菜", "换一道", "菜单", "选菜", "重新选", "不做了", "收工"];

/* 想换一道菜（在任何一问里都算"这道结束了，回菜单"） */
const MENU_WORDS = [
  "换菜", "换个菜", "菜单", "选菜", "重新选", "换一道", "换个菜做",
  "再做", "再来一道", "再来一个", "再选", "继续", "下一道", "下一个",
];
/* 明确收工 */
const STOP_WORDS = ["收工", "结束", "不做了", "够了", "就这样"];

function clean(text) {
  return String(text || "").replace(/[\s。，！？、.,!?~～]+/g, "");
}

function hasAny(t, words) {
  for (const w of words) if (t.indexOf(w) >= 0) return w;
  return "";
}

function isNo(text) {
  const t = clean(text);
  if (!t) return false;
  if (t === "不" || t === "否" || t === "no" || t === "n") return true;
  return Boolean(hasAny(t, NO_WORDS));
}

function isYes(text) {
  const t = clean(text);
  if (!t) return false;
  if (isNo(t)) return false;          // ★ 否定优先：「不要加」不能被"加"抢走
  return Boolean(hasAny(t, YES_WORDS));
}

/**
 * 判断这句话在当前这一问里代表什么动作。
 * @param {"askSave"|"askNext"|"summary"} stage
 * @param {string} text 识别出来的原话
 * @returns {{act:string, say?:string}}
 *   askSave: save=加进菜单 | skip=不存 | skipMenu=不存并回菜单 | retry
 *   askNext: menu=回菜单再选 | summary=收工 | retry
 *   summary: menu=再做一道 | stay=留在收工页
 */
function decide(stage, text) {
  const t = clean(text);
  if (!t) return { act: "retry" };

  if (stage === "askSave") {
    if (isNo(t)) return { act: "skip", say: "好，这次不存" };
    // ★ 先否定、再"明确存"、最后才看一般肯定 —— 含糊的「好 / 要 / 可以」只回问
    if (hasAny(t, SAVE_WORDS)) return { act: "save", say: "好，存进菜单" };
    if (hasAny(t, LEAVE_WORDS)) return { act: "skipMenu", say: "不存了，回菜单" };
    if (isYes(t)) return { act: "retry", say: "要存进菜单吗？说「加进去」，不存就说「算了」" };
    return { act: "retry", say: "说「加进去」或「算了」" };
  }

  if (stage === "askNext") {
    if (isNo(t)) return { act: "summary", say: "好，收工" };
    if (hasAny(t, STOP_WORDS)) return { act: "summary", say: "好，收工" };
    if (isYes(t)) return { act: "menu", say: "好，再选一道" };
    if (hasAny(t, MENU_WORDS)) return { act: "menu", say: "好，再选一道" };
    return { act: "retry", say: "说「要」再选一道，说「不用」收工" };
  }

  // 收工页：只有明确说"再做一道"才回菜单；「好」「收工」都留在这一页
  if (hasAny(t, MENU_WORDS)) return { act: "menu", say: "好，再选一道" };
  return { act: "stay", say: "说「再做一道」回菜单" };
}

/* 收尾阶段给识别器的小词表：越小越准（说"算了"不会被拼成"蒜了"以外的怪字） */
const VOCAB = [
  "加进去", "加上", "保存", "算了", "不用", "不要", "不加", "要", "不要了",
  "好", "好的", "下一道", "再做一道", "再来一道", "换菜", "菜单", "继续", "收工",
];

module.exports = { decide, isYes, isNo, VOCAB, YES_WORDS, NO_WORDS, MENU_WORDS, STOP_WORDS, SAVE_WORDS, LEAVE_WORDS };
