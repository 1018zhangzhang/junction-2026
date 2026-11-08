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
const llm = require("./llm-bridge");
const agent = require("./agent");      // 联网问答：先自己答，答不上再查（没配 search 时等同于 llm.advise）
const store = require("./dish-store"); // 收藏的菜（做完说「加进去」→ 下次出现在菜单最前面）
const wrapFlow = require("./wrap");    // 收尾问答：是否收藏 / 是否再做一道 / 收工
const menuPage = require("./menu-page"); // 菜单翻页（一页 12 行，多了翻页，见 src/menu-page.js）

const view = {};
// ★ 版本号显示在界面左上角，一眼确认跑的是不是最新包（防止 run 错旧的备份 .fuiapp）
const APP_VER = "v58e";

/* ============================================================================
 * ★ 字号总控 —— 想改字的大小，只改下面这一个数字
 * ----------------------------------------------------------------------------
 *   FONT_SCALE = 1.0   现在的样子（默认）
 *   FONT_SCALE = 1.15  整体放大一点（推荐，眼镜上更清楚，不会压字）
 *   FONT_SCALE = 1.25  明显变大（菜单最后一行会贴近底部提示行，仍可用）
 *   FONT_SCALE = 0.9   整体缩小
 *
 * 改完重跑 cook-run.sh 就生效，不用动别的地方：
 * 步骤正文、对话行、菜名列表、角标、底部提示 全部按这个系数一起缩放，
 * 行距也会跟着放大，所以不会出现"字变大了、上下压在一起"。
 *
 * 只想单独调某一行：看 start() 里那几行 makeText(...)，第 4 个参数就是
 * 这一行的基础字号（progress 14 / main 30 / sub 16 / timer 20 /
 * partial 15 / mic 12 / footer 12 / 菜名 19）。改基础字号同样会乘这个系数。
 * ========================================================================== */
const FONT_SCALE = 1.0;
/** 基础字号 → 实际字号（所有文字都走这里，保证只有一处总控） */
function fs(size) {
  return Math.max(8, Math.round(Number(size || 12) * FONT_SCALE));
}

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
  menuSelected: -1,  // 菜单里高亮的那道（推荐时标出来），-1=不高亮
  menuPage: 0,       // 当前是第几页（0 起）。一页 12 道，多了靠说「下一页」翻
  busy: false,       // ASR 识别中
  said: null,        // 我刚说的那句话 { text, until }（上面那行 🗣）
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
  // 选菜动画：选中后 0.9 秒的过渡（其余菜淡出、选中的放大提亮），结束后才进跟做
  pickAnim: null,    // { index, t0 } | null
  pickTimer: null,   // 选菜动画的 33ms 自驱动定时器 id
  lastPickFail: 0,
  noSpicy: false,    // 忌口筛选：true = 辣的菜变暗避开
  // 大模型现场生成菜谱：没配密钥时永远为 null，一行网络请求都不会发
  llmPending: null,   // { text, t0 } 正在生成的那句（防重复请求）
  llmDish: null,      // 最近一次生成出来的菜（只留一道，别把 12 行菜单撑爆）
  llmDishIndex: -1,   // 它在 DISHES 里的下标
  llmFailAt: 0,       // 上次失败时间（失败后 3 秒内不重复打扰）
  llmFailReason: "",  // 上次失败原因（重试时告诉用户为什么）
  // ★ 收尾流程（做完一道菜之后）：是否把新菜加进菜单 → 是否再做一道 → 收工
  wrap: null,         // { stage:"askSave"|"askNext"|"summary", dish, canSave, saved }
  done: [],           // 本次开机做过的菜 [{ title, ms }]，收工页用来汇总
  dishStartAt: 0,     // 这道菜什么时候开始做的（算用时）
  dishAiDish: false,  // 这道菜是不是 AI 现场生成的（只有这种才问"要加进菜单吗"）
  // 对话行（像豆包那样在下面出一句话）：听懂了什么，就在这里回一句
  // ★ 必须是状态、不能直接 setText：主循环每帧都会 show(present()) 把它盖掉
  //   （这正是以前「救场答案只闪一帧、看起来像没反应」的真因）
  reply: null,        // { text, tone, until, step }
  hint: null,         // { text, until } 底栏临时提示（压过默认提示）
  chatSeq: 0,         // 每说一句 +1，用来丢弃过期的模型回答
  chatBusy: false,
  // 识别服务（asr-service，5001）是否在线：不在线时界面要直说，别再喊「没听清」
  asrOk: true,
  asrCheckAt: 0,
  asrChecking: false,
  paintStage: "?",   // 当前画到哪一步（崩溃日志用它定位真凶）
  lastPaintFail: 0,  // 绘制报错日志的节流
  lastTickFail: 0,   // 主循环报错日志的节流
  frame: null,
  active: false
};

// ---- 语音喊停 / 继续（全局优先于引擎）----
// ★ 文字对齐：TextAlign 是九宫格枚举（TOP_LEFT / LEFT_MID / RIGHT_MID / CENTER...），
//   没有单独的 LEFT。v38/v39 这里写成 ui.TextAlign.LEFT（= undefined），真机 setTextAlign(undefined)
//   直接抛 FacadeTypeMismatch，被兜底吞掉后选菜动画的每一帧都画不出来 —— 表现为「点了直接跳进做菜页」。
//   下面这个常量带三级兜底，枚举将来再改名也不会炸。
const ALIGN_LEFT = ui.TextAlign.LEFT_MID || ui.TextAlign.TOP_LEFT || ui.TextAlign.CENTER;
// ★ v83：菜单两列改成列内居中。别写 ui.TextAlign.CENTER 以外的东西 ——
//   ALIGN_LEFT 那种 "LEFT_MID || TOP_LEFT || CENTER" 的兜底是因为老版本枚举名不一致，
//   CENTER 一直存在，直接用。（教训：第一版我在创建时写了未定义的 ALIGN_CENTER，
//   ON_CREATE 直接 ReferenceError —— 屏幕上就是「一直加载中」。）
const ALIGN_CENTER = ui.TextAlign.CENTER;
const STOP_WORDS = ["停", "停下", "停一下", "停一停", "暂停", "停止", "等一下", "等等", "先别做", "别动了"];
const RESUME_WORDS = ["继续", "接着来", "接着做", "继续做", "恢复", "开始吧", "好了继续"];
// 暂停状态下也允许直接推进的指令（暂停只停「自动往下走」，不锁操作）
const ADVANCE_WORDS = ["下一步", "下一个", "跳过", "上一步", "退回去", "退一步",
  "好了", "行了", "可以了", "完成了", "都做完了"];

// ---- 菜单 ----// 说这些词随时回到选菜界面
const MENU_WORDS = ["换菜", "换个菜", "重新选", "换一个菜", "菜单", "选菜", "换一道", "换个菜做"];
// 翻页口令（菜超过 4 道才用得上）
// ★ 翻页模式已废弃：11 道菜全部摆在第一页，两列排（左 1-6、右 7-11）。
//   原因：「下一页」三个字在小模型上一直识别不稳，用户翻不动就等于看不到后面的菜。
//   现在不翻页、不分页，序号就是 1-N 的全局序号，说数字或菜名直接选。
/* ★ v83 美化：菜单整块"以 640 的中线对称"摆。
   原来左列 x=30、右列 x=325，右下角空一大块，看起来像没对齐。
   现在两列各 300 宽、间隔 320，左列 20~320、右列 320~620 —— 左右各留 20，
   每列文字在框内水平居中（align CENTER），所以"1 番茄炒蛋"和"10 麻婆豆腐"
   都落在自己那一列的正中间，两列像两根对齐的柱子。 */
const MENU_COLS = [
  { x: 30, width: 280 },    // 左列：1-6，框 30~310，文字落在 170
  { x: 330, width: 280 }    // 右列：7-11，框 330~610，文字落在 470
];
/* 两列中心 170 / 470，中点正好 320 = 640 的一半 —— 这就是"居中"的算法依据：
   左 30 右 30 边距相等、中缝 20，两列像两根对称的柱子。 */
const MENU_ROWS = 6;        // 每列最多 6 行（12 道菜以内）
/* 垂直方向：标题占 120~156，菜名从 172 起、每行 34 → 最后一行底边 372。
   整块（标题 + 菜名）落在 120~372，中心 246 ≈ 画面中线 240，
   上下留白差不多，不再"头重脚轻挤在上半屏"。 */
const MENU_ROW_Y = 172;     // 第一行 y
const MENU_ROW_H = Math.round(34 * FONT_SCALE);  // 行距（跟着字号一起缩放，字变大也不会压行）
const MENU_MAX = MENU_ROWS * MENU_COLS.length;   // 一页最多摆 12 道
const ROW_FONT = 20;        // 菜名基础字号（实际字号 = fs(ROW_FONT)）
const ROW_BOX_H = 30;       // 行框高（比字号大 10，字不会贴着框边被裁）

const NEXT_PAGE_WORDS = ["下一页", "下一批", "翻页", "更多", "还有吗", "还有别的"];
const PREV_PAGE_WORDS = ["上一页", "上一批", "往前翻", "回上一页"];
const RECOMMEND_WORDS = ["推荐", "随便", "帮我选", "有什么推荐", "吃什么好"];

/* 辣味菜名单：忌口筛选（说「不吃辣」就变暗避开）。菜谱数据里没有辣度字段，
   名单放这里最直观，加了新辣菜往数组里补一个名字就行。 */
const SPICY_TITLES = ["麻婆豆腐"];

// ---- 识别词表：按当前场景收缩 ----
// 小模型是「词表越小越准」，所以菜单只认菜名 + 序号，跟做只认指令词
// ★ v58e 起菜单重新有翻页，所以「下一页 / 上一页 / 翻页」必须回到词表里 ——
//   不在词表里的词，本地小模型根本"拼"不出来（用户之前反馈过「下一页」识别不出来，
//   那次是因为翻页被取消了；现在翻页真的要用，词得给回去）。
//   数字仍只到「十二」：编号是按本页算的，一页就 12 道。
const MENU_VOCAB = DISHES.map((d) => d.title).concat(
  ["推荐", "随便", "帮我选", "菜单", "换菜", "选菜", "做什么菜",
    "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二",
    "下一页", "上一页", "翻页", "下一屏",
    "不吃辣", "不要辣", "别太辣", "能吃辣", "要辣的"]);
/* ★ 救场词表：这些词必须进识别词表，否则小模型根本"拼"不出来。
   实测证据（日志原文）：用户说「太咸了 / 糊了」，模型输出的是
   「好嘞咸腌」「生抽可乐」「爽口老抽可乐停」——因为这些词不在语法表里，
   模型只能从词表里挑最像的硬凑。引擎侧一直是好的（太咸了→RESCUE 正常），
   坏在耳朵听不出这几个字。
   ★ 刻意带「了」：模型是按词拼的，光有「太咸」很难拼出「太咸了」。 */
const RESCUE_VOCAB = [
  "太咸了", "太咸", "咸了", "齁咸", "咸死",
  "太淡了", "太淡", "淡了", "没味",
  "太甜了", "太甜", "甜了",
  "糊了", "糊锅了", "焦了", "烧焦",
  "太老了", "老了", "柴了", "没熟", "不熟",
  "太油了", "油太多", "油少了", "油冒烟了", "冒烟了",
  "溅油", "粘锅", "太干了", "太腥",
  "怎么办"
];
const COOK_VOCAB = [
  "下一步", "下一个", "上一步", "退回去", "退一步", "跳过", "跳到下一步",
  "好了", "好啦", "行啦", "行了", "可以了", "好嘞", "继续", "接着做", "然后呢",
  "停", "停下", "暂停", "等一下", "开始计时", "计时", "倒计时", "时间到",
  // ★ 不要放「收工」「几分」：与「一共」「几步」近音，Vosk 会把「一共几步」拼成「收工油几步」
  "完成了", "都做完了", "出锅了", "换菜", "换个菜", "菜单", "选菜", "换一道",
  // ★ 动态信息处理口令：进度摘要 + 份量换算（引擎现场算，不是写死内容）
  "到哪了", "做到哪了", "进度", "现在到哪了",
  "两个人吃", "三个人吃", "四个人吃", "多做点", "少做点",
  // ★ 不要放「收工」「几分」：与「一共」「几步」近音，Vosk 会把「一共几步」拼成「收工油几步」
  "多少", "放多少", "怎么办", "为什么"
].concat(RESCUE_VOCAB);
function useVocab(kind, dishIndex) {
  if (kind === "menu") { voice.configure({ vocab: MENU_VOCAB }); return; }
  if (kind === "wrap") { voice.configure({ vocab: wrapFlow.VOCAB }); return; }   // 收尾只认"要/不用/算了/收工"
  const dish = DISHES[dishIndex >= 0 ? dishIndex : 0];
  voice.configure({ vocab: COOK_VOCAB.concat(dish ? [dish.title] : []) });
}

// ---- 「跳过」= 下一步（跳过当前步骤，直接做后面的）----
const SKIP_WORDS = ["跳过", "跳过这步", "跳过这一步", "跳过去", "跳过当前", "跳到下一步"];

/* ---- 让大模型帮忙"听错纠正"时，可以归类的固定口令 ----
 * 只放引擎真认的动作词：模型只能从这张表里挑，不许自己造句。
 * 注意别把「太咸了」这类救场词放进来 —— 那是引擎的活，放进来会被抢成口令。*/
const AI_COMMANDS = [
  "下一步", "上一步", "暂停", "继续", "跳过这步", "跳过", "再说一遍",
  "换菜", "做好了", "完成了", "撤销", "取消", "开始计时", "倒计时", "火太大", "还没好",
];

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
 *  看菜名左边 6 个字 —— 「做个番茄炒蛋」里的「做个」不算否定。
 *  ★ 原来是 3 个字，漏掉一种情况：别名比菜名更靠后。
 *    「不想做番茄炒蛋」里「炒蛋」在第 5 位，前 3 字只有「做番茄」，查不到否定 →
 *    被当成「要做」，直接开始做菜。窗口放到 6 就够覆盖「不想做」+「番茄」。 */
function dishNegated(text, pos) {
  if (pos <= 0) return false;
  const head = String(text).slice(Math.max(0, pos - 6), pos);
  return /(不要|不想|不用|不吃|不做|别|算了)/.test(head);
}

/* 菜单序号：**按本页算**（本页印 1-12，说「5」就是本页第 5 道）。
   v58e 起菜单重新支持翻页，所以这里带一个 offset：第 2 页的「3」= 全局第 15 道。
   为什么不印全局号：识别词表里只有「一…十二」，说「十三」小模型拼不出来，
   页内编号才能一直说下去。 */
const CN_DIGIT = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };

function pickByIndex(text, total, offset) {
  // 「等一会儿」「一下」「一点」里的「一」不是序号 —— 以前会把「再等一会儿」当成为 1 号，
  // 直接把番茄炒蛋开做了。先把这类口语里的「一」摘掉再认数字。
  const t = String(text || "").trim().replace(/一(会儿|下|点|起|直|样|些|边|定|共|块|阵)/g, "");
  if (!t || t.length > 12) return -1;                 // 太长多半是在说话，不是报数
  // 「下一个」里含「一」、「上一个」里也含「一」，先排除滚动词
  if (/(下一?个|上一?个|下一?道|上一?道|下一页|上一页|下道|上道)/.test(t)) return -1;
  let n = 0;
  const m = t.match(/(\d{1,2})/);
  if (m) {
    n = Number(m[1]);
  } else {
    const c = t.match(/([一二两三四五六七八九十]{1,3})/);
    if (c) {
      const s = c[1];
      if (s.length === 1) {
        n = s === "十" ? 10 : (CN_DIGIT[s] || 0);
      } else {
        const at = s.indexOf("十");
        if (at < 0) {
          n = CN_DIGIT[s] || 0;
        } else {
          const head = at === 0 ? 1 : (CN_DIGIT[s.slice(0, at)] || 0);
          const tailStr = s.slice(at + 1);
          n = head * 10 + (tailStr ? (CN_DIGIT[tailStr] || 0) : 0);
        }
      }
    }
  }
  const max = Math.min(total || 0, MENU_MAX);
  if (n >= 1 && n <= max) return (offset || 0) + n - 1;
  return -1;
}

/* ── 菜名同音容错 ────────────────────────────────────────────────────────
 * 本地识别最常见的错法是「同音/近音换字」，不是整句听不懂：
 *   麻婆豆腐 → 马婆豆腐、糖醋排骨 → 汤醋排骨、可乐鸡翅 → 可乐鸡次
 * 一字不差的 indexOf 完全接不住这类错字，用户只能重说一遍。这里按「同音字族」
 * 把字折成同一个键，再做带权编辑距离：同族字算对（代价 0），其余算错（代价 1）。
 *
 * 刻意保守，宁可说「没对上」也不乱开做：
 *   · 只处理 ≤12 字的短句（长句里偶然撞字太多）
 *   · 菜名至少 3 个字才做容错（2 字词太容易撞）
 *   · 允许的错字量：6 字以内 1 个、6 字以上 2 个
 *   · 两道菜打平就放弃（不猜），否定句仍然走 dishNegated
 * 代价：纯本地、零请求、断网可用。
 */
const HOMO_GROUPS = [
  "番翻反帆繁", "茄且伽", "炒吵抄超草", "蛋但旦淡弹单担",
  "可克课客渴", "乐了勒热", "鸡机基级几积激", "翅次刺赤瓷词",
  "拍排牌派徘", "黄王皇簧煌", "瓜挂刮寡卦",
  "红虹洪宏鸿", "烧勺少绍哨稍", "肉漏揉柔", "饭范犯贩",
  "紫子字自籽仔", "菜猜才采彩材", "花华化话画",
  "汤糖躺烫唐堂", "西希夕吸洗喜", "柿是事市式士试", "面棉免眠绵",
  "清青轻请情晴", "蒸争正整证征", "鲈卢路如鲁露", "鱼于雨语余与玉",
  "麻马妈码嘛骂", "婆破坡泼颇", "豆斗都抖逗", "腐付父富服副负",
  "蒜算酸孙兰蓝", "蓉荣容融溶绒",
  "醋促粗簇错", "骨古谷顾鼓股", "排拍牌派"
];
const HOMO_KEY = (function () {
  const m = Object.create(null);
  for (let g = 0; g < HOMO_GROUPS.length; g++) {
    const chars = HOMO_GROUPS[g];
    for (let i = 0; i < chars.length; i++) m[chars[i]] = g;
  }
  return m;
})();

function homoEq(a, b) {
  if (a === b) return true;
  const ka = HOMO_KEY[a];
  return ka !== undefined && ka === HOMO_KEY[b];
}

/* ★ 容错规范（用户实测「红烧茄子 → 红烧肉」之后定的）：
 *   只有「同音/近音的字被听错」才算同一道菜；换了字就不算。
 *   反例：红烧茄子 ≠ 红烧肉（茄/肉不同音）、番茄牛腩 ≠ 番茄炒蛋、青椒肉丝 ≠ 红烧肉。
 *   正例：拍王瓜 → 拍黄瓜（王/黄同音组）、紫菜蛋花糖 → 紫菜蛋花汤、蛋炒范 → 蛋炒饭。
 *   原来允许"任意一个字不同"，等价于拿最像的菜硬套 —— 用户说的"覆盖性识别"就是它。
 *   现在非近音替换代价记 99（等于禁止），只保留"同音错字"和"多/少一个字"。*/
function subOk(a, b) {
  if (a === b) return true;
  return homoEq(a, b);          // 同音/近音组：这才叫听错
}

/** 同长度逐字对齐：每个位置都必须是「相同或同音」才算同一道菜 */
function subAllOk(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!subOk(a[i], b[i])) return false;
  return true;
}

/** 这段和菜名是不是「同一道菜被听错」：99 = 不是；0 = 一字不差；1 = 多/少一个字。
 *  ★ 为什么不用编辑距离：删一个字(1)+插一个字(1)=2，等于把"换一个字"伪装成 2，
 *    「红烧茄子」就这么被判成「红烧肉」。按位对齐没有这个漏洞 ——
 *    换字必须过 subOk（同音/近音），否则整段作废。 */
function nearWordDist(word, title) {
  if (word === title) return 0;
  if (word.length === title.length) return subAllOk(word, title) ? 0 : 99;
  if (word.length === title.length + 1) {          // 多听出一个字（红烧肉肉）
    for (let i = 0; i < word.length; i++) {
      if (subAllOk(word.slice(0, i) + word.slice(i + 1), title)) return 1;
    }
  }
  if (word.length + 1 === title.length) {          // 漏听一个字（红烧）
    for (let i = 0; i < title.length; i++) {
      if (subAllOk(word, title.slice(0, i) + title.slice(i + 1))) return 1;
    }
  }
  return 99;
}

// 最近一次容错命中的信息，给界面显示「听成 X → 理解成 Y」
let lastFuzzy = null;

/** 同音容错匹配，返回菜下标；没把握就返回 -1 */
function fuzzyDish(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 12) return -1;
  if (/^(下一步|上一步|好了|停|重来|取消|退出)$/.test(raw)) return -1;
  // 带否定的句子一律不做容错 —— 容错本来就没把握，绝不能用它把「不想吃」变成开做
  if (/(不要|不想|不用|不吃|不做|别做|算了)/.test(raw)) return -1;
  const hits = [];
  for (let i = 0; i < DISHES.length; i++) {
    const title = DISHES[i].title;
    const L = title.length;
    if (L < 3) continue;
    // ① 整句就是这道菜（这里才允许"漏听一个字"：红烧肉 → 红烧）
    let best = nearWordDist(raw, title);
    // ② 句子里含着这道菜（允许"多听一个字"：红烧肉肉）；★ 不再取更短的片段，
    //    否则「红烧茄子」里的「红烧」会被当成"红烧肉漏听了一个字"——正是覆盖性误判。
    for (let wl = L; wl <= L + 1; wl++) {
      for (let s = 0; s + wl <= raw.length; s++) {
        const d = nearWordDist(raw.slice(s, s + wl), title);
        if (d < best) best = d;
      }
    }
    if (best <= (L >= 6 ? 2 : 1)) hits.push({ i: i, best: best, title: title });
  }
  if (!hits.length) return -1;
  hits.sort(function (x, y) { return x.best - y.best; });
  if (hits.length > 1 && hits[1].best === hits[0].best) return -1;   // 打平不猜
  lastFuzzy = { index: hits[0].i, heard: raw, title: hits[0].title };
  return hits[0].i;
}

/** 剥掉"我想吃 / 来个 / 一份 / 吧 / 怎么做"这类前后缀，留下菜本身。
 *  只用于别名判定：别名必须覆盖整个"菜核"，才说明用户点的就是它。 */
function dishCore(text) {
  let x = String(text || "").replace(/[\s。，！？、.,!?]/g, "");
  for (let k = 0; k < 3; k++) {   // 「麻烦帮我做个」这种叠着说的，剥三轮
    x = x.replace(/^(麻烦|帮我|给我|请|我想|我要|想吃|想做|要|点|来一份|来一个|来份|来个|来|做|吃|一个|一份)+/, "");
  }
  for (let k = 0; k < 3; k++) {
    x = x.replace(/(可以吗|行吗|好吗|怎么做|咋做|怎么弄|怎么办|的做法|吧|呢|啊|呀|哦|嘛|了|的)+$/, "");
  }
  return x;
}

/** 大模型给的"听错纠正"结论，必须过这一关：
 *  只有在「原话里就含着这道菜」或「只差一个音近字」时才算纠正，
 *  否则一律判为"用户在说别的菜"——不许模型拿相似的另一道菜覆盖原话。
 *  为「红烧茄子 → 红烧肉」这种情况把门。*/
function nearMissOf(heard, title) {
  const t = String(heard || "").replace(/[\s。，！？、.,!?]/g, "");
  const w = String(title || "");
  if (!t || !w || w.length < 2) return false;
  if (t.indexOf(w) >= 0) return true;                 // 「我想吃红烧肉」这种，原话里就有
  if (nearWordDist(t, w) <= 1) return true;      // 整句就是这道菜（含漏听一个字）
  const L = w.length;
  for (let wl = L; wl <= L + 1; wl++) {          // 句子里含着（含多听一个字）
    for (let s = 0; s + wl <= t.length; s++) {
      if (nearWordDist(t.slice(s, s + wl), w) <= 1) return true;
    }
  }
  return false;
}

/** 把一句话匹配到某道菜（先精确菜名，再别名/关键词，再同音容错，最后页内序号）
 *  numLimit / numOffset：页内编号的上限与跨页偏移；不传 = 全菜单 1-12 当一页用。
 *  菜名匹配不受页码限制 —— 菜名永远能跨页找到。 */
function matchDish(text, numLimit, numOffset) {
  const t = String(text);
  for (let i = 0; i < DISHES.length; i++) {
    const at = t.indexOf(DISHES[i].title);
    if (at >= 0 && !dishNegated(t, at)) return i;
  }
  // 别名/关键词：按「命中的词有多长」优先，而不是按菜的顺序先到先得。
  // ★ 历史坑①：说「汤醋排骨」（糖被听成汤），紫菜蛋花汤的别名「汤」先命中，
  //   直接被判成要喝汤。现在长词优先，且单字别名只在「就俩字」时才认。
  // ★ 历史坑②（用户实测「番茄牛腩 → 番茄炒蛋」）：别名只要"句中包含"就命中，
  //   于是任何带「番茄」两个字的菜都变成番茄炒蛋。现在收紧为：
  //   去掉「我想吃 / 来个 / 吧 / 怎么做」这类前后缀之后，整句必须**就是**这个别名。
  //   —— 用户说的是另一道菜时，宁可当成"菜单里没有"（联网生成），也不许改他的菜。
  const core = dishCore(t);
  let bestWord = -1;
  let bestLen = 0;
  for (let i = 0; i < DISHES.length; i++) {
    for (const w of (DISHES[i].vocab || [])) {
      if (w.length < 2 && core.length > 2) continue;  // 「汤」「煎」这种单字别名太容易撞
      if (w.length <= bestLen) continue;
      if (core === w && !dishNegated(t, t.indexOf(w))) { bestWord = i; bestLen = w.length; }
    }
  }
  if (bestWord >= 0) return bestWord;
  // 序号选菜：按当前页印的号算（第 2 页说「3」= 全局第 15 道）
  const byNum = pickByIndex(
    t,
    numLimit === undefined ? DISHES.length : numLimit,
    numOffset || 0
  );
  if (byNum >= 0) return byNum;
  // 最后兜一层：同音字被听错了（「马婆豆腐」）
  lastFuzzy = null;
  return fuzzyDish(t);
}

function paintMenu() {
  const total = DISHES.length;
  // ★ v58e：菜可能"少了一道"（收尾说「算了」，那道生成菜被撤掉），页码要跟着收回来，
  //   否则会停在一个空页上，看起来像菜单丢了。
  const pages = menuPage.pageCount(total);
  const page = menuPage.clamp(app.menuPage, total);
  if (page !== app.menuPage) app.menuPage = page;
  const onPage = menuPage.countOn(page, total);
  // 页码/总数变了才记一行：翻页有没有真的生效、菜有没有被顶掉，看日志就知道
  const sig = page + "/" + pages + " n=" + total;
  if (shown.menuSig !== sig) {
    shown.menuSig = sig;
    dlog("COOK_MENU page=" + (page + 1) + "/" + pages + " n=" + total + " onPage=" + onPage);
  }
  app.paintStage = "menu:applyMain";
  applyMainLayout(true);
  app.paintStage = "menu:progress";
  // ★ v83：顶栏只留必要信息。★ v58e：多页时补一段「2/3 页」，编号按本页算。
  setText(view.progress, shown, "progress",
    "菜单 · " + (pages > 1 ? (page + 1) + "/" + pages + " 页 · " : "")
      + "编号 1-" + onPage + " · " + APP_VER);
  app.paintStage = "menu:main";
  setText(view.main, shown, "main", "今天做什么菜？");
  app.paintStage = "menu:sub";
  setText(view.sub, shown, "sub", "");       // 菜名改成逐行控件，这行不用了
  app.paintStage = "menu:rows";
  paintMenuRows();
  // ★ 听到的话放中间空行（y=92），最上面那条（y=64）留给临时提示，两条互不抢
  app.paintStage = "menu:heard";
  const colKey = app.heardLive ? "live" : "final";
  if (shown.heardColor !== colKey) {
    shown.heardColor = colKey;
    view.partial.getLocalStyle().setTextColor(ui.Color.fromRGB8(
      app.heardLive ? 0 : 255, app.heardLive ? 255 : 200, app.heardLive ? 120 : 0));
  }
  app.paintStage = "menu:partial";
  setText(view.partial, shown, "partial", menuHeardLine());
  app.paintStage = "menu:timer";
  setText(view.timer, shown, "timer", "");   // 菜单页没有倒计时
  app.paintStage = "menu:footer";
  setText(view.footer, shown, "footer",
    (pages > 1 ? "🎙 说本页编号或菜名 · 「下一页」翻页" : "🎙 说编号或菜名")
      + " · 「不吃辣」避开辣菜");
  app.paintStage = "menu:done";
}

/* 标题区高度按模式切换：
   跟做时 main 要装长步骤说明（200px）；菜单时它只放一句「今天做什么菜？」，
   而下面 6 行菜名从 y=162 开始 —— 200px 高的框会盖住菜名（文字在框里居中就更惨）。
   所以菜单模式把它压成 120~156 的窄带，只在切模式时改一次。 */
function applyMainLayout(menuMode) {
  if (shown.mainLayout === menuMode) return;
  shown.mainLayout = menuMode;
  if (menuMode) {
    view.main.setPosition([0, 120, 0]);
    view.main.setSize([640, 36, 0]);
  } else {
    view.main.setPosition([0, 120, 0]);
    view.main.setSize([640, 200, 0]);
  }
  shown.main = "";   // 尺寸变了，强制重画一次
}

/* 菜单列表：每道菜一个独立文本控件（左列 1-6、右列 7-11）。
   为什么不用一个控件塞 11 行：平台的 Text 对 \n 换行没有明确支持，
   逐行控件更稳，还能单独把推荐那道点亮。 */
/* ---- 选菜动画：选中后 0.9 秒，其余菜颜色变暗消失，选中的放大提亮 ----
   为什么放在菜单层而不是引擎层：这纯是"看着舒服"的事，和判断逻辑无关，
   出问题最多是不好看，不会让任何口令失效（比赛现场风险最低的地方）。 */
// ★ 动画开关：改成 0 = 关掉放大淡出动画，只把选中的菜换成高亮色、停 180ms 再进做菜页
//   （比赛现场若嫌动画花时间或出意外，改这一个数字就有降级效果，不必删代码）
const PICK_ANIM_MS = 900; // 0 = 只高亮不播动画；900 = 0.9 秒放大淡出过程
const PICK_HOLD_MS = 260;           // 关动画时"高亮亮一下"的停留时长
const pickDuration = () => (PICK_ANIM_MS > 0 ? PICK_ANIM_MS : PICK_HOLD_MS);
const ROW_RGB = [0, 200, 90];       // 常规菜名绿
const ROW_HOT_RGB = [0, 255, 120];  // 推荐点亮
const PICK_RGB = [255, 255, 235];   // 选中后提亮到近白
const PICK_CY = 208;                // 选中后停留的垂直中心

function rowPos(i) {
  const col = i < MENU_ROWS ? 0 : 1;
  const row = i < MENU_ROWS ? i : i - MENU_ROWS;
  return { col: col, y: MENU_ROW_Y + row * MENU_ROW_H };
}
function mixRgb(a, b, k) {
  const f = Math.max(0, Math.min(1, k));
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f)
  ];
}
function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }

/** 给某一行上样式。每个属性都比对上一次的值，没变就不调原生接口（避免每帧重设）。 */
function styleRow(i, o) {
  const row = view.menuRows[i];
  if (!row) return;
  const geo = o.x + "," + o.y + "," + o.w + "," + o.h + "," + o.size;
  if (shown["rowGeo" + i] !== geo) {
    shown["rowGeo" + i] = geo;
    app.paintStage = "row" + i + ":pos";
    row.setPosition([o.x, o.y, 0]);
    app.paintStage = "row" + i + ":size";
    row.setSize([o.w, o.h, 0]);
    app.paintStage = "row" + i + ":font";
    const s = row.getLocalStyle();
    s.setTextAlign(ALIGN_CENTER); // ★ v83 列内居中（全程恒定，不存在"中途改对齐文字会跳"）
    const font = ui.Font.getCachedFont("", o.size, 0, 0);
    if (font) s.setTextFont(font);
  }
  const cs = o.rgb.join(",");
  if (shown["rowC" + i] !== cs) {
    shown["rowC" + i] = cs;
    app.paintStage = "row" + i + ":color";
    row.getLocalStyle().setTextColor(ui.Color.fromRGB8(o.rgb[0], o.rgb[1], o.rgb[2]));
  }
  app.paintStage = "row" + i + ":text";
  setText(row, shown, "row" + i, o.text);
}

function beginPick(i) {
  if (app.pickAnim) return;
  // ★ v58e：选中的菜可能不在当前页（说菜名 / 推荐跨页）——先把页翻过去，
  //   否则动画会在别的行上放大，或者压根看不到。
  app.menuPage = menuPage.pageOf(i, DISHES.length);
  app.menuSelected = i;
  app.pickAnim = { index: i, t0: performance.now() };
  dlog("COOK_PICK begin idx=" + i + " t0=" + Math.round(app.pickAnim.t0));
  app.heard.text = "";   // 别让"听到的话"那行占着位置
  app.heardLive = "";
  startPickTimer();      // ★ 动画自驱动：不等平台的慢帧（实测模拟器 rAF 约 2s 才回调一次）
}

// ---- 选菜动画驱动 ----
// 模拟器的 requestAnimationFrame 实测约 2 秒才回调一次，0.9 秒的动画
// 在两帧之间就被判"播完"直接跳页。所以动画帧用独立定时器推，播完自己进做菜页。
function startPickTimer() {
  stopPickTimer();
  app.pickTimer = setInterval(drivePick, 33);
}
function stopPickTimer() {
  if (app.pickTimer !== null && app.pickTimer !== undefined) {
    try { clearInterval(app.pickTimer); } catch (e) {}
    app.pickTimer = null;
  }
}
function drivePick() {
  const anim = app.pickAnim;
  if (!anim) { stopPickTimer(); return; }
  const now = performance.now();
  if (now - anim.t0 >= pickDuration()) {
    stopPickTimer();
    const idx = anim.index;
    app.pickAnim = null;
    try { startDish(idx); }
    catch (e) { dlog("COOK_PICK_FAIL " + paintErr(e)); }
    return;
  }
  try { paintMenuRows(); }
  catch (e) {
    const t = performance.now();
    if (!app.lastPickFail || t - app.lastPickFail > 2000) {
      app.lastPickFail = t;
      dlog("COOK_PAINT_FAIL stage=pickAnim " + paintErr(e));
    }
    return;
  }
  // ★ 关键：平台大约每 2 秒才自动上一次屏，动画帧改的字号/颜色只堆在内存里，
  //   不主动提交就永远看不到过程（真机实测：动画时序 900ms 正常但视觉瞬跳）。
  //   requestPresentation() = "捕获此调用之前的所有 Widget 变更并提交呈现"（FusionRoot.d.ts L62）
  try {
    if (view.root && typeof view.root.requestPresentation === "function") {
      view.root.requestPresentation();
    }
  } catch (e2) { /* 提交失败不影响下一帧 */ }
  anim.frames = (anim.frames || 0) + 1;
  if (anim.frames % 5 === 1) {   // 约 165ms 一条，一屏动画 6 条左右，够定位又不刷屏
    dlog("COOK_PICKF f=" + anim.frames + " t=" + Math.round(now - anim.t0)
      + "ms / " + pickDuration() + "ms");
  }
}

function paintMenuRows() {
  const total = DISHES.length;
  const page = app.menuPage;
  const start = menuPage.startOf(page, total);
  const onPage = menuPage.countOn(page, total);
  const anim = app.pickAnim;
  const p = anim && PICK_ANIM_MS > 0
    ? Math.min(1, (performance.now() - anim.t0) / PICK_ANIM_MS) : -1;  // -1 = 静态高亮
  const e = p < 0 ? 0 : easeInOut(p);
  // 动画里的下标是全局下标，画的时候要换算成本页第几行（跨页选中时也能正确放大）
  const animRow = anim ? menuPage.localOf(anim.index, page, total) : -1;

  for (let r = 0; r < MENU_MAX; r++) {
    if (!view.menuRows[r]) continue;
    if (r >= onPage) { setText(view.menuRows[r], shown, "row" + r, ""); continue; }
    const i = start + r;                       // 全局下标：这一行画的是第几道菜
    const dish = DISHES[i];
    const pos = rowPos(r);
    // ★ v83：序号补成两位（" 1" / "10"），菜名起点对齐 —— 一眼扫下去是整齐的两列。
    // ★ v58e：序号是**本页**的号（第 2 页第一道也印 1），说「1」就选它。
    let title = String(r + 1).padStart(2, " ") + "  " + dish.title;
    // 现场生成、还没说「加进去」的菜标一下，别让人以为它已经在菜单里了
    if (dish.temp && !dish.saved) title += "（新）";

    if (p < 0) {
      // 忌口筛选：说了「不吃辣」→ 辣的菜变暗 + 标记（编号不变，方便照着说）
      const spicy = app.noSpicy && SPICY_TITLES.indexOf(dish.title) >= 0;
      styleRow(r, {
        x: MENU_COLS[pos.col].x, y: pos.y, w: MENU_COLS[pos.col].width,
        h: Math.round(ROW_BOX_H * FONT_SCALE), size: fs(ROW_FONT),
        rgb: spicy ? [0, 110, 50] : (i === app.menuSelected ? ROW_HOT_RGB : ROW_RGB),
        text: spicy ? title + "（辣）" : title
      });
    } else if (r === animRow) {
      // 选中的那道：字号 19→31、颜色提到近白、缓缓挪到中央（宽度放宽，避免放大后被裁）
      const size = fs(Math.round(ROW_FONT + 12 * e));
      styleRow(r, {
        x: MENU_COLS[pos.col].x,
        y: Math.round(pos.y + (PICK_CY - pos.y) * e),
        w: 640 - MENU_COLS[pos.col].x, h: size + 14, size: size,
        rgb: mixRgb(ROW_HOT_RGB, PICK_RGB, e), text: title
      });
    } else {
      // 其余：颜色按指数变暗 → 变黑即"消失"，位置不动，视觉上像沉下去
      const fade = Math.max(0, 1 - e * 1.55);
      styleRow(r, {
        x: MENU_COLS[pos.col].x, y: pos.y, w: MENU_COLS[pos.col].width,
        h: Math.round(ROW_BOX_H * FONT_SCALE), size: fs(ROW_FONT),
        rgb: mixRgb([0, 0, 0], ROW_RGB, fade), text: fade < 0.06 ? "" : title
      });
    }
  }
}

// 菜单页「听到的话」：先说实时文字（🎙），说完换成整句（🗣）保留 2.6 秒
function menuHeardLine() {
  // ★ 顺序很重要：先说过的整句（🗣）在 SAY_MS 内优先显示，
  //   否则 Vosk 切句后吐的空草稿/碎片会把刚上屏的整句瞬间盖成「正在听…」。
  if (app.heard.text && performance.now() < app.heard.until) return "🗣 " + app.heard.text;
  if (app.heardLive) {
    // ★ 云端精识别启用时，别再显示本地小模型的草稿。
    //   本地 Vosk 常把「我想吃酸辣土豆丝」听成「我想十三麻婆豆腐」，
    //   草稿一滚出来，用户就认定"机器听不懂"，而最终用的其实是云端那句。
    //   这里只提示"正在听"，等云端结果一次性上屏 —— 宁可短，不给错字。
    if (asr.finalReady) return "🎙 正在听…（云端精识别，说完再出字）";
    return "🎙 " + app.heardLive;
  }
  return "";
}
function noteHeard(text) {
  app.heard.text = String(text || "").trim();
  app.heard.until = performance.now() + SAY_MS;   // 和跟做页保持一致：留 8 秒
  app.heard.guard = true;                        // 这 8 秒内不让草稿抢位置
  app.heardLive = "";
}

function startDish(i) {
  stopPickTimer();
  app.pickAnim = null;
  app.dishIndex = i;
  app.mode = "cooking";
  app.session = createSession(DISHES[i]);
  app.wrap = null;                     // 上一轮的收尾问答不能带进新菜
  app.dishStartAt = performance.now();
  // ★ 只有 AI 现场生成的菜（库里本来没有）才需要问"要不要加进菜单"
  app.dishAiDish = (DISHES[i] === app.llmDish) || DISHES[i].custom === true;
  app.paused = false;
  app.menuSelected = -1;
  app.lastSay = { text: "", at: 0 };   // 刚切模式，别把上一句当重复
  app.heardLive = "";
  app.said = null;                     // 上一道菜说的话不能带过来
  clearReply();        // 上一道菜的对话行不能带到新菜里
  setHint("", 0);
  useVocab("cooking", i);   // 跟做中只认指令词 + 这道菜的名字
  timer.stepId = null;
  timer.remainMs = 0;
  show(app.session.present());
  notify("已选「" + DISHES[i].title + "」· 开做！", [0, 255, 90], 2200);
}

function enterMenu(hint) {
  stopPickTimer();
  app.mode = "menu";
  app.pickAnim = null;      // 万一动画中途被打断，别卡在动画状态里
  app.dishIndex = -1;
  app.wrap = null;          // 已经在选了，收尾问答结束
  app.menuSelected = -1;    // 回菜单不高亮任何一道
  app.session = null;
  app.paused = false;
  app.lastSay = { text: "", at: 0 };
  app.heardLive = "";
  app.reply = null;         // 回菜单：上一道菜的对话行不能留在屏幕上
  app.hint = null;
  shown.heardColor = "";    // 让 paintMenu 重新上色（暂停时那行被改成过红色）
  useVocab("menu");         // 回菜单：词表切回菜名
  paintMenu();
  // 提示走 notify 浮层：以前直接写 sub 会把菜名列表盖掉，看起来像"菜单没了"
  if (hint) notify(hint, [255, 220, 0], 2000);
}

/* ════════════════════════════════════════════════════════════════════════
 * 收尾流程：一道菜做完之后的两个问题 + 收工总页
 * ------------------------------------------------------------------------
 *   问题①（只有 AI 生成的菜才问）：「X」要存进菜单吗？
 *         要 → 写进应用数据目录 custom-dishes.json，下次启动排在第 1 位
 *         不 → 什么都不做
 *   问题②：还要做下一道吗？
 *         要 → 回菜单；不 → 收工总页（列出今天做了几道、各用了多久）
 * 判定逻辑全在 src/wrap.js（纯函数，能单测），这里只负责画和存取。
 * ════════════════════════════════════════════════════════════════════════ */
function startWrap() {
  const dish = app.dishIndex >= 0 ? DISHES[app.dishIndex] : null;
  if (!dish) { enterMenu(); return; }
  const ms = app.dishStartAt ? Math.max(0, performance.now() - app.dishStartAt) : 0;

  // 记一笔"今天做过什么"，收工页用
  app.done.push({ title: dish.title, ms: ms });
  while (app.done.length > MENU_MAX) app.done.shift();

  // ★ 只问"库外菜"：AI 现生成、还没收藏过、这次也不是收藏来的
  const canSave = Boolean(app.dishAiDish && !dish.saved && !store.has(dish.title));

  app.wrap = {
    stage: canSave ? "askSave" : "askNext",
    dish: dish,
    canSave: canSave,
    saved: false,
    ms: ms,
  };
  app.mode = "wrap";
  app.session = null;           // 引擎会话到此结束，后面由 wrap 状态机接管
  app.paused = false;
  app.pickAnim = null;
  app.menuSelected = -1;
  app.reply = null;
  app.hint = null;
  // ★ 不清 app.said：刚说的那句「完成了」留在上面那行 8 秒（SAY_MS），
  //   由 paintSessionInner 的过期检查收走。直接置 null 会把字留在屏上没人清。
  if (!app.said) setText(view.partial, shown, "partial", "");   // 文字输入/无语音时别留旧字
  app.heard.text = "";
  app.heard.until = 0;
  app.heardLive = "";
  timer.running = false;
  timer.remainMs = 0;
  stopPickTimer();
  shown.wrapStage = "";         // 强制这次重上一遍字色（从跟做页可能带过来红/青色）
  useVocab("wrap");
  dlog("COOK_WRAP start dish=" + JSON.stringify(dish.title) + " canSave=" + canSave
    + " stage=" + app.wrap.stage + " ms=" + Math.round(ms));
  paintSession();               // 立刻上屏，不等下一帧
}

/** 收工总页：今天做了什么、各用多久 */
function toSummary() {
  if (!app.wrap) return;
  app.wrap.stage = "summary";
  app.wrap.at = performance.now();
  dlog("COOK_WRAP summary dishes=" + app.done.length);
  paintSession();
}

/** 把菜单那 12 行清空（收尾问答页不用列表） */
function clearMenuRows() {
  if (!view.menuRows) return;
  for (let i = 0; i < view.menuRows.length; i++) setText(view.menuRows[i], shown, "row" + i, "");
}

/** 收工页用菜名那 12 行列今天做过的菜（复用同一批控件，不额外占版面） */
function paintDoneRows() {
  for (let i = 0; i < MENU_MAX; i++) {
    if (!view.menuRows[i]) continue;
    if (i >= app.done.length) { setText(view.menuRows[i], shown, "row" + i, ""); continue; }
    const pos = rowPos(i);
    const item = app.done[i];
    let title = String(item.title || "");
    if (title.length > 8) title = title.slice(0, 8) + "…";
    styleRow(i, {
      x: MENU_COLS[pos.col].x, y: pos.y, w: MENU_COLS[pos.col].width,
      h: Math.round(ROW_BOX_H * FONT_SCALE), size: fs(ROW_FONT),
      rgb: ROW_HOT_RGB,
      text: (i + 1) + ". " + title + (item.ms ? "  " + fmtMs(item.ms) : ""),
    });
  }
}

/** 收尾页的常规字色：副标题绿、上面那行黄（临时提示会临时改掉，过期后要还原） */
function wrapColors() {
  shown.replyTone = "";
  try {
    view.sub.getLocalStyle().setTextColor(ui.Color.fromRGB8(0, 190, 90));
    view.timer.getLocalStyle().setTextColor(ui.Color.fromRGB8(255, 200, 0));
  } catch (e) { /* 画色失败不影响文字 */ }
}

function paintWrap() {
  const w = app.wrap;
  if (!w) { enterMenu(); return; }

  app.paintStage = "wrap:layout";
  if (w.stage === "summary") {
    applyMainLayout(true);    // 标题区压窄，下面腾出来列今天的菜
  } else {
    applyMainLayout(false);
    clearMenuRows();
  }
  if (shown.wrapStage !== w.stage) {
    shown.wrapStage = w.stage;
    wrapColors();            // 从跟做页带过来的"对话行青色/暂停红色"要还原
  }

  app.paintStage = "wrap:progress";
  const tag = w.stage === "askSave" ? "收尾 · 1/2"
    : w.stage === "askNext" ? "收尾 · 2/2"
      : "今日收工 · 合计 " + fmtMs(app.done.reduce((s, x) => s + (x.ms || 0), 0));
  setText(view.progress, shown, "progress", tag + " · " + APP_VER);

  app.paintStage = "wrap:tone";
  const rgb = w.stage === "summary" ? [0, 255, 120] : [0, 230, 0];
  const ck = rgb.join(",");
  if (shown.wrapMainColor !== ck) {
    shown.wrapMainColor = ck;
    view.main.getLocalStyle().setTextColor(ui.Color.fromRGB8(rgb[0], rgb[1], rgb[2]));
  }

  app.paintStage = "wrap:text";
  if (w.stage === "askSave") {
    setText(view.main, shown, "main", "「" + w.dish.title + "」要存进菜单吗？");
    setText(view.sub, shown, "sub", "说「加进去」下次排第 1 位 · 说「算了」不存");
    setText(view.timer, shown, "timer", "🍳 " + w.dish.title + " 做好了");
  } else if (w.stage === "askNext") {
    setText(view.main, shown, "main", "还想做下一道菜吗？");
    setText(view.sub, shown, "sub", "说「要」回菜单再选 · 说「不用」收工");
    setText(view.timer, shown, "timer", "🍳 " + w.dish.title + " 做好了 · 趁热吃");
  } else {
    setText(view.main, shown, "main", "🎉 收工！今天做了 " + app.done.length + " 道菜");
    setText(view.sub, shown, "sub", "");       // 这行让给下面的菜名列表
    setText(view.timer, shown, "timer", "说「再做一道」回菜单 · 收工愉快");
    app.paintStage = "wrap:rows";
    paintDoneRows();
  }
  app.paintStage = "wrap:done";
}

/** 撤掉「现场生成、但用户说算了」的那道菜。
 *  ★ v58e 修的就是这里：以前收尾说「算了」只是不写磁盘，内存里的 DISHES 还留着它，
 *    回到菜单照样看得见、还能选中 —— 用户的原话是「说算了也还是保留」。
 *    现在说了不存就立刻摘掉；真收藏过的（saved / 在 store 里）绝不误删。 */
function dropTempDish(dish) {
  const d = dish;
  if (!d || d.saved || store.has(d.title)) return false;
  const i = DISHES.indexOf(d);
  if (i < 0) return false;
  DISHES.splice(i, 1);
  if (app.llmDish === d) { app.llmDish = null; app.llmDishIndex = -1; }
  if (app.menuSelected >= DISHES.length) app.menuSelected = -1;
  app.menuPage = menuPage.clamp(app.menuPage, DISHES.length);
  dlog("COOK_TEMP drop " + JSON.stringify(d.title) + " left=" + DISHES.length);
  return true;
}

/** 收尾阶段听懂一句话：按 src/wrap.js 的判定执行 */
function handleWrapUtterance(text) {
  const w = app.wrap;
  if (!w) { enterMenu(); return; }
  const t = String(text || "").trim();
  const d = wrapFlow.decide(w.stage, t);
  dlog("COOK_WRAP say=" + JSON.stringify(t) + " stage=" + w.stage + " act=" + d.act);

  if (w.stage === "askSave") {
    if (d.act === "save") {
      const r = store.add(w.dish);
      if (r.ok) {
        w.dish.saved = true;
        w.dish.temp = false;      // 已经是正式菜谱了，不再是「（新）」
        w.saved = true;
        if (MENU_VOCAB.indexOf(w.dish.title) < 0) MENU_VOCAB.unshift(w.dish.title);
        dlog("COOK_WRAP saved " + JSON.stringify(w.dish.title) + " total=" + r.total);
        notify("已加进菜单 · 下次排第 1 位", [0, 220, 120], 2600);
      } else {
        dlog("COOK_WRAP save_fail " + r.reason);
        notify("没能存进去（" + r.reason + "）", [255, 150, 0], 3000);
      }
      w.stage = "askNext";
      paintSession();
      return;
    }
    if (d.act === "skip" || d.act === "skipMenu") {
      // ★ v58e：说了「算了 / 不用」就把这道菜从菜单里撤掉（只是不落盘不够，
      //   内存里留着它照样能被选中，用户看到的就是"说了不存却还在"）
      const dropped = dropTempDish(w.dish);
      dlog("COOK_WRAP skip dropped=" + dropped);
      if (d.act === "skipMenu") { enterMenu("好，不存了 · 回菜单再选"); return; }
      notify(dropped ? "好，不存了 · 这道已经撤出菜单" : "好，这次不存", [255, 200, 0], 2200);
      w.stage = "askNext";
      paintSession();
      return;
    }
    notify(d.say || "说「加进去」或「算了」", [255, 180, 0], 2800);
    return;
  }

  if (w.stage === "askNext") {
    if (d.act === "menu") { dlog("COOK_WRAP next"); enterMenu("好，再选一道"); return; }
    if (d.act === "summary") { toSummary(); return; }
    notify(d.say || "说「要」再选一道 · 说「不用」收工", [255, 180, 0], 2800);
    return;
  }

  // 收工页：只有明确说"再做一道 / 换菜"才回菜单
  if (d.act === "menu") { dlog("COOK_WRAP again"); enterMenu("好，再选一道"); return; }
  notify(d.say || "说「再做一道」回菜单", [255, 180, 0], 2400);
}

function handleMenuUtterance(text) {
  const t = String(text).trim();
  noteHeard(t);                       // 先把「听到的话」记下来，界面立刻有反馈
  const total = DISHES.length;
  const pages = menuPage.pageCount(total);
  // ★ v58e：真的翻页。以前这里只会回一句「不用翻页」，可菜多了（收藏 + 生成）
  //   一页根本摆不下，第 13 道起就没入口 —— 现在按页翻，编号按本页算。
  if (matchWord(t, NEXT_PAGE_WORDS) || matchWord(t, PREV_PAGE_WORDS)) {
    if (pages <= 1) {
      notify("只有这一页 · " + total + " 道菜都在这里", [255, 180, 0], 2600);
      return;
    }
    const back = matchWord(t, PREV_PAGE_WORDS);
    app.menuPage = menuPage.clamp(app.menuPage + (back ? -1 : 1), total);
    app.menuSelected = -1;
    paintMenu();
    const onPage = menuPage.countOn(app.menuPage, total);
    notify("第 " + (app.menuPage + 1) + "/" + pages + " 页 · 编号 1-" + onPage,
      [0, 220, 120], 2600);
    return;
  }
  if (matchWord(t, RECOMMEND_WORDS)) {
    let best = 0;
    for (let i = 1; i < DISHES.length; i++) if (DISHES[i].totalMs < DISHES[best].totalMs) best = i;
    if (app.noSpicy && SPICY_TITLES.indexOf(DISHES[best].title) >= 0) {
      // 忌口生效时，推荐改推最快的非辣菜（这就是「筛选」：结果跟着条件变）
      best = -1;
      for (let i = 0; i < DISHES.length; i++) {
        if (SPICY_TITLES.indexOf(DISHES[i].title) >= 0) continue;
        if (best < 0 || DISHES[i].totalMs < DISHES[best].totalMs) best = i;
      }
      if (best < 0) best = 0;
    }
    app.menuSelected = best;      // 点亮推荐那道
    app.menuPage = menuPage.pageOf(best, total);   // ★ v58e：推荐的可能在别的页，先翻过去
    paintMenu();
    const localNo = best - menuPage.startOf(app.menuPage, total) + 1;   // 页内号
    notify("推荐 " + DISHES[best].title + " · 本页 " + localNo + " 号 · 请说编号或菜名", [0, 220, 120], 5200);
    return;
  }
  // 忌口筛选：「不吃辣」→ 辣的菜变暗标「辣」，推荐避开辣的；编号不变，照说就行
  if (/不吃辣|不要辣|别太辣|不能吃辣|辣的少吃/.test(t)) {
    app.noSpicy = true;
    paintMenu();
    notify("好，辣的都标出来避开了 · 要辣的说「要辣的」恢复", [0, 220, 120], 4200);
    return;
  }
  if (/要辣的|能吃辣|爱吃辣|想吃辣|恢复菜单/.test(t)) {
    app.noSpicy = false;
    paintMenu();
    notify("好，全部菜都显示", [0, 220, 120], 3000);
    return;
  }
  const pick = matchDish(
    t,
    menuPage.countOn(app.menuPage, total),        // 本页有几道 → 编号最多到它
    menuPage.startOf(app.menuPage, total)         // 本页第一道的全局下标
  );
  if (pick >= 0) {
    // 走的是同音容错（识别字错了），要明确显示「听成 X → 当成 Y」，
    // 否则用户会以为机器在乱猜；显示出来他才知道是识别的问题、不是选错菜。
    if (lastFuzzy && lastFuzzy.index === pick) {
      dlog("COOK_HOMO " + JSON.stringify(lastFuzzy.heard) + " -> " + lastFuzzy.title);
      notify("听成「" + lastFuzzy.heard + "」，按「" + lastFuzzy.title + "」开做", [0, 220, 120], 2600);
    }
    beginPick(pick);
    return;
  }   // 先播 0.9 秒的选菜动画，再进跟做
  // ★ 本地菜谱里没有这道菜：配了密钥就现场联网生成；没配就一行网络请求都不发。
  //   这一分支就是"大模型能力"的唯一入口，失败也只影响这一句，绝不卡住主流程。
  if (looksLikeDish(t) && llm.ready()) {
    // 先做一次"听错纠正"：确认这句是不是菜单里某道菜听错了（3.2 秒）。
    // 以前这里直接去生成新菜谱，结果「沙辣土豆丝」被当成一道新菜联网生成，
    // 菜单里明明有这道菜 —— 先问一句，能对上就直接选，对不上再生成。
    notify("正在确认是不是菜单里的菜…", [0, 200, 255], 3200);
    const seq = app.chatSeq;
    llm.interpret(t, {
      dishes: DISHES.map((d) => d.title),
      commands: [],
      timeoutMs: 3200,
    }).then(function (r) {
      if (app.mode !== "menu" || seq !== app.chatSeq) return;   // 期间已经选好菜/回菜单了
      if (r && r.ok && r.type === "dish") {
        const idx = DISHES.findIndex((d) => d.title === r.value);
        // ★ 二次校验：只认"音近的一个字听错"，不认"换成相似的另一道菜"。
        //   没有这一步，模型会把「红烧茄子」硬纠正成「红烧肉」。
        if (idx >= 0 && nearMissOf(t, r.value)) {
          console.log("COOK_AI_FIX menu " + JSON.stringify(t) + " → " + r.value);
          notify("听成「" + r.value + "」· 开做", [0, 220, 120], 2600);
          beginPick(idx);
          return;
        }
        if (idx >= 0) {
          console.log("COOK_AI_REJECT menu " + JSON.stringify(t) + " =/=> " + r.value + "（不是听错，是另一道菜）");
        }
      }
      requestLlmDish(t);                                        // 确实不是菜单里的菜 → 生成
    }).catch(function () {
      if (app.mode !== "menu") return;
      requestLlmDish(t);
    });
    return;
  }
  notify("听到「" + t + "」· 没对上，请说本页编号 1-"
    + menuPage.countOn(app.menuPage, total), [255, 150, 0], 3200);
}

// ---- 大模型现场生成菜谱（可选能力）----
// 没配 llm.json 时整段代码永远走不到，行为与纯离线版完全一致。
const LLM_REASON_TEXT = {
  "not-configured": "没配密钥",
  "timeout": "网络超时",
  "auth": "密钥不对",
  "rate-limit": "调用太频繁",
  "network": "网络不通",
  "no-fetch": "运行时没有网络模块",
  "bad-json": "模型答得不对",
  "bad-dish": "菜谱不完整",
  "bad-response": "返回内容看不懂",
  "empty": "模型没说话"
};
function llmReasonText(reason) {
  const r = String(reason || "");
  if (LLM_REASON_TEXT[r]) return LLM_REASON_TEXT[r];
  if (r.indexOf("http-") === 0) return "服务返回 " + r.slice(5);
  return "没成功";
}

/** 像不像"我要做某道菜"：太短、纯数字、带指令词的都不浪费模型调用 */
function looksLikeDish(text) {
  const t = String(text || "").trim();
  if (t.length < 2) return false;
  if (/^[0-9０-９一二三四五六七八九十百]+$/.test(t)) return false;
  if (/停|继续|下一步|上一步|菜单|换菜|推荐|不吃辣|要辣的/.test(t)) return false;
  return true;
}

function requestLlmDish(text) {
  const now = performance.now();
  if (app.llmPending) { notify("还在想上一道，稍等…", [255, 180, 0], 2000); return; }
  if (app.llmFailAt && now - app.llmFailAt < 3000) {
    notify("刚没成功，缓一下再说（" + llmReasonText(app.llmFailReason) + "）", [255, 150, 0], 2600);
    return;
  }
  app.llmPending = { text: text, t0: now };
  notify("「" + text + "」不在菜单 · 正在联网生成菜谱…（约 5 秒）", [0, 200, 255], 15000);
  dlog("COOK_LLM ask " + text);
  llm.parseDish(text).then(function (r) {
    onLlmDish(text, r);
  }).catch(function () {
    onLlmDish(text, { ok: false, reason: "network" });
  });
}

function onLlmDish(text, result) {
  app.llmPending = null;
  if (!result || !result.ok) {
    const reason = (result && result.reason) || "unknown";
    app.llmFailAt = performance.now();
    app.llmFailReason = reason;
    dlog("COOK_LLM fail " + reason + " text=" + text);
    if (app.mode === "menu") {
      notify("没生成出来（" + llmReasonText(reason) + "）· 请说本页编号 1-"
        + menuPage.countOn(app.menuPage, DISHES.length), [255, 150, 0], 4200);
    }
    return;
  }
  const dish = result.dish;
  // ★ v58e：生成出来的菜一律「追加」，绝不顶掉别人。
  //   以前菜单满了就把它塞到第 12 格，把内置菜（糖醋排骨）挤没了 ——
  //   用户实测就是这个症状。现在菜单有翻页兜底，多一道就多一行。
  dish.temp = true;      // 标记：还没说「加进去」，说「算了」就撤掉
  dish.saved = false;
  let idx = -1;
  if (app.llmDish && !app.llmDish.saved) {
    // 上一次生成的还没存 → 直接换掉它，别让临时菜越攒越多
    idx = DISHES.indexOf(app.llmDish);
  }
  if (idx >= 0) {
    DISHES[idx] = dish;
  } else {
    DISHES.push(dish);
    idx = DISHES.length - 1;
  }
  app.llmDish = dish;
  app.llmDishIndex = idx;
  dlog("COOK_LLM ok " + dish.title + " steps=" + dish.steps.length + " index=" + idx);
  if (app.mode !== "menu") return;   // 生成期间用户已经选了别的菜：只记下，不打断
  paintMenu();
  notify("「" + dish.title + "」已生成 · " + dish.steps.length + " 步 · 准备开做", [0, 220, 120], 5000);
  beginPick(idx);                    // 直接进跟做：他说要做这道，就是这道
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
/* 收尾问答时的数字键：1=要（加进去/再做一道），2=不用（不存/收工）
   —— 模拟器没有麦克风时也能把这两个问题答完 */
const WRAP_KEYS = { "1": "要", "2": "不用" };

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
  size = fs(size);        // 统一按 FONT_SCALE 缩放（改字号只改顶部那一个数字）
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
  // ★ 收尾页也走"最上面那行"：收工页下面全是菜名列表，写 sub 会和列表叠字
  // ★ cache key 必须和常规文字分开：共用 "timer" 会互相污染缓存，
  //   出现过「提示写进去了但下一帧又被判定为没变化、界面始终空白」的坑
  const menuish = app.mode === "menu" || app.mode === "wrap";
  const key = menuish ? "noticeMenu" : "noticeSub";
  const target = menuish ? view.timer : view.sub;
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
    if (app.mode === "wrap") wrapColors();   // 提示期间改过的字色要还原
  }
}

// ---- 「我说的那句话」：单独一层状态，8 秒后自己收走 ----
/* 为什么要单独存：onText 把「🗣 我说的」写到上面那行之后，Vosk 还会接着吐
   一个空草稿（日志实证：COOK_STREAM final 之后紧跟 partial=""），
   一次就把刚写的字冲成空白 —— 屏幕上看就是"有正在听、没有我说的句子"。
   所以这里存成带过期时间的状态，草稿只能在它过期后、或是明显说了新的一句时才接手。*/
function saidSame(a, b) {
  const A = String(a || "").replace(/[\s。，！？、.,!?]/g, "");
  const B = String(b || "").replace(/[\s。，！？、.,!?]/g, "");
  if (!A || !B) return false;
  if (A.indexOf(B) >= 0 || B.indexOf(A) >= 0) return true;   // 草稿常是整句的一截
  let hit = 0;
  for (const ch of A) if (B.indexOf(ch) >= 0) hit++;
  return hit / Math.min(A.length, B.length) >= 0.6;          // 大半字重合就算同一句
}
function showSaid(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  app.said = { text: t, until: performance.now() + SAY_MS };
  setText(view.partial, shown, "partial", "🗣 " + t);
  return true;
}
function activeSaid() {
  const s = app.said;
  if (!s) return null;
  if (performance.now() > s.until) { app.said = null; return null; }
  return s;
}
function clearSaid() {
  if (!app.said) return;
  app.said = null;
  setText(view.partial, shown, "partial", "");
}

// ---- 对话行：听懂了，就在下面出一句话，当前那一步不动 ----
// 为什么要单独做一层：主循环每帧都会 show(app.session.present())，
// 一次性写进去的文字下一帧就没了。所以答案必须存成状态 + 过期时间。
/* ★ 答案留多久：10 分钟。
 *   用户的诉求：「他返回的回答那个句子可以一直留着，留到下一次回答，
 *   除非过了半天，才可以换回默认的句子」——所以不再 20 秒就撤，
 *   也不因为翻到下一步就撤（旧逻辑会在换步骤时清掉，见 activeReply）。*/
const REPLY_MS = 10 * 60 * 1000;
/* ★ 我说的那句话在屏幕上留多久：8 秒。
 *   太短看不清（云端识别本身要 1~2 秒），太长会一直占着上面的位置。*/
const SAY_MS = 8000;

function showReply(text, tone, ms) {
  const t = String(text || "").trim();
  if (!t) return;
  app.reply = {
    text: t,
    tone: tone || "answer",
    until: performance.now() + (ms || REPLY_MS),
    step: app.session ? app.session.getState().stepIndex : -1,
  };
  shown.sub = "";   // 清缓存，保证下一帧一定重画
  dlog("COOK_REPLY " + (tone || "answer") + " " + JSON.stringify(t.slice(0, 60)));
}

function clearReply() {
  if (!app.reply) return;
  app.reply = null;
  shown.sub = "";
}

/** 当前是否该显示对话行：只有「下一句回答」或「时间到」才会撤掉。
 *  ★ 以前翻到下一步就把答案清掉，用户反馈「刚说完的建议一转眼就没了」——
 *    现在照他说的做：答案一直留着，直到下一次回答，或 10 分钟没新回答。*/
function activeReply() {
  const r = app.reply;
  if (!r) return null;
  if (performance.now() > r.until) { app.reply = null; return null; }
  return r;
}

// 底栏临时提示（比 notify 更靠下，不抢对话行的位置）
function setHint(text, ms) {
  const t = String(text || "").trim();
  app.hint = t ? { text: t, until: performance.now() + (ms || 12000) } : null;
}

// ---- 麦克风那一行：永远告诉用户「现在能不能说话」----
function micLine() {
  const st = voice.state;
  if (app.busy) return "⏳ 正在把刚才那句转成文字…";
  // ★ 识别服务没起的时候，麦克风本身是好的 —— 必须说清是哪一头坏了
  if (!app.asrOk) return "⚠ 识别服务没连上 · 先启动 asr_server.py（5001）";
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
  if (!app.asrOk) return [255, 90, 60];
  if (app.paused) return [255, 120, 60];
  if (voice.state === "recording") return [0, 255, 90];
  if (voice.state === "pending") return [255, 180, 0];
  if (voice.lastError) return [255, 90, 60];
  return [0, 150, 0];
}

// ---- 最下面那行：按当前场景给不同的操作提示 ----
function footerHint() {
  // 对话进行中：底栏优先说"下一步能干什么"，别让用户对着答案发呆
  if (app.hint && performance.now() < app.hint.until) return app.hint.text;
  if (!asr.remoteReady) return "识别服务未连接 · 文字框打数字 1-9 也能操作";

  if (app.mode === "menu") {
    // ★ v58e：多页时提示可以翻页，并说清编号是「本页」的号
    const pages = menuPage.pageCount(DISHES.length);
    const onPage = menuPage.countOn(app.menuPage, DISHES.length);
    if (pages > 1) return "本页编号 1-" + onPage + " · 说「下一页」翻页 · 也可以说菜名";
    return "请说对应编号 1-" + onPage + " · 也可以说菜名";
  }

  // ★ 收尾页：说话内容就是这两个问题的答案，底栏直接给说法
  if (app.mode === "wrap" && app.wrap) {
    if (app.wrap.stage === "askSave") return "说「加进去」存进菜单 · 说「算了」不存";
    if (app.wrap.stage === "askNext") return "说「要」回菜单再选 · 说「不用」收工";
    return "说「再做一道」回菜单 · 收工愉快";
  }

  if (app.paused) return "说「继续」接着做 · 说「换菜」重新选一道";
  if (app.busy) return "稍等一下，正在听懂刚才那句…";

  const state = app.session.getState();
  // ★ 走到最后一步的「下一步」时引擎只是标记 finished，真正的收尾要听「完成了」
  //   （以前这里写「说换菜再选一道」，等于把用户带离了新加的收尾问答）
  if (state.finished) return "都做完了就说「完成了」· 收尾时问你要不要存进菜单";

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

  view.progress = makeText(view.canvas, 26, 30, 14, [0, 170, 0], "");
  view.main = makeText(view.canvas, 120, 200, 30, [0, 230, 0], "");
  view.sub = makeText(view.canvas, 330, 60, 16, [0, 170, 0], "");
  view.timer = makeText(view.canvas, 64, 34, 20, [255, 200, 0], ""); // 本步倒计时 / 暂停提示
  // ★ y 从 356 改成 92：原来那行和副标题（330~390）叠在一起，字压字根本看不清
  view.partial = makeText(view.canvas, 92, 26, 15, [255,255,255], "",
    { x: 12, width: 360, align: ALIGN_LEFT }); // 流式实时识别文字（左侧空白处）
  view.mic = makeText(view.canvas, 404, 24, 12, [0, 130, 0], "");
  view.footer = makeText(view.canvas, 448, 24, 12, [0, 110, 0], "");

  // ★ 菜单列表：一页摆满，两列（左 1-6、右 7-11），不再翻页
  view.menuRows = [];
  for (let i = 0; i < MENU_MAX; i++) {
    const col = i < MENU_ROWS ? 0 : 1;
    const row = i < MENU_ROWS ? i : i - MENU_ROWS;
    view.menuRows.push(makeText(view.canvas,
      MENU_ROW_Y + row * MENU_ROW_H, Math.round(28 * FONT_SCALE), ROW_FONT, [0, 200, 90], "",
      { x: MENU_COLS[col].x, width: MENU_COLS[col].width, align: ALIGN_CENTER }));
  }

  app.session = null;  // 菜单模式：还没选菜
  console.log("COOK_VOICE probe " + JSON.stringify(voice.probe()));
  useVocab("menu");   // 开场是菜单，先把识别词表收在菜名上
  voice.onPartial = onPartial;   // 流式：边说边出字
  voice.onText = onText;         // 流式：说完静音够久（默认 3 秒）出整句
  voice.onUtterance = onUtterance; // 批量退回模式（流式不可用时自动启用）
  dlog("COOK_BOOT " + APP_VER + " onText=" + (typeof voice.onText) + " dishes=" + DISHES.length);
  // 大模型是可选项：没配密钥就打一行"离线"，配了就报模型名（密钥只露尾巴）
  try {
    const st = llm.describe();
    console.log("COOK_LLM status " + (st.ready ? "online model=" + st.model : "offline"));
    dlog("COOK_LLM " + (st.ready ? "ready " + st.model : "offline · 想接大模型就把 llm.json 放到 " + st.hint));
    // 联网问答是第二层的可选项：只在真需要查资料时才会被用到
    const sg = agent.describeSearch();
    dlog("COOK_AGENT " + (sg.ready ? "search " + sg.provider + " count=" + sg.count : "search off（答不上就只靠模型常识）"));
  } catch (e) { /* 状态查询失败不影响启动 */ }
  // ★ 启动画面的绘制绝不许把整个应用带走：真机 v38 出过「启动即崩、平台反复拉起」，
  //   症状就是模拟器卡在开机画面进不去应用。崩了也要活下来，把现场写进日志再继续。
  try {
    paintSession();
  } catch (e) {
    dlog("COOK_BOOT_PAINT_FAIL " + paintErr(e));
    try { setText(view.footer, shown, "footer", "画面初始化出错了（日志已记录）· 语音操作不受影响"); } catch (e2) {}
  }
  resume();
}

/** 崩溃现场压缩成一行进日志：阶段标记 + 堆栈前 3 行 */
function paintErr(e) {
  const st = e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e);
  return "stage=" + (app.paintStage || "?") + " " + st;
}

// ---- 会话结果上屏 ----
function show(display) {
  app.paintStage = "cook:layout";
  applyMainLayout(false);   // 跟做模式：标题区恢复成 200px 高（装得下长步骤说明）
  // 跟做模式：先把菜单列表收起来，否则菜名会和步骤说明叠在一起
  if (view.menuRows) {
    for (let i = 0; i < view.menuRows.length; i++) {
      setText(view.menuRows[i], shown, "row" + i, "");
    }
  }
  app.paintStage = "cook:tone";
  const rgb = TONE_COLOR[display.tone] || TONE_COLOR.normal;
  view.main.getLocalStyle().setTextColor(ui.Color.fromRGB8(rgb[0], rgb[1], rgb[2]));
  app.paintStage = "cook:text";
  setText(view.progress, shown, "progress",
    (display.progress || "") + (display.progress ? " · " : "") + APP_VER);
  setText(view.main, shown, "main", display.main || "");
  // 对话行压过步骤补充说明：有答案时下面那行就是答案本身
  const rep = activeReply();
  if (rep) {
    // 对话行换颜色：救场=橙、普通回答=青，和绿色的步骤文字区分开
    const rRgb = TONE_COLOR[rep.tone] || TONE_COLOR.answer;
    const rKey = rep.tone;
    if (shown.replyTone !== rKey) {
      shown.replyTone = rKey;
      view.sub.getLocalStyle().setTextColor(ui.Color.fromRGB8(rRgb[0], rRgb[1], rRgb[2]));
    }
    setText(view.sub, shown, "sub", "💬 " + rep.text);
  } else {
    if (shown.replyTone) {
      shown.replyTone = "";
      view.sub.getLocalStyle().setTextColor(ui.Color.fromRGB8(0, 170, 0));
    }
    setText(view.sub, shown, "sub", display.sub || "");
  }
  shown.tone = display.tone;
  app.paintStage = "cook:done";
}

function paintSession() {
  try {
    paintSessionInner();
  } catch (e) {
    // 任何一帧画崩了都不能把进程带走（真机教训：崩→平台重启→再崩→永远进不去）
    const t = performance.now();
    if (!app.lastPaintFail || t - app.lastPaintFail > 2000) {
      app.lastPaintFail = t;
      dlog("COOK_PAINT_FAIL " + paintErr(e));
    }
    try { setText(view.footer, shown, "footer", "画面刷新出错（日志已记录）· 语音操作不受影响"); } catch (e2) {}
  }
}

function paintSessionInner() {
  app.paintStage = "entry";
  if (app.mode === "menu") paintMenu();
  else if (app.mode === "wrap") paintWrap();        // 收尾问答 / 收工总页
  else if (app.session) show(app.session.present());
  // 麦克风行：文字 + 颜色都跟着状态变，点完麦克风立刻能看出「已接通」
  // 时间到就把「我说的那句话」收走（下面那行答案不受影响，它有自己的 10 分钟）
  if (app.said && performance.now() > app.said.until) {
    app.said = null;
    setText(view.partial, shown, "partial", "");
  }
  app.paintStage = "mic";
  const rgb = micColor();
  const key = rgb.join(",");
  if (shown.micColor !== key) {
    view.mic.getLocalStyle().setTextColor(ui.Color.fromRGB8(rgb[0], rgb[1], rgb[2]));
    shown.micColor = key;
  }
  app.paintStage = "micline";
  setText(view.mic, shown, "mic", micLine());
  app.paintStage = "footer";
  setText(view.footer, shown, "footer", footerHint());
  app.paintStage = "notice";
  paintNotice();   // 必须最后：临时提示要压在上面
  app.paintStage = "log";
  // 每 2 秒把「界面上实际写着什么」记一次：用来区分「没收到」还是「收到了没画上」
  const tNow = performance.now();
  if (!app.paintLogAt || tNow - app.paintLogAt > 2000) {
    app.paintLogAt = tNow;
    dlog("COOK_PAINT mode=" + app.mode
      + " partial=" + JSON.stringify(shown.partial || "")
      + " timer=" + JSON.stringify(shown[app.mode === "menu" ? "noticeMenu" : "noticeSub"] || shown.timer || "")
      + " main=" + JSON.stringify(shown.main || "")
      + " sub=" + JSON.stringify(shown.sub || ""));   // 对话行写没写上去，一眼可查
  }
}

// ---- 流式识别回调 ----
function onPartial(text) {
  const t = String(text || "").trim();
  // 实时显示"正在说的字"
  // 菜单页：写到上面那行（partial 行会被菜名列表压住，看不见）
  if (app.mode === "menu") {
    const h = app.heard;
    if (h.guard && h.text && performance.now() < h.until) {
      if (!t) return;                  // 空草稿：忽略，保住刚上屏的整句
      if (saidSame(t, h.text)) return; // 同一句的碎片：忽略
      h.guard = false;                 // 确实在说新的一句 → 让位给「正在听…」
      h.text = "";
    }
    app.heardLive = t;
    return;   // 下一帧 paintMenu 会渲染（menuHeardLine 里已按云端模式屏蔽）
  }
  // ★ 刚说完的那句还在屏幕上（SAY_MS 内）：草稿一律不许冲掉它。
  //   空草稿（Vosk 切句后必吐一个）直接忽略；同一句的碎片也忽略；
  //   只有确实在说新的一句，才让位给「正在听…」。
  const said = activeSaid();
  if (said) {
    if (!t) return;
    if (saidSame(t, said.text)) return;
    app.said = null;    // 新的一句，让位
  }
  // ★ 云端耳朵（豆包）启用后，屏幕上不再出现本地小模型的草稿。
  //   本地 Vosk 常把「我想吃酸辣土豆丝」听成「我想十三麻婆豆腐」，
  //   草稿滚出来用户就认定"机器听不懂"，而真正用的是说完后豆包给的整句。
  //   所以这里只说"正在听…"，等整句结果一次性上屏 —— 宁可慢一秒，不给错字。
  if (asr.finalReady) {
    setText(view.partial, shown, "partial", t ? "🎙 正在听…" : "");
    return;
  }
  setText(view.partial, shown, "partial", t ? "🎙 " + t : "");
}
function onText(text) {
  dlog("COOK_HANDLE final=" + JSON.stringify(text) + " mode=" + app.mode);
  const t = String(text || "").trim();
  if (!t) {
    if (app.mode !== "menu") clearSaid();
    // ★ 服务没起 ≠ 没听清：错怪麦克风会让人一直重说
    if (!app.asrOk) {
      notify("识别服务没连上 · 先在 WSL 启动 asr_server.py（5001）", [255, 90, 60], 5000);
      return;
    }
    // 说完了但一个字都没认出来 → 显眼提示，请用户重说（走 notify，才不会被下一帧冲掉）
    notify("不好意思，可以再说一遍吗 🎤", [255, 150, 0], 3000);
    return;
  }
  // 把「听到的是什么」留在屏幕上，方便你判断是我听错了还是理解错了
  // 菜单页不写字幕行（会和菜名重叠），由 handleMenuUtterance → noteHeard 写到上面那行
  if (app.mode === "menu") app.heardLive = "";
  else showSaid(t);      // ★ 我说的话：留 SAY_MS（8 秒），不会被后续空草稿冲掉
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
        // ★ 服务没起 ≠ 没听清：这条路径是流式挂掉后的退路，最容易在服务没起时触发
        if (!app.asrOk) notify("识别服务没连上 · 先在 WSL 启动 asr_server.py（5001）", [255, 90, 60], 5000);
        else notify("没听清，请再说一遍 🎤", [255, 180, 0], 3000);
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
function handleUtterance(text, fromAi) {
  // 选菜动画正在播：这 0.9 秒里说什么都不理，避免刚选中又被另一句改掉
  if (app.pickAnim) { app.lastSay = { text: "", at: 0 }; return; }
  const t0 = String(text || "").trim();
  const nowMs = performance.now();
  // ★ 同一句会被流式切两段连触发两次（日志里「下一页」就翻了两页），900ms 内同文只执行一次
  if (t0 && t0 === app.lastSay.text && nowMs - app.lastSay.at < 900 && !fromAi) {
    console.log("COOK_DEDUP " + JSON.stringify(t0));
    if (app.mode === "menu") noteHeard(t0);
    return;
  }
  app.lastSay.text = t0;
  app.lastSay.at = nowMs;
  app.chatSeq++;          // 一旦有新的一句，之前那次的模型回答就作废（别覆盖新内容）
  clearNotice(); // 有新指令进来，先撤掉上一条临时提示
  // 0) 收尾问答：这里只认"要/不用/算了/收工"，不再走引擎
  if (app.mode === "wrap") { handleWrapUtterance(text); return; }
  // 0) 菜单模式：只处理选菜
  if (app.mode === "menu") { handleMenuUtterance(text); return; }
  // 0.5) 跟做中说了翻页词 → 告诉用户怎么回菜单（否则完全没反应，像死机）
  if (matchWord(text, NEXT_PAGE_WORDS) || matchWord(text, PREV_PAGE_WORDS)) {
    notify("现在是跟做中 · 说「换菜」回菜单重新选", [255, 180, 0], 3200);
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
      handleCookingResult(text, app.session.handle(text, performance.now()));
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
  handleCookingResult(text, app.session.handle(text, performance.now()));
}

/* ───────────── 跟做模式的结果分发（本版核心） ─────────────
 * 以前的病根：paintSession 每帧都会 show(present())，
 * 而引擎把救场答案放在 display.main 里 —— 于是答案只存在一帧（16 毫秒），
 * 界面上根本看不到；UNKNOWN 更是原样重画一遍，看起来就是"听懂了但没动作"。
 * 现在分成三类，每一类都一定给出看得见的反应：
 *   ① 救场/提问 → 正在做的那一步不动，答案走下面的对话行（可停留 20 秒）
 *   ② 完全没听懂 → 也要回一句；配了模型就让它像人一样答（这就是"对话式"）
 *   ③ 真动作（下一步/暂停/完成…）→ 照常推进
 */
function handleCookingResult(text, res) {
  const type = (res && res.intent && res.intent.type) || "UNKNOWN";
  const disp = (res && res.display) || app.session.present();

  if (type === "RESCUE" || type === "ASK") {
    const base = app.session.present();
    // 本地词表没这条时，引擎会回「这个我不确定 / 这个问题我还没准备答案」——
    // 这句话对用户毫无用处，配了模型就换成"我想想"，等真的答案。
    const noLocal = disp.tone === "ask" && llm.ready();
    // 主区域保持「第几步、在做什么」不动；答案放到下面
    show({ main: base.main, sub: base.sub, progress: disp.progress || base.progress, tone: "normal" });
    showReply(noLocal ? "嗯，我想想…" : disp.main, type === "RESCUE" ? "rescue" : "answer", noLocal ? 6000 : REPLY_MS);
    setHint(type === "RESCUE"
      ? "说「好」就按这个改法记下 · 说「下一步」照原步骤走"
      : "说「下一步」继续 · 还可以接着问", 14000);
    // 本地答案先顶上（零延迟），同时让模型给个更贴这一锅的具体做法
    askLlmAdvice(text, disp.main, type);
    return;
  }

  if (type === "UNKNOWN") {
    // ① 说的是另一道菜 → 直接告诉他怎么换，别再默默不动
    const pick = matchDish(text);
    if (pick >= 0 && pick !== app.dishIndex) {
      const cur = app.dishIndex >= 0 ? DISHES[app.dishIndex].title : "这道菜";
      showReply("现在在做「" + cur + "」· 想换说「换菜」", "corrected", 12000);
      setHint("说「换菜」回菜单重新选", 12000);
      return;
    }
    // ② 配了模型 → 先让它做一次"听错纠正"：同音字纠正成菜单里的菜或固定口令
    //    fromAi=true 说明这句本来就是模型纠正出来的，别再让模型纠自己一遍（会打转）
    if (llm.ready() && !fromAi) {
      showReply("嗯，我想想…", "ask", 5000);
      setHint("正在确认你说的是哪道菜 / 哪个口令…", 4000);
      const seq = app.chatSeq;
      llm.interpret(text, {
        dishes: DISHES.map((d) => d.title),
        commands: AI_COMMANDS,
        timeoutMs: 3200,
      }).then(function (r) {
        if (seq !== app.chatSeq || !app.session) return;      // 期间又说了新的一句 → 这次作废
        if (r && r.ok && r.type === "dish") {
          const idx = DISHES.findIndex((d) => d.title === r.value);
          // ★ 同样的二次校验：只认音近听错，不认"换成相似的另一道菜"
          if (idx >= 0 && nearMissOf(text, r.value)) {
            console.log("COOK_AI_FIX dish " + JSON.stringify(text) + " → " + r.value);
            startDish(idx);
            showReply("听成「" + r.value + "」· 开做", "corrected", 8000);
            return;
          }
          if (idx >= 0) {
            console.log("COOK_AI_REJECT dish " + JSON.stringify(text) + " =/=> " + r.value + "（不是听错）");
          }
        }
        if (r && r.ok && r.type === "cmd") {
          console.log("COOK_AI_FIX cmd " + JSON.stringify(text) + " → " + r.value);
          // 当作他说了这句口令重新走一遍（fromAi=true，避免又绕回这里打转）
          handleUtterance(r.value, true);
          return;
        }
        askLlmAdvice(text, "", "CHAT");                       // 确实不是菜也不是口令 → 当聊天
      }).catch(function () {
        if (seq !== app.chatSeq || !app.session) return;
        askLlmAdvice(text, "", "CHAT");
      });
      return;
    }
    // ③ 纯离线：也必须明确回一句，不能"看起来没反应"
    showReply("这句我没接住 · 可以说「下一步」「太咸了」「换菜」", "ask", 10000);
    return;
  }

  // 其余意图都是真动作（下一步 / 上一步 / 暂停 / 做好了…）→ 主步骤推进
  // ★ 但下面那行的答案不撤：用户要求「回答一直留着，留到下一次回答」。
  //   旧逻辑这里调了 clearReply()，一翻页建议就消失 —— 正是他说的"一转眼就没了"。
  setHint("", 0);
  show(disp);
  // ★ 整道菜做完（说「完成了」）→ 进入收尾问答：要不要收藏 / 要不要再做一道
  if (type === "FINISH") startWrap();
}

/** 把当前处境 + 用户那句话交给模型，换回一句话放到对话行。
 *  kind: "CHAT"=纯闲聊/听不懂的问题 | "RESCUE"=故障 | "ASK"=提问 */
function askLlmAdvice(said, localAnswer, kind) {
  if (!llm.ready() || !app.session) return;
  const st = app.session.getState();
  const step = app.session.currentStep();
  const stepIndex = st.stepIndex;
  const seq = app.chatSeq;            // 期间用户再说一句，这个序号就过期了
  dlog("COOK_CHAT ask kind=" + kind + " " + JSON.stringify(String(said || "").slice(0, 20)));
  agent.answer({
    dish: app.dishIndex >= 0 && DISHES[app.dishIndex] ? DISHES[app.dishIndex].title : "",
    stepIndex: stepIndex,
    total: st.total,
    step: step ? step.ask : "",
    detail: step ? step.detail : "",
    said: String(said || ""),
    local: String(localAnswer || ""),
    // 第二步（去查资料）要花几秒：界面得说清楚在干什么，不然像是卡住了
    onStage: function (stageName) {
      if (seq !== app.chatSeq) return;
      if (stageName === "search") setHint("这句得查一下 · 正在搜…", 8000);
    },
  }).then(function (r) {
    if (seq !== app.chatSeq) { dlog("COOK_CHAT drop stale"); return; }
    if (!r || !r.ok) {
      dlog("COOK_CHAT fail " + ((r && r.reason) || "error"));
      if (kind === "CHAT") {
        showReply("这个我没答上来 · 说「下一步」继续，或再说一次", "ask", 8000);
      }
      setHint("模型没通（" + ((r && r.reason) || "error") + "）· 离线功能照常", 8000);
      return;
    }
    const cur = app.session ? app.session.getState() : null;
    if (!cur || cur.stepIndex !== stepIndex) { dlog("COOK_CHAT drop step-changed"); return; }
    dlog("COOK_CHAT ok " + JSON.stringify(r.text.slice(0, 40)));
    showReply(r.text, kind === "RESCUE" ? "rescue" : "answer", REPLY_MS);
    setHint("说「好」按它改 · 说「下一步」照原步骤走", 14000);
  }).catch(function (e) {
    dlog("COOK_CHAT throw " + ((e && e.message) || e));
  });
}

// ---- 导航键映射（语音之外的操作兜底；菜单模式不响应） ----
function handleAction(action) {
  if (app.mode === "menu") return null;
  // ★ 收尾问答：确认键 = 要，返回键 = 不用（眼镜上不摘手套也能答）
  if (app.mode === "wrap") {
    if (action === "activate") handleWrapUtterance("要");
    else if (action === "back") handleWrapUtterance("不用");
    return null;
  }
  if (app.paused) {
    if (action === "activate") { doResume(); show(app.session.present()); }
    return null; // 暂停中其余按键不动作
  }
  if (action === "activate") return app.session.handle("下一步", performance.now()).display;
  if (action === "back") return app.session.handle("上一步", performance.now()).display;
  return null;
}

// ---- 主循环 ----
// ★ 帧循环任何异常都不许终止进程：崩一次平台就重启一次，用户看到的永远是开机画面。
//   出错只记日志，只要应用还活着就继续排下一帧。
function tick() {
  app.frame = null;
  if (!app.active || !view.window) return;
  try {
    tickBody();
  } catch (e) {
    const t = performance.now();
    if (!app.lastTickFail || t - app.lastTickFail > 2000) {
      app.lastTickFail = t;
      dlog("COOK_TICK_FAIL " + paintErr(e));
    }
  }
  if (app.active && view.window) app.frame = os.requestAnimationFrame(tick);
}

function tickBody() {
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
  // 2.1) 选菜动画播完 → 才真正进入跟做界面（动画期间界面按帧插值，见 paintMenuRows）
  if (app.pickAnim && now - app.pickAnim.t0 >= pickDuration()) {
    const idx = app.pickAnim.index;
    app.pickAnim = null;
    startDish(idx);
  }
  // 2.2) 识别服务探活：每 5 秒一次。服务挂了要让界面直说，不能一路假装「没听清」
  if (!app.asrChecking && now - app.asrCheckAt > 5000) {
    app.asrChecking = true;
    app.asrCheckAt = now;
    asr.ping().then((ok) => {
      app.asrChecking = false;
      if (ok === app.asrOk) return;
      app.asrOk = ok;
      if (ok) notify("识别服务已连上 · 可以正常说话了", [0, 255, 90], 2600);
      else notify("识别服务没连上（5001）· 在 WSL 里启动 asr_server.py", [255, 90, 60], 6000);
    }).catch(() => { app.asrChecking = false; });
  }
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
    const text = app.mode === "cooking" ? (QUICK_COMMANDS[raw] || raw)
      : app.mode === "wrap" ? (WRAP_KEYS[raw] || raw)
        : raw;
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
  // 6) 上屏（内部只提交变化；自身兜底，不会往外抛）
  paintSession();
}

function resume() {
  if (!view.window || app.active) return;
  app.active = true;
  app.micWanted = true;
  timer.lastNow = performance.now();
  if (app.pickAnim) startPickTimer();   // 切后台时动画被打断 → 续播剩余部分
  app.frame = os.requestAnimationFrame(tick);
}
function pause() {
  app.active = false;
  stopPickTimer();  // 动画定时器跟着停，回前台由 resume 续上
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
