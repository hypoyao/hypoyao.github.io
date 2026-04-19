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
  // 默认用 reasoner（更会思考）
  const [model, setModel] = useState<"deepseek-chat" | "deepseek-reasoner">("deepseek-reasoner");
  const listRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number }>>([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [published, setPublished] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const speechRef = useRef<any>(null);
  const speechBaseRef = useRef<string>("");
  const inputRef = useRef<string>("");

  useEffect(() => {
    inputRef.current = input || "";
  }, [input]);

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
        // 注意：interimResults 会反复触发 onresult
        // 如果我们用“追加”的方式更新输入框，就会出现“重复一大串”的 bug。
        // 正确做法：每次都用“语音开始时的基准输入 + 当前识别结果”去覆盖显示。
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = r?.[0]?.transcript || "";
          if (!t) continue;
          if (r.isFinal) finalText += t;
          else interimText += t;
        }
        const base = speechBaseRef.current || "";
        const merged = (base + finalText + interimText).trimStart();
        setInput(merged);
      };
      rec.onstart = () => {
        // 记录“开始说话时”输入框已有内容，避免中途重复叠加
        speechBaseRef.current = inputRef.current || "";
        setListening(true);
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      speechRef.current = rec;
    } catch {
      setSpeechSupported(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        speechBaseRef.current = input || "";
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

  // 顶部操作（新建/发布/删除）已移动到页面 header（TopActions 下拉菜单）
  // studio 只负责：选择游戏、聊天、预览
  useEffect(() => {
    const emit = () => {
      window.dispatchEvent(
        new CustomEvent("creatorStudioState", {
          detail: { gameId, published, loggedIn, busy },
        })
      );
    };
    emit();
    const onPing = () => emit();
    window.addEventListener("creatorStudioPing", onPing as any);
    return () => window.removeEventListener("creatorStudioPing", onPing as any);
  }, [gameId, published, loggedIn, busy]);

  useEffect(() => {
    const onAction = (e: any) => {
      const type = e?.detail?.type;
      if (type === "new") {
        (async () => {
          setMessages([{ role: "assistant", content: "好耶！我们从一个全新的小游戏开始吧～你想做什么？" }]);
          setMsg("");
          try {
            const gid = await newGame();
            await ensureSeed(gid);
            setPreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`);
            await refreshProjects();
          } catch (err: any) {
            setMsg(`新建游戏失败：${err?.message || "未知错误"}`);
          }
        })();
      } else if (type === "publish") {
        if (!gameId) return;
        if (!loggedIn) {
          if (window.confirm("发布/更新需要先登录。现在去登录吗？")) window.location.href = "/login";
          return;
        }
        window.location.href = `/publish?id=${encodeURIComponent(gameId)}`;
      } else if (type === "delete") {
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
          } catch (err: any) {
            setMsg(`删除失败：${err?.message || "未知错误"}`);
          }
        })();
      }
    };
    window.addEventListener("creatorStudioAction", onAction as any);
    return () => window.removeEventListener("creatorStudioAction", onAction as any);
  }, [gameId, loggedIn]);

  return (
    <section aria-label="create studio">
      <div className="createTopBar" aria-label="tools">
        <div className="createTopLeft">
          <label className="createTopInline">
            <span className="createTopLabel">我的游戏</span>
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

          <label className="createTopInline">
            <span className="createTopLabel">模型</span>
            <select
              className="restInput"
              value={model}
              onChange={(e) => setModel(e.target.value as any)}
              disabled={busy}
              aria-label="选择模型"
              style={{ padding: "8px 10px", fontSize: 13, fontWeight: 900 }}
            >
              <option value="deepseek-chat">chat（更快）</option>
              <option value="deepseek-reasoner">reasoner（更会思考）</option>
            </select>
          </label>
        </div>
      </div>

      <section className="createGrid">
        <div className="createPanel isChat" aria-label="chat">
          <div className="createPanelHeader">
            <div>
              <div className="createPanelTitle">AI 聊天</div>
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
            <div className="previewHeadLeft">
              <div className="createPanelTitle">预览</div>
              <div className="previewUrl" title={previewUrl}>
                {previewUrl}
              </div>
            </div>
            <div className="previewToolbar">
              <button
                className="btn btnGray iconBtn"
                type="button"
                onClick={() => {
                  if (!gameId) return;
                  setPreviewUrl(`${entryOf(gameId)}?t=${encodeURIComponent(nowId())}`);
                }}
                aria-label="刷新预览"
                title="刷新预览"
              >
                ⟳
              </button>
              <a className="btn btnGray iconBtn" href={previewUrl} target="_blank" rel="noreferrer" aria-label="新窗口打开" title="新窗口打开">
                ↗
              </a>
            </div>
          </div>
          <iframe className="previewFrame" src={previewUrl} title="preview" />
        </div>
      </section>
    </section>
  );
}
