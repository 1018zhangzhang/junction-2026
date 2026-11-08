"use strict";
// ============================================================================
// 用户导入菜谱的通道（预留扩展点，不是必须）
//
// 用法：把 json 放到应用的"数据目录"里，重启应用就自动出现在菜单里。
//   数据目录 = 系统环境变量 FUSIONUI_APP_DATA_DIR（平台提供）
//   支持两种放法：
//     1) <数据目录>/recipes.json            一个文件装多道菜
//     2) <数据目录>/recipes/任意名字.json    一道菜一个文件
//
// 格式（最小可用，其余字段会自动补默认值）：
//   {
//     "title": "青椒炒蛋",
//     "steps": [
//       { "ask": "青椒切丝，鸡蛋打散" },
//       { "ask": "热锅倒油，炒蛋盛出", "timeMs": 60000, "timer": true }
//     ]
//   }
//
// 安全原则：这段代码跑在任何 try/catch 里，文件坏了、格式不对、没权限，
//          一律当作"没有导入菜"，绝不影响应用启动。
// ============================================================================
const fs = require("node:fs");
const path = require("node:path");

function dataDirectory() {
  try {
    return require("./application-data").applicationDataDirectory();
  } catch (error) {
    return null;   // 不在真机上跑（比如 node 单测没设环境变量）→ 直接当没有
  }
}

/** 读一个 json 文件，返回菜对象数组；任何异常都返回空数组。 */
function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) return parsed;                  // [ {..}, {..} ]
    if (parsed && Array.isArray(parsed.dishes)) return parsed.dishes;  // { dishes: [...] }
    if (parsed && Array.isArray(parsed.steps)) return [parsed];        // 单道菜
    return [];
  } catch (error) {
    return [];
  }
}

const PHASES = ["prep", "cook", "seasoning", "finish"];

/** 把用户写的最小格式补成引擎认的完整格式。缺关键字段就丢掉这道菜。 */
function normalize(dish, index) {
  if (!dish || typeof dish !== "object") return null;
  const title = String(dish.title || dish.name || "").trim();
  const rawSteps = Array.isArray(dish.steps) ? dish.steps : [];
  if (!title || rawSteps.length === 0) return null;

  const steps = rawSteps.map((step, i) => {
    if (!step || typeof step !== "object") return null;
    const ask = String(step.ask || step.action || step.title || "").trim();
    if (!ask) return null;
    const timeMs = Number.isFinite(step.timeMs) ? step.timeMs : 0;
    return {
      id: String(step.id || ("s" + (i + 1))),
      ask,
      detail: String(step.detail || step.cue || ""),
      phase: PHASES.includes(step.phase) ? step.phase : "cook",
      seasoning: Array.isArray(step.seasoning) ? step.seasoning : [],
      timeMs,
      timer: step.timer === true || (step.timer !== false && timeMs > 0),
      tips: Array.isArray(step.tips) ? step.tips : [],
      rescue: step.rescue && typeof step.rescue === "object" ? step.rescue : {},
    };
  }).filter(Boolean);

  if (steps.length === 0) return null;

  const totalMs = Number.isFinite(dish.totalMs)
    ? dish.totalMs
    : steps.reduce((sum, s) => sum + (s.timeMs || 0), 0);

  return {
    schema: "irisview-recipe-2",
    id: String(dish.id || ("dish.imported-" + (index + 1))),
    title,
    subtitle: String(dish.subtitle || "自建菜谱"),
    totalMs,
    steps,
    vocab: Array.isArray(dish.vocab) && dish.vocab.length ? dish.vocab.slice() : [title],
    imported: true,   // 标记：这是用户导入的，方便以后区分
  };
}

/** 扫描数据目录，返回所有可用的导入菜。 */
function load() {
  const dir = dataDirectory();
  if (!dir) return [];

  const raw = [];

  // 1) 单个文件 recipes.json
  const single = path.join(dir, "recipes.json");
  try {
    if (fs.existsSync(single)) raw.push(...readFile(single));
  } catch (error) { /* 忽略 */ }

  // 2) recipes/ 目录下每个 json
  const folder = path.join(dir, "recipes");
  try {
    if (fs.existsSync(folder)) {
      for (const name of fs.readdirSync(folder)) {
        if (!name.toLowerCase().endsWith(".json")) continue;
        raw.push(...readFile(path.join(folder, name)));
      }
    }
  } catch (error) { /* 忽略 */ }

  const dishes = raw.map(normalize).filter(Boolean);

  // 同名菜只保留第一个，避免用户改文件时留下重复项
  const seen = new Set();
  return dishes.filter((d) => {
    if (seen.has(d.title)) return false;
    seen.add(d.title);
    return true;
  });
}

/** 在数据目录写一份示例文件，方便用户照着改。已存在则不覆盖。 */
function writeTemplate() {
  const dir = dataDirectory();
  if (!dir) return { ok: false, reason: "no-data-dir" };
  const target = path.join(dir, "recipes.json");
  try {
    if (fs.existsSync(target)) return { ok: true, path: target, existed: true };
    const sample = {
      dishes: [{
        title: "青椒炒蛋",
        subtitle: "示例 · 照这个格式改就行",
        steps: [
          { ask: "青椒切丝，鸡蛋打散加一小撮盐", detail: "青椒去籽不辣", phase: "prep", timeMs: 120000 },
          { ask: "热锅倒油，炒蛋盛出", detail: "蛋七成熟就盛", phase: "cook", timeMs: 60000 },
          { ask: "下青椒炒软，倒回鸡蛋加盐出锅", detail: "青椒断生就够", phase: "finish", timeMs: 120000 },
        ],
      }],
    };
    fs.writeFileSync(target, JSON.stringify(sample, null, 2), "utf8");
    return { ok: true, path: target, existed: false };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

module.exports = { load, normalize, writeTemplate, dataDirectory };
