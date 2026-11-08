"use strict";

// 结构化日志：每一行都是可粘贴给评委/队友的证据。
// 格式固定为 "KITCHEN {json}"，方便用 grep 过滤、也方便写进验收表。
const TAG = "KITCHEN";

function log(event, data) {
  const payload = { event, at: Date.now() };
  if (data) {
    for (const key of Object.keys(data)) payload[key] = data[key];
  }
  try {
    console.log(TAG + " " + JSON.stringify(payload));
  } catch (error) {
    // 日志本身绝不允许让应用崩掉
    console.log(TAG + " " + event);
  }
}

module.exports = { log, TAG };
