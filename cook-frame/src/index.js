"use strict";

// ============================================================================
// 做饭助手 · 对话版（沙盘引擎移植）
// ----------------------------------------------------------------------------
// 数据流：麦克风 PCM(voice.js) → VAD 切句 → asr.js 转文字（队友插座）
//        → engine.js 理解（沙盘同款引擎）→ 界面回应
// 文字输入保留为调试备胎（模拟器发文字）。导航键：确认=好/下一步，返回=上一步。
// ============================================================================

const os = require("@irisview/osx/os");
const input = require("@irisview/osx/os/input");
const ui = require("@irisview/osx/fusionui");
const { performance } = require("node:perf_hooks");
const { createSession } = require("./engine");
const { DISHES, VOCAB } = require("./recipe");
const voice = require("./voice");
const asr = require("./asr");
const menu = require("./menu");   // 菜单分页（纯函数，菜多了要分页）

const view = {};
// ★ 版本号显示在界面左上角，一眼确认跑的是不是最新包（防止 run 错旧的备份 .fuiapp）
const APP_VER = "v35";

/** 关键事件写进 /tmp/cook-mic.log（console.log 只到终端，事后抓不到） */
function dlog(msg) {
  try { voice.log(msg); } catch (e) { /* 忽略 */ }
}

// ★ 回调在模块加载时就注入，不依赖 start() 走到哪一步
//   （以前放在 start() 末尾，一旦前面哪句抛错，识别结果就会全部丢掉：能识别但不执行）
voice.onPartial = onPartial;
voice.onText = onText;
voice.onUtterance = onUtterance;

const app = {
  session: null,     // 对话会话（engine.js）· 菜单模式下是 null
  mode: "menu",      // menu=选菜中 | cooking=跟做中
  dishIndex: -1,     // 当前选中的菜（DISHES 下标）
  menuPage: 0,       // 菜单当前页（每页 4 道，菜多了才用得上）
  busy: false,       // ASR 识别中
  micWanted: true,   // 前台时保持持续监听
  micRestartAt: 0,   // 一次会话结束后多久再申请下一次
  paused: false,     // 语音喊停后的暂停状态（麦克风保持监听，随时可喊「继续」）
  // 临时提示（没听清 / 已选菜 / 推荐结果…）
  // ★ 必须存在状态里由主循环渲染：直接写 setText 会被下一帧 paintSession 覆盖掉
  notice: { text: "", rgb: [255, 180, 0], until: 0 },
  // 菜单模式下「刚才听到的话」：流式边说边显示，说完保留几秒
  // ★ 单独的 partial 行在菜单页会压在菜名列表上，所以菜单改用 timer 那行显示
  heard: { text: "", until: 0 },
  heardLive: "",     // 流式实时文字（还没定句）
  lastSay: { text: "", at: 0 },  // 上一句原文+时间（同句重复触发去重）
  micState: "idle",  // 上一帧的麦克风状态（用来抓「刚接通」这一下）
  frame: null,
  active: false
};

// ---- 语音喊停 / 继续（全局优先于引擎）----
const STOP_WORDS = ["停", "停下", "停一下", "停一停", "暂停", "停止", "等一下", "等等", "先别做", "别动了"];
const RESUME_WORDS = ["继续", "接着来", "接着做", "继续做", "恢复", "开始吧", "好了继续"];
// 暂停状态下也允许直接推进的指令（暂停只停「自动往下走」，不锁操作）
const ADVANCE_WORDS = ["下一步", "下一个", "跳过", "上一步", "退回去", "退一步",
  "好了", "行了", "可以了", "完成了", "都做完了"];

// ---- 菜单 ----// 说这些词随时回到选菜界面
const MENU_WORDS = ["换菜", "换个菜", "重新选", "换一个菜", "菜单", "选菜", "换一道", "换个菜做"];
// 翻页口令（菜超过 4 道才用得上）
const NEXT_PAGE_WORDS = ["下一页", "下一批", "翻页", "更多", "还有吗", "还有别的"];
const PREV_PAGE_WORDS = ["上一页", "上一批", "往前翻", "回上一页"];
const RECOMMEND_WORDS = ["推荐", "随便", "帮我选", "有什么推荐", "吃什么好"];

// ---- 识别词表：按当前场景收缩 ----
// 小模型是「词表越小越准」，所以菜单只认菜名，跟做只认指令词，别再一股脑全塞进去
const MENU_VOCAB = DISHES.map((d) => d.title).concat(
  ["推荐", "随便", "帮我选", "菜单", "换菜", "选菜", "做什么菜",
    "一", "二", "三", "四", "下一页", "上一页", "更多", "翻页"]);
const COOK_VOCAB = [
  "下一步", "下一个", "上一步", "退回去", "退一步", "跳过", "跳到下一步",
  "好了", "好啦", "行啦", "行了", "可以了", "好嘞", "继续", "接着做", "然后呢",
  "停", "停下", "暂停", "等一下", "开始计时", "计时", "倒计时", "时间到",
  // ★ 不要放「收工」「几分」：与「一共」「几步」近音，Vosk 会把「一共几步」拼成「收工油几步」
  "完成了", "都做完了", "出锅了", "换菜", "换个菜", "菜单", "选菜", "换一道",
  "多少", "放多少", "太咸", "太淡", "齁咸", "糊了", "油冒烟", "怎么办", "为什么"
];
function useVocab(kind, dishIndex) {
  if (kind === "menu") { voice.configure({ vocab: MENU_VOCAB }); return; }
  const dish = DISHES[dishIndex >= 0 ? dishIndex : 0];
  voice.configure({ vocab: COOK_VOCAB.concat(dish ? [dish.title] : []) });
}

// ---- 「跳过」= 下一步（跳过当前步骤，直接做后面的）----
const SKIP_WORDS = ["跳过", "跳过这步", "跳过这一步", "跳过去", "跳过当前", "跳到下一步"];

// ---- 计时：不自动开始，用户说才开始（他可能还没把锅放上去）----
const TIMER_START_WORDS = ["开始计时", "计时", "倒计时", "计时开始", "开始记时", "开始数"];
function startStepTimer() {
  if (app.mode !== "cooking" || !app.session) return false;
  const step = app.session.currentStep();
  if (!step || !step.timer) {
    notify("这一步不用计时，按步骤做就行", [255, 180, 0], 2200);
    return true; // 已经接住了这句话，别再丢给引擎
  }
  timer.stepId = step.id;
  timer.remainMs = step.timeMs || 0;
  timer.running = true;
  console.log("COOK_TIMER start " + step.id + " " + timer.remainMs + "ms");
  return true;
}

/** 菜名被否定了吗：「不要番茄炒蛋了」「我不想做番茄炒蛋」不该直接开做。
 *  只看菜名左边 3 个字 —— 「做个番茄炒蛋」里的「做个」不算否定。 */
function dishNegated(text, pos) {
  if (pos <= 0) return false;
  const head = String(text).slice(Math.max(0, pos - 3), pos);
  return /(不要|不想|不用|不吃|不做|别|算了)/.test(head);
}

/** 把一句话匹配到某道菜（先精确菜名，再别名/关键词，最后数字 1/2/3） */
function matchDish(text) {
  const t = String(text);
  for (let i = 0; i < DISHES.length; i++) {
    const at = t.indexOf(DISHES[i].title);
    if (at >= 0 && !dishNegated(t, at)) return i;
  }
  for (let i = 0; i < DISHES.length; i++) {
    for (const w of (DISHES[i].vocab || [])) {
      const at = t.indexOf(w);
      if (at >= 0 && !dishNegated(t, at)) return i;
    }
  }
  // 数字选菜：按「当前页」算，第 2 页的 1 就是那页第一个
  const byNum = menu.pickByNumber(t, app.menuPage, DISHES.length);
  if (byNum >= 0) return byNum;
  return -1;
}

function paintMenu() {
  const total = DISHES.length;
  app.menuPage = menu.clampPage(app.menuPage, total);
  const pages = menu.pageCount(total);
  setText(view.progress, shown, "progress",
    "菜单 · " + APP_VER + " · 共 " + total + " 道菜" + (pages > 1 ? " · " + menu.pageHint(app.menuPage, total) : ""));
  setText(view.main, shown, "main", "今天做什么菜？");
  setText(view.sub, shown, "sub", menu.line(DISHES.map((d) => d.title), app.menuPage, total));
  // ★ 听到的话放中间空行（y=92），最上面那条（y=64）留给临时提示，两条互不抢
  const colKey = app.heardLive ? "live" : "final";
  if (shown.heardColor !== colKey) {
    shown.heardColor = colKey;
    view.partial.getLocalStyle().setTextColor(ui.Color.fromRGB8(
      app.heardLive ? 0 : 255, app.heardLive ? 255 : 200, app.heardLive ? 120 : 0));
  }
  setText(view.partial, shown, "partial", menuHeardLine());
  setText(view.timer, shown, "timer", "");   // 菜单页没有倒计时
  setText(view.footer, shown, "footer",
    pages > 1
      ? "说 1-4 或菜名 · 「下一页」翻页 · 「推荐」我帮你挑"
      : "说菜名或数字，说「推荐」我帮你挑");
}

// 菜单页「听到的话」：先说实时文字（🎙），说完换成整句（🗣）保留 2.6 秒
function menuHeardLine() {
  if (app.heardLive) return "🎙 " + app.heardLive;
  if (app.heard.text && performance.now() < app.heard.until) return "🗣 " + app.heard.text;
  return "";
}
function noteHeard(text) {
  app.heard.text = String(text || "").trim();
  app.heard.until = performance.now() + 2600;
  app.heardLive = "";
}

function startDish(i) {
  app.dishIndex = i;
  app.mode = "cooking";
  app.session = createSession(DISHES[i]);
  app.paused = false;
  app.lastSay = { text: "", at: 0 };   // 刚切模式，别把上一句当重复
  app.heardLive = "";
  useVocab("cooking", i);   // 跟做中只认指令词 + 这道菜的名字
  timer.stepId = null;
  timer.remainMs = 0;
  show(app.session.present());
  notify("已选「" + DISHES[i].title + "」· 开做！", [0, 255, 90], 2200);
}

function enterMenu(hint) {
  app.mode = "menu";
  app.dishIndex = -1;
  app.menuPage = 0;         // 回菜单总是从第一页开始
  app.session = null;
  app.paused = false;
  app.lastSay = { text: "", at: 0 };
  app.heardLive = "";
  shown.heardColor = "";    // 让 paintMenu 重新上色（暂停时那行被改成过红色）
  useVocab("menu");         // 回菜单：词表切回菜名
  paintMenu();
  // 提示走 notify 浮层：以前直接写 sub 会把菜名列表盖掉，看起来像"菜单没了"
  if (hint) notify(hint, [255, 220, 0], 2000);
}

function handleMenuUtterance(text) {
  const t = String(text).trim();
  noteHeard(t);                       // 先把「听到的话」记下来，界面立刻有反馈
  const pages = menu.pageCount(DISHES.length);
  // 翻页必须排在选菜前面：「下一页」里含「一」，否则会被当成选第 1 道
  if (matchWord(t, NEXT_PAGE_WORDS)) {
    const before = app.menuPage;
    app.menuPage = menu.clampPage(app.menuPage + 1, DISHES.length);
    paintMenu();
    if (pages <= 1) notify("只有这一页 · 菜都在上面了", [255, 180, 0], 2400);
    else if (app.menuPage === 0 && before !== 0) notify("已经是最后一页 · 翻回第 1 页", [0, 220, 120], 3000);
    else notify("第 " + (app.menuPage + 1) + "/" + pages + " 页 · 说 1-4 选这页的菜", [0, 220, 120], 3000);
    return;
  }
  if (matchWord(t, PREV_PAGE_WORDS)) {
    const before = app.menuPage;
    app.menuPage = menu.clampPage(app.menuPage - 1, DISHES.length);
    paintMenu();
    if (pages <= 1) notify("只有这一页 · 菜都在上面了", [255, 180, 0], 2400);
    else if (app.menuPage === pages - 1 && before !== pages - 1) notify("已经在第一页 · 翻到最后一页", [0, 220, 120], 3000);
    else notify("第 " + (app.menuPage + 1) + "/" + pages + " 页 · 说 1-4 选这页的菜", [0, 220, 120], 3000);
    return;
  }
  if (matchWord(t, RECOMMEND_WORDS)) {
    let best = 0;
    for (let i = 1; i < DISHES.length; i++) if (DISHES[i].totalMs < DISHES[best].totalMs) best = i;
    app.menuPage = Math.floor(best / menu.PAGE_SIZE);   // 推荐的那道翻到它所在页，看得见
    paintMenu();
    notify("推荐 " + DISHES[best].title + " · 想说「" + DISHES[best].title + "」", [0, 220, 120], 5200);
    return;
  }
  const pick = matchDish(t);
  if (pick >= 0) { startDish(pick); return; }
  notify("听到「" + t + "」· 没对上菜名，再说一遍或说「推荐」", [255, 150, 0], 3200);
}

// ---- 数字快捷指令（绕开中文输入法：文字框里打数字+回车）----
// 1下一步 2上一步 3停 4继续 5提问示例 6救场示例 7延迟 8收尾 9改口示例
const QUICK_COMMANDS = {
  "1": "下一步",
  "2": "上一步",
  "3": "停",
  "4": "继续",
  "5": "盐放多少",
  "6": "齁咸",
  "7": "还没好",
  "8": "完成了",
  "9": "不对，半勺"
};

function matchWord(text, words) {
  const t = String(text).trim();
  return words.some((w) => t.includes(w));
}

// 语气 → 颜色（红绿蓝 0~255，沙盘里五种 tone）
const TONE_COLOR = {
  normal: [0, 230, 0],
  answer: [0, 210, 255],
  corrected: [255, 180, 0],
  rescue: [255, 100, 0],
  ask: [0, 170, 0],
  success: [0, 255, 90]
};

// ---- 界面辅助 ----
// opts 可选：{ x, width, align } —— x/width 是像素坐标和宽度(0-640)，align 是对齐方式
// 不传 opts 时保持老行为：x=0、宽640、居中（其他行不受影响）
function makeText(parent, y, height, size, rgb, text, opts) {
  const o = opts || {};
  const x = (o.x !== undefined) ? o.x : 0;
  const w = (o.width !== undefined) ? o.width : 640;
  const t = ui.Text.create();
  t.setParent(parent);
  t.setIgnoreLayout(true);
  t.setPosition([x, y, 0]);
  t.setSize([w, height, 0]);
  const s = t.getLocalStyle();
  s.setTextColor(ui.Color.fromRGB8(rgb[0], rgb[1], rgb[2]));
  s.setTextAlign(o.align || ui.TextAlign.CENTER);
  const font = ui.Font.getCachedFont("", size, 0, 0);
  if (font) s.setTextFont(font);
  t.setText(text);
  return t;
}
function setText(t, cache, key, text) {
  if (cache[key] !== text) { t.setText(text); cache[key] = text; }
}
const shown = {};

// ---- 临时提示：显示 ms 毫秒后自动消失，期间压住正常文字 ----
// 用法：notify("没听清，请再说一遍", [255,180,0], 3000)
function notify(text, rgb, ms) {
  app.notice.text = text || "";
  app.notice.rgb = rgb || [255, 180, 0];
  app.notice.until = performance.now() + (ms || 2600);
}
function clearNotice() {
  if (app.notice.text) {
    // 同 paintNotice：撤提示要把缓存一起清掉，否则原文字画不回来
    shown.noticeMenu = "";
    shown.noticeSub = "";
    shown.sub = "";
    shown.timer = "";
  }
  app.notice.text = "";
  app.notice.until = 0;
}
// 每帧最后调用：有提示就压在上面，过期后自动让位给正常文字
function paintNotice() {
  const n = app.notice;
  const live = n.text && performance.now() < n.until;
  // 菜单模式压在最上面那行（别把菜名列表挤掉）；跟做模式压在副标题
  // ★ cache key 必须和常规文字分开：共用 "timer" 会互相污染缓存，
  //   出现过「提示写进去了但下一帧又被判定为没变化、界面始终空白」的坑
  const key = app.mode === "menu" ? "noticeMenu" : "noticeSub";
  const target = app.mode === "menu" ? view.timer : view.sub;
  if (live) {
    target.getLocalStyle().setTextColor(ui.Color.fromRGB8(n.rgb[0], n.rgb[1], n.rgb[2]));
    setText(target, shown, key, n.text);
  } else if (n.text) {
    n.text = "";
    n.until = 0;
    // ★ 提示撤掉后必须让常规文字重画回去：缓存里还是「上次画的值」，
    //   不清掉就会判定「没变化」而不重画，屏幕上是空白（或残留提示）
    shown[key] = "";
    shown.sub = "";
    shown.timer = "";
  }
}

// ---- 麦克风那一行：永远告诉用户「现在能不能说话」----
function micLine() {
  const st = voice.state;
  if (app.busy) return "⏳ 正在把刚才那句转成文字…";
  if (app.paused) return "🎤 已暂停 · 但麦克风还在听，说「继续」就行";
  if (st === "pending") return "⏳ 等授权 · 点控制器上的麦克风按钮";
  if (st === "recording") {
    const bars = Math.min(8, Math.round(voice.level * 30));
    if (bars >= 2) return "🎙 已接通 · 音量" + "█".repeat(bars) + "░".repeat(8 - bars);
    return "🟢 已接通 · 我在听，请说";
  }
  if (voice.lastError) return "⚠ 麦克风: " + voice.lastError;
  return "🎤 我在听 · 请说";
}
// 麦克风行颜色：待授权=橙、录音中=亮绿、出错=红，一眼看出状态有没有变
function micColor() {
  if (app.busy) return [0, 200, 255];
  if (app.paused) return [255, 120, 60];
  if (voice.state === "recording") return [0, 255, 90];
  if (voice.state === "pending") return [255, 180, 0];
  if (voice.lastError) return [255, 90, 60];
  return [0, 150, 0];
}

// ---- 最下面那行：按当前场景给不同的操作提示 ----
function footerHint() {
  if (!asr.remoteReady) return "识别服务未连接 · 文字框打数字 1-9 也能操作";

  if (app.mode === "menu") {
    // ★ 这行以前写死不带翻页，把 paintMenu 里的翻页提示盖掉了，用户根本发现不了「下一页」
    const pages = menu.pageCount(DISHES.length);
    return pages > 1
      ? "说 1-4 或菜名选菜 · 「下一页」翻页 · 「推荐」我帮你挑"
      : "说菜名或 1/2/3 选菜 · 说「推荐」我帮你挑";
  }

  if (app.paused) return "说「继续」接着做 · 说「换菜」重新选一道";
  if (app.busy) return "稍等一下，正在听懂刚才那句…";

  const state = app.session.getState();
  if (state.finished) return "这道做完了 · 说「换菜」再选一道";

  const step = app.session.currentStep();
  const isLast = state.stepIndex >= state.total - 1;

  // 计时相关的场景优先提示（这时最需要知道怎么说）
  if (step && step.timer) {
    if (!timer.running) return "这一步要等 · 说「开始计时」再起表";
    if (timer.remainMs > 0) return "计时中 " + fmtMs(timer.remainMs) + " · 说「停」暂停，说「跳过」略过";
    return "时间到 · 说「下一步」或「好了」继续";
  }

  if (voice.state === "recording") {
    const speaking = Math.round(voice.level * 30) >= 2;
    if (speaking) return "我在听 · 说完自动执行，不用按键";
    return "双手可以放开 · 说「下一步」「停」「换菜」";
  }
  if (voice.state === "pending") return "点控制器上的麦克风按钮 · 之后一句接一句不用再点";
  if (isLast) return "最后一步了 · 都做完了说「完成了」收尾";
  return "双手可以放开 · 说「下一步」「停」「换菜」";
}

// ---- 倒计时状态 ----
const timer = {
  stepId: null,   // 当前步骤 id（变了就重置剩余时间）
  remainMs: 0,    // 本步剩余毫秒
  running: false, // 是否已经在倒数（用户说「开始计时」才 true）
  lastNow: 0      // 上次 tick 时间，用于计算间隔
};
function fmtMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// ---- 暂停 / 恢复（语音喊停的全局出口）----
function doPause(reason) {
  app.paused = true;
  view.timer.getLocalStyle().setTextColor(ui.Color.fromRGB8(255, 90, 60));
  setText(view.timer, shown, "timer", reason || "已暂停 · 说「继续」接着做");
  setText(view.mic, shown, "mic", "已暂停 · 麦克风仍在听");
  console.log("COOK_PAUSED");
}
function doResume() {
  app.paused = false;
  view.timer.getLocalStyle().setTextColor(ui.Color.fromRGB8(255, 200, 0));
  timer.lastNow = performance.now(); // 防止暂停期间的时间差一次性扣掉
  console.log("COOK_RESUMED");
}

// ---- 界面创建（先父后子！）----
function start() {
  if (view.window) return;
  const p = os.WindowProperty.create();
  p.setTitle("做饭助手");
  p.setSize([0.64, 0.48, 0.01]);
  view.window = os.Window.create(p);
  view.root = ui.FusionRoot.acquireFusionRootFromWindow(view.window);

  view.canvas = ui.Board.create();
  view.canvas.setParent(view.root.getRootWidget());
  view.canvas.setIgnoreLayout(true);
  view.canvas.setSize([640, 480, 0]);
  view.canvas.getLocalStyle().setBackgroundColor(ui.Color.fromRGB8(0, 0, 0));

  view.progress = makeText(view.canvas, 26, 30, 14, [0, 150, 0], "");
  view.main = makeText(view.canvas, 120, 200, 30, [0, 230, 0], "");
  view.sub = makeText(view.canvas, 330, 60, 16, [0, 170, 0], "");
  view.timer = makeText(view.canvas, 64, 34, 20, [255, 200, 0], ""); // 本步倒计时 / 暂停提示
  // ★ y 从 356 改成 92：原来那行和副标题（330~390）叠在一起，字压字根本看不清
  view.partial = makeText(view.canvas, 92, 26, 15, [255,255,255], "",
    { x: 12, width: 360, align: ui.TextAlign.LEFT }); // 流式实时识别文字（左侧空白处）
  view.mic = makeText(view.canvas, 404, 24, 12, [0, 130, 0], "");
  view.footer = makeText(view.canvas, 448, 24, 12, [0, 110, 0], "");

  app.session = null;  // 菜单模式：还没选菜
  console.log("COOK_VOICE probe " + JSON.stringify(voice.probe()));
  useVocab("menu");   // 开场是菜单，先把识别词表收在菜名上
  voice.onPartial = onPartial;   // 流式：边说边出字
  voice.onText = onText;         // 流式：说完静音够久（默认 3 秒）出整句
  voice.onUtterance = onUtterance; // 批量退回模式（流式不可用时自动启用）
  dlog("COOK_BOOT " + APP_VER + " onText=" + (typeof voice.onText) + " dishes=" + DISHES.length);
  paintSession();
  resume();
}

// ---- 会话结果上屏 ----
function show(display) {
  const rgb = TONE_COLOR[display.tone] || TONE_COLOR.normal;
  view.main.getLocalStyle().setTextColor(ui.Color.fromRGB8(rgb[0], rgb[1], rgb[2]));
  setText(view.progress, shown, "progress",
    (display.progress || "") + (display.progress ? " · " : "") + APP_VER);
  setText(view.main, shown, "main", display.main || "");
  setText(view.sub, shown, "sub", display.sub || "");
  shown.tone = display.tone;
}

function paintSession() {
  if (app.mode === "menu") paintMenu();
  else show(app.session.present());
  // 麦克风行：文字 + 颜色都跟着状态变，点完麦克风立刻能看出「已接通」
  const rgb = micColor();
  const key = rgb.join(",");
  if (shown.micColor !== key) {
    view.mic.getLocalStyle().setTextColor(ui.Color.fromRGB8(rgb[0], rgb[1], rgb[2]));
    shown.micColor = key;
  }
  setText(view.mic, shown, "mic", micLine());
  setText(view.footer, shown, "footer", footerHint());
  paintNotice();   // 必须最后：临时提示要压在上面
  // 每 2 秒把「界面上实际写着什么」记一次：用来区分「没收到」还是「收到了没画上」
  const tNow = performance.now();
  if (!app.paintLogAt || tNow - app.paintLogAt > 2000) {
    app.paintLogAt = tNow;
    dlog("COOK_PAINT mode=" + app.mode
      + " partial=" + JSON.stringify(shown.partial || "")
      + " timer=" + JSON.stringify(shown[app.mode === "menu" ? "noticeMenu" : "noticeSub"] || shown.timer || "")
      + " main=" + JSON.stringify(shown.main || ""));
  }
}

// ---- 流式识别回调 ----
function onPartial(text) {
  // 实时显示"正在说的字"
  // 菜单页：写到上面那行（partial 行会被菜名列表压住，看不见）
  if (app.mode === "menu") {
    app.heardLive = String(text || "").trim();
    return;   // 下一帧 paintMenu 会渲染
  }
  setText(view.partial, shown, "partial", text ? "🎙 " + text : "");
}
function onText(text) {
  dlog("COOK_HANDLE final=" + JSON.stringify(text) + " mode=" + app.mode);
  const t = String(text || "").trim();
  if (!t) {
    if (app.mode !== "menu") setText(view.partial, shown, "partial", "");
    // 说完了但一个字都没认出来 → 显眼提示，请用户重说（走 notify，才不会被下一帧冲掉）
    notify("不好意思，可以再说一遍吗 🎤", [255, 150, 0], 3000);
    return;
  }
  // 把「听到的是什么」留在屏幕上，方便你判断是我听错了还是理解错了
  // 菜单页不写字幕行（会和菜名重叠），由 handleMenuUtterance → noteHeard 写到上面那行
  if (app.mode === "menu") app.heardLive = "";
  else setText(view.partial, shown, "partial", "🗣 " + t);
  handleUtterance(t);
}

// ---- 声音 → 文字 → 引擎（批量退回模式） ----
function onUtterance(pcm) {
  if (app.busy) return;
  app.busy = true;
  Promise.resolve(asr.transcribe(pcm, 16000))
    .then((text) => {
      app.busy = false;
      if (!text) {
        // 显眼的"没听清"提示
        notify("没听清，请再说一遍 🎤", [255, 180, 0], 3000);
        return;
      }
      console.log("COOK_ASR text=" + JSON.stringify(text));
      handleUtterance(String(text));
    })
    .catch((error) => {
      app.busy = false;
      console.log("COOK_ASR error " + error);
      notify("识别服务没响应，请再说一遍", [255, 120, 0], 3200);
    });
}

// 所有输入（语音/文字/按键）统一走这里：菜单 > 喊停 > 引擎
function handleUtterance(text) {
  const t0 = String(text || "").trim();
  const nowMs = performance.now();
  // ★ 同一句会被流式切两段连触发两次（日志里「下一页」就翻了两页），900ms 内同文只执行一次
  if (t0 && t0 === app.lastSay.text && nowMs - app.lastSay.at < 900) {
    console.log("COOK_DEDUP " + JSON.stringify(t0));
    if (app.mode === "menu") noteHeard(t0);
    return;
  }
  app.lastSay.text = t0;
  app.lastSay.at = nowMs;
  clearNotice(); // 有新指令进来，先撤掉上一条临时提示
  // 0) 菜单模式：只处理选菜
  if (app.mode === "menu") { handleMenuUtterance(text); return; }
  // 0.5) 跟做中说了翻页词 → 告诉用户得先回菜单（否则完全没反应，像死机）
  if (matchWord(text, NEXT_PAGE_WORDS) || matchWord(text, PREV_PAGE_WORDS)) {
    notify("现在是跟做中 · 说「换菜」回菜单再翻页", [255, 180, 0], 3200);
    return;
  }
  // 1) 跟做中随时可以换菜
  // 「换菜」识别经常走样（换成"换到菜""换一道"），用宽松匹配兜一下
  if (matchWord(text, MENU_WORDS) || /换.{0,2}菜|换一道|换道菜|重选|菜单|选菜/.test(text)) {
    enterMenu("好，重新选菜");
    return;
  }
  // 1.5) 「开始计时」：用户准备好之后才起表（暂停中不处理）
  if (!app.paused && matchWord(text, TIMER_START_WORDS) && startStepTimer()) return;
  // 1.6) 「跳过」≡「下一步」：跳过当前步骤
  if (matchWord(text, SKIP_WORDS)) { console.log("COOK_SKIP " + JSON.stringify(text)); text = "下一步"; }
  // 2) 暂停中：默认只听「继续」，但明确说「下一步 / 跳过 / 上一步 / 完成了」照做
  //    ★ 暂停的意思是「别自己往下走」，不是把操作锁死（计时没走完也能跳过）
  if (app.paused) {
    if (matchWord(text, RESUME_WORDS)) {
      doResume();
      show(app.session.present()); // 恢复原步骤画面
    } else if (matchWord(text, STOP_WORDS)) {
      doPause("已经在暂停中 · 说「继续」");
    } else if (matchWord(text, ADVANCE_WORDS)) {
      doResume();                  // 先解除暂停，再照常推进
      show(app.session.handle(text, performance.now()).display);
    } else {
      notify("已暂停 · 说「继续」接着做，或直接说「下一步」「跳过」", [255, 120, 60], 2600);
    }
    return;
  }
  // 2) 任何时候喊停：立即暂停（不进引擎）
  if (matchWord(text, STOP_WORDS)) {
    doPause();
    return;
  }
  // 3) 正常交给引擎
  show(app.session.handle(text, performance.now()).display);
}

// ---- 导航键映射（语音之外的操作兜底；菜单模式不响应） ----
function handleAction(action) {
  if (app.mode === "menu") return null;
  if (app.paused) {
    if (action === "activate") { doResume(); show(app.session.present()); }
    return null; // 暂停中其余按键不动作
  }
  if (action === "activate") return app.session.handle("下一步", performance.now()).display;
  if (action === "back") return app.session.handle("上一步", performance.now()).display;
  return null;
}

// ---- 主循环 ----
function tick() {
  app.frame = null;
  if (!app.active || !view.window) return;
  const now = performance.now();

  // 1) 免手模式：麦克风一结束就立刻再开（80ms，尽量不断档），全程用不着按键
  if (app.micWanted && !app.busy && !voice.state.includes("recording") && !voice.state.includes("pending")) {
    if (now >= app.micRestartAt) {
      if (voice.request()) app.micRestartAt = now + 80;    // 立刻续上下一段采集
      else app.micRestartAt = now + 3000;                  // 开不起来就慢点重试，别刷屏
    }
  }
  // 2) 驱动音频事件与 VAD
  voice.poll(now);
  // 2.5) 刚接通麦克风 → 立刻给个明确反馈（不然 pending/recording 看着一样，像没反应）
  if (app.micState !== voice.state) {
    const prev = app.micState;
    app.micState = voice.state;
    if (voice.state === "recording" && prev !== "recording") {
      notify("麦克风已接通 · 直接说话就行", [0, 255, 90], 1800);
    }
  }
  // 3) 导航输入
  for (let i = 0; i < 4; i++) {
    let action = null;
    try { action = os.takeNavigationAction(); } catch (e) { break; }
    if (!action) break;
    const display = handleAction(action);
    if (display) show(display);
  }
  // 4) 文字输入（调试备胎 · 数字1-9=快捷指令，直接打中文也支持）
  for (let i = 0; i < 2; i++) {
    let submission = null;
    try { submission = input.takeTextInput(); } catch (e) { break; }
    if (!submission) break;
    const raw = String(submission.text || "").trim();
    if (!raw) break;
    const text = app.mode === "cooking" ? (QUICK_COMMANDS[raw] || raw) : raw;
    if (text !== raw) console.log("COOK_TEXT quick[" + raw + "] -> " + JSON.stringify(text));
    else console.log("COOK_TEXT " + JSON.stringify(text));
    handleUtterance(text);
  }
  // 5) 倒计时推进（暂停时冻结；菜单模式没有倒计时）
  {
    const dt = Math.min(1000, Math.max(0, now - (timer.lastNow || now)));
    timer.lastNow = now;
    if (app.mode === "cooking" && app.session) {
      const st = app.session.getState();
      if (!app.paused && !st.finished) {
        const step = app.session.currentStep();
        const needTimer = !!(step && step.timer);   // 只有明确写了时长的步骤（焖/腌/焯水/冷藏）
        if (!needTimer) {
          // 切菜、打蛋、拌匀、装盘这类不需要计时 → 倒计时行留空
          timer.stepId = step ? step.id : null;
          timer.remainMs = 0;
          timer.running = false;
          setText(view.timer, shown, "timer", "");
        } else {
          if (step.id !== timer.stepId) {
            // 换步骤：时长换成这一步的，但【不自动开始】，等用户说「开始计时」
            timer.stepId = step.id;
            timer.remainMs = step.timeMs || 0;
            timer.running = false;
          }
          if (!timer.running) {
            // 还没开始：只提示时长和启动口令（用户可能锅还没热）
            setText(view.timer, shown, "timer",
              "⏱ " + fmtMs(timer.remainMs) + " · 说「开始计时」");
          } else {
            timer.remainMs = Math.max(0, timer.remainMs - dt);
            setText(view.timer, shown, "timer",
              timer.remainMs > 0 ? "⏱ " + fmtMs(timer.remainMs) : "⏰ 时间到 · 说「下一步」");
          }
        }
      } else if (st.finished) {
        setText(view.timer, shown, "timer", "");
      }
      // 暂停时 timer 行由 doPause 写提示语，这里不覆盖
    }
  }
  // 6) 上屏（内部只提交变化）
  paintSession();
  app.frame = os.requestAnimationFrame(tick);
}

function resume() {
  if (!view.window || app.active) return;
  app.active = true;
  app.micWanted = true;
  timer.lastNow = performance.now();
  app.frame = os.requestAnimationFrame(tick);
}
function pause() {
  app.active = false;
  voice.stop(); // 后台必须停采集（平台也会强制收回会话）
  if (app.frame !== null) os.cancelAnimationFrame(app.frame);
  app.frame = null;
}

// ---- 生命周期 ----
os.App.createApp((lifecycle) => {
  console.log("COOK_LIFECYCLE " + lifecycle);
  if (lifecycle === os.AppLifecycle.ON_CREATE) start();
  else if (lifecycle === os.AppLifecycle.ON_FOREGROUND || lifecycle === os.AppLifecycle.ON_REOPEN) resume();
  else if (lifecycle === os.AppLifecycle.ON_BACKGROUND) pause();
  else if (lifecycle === os.AppLifecycle.ON_DESTROY) {
    pause();
    for (const key of Object.keys(view)) delete view[key];
  }
});
