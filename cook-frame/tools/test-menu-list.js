"use strict";
// ============================================================================
// 菜单单页（不翻页）回归测试
// ----------------------------------------------------------------------------
// 背景：以前每页 4 道、靠说「下一页」翻页，但「下一页」在小模型上一直识别不稳，
//       用户翻不动就等于看不到后面的菜。现在 11 道菜全摆第一页，序号 1-11 直选。
//
// 这个测试直接抽取 index.js 里的真实实现（pickByIndex / matchDish）来跑，
// 不是另写一份仿制品，所以能真的挡住「改了代码却测的是假逻辑」。
//
// 跑法：node tools/test-menu-list.js
// ============================================================================

const fs = require("fs");
const path = require("path");
const { DISHES } = require("../src/recipe");

const src = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8");

// 从源码里挑出「菜单常量 + dishNegated + pickByIndex + matchDish」这一整段
const start = src.indexOf("const MENU_COLS");
const end = src.indexOf("function paintMenu");
if (start < 0 || end < 0 || end <= start) {
  console.error("✗ 抽取失败：index.js 结构变了，请检查 MENU_COLS / paintMenu 是否还在");
  process.exit(1);
}
const block = src.slice(start, end);

/* 字号总控（FONT_SCALE / fs）在 MENU_COLS 之前定义，不在抽取区段里。
   这里把同一段源码单独抽出来跑，再把结果当参数喂给主区段 ——
   保证测试用的缩放规则和真机完全一致（不是测试里另写一份）。 */
const fStart = src.indexOf("const FONT_SCALE");
const fEnd = src.indexOf("function dlog");
let fontApi;
try {
  if (fStart < 0 || fEnd <= fStart) throw new Error("找不到 FONT_SCALE / dlog 区段");
  fontApi = new Function(src.slice(fStart, fEnd) + "\nreturn { FONT_SCALE, fs };")();
} catch (e) {
  console.error("✗ 抽取字号总控失败：" + e.message);
  process.exit(1);
}

let api;
try {
  api = new Function("DISHES", "FONT_SCALE", "fs",
    block + "\nreturn { matchDish, pickByIndex, MENU_MAX, MENU_ROWS, MENU_COLS, MENU_ROW_Y, MENU_ROW_H };"
  )(DISHES, fontApi.FONT_SCALE, fontApi.fs);
} catch (e) {
  console.error("✗ 抽取的代码无法执行：" + e.message);
  process.exit(1);
}

const { matchDish, pickByIndex, MENU_MAX, MENU_ROWS, MENU_COLS, MENU_ROW_Y, MENU_ROW_H } = api;
const FONT_SCALE = fontApi.FONT_SCALE;
const total = DISHES.length;

let pass = 0;
const fails = [];
function eq(text, expect, label) {
  const got = matchDish(text);
  if (got === expect) {
    pass++;
  } else {
    fails.push(label + " 「" + text + "」→ " + got + "（期望 " + expect + "）");
  }
}

console.log("菜数: " + total + " | 一页最多摆: " + MENU_MAX + "（" + MENU_COLS.length + " 列 × " + MENU_ROWS + " 行）");

// 0) 一页必须装得下所有菜，否则「不翻页」这个前提就破了
if (total > MENU_MAX) {
  fails.push("菜数 " + total + " 超过一页上限 " + MENU_MAX + "，会摆不下");
} else pass++;

// 1) 序号直选：1-11 全都要能选中对应那道
for (let i = 0; i < total; i++) {
  eq(String(i + 1), i, "阿拉伯数字");
  eq("第" + (i + 1) + "道", i, "第N道");
}
console.log("  序号 1-" + total + " 直选：逐个验证完毕");

// 2) 中文数字
eq("五", 4, "中文数字");
eq("第五个", 4, "第N个");
eq("十一", 10, "十一");
eq("两个", 1, "两个（两=2）");

// 3) 翻页词不能当序号（「下一个」里含「一」是历史大坑）
eq("下一个", -1, "滚动词");
eq("上一个", -1, "滚动词");
eq("下一页", -1, "翻页词");
eq("还有吗", -1, "翻页词");

// 4) 越界序号不选
eq("12", -1, "越界");
eq("0", -1, "越界");

// 5) 菜名 / 别名
eq("番茄炒蛋", 0, "精确菜名");
eq("做个可乐鸡翅", 1, "菜名带前缀");
if (DISHES[2] && (DISHES[2].vocab || []).length) {
  eq(DISHES[2].vocab[0], 2, "别名");
}

// 6) 否定不能开做（历史 bug：说「不想做番茄炒蛋」会直接开始做）
eq("不想做番茄炒蛋", -1, "否定");
eq("不要番茄炒蛋了", -1, "否定");

// 7) 纯口语不误选
eq("今天随便说点什么", -1, "无意义");
eq("太咸了", -1, "故障词");
eq("有点咸", -1, "单字故障词");
eq("再等一会儿", -1, "口语");

// 7.5) 同音容错：本地识别把字听错时也要能对上（否则用户只能重说）
eq("马婆豆腐", 8, "同音：麻婆豆腐");
eq("汤醋排骨", 10, "同音：糖醋排骨");
eq("可乐鸡次", 1, "同音：可乐鸡翅");
eq("红勺肉", 3, "同音：红烧肉");
eq("蛋炒范", 4, "同音：蛋炒饭");
eq("拍王瓜", 2, "近音：拍黄瓜");
eq("紫菜蛋花糖", 5, "同音：紫菜蛋花汤");
eq("清蒸鲈于", 7, "同音：清蒸鲈鱼");
eq("兰蓉西兰花", 9, "错字：蒜蓉西兰花");
// 容错不能越过否定：带否定词一律不开做
eq("不要马婆豆腐", -1, "同音+否定");
eq("不想吃汤醋排骨", -1, "同音+否定2");

// ★ 不许"覆盖性"纠正：只是相似的另一道菜，必须当成"菜单里没有这道菜"
//   用户实测：说「红烧茄子」被硬套成「红烧肉」——茄/肉都是食材字、不同音，不是听错
eq("红烧茄子", -1, "不许把红烧茄子套成红烧肉");
eq("我想吃红烧茄子", -1, "同一句带前后文也不许套");
eq("红烧茄子怎么做", -1, "问句里出现也不许套");
eq("番茄牛腩", -1, "不许把番茄牛腩套成番茄炒蛋");
eq("青椒肉丝", -1, "不许把青椒肉丝套成麻婆豆腐");
eq("红烧鱼", -1, "不许把红烧鱼套成红烧肉");
// 反过来，真正的听错仍然要认出来（不能因为收紧就变笨）
eq("红烧肉肉", 3, "多一个字：仍然认红烧肉");
eq("马婆豆付", 8, "两个字音近：仍然认麻婆豆腐");
// 别名只在「整句就是它」时才认（以前"句中出现"就算，于是 番茄牛腩→番茄炒蛋）
eq("豆腐", 8, "只说主料：豆腐 → 麻婆豆腐");
eq("我想吃排骨", 10, "带前缀的别名：排骨 → 糖醋排骨");
eq("排骨怎么做", 10, "带后缀的别名");
eq("红烧豆腐", -1, "换个做法就不是同一道菜：红烧豆腐 ≠ 麻婆豆腐");
eq("番茄", 0, "只说番茄 → 番茄炒蛋");

// 8) 版面：最后一行不能压到麦克风行（mic 在 y=404）
const lastRowY = MENU_ROW_Y + (MENU_ROWS - 1) * MENU_ROW_H;
const rowH = Math.round(28 * FONT_SCALE);
if (lastRowY + rowH > 404) fails.push("最后一行底边 " + (lastRowY + rowH) + " 压到麦克风行(404)，FONT_SCALE=" + FONT_SCALE + " 太大了");
else pass++;

// 9) 字号总控必须在合理区间（太小看不清、太大把版面撑破）
if (!(FONT_SCALE >= 0.8 && FONT_SCALE <= 1.3)) fails.push("FONT_SCALE=" + FONT_SCALE + " 超出可用范围 0.8~1.3");
else pass++;

console.log("\n结果: " + pass + " 通过 / " + fails.length + " 失败");
if (fails.length) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✓ 菜单单页测试全部通过");
