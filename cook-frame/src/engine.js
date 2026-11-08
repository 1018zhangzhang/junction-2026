"use strict";
// ============================================================================
// 对话引擎 · 从团队 src/ 沙盘原样移植（lexicon + engine 两模块合并）
// 纯本地、无大模型：同音纠错 + 口语归一 + 意图识别 + 救场建议
// 逻辑与浏览器沙盘完全一致，改逻辑请改团队 src/ 后同步过来
// ============================================================================

/* ── lexicon ── */
/* 同音 / 近音纠错表。
 * 按「上下文」分组，不做全局替换 —— 这是关键设计：
 * 只有当前菜谱步骤里真的涉及该调料时，才启用对应的同音映射，
 * 否则「汤」会被误纠成「糖」、「少」会被误纠成「勺」。
 */
const HOMOPHONE_GROUPS = ({
  盐: {
    // 注意：不把「咸」放进来。「咸」是合法词（太咸了），纠成「太盐了」反而毁掉救场识别
    variants: ["言", "严", "沿", "岩", "炎", "颜"],
    // 「少量」「少许」是合法的量词，不能当错字处理
    exclude: [/少量/g, /少许/g, /少放/g],
  },
  糖: { variants: ["汤", "塘", "唐", "躺"], exclude: [/汤勺/g] },
  油: { variants: ["由", "游", "优", "邮"], exclude: [] },
  // 「少」问题很多：既可能是「勺」的错字，也可能是「少了」的正当用法。
  // 只在「用户明确在说量词」的语境里才纠，避免「有点少，放两勺」被改坏。
  勺: {
    variants: ["烧", "设", "匀"],
    exclude: [],
    requireContext: /(勺|少|放|加|来|勺吧)/,
    skipIf: /(有点少|少了|太少|不够|少放|少量|少许)/,
  },
  // 「淡」永远不纠 —— 它属于「咸淡」语义，纠成「蛋」会把救场识别彻底搞坏
  蛋: { variants: ["但", "单", "弹"], exclude: [] },
  番茄: { variants: ["西红柿", "番茄", "翻茄", "反茄"], exclude: [] },
  生抽: { variants: ["生吃", "升抽", "生油"], exclude: [] },
  葱: { variants: ["冲", "充", "匆"], exclude: [] },
  姜: { variants: ["讲", "浆", "将", "酱"], exclude: [/酱/g] },
});

/* 数量词归一。顺序有意义：先匹配更具体的说法。 */
const AMOUNT_PATTERNS = ([
  // 极少量必须排在「半勺」之前：否则「小半勺」里的「半勺」先命中，判成半份
  { value: "极少量", label: "极少", hint: "指尖捏一点", re: /(一点点|一丁点|很少|一丝丝?|微微一?点|一丢丢|一咪咪|捏一点|沾一点)/ },
  { value: "少量", label: "少量", hint: "约 1/4 茶匙", re: /(一小?撮|少量|少许|一?小把|小半勺|半茶匙|小半茶匙)/ },
  { value: "半份", label: "半份", hint: "半勺", re: /(半勺|半汤匙|半勺吧|一半)/ },
  { value: "一份", label: "一份", hint: "一满勺", re: /(一勺|一汤匙|一大勺|一平勺|满满一勺)/ },
  { value: "两份", label: "两份", hint: "两满勺", re: /(两勺|二勺|两大勺|两汤匙|俩勺)/ },
  { value: "三份", label: "三份", hint: "三满勺", re: /(三勺|三大勺|三汤匙|仨勺)/ },
  { value: "追加", label: "再加", hint: "再加半勺", re: /(再多?[加放来补][一]?[点些儿]?|再来点|加点|多点|补一点|多放|再放|再来一勺|续一勺)/ },
]);

/* 中文数字 → 阿拉伯数字，用于「三个蛋」「两个番茄」 */
const CN_NUM = ({
  一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 仨: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
});

/* ──────────────────── 口语 / 俚语归一 ────────────────────
 * 目标不是"听懂所有话"，而是把厨房里高频的口语说法，
 * 尽可能多地映射回引擎能处理的少数几个关键词上。
 *
 * 规则：右边必须是引擎认识的词（状态词 / 意图词），
 * 左边是口语说法。按顺序匹配，越靠前的越优先。
 *
 * 为什么要做这一步：ASR 转出来的经常是口语，
 * 「齁咸」「淡出鸟」「皮了」这类说法，靠 tips 的 aliases 一条条覆盖很累，
 * 先归一成「太咸」「太淡」，后面所有逻辑就都能复用了。
 */
const COLLOQUIAL = ([
  // ── 咸淡 ──
  { re: /(齁咸|齁得慌|齁死|爆咸|贼咸|死咸|咸死|咸得慌|咸到哭|咸爆了|咸过头|过咸|咸了一?点)/g, to: "太咸" },
  { re: /(淡出鸟|没滋没味|没味儿|没味道|寡淡|清汤寡水|不够味|不够咸|味太淡|淡得很)/g, to: "太淡" },
  { re: /(糖放多了|糖撒多了|糖多了|糖多|太甜|甜得慌|齁甜)/g, to: "太甜" },
  { re: /(盐放多了|盐撒多了|盐多了|盐多)/g, to: "太咸" },
  { re: /(咸淡正好|口味正好|正正好|刚刚好|刚好|差不多了|挺合适)/g, to: "正好" },

  // ── 火候：糊 / 焦 / 老 / 生 ──
  { re: /(糊锅|糊底|糊了锅|烧糊|烧焦|焦掉|焦了|糊掉|发黑|变黑|糊味|焦味|冒黑烟|冒青烟|串味)/g, to: "糊了" },
  { re: /(炒老|太老了|变老|老了|柴了|发柴|干柴|硬邦邦|咬不动|咬不烂|嚼不动)/g, to: "太老" },
  { re: /(没熟|不熟|夹生|还是生)/g, to: "没熟" },
  { re: /(火太大|火大了|火过|火太旺|烧太旺|火候太猛|火太冲)/g, to: "火太大" },
  { re: /(火太小|火不够|火不旺|火太弱)/g, to: "火太小" },

  // ── 干湿（「走水」是北方话，指食材出水太多） ──
  // 注意：这里刻意只收「水太多」这一支，不收「粘锅」。
  // 「粘锅」是用户在做第 3/4 步时的真实白描，归到「干」更贴切，
  // 放在「水太多」组会让它去查干锅的救法，答非所问。
  { re: /(走水|出了好多水|出水太多|汤太多|水太多|稀了|水汪汪)/g, to: "水太多" },
  { re: /(干锅|太干了|发干|锅干了|没汤汁|不出汁|汁收干|收干了|抱锅|没汤)/g, to: "太干" },

  // ── 油 ──
  { re: /(冒烟|油烟|油冒烟|油太热|油过热|油温太高|油温过了|油烧过头)/g, to: "油太热" },
  { re: /(油温不够|油没热|油不热|油还是凉|油温低|油不够热)/g, to: "油没热" },
  { re: /(溅油|炸油|油溅|爆油|噼里啪啦|油点子)/g, to: "油溅" },
  // 注意：不能用「油放多」这种前缀，否则会把「油放多少」吃掉。必须带「了 / 太多」收尾。
  { re: /(油太多|太油|油大了|油放多了|油多了|油乎乎|油汪汪|太腻)/g, to: "油太多" },
  { re: /(油少|油不够|太素|一点不滑|油放少了|油少了)/g, to: "油太少" },

  // ── 时间 / 进度 ──
  // 注意：「还没好」类必须先于「好了」类，否则「还没好」会被吃成「好了」
  { re: /(还没好|没好|没弄完|没完|还在弄|还得一会|再等会|稍等|等一下|缓一下|先别|先不|别翻页)/g, to: "还没" },
  // 只有「明确说整道菜都做完」才算收尾（全部做完 / 都做完了 / 收工 / 完成了）
  // 必须带「全部 / 都 / 整道」或本身就是完成时，避免做饭中途误判成整道菜结束
  { re: /(全部做完|全部都做完|全都做完|都做完了|全做完了|整道菜做完|这道菜做完|整道菜做好|这道菜做好|整个做完|收工|完成了|出锅了|结束了)/g, to: "完成" },
  // 「做好了 / 做完了 / 弄好了 / 搞定了」在做饭场景里百分之百指「这一步做好了」
  // → 一律当翻页，不再当整道菜收尾
  { re: /(做好了|做完了|弄好了|搞定了|完事了|整完了|齐活了|操作完了|完活了|妥了)/g, to: "好了" },
  // 「打好了 / 切好了 / 搅好了」这类"某事做完了"，说的是翻页不是收尾
  { re: /(打好了|切好了|搅好了|拌好了|打好|切好|弄好|备好|准备好了)/g, to: "好了" },
  // 口语同义说法：行了 / 可以了 / 好嘞 / 好哒… 同样表示"这一步好了、翻下一页"
  // 必须排在「完成」规则之后，否则「弄好了」可能被提前改写
  { re: /(可以了|行了|行啦|行嘞|好嘞|好哒|好勒|好啦|好咧|哦了|成了|中嘞)/g, to: "好了" },

  // ── 求助 ──
  { re: /(救命|帮帮我|帮我看看|出事了|出问题|翻车|废了|完了完了|糟了|坏事了|咋整|咋办|咋弄)/g, to: "怎么办" },

  // ── 步骤跳跃 ──
  { re: /(翻篇|翻页|下一条|往下走|往下讲|下个步骤|再往下|接着来|接着做|接着|然后呢|接下来|往下|下一项|继续下一步)/g, to: "下一步" },
  // 「上一步」容易和「下一步」混淆，所以把这些更好分辨的说法也归到上一步
  { re: /(倒回去|倒退|回上一页|往回走|往回退|往前退|前一条|上一个步骤|退回去|退一步|退回|上一条)/g, to: "上一步" },

  // ── 撤销 / 改口 ──
  { re: /(说错了|错说了|搞错|记错|收回|当我没说|重新说|不算不算|不算了)/g, to: "撤销" },
]);

/* ──────────────────── 故障状态词表 ────────────────────
 * 这是 RESCUE（救场）意图的触发依据。
 * 关键设计：不看疑问词，只看"状态描述"。
 * 用户说「太咸了」就该救，不需要他补一句「怎么办」。
 *
 * phase 表示这条故障属于做饭的哪个环节，决定救法：
 *   prep      备料（还没下锅，能改原料）
 *   cook      加热中（还能调火、调时长）
 *   seasoning 调味（只能靠加东西压）
 */
const TROUBLE = ([
  { key: "咸", phase: "seasoning", re: /(太咸|咸了|有点咸|咸过头|过咸|齁|爆咸|死咸|咸死|咸爆)/ },
  { key: "淡", phase: "seasoning", re: /(太淡|淡了|有点淡|不够咸|没味|没味道|没滋没味|寡淡|不够味)/ },
  { key: "甜", phase: "seasoning", re: /(太甜|甜了|有点甜|糖放多了|糖撒多了|糖多了|齁甜)/ },
  { key: "糊", phase: "cook", re: /(糊了|糊锅|糊底|烧糊|焦了|烧焦|焦掉|发黑|变黑|糊味|焦味)/ },
  { key: "老", phase: "cook", re: /(太老|老了|炒老|变老|柴了|发柴|硬邦邦|咬不动|嚼不动)/ },
  { key: "生", phase: "cook", re: /(没熟|不熟|夹生)/ },
  { key: "干", phase: "cook", re: /(太干|干了|发干|干锅|没汁|没汤|不出汁|没汤汁|粘锅|黏锅|巴锅|贴锅|走水|出水太多|汤太多|水太多|稀了)/ },
  { key: "油温", phase: "cook", re: /(油太热|油过热|冒烟|油烟|油温过高|油温过了|油没热|油不热|油温不够)/ },
  { key: "油多", phase: "cook", re: /(油太多|太油|油多了|油大了|油放多了|太腻|腻了|油乎乎|油汪汪)/ },
  { key: "油少", phase: "cook", re: /(油太少|油少了|油不够|油放少了)/ },
  { key: "油溅", phase: "cook", re: /(油溅|溅油|爆油|炸油|噼里啪啦)/ },
]);

/* 严重程度：同一句话在不同环节救法不同，也用来挑答案。 */
const SEVERITY = ({
  轻微: /(有点|稍微|略微|微微|还算|一点)/,
  严重: /(太|齁|爆|死|极|非常|特别|完全|彻底|已经|没法)/,
});

/* 通用救场兜底：菜谱里没写这条故障时的最后一道保险。
 * 以前找不到就回「这个问题我还没准备答案」——用户正着急时这句最伤人。
 * 只在「本步骤和邻近步骤都没有对应答案」时才用，不抢具体答案的位置。 */
const GENERIC_RESCUE = ({
  咸: "加小半勺糖或一点水，再放两口配菜一起炒，把咸味压下去。",
  淡: "补一点点盐，边尝边加，别一次倒多了。",
  甜: "加点醋或几滴生抽压一压，或者添点主料稀释。",
  糊: "马上关小火，糊的地方别翻搅，铲到一边去，别让苦味拌开。",
  老: "立刻盛出来，余温还会继续加热；下次早半分钟出锅。",
  生: "回锅加两勺水，盖盖焖 1-2 分钟；大块的先切开。",
  干: "加两勺水或高汤，转小火翻一下，让它把汁吸回去。",
  油温: "先把锅离火降一下温，或者抓一把凉菜进去垫一下。",
  油多: "把多余的油舀出来，或者下点吸油的配菜（豆芽、粉条）。",
  油少: "补一勺油，沿锅边淋进去，别一次倒中间。",
  油溅: "先关小火，食材擦干水再下锅，锅盖半掩着挡一下。",
});

/** 把文本里的中文数字替换成阿拉伯数字，便于后续解析。
 * 「半」不参与替换 —— 它属于「半勺 / 半份」这类量词说法，
 * 交给 AMOUNT_PATTERNS 处理更准确；换成 0.5 会把「小半勺」拆坏。
 */
function normalizeNumbers(text) {
  // ★ 先保护「下一个 / 上一个」：它们不是数量，转成「下1个」会让翻页口令彻底失效
  //   （队友 normalize.py 里同类问题的解法是 PROTECT_PATTERNS，这里只保留必要几条）
  const PROTECT = ["下一个", "上一个", "下个", "上个", "这一个", "那一个"];
  const saved = [];
  let out = String(text);
  for (const word of PROTECT) {
    if (!out.includes(word)) continue;
    const key = "\u0002" + saved.length + "\u0002";
    saved.push([key, word]);
    out = out.split(word).join(key);
  }
  out = out.replace(/([一二两三四五六七八九十俩仨])\s*(?=[个只颗根片勺撮克分秒])/g, (m, cn) => {
    const v = CN_NUM[cn];
    return v === undefined ? m : String(v);
  });
  for (const [key, word] of saved) out = out.split(key).join(word);
  return out;
}

/** 口语归一：把俚语说法替换成引擎认识的关键词。返回 { text, applied }。 */
function normalizeColloquial(text) {
  let out = text;
  const applied = [];
  for (const rule of COLLOQUIAL) {
    const hits = out.match(rule.re);
    if (!hits) continue;
    for (const h of hits) {
      if (h === rule.to) continue;
      applied.push({ from: h, to: rule.to, kind: "colloquial" });
    }
    out = out.replace(rule.re, rule.to);
  }
  // 「糊锅了」→「糊了了」这类叠字收一下，避免下游正则被重复的「了」干扰
  out = out.replace(/了{2,}/g, "了");
  return { text: out, applied };
}

/** 识别故障类型。返回 { key, phase, severity } | null */
function detectTrouble(text) {
  for (const t of TROUBLE) {
    if (!t.re.test(text)) continue;
    const severity = SEVERITY.严重.test(text)
      ? "严重"
      : SEVERITY.轻微.test(text)
        ? "轻微"
        : "中等";
    return { key: t.key, phase: t.phase, severity };
  }
  return null;
}

/** 提取数量表达：返回 { value, label, hint, raw } | null */
function parseAmount(text) {
  const t = normalizeNumbers(text);
  for (const p of AMOUNT_PATTERNS) {
    const m = t.match(p.re);
    if (m) return { value: p.value, label: p.label, hint: p.hint, raw: m[1] };
  }
  // 「两勺」「3勺」「三个」这种数字 + 量词（含计数单位）
  const m = t.match(/(\d+(?:\.\d+)?)\s*(勺|汤匙|撮|个|只|颗|根|片|瓣|克|毫升|ml|g)/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    return {
      value: n === 0.5 ? "半份" : n === 1 ? "一份" : n === 2 ? "两份" : `${n}份`,
      label: `${n} ${unit}`,
      hint: `${n} ${unit}`,
      raw: m[0],
    };
  }
  return null;
}

/** 取出当前步骤涉及的调料名集合（用于决定启用哪些同音组）。 */
function activeSeasonings(step) {
  if (!step || !Array.isArray(step.seasoning)) return new Set();
  return new Set(step.seasoning.map((s) => s.name));
}

/** 按上下文纠错。只在 active 集合内的调料才启用对应同音组。 */
function correctHomophones(text, active) {
  let out = text;
  const applied = [];
  for (const [canonical, group] of Object.entries(HOMOPHONE_GROUPS)) {
    // 当前步骤没涉及这个调料 → 不纠错，避免过度矫正
    const relevant =
      active.has(canonical) ||
      // 用户明确说出了调料动作词（放/加/减）时才放宽
      (/放|加|减|要|有点|太/.test(text) && text.includes(canonical));
    if (!relevant) continue;

    // 语境守卫：整句命中 skipIf 时，这一组完全跳过
    if (group.skipIf && group.skipIf.test(out)) continue;
    // requireContext 存在时，整句必须命中才纠（用于歧义大的字）
    if (group.requireContext && !group.requireContext.test(out)) continue;

    for (const v of group.variants) {
      if (v === canonical) continue;
      if (!out.includes(v)) continue;
      // 保护区域先切成占位符
      let protectedText = out;
      const masks = [];
      for (const ex of group.exclude) {
        protectedText = protectedText.replace(ex, (m) => {
          masks.push(m);
          return `\u0000${masks.length - 1}\u0000`;
        });
      }
      if (protectedText.includes(v)) {
        protectedText = protectedText.split(v).join(canonical);
        applied.push({ from: v, to: canonical });
      }
      out = protectedText.replace(/\u0000(\d+)\u0000/g, (_, i) => masks[Number(i)]);
    }
  }
  return { text: out, applied };
}

/* ── engine ── */
/* ────────────────────────── 意图模式 ──────────────────────────
 * 顺序即优先级。
 *
 * 关键原则：**先判「话里干了什么」，再判「话里有没有疑问词」**。
 * 旧版把 ASK（带疑问词）排在 CORRECT 前面，导致「不对吧？」「太咸了怎么办」
 * 都被当成提问；但「怎么办」本身是个信号词，不足以判定意图。
 */
const INTENTS = ([
  {
    type: "RETRACT",
    // 撤回上一条修改。最高优先级 —— 用户喊「等等」时别再问别的。
    re: /^(撤销|撤回|算了我|改回去|恢复原来|还是按原来的?|取消刚才|收回|当我没说)/,
  },
  {
    type: "DEFER",
    // 「还没好」「等一下」—— 用户在说"别翻页"。
    // 必须排在 NEXT 之前，否则「还没好」里的「好了」会被吃成 NEXT。
    re: /(还没好|没好|没弄完|还没|没好呢|还在弄|还得一会|再等会|稍等|等一下|缓一下|先别翻|别翻页|先别走|别急)/,
  },
  {
    type: "BACK",
    re: /(上一步|上一个?|回到上一步|回到前面|刚才那步|前面那步|前一步|往回|返回|倒回去|倒退)/,
  },
  {
    type: "REPEAT",
    re: /(再说一遍|再念一遍|再讲一遍|再说一次|再说一下|念一遍|念一次|重复|没听清|没听见|没听到|没看清|没记住|再说|什么来着|刚才说什么|说啥)/,
  },
  {
    type: "CORRECT",
    // 口误修改：有修正确认词。是否真的算修改，在下面用 amount 再筛一次
    re: /(不对|不是|错了|说错|改成|改为|应该是|其实|重新说|等等|哦对|搞错|记错)/,
  },
  {
    type: "ASK",
    // 纯提问：有疑问词，且没有在描述故障（故障由 RESCUE 先接走）
    // 补进来的火候/时长/进度/熟度类，是队友 189 条语料里我们原来全漏的一批
    re: /([?？]|怎么|为什么|要不要|多久|多长|几分钟|多少|能不能|可不可以|可以吗|是吗|对吗|怎么办|什么|哪个|行不行|好不好|咋整|咋办|不动|不了|不成|不开|切不|咬不|翻不|铲不|火候|火侯|多大火|什么火|几档|大火还是小火|用大火|开大火|开多大|多旺|烧多|怎样|几个人|几步|难吗|熟了没|几分熟|什么颜色|怎么判断|怎么切|切多大|怎么翻|盖锅盖|锅盖|先放|哪个先|一起放|够不够|多少克|吗|呢)/,
  },
  {
    type: "SKIP",
    re: /(跳过|略过|略掉|省掉|省略|直接过|下个?菜|不用了|直接下一步|直接跳过|太快了?了?|快点)/,
  },
  {
    type: "NEXT",
    re: /(下一步|下一个?|继续|好了|做完了|好了下一步|ok|okay|搞定|完事|接着来|往下走|往下|下一条|翻篇)/i,
  },
  {
    type: "FINISH",
    // 只有明确表达「整道菜都做完了」才收尾。
    // 「做好了 / 做完了」这类在 normalize 阶段已改写成「好了」，走 NEXT 翻页，
    // 所以这里不能再收它们，否则做饭中途一句「做好了」就被判成整道菜结束。
    re: /^(完成|完成了|出锅了|结束了|收工|全部做完|都做完了|全做完了|整道菜做完|整道菜做好|这道菜做完|这道菜做好)/,
  },
  {
    type: "ACCEPT",
    // 用户接受了上一条建议。排在 FINISH 之后：单独说「好了」算翻页，
    // 但在 pendingRescue 状态下，则由 NEXT 分支优先截获转成记账。
    re: /^(好|行|可以|嗯|对|就这样|中|ok|okay|要得|成|行吧|好的|好吧|听你的|就这么办|行了|好了行了)/i,
  },
]);

/* 否定处理：早先只有「句首否定」一条正则，管不住「先别下一步」「别停继续」这类
 * 句中否定。现已换成下面的 negatedAt() 否定窗口（学自队友 nlu.py），
 * 按「关键词出现的位置」判断，所以这里不再保留旧的句首正则。 */

/* 否定窗口（学自队友 nlu.py 的 is_negated）：
 * 关键词前面 3 个字以内出现否定词 → 这句不算在让程序执行。
 * 关键在第三条：否定词和关键词之间夹了「别的动作」时，否定指向那个动作。
 *   「别停继续」  → 否定的是「停」，该继续 → 放行
 *   「先别下一步」 → 否定的是「下一步」 → 拦截
 */
const NEGATORS = ["先别", "别", "不用", "不要", "不想", "甭", "不", "没", "勿"];
const OTHER_VERBS = ["停", "吃", "弄", "放", "切", "盖", "加", "翻", "关", "开", "洗", "盛", "端"];
function negatedAt(text, index) {
  if (!index || index <= 0) return false;
  const head = String(text).slice(Math.max(0, index - 3), index);
  for (const neg of NEGATORS) {
    const at = head.lastIndexOf(neg);
    if (at < 0) continue;
    const gap = head.slice(at + neg.length);
    if (gap && OTHER_VERBS.some((v) => gap.includes(v))) continue; // 否定的是中间那个动作
    return true;
  }
  return false;
}

/* 用户说这些表示"接受建议"，把上一条救场建议记账 */
const ACCEPT = /^(好|行|可以|嗯|对|就这样|中|ok|okay|要得|成|行吧|好的|好吧)/i;

/* ────────────────────────── 单条话语理解 ────────────────────────── */

/**
 * 把一句话解析成结构化意图。
 * @param {string} raw  用户原始话语（可能是 ASR 结果，含错字和口语）
 * @param {object} step 当前步骤（用于上下文纠错）
 */
function parseUtterance(raw, step) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) {
    return {
      type: "EMPTY", text: "", corrected: "",
      corrections: [], amount: null, seasoning: null,
      trouble: null, confidence: 0,
    };
  }

  const active = activeSeasonings(step);

  // 三步归一：中文数字 → 口语 → 同音错字
  // 顺序不能换：口语先归一，「齁咸」才能变成「太咸」再交给纠错
  const numeric = normalizeNumbers(text);
  const col = normalizeColloquial(numeric);
  const { text: corrected, applied } = correctHomophones(col.text, active);
  const corrections = [...col.applied, ...applied];

  // 故障识别：看归一后的文本。这是 RESCUE 的依据。
  const trouble = detectTrouble(corrected);

  // 抽出涉及的调料名（当前步骤的调料优先）
  let seasoning = null;
  for (const name of active) {
    if (corrected.includes(name)) { seasoning = name; break; }
  }
  if (!seasoning) {
    for (const name of ["盐", "糖", "油", "生抽", "葱", "姜", "蛋", "番茄"]) {
      if (corrected.includes(name)) { seasoning = name; break; }
    }
  }

  const amount = parseAmount(corrected);

  // 只说了量、没说调料（「半勺」）→ 按当前步骤的调料推断
  if (!seasoning && amount && step && Array.isArray(step.seasoning)) {
    const names = step.seasoning.map((s) => s.name);
    const condiment = names.find((n) => !["鸡蛋", "番茄"].includes(n));
    seasoning = condiment || names[0] || null;
  }

  /* ── 判断顺序：整个引擎最需要讲清楚的一段 ──
   *
   * 1. RESCUE 最先：只要在描述故障（太咸 / 糊了 / 粘锅），就进救场。
   *    「太咸了怎么办」既含故障词又含疑问词，必须走 RESCUE 而不是 ASK，
   *    否则会被当成"知识问答"去 tips 里找，找不到就回「我不确定」。
   * 2. 然后按 INTENTS 顺序匹配。
   * 3. 最后才看"有没有量"「有没有提调料」。
   */
  if (trouble && !looksLikeCorrection(corrected)) {
    return {
      type: "RESCUE", text, corrected, corrections,
      amount, seasoning, trouble,
      confidence: 0.92,
    };
  }

  for (const intent of INTENTS) {
    const hit = corrected.match(intent.re);
    if (!hit) continue;                        // 命中位置：否定窗口要看它左边的字
    const pos = hit.index || 0;
    if ((intent.type === "NEXT" || intent.type === "SKIP" || intent.type === "BACK")
      && negatedAt(corrected, pos)) continue;
    // 「下一个步骤是什么」「上一步说了什么」听着像提问，其实是要翻页/回退
    if (intent.type === "ASK" && /(下一步|下一个|下1个|下个步骤|上一步|上1个|前面那步)/.test(corrected)) continue;
    // CORRECT 必须真的给出量或故障，否则「不对」只是口语停顿
    if (intent.type === "CORRECT" && !amount && !trouble) continue;
    return {
      type: intent.type,
      text, corrected, corrections,
      amount, seasoning, trouble,
      confidence: corrections.length ? 0.82 : 0.95,
    };
  }

  // 没有命中关键词：只有在「明确表达了量」时才当作改量
  if (amount) {
    return {
      type: "CORRECT", text, corrected, corrections, amount, seasoning, trouble,
      confidence: 0.7,
    };
  }

  // 提到调料但没有量也没有修正词 → 视为模糊提问（「盐？」「那个油」）
  if (seasoning) {
    return {
      type: "ASK", text, corrected, corrections, amount: null, seasoning, trouble,
      confidence: 0.45,
    };
  }

  return {
    type: "UNKNOWN", text, corrected, corrections,
    amount: null, seasoning, trouble, confidence: 0.3,
  };
}

/** 判断这句话是在"改用量"还是在"报故障"。
 *  「改成半勺」「不对，多了」是改量；「太咸了」「糊了」是报故障。
 *  区分点：有没有『改成 / 说错 / 重新说』这类明确动作。
 */
function looksLikeCorrection(text) {
  return /(改成|改为|说错|说错了|重新说|应该是|记错|收回)/.test(text);
}

/* ────────────────────────── 会话状态机 ────────────────────────── */

const DEFAULTS = ({
  /** 改口确认窗口：在此时间内的连续修改合并为一次，只保留最后一次 */
  correctWindowMs: 2500,
  /** 琥珀色回显停留时长 */
  echoMs: 1200,
  /** 「下一步」在最后一步被拦下时，显示这句 */
  lastStepHint: "已经是最后一步了",
});

/** 数量 → 可读回显。用自然的厨房说法。 */
function amountPhrase(amount, seasoning) {
  if (!amount) return seasoning ? `${seasoning} 已调整` : "已调整";
  const head = seasoning ? `${seasoning} → ` : "";
  return `${head}${amount.hint}`;
}

/** override 在副标题里的显示文本 */
function overrideLabel(key, v) {
  if (key === "数量") return `用量 ${v.label}`;
  return `${key} ${v.label}`;
}

/** 把 tips 统一成 { q, answer, aliases }[]。兼容旧的「纯对象」写法。 */
function normalizeTips(step) {
  const raw = step && step.tips;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => ({
      q: t.q || "",
      answer: t.answer || t.a || "",
      aliases: Array.isArray(t.aliases) ? t.aliases : [],
    }));
  }
  return Object.entries(raw).map(([q, answer]) => ({
    q,
    answer: typeof answer === "string" ? answer : String(answer),
    aliases: [],
  }));
}

function createSession(recipe, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const steps = recipe.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error("recipe.steps 不能为空");

  const state = {
    stepIndex: 0,
    finished: false,
    overrides: {},
    lastSnapshot: null,
    correctionCount: 0,
    /** 上一条 RESCUE 给出的建议，等用户说「好」就转成 override */
    pendingRescue: null,
    /** 「还没好」被说的次数。连续催两次以上就换个提示语。 */
    deferCount: 0,
    history: [],
  };

  function snapshot() {
    return JSON.parse(JSON.stringify({
      stepIndex: state.stepIndex,
      overrides: state.overrides,
      finished: state.finished,
    }));
  }

  function currentStep() {
    return steps[state.stepIndex];
  }

  function present(extra = {}) {
    const step = currentStep();
    const n = state.stepIndex + 1;
    const total = steps.length;

    const adjusted = Object.entries(state.overrides)
      .filter(([, v]) => v.stepId === step.id)
      .map(([k, v]) => overrideLabel(k, v));

    return {
      main: step.ask,
      sub: adjusted.length ? `${step.detail} · 已改为 ${adjusted.join("、")}` : step.detail,
      progress: `第 ${n} 步 / 共 ${total} 步`,
      tone: "normal",
      ...extra,
    };
  }

  /** 在当前步骤找答案。必须带「调料一致性」约束 —— 用户问「油放多少」时，
   *  不能因为当前步骤有盐、而「放多少」三个字又高度重叠，就答成盐的用量。
   */
  function findTip(step, text, seasoning) {
    if (seasoning && step && Array.isArray(step.seasoning)) {
      const names = new Set(step.seasoning.map((s) => s.name));
      if (names.size && !names.has(seasoning)) return null; // 本步骤不涉及这个调料，别硬答
    }
    const tips = normalizeTips(step);
    if (!tips.length) return null;

    // ① 精确包含：用户的话里出现了某条 tip 的 alias 或 q
    //    这是「太咸了」能命中「太咸了怎么办」的关键
    let best = null;
    let bestLen = 0;
    for (const t of tips) {
      for (const key of [t.q, ...t.aliases]) {
        if (!key) continue;
        if (text.includes(key) && key.length > bestLen) {
          bestLen = key.length;
          best = t;
        }
      }
    }
    if (best) return best.answer;

    // ② 反向包含：用户只说了一个短词（「咸」），alias 里包含它
    //    只在 4 字以内的短句启用，避免长句里一个「咸」字把答案拽过来
    if (text.length <= 4) {
      for (const t of tips) {
        const keys = [t.q, ...t.aliases];
        if (keys.some((k) => k && k.includes(text))) return t.answer;
      }
    }

    // ③ 退回二元组打分（兼容旧菜谱的纯对象写法）
    //    注意：短句（<= 4 字）不打分。「盐放多少」去掉疑问词后只剩「盐放多少」，
    //    和「油放多少」的二元组重叠度能到 0.6，会串味。
    if (text.length <= 4) return null;
    const q = text.replace(/[?？。，、！!]/g, "");
    let score = 0;
    let hit = null;
    for (const t of tips) {
      const s = bigramOverlap(t.q, q);
      if (s > score) { score = s; hit = t.answer; }
    }
    return score >= 0.5 ? hit : null;
  }

  /** 从步骤的 rescue 表里取救场答案，按严重程度分层。 */
  function findRescue(step, trouble) {
    const table = step && step.rescue;
    if (!table || !trouble) return null;
    const entry = table[trouble.key];
    if (!entry) return null;
    if (typeof entry === "string") return { answer: entry, severity: "中等" };
    const s = trouble.severity;
    const answer = entry[s] || entry["中等"] || entry["轻微"] || entry["严重"];
    if (!answer) return null;
    return { answer, severity: s };
  }

  /**
   * 处理一条话语。
   * @param {string} raw
   * @param {number} now 单调毫秒时间戳，用于合并改口
   */
  function handle(raw, now = 0) {
    const step = currentStep();
    const u = parseUtterance(raw, step);
    const actions = [];
    state.history.push({ at: now, raw, type: u.type });

    if (u.corrections.length) state.correctionCount += u.corrections.length;

    /** 把待定的救场建议记成一笔 override。NEXT 和 ACCEPT 两个分支共用。 */
    function acceptRescue(at, intent, acts) {
      const p = state.pendingRescue;
      state.lastSnapshot = snapshot();
      state.overrides[p.key] = {
        label: p.label, hint: p.hint, at, stepId: currentStep().id, merged: false,
      };
      state.pendingRescue = null;
      acts.push("OVERRIDE_SET", "RESCUE_ACCEPTED");
      return {
        intent,
        display: {
          main: `好，${p.label}`,
          sub: p.hint,
          progress: present().progress,
          tone: "corrected",
          echoMs: cfg.echoMs,
          canRetract: true,
        },
        actions: acts,
      };
    }

    switch (u.type) {
      case "NEXT": {
        // 用户说「好」时，如果上一条是救场建议，就执行它，而不是翻页
        if (state.pendingRescue && ACCEPT.test(u.corrected)) {
          return acceptRescue(now, u, actions);
        }

        if (state.stepIndex < steps.length - 1) {
          state.lastSnapshot = snapshot();
          state.stepIndex += 1;
          state.finished = false;
          state.pendingRescue = null;
          state.deferCount = 0;
          actions.push("STEP_ADVANCE", "CLEAR_OVERRIDES");
          return { intent: u, display: present(), actions };
        }

        // 已在最后一步：不跳完成页，提醒用户「整道菜都做完了」才说完成
        state.finished = true;
        actions.push("FINISH");
        return {
          intent: u,
          display: {
            main: cfg.lastStepHint,
            sub: "都做完了就说「完成了」才算收尾",
            progress: present().progress,
            tone: "ask",
          },
          actions,
        };
      }

      case "BACK": {
        state.lastSnapshot = snapshot();
        if (state.stepIndex > 0) state.stepIndex -= 1;
        state.finished = false;
        state.pendingRescue = null;
        actions.push("STEP_BACK");
        return { intent: u, display: present(), actions };
      }

      case "REPEAT":
        actions.push("REPEAT");
        return { intent: u, display: present(), actions };

      case "DEFER": {
        // 用户说「还没好」「等一下」→ 原地不动，不翻页，不追问
        state.deferCount += 1;
        actions.push("DEFER_HOLD");
        const n = state.deferCount;
        return {
          intent: u,
          display: {
            main: "不着急，慢慢来",
            sub: n >= 2 ? "好了说一声就行" : `${step.ask} · 好了说一声`,
            progress: present().progress,
            tone: "ask",
          },
          actions,
        };
      }

      case "SKIP": {
        state.lastSnapshot = snapshot();
        if (state.stepIndex < steps.length - 1) state.stepIndex += 1;
        state.finished = false;
        state.pendingRescue = null;
        actions.push("STEP_ADVANCE");
        return { intent: u, display: present({ sub: `已跳过：${currentStep().detail}` }), actions };
      }

      case "CORRECT": {
        if (!u.amount && !u.seasoning) {
          return {
            intent: u,
            display: { main: "想改成什么？", sub: step.detail, progress: present().progress, tone: "ask" },
            actions: ["ASK_CLARIFY"],
          };
        }
        const key = u.seasoning || "数量";
        const prev = state.overrides[key];
        const merged = prev && now - prev.at <= cfg.correctWindowMs;

        // 快照必须在写入之前拍，否则撤回拿到的是修改后的状态
        if (!merged) state.lastSnapshot = snapshot();

        if (!merged) {
          for (const k of Object.keys(state.overrides)) {
            if (k !== key && state.overrides[k].stepId === step.id) delete state.overrides[k];
          }
        }

        state.overrides[key] = {
          label: u.amount ? u.amount.label : "已调整",
          hint: u.amount ? u.amount.hint : "",
          at: now,
          stepId: step.id,
          merged: Boolean(merged),
        };
        state.pendingRescue = null;

        actions.push("OVERRIDE_SET", merged ? "MERGE_WINDOW" : "NEW_OVERRIDE");

        return {
          intent: u,
          display: {
            main: `已改为：${u.amount ? u.amount.label : "已调整"}`,
            sub: amountPhrase(u.amount, u.seasoning),
            progress: present().progress,
            tone: "corrected",
            echoMs: cfg.echoMs,
            canRetract: true,
          },
          actions,
        };
      }

      case "RETRACT": {
        if (!state.lastSnapshot) {
          return {
            intent: u,
            display: { main: "没有可撤回的修改", sub: step.detail, progress: present().progress, tone: "ask" },
            actions: ["RETRACT_NONE"],
          };
        }
        state.stepIndex = state.lastSnapshot.stepIndex;
        state.overrides = state.lastSnapshot.overrides;
        state.finished = state.lastSnapshot.finished || false;
        state.lastSnapshot = null;
        state.pendingRescue = null;
        actions.push("RETRACT");
        return {
          intent: u,
          display: present({ sub: "已撤回上一步修改", tone: "corrected" }),
          actions,
        };
      }

      /* ─────────── 救场：本版新增的核心分支 ─────────── */
      case "RESCUE": {
        // 先在当前步骤的 rescue 表里找，再按「离当前步骤的距离」跨步骤找
        let hit = findRescue(step, u.trouble);
        let fromStep = null;

        if (!hit) {
          const order = steps
            .map((_, i) => i)
            .filter((i) => i !== state.stepIndex)
            .sort((a, b) => Math.abs(a - state.stepIndex) - Math.abs(b - state.stepIndex));
          for (const i of order) {
            const h = findRescue(steps[i], u.trouble);
            if (h) { hit = h; fromStep = i; break; }
          }
        }

        if (!hit) {
          // 本步骤和邻近步骤都没写这条故障 → 用通用救法兜住，别回「没准备答案」
          const generic = GENERIC_RESCUE[u.trouble.key];
          if (generic) hit = { answer: generic, severity: "通用" };
        }

        if (!hit) {
          return {
            intent: u,
            display: {
              main: "这个问题我还没准备答案",
              sub: step.ask,
              progress: present().progress,
              tone: "ask",
            },
            actions: ["NO_RESCUE"],
          };
        }

        // 记下建议，等用户说「好」就转成 override
        state.pendingRescue = {
          key: rescueKey(u.trouble.key, u.seasoning),
          label: rescueLabel(u.trouble.key),
          hint: hit.answer,
        };

        const tag = fromStep === null ? "" : `（第 ${fromStep + 1} 步也适用）`;
        actions.push("RESCUE_ANSWER", "AWAIT_CONFIRM");
        return {
          intent: u,
          display: {
            main: hit.answer,
            sub: `说「好」我就记下${tag}`,
            progress: present().progress,
            tone: "rescue",
            holdMs: 4000,
          },
          actions,
        };
      }

      case "ASK": {
        // 先在当前步骤找答案，找不到再跨步骤找
        let hit = findTip(step, u.corrected, u.seasoning);
        let fromStep = null;
        if (!hit) {
          const order = steps
            .map((_, i) => i)
            .filter((i) => i !== state.stepIndex)
            .sort((a, b) => Math.abs(a - state.stepIndex) - Math.abs(b - state.stepIndex));
          for (const i of order) {
            const h = findTip(steps[i], u.corrected, u.seasoning);
            if (h) { hit = h; fromStep = i; break; }
          }
        }
        if (hit) {
          const tag = fromStep === null ? "" : `（第 ${fromStep + 1} 步也会讲到）`;
          // 太咸/太淡被问出来（「盐放多少」「放多少盐」），其实是用户想改用量，
          // 顺手给一句可直接说的改口话术，比纯念答案更实用。
          const hint = seasoningHint(u.seasoning, hit);
          return {
            intent: u,
            display: {
              main: hit,
              sub: [fromStep === null ? "" : `已提前回答${tag}`, hint]
                .filter(Boolean).join(" · "),
              progress: present().progress,
              tone: "answer",
            },
            actions: ["ANSWER_TIP"],
          };
        }
        return {
          intent: u,
          display: { main: "这个我不确定", sub: step.detail, progress: present().progress, tone: "ask" },
          actions: ["NO_MATCH"],
        };
      }

      case "ACCEPT": {
        // 有救场建议在等确认 → 记账；没有 → 当作「嗯，知道了」，原地不动
        if (state.pendingRescue) return acceptRescue(now, u, actions);
        actions.push("ACK");
        return { intent: u, display: present(), actions };
      }

      case "FINISH": {
        state.finished = true;
        return {
          intent: u,
          display: { main: "做好了，趁热吃", sub: recipe.title, progress: "已完成", tone: "success" },
          actions: ["FINISH"],
        };
      }

      case "EMPTY":
        return { intent: u, display: present(), actions: ["IGNORED"] };

      default:
        return { intent: u, display: present(), actions: ["FALLBACK"], lowConfidence: true };
    }
  }

  function getState() {
    return {
      stepIndex: state.stepIndex,
      stepId: currentStep().id,
      total: steps.length,
      finished: state.finished,
      overrides: { ...state.overrides },
      correctionCount: state.correctionCount,
      pendingRescue: state.pendingRescue ? { ...state.pendingRescue } : null,
    };
  }

  return { handle, getState, present, currentStep, config: cfg };
}

/** 故障类型 → override 的 key（「油温」记到「油」而不是「盐」） */
function rescueKey(troubleKey, seasoning) {
  if (troubleKey === "咸" || troubleKey === "淡") return seasoning || "味道";
  if (troubleKey === "油温" || troubleKey === "油多" || troubleKey === "油少" || troubleKey === "油溅") return "油";
  if (troubleKey === "干") return "火候";
  return "火候";
}

/** 故障类型 → 副标题显示的短语 */
function rescueLabel(troubleKey) {
  const map = {
    咸: "减咸", 淡: "补咸", 甜: "减甜", 糊: "去糊", 老: "离火", 生: "回锅",
    干: "补汁", 油温: "调火", 油多: "去油", 油少: "补油", 油溅: "关小火",
  };
  return map[troubleKey] || "补救";
}

/** 用户问盐/油用量时，顺手给一句可直接说的改口话术。
 *  没有这句，用户听完答案还得自己想"我该怎么说"。 */
function seasoningHint(seasoning, answer) {
  if (!seasoning) return "";
  if (seasoning === "盐" || seasoning === "生抽") return "要改就说「少放点盐」";
  if (seasoning === "糖") return "要改就说「少放点糖」";
  if (seasoning === "油") return "要改就说「少放点油」";
  if (answer && answer.length < 30) return "";
  return "";
}

/** 二元组重叠度：0~1。中文短句下比关键词包含更稳。 */
function bigramOverlap(a, b) {
  const grams = (s) => {
    const g = new Set();
    const t = s.replace(/\s/g, "");
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    if (t.length === 1) g.add(t);
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

module.exports = { parseUtterance, createSession };
