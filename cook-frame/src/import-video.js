"use strict";
// ============================================================================
// 视频 / 图文导入的预留接口（默认不做事，只占位）
//
// 目标形态（决赛后 / 产品版）：
//   用户给一段做菜视频或一张截图 → 自动拆成"一步一步"，然后跟本地菜谱一样，
//   带着用户一步步做（计时、救场、追问全都自动继承）。
//
// 现在为什么不做：
//   1) 眼镜端没有视频解码与抽帧能力，算力也不够；
//   2) 真正能做的是"抽帧 + 语音转写 + 多模态模型理解"，需要联网和大模型额度；
//   3) 赛制时间有限，要做就把已有的核心链路（语音免手 + 11 道菜 + 救场）做稳。
//
// 以后怎么接（三步，不改现有代码）：
//   1) 在 PC 端把视频拆成 steps（用 llm-bridge.ask + llm-bridge.extractJson）
//   2) 交给 dishes-extra.normalize() 校验并补默认字段
//   3) 写进应用数据目录的 recipes.json —— 之后和内置菜谱完全一样
//
// 所以这个文件的职责只有一件：把"视频 → 菜谱"这条链路的入口先钉死，
// 保证以后接进来的时候，上层（菜单 / 引擎 / 语音）一行都不用改。
// ============================================================================

const STATUS = Object.freeze({
  NOT_CONFIGURED: "not-configured",
  UNSUPPORTED: "unsupported",
  BAD_MEDIA: "bad-media",
  OK: "ok"
});

/**
 * 从视频/图片里解析菜谱。
 * 现在恒定返回「不支持」，不会读文件、不会联网、不会抛异常。
 * @param {string} mediaPath 本地文件路径（将来才用）
 * @returns {Promise<{ok:boolean, reason?:string, dish?:object, steps?:Array}>}
 */
async function importFromMedia(mediaPath) {
  const target = String(mediaPath || "");
  if (!target) return { ok: false, reason: STATUS.BAD_MEDIA };
  // 占位：将来这里会调 llm-bridge 做"抽帧 + 转写 + 结构化"
  return { ok: false, reason: STATUS.UNSUPPORTED };
}

/** 给人看的状态说明（界面/日志用）。 */
function statusText() {
  return "视频导入：预留（当前版本请用 recipes.json 导入菜谱）";
}

module.exports = { STATUS, importFromMedia, statusText };
