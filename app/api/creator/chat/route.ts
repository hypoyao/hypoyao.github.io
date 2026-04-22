import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Script } from "node:vm";
import { CREATOR_OUTPUT_FORMAT_ADDON, CREATOR_SYSTEM_PROMPT } from "@/lib/creator/systemPrompt";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const OPENROUTER_MODELS = [
  // 默认：免费模型（用户要求）
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3.6-plus",
  "qwen/qwen-2.5-72b-instruct:free",
  "deepseek/deepseek-v3.2",
  // Architect / Refine（用户选择）
  "anthropic/claude-sonnet-4.6",
  // Planner / Review 阶段（按需自动使用）
  "openai/gpt-5.4-nano",
  "openai/gpt-5.4-mini",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  // Gemini：有些地区/本地网络下走官方节点容易被拦，后端会对该类模型加 provider routing（见下方）
  "google/gemini-3-flash",
  "google/gemini-3-flash-preview",
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
2) 输出结构必须是：
{ "assistant": "...", "files": [ { "path": "...", "content": "..." } ] }
3) 只允许改这些文件：index.html / style.css / game.js
4) 最小改动原则：不要无意义重写；保持原有结构与命名协议。
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
  let provider: "openrouter" | "deepseek" = "openrouter";
  if (providerRaw === "deepseek") provider = "deepseek";
  else if (providerRaw === "openrouter") provider = "openrouter";
  else provider = hasOpenRouter ? "openrouter" : "deepseek";

  let url = "";
  let authKey = "";
  let model = "";
  if (provider === "deepseek") {
    authKey = process.env.DEEPSEEK_API_KEY || "";
    if (!authKey) {
      // DeepSeek 未配置时自动回退 OpenRouter
      if (hasOpenRouter) {
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

  async function callModelStream(payload: any) {
    const maxTry = 2;
    for (let k = 1; k <= maxTry; k++) {
      try {
        // 超时兜底：避免请求永远挂起导致前端表现为“网络错误”
        return await fetch(url, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120_000),
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

  async function callModelOnce(payload: any) {
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
          signal: AbortSignal.timeout(120_000),
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

        const canFallback = provider === "openrouter" && !!(process.env.DEEPSEEK_API_KEY || "");
        const fallbackToDeepSeek = async () => {
          provider = "deepseek";
          authKey = process.env.DEEPSEEK_API_KEY || "";
          const baseUrl = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
          url = `${baseUrl}/v1/chat/completions`;
          model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
          // 通知前端：已经回退
          sendMeta({ provider, model, reason: "fallback_openrouter_fetch_failed" });
        };

        // 对分步生成：每一步也做“流式输出”并把 token 增量推给前端，让用户看到进度
        const callStreamToString = async (payload: any, stepTag: string, strictJson = false) => {
          // payload.stream 必须为 true
          const p0: any = { ...payload, stream: true };
          const doReq = async (p: any) => {
            let r: Response;
            try {
              r = await callModelStream(p);
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
              const once = await callModelOnce({ ...payload, stream: false });
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
        ) => {
          try {
            return await callStreamToString(payload, stepTag, strictJson);
          } catch (e: any) {
            const em = String(e?.message || e);
            const eml = em.toLowerCase();

            // 如果是 OpenAI/Gemini 这类模型在当前网络/地区不稳定，优先“换模型”再试一次
            // （仍走 OpenRouter，不切 provider），避免一直卡在 region / 网关不稳定上。
            const canSwapModel = provider === "openrouter" && Array.isArray(fallbackModels) && fallbackModels.length > 0;
            const isRegionBlocked =
              eml.includes("not available in your region") ||
              eml.includes("region") ||
              eml.includes("country") ||
              eml.includes("location");
            const isModelUnavailable =
              eml.includes("model_not_found") || eml.includes("model not found") || eml.includes("deprecated") || eml.includes("not available");
            const isNetwork = eml.includes("fetch_failed") || eml.includes("network error") || eml.includes("timeout");
            if (canSwapModel && (isRegionBlocked || isModelUnavailable || isNetwork)) {
              const picked = pickOpenRouterModel(fallbackModels);
              if (picked && picked !== String(payload?.model || "")) {
                sendStatus(`当前模型不稳定/不可用，我切换到 ${picked} 再试一次…`);
                sendMeta({ provider, model: picked, reason: "fallback_model_unstable" });
                const p2: any = { ...payload, model: picked };
                // 对 Gemini 的 provider routing 仅对 gemini 生效；换到 deepseek/qwen 就不需要了
                if (!String(picked).toLowerCase().startsWith("google/")) delete p2.provider;
                try {
                  return await callStreamToString(p2, stepTag, strictJson);
                } catch (e2: any) {
                  // 继续走下面的 provider fallback
                }
              }
            }

            if (canFallback && em.toLowerCase().includes("fetch_failed")) {
              sendStatus("OpenRouter 连接失败，我先切到 DeepSeek 再试一次…");
              await fallbackToDeepSeek();
              const p2: any = { ...payload };
              delete p2.provider;
              return await callStreamToString(p2, stepTag, strictJson);
            }
            throw e;
          }
        };

        // 每一步“自动重试一次”，避免用户手动点重试
        const autoRetry = async <T>(
          run: () => Promise<T>,
          label: string,
          retryHint: string,
        ): Promise<T> => {
          try {
            return await run();
          } catch (e: any) {
            const em = String(e?.message || e);
            sendStatus(`${label}失败，自动重试一次…（原因：${em.slice(0, 120)}）`);
            sendDelta(`\n\n（自动重试提示）${retryHint}\n`);
            // 给网络/模型一点喘息时间
            await new Promise((r) => setTimeout(r, 280));
            return await run();
          }
        };

        // ===== Fix 模式：最小补丁修复（不走 Planner/Coder 全流程）=====
        if (mode === "fix") {
          if (!safeGameId) throw new Error("MISSING_GAME_ID");
          if (!ownerKey) throw new Error("UNAUTHORIZED");
          let canCheckpoint = false;
          const readDraftFile = async (path: string) => {
            if (!canCheckpoint) return "";
            const rows = await db.execute(sql`
              select content
              from creator_draft_files
              where game_id = ${safeGameId} and path = ${path}
              limit 1
            `);
            const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
            const c = list?.[0]?.content;
            return typeof c === "string" ? c : "";
          };
          const upsertDraftFile = async (path: string, content: string) => {
            if (!canCheckpoint) return;
            await db.execute(sql`
              insert into creator_draft_files (game_id, path, content)
              values (${safeGameId}, ${path}, ${content})
              on conflict (game_id, path)
              do update set content = excluded.content, updated_at = now()
            `);
          };

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
          // ===== 新方案：Architect -> 单文件 MVP -> （沙箱自愈）-> 拆分 -> 迭代补丁 =====
          const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY || "");

          // 环境变量覆盖：便于线上/本地根据地区可用性调整
          const architectOverride = envModelOrEmpty("CREATOR_ARCHITECT_MODEL");
          const mvpOverride = envModelOrEmpty("CREATOR_MVP_MODEL");
          const refineOverride = envModelOrEmpty("CREATOR_REFINE_MODEL");
          const debugOverride = envModelOrEmpty("CREATOR_DEBUG_MODEL");

          const architectModel = hasOpenRouter
            ? pickOpenRouterModel([architectOverride, "anthropic/claude-sonnet-4.6", "qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"].filter(Boolean) as string[])
            : model;
          const mvpModel = hasOpenRouter
            ? pickOpenRouterModel([mvpOverride, "qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"].filter(Boolean) as string[])
            : model;
          const refineModel = hasOpenRouter
            ? pickOpenRouterModel([refineOverride, "anthropic/claude-sonnet-4.6", "qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"].filter(Boolean) as string[])
            : model;
          const debugModel = hasOpenRouter
            ? pickOpenRouterModel([debugOverride, "openai/gpt-4o-mini", "qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"].filter(Boolean) as string[])
            : model;

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

          const upsertDraftFile = async (path: string, content: string) => {
            await db.execute(sql`
              insert into creator_draft_files (game_id, path, content)
              values (${safeGameId}, ${path}, ${content})
              on conflict (game_id, path)
              do update set content = excluded.content, updated_at = now()
            `);
          };
          const readDraftFile = async (path: string) => {
            const rows = await db.execute(sql`
              select content
              from creator_draft_files
              where game_id = ${safeGameId} and path = ${path}
              limit 1
            `);
            const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
            const c = list?.[0]?.content;
            return typeof c === "string" ? c : "";
          };

          const hash12 = (s: string) => crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
          const showModel = () => `${provider} / ${model}`;

          const readMetaObj = async () => {
            const metaRaw = await readDraftFile("meta.json");
            const metaObj = metaRaw ? parseJsonObjectLoose(metaRaw) : null;
            return metaObj && typeof metaObj === "object" ? metaObj : null;
          };

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
                  await callStreamRobust(debugPayload, `Debug：修复补丁`, true, ["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"]),
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
          const index0 = await readDraftFile("index.html");
          const style0 = await readDraftFile("style.css");
          const game0 = await readDraftFile("game.js");
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
              async () => await callStreamRobust(payload, "阶段1：蓝图 JSON", true, ["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"]),
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
                  await callStreamRobust(repairPayload, "阶段1：修复蓝图 JSON", true, ["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"]),
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
            if (provider === "openrouter") model = mvpModel;
            sendMeta({ provider, model, phase: "mvp" });
            const payload: any = {
              model,
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
              async () => await callStreamRobust(payload, "阶段2：单文件 MVP", true, ["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"]),
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
          const errs0 = validateScripts(files);
          if (errs0.length) {
            files = await selfHeal("沙箱检查", files, errs0.join("\n"), 2);
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
              const errs = validateScripts(splitFiles);
              if (!errs.length) {
                await upsertDraftFile("index.html", indexNew);
                await upsertDraftFile("style.css", cssNew);
                await upsertDraftFile("game.js", jsNew);
                files = splitFiles;
                const metaNow = (await readMetaObj()) || {};
                (metaNow as any)._gen = { v: 1, stage: "split_done", splitted: true, updatedAt: Date.now(), lastGood: hash12(indexNew + cssNew + jsNew) };
                await upsertDraftFile("meta.json", JSON.stringify(metaNow, null, 2));
              } else {
                sendStatus("拆分后检测到问题，先保留单文件版本继续运行。");
              }
            }
          }

          // ===== 阶段 3：Refine（在活代码上全量替换或多文件补丁）=====
          const isFirstGen = !hasIndex;
          if (!isFirstGen) {
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
            const outText = await autoRetry(
              async () => await callStreamRobust(payload, "阶段3：迭代补丁", true, ["qwen/qwen3.6-plus", "deepseek/deepseek-v3.2"]),
              "迭代补丁",
              "只输出 JSON，files 里包含修改后的完整文件内容。",
            );
            const obj = parseJsonObjectLoose(outText);
            const outFiles = Array.isArray((obj as any)?.files) ? (obj as any).files : [];
            // 合并更新（只允许 3 个文件）
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
            if (errs.length) files = await selfHeal("迭代后沙箱检查", files, errs.join("\n"), 2);
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
          // 默认优先 OpenRouter，但如果 OpenRouter 网络失败且 DeepSeek 可用，则自动回退一次
          const em = String(e?.message || e);
          if (canFallback && em.toLowerCase().includes("fetch_failed")) {
            sendStatus("OpenRouter 连接失败，我先切到 DeepSeek 再试一次…");
            await fallbackToDeepSeek();
            payloadBase.model = model;
            delete payloadBase.provider;
            resp = await callModelStream(payloadBase);
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
