"use strict";
/* 提交前自检：源码 / 构建产物 / .fuiapp 包里有没有密钥。
   用法：node tools/check-secrets.js [包路径]
   退出码 0 = 干净，1 = 发现疑似密钥（cook-run.sh 会直接中断，不打包）。
   ★ 只扫 src/ 和 dist/ 和包本身：根目录的 llm.json 是你本机的密钥文件，
     不进包、不进仓库（.gitignore 已忽略），本来就应该存在。 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const RULES = [
  { name: "OpenAI 风格密钥", re: /sk-[A-Za-z0-9_\-]{16,}/g },
  { name: "Bearer 长串", re: /Bearer\s+[A-Za-z0-9_\-.~+/]{20,}/g },
  { name: "填写了真实 apiKey 字段", re: /"api[_-]?key"\s*:\s*"(?!把这里|your|YOUR|<|\.\.\.)[A-Za-z0-9_\-]{16,}"/g },
  { name: "常见云厂商密钥", re: /(AKIA|LTAI|AKID)[A-Za-z0-9]{12,}/g },
];
const TEXT_EXT = new Set([".js", ".json", ".md", ".txt", ".xml", ".yaml", ".yml", ".html", ".css"]);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function scanBuffer(file, label) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return []; }
  const text = buf.toString("utf8");
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(text);
    if (m) hits.push(label + " · " + rule.name + " · " + m[0].slice(0, 8) + "…");
  }
  return hits;
}

const targets = [path.join(ROOT, "src"), path.join(ROOT, "dist")];
for (const arg of process.argv.slice(2)) targets.push(path.resolve(arg));

const files = [];
for (const t of targets) {
  try {
    const st = fs.statSync(t);
    if (st.isDirectory()) walk(t, files);
    else files.push(t);
  } catch (e) { /* 路径不存在就跳过（比如还没 build 的 dist） */ }
}

let hits = [];
for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const isPkg = /\.(fuiapp|zip|tar|gz)$/i.test(ext);
  if (!TEXT_EXT.has(ext) && !isPkg) continue;
  hits = hits.concat(scanBuffer(file, path.relative(ROOT, file)));
}

if (hits.length) {
  console.error("[失败] 发现疑似密钥（提交物里不能有密钥）：");
  for (const h of hits.slice(0, 20)) console.error("   - " + h);
  console.error("   处理：把密钥移到应用数据目录的 llm.json，或换成占位文字。");
  process.exit(1);
}
console.log("[ok] 源码/产物里没有密钥（" + files.length + " 个文件已检查）");
