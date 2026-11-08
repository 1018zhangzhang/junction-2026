"use strict";

// 纯状态机：不碰任何 IrisView API，也不做网络请求。
// 好处是可以用 node 直接单测（tools/selftest.js），并且"旧结果不得覆盖新结果"这一条
// 在 PARSE_OK / PARSE_FAIL 里靠 seq 比较天然成立。
const PHASE = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  CONFIRM: "confirm",
  DONE: "done",
  ERROR: "error"
});

const MODE = Object.freeze({
  FULL: "full",       // 主行 + 用量火候 + 计时 + 下一步
  COMPACT: "compact", // 只看当前与下一步
  TIMER: "timer"      // 计时放大
});

const PHASE_LABEL = Object.freeze({
  idle: "待命",
  working: "处理中",
  confirm: "待确认",
  done: "完成",
  error: "异常"
});

function create() {
  return {
    phase: PHASE.IDLE,
    mode: MODE.FULL,
    dish: "",
    steps: [],
    stepIndex: 0,
    fields: null,     // null = 全部显示；数组 = 只显示这些字段（内容调整）
    question: "",
    error: null,
    hint: "说「做番茄炒蛋」开始",
    lastInput: "",
    lastInputSource: "",
    seq: 0,
    note: "",
    droppedCount: 0,
    timer: null
  };
}

function clone(state) {
  return {
    phase: state.phase,
    mode: state.mode,
    dish: state.dish,
    steps: state.steps,
    stepIndex: state.stepIndex,
    fields: state.fields,
    question: state.question,
    error: state.error,
    hint: state.hint,
    lastInput: state.lastInput,
    lastInputSource: state.lastInputSource,
    seq: state.seq,
    note: state.note,
    droppedCount: state.droppedCount,
    timer: state.timer
  };
}

function currentStep(state) {
  return state.steps[state.stepIndex] || null;
}

function nextStep(state) {
  return state.steps[state.stepIndex + 1] || null;
}

function isLastStep(state) {
  return state.steps.length > 0 && state.stepIndex >= state.steps.length - 1;
}

// 切步骤必须让旧计时作废，否则会出现"上一锅的倒计时还在响"
function makeTimer(step, now) {
  if (!step || !step.durationSec || step.durationSec <= 0) return null;
  return {
    durationSec: step.durationSec,
    startedAt: now,
    expired: false
  };
}

function reduce(state, action) {
  const next = clone(state);
  next.note = action.type;

  switch (action.type) {
    case "INPUT": {
      next.lastInput = action.text;
      next.lastInputSource = action.source || "text";
      return next;
    }

    case "REQUEST": {
      next.seq = action.seq;
      next.phase = PHASE.WORKING;
      next.error = null;
      next.question = "";
      next.hint = action.hint || "正在理解你的口述…";
      return next;
    }

    case "PARSE_OK": {
      // 关键：晚到的旧响应直接丢弃，不改动当前画面
      if (action.seq !== state.seq) {
        next.note = "stale-dropped";
        next.droppedCount = state.droppedCount + 1;
        return next;
      }
      next.dish = action.recipe.dish || "未命名";
      next.steps = action.recipe.steps;
      next.stepIndex = 0;
      next.fields = null;
      next.phase = PHASE.DONE;
      next.mode = MODE.FULL;
      next.error = null;
      next.hint = "说「下一步」推进";
      next.timer = makeTimer(next.steps[0], action.now || Date.now());
      return next;
    }

    case "PARSE_FAIL": {
      if (action.seq !== state.seq) {
        next.note = "stale-dropped";
        next.droppedCount = state.droppedCount + 1;
        return next;
      }
      next.phase = PHASE.ERROR;
      next.error = action.error;
      next.hint = action.error && action.error.hint ? action.error.hint : "可以说「重来」或改用文字输入";
      next.timer = null;
      return next;
    }

    case "NEXT": {
      if (state.phase !== PHASE.DONE && state.phase !== PHASE.CONFIRM) return next;
      if (state.steps.length === 0) return next;
      if (state.stepIndex >= state.steps.length - 1) {
        next.hint = "已经是最后一步";
        next.timer = null;
        next.question = "";
        next.phase = PHASE.DONE;
        return next;
      }
      next.stepIndex = state.stepIndex + 1;
      next.phase = PHASE.DONE;
      next.question = "";
      next.hint = "说「下一步」推进";
      next.timer = makeTimer(next.steps[next.stepIndex], action.now || Date.now());
      return next;
    }

    case "PREV": {
      if (state.phase !== PHASE.DONE) return next;
      if (state.stepIndex <= 0) {
        next.hint = "已经是第一步";
        return next;
      }
      next.stepIndex = state.stepIndex - 1;
      next.timer = makeTimer(next.steps[next.stepIndex], action.now || Date.now());
      return next;
    }

    case "SET_MODE": {
      if (!Object.values(MODE).includes(action.mode)) return next;
      next.mode = action.mode;
      next.hint = action.hint || next.hint;
      return next;
    }

    case "ASK": {
      next.phase = PHASE.CONFIRM;
      next.question = action.question;
      next.hint = action.hint || "回答后继续，或说「取消」";
      return next;
    }

    case "SET_FIELDS": {
      // 内容调整：只保留指定字段，界面呈现的条目数真的会变少
      const fields = Array.isArray(action.fields) && action.fields.length ? action.fields.slice() : null;
      next.fields = fields;
      next.hint = fields ? "已精简：" + fields.map(fieldLabel).join("、") : "已恢复完整信息";
      return next;
    }

    case "AMEND": {
      if (state.steps.length === 0) return next;
      const updated = state.steps.slice();
      const cur = updated[state.stepIndex];
      if (!cur) return next;
      updated[state.stepIndex] = {
        no: cur.no,
        action: cur.action,
        usage: cur.usage ? cur.usage + " + " + action.object : action.object,
        durationSec: cur.durationSec,
        fire: cur.fire
      };
      next.steps = updated;
      next.phase = PHASE.DONE;
      next.fields = null;
      next.hint = "已补充「" + action.object + "」";
      return next;
    }

    case "CORRECT": {
      // 独立纠正：事实性错误要全篇替换，否则用户在第 3 步纠正第 1 步的用量会改不到
      if (state.steps.length === 0) return next;
      const updated = state.steps.map((step) => ({
        no: step.no,
        action: replaceAll(step.action, action.from, action.to),
        usage: replaceAll(step.usage, action.from, action.to),
        durationSec: step.durationSec,
        fire: step.fire
      }));
      next.steps = updated;
      next.phase = PHASE.DONE;
      next.question = "";
      next.hint = `已改为「${action.to}」`;
      next.timer = makeTimer(updated[next.stepIndex], action.now || Date.now());
      return next;
    }

    case "RESET": {
      const fresh = create();
      fresh.seq = state.seq;
      fresh.lastInput = state.lastInput;
      fresh.lastInputSource = state.lastInputSource;
      fresh.note = "RESET";
      fresh.hint = "说「做番茄炒蛋」开始";
      return fresh;
    }

    case "TICK": {
      if (!state.timer) return next;
      const elapsed = (action.now - state.timer.startedAt) / 1000;
      if (elapsed >= state.timer.durationSec && !state.timer.expired) {
        next.timer = { durationSec: state.timer.durationSec, startedAt: state.timer.startedAt, expired: true };
        next.hint = "时间到";
      }
      return next;
    }

    default:
      return next;
  }
}

function replaceAll(text, from, to) {
  if (typeof text !== "string" || !from) return text || "";
  return text.split(from).join(to);
}

function fieldLabel(field) {
  if (field === "usage") return "用量";
  if (field === "duration") return "时长";
  if (field === "fire") return "火候";
  if (field === "next") return "下一步";
  return field;
}

// 计时剩余秒数，供 UI 显示
function remainingSec(state, now) {
  if (!state.timer) return null;
  const elapsed = (now - state.timer.startedAt) / 1000;
  const left = state.timer.durationSec - elapsed;
  return left > 0 ? Math.ceil(left) : 0;
}

module.exports = {
  PHASE,
  MODE,
  PHASE_LABEL,
  create,
  reduce,
  currentStep,
  nextStep,
  isLastStep,
  remainingSec
};
