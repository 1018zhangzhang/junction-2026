"use strict";

// ============================================================================
// 【大脑接口】把"一句话"变成"一份菜谱步骤"
// ----------------------------------------------------------------------------
// 统一插座：getBrain() 按配置自动选择实现，上层代码不关心背后是谁。
//   LocalBrain  —— 默认。内置示例菜谱 + 关键词匹配，完全离线可用。
//   RemoteBrain —— 预留。项目根目录有 config.json 且填了 LLM endpoint/key
//                  时自动启用，fetch 调 OpenAI 兼容接口（换服务商只改配置）。
//
// 菜谱数据结构（两个实现都必须返回这个形状）：
//   { dish: "番茄炒蛋", steps: [ { text: "步骤一句话", sec: 60 }, ... ] }
// ============================================================================

const fs = require("node:fs");
const path = require("node:path");

// ---- 内置示例菜谱（离线模式的弹药库，往里加菜就行） ----
const BUILTIN_RECIPES = Object.freeze([
  {
    dish: "番茄炒蛋",
    steps: [
      { text: "番茄切块，鸡蛋打散加少许盐", sec: 60 },
      { text: "热锅倒油，先炒蛋至凝固盛出", sec: 60 },
      { text: "下番茄炒出汁，倒回蛋翻匀", sec: 90 },
      { text: "加盐调味，出锅装盘", sec: 30 }
    ]
  },
  {
    dish: "泡面加蛋",
    steps: [
      { text: "烧一壶水", sec: 180 },
      { text: "水开下面，煮三分钟", sec: 180 },
      { text: "卧个鸡蛋，关火加盖焖", sec: 60 }
    ]
  },
  {
    dish: "蒸蛋羹",
    steps: [
      { text: "鸡蛋打匀，加1.5倍温水", sec: 60 },
      { text: "过筛去泡，盖上保鲜膜", sec: 60 },
      { text: "水开后中火蒸十分钟", sec: 600 }
    ]
  }
]);

// ---- 配置读取（模仿 kitchen-tips 的做法：密钥不进代码、不进提交包） ----
function loadConfig() {
  const candidates = [
    path.join(__dirname, "..", "config.json"),        // 项目根（开发期）
    path.join(__dirname, "config.json")               // src 内（备用）
  ];
  const appDir = process.env.FUSIONUI_APP_DATA_DIR;   // 应用私有目录（正式环境）
  if (appDir) candidates.unshift(path.join(appDir, "config.json"));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.log("COOK_CONFIG bad file: " + file + " " + error);
    }
  }
  return null;
}

// ---- 本地大脑：关键词匹配。没有网络、没有模型也能用 ----
const localBrain = {
  name: "local",
  match(utterance) {
    if (!utterance) return null;
    const text = String(utterance);
    for (const recipe of BUILTIN_RECIPES) {
      // 菜名里任意一个字被提到就算命中，"我要吃番茄"也能匹配"番茄炒蛋"
      const hit = recipe.dish.split("").some((ch) => ch !== "蛋" && text.includes(ch));
      if (text.includes(recipe.dish) || (hit && recipe.dish.split("").filter((ch) => text.includes(ch)).length >= 2)) {
        return recipe;
      }
    }
    return null;
  },
  // 菜单文案：待命界面展示给用户看
  menuText() {
    return "菜单：" + BUILTIN_RECIPES.map((r) => r.dish).join(" / ");
  }
};

// ---- 远程大脑：预留插座。有 config.json 就启用，失败自动退回本地 ----
function buildRemoteBrain(config) {
  const llm = (config && config.llm) || {};
  if (!llm.endpoint || !llm.apiKey || !llm.model) return null;
  const timeoutMs = llm.timeoutMs || 20000;
  return {
    name: "remote",
    async match(utterance) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(llm.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + llm.apiKey
          },
          body: JSON.stringify({
            model: llm.model,
            temperature: 0.2,
            messages: [
              { role: "system", content: '把用户口述的做菜需求整理成步骤。只输出JSON：{"dish":"菜名","steps":[{"text":"步骤一句话","sec":秒数}]}，不要解释。' },
              { role: "user", content: String(utterance) }
            ]
          }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const jsonText = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
        const recipe = JSON.parse(jsonText);
        if (!recipe || !recipe.dish || !Array.isArray(recipe.steps) || !recipe.steps.length) {
          throw new Error("bad schema");
        }
        return recipe;
      } catch (error) {
        console.log("COOK_BRAIN remote failed: " + error);
        return null; // 上层拿到 null 会退回本地匹配
      } finally {
        clearTimeout(timer);
      }
    },
    menuText: localBrain.menuText
  };
}

// ---- 出厂：按配置自动选择 ----
function getBrain() {
  const config = loadConfig();
  const remote = buildRemoteBrain(config);
  if (remote) {
    console.log("COOK_BRAIN using remote: " + config.llm.model);
    return remote;
  }
  console.log("COOK_BRAIN using local (no config.json / no key)");
  return localBrain;
}

// 供测试用
module.exports = { getBrain, localBrain, BUILTIN_RECIPES };
