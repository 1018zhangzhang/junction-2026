"use strict";
/* 开机点阵动画的单测（纯逻辑，不上屏、不需要模拟器）
   验证四件事：
     ① 矩阵尺寸/位置合法：不出画布、不压到下面的提问行
     ② 亮度永远在 0~1，档位换算不越界
     ③ 真的"会动"：不同时刻的图案不一样，而且底部先亮、往上灌
     ④ 上屏路径（create/apply/hide）能建 189 个点、只改变化了的那几个、能收干净 */
const boot = require("../src/boot-anim");

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) pass++;
  else fails.push(label + (extra ? " → " + extra : ""));
}

// ① 尺寸与位置
ok(boot.COLS * boot.ROWS === 189, "点阵数量应为 21×9=189", String(boot.COLS * boot.ROWS));
ok(boot.X0 >= 0 && boot.X0 + boot.GRID_W <= 640, "点阵水平方向越出画布",
  "x=" + boot.X0 + " w=" + boot.GRID_W);
ok(boot.Y0 >= 100, "点阵太靠上，会压住标题行", "y=" + boot.Y0);
ok(boot.Y0 + boot.GRID_H <= 320, "点阵太靠下，会压住 330 的提问行",
  "y+h=" + (boot.Y0 + boot.GRID_H));

// ② 亮度与档位
const p0 = boot.pattern(0);
ok(p0.length === 189, "pattern 长度不对", String(p0.length));
let outOfRange = 0;
for (const t of [0, 120, 400, 900, 1500, 3000, 8000]) {
  for (const v of boot.pattern(t)) {
    if (!(v >= 0 && v <= 1)) outOfRange++;
  }
}
ok(outOfRange === 0, "有 " + outOfRange + " 个点的亮度超出 0~1");
ok(boot.levelOf(-1) === 0 && boot.levelOf(2) === 5, "levelOf 没有把超界值夹到 0~5");
ok(boot.levelOf(0) === 0 && boot.levelOf(1) === 5 && boot.levelOf(0.5) === 3,
  "levelOf 分档不对", [boot.levelOf(0), boot.levelOf(0.5), boot.levelOf(1)].join("/"));

// ③ 会动 + 从底往上灌
const a = boot.pattern(1200), b = boot.pattern(1360);
let diff = 0;
for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 0.02) diff++;
ok(diff > 20, "相邻两帧几乎没变化（看着像静止画面）", "变化点=" + diff);

const early = boot.pattern(260);      // 灌水早期：只该亮底部
const rowSum = (pat, r) => {
  let s = 0;
  for (let c = 0; c < boot.COLS; c++) s += pat[r * boot.COLS + c];
  return s;
};
ok(rowSum(early, boot.ROWS - 1) > 0, "最早一帧底部完全没亮");
ok(rowSum(early, boot.ROWS - 1) > rowSum(early, 0) * 1.5,
  "不是从底部往上亮（底行 " + rowSum(early, boot.ROWS - 1).toFixed(2)
  + " vs 顶行 " + rowSum(early, 0).toFixed(2) + "）");
ok(rowSum(boot.pattern(4000), boot.ROWS - 1) > 0.5, "动画稳定后底部不该是黑的");

// ④ 上屏路径（用最小桩件）
function fakeUi() {
  const made = { boards: 0, sizes: [], colors: [], styles: [] };
  const color = (r, g, b) => ({ r, g, b });
  return {
    made: made,
    Color: { fromRGB8: color },
    Board: {
      create() {
        made.boards++;
        let style = null;
        return {
          setParent() {},
          setIgnoreLayout() {},
          setPosition(p) { made.sizes.push(p); },
          setSize(s) { made.sizes.push(s); },
          getLocalStyle() {
            if (!style) style = { setBackgroundColor(c) { made.colors.push(c); } };
            return style;
          },
        };
      },
    },
  };
}
const ui = fakeUi();
const grid = boot.create(ui, {});
ok(ui.made.boards === 189, "建点数不对", String(ui.made.boards));
const changed1 = boot.apply(grid, 0);
ok(changed1 > 0, "第一次 apply 没有改任何点（第一眼会是黑的）");
const changed2 = boot.apply(grid, 0);
ok(changed2 === 0, "同一时刻重复 apply 还在改颜色（白烧 CPU）", String(changed2));
boot.apply(grid, 900);                    // 先跑到稳定态
const changed3 = boot.apply(grid, 960);   // 再走 60ms（约一帧）
ok(changed3 > 0 && changed3 < 189, "换时刻后应只改变化了的那部分点", String(changed3));

boot.hide(grid);
const zero = ui.made.sizes.filter((s) => s[0] === 0 && s[1] === 0).length;
ok(zero === 189, "hide 没有把 189 个点都收成 0 尺寸", String(zero));

// create 的容错：没有 ui.Board 时返回 null，而不是抛异常把启动带崩
ok(boot.create(null, {}) === null, "没有 ui 时 create 应返回 null");
ok(boot.create({ Color: { fromRGB8: () => ({}) } }, {}) === null, "没有 Board 时 create 应返回 null");
ok(boot.apply(null, 100) === 0, "apply(null) 应返回 0");
boot.hide(null);   // 不许抛

console.log("\n结果: " + pass + " 通过 / " + fails.length + " 失败");
if (fails.length) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("✓ 开机点阵测试全部通过（21×9=189 点、底先亮、会动、能收干净）");
