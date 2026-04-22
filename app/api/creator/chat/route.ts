import { NextResponse } from "next/server";
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

// ===== Planner -> Coder（分步生成，默认开启）=====
// 目的：避免一次性生成过长导致超时/截断/JSON 崩溃
const PLANNER_PROMPT = `
你是“架构师（Planner）”。你的任务不是写代码，而是把用户的小游戏需求拆解成一个可执行的开发蓝图。

【输出要求】
1) 只输出合法 JSON，不要输出任何 Markdown/解释文字。
2) 必须包含 meta 与 tasks：
   - meta：用于 meta.json（title/shortDesc/rules/creator{name}）
   - tasks：按顺序给出需要生成的文件（index.html/style.css/game.js/prompt.md）
3) 每个文件的生成尽量控制在 200 行左右，优先最小可运行版本，后续可迭代。

【JSON Schema】
{
  "meta": { "title": "...", "shortDesc": "...", "rules": "...", "creator": { "name": "..." } },
  "tasks": [
    { "path": "index.html", "instruction": "..." },
    { "path": "style.css", "instruction": "..." },
    { "path": "game.js", "instruction": "..." },
    { "path": "prompt.md", "instruction": "..." }
  ]
}
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

function coderPrompt(blueprint: any, filePath: string) {
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

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const ownerKey = ownerKeyFromSession(sess);

  let body: { messages?: Msg[]; model?: string; provider?: string; promptAddon?: string; gameId?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }
  const gameId = String((body as any)?.gameId || "").trim();
  const safeGameId = gameId && /^[a-zA-Z0-9_-]+$/.test(gameId) ? gameId : "";

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
    try {
      return await fetch(url, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      const code = e?.cause?.code || e?.code || "";
      const msg = String(code || e?.message || e);
      throw new Error(`FETCH_FAILED:${msg}`);
    }
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
    } catch (e) {
      // retry without response_format
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

        const callStreamRobust = async (payload: any, stepTag: string, strictJson = false) => {
          try {
            return await callStreamToString(payload, stepTag, strictJson);
          } catch (e: any) {
            const em = String(e?.message || e);
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

        if (!forceLegacy) {
          // ===== Planner -> Coder 分步生成 =====
          // 分阶段模型策略：
          // - Planner：优先 OpenAI GPT-5.4 Nano，其次 GPT-5.4 Mini；最后回退到当前选择
          // - Coder：优先 DeepSeek V3.2（OpenRouter），其次 Qwen3.6 Plus；再回退当前选择
          // - Review：优先 Gemini 2.5 Flash，其次 GPT-4o-mini，再回退 Gemini 3 Flash Preview（或当前选择）
          const hasOpenRouter = !!(process.env.OPENROUTER_API_KEY || "");

          // 允许通过环境变量覆盖（便于本地/线上按地区可用性调整）
          const plannerOverride = envModelOrEmpty("CREATOR_PLANNER_MODEL");
          const coderOverride = envModelOrEmpty("CREATOR_CODER_MODEL");
          const reviewOverride = envModelOrEmpty("CREATOR_REVIEW_MODEL");

          const plannerModel = hasOpenRouter
            ? pickOpenRouterModel([plannerOverride, "openai/gpt-5.4-nano", "openai/gpt-5.4-mini"].filter(Boolean) as string[])
            : model;
          const coderModel = hasOpenRouter
            ? pickOpenRouterModel([coderOverride, "deepseek/deepseek-v3.2", "qwen/qwen3.6-plus"].filter(Boolean) as string[])
            : model;
          const reviewerModel = hasOpenRouter
            ? pickOpenRouterModel(
                [reviewOverride, "google/gemini-2.5-flash", "openai/gpt-4o-mini", "google/gemini-3-flash-preview"].filter(Boolean) as string[],
              )
            : model;

          // 断点续跑：若传了 gameId 且属于当前用户，则把每一步生成的文件写入草稿 DB，
          // 下次重试会跳过已完成文件，从失败那一步继续。
          let canCheckpoint = false;
          if (safeGameId && ownerKey) {
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
          }

          const upsertDraftFile = async (path: string, content: string) => {
            if (!canCheckpoint) return;
            await db.execute(sql`
              insert into creator_draft_files (game_id, path, content)
              values (${safeGameId}, ${path}, ${content})
              on conflict (game_id, path)
              do update set content = excluded.content, updated_at = now()
            `);
          };

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

          const showModel = () => `${provider} / ${model}`;
          // 总步骤：1（蓝图）+ 4（四个文件）+ 1（review）
          const totalSteps = 1 + 4 + 1;
          let step = 1;
          // Planner 使用独立模型（OpenRouter/OpenAI）
          if (provider === "openrouter") model = plannerModel;
          sendMeta({ provider, model, phase: "planner" });
          sendStatus(`（${step}/${totalSteps}）架构师：生成蓝图（${showModel()}）…`);
          const userMsgs = messages.filter((m) => m.role === "user").slice(-4);

          // 若已存在 plan 且 user input 相同，则跳过 planner
          const lastUserInput = String(userMsgs[userMsgs.length - 1]?.content || "").trim();
          let blueprint: any = null;
          if (canCheckpoint) {
            const metaRaw = await readDraftFile("meta.json");
            const metaObj = metaRaw ? parseJsonObjectLoose(metaRaw) : null;
            const plan = metaObj && typeof metaObj === "object" ? (metaObj as any)._plan : null;
            if (plan && typeof plan === "object" && String(plan.userInput || "") === lastUserInput && Array.isArray(plan.tasks)) {
              blueprint = { meta: safeMeta(metaObj), tasks: normalizePlannerTasks(plan.tasks) };
              sendStatus(`（${step}/${totalSteps}）架构师：复用已有蓝图（${showModel()}）…`);
            }
          }

          if (!blueprint) {
          const plannerPayload: any = {
            model,
            messages: [{ role: "system", content: PLANNER_PROMPT }, ...userMsgs],
            temperature: 0.2,
            max_tokens: 900,
            response_format: { type: "json_object" },
          };
          if (provider === "openrouter" && payloadBase.provider) plannerPayload.provider = payloadBase.provider;
            const plannerText = await callStreamRobust(plannerPayload, `步骤 ${step}/${totalSteps}：蓝图 JSON`, true);
            let bp0 = parseJsonObjectLoose(plannerText);
            if (!bp0) {
              // 兜底：让“修复器”把内容转成严格 JSON
              sendStatus("蓝图不是严格 JSON，正在修复为 JSON…");
              const repairPrompt =
                `请把下面文本修复为严格 JSON，且必须符合 Schema：{meta:{title,shortDesc,rules,creator{name}},tasks:[{path,instruction}...] }。\n` +
                `只输出 JSON，不要 markdown，不要解释。\n\n` +
                `原文：\n${plannerText}\n`;
              const repairPayload: any = {
                model,
                messages: [
                  { role: "system", content: "你是 JSON 修复器。只输出 JSON（json_object）。" },
                  { role: "user", content: repairPrompt },
                ],
                temperature: 0.0,
                max_tokens: 900,
                response_format: { type: "json_object" },
              };
              if (provider === "openrouter" && payloadBase.provider) repairPayload.provider = payloadBase.provider;
              const repairedText = await callStreamRobust(repairPayload, `步骤 ${step}/${totalSteps}：修复蓝图 JSON`, true);
              bp0 = parseJsonObjectLoose(repairedText);
            }
            if (!bp0) throw new Error("PLANNER_NOT_JSON");
          blueprint = { meta: safeMeta((bp0 as any).meta), tasks: normalizePlannerTasks((bp0 as any).tasks) };
          if (!blueprint.meta.title) blueprint.meta.title = "未命名作品";
          // 保存 plan 到 meta.json（隐藏字段），用于断点续跑
          if (canCheckpoint) {
            const metaWithPlan = {
              ...blueprint.meta,
                _plan: {
                  v: 2,
                  userInput: lastUserInput,
                  tasks: blueprint.tasks,
                  models: { planner: plannerModel, coder: coderModel, reviewer: reviewerModel },
                  createdAt: Date.now(),
                },
            };
            await upsertDraftFile("meta.json", JSON.stringify(metaWithPlan, null, 2));
          }
          }

          const files: Array<{ path: string; content: string }> = [];
          // 只生成我们允许的 4 个文件（normalizePlannerTasks 已补齐并排序）
          for (const t of blueprint.tasks) {
            const p = t.path;
            step++;
            // 若已存在该文件且 plan 未变，则跳过生成
            if (canCheckpoint) {
              const ex = await readDraftFile(p);
              if (ex && ex.trim()) {
                sendStatus(`（${step}/${totalSteps}）程序员：跳过 ${p}（已生成）`);
                files.push({ path: p, content: ex });
                continue;
              }
            }
            // Coder 使用独立模型（优先 DeepSeek V3.2 / Qwen3.6 Plus）
            if (provider === "openrouter") model = coderModel;
            sendMeta({ provider, model, phase: "coder", file: p });
            sendStatus(`（${step}/${totalSteps}）程序员：生成 ${p}（${showModel()}）…`);
            const pld: any = {
              model,
              messages: [
                { role: "system", content: coderPrompt(blueprint, p) },
                { role: "user", content: t.instruction || `请生成 ${p}` },
              ],
              temperature: 0.3,
              max_tokens: p === "game.js" ? 1400 : p === "index.html" ? 1200 : 900,
              response_format: { type: "json_object" },
            };
            if (provider === "openrouter" && payloadBase.provider) pld.provider = payloadBase.provider;
              const outText = await callStreamRobust(pld, `步骤 ${step}/${totalSteps}：生成 ${p}`, true);
            const obj = parseJsonObjectLoose(outText);
            const outPath = String((obj as any)?.path || "").trim();
            const outContent = String((obj as any)?.content || "");
            if (outPath !== p) throw new Error(`CODER_BAD_PATH:${p}:${outPath || "EMPTY"}`);
            if (!outContent.trim()) throw new Error(`CODER_EMPTY_CONTENT:${p}`);
            files.push({ path: outPath, content: outContent });
            await upsertDraftFile(outPath, outContent);
          }
          // meta.json：若已存在 plan 版，则读取；否则写入基础 meta
          if (canCheckpoint) {
            const metaFinal = await readDraftFile("meta.json");
            files.push({ path: "meta.json", content: metaFinal || JSON.stringify(blueprint.meta, null, 2) });
            if (!metaFinal) await upsertDraftFile("meta.json", JSON.stringify({ ...blueprint.meta, _plan: { v: 1, userInput: lastUserInput, tasks: blueprint.tasks } }, null, 2));
          } else {
            files.push({ path: "meta.json", content: JSON.stringify(blueprint.meta, null, 2) });
          }

          // 3) Integrating/Review：让模型做一次轻量自检（可选但默认开启）
          step++;
          if (provider === "openrouter") model = reviewerModel;
          sendMeta({ provider, model, phase: "review" });
          sendStatus(`（${step}/${totalSteps}）整合与自检（${showModel()}）…`);
          const compactFiles = files
            .filter((f) => ["index.html", "style.css", "game.js"].includes(f.path))
            .map((f) => {
              const c = String(f.content || "");
              // 限制传入长度，避免 review 再次超长
              const trimmed = c.length > 9000 ? c.slice(0, 9000) + "\n/* ...TRUNCATED... */" : c;
              return { path: f.path, content: trimmed };
            });
          const reviewPrompt =
            `请快速检查这 3 个文件是否能互相引用并运行（只做最小修正）。\n` +
            `要求：只输出 JSON：{"patches":[{"path":"index.html|style.css|game.js","content":"..."}]}\n` +
            `如果无需修改，patches 为空数组。\n` +
            `注意：不要解释文字，不要 markdown。\n\n` +
            `文件：\n${JSON.stringify(compactFiles, null, 2)}\n`;
          const reviewPayload: any = {
            model,
            messages: [
              { role: "system", content: "你是资深前端工程师，擅长快速自检与最小补丁修复。只输出 JSON。" },
              { role: "user", content: reviewPrompt },
            ],
            temperature: 0.2,
            max_tokens: 900,
            response_format: { type: "json_object" },
          };
          if (provider === "openrouter" && payloadBase.provider) reviewPayload.provider = payloadBase.provider;
          try {
            const reviewText = await callStreamRobust(reviewPayload, `步骤 ${step}/${totalSteps}：自检补丁`, true);
            const reviewObj = parseJsonObjectLoose(reviewText);
            const patches = Array.isArray((reviewObj as any)?.patches) ? (reviewObj as any).patches : [];
            for (const p of patches) {
              const pp = String(p?.path || "").trim();
              const cc = String(p?.content || "");
              if (!["index.html", "style.css", "game.js"].includes(pp)) continue;
              if (!cc.trim()) continue;
              // 应用 patch
              for (let i = 0; i < files.length; i++) {
                if (files[i].path === pp) files[i] = { path: pp, content: cc };
              }
              await upsertDraftFile(pp, cc);
            }
          } catch {
            // review 失败不阻断主流程
          }

          const assistantText = `已生成最小可运行版本：${blueprint.meta.title}。\n如果你想加功能/换皮肤/加排行榜，继续告诉我即可。`;
          const finalObj = { assistant: assistantText, meta: blueprint.meta, files };

          sendStatus("AI 正在检查输出格式…");
          // 复用原校验：确保最终结构符合前端约定
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
