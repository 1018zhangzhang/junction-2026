"use strict";
// ============================================================================
// 收尾流程回归测试（纯 node，不需要模拟器）
//   node tools/test-wrap.js
//
// 覆盖两件事：
//   ① src/wrap.js 的"要/不要"判定 —— 尤其是否定优先（不要加 ≠ 加）
//   ② src/dish-store.js 的收藏落盘 —— 同名去重、上限、坏文件不炸、重启后还在
// ============================================================================
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookstore-"));
process.env.FUSIONUI_APP_DATA_DIR = dir;

const flow = require("../src/wrap");
const store = require("../src/dish-store");

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? "（" + extra + "）" : ""));
}

function dish(title, steps) {
  return {
    title: title,
    subtitle: "刚刚生成的",
    steps: steps || [
      { ask: "切丝泡水", detail: "冲两遍", phase: "prep", timeMs: 300000 },
      { ask: "大火快炒", detail: "沿锅边淋醋", phase: "cook", timeMs: 120000 },
    ],
  };
}

/* ─────────── ① 收尾问答判定 ─────────── */
// 问题①：要不要加进菜单
t("加进去 → 保存", flow.decide("askSave", "加进去").act === "save");
t("要 → 保存", flow.decide("askSave", "要").act === "save");
t("好啊 → 保存", flow.decide("askSave", "好啊").act === "save");
t("存起来 → 保存", flow.decide("askSave", "存起来吧").act === "save");
t("嗯 → 保存", flow.decide("askSave", "嗯").act === "save");
t("算了 → 不存", flow.decide("askSave", "算了").act === "skip");
t("不用 → 不存", flow.decide("askSave", "不用").act === "skip");
// ★ 关键：否定优先。「不要加」里既有"不要"也有"加"，必须判成"不存"
t("不要加 → 不存（否定优先）", flow.decide("askSave", "不要加").act === "skip");
t("不加了 → 不存", flow.decide("askSave", "不加了").act === "skip");
t("酸了（算了被听错）→ 不存", flow.decide("askSave", "酸了").act === "skip");
t("换菜 → 不存并回菜单", flow.decide("askSave", "换菜").act === "skipMenu");
t("听不懂 → 重问", flow.decide("askSave", "今天天气不错").act === "retry");
t("空话 → 重问", flow.decide("askSave", "   ").act === "retry");

// 问题②：还要不要做下一道
t("要 → 回菜单", flow.decide("askNext", "要").act === "menu");
t("好 → 回菜单", flow.decide("askNext", "好").act === "menu");
t("再来一道 → 回菜单", flow.decide("askNext", "再来一道").act === "menu");
t("换菜 → 回菜单", flow.decide("askNext", "换菜").act === "menu");
t("不用 → 收工", flow.decide("askNext", "不用").act === "summary");
t("不了 → 收工", flow.decide("askNext", "不了").act === "summary");
t("收工 → 收工", flow.decide("askNext", "收工").act === "summary");
t("不做了 → 收工", flow.decide("askNext", "不做了").act === "summary");
t("算了 → 收工", flow.decide("askNext", "算了").act === "summary");
t("听不懂 → 重问", flow.decide("askNext", "今天天气不错").act === "retry");

// 收工页：只有明确说"再做一道"才回菜单
t("收工页说「再做一道」→ 回菜单", flow.decide("summary", "再做一道").act === "menu");
t("收工页说「换菜」→ 回菜单", flow.decide("summary", "换菜").act === "menu");
t("收工页说「好」→ 留在收工页", flow.decide("summary", "好").act === "stay");
t("收工页说「收工」→ 留在收工页", flow.decide("summary", "收工").act === "stay");

/* ─────────── ② 收藏落盘 ─────────── */
t("一开始没有收藏", store.list().length === 0);

let r = store.add(dish("红烧茄子"));
t("收藏成功", r.ok === true, r.reason);
t("收藏后数量 1", r.total === 1);
t("文件真的写出来了", fs.existsSync(path.join(dir, store.FILE)));

const raw = JSON.parse(fs.readFileSync(path.join(dir, store.FILE), "utf8"));
t("文件结构是 {version, dishes}", raw.version === 1 && Array.isArray(raw.dishes) && raw.dishes.length === 1);
t("存的是「红烧茄子」", raw.dishes[0].title === "红烧茄子");
t("标记了 custom / saved", raw.dishes[0].custom === true && raw.dishes[0].saved === true);
t("步骤保留完整", raw.dishes[0].steps.length === 2 && raw.dishes[0].steps[1].ask.indexOf("快炒") >= 0);
t("有计时的步骤 timer=true", raw.dishes[0].steps[1].timer === true);
t("has() 认得", store.has("红烧茄子") === true);
t("has() 不认得别的", store.has("麻婆豆腐") === false);

// 同名再存一次：应该覆盖而不是出现两条
r = store.add(dish("红烧茄子", [
  { ask: "切滚刀块", detail: "撒盐杀水", phase: "prep", timeMs: 600000 },
  { ask: "下锅烧", detail: "收汁", phase: "cook", timeMs: 300000 },
  { ask: "撒葱花出锅", detail: "", phase: "finish", timeMs: 0 },
]));
t("同名覆盖：仍然只有 1 条", r.total === 1);
t("同名覆盖：步骤换成新的", store.list()[0].steps.length === 3);
t("同名覆盖：没有计时那步 timer=false", store.list()[0].steps[2].timer === false);

// 非法菜谱
const bad = store.add({ title: "没步骤的菜", steps: [] });
t("没有步骤 → 拒绝", bad.ok === false && bad.reason === "bad-dish");
t("拒绝后列表不变", store.list().length === 1);

// 上限：最多 MAX_SAVED 条，新的排最前
for (let i = 0; i < 9; i++) store.add(dish("测试菜" + i));
t("最多只留 " + store.MAX_SAVED + " 条", store.list().length === store.MAX_SAVED, "实际 " + store.list().length);
t("最新的排第一", store.list()[0].title === "测试菜8");
t("最老的被丢掉", store.has("红烧茄子") === false);

// 重启（清缓存后从磁盘读）还在
store.reset();
t("重启后仍然读得到", store.list().length === store.MAX_SAVED && store.has("测试菜8"));

// 文件坏了不能把应用带崩
fs.writeFileSync(path.join(dir, store.FILE), "{ 这不是 json", "utf8");
store.reset();
let survived = true;
let list = [];
try { list = store.list(); } catch (e) { survived = false; }
t("文件坏了不抛异常", survived === true);
t("文件坏了当作没有收藏", Array.isArray(list) && list.length === 0);

// 没有数据目录（比如单测/非真机）：只当没有存储，不抛错
process.env.FUSIONUI_APP_DATA_DIR = "";
store.reset();
let noDirOk = true;
try {
  store.list();
  const rr = store.add(dish("无目录菜"));
  t("没有数据目录 → 明确返回失败", rr.ok === false && rr.reason === "no-data-dir");
} catch (e) { noDirOk = false; }
t("没有数据目录也不抛异常", noDirOk === true);

/* ─────────── ③ 下次启动：收藏的菜排在第一页最前面 ─────────── */
// 真开一个新进程读 recipe.js —— 这样测的是"启动时合并"的真实路径，
// 不是在本进程里手动把数组拼一遍（拼错了也测不出来）。
const { execFileSync } = require("node:child_process");
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cookboot-"));
fs.writeFileSync(path.join(bootDir, store.FILE), JSON.stringify({
  version: 1,
  dishes: [dish("红烧茄子"), dish("番茄炒蛋")],   // 第二道故意和内置菜同名
}), "utf8");

const script = "const {DISHES}=require('./src/recipe');"
  + "console.log('MENUOUT:'+JSON.stringify(DISHES.map(function(d){return d.title})));";
let titles = [];
try {
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { FUSIONUI_APP_DATA_DIR: bootDir }),
  }).toString("utf8");
  const line = out.split(/\r?\n/).find((l) => l.indexOf("MENUOUT:") === 0);
  titles = JSON.parse(line.slice("MENUOUT:".length));
} catch (e) {
  t("启动时合并收藏菜不报错", false, e.message);
}
t("重启后收藏的菜排在菜单第 1 位", titles[0] === "红烧茄子", JSON.stringify(titles.slice(0, 3)));
t("收藏的内置同名菜不会出现两次", titles.filter((x) => x === "番茄炒蛋").length === 1);
t("内置菜一道都没少", titles.indexOf("麻婆豆腐") >= 0 && titles.length === 12, "共 " + titles.length + " 道");

/* ─────────── 结果 ─────────── */
console.log((fails.length ? "✗ 失败 " + fails.length + " 项：" : "") );
for (const f of fails) console.log("  ✗ " + f);
if (fails.length) process.exit(1);
console.log("✓ 收尾流程测试全部通过 " + pass + "/" + pass);
