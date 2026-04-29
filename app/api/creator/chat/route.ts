import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Script } from "node:vm";
import { CREATOR_GAME_TYPE_LIBRARY_ADDON, CREATOR_OUTPUT_FORMAT_ADDON, CREATOR_SYSTEM_PROMPT } from "@/lib/creator/systemPrompt";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel Serverless：给生成留足时间，避免长步骤被平台提前终止导致前端 network error
export const maxDuration = 300;

type Msg = { role: "system" | "user" | "assistant"; content: string };
type ModelProvider = "openrouter" | "deepseek" | "bailian" | "tencent" | "chinamobile";

const TENCENT_TOKENHUB_MODELS = ["hy3-preview"] as const;
const CHINAMOBILE_MODELS = ["minimax-m25"] as const;
// DeepSeek 官方 API（OpenAI 兼容）模型：V4 系列
// deepseek-chat / deepseek-reasoner 将逐步下线（官方已声明未来弃用）
const DEEPSEEK_DIRECT_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;

function isDeepSeekV4OpenRouterModel(m: string) {
  const s = String(m || "").trim();
  return s === "deepseek/deepseek-v4-pro" || s === "deepseek/deepseek-v4-flash";
}

const OPENROUTER_MODELS = [
  // 默认：免费模型（用户要求）
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3.6-plus",
  "qwen/qwen-2.5-72b-instruct:free",
  "deepseek/deepseek-v3.2",
  // DeepSeek V4（支持 reasoning 参数；这里会自动开“最高思考强度”）
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  // Tencent（OpenRouter）
  "tencent/hy3-preview:free",
  // ZhipuAI GLM（OpenRouter）
  "z-ai/glm-5.1",
  // Architect / Refine（优先不用 Claude：地区/链路更容易失败）
  "anthropic/claude-sonnet-4.6",
  // Planner / Review 阶段（按需自动使用）
  "openai/gpt-5.4-nano",
  "openai/gpt-5.4-mini",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  // Gemini：有些地区/本地网络下走官方节点容易被拦，后端会对该类模型加 provider routing（见下方）
  // 注：部分“gemini-3-*”在 OpenRouter 可能不可用，易触发 not a valid model ID；这里不作为默认候选
  "minimax/minimax-m2.5",
] as const;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function sseHeaders() {
  return {
    "cache-control": "no-store",
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
    // Nginx 等反向代理默认会缓冲 SSE，导致长时间无输出时连接更容易被断开
    "x-accel-buffering": "no",
  };
}

function parseCreatorJson(s: string) {
  // 允许被 ```json ... ``` 包住
  const raw = s.trim();
  let obj: any = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = raw.match(/```json\s*([\s\S]*?)```/i);
    if (m) obj = JSON.parse(m[1]);
    // 兜底：有些模型会在 JSON 前后夹带少量文字，尝试截取第一个 { 到最后一个 }
    if (!obj) {
      const i0 = raw.indexOf("{");
      const i1 = raw.lastIndexOf("}");
      if (i0 >= 0 && i1 > i0) {
        try {
          obj = JSON.parse(raw.slice(i0, i1 + 1));
        } catch {
          // ignore
        }
      }
    }
  }
  if (!obj || typeof obj !== "object") throw new Error("NOT_JSON_OBJECT");
  if (typeof obj.assistant !== "string") throw new Error("MISSING_ASSISTANT");
  if (obj.meta != null) {
    if (typeof obj.meta !== "object") throw new Error("BAD_META");
    // 宽松校验：只要是 object 即可；字段缺失交给前端兜底
  }
  if (obj.files != null) {
    if (!Array.isArray(obj.files)) throw new Error("FILES_NOT_ARRAY");
    // 允许写入的文件路径（既包含发布文件，也包含草稿元信息）
    const ALLOWED = new Set(["index.html", "style.css", "game.js", "prompt.md", "meta.json"]);
    for (const f of obj.files) {
      if (!f || typeof f !== "object") throw new Error("BAD_FILE_ITEM");
      const p = String(f.path || "").trim();
      if (!ALLOWED.has(p)) {
        throw new Error(`BAD_FILE_PATH:${p || "EMPTY"}:expected=${Array.from(ALLOWED).join(",")}`);
      }
      if (typeof f.content !== "string") throw new Error("BAD_FILE_CONTENT");
    }
  }
  return obj;
}

function stripDangerousLocalBehaviorArtifacts(path: string, content: string) {
  const rel = String(path || "").trim();
  const raw = String(content || "");
  if (!raw) return raw;
  if (rel === "index.html") {
    return raw
      .replace(/\n?\s*<style\b[^>]*data-ai-local-behavior=["']1["'][^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/\n?\s*<script\b[^>]*data-ai-local-behavior=["']1["'][^>]*>[\s\S]*?<\/script>/gi, "");
  }
  if (rel === "game.js" && /__aiLocalBehaviorPatched|aiCurrentSentence|aiHideStart/.test(raw)) {
    return raw
      .replace(/.*__aiLocalBehaviorPatched.*\n?/g, "")
      .replace(/.*aiCurrentSentence.*\n?/g, "")
      .replace(/.*aiHideStart.*\n?/g, "");
  }
  return raw;
}

const OPS_PATCH_PROMPT = `
你是“前端最小补丁器（Ops Patch）”。你将基于当前现有文件和用户修改要求，只输出最小 JSON 补丁。

【硬性要求】
1) 只输出合法 JSON，不要输出 markdown/解释。
2) 输出结构优先使用轻量补丁：
{ "assistant": "...", "ops": [ ... ] }
如果确实无法用 ops 表达，才允许输出：
{ "assistant": "...", "files": [ { "path": "...", "content": "..." } ] }
3) ops 仅允许使用这些类型：
   - replace_in_file
   - remove_in_file
   - insert_before
   - insert_after
   - append_in_file
   - prepend_in_file
4) 只允许改这些文件：index.html / style.css / game.js
5) 最小改动原则：不要无意义重写；保持原有结构与命名协议。
6) 如果只是改文案、显隐、位置、样式，请优先输出 ops，不要重写整文件。
7) 严禁通过“额外注入一个兜底脚本”来偷改行为。
`.trim();

const SINGLE_FILE_PATCH_PROMPT = `
你是“前端单文件补丁器（Single File Patch）”。你会收到一个目标文件和一次具体修改指令。

【硬性要求】
1) 只输出目标文件的完整纯代码文本，不要输出 JSON，不要解释，不要 markdown 说明。
2) 如果一定要用代码块，只能输出一个与目标文件匹配的代码块。
3) 这是已有游戏上的最小修改，保留原有结构与命名，能少改就少改。
4) 只修和这次任务直接相关的内容，不要重写整个游戏，不要改其它文件。
5) 严禁通过额外注入兜底脚本来绕过现有逻辑。
`.trim();

const DEBUG_PROMPT = `
你是“自动 Debug 工程师”。输入会给你：当前文件内容 + 沙箱静态检查报错（语法错误等）。
你的任务：输出最小补丁修复错误，使代码通过检查。

【硬性要求】
1) 只输出合法 JSON，不要输出 markdown/解释。
2) 输出结构必须是：{ "assistant": "...", "files": [ { "path": "...", "content": "..." } ] }
3) 只允许改 index.html/style.css/game.js
4) 最小修复原则：只修报错相关内容，不要大改功能。
`.trim();

// 需求澄清（第一步）：严禁生成代码，先给出 3 个可选方向 + 3-5 个关键反问。
// 输出必须是 json_object，便于服务端持久化为“中间变量”。
const CLARIFY_PROMPT = `
你现在是“青少年友好”的小游戏需求小助手（面向小学/初中）。

【铁律】
1) 当用户的需求还不够明确时，严禁直接生成任何代码（包括 HTML/CSS/JS）。
2) 你要用非常简单、孩子也能懂的语言来反问；每个问题必须是“选择题”，不要让用户写长篇。
3) 你必须给出 3 个可选方案（A/B/C），让用户一键选方向。
4) 你最多问 3-5 个问题（后端会限制轮次），问题要围绕：怎么玩、在哪玩、怎么操作、画风。
5) 绝对不要出现“状态机/渲染方案/胜负判定/物理参数”等专业词。
6) 你提出的方案和问题必须紧扣“用户最早的主题/目标”（例如：学英语口语、背单词、练听力等），不能跑题成通用小游戏。
7) 你可以参考【参考案例类型库】来保持方向一致；如果你不确定应该参考哪种类型，就一定要问用户选 A-F（选择题形式）。

【输出要求：只输出合法 JSON（json_object）】
Schema：
{
  "intent": "用户想做什么（1句，儿童能懂）",
  "missing": ["还没说清楚的点1","点2"],
  "options": [
    {
      "id": "A",
      "title": "方案A（短标题）",
      "style": "画风（例如：卡通/像素/霓虹）",
      "platform": "在哪玩（手机/电脑/都可以）",
      "controls": "怎么玩（左右键/点按钮/滑动）",
      "winLose": "输了会怎样/什么时候结束（例如：撞到就结束/时间到结束）",
      "notes": "一句话特点（简单有趣）"
    }
  ],
  "questions": [
    { "id": "q1", "question": "问题（用儿童能懂的话）", "choices": ["选项1","选项2","选项3","选项4"] }
  ],
  "recommend": "A"
}

【示例问题风格（照这个口吻写）】
- 你更想在手机玩还是电脑玩？
- 你想用哪种操作？（左右键 / 点屏幕按钮 / 手指左右滑）
- 你喜欢哪种画风？（卡通 / 像素 / 霓虹酷炫）
`.trim();

// 蓝图阶段（新）：一次输出“同源蓝图 + 协议/命名 + config”的分段文本协议，但严禁输出任何代码。
// 目标：避免蓝图阶段因为严格 JSON 而跑飞；后端负责把文本协议解析成内部 design 对象。
const BLUEPRINT_PROMPT = `
你现在是“青少年友好”的小游戏设计师（面向小学/初中）。你要先做设计蓝图，再写代码（代码在下一步做）。

【铁律】
1) 严禁输出任何代码（HTML/CSS/JS）。
2) 你必须先把“关键命名/协议”定下来，后续写代码必须一模一样（比如：canvasId、按钮id、全局对象名、关键变量名）。
3) 蓝图要短、清楚、孩子能读懂；不要写长篇。
4) 必须紧扣【用户最早的主题】，不能跑题。
5) 必须从“用户最早主题”的关键词里提炼一个适合作品展示的短标题，写到 meta.title；这个标题会被固定下来，后续不要随意改名。

【输出要求：分段文本协议（更稳，严禁 JSON）】
你必须严格按下面格式输出 5 个段落。每一段都只允许写简单的 key=value 行，段落外禁止任何解释文字。
不要输出 JSON，不要输出 markdown 标题，不要写“下面是蓝图”之类说明。

===SECTION:meta===
title=从用户需求关键词提炼出的稳定短标题（不要写“我的小游戏”这种泛标题）
shortDesc=...
rules=...
creatorName=...
===END===

===SECTION:config===
platform=pc|mobile|both
theme=卡通|像素|霓虹|清新
bg=#...
accent=#...
startText=开始
restartText=重开
===END===

===SECTION:protocol===
rootId=app
canvasId=game
btnStartId=btnStart
btnRestartId=btnRestart
btnLeftId=btnLeft
stateName=G
stateVars=level,score,state,speed,autoCenter
===END===

===SECTION:blueprint===
type=A|B|C|D|E|F
coreLoop=一句话核心循环
steps=步骤1 | 步骤2 | 步骤3
winLose=什么时候结束/怎么算赢
===END===

===SECTION:assetsPlan===
renderer=canvas|dom
sprites=元素1,元素2,元素3
===END===
`.trim();

// 蓝图增量更新：基于“已有蓝图 design”，做最小改动更新并保持协议命名稳定。
const BLUEPRINT_UPDATE_PROMPT = `
你现在是“小游戏设计师（蓝图增量更新模式）”。我会给你：
1) 当前已存在的蓝图 design（包含 meta/config/protocol/blueprint/assetsPlan）
2) 用户新增需求

你的任务：在不改动核心协议命名的前提下，把新增需求合并进蓝图。

【铁律】
1) 严禁输出任何代码（HTML/CSS/JS）。
2) 尽量保持 protocol.dom 的 id 不变（rootId/canvasId/btnStartId/btnRestartId/btnLeftId）。
3) 尽量保持 protocol.state.name 与 vars 不变；如果必须新增变量，只能“追加”，不要删除旧变量。
4) 只做“最小必要修改”，避免把整个游戏换成另一个玩法。
5) 输出必须是“蓝图分段文本协议”（key=value 行），严禁输出 JSON。
6) meta.title 视为已固定标题，除非我明确要求改名，否则必须保持原样。

【输出格式（必须严格）】
===SECTION:meta===
title=保持当前固定标题，不要改名
shortDesc=...
rules=...
creatorName=...
===END===

===SECTION:config===
platform=pc|mobile|both
theme=...
bg=#...
accent=#...
startText=...
restartText=...
（可按需补充少量 config key=value）
===END===

===SECTION:protocol===
rootId=app
canvasId=game
btnStartId=btnStart
btnRestartId=btnRestart
btnLeftId=btnLeft
stateName=G
stateVars=level,score,state,speed,autoCenter
===END===

===SECTION:blueprint===
type=A|B|C|D|E|F
coreLoop=...
steps=开始 | 游玩 | 结束
winLose=...
===END===

===SECTION:assetsPlan===
renderer=canvas|dom
sprites=...
===END===
`.trim();

function pushDesignHistory(metaObj: any, prevDesign: any, note: string) {
  if (!prevDesign || typeof prevDesign !== "object") return metaObj;
  const m = metaObj && typeof metaObj === "object" ? metaObj : {};
  const g = (m as any)._gen && typeof (m as any)._gen === "object" ? { ...(m as any)._gen } : {};
  const hist = Array.isArray(g.designHistory) ? g.designHistory.slice(0, 20) : [];
  hist.unshift({ at: Date.now(), note: String(note || "").slice(0, 80), design: prevDesign });
  g.designHistory = hist.slice(0, 8);
  return { ...m, _gen: g };
}


const CODEGEN_HTML_PROMPT = `
你是“前端小游戏页面生成器”。你会收到一份已经确认好的蓝图 JSON（其中包含 meta/config/protocol/blueprint/assetsPlan）。
你的任务是先生成稳定的页面结构，只输出 index.html 纯文本。

【硬性要求】
1) 只输出 index.html 的纯 HTML 文本，不要输出 JSON，不要解释，不要 markdown 说明。
2) 如果你一定要使用代码块，也只能输出一个 \`\`\`html ... \`\`\` 代码块，里面只放 HTML。
3) index.html 必须正确引用 ./style.css 和 ./game.js，但不要内联大段脚本逻辑。
4) 先保证结构清楚、DOM id 稳定、页面容器完整。
5) 严禁输出 style.css 和 game.js。
6) 严禁输出 data-ai-local-behavior 之类的注入脚本；不要用 MutationObserver + 轮询去外挂式修改页面。
`.trim();

const CODEGEN_CSS_PROMPT = `
你是“前端小游戏样式生成器”。你会收到蓝图 JSON 和已经生成好的 index.html。
你的任务是只输出 style.css 纯文本，为当前页面结构补上稳定、清晰、适合儿童使用的布局与视觉样式。

【硬性要求】
1) 只输出 style.css 的纯 CSS 文本，不要输出 JSON，不要解释，不要 markdown 说明。
2) 如果你一定要使用代码块，也只能输出一个 \`\`\`css ... \`\`\` 代码块，里面只放 CSS。
3) 不要输出 index.html 或 game.js。
4) 样式优先保证清晰布局、大按钮、稳定响应式，不要为了炫技写过长或过度复杂的 CSS。
5) 严禁依赖外部资源、远程字体或注入脚本。
`.trim();
const CODEGEN_GAMEJS_PROMPT = `
你是“前端小游戏逻辑生成器”。你会收到蓝图 JSON、已经生成好的 index.html 和 style.css。
你的任务是只输出 game.js 纯文本，实现核心玩法逻辑。

【硬性要求】
1) 只输出 game.js 的纯 JavaScript 文本，不要输出 JSON，不要解释，不要 markdown 说明。
2) 如果你一定要使用代码块，也只能输出一个 \`\`\`js ... \`\`\` 代码块，里面只放 JS。
3) 不要输出 index.html 或 style.css。
4) 逻辑优先保证可运行、可重开、状态清楚，再考虑额外特效。
5) 不要依赖外部库；尽量暴露稳定的 window.gameHooks（如 start/restart/setAutoStart/showCurrentSentence）。
`.trim();

const CODEGEN_GAMEJS_SKELETON_PROMPT = `
你是“前端小游戏逻辑骨架生成器”。你会收到蓝图 JSON、已经生成好的 index.html 和 style.css。
你的任务是先输出一个结构完整、能通过基础语法检查的 game.js 骨架版本。

【硬性要求】
1) 只输出 game.js 的纯 JavaScript 文本，不要输出 JSON，不要解释，不要 markdown 说明。
2) 如果你一定要使用代码块，也只能输出一个 \`\`\`js ... \`\`\` 代码块，里面只放 JS。
3) 必须先把这些内容完整写出来：
   - 全局状态
   - DOM 获取
   - 关键函数定义
   - 事件绑定
   - init()/start() 入口
4) 先保证结构完整闭合、函数齐全、启动入口明确，再考虑细节。
5) 可以先用简单逻辑或 TODO 注释占位，但代码必须能通过基础 JS 语法检查，不能半句结束。
`.trim();

const CODEGEN_GAMEJS_COMPLETE_PROMPT = `
你是“前端小游戏逻辑补全器”。你会收到蓝图 JSON、index.html、style.css，以及一份已经闭合完整的 game.js 骨架。
你的任务是在保留现有结构的前提下，把 game.js 补成完整可运行版本。

【硬性要求】
1) 只输出 game.js 的纯 JavaScript 文本，不要输出 JSON，不要解释，不要 markdown 说明。
2) 如果你一定要使用代码块，也只能输出一个 \`\`\`js ... \`\`\` 代码块，里面只放 JS。
3) 必须保留已有骨架里的命名、函数结构和入口，不要重写成另一套架构。
4) 优先补全玩法细节、状态流转、事件逻辑、进度/评分/TTS/录音等业务细节。
5) 最后一行不能是半句；代码必须完整闭合，并能通过基础 JS 语法检查。
`.trim();

const FIXER_PROMPT = `
你是“Bug 修复工程师（Fixer）”。你的任务是基于当前项目文件与用户描述的 bug，给出最小改动补丁来修复问题。

【输出要求】
1) 只输出合法 JSON，不要输出任何 Markdown/解释文字。
2) 只允许修改以下文件之一：index.html / style.css / game.js
3) 返回格式必须为：
{
  "assistant": "用 1-2 句话说明修复了什么（中文）",
  "files": [
    { "path": "index.html|style.css|game.js", "content": "完整文件内容（修复后）" }
  ]
}
4) 最小修改原则：除修 bug 所需外，不要重写整个项目。
`.trim();

function parseJsonObjectLoose(s: string) {
  const raw = String(s || "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const m = raw.match(/```json\\s*([\\s\\S]*?)```/i);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  const i0 = raw.indexOf("{");
  const i1 = raw.lastIndexOf("}");
  if (i0 >= 0 && i1 > i0) {
    try {
      return JSON.parse(raw.slice(i0, i1 + 1));
    } catch {}
  }
  return null;
}

function extractPlainCodeText(raw: string, languageHints: string[] = []) {
  const text = String(raw || "").trim();
  if (!text) return "";
  for (const lang of languageHints) {
    // 注意：这里不能直接在模板字符串里写 ```，会与 TS 的反引号字符串冲突
    const re = new RegExp(`^\\s*\\\`\\\`\\\`${lang}\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*$`, "i");
    const m = text.match(re);
    if (m?.[1]) return String(m[1]).trim();
  }
  const generic = text.match(/^\s*```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```\s*$/i);
  if (generic?.[1]) return String(generic[1]).trim();
  return text;
}

function collectInlineScriptBlocks(html: string) {
  const blocks: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html || "")))) {
    const attrs = String(m[1] || "");
    if (/src\s*=/.test(attrs)) continue;
    const code = String(m[2] || "").trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

// 通用校验：检查 index.html 内联 <script>（无 src）是否可被 JS 解析
function validateInlineScripts(html: string) {
  const err: string[] = [];
  try {
    const js = collectInlineScriptBlocks(html).join("\n\n");
    if (js.trim()) new Script(js);
  } catch (e: any) {
    err.push(`index.html 内联脚本语法错误：${String(e?.message || e)}`);
  }
  return err;
}

function validateStandaloneJsSyntax(jsCode: string) {
  try {
    if (String(jsCode || "").trim()) new Script(String(jsCode || ""));
    return "";
  } catch (e: any) {
    return String(e?.message || e || "");
  }
}

function hasExpectedAssetReference(indexHtml: string, relPath: string, attr: "href" | "src") {
  const safePath = escapeRegExp(String(relPath || "").replace(/^\.\//, ""));
  const re = new RegExp(`${attr}\\s*=\\s*["'](?:\\.\\/)?${safePath}(?:\\?[^"']*)?["']`, "i");
  return re.test(String(indexHtml || ""));
}

type AcceptanceReport = {
  blockers: string[];
  warnings: string[];
};

type SandboxSelfCheckResult = {
  blockers: string[];
  warnings: string[];
};

function pushUniqueIssue(list: string[], raw: string) {
  const msg = String(raw || "").trim();
  if (!msg) return;
  if (!list.includes(msg)) list.push(msg);
}

function formatSandboxValue(value: any): string {
  if (value == null) return String(value);
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return String(value);
}

type HtmlElementSeed = {
  tagName: string;
  id: string;
  classes: string[];
};

function parseHtmlElementSeeds(html: string): HtmlElementSeed[] {
  const seeds: HtmlElementSeed[] = [];
  const re = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html || "")))) {
    const tagName = String(m[1] || "").toLowerCase();
    if (!tagName || ["script", "style"].includes(tagName)) continue;
    const attrs = String(m[2] || "");
    const id = String(attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1] || "").trim();
    const classes = String(attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1] || "")
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
    seeds.push({ tagName, id, classes });
  }
  return seeds;
}

function createCanvasContextProxy(canvas: any) {
  let proxy: any = null;
  const fn = () => undefined;
  proxy = new Proxy(fn as any, {
    get(_target, prop) {
      if (prop === "canvas") return canvas;
      if (prop === Symbol.toPrimitive) return () => 0;
      return proxy;
    },
    apply() {
      return undefined;
    },
    set() {
      return true;
    },
  });
  return proxy;
}

async function runSandboxSelfCheck(indexHtml: string, jsCode: string): Promise<SandboxSelfCheckResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const seeds = parseHtmlElementSeeds(indexHtml);
  const byId = new Map<string, any>();
  const allElements: any[] = [];
  const classMap = new Map<string, any[]>();
  const scheduledTasks: Array<() => any> = [];
  const documentListeners = new Map<string, Function[]>();
  const windowListeners = new Map<string, Function[]>();
  const storageData = new Map<string, string>();
  let documentRef: any = null;
  let sandboxRef: any = null;

  const registerClass = (cls: string, el: any) => {
    const list = classMap.get(cls) || [];
    if (!list.includes(el)) list.push(el);
    classMap.set(cls, list);
  };

  const unregisterClasses = (el: any) => {
    for (const [cls, list] of classMap.entries()) {
      const next = list.filter((x) => x !== el);
      if (next.length) classMap.set(cls, next);
      else classMap.delete(cls);
    }
  };

  class FakeClassList {
    owner: any;
    valuesSet: Set<string>;
    constructor(owner: any, values: string[] = []) {
      this.owner = owner;
      this.valuesSet = new Set(values);
      this.sync();
    }
    private sync() {
      unregisterClasses(this.owner);
      const values = Array.from(this.valuesSet);
      this.owner.className = values.join(" ");
      for (const cls of values) registerClass(cls, this.owner);
    }
    add(...tokens: string[]) {
      for (const token of tokens) if (token) this.valuesSet.add(String(token));
      this.sync();
    }
    remove(...tokens: string[]) {
      for (const token of tokens) this.valuesSet.delete(String(token));
      this.sync();
    }
    contains(token: string) {
      return this.valuesSet.has(String(token));
    }
    toggle(token: string, force?: boolean) {
      const key = String(token);
      if (force === true) this.valuesSet.add(key);
      else if (force === false) this.valuesSet.delete(key);
      else if (this.valuesSet.has(key)) this.valuesSet.delete(key);
      else this.valuesSet.add(key);
      this.sync();
      return this.valuesSet.has(key);
    }
    values() {
      return Array.from(this.valuesSet);
    }
    toString() {
      return Array.from(this.valuesSet).join(" ");
    }
  }

  const makeNodeList = (list: any[]) => {
    const arr = list.slice();
    (arr as any).item = (i: number) => arr[i] || null;
    return arr as any;
  };

  const queueTask = (fn: any) => {
    if (typeof fn === "function" && scheduledTasks.length < 48) scheduledTasks.push(fn);
    return scheduledTasks.length;
  };

  const invokeHandlers = async (handlers: Function[], thisArg: any, event: any) => {
    for (const handler of handlers) {
      try {
        const res = handler.call(thisArg, event);
        if (res && typeof (res as any).then === "function") await res;
      } catch (e: any) {
        pushUniqueIssue(blockers, `沙盒自检运行报错：${formatSandboxValue(e?.message || e).slice(0, 220)}`);
      }
    }
  };

  const queryElements = (selector: string) => {
    const raw = String(selector || "").trim();
    if (!raw) return [];
    const selectors = raw.split(",").map((x) => x.trim()).filter(Boolean);
    const out: any[] = [];
    for (const sel of selectors) {
      if (sel === "body" && documentRef?.body) {
        out.push(documentRef.body);
        continue;
      }
      if ((sel === "html" || sel === ":root") && documentRef?.documentElement) {
        out.push(documentRef.documentElement);
        continue;
      }
      if (sel.startsWith("#")) {
        const hit = byId.get(sel.slice(1));
        if (hit) out.push(hit);
        continue;
      }
      if (sel.startsWith(".")) {
        for (const hit of classMap.get(sel.slice(1)) || []) if (!out.includes(hit)) out.push(hit);
        continue;
      }
      const lower = sel.toLowerCase();
      for (const el of allElements) {
        if (String(el.tagName || "").toLowerCase() === lower && !out.includes(el)) out.push(el);
      }
    }
    return out;
  };

  class FakeElement {
    id: string;
    tagName: string;
    className = "";
    classList: FakeClassList;
    style: Record<string, any>;
    dataset: Record<string, string>;
    children: any[];
    parentNode: any;
    ownerDocument: any;
    eventListeners: Map<string, Function[]>;
    hidden: boolean;
    disabled: boolean;
    value: string;
    textContent: string;
    innerHTML: string;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    attributes: Map<string, string>;
    constructor(tagName: string, id = "", classes: string[] = []) {
      this.id = id;
      this.tagName = String(tagName || "div").toUpperCase();
      this.style = new Proxy<Record<string, any>>({}, {
        get(target, prop: string) {
          return prop in target ? target[prop] : "";
        },
        set(target, prop: string, value) {
          target[prop] = value;
          return true;
        },
      });
      this.dataset = {};
      this.children = [];
      this.parentNode = null;
      this.ownerDocument = null;
      this.eventListeners = new Map();
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.textContent = "";
      this.innerHTML = "";
      this.width = 320;
      this.height = 180;
      this.clientWidth = 320;
      this.clientHeight = 180;
      this.attributes = new Map();
      this.classList = new FakeClassList(this, classes);
    }
    addEventListener(type: string, handler: any) {
      const key = String(type || "");
      const arr = this.eventListeners.get(key) || [];
      if (typeof handler === "function") arr.push(handler);
      this.eventListeners.set(key, arr);
    }
    removeEventListener(type: string, handler: any) {
      const key = String(type || "");
      const arr = (this.eventListeners.get(key) || []).filter((fn) => fn !== handler);
      this.eventListeners.set(key, arr);
    }
    dispatchEvent(evt: any) {
      const event = evt && typeof evt === "object" ? evt : { type: String(evt || "") };
      event.target = event.target || this;
      event.currentTarget = this;
      event.preventDefault = event.preventDefault || (() => undefined);
      event.stopPropagation = event.stopPropagation || (() => undefined);
      const handlers = this.eventListeners.get(String(event.type || "")) || [];
      void invokeHandlers(handlers, this, event);
      const inlineHandler = (this as any)[`on${String(event.type || "")}`];
      if (typeof inlineHandler === "function") void invokeHandlers([inlineHandler], this, event);
      return true;
    }
    click() {
      this.dispatchEvent({ type: "click" });
    }
    focus() {}
    blur() {}
    appendChild(child: any) {
      if (child && typeof child === "object") {
        child.parentNode = this;
        child.ownerDocument = documentRef;
        this.children.push(child);
        if (!allElements.includes(child)) allElements.push(child);
        if (child.id) byId.set(child.id, child);
      }
      return child;
    }
    removeChild(child: any) {
      this.children = this.children.filter((x) => x !== child);
      return child;
    }
    setAttribute(name: string, value: any) {
      const key = String(name || "");
      const text = String(value ?? "");
      this.attributes.set(key, text);
      if (key === "id") {
        this.id = text;
        byId.set(text, this);
      } else if (key === "class") {
        this.classList = new FakeClassList(this, text.split(/\s+/).filter(Boolean));
      } else if (key.startsWith("data-")) {
        const dataKey = key
          .slice(5)
          .replace(/-([a-z])/g, (_m, c) => String(c || "").toUpperCase());
        this.dataset[dataKey] = text;
      }
    }
    getAttribute(name: string) {
      const key = String(name || "");
      if (key === "id") return this.id || null;
      if (key === "class") return this.className || null;
      return this.attributes.get(key) || null;
    }
    querySelector(selector: string) {
      return queryElements(selector)[0] || null;
    }
    querySelectorAll(selector: string) {
      return makeNodeList(queryElements(selector));
    }
    getContext() {
      return createCanvasContextProxy(this);
    }
    getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: this.clientWidth,
        bottom: this.clientHeight,
        width: this.clientWidth,
        height: this.clientHeight,
      };
    }
  }

  const bodyEl = new FakeElement("body");
  const headEl = new FakeElement("head");
  const htmlEl = new FakeElement("html");
  allElements.push(htmlEl, headEl, bodyEl);

  documentRef = {
    readyState: "loading",
    body: bodyEl,
    head: headEl,
    documentElement: htmlEl,
    createElement(tag: string) {
      const el = new FakeElement(tag);
      el.ownerDocument = documentRef;
      allElements.push(el);
      return el;
    },
    createTextNode(text: string) {
      return { nodeType: 3, textContent: String(text || "") };
    },
    getElementById(id: string) {
      return byId.get(String(id || "")) || null;
    },
    querySelector(selector: string) {
      return queryElements(selector)[0] || null;
    },
    querySelectorAll(selector: string) {
      return makeNodeList(queryElements(selector));
    },
    addEventListener(type: string, handler: any) {
      const key = String(type || "");
      const arr = documentListeners.get(key) || [];
      if (typeof handler === "function") arr.push(handler);
      documentListeners.set(key, arr);
    },
    removeEventListener(type: string, handler: any) {
      const key = String(type || "");
      const arr = (documentListeners.get(key) || []).filter((fn) => fn !== handler);
      documentListeners.set(key, arr);
    },
    dispatchEvent(event: any) {
      const handlers = documentListeners.get(String(event?.type || "")) || [];
      void invokeHandlers(handlers, documentRef, event);
      return true;
    },
  };
  bodyEl.ownerDocument = documentRef;
  headEl.ownerDocument = documentRef;
  htmlEl.ownerDocument = documentRef;
  htmlEl.appendChild(headEl);
  htmlEl.appendChild(bodyEl);

  for (const seed of seeds) {
    if (seed.tagName === "html" || seed.tagName === "head" || seed.tagName === "body") continue;
    const el = new FakeElement(seed.tagName, seed.id, seed.classes);
    el.ownerDocument = documentRef;
    allElements.push(el);
    if (seed.id) byId.set(seed.id, el);
  }

  const createStorage = () => ({
    getItem(key: string) {
      return storageData.has(String(key || "")) ? storageData.get(String(key || "")) || "" : null;
    },
    setItem(key: string, value: any) {
      storageData.set(String(key || ""), String(value ?? ""));
    },
    removeItem(key: string) {
      storageData.delete(String(key || ""));
    },
    clear() {
      storageData.clear();
    },
  });

  class SandboxEvent {
    type: string;
    detail: any;
    target: any;
    currentTarget: any;
    constructor(type: string, init?: any) {
      this.type = String(type || "");
      this.detail = init?.detail;
      this.target = null;
      this.currentTarget = null;
    }
    preventDefault() {}
    stopPropagation() {}
  }

  const consoleProxy = {
    log() {},
    info() {},
    debug() {},
    warn: (...args: any[]) => pushUniqueIssue(warnings, `沙盒 console.warn：${args.map(formatSandboxValue).join(" ").slice(0, 220)}`),
    error: (...args: any[]) => pushUniqueIssue(blockers, `沙盒 console.error：${args.map(formatSandboxValue).join(" ").slice(0, 220)}`),
  };

  sandboxRef = {
    console: consoleProxy,
    document: documentRef,
    navigator: {
      userAgent: "codex-sandbox",
      mediaDevices: {
        async getUserMedia() {
          return {
            getTracks: () => [{ stop() {} }],
          };
        },
      },
    },
    location: { href: "http://localhost/", origin: "http://localhost", pathname: "/", search: "", hash: "" },
    history: { pushState() {}, replaceState() {} },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 2,
    performance: { now: () => 0 },
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      };
    },
    requestAnimationFrame(fn: any) {
      return queueTask(() => (typeof fn === "function" ? fn(16) : undefined));
    },
    cancelAnimationFrame() {},
    setTimeout(fn: any) {
      return queueTask(fn);
    },
    clearTimeout() {},
    setInterval(fn: any) {
      return queueTask(fn);
    },
    clearInterval() {},
    queueMicrotask(fn: any) {
      queueTask(fn);
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      async text() {
        return "";
      },
      async json() {
        return {};
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    }),
    SpeechSynthesisUtterance: function (this: any, text = "") {
      this.text = text;
      this.lang = "";
      this.rate = 1;
    },
    speechSynthesis: {
      speak() {},
      cancel() {},
      pause() {},
      resume() {},
    },
    MediaRecorder: class {
      ondataavailable: ((evt: any) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        if (typeof this.onstop === "function") this.onstop();
      }
    },
    Audio: function (this: any) {
      this.currentTime = 0;
      this.src = "";
      this.play = async () => undefined;
      this.pause = () => undefined;
      this.addEventListener = () => undefined;
      this.removeEventListener = () => undefined;
    },
    Image: function () {
      return new FakeElement("img");
    },
    URL: {
      createObjectURL() {
        return "blob:codex-sandbox";
      },
      revokeObjectURL() {},
    },
    Event: SandboxEvent,
    CustomEvent: SandboxEvent,
    KeyboardEvent: SandboxEvent,
    MouseEvent: SandboxEvent,
    HTMLElement: FakeElement,
    HTMLCanvasElement: FakeElement,
    Node: FakeElement,
    alert() {},
    confirm() {
      return true;
    },
    prompt() {
      return "";
    },
    addEventListener(type: string, handler: any) {
      const key = String(type || "");
      const arr = windowListeners.get(key) || [];
      if (typeof handler === "function") arr.push(handler);
      windowListeners.set(key, arr);
    },
    removeEventListener(type: string, handler: any) {
      const key = String(type || "");
      const arr = (windowListeners.get(key) || []).filter((fn) => fn !== handler);
      windowListeners.set(key, arr);
    },
    dispatchEvent(event: any) {
      const handlers = windowListeners.get(String(event?.type || "")) || [];
      void invokeHandlers(handlers, sandboxRef, event);
      return true;
    },
  } as any;

  sandboxRef.window = sandboxRef;
  sandboxRef.self = sandboxRef;
  sandboxRef.globalThis = sandboxRef;
  documentRef.defaultView = sandboxRef;

  const runCode = async (code: string, filename: string) => {
    if (!String(code || "").trim()) return;
    try {
      const script = new Script(String(code || ""), { filename });
      script.runInNewContext(sandboxRef, { timeout: 800 });
      await Promise.resolve();
    } catch (e: any) {
      pushUniqueIssue(blockers, `沙盒自检运行报错：${filename} - ${formatSandboxValue(e?.message || e).slice(0, 220)}`);
    }
  };

  const flushScheduled = async (limit = 24) => {
    let count = 0;
    while (scheduledTasks.length && count < limit) {
      const task = scheduledTasks.shift();
      count += 1;
      if (typeof task === "function") {
        await invokeHandlers([task], sandboxRef, new SandboxEvent("task"));
        await Promise.resolve();
      }
    }
  };

  for (const [i, block] of collectInlineScriptBlocks(indexHtml).entries()) {
    await runCode(block, `index.inline.${i + 1}.js`);
  }
  if (String(jsCode || "").trim()) await runCode(jsCode, "game.js");

  documentRef.readyState = "interactive";
  await invokeHandlers(documentListeners.get("DOMContentLoaded") || [], documentRef, new SandboxEvent("DOMContentLoaded"));
  documentRef.readyState = "complete";
  if (typeof sandboxRef.onload === "function") {
    await invokeHandlers([sandboxRef.onload], sandboxRef, new SandboxEvent("load"));
  }
  await invokeHandlers(windowListeners.get("load") || [], sandboxRef, new SandboxEvent("load"));
  await invokeHandlers(documentListeners.get("load") || [], documentRef, new SandboxEvent("load"));
  await flushScheduled();

  return {
    blockers,
    warnings,
  };
}

async function buildAcceptanceReport(indexHtml: string, styleCss: string, jsCode: string): Promise<AcceptanceReport> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  blockers.push(...validateInlineScripts(indexHtml));
  const jsErr = validateStandaloneJsSyntax(jsCode);
  if (jsErr) blockers.push(`game.js 语法错误：${jsErr}`);
  if (String(styleCss || "").trim() && !hasExpectedAssetReference(indexHtml, "style.css", "href")) {
    blockers.push("index.html 未正确引用 ./style.css");
  }
  if (String(jsCode || "").trim() && !hasExpectedAssetReference(indexHtml, "game.js", "src")) {
    blockers.push("index.html 未正确引用 ./game.js");
  }
  warnings.push(...validateStructureContracts(indexHtml, jsCode));
  if (!blockers.length) {
    const sandbox = await runSandboxSelfCheck(indexHtml, jsCode);
    for (const msg of sandbox.blockers) pushUniqueIssue(blockers, msg);
    for (const msg of sandbox.warnings) pushUniqueIssue(warnings, msg);
  }
  return {
    blockers,
    warnings: warnings.filter((msg, idx) => warnings.indexOf(msg) === idx && !blockers.includes(msg)),
  };
}

function parseSectionBlocks(raw: string) {
  const text = String(raw || "")
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!text) return null;
  const re = /===\s*SECTION\s*:\s*([a-zA-Z0-9_-]+)\s*===\s*([\s\S]*?)\s*===\s*END\s*===/gi;
  const sections = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = String(m[1] || "").trim().toLowerCase();
    const content = String(m[2] || "").trim();
    if (name) sections.set(name, content);
  }
  if (!sections.size) return null;
  return sections;
}

function normalizeBlueprintKvKey(raw: string) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function parseKeyValueLines(raw: string) {
  const map = new Map<string, string>();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim().replace(/^[\-\*\u2022\d\.\)\s]+/, "");
    if (!t) continue;
    const m = t.match(/^([A-Za-z][A-Za-z0-9_\-\s]*)\s*[:=：]\s*(.+)$/u);
    if (!m) continue;
    map.set(normalizeBlueprintKvKey(m[1]), String(m[2] || "").trim());
  }
  return map;
}

function splitPipeList(raw: string) {
  return String(raw || "")
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitCommaList(raw: string) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseBlueprintSectionProtocol(
  sections: Map<string, string>,
  fallbackConfig: any,
  fallbackMeta: any,
) {
  const pick = (kv: Map<string, string>, ...keys: string[]) => {
    for (const key of keys) {
      const v = kv.get(normalizeBlueprintKvKey(key));
      if (String(v || "").trim()) return String(v || "").trim();
    }
    return "";
  };
  const metaKv = parseKeyValueLines(sections.get("meta") || "");
  const configKv = parseKeyValueLines(sections.get("config") || "");
  const protocolKv = parseKeyValueLines(sections.get("protocol") || "");
  const blueprintKv = parseKeyValueLines(sections.get("blueprint") || "");
  const assetsKv = parseKeyValueLines(sections.get("assetsplan") || sections.get("assetsPlan") || "");

  const title =
    pick(metaKv, "title", "gameTitle", "name", "gameName", "titleText") ||
    String((fallbackMeta as any)?.title || "").trim() ||
    "我的小游戏";

  const meta = safeMeta({
    title,
    shortDesc:
      pick(metaKv, "shortDesc", "desc", "description", "summary") ||
      String((fallbackMeta as any)?.shortDesc || "").trim(),
    rules: pick(metaKv, "rules", "rule", "gameRules", "gameplayRules") || String((fallbackMeta as any)?.rules || "").trim(),
    creator: { name: pick(metaKv, "creatorName", "creator", "author") || String((fallbackMeta as any)?.creator?.name || "Architect").trim() },
  });

  const nextConfig = {
    ...(fallbackConfig && typeof fallbackConfig === "object" ? fallbackConfig : {}),
    platform: pick(configKv, "platform", "device", "platformType") || String((fallbackConfig as any)?.platform || "both").trim() || "both",
    style: {
      ...(((fallbackConfig as any)?.style && typeof (fallbackConfig as any).style === "object") ? (fallbackConfig as any).style : {}),
      theme: pick(configKv, "theme", "style", "visualStyle") || String((fallbackConfig as any)?.style?.theme || "卡通").trim() || "卡通",
      colors: {
        bg:
          pick(configKv, "bg", "bgColor", "background", "backgroundColor") ||
          String((fallbackConfig as any)?.style?.colors?.bg || "#f8fafc").trim() ||
          "#f8fafc",
        accent:
          pick(configKv, "accent", "accentColor", "primary", "primaryColor") ||
          String((fallbackConfig as any)?.style?.colors?.accent || "#2563eb").trim() ||
          "#2563eb",
      },
    },
    ui: {
      ...(((fallbackConfig as any)?.ui && typeof (fallbackConfig as any).ui === "object") ? (fallbackConfig as any).ui : {}),
      texts: {
        start: pick(configKv, "startText", "start", "startLabel", "btnStartText") || String((fallbackConfig as any)?.ui?.texts?.start || "开始").trim() || "开始",
        restart:
          pick(configKv, "restartText", "restart", "restartLabel", "replayText", "btnRestartText") ||
          String((fallbackConfig as any)?.ui?.texts?.restart || "重开").trim() ||
          "重开",
      },
    },
  };

  const protocol = {
    dom: {
      rootId: pick(protocolKv, "rootId", "root", "rootID") || "app",
      canvasId: pick(protocolKv, "canvasId", "canvas", "canvasID") || "game",
      btnStartId: pick(protocolKv, "btnStartId", "startBtnId", "startButtonId") || "btnStart",
      btnRestartId: pick(protocolKv, "btnRestartId", "restartBtnId", "restartButtonId") || "btnRestart",
      btnLeftId: pick(protocolKv, "btnLeftId", "leftBtnId", "leftButtonId") || "btnLeft",
    },
    state: {
      name: pick(protocolKv, "stateName", "state", "storeName") || "G",
      vars: splitCommaList(pick(protocolKv, "stateVars", "vars", "stateFields") || "level,score,state,speed,autoCenter"),
    },
  };

  const blueprint = {
    type: pick(blueprintKv, "type", "gameType", "template") || "C",
    coreLoop: pick(blueprintKv, "coreLoop", "loop", "gameLoop"),
    steps: splitPipeList(pick(blueprintKv, "steps", "flow", "sequence") || "开始 | 游玩 | 结束"),
    winLose: pick(blueprintKv, "winLose", "winCondition", "loseCondition", "outcome"),
  };

  const assetsPlan = {
    renderer: pick(assetsKv, "renderer", "render", "mode") || "dom",
    sprites: splitCommaList(pick(assetsKv, "sprites", "elements", "items")),
  };

  return { meta, config: nextConfig, protocol, blueprint, assetsPlan };
}

function safeMeta(meta: any) {
  const m = meta && typeof meta === "object" ? meta : {};
  const creator = m.creator && typeof m.creator === "object" ? m.creator : {};
  return {
    title: String(m.title || "").trim().slice(0, 80),
    shortDesc: String(m.shortDesc || "").trim().slice(0, 120),
    rules: String(m.rules || "").trim().slice(0, 600),
    creator: { name: String(creator.name || "").trim().slice(0, 24) },
  };
}

function normalizeGameTitle(raw: string) {
  return String(raw || "")
    .replace(/\r/g, " ")
    .split("\n")[0]
    .replace(/^["'“”《〈【\[]+|["'“”》〉】\]]+$/g, "")
    .replace(/^(title|标题)\s*[:：]\s*/i, "")
    .trim()
    .slice(0, 80);
}

function isPlaceholderGameTitle(raw: string) {
  const title = normalizeGameTitle(raw);
  return !title || /^(我的小游戏|未命名作品|未命名游戏|小游戏|游戏)$/i.test(title);
}

function deriveGameTitleFromPrompt(prompt: string) {
  const text = String(prompt || "").replace(/\r/g, "").trim();
  if (!text) return "";
  const m1 = text.match(/(?:我想|想)?做(?:一个|个|一款)?\s*([^\n，。,.]{2,24}?)(?:小游戏|游戏|h5)/);
  const m2 = text.match(/([^\n，。,.]{2,24}?)(?:小游戏|游戏)/);
  let picked = String(m1?.[1] || m2?.[1] || "").trim();
  if (!picked) {
    picked =
      text
        .split("\n")
        .map((x) => x.trim())
        .find((x) => x && !x.startsWith("#")) || "";
  }
  picked = picked.replace(/^(一个|个|一款|做|生成|创建|写)\s*/g, "").replace(/（.*?）/g, "").trim();
  if (!picked) return "";
  if (picked.length > 18) picked = picked.slice(0, 18).trim();
  if (!/(挑战|闯关|冒险|练习|训练|课堂|大作战|之旅|派对|工坊|乐园|任务|冲刺|计划|游戏)$/u.test(picked)) {
    if (/(口语|英语|单词|词汇|听力|跟读)/.test(picked)) picked += "挑战";
    else if (/(数学|口算|算术|加减|乘除)/.test(picked)) picked += "训练营";
    else picked += "游戏";
  }
  return normalizeGameTitle(picked);
}

function pickLockedGameTitle(metaObj: any, draftTitle: string) {
  const gen = metaObj?._gen && typeof metaObj._gen === "object" ? metaObj._gen : {};
  const hasFixedTitle = !isPlaceholderGameTitle(String(gen.fixedTitle || ""));
  const allowMetaTitle = hasFixedTitle || (!String(gen.titleCandidate || "").trim() && String(gen.stage || "").trim() !== "clarify");
  const candidates = [String(gen.fixedTitle || "")];
  if (allowMetaTitle) candidates.push(String(metaObj?.title || ""));
  candidates.push(String(draftTitle || ""));
  for (const item of candidates) {
    const title = normalizeGameTitle(item);
    if (!isPlaceholderGameTitle(title)) return title;
  }
  return "";
}

function applyLockedGameTitle(metaObj: any, options: { preferredTitle?: string; fallbackPrompt?: string; draftTitle?: string; source?: string }) {
  const base = metaObj && typeof metaObj === "object" ? { ...metaObj } : {};
  const creator = base.creator && typeof base.creator === "object" ? { ...base.creator } : {};
  const gen = base._gen && typeof base._gen === "object" ? { ...base._gen } : {};
  const lockedTitle = pickLockedGameTitle(base, options.draftTitle || "");
  const nextTitle =
    lockedTitle ||
    normalizeGameTitle(options.preferredTitle || "") ||
    deriveGameTitleFromPrompt(options.fallbackPrompt || "") ||
    "我的小游戏";
  const titleSource = String(gen.titleSource || options.source || (lockedTitle ? "existing" : "blueprint")).trim() || "blueprint";
  return {
    ...base,
    title: nextTitle,
    shortDesc: String(base.shortDesc || "").trim().slice(0, 120),
    rules: String(base.rules || "").trim().slice(0, 600),
    creator: {
      ...creator,
      name: String(creator.name || "Architect").trim().slice(0, 24) || "Architect",
    },
    _gen: {
      ...gen,
      fixedTitle: nextTitle,
      titleLockedAt: Number(gen.titleLockedAt) > 0 ? Number(gen.titleLockedAt) : Date.now(),
      titleSource,
    },
  };
}

function normalizePlannerTasks(tasks: any) {
  const allow = new Set(["index.html", "style.css", "game.js", "prompt.md"]);
  const arr = Array.isArray(tasks) ? tasks : [];
  const out: Array<{ path: string; instruction: string }> = [];
  for (const t of arr) {
    const p = String(t?.path || "").trim();
    if (!allow.has(p)) continue;
    const ins = String(t?.instruction || "").trim().slice(0, 2000);
    if (!ins) continue;
    out.push({ path: p, instruction: ins });
  }
  const order = ["index.html", "style.css", "game.js", "prompt.md"];
  out.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
  const has = new Set(out.map((x) => x.path));
  for (const p of order) {
    if (!has.has(p)) out.push({ path: p, instruction: `请生成 ${p}（最小可运行版本，避免输出过长）。` });
  }
  return out;
}

type TemplateProfile = {
  id: string;
  label: string;
  hint: string;
};

type RequirementContract = {
  topic: string;
  gameplay: string;
  platform: string;
  templateId: string;
  templateLabel: string;
  theme: string;
  keyUi: string[];
  mustHave: string[];
  forbidden: string[];
  complexity: "simple" | "complex";
};

function pickTemplateProfile(text: string): TemplateProfile {
  const t = String(text || "").toLowerCase();
  if (/(英语|英文|单词|词汇|拼写|口语|听力|跟读|quiz|word|vocab|spell|memory card)/i.test(t)) {
    return {
      id: "quiz_words",
      label: "问答闯关模板",
      hint:
        "优先采用“题目卡片 + 选项按钮/输入区 + 进度条 + 连对/生命值”的成熟结构。每回合只做一件事，反馈要立刻、清楚、鼓励式。",
    };
  }
  if (/(打地鼠|whack|点击目标|反应|手速|点点点|敲)/i.test(t)) {
    return {
      id: "whack_reaction",
      label: "反应点击模板",
      hint:
        "优先采用“目标出现 -> 点击得分 -> 倒计时结束”的成熟结构。目标数量、出现节奏、得分反馈要清晰，按钮和点击区域要偏大，适合触屏。",
    };
  }
  if (/(跑酷|躲避|避开|障碍|小球|跳跃|runner|dodge|接物|吃豆|snake|贪吃蛇)/i.test(t)) {
    return {
      id: "dodge_runner",
      label: "动作躲避模板",
      hint:
        "优先采用“开始页 -> 游戏中 -> 结束页”的连续动作结构。核心循环要简单：移动、碰撞、得分、重开；先保证手感和碰撞反馈，再考虑花哨效果。",
    };
  }
  if (/(井字棋|五子棋|象棋|国际象棋|棋|对战|回合制|落子)/i.test(t)) {
    return {
      id: "board_turn_based",
      label: "棋盘回合模板",
      hint:
        "优先采用“棋盘格 + 当前回合提示 + 合法落子 + 胜负检测”的成熟结构。规则显示清楚，状态切换稳定，回合与重开逻辑优先保证正确。",
    };
  }
  if (/(记忆|翻牌|配对|match|memory|消消乐|连连看)/i.test(t)) {
    return {
      id: "memory_match",
      label: "配对记忆模板",
      hint:
        "优先采用“翻开两张 -> 判定匹配 -> 全部完成过关”的成熟结构。动画轻一点，翻牌锁定逻辑清楚，避免一次放太多特殊规则。",
    };
  }
  return {
    id: "generic_arcade",
    label: "通用轻量模板",
    hint:
      "优先采用一个主玩法循环、一个核心操作、一个明确结束条件的轻量结构。先做出可玩的闭环，不要同时堆太多系统。",
  };
}

function buildTemplateHintBlock(seedPrompt: string, latestPrompt: string, answers: any) {
  const summary = [seedPrompt, latestPrompt, JSON.stringify(answers || {})].filter(Boolean).join("\n");
  const profile = pickTemplateProfile(summary);
  return (
    `【优先模板】\n` +
    `- 模板ID：${profile.id}\n` +
    `- 模板名称：${profile.label}\n` +
    `- 模板提示：${profile.hint}\n` +
    `- 规则：优先复用这类成熟结构，不要每次从零发明页面层级、状态切换和输入系统；但如果与用户要求冲突，以用户要求为准。\n`
  );
}

function normalizeChecklistItems(items: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const t = String(raw || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 12);
}

function inferRequirementMustHaves(seedPrompt: string, latestPrompt: string, design: any) {
  const text = [seedPrompt, latestPrompt, JSON.stringify(design || {})].filter(Boolean).join("\n");
  const items: string[] = [];
  if (/(tts|朗读|跟读|speechsynthesis|语音朗读)/i.test(text)) items.push("支持示范朗读/TTS");
  if (/(录音|麦克风|mediarecorder|录制)/i.test(text)) items.push("支持录音");
  if (/(评分|打分|score|85分|>=\s*85|大于85)/i.test(text)) items.push("有明确评分判定");
  if (/(进度|存档|记住|继续学习|恢复|localstorage)/i.test(text)) items.push("保存并恢复学习进度");
  if (/(当前句子|句子|题目|题干|文案同步|显示句子)/i.test(text)) items.push("显示当前句子/题目并随进度同步");
  if (/(开始|开始按钮|自动开始|直接开始)/i.test(text)) items.push("有清晰的开始入口或自动开始规则");
  if (/(重开|重新开始|restart)/i.test(text)) items.push("支持重开/重新开始");
  if (/(进度条|progress)/i.test(text)) items.push("显示进度信息");
  if (/(得分|分数)/i.test(text)) items.push("显示分数或结果反馈");
  const steps = Array.isArray((design as any)?.blueprint?.steps) ? (design as any).blueprint.steps : [];
  if (steps.length) items.push(`玩法流程保持为：${steps.slice(0, 3).join(" -> ")}`);
  const winLose = String((design as any)?.blueprint?.winLose || "").trim();
  if (winLose) items.push(`胜负规则：${winLose}`);
  return normalizeChecklistItems(items);
}

function inferRequirementForbidden(seedPrompt: string, latestPrompt: string, design: any) {
  const items = [
    "不要引入外部库或 CDN 依赖",
    "不要修改蓝图约定的 DOM id、关键状态名和 hooks 命名",
    "不要把业务逻辑塞进 index.html 内联脚本",
    "不要注入 data-ai-local-behavior 或轮询式兜底脚本",
  ];
  const renderer = String((design as any)?.assetsPlan?.renderer || "").trim();
  if (renderer === "canvas") items.push("不要把 canvas 游戏重写成纯 DOM 玩法");
  return normalizeChecklistItems(items);
}

function inferRequirementKeyUi(design: any) {
  const protocolDom = ((design as any)?.protocol?.dom && typeof (design as any).protocol.dom === "object")
    ? (design as any).protocol.dom
    : {};
  const ids = [
    protocolDom.rootId,
    protocolDom.canvasId,
    protocolDom.btnStartId,
    protocolDom.btnRestartId,
    protocolDom.btnLeftId,
  ]
    .map((x: any) => String(x || "").trim())
    .filter(Boolean);
  return normalizeChecklistItems(ids);
}

function shouldUseTwoStepGameJs(profile: TemplateProfile, contract: RequirementContract, seedPrompt: string, latestPrompt: string) {
  if (contract.complexity === "complex") return true;
  const text = [seedPrompt, latestPrompt, contract.gameplay, ...contract.mustHave].join("\n");
  if (/(录音|麦克风|tts|朗读|评分|进度|存档|恢复|状态|screen|hook|gamehooks)/i.test(text)) return true;
  return ["quiz_words", "board_turn_based"].includes(profile.id);
}

function buildRequirementContract(
  seedPrompt: string,
  latestPrompt: string,
  answers: any,
  design: any,
): RequirementContract {
  const summary = [seedPrompt, latestPrompt, JSON.stringify(answers || {}), JSON.stringify(design || {})].filter(Boolean).join("\n");
  const profile = pickTemplateProfile(summary);
  const gameplay =
    String((design as any)?.blueprint?.coreLoop || "").trim() ||
    String((design as any)?.meta?.shortDesc || "").trim() ||
    String(seedPrompt || latestPrompt || "").trim();
  const mustHave = inferRequirementMustHaves(seedPrompt, latestPrompt, design);
  const forbidden = inferRequirementForbidden(seedPrompt, latestPrompt, design);
  const complexity: "simple" | "complex" =
    /(录音|麦克风|tts|朗读|评分|进度|存档|恢复|状态|screen|hook|gamehooks|下一句|关卡|回合)/i.test(
      [seedPrompt, latestPrompt, gameplay, mustHave.join("\n")].join("\n"),
    ) || ["quiz_words", "board_turn_based"].includes(profile.id)
      ? "complex"
      : "simple";
  return {
    topic: String((design as any)?.meta?.title || seedPrompt || latestPrompt || "我的小游戏").trim(),
    gameplay,
    platform: String((design as any)?.config?.platform || "both").trim() || "both",
    templateId: profile.id,
    templateLabel: profile.label,
    theme: String((design as any)?.config?.style?.theme || "卡通").trim() || "卡通",
    keyUi: inferRequirementKeyUi(design),
    mustHave,
    forbidden,
    complexity,
  };
}

function formatRequirementContractBlock(contract: RequirementContract | null | undefined) {
  const c = contract && typeof contract === "object" ? contract : null;
  if (!c) return "";
  return (
    `【需求契约（必须严格遵守）】\n` +
    `${JSON.stringify(
      {
        topic: c.topic,
        gameplay: c.gameplay,
        platform: c.platform,
        templateId: c.templateId,
        templateLabel: c.templateLabel,
        theme: c.theme,
        keyUi: c.keyUi,
        complexity: c.complexity,
      },
      null,
      2,
    )}\n\n` +
    `【must-have 清单】\n${c.mustHave.map((x) => `- ${x}`).join("\n") || "- （无）"}\n\n` +
    `【禁忌项】\n${c.forbidden.map((x) => `- ${x}`).join("\n") || "- （无）"}\n\n`
  );
}

function buildStyleConsistencyBlock(indexHtml: string, styleCss: string, design: any) {
  const html = String(indexHtml || "");
  const css = String(styleCss || "");
  const theme = String((design as any)?.config?.style?.theme || "").trim();
  const colors = Array.from(new Set((css.match(/#[0-9a-fA-F]{3,8}/g) || []).map((x) => x.toLowerCase()))).slice(0, 8);
  const styleSignals: string[] = [];
  if (/border-radius\s*:/i.test(css)) styleSignals.push("保留圆角组件风格");
  if (/box-shadow\s*:/i.test(css)) styleSignals.push("保留卡片阴影层次");
  if (/linear-gradient\s*\(/i.test(css)) styleSignals.push("保留渐变背景基调");
  if (/transition\s*:/i.test(css) || /animation\s*:/i.test(css)) styleSignals.push("保留现有动效节奏");
  if (/\bid\s*=\s*["'](?:startScreen|gameScreen|endScreen|app)["']/i.test(html)) {
    styleSignals.push("保留当前页面分区与信息密度");
  }
  const lines = [
    `- 视觉主题：${theme || "沿用当前页面风格，不要改成另一套设计语言"}`,
    `- 颜色锚点：${colors.length ? colors.join(", ") : "沿用现有主色、背景色和强调色"}`,
    `- 风格特征：${styleSignals.length ? styleSignals.join("；") : "保持当前布局和组件形态"}`,
    "- 只在满足这次需求的必要范围内调整视觉，不要重做整体 UI。",
  ];
  return `【原有风格约束（必须保持）】\n${lines.join("\n")}\n\n`;
}

function describeClarifyChoice(choice: string) {
  const c = String(choice || "").trim().toUpperCase();
  if (!c) return "（未选方案）";
  if (c === "OTHER") return "自定义方向";
  return `方案${c}`;
}

function buildClarifyUiOptions(options: any[]) {
  const base = (Array.isArray(options) ? options : []).slice(0, 3).map((o: any) => ({
    id: String(o?.id || "").trim() || "",
    label: String(o?.title || "").trim() || String(o?.id || "").trim() || "方案",
    desc: String(o?.notes || "").trim() || String(o?.style || "").trim() || "",
    payload: `@choice ${String(o?.id || "").trim() || "A"}`,
  }));
  base.push({
    id: "OTHER",
    label: "这三个都不想选",
    desc: "按你自己的想法继续说",
    payload: "@choice OTHER",
  });
  return base;
}

type IncrementalEditProfile = {
  kind: "content" | "layout" | "visual" | "behavior" | "bugfix" | "feature";
  confidence: number;
  hint: string;
};

function classifyIncrementalEdit(text: string): IncrementalEditProfile | null {
  const t = String(text || "").trim();
  if (!t) return null;
  // 明显是“新建/从零做一个游戏”的表达：不要走小改动链
  if (/^(做|生成|创建|写|帮我做一个|给我做一个|我想做|我想做一个|想做|想做一个|新建|新建一个|创建一个|创建一个新|做一个新)/.test(t)) return null;
  const giantFeatureSignals =
    /(从头|重做|重新做|整个游戏|完全重写|做一个新|换成另一个游戏|新增一个模式|加入排行榜系统|联机|多人|存档|关卡编辑器)/i.test(t);
  if (giantFeatureSignals || t.length > 160) return null;

  if (/(bug|报错|错误|异常|崩溃|无法|不显示|不生效|没反应|白屏|卡住|修复|修一下|修一修)/i.test(t)) {
    return {
      kind: "bugfix",
      confidence: 0.95,
      hint: "优先定位并修复当前行为问题，不改主题，不新增无关功能。",
    };
  }
  if (looksLikeCoupledContentIntent(t)) {
    return {
      kind: /(顺序|摆放|位置|布局|居中|左对齐|右对齐|左右|上下|底部|顶部)/i.test(t) ? "layout" : "behavior",
      confidence: 0.93,
      hint: "这句话表面像改文案或按钮，实际牵涉页面结构、事件或状态流。优先联动相关文件一起改，不要走纯补丁。",
    };
  }
  if (/(去掉|删除|隐藏|显示|保留|按钮|标题|文案|文字|提示语|开始游戏|重新开始|得分文案|分数文案)/i.test(t)) {
    return {
      kind: "content",
      confidence: 0.92,
      hint: "这是界面文案或显隐层的小改动。优先保留结构，只改文字、按钮、显示状态和少量关联逻辑。",
    };
  }
  if (/(挪到|移到|放到|放在|居中|左对齐|右对齐|排列|布局|位置|浮到|置顶|底部|右上角|左上角|中间)/i.test(t)) {
    return {
      kind: "layout",
      confidence: 0.9,
      hint: "这是布局调整。优先改 HTML 结构和 CSS 布局，不碰核心玩法逻辑。",
    };
  }
  if (/(颜色|字体|圆角|阴影|背景|主题色|样式|美化|更好看|更精致|动画|动效|图标|边框|透明度)/i.test(t)) {
    return {
      kind: "visual",
      confidence: 0.88,
      hint: "这是视觉优化。优先改样式和少量交互反馈，不重写玩法流程。",
    };
  }
  if (/(更快|更慢|速度|难度|灵敏|手感|碰撞|倒计时|分数|得分|判定|自动开始|直接开始|跳过|去掉开始页|重开逻辑)/i.test(t)) {
    return {
      kind: "behavior",
      confidence: 0.86,
      hint: "这是玩法行为微调。优先只改相关状态流转、参数和事件，不改整体结构。",
    };
  }
  if (/(增加|加上|新增|加入|再来一个|支持|加个|多个|增加一个按钮|增加一个开关)/i.test(t)) {
    return {
      kind: "feature",
      confidence: 0.8,
      hint: "这是小功能增强。优先在现有结构上增量添加，不要重做全局架构。",
    };
  }
  if (/(优化|调整|修改|改成|改为|换成|换成更|完善|增强|不要|只要)/i.test(t)) {
    return {
      kind: "content",
      confidence: 0.65,
      hint: "这是泛化的小改动请求。优先最小修改，只动和用户这句话直接相关的部分。",
    };
  }
  return null;
}

function looksLikeIncrementalEdit(text: string) {
  return !!classifyIncrementalEdit(text);
}

function isSentenceLikeEditIntent(text: string) {
  return /(sentence|sentences|句子|当前句子|当前文本|台词|文案|题目|题干|字幕|提示语|显示句子|显示文本)/i.test(
    String(text || ""),
  );
}

function looksLikePureCopyOrVisibilityEdit(userIntent = "") {
  const intent = String(userIntent || "");
  if (!/(去掉|删除|隐藏|显示|保留|标题|文案|文字|提示语|按钮文案|按钮文字|简介|规则|副标题|待发布|占位|占位文案)/i.test(intent)) {
    return false;
  }
  return !/(点击|顺序|摆放|位置|布局|左右|上下|移动|跳|自动开始|直接开始|开始页|当前句子|进度|状态|流程|初始化|事件|绑定|ai|bot|opponent|玩家|对战|敌人|回合|逻辑|判定|碰撞|速度|难度|倒计时)/i.test(
    intent,
  );
}

function looksLikeIsolatedStyleEdit(userIntent = "") {
  const intent = String(userIntent || "");
  if (!/(颜色|字体|圆角|阴影|背景|主题色|样式|美化|更好看|更精致|动画|动效|图标|边框|透明度)/i.test(intent)) {
    return false;
  }
  return !/(按钮|点击|顺序|摆放|位置|布局|左右|上下|移动|跳|开始页|当前句子|进度|状态|流程|初始化|事件|绑定|ai|bot|opponent|玩家|对战|敌人|回合|逻辑|判定)/i.test(
    intent,
  );
}

function looksLikeCoupledContentIntent(userIntent = "") {
  const intent = String(userIntent || "");
  return /(按钮|标题|文案|文字|提示语|开始游戏|重新开始|得分文案|分数文案|去掉|删除|隐藏|显示|保留)/i.test(intent) &&
    /(点击|顺序|摆放|位置|布局|左右|上下|移动|跳|自动开始|直接开始|开始页|当前句子|进度|状态|流程|初始化|事件|绑定|ai|bot|opponent|玩家|对战|敌人|回合|逻辑|判定|碰撞|速度|难度|倒计时)/i.test(
      intent,
    );
}

function looksLikeStarterDraft(indexHtml: string, styleCss: string, gameJs: string) {
  const html = String(indexHtml || "");
  const css = String(styleCss || "");
  const js = String(gameJs || "");
  if (!html.trim() || !css.trim() || !js.trim()) return false;
  const htmlSignals = [/<title>我的小游戏<\/title>/, /在左侧对话生成\/修改这个游戏。/, /<div id=['"]app['"]/].every((re) => re.test(html));
  const cssSignals = [/linear-gradient\(180deg,#f8fafc,#eef2ff\)/, /#app\{padding:14px/].every((re) => re.test(css));
  const jsSignals = [/准备就绪\s*✅/, /document\.getElementById\(['"]app['"]\)/].every((re) => re.test(js));
  return htmlSignals && cssSignals && jsSignals;
}

function trimCodeContext(path: string, content: string) {
  const raw = String(content || "");
  const max = path === "index.html" ? 18000 : path === "game.js" ? 12000 : 8000;
  if (raw.length <= max) return raw;
  const tail = path === "index.html" ? "\n<!-- ...TRUNCATED... -->" : "\n/* ...TRUNCATED... */";
  return raw.slice(0, max) + tail;
}

function sortCodePaths(paths: string[]) {
  const order = ["index.html", "style.css", "game.js"];
  return Array.from(new Set((Array.isArray(paths) ? paths : []).filter((p) => order.includes(String(p || "")))))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function mergeCodeFiles(
  baseFiles: Array<{ path: string; content: string }>,
  updates: Array<{ path: string; content: string }>,
) {
  const merged = Array.isArray(baseFiles) ? baseFiles.map((f) => ({ path: String(f.path || ""), content: String(f.content || "") })) : [];
  for (const u of Array.isArray(updates) ? updates : []) {
    const p = String(u?.path || "").trim();
    const c = String(u?.content || "");
    if (!["index.html", "style.css", "game.js"].includes(p)) continue;
    const idx = merged.findIndex((f) => f.path === p);
    if (idx >= 0) merged[idx] = { path: p, content: c };
    else merged.push({ path: p, content: c });
  }
  return sortCodePaths(merged.map((f) => f.path)).map((path) => merged.find((f) => f.path === path) || { path, content: "" });
}

function buildReadonlyFilesContext(
  files: Array<{ path: string; content: string }>,
  targetPaths: string[],
) {
  const deny = new Set(sortCodePaths(targetPaths));
  const readonly = sortCodePaths((Array.isArray(files) ? files : []).map((f) => String(f?.path || "")))
    .filter((path) => !deny.has(path))
    .map((path) => {
      const content = files.find((f) => f.path === path)?.content || "";
      return { path, content: trimCodeContext(path, content) };
    })
    .filter((f) => String(f.content || "").trim());
  if (!readonly.length) return "";
  return `【只读相关文件（不要输出这些文件）】\n${JSON.stringify(readonly, null, 2)}\n\n`;
}

function collectHtmlIds(html: string) {
  const ids = new Set<string>();
  const re = /\bid\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html || "")))) {
    const id = String(m[1] || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

function escapeRegExp(s: string) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateStructureContracts(indexHtml: string, jsCode: string) {
  const html = String(indexHtml || "");
  const js = String(jsCode || "");
  const errs: string[] = [];
  if (!html.trim() || !js.trim()) return errs;

  const htmlIds = collectHtmlIds(html);
  const referencedIds = new Set<string>();
  for (const re of [
    /document\.getElementById\(\s*["']([^"']+)["']\s*\)/g,
    /querySelector(?:All)?\(\s*["']#([^"']+)["']\s*\)/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(js))) {
      const id = String(m[1] || "").trim();
      if (id) referencedIds.add(id);
    }
  }
  for (const id of referencedIds) {
    if (!htmlIds.has(id)) errs.push(`game.js 引用了不存在的 DOM id：${id}`);
  }

  const idToVar = new Map<string, string>();
  for (const re of [
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*["']([^"']+)["']\s*\)/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.querySelector\(\s*["']#([^"']+)["']\s*\)/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(js))) {
      const varName = String(m[1] || "").trim();
      const id = String(m[2] || "").trim();
      if (varName && id) idToVar.set(id, varName);
    }
  }
  const interactiveEventNames = ["click", "pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"];
  for (const id of ["btnStart", "btnRestart", "btnPlay", "btnRecord", "btnNext", "btnLeft", "btnRight"]) {
    const varName = idToVar.get(id);
    if (!varName) continue;
    const eventRe = new RegExp(
      `${escapeRegExp(varName)}\\s*\\.\\s*(?:addEventListener\\(\\s*["'](?:${interactiveEventNames.join("|")})["']|on(?:${interactiveEventNames.join("|")})\\s*=)`,
      "m",
    );
    if (!eventRe.test(js)) errs.push(`${id} 缺少交互事件绑定`);
  }

  if (/window\.gameHooks\s*=/.test(js)) {
    if (!/(start|restart|setAutoStart|showCurrentSentence|setCurrentSentence)\s*[:=]/.test(js)) {
      errs.push("window.gameHooks 缺少关键接口");
    }
  }

  const initNames = new Set<string>();
  for (const re of [
    /function\s+(init|setup|bootstrap|main)\b/g,
    /(?:const|let|var)\s+(init|setup|bootstrap|main)\s*=/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(js))) {
      const name = String(m[1] || "").trim();
      if (name) initNames.add(name);
    }
  }
  const definesInitLike = initNames.size > 0;
  const hasNamedInitEntry = Array.from(initNames).some((name) =>
    new RegExp(`(?:^|[^\\w$])(?:await\\s+)?${escapeRegExp(name)}\\s*\\(\\s*\\)\\s*(?:;|\\n|$)`, "m").test(js),
  );
  const hasInitEntry =
    hasNamedInitEntry ||
    /addEventListener\(\s*["'](?:DOMContentLoaded|load)["']/.test(js) ||
    /window\.onload\s*=/.test(js) ||
    /\(\s*function\s*\(\s*\)\s*\{[\s\S]*\}\s*\)\s*\(\s*\)\s*;?/.test(js) ||
    /\(\s*\(\s*\)\s*=>\s*\{[\s\S]*\}\s*\)\s*\(\s*\)\s*;?/.test(js);
  if (definesInitLike && !hasInitEntry) errs.push("game.js 缺少明确入口调用");

  return errs;
}

function pickPrimaryDirectRefinePath(
  kind: IncrementalEditProfile["kind"],
  hasSplit: boolean,
  userIntent = "",
) {
  const intent = String(userIntent || "");
  if (!hasSplit) return "index.html";
  if (kind === "visual") return "style.css";
  if (kind === "layout") return "style.css";
  if (kind === "behavior") return "game.js";
  if (kind === "content") {
    if (isSentenceLikeEditIntent(intent)) return "game.js";
    return "index.html";
  }
  if (kind === "bugfix") return "game.js";
  return "game.js";
}

function pickPrimaryFixPath(userIntent = "", hasSplit = true) {
  const intent = String(userIntent || "");
  if (!hasSplit) return "index.html";
  if (/(颜色|字体|圆角|阴影|背景|主题色|样式|美化|动画|动效|布局|位置|居中|右上角|左上角)/i.test(intent)) {
    return "style.css";
  }
  if (/(按钮|标题|文案|文字|提示语|显示|隐藏|不显示|页面|弹层|浮层|遮罩|html|dom)/i.test(intent)) {
    return "index.html";
  }
  return "game.js";
}

function looksLikeStateFlowBug(userIntent = "") {
  return /(自动开始|直接开始|开始页|当前句子|当前文本|句子|进度|状态|流程|切换|screen|下一句|下一关|同步|初始化|init|start|restart|hook|gamehooks|没反应|点击无效|事件绑定|按钮没反应|页面切换)/i.test(
    String(userIntent || ""),
  );
}

function looksLikeDomJsCouplingBug(userIntent = "") {
  const intent = String(userIntent || "");
  const domLike = /(dom|html|按钮|点击|事件|id|选择器|页面|screen|显示|隐藏|节点|元素|绑定)/i.test(intent);
  const jsLike = /(js|脚本|逻辑|state|状态|hook|gamehooks|初始化|current|句子|进度|render|update|ai|bot|opponent|玩家|对战|敌人|回合)/i.test(intent);
  return domLike && jsLike;
}

function looksLikeNewFeatureOrUi(userIntent = "") {
  const intent = String(userIntent || "");
  // “新增功能/新增 UI”通常会牵涉 index + css + js 的联动
  return /(新增|加入|添加|增加|支持|实现|做成|加上|扩展|升级).*(功能|特性|模式|系统|界面|UI|按钮|面板|弹窗|菜单|排行榜|榜单|存档|进度|音效|音乐|皮肤|主题)/i.test(
    intent,
  );
}

function pickExplicitOnlyTarget(userIntent = ""): Array<"index.html" | "style.css" | "game.js"> | null {
  const s = String(userIntent || "");
  if (/只改.*(css|样式|style\.css)/i.test(s) || /(只|仅)(需要|想)?(改|调整).*(css|样式)/i.test(s)) return ["style.css"];
  if (/只改.*(html|结构|页面|index\.html)/i.test(s) || /(只|仅)(需要|想)?(改|调整).*(html|页面|结构)/i.test(s)) return ["index.html"];
  if (/只改.*(js|逻辑|game\.js)/i.test(s) || /(只|仅)(需要|想)?(改|调整).*(js|逻辑)/i.test(s)) return ["game.js"];
  return null;
}

function pickFixTargetPaths(userIntent = "", hasSplit = true) {
  const intent = String(userIntent || "");
  if (!hasSplit) return ["index.html"];
  const explicit = pickExplicitOnlyTarget(intent);
  if (explicit) return explicit;
  const visualLike = /(颜色|字体|圆角|阴影|背景|主题色|样式|美化|动画|动效|布局|位置|居中|右上角|左上角)/i.test(intent);
  const htmlLike = /(按钮|标题|文案|文字|提示语|显示|隐藏|不显示|页面|弹层|浮层|遮罩|html|dom)/i.test(intent);
  const stateFlowLike = looksLikeStateFlowBug(intent);
  const newFeatureOrUi = looksLikeNewFeatureOrUi(intent);

  // 新增功能/新增 UI：默认把三文件都纳入（除非上面 explicit 指定只改某一个文件）
  if (newFeatureOrUi) return ["index.html", "style.css", "game.js"];
  if (visualLike && !htmlLike && !stateFlowLike) return ["style.css"];
  if (stateFlowLike) {
    if (visualLike) return ["style.css", "game.js"];
    if (htmlLike || /(页面|按钮|显示|隐藏|screen|dom)/i.test(intent)) return ["index.html", "game.js"];
    return ["game.js"];
  }
  if (htmlLike) return looksLikePureCopyOrVisibilityEdit(intent) ? ["index.html"] : ["index.html", "game.js"];
  return ["game.js"];
}

function chooseFixStrategy(userIntent = "", hasSplit = true): "single_file_patch" | "single_file_regen" | "multi_file_regen" {
  const intent = String(userIntent || "");
  const targets = pickFixTargetPaths(userIntent, hasSplit);
  if (targets.length > 1) return "multi_file_regen";
  const only = targets[0];
  if (only === "style.css" && looksLikeIsolatedStyleEdit(intent)) return "single_file_patch";
  if (only === "index.html" && looksLikePureCopyOrVisibilityEdit(intent)) return "single_file_patch";
  if (looksLikeStateFlowBug(intent) || looksLikeDomJsCouplingBug(intent) || looksLikeNewFeatureOrUi(intent)) {
    return "single_file_regen";
  }
  return only === "game.js" ? "single_file_regen" : "single_file_patch";
}

function chooseDirectPatchStrategy(
  kind: IncrementalEditProfile["kind"],
  directPaths: string[],
  userIntent = "",
): "ops_patch" | "single_file_patch" | "single_file_regen" | "multi_file_regen" {
  const intent = String(userIntent || "");
  const stateFlowLike = looksLikeStateFlowBug(intent);
  const couplingLike = looksLikeDomJsCouplingBug(intent);
  if (directPaths.length > 1) return "multi_file_regen";
  const only = directPaths[0] || "game.js";
  if (kind === "bugfix" || kind === "feature") return "single_file_regen";
  if (kind === "behavior") return "single_file_regen";
  if (stateFlowLike || couplingLike) return "single_file_regen";
  if (kind === "layout") return only === "style.css" ? "single_file_patch" : "single_file_regen";
  if (kind === "visual") return only === "style.css" && looksLikeIsolatedStyleEdit(intent) ? "single_file_patch" : "single_file_regen";
  if (kind === "content") {
    if (only === "index.html" && looksLikePureCopyOrVisibilityEdit(intent)) return "ops_patch";
    if (only === "style.css" && looksLikeIsolatedStyleEdit(intent)) return "single_file_patch";
    return "single_file_regen";
  }
  return only === "index.html" && looksLikePureCopyOrVisibilityEdit(intent) ? "ops_patch" : "single_file_regen";
}

function pickDirectRefinePaths(kind: IncrementalEditProfile["kind"], hasSplit: boolean, userIntent = "") {
  const intent = String(userIntent || "");
  if (!hasSplit) return ["index.html"];
  if (kind === "visual") return looksLikeIsolatedStyleEdit(intent) ? ["style.css"] : ["index.html", "style.css"];
  if (kind === "layout") return ["index.html", "style.css"];
  if (kind === "content") {
    if (looksLikePureCopyOrVisibilityEdit(intent)) return ["index.html"];
    if (isSentenceLikeEditIntent(intent) && !looksLikeStateFlowBug(intent)) return ["game.js"];
    return ["index.html", "game.js"];
  }
  if (kind === "behavior") {
    if (/(按钮|点击|顺序|摆放|位置|显示|隐藏|ai|玩家|对战|bot|opponent)/i.test(intent)) {
      if (/(顺序|摆放|位置|布局|居中|左右|上下|底部|顶部)/i.test(intent)) return ["index.html", "style.css", "game.js"];
      return ["index.html", "game.js"];
    }
    if (/(自动开始|直接开始|跳过开始|去掉开始页|开始页|开始按钮|不用点击开始|按进度显示|当前句子|当前文本|句子|进度|状态|初始化|start|restart)/i.test(intent)) {
      return ["index.html", "game.js"];
    }
    return ["game.js"];
  }
  if (kind === "bugfix") return ["index.html", "style.css", "game.js"];
  return ["index.html", "style.css", "game.js"];
}

function extractQuotedText(text: string) {
  const s = String(text || "");
  const m = s.match(/[“"'‘「『](.+?)[”"'’」』]/);
  return m ? String(m[1] || "").trim() : "";
}

function stripHtmlTags(s: string) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tryLocalButtonEdit(userIntent: string, html: string) {
  const label = extractQuotedText(userIntent);
  if (!label) return null;
  const wantsRemove = /(去掉|删除|移除)/.test(userIntent);
  const wantsHide = /(隐藏|不显示)/.test(userIntent);
  if (!wantsRemove && !wantsHide) return null;

  const candidates = [
    /<button\b[^>]*>[\s\S]*?<\/button>/gi,
    /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    /<input\b[^>]*type=["']?(?:button|submit)["']?[^>]*>/gi,
  ];
  let changed = false;
  let out = String(html || "");

  const hideElement = (raw: string) => {
    if (/style=/.test(raw)) {
      return raw.replace(
        /style=(["'])(.*?)\1/i,
        (_m, q, css) =>
          `style=${q}${css};display:none !important;visibility:hidden !important;pointer-events:none !important;${q}`,
      );
    }
    return raw.replace(
      /^(<\w+\b)/i,
      `$1 style="display:none !important;visibility:hidden !important;pointer-events:none !important;" aria-hidden="true"`,
    );
  };

  const handleMatch = (raw: string) => {
    const text = stripHtmlTags(raw);
    if (!text.includes(label) && !new RegExp(`value=["'][^"']*${label}[^"']*["']`, "i").test(raw)) return raw;
    changed = true;
    // 稳定优先：即使用户说“删除”，本地极速通道也只做“隐藏”。
    // 这样可以保留节点/id/事件绑定，减少把游戏脚本弄进反复重建状态的风险。
    if (wantsHide || wantsRemove) return hideElement(raw);
    return raw;
  };

  for (const re of candidates) {
    out = out.replace(re, (m) => handleMatch(m));
  }
  if (!changed || out === html) return null;
  return {
    content: out,
    assistant: `已隐藏“${label}”按钮。`,
  };
}

type PatchOp = {
  type: "replace_in_file" | "remove_in_file" | "insert_before" | "insert_after" | "append_in_file" | "prepend_in_file";
  path?: string;
  find?: string;
  replace?: string;
  content?: string;
};

function applyPatchOpsToFiles(
  files: Array<{ path: string; content: string }>,
  ops: PatchOp[],
  allowedPaths: string[],
) {
  const allow = new Set(allowedPaths);
  const merged = files.map((f) => ({ ...f }));
  let changed = 0;
  const getIdx = (path: string) => merged.findIndex((f) => f.path === path);
  const ensurePath = (path: string) => {
    const idx = getIdx(path);
    if (idx >= 0) return idx;
    merged.push({ path, content: "" });
    return merged.length - 1;
  };

  for (const rawOp of Array.isArray(ops) ? ops : []) {
    const op = rawOp && typeof rawOp === "object" ? rawOp : null;
    if (!op) continue;
    const type = String(op.type || "").trim() as PatchOp["type"];
    const path = String(op.path || "").trim();
    if (!allow.has(path)) continue;
    const idx = ensurePath(path);
    const before = String(merged[idx]?.content || "");
    let after = before;

    if (type === "replace_in_file") {
      const find = String(op.find || "");
      if (!find || !before.includes(find)) continue;
      after = before.replace(find, String(op.replace || ""));
    } else if (type === "remove_in_file") {
      const find = String(op.find || "");
      if (!find || !before.includes(find)) continue;
      after = before.replace(find, "");
    } else if (type === "insert_before") {
      const find = String(op.find || "");
      if (!find || !before.includes(find)) continue;
      after = before.replace(find, `${String(op.content || "")}${find}`);
    } else if (type === "insert_after") {
      const find = String(op.find || "");
      if (!find || !before.includes(find)) continue;
      after = before.replace(find, `${find}${String(op.content || "")}`);
    } else if (type === "append_in_file") {
      const content = String(op.content || "");
      if (!content) continue;
      after = before + content;
    } else if (type === "prepend_in_file") {
      const content = String(op.content || "");
      if (!content) continue;
      after = content + before;
    } else {
      continue;
    }

    if (after !== before) {
      merged[idx] = { path, content: after };
      changed += 1;
    }
  }

  return { files: merged, changed };
}

function createDraftStore(gameId: string, options?: { enabled?: boolean }) {
  const enabled = options?.enabled !== false;

  const readFileOnce = async (path: string) => {
    const rows = await db.execute(sql`
      select content
      from creator_draft_files
      where game_id = ${gameId} and path = ${path}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    const c = list?.[0]?.content;
    return typeof c === "string" ? c : "";
  };

  const readFile = async (path: string) => {
    if (!enabled) return "";
    try {
      return await readFileOnce(path);
    } catch (e1: any) {
      // Neon/网络抖动时这里偶发 Drizzle "Failed query"；强制 ensure 一次后再轻量重试。
      try {
        await ensureCreatorDraftTables(true);
      } catch {}
      try {
        return await readFileOnce(path);
      } catch {
        return "";
      }
    }
  };

  const readFiles = async (paths: string[]) => {
    const out: Record<string, string> = {};
    for (const path of paths) out[path] = await readFile(path);
    return out;
  };

  const writeFile = async (path: string, content: string) => {
    if (!enabled) return;
    const safeContent = stripDangerousLocalBehaviorArtifacts(path, content);
    const writeOnce = async () =>
      await db.execute(sql`
        insert into creator_draft_files (game_id, path, content)
        values (${gameId}, ${path}, ${safeContent})
        on conflict (game_id, path)
        do update set content = excluded.content, updated_at = now()
      `);
    try {
      await writeOnce();
    } catch (e1: any) {
      try {
        await ensureCreatorDraftTables(true);
      } catch {}
      await writeOnce();
    }
  };

  const writeFilesDetailed = async (files: Array<{ path: string; content: string }>) => {
    const written: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const f of files) {
      const path = String(f?.path || "").trim();
      if (!path) continue;
      try {
        await writeFile(path, String(f?.content || ""));
        written.push(path);
      } catch (e: any) {
        failed.push({ path, error: String(e?.message || e || "WRITE_FAILED") });
      }
    }
    return {
      ok: failed.length === 0,
      written,
      failed,
      updatedAt: Date.now(),
    };
  };

  const readMeta = async () => {
    const raw = await readFile("meta.json");
    const obj = raw ? parseJsonObjectLoose(raw) : null;
    return obj && typeof obj === "object" ? obj : null;
  };

  const writeMeta = async (metaObj: any) => {
    await writeFile("meta.json", JSON.stringify(metaObj || {}, null, 2));
  };

  return { readFile, readFiles, writeFile, writeFilesDetailed, readMeta, writeMeta };
}

function coderPrompt(blueprint: any, filePath: string, isQuality: boolean) {
  const bp = JSON.stringify(blueprint || {}, null, 2);
  return `
你是“程序员（Coder）”。你将根据架构师给出的蓝图，为小游戏生成指定文件的最终内容。

【通用要求】
1) 只输出合法 JSON，不要输出 Markdown/解释文字。
2) 仅生成一个文件，返回格式：{"path":"${filePath}","content":"..."}。
3) 其它约束：
   - index.html 必须引入 ./style.css 与 ./game.js
   - game.js 不依赖第三方库
   - 优先最小可运行版本，后续可迭代
${isQuality ? "4) 质量模式：在不大幅增加代码量的前提下，做更好的交互反馈、排版、动效/过渡（可选）、更像产品。" : ""}

【蓝图（JSON）】
${bp}
`.trim();
}

function envFlag(key: string) {
  const v = String(process.env[key] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isDeepSeekV4DirectModel(model: string) {
  return /^deepseek-v4-(pro|flash)$/i.test(String(model || "").trim());
}

function extractModelTextParts(content: any): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const t = item as any;
    if (typeof t.text === "string" && t.text) out.push(t.text);
    else if (typeof t.content === "string" && t.content) out.push(t.content);
    else if (typeof t.value === "string" && t.value) out.push(t.value);
  }
  return out;
}

function extractAssistantTextFromResponseJson(j: any) {
  const msg = j?.choices?.[0]?.message || {};
  const parts = [
    ...extractModelTextParts(j?.choices?.[0]?.text),
    ...extractModelTextParts(msg?.text),
    ...extractModelTextParts(msg?.content),
    ...extractModelTextParts(msg?.output_text),
    ...extractModelTextParts(j?.choices?.[0]?.output_text),
    ...extractModelTextParts(j?.output_text),
  ].filter(Boolean);
  return parts.join("");
}

function shouldDisableDeepSeekThinkingForStep(stepTag: string) {
  const t = String(stepTag || "").toLowerCase();
  return /(直接补丁|ops patch|小改动|修复 bug|生成补丁|纯代码|single file|patch|fix)/i.test(t);
}

function envAny(...keys: string[]) {
  for (const key of keys) {
    const v = String(process.env[key] || "").trim();
    if (v) return v;
  }
  return "";
}

function joinOpenAiCompatibleUrl(baseUrl: string, apiPath: string) {
  const path = String(apiPath || "/chat/completions").trim() || "/chat/completions";
  if (/^https?:\/\//i.test(path)) return path.replace(/\/+$/, "");
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function tunePayloadForStep(
  payload: any,
  providerName: ModelProvider,
  stepTag = "",
  forceLeanThinking = false,
) {
  const p: any = { ...payload };
  const leanThinking = forceLeanThinking || shouldDisableDeepSeekThinkingForStep(stepTag);
  if (providerName === "openrouter" && isDeepSeekV4OpenRouterModel(String(p.model || ""))) {
    if (leanThinking) delete p.reasoning;
    else p.reasoning = { effort: "high" };
  }
  if (providerName === "deepseek" && isDeepSeekV4DirectModel(String(p.model || ""))) {
    if (leanThinking) {
      delete p.thinking;
      delete p.reasoning_effort;
    } else {
      p.thinking = { type: "enabled" };
      p.reasoning_effort = "max";
    }
  }
  return p;
}

function summarizeModelResponseEnvelope(j: any) {
  const root = j && typeof j === "object" ? j : {};
  const choice = root?.choices?.[0] && typeof root.choices[0] === "object" ? root.choices[0] : {};
  const msg = choice?.message && typeof choice.message === "object" ? choice.message : {};
  const hasText = !!extractAssistantTextFromResponseJson(root).trim();
  const hasReasoning = !!(
    choice?.reasoning ||
    choice?.reasoning_content ||
    msg?.reasoning ||
    msg?.reasoning_content ||
    root?.reasoning ||
    root?.reasoning_content
  );
  const topKeys = Object.keys(root).slice(0, 8).join(",") || "-";
  const choiceKeys = Object.keys(choice).slice(0, 8).join(",") || "-";
  const messageKeys = Object.keys(msg).slice(0, 8).join(",") || "-";
  const finish = String(choice?.finish_reason || root?.finish_reason || "").trim() || "-";
  return `finish=${finish};top=${topKeys};choice=${choiceKeys};message=${messageKeys};hasText=${hasText ? 1 : 0};hasReasoning=${hasReasoning ? 1 : 0}`;
}

function summarizeStreamEmptyObservation(state: {
  events: number;
  finishReason?: string;
  deltaKeys: Set<string>;
  choiceKeys: Set<string>;
  sawReasoning: boolean;
}) {
  const deltaKeys = Array.from(state.deltaKeys).slice(0, 8).join(",") || "-";
  const choiceKeys = Array.from(state.choiceKeys).slice(0, 8).join(",") || "-";
  const finish = String(state.finishReason || "").trim() || "-";
  return `events=${state.events};finish=${finish};delta=${deltaKeys};choice=${choiceKeys};hasText=0;hasReasoning=${state.sawReasoning ? 1 : 0}`;
}

const STEP_LOG_MAX = 900;

function summarizeLogValue(value: unknown, maxLen = STEP_LOG_MAX): string {
  const summarizeString = (text: string, limit = maxLen) => {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    return compact.length > limit ? `${compact.slice(0, limit)}…[${compact.length}]` : compact;
  };

  const fileSummary = (item: any) => ({
    path: String(item?.path || "").trim(),
    chars: String(item?.content || "").length,
    hash: crypto.createHash("sha1").update(String(item?.content || "")).digest("hex").slice(0, 10),
  });

  if (typeof value === "string") return summarizeString(value);
  if (Array.isArray(value)) {
    const simple =
      value.length && value.every((x) => x && typeof x === "object" && "path" in x && "content" in x)
        ? value.map(fileSummary)
        : value;
    return summarizeString(JSON.stringify(simple));
  }
  if (value && typeof value === "object") {
    const raw = value as Record<string, any>;
    const normalized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key === "files" && Array.isArray(val)) normalized[key] = val.map(fileSummary);
      else if (typeof val === "string") normalized[key] = summarizeString(val, 180);
      else if (Array.isArray(val)) normalized[key] = val.length > 8 ? { count: val.length } : val;
      else normalized[key] = val;
    }
    return summarizeString(JSON.stringify(normalized));
  }
  return summarizeString(String(value ?? ""));
}

function createStepLogger(scope: string) {
  const prefix = `[creator:${scope || "unknown"}]`;
  return (step: string, details?: unknown) => {
    const suffix = details === undefined ? "" : ` ${summarizeLogValue(details)}`;
    console.log(`${prefix} ${step}${suffix}`);
  };
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const ownerKey = ownerKeyFromSession(sess);

  let body: { messages?: Msg[]; model?: string; provider?: string; promptAddon?: string; gameId?: string; runId?: string; mode?: string; quality?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }
  const gameId = String((body as any)?.gameId || "").trim();
  const safeGameId = gameId && /^[a-zA-Z0-9_-]+$/.test(gameId) ? gameId : "";
  const requestRunId = String((body as any)?.runId || "").trim() || `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const requestStartedAt = Date.now();
  const modeRaw = String((body as any)?.mode || "auto").trim().toLowerCase(); // auto | generate | fix
  const qualityRaw = String((body as any)?.quality || "auto").trim().toLowerCase(); // auto | stable | quality

  // 忽略客户端传来的 system message：服务端统一加（保证所有用户都带上）
  // 同时裁剪历史消息，避免 Reasoner 过长输出导致更高的断流概率
  let messages = (Array.isArray(body?.messages) ? body.messages : []).filter((m) => m?.role === "user" || m?.role === "assistant");
  // 只保留最近 N 条（越长越容易超时/断开）
  const MAX_MSG = 12;
  if (messages.length > MAX_MSG) messages = messages.slice(-MAX_MSG);
  // 再按字符长度做一次裁剪（粗略控制）
  const MAX_CHARS = 12000;
  let total = 0;
  const trimmed: any[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = typeof m?.content === "string" ? m.content : "";
    total += c.length;
    trimmed.push(m);
    if (total >= MAX_CHARS) break;
  }
  messages = trimmed.reverse();
  if (!messages.length) return json(400, { ok: false, error: "MISSING_MESSAGES" });

  // 默认优先 OpenRouter：如果用户没指定 provider，则在两者都配置时优先用 OpenRouter
  const providerRaw = String((body as any)?.provider || "").trim().toLowerCase();
  const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY || "");
  const hasDeepSeek = !!(process.env.DEEPSEEK_API_KEY || "");
  const hasBailian = !!(process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "");
  const hasTencentTokenHub = !!(process.env.TENCENT_TOKENHUB_API_KEY || process.env.TOKENHUB_API_KEY || "");
  const hasChinaMobile = !!String(process.env.CHINAMOBILE_TOKENHUB_API_KEY || "").trim();
  let provider: ModelProvider = "openrouter";
  if (providerRaw === "deepseek") provider = "deepseek";
  else if (providerRaw === "openrouter") provider = "openrouter";
  else if (providerRaw === "bailian" || providerRaw === "dashscope") provider = "bailian";
  else if (providerRaw === "tencent" || providerRaw === "tokenhub" || providerRaw === "hunyuan") provider = "tencent";
  else if (providerRaw === "chinamobile" || providerRaw === "china-mobile" || providerRaw === "cmcc" || providerRaw === "mobile") provider = "chinamobile";
  else provider = hasTencentTokenHub ? "tencent" : hasBailian ? "bailian" : hasChinaMobile ? "chinamobile" : hasOpenRouter ? "openrouter" : "deepseek";

  let url = "";
  let authKey = "";
  let model = "";
  if (provider === "deepseek") {
    authKey = process.env.DEEPSEEK_API_KEY || "";
    if (!authKey) {
      // DeepSeek 未配置时自动回退 OpenRouter
      if (hasTencentTokenHub) {
        provider = "tencent";
      } else if (hasBailian) {
        provider = "bailian";
      } else if (hasOpenRouter) {
        provider = "openrouter";
      } else {
        return json(500, { ok: false, error: "MISSING_DEEPSEEK_API_KEY" });
      }
    }
  }

  if (provider === "deepseek") {
    const baseUrl = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
    url = `${baseUrl}/v1/chat/completions`;
    const picked = (body as any)?.model;
    const envModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
    model = (DEEPSEEK_DIRECT_MODELS as readonly string[]).includes(String(picked || "").trim()) ? String(picked).trim() : envModel;
  } else if (provider === "bailian") {
    // 阿里云百炼（DashScope）OpenAI 兼容接口：
    // base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    // chat completions: POST {base_url}/chat/completions
    authKey = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "";
    if (!authKey) {
      if (hasOpenRouter) provider = "openrouter";
      else if (hasDeepSeek) provider = "deepseek";
      else return json(500, { ok: false, error: "MISSING_DASHSCOPE_API_KEY" });
    } else {
      const baseUrl = (process.env.DASHSCOPE_BASE_URL || process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1")
        .replace(/\/+$/, "");
      url = `${baseUrl}/chat/completions`;
      const picked = String((body as any)?.model || "").trim();
      // 百炼模型名：例如 qwen3.6-plus / qwen-plus 等
      model = picked || process.env.BAILIAN_MODEL || process.env.DASHSCOPE_MODEL || "qwen3.6-plus";
    }
  } else if (provider === "tencent") {
    authKey = process.env.TENCENT_TOKENHUB_API_KEY || process.env.TOKENHUB_API_KEY || "";
    if (!authKey) {
      if (hasBailian) provider = "bailian";
      else if (hasOpenRouter) provider = "openrouter";
      else if (hasDeepSeek) provider = "deepseek";
      else return json(500, { ok: false, error: "MISSING_TENCENT_TOKENHUB_API_KEY" });
    } else {
      const baseUrl = (process.env.TENCENT_TOKENHUB_BASE_URL || process.env.TOKENHUB_BASE_URL || "https://tokenhub.tencentmaas.com/v1")
        .replace(/\/+$/, "");
      url = `${baseUrl}/chat/completions`;
      const picked = String((body as any)?.model || "").trim();
      model = (TENCENT_TOKENHUB_MODELS as readonly string[]).includes(picked)
        ? picked
        : process.env.TENCENT_TOKENHUB_MODEL || process.env.TOKENHUB_MODEL || "hy3-preview";
    }
  } else if (provider === "chinamobile") {
    // 中国移动 MaaS（OpenAI-compatible completions）
    // 默认 base_url: https://maas.gd.chinamobile.com:36007/ai/uifm/open/v1
    // 默认 path: /chat/completions；若控制台给的是完整 completions 地址，可用 CHINAMOBILE_API_PATH 覆盖。
    authKey = String(process.env.CHINAMOBILE_TOKENHUB_API_KEY || "").trim();
    if (!authKey) {
      return json(500, { ok: false, error: "MISSING_CHINAMOBILE_API_KEY" });
    } else {
      const baseUrl = String(process.env.CHINAMOBILE_BASE_URL || "").trim() || "https://maas.gd.chinamobile.com:36007/ai/uifm/open/v1";
      const apiPath = String(process.env.CHINAMOBILE_API_PATH || "").trim() || "/chat/completions";
      url = joinOpenAiCompatibleUrl(baseUrl, apiPath);
      const picked = String((body as any)?.model || "").trim();
      model = (CHINAMOBILE_MODELS as readonly string[]).includes(picked)
        ? picked
        : String(process.env.CHINAMOBILE_MODEL || "").trim() || "minimax-m25";
    }
  } else {
    authKey = process.env.OPENROUTER_API_KEY || "";
    if (!authKey) return json(500, { ok: false, error: "MISSING_OPENROUTER_API_KEY" });
    const baseUrl = (process.env.OPENROUTER_API_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    url = `${baseUrl}/chat/completions`;
    const picked = String((body as any)?.model || "").trim();
    model = (OPENROUTER_MODELS as readonly string[]).includes(picked) ? picked : OPENROUTER_MODELS[0];
  }

  // ===== 本地开发：仅对“受地区/风控影响更明显”的模型走线上 Vercel 中转 =====
  // 目的：本地出口 IP 下，OpenRouter 可能返回 "This model is not available in your region"（Gemini/OpenAI/Claude 常见）；
  // 让本地仅在调用这些模型时，把请求转发到线上 Vercel 域名，由 Vercel 出口去请求 OpenRouter。
  //
  // 使用方式（本地）：
  //   在 .env.local 设置：DEV_OPENROUTER_PROXY_ORIGIN=https://你的线上域名
  //
  // 注意：
  // - 只影响 /api/creator/chat（其它 API 仍走本地）
  // - 会把 Cookie header 一并转发到线上（如线上也需要 session）
  const devProxyOrigin = String(process.env.DEV_OPENROUTER_PROXY_ORIGIN || "").trim().replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development" && devProxyOrigin && provider === "openrouter") {
    // 分步生成会在“内部”动态切换模型（Planner/Coder/Review）。
    // 如果只按“最开始选中的 model”判断，后续切到 OpenAI/Gemini 时就不会走中转，
    // 从而在本地触发 region 限制。因此：本地开发只要配置了 DEV_OPENROUTER_PROXY_ORIGIN，
    // 默认对所有 OpenRouter 请求都走线上中转（可通过 promptAddon 包含 no_dev_proxy 关闭）。
    const addon0 = typeof (body as any)?.promptAddon === "string" ? String((body as any).promptAddon) : "";
    const disableProxy = addon0.includes("no_dev_proxy");
    if (!disableProxy) {
      const forwardBody = { ...(body as any), messages };
      const doProxy = async () => {
        const upstream = await fetch(`${devProxyOrigin}/api/creator/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            // 把本地 cookie 转发过去（如果线上需要 session）
            ...(req.headers.get("cookie") ? { cookie: String(req.headers.get("cookie")) } : {}),
            // 某些网关会对 UA/Referer 更宽松；给一个稳定值
            "user-agent": "local-dev-openrouter-proxy",
          },
          body: JSON.stringify(forwardBody),
          // 避免中转请求“永久挂起”
          signal: AbortSignal.timeout(240_000),
        });
        const h = new Headers();
        const ct = upstream.headers.get("content-type");
        if (ct) h.set("content-type", ct);
        h.set("cache-control", "no-store");
        return new Response(upstream.body, { status: upstream.status, headers: h });
      };
      try {
        return await doProxy();
      } catch (e: any) {
        const code = e?.cause?.code || e?.code || "";
        // ECONNRESET 在本地“系统代理/杀软/公司网络”拦截 HTTPS 长连接时很常见：重试一次
        if (String(code).toUpperCase() === "ECONNRESET") {
          try {
            await new Promise((r) => setTimeout(r, 180));
            return await doProxy();
          } catch (e2: any) {
            const code2 = e2?.cause?.code || e2?.code || "";
            const msg2 = String(code2 || e2?.message || e2);
            return json(502, {
              ok: false,
              error: `DEV_OPENROUTER_PROXY_FAILED:${msg2}`,
              hint:
                "本地到线上域名的连接被重置（ECONNRESET）。常见原因：系统全局代理/本地 7897 代理污染、杀软拦截、公司网络重置 HTTP/2/SSE。建议：临时关闭全局代理；或设置 NO_PROXY=aiprograms.cloud；或把 DEV_OPENROUTER_PROXY_ORIGIN 换成 *.vercel.app 域名再试。",
            });
          }
        }
        const msg = String(code || e?.message || e);
        return json(502, { ok: false, error: `DEV_OPENROUTER_PROXY_FAILED:${msg}` });
      }
    }
  }

  const serverBasePrompt = (process.env.CREATOR_SYSTEM_PROMPT || CREATOR_SYSTEM_PROMPT).trim();
  const addon = typeof body.promptAddon === "string" ? body.promptAddon.trim() : "";
  // 限制一下长度，避免被塞超长 prompt
  const safeAddon = addon.length > 6000 ? addon.slice(0, 6000) : addon;
  const antiCoT =
    `\n\n【连接稳定性要求】\n` +
    `- 请不要输出冗长的“思考过程/分析/推理”，直接输出最终 JSON。\n` +
    `- 先做最小可运行版本，再逐步迭代，避免一次性输出过长代码。\n`;
  const baseSystemPrompt = `${serverBasePrompt}${antiCoT}${safeAddon ? `\n\n【用户补充要求】\n${safeAddon}\n` : ""}`;
  const jsonSystemPrompt = `${serverBasePrompt}${CREATOR_OUTPUT_FORMAT_ADDON}${antiCoT}${safeAddon ? `\n\n【用户补充要求】\n${safeAddon}\n` : ""}`;

  // ===== Streaming SSE =====
  const payloadBase: any = {
    model,
    messages: [{ role: "system", content: jsonSystemPrompt }, ...messages],
    temperature: 0.4,
    stream: true,
  };
  // OpenRouter：对 Gemini 等“官方节点容易被封”的模型，强制走第三方 provider，绕过 Google 官方入口。
  // 参考：{ provider: { order: ["DeepInfra","Novita","Together"], allow_fallbacks: true } }
  if (provider === "openrouter") {
    const m = String(model || "").toLowerCase();
    const isGemini = m.startsWith("google/") && m.includes("gemini");
    if (isGemini) {
      const orderEnv = String(process.env.OPENROUTER_PROVIDER_ORDER || "").trim();
      const order = orderEnv
        ? orderEnv
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : ["DeepInfra", "Novita", "Together"];
      payloadBase.provider = { order, allow_fallbacks: true };
    }
  }
  // DeepSeek 通常兼容 OpenAI 的 response_format；如果不支持，会返回错误，我们会在下方兜底重试非 json_mode
  payloadBase.response_format = { type: "json_object" };

  function buildHeaders() {
    const h: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${authKey}`,
    };
    if (provider === "openrouter") {
      // OpenRouter 推荐带站点信息，便于风控 & 稳定性
      const origin = req.headers.get("origin") || process.env.APP_ORIGIN || "http://localhost:3000";
      h["HTTP-Referer"] = origin;
      // 注意：Node/undici 对 header value 要求 ByteString（0-255）。
      // 这里确保只发送 ASCII，避免中文导致 “Cannot convert argument to a ByteString … >255”。
      const rawTitle = process.env.APP_TITLE || "AI Games";
      const asciiTitle = String(rawTitle).replace(/[^\x20-\x7E]/g, "").trim();
      if (asciiTitle) h["X-Title"] = asciiTitle;
    }
    return h;
  }

  async function callModelStream(payload: any, timeoutMs = 360_000) {
    const maxTry = 2;
    for (let k = 1; k <= maxTry; k++) {
      try {
        // 超时兜底：避免请求永远挂起导致前端表现为“网络错误”
        return await fetch(url, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: any) {
        const code = String(e?.cause?.code || e?.code || "").toUpperCase();
        const msg = String(code || e?.message || e);
        // 常见可重试：连接重置/超时/网络抖动
        const retryable = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"].some((x) => msg.includes(x));
        if (k < maxTry && retryable) {
          await new Promise((r) => setTimeout(r, 220 * k));
          continue;
        }
        throw new Error(`FETCH_FAILED:${msg}`);
      }
    }
    throw new Error("FETCH_FAILED:UNKNOWN");
  }

  async function callModelOnce(payload: any, timeoutMs = 360_000, stepTag = "", forceLeanThinking = false) {
    // 尽量也用 json_object，减少模型“解释/思考”导致的超长输出；
    // 如果不兼容，再自动退回普通模式。
    const p0: any = tunePayloadForStep({ ...payload, stream: false }, provider, stepTag, forceLeanThinking);
    const doReq = async (p: any) => {
      let r: Response;
      try {
        r = await fetch(url, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(p),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: any) {
        const code = e?.cause?.code || e?.code || "";
        const msg = String(code || e?.message || e);
        throw new Error(`FETCH_FAILED:${msg}`);
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error?.message || j?.message || r.status;
        throw new Error(`MODEL_ERROR:${msg}`);
      }
      const text = extractAssistantTextFromResponseJson(j);
      if (!text) throw new Error(`EMPTY_MODEL_RESPONSE:${summarizeModelResponseEnvelope(j)}`);
      return text;
    };
    try {
      return await doReq(p0);
    } catch (e: any) {
      const em = String(e?.message || e);
      // 如果是“网络类错误”，先原样重试一次（保留 response_format），避免无谓放开格式导致后续解析失败
      if (em.includes("FETCH_FAILED")) {
        try {
          await new Promise((r) => setTimeout(r, 220));
          return await doReq(p0);
        } catch {}
      }
      // retry without response_format（仅在非网络原因/确实不兼容时）
      const p1 = tunePayloadForStep({ ...p0 }, provider, stepTag, forceLeanThinking);
      delete p1.response_format;
      return await doReq(p1);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: any) => {
        controller.enqueue(enc.encode(`event: ${event}\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const sendStatus = (text: string) => send("status", { text });
      const sendMeta = (data: any) => send("meta", data);
      const sendDelta = (text: string) => send("delta", { text });
      let progressMode: "create" | "patch" | "fix" | "clarify" | "run" = "run";
      let progressStepId = "prepare";
      let progressStepLabel = "准备请求";
      const sendProgress = (data: any) => {
        if (data?.mode) progressMode = data.mode;
        if (data?.stepId) progressStepId = String(data.stepId);
        if (data?.stepLabel) progressStepLabel = String(data.stepLabel);
        send("progress", {
          runId: requestRunId,
          gameId: safeGameId,
          provider,
          model,
          mode: progressMode,
          at: Date.now(),
          ...data,
        });
      };
      const sendContract = (contract: any) => send("contract", { runId: requestRunId, gameId: safeGameId, contract });
      const logStep = createStepLogger(safeGameId || "no-game");
      // SSE 心跳：避免部分网关/代理在“长时间无数据”时主动断开
      const heartbeat = setInterval(() => {
        try {
          send("ping", { t: Date.now() });
        } catch {}
      }, 12000);

      try {
        sendStatus("AI 正在理解你的想法…");
        // 告诉前端当前使用的 provider/model（用于 UI 提示）
        sendMeta({ provider, model });

        // ===== 自动路由：模型根据用户输入决定走生成还是修复、稳定还是质量 =====
        const lastUserText = String(messages.filter((m) => m.role === "user").slice(-1)[0]?.content || "").trim();
        const looksLikeBug =
          /(^\s*修复[:：]|bug|报错|错误|异常|崩溃|无法|不显示|不生效|没反应|卡住|卡死|白屏|闪退|console|控制台)/i.test(lastUserText);
        const wantsQuality =
          /(更精致|更好看|更像|高质量|质量模式|产品级|动效|动画|UI|视觉|排版|美化|duolingo|仿)/i.test(lastUserText);
        const mode = modeRaw === "fix" || modeRaw === "generate" ? modeRaw : looksLikeBug ? "fix" : "generate";
        const quality =
          qualityRaw === "quality" || qualityRaw === "stable" ? qualityRaw : wantsQuality ? "quality" : "stable";
        const routeEditProfile = classifyIncrementalEdit(lastUserText);
        const forceBlueprintRegenForFix =
          mode === "fix" && !!routeEditProfile && (routeEditProfile.kind === "bugfix" || routeEditProfile.kind === "feature");
        sendProgress({
          mode: mode === "fix" ? "fix" : "create",
          stepId: "route",
          stepLabel: mode === "fix" ? "进入修复流程" : "进入生成流程",
          status: "running",
          detail: quality === "quality" ? "以质量优先策略处理" : "以稳定优先策略处理",
        });

        // 对分步生成：每一步也做“流式输出”并把 token 增量推给前端，让用户看到进度
        const callStreamToString = async (payload: any, stepTag: string, strictJson = false, timeoutMs = 360_000) => {
          // payload.stream 必须为 true
          const p0: any = tunePayloadForStep({ ...payload, stream: true }, provider, stepTag);
          // 在 Vercel 上，服务端“上游再开一条流”更容易卡死/断流；这里强制改为非流式获取结果，
          // 前端仍通过 SSE status/ping 看到进度，不依赖上游流的稳定性。
          // 如确实需要上游也流式（风险更高），可在环境变量设置 CREATOR_UPSTREAM_STREAM=1
          const preferNonStreamUpstream = !!process.env.VERCEL && !envFlag("CREATOR_UPSTREAM_STREAM");

          const doReq = async (p: any) => {
            if (preferNonStreamUpstream) {
              // “伪流式”：上游非流式时，也要持续给前端 status，让用户知道在干嘛
              const phases = (() => {
                const t = String(stepTag || "").toLowerCase();
                if (t.includes("mvp") || t.includes("单文件")) return ["分析需求", "搭建页面结构", "编写核心逻辑", "收尾检查与输出"];
                if (t.includes("debug") || t.includes("修复")) return ["定位错误", "生成最小补丁", "复查输出格式"];
                if (t.includes("蓝图") || t.includes("architect")) return ["理解需求", "定义协议/命名", "输出 JSON 蓝图"];
                return ["处理中", "生成中", "收尾输出"];
              })();
              const startedAt = Date.now();
              let idx = 0;
              const ticker = setInterval(() => {
                try {
                  const sec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
                  const phase = phases[Math.min(idx, phases.length - 1)];
                  sendStatus(`${stepTag}：${phase}…（已等待 ${sec}s）`);
                  idx++;
                } catch {}
              }, 3500);
              try {
                return await callModelOnce({ ...p, stream: false }, timeoutMs, stepTag);
              } finally {
                clearInterval(ticker);
              }
            }
            let r: Response;
            try {
              r = await callModelStream(p, timeoutMs);
            } catch (e: any) {
              throw e;
            }
            if (!r.ok || !r.body) {
              const j = await r.json().catch(() => ({}));
              const msg = j?.error?.message || j?.message || r.status;
              throw new Error(`MODEL_ERROR:${msg}`);
            }
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            let out = "";
            let lastChunkAt = Date.now();
            const streamObservation = {
              events: 0,
              finishReason: "",
              deltaKeys: new Set<string>(),
              choiceKeys: new Set<string>(),
              sawReasoning: false,
            };
            const IDLE_MS = 50_000; // 上游 50s 无任何数据则认为卡死，转为非流式
            while (true) {
              const readPromise = reader.read();
              const timeoutPromise = new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error("STREAM_IDLE_TIMEOUT")), IDLE_MS),
              );
              const { value, done } = await Promise.race([readPromise, timeoutPromise]);
              if (done) break;
              buf += dec.decode(value, { stream: true });
              lastChunkAt = Date.now();
              let idx;
              while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                if (!line.startsWith("data:")) continue;
                const dataStr = line.slice(5).trim();
                if (dataStr === "[DONE]") break;
                let j: any = null;
                try {
                  j = JSON.parse(dataStr);
                } catch {
                  continue;
                }
                streamObservation.events += 1;
                const choice0 = j?.choices?.[0] && typeof j.choices[0] === "object" ? j.choices[0] : {};
                for (const key of Object.keys(choice0).slice(0, 8)) streamObservation.choiceKeys.add(key);
                const delta0 = choice0?.delta && typeof choice0.delta === "object" ? choice0.delta : {};
                for (const key of Object.keys(delta0).slice(0, 8)) streamObservation.deltaKeys.add(key);
                if (!streamObservation.finishReason && choice0?.finish_reason) {
                  streamObservation.finishReason = String(choice0.finish_reason || "");
                }
                if (
                  choice0?.reasoning ||
                  choice0?.reasoning_content ||
                  delta0?.reasoning ||
                  delta0?.reasoning_content ||
                  delta0?.reasoning_text
                ) {
                  streamObservation.sawReasoning = true;
                }
                const deltaParts = [
                  ...extractModelTextParts(j?.choices?.[0]?.delta?.content),
                  ...extractModelTextParts(j?.choices?.[0]?.delta?.output_text),
                ];
                for (const delta of deltaParts) {
                  if (typeof delta === "string" && delta) {
                    out += delta;
                    sendDelta(delta);
                  }
                }
              }
            }
            if (!out.trim()) throw new Error(`EMPTY_MODEL_RESPONSE:${summarizeStreamEmptyObservation(streamObservation)}`);
            return out;
          };
          // 在流式输出中插入一个小分隔符，避免用户看不懂现在在做哪一步
          sendDelta(`\n\n—— ${stepTag} ——\n`);
          try {
            return await doReq(p0);
          } catch (e: any) {
            const em = String(e?.message || e || "");
            // 对需要“严格 JSON”的阶段：不要直接去掉 response_format（会显著增加非 JSON 概率）。
            // 改用一次非流式兜底，再返回文本用于解析。
            if (strictJson) {
              sendStatus("该步骤需要严格 JSON，我用非流式方式再试一次…");
              const once = await callModelOnce({ ...payload, stream: false }, timeoutMs, stepTag);
              // 也把结果推给前端，让用户看到发生了什么（不然会像“卡住”）
              sendDelta(`\n\n（非流式结果）\n${once}\n`);
              return once;
            }
            // 非严格场景：retry without response_format（某些模型/网关不支持）
            if (em.includes("STREAM_IDLE_TIMEOUT")) {
              sendStatus(`${stepTag} 流式输出中断，我正在自动续跑这一步…`);
            } else if (em.includes("FETCH_FAILED")) {
              sendStatus(`${stepTag} 网络有点不稳，我正在自动重连继续…`);
            } else if (em.includes("EMPTY_MODEL_RESPONSE")) {
              sendStatus(`${stepTag} 这一轮没有拿到有效正文，我改用“非流式 + 关闭 thinking”再试一次…`);
              const once = await callModelOnce({ ...payload, stream: false }, timeoutMs, stepTag, true);
              sendDelta(`\n\n（非流式重试结果）\n${once}\n`);
              return once;
            } else {
              sendStatus(`${stepTag} 这一步返回不稳定，我正在自动重试一次…`);
            }
            const p1: any = { ...p0 };
            delete p1.response_format;
            return await doReq(p1);
          }
        };

        const callStreamRobust = async (
          payload: any,
          stepTag: string,
          strictJson = false,
          // 兼容两种调用方式：
          // - (payload, tag, strictJson, timeoutMs)
          // - (payload, tag, strictJson, fallbackModels, timeoutMs)
          fallbackModelsOrTimeout: string[] | number = [],
          timeoutMs = 360_000,
        ) => {
          const fallbackModels = Array.isArray(fallbackModelsOrTimeout) ? fallbackModelsOrTimeout : [];
          const realTimeout = typeof fallbackModelsOrTimeout === "number" ? fallbackModelsOrTimeout : timeoutMs;
          try {
            return await callStreamToString(payload, stepTag, strictJson, realTimeout);
          } catch (e: any) {
            const em = String(e?.message || e);
            const eml = em.toLowerCase();

            const canSwapModel = provider === "openrouter" && Array.isArray(fallbackModels) && fallbackModels.length > 0;
            const isRegionBlocked =
              eml.includes("not available in your region") ||
              eml.includes("region") ||
              eml.includes("country") ||
              eml.includes("location");
            const isModelUnavailable =
              eml.includes("model_not_found") ||
              eml.includes("model not found") ||
              eml.includes("not a valid model id") ||
              eml.includes("invalid model id") ||
              eml.includes("deprecated") ||
              eml.includes("not available");
            const isNetwork =
              eml.includes("fetch_failed") || eml.includes("network error") || eml.includes("timeout") || eml.includes("gateway");

            if (canSwapModel && (isRegionBlocked || isModelUnavailable || isNetwork)) {
              const curModel = String(payload?.model || "");
              const pickFallback = () => {
                // 你之前的约定：fallback 优先 deepseek/deepseek-v3.2
                if (fallbackModels.includes("deepseek/deepseek-v3.2") && curModel !== "deepseek/deepseek-v3.2") return "deepseek/deepseek-v3.2";
                for (const m of fallbackModels) {
                  if (m && m !== curModel) return m;
                }
                return "";
              };
              const picked = pickFallback();
              if (picked) {
                sendStatus(`当前模型不稳定/不可用，我切换到 ${picked} 再试一次…`);
                sendMeta({ provider, model: picked, reason: "fallback_model_unstable" });
                const p2: any = { ...payload, model: picked };
                // 对 Gemini 的 provider routing 仅对 gemini 生效；换到 deepseek/qwen 就不需要了
                if (!String(picked).toLowerCase().startsWith("google/")) delete p2.provider;
                return await callStreamToString(p2, stepTag, strictJson, realTimeout);
              }
            }
            throw e;
          }
        };

        const repairJsonObject = async (rawText: string, schemaHint: string, stepTag: string, maxTokens = 8000) => {
          const clipped = String(rawText || "").slice(0, 12000);
          const repairPayload: any = {
            model,
            messages: [
              { role: "system", content: `你是 JSON 修复器。只输出一个严格 JSON 对象（json_object），不要任何解释或 markdown。\n${schemaHint}` },
              { role: "user", content: `请把下面“原输出”修复为严格 JSON：\n\n【原输出】\n${clipped}\n` },
            ],
            temperature: 0,
            max_tokens: maxTokens,
            response_format: { type: "json_object" },
          };
          if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
          const repairedText = await callStreamRobust(repairPayload, stepTag, true, 120_000);
          return parseJsonObjectLoose(repairedText);
        };

        // 每一步“自动重试一次”，避免用户手动点重试
        const autoRetry = async <T>(
          run: () => Promise<T>,
          label: string,
          retryHint: string,
          attempts = 2,
        ): Promise<T> => {
          let lastErr: any = null;
          for (let i = 1; i <= Math.max(1, attempts); i++) {
            try {
              return await run();
            } catch (e: any) {
              lastErr = e;
              const em = String(e?.message || e);
              if (i >= attempts) break;
              sendStatus(`${label}失败，自动重试一次…（原因：${em.slice(0, 120)}）`);
              sendDelta(`\n\n（自动重试提示）${retryHint}\n`);
              await new Promise((r) => setTimeout(r, 280));
            }
          }
          throw lastErr;
        };

        // ===== Fix 模式：最小补丁修复（不走 Planner/Coder 全流程）=====
        if (mode === "fix" && !forceBlueprintRegenForFix) {
          if (!safeGameId) throw new Error("MISSING_GAME_ID");
          if (!ownerKey) throw new Error("UNAUTHORIZED");
          let canCheckpoint = false;
          let fixDraftStore = createDraftStore(safeGameId, { enabled: false });
          const readDraftFile = async (path: string) => await fixDraftStore.readFile(path);
          const upsertDraftFile = async (path: string, content: string) => await fixDraftStore.writeFile(path, content);

          try {
            await ensureCreatorDraftTables();
            const owns = await db.execute(sql`
              select 1
              from creator_draft_games
              where id = ${safeGameId} and owner_key = ${ownerKey}
              limit 1
            `);
            const ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
            canCheckpoint = !!ownRows.length;
            fixDraftStore = createDraftStore(safeGameId, { enabled: canCheckpoint });
          } catch {
            canCheckpoint = false;
          }
          if (!canCheckpoint) throw new Error("NOT_YOUR_GAME");

          const indexHtml = await readDraftFile("index.html");
          const styleCss = await readDraftFile("style.css");
          const gameJs = await readDraftFile("game.js");
          // 如果用户看起来在报 bug，但草稿里没有完整文件，则自动回退到生成流程
          if (!(indexHtml && styleCss && gameJs)) {
            sendStatus("未找到可修复的源文件，我改为走“生成/重建”流程…");
          } else {

          const lastUser = (messages.filter((m) => m.role === "user").slice(-1)[0]?.content || "").trim();
          const totalSteps = 1;
          const step = 1;
          sendStatus(`（${step}/${totalSteps}）修复 bug：生成最小补丁…`);
          sendProgress({
            mode: "fix",
            stepId: "fix_classify",
            stepLabel: "修复策略分析",
            status: "running",
            detail: "正在判断主文件和修复策略",
          });

          sendMeta({ provider, model, phase: "fix", gameId: safeGameId });

          const trim = (s: string) => (s.length > 12000 ? s.slice(0, 12000) + "\n<!-- ...TRUNCATED... -->" : s);
          const fixInput =
            `【Bug 描述】\n${lastUser || "（用户未提供具体 bug 描述）"}\n\n` +
            `【当前文件】\n` +
            `index.html:\n${trim(indexHtml)}\n\n` +
            `style.css:\n${trim(styleCss)}\n\n` +
            `game.js:\n${trim(gameJs)}\n`;
          const currentFixFilesRaw = sortCodePaths(["index.html", "style.css", "game.js"]).map((path) => ({
            path,
            content: path === "index.html" ? indexHtml : path === "style.css" ? styleCss : gameJs,
          }));
          const fixTargetPaths = pickFixTargetPaths(lastUser, true);
          const fixStrategy = chooseFixStrategy(lastUser, true);
          const fixSingleFilePlainFallback = async (
            targetPath: "index.html" | "style.css" | "game.js",
            workingFiles = currentFixFilesRaw,
            mode: "patch" | "regen" = "patch",
          ) => {
            const currentContent = workingFiles.find((f) => f.path === targetPath)?.content || "";
            const readonlyContext = buildReadonlyFilesContext(workingFiles, [targetPath]);
            const lang = targetPath === "index.html" ? "html" : targetPath === "style.css" ? "css" : "js";
            const fileSpecificHint =
              targetPath === "index.html"
                ? "- 保留并校准 ./style.css 与 ./game.js 的引用，确保 DOM id 与只读相关文件一致。\n"
                : targetPath === "style.css"
                  ? "- 保留现有选择器命名，不要无故改类名或 id 选择器。\n"
                  : "- 保留现有 DOM id、入口函数和关键事件绑定；如果存在 window.gameHooks，请保持关键接口一致。\n";
            const plainPrompt =
              `${SINGLE_FILE_PATCH_PROMPT}\n` +
              `- 模式：${mode === "regen" ? "重生成目标文件" : "最小补丁修复"}。\n` +
              `- 目标文件：${targetPath}\n` +
              `- 只输出 ${targetPath} 的完整内容。\n` +
              `- 如果一定要用代码块，只能输出一个 \`\`\`${lang} ... \`\`\` 代码块。\n` +
              `- 只修和这次 bug 直接相关的问题，不要重写整个游戏。\n` +
              fileSpecificHint;
            const fallbackPayload: any = {
              model,
              messages: [
                { role: "system", content: `${baseSystemPrompt}\n\n${plainPrompt}` },
                {
                  role: "user",
                  content:
                    `【Bug 描述】\n${lastUser || "（用户未提供具体 bug 描述）"}\n\n` +
                    readonlyContext +
                    `【目标文件】\npath=${targetPath}\n${currentContent}\n`,
                },
              ],
              temperature: 0.1,
              max_tokens: 8000,
            };
            if (provider === "openrouter" && payloadBase.provider) fallbackPayload.provider = payloadBase.provider;
            const out = await callStreamRobust(fallbackPayload, `修复 bug：${targetPath} 纯代码`, false, 180_000);
            return extractPlainCodeText(out, [lang, targetPath === "game.js" ? "javascript" : lang]);
          };
          const validateFixAcceptance = async (files: Array<{ path: string; content: string }>) => {
            const merged = mergeCodeFiles(currentFixFilesRaw, files);
            const index = merged.find((f) => f.path === "index.html")?.content || "";
            const css = merged.find((f) => f.path === "style.css")?.content || "";
            const js = merged.find((f) => f.path === "game.js")?.content || "";
            return await buildAcceptanceReport(index, css, js);
          };
          const regenerateFixTargets = async (targetPaths: string[]) => {
            let workingFiles = mergeCodeFiles(currentFixFilesRaw, []);
            const out: Array<{ path: string; content: string }> = [];
            for (const path of sortCodePaths(targetPaths)) {
              sendStatus(`（${step}/${totalSteps}）修复 bug：升级为${targetPaths.length > 1 ? "双文件" : "单文件"}重生成，当前处理 ${path}…`);
              const content = await fixSingleFilePlainFallback(path as "index.html" | "style.css" | "game.js", workingFiles, "regen");
              if (!content.trim()) return [];
              workingFiles = mergeCodeFiles(workingFiles, [{ path, content }]);
              out.push({ path, content });
            }
            return out;
          };
          const inferFixRecoveryTargets = (errs: string[]) => {
            const targets = new Set<string>();
            for (const err of Array.isArray(errs) ? errs : []) {
              const msg = String(err || "");
              if (/game\.js 语法错误|game\.js 引用了不存在的 DOM id|缺少(?:\s*click|交互)?\s*事件绑定|window\.gameHooks 缺少关键接口|game\.js 缺少明确入口调用|沙盒(?:自检运行报错| console\.error)/i.test(msg)) {
                targets.add("game.js");
              }
              // game.js 引用了不存在的 DOM id，本质是“JS 与 HTML 结构不一致”，必须连同 index.html 一起修
              if (/game\.js 引用了不存在的 DOM id|沙盒(?:自检运行报错| console\.error).*(?:getelementbyid|queryselector|addEventListener|classList|textContent|Cannot read properties of null|Cannot set properties of null)/i.test(msg)) {
                targets.add("index.html");
              }
              if (/index\.html 内联脚本语法错误|未正确引用 \.\/style\.css|未正确引用 \.\/game\.js/i.test(msg)) {
                targets.add("index.html");
              }
              if (/style\.css/i.test(msg) && !/index\.html 未正确引用 \.\/style\.css/i.test(msg)) {
                targets.add("style.css");
              }
            }
            return sortCodePaths(Array.from(targets));
          };
          const primaryFixPath = (fixTargetPaths[0] || pickPrimaryFixPath(lastUser, true)) as "index.html" | "style.css" | "game.js";

          sendStatus(`（${step}/${totalSteps}）修复 bug：优先修主文件 ${primaryFixPath}…`);
          sendProgress({
            mode: "fix",
            stepId: fixStrategy === "multi_file_regen" ? "fix_multi_regen" : fixStrategy === "single_file_regen" ? "fix_single_regen" : "fix_patch",
            stepLabel: fixStrategy === "multi_file_regen" ? "多文件重生成" : fixStrategy === "single_file_regen" ? "单文件重生成" : "单文件补丁",
            status: "running",
            strategy: fixStrategy,
            fileTargets: fixTargetPaths,
            detail: `优先处理 ${primaryFixPath}`,
          });
          let obj: any = null;
          if (fixStrategy === "single_file_patch") {
            const plainContent = await fixSingleFilePlainFallback(primaryFixPath, currentFixFilesRaw, "patch");
            if (plainContent.trim()) {
              obj = {
                assistant: "已按你的要求完成这次 bug 修复。",
                files: [{ path: primaryFixPath, content: plainContent }],
              };
            }
          } else {
            const regeneratedFiles = await regenerateFixTargets(fixTargetPaths);
            if (regeneratedFiles.length) {
              obj = {
                assistant: fixStrategy === "multi_file_regen" ? "已按你的要求重生成相关文件并修复问题。" : "已按你的要求重生成主文件并修复问题。",
                files: regeneratedFiles,
              };
            }
          }
          if (!obj) {
            const fixPayload: any = {
              model,
              messages: [
                { role: "system", content: FIXER_PROMPT },
                { role: "user", content: fixInput },
              ],
              temperature: 0.2,
              max_tokens: 8000,
              response_format: { type: "json_object" },
            };
            if (provider === "openrouter" && payloadBase.provider) fixPayload.provider = payloadBase.provider;

            const outText = await callStreamRobust(fixPayload, `步骤 ${step}/${totalSteps}：生成补丁 JSON`, true, 120_000);
            logStep("fix.raw", outText);
            const fixSchemaHint =
              `Schema：{\n` +
              `  "assistant": string,\n` +
              `  "files": [ { "path": "index.html|style.css|game.js", "content": string } ]\n` +
              `}\n`;
            obj = parseJsonObjectLoose(outText);
            if (!obj) obj = await repairJsonObject(outText, fixSchemaHint, "修复 fix JSON", 1200);
          }
          if (!obj) throw new Error("FIXER_NOT_JSON");
          // 复用 parseCreatorJson 来做路径/结构校验
          const normalized = {
            assistant: String((obj as any).assistant || "已修复。").trim(),
            files: Array.isArray((obj as any).files) ? (obj as any).files : [],
          };
          parseCreatorJson(JSON.stringify(normalized));
          let fixAcceptance = await validateFixAcceptance(normalized.files);
          let fixAcceptanceErrs = fixAcceptance.blockers;
          if (fixAcceptance.warnings.length) logStep("fix.acceptance_warnings", fixAcceptance.warnings);
          if (fixAcceptanceErrs.length) {
            logStep("fix.invalid_after_patch", { strategy: fixStrategy, errors: fixAcceptanceErrs });
            const inferredTargets = inferFixRecoveryTargets(fixAcceptanceErrs);
            const upgradeTargets =
              inferredTargets.length
                ? inferredTargets
                : fixTargetPaths.length > 1
                  ? sortCodePaths(fixTargetPaths)
                  : [primaryFixPath];
            sendStatus(`（${step}/${totalSteps}）修复 bug：补丁验收没通过，升级为${upgradeTargets.length > 1 ? "多文件" : "单文件"}重生成…`);
            sendProgress({
              mode: "fix",
              stepId: "fix_upgrade_regen",
              stepLabel: "升级为重生成",
              status: "upgraded",
              strategy: upgradeTargets.length > 1 ? "multi_file_regen" : "single_file_regen",
              fileTargets: upgradeTargets,
              detail: fixAcceptanceErrs.join(" | ").slice(0, 180),
            });
            const regeneratedFiles = await regenerateFixTargets(upgradeTargets);
            if (!regeneratedFiles.length) {
              throw new Error(`FIXER_INVALID_FILES:${fixAcceptanceErrs.join(" | ").slice(0, 300)}`);
            }
            normalized.files = regeneratedFiles;
            fixAcceptance = await validateFixAcceptance(normalized.files);
            fixAcceptanceErrs = fixAcceptance.blockers;
            if (fixAcceptance.warnings.length) logStep("fix.acceptance_warnings_after_regen", fixAcceptance.warnings);
            if (fixAcceptanceErrs.length) {
              throw new Error(`FIXER_INVALID_FILES:${fixAcceptanceErrs.join(" | ").slice(0, 300)}`);
            }
            logStep("fix.recovered_by_regen", { upgradeTargets, files: regeneratedFiles });
          }

          // 可选：服务端也写一份，确保断点续跑时立即生效（前端也会再写一次）
          try {
            for (const f of normalized.files) {
              const p = String((f as any)?.path || "").trim();
              const c = String((f as any)?.content || "");
              if (["index.html", "style.css", "game.js"].includes(p) && c.trim()) await upsertDraftFile(p, c);
            }
          } catch {}
          logStep("fix.persist", normalized);
          sendProgress({
            mode: "fix",
            stepId: "fix_validate",
            stepLabel: "强验收与落库",
            status: "done",
            fileTargets: normalized.files.map((f: any) => String(f?.path || "").trim()).filter(Boolean),
            detail: "修复结果已通过验收并写回草稿",
          });

          send("final", { ok: true, content: JSON.stringify(normalized), repaired: false });
          clearInterval(heartbeat);
          controller.close();
          return;
          }
        }
        if (mode === "fix" && forceBlueprintRegenForFix) {
          sendStatus("检测到这是 bug/feature 级改动：改为“更新蓝图 -> 重生成代码”（保持原有风格）…");
          sendProgress({
            mode: "fix",
            stepId: "fix_upgrade_blueprint_regen",
            stepLabel: "升级为蓝图重生成",
            status: "upgraded",
            detail: "跳过最小补丁，改为先更新蓝图再重生成",
          });
        }

        {
          // ===== 默认生成/补丁主链：blueprint -> html/css -> game.js =====
            const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY || "");
            if (!safeGameId || !ownerKey) throw new Error("MISSING_GAME_ID");

            await ensureCreatorDraftTables();
            const owns = await db.execute(sql`
              select title
              from creator_draft_games
              where id = ${safeGameId} and owner_key = ${ownerKey}
              limit 1
            `);
            const ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
            if (!ownRows.length) throw new Error("NOT_YOUR_GAME");
            let draftGameTitle = String((ownRows[0] as any)?.title || "").trim();

            const draftStore = createDraftStore(safeGameId);
            const upsertDraftFile = async (path: string, content: string) => await draftStore.writeFile(path, content);
            const writeDraftFilesDetailed = async (files: Array<{ path: string; content: string }>) => await draftStore.writeFilesDetailed(files);
            const readDraftFile = async (path: string) => await draftStore.readFile(path);
            const readDraftFiles = async (paths: string[]) => await draftStore.readFiles(paths);
            const readMetaObj = async () => await draftStore.readMeta();
            const writeMetaObj = async (metaObj: any) => await draftStore.writeMeta(metaObj);
            const syncDraftGameTitle = async (nextRaw: string) => {
              const nextTitle = normalizeGameTitle(nextRaw);
              if (!nextTitle || nextTitle === draftGameTitle) return;
              await db.execute(sql`
                update creator_draft_games
                set title = ${nextTitle}, updated_at = now()
                where id = ${safeGameId} and owner_key = ${ownerKey}
              `);
              draftGameTitle = nextTitle;
            };
            const hash12 = (s: string) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
            const applyPersistStatus = (metaObj: any, step: string, result: { ok: boolean; written: string[]; failed: Array<{ path: string; error: string }>; updatedAt: number }, expected?: string[]) => ({
              ...(metaObj && typeof metaObj === "object" ? metaObj : {}),
              _gen: {
                ...((metaObj && typeof metaObj === "object" ? metaObj : {})._gen || {}),
                persist: {
                  step,
                  ok: !!result.ok,
                  expected: Array.isArray(expected) ? expected : result.written.concat(result.failed.map((x) => x.path)),
                  written: result.written,
                  failed: result.failed,
                  updatedAt: result.updatedAt,
                },
              },
            });
            const applyFirstSuccessTiming = (metaObj: any) => {
              const base = metaObj && typeof metaObj === "object" ? metaObj : {};
              const gen = base._gen && typeof base._gen === "object" ? { ...base._gen } : {};
              if (Number(gen.firstSuccessElapsedMs) > 0) return base;
              return {
                ...base,
                _gen: {
                  ...gen,
                  firstSuccessElapsedMs: Math.max(0, Date.now() - requestStartedAt),
                  firstSuccessAt: Date.now(),
                  firstSuccessRunId: requestRunId,
                },
              };
            };

            const validateStandaloneJs = (jsCode: string) => validateStandaloneJsSyntax(jsCode);

            const setLastGood = async (metaObj: any, files: Array<{ path: string; content: string }>, note: string) => {
              const m = metaObj && typeof metaObj === "object" ? metaObj : {};
              const pick = files
                .filter((f) => ["index.html", "style.css", "game.js"].includes(f.path))
                .map((f) => ({ path: f.path, content: String(f.content || "") }));
              const blob = pick.map((f) => `${f.path}\n${f.content}`).join("\n\n");
              (m as any)._gen = {
                ...(m as any)._gen,
                stage: "code_done",
                updatedAt: Date.now(),
                lastGood: {
                  at: Date.now(),
                  hash: hash12(blob),
                  note,
                  files: pick.length ? pick : [{ path: "index.html", content: "" }],
                },
              };
              await writeMetaObj(m);
            };
            const validateAcceptanceSimple = async (files: Array<{ path: string; content: string }>) => {
              const index = files.find((f) => f.path === "index.html")?.content || "";
              const css = files.find((f) => f.path === "style.css")?.content || "";
              const js = files.find((f) => f.path === "game.js")?.content || "";
              return await buildAcceptanceReport(index, css, js);
            };
            const trimRefineFile = (path: string, content: string) => {
              return trimCodeContext(path, content);
            };
            const repairFilesJson = async (rawText: string) =>
              await repairJsonObject(
                rawText,
                `Schema：{\n` +
                  `  "assistant": string,\n` +
                  `  "ops"?: [\n` +
                  `    {\n` +
                  `      "type":"replace_in_file|remove_in_file|insert_before|insert_after|append_in_file|prepend_in_file",\n` +
                  `      "path":"index.html|style.css|game.js"\n` +
                  `    }\n` +
                  `  ],\n` +
                  `  "files"?: [ { "path": "index.html|style.css|game.js", "content": string } ]\n` +
                  `}\n`,
                "直接补丁：修复 JSON",
                2400,
              );
            const directSingleFilePlainFallback = async (
              targetPath: string,
              currentContent: string,
              promptText: string,
              taskHint: string,
              readonlyContext = "",
              mode: "patch" | "regen" = "patch",
            ) => {
              const lang = targetPath.endsWith(".js") ? "js" : targetPath.endsWith(".css") ? "css" : "html";
              const fileSpecificHint =
                targetPath === "index.html"
                  ? "- index.html 只负责页面结构与资源引用。不要新增业务内联脚本；交互逻辑保留在 ./game.js。\n- 保留并校准 ./style.css 与 ./game.js 的引用，确保 DOM id 与只读相关文件一致。\n"
                  : targetPath.endsWith(".css")
                    ? "- 保留现有选择器命名，不要无故改类名或 id 选择器。\n"
                    : "- 保留现有 DOM id、入口函数和关键事件绑定；如果存在 window.gameHooks，请保持关键接口一致。\n";
              const plainPrompt =
                `${SINGLE_FILE_PATCH_PROMPT}\n` +
                `- 模式：${mode === "regen" ? "重生成目标文件" : "最小补丁修复"}。\n` +
                `- 目标文件：${targetPath}\n` +
                `- 只输出 ${targetPath} 的完整内容。\n` +
                `- 如果一定要用代码块，只能输出一个 \`\`\`${lang} ... \`\`\` 代码块。\n` +
                fileSpecificHint +
                `${taskHint ? `- 任务提示：${taskHint}\n` : ""}`;
              const payload: any = {
                model,
                messages: [
                  { role: "system", content: `${baseSystemPrompt}\n\n${plainPrompt}` },
                  {
                    role: "user",
                    content:
                      `【最早主题】\n${seedPrompt}\n\n` +
                      readonlyContext +
                      `【当前文件】\npath=${targetPath}\n${currentContent}\n\n` +
                      `【本次修改指令】\n${promptText}\n`,
                  },
                ],
                temperature: 0.1,
                max_tokens: 8000,
              };
              if (provider === "openrouter" && payloadBase.provider) payload.provider = payloadBase.provider;
              const out = await callStreamRobust(payload, `直接补丁：${targetPath} 纯代码`, false, 180_000);
              return extractPlainCodeText(out, [lang, targetPath.endsWith(".js") ? "javascript" : lang]);
            };

            // 选择模型：始终优先使用前端“彩蛋”中用户选择的 provider/model（请求 body 传入的 model）。
            const mvpModel = String(model || "").trim() || (hasOpenRouter ? "qwen/qwen3.6-plus" : model);
            const refineModel = mvpModel;

            const userMsgs = messages.filter((m) => m.role === "user").slice(-2);
            const userIntent = String(userMsgs[userMsgs.length - 1]?.content || "").trim();
            const currentDraft = await readDraftFiles(["index.html", "style.css", "game.js"]);
            const indexExisting = currentDraft["index.html"] || "";
            const styleExisting = currentDraft["style.css"] || "";
            const gameExisting = currentDraft["game.js"] || "";
            const hasExistingGame = !!(indexExisting.trim() || styleExisting.trim() || gameExisting.trim());
            const hasCompleteSplitGame = !!(indexExisting.trim() && styleExisting.trim() && gameExisting.trim());
            const isStarterDraft = looksLikeStarterDraft(indexExisting, styleExisting, gameExisting);
            const directEditProfile = classifyIncrementalEdit(userIntent);

            const readMeta = (await readMetaObj()) || {};
            const genState = ((readMeta as any)._gen && typeof (readMeta as any)._gen === "object" ? (readMeta as any)._gen : {}) as any;
            let stage = String(genState.stage || "").trim();
            // 最多让用户回答 3 个“问题”（不包含选 A/B/C 方向）
            const MAX_TURNS = 3;
            // 容错：有时 stage 字段可能丢失，但 clarify/answers 仍在，避免又回到“阶段0”循环
            if (!stage && genState && typeof genState === "object") {
              if ((genState as any).clarify || (genState as any).answers) stage = "clarify";
            }
            // 固化“最早的用户主题”，避免后续点击选项导致上下文跑偏
            const seedPromptFromMeta = String((genState as any)?.seedPrompt || "").trim();
            const firstNonCommandUser = (() => {
              for (const mm of messages) {
                if (mm.role !== "user") continue;
                const t = String(mm.content || "").trim();
                if (!t) continue;
                // 跳过本地选择指令/控制指令
                if (t.startsWith("@")) continue;
                // 跳过纯链接输入
                if (/^https?:\/\/\S+/i.test(t)) continue;
                return t;
              }
              return "";
            })();
            const seedPrompt = seedPromptFromMeta || firstNonCommandUser || userIntent;
            const lockMetaTitle = async (metaObj: any, preferredTitle = "", source = "blueprint") => {
              const lockedMeta = applyLockedGameTitle(metaObj, {
                preferredTitle,
                fallbackPrompt: seedPrompt,
                draftTitle: draftGameTitle,
                source,
              });
              const finalTitle = normalizeGameTitle((lockedMeta as any)?.title || "");
              if (finalTitle) {
                try {
                  await syncDraftGameTitle(finalTitle);
                } catch (e: any) {
                  logStep("title.sync_failed", { title: finalTitle, error: String(e?.message || e) });
                }
              }
              return lockedMeta;
            };

            // 只有在“确实已有生成历史/蓝图状态”的情况下，才允许走 direct_refine（小改动）。
            // 否则新建游戏（seed 模板已写入 index/style/game，但 meta 里没有 stage/lastGood/design）会被误判成小改动。
            const hasGenState =
              !!String(genState.stage || "").trim() ||
              !!(genState as any).lastGood ||
              !!(genState as any).design ||
              !!(genState as any).requirementContract;
            const forceBlueprintRegenerate =
              !!directEditProfile && (directEditProfile.kind === "feature" || directEditProfile.kind === "bugfix");
            const preserveExistingStyle = forceBlueprintRegenerate && hasExistingGame && !isStarterDraft;
            const styleConsistencyBlock = preserveExistingStyle
              ? buildStyleConsistencyBlock(indexExisting, styleExisting, (genState as any)?.design || readMeta)
              : "";
            const shouldUseDirectRefine =
              mode !== "fix" &&
              hasExistingGame &&
              hasGenState &&
              !isStarterDraft &&
              !!directEditProfile &&
              !forceBlueprintRegenerate;
            logStep("direct_refine.gate", {
              hasExistingGame,
              hasCompleteSplitGame,
              hasGenState,
              isStarterDraft,
              hasProfile: !!directEditProfile,
              forceBlueprintRegenerate,
              preserveExistingStyle,
              stage: String(genState.stage || ""),
            });

            if (shouldUseDirectRefine) {
              const editProfile = directEditProfile as IncrementalEditProfile;
              logStep("direct_refine.enter", { kind: editProfile.kind, confidence: editProfile.confidence, hasCompleteSplitGame });
              sendStatus(`（1/1）根据现有游戏直接做小改动（${provider} / ${refineModel}）…`);
              if (provider === "openrouter") model = refineModel;
              sendMeta({ provider, model, phase: `direct_refine_${editProfile.kind}` });

              const currentFilesRaw = hasCompleteSplitGame
                ? [
                    { path: "index.html", content: indexExisting },
                    { path: "style.css", content: styleExisting },
                    { path: "game.js", content: gameExisting },
                  ]
                : [{ path: "index.html", content: indexExisting }];

              const localButtonEdit = tryLocalButtonEdit(userIntent, indexExisting);
              if (localButtonEdit) {
                const files = currentFilesRaw.map((f) =>
                  f.path === "index.html" ? { path: "index.html", content: localButtonEdit.content } : f,
                );
                await upsertDraftFile("index.html", localButtonEdit.content);
                const metaNow = (await readMetaObj()) || readMeta || {};
                const localAcceptance = await validateAcceptanceSimple(files);
                if (!localAcceptance.blockers.length) await setLastGood(metaNow, files, "after_local_direct_edit");
                if (localAcceptance.warnings.length) logStep("direct_refine.local_acceptance_warnings", localAcceptance.warnings);
                const finalObj = {
                  assistant: localButtonEdit.assistant,
                  meta: metaNow,
                  files: [...files, { path: "meta.json", content: JSON.stringify(metaNow, null, 2) }],
                };
                parseCreatorJson(JSON.stringify(finalObj));
                send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false, local: true });
                clearInterval(heartbeat);
                controller.close();
                return;
              }

              const directPaths = pickDirectRefinePaths(editProfile.kind, hasCompleteSplitGame, userIntent);
              const primaryDirectPath = pickPrimaryDirectRefinePath(editProfile.kind, hasCompleteSplitGame, userIntent);
              const directPatchStrategy = chooseDirectPatchStrategy(editProfile.kind, directPaths, userIntent);
              sendProgress({
                mode: "patch",
                stepId: "direct_refine_strategy",
                stepLabel: "小改动策略分析",
                status: "running",
                strategy: directPatchStrategy,
                fileTargets: directPaths,
                detail: editProfile.hint,
              });
              const currentFiles = currentFilesRaw
                .filter((f) => directPaths.includes(f.path))
                .map((f) => ({ path: f.path, content: trimRefineFile(f.path, f.content) }));
              const refineTaskHint =
                editProfile.kind === "content"
                  ? "这是单点内容/显隐修改。优先删掉、隐藏、改文案，不要重写整页。"
                  : editProfile.kind === "layout"
                    ? "这是布局位置调整。优先改 CSS 或少量 DOM 结构，不要动玩法逻辑。"
                    : editProfile.kind === "visual"
                      ? "这是视觉样式优化。优先改样式，不要改玩法和状态流。"
                      : editProfile.kind === "behavior"
                      ? "这是已有游戏上的行为修改。优先保持原有风格与 DOM 约定；只要涉及开始页、按钮、AI、显示状态或进度，就要同步保证 index.html 和 game.js 一致。"
                        : editProfile.kind === "bugfix"
                          ? "这是行为修复。优先修问题本身，不要额外设计新玩法。"
                          : "这是已有游戏上的小增强。优先增量添加，不要重写大结构。";
              const refineExtraRules =
                editProfile.kind === "behavior"
                  ? `- 这次是已有游戏上的行为修改；如果涉及按钮、开始页、AI/玩家、当前句子、进度、事件绑定，请联动保证 DOM id、事件和状态流一致。\n` +
                    `- 不要通过注入大段兜底脚本来绕过现有代码，也不要静默删掉原有按钮绑定。\n` +
                    `- 如果要“自动开始”，请直接复用现有 start/init 流程；如果要“按进度显示当前句子”，请同时同步页面显示和状态更新。\n`
                  : "";
              const regenerateDirectTargets = async (targetPaths: string[]) => {
                let workingFiles = mergeCodeFiles(currentFilesRaw, []);
                const out: Array<{ path: string; content: string }> = [];
                for (const path of sortCodePaths(targetPaths)) {
                  const currentTarget = workingFiles.find((f) => f.path === path)?.content || "";
                  const readonlyContext = buildReadonlyFilesContext(workingFiles, [path]);
                  sendStatus(`这次小改动升级为${targetPaths.length > 1 ? "双文件" : "单文件"}重生成，当前处理 ${path}…`);
                  const plainContent = await directSingleFilePlainFallback(path, currentTarget, userIntent, refineTaskHint, readonlyContext, "regen");
                  if (!plainContent.trim()) return [];
                  workingFiles = mergeCodeFiles(workingFiles, [{ path, content: plainContent }]);
                  out.push({ path, content: plainContent });
                }
                return out;
              };
              const inferDirectRecoveryTargets = (errs: string[]) => {
                const targets = new Set<string>();
                for (const err of Array.isArray(errs) ? errs : []) {
                  const msg = String(err || "");
                  if (
                    /index\.html\s*内联脚本语法错误|未正确引用 \.\/style\.css|未正确引用 \.\/game\.js/i.test(msg)
                  ) {
                    targets.add("index.html");
                  }
                  if (
                    /game\.js 语法错误|game\.js 引用了不存在的 DOM id|缺少(?:\s*click|交互)?\s*事件绑定|window\.gameHooks 缺少关键接口|game\.js 缺少明确入口调用|沙盒(?:自检运行报错| console\.error)/i.test(
                      msg,
                    )
                  ) {
                    targets.add("game.js");
                  }
                  if (/缺少(?:\s*click|交互)?\s*事件绑定/i.test(msg)) {
                    targets.add("index.html");
                  }
                  // game.js 引用了不存在的 DOM id => 必须补 HTML 结构
                  if (/game\.js 引用了不存在的 DOM id|沙盒(?:自检运行报错| console\.error).*(?:getelementbyid|queryselector|addEventListener|classList|textContent|Cannot read properties of null|Cannot set properties of null)/i.test(msg)) {
                    targets.add("index.html");
                  }
                  if (/style\.css/i.test(msg) && !/index\.html 未正确引用 \.\/style\.css/i.test(msg)) {
                    targets.add("style.css");
                  }
                }
                return sortCodePaths(Array.from(targets));
              };

              let refineObj: any = null;
              if (directPatchStrategy === "single_file_patch" || directPatchStrategy === "single_file_regen") {
                const targetPath = directPaths.includes(primaryDirectPath) ? primaryDirectPath : directPaths[0];
                const currentTarget = currentFilesRaw.find((f) => f.path === targetPath)?.content || "";
                const readonlyContext = buildReadonlyFilesContext(currentFilesRaw, [targetPath]);
                sendStatus(
                  directPatchStrategy === "single_file_regen"
                    ? `这次小改动升级为“单文件重生成”模式，优先修改 ${targetPath}…`
                    : `这次小改动走“单文件补丁”模式，优先修改 ${targetPath}…`,
                );
                const plainContent = await directSingleFilePlainFallback(
                  targetPath,
                  currentTarget,
                  userIntent,
                  refineTaskHint,
                  readonlyContext,
                  directPatchStrategy === "single_file_regen" ? "regen" : "patch",
                );
                if (plainContent.trim()) {
                  refineObj = {
                    assistant: "已按你的要求完成这次小改动。",
                    files: [{ path: targetPath, content: plainContent }],
                  };
                }
              } else if (directPatchStrategy === "multi_file_regen") {
                const regeneratedFiles = await regenerateDirectTargets(directPaths);
                if (regeneratedFiles.length) {
                  refineObj = {
                    assistant: "已按你的要求重生成相关文件并完成修复。",
                    files: regeneratedFiles,
                  };
                }
              } else {
                const refinePayload: any = {
                  model,
                  messages: [
                    {
                      role: "system",
                      content:
                        `${OPS_PATCH_PROMPT}\n\n` +
                        `【额外要求】\n` +
                        `- 这是“已有游戏上的小改动/小优化”，不是从零创建新游戏。\n` +
                        `- 不要反问，不要改主题，不要重做整体结构。\n` +
                        `- 只改和用户这句话直接相关的内容，能少改就少改。\n` +
                        refineExtraRules,
                    },
                    {
                      role: "user",
                      content:
                        `【最早主题】\n${seedPrompt}\n\n` +
                        `【增量编辑类型】\nkind=${editProfile.kind}\nconfidence=${editProfile.confidence}\nhint=${editProfile.hint}\n\n` +
                        `【本次任务提示】\n${refineTaskHint}\n\n` +
                        `【本次可修改文件】\n${directPaths.join(", ")}\n\n` +
                        `【当前文件】\n${JSON.stringify(currentFiles, null, 2)}\n\n` +
                        `【本次修改指令】\n${userIntent}\n\n` +
                        `优先输出 ops；只有在确实无法用 ops 表达时，再输出修改后的 files。若这句话只是“去掉/隐藏/调整位置/改文案/改样式”，不要生成额外玩法方案，不要重写无关文件。`,
                    },
                  ],
                  temperature: editProfile.kind === "bugfix" ? 0.1 : editProfile.kind === "feature" ? 0.25 : 0.15,
                  max_tokens: 8000,
                  response_format: { type: "json_object" },
                };
                if (provider === "openrouter" && payloadBase.provider) refinePayload.provider = payloadBase.provider;

                const refineText = await autoRetry(
                  async () =>
                    await callStreamRobust(refinePayload, "直接补丁：ops patch", true, directPaths.length === 1 ? 90_000 : 150_000),
                  "小改动补丁",
                  "这是已有游戏上的小改动，只输出 JSON 和必要文件。",
                  1,
                );
                logStep("direct_refine.raw", refineText);
                refineObj = parseJsonObjectLoose(refineText);
                if (!refineObj) refineObj = await repairFilesJson(refineText);
                if (!refineObj) {
                  const targetPath = directPaths.includes(primaryDirectPath) ? primaryDirectPath : directPaths[0];
                  const upgradeTargets = directPaths.length > 1 ? sortCodePaths(directPaths) : [targetPath];
                  sendStatus(`这次小改动的 JSON 不稳定，我直接升级为${upgradeTargets.length > 1 ? "多文件" : "单文件"}重生成…`);
                  sendProgress({
                    mode: "patch",
                    stepId: "direct_refine_upgrade",
                    stepLabel: "升级为重生成",
                    status: "upgraded",
                    strategy: upgradeTargets.length > 1 ? "multi_file_regen" : "single_file_regen",
                    fileTargets: upgradeTargets,
                    detail: "补丁 JSON 不稳定",
                  });
                  const regenerated = await regenerateDirectTargets(upgradeTargets);
                  if (regenerated.length) {
                    refineObj = {
                      assistant: "已按你的要求重生成相关文件并完成修复。",
                      files: regenerated,
                    };
                  }
                }
              }
              if (!refineObj) throw new Error("DIRECT_REFINE_NOT_JSON");
              const outOps = Array.isArray((refineObj as any)?.ops) ? ((refineObj as any).ops as PatchOp[]) : [];
              const outFiles = Array.isArray((refineObj as any)?.files) ? (refineObj as any).files : [];
              let files = currentFilesRaw.slice();
              let appliedOpsChanged = 0;
              if (outOps.length) {
                const applied = applyPatchOpsToFiles(files, outOps, directPaths);
                files = applied.files;
                appliedOpsChanged = applied.changed;
              }
              if (!outFiles.length && outOps.length && !appliedOpsChanged) {
                const targetPath = directPaths.includes(primaryDirectPath) ? primaryDirectPath : directPaths[0];
                const upgradeTargets =
                  directPaths.length > 1 ? sortCodePaths(directPaths) : [targetPath];
                logStep("direct_refine.ops_no_match", { targetPath, ops: outOps });
                sendStatus(`这次补丁锚点没有命中当前代码，我直接升级为${upgradeTargets.length > 1 ? "多文件" : "单文件"}重生成…`);
                sendProgress({
                  mode: "patch",
                  stepId: "direct_refine_upgrade",
                  stepLabel: "升级为重生成",
                  status: "upgraded",
                  strategy: upgradeTargets.length > 1 ? "multi_file_regen" : "single_file_regen",
                  fileTargets: upgradeTargets,
                  detail: "ops 锚点未命中当前代码",
                });
                const regenerated = await regenerateDirectTargets(upgradeTargets);
                if (regenerated.length) {
                  files = mergeCodeFiles(currentFilesRaw, regenerated);
                } else {
                  throw new Error("DIRECT_REFINE_OPS_NO_MATCH");
                }
              }
              for (const f of outFiles) {
                const p = String((f as any)?.path || "").trim();
                const c = String((f as any)?.content || "");
                if (!["index.html", "style.css", "game.js"].includes(p) || !c.trim()) continue;
                const idx = files.findIndex((x) => x.path === p);
                if (idx >= 0) files[idx] = { path: p, content: c };
                else files.push({ path: p, content: c });
              }
              let finalAcceptance = await validateAcceptanceSimple(
                files.filter((f) => ["index.html", "style.css", "game.js"].includes(f.path)),
              );
              let finalAcceptanceErrs = finalAcceptance.blockers;
              if (finalAcceptance.warnings.length) logStep("direct_refine.acceptance_warnings", finalAcceptance.warnings);
              if (finalAcceptanceErrs.length) {
                logStep("direct_refine.invalid_after_patch", { strategy: directPatchStrategy, errors: finalAcceptanceErrs });
                const inferredTargets = inferDirectRecoveryTargets(finalAcceptanceErrs);
                const recoveryTargets = inferredTargets.length
                  ? inferredTargets
                  : directPatchStrategy === "multi_file_regen"
                    ? sortCodePaths(directPaths)
                    : (looksLikeStateFlowBug(userIntent) || looksLikeDomJsCouplingBug(userIntent)) && directPaths.includes("index.html") && directPaths.includes("game.js")
                      ? ["index.html", "game.js"]
                      : [directPaths.includes(primaryDirectPath) ? primaryDirectPath : directPaths[0]];
                if (recoveryTargets.length) {
                  sendStatus(`这次补丁验收没通过，升级为${recoveryTargets.length > 1 ? "多文件" : "单文件"}重生成…`);
                  sendProgress({
                    mode: "patch",
                    stepId: "direct_refine_validate",
                    stepLabel: "强验收与恢复",
                    status: "upgraded",
                    strategy: recoveryTargets.length > 1 ? "multi_file_regen" : "single_file_regen",
                    fileTargets: recoveryTargets,
                    detail: finalAcceptanceErrs.join(" | ").slice(0, 180),
                  });
                  const regenerated = await regenerateDirectTargets(recoveryTargets);
                  if (regenerated.length) {
                    files = mergeCodeFiles(files, regenerated);
                    finalAcceptance = await validateAcceptanceSimple(
                      files.filter((f) => ["index.html", "style.css", "game.js"].includes(f.path)),
                    );
                    finalAcceptanceErrs = finalAcceptance.blockers;
                    if (finalAcceptance.warnings.length) logStep("direct_refine.acceptance_warnings_after_regen", finalAcceptance.warnings);
                    if (!finalAcceptanceErrs.length) {
                      logStep("direct_refine.recovered_by_regen", { recoveryTargets, regenerated });
                    } else {
                      logStep("direct_refine.recovery_failed", finalAcceptanceErrs);
                      throw new Error(`DIRECT_REFINE_INVALID_FILES:${finalAcceptanceErrs.join(" | ").slice(0, 300)}`);
                    }
                  } else {
                    throw new Error(`DIRECT_REFINE_INVALID_FILES:${finalAcceptanceErrs.join(" | ").slice(0, 300)}`);
                  }
                } else {
                  throw new Error(`DIRECT_REFINE_INVALID_FILES:${finalAcceptanceErrs.join(" | ").slice(0, 300)}`);
                }
              }
              for (const f of files) {
                if (!["index.html", "style.css", "game.js"].includes(f.path)) continue;
                await upsertDraftFile(f.path, f.content);
              }
              logStep("direct_refine.persist", { files, ops: outOps, changed: appliedOpsChanged });
              const metaNow = (await readMetaObj()) || readMeta || {};
              await setLastGood(metaNow, files, "after_direct_refine");
              sendProgress({
                mode: "patch",
                stepId: "direct_refine_validate",
                stepLabel: "强验收与落库",
                status: "done",
                strategy: directPatchStrategy,
                fileTargets: files.map((f) => f.path),
                detail: "小改动已通过验收并写回草稿",
              });
              const finalObj = {
                assistant: String((refineObj as any)?.assistant || "已按你的要求完成这次小改动。").trim(),
                meta: metaNow,
                files: [...files, { path: "meta.json", content: JSON.stringify(metaNow, null, 2) }],
              };
              parseCreatorJson(JSON.stringify(finalObj));
              send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
              clearInterval(heartbeat);
              controller.close();
              return;
            }

            // 如果用户当前发的是点击指令，但我们还没有“最早主题”，就不要进入澄清/反问（否则必然跑题）
            if (!seedPromptFromMeta && !firstNonCommandUser && userIntent.startsWith("@")) {
              const finalObj = {
                assistant:
                  "我还不知道你想做什么小游戏。请先用一句话告诉我主题，例如：\n" +
                  "- 做一个学英语口语的小游戏（跟读/闯关）\n" +
                  "- 做一个背单词闯关小游戏\n" +
                  "- 做一个数学口算小游戏\n",
                meta: readMeta,
                files: [] as any[],
              };
              parseCreatorJson(JSON.stringify(finalObj));
              send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
              clearInterval(heartbeat);
              controller.close();
              return;
            }

            const writeMeta = async (obj: any) => {
              await upsertDraftFile("meta.json", JSON.stringify(obj || {}, null, 2));
            };

            // ===== 阶段 0：澄清（分析师反问 + 3 方案）=====
            // 稳定优先：当用户需求缺少关键要素时，先反问，不生成代码。
            const hasControls = /(键盘|方向键|arrowleft|arrowright|触屏|触控|虚拟|按钮|点击|轻点|滑动|拖动|wasd|空格)/i.test(userIntent);
            const hasWinLose = /(胜利|失败|终点|过关|闯关|碰撞|撞到|结束|计时|倒计时|对战|得分|积分|排行榜)/i.test(userIntent);
            const hasStyle = /(像素|霓虹|手绘|卡通|写实|酷炫|帅气|赛博|风格|主题|星空|森林|海洋|校园)/i.test(userIntent);
            const hasPlatform = /(手机|移动端|pc|电脑|竖屏|横屏|双端|网页|浏览器|ipad)/i.test(userIntent);
            const missingCount = [hasControls, hasWinLose, hasStyle, hasPlatform].filter((x) => !x).length;
            const genericOnly = /^(做|生成|写|创建)?\s*(一个|一款)?\s*(h5\s*)?(小游戏|游戏|小应用)(吧|呀|就行|就可以)?[！!。.\s]*$/i.test(userIntent);
            const isVague = genericOnly || userIntent.length < 12 || (userIntent.length < 24 && missingCount >= 3);
            // 如果正在等待用户选择方案/确认配置，则进入对应阶段处理
            const pickChoice = (s: string) => {
              const t = String(s || "").trim();
              // 结构化点击：@choice A
              const c0 = t.match(/^@choice\s+(OTHER|[ABCabc])\b/i);
              if (c0) return String(c0[1] || "").toUpperCase();
              const m = t.match(/(?:方案)?\s*([ABCabc])\b/);
              if (m) return m[1].toUpperCase();
              const n = t.match(/^\s*([123])\b/);
              if (n) return n[1] === "1" ? "A" : n[1] === "2" ? "B" : "C";
              if (/(这三个都不想选|这三个都不喜欢|都不想选|都不喜欢|其他|其它|自己定|自定义|我自己说)/i.test(t)) return "OTHER";
              return "";
            };
            // 注意：不要用“包含生成/开始”等关键词来判断确认，否则用户点某些方案描述里包含“生成”会误触发进入编码。
            // 仅在“明确命令”时进入编码。
            const isConfirm = (s: string) => {
              const t = String(s || "").trim();
              if (!t) return false;
              if (/^@confirm\b/i.test(t)) return true;
              return /^(确认|开始生成|开始|ok|好的|可以|就这样)$/i.test(t);
            };

            // 如果前端一次性提交了答案（@answers），但 meta 里还没有 stage（例如刷新/丢状态），
            // 则直接进入 clarify 分支继续往下走，避免再次触发“阶段0：需求澄清”导致跑题/死循环。
            const userTrim0 = String(userIntent || "").trim();
            // 允许用户在“写代码阶段失败”后点重试：@retry
            // 直接进入 code_pending，复用已保存的 design/config，不再回到澄清/蓝图。
            if (/^@retry\b/i.test(userTrim0)) {
              stage = "code_pending";
              genState.stage = "code_pending";
              genState.seedPrompt = seedPrompt;
              await writeMeta({ ...(readMeta && typeof readMeta === "object" ? readMeta : {}), _gen: { ...(genState || {}), updatedAt: Date.now() } });
            }
            if (!stage && /^@answers\b/i.test(userTrim0)) {
              stage = "clarify";
              genState.stage = "clarify";
              genState.seedPrompt = seedPrompt;
              genState.clarify = genState.clarify || {};
              const raw = userTrim0.replace(/^@answers\b/i, "").trim();
              const obj = parseJsonObjectLoose(raw);
              const answers = (genState.answers && typeof genState.answers === "object" ? genState.answers : {}) as any;
              if (obj && typeof obj === "object") {
                for (const [k, v] of Object.entries(obj as any)) answers[k] = v as any;
              }
              genState.answers = answers;
              genState.turnsUsed = MAX_TURNS; // 视为已完成本轮问答
              await writeMeta({ ...(readMeta && typeof readMeta === "object" ? readMeta : {}), _gen: { ...(genState || {}), updatedAt: Date.now() } });
            }

            // 兼容历史草稿状态：旧版本会把待生成阶段写成 monolith_mvp_pending。
            // 新链只保留 blueprint -> html/css -> game.js，所以这里直接迁移到 blueprint_pending。
            if (stage === "monolith_mvp_pending") {
              stage = "blueprint_pending";
              await writeMeta({
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: { ...(genState || {}), stage: "blueprint_pending", seedPrompt, updatedAt: Date.now() },
              });
            }

            // 0.1 若需要澄清（且不是已有配置流程中），先让 Qwen 输出澄清 JSON
            if (!stage && isVague) {
              sendStatus(`（1/3）需求澄清：给出 3 个方向供你选择（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "clarify" });
              sendProgress({
                mode: "clarify",
                stepId: "clarify",
                stepLabel: "需求澄清",
                status: "running",
                detail: "正在生成可选方向与补充问题",
              });
              const payloadClarify: any = {
                model,
                messages: [
                  { role: "system", content: `${CREATOR_GAME_TYPE_LIBRARY_ADDON}\n\n${CLARIFY_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【用户最早的主题】\n${seedPrompt || userIntent}\n\n` +
                      `【用户最新补充】\n${userIntent}\n\n` +
                      `请严格围绕“用户最早的主题”给出 A/B/C 三个方向，并提出选择题问题。`,
                  },
                ],
                temperature: 0.2,
                max_tokens: 8000,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) payloadClarify.provider = payloadBase.provider;
              const out = await autoRetry(
                async () =>
                  await callStreamRobust(payloadClarify, "阶段0：需求澄清 JSON", true, 180_000),
                "需求澄清",
                "只输出 JSON（intent/missing/options/questions/recommend）。",
                2,
              );
              const clarifySchemaHint =
                `Schema：{\n` +
                `  "intent": string,\n` +
                `  "missing": string[],\n` +
                `  "options": object[],\n` +
                `  "questions": object[],\n` +
                `  "recommend": string\n` +
                `}\n`;
              let obj = parseJsonObjectLoose(out);
              if (!obj) obj = await repairJsonObject(out, clarifySchemaHint, "修复澄清 JSON", 1000);
              if (!obj) throw new Error("CLARIFY_NOT_JSON");
              const options = Array.isArray((obj as any).options) ? (obj as any).options : [];
              const qs = Array.isArray((obj as any).questions) ? (obj as any).questions : [];
              const rec = String((obj as any).recommend || "A").trim() || "A";
              // 生成友好文案
              const lines: string[] = [];
              lines.push(`我先帮你把需求补齐，再开始写代码。你可以直接回复 A/B/C 选择一个方向；如果这三个都不喜欢，也可以直接说“都不想选，我想自己定”。`);
              for (const o of options.slice(0, 3)) {
                const id = String(o?.id || "").trim() || "?";
                const title = String(o?.title || "").trim();
                const style = String(o?.style || "").trim();
                const plat = String(o?.platform || "").trim();
                const ctrl = String(o?.controls || "").trim();
                const wl = String(o?.winLose || "").trim();
                const notes = String(o?.notes || "").trim();
                lines.push(`- 方案${id}${id === rec ? "（推荐）" : ""}：${title}`);
                lines.push(`  - 风格：${style || "（默认）"}；平台：${plat || "（默认）"}；操作：${ctrl || "（默认）"}；胜负：${wl || "（默认）"}${notes ? `；特点：${notes}` : ""}`);
              }
              if (qs.length) {
                lines.push(`\n另外还有几个关键问题（可选回答）：`);
                for (const q of qs.slice(0, 5)) {
                  const qid = String(q?.id || "").trim();
                  const qq = String(q?.question || "").trim();
                  const ch = Array.isArray(q?.choices) ? q.choices : [];
                  lines.push(`- ${qid ? `${qid}. ` : ""}${qq}${ch.length ? `（${ch.slice(0, 3).join(" / ")}）` : ""}`);
                }
              }
              lines.push(`\n请回复：A / B / C；如果这三个都不合适，也可以直接说“都不想选，我想自己定”，或者补充一句你特别想要的效果。`);

              // 写入 meta.json：记录澄清阶段与澄清 JSON（中间变量）
              const clarifyTitleCandidate = String(options.find((x: any) => String(x?.id || "").toUpperCase() === rec)?.title || "").trim();
              const metaOut = {
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                title: pickLockedGameTitle(readMeta, draftGameTitle) || "",
                _gen: {
                  ...(genState || {}),
                  stage: "clarify",
                  clarify: obj,
                  titleCandidate: clarifyTitleCandidate,
                  seedPrompt,
                  turnsUsed: 0, // 已回答的问题数（不包含选 A/B/C）
                  maxTurns: MAX_TURNS,
                  answers: {},
                  updatedAt: Date.now(),
                },
              };
              await writeMeta(metaOut);

              // 交互优化：一次只展示一个“下一步要选的维度”
              // 第一步：先选 A/B/C；之后：按 questions 顺序逐个回答
              const ui = {
                type: "clarify",
                mode: "single_step",
                turn: 0,
                maxTurns: MAX_TURNS,
                recommend: rec,
                step: "choice",
                options: buildClarifyUiOptions(options),
                questions: [],
                selected: {},
                actions: [{ id: "confirm", label: "开始生成（跳过剩余选择）", payload: "@confirm" }],
                // 给前端“本地分步选择”用：一次性下发全部维度，后续点击不必再次请求大模型
                all: { options: buildClarifyUiOptions(options), questions: qs.slice(0, 5) },
              };

              const finalObj = { assistant: lines.join("\n"), meta: metaOut, files: [] as any[], ui };
              parseCreatorJson(JSON.stringify(finalObj));
              send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
              clearInterval(heartbeat);
              controller.close();
              return;
            }

            // 0.2 多轮澄清：用户最多选择/回答 3 次；达到上限或用户点“开始生成”则进入编码模式。
            if (stage === "clarify") {
              const clarify = genState.clarify || {};
              const turnsUsed0 = Number(genState.turnsUsed || 0) || 0;
              let turnsUsed = turnsUsed0;
              let picked = pickChoice(userIntent);

              // 记录用户选择/回答（结构化收集）
              const answers = (genState.answers && typeof genState.answers === "object" ? genState.answers : {}) as any;
              // 前端可一次性提交所有答案：@answers {...}
              const userTrim = String(userIntent || "").trim();
              if (/^@answers\b/i.test(userTrim)) {
                const raw = userTrim.replace(/^@answers\b/i, "").trim();
                const obj = parseJsonObjectLoose(raw);
                if (obj && typeof obj === "object") {
                  for (const [k, v] of Object.entries(obj as any)) answers[k] = v as any;
                }
                const c = String(answers.choice || "").trim();
                if (c) picked = pickChoice(c) || c.toUpperCase();
                if (picked) answers.choice = picked;
                // 一次性提交时直接视为问题已答完
                turnsUsed = MAX_TURNS;
              } else {
                if (picked) answers.choice = picked;
              }
              // 支持 “q1: xxx” / @answer q1 手机 这种回答格式
              try {
                let answeredThisTurn = false;
                // 结构化点击：@answer q1 手机
                const a0 = String(userIntent || "").match(/^@answer\s+([a-zA-Z0-9_-]{1,16})\s+(.{1,60})\s*$/);
                if (a0 && a0[1] && a0[2]) {
                  answers[a0[1]] = a0[2].trim();
                  answeredThisTurn = true;
                }
                const m = String(userIntent || "").match(/^\s*([a-zA-Z0-9_-]{1,16})\s*[:：]\s*(.{1,60})\s*$/);
                if (m && m[1] && m[2]) {
                  answers[m[1]] = m[2].trim();
                  answeredThisTurn = true;
                }
                // 如果用户不是点按钮，而是直接用自然语言回答，也视为回答了 1 个问题（避免一直问）
                if (!answeredThisTurn && !userTrim.startsWith("@") && userTrim.length > 0) {
                  const k = `free${turnsUsed0 + 1}`;
                  if (!answers[k]) answers[k] = userTrim.slice(0, 80);
                  answeredThisTurn = true;
                }
                if (answeredThisTurn && turnsUsed < MAX_TURNS) turnsUsed += 1;
              } catch {}

              const metaOut0 = {
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: {
                  ...(genState || {}),
                  stage: "clarify",
                  clarify,
                  seedPrompt,
                  turnsUsed,
                  maxTurns: MAX_TURNS,
                  answers,
                  updatedAt: Date.now(),
                },
              };
              await writeMeta(metaOut0);

              const shouldStart = isConfirm(userIntent) || turnsUsed >= MAX_TURNS || /^@answers\b/i.test(userTrim);
              if (!shouldStart) {
                const options = Array.isArray((clarify as any)?.options) ? (clarify as any).options : [];
                const qs = Array.isArray((clarify as any)?.questions) ? (clarify as any).questions : [];
                const rec = String((clarify as any)?.recommend || "A").trim() || "A";
                const unanswered = qs.filter((q: any) => {
                  const id = String(q?.id || "").trim();
                  if (!id) return false;
                  return answers[id] == null || String(answers[id] || "").trim() === "";
                });
                const nextQ = unanswered[0] || null;
                const remaining = Math.max(0, MAX_TURNS - turnsUsed);
                const nextHint = !answers.choice
                  ? "下一步：请选择一个方向（A/B/C/其它）。"
                  : nextQ
                    ? `下一步：${String(nextQ?.question || "").trim() || "请回答下一个问题"}`
                    : "下一步：如果没有更多要补充的，可以开始生成。";
                const txt =
                  `收到，我已记录你的选择（已回答 ${turnsUsed}/${MAX_TURNS} 个问题）。\n` +
                  `你还可以再回答 ${remaining} 个问题，之后我就会开始写代码。\n\n` +
                  `当前已选：${describeClarifyChoice(String(answers.choice || ""))}\n` +
                  `${nextHint}`;

                const ui = {
                  type: "clarify",
                  mode: "single_step",
                  turn: turnsUsed,
                  maxTurns: MAX_TURNS,
                  recommend: rec,
                  step: !answers.choice ? "choice" : nextQ ? String(nextQ?.id || "").trim() || "q" : "done",
                  options: !answers.choice
                    ? buildClarifyUiOptions(options)
                    : [],
                  questions: answers.choice && nextQ
                    ? [
                        {
                          id: String(nextQ?.id || "").trim() || "",
                          question: String(nextQ?.question || "").trim() || "",
                          choices: Array.isArray(nextQ?.choices) ? nextQ.choices.slice(0, 4) : [],
                        },
                      ]
                    : [],
                  selected: answers,
                  actions:
                    !answers.choice
                      ? []
                      : [
                          { id: "confirm", label: "开始生成（跳过剩余选择）", payload: "@confirm" },
                        ],
                  // 为前端本地分步展示提供完整列表（不必再请求大模型）
                  all: { options: buildClarifyUiOptions(options), questions: qs.slice(0, 5) },
                };
                const finalObj = { assistant: txt, meta: metaOut0, files: [] as any[], ui };
                parseCreatorJson(JSON.stringify(finalObj));
                send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
                clearInterval(heartbeat);
                controller.close();
                return;
              }

              // 达到选择上限或用户确认：直接进入 blueprint，省掉 config 这一跳，减少一次模型调用。
              await writeMeta({
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: { ...(genState || {}), stage: "blueprint_pending", seedPrompt, answers, updatedAt: Date.now() },
              });
              stage = "blueprint_pending";
            }

            // ===== 两步生成：蓝图（短 JSON） -> 代码（文件）=====
            // 目标：降低 MVP_NOT_JSON（减少一次输出体积），并通过 protocol/命名保证蓝图与代码同源不漂移。
            let activeConfig = genState && typeof genState === "object" && (genState as any).config ? (genState as any).config : null;
            const answers = (genState as any)?.answers && typeof (genState as any).answers === "object" ? (genState as any).answers : {};
            let design = (genState as any)?.design && typeof (genState as any).design === "object" ? (genState as any).design : null;
            let requirementContract =
              (genState as any)?.requirementContract && typeof (genState as any).requirementContract === "object"
                ? ((genState as any).requirementContract as RequirementContract)
                : null;
            const templateHint = buildTemplateHintBlock(seedPrompt, userIntent, answers);
            logStep("generation.enter", {
              stage,
              hasDesign: !!design,
              hasRequirementContract: !!requirementContract,
              hasActiveConfig: !!activeConfig,
              provider,
              model,
              quality,
            });

            const shouldUpdateBlueprintFromUserIntent = (t: string) => {
              const s = String(t || "").trim();
              if (!s) return false;
              if (/不(要|用)改蓝图|别改蓝图|保持蓝图不变/i.test(s)) return false;
              // 明显是“新增/改规则/加功能”类指令：允许更新蓝图（但必须保留旧蓝图历史）
              return /(新增|加入|添加|增加|支持|改成|改为|规则|玩法|排行榜|榜单|存档|进度|背景|关卡|模式|控制|按键|重力|UI|界面|音效|音乐|难度|修复|bug|报错|错误|异常|崩溃|卡住|白屏|不生效)/i.test(
                s,
              );
            };
            const repairBlueprintProtocol = async (rawText: string) => {
              const clipped = String(rawText || "").slice(0, 12000);
              const repairPayload: any = {
                model,
                messages: [
                  {
                    role: "system",
                    content:
                      `你是蓝图协议修复器。不要输出 JSON，不要解释，只输出分段文本协议。\n` +
                      `必须严格包含 5 段：meta、config、protocol、blueprint、assetsPlan。\n` +
                      `每段都用 ===SECTION:name=== 开始，用 ===END=== 结束，段内只允许 key=value 行。\n`,
                  },
                  {
                    role: "user",
                    content:
                      `请把下面内容修复成正确的“蓝图分段文本协议”：\n\n` +
                      `【原输出】\n${clipped}\n`,
                  },
                ],
                temperature: 0,
                max_tokens: 8000,
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              return await callStreamRobust(repairPayload, "阶段2：修复蓝图协议", false, 120_000);
            };
            const markCodePending = async () => {
              const nextMeta = {
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: {
                  ...(genState || {}),
                  stage: "code_pending",
                  seedPrompt,
                  answers,
                  config: activeConfig,
                  design,
                  requirementContract,
                  updatedAt: Date.now(),
                },
              };
              try {
                await writeMeta(nextMeta);
                logStep("generation.stage.code_pending", {
                  stage: "code_pending",
                  hasDesign: !!design,
                  hasRequirementContract: !!requirementContract,
                });
              } catch (e: any) {
                logStep("generation.stage.code_pending_failed", String(e?.message || e));
              }
            };

            // 1) 若还没有 design（蓝图/协议），先生成蓝图并落盘。只在 stage 非 code_pending 时进行。
            const generateBlueprintStep = async () => {
              // 落盘：进入蓝图 pending，保证重试时不会回到阶段0/澄清
              try {
                await writeMeta({
                  ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                  _gen: { ...(genState || {}), stage: "blueprint_pending", seedPrompt, config: activeConfig, answers, updatedAt: Date.now() },
                });
                logStep("blueprint.pending", { stage: "blueprint_pending", seedPrompt });
              } catch {}

              sendStatus(`（1/5）生成蓝图（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "blueprint" });
              sendProgress({
                mode: "create",
                stepId: "blueprint",
                stepLabel: "蓝图",
                status: "running",
                detail: "正在收敛玩法协议与命名约束",
              });

              const bpPayload: any = {
                model,
                messages: [
                  { role: "system", content: `${baseSystemPrompt}\n\n${CREATOR_GAME_TYPE_LIBRARY_ADDON}\n\n${BLUEPRINT_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【用户最早的主题】\n${seedPrompt}\n\n` +
                      `【用户补充/本轮输入】\n${userIntent}\n\n` +
                      `【已选答案（可能为空）】\n${JSON.stringify(answers, null, 2)}\n\n` +
                      styleConsistencyBlock +
                      `${templateHint}\n` +
                      (activeConfig ? `【已有 config（如有）】\n${JSON.stringify(activeConfig, null, 2)}\n\n` : "") +
                      `请输出蓝图分段文本协议（meta/config/protocol/blueprint/assetsPlan），不要输出 JSON。`,
                  },
                ],
                temperature: 0.2,
                max_tokens: 8000,
              };
              if (provider === "openrouter" && payloadBase.provider) bpPayload.provider = payloadBase.provider;

              const bpText = await autoRetry(
                async () =>
                  await callStreamRobust(bpPayload, "阶段2：蓝图（分段协议）", false, 180_000),
                "蓝图",
                "严格按 ===SECTION:...=== / ===END=== 输出 5 段 key=value 文本协议（meta/config/protocol/blueprint/assetsPlan），严禁输出代码。",
                2,
              );
              logStep("blueprint.raw", bpText);
              let sec = parseSectionBlocks(bpText);
              if (!sec) {
                const repairedBpText = await repairBlueprintProtocol(bpText);
                logStep("blueprint.repaired", repairedBpText);
                sec = parseSectionBlocks(repairedBpText);
              }
              if (!sec) throw new Error("BLUEPRINT_PROTOCOL_INVALID");

              const parsedBlueprint = parseBlueprintSectionProtocol(sec, activeConfig, readMeta);
              if (!parsedBlueprint) throw new Error("BLUEPRINT_PROTOCOL_PARSE_FAILED");
              parsedBlueprint.meta = await lockMetaTitle(parsedBlueprint.meta, parsedBlueprint?.meta?.title, "blueprint");
              design = parsedBlueprint;
              const metaBp = parsedBlueprint.meta;
              const cfgBp = parsedBlueprint.config || activeConfig || {};
              activeConfig = cfgBp;
              requirementContract = buildRequirementContract(seedPrompt, userIntent, answers, design);
              logStep("blueprint.parsed", {
                meta: metaBp,
                configKeys: Object.keys(activeConfig || {}),
                protocolKeys: Object.keys((design as any)?.protocol || {}),
                blueprintKeys: Object.keys((design as any)?.blueprint || {}),
                requirementContract,
              });
              sendProgress({
                mode: "create",
                stepId: "blueprint",
                stepLabel: "蓝图",
                status: "done",
                detail: "蓝图已生成",
              });
              await writeMeta({
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                ...metaBp,
                _gen: {
                  ...(genState || {}),
                  stage: "code_pending",
                  seedPrompt,
                  answers,
                  config: activeConfig,
                  design,
                  requirementContract,
                  updatedAt: Date.now(),
                },
              });
            };

            const updateBlueprintStep = async () => {
              if (!design) return;
              const prev = design;

              // 先把旧蓝图存档（避免“改蓝图”把历史丢了）
              try {
                await writeMeta(
                  pushDesignHistory(
                    {
                      ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                      _gen: { ...(genState || {}), stage: "blueprint_pending", seedPrompt, config: activeConfig, answers, design, updatedAt: Date.now() },
                    },
                    prev,
                    "before_blueprint_update",
                  ),
                );
              } catch {}

              sendStatus(`（1/5）更新蓝图（增量）（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "blueprint_update" });
              sendProgress({
                mode: "create",
                stepId: "blueprint_update",
                stepLabel: "蓝图（增量）",
                status: "running",
                detail: "正在把新增需求合并进蓝图（保留旧蓝图历史）",
              });

              const bpPayload: any = {
                model,
                messages: [
                  { role: "system", content: `${baseSystemPrompt}\n\n${CREATOR_GAME_TYPE_LIBRARY_ADDON}\n\n${BLUEPRINT_UPDATE_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【当前蓝图 design（必须尽量保持命名稳定）】\n${JSON.stringify(prev, null, 2)}\n\n` +
                      `【当前固定标题】\n${pickLockedGameTitle((prev as any)?.meta || readMeta, draftGameTitle) || "（暂无，若本次首次生成则请从最早主题提炼）"}\n\n` +
                      `【用户新增需求/本轮输入】\n${userIntent}\n\n` +
                      styleConsistencyBlock +
                      `请在保持上面“原有风格约束”的前提下更新蓝图，禁止改成另一种视觉语言。\n\n` +
                      `${templateHint}\n` +
                      `请输出更新后的蓝图分段文本协议（meta/config/protocol/blueprint/assetsPlan），不要输出 JSON。`,
                  },
                ],
                temperature: 0.15,
                max_tokens: 8000,
              };
              if (provider === "openrouter" && payloadBase.provider) bpPayload.provider = payloadBase.provider;

              const bpText = await autoRetry(
                async () => await callStreamRobust(bpPayload, "阶段2：蓝图（增量更新）", false, 180_000),
                "蓝图（增量）",
                "严格按 ===SECTION:...=== / ===END=== 输出 5 段 key=value 文本协议，严禁输出代码。",
                2,
              );
              logStep("blueprint_update.raw", bpText);

              let sec = parseSectionBlocks(bpText);
              if (!sec) {
                const repaired = await repairBlueprintProtocol(bpText);
                logStep("blueprint_update.repaired", repaired);
                sec = parseSectionBlocks(repaired);
              }
              if (!sec) throw new Error("BLUEPRINT_UPDATE_PROTOCOL_INVALID");

              const parsedBlueprint = parseBlueprintSectionProtocol(sec, activeConfig, (prev as any)?.meta || readMeta);
              if (!parsedBlueprint) throw new Error("BLUEPRINT_UPDATE_PROTOCOL_PARSE_FAILED");
              parsedBlueprint.meta = await lockMetaTitle(parsedBlueprint.meta, (prev as any)?.meta?.title || parsedBlueprint?.meta?.title, "blueprint");

              design = parsedBlueprint;
              activeConfig = parsedBlueprint.config || activeConfig || {};
              requirementContract = buildRequirementContract(seedPrompt, userIntent, answers, design);

              const nextMeta = pushDesignHistory(
                {
                  ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                  ...parsedBlueprint.meta,
                  _gen: {
                    ...(genState || {}),
                    stage: "code_pending",
                    seedPrompt,
                    answers,
                    config: activeConfig,
                    design,
                    requirementContract,
                    updatedAt: Date.now(),
                  },
                },
                prev,
                "after_blueprint_update",
              );
              await writeMeta(nextMeta);

              sendProgress({
                mode: "create",
                stepId: "blueprint_update",
                stepLabel: "蓝图（增量）",
                status: "done",
                detail: "蓝图已更新并保存历史",
              });
            };
            if (!design && stage !== "code_pending") await generateBlueprintStep();
            else if (design && (forceBlueprintRegenerate || mode === "fix" || shouldUpdateBlueprintFromUserIntent(userIntent))) {
              await updateBlueprintStep();
            }


            // 2) 代码生成：需求契约 -> index.html -> style.css -> game.js
            // 避免把 index.html + style.css 塞进同一个 JSON，降低在第二个文件附近截断的概率。
            // 落盘：进入 code_pending，确保重试时复用同一份蓝图（同源，不漂移）
            await markCodePending();
            sendStatus(`（2/${requirementContract?.complexity === "complex" ? 6 : 5}）收敛需求契约…`);
            logStep("requirement_contract.ready", requirementContract);
            sendProgress({
              mode: "create",
              stepId: "requirement_contract",
              stepLabel: "需求契约",
              status: "running",
              detail: "正在固化主题、玩法、关键 UI 与 must-have",
            });
            if (requirementContract) sendContract(requirementContract);
            const requirementContractBlock = formatRequirementContractBlock(requirementContract);
            const gameJsTwoStep = shouldUseTwoStepGameJs(
              {
                id: String(requirementContract?.templateId || "generic_arcade"),
                label: String(requirementContract?.templateLabel || "通用轻量模板"),
                hint: "",
              },
              requirementContract || buildRequirementContract(seedPrompt, userIntent, answers, design),
              seedPrompt,
              userIntent,
            );
            const generationTotalSteps = gameJsTwoStep ? 6 : 5;

            const tryRepairJsonOnce = async (raw: string, why: string, schemaHint: string) => {
              const rawText = String(raw || "");
              if (!rawText.trim()) return null;
              logStep("json_repair.start", { why, raw: rawText });
              sendStatus(`输出 JSON 有问题，我尝试自动修复一次…（原因：${why}）`);
              sendMeta({ provider, model, phase: "json_repair" });
              const clipped = rawText.length > 12000 ? rawText.slice(0, 12000) : rawText;
              const repairPayload: any = {
                model,
                messages: [
                  { role: "system", content: `你是 JSON 修复器。\n${schemaHint}` },
                  { role: "user", content: `请把下面“原输出”修复为严格 JSON：\n\n【原输出】\n${clipped}\n` },
                ],
                temperature: 0.0,
                max_tokens: 8000,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              try {
                const repairedText = await callStreamRobust(repairPayload, "阶段：修复输出 JSON", true, 180_000);
                logStep("json_repair.raw", repairedText);
                return parseJsonObjectLoose(repairedText);
              } catch {
                logStep("json_repair.failed", why);
                return null;
              }
            };
            const failWithRetry = async (assistant: string, badText = "") => {
              logStep("generation.retryable_failure", { assistant, badText });
              const retryMeta = {
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: { ...(genState || {}), stage: "code_pending", seedPrompt, updatedAt: Date.now(), lastBad: String(badText || "").slice(0, 2000) },
              };
              await writeMeta(retryMeta);
              const latestMeta = (await readMetaObj()) || retryMeta;
              const finalObj = {
                assistant,
                meta: latestMeta,
                files: [] as any[],
                ui: { type: "actions", actions: [{ id: "retry", label: "重试（继续写代码）", payload: "@retry" }] },
              };
              parseCreatorJson(JSON.stringify(finalObj));
              send("final", { ok: true, content: JSON.stringify(finalObj), repaired: true });
              clearInterval(heartbeat);
              controller.close();
              return;
            };

            const parseFilesObject = async (
              rawText: string,
              schemaHint: string,
              requiredPaths: string[],
            ): Promise<any | null> => {
              let obj: any = parseJsonObjectLoose(rawText);
              if (!obj) obj = await tryRepairJsonOnce(rawText, "NOT_JSON_OR_TRUNCATED", schemaHint);
              if (!obj) return null;
              const outFiles = Array.isArray((obj as any).files) ? (obj as any).files : [];
              const ok = requiredPaths.every((p) => outFiles.some((x: any) => String(x?.path || "").trim() === p && String(x?.content || "").trim()));
              if (ok) return obj;
              return (await tryRepairJsonOnce(rawText, `MISSING_${requiredPaths.join("_")}`, schemaHint)) || obj;
            };
            const generateHtmlStep = async () => {
              sendStatus(`（3/${generationTotalSteps}）生成页面结构（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "codegen_html" });
              sendProgress({
                mode: "create",
                stepId: "html",
                stepLabel: "页面结构",
                status: "running",
                fileTargets: ["index.html"],
                detail: "生成 index.html",
              });
              const htmlPayload: any = {
                model,
                messages: [
                  { role: "system", content: `${baseSystemPrompt}\n\n${CODEGEN_HTML_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【用户最早的主题】\n${seedPrompt}\n\n` +
                      `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                      requirementContractBlock +
                      styleConsistencyBlock +
                      `${templateHint}\n` +
                      `请只输出 index.html 纯文本，不要输出 JSON。`,
                  },
                ],
                temperature: 0.2,
                max_tokens: 8000,
              };
              if (provider === "openrouter" && payloadBase.provider) htmlPayload.provider = payloadBase.provider;

              let htmlText = "";
              try {
                htmlText = await autoRetry(
                  async () =>
                    await callStreamRobust(htmlPayload, "阶段3：页面结构 HTML", false, 180_000),
                  "页面结构",
                  "只输出 index.html 纯文本，不要解释，不要 JSON。",
                  2,
                );
              } catch (e: any) {
                logStep("html.request_failed", String(e?.message || e));
                return await failWithRetry(
                  "我刚刚在生成页面结构时遇到了网络问题。蓝图已经保存好，点“重试”会直接从写代码继续。",
                  String(e?.message || e),
                );
              }

              logStep("html.raw", htmlText);
              const html = extractPlainCodeText(htmlText, ["html"]);
              if (!html.trim()) {
                logStep("html.empty", htmlText);
                return await failWithRetry(
                  "我刚刚在生成页面结构时，没有拿到有效的 HTML 内容。你的蓝图我已经保存好了，点“重试”会从写代码继续。",
                  htmlText,
                );
              }
              const htmlWrite = await writeDraftFilesDetailed([{ path: "index.html", content: html }]);
              logStep("html.persist", htmlWrite);
              const metaAfterHtml = applyPersistStatus((await readMetaObj()) || readMeta || {}, "html", htmlWrite, ["index.html"]);
              try {
                await writeMeta(metaAfterHtml);
              } catch (e: any) {
                logStep("html.persist_meta_failed", String(e?.message || e));
              }
              if (!htmlWrite.ok) {
                return await failWithRetry(
                  "页面结构已经生成出来了，但写回数据库时没有完全成功。点“重试”我会从已生成结果继续。",
                  JSON.stringify(htmlWrite.failed),
                );
              }
              sendProgress({
                mode: "create",
                stepId: "html",
                stepLabel: "页面结构",
                status: "done",
                fileTargets: ["index.html"],
                detail: "index.html 已生成并落库",
              });
              const stepMeta = safeMeta((design as any)?.meta || (readMeta as any) || {});
              return { meta: stepMeta, html };
            };
            const generateCssStep = async (html: string) => {
              sendStatus(`（4/${generationTotalSteps}）生成页面样式（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "codegen_css" });
              sendProgress({
                mode: "create",
                stepId: "css",
                stepLabel: "页面样式",
                status: "running",
                fileTargets: ["style.css"],
                detail: "生成 style.css",
              });
              const cssPayload: any = {
                model,
                messages: [
                  { role: "system", content: `${baseSystemPrompt}\n\n${CODEGEN_CSS_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【用户最早的主题】\n${seedPrompt}\n\n` +
                      `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                      requirementContractBlock +
                      styleConsistencyBlock +
                      `【当前页面结构】\n${JSON.stringify([{ path: "index.html", content: html }], null, 2)}\n\n` +
                      `${templateHint}\n` +
                      `请只输出 style.css 纯文本，不要输出 JSON。`,
                  },
                ],
                temperature: 0.2,
                max_tokens: 8000,
              };
              if (provider === "openrouter" && payloadBase.provider) cssPayload.provider = payloadBase.provider;

              let cssText = "";
              try {
                cssText = await autoRetry(
                  async () => await callStreamRobust(cssPayload, "阶段4：页面样式 CSS", false, 180_000),
                  "页面样式",
                  "只输出 style.css 纯文本，不要解释，不要 JSON。",
                  2,
                );
              } catch (e: any) {
                logStep("css.request_failed", String(e?.message || e));
                return await failWithRetry(
                  "我刚刚在生成页面样式时遇到了网络问题。蓝图和页面结构已经保存好，点“重试”会直接从写代码继续。",
                  String(e?.message || e),
                );
              }

              logStep("css.raw", cssText);
              const cssContent = extractPlainCodeText(cssText, ["css"]);
              if (!cssContent.trim()) {
                logStep("css.empty", cssText);
                return await failWithRetry(
                  "我刚刚在生成页面样式时，没有拿到有效的 CSS 内容。你的蓝图和页面结构已保存，点“重试”会从写代码继续。",
                  cssText,
                );
              }
              const cssWrite = await writeDraftFilesDetailed([{ path: "style.css", content: cssContent }]);
              logStep("css.persist", cssWrite);
              const metaAfterCss = applyPersistStatus((await readMetaObj()) || readMeta || {}, "css", cssWrite, ["style.css"]);
              try {
                await writeMeta(metaAfterCss);
              } catch (e: any) {
                logStep("css.persist_meta_failed", String(e?.message || e));
              }
              if (!cssWrite.ok) {
                return await failWithRetry(
                  "页面样式已经生成出来了，但写回数据库时没有完全成功。点“重试”我会从已生成结果继续。",
                  JSON.stringify(cssWrite.failed),
                );
              }
              sendProgress({
                mode: "create",
                stepId: "css",
                stepLabel: "页面样式",
                status: "done",
                fileTargets: ["style.css"],
                detail: "style.css 已生成并落库",
              });
              return { css: cssContent };
            };
            const generateGameJsStep = async (html: string, css: string) => {
              let jsContent = "";
              if (!gameJsTwoStep) {
                sendStatus(`（5/${generationTotalSteps}）生成核心逻辑（${provider} / ${mvpModel}）…`);
                sendMeta({ provider, model, phase: "codegen_game_js" });
                sendProgress({
                  mode: "create",
                  stepId: "game_js",
                  stepLabel: "核心逻辑",
                  status: "running",
                  fileTargets: ["game.js"],
                  detail: "一次性生成完整 game.js",
                });
                const gameJsPayload: any = {
                  model,
                  messages: [
                    { role: "system", content: `${baseSystemPrompt}\n\n${CODEGEN_GAMEJS_PROMPT}` },
                    {
                      role: "user",
                      content:
                        `【用户最早的主题】\n${seedPrompt}\n\n` +
                        `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                        requirementContractBlock +
                        styleConsistencyBlock +
                        `【当前页面结构】\n${JSON.stringify([{ path: "index.html", content: html }, { path: "style.css", content: css }], null, 2)}\n\n` +
                        `${templateHint}\n` +
                        `请输出完整的 game.js 纯文本，不要输出 JSON。`,
                    },
                  ],
                  temperature: 0.2,
                  max_tokens: 8000,
                };
                if (provider === "openrouter" && payloadBase.provider) gameJsPayload.provider = payloadBase.provider;

                let gameJsText = "";
                try {
                  gameJsText = await autoRetry(
                    async () =>
                      await callStreamRobust(gameJsPayload, "阶段5：核心逻辑 JS", false, 180_000),
                    "核心逻辑",
                    "只输出 game.js 纯文本，不要解释，不要 JSON。",
                    2,
                  );
                } catch (e: any) {
                  logStep("game_js.request_failed", String(e?.message || e));
                  return await failWithRetry(
                    "我刚刚在生成核心逻辑时遇到了网络问题。蓝图和页面结构已经保存好，点“重试”会直接从写代码继续。",
                    String(e?.message || e),
                  );
                }
                logStep("game_js.raw", gameJsText);
                jsContent = extractPlainCodeText(gameJsText, ["js", "javascript"]);
              } else {
                sendStatus(`（5/${generationTotalSteps}）生成核心逻辑骨架（${provider} / ${mvpModel}）…`);
                sendMeta({ provider, model, phase: "codegen_game_js_skeleton" });
                sendProgress({
                  mode: "create",
                  stepId: "game_js_skeleton",
                  stepLabel: "核心逻辑骨架",
                  status: "running",
                  fileTargets: ["game.js"],
                  detail: "先生成结构完整的 game.js 骨架",
                });
                const gameJsSkeletonPayload: any = {
                  model,
                  messages: [
                    { role: "system", content: `${baseSystemPrompt}\n\n${CODEGEN_GAMEJS_SKELETON_PROMPT}` },
                    {
                      role: "user",
                      content:
                        `【用户最早的主题】\n${seedPrompt}\n\n` +
                        `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                        requirementContractBlock +
                        styleConsistencyBlock +
                        `【当前页面结构】\n${JSON.stringify([{ path: "index.html", content: html }, { path: "style.css", content: css }], null, 2)}\n\n` +
                        `${templateHint}\n` +
                        `请先输出一个结构完整、函数齐全、带启动入口的 game.js 骨架纯文本，不要输出 JSON。`,
                    },
                  ],
                  temperature: 0.2,
                  max_tokens: 8000,
                };
                if (provider === "openrouter" && payloadBase.provider) gameJsSkeletonPayload.provider = payloadBase.provider;

                let skeletonText = "";
                try {
                  skeletonText = await autoRetry(
                    async () =>
                      await callStreamRobust(gameJsSkeletonPayload, "阶段5：核心逻辑骨架 JS", false, 180_000),
                    "核心逻辑骨架",
                    "只输出 game.js 骨架纯文本，不要解释，不要 JSON。",
                    2,
                  );
                } catch (e: any) {
                  logStep("game_js_skeleton.request_failed", String(e?.message || e));
                  return await failWithRetry(
                    "我刚刚在生成核心逻辑骨架时遇到了网络问题。蓝图和页面结构已经保存好，点“重试”会直接从写代码继续。",
                    String(e?.message || e),
                  );
                }

                logStep("game_js_skeleton.raw", skeletonText);
                const skeletonJs = extractPlainCodeText(skeletonText, ["js", "javascript"]);
                if (!skeletonJs.trim()) {
                  logStep("game_js_skeleton.empty", skeletonText);
                  return await failWithRetry(
                    "我刚刚在生成核心逻辑骨架时，没有拿到有效的 JS 内容。你的蓝图和页面结构已保存，点“重试”会从写代码继续。",
                    skeletonText,
                  );
                }
                const skeletonErr = validateStandaloneJs(skeletonJs);
                if (skeletonErr) {
                  logStep("game_js_skeleton.syntax_error", skeletonErr);
                  return await failWithRetry(
                    "我刚刚生成的核心逻辑骨架没有闭合完整。蓝图和页面结构已保存，点“重试”我会直接从 JS 继续。",
                    skeletonErr,
                  );
                }

                sendStatus(`（6/${generationTotalSteps}）补全核心逻辑细节（${provider} / ${mvpModel}）…`);
                sendMeta({ provider, model, phase: "codegen_game_js_complete" });
                sendProgress({
                  mode: "create",
                  stepId: "game_js_complete",
                  stepLabel: "核心逻辑补全",
                  status: "running",
                  fileTargets: ["game.js"],
                  detail: "基于骨架补全业务细节与 must-have",
                });
                const gameJsCompletePayload: any = {
                  model,
                  messages: [
                    { role: "system", content: `${baseSystemPrompt}\n\n${CODEGEN_GAMEJS_COMPLETE_PROMPT}` },
                    {
                      role: "user",
                      content:
                        `【用户最早的主题】\n${seedPrompt}\n\n` +
                        `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                        requirementContractBlock +
                        styleConsistencyBlock +
                        `【当前页面结构】\n${JSON.stringify([{ path: "index.html", content: html }, { path: "style.css", content: css }], null, 2)}\n\n` +
                        `【当前 game.js 骨架】\n${skeletonJs}\n\n` +
                        `${templateHint}\n` +
                        `请基于这份骨架和上面的 must-have checklist 补全完整的 game.js 纯文本，不要输出 JSON。`,
                    },
                  ],
                  temperature: 0.2,
                  max_tokens: 8000,
                };
                if (provider === "openrouter" && payloadBase.provider) gameJsCompletePayload.provider = payloadBase.provider;

                let gameJsText = "";
                try {
                  gameJsText = await autoRetry(
                    async () =>
                      await callStreamRobust(gameJsCompletePayload, "阶段6：补全核心逻辑 JS", false, 180_000),
                    "核心逻辑补全",
                    "基于已有骨架补全 game.js 纯文本，不要解释，不要 JSON。",
                    2,
                  );
                } catch (e: any) {
                  logStep("game_js_complete.request_failed", String(e?.message || e));
                  return await failWithRetry(
                    "我刚刚在补全核心逻辑时遇到了网络问题。蓝图和页面结构已经保存好，点“重试”会直接从写代码继续。",
                    String(e?.message || e),
                  );
                }

                logStep("game_js_complete.raw", gameJsText);
                jsContent = extractPlainCodeText(gameJsText, ["js", "javascript"]);
              }
              if (!jsContent.trim()) {
                logStep("game_js.empty", { twoStep: gameJsTwoStep });
                return await failWithRetry(
                  "我刚刚在生成核心逻辑时，没有拿到有效的 JS 内容。你的蓝图和页面结构已保存，点“重试”会从写代码继续。",
                  "",
                );
              }
              let jsSyntaxErr = validateStandaloneJs(jsContent);
              if (jsSyntaxErr) {
                logStep("game_js.syntax_error", jsSyntaxErr);
                sendStatus("核心逻辑看起来没生成完整，我先自动修一次 JS 语法…");
                const repairPayload: any = {
                  model,
                  messages: [
                    { role: "system", content: `${baseSystemPrompt}\n\n${SINGLE_FILE_PATCH_PROMPT}\n- 目标文件：game.js\n- 这次只修 JS 语法和截断问题，优先补全括号、函数体、对象、数组和字符串，不要重写业务逻辑。` },
                    {
                      role: "user",
                      content:
                        `【用户最早的主题】\n${seedPrompt}\n\n` +
                        `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                        styleConsistencyBlock +
                        `【当前页面结构】\n${JSON.stringify([{ path: "index.html", content: html }, { path: "style.css", content: css }], null, 2)}\n\n` +
                        `【当前损坏的 game.js】\n${jsContent}\n\n` +
                        `【语法错误】\n${jsSyntaxErr}\n\n` +
                        `请只输出修复后的 game.js 纯文本。`,
                    },
                  ],
                  temperature: 0.1,
                  max_tokens: 8000,
                };
                if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
                try {
                  const repairedJsText = await callStreamRobust(repairPayload, "阶段5：修复核心逻辑 JS", false, 120_000);
                  const repairedJs = extractPlainCodeText(repairedJsText, ["js", "javascript"]);
                  if (repairedJs.trim()) {
                    const repairedErr = validateStandaloneJs(repairedJs);
                    logStep("game_js.repair_result", { before: jsSyntaxErr, after: repairedErr || "ok" });
                    if (!repairedErr) {
                      jsContent = repairedJs;
                      jsSyntaxErr = "";
                    }
                  }
                } catch (e: any) {
                  logStep("game_js.repair_failed", String(e?.message || e));
                }
              }
              if (jsSyntaxErr) {
                return await failWithRetry(
                  "我刚刚生成的核心逻辑没有闭合完整，自动修复这次也没成功。蓝图和页面结构已保存，点“重试”我会直接从 JS 继续。",
                  jsSyntaxErr,
                );
              }
              const gameJsWrite = await writeDraftFilesDetailed([{ path: "game.js", content: jsContent }]);
              logStep("game_js.persist", gameJsWrite);
              const metaAfterGameJs = applyPersistStatus((await readMetaObj()) || readMeta || {}, "game_js", gameJsWrite, ["game.js"]);
              try {
                await writeMeta(metaAfterGameJs);
              } catch (e: any) {
                logStep("game_js.persist_meta_failed", String(e?.message || e));
              }
              if (!gameJsWrite.ok) {
                return await failWithRetry(
                  "核心逻辑已经生成出来了，但写回数据库时没有完全成功。点“重试”我会从已生成结果继续。",
                  JSON.stringify(gameJsWrite.failed),
                );
              }
              sendProgress({
                mode: "create",
                stepId: gameJsTwoStep ? "game_js_complete" : "game_js",
                stepLabel: gameJsTwoStep ? "核心逻辑补全" : "核心逻辑",
                status: "done",
                fileTargets: ["game.js"],
                detail: "game.js 已生成并落库",
              });
              return { jsContent };
            };

            const htmlStep = await generateHtmlStep();
            if (!htmlStep) return;
            const { meta, html } = htmlStep;

            const cssStep = await generateCssStep(html);
            if (!cssStep) return;
            const { css } = cssStep;

            const gameJsStep = await generateGameJsStep(html, css);
            if (!gameJsStep) return;
            const { jsContent } = gameJsStep;

            const metaNow = await lockMetaTitle(applyFirstSuccessTiming({
              ...meta,
              _gen: {
                ...(genState || {}),
                v: 1,
                stage: "code_done",
                ...(activeConfig ? { config: activeConfig } : {}),
                ...(requirementContract ? { requirementContract } : {}),
                clarify: undefined,
                persist: {
                  step: "finalized",
                  ok: true,
                  expected: ["index.html", "style.css", "game.js"],
                  written: ["index.html", "style.css", "game.js"],
                  failed: [],
                  updatedAt: Date.now(),
                },
                updatedAt: Date.now(),
              },
            }), meta?.title || "", "blueprint");
            const finalFiles: Array<{ path: string; content: string }> = [
              { path: "index.html", content: html },
              { path: "style.css", content: css },
              { path: "game.js", content: jsContent },
            ];
            let stableFiles = finalFiles;
            const acceptance = await validateAcceptanceSimple(finalFiles);
            const acceptanceErrs = acceptance.blockers;
            sendProgress({
              mode: "create",
              stepId: "validate",
              stepLabel: "验收与落库",
              status: "running",
              fileTargets: ["index.html", "style.css", "game.js"],
              detail: "执行最终强验收",
            });
            logStep("final.acceptance", {
              ok: acceptanceErrs.length === 0,
              errors: acceptanceErrs,
              warnings: acceptance.warnings,
              files: finalFiles,
            });
            if (acceptanceErrs.length) {
              return await failWithRetry(
                "我已经把三个文件都生成出来了，但首次联调检查没通过。蓝图和代码草稿已保存，点“重试”我会继续修。",
                acceptanceErrs.join("\n"),
              );
            }
            await writeMeta(metaNow);
            logStep("final.persisted", { title: metaNow.title, stage: metaNow?._gen?.stage, files: finalFiles });
            sendProgress({
              mode: "create",
              stepId: "validate",
              stepLabel: "验收与落库",
              status: "done",
              fileTargets: ["index.html", "style.css", "game.js"],
              detail: "三个文件已通过验收并写回草稿",
            });

            const metaFinal = (await readMetaObj()) || metaNow;
            const assistantText = `已生成可运行版本：${String((metaFinal as any)?.title || meta.title || "").trim() || "未命名作品"}。`;
            const finalObj = {
              assistant: assistantText,
              meta: metaFinal,
              files: [...stableFiles, { path: "meta.json", content: JSON.stringify(metaFinal, null, 2) }],
            };
            parseCreatorJson(JSON.stringify(finalObj));
            send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
            clearInterval(heartbeat);
            controller.close();
            return;
          }

      } catch (e: any) {
        try {
          sendProgress({
            stepId: progressStepId || "error",
            stepLabel: progressStepLabel || "执行失败",
            status: "failed",
            error: String(e?.message || e || "").slice(0, 300),
            detail: String(e?.message || e || "").slice(0, 180),
          });
        } catch {}
        send("error", { ok: false, error: String(e?.message || e) });
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
