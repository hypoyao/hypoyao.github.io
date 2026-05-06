#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";

const ROOT = process.cwd();
const DEFAULT_MODEL = "qwen3.6-plus-2026-04-02";
const DEFAULT_OUT_DIR = "template-lab/generated";

const TEMPLATE_SPECS = {
  quizChallenge: {
    name: "问答闯关",
    purpose: "知识问答、英语学习、判断题、口算挑战",
    core: "展示题目 -> 选择答案 -> 即时反馈 -> 计分/下一题 -> 完成结算",
    controls: "点击/触摸选项按钮",
  },
  tapTarget: {
    name: "点击目标/打地鼠",
    purpose: "打地鼠、点击收集、反应力挑战、找目标",
    core: "目标随机出现 -> 点击正确目标得分 -> 避免错误目标 -> 倒计时结算",
    controls: "鼠标点击/触摸点击",
  },
  dodgeRunner: {
    name: "躲避障碍",
    purpose: "躲避、跑酷、飞行避障、接炸弹/躲炸弹",
    core: "角色移动 -> 障碍生成 -> 碰撞判定 -> 存活计分 -> 失败重开",
    controls: "键盘左右/触摸左右按钮/滑动",
  },
  jumping: {
    name: "跳跳球",
    purpose: "弹跳闯关、跳跃收集、平台跳跃",
    core: "重力/跳跃 -> 平台/道具 -> 收集或到达目标 -> 失败/通关",
    controls: "点击/空格跳跃，左右键或按钮移动",
  },
  memoryCard: {
    name: "记忆翻牌",
    purpose: "记忆力、单词图片匹配、图案配对",
    core: "翻开卡片 -> 两两匹配 -> 错误盖回 -> 全部匹配结算",
    controls: "点击/触摸卡片",
  },
  matchingLine: {
    name: "连线匹配",
    purpose: "词义配对、科学知识匹配、分类连线",
    core: "左右两列项目 -> 选择配对 -> 判断正确性 -> 完成全部结算",
    controls: "点击左项再点击右项",
  },
};

function parseArgs(argv) {
  const out = {
    templateId: "",
    all: false,
    outDir: DEFAULT_OUT_DIR,
    model: DEFAULT_MODEL,
    temperature: 0.35,
    maxTokens: 8000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--out") out.outDir = argv[++i] || out.outDir;
    else if (a === "--model") out.model = argv[++i] || out.model;
    else if (a === "--temperature") out.temperature = Number(argv[++i] || out.temperature);
    else if (a === "--max-tokens") out.maxTokens = Number(argv[++i] || out.maxTokens);
    else if (!a.startsWith("--") && !out.templateId) out.templateId = a;
  }
  if (!out.all && !out.templateId) out.templateId = "tapTarget";
  return out;
}

async function loadDotEnv(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(s);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] != null) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // .env.local is optional.
  }
}

function normalizeBaseUrl(raw, fallback) {
  const s = String(raw || fallback || "").trim().replace(/\/+$/, "");
  return s || fallback;
}

function modelConfig(args) {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "";
  if (!apiKey) {
    throw new Error("MISSING_DASHSCOPE_API_KEY_OR_BAILIAN_API_KEY");
  }
  const baseUrl = normalizeBaseUrl(
    process.env.DASHSCOPE_BASE_URL || process.env.BAILIAN_BASE_URL,
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
  return {
    apiKey,
    url: `${baseUrl}/chat/completions`,
    model: args.model || process.env.BAILIAN_MODEL || process.env.DASHSCOPE_MODEL || DEFAULT_MODEL,
  };
}

function buildPrompt(templateId) {
  const spec = TEMPLATE_SPECS[templateId];
  if (!spec) {
    throw new Error(`UNKNOWN_TEMPLATE:${templateId}. Available: ${Object.keys(TEMPLATE_SPECS).join(", ")}`);
  }
  return `你是一个儿童 H5 小游戏模板设计师。请生成一个“${spec.name}”模板原型。

这是“模板”，不是某一个固定游戏。后续平台会通过 config 注入主题、角色、题目、颜色和规则。

【模板用途】
- templateId: ${templateId}
- 适用需求：${spec.purpose}
- 核心循环：${spec.core}
- 操作方式：${spec.controls}

【必须满足】
1. 只输出文件分隔符协议，不要解释，不要 Markdown 代码块。
2. 输出 4 个文件：README.md、index.html、style.css、game.js。
3. 不使用任何外部资源、CDN、远程字体、远程图片、第三方脚本。
4. 支持手机和电脑，触控目标要大，儿童可读。
5. 文件必须短小稳定，适合作为模板原型，不追求复杂功能。
6. 所有主题内容通过 window.GAME_CONFIG 注入；game.js 必须提供默认 config 并与 window.GAME_CONFIG 合并。
7. game.js 必须暴露 window.__GAME_TEMPLATE_META__，内容包含：
   - templateId
   - version
   - requiredConfig
   - requiredDomIds
   - events
   - supportedControls
   - acceptance
8. index.html 必须包含固定 DOM：
   - gameRoot
   - playArea
   - scoreText
   - timerText
   - statusText
   - btnStart
   - btnRestart
9. game.js 必须绑定 btnStart 和 btnRestart 的 click 事件。
10. 不能写死具体游戏主题，例如“小猫偷吃”只能作为默认 config 示例，不能写死在逻辑里。

【文件分隔符协议】
严格按下面格式输出，每个文件必须完整闭合：

<<<FILE:README.md>>>
...
<<<END_FILE>>>
<<<FILE:index.html>>>
...
<<<END_FILE>>>
<<<FILE:style.css>>>
...
<<<END_FILE>>>
<<<FILE:game.js>>>
...
<<<END_FILE>>>

现在开始输出。`;
}

async function callQwen(prompt, args) {
  const cfg = modelConfig(args);
  const payload = {
    model: cfg.model,
    messages: [
      {
        role: "system",
        content:
          "你只输出用户要求的文件分隔符协议。不要输出思考过程、解释、Markdown 代码块或额外文字。代码必须完整，不要截断。",
      },
      { role: "user", content: prompt },
    ],
    temperature: Number.isFinite(args.temperature) ? args.temperature : 0.35,
    max_tokens: Number.isFinite(args.maxTokens) ? args.maxTokens : 8000,
    stream: false,
  };
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(480_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || res.status;
    throw new Error(`MODEL_ERROR:${msg}`);
  }
  const text = String(json?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("EMPTY_MODEL_RESPONSE");
  return { text, model: cfg.model, url: cfg.url };
}

function parseFiles(text) {
  const files = new Map();
  const re = /<<<FILE:([^>\n]+)>>>\s*([\s\S]*?)\s*<<<END_FILE>>>/g;
  let m;
  while ((m = re.exec(text))) {
    const filePath = String(m[1] || "").trim();
    const content = String(m[2] || "").replace(/\s+$/g, "");
    if (filePath) files.set(filePath, content);
  }
  return Object.fromEntries(files);
}

function validateFiles(files) {
  const errors = [];
  for (const p of ["README.md", "index.html", "style.css", "game.js"]) {
    if (!files[p] || String(files[p]).trim().length < 20) errors.push(`MISSING_OR_EMPTY:${p}`);
  }
  const all = Object.values(files).join("\n");
  if (/https?:\/\//i.test(all)) errors.push("EXTERNAL_URL_FOUND");
  const html = files["index.html"] || "";
  const js = files["game.js"] || "";
  if (!/style\.css/.test(html)) errors.push("INDEX_MISSING_STYLE_CSS");
  if (!/game\.js/.test(html)) errors.push("INDEX_MISSING_GAME_JS");
  for (const id of ["gameRoot", "playArea", "scoreText", "timerText", "statusText", "btnStart", "btnRestart"]) {
    if (!new RegExp(`id=["']${id}["']`).test(html)) errors.push(`INDEX_MISSING_DOM_ID:${id}`);
  }
  if (!/window\.__GAME_TEMPLATE_META__/.test(js)) errors.push("JS_MISSING_TEMPLATE_META");
  if (!/GAME_CONFIG/.test(js)) errors.push("JS_MISSING_GAME_CONFIG");
  if (!/btnStart/.test(js) || !/addEventListener\(["']click["']/.test(js)) errors.push("JS_MISSING_START_CLICK_BINDING");
  if (!/btnRestart/.test(js)) errors.push("JS_MISSING_RESTART_BINDING");
  try {
    new Script(js);
  } catch (e) {
    errors.push(`JS_SYNTAX:${e.message}`);
  }
  return {
    ok: errors.length === 0,
    errors,
  };
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds(),
  )}`;
}

async function writeTemplateRun({ templateId, args, prompt, response }) {
  const files = parseFiles(response.text);
  const validation = validateFiles(files);
  const dir = path.join(ROOT, args.outDir, templateId, stamp());
  await fs.mkdir(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const safeName = filePath.replace(/^\/+/, "").replace(/\.\./g, "");
    await fs.writeFile(path.join(dir, safeName), content, "utf8");
  }
  await fs.writeFile(path.join(dir, "prompt.txt"), prompt, "utf8");
  await fs.writeFile(path.join(dir, "raw-response.txt"), response.text, "utf8");
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        templateId,
        templateName: TEMPLATE_SPECS[templateId]?.name || templateId,
        createdAt: new Date().toISOString(),
        provider: "bailian",
        model: response.model,
        outputDir: path.relative(ROOT, dir),
        files: Object.keys(files),
        validation,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, validation };
}

async function generateOne(templateId, args) {
  const prompt = buildPrompt(templateId);
  console.log(`[template] generating ${templateId} with ${args.model || DEFAULT_MODEL}...`);
  const response = await callQwen(prompt, args);
  const result = await writeTemplateRun({ templateId, args, prompt, response });
  const rel = path.relative(ROOT, result.dir);
  if (result.validation.ok) {
    console.log(`[template] ok ${templateId} -> ${rel}`);
  } else {
    console.log(`[template] generated with validation issues ${templateId} -> ${rel}`);
    for (const err of result.validation.errors) console.log(`  - ${err}`);
  }
}

async function main() {
  await loadDotEnv(path.join(ROOT, ".env.local"));
  const args = parseArgs(process.argv.slice(2));
  const ids = args.all ? Object.keys(TEMPLATE_SPECS) : [args.templateId];
  for (const id of ids) {
    await generateOne(id, args);
  }
}

main().catch((e) => {
  console.error(`[template] failed: ${e?.message || e}`);
  process.exit(1);
});
