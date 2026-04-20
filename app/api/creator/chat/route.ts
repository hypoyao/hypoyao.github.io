import { NextResponse } from "next/server";
import { CREATOR_OUTPUT_FORMAT_ADDON, CREATOR_SYSTEM_PROMPT } from "@/lib/creator/systemPrompt";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Msg = { role: "system" | "user" | "assistant"; content: string };

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
  }
  if (!obj || typeof obj !== "object") throw new Error("NOT_JSON_OBJECT");
  if (typeof obj.assistant !== "string") throw new Error("MISSING_ASSISTANT");
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
  const key = process.env.DEEPSEEK_API_KEY || "";
  if (!key) return json(500, { ok: false, error: "MISSING_DEEPSEEK_API_KEY" });

  let body: { messages?: Msg[]; model?: string; promptAddon?: string };
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

  const baseUrl = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;
  const picked = (body as any)?.model;
  const envModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const model = picked === "deepseek-chat" || picked === "deepseek-reasoner" ? picked : envModel;

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
  // DeepSeek 通常兼容 OpenAI 的 response_format；如果不支持，会返回错误，我们会在下方兜底重试非 json_mode
  payloadBase.response_format = { type: "json_object" };

  async function callDeepSeekStream(payload: any) {
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });
  }

  async function callDeepSeekOnce(payload: any) {
    // 尽量也用 json_object，减少模型“解释/思考”导致的超长输出；
    // 如果不兼容，再自动退回普通模式。
    const p0 = { ...payload, stream: false };
    const doReq = async (p: any) => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(p),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j?.error?.message || j?.message || r.status;
        throw new Error(`DEEPSEEK_ERROR:${msg}`);
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
      // SSE 心跳：避免部分网关/代理在“长时间无数据”时主动断开
      const heartbeat = setInterval(() => {
        try {
          send("ping", { t: Date.now() });
        } catch {}
      }, 12000);

      let resp: Response | null = null;
      try {
        sendStatus("AI 正在理解你的想法…");
        resp = await callDeepSeekStream(payloadBase);
        if (!resp.ok) {
          // response_format 可能不兼容，退回普通 stream
          try {
            resp.body?.cancel();
          } catch {}
          delete payloadBase.response_format;
          resp = await callDeepSeekStream(payloadBase);
        }
        if (!resp.ok || !resp.body) {
          const j = await resp.json().catch(() => ({}));
          const msg = j?.error?.message || j?.message || resp.status;
          throw new Error(`DEEPSEEK_ERROR:${msg}`);
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
          const once = await callDeepSeekOnce({
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
          const repaired = await callDeepSeekOnce({
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
