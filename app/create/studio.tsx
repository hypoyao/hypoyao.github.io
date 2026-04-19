"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

type ModelFile = { path: string; content: string };

function nowId() {
  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {}
  // 尝试提取 ```json ... ```
  const m = s.match(/```json\s*([\s\S]*?)```/i);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  return null;
}

const THINK_PREFIX = "[[THINK]]";

function parseSseChunk(state: { buf: string }, chunk: string) {
  state.buf += chunk;
  const events: Array<{ event: string; data: any }> = [];
  let idx;
  while ((idx = state.buf.indexOf("\n\n")) >= 0) {
    const block = state.buf.slice(0, idx).trim();
    state.buf = state.buf.slice(idx + 2);
    if (!block) continue;
    const lines = block.split("\n");
    let ev = "message";
    let dataLine = "";
    for (const ln of lines) {
      if (ln.startsWith("event:")) ev = ln.slice(6).trim();
      else if (ln.startsWith("data:")) dataLine += ln.slice(5).trim();
    }
    if (!dataLine) continue;
    try {
      events.push({ event: ev, data: JSON.parse(dataLine) });
    } catch {
      // ignore bad json
    }
  }
  return events;
}

export default function CreateStudio() {
  const [gameId, setGameId] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("/games/creator-playground/index.html");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [input, setInput] = useState("");
  const [model, setModel] = useState<"deepseek-chat" | "deepseek-reasoner">("deepseek-chat");
  const listRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number }>>([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [published, setPublished] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const speechRef = useRef<any>(null);

  // 注意：messages 里不放 system；发送给后端时会自动拼接 systemPrompt
  const [messages, setMessages] = useState<ChatMsg[]>(() => [
    { role: "assistant", content: "你好！把你想做的小游戏告诉我吧（玩法、按钮、胜负条件、画面风格）。" },
  ]);

  const viewMessages = useMemo(() => messages, [messages]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [viewMessages.length, busy]);

  function entryOf(gid: string) {
    return `/games/${gid}/index.html`;
  }

  async function newGame() {
    const r = await fetch("/api/creator/new", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok || !j?.gameId) throw new Error(j?.error || "NEW_GAME_FAILED");
    setGameId(j.gameId);
    return j.gameId as string;
  }

  async function ensureSeed(gid: string) {
    // 初始化该小游戏文件（seed 模式下 index.html 不会覆盖已存在内容）
    await fetch("/api/creator/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId: gid,
        seed: true,
        files: [
          {
            path: "index.html",
            content:
              "<!doctype html><html lang='zh-CN'><head><meta charset='UTF-8'/>" +
              "<meta name='viewport' content='width=device-width,initial-scale=1.0'/>" +
              "<title>我的小游戏</title><link rel='stylesheet' href='./style.css'/>" +
              "</head><body><main class='wrap'><section class='card'>" +
              "<header class='header'><h1>我的小游戏</h1><p class='desc'>在左侧对话生成/修改这个游戏。</p></header>" +
              "<div id='app' class='card' style='margin-top:10px'></div>" +
              "</section></main><script src='./game.js'></script></body></html>",
          },
          {
            path: "style.css",
            content:
              "body{margin:0;background:linear-gradient(180deg,#f8fafc,#eef2ff)}" +
              "#app{padding:14px;border-radius:16px;border:1px solid rgba(15,23,42,0.10);" +
              "background:rgba(255,255,255,0.70)}",
          },
          {
            path: "game.js",
            content:
              "(()=>{const el=document.getElementById('app');" +
              "if(!el) return; el.innerHTML=\"<div style='font-weight:900'>准备就绪 ✅</div>\";})();",
          },
        ],
      }),
    });
  }

  useEffect(() => {
    // 进入页面：先拉取历史项目；有就默认选最新一个，没有就新建
    (async () => {
      try {
        const me = await fetch("/api/me", { cache: "no-store" })
          .then((x) => x.json())
          .catch(() => null);
        setLoggedIn(!!me?.loggedIn);

        const r = await fetch("/api/creator/list", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        const arr = Array.isArray(j?.games) ? j.games : [];
        setProjects(arr);
        if (arr.length && arr[0]?.gameId) {
          setGameId(arr[0].gameId);
          setPreviewUrl(`${entryOf(arr[0].gameId)}?t=${encodeURIComponent(nowId())}`);
          return;
        }
      } catch {}
      try {
        const gid = await newGame();
        await ensureSeed(gid);
        setPreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`);
        // 刷新项目列表
        const r2 = await fetch("/api/creator/list", { cache: "no-store" });
        const j2 = await r2.json().catch(() => ({}));
        setProjects(Array.isArray(j2?.games) ? j2.games : []);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 检查当前游戏是否已发布（用于显示“发布/更新”）
  useEffect(() => {
    if (!gameId) {
      setPublished(false);
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(gameId)}`, { cache: "no-store" });
        setPublished(r.ok);
      } catch {
        setPublished(false);
      }
    })();
  }, [gameId]);

  // 语音输入（浏览器 SpeechRecognition，优先给孩子用）
  useEffect(() => {
    try {
      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) {
        setSpeechSupported(false);
        return;
      }
      setSpeechSupported(true);
      const rec = new SR();
      rec.lang = "zh-CN";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (ev: any) => {
        let text = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          text += ev.results[i][0]?.transcript || "";
        }
        if (text) setInput((v) => (v ? v + text : text));
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      speechRef.current = rec;
    } catch {
      setSpeechSupported(false);
    }
  }, []);

  function toggleSpeech() {
    if (!speechSupported || !speechRef.current) {
      setMsg("当前浏览器不支持语音输入（建议用 Chrome）。");
      return;
    }
    if (busy) return;
    try {
      setMsg("");
      if (listening) {
        speechRef.current.stop();
        setListening(false);
      } else {
        // 开始识别时不清空输入，直接续写
        speechRef.current.start();
        setListening(true);
      }
    } catch {
      setListening(false);
    }
  }

  useEffect(() => {
    try {
      const m = window.localStorage.getItem("creator.model");
      if (m === "deepseek-chat" || m === "deepseek-reasoner") setModel(m);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("creator.model", model);
    } catch {}
  }, [model]);

  async function refreshProjects() {
    const r = await fetch("/api/creator/list", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j?.games) ? j.games : [];
    setProjects(arr);
    return arr as Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number }>;
  }

  async function writeFiles(files: ModelFile[]) {
    if (!gameId) throw new Error("NO_GAME_ID");
    const r = await fetch("/api/creator/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId, files }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || "WRITE_FAILED");
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setMsg("");
    setInput("");
    const startAt = Date.now();

    const myMsg: ChatMsg = { role: "user", content: text };
    const snap: ChatMsg[] = [...messages, myMsg, { role: "assistant", content: "AI 开始写代码…" }];
    setMessages(snap);

    try {
      const r = await fetch("/api/creator/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 只传 user/assistant；system 由服务端统一注入
        body: JSON.stringify({ messages: [...messages, myMsg], model }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || "CHAT_FAILED");
      }

      const ct = r.headers.get("content-type") || "";
      let finalContent = "";
      let repaired = false;
      if (ct.includes("text/event-stream") && r.body) {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        const sseState = { buf: "" };
        const withTime = (t: string) => {
          const sec = Math.max(1, Math.floor((Date.now() - startAt) / 1000));
          return `${t}（${sec}s）`;
        };
        let draft = "";
        let lastPaint = 0;
        let statusLine = withTime("AI 正在准备…");

        const paintDraft = (force = false) => {
          const now = Date.now();
          if (!force && now - lastPaint < 80) return;
          lastPaint = now;
          // 避免太长卡 UI：只展示最后 6000 字符
          const shown = draft.length > 6000 ? "…（已省略前面内容）\n" + draft.slice(-6000) : draft;
          setMessages((m) => {
            const mm = m.slice();
            for (let i = mm.length - 1; i >= 0; i--) {
              if (mm[i].role === "assistant") {
                // 用一个特殊前缀，让渲染层把“思考过程”折叠起来
                mm[i] = {
                  role: "assistant",
                  content: `${THINK_PREFIX}\n${statusLine}\n${shown || ""}`,
                };
                break;
              }
            }
            return mm;
          });
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          const events = parseSseChunk(sseState, chunk);
          for (const ev of events) {
            if (ev.event === "status") {
              const t = String(ev.data?.text || "AI 思考中…");
              statusLine = withTime(t);
              paintDraft(true);
            } else if (ev.event === "delta") {
              const t = String(ev.data?.text || "");
              if (t) {
                draft += t;
                paintDraft(false);
              }
            } else if (ev.event === "final") {
              finalContent = String(ev.data?.content || "");
              repaired = !!ev.data?.repaired;
              // 最后强制刷新一次 draft，确保用户看到完整输出（或至少尾部）
              if (draft) paintDraft(true);
            } else if (ev.event === "error") {
              throw new Error(String(ev.data?.error || "CHAT_STREAM_ERROR"));
            }
          }
        }
      } else {
        // 兼容非流式（理论上不会走到这里）
        const data = await r.json().catch(() => ({}));
        if (!data?.ok) throw new Error(data?.error || "CHAT_FAILED");
        finalContent = String(data?.content || "");
      }

      if (!finalContent) throw new Error("EMPTY_MODEL_RESPONSE");
      const parsed = safeJsonParse(finalContent);
      if (!parsed) throw new Error("AI_OUTPUT_NOT_JSON");

      const assistantText = String(parsed.assistant || "").trim() || (repaired ? "（AI 已自动修复输出格式）" : "（AI 回复为空）");
      // 把占位消息替换为最终文本
      setMessages((m) => {
        const mm = m.slice();
        for (let i = mm.length - 1; i >= 0; i--) {
          if (mm[i].role === "assistant") {
            mm[i] = { role: "assistant", content: assistantText };
            break;
          }
        }
        return mm;
      });

      const files = (Array.isArray(parsed.files) ? parsed.files : []) as ModelFile[];
      if (files.length) {
        await writeFiles(files);
        setPreviewUrl(`${entryOf(gameId)}?t=${encodeURIComponent(nowId())}`);
      }
    } catch (e: any) {
      const m = String(e?.message || "未知错误");
      const hint =
        m.toLowerCase().includes("missing_deepseek_api_key")
          ? "（服务端未配置 DEEPSEEK_API_KEY）"
          : m.toLowerCase().includes("terminated")
            ? "（连接被中断：可能是网络/模型超时/Key 无效/服务端被重启，建议重试）"
            : "（建议重试；如持续失败再检查 DEEPSEEK_API_KEY）";
      setMsg(`出错：${m}${hint}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="createGrid" aria-label="create studio">
      <div className="createPanel" aria-label="chat">
        <div className="createPanelHeader">
          <div>
            <div className="createPanelTitle">AI 聊天</div>
          </div>
          <div className="chatActions">
            <label style={{ display: "grid", gap: 4, minWidth: 180 }}>
              <span className="createPanelSub" style={{ margin: 0 }}>
                我的游戏
              </span>
              <select
                className="restInput"
                value={gameId}
                onChange={(e) => {
                  const gid = e.target.value;
                  setGameId(gid);
                  if (gid) setPreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`);
                }}
                disabled={busy}
                aria-label="选择历史游戏"
                style={{ padding: "8px 10px", fontSize: 13, fontWeight: 900 }}
              >
                {projects.length ? null : <option value="">（暂无历史游戏）</option>}
                {projects.map((p) => (
                  <option key={p.gameId} value={p.gameId}>
                    {(p.title && p.title.trim()) ? `${p.title}（${p.gameId}）` : p.gameId}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span className="createPanelSub" style={{ margin: 0 }}>
                模型
              </span>
              <select
                className="restInput"
                value={model}
                onChange={(e) => setModel(e.target.value as any)}
                disabled={busy}
                aria-label="选择模型"
                style={{ padding: "8px 10px", fontSize: 13, fontWeight: 900 }}
              >
                <option value="deepseek-chat">deepseek-chat（更快）</option>
                <option value="deepseek-reasoner">deepseek-reasoner（更会思考）</option>
              </select>
            </label>
            <button
              className="btn btnGray"
              type="button"
              onClick={() => {
                // 新建一个新的小游戏目录（并切换预览）
                (async () => {
                  setMessages([{ role: "assistant", content: "好耶！我们从一个全新的小游戏开始吧～你想做什么？" }]);
                  setMsg("");
                  try {
                    const gid = await newGame();
                    await ensureSeed(gid);
                    setPreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`);
                    await refreshProjects();
                  } catch (e: any) {
                    setMsg(`新建游戏失败：${e?.message || "未知错误"}`);
                  }
                })();
              }}
              disabled={busy}
            >
              新建游戏
            </button>

            <a
              className="btn"
              href={gameId ? `/publish?id=${encodeURIComponent(gameId)}` : "#"}
              onClick={(e) => {
                if (!gameId) {
                  e.preventDefault();
                  return;
                }
                if (!loggedIn) {
                  e.preventDefault();
                  if (window.confirm("发布/更新需要先登录。现在去登录吗？")) window.location.href = "/login";
                }
              }}
              style={{
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: gameId ? 1 : 0.6,
              }}
              aria-disabled={!gameId || !loggedIn}
            >
              {published ? "更新到首页" : "发布到首页"}
            </a>
            <button
              className="btn btnGray"
              type="button"
              onClick={() => {
                if (!gameId) return;
                if (!window.confirm(`确定删除这个游戏吗？\n\n${gameId}\n\n删除后无法恢复。`)) return;
                (async () => {
                  try {
                    setMsg("");
                    const r = await fetch("/api/creator/delete", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ gameId }),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok || !j?.ok) throw new Error(j?.error || "DELETE_FAILED");

                    const arr = await refreshProjects();
                    if (arr.length && arr[0]?.gameId) {
                      setGameId(arr[0].gameId);
                      setPreviewUrl(`${entryOf(arr[0].gameId)}?t=${encodeURIComponent(nowId())}`);
                      setMessages([{ role: "assistant", content: "这个游戏已删除。我们继续修改其它游戏，或者新建一个吧～" }]);
                      return;
                    }

                    // 没有任何历史游戏了：自动新建一个
                    const gid = await newGame();
                    await ensureSeed(gid);
                    setPreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`);
                    await refreshProjects();
                    setMessages([{ role: "assistant", content: "这个游戏已删除。已为你新建一个空白小游戏～你想做什么？" }]);
                  } catch (e: any) {
                    setMsg(`删除失败：${e?.message || "未知错误"}`);
                  }
                })();
              }}
              disabled={busy || !gameId}
              style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "rgba(185,28,28,0.95)" }}
            >
              删除游戏
            </button>
            <button
              className="btn btnGray"
              type="button"
              onClick={() => {
                setMessages([{ role: "assistant", content: "继续吧～你想怎么改这个游戏？" }]);
                setMsg("");
              }}
              disabled={busy}
            >
              清空对话
            </button>
          </div>
        </div>

        <div className="chatList" ref={listRef}>
          {viewMessages.map((m, idx) => (
            <div key={idx} className={`chatMsg ${m.role === "user" ? "isUser" : ""}`.trim()}>
              <div className="chatRole">{m.role === "user" ? "我" : "AI"}</div>
              {m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(THINK_PREFIX) ? (
                (() => {
                  const rest = m.content.slice(THINK_PREFIX.length).trimStart();
                  const nl = rest.indexOf("\n");
                  const summary = nl >= 0 ? rest.slice(0, nl).trim() : "AI 正在思考…";
                  const detail = nl >= 0 ? rest.slice(nl + 1) : "";
                  return (
                    <details className="thinkBox">
                      <summary className="thinkSummary">{summary}</summary>
                      <pre className="thinkBody">{detail || "（暂无输出）"}</pre>
                    </details>
                  );
                })()
              ) : (
                <div className="chatText">{m.content}</div>
              )}
            </div>
          ))}
        </div>

        <div className="chatComposer">
          {msg ? <div className="desc" style={{ color: "rgba(220,38,38,0.95)", margin: 0 }}>{msg}</div> : null}
          <div className="chatRow">
            <textarea
              className="restTextarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：做一个打地鼠小游戏，3 个洞，30 秒计时，分数统计，结束弹窗"
              rows={4}
              disabled={busy}
            />
            <div className="sendCol">
              <button className="btn btnGray" type="button" onClick={toggleSpeech} disabled={busy || !speechSupported}>
                {listening ? "停止语音" : "语音输入"}
              </button>
              <button className="btn" type="button" onClick={send} disabled={busy || !input.trim()}>
                发送
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="createPanel previewPanel" aria-label="preview">
        <div className="createPanelHeader">
          <div>
            <div className="createPanelTitle">实时预览</div>
            <div className="previewUrl">{previewUrl}</div>
          </div>
          <div className="previewToolbar">
            <button
              className="btn btnGray"
              type="button"
              onClick={() => {
                if (!gameId) return;
                setPreviewUrl(`${entryOf(gameId)}?t=${encodeURIComponent(nowId())}`);
              }}
            >
              刷新
            </button>
            <a className="btn btnGray" href={previewUrl} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          </div>
        </div>
        <iframe className="previewFrame" src={previewUrl} title="preview" />
      </div>
    </section>
  );
}
