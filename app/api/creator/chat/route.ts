import { NextResponse } from "next/server";
import { CREATOR_OUTPUT_FORMAT_ADDON, CREATOR_SYSTEM_PROMPT } from "@/lib/creator/systemPrompt";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const OPENROUTER_MODELS = [
  // 默认：免费模型（用户要求）
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "anthropic/claude-sonnet-4.6",
  "deepseek/deepseek-v3.2",
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
    for (const f of obj.files) {
      if (!f || typeof f !== "object") throw new Error("BAD_FILE_ITEM");
      if (!["index.html", "style.css", "game.js"].includes(String(f.path || ""))) throw new Error("BAD_FILE_PATH");
      if (typeof f.content !== "string") throw new Error("BAD_FILE_CONTENT");
    }
  }
  return obj;
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });

  let body: { messages?: Msg[]; model?: string; provider?: string; promptAddon?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

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
    const ml = String(model || "").toLowerCase();
    const needProxy =
      (ml.startsWith("google/") && ml.includes("gemini")) ||
      ml.startsWith("openai/") ||
      (ml.startsWith("anthropic/") && ml.includes("claude"));
    if (needProxy) {
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
        try {
          resp = await callModelStream(payloadBase);
        } catch (e: any) {
          // 默认优先 OpenRouter，但如果 OpenRouter 网络失败且 DeepSeek 可用，则自动回退一次
          const em = String(e?.message || e);
          const canFallback = provider === "openrouter" && !!(process.env.DEEPSEEK_API_KEY || "");
          if (canFallback && em.toLowerCase().includes("fetch_failed")) {
            sendStatus("OpenRouter 连接失败，我先切到 DeepSeek 再试一次…");
            provider = "deepseek";
            authKey = process.env.DEEPSEEK_API_KEY || "";
            const baseUrl = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
            url = `${baseUrl}/v1/chat/completions`;
            model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
            payloadBase.model = model;
            // DeepSeek API 不支持 OpenRouter 的 provider routing
            delete payloadBase.provider;
            // 通知前端：已经回退
            sendMeta({ provider, model, reason: "fallback_openrouter_fetch_failed" });
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
