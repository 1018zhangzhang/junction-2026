"use strict";

// 意图识别：纯规则，不调模型。
// 原因很实际 —— 意图判断必须在本地毫秒级完成，模型只用来做"口述 → 结构化步骤"。
// 规则覆盖不到的输入不会被丢掉，会当作新需求交给模型处理（这正好是赛题要求的"新需求"）。
const KIND = Object.freeze({
  CORRECT: "correct",
  CANCEL: "cancel",
  CONFIRM: "confirm",
  PREV: "prev",
  NEXT: "next",
  LAYOUT: "layout",
  CONTENT: "content",
  AMEND: "amend",
  RESET: "reset",
  NEW_RECIPE: "new_recipe",
  AMBIGUOUS: "ambiguous"
});

const CONFIRM_WORDS = ["确认", "确定", "可以", "没问题", "是的", "对的", "对", "嗯", "好", "好的", "行", "ok", "OK"];
const CANCEL_WORDS = ["取消", "算了", "不用了", "停止", "停下", "别做了", "不要了"];

function normalize(text) {
  return String(text || "")
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[。！!？?，,、；;]+$/g, "")
    .trim();
}

function isExact(text, words) {
  return words.some((word) => text === word);
}

function detect(text) {
  const input = normalize(text);
  if (!input) return { kind: KIND.AMBIGUOUS, reason: "empty", raw: "" };

  // 1 独立纠正："不是三个蛋，是两个"
  const correct = input.match(/不是\s*([^，,。！!？?]{1,10})\s*[，,]?\s*(?:而是|是)\s*([^，,。！!？?]{1,10})/);
  if (correct) {
    return { kind: KIND.CORRECT, from: correct[1].trim(), to: correct[2].trim(), raw: input };
  }
  const wrong = input.match(/(?:改一下|错了|不对)[，,]?\s*(?:是|改成)\s*([^，,。！!？?]{1,12})/);
  if (wrong) {
    return { kind: KIND.AMEND, object: wrong[1].trim(), raw: input };
  }

  // 2 取消 → 必须排在确认前面，否则"不用了"会被"好"吃掉
  if (isExact(input, CANCEL_WORDS) || /^(取消|算了|不用了)/.test(input)) {
    return { kind: KIND.CANCEL, raw: input };
  }

  // 3 确认
  if (isExact(input, CONFIRM_WORDS)) {
    return { kind: KIND.CONFIRM, raw: input };
  }

  // 4 上一步 / 下一步
  if (/^(上一步|退回去?|往回|返回上一步|前面那步)/.test(input)) {
    return { kind: KIND.PREV, raw: input };
  }
  if (/(下一步|下个步骤|接着来|继续|好了|完成|做完了|搞定了|然后呢|这一?步做?完)/.test(input)) {
    return { kind: KIND.NEXT, raw: input };
  }

  // 5 布局变化（重点/布局）
  if (/(计时|倒计时)/.test(input) && /(放大|大一点|显示大|突出|重点)/.test(input)) {
    return { kind: KIND.LAYOUT, mode: "timer", raw: input };
  }
  if (/(放大|大字|字体大|显示大|突出|重点显示)/.test(input)) {
    return { kind: KIND.LAYOUT, mode: "timer", raw: input };
  }
  if (/(只(看|显示)?接下来|接下来两步|精简|简单点|只要下一?步)/.test(input)) {
    return { kind: KIND.LAYOUT, mode: "compact", raw: input };
  }
  if (/(恢复|全部显示|完整|都显示|还原)/.test(input)) {
    return { kind: KIND.LAYOUT, mode: "full", raw: input };
  }

  // 6 内容变化（换对象/范围/条件）
  if (/(只(保留|看|显示|要)|不要(显示|那个)|去掉|隐藏|删掉)/.test(input)) {
    const fields = [];
    if (/(用量|分量|多少|几克|几勺)/.test(input)) fields.push("usage");
    if (/(时长|时间|多久|几分钟|秒)/.test(input)) fields.push("duration");
    if (/(火候|火|大火|小火)/.test(input)) fields.push("fire");
    if (/(下一步|接下来|后面)/.test(input)) fields.push("next");
    return { kind: KIND.CONTENT, fields, raw: input };
  }

  // 7 指代不明 → 必须主动澄清（赛题验收点）
  const vague = input.match(/(?:加|放|来)(?:一?点|些)([^，,。！!？?]{0,4})/);
  if (vague && /^(那个|这个|它|啥|什么|点儿?|一点)?$/.test(vague[1].trim())) {
    return { kind: KIND.AMBIGUOUS, question: "加什么？盐、糖，还是别的？", raw: input };
  }
  if (/(那个|这个|它)/.test(input) && input.length <= 8) {
    return { kind: KIND.AMBIGUOUS, question: "你指的是哪一步？说个关键词我就改。", raw: input };
  }

  // 8 补充现有步骤（"再加点盐"）
  if (vague) {
    return { kind: KIND.AMEND, object: vague[1].trim() || "调料", raw: input };
  }

  // 9 重来
  if (/(重来|重新开始|清空|reset)/.test(input)) {
    return { kind: KIND.RESET, raw: input };
  }

  // 10 新菜谱 / 新需求
  if (/(做|烧|炒|煮|蒸|炖|拌|烤|来一?[份道个碗]|怎么(做|炒|烧|煮)|菜谱|步骤)/.test(input)) {
    return { kind: KIND.NEW_RECIPE, raw: input };
  }

  // 兜底：当成现场新需求，交给模型理解，不做静默丢弃
  return { kind: KIND.NEW_RECIPE, raw: input, fallback: true };
}

module.exports = { KIND, detect, normalize };
