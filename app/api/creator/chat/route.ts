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

const OPENROUTER_MODELS = [
  // 默认：免费模型（用户要求）
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3.6-plus",
  "qwen/qwen-2.5-72b-instruct:free",
  "deepseek/deepseek-v3.2",
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

// ===== “骨架增长 + 迭代补丁”生成架构（默认开启）=====
// 核心目标：先拿到单文件可运行 MVP（闭环），再迭代补丁；避免多文件分步“上下文漂移”导致不可用。
const ARCHITECT_PROMPT = `
你是“架构师（Architect）”。你的任务不是写最终代码，而是把用户的一句话需求转成一份“协议蓝图”，为后续所有生成/补丁提供统一约束，保证变量命名与交互一致。

【输出要求】
1) 只输出合法 JSON，不要输出任何 Markdown/解释文字。
2) 必须包含 meta、protocol、acceptance：
   - meta：用于 meta.json（title/shortDesc/rules/creator{name}）
   - protocol：全局状态/事件/DOM 协议（命名约定就是“法律”）
   - acceptance：可运行验收清单（可自动检查的项）

【JSON Schema（必须符合）】
{
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "protocol": {
    "globalState": { "stateMachine": ["start","playing","win","lose"], "vars": [{"name":"score","type":"number","purpose":"..."}] },
    "dom": { "rootId": "app", "canvasId": "gameCanvas", "startBtnId": "btnStart", "hudIds": ["hudScore","hudInfo"] },
    "events": ["startGame","resetGame","tick","render"],
    "gameLoop": { "tickMs": 16, "functions": ["init","reset","update","render"] }
  },
  "acceptance": {
    "mustHave": [
      "index.html 内含一个 <style> 和一个 <script>（单文件 MVP）",
      "无 JS 语法错误（可被静态解析）",
      "点击开始可进入 playing，结束后可回到 start/over"
    ]
  }
}
`.trim();

const MVP_PROMPT = `
你是“程序员（Skeleton Builder）”。请基于架构师蓝图，生成一个“单文件 MVP（index.html）”，把 CSS/JS 全部内联在同一个 HTML 文件里。

【目标】
- 先做“能跑起来”的最小可运行版本（MVP），主循环与基础 UI 完整闭环。
- 代码尽量控制在 200~450 行左右，避免超长输出。

【硬性要求】
1) 只输出合法 JSON，不要输出 markdown/解释。
2) 输出结构必须是：
{
  "assistant": "一句话说明你生成了什么",
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "files": [{ "path": "index.html", "content": "..." }]
}
3) index.html 里必须包含：
   - <!-- AI_MVP_SINGLE_FILE v1 -->
   - 一个 <style>（内联样式）
   - 一个 <script>（内联逻辑）
4) 不依赖任何外部库。
`.trim();

const REFINE_PROMPT = `
你是“程序员（Refiner）”。你将基于“当前可运行代码 + 架构协议 + 用户新需求”，输出最小风险的全量替换版本（或多文件时输出必要文件）。

【硬性要求】
1) 只输出合法 JSON，不要输出 markdown/解释。
2) 输出结构优先使用轻量补丁：
{ "assistant": "...", "ops": [ ... ] }
如果确实需要返回完整文件，也可以用：
{ "assistant": "...", "files": [ { "path": "...", "content": "..." } ] }
3) ops 仅允许使用这些类型：
   - replace_in_file: { "type":"replace_in_file", "path":"index.html|style.css|game.js", "find":"原片段", "replace":"新片段" }
   - remove_in_file: { "type":"remove_in_file", "path":"...", "find":"要删除的片段" }
   - insert_before: { "type":"insert_before", "path":"...", "find":"锚点片段", "content":"插入内容" }
   - insert_after: { "type":"insert_after", "path":"...", "find":"锚点片段", "content":"插入内容" }
   - append_in_file: { "type":"append_in_file", "path":"...", "content":"追加内容" }
   - prepend_in_file: { "type":"prepend_in_file", "path":"...", "content":"前置内容" }
4) 只允许改这些文件：index.html / style.css / game.js
5) 最小改动原则：不要无意义重写；保持原有结构与命名协议。
6) 严禁通过“额外注入一个兜底脚本”来偷改行为。
   - 不要输出带 data-ai-local-behavior 的 style/script
   - 不要用 MutationObserver + setInterval 轮询 DOM 的方式强行修页面
   - 优先直接改现有按钮、状态流、事件绑定和文案
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

// 单模型单次生成（稳定优先）：一次性输出“蓝图 + 代码”（仍为单文件），再做最小校验/一次自愈
// 注意：不要求/不输出“内心独白”，而是输出可读的“蓝图/伪代码/资源方案”，避免泄露推理过程且更稳定。
const MONOLITH_MVP_PROMPT = `
你是“前端小游戏生成器”。请根据用户的一句话需求，在一次输出中同时给出：
1) 游戏蓝图（可读的结构化说明 + 伪代码）
2) 资源/渲染方案（Canvas 或 SVG，说明理由与关键资产）
3) 最终可运行代码（单文件 index.html，内联 CSS/JS）

【硬性要求】
1) 只输出合法 JSON（json_object），不要任何解释或 markdown。
2) 输出结构必须为：
{
  "assistant": "一句话说明已生成什么",
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "blueprint": {
    "coreLoop": "一句话描述核心循环",
    "states": ["start","playing","gameover"],
    "pseudocode": ["步骤1 ...", "步骤2 ..."],
    "controls": ["..."],
    "winLose": "结束判定"
  },
  "assets": {
    "renderer": "canvas|svg",
    "reasons": ["为什么选它"],
    "sprites": ["需要的图形元素列表（用程序绘制即可）"]
  },
  "files": [
    { "path": "index.html", "content": "..." }
  ]
}
3) files 里必须且只能包含 index.html；index.html 必须包含：
   - <!-- AI_MVP_SINGLE_FILE v1 -->
   - 一个 <style>（内联样式）
   - 一个 <script>（内联逻辑）
4) 不依赖任何外部库，不要引用外部 CDN。
5) 目标是“最小可运行版本”：点击开始/重开可玩；保证无明显 JS 语法错误。
6) 为避免输出过长导致 JSON 被截断：blueprint / assets 必须简短：
   - blueprint.pseudocode 最多 8 条
   - assets.reasons 最多 3 条
   - assets.sprites 最多 8 条
7) 如果脚本里存在开始/重开/句子展示等核心动作，请尽量暴露：
   window.gameHooks = {
     start(){},
     restart(){},
     setAutoStart(enabled){},
     setCurrentSentence(text){},
     showCurrentSentence(enabled){}
   }
   没有对应能力时可以是空实现，但名字必须稳定，方便后续小改动复用。
8) 严禁输出 data-ai-local-behavior 之类的注入脚本；不要用 MutationObserver + 轮询去“外挂式”修改页面。
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

// 配置表生成（第二步）：基于用户选择/回答生成“参数配置表 JSON”，仍然不写代码。
const CONFIG_PROMPT = `
你现在是“青少年友好”的小游戏配置生成器（面向小学/初中）。
你要把用户刚才点选的答案，变成一份“游戏配置表 JSON”，方便下一步写代码。

【铁律】
1) 严禁输出任何代码（HTML/CSS/JS），只输出 JSON。
2) 配置要简单、可理解：不要出现专业术语；用“速度/难度/颜色/按钮文字”这种词。
3) 如果用户没选某个点，用合理默认值（更偏简单、好上手）。
4) 规则文字 rules 必须用青少年能读懂的话说明“怎么玩、怎么得分、什么时候结束”。

【输出要求：只输出合法 JSON（json_object）】
Schema：
{
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "config": {
    "platform": "pc|mobile|both",
    "style": {
      "theme": "卡通|像素|霓虹",
      "colors": { "bg": "#...", "accent": "#..." }
    },
    "controls": {
      "pc": { "left": "ArrowLeft", "right": "ArrowRight" },
      "mobile": { "type": "virtual_left", "releaseAutoCenter": true }
    },
    "level": {
      "min": 1,
      "max": 10,
      "meaning": "等级越高越难（更快/障碍更多/回正更慢）"
    },
    "numbers": {
      "speedBase": 7,
      "speedPerLevel": 0.9,
      "autoCenterBase": 0.12,
      "autoCenterPerLevel": -0.007
    },
    "gameplay": {
      "mode": "endless|levels|time",
      "score": ["distance","stars"],
      "endOnCrash": true
    },
    "ui": {
      "texts": { "start": "开始", "restart": "重开", "pause": "暂停" },
      "showHud": true
    }
  },
  "needConfirm": ["如果还有必须确认的点，用很简单的句子列出来；没有就给空数组"]
}
`.trim();

// 蓝图阶段（新）：一次输出“同源蓝图 + 协议/命名 + config”，但严禁输出任何代码。
// 这一步输出短 JSON，稳定落盘；下一步代码生成必须严格按此 JSON 实现，避免变量/规则漂移。
const BLUEPRINT_PROMPT = `
你现在是“青少年友好”的小游戏设计师（面向小学/初中）。你要先做设计蓝图，再写代码（代码在下一步做）。

【铁律】
1) 严禁输出任何代码（HTML/CSS/JS），只输出 JSON（json_object）。
2) 你必须先把“关键命名/协议”定下来，后续写代码必须一模一样（比如：canvasId、按钮id、全局对象名、关键变量名）。
3) 蓝图要短、清楚、孩子能读懂；不要写长篇。
4) 必须紧扣【用户最早的主题】，不能跑题。

【输出要求：只输出合法 JSON（json_object）】
Schema：
{
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "config": { ...（沿用 CONFIG_PROMPT 的 config 结构，缺啥就用默认值）... },
  "protocol": {
    "dom": { "rootId": "app", "canvasId": "game", "btnStartId": "btnStart", "btnRestartId": "btnRestart", "btnLeftId": "btnLeft" },
    "state": { "name": "G", "vars": ["level","score","state","speed","autoCenter"] }
  },
  "blueprint": {
    "type": "A|B|C|D|E|F",
    "coreLoop": "一句话核心循环",
    "steps": ["1 ...","2 ...","3 ..."],
    "winLose": "什么时候结束/怎么算赢"
  },
  "assetsPlan": { "renderer": "canvas", "sprites": ["元素1","元素2","元素3"] }
}
`.trim();

// 代码生成（第三步）：一次性输出“蓝图 + 代码”，并严格按照 config 实现（服务端仍可拆分为三文件）。
const CODEGEN_FROM_CONFIG_PROMPT = `
你是“前端小游戏生成器”。你会收到一份已经确认好的蓝图 JSON（其中包含 meta/config/protocol/blueprint/assetsPlan）。
你的任务是严格按照这份蓝图生成最终可运行代码。

【硬性要求】
1) 只输出合法 JSON（json_object），不要任何解释或 markdown。
2) 输出结构必须为：
{
  "assistant": "一句话说明已生成什么",
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "files": [ { "path": "index.html", "content": "..." } ]
}
3) index.html 必须包含：
   - <!-- AI_MVP_SINGLE_FILE v1 -->
   - 一个 <style>（内联样式）
   - 一个 <script>（内联逻辑）
4) 不依赖外部库/CDN。
5) 必须严格遵守蓝图中的命名、DOM id、状态字段、玩法规则、控制方式和渲染方案，不要擅自改协议。
6) 优先复用成熟玩法骨架，不要每次从零发明结构；但如果模板建议与用户需求冲突，以用户需求和蓝图为准。
7) 目标是“最小但完整的高质量版本”：能开始、能重开、反馈清楚、按钮清晰、手机和桌面至少有一种适配正确。
8) 严禁再次输出 blueprint/protocol/assetsPlan 字段，它们已经在上一步生成并落盘。
9) 如果输出包含 game.js，必须暴露统一接口：
   window.gameHooks = {
     start(){},
     restart(){},
     setAutoStart(enabled){},
     setCurrentSentence(text){},
     showCurrentSentence(enabled){}
   }
   这些接口可以是薄封装，但名字必须稳定，供后续增量编辑复用。
10) 严禁在 index.html 里额外注入“本地行为补丁脚本”去劫持开始按钮、轮询句子或观察整个 DOM。
`.trim();

const CODEGEN_HTML_CSS_PROMPT = `
你是“前端小游戏页面生成器”。你会收到一份已经确认好的蓝图 JSON（其中包含 meta/config/protocol/blueprint/assetsPlan）。
你的任务是先生成稳定的页面结构和样式，只输出 index.html 与 style.css。

【硬性要求】
1) 只输出合法 JSON（json_object），不要任何解释或 markdown。
2) 输出结构必须为：
{
  "assistant": "一句话说明已生成什么",
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "style.css", "content": "..." }
  ]
}
3) index.html 必须正确引用 ./style.css 和 ./game.js，但不要内联大段脚本逻辑。
4) style.css 负责主要布局和视觉表现；先保证结构清楚、DOM id 稳定。
5) 严禁输出 game.js。
6) 严禁输出 data-ai-local-behavior 之类的注入脚本；不要用 MutationObserver + 轮询去外挂式修改页面。
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

type IncrementalEditProfile = {
  kind: "content" | "layout" | "visual" | "behavior" | "bugfix" | "feature";
  confidence: number;
  hint: string;
};

function classifyIncrementalEdit(text: string): IncrementalEditProfile | null {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^(做|生成|创建|写|帮我做一个|给我做一个)/.test(t)) return null;
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

function pickDirectRefinePaths(kind: IncrementalEditProfile["kind"], hasSplit: boolean, userIntent = "") {
  const intent = String(userIntent || "");
  if (!hasSplit) return ["index.html"];
  if (kind === "visual") return ["index.html", "style.css"];
  if (kind === "layout") return ["index.html", "style.css"];
  if (kind === "content") return ["index.html", "game.js"];
  if (kind === "behavior") {
    // 行为类小改动默认只改 game.js，避免把页面结构和玩法逻辑一起塞给模型。
    // 对“自动开始/跳过开始页/按进度显示句子”这类请求，单文件补丁更快也更稳。
    if (/(自动开始|直接开始|跳过开始|去掉开始页|开始页|开始按钮|不用点击开始|按进度显示|当前句子|当前文本|句子)/i.test(intent)) {
      return ["game.js"];
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

  const writeFiles = async (files: Array<{ path: string; content: string }>) => {
    for (const f of files) {
      const path = String(f?.path || "").trim();
      if (!path) continue;
      await writeFile(path, String(f?.content || ""));
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

  return { readFile, readFiles, writeFile, writeFiles, writeFilesDetailed, readMeta, writeMeta };
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

function pickOpenRouterModel(prefer: string[]) {
  for (const m of prefer) {
    if ((OPENROUTER_MODELS as readonly string[]).includes(m)) return m;
  }
  return OPENROUTER_MODELS[0];
}

function pickAlternateOpenRouterModel(current: string, prefer: string[]) {
  const cur = String(current || "").trim();
  for (const m of prefer) {
    const mm = String(m || "").trim();
    if (!mm || mm === cur) continue;
    if ((OPENROUTER_MODELS as readonly string[]).includes(mm)) return mm;
  }
  return "";
}

function envModelOrEmpty(key: string) {
  return String(process.env[key] || "").trim();
}

function envFlag(key: string) {
  const v = String(process.env[key] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const ownerKey = ownerKeyFromSession(sess);

  let body: { messages?: Msg[]; model?: string; provider?: string; promptAddon?: string; gameId?: string; mode?: string; quality?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }
  const gameId = String((body as any)?.gameId || "").trim();
  const safeGameId = gameId && /^[a-zA-Z0-9_-]+$/.test(gameId) ? gameId : "";
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
  let provider: "openrouter" | "deepseek" | "bailian" = "openrouter";
  if (providerRaw === "deepseek") provider = "deepseek";
  else if (providerRaw === "openrouter") provider = "openrouter";
  else if (providerRaw === "bailian" || providerRaw === "dashscope") provider = "bailian";
  else provider = hasBailian ? "bailian" : hasOpenRouter ? "openrouter" : "deepseek";

  let url = "";
  let authKey = "";
  let model = "";
  if (provider === "deepseek") {
    authKey = process.env.DEEPSEEK_API_KEY || "";
    if (!authKey) {
      // DeepSeek 未配置时自动回退 OpenRouter
      if (hasBailian) {
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
    const envModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
    model = picked === "deepseek-chat" || picked === "deepseek-reasoner" ? picked : envModel;
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
          signal: AbortSignal.timeout(120_000),
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
  const systemPrompt = `${serverBasePrompt}${CREATOR_OUTPUT_FORMAT_ADDON}${antiCoT}${safeAddon ? `\n\n【用户补充要求】\n${safeAddon}\n` : ""}`;

  // ===== Streaming SSE =====
  const payloadBase: any = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
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

  async function callModelStream(payload: any, timeoutMs = 180_000) {
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

  async function callModelOnce(payload: any, timeoutMs = 180_000) {
    // 尽量也用 json_object，减少模型“解释/思考”导致的超长输出；
    // 如果不兼容，再自动退回普通模式。
    const p0 = { ...payload, stream: false };
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
      const content = j?.choices?.[0]?.message?.content;
      if (!content) throw new Error("EMPTY_MODEL_RESPONSE");
      return String(content);
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
      const p1 = { ...p0 };
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

      let full = "";
      const sendStatus = (text: string) => send("status", { text });
      const sendMeta = (data: any) => send("meta", data);
      const sendDelta = (text: string) => send("delta", { text });
      // SSE 心跳：避免部分网关/代理在“长时间无数据”时主动断开
      const heartbeat = setInterval(() => {
        try {
          send("ping", { t: Date.now() });
        } catch {}
      }, 12000);

      let resp: Response | null = null;
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

        // 默认走分步生成；若用户补充要求里包含 legacy_single_shot 则强制使用旧模式
        const forceLegacy = safeAddon.includes("legacy_single_shot");

        const canFallbackDeepSeek = !!(process.env.DEEPSEEK_API_KEY || "");
        const canFallbackBailian = !!(process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "");
        const fallbackToDeepSeek = async () => {
          provider = "deepseek";
          authKey = process.env.DEEPSEEK_API_KEY || "";
          const baseUrl = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
          url = `${baseUrl}/v1/chat/completions`;
          model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
          // 通知前端：已经回退
          sendMeta({ provider, model, reason: "fallback_openrouter_fetch_failed" });
        };
        const fallbackToBailian = async () => {
          provider = "bailian";
          authKey = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "";
          const baseUrl = (process.env.DASHSCOPE_BASE_URL || process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1")
            .replace(/\/+$/, "");
          url = `${baseUrl}/chat/completions`;
          model = process.env.BAILIAN_MODEL || process.env.DASHSCOPE_MODEL || "qwen3.6-plus";
          sendMeta({ provider, model, reason: "fallback_to_bailian" });
        };

        // 对分步生成：每一步也做“流式输出”并把 token 增量推给前端，让用户看到进度
        const callStreamToString = async (payload: any, stepTag: string, strictJson = false, timeoutMs = 180_000) => {
          // payload.stream 必须为 true
          const p0: any = { ...payload, stream: true };
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
                return await callModelOnce({ ...p, stream: false }, timeoutMs);
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
            const IDLE_MS = 25_000; // 上游 25s 无任何数据则认为卡死，转为非流式
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
                const delta = j?.choices?.[0]?.delta?.content ?? "";
                if (typeof delta === "string" && delta) {
                  out += delta;
                  sendDelta(delta);
                }
              }
            }
            if (!out.trim()) throw new Error("EMPTY_MODEL_RESPONSE");
            return out;
          };
          // 在流式输出中插入一个小分隔符，避免用户看不懂现在在做哪一步
          sendDelta(`\n\n—— ${stepTag} ——\n`);
          try {
            return await doReq(p0);
          } catch (e) {
            // 对需要“严格 JSON”的阶段：不要直接去掉 response_format（会显著增加非 JSON 概率）。
            // 改用一次非流式兜底，再返回文本用于解析。
            if (strictJson) {
              sendStatus("该步骤需要严格 JSON，我用非流式方式再试一次…");
              const once = await callModelOnce({ ...payload, stream: false }, timeoutMs);
              // 也把结果推给前端，让用户看到发生了什么（不然会像“卡住”）
              sendDelta(`\n\n（非流式结果）\n${once}\n`);
              return once;
            }
            // 非严格场景：retry without response_format（某些模型/网关不支持）
            const p1: any = { ...p0 };
            delete p1.response_format;
            return await doReq(p1);
          }
        };

        const callStreamRobust = async (
          payload: any,
          stepTag: string,
          strictJson = false,
          fallbackModels: string[] = [],
          timeoutMs = 180_000,
        ) => {
          try {
            return await callStreamToString(payload, stepTag, strictJson, timeoutMs);
          } catch (e: any) {
            const em = String(e?.message || e);
            const eml = em.toLowerCase();
            const isNetwork = eml.includes("fetch_failed") || eml.includes("network error") || eml.includes("timeout");

            // OpenRouter 链路级失败：直接切到 DeepSeek 官方 API（不经过 OpenRouter）
            // 典型：FETCH_FAILED / timeout / gateway / 5xx / region 等。
            const openrouterDown =
              eml.includes("fetch_failed") ||
              eml.includes("network error") ||
              eml.includes("timeout") ||
              eml.includes("gateway") ||
              eml.includes("service unavailable") ||
              eml.includes("overloaded") ||
              eml.includes("not available in your region");
            if (provider === "openrouter" && openrouterDown) {
              // 优先回退到百炼（如果配置了），其次直连 DeepSeek
              if (canFallbackBailian) {
                sendStatus("OpenRouter 不稳定/不可达，我切到阿里云百炼（DashScope）再试一次…");
                await fallbackToBailian();
                const p2: any = { ...payload, model };
                delete p2.provider;
                return await callStreamToString(p2, stepTag, strictJson, timeoutMs);
              }
              if (canFallbackDeepSeek) {
                sendStatus("OpenRouter 不稳定/不可达，我切到 DeepSeek 官方 API 再试一次…");
                await fallbackToDeepSeek();
                // 关键：切 provider 后必须同时切 payload.model，否则会把 OpenRouter 的 model id 发给 DeepSeek
                const p2: any = { ...payload, model };
                delete p2.provider;
                return await callStreamToString(p2, stepTag, strictJson, timeoutMs);
              }
            }

            // 百炼链路失败：回退 DeepSeek
            const bailianDown = provider === "bailian" && isNetwork;
            if (bailianDown && canFallbackDeepSeek) {
              sendStatus("百炼连接不稳定/不可达，我切到 DeepSeek 官方 API 再试一次…");
              await fallbackToDeepSeek();
              const p2: any = { ...payload, model };
              delete p2.provider;
              return await callStreamToString(p2, stepTag, strictJson, timeoutMs);
            }
            throw e;
          }
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
        if (mode === "fix") {
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

          // 默认用 coderModel（DeepSeek/Qwen），但若用户当前选择就是别的，也允许；并在不稳定时自动换到 Qwen/DeepSeek
          const fixModel = provider === "openrouter" ? pickOpenRouterModel(["deepseek/deepseek-v3.2", "qwen/qwen3.6-plus"]) : model;
          if (provider === "openrouter") model = fixModel;
          sendMeta({ provider, model, phase: "fix", gameId: safeGameId });

          const trim = (s: string) => (s.length > 12000 ? s.slice(0, 12000) + "\n<!-- ...TRUNCATED... -->" : s);
          const fixInput =
            `【Bug 描述】\n${lastUser || "（用户未提供具体 bug 描述）"}\n\n` +
            `【当前文件】\n` +
            `index.html:\n${trim(indexHtml)}\n\n` +
            `style.css:\n${trim(styleCss)}\n\n` +
            `game.js:\n${trim(gameJs)}\n`;

          const fixPayload: any = {
            model,
            messages: [
              { role: "system", content: FIXER_PROMPT },
              { role: "user", content: fixInput },
            ],
            temperature: 0.2,
            max_tokens: 1600,
            response_format: { type: "json_object" },
          };
          if (provider === "openrouter" && payloadBase.provider) fixPayload.provider = payloadBase.provider;

          const outText = await callStreamRobust(fixPayload, `步骤 ${step}/${totalSteps}：生成补丁 JSON`, true, [
            "qwen/qwen3.6-plus",
            "deepseek/deepseek-v3.2",
          ]);
          const obj = parseJsonObjectLoose(outText);
          if (!obj) throw new Error("FIXER_NOT_JSON");
          // 复用 parseCreatorJson 来做路径/结构校验
          const normalized = {
            assistant: String((obj as any).assistant || "已修复。").trim(),
            files: Array.isArray((obj as any).files) ? (obj as any).files : [],
          };
          parseCreatorJson(JSON.stringify(normalized));

          // 可选：服务端也写一份，确保断点续跑时立即生效（前端也会再写一次）
          try {
            for (const f of normalized.files) {
              const p = String((f as any)?.path || "").trim();
              const c = String((f as any)?.content || "");
              if (["index.html", "style.css", "game.js"].includes(p) && c.trim()) await upsertDraftFile(p, c);
            }
          } catch {}

          send("final", { ok: true, content: JSON.stringify(normalized), repaired: false });
          clearInterval(heartbeat);
          controller.close();
          return;
          }
        }

        if (!forceLegacy) {
          // ===== 稳定模式（默认）：单模型单次生成 + 最小后处理 =====
          // 目标：减少模型调用次数（失败点），避免阶段3卡住；先交付可运行 MVP，再逐步迭代。
          const generationMode = (envModelOrEmpty("CREATOR_GENERATION_MODE") || "evolve").toLowerCase(); // monolith | evolve
          if (generationMode !== "evolve") {
            const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY || "");
            if (!safeGameId || !ownerKey) throw new Error("MISSING_GAME_ID");

            await ensureCreatorDraftTables();
            const owns = await db.execute(sql`
              select 1
              from creator_draft_games
              where id = ${safeGameId} and owner_key = ${ownerKey}
              limit 1
            `);
            const ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
            if (!ownRows.length) throw new Error("NOT_YOUR_GAME");

            const draftStore = createDraftStore(safeGameId);
            const upsertDraftFile = async (path: string, content: string) => await draftStore.writeFile(path, content);
            const writeDraftFiles = async (files: Array<{ path: string; content: string }>) => await draftStore.writeFiles(files);
            const writeDraftFilesDetailed = async (files: Array<{ path: string; content: string }>) => await draftStore.writeFilesDetailed(files);
            const readDraftFile = async (path: string) => await draftStore.readFile(path);
            const readDraftFiles = async (paths: string[]) => await draftStore.readFiles(paths);
            const readMetaObj = async () => await draftStore.readMeta();
            const writeMetaObj = async (metaObj: any) => await draftStore.writeMeta(metaObj);
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

            const validateScripts = (html: string, jsExtra = "") => {
              const err: string[] = [];
              const jsFromHtml = (h: string) => {
                if (!h) return "";
                const blocks: string[] = [];
                const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
                let m: RegExpExecArray | null;
                while ((m = re.exec(h))) {
                  const attrs = String(m[1] || "");
                  if (/src\s*=/.test(attrs)) continue;
                  blocks.push(String(m[2] || ""));
                }
                return blocks.join("\n\n");
              };
              try {
                const js = [jsFromHtml(html), String(jsExtra || "")].filter(Boolean).join("\n\n");
                if (js.trim()) new Script(js);
              } catch (e: any) {
                err.push(`index.html 内联脚本语法错误：${String(e?.message || e)}`);
              }
              return err;
            };

            const readLastGood = async () => {
              const meta = (await readMetaObj()) || {};
              const lg = (meta as any)?._gen?.lastGood;
              if (!lg || typeof lg !== "object") return null;
              const files = Array.isArray(lg.files) ? lg.files : [];
              const normalized = files
                .map((f: any) => ({ path: String(f?.path || "").trim(), content: String(f?.content || "") }))
                .filter((f: any) => ["index.html", "style.css", "game.js"].includes(f.path) && f.content.trim());
              if (!normalized.find((f: any) => f.path === "index.html")) return null;
              return { meta, files: normalized };
            };
            const setLastGood = async (metaObj: any, files: Array<{ path: string; content: string }>, note: string) => {
              const m = metaObj && typeof metaObj === "object" ? metaObj : {};
              const pick = files
                .filter((f) => ["index.html", "style.css", "game.js"].includes(f.path))
                .map((f) => ({ path: f.path, content: String(f.content || "") }));
              const blob = pick.map((f) => `${f.path}\n${f.content}`).join("\n\n");
              (m as any)._gen = {
                ...(m as any)._gen,
                stage: "monolith_mvp",
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
            const restoreLastGood = async (reason: string) => {
              const lg = await readLastGood();
              if (!lg) throw new Error(`NO_LAST_GOOD:${reason}`);
              sendStatus(`生成遇到问题（${reason}），已回滚到上一次可用版本。`);
              await writeDraftFiles(lg.files);
              return lg;
            };

            const splitSingleFile = (html: string) => {
              const raw = String(html || "");
              // 不强制要求标记，尽量拆；拆不出来就返回 null
              const styleBlocks: string[] = [];
              const scriptBlocks: string[] = [];
              let out = raw;
              out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, c) => {
                styleBlocks.push(String(c || ""));
                return "";
              });
              out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs, c) => {
                const a = String(attrs || "");
                if (/src\s*=/.test(a)) return _m;
                scriptBlocks.push(String(c || ""));
                return "";
              });
              const css = styleBlocks.join("\n\n").trim();
              const js = scriptBlocks.join("\n\n").trim();
              if (!css || !js) return null;
              if (!/href\s*=\s*["']\.\/style\.css["']/.test(out)) {
                out = out.replace(/<\/head>/i, `  <link rel="stylesheet" href="./style.css" />\n</head>`);
              }
              if (!/src\s*=\s*["']\.\/game\.js["']/.test(out)) {
                out = out.replace(/<\/body>/i, `  <script src="./game.js"></script>\n</body>`);
              }
              return { index: out.trim() + "\n", css: css + "\n", js: js + "\n" };
            };
            const validateAcceptanceSimple = (files: Array<{ path: string; content: string }>) => {
              const index = files.find((f) => f.path === "index.html")?.content || "";
              const js = files.find((f) => f.path === "game.js")?.content || "";
              const errs = validateScripts(index, js);
              const hasCss = !!files.find((f) => f.path === "style.css")?.content;
              const hasJs = !!js.trim();
              if (hasCss && !/href\s*=\s*["']\.\/style\.css["']/.test(index)) errs.push("index.html 未正确引用 ./style.css");
              if (hasJs && !/src\s*=\s*["']\.\/game\.js["']/.test(index)) errs.push("index.html 未正确引用 ./game.js");
              return errs;
            };
            const trimRefineFile = (path: string, content: string) => {
              const raw = String(content || "");
              const max = path === "index.html" ? 18000 : path === "game.js" ? 12000 : 8000;
              if (raw.length <= max) return raw;
              const tail = path === "index.html" ? "\n<!-- ...TRUNCATED... -->" : "\n/* ...TRUNCATED... */";
              return raw.slice(0, max) + tail;
            };
            const repairFilesJson = async (rawText: string) => {
              const fixerModel = provider === "openrouter"
                ? pickOpenRouterModel(["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"])
                : model;
              const repairPayload: any = {
                model: fixerModel,
                messages: [
                  { role: "system", content: "你是 JSON 修复器。只输出一个严格 JSON 对象（json_object），不要任何解释或 markdown。" },
                  {
                    role: "user",
                    content:
                      `请把下面内容修复为严格 JSON，并确保符合 Schema：\n` +
                      `{\n  "assistant": string,\n  "ops"?: [\n    {\n      "type":"replace_in_file|remove_in_file|insert_before|insert_after|append_in_file|prepend_in_file",\n      "path":"index.html|style.css|game.js"\n    }\n  ],\n  "files"?: [ { "path": "index.html|style.css|game.js", "content": string } ]\n}\n\n` +
                      `原输出：\n${String(rawText || "").slice(0, 24000)}\n`,
                  },
                ],
                temperature: 0,
                max_tokens: 2200,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              const repairedText = await callStreamRobust(
                repairPayload,
                "直接补丁：修复 JSON",
                true,
                ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                60_000,
              );
              return parseJsonObjectLoose(repairedText);
            };
            const healDirectFiles = async (files: Array<{ path: string; content: string }>, errMsg: string) => {
              const debugModel = hasOpenRouter
                ? pickOpenRouterModel([envModelOrEmpty("CREATOR_DEBUG_MODEL"), "qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"].filter(Boolean) as string[])
                : model;
              if (provider === "openrouter") model = debugModel;
              sendMeta({ provider, model, phase: "direct_refine_debug" });
              const debugPayload: any = {
                model,
                messages: [
                  { role: "system", content: DEBUG_PROMPT },
                  {
                    role: "user",
                    content:
                      `【错误】\n${errMsg}\n\n` +
                      `【当前文件】\n${JSON.stringify(files, null, 2)}\n\n` +
                      `请输出修复后的 files（保持最小改动）。`,
                  },
                ],
                temperature: 0.1,
                max_tokens: 1800,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) debugPayload.provider = payloadBase.provider;
              const debugText = await callStreamRobust(
                debugPayload,
                "直接补丁：修复校验问题",
                true,
                ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                60_000,
              );
              const debugObj = parseJsonObjectLoose(debugText);
              const outFiles = Array.isArray((debugObj as any)?.files) ? (debugObj as any).files : [];
              const merged = files.slice();
              for (const f of outFiles) {
                const p = String((f as any)?.path || "").trim();
                const c = String((f as any)?.content || "");
                if (!["index.html", "style.css", "game.js"].includes(p) || !c.trim()) continue;
                const idx = merged.findIndex((x) => x.path === p);
                if (idx >= 0) merged[idx] = { path: p, content: c };
                else merged.push({ path: p, content: c });
              }
              return merged;
            };

            // 选择模型：优先使用前端“彩蛋”中用户选择的 provider/model（请求 body 传入的 model）。
            // 仅当模型不稳定/不可用时，callStreamRobust 才会在 fallbackModels 中自动切换。
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
            const directEditProfile = classifyIncrementalEdit(userIntent);
            const shouldUseDirectRefine = hasExistingGame && !!directEditProfile;

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

            if (shouldUseDirectRefine) {
              const editProfile = directEditProfile as IncrementalEditProfile;
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
                if (!validateAcceptanceSimple(files).length) await setLastGood(metaNow, files, "after_local_direct_edit");
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
                      ? "这是轻量行为修改。优先只改 game.js 里的事件、状态流转和显示同步，不要改主题，不要重构页面，不要注入整套新脚本。"
                        : editProfile.kind === "bugfix"
                          ? "这是行为修复。优先修问题本身，不要额外设计新玩法。"
                          : "这是已有游戏上的小增强。优先增量添加，不要重写大结构。";
              const refineExtraRules =
                editProfile.kind === "behavior"
                  ? `- 这次是已有游戏上的“行为小改动”，优先只修改 game.js。\n` +
                    `- 不要新增独立的开始页逻辑，不要重写 index.html，不要通过注入大段兜底脚本来绕过现有代码。\n` +
                    `- 如果要“自动开始”，请直接复用现有 start/init 流程；如果要“按进度显示当前句子”，请在现有状态更新里同步文案。\n`
                  : "";

              const refinePayload: any = {
                model,
                messages: [
                  {
                    role: "system",
                    content:
                      `${REFINE_PROMPT}\n\n` +
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
                max_tokens: directPaths.length === 1 ? (editProfile.kind === "behavior" ? 1200 : 1600) : 2200,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) refinePayload.provider = payloadBase.provider;

              const refineText = await autoRetry(
                async () =>
                  await callStreamRobust(
                    refinePayload,
                    "直接补丁：小改动",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    directPaths.length === 1 ? (editProfile.kind === "behavior" ? 20_000 : 25_000) : 45_000,
                  ),
                "小改动补丁",
                "这是已有游戏上的小改动，只输出 JSON 和必要文件。",
                1,
              );
              let refineObj = parseJsonObjectLoose(refineText);
              if (!refineObj) refineObj = await repairFilesJson(refineText);
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
              if (!outFiles.length && outOps.length && !appliedOpsChanged) throw new Error("DIRECT_REFINE_OPS_NO_MATCH");
              for (const f of outFiles) {
                const p = String((f as any)?.path || "").trim();
                const c = String((f as any)?.content || "");
                if (!["index.html", "style.css", "game.js"].includes(p) || !c.trim()) continue;
                const idx = files.findIndex((x) => x.path === p);
                if (idx >= 0) files[idx] = { path: p, content: c };
                else files.push({ path: p, content: c });
              }
              for (const f of files) {
                if (!["index.html", "style.css", "game.js"].includes(f.path)) continue;
                await upsertDraftFile(f.path, f.content);
              }
              const acceptanceErrs = validateAcceptanceSimple(
                files.filter((f) => ["index.html", "style.css", "game.js"].includes(f.path)),
              );
              if (acceptanceErrs.length) {
                files = await healDirectFiles(
                  files.filter((f) => ["index.html", "style.css", "game.js"].includes(f.path)),
                  acceptanceErrs.join("\n"),
                );
              }
              const metaNow = (await readMetaObj()) || readMeta || {};
              if (!validateAcceptanceSimple(files).length) await setLastGood(metaNow, files, "after_direct_refine");
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
              const c0 = t.match(/^@choice\s+([ABCabc])\b/);
              if (c0) return c0[1].toUpperCase();
              const m = t.match(/(?:方案)?\s*([ABCabc])\b/);
              if (m) return m[1].toUpperCase();
              const n = t.match(/^\s*([123])\b/);
              if (n) return n[1] === "1" ? "A" : n[1] === "2" ? "B" : "C";
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

            // 兼容旧状态：以前会在“澄清后先生成 config”这一层中断。
            // 现在默认直接进入 blueprint，所以遇到旧状态时直接迁移过去。
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
                max_tokens: 1400,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) payloadClarify.provider = payloadBase.provider;
              const out = await autoRetry(
                async () =>
                  await callStreamRobust(
                    payloadClarify,
                    "阶段0：需求澄清 JSON",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    90_000,
                  ),
                "需求澄清",
                "只输出 JSON（intent/missing/options/questions/recommend）。",
                2,
              );
              const obj = parseJsonObjectLoose(out) || {};
              const options = Array.isArray((obj as any).options) ? (obj as any).options : [];
              const qs = Array.isArray((obj as any).questions) ? (obj as any).questions : [];
              const rec = String((obj as any).recommend || "A").trim() || "A";
              // 生成友好文案
              const lines: string[] = [];
              lines.push(`我先帮你把需求补齐，再开始写代码。你可以直接回复 A/B/C 选择一个方向：`);
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
              lines.push(`\n请回复：A 或 B 或 C（也可以直接补充一句你特别想要的效果）。`);

              // 写入 meta.json：记录澄清阶段与澄清 JSON（中间变量）
              const metaOut = {
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                title: (readMeta as any)?.title || String(options.find((x: any) => String(x?.id || "").toUpperCase() === rec)?.title || "") || "未命名作品",
                _gen: {
                  ...(genState || {}),
                  stage: "clarify",
                  clarify: obj,
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
                options: options.slice(0, 3).map((o: any) => ({
                  id: String(o?.id || "").trim() || "",
                  label: String(o?.title || "").trim() || String(o?.id || "").trim() || "方案",
                  desc: String(o?.notes || "").trim() || String(o?.style || "").trim() || "",
                  payload: `@choice ${String(o?.id || "").trim() || "A"}`,
                })),
                questions: [],
                selected: {},
                actions: [{ id: "confirm", label: "开始生成（跳过剩余选择）", payload: "@confirm" }],
                // 给前端“本地分步选择”用：一次性下发全部维度，后续点击不必再次请求大模型
                all: { options: options.slice(0, 3), questions: qs.slice(0, 5) },
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
                  ? "下一步：请选择一个方向（A/B/C）。"
                  : nextQ
                    ? `下一步：${String(nextQ?.question || "").trim() || "请回答下一个问题"}`
                    : "下一步：如果没有更多要补充的，可以开始生成。";
                const txt =
                  `收到，我已记录你的选择（已回答 ${turnsUsed}/${MAX_TURNS} 个问题）。\n` +
                  `你还可以再回答 ${remaining} 个问题，之后我就会开始写代码。\n\n` +
                  `当前已选：${answers.choice ? `方案${answers.choice}` : "（未选方案）"}\n` +
                  `${nextHint}`;

                const ui = {
                  type: "clarify",
                  mode: "single_step",
                  turn: turnsUsed,
                  maxTurns: MAX_TURNS,
                  recommend: rec,
                  step: !answers.choice ? "choice" : nextQ ? String(nextQ?.id || "").trim() || "q" : "done",
                  options: !answers.choice
                    ? options.slice(0, 3).map((o: any) => ({
                        id: String(o?.id || "").trim() || "",
                        label: String(o?.title || "").trim() || String(o?.id || "").trim() || "方案",
                        desc: String(o?.notes || "").trim() || "",
                        payload: `@choice ${String(o?.id || "").trim() || "A"}`,
                      }))
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
                  all: { options: options.slice(0, 3), questions: qs.slice(0, 5) },
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

            // 0.3 若在配置确认阶段：确认 -> 进入代码生成；否则更新 config 再次确认
            if (stage === "confirm_config" && !isConfirm(userIntent)) {
              const clarify = genState.clarify || {};
              const oldConfig = genState.config || {};
              sendStatus(`（2/3）更新参数配置表 JSON（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "config_update" });
              const payloadCfg2: any = {
                model,
                messages: [
                  { role: "system", content: `${CREATOR_GAME_TYPE_LIBRARY_ADDON}\n\n${CONFIG_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【用户最早的主题】\n${String((genState as any)?.seedPrompt || seedPrompt)}\n\n` +
                      `【澄清 JSON】\n${JSON.stringify(clarify, null, 2)}\n\n` +
                      `【当前 config】\n${JSON.stringify(oldConfig, null, 2)}\n\n` +
                      `【用户修改要求】\n${userIntent}\n\n` +
                      `请输出更新后的 config JSON。`,
                  },
                ],
                temperature: 0.2,
                max_tokens: 1600,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) payloadCfg2.provider = payloadBase.provider;
              const out = await autoRetry(
                async () =>
                  await callStreamRobust(
                    payloadCfg2,
                    "阶段1：更新配置表 JSON",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    90_000,
                  ),
                "配置表更新",
                "只输出 JSON（meta/config/needConfirm）。",
                2,
              );
              const cfgObj = parseJsonObjectLoose(out);
              if (!cfgObj) throw new Error("CONFIG_NOT_JSON");
              const metaCfg = safeMeta((cfgObj as any).meta);
              const config = (cfgObj as any).config || {};
              const needConfirm = Array.isArray((cfgObj as any).needConfirm) ? (cfgObj as any).needConfirm : [];

              const metaOut = {
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                ...metaCfg,
                _gen: { ...(genState || {}), stage: "confirm_config", clarify, config, updatedAt: Date.now() },
              };
              await writeMeta(metaOut);

              const txt =
                `好的，我已更新“参数配置表”。请确认后我再开始写代码：\n\n` +
                `\`\`\`json\n${JSON.stringify({ meta: metaCfg, config }, null, 2)}\n\`\`\`\n\n` +
                (needConfirm.length ? `需要你确认的点：\n- ${needConfirm.join("\n- ")}\n\n` : "") +
                `如果没问题请回复：确认（或“开始生成”）。`;

              const finalObj = { assistant: txt, meta: metaOut, files: [] as any[] };
              parseCreatorJson(JSON.stringify(finalObj));
              send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
              clearInterval(heartbeat);
              controller.close();
              return;
            }

            // ===== 两步生成：蓝图（短 JSON） -> 代码（文件）=====
            // 目标：降低 MVP_NOT_JSON（减少一次输出体积），并通过 protocol/命名保证蓝图与代码同源不漂移。
            let activeConfig = genState && typeof genState === "object" && (genState as any).config ? (genState as any).config : null;
            const answers = (genState as any)?.answers && typeof (genState as any).answers === "object" ? (genState as any).answers : {};
            let design = (genState as any)?.design && typeof (genState as any).design === "object" ? (genState as any).design : null;
            const templateHint = buildTemplateHintBlock(seedPrompt, userIntent, answers);
            const repairBlueprintJson = async (rawText: string) => {
              const fixerModel = provider === "openrouter"
                ? pickOpenRouterModel(["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"])
                : model;
              const repairPayload: any = {
                model: fixerModel,
                messages: [
                  { role: "system", content: "你是 JSON 修复器。只输出一个严格 JSON 对象（json_object），不要任何解释或 markdown。" },
                  {
                    role: "user",
                    content:
                      `请把下面内容修复为严格 JSON，并确保符合 Schema：\n` +
                      `{\n  "meta": object,\n  "config": object,\n  "protocol": object,\n  "blueprint": object,\n  "assetsPlan": object\n}\n\n` +
                      `原输出：\n${String(rawText || "").slice(0, 24000)}\n`,
                  },
                ],
                temperature: 0,
                max_tokens: 1800,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              const repairedText = await callStreamRobust(
                repairPayload,
                "阶段2：修复蓝图 JSON",
                true,
                ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                60_000,
              );
              return parseJsonObjectLoose(repairedText);
            };

            // 1) 若还没有 design（蓝图/协议），先生成蓝图并落盘。只在 stage 非 code_pending 时进行。
            if (!design && stage !== "code_pending") {
              // 落盘：进入蓝图 pending，保证重试时不会回到阶段0/澄清
              try {
                await writeMeta({
                  ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                  _gen: { ...(genState || {}), stage: "blueprint_pending", seedPrompt, config: activeConfig, answers, updatedAt: Date.now() },
                });
              } catch {}

              sendStatus(`（1/2）生成蓝图（${provider} / ${mvpModel}）…`);
              sendMeta({ provider, model, phase: "blueprint" });

              const bpPayload: any = {
                model,
                messages: [
                  { role: "system", content: `${CREATOR_GAME_TYPE_LIBRARY_ADDON}\n\n${BLUEPRINT_PROMPT}` },
                  {
                    role: "user",
                    content:
                      `【用户最早的主题】\n${seedPrompt}\n\n` +
                      `【用户补充/本轮输入】\n${userIntent}\n\n` +
                      `【已选答案（可能为空）】\n${JSON.stringify(answers, null, 2)}\n\n` +
                      `${templateHint}\n` +
                      (activeConfig ? `【已有 config（如有）】\n${JSON.stringify(activeConfig, null, 2)}\n\n` : "") +
                      `请输出蓝图 JSON（含 meta/config/protocol/blueprint/assetsPlan）。`,
                  },
                ],
                temperature: 0.2,
                max_tokens: 1400,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) bpPayload.provider = payloadBase.provider;

              const bpText = await autoRetry(
                async () =>
                  await callStreamRobust(
                    bpPayload,
                    "阶段2：蓝图 JSON",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    90_000,
                  ),
                "蓝图",
                "只输出 JSON（meta/config/protocol/blueprint/assetsPlan），严禁输出代码。",
                2,
              );
              let bpObj = parseJsonObjectLoose(bpText);
              if (!bpObj) bpObj = await repairBlueprintJson(bpText);
              if (!bpObj) throw new Error("BLUEPRINT_NOT_JSON");
              const metaBp = safeMeta((bpObj as any).meta);
              const cfgBp = (bpObj as any).config || activeConfig || {};
              design = {
                meta: metaBp,
                config: cfgBp,
                protocol: (bpObj as any).protocol || {},
                blueprint: (bpObj as any).blueprint || {},
                assetsPlan: (bpObj as any).assetsPlan || {},
              };
              activeConfig = cfgBp;
              await writeMeta({
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                ...metaBp,
                _gen: { ...(genState || {}), stage: "code_pending", seedPrompt, answers, config: activeConfig, design, updatedAt: Date.now() },
              });
            }

            // 2) 代码生成：先出 index.html + style.css，再单独出 game.js
            // 这样首次生成不必一次吐出三个完整文件，严格 JSON 更稳。
            // 落盘：进入 code_pending，确保重试时复用同一份蓝图（同源，不漂移）
            try {
              await writeMeta({
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: { ...(genState || {}), stage: "code_pending", seedPrompt, answers, config: activeConfig, design, updatedAt: Date.now() },
              });
            } catch {}

            const tryRepairJsonOnce = async (raw: string, why: string, schemaHint: string) => {
              const rawText = String(raw || "");
              if (!rawText.trim()) return null;
              // 用户要求：修复模型优先 deepseek/deepseek-v3.2（仅 OpenRouter 可用）
              const repairModel = provider === "openrouter" ? "deepseek/deepseek-v3.2" : model;
              sendStatus(`输出 JSON 有问题，我尝试自动修复一次…（原因：${why}）`);
              sendMeta({ provider, model: repairModel, phase: "json_repair" });
              const clipped = rawText.length > 12000 ? rawText.slice(0, 12000) : rawText;
              const repairPayload: any = {
                model: repairModel,
                messages: [
                  { role: "system", content: `你是 JSON 修复器。\n${schemaHint}` },
                  { role: "user", content: `请把下面“原输出”修复为严格 JSON：\n\n【原输出】\n${clipped}\n` },
                ],
                temperature: 0.0,
                max_tokens: 2400,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              try {
                const repairedText = await callStreamRobust(
                  repairPayload,
                  "阶段：修复输出 JSON",
                  true,
                  // 修复阶段也允许在 OpenRouter 内换模型，但仍优先 deepseek
                  ["deepseek/deepseek-v3.2", "qwen/qwen3.6-plus", "minimax/minimax-m2.5"],
                  90_000,
                );
                return parseJsonObjectLoose(repairedText);
              } catch {
                return null;
              }
            };
            const failWithRetry = async (assistant: string, badText = "") => {
              await writeMeta({
                ...(readMeta && typeof readMeta === "object" ? readMeta : {}),
                _gen: { ...(genState || {}), stage: "code_pending", seedPrompt, updatedAt: Date.now(), lastBad: String(badText || "").slice(0, 2000) },
              });
              const finalObj = {
                assistant,
                meta: readMeta,
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

            const htmlCssSchemaHint =
              `只输出一个严格 JSON 对象（json_object），不要任何解释或 markdown。\n` +
              `Schema：{\n` +
              `  "assistant": string,\n` +
              `  "meta": { "title": string, "shortDesc": string, "rules": string, "creator": { "name": string } },\n` +
              `  "files": [\n` +
              `    { "path": "index.html", "content": string },\n` +
              `    { "path": "style.css", "content": string }\n` +
              `  ]\n` +
              `}\n` +
              `要求：index.html 必须引用 ./style.css 和 ./game.js；不要输出 game.js。\n`;
            const gameJsSchemaHint =
              `只输出一个严格 JSON 对象（json_object），不要任何解释或 markdown。\n` +
              `Schema：{\n` +
              `  "path": "game.js",\n` +
              `  "content": string\n` +
              `}\n`;

            sendStatus(`（2/3）生成页面结构和样式（${provider} / ${mvpModel}）…`);
            sendMeta({ provider, model, phase: "codegen_html_css" });
            const htmlCssPayload: any = {
              model,
              messages: [
                { role: "system", content: CODEGEN_HTML_CSS_PROMPT },
                {
                  role: "user",
                  content:
                    `【用户最早的主题】\n${seedPrompt}\n\n` +
                    `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                    `${templateHint}\n` +
                    `请只输出 index.html 和 style.css。`,
                },
              ],
              temperature: 0.2,
              max_tokens: 2200,
              response_format: { type: "json_object" },
            };
            if (provider === "openrouter" && payloadBase.provider) htmlCssPayload.provider = payloadBase.provider;

            let htmlCssText = "";
            try {
              htmlCssText = await autoRetry(
                async () =>
                  await callStreamRobust(
                    htmlCssPayload,
                    "阶段3：页面和样式 JSON",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    90_000,
                  ),
                "页面和样式",
                "只输出 JSON，files 中仅包含 index.html 和 style.css。",
                2,
              );
            } catch (e: any) {
              return await failWithRetry(
                "我刚刚在生成页面结构和样式时遇到了网络问题。蓝图已经保存好，点“重试”会直接从写代码继续。",
                String(e?.message || e),
              );
            }

            const htmlCssObj = await parseFilesObject(htmlCssText, htmlCssSchemaHint, ["index.html", "style.css"]);
            if (!htmlCssObj) {
              return await failWithRetry(
                "我刚刚在生成页面结构和样式时，模型输出的 JSON 格式不对（可能内容太长被截断）。你的蓝图我已经保存好了，点“重试”会从写代码继续。",
                htmlCssText,
              );
            }

            const meta = safeMeta((htmlCssObj as any).meta);
            const htmlCssFiles = Array.isArray((htmlCssObj as any).files) ? (htmlCssObj as any).files : [];
            const html = String(htmlCssFiles.find((x: any) => String(x?.path || "") === "index.html")?.content || "");
            const css = String(htmlCssFiles.find((x: any) => String(x?.path || "") === "style.css")?.content || "");
            if (!html.trim() || !css.trim()) {
              return await failWithRetry(
                "我生成出来的内容里没有完整找到 index.html 或 style.css。你的蓝图已保存，点“重试”继续写代码即可。",
                htmlCssText,
              );
            }
            const htmlCssWrite = await writeDraftFilesDetailed([
              { path: "index.html", content: html },
              { path: "style.css", content: css },
            ]);
            const metaAfterHtmlCss = applyPersistStatus((await readMetaObj()) || readMeta || {}, "html_css", htmlCssWrite, ["index.html", "style.css"]);
            try {
              await writeMeta(metaAfterHtmlCss);
            } catch {}
            if (!htmlCssWrite.ok) {
              return await failWithRetry(
                "页面和样式已经生成出来了，但写回数据库时没有完全成功。点“重试”我会从已生成结果继续。",
                JSON.stringify(htmlCssWrite.failed),
              );
            }

            sendStatus(`（3/3）生成核心逻辑（${provider} / ${mvpModel}）…`);
            sendMeta({ provider, model, phase: "codegen_game_js" });
            const gameJsPayload: any = {
              model,
              messages: [
                { role: "system", content: coderPrompt(design || { config: activeConfig }, "game.js", quality === "quality") },
                {
                  role: "user",
                  content:
                    `【用户最早的主题】\n${seedPrompt}\n\n` +
                    `【蓝图 JSON（必须严格遵守）】\n${JSON.stringify(design || { config: activeConfig }, null, 2)}\n\n` +
                    `【当前页面结构】\n${JSON.stringify([{ path: "index.html", content: html }, { path: "style.css", content: css }], null, 2)}\n\n` +
                    `${templateHint}\n` +
                    `请只输出 game.js 的 JSON。`,
                },
              ],
              temperature: 0.2,
              max_tokens: 2200,
              response_format: { type: "json_object" },
            };
            if (provider === "openrouter" && payloadBase.provider) gameJsPayload.provider = payloadBase.provider;

            let gameJsText = "";
            try {
              gameJsText = await autoRetry(
                async () =>
                  await callStreamRobust(
                    gameJsPayload,
                    "阶段4：核心逻辑 JSON",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    90_000,
                  ),
                "核心逻辑",
                "只输出 JSON，结构为 {path:\"game.js\", content:\"...\"}。",
                2,
              );
            } catch (e: any) {
              return await failWithRetry(
                "我刚刚在生成核心逻辑时遇到了网络问题。蓝图和页面结构已经保存好，点“重试”会直接从写代码继续。",
                String(e?.message || e),
              );
            }

            let gameJsObj: any = parseJsonObjectLoose(gameJsText);
            if (!gameJsObj) gameJsObj = await tryRepairJsonOnce(gameJsText, "GAME_JS_NOT_JSON", gameJsSchemaHint);
            const jsPath = String((gameJsObj as any)?.path || "").trim();
            const jsContent = String((gameJsObj as any)?.content || "");
            if (!gameJsObj || jsPath !== "game.js" || !jsContent.trim()) {
              return await failWithRetry(
                "我刚刚在生成核心逻辑时，模型输出的 JSON 格式不对（可能内容太长被截断）。你的蓝图和页面结构已保存，点“重试”会从写代码继续。",
                gameJsText,
              );
            }
            const gameJsWrite = await writeDraftFilesDetailed([{ path: "game.js", content: jsContent }]);
            const metaAfterGameJs = applyPersistStatus((await readMetaObj()) || readMeta || {}, "game_js", gameJsWrite, ["game.js"]);
            try {
              await writeMeta(metaAfterGameJs);
            } catch {}
            if (!gameJsWrite.ok) {
              return await failWithRetry(
                "核心逻辑已经生成出来了，但写回数据库时没有完全成功。点“重试”我会从已生成结果继续。",
                JSON.stringify(gameJsWrite.failed),
              );
            }

            const metaNow = {
              ...meta,
              _gen: {
                ...(genState || {}),
                v: 1,
                stage: "code_done",
                ...(activeConfig ? { config: activeConfig } : {}),
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
            };
            const finalFiles: Array<{ path: string; content: string }> = [
              { path: "index.html", content: html },
              { path: "style.css", content: css },
              { path: "game.js", content: jsContent },
            ];
            let stableFiles = finalFiles;
            const acceptanceErrs: string[] = [];
            try {
              if (jsContent.trim()) new Script(jsContent);
            } catch (e: any) {
              acceptanceErrs.push(`game.js 语法错误：${String(e?.message || e)}`);
            }
            const indexRef = finalFiles.find((f) => f.path === "index.html")?.content || "";
            if (!/href\s*=\s*["']\.\/style\.css["']/.test(indexRef)) acceptanceErrs.push("index.html 未正确引用 ./style.css");
            if (!/src\s*=\s*["']\.\/game\.js["']/.test(indexRef)) acceptanceErrs.push("index.html 未正确引用 ./game.js");
            if (acceptanceErrs.length) {
              return await failWithRetry(
                "我已经把三个文件都生成出来了，但首次联调检查没通过。蓝图和代码草稿已保存，点“重试”我会继续修。",
                acceptanceErrs.join("\n"),
              );
            }
            await writeMeta(metaNow);

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

          // ===== 新方案：Architect -> 单文件 MVP -> （沙箱自愈）-> 拆分 -> 迭代补丁 =====
          const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY || "");

          // 模型选择：优先使用前端“彩蛋”里用户选定的 model（请求 body 传入）。
          // 这样 Architect/MVP/Refine 都同源，减少“变量/规则漂移”。
          // Debug 阶段仍可使用更稳的兜底模型。
          const debugOverride = envModelOrEmpty("CREATOR_DEBUG_MODEL");
          const chosen = String(model || "").trim() || "qwen/qwen3.6-plus";
          const architectModel = chosen;
          const mvpModel = chosen;
          const refineModel = chosen;
          const debugModel = hasOpenRouter
            ? pickOpenRouterModel([debugOverride, "openai/gpt-4o-mini", "qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"].filter(Boolean) as string[])
            : chosen;

          // 必须有 gameId 才能做“可用成果持久化 + 失败不归零”
          if (!safeGameId || !ownerKey) throw new Error("MISSING_GAME_ID");

          await ensureCreatorDraftTables();
          const owns = await db.execute(sql`
            select 1
            from creator_draft_games
            where id = ${safeGameId} and owner_key = ${ownerKey}
            limit 1
          `);
          const ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
          if (!ownRows.length) throw new Error("NOT_YOUR_GAME");

          const draftStore = createDraftStore(safeGameId);
          const upsertDraftFile = async (path: string, content: string) => await draftStore.writeFile(path, content);
          const readDraftFile = async (path: string) => await draftStore.readFile(path);
          const readDraftFiles = async (paths: string[]) => await draftStore.readFiles(paths);

          const hash12 = (s: string) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
          const showModel = () => `${provider} / ${model}`;

          const readMetaObj = async () => await draftStore.readMeta();

          const validateScripts = (files: Array<{ path: string; content: string }>) => {
            const err: string[] = [];
            const get = (p: string) => files.find((x) => x.path === p)?.content || "";
            const jsFromHtml = (html: string) => {
              if (!html) return "";
              const blocks: string[] = [];
              const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
              let m: RegExpExecArray | null;
              while ((m = re.exec(html))) {
                const attrs = String(m[1] || "");
                // 跳过 <script src=...>
                if (/src\s*=/.test(attrs)) continue;
                blocks.push(String(m[2] || ""));
              }
              return blocks.join("\n\n");
            };
            try {
              const html = get("index.html");
              if (html) {
                const js = jsFromHtml(html);
                if (js.trim()) new Script(js);
              }
            } catch (e: any) {
              err.push(`index.html 内联脚本语法错误：${String(e?.message || e)}`);
            }
            try {
              const js = get("game.js");
              if (js && js.trim()) new Script(js);
            } catch (e: any) {
              err.push(`game.js 语法错误：${String(e?.message || e)}`);
            }
            return err;
          };

          // 最小验收（稳定优先）：语法可解析 +（若已拆分）引用关系正确
          const validateAcceptance = (files: Array<{ path: string; content: string }>) => {
            const err = [...validateScripts(files)];
            const index = files.find((f) => f.path === "index.html")?.content || "";
            const hasCss = !!files.find((f) => f.path === "style.css")?.content;
            const hasJs = !!files.find((f) => f.path === "game.js")?.content;
            if (hasCss && !/href\s*=\s*["']\.\/style\.css["']/.test(index)) err.push("index.html 未正确引用 ./style.css");
            if (hasJs && !/src\s*=\s*["']\.\/game\.js["']/.test(index)) err.push("index.html 未正确引用 ./game.js");
            return err;
          };

          // lastGood：稳定交付的关键（任何后续失败都回滚到最近一次通过验收的版本）
          const readLastGood = async () => {
            const meta = (await readMetaObj()) || {};
            const lg = (meta as any)?._gen?.lastGood;
            if (!lg || typeof lg !== "object") return null;
            const files = Array.isArray(lg.files) ? lg.files : [];
            const normalized = files
              .map((f: any) => ({ path: String(f?.path || "").trim(), content: String(f?.content || "") }))
              .filter((f: any) => ["index.html", "style.css", "game.js"].includes(f.path) && f.content.trim());
            return normalized.length ? { meta, lg, files: normalized } : null;
          };

          const writeMeta = async (metaObj: any) => {
            await upsertDraftFile("meta.json", JSON.stringify(metaObj || {}, null, 2));
          };

          const setLastGood = async (files: Array<{ path: string; content: string }>, note: string) => {
            const metaNow = (await readMetaObj()) || {};
            const pick = files
              .filter((f) => ["index.html", "style.css", "game.js"].includes(f.path))
              .map((f) => ({ path: f.path, content: String(f.content || "") }));
            const blob = pick.map((f) => `${f.path}\n${f.content}`).join("\n\n");
            (metaNow as any)._gen = { ...(metaNow as any)._gen, lastGood: { at: Date.now(), hash: hash12(blob), note, files: pick } };
            await writeMeta(metaNow);
          };

          const restoreLastGood = async (reason: string) => {
            const lg = await readLastGood();
            if (!lg) throw new Error(`NO_LAST_GOOD:${reason}`);
            sendStatus(`生成遇到问题（${reason}），已回滚到上一次可用版本。`);
            for (const f of lg.files) {
              await upsertDraftFile(f.path, f.content);
            }
            return lg.files;
          };

          const splitSingleFile = (html: string) => {
            const raw = String(html || "");
            if (!raw.includes("AI_MVP_SINGLE_FILE")) return null;
            const styleBlocks: string[] = [];
            const scriptBlocks: string[] = [];
            let out = raw;
            out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, c) => {
              styleBlocks.push(String(c || ""));
              return "";
            });
            out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs, c) => {
              const a = String(attrs || "");
              if (/src\s*=/.test(a)) return _m;
              scriptBlocks.push(String(c || ""));
              return "";
            });
            const css = styleBlocks.join("\n\n").trim();
            const js = scriptBlocks.join("\n\n").trim();
            if (!css || !js) return null;
            // 注入外链引用：放在 </head> 前；script 放在 </body> 前
            if (!/href\s*=\s*["']\.\/style\.css["']/.test(out)) {
              out = out.replace(/<\/head>/i, `  <link rel="stylesheet" href="./style.css" />\n</head>`);
            }
            if (!/src\s*=\s*["']\.\/game\.js["']/.test(out)) {
              out = out.replace(/<\/body>/i, `  <script src="./game.js"></script>\n</body>`);
            }
            return { index: out.trim() + "\n", css: css + "\n", js: js + "\n" };
          };

          const selfHeal = async (
            phaseLabel: string,
            curFiles: Array<{ path: string; content: string }>,
            errMsg: string,
            maxRound = 2,
          ) => {
            let files = curFiles.slice();
            for (let i = 0; i < maxRound; i++) {
              sendStatus(`${phaseLabel}：检测到错误，自动修复中（${i + 1}/${maxRound}）…`);
              if (provider === "openrouter") model = debugModel;
              sendMeta({ provider, model, phase: "debug" });
              const debugPayload: any = {
                model,
                messages: [
                  { role: "system", content: DEBUG_PROMPT },
                  {
                    role: "user",
                    content:
                      `【错误】\n${errMsg}\n\n【当前文件】\n${JSON.stringify(files, null, 2)}\n\n` +
                      `请输出修复后的 files（保持最小改动）。`,
                  },
                ],
                temperature: 0.1,
                max_tokens: 1400,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) debugPayload.provider = payloadBase.provider;
              const outText = await autoRetry(
                async () =>
                  await callStreamRobust(debugPayload, `Debug：修复补丁`, true, [
                    "deepseek/deepseek-v3.2",
                    "minimax/minimax-m2.5",
                    "qwen/qwen3.6-plus",
                  ]),
                "Debug 自动修复",
                "只输出 JSON，files 里给出修复后的完整文件内容。",
              );
              const obj = parseJsonObjectLoose(outText);
              const outFiles = Array.isArray((obj as any)?.files) ? (obj as any).files : [];
              // 合并更新
              for (const f of outFiles) {
                const p = String((f as any)?.path || "").trim();
                const c = String((f as any)?.content || "");
                if (!["index.html", "style.css", "game.js"].includes(p) || !c.trim()) continue;
                const idx = files.findIndex((x) => x.path === p);
                if (idx >= 0) files[idx] = { path: p, content: c };
                else files.push({ path: p, content: c });
                await upsertDraftFile(p, c);
              }
              const errs = validateScripts(files);
              if (!errs.length) return files;
              errMsg = errs.join("\n");
            }
            throw new Error(`SANDBOX_FAILED:${errMsg.slice(0, 180)}`);
          };

          // ===== 读取当前工程状态 =====
          const currentDraft0 = await readDraftFiles(["index.html", "style.css", "game.js"]);
          const index0 = currentDraft0["index.html"] || "";
          const style0 = currentDraft0["style.css"] || "";
          const game0 = currentDraft0["game.js"] || "";
          const meta0 = await readMetaObj();
          const plan0 = meta0 && typeof (meta0 as any)._plan === "object" ? (meta0 as any)._plan : null;
          const gen0 = meta0 && typeof (meta0 as any)._gen === "object" ? (meta0 as any)._gen : null;
          const hasSplit0 = !!(gen0?.splitted && style0 && game0);

          const firstUserText = String(messages.find((m) => m.role === "user")?.content || "").trim();
          const userIntent = lastUserText || firstUserText;

          // ===== 阶段 1：Architect（只在首次或缺失 plan 时生成）=====
          let blueprint: any = null;
          if (plan0 && typeof plan0 === "object" && (plan0 as any).protocol) {
            blueprint = plan0;
          } else {
            sendStatus(`（1/3）架构师：生成协议蓝图（${provider} / ${architectModel}）…`);
            if (provider === "openrouter") model = architectModel;
            sendMeta({ provider, model, phase: "architect" });
            const payload: any = {
              model,
              messages: [
                { role: "system", content: ARCHITECT_PROMPT },
                { role: "user", content: userIntent || "请为一个简单小游戏生成协议蓝图。" },
              ],
              temperature: 0.2,
              max_tokens: 1400,
              response_format: { type: "json_object" },
            };
            if (provider === "openrouter" && payloadBase.provider) payload.provider = payloadBase.provider;
            const outText = await autoRetry(
              async () =>
                await callStreamRobust(payload, "阶段1：蓝图 JSON", true, [
                  // qwen 不稳时，换 deepseek / minimax
                  "deepseek/deepseek-v3.2",
                  "minimax/minimax-m2.5",
                  "qwen/qwen3.6-plus",
                ]),
              "架构师蓝图",
              "只输出 JSON 对象，包含 meta/protocol/acceptance。",
            );
            let obj = parseJsonObjectLoose(outText);
            if (!obj) {
              // 兜底 1：先用“JSON 修复器”把输出纯化为严格 JSON（保持结构）
              sendStatus("蓝图不是严格 JSON，正在自动修复为 JSON…");
              const fixerModel = provider === "openrouter" ? pickOpenRouterModel(["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"]) : model;
              const repairPayload: any = {
                model: fixerModel,
                messages: [
                  { role: "system", content: "你是 JSON 修复器。只输出一个严格 JSON 对象（json_object），不要任何解释或 markdown。" },
                  {
                    role: "user",
                    content:
                      `请把下面内容修复为严格 JSON，并确保符合 Schema：\n` +
                      `{\n  "meta":{ "title":string,"shortDesc":string,"rules":string,"creator":{"name":string}},\n` +
                      `  "protocol":{...},\n  "acceptance":{...}\n}\n\n` +
                      `原输出：\n${outText}\n`,
                  },
                ],
                temperature: 0.0,
                max_tokens: 1400,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              const repairedText = await autoRetry(
                async () =>
                  await callStreamRobust(repairPayload, "阶段1：修复蓝图 JSON", true, [
                    "deepseek/deepseek-v3.2",
                    "minimax/minimax-m2.5",
                    "qwen/qwen3.6-plus",
                  ]),
                "架构师蓝图修复",
                "只输出严格 JSON 对象（meta/protocol/acceptance）。",
              );
              obj = parseJsonObjectLoose(repairedText);
            }
            if (!obj && provider === "openrouter") {
              // 兜底 2：修复失败 -> 直接强制换 Qwen 重跑一次 Architect（比继续修复更稳）
              const qwen = pickOpenRouterModel(["qwen/qwen3.6-plus"]);
              sendStatus(`修复失败，我改用 ${qwen} 重新生成协议蓝图…`);
              sendMeta({ provider, model: qwen, phase: "architect", reason: "force_qwen_architect_not_json" });
              const p2: any = { ...payload, model: qwen, temperature: 0.2, max_tokens: 1400, response_format: { type: "json_object" } };
              delete p2.provider; // Qwen 不需要 Gemini 的 provider routing
              const out2 = await autoRetry(
                async () => await callStreamRobust(p2, "阶段1：蓝图 JSON（Qwen 兜底）", true, []),
                "架构师蓝图（Qwen兜底）",
                "只输出严格 JSON 对象（meta/protocol/acceptance）。",
              );
              obj = parseJsonObjectLoose(out2);
            }
            if (!obj) {
              // 最后兜底：不要让用户因为“蓝图不是 JSON”而完全生成失败。
              // 用一个内置的最小蓝图继续进入 MVP 阶段（保证“至少可运行”）。
              sendStatus("架构师输出异常（仍非 JSON），我将使用内置最小蓝图继续生成 MVP…");
              const titleGuess = (() => {
                const t = String(userIntent || "").replace(/\s+/g, " ").trim();
                if (!t) return "未命名作品";
                const s = t.replace(/[，。,.!！?？:：;；"“”'‘’()（）【】\[\]]/g, "").trim();
                return (s.slice(0, 18) || "未命名作品") + (s.length > 18 ? "…" : "");
              })();
              obj = {
                meta: { title: titleGuess, shortDesc: "一个可运行的最小可行版本（MVP），可继续迭代完善。", rules: "点击开始；完成目标后结束。", creator: { name: "创作者" } },
                protocol: {
                  globalState: { stateMachine: ["start", "playing", "win", "lose"], vars: [{ name: "score", type: "number", purpose: "记录得分" }] },
                  dom: { rootId: "app", canvasId: "gameCanvas", startBtnId: "btnStart", hudIds: ["hudScore", "hudInfo"] },
                  events: ["startGame", "resetGame", "tick", "render"],
                  gameLoop: { tickMs: 16, functions: ["init", "reset", "update", "render"] },
                },
                acceptance: {
                  mustHave: [
                    "index.html 内含一个 <style> 和一个 <script>（单文件 MVP）",
                    "无 JS 语法错误（可被静态解析）",
                    "点击开始可进入 playing，结束后可回到 start/over",
                  ],
                },
              };
            }
            const meta = safeMeta((obj as any).meta);
            blueprint = { v: 1, baseIdea: userIntent, meta, protocol: (obj as any).protocol || {}, acceptance: (obj as any).acceptance || {} };
            const metaOut = { ...meta, _plan: blueprint, _gen: { v: 1, stage: "architect_done", updatedAt: Date.now() } };
            await upsertDraftFile("meta.json", JSON.stringify(metaOut, null, 2));
          }

          // ===== 阶段 2：Skeleton（单文件 MVP）=====
          let files: Array<{ path: string; content: string }> = [];
          const hasIndex = !!index0.trim();
          if (!hasIndex) {
            sendStatus(`（2/3）生成单文件 MVP（${provider} / ${mvpModel}）…`);
            sendMeta({ provider, model: mvpModel, phase: "mvp" });
            const payload: any = {
              model: mvpModel,
              messages: [
                { role: "system", content: MVP_PROMPT },
                { role: "user", content: `【蓝图】\n${JSON.stringify(blueprint, null, 2)}\n\n【用户需求】\n${userIntent}\n` },
              ],
              temperature: 0.3,
              max_tokens: 2200,
              response_format: { type: "json_object" },
            };
            if (provider === "openrouter" && payloadBase.provider) payload.provider = payloadBase.provider;
            const outText = await autoRetry(
              async () =>
                await callStreamRobust(payload, "阶段2：单文件 MVP", true, [
                  "deepseek/deepseek-v3.2",
                  "minimax/minimax-m2.5",
                  "qwen/qwen3.6-plus",
                ]),
              "单文件 MVP",
              "只输出 JSON，files 里只包含 index.html。",
            );
            const obj = parseJsonObjectLoose(outText);
            if (!obj) throw new Error("MVP_NOT_JSON");
            const meta = safeMeta((obj as any).meta || blueprint.meta);
            const outFiles = Array.isArray((obj as any).files) ? (obj as any).files : [];
            const html = String(outFiles.find((x: any) => String(x?.path || "") === "index.html")?.content || "");
            if (!html.trim()) throw new Error("MVP_EMPTY_INDEX");
            files = [{ path: "index.html", content: html }];
            // 写入草稿：保证失败不归零
            await upsertDraftFile("index.html", html);
            const metaOut = { ...meta, _plan: blueprint, _gen: { v: 1, stage: "mvp_generated", singleFile: true, updatedAt: Date.now() } };
            await upsertDraftFile("meta.json", JSON.stringify(metaOut, null, 2));
          } else {
            // 已有代码：进入阶段 3（Refine/Patch）
            files = hasSplit0
              ? [
                  { path: "index.html", content: index0 },
                  { path: "style.css", content: style0 },
                  { path: "game.js", content: game0 },
                ]
              : [{ path: "index.html", content: index0 }];
          }

          // ===== 沙箱静态检查 + 自愈 =====
          {
            const errs0 = validateAcceptance(files);
            if (errs0.length) {
              try {
                files = await selfHeal("沙箱检查", files, errs0.join("\n"), 2);
              } catch (e: any) {
                // 稳定优先：自愈失败不阻断交付，直接回滚 lastGood（若还没有则继续抛错）
                files = await restoreLastGood(String(e?.message || e));
              }
            }
            // 只要通过验收，就立刻设置 lastGood（保证后续失败不归零）
            const ok = !validateAcceptance(files).length;
            if (ok) await setLastGood(files, "after_sandbox");
          }

          // ===== MVP 稳定后：自动拆分（单文件 -> 三文件）=====
          if (!hasSplit0) {
            const html = files.find((f) => f.path === "index.html")?.content || "";
            const split = splitSingleFile(html);
            if (split) {
              sendStatus("MVP 已稳定，正在自动拆分为 index.html + style.css + game.js…");
              const indexNew = split.index;
              const cssNew = split.css;
              const jsNew = split.js;
              const splitFiles = [
                { path: "index.html", content: indexNew },
                { path: "style.css", content: cssNew },
                { path: "game.js", content: jsNew },
              ];
              try {
                const errs = validateAcceptance(splitFiles);
                if (errs.length) throw new Error(`SPLIT_ACCEPTANCE_FAILED:${errs.join(" | ")}`);
                await upsertDraftFile("index.html", indexNew);
                await upsertDraftFile("style.css", cssNew);
                await upsertDraftFile("game.js", jsNew);
                files = splitFiles;
                const metaNow = (await readMetaObj()) || {};
                (metaNow as any)._gen = { ...(metaNow as any)._gen, stage: "split_done", splitted: true, updatedAt: Date.now() };
                await writeMeta(metaNow);
                await setLastGood(files, "after_split");
              } catch (e: any) {
                // 稳定优先：拆分失败不阻断交付，保留单文件 lastGood
                sendStatus("拆分后检测到问题，已保留单文件版本继续运行。");
              }
            }
          }

          // ===== 阶段 3：Refine（在活代码上全量替换或多文件补丁）=====
          const isFirstGen = !hasIndex;
          if (!isFirstGen) {
            try {
              sendStatus(`（3/3）根据新指令迭代完善（${provider} / ${refineModel}）…`);
              if (provider === "openrouter") model = refineModel;
              sendMeta({ provider, model, phase: "refine" });
              const payload: any = {
                model,
                messages: [
                  { role: "system", content: REFINE_PROMPT },
                  {
                    role: "user",
                    content:
                      `【架构协议】\n${JSON.stringify(blueprint, null, 2)}\n\n` +
                      `【当前文件】\n${JSON.stringify(files, null, 2)}\n\n` +
                      `【用户新需求】\n${userIntent}\n\n` +
                      `请输出修订后的 files（尽量只改必要文件）。`,
                  },
                ],
                temperature: 0.3,
                max_tokens: 2400,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) payload.provider = payloadBase.provider;
              // 稳定优先：阶段3 不要无限等待/反复重试。
              // - 单次调用超时压到 60s
              // - 不额外重试（attempts=1）
              const outText = await autoRetry(
                async () =>
                  await callStreamRobust(
                    payload,
                    "阶段3：迭代补丁",
                    true,
                    ["deepseek/deepseek-v3.2", "minimax/minimax-m2.5", "qwen/qwen3.6-plus"],
                    60_000,
                  ),
                "迭代补丁",
                "只输出 JSON，files 里包含修改后的完整文件内容。",
                1,
              );
              const obj = parseJsonObjectLoose(outText);
              const outFiles = Array.isArray((obj as any)?.files) ? (obj as any).files : [];
              for (const f of outFiles) {
                const p = String((f as any)?.path || "").trim();
                const c = String((f as any)?.content || "");
                if (!["index.html", "style.css", "game.js"].includes(p) || !c.trim()) continue;
                const idx = files.findIndex((x) => x.path === p);
                if (idx >= 0) files[idx] = { path: p, content: c };
                else files.push({ path: p, content: c });
                await upsertDraftFile(p, c);
              }
              const errs = validateAcceptance(files);
              if (errs.length) files = await selfHeal("迭代后沙箱检查", files, errs.join("\n"), 2);
              if (!validateAcceptance(files).length) await setLastGood(files, "after_refine");
            } catch (e: any) {
              // 稳定优先：refine 失败不阻断交付，回滚 lastGood
              files = await restoreLastGood(String(e?.message || e));
            }
          }

          // 更新 meta.json（标题/简介等）+ 返回给前端写入
          const metaNow = (await readMetaObj()) || {};
          const metaClean = safeMeta((metaNow as any) || blueprint.meta);
          (metaNow as any).title = metaClean.title || (metaNow as any).title || "未命名作品";
          (metaNow as any).shortDesc = metaClean.shortDesc || (metaNow as any).shortDesc || "";
          (metaNow as any).rules = metaClean.rules || (metaNow as any).rules || "";
          (metaNow as any).creator = metaClean.creator || (metaNow as any).creator || {};
          (metaNow as any)._plan = blueprint;
          (metaNow as any)._gen = { ...(metaNow as any)._gen, updatedAt: Date.now() };
          await upsertDraftFile("meta.json", JSON.stringify(metaNow, null, 2));

          const assistantText =
            `已生成可运行版本：${String((metaNow as any).title || "").trim() || "未命名作品"}。` +
            `\n（已做静态沙箱检查与自动修复；MVP 稳定后已自动拆分为多文件。）`;
          const finalObj = { assistant: assistantText, meta: metaNow, files: [...files, { path: "meta.json", content: JSON.stringify(metaNow, null, 2) }] };

          parseCreatorJson(JSON.stringify(finalObj));
          send("final", { ok: true, content: JSON.stringify(finalObj), repaired: false });
          clearInterval(heartbeat);
          controller.close();
          return;
        }

        try {
          resp = await callModelStream(payloadBase);
        } catch (e: any) {
          // 默认优先 OpenRouter，但如果 OpenRouter 网络失败，则优先回退百炼，其次直连 DeepSeek
          const em = String(e?.message || e);
          if (em.toLowerCase().includes("fetch_failed")) {
            if (provider === "openrouter" && canFallbackBailian) {
              sendStatus("OpenRouter 连接失败，我先切到阿里云百炼再试一次…");
              await fallbackToBailian();
              payloadBase.model = model;
              delete payloadBase.provider;
              resp = await callModelStream(payloadBase);
            } else if (provider === "openrouter" && canFallbackDeepSeek) {
              sendStatus("OpenRouter 连接失败，我先切到 DeepSeek 再试一次…");
              await fallbackToDeepSeek();
              payloadBase.model = model;
              delete payloadBase.provider;
              resp = await callModelStream(payloadBase);
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        }
        // 不做“地区不可用时自动降级”：让错误显式暴露，方便用户选择用代理/用 Vercel 中转等方案解决。
        if (!resp.ok) {
          // response_format 可能不兼容，退回普通 stream
          try {
            resp.body?.cancel();
          } catch {}
          delete payloadBase.response_format;
          resp = await callModelStream(payloadBase);
        }
        if (!resp.ok || !resp.body) {
          const j = await resp.json().catch(() => ({}));
          const msg = j?.error?.message || j?.message || resp.status;
          throw new Error(`MODEL_ERROR:${msg}`);
        }

        sendStatus("AI 正在生成代码…");
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
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
              const delta = j?.choices?.[0]?.delta?.content ?? "";
              if (typeof delta === "string" && delta) {
                full += delta;
                // 把增量内容流式推给前端，让用户看到 AI 正在输出什么
                send("delta", { text: delta });
              }
            }
          }
        } catch (e: any) {
          // 流式传输中断：用非流式再请求一次兜底，尽量给用户结果
          // 流式连接偶尔会中断：这里用一次非流式请求兜底，继续给用户结果
          sendStatus("连接有点不稳定，我换个方式继续生成…");
          const once = await callModelOnce({
            model,
            messages: [{ role: "system", content: systemPrompt }, ...messages],
            temperature: 0.4,
          });
          full = once;
        }

        // 校验 JSON；不通过就自动修复 1 次
        try {
          sendStatus("AI 正在检查输出格式…");
          parseCreatorJson(full);
          send("final", { ok: true, content: full, repaired: false });
          clearInterval(heartbeat);
          controller.close();
          return;
        } catch (e: any) {
          sendStatus("AI 在修复输出格式…");
          const repairPrompt =
            `你刚才的输出不是严格可解析的 JSON。请只输出一个 JSON 对象（不要任何额外文本），并修复格式。\n` +
            `错误原因：${String(e?.message || e)}\n` +
            `原输出：\n${full}\n`;
          const repaired = await callModelOnce({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              ...messages,
              { role: "user", content: repairPrompt },
            ],
            temperature: 0.2,
          });
          parseCreatorJson(repaired);
          send("final", { ok: true, content: repaired, repaired: true });
          clearInterval(heartbeat);
          controller.close();
          return;
        }
      } catch (e: any) {
        send("error", { ok: false, error: String(e?.message || e) });
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
