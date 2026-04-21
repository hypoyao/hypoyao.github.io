"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

type ModelFile = { path: string; content: string };

function nowId() {
  return String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

const CREATOR_STORE_VER = 1;
const CREATOR_LAST_KEY = "creatorStudio:last";
function chatKey(gid: string) {
  return `creatorStudio:chat:${gid || "draft"}`;
}

function safeLoadChat(gid: string): { messages: ChatMsg[] } | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(chatKey(gid));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j?.v !== CREATOR_STORE_VER) return null;
    const arr = Array.isArray(j?.messages) ? j.messages : null;
    if (!arr) return null;
    const messages: ChatMsg[] = arr
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: String(m.content) }));
    if (!messages.length) return null;
    return { messages };
  } catch {
    return null;
  }
}

function safeSaveChat(gid: string, messages: ChatMsg[]) {
  try {
    if (typeof window === "undefined") return;
    const MAX_MSG = 40;
    const MAX_LEN = 4000;
    const trimmed = (messages || [])
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .slice(-MAX_MSG)
      .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, MAX_LEN) }));
    window.localStorage.setItem(
      chatKey(gid),
      JSON.stringify({ v: CREATOR_STORE_VER, updatedAt: Date.now(), gameId: gid, messages: trimmed }),
    );
    window.localStorage.setItem(CREATOR_LAST_KEY, JSON.stringify({ v: CREATOR_STORE_VER, gameId: gid, updatedAt: Date.now() }));
  } catch {
    // ignore
  }
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

export default function CreateStudio({ initialPrompt = "", autoStart = false }: { initialPrompt?: string; autoStart?: boolean }) {
  const [gameId, setGameId] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("/games/creator-playground/index.html");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [input, setInput] = useState(initialPrompt || "");
  // 模型选择：DeepSeek / OpenRouter
  const [provider, setProvider] = useState<"deepseek" | "openrouter">(() => {
    try {
      const raw = window.localStorage.getItem("creatorStudio:modelProvider");
      if (raw === "deepseek" || raw === "openrouter") return raw;
    } catch {}
    // 默认走 OpenRouter（用户要求默认选择 nemotron free）
    return "openrouter";
  });
  const [model, setModel] = useState<string>(() => {
    try {
      const raw = window.localStorage.getItem("creatorStudio:modelName");
      if (raw) return raw;
    } catch {}
    return "nvidia/nemotron-3-super-120b-a12b:free";
  });
  const listRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number }>>([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [published, setPublished] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const speechRef = useRef<any>(null);
  const speechBaseRef = useRef<string>("");
  const inputRef = useRef<string>("");
  const bootRef = useRef(false);
  const [lastFailedText, setLastFailedText] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const opMenuRef = useRef<HTMLDetailsElement | null>(null);

  const publishText = useMemo(() => (published ? "更新" : "发布"), [published]);

  const openrouterModels = useMemo(
    () => [
      { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "nvidia/nemotron-3-super-120b-a12b:free（默认）" },
      { id: "qwen/qwen-2.5-72b-instruct:free", name: "qwen/qwen-2.5-72b-instruct:free" },
      { id: "anthropic/claude-sonnet-4.6", name: "anthropic/claude-sonnet-4.6" },
      { id: "deepseek/deepseek-v3.2", name: "deepseek/deepseek-v3.2" },
      { id: "google/gemini-3-flash-preview", name: "google/gemini-3-flash-preview" },
      { id: "minimax/minimax-m2.5", name: "minimax/minimax-m2.5" },
    ],
    [],
  );

  const deepseekModels = useMemo(
    () => [
      { id: "deepseek-reasoner", name: "deepseek-reasoner（思考更强）" },
      { id: "deepseek-chat", name: "deepseek-chat（更快）" },
    ],
    [],
  );

  // 修正本地缓存里可能出现的“provider/model 不匹配”
  useEffect(() => {
    if (provider === "openrouter") {
      const ok = openrouterModels.some((x) => x.id === model);
      if (!ok) setModel("nvidia/nemotron-3-super-120b-a12b:free");
    } else {
      const ok = deepseekModels.some((x) => x.id === model);
      if (!ok) setModel("deepseek-reasoner");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  useEffect(() => {
    try {
      window.localStorage.setItem("creatorStudio:modelProvider", provider);
      window.localStorage.setItem("creatorStudio:modelName", model);
    } catch {}
  }, [provider, model]);

  function act(type: "new" | "publish" | "delete") {
    const ok =
      type === "new"
        ? window.confirm("确定新建一个游戏吗？\n\n当前游戏不会丢失，你可以在“我的游戏”里再切回来。")
        : type === "publish"
          ? window.confirm(`确定${publishText}吗？`)
          : window.confirm("确定删除当前游戏吗？\n\n删除后无法恢复。");
    if (!ok) return;
    if (opMenuRef.current) opMenuRef.current.open = false;
    window.dispatchEvent(new CustomEvent("creatorStudioAction", { detail: { type } }));
  }

  useEffect(() => {
    inputRef.current = input || "";
  }, [input]);

  // 组件卸载时中止正在进行的请求，避免悬挂
  useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort();
      } catch {}
    };
  }, []);

  // 点击其它地方自动关闭“操作”下拉框
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const el = opMenuRef.current;
      if (!el?.open) return;
      const t = e.target as any;
      if (t && el.contains(t)) return;
      el.open = false;
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, []);

  // 首屏从首页带过来的 prompt：会自动“新建一个游戏并切换过去”
  // 为避免开发模式下 useEffect 触发两次导致重复新建，这里加一个 bootRef 防抖。

  // 注意：messages 里不放 system；发送给后端时会自动拼接 systemPrompt
  const [messages, setMessages] = useState<ChatMsg[]>(() => [
    { role: "assistant", content: "你好！把你想做的小游戏告诉我吧（玩法、按钮、胜负条件、画面风格）。" },
  ]);

  const viewMessages = useMemo(() => messages, [messages]);

  // === 聊天记录持久化（刷新不丢） ===
  // 1) gameId 变化时：尝试从 localStorage 恢复该项目的聊天记录
  useEffect(() => {
    if (!gameId) return;
    // 从首页模板进来属于“强制新建并自动开始”，不要用旧记录覆盖
    if ((initialPrompt || "").trim() && autoStart) return;
    const saved = safeLoadChat(gameId);
    if (saved?.messages?.length) {
      setMessages(saved.messages);
      return;
    }
    // 本地没有，再从服务器恢复（只包含用户发送内容）
    (async () => {
      try {
        const r = await fetch(`/api/creator/chatlog?gameId=${encodeURIComponent(gameId)}`, { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        const arr = Array.isArray(j?.messages) ? j.messages : [];
        const userMsgs: ChatMsg[] = arr
          .map((x: any) => ({ role: "user", content: String(x?.content || "").trim() }))
          .filter((m: any) => m.content);
        if (userMsgs.length) {
          setMessages([
            { role: "assistant", content: "（已从服务器恢复你之前发送的内容。AI 的历史回复未保存。）" },
            ...userMsgs,
          ]);
        }
      } catch {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  // 2) messages 变化时：保存到 localStorage
  useEffect(() => {
    if (!gameId) return;
    safeSaveChat(gameId, messages);
  }, [gameId, messages]);

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
    let j: any = null;
    try {
      j = await r.json();
    } catch {
      j = null;
    }
    if (!r.ok || !j?.ok || !j?.gameId) {
      const err = String(j?.error || "").trim();
      if (r.status === 401 || err === "UNAUTHORIZED") {
        if (window.confirm("新建游戏需要先登录。现在去登录吗？")) {
          window.location.href = `/login?next=${encodeURIComponent("/create")}`;
        }
        throw new Error("UNAUTHORIZED");
      }
      // 兜底：把状态码带上，避免只看到 NEW_GAME_FAILED
      throw new Error(err || `NEW_GAME_FAILED(${r.status})`);
    }
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
          {
            path: "prompt.md",
            content: "我想做一个什么小游戏呢？\n\n（你可以在左边对 AI 说：我想做一个……）\n",
          },
        ],
      }),
    });
  }

  async function writePrompt(gid: string, promptText: string) {
    const content = (promptText || "").trim();
    if (!content) return;
    await fetch("/api/creator/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId: gid,
        files: [{ path: "prompt.md", content }],
      }),
    });
  }

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const isFromHome = !!(autoStart && initialPrompt && initialPrompt.trim());

    const baseAssistant: ChatMsg[] = [
      {
        role: "assistant",
        content: "好耶！我们从一个全新的小游戏开始吧～你想做什么？",
      },
    ];

    // 进入页面：如果带 prompt（从首页/模板进来）→ 强制新建并切换；
    // 否则：先拉取历史项目；有就默认选最新一个，没有就新建
    (async () => {
      try {
        // 并发请求：me 和 list 不互相依赖，避免串行等待导致首屏变慢
        const meP = fetch("/api/me", { cache: "no-store" })
          .then((x) => x.json())
          .catch(() => null);

        if (isFromHome) {
          const me = await meP;
          setLoggedIn(!!me?.loggedIn);
          // 只在“从其它页面跳转过来且明确带 auto=1”时自动启动；
          // 启动后立刻把 URL 里的 auto=1 去掉，避免用户刷新页面时重复启动。
          try {
            const u = new URL(window.location.href);
            if (u.searchParams.get("auto") === "1") {
              u.searchParams.delete("auto");
              window.history.replaceState({}, "", u.pathname + (u.searchParams.toString() ? `?${u.searchParams.toString()}` : ""));
            }
          } catch {}

          setMessages(baseAssistant);
          setMsg("");
          const gid = await newGame();
          await ensureSeed(gid);
          setPreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`);
          await refreshProjects();
          await writePrompt(gid, initialPrompt);
          // 自动把首页的 prompt 作为第一句话发给 AI（用户点击“开始创造/模板”即表示要开始）
          await sendText(initialPrompt, gid, baseAssistant);
          return;
        }

        // 首屏先用本地缓存把“我的游戏”列表渲染出来（体感更快），再后台拉最新
        try {
          const raw = window.localStorage.getItem("creatorStudio:projectsCache");
          const c = raw ? JSON.parse(raw) : null;
          const arr0 = Array.isArray(c?.games) ? c.games : [];
          if (arr0.length) {
            setProjects(arr0);
            let pick0 = arr0[0]?.gameId || "";
            // 优先恢复上次打开的项目
            try {
              const rawLast = window.localStorage.getItem(CREATOR_LAST_KEY);
              const last = rawLast ? JSON.parse(rawLast) : null;
              const lastId = typeof last?.gameId === "string" ? last.gameId : "";
              if (lastId && arr0.some((x: any) => x?.gameId === lastId)) pick0 = lastId;
            } catch {}
            if (pick0) {
              setGameId(pick0);
              setPreviewUrl(`${entryOf(pick0)}?t=${encodeURIComponent(nowId())}`);
            }
          }
        } catch {}

        const listP = fetch("/api/creator/list", { cache: "no-store" }).then((x) => x.json().catch(() => ({})));
        // 优先把“我的游戏”列表展示出来；me 允许慢一点再更新登录态
        const j = await listP;
        const arr = Array.isArray(j?.games) ? j.games : [];
        setProjects(arr);
        if (arr.length) {
          let pick = arr[0]?.gameId || "";
          // 优先恢复上次打开的项目
          try {
            const raw = window.localStorage.getItem(CREATOR_LAST_KEY);
            const last = raw ? JSON.parse(raw) : null;
            const lastId = typeof last?.gameId === "string" ? last.gameId : "";
            if (lastId && arr.some((x: any) => x?.gameId === lastId)) pick = lastId;
          } catch {}
          if (pick) {
            setGameId(pick);
            setPreviewUrl(`${entryOf(pick)}?t=${encodeURIComponent(nowId())}`);
            return;
          }
          return;
        }

        const me = await meP;
        setLoggedIn(!!me?.loggedIn);
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

  async function refreshProjects() {
    const r = await fetch("/api/creator/list", { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j?.games) ? j.games : [];
    setProjects(arr);
    // 本地缓存一份：让 create 首屏先秒出列表，再后台刷新
    try {
      window.localStorage.setItem("creatorStudio:projectsCache", JSON.stringify({ v: 1, at: Date.now(), games: arr }));
    } catch {}
    return arr as Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number }>;
  }

  async function writeFiles(files: ModelFile[], gid?: string) {
    const useId = gid || gameId;
    if (!useId) throw new Error("NO_GAME_ID");
    const r = await fetch("/api/creator/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameId: useId, files }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || "WRITE_FAILED");
  }

  async function sendText(textRaw: string, gid?: string, baseMsgs?: ChatMsg[]) {
    const text = (textRaw || "").trim();
    const useId = gid || gameId;
    const useBase = baseMsgs || messages;
    if (!text || busy) return;
    if (!useId) throw new Error("NO_GAME_ID");

    // 第一句用户输入：把它写到 prompt.md（用于“我的游戏”下拉框显示关键词）
    // 只在当前对话还没有 user 消息时写入，避免后续不断覆盖
    const hasUser = useBase.some((m) => m.role === "user");
    if (!hasUser) {
      try {
        await writePrompt(useId, text);
        // 让下拉框尽快显示关键词
        await refreshProjects();
      } catch {
        // ignore
      }
    }
    setLastFailedText("");
    setBusy(true);
    setMsg("");
    setInput("");
    const startAt = Date.now();

    // 新的一次请求：先取消上一次（理论上不会同时存在，但以防万一）
    try {
      abortRef.current?.abort();
    } catch {}
    const ac = new AbortController();
    abortRef.current = ac;

    const myMsg: ChatMsg = { role: "user", content: text };
    const snap: ChatMsg[] = [...useBase, myMsg, { role: "assistant", content: "AI 开始写代码…" }];
    setMessages(snap);
    // 只把“用户发给 AI 的内容”存到数据库（失败不影响创作）
    try {
      fetch("/api/creator/chatlog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: useId, content: text }),
      }).catch(() => null);
    } catch {
      // ignore
    }

    try {
      const r = await fetch("/api/creator/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 只传 user/assistant；system 由服务端统一注入
        body: JSON.stringify({ messages: [...useBase, myMsg], provider, model }),
        signal: ac.signal,
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
        let statusRaw = "AI 正在准备…";
        let statusLine = withTime(statusRaw);

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

        // 计时器：即使长时间没有 status/delta，也要让 “xxs” 动起来
        const timeTicker = setInterval(() => {
          statusLine = withTime(statusRaw);
          paintDraft(true);
        }, 500);

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = dec.decode(value, { stream: true });
            const events = parseSseChunk(sseState, chunk);
            for (const ev of events) {
              if (ev.event === "status") {
                statusRaw = String(ev.data?.text || "AI 思考中…");
                statusLine = withTime(statusRaw);
                paintDraft(true);
              } else if (ev.event === "meta") {
                const p = String(ev.data?.provider || "").trim();
                const m = String(ev.data?.model || "").trim();
                const reason = String(ev.data?.reason || "").trim();
                if (reason && p === "deepseek") {
                  // 明确提醒用户：已回退到 DeepSeek
                  statusRaw = `已回退到 DeepSeek（${m || "deepseek-chat"}）`;
                } else if (p && m) {
                  statusRaw = `当前模型：${p} / ${m}`;
                }
                statusLine = withTime(statusRaw);
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
        } finally {
          clearInterval(timeTicker);
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
        await writeFiles(files, useId);
        setPreviewUrl(`${entryOf(useId)}?t=${encodeURIComponent(nowId())}`);
      }
    } catch (e: any) {
      // 用户主动停止
      if (e?.name === "AbortError") {
        setMsg("已停止。你可以修改一下，再点发送～");
        setInput(text); // 把刚才的输入还给用户，方便继续编辑
        setLastFailedText(text); // 允许一键重试
        setMessages((mm0) => {
          const mm = mm0.slice();
          for (let i = mm.length - 1; i >= 0; i--) {
            if (mm[i].role === "assistant") {
              mm[i] = { role: "assistant", content: "我先停下来啦～如果你还想继续，就再点一次发送或重试！" };
              break;
            }
          }
          return mm;
        });
        return;
      }
      const m = String(e?.message || "未知错误");
      const hint =
        m.toLowerCase().includes("missing_deepseek_api_key")
          ? "（服务端未配置 DEEPSEEK_API_KEY）"
          : m.toLowerCase().includes("missing_openrouter_api_key")
            ? "（服务端未配置 OPENROUTER_API_KEY）"
            : m.toLowerCase().includes("fetch failed")
              ? "（服务端请求模型失败：常见原因是网络/DNS/代理/TLS/Key 限制；建议重试或切换模型）"
          : m.toLowerCase().includes("terminated")
            ? "（连接被中断：可能是网络/模型超时/Key 无效/服务端被重启，建议重试）"
            : "（建议重试；如持续失败再检查 OPENROUTER_API_KEY / DEEPSEEK_API_KEY）";
      setMsg(`出错：${m}${hint}`);
      setLastFailedText(text);
      // 把最后的“AI 开始写代码…”替换成更友好的提示
      setMessages((mm0) => {
        const mm = mm0.slice();
        for (let i = mm.length - 1; i >= 0; i--) {
          if (mm[i].role === "assistant") {
            mm[i] = { role: "assistant", content: "哎呀，AI 刚刚卡住了～你可以点下面的“重试”再来一次！" };
            break;
          }
        }
        return mm;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function send() {
    return sendText(input);
  }

  function stopAi() {
    try {
      abortRef.current?.abort();
    } catch {}
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
        setMsg("发布中…正在打开发布页面…");
        // 让提示先渲染出来再跳转
        setTimeout(() => {
          window.location.href = `/publish?id=${encodeURIComponent(gameId)}`;
        }, 80);
      } else if (type === "delete") {
        if (!gameId) return;
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
                  {(p.title && p.title.trim()) ? p.title.trim() : p.gameId}
                </option>
              ))}
            </select>
          </label>

          <details className="createMenu" ref={opMenuRef}>
            <summary className="createMenuBtn" aria-label="更多操作">
              操作 ▾
            </summary>
            <div className="createMenuPanel" role="menu" aria-label="创作操作菜单">
              <button className="createMenuItem" type="button" onClick={() => act("new")} disabled={busy}>
                新建游戏
              </button>
              <button className="createMenuItem" type="button" onClick={() => act("publish")} disabled={busy || !gameId}>
                {publishText}
              </button>
              <button className="createMenuItem" type="button" onClick={() => act("delete")} disabled={busy || !gameId}>
                删除游戏
              </button>
            </div>
          </details>
        </div>

        <div className="createTopRight" aria-label="model picker">
          <div className="createTopInline" style={{ gap: 6, minWidth: 0 }}>
            <span className="createTopLabel">模型</span>
            <select
              className="restInput"
              value={provider}
              disabled={busy}
              onChange={(e) => {
                const p = (e.target.value || "openrouter") as any;
                if (p !== "deepseek" && p !== "openrouter") return;
                setProvider(p);
                // 切换 provider 时给一个合理默认
                if (p === "openrouter") setModel("nvidia/nemotron-3-super-120b-a12b:free");
                else setModel("deepseek-reasoner");
              }}
              style={{ padding: "8px 10px", fontSize: 13, fontWeight: 900, width: 140 }}
              aria-label="选择模型平台"
            >
              <option value="openrouter">OpenRouter</option>
              <option value="deepseek">DeepSeek</option>
            </select>
            <select
              className="restInput"
              value={model}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
              style={{ padding: "8px 10px", fontSize: 13, fontWeight: 900, width: 320, maxWidth: "52vw" }}
              aria-label="选择模型"
            >
              {(provider === "openrouter" ? openrouterModels : deepseekModels).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
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
            <div
              key={idx}
              className={
                `chatMsg ${m.role === "user" ? "isUser" : "isAi"} ` +
                `${m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(THINK_PREFIX) ? "isThinking" : ""}`
              }
            >
              {busy &&
              idx === viewMessages.length - 1 &&
              m.role === "assistant" &&
              typeof m.content === "string" &&
              m.content.startsWith(THINK_PREFIX) ? (
                <button className="chatStopLink" type="button" onClick={stopAi} aria-label="停止AI任务">
                  停止
                </button>
              ) : null}
              {m.role === "assistant" && typeof m.content === "string" && m.content.startsWith(THINK_PREFIX) ? (
                (() => {
                  const rest = m.content.slice(THINK_PREFIX.length).trimStart();
                  const nl = rest.indexOf("\n");
                  const summary = nl >= 0 ? rest.slice(0, nl).trim() : "AI 正在思考…";
                  const detail = nl >= 0 ? rest.slice(nl + 1) : "";
                  return (
                    <details className="thinkBox">
                      <summary className="thinkSummary">AI · {summary}</summary>
                      <pre className="thinkBody">{detail || "（暂无输出）"}</pre>
                    </details>
                  );
                })()
              ) : (
                <>
                  <div className="chatRole">{m.role === "user" ? "我" : "AI"}</div>
                  <div className="chatText">{m.content}</div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="chatComposer">
          {msg ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="desc" style={{ color: "rgba(220,38,38,0.95)", margin: 0 }}>
                {msg}
              </div>
              {lastFailedText && !busy ? (
                <button className="btn btnGray" type="button" onClick={() => sendText(lastFailedText)}>
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="chatRow">
            <textarea
              className="restTextarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              disabled={busy}
            />
            <div className="sendCol">
              <button
                className="btn btnGray voiceBtn"
                type="button"
                onClick={toggleSpeech}
                disabled={busy || !speechSupported}
                aria-label={listening ? "停止语音输入" : "语音输入"}
                title={listening ? "停止语音输入" : "语音输入"}
              >
                {listening ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z"
                      fill="currentColor"
                    />
                    <path
                      d="M7 11a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.93V20h-2v-2.07A7 7 0 0 1 5 11h2Z"
                      fill="currentColor"
                      opacity="0.9"
                    />
                  </svg>
                )}
              </button>
              <button className="btn sendBtn" type="button" onClick={send} disabled={busy || !input.trim()} aria-label="发送">
                ➤ 发送
              </button>
            </div>
          </div>
        </div>
      </div>

        <div className="createPanel previewPanel" aria-label="preview">
          <div className="simShell" aria-label="simulator">
            <div className="simBar" aria-hidden="true">
              <div className="simDots">
                <span className="simDot red" />
                <span className="simDot yellow" />
                <span className="simDot green" />
              </div>
              <div className="simTitle"> </div>
              <div className="simActions">
                <a
                  className="btn btnGray iconBtn simOpenBtn"
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="在新标签页打开预览"
                  title="在新标签页打开预览"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3Z"
                      fill="currentColor"
                    />
                    <path
                      d="M5 5h6v2H7v10h10v-4h2v6H5V5Z"
                      fill="currentColor"
                      opacity="0.9"
                    />
                  </svg>
                </a>
              </div>
            </div>
            <div className="simScreen">
              <iframe className="previewFrame" src={previewUrl} title="preview" />
            </div>
          </div>
        </div>
      </section>
    </section>
  );
}
