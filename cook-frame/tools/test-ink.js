"use strict";
// ============================================================================
// 字号 / 墨色阶梯测试（v67）
// ----------------------------------------------------------------------------
// 这一版改的是"看得舒不舒服"，最容易出的问题是**看着没问题、实测不可读**：
//   ① 小字被缩到 12 号（眼镜上要凑近）
//   ② 次要文字压得太暗（黑底 3:1，厨房灯一开就没了）
//   ③ 字号放大后行高不够，字被控件裁掉半截
//   ④ 深浅层次排错（次要信息比当前步骤还亮）
// 所以这里直接抽 index.js 里的真函数来验，不另写一份仿制品。
//
// 跑法：node tools/test-ink.js
// ============================================================================

const fsmod = require("fs");
const path = require("path");
const src = fsmod.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail ? "（" + detail + "）" : ""));
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---- 1) 抽出字号总控（FONT_SCALE / FONT / fs）+ 墨色阶梯（lumOf / contrastOn / ink）----
   两段都从源码里原样抽出来跑，保证测的就是真机那一份。 */
const fStart = src.indexOf("const FONT_SCALE");
const fEnd = src.indexOf("function dlog");
const cStart = src.indexOf("const INK = {");
const cEnd = src.indexOf("// ★ 回调在模块加载时就注入");
let api = null;
try {
  if (fStart < 0 || fEnd <= fStart) throw new Error("找不到字号总控区段");
  if (cStart < 0 || cEnd <= cStart) throw new Error("找不到墨色阶梯区段");
  const fontPart = src.slice(fStart, fEnd);
  const inkPart = src.slice(cStart, cEnd);
  // 同一个作用域里拼起来跑：setBoost 用来模拟"说一句「看不清」"
  api = new Function(fontPart + "\n" + inkPart
    + "\nreturn { FONT, FS_FLOOR, FONT_SCALE, COMFORT_MAX_BASE, fs, ink, lumOf, contrastOn, C, INK,"
    + " setBoost: function (v) { fontBoost = v; } };")();
} catch (e) {
  console.error("✗ 抽取字号/墨色阶梯失败：" + e.message);
  process.exit(1);
}
const { FONT, FS_FLOOR, FONT_SCALE, COMFORT_MAX_BASE, fs, ink, lumOf, contrastOn, C, INK } = api;

console.log("字号表: " + Object.keys(FONT).map((k) => k + "=" + FONT[k]).join(" ")
  + " | 下限 " + FS_FLOOR);
console.log("亮度档: " + Object.keys(INK).map((k) => k + "=" + INK[k]).join(" "));

/* ---- 2) 字号阶梯：越重要越大，且最小一档不再"凑近看" ---- */
const ORDER = ["main", "timer", "row", "sub", "said", "time", "progress", "meta"];
for (let i = 0; i + 1 < ORDER.length; i++) {
  const a = FONT[ORDER[i]], b = FONT[ORDER[i + 1]];
  // said / time 允许同级（都是"次要小字"），其余必须严格递减
  const sameOk = ORDER[i] === "said" && ORDER[i + 1] === "time";
  ok(a > b || (sameOk && a === b),
    "字号阶梯顺序错：" + ORDER[i] + "(" + a + ") 应 > " + ORDER[i + 1] + "(" + b + ")");
}
ok(FONT.meta >= 14, "最小字号只有 " + FONT.meta + "，眼镜上要凑近看（应 ≥ 14）");
ok(FONT.main >= 30, "主步骤字号 " + FONT.main + " 小于 30，主角不够突出");
ok(fs(8) >= FS_FLOOR, "fs(8)=" + fs(8) + " 低于硬下限 " + FS_FLOOR);
ok(fs(12) >= 13, "12 号字仍然漏出来了：fs(12)=" + fs(12));

/* 每行控件高度都装得下自己的字号（行高 ≈ 字号 × 1.34），否则字会被裁半截 */
const ROWS = [
  ["progress", 30, FONT.progress],
  ["main", 200, FONT.main],
  ["sub", 60, FONT.sub],
  ["timer", 34, FONT.timer],
  ["partial", 26, FONT.said],
  ["mic", 24, FONT.meta],
  ["footer", 24, FONT.meta],
  ["state", 22, FONT.meta],
  ["chan", 22, FONT.meta],
  ["rowH", 28, FONT.row],
  ["time", 26, FONT.time]
];
for (const r of ROWS) {
  const need = fs(r[2]) * 1.34;
  ok(r[1] >= need, "行「" + r[0] + "」高 " + r[1] + " 装不下 " + fs(r[2]) + " 号字（需要 " + Math.ceil(need) + "）");
  ok(fs(r[2]) * 1.02 <= 640, "行「" + r[0] + "」单字宽超屏");
}

/* ---- 3) 舒适档：说「看不清」只抬小字，不把菜名/主步骤撑到压行 ---- */
api.setBoost(2);
ok(fs(FONT.meta) === FONT.meta + 2, "舒适档没有把 meta 抬 2 号：" + fs(FONT.meta));
ok(fs(FONT.progress) === FONT.progress + 2, "舒适档没有把 progress 抬 2 号：" + fs(FONT.progress));
ok(fs(FONT.row) === FONT.row, "舒适档把菜名也放大了（会压行）：" + fs(FONT.row));
ok(fs(FONT.main) === FONT.main, "舒适档把主步骤也放大了（那是「大字」的事）：" + fs(FONT.main));
for (const r of ROWS) {
  const need = fs(r[2]) * 1.34;
  ok(r[1] >= need, "舒适档下行「" + r[0] + "」装不下 " + fs(r[2]) + " 号字（需要 " + Math.ceil(need) + "）");
}
api.setBoost(0);

/* ---- 4) 墨色阶梯：深浅必须严格递减，且最暗一档也要过 WCAG AA ---- */
const LEVELS = ["key", "main", "sub", "aux", "meta"];
for (let i = 0; i + 1 < LEVELS.length; i++) {
  ok(INK[LEVELS[i]] > INK[LEVELS[i + 1]],
    "亮度档顺序错：" + LEVELS[i] + "(" + INK[LEVELS[i]] + ") 应 > " + LEVELS[i + 1] + "(" + INK[LEVELS[i + 1]] + ")");
}
const C_LIST = [
  ["green", C.green], ["greenSoft", C.greenSoft], ["yellow", C.yellow],
  ["white", C.white], ["blue", C.blue], ["orange", C.orange], ["red", C.red]
];
for (const c of C_LIST) {
  for (const lv of LEVELS) {
    const got = ink(c[1], lv);
    const cr = contrastOn(got, [0, 0, 0]);
    ok(cr >= 4.5, "色 " + c[0] + " 压到 " + lv + " 档后黑底对比度只有 " + cr.toFixed(2) + ":1（AA 要 ≥ 4.5）");
    ok(got.every((v) => v >= 0 && v <= 255 && Number.isFinite(v)), "ink(" + c[0] + "," + lv + ") 算出非法 RGB：" + got);
  }
}
/* 同一色相，档越高越亮 —— 这就是"深浅表示重要程度"的机械保证 */
for (const c of C_LIST) {
  const arr = LEVELS.map((lv) => lumOf(ink(c[1], lv)));
  for (let i = 0; i + 1 < arr.length; i++) {
    ok(arr[i] >= arr[i + 1] - 0.006,
      "色 " + c[0] + " 的 " + LEVELS[i] + " 档比 " + LEVELS[i + 1] + " 档还暗（阶梯反了）");
  }
}
/* 幂等：已经在这一档的颜色再压一次不该继续变暗（否则每帧都会掉亮度） */
for (const lv of LEVELS) {
  const once = ink(C.green, lv);
  const twice = ink(once, lv);
  ok(near(lumOf(once), lumOf(twice), 0.02), "ink 不幂等：" + lv + " 档二次处理后亮度从 "
    + lumOf(once).toFixed(3) + " 变 " + lumOf(twice).toFixed(3));
}
/* 边界：纯黑输入不许算出 NaN / 溢出（曾经 lineColor 混色也会碰到 0,0,0） */
const black = ink([0, 0, 0], "sub");
ok(black.every((v) => Number.isFinite(v)), "ink(黑) 算出 NaN：" + black);
const oversat = ink([255, 255, 255], "meta");
ok(oversat.every((v) => v <= 255), "ink(白,meta) 溢出：" + oversat);

/* 语义色之间的"亮"不能盖过档位：红/橙天生到不了 0.5，但必须比 meta 更亮，
   否则"异常/提醒"看起来比底栏还弱 —— 这是 ink 允许"取可达最大值"的那条例外。 */
for (const c of [["red", C.red], ["orange", C.orange], ["yellow", C.yellow]]) {
  const atSub = lumOf(ink(c[1], "sub"));
  const atMeta = lumOf(ink(c[1], "meta"));
  ok(atSub >= atMeta, "语义色 " + c[0] + " 的 sub 档比 meta 档还暗");
  ok(contrastOn(ink(c[1], "sub"), [0, 0, 0]) >= 4.5, "语义色 " + c[0] + " 在 sub 档不可读");
}

/* ---- 5) 源码扫描：不许再出现"手写字号 / 手写文字颜色"绕过总控 ---- */
const magicSize = src.match(/fs\(\s*\d+\s*\)/g) || [];
ok(magicSize.length === 0, "还有手写字号绕过 FONT 表：" + magicSize.join(" "));
const magicColor = src.match(/setTextColor\(ui\.Color\.fromRGB8\(\s*\d/g) || [];
ok(magicColor.length === 0, "还有手写文字颜色绕过墨色阶梯：" + magicColor.length + " 处");
ok(/const FONT = \{/.test(src) && /const INK = \{/.test(src), "FONT / INK 表被删了");
ok((src.match(/ink\(/g) || []).length >= 12, "用 ink() 的地方太少，深浅层次可能没落地");

/* ---- 6) 字号指令的词面：不能把"火候/用量"当成"调字号"（v63 的老教训）---- */
let words = null;
try {
  const wStart = src.indexOf("const LAYOUT_WORDS");
  const wEnd = src.indexOf("function matchLayout");
  if (wStart < 0 || wEnd <= wStart) throw new Error("找不到 LAYOUT_WORDS 区段");
  words = new Function(src.slice(wStart, wEnd) + "\nreturn LAYOUT_WORDS;")();
} catch (e) {
  fails.push("抽取 LAYOUT_WORDS 失败：" + e.message);
}
if (words) {
  const hit = (text) => {
    const w = words.find((x) => x.re.test(text));
    return w ? w.name : "";
  };
  const YES = [
    ["看不清", "comfort"], ["看不清楚", "comfort"], ["字太小了", "comfort"],
    ["字有点小", "comfort"], ["字号太小", "comfort"], ["护眼模式", "comfort"],
    ["字小一点", "compact"], ["常规字号", "compact"], ["字太大了", "compact"],
    ["大字", "big"], ["字号大一点", "big"]
  ];
  for (const c of YES) {
    ok(hit(c[0]) === c[1], "「" + c[0] + "」应识别为 " + c[1] + "，实际 " + (hit(c[0]) || "没认出来"));
  }
  const NO = [
    "火太小了", "火太大了", "火大一点", "再放大蒜", "加两勺生抽", "盐太少了",
    "这菜太咸了", "我太小看它了"
  ];
  for (const t of NO) {
    ok(hit(t) === "", "「" + t + "」是做菜的话，却被当成字号/布局指令（" + hit(t) + "）");
  }
  // 顺序也重要：舒适档必须排在「大字」前面，否则「看不清」会被 big 抢走
  ok(words[0].name === "comfort" && words[1].name === "compact", "舒适档没有排在词表最前面");
}

/* ---- 结果 ---- */
console.log("");
if (fails.length) {
  for (const f of fails) console.error("✗ " + f);
  console.error("\n结果: " + pass + " 通过 / " + fails.length + " 失败");
  process.exit(1);
}
console.log("结果: " + pass + " 通过 / 0 失败");
console.log("✓ 字号阶梯 / 舒适档 / 墨色阶梯（对比度 ≥ 4.5:1）全部通过");
