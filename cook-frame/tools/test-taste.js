"use strict";
// ============================================================================
// 忌口 / 喜好记忆测试（v68）
// ----------------------------------------------------------------------------
// 这块功能最大的风险不是"记不住"，是**记错**：
//   ① 把灶台指令记成一辈子的事（「不放盐」「别放葱」「火小一点」）
//      —— v63 的老坑：「火大一点」被当成调字号，这里同样必须挡住；
//   ② 把整句话当食材（「我不吃这个」→ 记下"这个"）；
//   ③ 说「爱吃辣」之后，之前的「不吃辣」还留着，两边打架；
//   ④ apply 改到了缓存的档案，导致"没说的也被记上"。
// 所以下面反例（必须不认）和正例（必须认出）一样多。
//
// 跑法：node tools/test-taste.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const taste = require("../src/taste");

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail ? "（" + detail + "）" : ""));
}

/* ---- 1) 说法 → 命令：正例 ---- */
const YES = [
  ["我不吃香菜", "add", "avoid", ["香菜"]],
  ["我不吃香菜。", "add", "avoid", ["香菜"]],
  ["我对花生过敏", "add", "avoid", ["花生"]],
  ["我花生过敏", "add", "avoid", ["花生"]],
  ["不吃辣", "add", "avoid", ["辣"]],
  ["我不能吃辣", "add", "avoid", ["辣"]],
  ["我不喜欢吃葱和姜", "add", "avoid", ["葱", "姜"]],
  ["我讨厌香菜", "add", "avoid", ["香菜"]],
  ["我忌口海鲜", "add", "avoid", ["海鲜"]],
  ["我不吃香菜和葱，还有蒜", "add", "avoid", ["香菜", "葱", "蒜"]],
  ["我爱吃辣", "add", "like", ["辣"]],
  ["我喜欢吃折耳根", "add", "like", ["折耳根"]],
  ["多放点蒜", "add", "like", ["蒜"]],
  ["来点香菜", "add", "like", ["香菜"]]
];
for (const c of YES) {
  const r = taste.parse(c[0]);
  ok(r && r.op === c[1] && r.kind === c[2] && JSON.stringify(r.items) === JSON.stringify(c[3]),
    "「" + c[0] + "」识别错", JSON.stringify(r));
}

/* 撤销 / 查询 / 清空 */
const CMD = [
  ["忘掉香菜", "remove", ["香菜"]],
  ["不用记香菜了", "remove", ["香菜"]],
  ["忘记葱和姜", "remove", ["葱", "姜"]],
  ["我有什么忌口", "list", []],
  ["你记得我什么", "list", []],
  ["清空忌口", "clear", []],
  ["忘掉所有记忆", "clear", []]
];
for (const c of CMD) {
  const r = taste.parse(c[0]);
  ok(r && r.op === c[1] && JSON.stringify(r.items || []) === JSON.stringify(c[2]),
    "「" + c[0] + "」应识别为 " + c[1], JSON.stringify(r));
}

/* ---- 2) 反例：这些话是"做菜"，不是"一辈子不吃" ---- */
const NO = [
  "不放盐", "别放葱", "不要放香菜", "少放点辣", "火太小了", "火大一点", "太咸了",
  "可以吃了", "这个不吃", "我不吃这个", "我不吃太咸的", "我不吃亏", "我吃过了",
  "再放大蒜", "盐太少了", "这菜太辣了", "好了", "下一步", "我不太会用这个锅",
  "把香菜切碎", "香菜要不要焯水",
  // ★ 撤消词必须窄：「去掉 / 取消」是灶台常用动词，不能被当成"撤销忌口"
  "去掉籽", "把葱去掉", "取消计时", "删掉这一行",
  // ★ 词表外的话不能瞎记：「火候」不是食材
  "我不喜欢这个火候", "我不喜欢这个颜色", "我讨厌这个味道"
];
for (const t of NO) {
  ok(taste.parse(t) === null, "「" + t + "」是做菜的话，却被记进忌口", JSON.stringify(taste.parse(t)));
}

/* ---- 3) 写档案：新增 / 重复 / 互斥 / 上限 / 删除 / 清空 ---- */
let p = taste.empty();
let r = taste.apply(p, taste.parse("我不吃香菜"));
ok(r.changed && r.profile.avoid.join() === "香菜", "新增忌口失败", JSON.stringify(r));
ok(r.profile !== p, "apply 返回了原对象（应返回副本）");

r = taste.apply(r.profile, taste.parse("我不吃香菜"));
ok(!r.changed && r.existed[0] === "香菜" && r.added.length === 0,
  "重复说同一句应报「已经在里面」，不再重复新增", JSON.stringify(r));

// 互斥：先说爱吃辣，再说不能吃辣 → 只留在 avoid
p = taste.apply(taste.empty(), taste.parse("爱吃辣")).profile;
p = taste.apply(p, taste.parse("不能吃辣")).profile;
ok(p.like.indexOf("辣") < 0 && p.avoid.indexOf("辣") >= 0,
  "「不能吃辣」没有把之前的「爱吃辣」摘掉", JSON.stringify(p));

// 反方向：先忌口，再说爱吃
p = taste.apply(taste.empty(), taste.parse("不吃辣")).profile;
p = taste.apply(p, taste.parse("爱吃辣")).profile;
ok(p.avoid.indexOf("辣") < 0 && p.like.indexOf("辣") >= 0,
  "「爱吃辣」没有把之前的「不吃辣」摘掉", JSON.stringify(p));

// 上限 8：记 10 样只留 8 样（界面写不下）
p = taste.empty();
for (const w of ["香菜", "葱", "姜", "蒜", "花生", "虾", "鸡蛋", "牛奶", "花生米", "紫菜"]) {
  p = taste.apply(p, { op: "add", kind: "avoid", items: [w] }).profile;
}
ok(p.avoid.length === taste.MAX_ITEMS, "忌口没有截到上限 8 条", JSON.stringify(p.avoid));

// 删除：忌口和喜好两侧都删
p = taste.apply(taste.empty(), taste.parse("不吃香菜")).profile;
p = taste.apply(p, taste.parse("爱吃香菜")).profile;   // 此时香菜在 like
r = taste.apply(p, taste.parse("忘掉香菜"));
ok(r.removed.indexOf("香菜") >= 0 && r.profile.like.concat(r.profile.avoid).indexOf("香菜") < 0,
  "「忘掉香菜」没有把两侧都清掉", JSON.stringify(r.profile));

// 清空
p = taste.apply(taste.empty(), taste.parse("不吃香菜")).profile;
r = taste.apply(p, { op: "clear" });
ok(r.changed && r.profile.avoid.length === 0 && r.profile.like.length === 0, "清空失败");

// ★ 缓存安全：apply 不能改到原档案（否则"没说的也被记上"）
const frozen = taste.normalize(taste.empty());
const snapshot = JSON.stringify(frozen);
taste.apply(frozen, { op: "add", kind: "avoid", items: ["香菜"] });
ok(JSON.stringify(frozen) === snapshot, "apply 改到了原档案（缓存污染）", JSON.stringify(frozen));

/* ---- 4) 命中与后缀：菜谱里出现忌口食材时标出来 ---- */
const { DISHES } = require("../src/recipe");
const tomato = DISHES.find((d) => d.title === "番茄炒蛋");
ok(Boolean(tomato), "找不到番茄炒蛋（菜谱数据变了？）");
p = taste.apply(taste.empty(), taste.parse("不吃鸡蛋")).profile;
let hit = taste.hitsOf(p, taste.dishText(tomato));
ok(hit.avoid.indexOf("鸡蛋") >= 0, "「不吃鸡蛋」没有在番茄炒蛋里命中", JSON.stringify(hit));
ok(taste.tagOf(hit) === "（含鸡蛋）", "单项后缀格式错", taste.tagOf(hit));
ok(taste.tagOf({ avoid: ["葱", "姜"] }) === "（含葱、姜）", "两项后缀格式错");
ok(taste.tagOf({ avoid: ["葱", "姜", "蒜"] }) === "（含葱、姜等3样）", "三项后缀格式错");
ok(taste.tagOf({ avoid: [] }) === "", "没命中却给了后缀");

// 步骤级：只提示这一步
const stepWithEgg = (tomato.steps || []).find((s) => /鸡蛋/.test(taste.stepText(s)));
ok(Boolean(stepWithEgg), "番茄炒蛋里没有一步提到鸡蛋？");
const stepNoEgg = (tomato.steps || []).find((s) => !/鸡蛋|葱|油/.test(taste.stepText(s)));
if (stepNoEgg) {
  ok(taste.hitsOf(p, taste.stepText(stepNoEgg)).avoid.length === 0, "不相干的步骤也报了忌口");
}

// 菜谱文本缓存：同一道菜两次结果一致，不同菜不同
ok(taste.dishText(tomato) === taste.dishText(tomato), "dishText 两次结果不一致（缓存坏了）");
ok(taste.dishText(tomato) !== taste.dishText(DISHES.find((d) => d.title === "红烧肉")),
  "两道菜的文本一样？（缓存串了）");

/* ---- 5) 说人话 + 给模型的约束 ---- */
ok(taste.describe(taste.empty()) === "", "空档案不该有描述");
p = taste.apply(taste.empty(), taste.parse("不吃香菜")).profile;
p = taste.apply(p, taste.parse("爱吃辣")).profile;
ok(taste.describe(p) === "不吃香菜 · 爱吃辣", "描述格式错", taste.describe(p));
ok(/香菜/.test(taste.promptLine(p)) && /用户忌口/.test(taste.promptLine(p)), "promptLine 没带上忌口");
ok(taste.promptLine(taste.empty()) === "", "没有忌口却给模型加了约束（白费 token）");

/* ---- 6) 存储：没配置应用目录时不许抛错（单测/模拟器就是这种情况）---- */
let threw = false;
try {
  taste.save(p);
  const back = taste.load();
  ok(back && Array.isArray(back.avoid), "load 没返回合法档案");
} catch (e) {
  threw = true;
}
ok(!threw, "存储读写抛错了（会带崩启动流程）");

/* ---- 7) 接线：这句话必须真的进主流程，而且排在菜单/收尾之前 ---- */
const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");
const at = src.indexOf("if (handleTaste(t0)) return;");
const menuAt = src.indexOf("if (app.mode === \"menu\") { handleMenuUtterance(text); return; }");
const wrapAt = src.indexOf("if (app.mode === \"wrap\") { handleWrapUtterance(text); return; }");
ok(at > 0, "主流程里没有调用 handleTaste");
ok(at > 0 && menuAt > at && wrapAt > at, "handleTaste 没有排在菜单/收尾之前（会被吞掉）");
ok(src.indexOf("taste.tagOf(taste.hitsOf(app.taste, taste.dishText(") > 0, "菜单行没有接忌口后缀");
ok(src.indexOf("noteTasteStep(false)") > 0, "跟做页没有接步骤级忌口提醒");
ok(src.indexOf("taste.normalize(app.taste).avoid") > 0, "生成菜谱时没有把忌口交给模型");
ok(src.indexOf("pickRecommend") > 0 && src.indexOf("h.avoid.length") > 0, "推荐没有避开忌口");

/* ---- 结果 ---- */
console.log("");
if (fails.length) {
  for (const f of fails) console.error("✗ " + f);
  console.error("\n结果: " + pass + " 通过 / " + fails.length + " 失败");
  process.exit(1);
}
console.log("结果: " + pass + " 通过 / 0 失败");
console.log("✓ 忌口/喜好记忆：识别、互斥、上限、命中、存储、接线全部通过");
