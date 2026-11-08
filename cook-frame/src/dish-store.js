"use strict";
// ============================================================================
// 收藏的菜（用户做完一道"库里没有的菜"，说"加进去"就存这里）
// ----------------------------------------------------------------------------
// 存在应用的私有数据目录：<FUSIONUI_APP_DATA_DIR>/custom-dishes.json
//   · 和 llm.json 一样在包外 —— 不会打进 .fuapp，换机器/重装就没了，这是有意的
//   · 下次启动由 recipe.js 放在菜单最前面（用户要求：下次出现在第一页）
//   · 任何异常（没权限 / 文件坏了 / 不在真机上跑）都只当"没有收藏"，绝不影响启动
// ============================================================================
const fs = require("node:fs");
const path = require("node:path");

const FILE = "custom-dishes.json";
const MAX_SAVED = 6;          // 最多留 6 道（菜单一页 12 行，再多会把内置菜挤出去）

let cache = null;             // 读一次就记住，避免每帧都碰磁盘

function storePath() {
  try {
    const dir = require("./application-data").applicationDataDirectory();
    return path.join(dir, FILE);
  } catch (error) {
    return null;              // 不在真机上（单测没设环境变量）→ 当作没有存储
  }
}

/** 只保留引擎真正会用到的字段；缺关键字段视为无效（返回 null） */
function coerce(dish, index) {
  if (!dish || typeof dish !== "object") return null;
  const title = String(dish.title || dish.name || "").trim();
  const rawSteps = Array.isArray(dish.steps) ? dish.steps : [];
  if (!title || !rawSteps.length) return null;

  const steps = rawSteps.map(function (s, i) {
    if (!s || typeof s !== "object") return null;
    const ask = String(s.ask || s.action || s.title || "").trim();
    if (!ask) return null;
    const timeMs = Number(s.timeMs) > 0 ? Number(s.timeMs) : 0;
    return {
      id: String(s.id || ("s" + (i + 1))),
      ask: ask,
      detail: String(s.detail || s.cue || ""),
      phase: String(s.phase || "cook"),
      seasoning: Array.isArray(s.seasoning) ? s.seasoning.slice(0, 8) : [],
      timeMs: timeMs,
      timer: s.timer === true || (s.timer !== false && timeMs > 0),
      tips: Array.isArray(s.tips) ? s.tips.slice(0, 8) : [],
      rescue: s.rescue && typeof s.rescue === "object" ? s.rescue : {},
    };
  }).filter(Boolean);

  if (!steps.length) return null;

  const totalMs = Number(dish.totalMs) > 0
    ? Number(dish.totalMs)
    : steps.reduce((sum, s) => sum + (s.timeMs || 0), 0);

  return {
    schema: "irisview-recipe-2",
    id: String(dish.id || ("dish.saved-" + (index + 1))),
    title: title,
    subtitle: String(dish.subtitle || "我加的菜"),
    totalMs: totalMs,
    steps: steps,
    vocab: Array.isArray(dish.vocab) && dish.vocab.length ? dish.vocab.slice(0, 10) : [title],
    custom: true,                                    // 标记：这道不是内置的
    saved: true,                                     // 标记：已经在收藏里了
    savedAt: Number(dish.savedAt) || 0,
  };
}

/** 读收藏列表（任何时候都不会抛错） */
function load() {
  if (cache) return cache.slice();
  const file = storePath();
  if (!file) { cache = []; return []; }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const arr = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.dishes) ? parsed.dishes : []);
    cache = arr.map(coerce).filter(Boolean);
  } catch (error) {
    cache = [];                                     // 文件不存在/坏了 → 没有收藏
  }
  return cache.slice();
}

function list() {
  return load();
}

function has(title) {
  const t = String(title || "").trim();
  return Boolean(t) && load().some((d) => d.title === t);
}

function persist(list) {
  const file = storePath();
  if (!file) return { ok: false, reason: "no-data-dir" };
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, dishes: list }, null, 1), "utf8");
    fs.renameSync(tmp, file);                       // 原子替换：写一半断电也不会留半个文件
    return { ok: true, path: file };
  } catch (error) {
    return { ok: false, reason: "write-failed" };
  }
}

/**
 * 把一道菜加进收藏（同名覆盖，新的排最前面）。
 * @returns {{ok:boolean, reason?:string, dish?:object, total?:number, path?:string}}
 */
function add(dish) {
  const d = coerce(dish, 0);
  if (!d) return { ok: false, reason: "bad-dish" };
  d.savedAt = Date.now();

  const next = load().filter((x) => x.title !== d.title);
  next.unshift(d);
  while (next.length > MAX_SAVED) next.pop();       // 只留最近保存的几道

  const written = persist(next);
  if (!written.ok) return written;
  cache = next;
  return { ok: true, dish: d, total: next.length, path: written.path };
}

/** 单测用：清掉内存缓存，强制下次从磁盘读 */
function reset() { cache = null; }

module.exports = { FILE, MAX_SAVED, load, list, has, add, reset, coerce };
