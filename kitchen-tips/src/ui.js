"use strict";

// 渲染层：只负责"把状态画出来"，不做任何判断。
// 布局用绝对定位（setIgnoreLayout(true)），和官方呼吸示例一致，640×480 单目视口。
const { PHASE, MODE, PHASE_LABEL, currentStep, nextStep, remainingSec } = require("./state");

// 状态配色：待命灰、处理中青、待确认黄、完成绿、异常红
const PHASE_RGB = {
  idle: [128, 134, 146],
  working: [0, 198, 224],
  confirm: [242, 184, 5],
  done: [0, 208, 132],
  error: [240, 88, 88]
};

const C = {
  bg: [10, 12, 16],
  primary: [238, 242, 248],
  secondary: [150, 160, 176],
  muted: [104, 112, 126],
  faint: [74, 80, 92],
  divider: [38, 42, 50],
  warn: [242, 184, 5],
  timer: [0, 198, 224]
};

const LAYOUTS = {
  full: {
    main: { x: 26, y: 72, w: 588, h: 112, size: 30, align: "left" },
    sub: { x: 26, y: 196, w: 588, h: 30, size: 20 },
    timer: { x: 26, y: 234, w: 588, h: 36, size: 24 },
    divider: { x: 26, y: 286, w: 588, h: 1 },
    next: { x: 26, y: 298, w: 588, h: 58, size: 17 }
  },
  compact: {
    main: { x: 26, y: 72, w: 588, h: 128, size: 30, align: "left" },
    sub: { x: 26, y: 208, w: 588, h: 28, size: 19 },
    timer: { x: 26, y: 240, w: 588, h: 30, size: 20 },
    divider: { x: 26, y: 252, w: 588, h: 1 },
    next: { x: 26, y: 266, w: 588, h: 92, size: 24 }
  },
  timer: {
    main: { x: 26, y: 66, w: 588, h: 42, size: 19, align: "center" },
    sub: { x: 26, y: 240, w: 588, h: 30, size: 20 },
    timer: { x: 26, y: 118, w: 588, h: 110, size: 64, align: "center" },
    divider: { x: 26, y: 286, w: 588, h: 1 },
    next: { x: 26, y: 298, w: 588, h: 58, size: 17 }
  }
};

function createUI(ui, rootWidget) {
  const view = {};
  const fonts = new Map();

  function rgb(color) {
    return ui.Color.fromRGB8(color[0], color[1], color[2]);
  }

  function font(size) {
    if (fonts.has(size)) return fonts.get(size);
    const cached = ui.Font.getCachedFont("", size, 0, 0);
    fonts.set(size, cached || null);
    return cached || null;
  }

  function text(x, y, w, h, size, color) {
    const widget = ui.Text.create();
    widget.setParent(view.canvas);
    widget.setIgnoreLayout(true);
    widget.setPosition([x, y, 0]);
    widget.setSize([w, h, 0]);
    const style = widget.getLocalStyle();
    const loaded = font(size);
    if (loaded) style.setTextFont(loaded);
    style.setTextColor(rgb(color));
    style.setTextAlign(ui.TextAlign.LEFT_MID);
    widget.setText("");
    return widget;
  }

  function block(x, y, w, h, color) {
    const widget = ui.View.create();
    widget.setParent(view.canvas);
    widget.setIgnoreLayout(true);
    widget.setPosition([x, y, 0]);
    widget.setSize([w, h, 0]);
    widget.getLocalStyle().setBackgroundColor(rgb(color));
    return widget;
  }

  function start() {
    view.canvas = ui.Board.create();
    view.canvas.setParent(rootWidget);
    view.canvas.setIgnoreLayout(true);
    view.canvas.setSize([640, 480, 0]);
    view.canvas.getLocalStyle().setBackgroundColor(rgb(C.bg));

    view.dot = block(26, 22, 10, 10, C.muted);
    view.status = text(46, 14, 220, 26, 18, C.muted);
    view.counter = text(360, 14, 254, 26, 14, C.faint);
    view.counter.getLocalStyle().setTextAlign(ui.TextAlign.RIGHT_MID);

    view.main = text(26, 72, 588, 112, 30, C.primary);
    view.sub = text(26, 196, 588, 30, 20, C.secondary);
    view.timer = text(26, 234, 588, 36, 24, C.timer);
    view.divider = block(26, 286, 588, 1, C.divider);
    view.next = text(26, 298, 588, 58, 17, C.secondary);

    view.echo = text(26, 404, 588, 22, 13, C.muted);
    view.hint = text(26, 432, 588, 22, 12, C.faint);

    // 主行文字限制：明确换行 + 最多三行，防止长内容溢出（验收项）
    try {
      if (ui.Text && ui.Text.LongMode) view.main.setLongMode(ui.Text.LongMode.LONG_WRAP);
    } catch (error) {
      // 老版本 Host 没有该接口，忽略即可
    }
    try {
      if (typeof view.main.setHeightByLineCount === "function") view.main.setHeightByLineCount(3);
    } catch (error) {
      // 同上
    }

    view.lastLayout = "";
    view.lastText = {};
    view.lastColor = {};
    return view;
  }

  function place(widget, box, align) {
    widget.setPosition([box.x, box.y, 0]);
    widget.setSize([box.w, box.h, 0]);
    const loaded = font(box.size);
    if (loaded) widget.getLocalStyle().setTextFont(loaded);
    if (align) {
      widget.getLocalStyle().setTextAlign(align === "center" ? ui.TextAlign.CENTER : ui.TextAlign.LEFT_MID);
    }
    widget.setHidden(false);
  }

  function applyLayout(mode) {
    const layout = LAYOUTS[mode] || LAYOUTS.full;
    place(view.main, layout.main, layout.main.align);
    place(view.sub, layout.sub);
    place(view.timer, layout.timer, layout.timer.align);
    place(view.next, layout.next);
    view.divider.setPosition([layout.divider.x, layout.divider.y, 0]);
    view.divider.setSize([layout.divider.w, layout.divider.h, 0]);
    view.divider.setHidden(false);
  }

  function setText(widget, key, value) {
    if (view.lastText[key] === value) return;
    view.lastText[key] = value;
    widget.setText(value);
  }

  function setColor(widget, key, color) {
    if (view.lastColor[key] === color) return;
    view.lastColor[key] = color;
    widget.getLocalStyle().setTextColor(rgb(color));
  }

  function fmt(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes + ":" + String(rest).padStart(2, "0");
  }

  function render(state, now) {
    const modeKey = state.mode + "|" + state.phase;
    if (view.lastLayout !== modeKey) {
      view.lastLayout = modeKey;
      applyLayout(state.mode);
      if (state.phase === PHASE.IDLE || state.phase === PHASE.ERROR) {
        // 这两种状态只需要主行与副行，其余元素隐藏，避免"杂讯"
        view.timer.setHidden(true);
        view.divider.setHidden(true);
        view.next.setHidden(true);
      }
      if (state.phase === PHASE.CONFIRM) {
        view.timer.setHidden(true);
      }
    }

    const color = PHASE_RGB[state.phase] || PHASE_RGB.idle;
    const statusColor = state.phase === PHASE.WORKING && Math.floor(now / 320) % 2 === 0 ? C.faint : color;

    view.dot.getLocalStyle().setBackgroundColor(rgb(statusColor));
    setColor(view.status, "status", color);
    setText(view.status, "status", PHASE_LABEL[state.phase] || "待命");

    const total = state.steps.length;
    const counter = total > 0 ? `${state.dish} · 第 ${state.stepIndex + 1}/${total} 步` : "";
    setText(view.counter, "counter", counter.slice(0, 30));

    const step = currentStep(state);
    const upcoming = nextStep(state);
    let main = "";
    let sub = "";
    let nextLine = "";
    let timerLine = "";

    if (state.phase === PHASE.IDLE) {
      main = "等待指令";
      sub = "说一句想做的菜，比如「做番茄炒蛋」";
    } else if (state.phase === PHASE.WORKING) {
      const dots = ".".repeat(1 + (Math.floor(now / 400) % 3));
      main = "正在理解" + dots;
      sub = state.lastInput ? "听到：" + state.lastInput : "正在采集输入";
    } else if (state.phase === PHASE.CONFIRM) {
      main = state.question || "需要确认一下";
      sub = "说「确认」，或直接告诉我更具体的信息";
    } else if (state.phase === PHASE.ERROR) {
      main = state.error && state.error.title ? state.error.title : "处理失败";
      sub = state.error && state.error.hint ? state.error.hint : "可以说「重来」";
    } else {
      main = step ? step.action : "没有步骤";
      // 内容调整（"只保留用量和时长"）在这里真实生效：条目数会变少
      const showAll = !state.fields;
      const wants = (field) => showAll || (Array.isArray(state.fields) && state.fields.indexOf(field) >= 0);
      const parts = [];
      if (step) {
        if (step.usage && wants("usage")) parts.push("用量 " + step.usage);
        if (step.fire && wants("fire")) parts.push(step.fire);
        if (step.durationSec > 0 && wants("duration")) parts.push("约 " + step.durationSec + " 秒");
      }
      sub = parts.join(" · ");
      if (upcoming && wants("next")) nextLine = "下一步  " + upcoming.action;
      else if (upcoming) nextLine = "";
      else nextLine = "这是最后一步，做完就开饭";

      const left = remainingSec(state, now);
      if (left !== null && wants("duration")) {
        timerLine = state.timer && state.timer.expired ? "时间到" : fmt(left);
      }
      // 放大计时的指令落在没有时长的步骤上时，也要给出可见反馈，而不是一片空白
      if (!timerLine && state.mode === MODE.TIMER && wants("duration")) timerLine = "无需计时";
    }

    if (state.mode === MODE.COMPACT && state.phase === PHASE.DONE) {
      const wantsCompact = (field) => !state.fields || state.fields.indexOf(field) >= 0;
      sub = step && step.usage && wantsCompact("usage") ? "用量 " + step.usage : "";
      nextLine = upcoming ? "接着做：" + upcoming.action : "最后一步了";
    }

    setText(view.main, "main", main);
    setText(view.sub, "sub", sub);
    setText(view.next, "next", nextLine);
    setText(view.timer, "timer", timerLine);
    setColor(view.main, "main", state.phase === PHASE.ERROR ? PHASE_RGB.error : state.phase === PHASE.IDLE ? C.secondary : C.primary);
    setColor(view.timer, "timer", state.timer && state.timer.expired ? C.warn : C.timer);

    if (state.mode === MODE.COMPACT && state.phase === PHASE.DONE) {
      setColor(view.next, "next", C.primary);
    } else {
      setColor(view.next, "next", C.secondary);
    }

    if (state.phase === PHASE.DONE) {
      const showAllFields = !state.fields;
      const fieldOn = (field) => showAllFields || (Array.isArray(state.fields) && state.fields.indexOf(field) >= 0);
      const showTimer = Boolean(timerLine) && state.mode !== MODE.COMPACT && fieldOn("duration");
      view.timer.setHidden(!showTimer);
      view.next.setHidden(state.mode === MODE.TIMER || !fieldOn("next") || !nextLine);
      view.divider.setHidden(state.mode === MODE.TIMER && !nextLine);
    }

    const sourceTag = state.lastInputSource === "voice" ? "语音" : "文字";
    setText(view.echo, "echo", state.lastInput ? `${sourceTag} · ${state.lastInput}`.slice(0, 46) : "");
    setText(view.hint, "hint", state.hint || "");
    setColor(view.hint, "hint", state.hint === "时间到" ? C.warn : C.faint);
  }

  return { start, render, view };
}

module.exports = { createUI, PHASE_RGB, C };
