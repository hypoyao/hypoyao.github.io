"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

type ModelFile = { path: string; content: string };

type GameMeta = {
  title?: string;
  shortDesc?: string;
  rules?: string;
  creator?: { name?: string; avatarUrl?: string; profilePath?: string };
};

type ProcessMode = "create" | "patch" | "fix" | "clarify" | "run";
type ProcessStepStatus = "pending" | "running" | "done" | "failed" | "upgraded";

type ProcessContract = {
  topic?: string;
  gameplay?: string;
  platform?: string;
  theme?: string;
  complexity?: string;
  keyUi?: string[];
  mustHave?: string[];
  forbidden?: string[];
};

type ProcessStep = {
  id: string;
  label: string;
  status: ProcessStepStatus;
  detail?: string;
  strategy?: string;
  fileTargets?: string[];
  startedAt?: number;
  finishedAt?: number;
};

type ProcessRun = {
  id: string;
  gameId: string;
  mode: ProcessMode;
  provider: string;
  model: string;
  status: "running" | "done" | "failed" | "stopped";
  summary: string;
  startedAt: number;
  finishedAt?: number;
  currentStepId?: string;
  steps: ProcessStep[];
  contract?: ProcessContract | null;
  error?: string;
};

type ProgressEventPayload = {
  runId?: string;
  mode?: ProcessMode;
  stepId?: string;
  stepLabel?: string;
  status?: ProcessStepStatus;
  detail?: string;
  strategy?: string;
  fileTargets?: string[];
  provider?: string;
  model?: string;
  error?: string;
};

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

function safeDeleteChat(gid: string) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(chatKey(gid));
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

function normalizeStringList(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || "").trim()).filter(Boolean);
}

function formatElapsed(startedAt?: number, finishedAt?: number) {
  if (!startedAt) return "0s";
  const end = finishedAt || Date.now();
  const sec = Math.max(1, Math.round((end - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min}m ${rest}s` : `${min}m`;
}

function guessProcessMode(text: string): ProcessMode {
  const t = String(text || "").trim();
  if (/(^\s*修复[:：]|bug|报错|错误|异常|崩溃|无法|不显示|不生效|没反应|卡住|卡死|白屏|闪退|console|控制台)/i.test(t)) {
    return "fix";
  }
  return "create";
}

function processModeLabel(mode: ProcessMode) {
  if (mode === "fix") return "修 bug";
  if (mode === "patch") return "小改动";
  if (mode === "clarify") return "需求澄清";
  if (mode === "create") return "首次生成";
  return "处理中";
}

function processStatusLabel(status: ProcessRun["status"]) {
  if (status === "done") return "已完成";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  return "进行中";
}

function summarizeStatusText(text: string) {
  return String(text || "")
    .replace(/^（\d+\/\d+）/, "")
    .replace(/（已等待\s*\d+s）/g, "")
    .replace(/\s*…$/, "")
    .trim();
}

function inferStepFromPhase(phase: string): { id: string; label: string; mode?: ProcessMode } | null {
  const p = String(phase || "").trim().toLowerCase();
  if (!p) return null;
  if (p === "clarify") return { id: "clarify", label: "需求澄清", mode: "clarify" };
  if (p === "blueprint") return { id: "blueprint", label: "蓝图", mode: "create" };
  if (p === "json_repair") return { id: "repair", label: "结构修复" };
  if (p === "codegen_html") return { id: "html", label: "页面结构", mode: "create" };
  if (p === "codegen_css") return { id: "css", label: "页面样式", mode: "create" };
  if (p === "codegen_game_js") return { id: "game_js", label: "核心逻辑", mode: "create" };
  if (p === "codegen_game_js_skeleton") return { id: "game_js_skeleton", label: "核心逻辑骨架", mode: "create" };
  if (p === "codegen_game_js_complete") return { id: "game_js_complete", label: "核心逻辑补全", mode: "create" };
  if (p === "fix") return { id: "fix", label: "Bug 修复", mode: "fix" };
  if (p.startsWith("direct_refine_")) {
    const kind = p.slice("direct_refine_".length);
    const map: Record<string, string> = {
      content: "文案与显隐",
      layout: "布局调整",
      visual: "样式优化",
      behavior: "行为修改",
      bugfix: "问题修复",
      feature: "功能增强",
    };
    return { id: `direct_${kind}`, label: map[kind] || "小改动", mode: "patch" };
  }
  return null;
}

function inferStepFromStatusText(text: string): { id: string; label: string; mode?: ProcessMode } | null {
  const raw = summarizeStatusText(text);
  if (!raw) return null;
  if (raw.includes("需求澄清")) return { id: "clarify", label: "需求澄清", mode: "clarify" };
  if (raw.includes("生成蓝图")) return { id: "blueprint", label: "蓝图", mode: "create" };
  if (raw.includes("收敛需求契约")) return { id: "requirement_contract", label: "需求契约", mode: "create" };
  if (raw.includes("生成页面结构")) return { id: "html", label: "页面结构", mode: "create" };
  if (raw.includes("生成页面样式")) return { id: "css", label: "页面样式", mode: "create" };
  if (raw.includes("生成核心逻辑骨架")) return { id: "game_js_skeleton", label: "核心逻辑骨架", mode: "create" };
  if (raw.includes("补全核心逻辑细节")) return { id: "game_js_complete", label: "核心逻辑补全", mode: "create" };
  if (raw.includes("生成核心逻辑")) return { id: "game_js", label: "核心逻辑", mode: "create" };
  if (raw.includes("修复 bug")) return { id: "fix", label: "Bug 修复", mode: "fix" };
  if (raw.includes("小改动")) return { id: "patch", label: "小改动", mode: "patch" };
  if (raw.includes("结构不一致") || raw.includes("验收没通过")) return { id: "validate", label: "强验收与恢复" };
  if (raw.includes("JSON")) return { id: "repair", label: "结构修复" };
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

export default function CreateStudio({
  initialPrompt = "",
  autoStart = false,
  initialGameId = "",
}: {
  initialPrompt?: string;
  autoStart?: boolean;
  initialGameId?: string;
}) {
  const [gameId, setGameId] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("/games/creator-playground/index.html");
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [input, setInput] = useState(initialPrompt || "");
  // 模型选择：DeepSeek / OpenRouter
  // 注意：不要在 useState initializer 读取 localStorage，否则 SSR/CSR 初始值不一致会触发 hydration failed。
  // 这里先用稳定默认值，等客户端挂载后再从 localStorage 恢复。
  const [provider, setProvider] = useState<"deepseek" | "openrouter" | "bailian" | "tencent">("openrouter");
  // 默认模型：保持原先默认（不要在这里强行替用户改模型）
  const [model, setModel] = useState<string>("nvidia/nemotron-3-super-120b-a12b:free");
  const [hydrated, setHydrated] = useState(false);
  const [currentModelLabel, setCurrentModelLabel] = useState<string>("");
  const [processCurrent, setProcessCurrent] = useState<ProcessRun | null>(null);
  const [processHistory, setProcessHistory] = useState<ProcessRun[]>([]);
  const [processCollapsed, setProcessCollapsed] = useState(false);
  const [creatorName, setCreatorName] = useState<string>("");
  const [creatorAvatarUrl, setCreatorAvatarUrl] = useState<string>("");
  const [creatorProfilePath, setCreatorProfilePath] = useState<string>("");
  const [gameMeta, setGameMeta] = useState<GameMeta | null>(null);
  const [clarifyUi, setClarifyUi] = useState<any>(null);
  const [clarifyLocal, setClarifyLocal] = useState<any>(null);
  const clarifyAutoSubmittedRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number; published?: boolean }>>(
    [],
  );
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

  // 新的一轮运行开始时，默认展开
  useEffect(() => {
    if (processCurrent?.id) setProcessCollapsed(false);
  }, [processCurrent?.id]);

  const openrouterModels = useMemo(
    () => [
      { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "nvidia/nemotron-3-super-120b-a12b:free（默认）" },
      { id: "qwen/qwen3.6-plus", name: "qwen/qwen3.6-plus（Qwen3.6 Plus）" },
      { id: "qwen/qwen-2.5-72b-instruct:free", name: "qwen/qwen-2.5-72b-instruct:free" },
      { id: "deepseek/deepseek-v3.2", name: "deepseek/deepseek-v3.2" },
      { id: "deepseek/deepseek-v4-pro", name: "deepseek/deepseek-v4-pro（思考：最高）" },
      { id: "deepseek/deepseek-v4-flash", name: "deepseek/deepseek-v4-flash（思考：最高，较快）" },
      { id: "tencent/hy3-preview:free", name: "tencent/hy3-preview:free（腾讯 Hy3 Preview 免费）" },
      { id: "z-ai/glm-5.1", name: "z-ai/glm-5.1（GLM 5.1）" },
      { id: "google/gemini-2.5-flash", name: "google/gemini-2.5-flash" },
      { id: "google/gemini-2.5-flash-lite", name: "google/gemini-2.5-flash-lite" },
      { id: "minimax/minimax-m2.5", name: "minimax/minimax-m2.5" },
    ],
    [],
  );

  const bailianModels = useMemo(
    () => [
      { id: "qwen3.6-plus", name: "qwen3.6-plus（百炼直连）" },
      { id: "qwen-plus", name: "qwen-plus（百炼）" },
    ],
    [],
  );

  const tencentModels = useMemo(
    () => [{ id: "hy3-preview", name: "hy3-preview（腾讯混元 Hunyuan 3 Preview）" }],
    [],
  );

  const deepseekModels = useMemo(
    () => [
      // DeepSeek V4：统一开启“最高思考强度”（由后端/网关控制）
      { id: "deepseek-v4-pro", name: "deepseek-v4-pro（思考：最高）" },
      { id: "deepseek-v4-flash", name: "deepseek-v4-flash（思考：最高，较快）" },
    ],
    [],
  );

  // 修正本地缓存里可能出现的“provider/model 不匹配”
  // 注意：hydration 会从 localStorage 恢复 model，所以这里必须同时依赖 model，才能在恢复后再校验一次。
  useEffect(() => {
    if (provider === "openrouter") {
      const ok = openrouterModels.some((x) => x.id === model);
      if (!ok) setModel("nvidia/nemotron-3-super-120b-a12b:free");
    } else if (provider === "bailian") {
      const ok = bailianModels.some((x) => x.id === model);
      if (!ok) setModel("qwen3.6-plus");
    } else if (provider === "tencent") {
      const ok = tencentModels.some((x) => x.id === model);
      if (!ok) setModel("hy3-preview");
    } else {
      const ok = deepseekModels.some((x) => x.id === model);
      if (!ok) setModel("deepseek-v4-flash");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, model]);

  // 客户端挂载后恢复用户上次选择，避免 SSR/CSR hydration mismatch
  useEffect(() => {
    setHydrated(true);
    try {
      const p = window.localStorage.getItem("creatorStudio:modelProvider");
      const m = window.localStorage.getItem("creatorStudio:modelName");
      if (p === "deepseek" || p === "openrouter" || p === "bailian" || p === "tencent") setProvider(p as any);
      if (m) setModel(m);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem("creatorStudio:modelProvider", provider);
      window.localStorage.setItem("creatorStudio:modelName", model);
    } catch {}
  }, [provider, model, hydrated]);

  // 顶部/聊天区展示当前模型（常驻显示）
  useEffect(() => {
    setCurrentModelLabel(`当前模型：${provider} / ${model}`);
  }, [provider, model]);

  const archiveProcessRun = (status: ProcessRun["status"], error = "") => {
    setProcessCurrent((prev) => {
      if (!prev) return null;
      const finishedAt = Date.now();
      const finalized: ProcessRun = {
        ...prev,
        status,
        error: error || prev.error || "",
        finishedAt,
        steps: prev.steps.map((step) =>
          step.status === "running"
            ? { ...step, status: status === "done" ? "done" : "failed", finishedAt }
            : step.finishedAt
              ? step
              : step.status === "pending"
                ? step
                : { ...step, finishedAt },
        ),
      };
      setProcessHistory((hist) => [finalized, ...hist].slice(0, 8));
      return null;
    });
  };

  const upsertProcessStep = (
    prev: ProcessRun | null,
    evt: {
      runId?: string;
      mode?: ProcessMode;
      stepId?: string;
      stepLabel?: string;
      status?: ProcessStepStatus;
      detail?: string;
      strategy?: string;
      fileTargets?: string[];
      provider?: string;
      model?: string;
      contract?: ProcessContract | null;
      summary?: string;
      error?: string;
      source?: "status" | "meta" | "progress";
    },
    fallback: { runId: string; gameId: string; provider: string; model: string },
  ) => {
    const now = Date.now();
    const runId = String(evt.runId || prev?.id || fallback.runId);
    let stepId = String(evt.stepId || "").trim();
    let stepLabel = String(evt.stepLabel || "").trim();
    const stepStatus = (evt.status || "running") as ProcessStepStatus;
    const mode = evt.mode || prev?.mode || "run";
    const next: ProcessRun = prev && prev.id === runId
      ? {
          ...prev,
          mode,
          provider: evt.provider || prev.provider,
          model: evt.model || prev.model,
          summary: evt.summary || evt.detail || prev.summary,
          contract: evt.contract ?? prev.contract,
          error: evt.error || prev.error,
        }
      : {
          id: runId,
          gameId: fallback.gameId,
          mode,
          provider: evt.provider || fallback.provider,
          model: evt.model || fallback.model,
          status: "running",
          summary: evt.summary || evt.detail || "AI 正在处理…",
          startedAt: now,
          currentStepId: "",
          steps: [],
          contract: evt.contract ?? null,
          error: evt.error || "",
        };

    // status 事件是“心跳/过程提示”，不应抢占当前步骤，也不应把其它步骤误标为完成。
    if (evt.source === "status" && prev?.currentStepId) {
      const cur = prev.steps.find((s) => s.id === prev.currentStepId);
      if (cur && cur.status === "running") {
        stepId = cur.id;
        stepLabel = cur.label;
      }
    }

    if (!stepId || !stepLabel) return next;
    const steps: ProcessStep[] =
      evt.source === "status"
        ? next.steps.slice()
        : next.steps.map((step) =>
            step.status === "running" && step.id !== stepId
              ? { ...step, status: "done" as ProcessStepStatus, finishedAt: step.finishedAt || now }
              : step,
          );
    const idx = steps.findIndex((step) => step.id === stepId);
    const nextStep: ProcessStep = idx >= 0
      ? {
          ...steps[idx],
          label: stepLabel || steps[idx].label,
          status: stepStatus,
          detail: evt.detail || steps[idx].detail,
          strategy: evt.strategy || steps[idx].strategy,
          fileTargets: evt.fileTargets && evt.fileTargets.length ? evt.fileTargets : steps[idx].fileTargets,
          startedAt: steps[idx].startedAt || now,
          finishedAt: stepStatus === "done" || stepStatus === "failed" ? now : undefined,
        }
      : {
          id: stepId,
          label: stepLabel,
          status: stepStatus,
          detail: evt.detail || "",
          strategy: evt.strategy || "",
          fileTargets: evt.fileTargets || [],
          startedAt: now,
          finishedAt: stepStatus === "done" || stepStatus === "failed" ? now : undefined,
        };
    if (idx >= 0) steps[idx] = nextStep;
    else steps.push(nextStep);

    return {
      ...next,
      summary: evt.summary || evt.detail || next.summary || stepLabel,
      currentStepId: stepId,
      steps,
    };
  };

  const applyProgressUpdate = (
    evt: {
      runId?: string;
      mode?: ProcessMode;
      stepId?: string;
      stepLabel?: string;
      status?: ProcessStepStatus;
      detail?: string;
      strategy?: string;
      fileTargets?: string[];
      provider?: string;
      model?: string;
      contract?: ProcessContract | null;
      summary?: string;
      error?: string;
      source?: "status" | "meta" | "progress";
    },
    fallback: { runId: string; gameId: string; provider: string; model: string },
  ) => {
    setProcessCurrent((prev) => upsertProcessStep(prev, evt, fallback));
  };

  useEffect(() => {
    setProcessCurrent(null);
    setProcessHistory([]);
  }, [gameId]);

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

  // 防止切换 gameId 时把“旧项目 messages”误保存到“新项目”
  // 只有当 messages 已确认属于当前 gameId 时，才允许写入 localStorage。
  const chatOwnerGameIdRef = useRef<string>("");

  // “创作过程/创作者想法”：从对话里提取用户发给 AI 的指令（步骤）
  const creatorStepsText = useMemo(() => {
    const userMsgs = (messages || [])
      .filter((m) => m?.role === "user")
      .map((m) => String(m.content || "").trim())
      .filter(Boolean);
    if (!userMsgs.length) return "";
    // 去重（避免重复重试导致相同文本堆叠）
    const dedup: string[] = [];
    for (const t of userMsgs) {
      if (!dedup.length || dedup[dedup.length - 1] !== t) dedup.push(t);
    }
    const lastN = dedup.slice(-8);
    return lastN.map((t, i) => `${i + 1}. ${t}`).join("\n");
  }, [messages]);

  const processCompletion = useMemo(() => {
    if (!processCurrent?.steps?.length) return 0;
    const total = processCurrent.steps.length;
    const done = processCurrent.steps.filter((step) => step.status === "done").length;
    const running = processCurrent.steps.some((step) => step.status === "running") ? 1 : 0;
    return Math.max(8, Math.min(96, Math.round(((done + running * 0.5) / total) * 100)));
  }, [processCurrent]);

  const activeProcessStep = useMemo(() => {
    if (!processCurrent?.steps?.length) return null;
    return processCurrent.steps.find((step) => step.id === processCurrent.currentStepId) || processCurrent.steps[processCurrent.steps.length - 1] || null;
  }, [processCurrent]);

  // === 聊天记录持久化（刷新不丢） ===
  // 1) gameId 变化时：尝试从 localStorage 恢复该项目的聊天记录
  useEffect(() => {
    if (!gameId) return;
    // 从首页模板进来属于“强制新建并自动开始”，不要用旧记录覆盖
    if ((initialPrompt || "").trim() && autoStart) return;
    // gameId 刚变化时，先标记“未确认归属”，避免 save effect 把旧 messages 写到新 gid
    chatOwnerGameIdRef.current = "";
    const saved = safeLoadChat(gameId);
    if (saved?.messages?.length) {
      setMessages(saved.messages);
      chatOwnerGameIdRef.current = gameId;
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
          chatOwnerGameIdRef.current = gameId;
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
    if (chatOwnerGameIdRef.current !== gameId) return;
    safeSaveChat(gameId, messages);
  }, [gameId, messages]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [viewMessages.length, busy]);

  function entryOf(gid: string) {
    // create 里预览要“原始游戏页面”（不带外层信息栏），避免双层嵌套
    return `/games/${gid}/__raw/index.html`;
  }

  function updatePreviewUrl(url: string, options?: { enable?: boolean }) {
    setPreviewUrl(url);
    if (options?.enable != null) setPreviewEnabled(!!options.enable);
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
        // 避免 window.confirm 造成页面“卡住”（尤其是自动化/某些浏览器环境下弹窗不明显）。
        // 直接跳转登录页即可，减少重复弹窗导致的“无法点击”体验。
        window.location.href = `/login?next=${encodeURIComponent("/create")}`;
        throw new Error("UNAUTHORIZED");
      }
      // 兜底：把状态码带上，避免只看到 NEW_GAME_FAILED
      throw new Error(err || `NEW_GAME_FAILED(${r.status})`);
    }
    setGameId(j.gameId);
    // 还没来得及切换/恢复新项目的 messages，先不要让 save effect 误写
    chatOwnerGameIdRef.current = "";
    return j.gameId as string;
  }

  async function ensureSeed(gid: string) {
    // 初始化该小游戏文件（seed 模式下 index.html 不会覆盖已存在内容）
    const r = await fetch("/api/creator/write", {
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
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(String(j?.error || `SEED_FAILED(${r.status})`));
    }
  }

  async function writePrompt(gid: string, promptText: string) {
    const content = (promptText || "").trim();
    if (!content) return;
    const r = await fetch("/api/creator/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameId: gid,
        files: [{ path: "prompt.md", content }],
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(String(j?.error || `WRITE_PROMPT_FAILED(${r.status})`));
    }
  }

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const isFromHome = !!(autoStart && initialPrompt && initialPrompt.trim());
    const fixedGameId = String(initialGameId || "").trim();

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

        // 从游戏页“编辑”跳转过来：固定打开指定项目（优先级最高）
        if (fixedGameId) {
          const me = await meP;
          setLoggedIn(!!me?.loggedIn);
          if (me?.creator?.name) setCreatorName(String(me.creator.name));
          if (me?.creator?.avatarUrl) setCreatorAvatarUrl(String(me.creator.avatarUrl));
          if (me?.creator?.profilePath) setCreatorProfilePath(String(me.creator.profilePath));
          setGameId(fixedGameId);
          updatePreviewUrl(`${entryOf(fixedGameId)}?t=${encodeURIComponent(nowId())}`, { enable: false });
          // 刷新项目列表（避免下拉框里没有该项目）
          await refreshProjects();
          return;
        }

        if (isFromHome) {
          const me = await meP;
          setLoggedIn(!!me?.loggedIn);
          if (me?.creator?.name) setCreatorName(String(me.creator.name));
          if (me?.creator?.avatarUrl) setCreatorAvatarUrl(String(me.creator.avatarUrl));
          if (me?.creator?.profilePath) setCreatorProfilePath(String(me.creator.profilePath));
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
          updatePreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`, { enable: true });
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
              updatePreviewUrl(`${entryOf(pick0)}?t=${encodeURIComponent(nowId())}`, { enable: false });
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
            updatePreviewUrl(`${entryOf(pick)}?t=${encodeURIComponent(nowId())}`, { enable: false });
            return;
          }
          return;
        }

        const me = await meP;
        setLoggedIn(!!me?.loggedIn);
        if (me?.creator?.name) setCreatorName(String(me.creator.name));
        if (me?.creator?.avatarUrl) setCreatorAvatarUrl(String(me.creator.avatarUrl));
        if (me?.creator?.profilePath) setCreatorProfilePath(String(me.creator.profilePath));
      } catch {}
      try {
        const gid = await newGame();
        await ensureSeed(gid);
        updatePreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`, { enable: true });
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
    // 优先用“我的游戏”列表里的标记，避免额外请求导致已发布游戏出现很慢
    const hit = (projects || []).find((p) => p.gameId === gameId);
    if (hit && typeof hit.published === "boolean") {
      setPublished(!!hit.published);
      return;
    }
    // 兜底：老缓存/列表里没有 published 字段时，才请求一次
    (async () => {
      try {
        const r = await fetch(`/api/games/${encodeURIComponent(gameId)}`, { cache: "no-store" });
        setPublished(r.ok);
      } catch {
        setPublished(false);
      }
    })();
  }, [gameId, projects]);

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
      // 手机端（尤其 iOS Safari）通常不支持 SpeechRecognition：给一个明确替代方案
      setMsg("当前浏览器暂不支持页面内语音输入。可点击输入框，使用系统键盘自带的语音输入（麦克风）。");
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
    return arr as Array<{ gameId: string; title?: string; entry: string; mtimeMs?: number; published?: boolean }>;
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
    if (!r.ok || !j?.ok) {
      const err = String(j?.error || "").trim();
      // 常见：登录过期 -> 401
      if (r.status === 401 || err === "UNAUTHORIZED") throw new Error("UNAUTHORIZED");
      throw new Error(err || `WRITE_FAILED(${r.status})`);
    }
  }

  async function loadGameMeta(gid: string) {
    const id = (gid || "").trim();
    if (!id) return;
    try {
      const r = await fetch(`/games/${encodeURIComponent(id)}/meta.json?t=${encodeURIComponent(nowId())}`, { cache: "no-store" });
      if (!r.ok) {
        setGameMeta(null);
        return;
      }
      const text = await r.text();
      const j = text ? JSON.parse(text) : null;
      if (j && typeof j === "object") setGameMeta(j as any);
      else setGameMeta(null);
    } catch {
      setGameMeta(null);
    }
  }

  // 切换游戏时加载对应的 meta（用于右侧“作品信息模块”）
  useEffect(() => {
    if (!gameId) {
      setGameMeta(null);
      return;
    }
    loadGameMeta(gameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  async function sendText(textRaw: string, gid?: string, baseMsgs?: ChatMsg[]) {
    const text = (textRaw || "").trim();
    const useId = gid || gameId;
    const useBase = baseMsgs || messages;
    if (!text || busy) return;
    if (!useId) throw new Error("NO_GAME_ID");

    // 快捷操作：如果用户输入的是一个 http(s) 链接，则直接在预览器打开，不走 AI 生成。
    // 说明：部分网站会设置 X-Frame-Options/CSP 禁止被 iframe 嵌入；此时可用右上角“新标签页打开”。
    if (/^https?:\/\/\S+/i.test(text)) {
      setMsg("已在预览器打开链接。若页面空白，可能该网站禁止 iframe 嵌入，可点右上角在新标签页打开。");
      updatePreviewUrl(text, { enable: true });
      setInput("");
      return;
    }

    setLastFailedText("");
    setBusy(true);
    setClarifyUi(null);
    setClarifyLocal(null);
    setMsg("");
    setInput("");
    const startAt = Date.now();
    const runId = nowId();
    setProcessCurrent({
      id: runId,
      gameId: useId,
      mode: guessProcessMode(text),
      provider,
      model,
      status: "running",
      summary: "AI 正在准备…",
      startedAt: startAt,
      currentStepId: "prepare",
      steps: [{ id: "prepare", label: "准备请求", status: "running", detail: "初始化对话与连接", startedAt: startAt }],
      contract: null,
      error: "",
    });

    // 新的一次请求：先取消上一次（理论上不会同时存在，但以防万一）
    try {
      abortRef.current?.abort();
    } catch {}
    const ac = new AbortController();
    abortRef.current = ac;

    const myMsg: ChatMsg = { role: "user", content: text };
    const snap: ChatMsg[] = [...useBase, myMsg, { role: "assistant", content: "AI 开始写代码…" }];
    chatOwnerGameIdRef.current = useId;
    setMessages(snap);

    // 第一句用户输入：把它写到 prompt.md（用于“我的游戏”下拉框显示关键词）
    // 性能优化：不要阻塞 UI / 不要阻塞 AI 请求（之前这里 await 会导致“点发送后几秒没反应”）
    // 只在当前对话还没有 user 消息时写入，避免后续不断覆盖
    const hasUser = useBase.some((m) => m.role === "user");
    if (!hasUser) {
      void (async () => {
        try {
          await writePrompt(useId, text);
          // 让下拉框尽快显示关键词
          await refreshProjects();
        } catch {
          // ignore
        }
      })();
    }

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
        // 传 gameId：让服务端能做“分步生成断点续跑”（哪一步失败，下次从哪一步开始）
        // mode/quality 由服务端自动判断（根据用户输入与当前工程状态）
        body: JSON.stringify({ gameId: useId, runId, messages: [...useBase, myMsg], provider, model }),
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
        const progressFallback = { runId, gameId: useId, provider, model };
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
                const inferred = inferStepFromStatusText(statusRaw);
                applyProgressUpdate(
                  {
                    mode: inferred?.mode,
                    stepId: inferred?.id || "status",
                    stepLabel: inferred?.label || "处理中",
                    status: "running",
                    detail: summarizeStatusText(statusRaw),
                    summary: summarizeStatusText(statusRaw),
                    source: "status",
                  },
                  progressFallback,
                );
                paintDraft(true);
              } else if (ev.event === "meta") {
                const p = String(ev.data?.provider || "").trim();
                const m = String(ev.data?.model || "").trim();
                const reason = String(ev.data?.reason || "").trim();
                const phase = String(ev.data?.phase || "").trim();
                if (reason && p === "deepseek") {
                  // 明确提醒用户：已回退到 DeepSeek
                  statusRaw = `已回退到 DeepSeek（${m || "deepseek-v4-flash"}）`;
                  if (m) setCurrentModelLabel(`当前模型：deepseek / ${m}`);
                } else if (p && m) {
                  statusRaw = `当前模型：${p} / ${m}`;
                  setCurrentModelLabel(`当前模型：${p} / ${m}`);
                }
                const inferred = inferStepFromPhase(phase);
                applyProgressUpdate(
                  {
                    provider: p || undefined,
                    model: m || undefined,
                    mode: inferred?.mode,
                    stepId: inferred?.id,
                    stepLabel: inferred?.label,
                    status: inferred ? "running" : undefined,
                    detail: inferred?.label ? `进入${inferred.label}` : undefined,
                    source: "meta",
                  },
                  progressFallback,
                );
                statusLine = withTime(statusRaw);
                paintDraft(true);
              } else if (ev.event === "progress") {
                const data = (ev.data || {}) as ProgressEventPayload;
                applyProgressUpdate(
                  {
                    runId: String(data.runId || runId),
                    mode: data.mode,
                    stepId: data.stepId,
                    stepLabel: data.stepLabel,
                    status: data.status,
                    detail: data.detail,
                    strategy: data.strategy,
                    fileTargets: normalizeStringList(data.fileTargets),
                    provider: String(data.provider || "").trim() || undefined,
                    model: String(data.model || "").trim() || undefined,
                    error: String(data.error || "").trim() || undefined,
                    summary: data.detail,
                    source: "progress",
                  },
                  progressFallback,
                );
              } else if (ev.event === "contract") {
                const raw = (ev.data || {}).contract || {};
                const contract: ProcessContract = {
                  topic: String(raw?.topic || "").trim(),
                  gameplay: String(raw?.gameplay || "").trim(),
                  platform: String(raw?.platform || "").trim(),
                  theme: String(raw?.theme || "").trim(),
                  complexity: String(raw?.complexity || "").trim(),
                  keyUi: normalizeStringList(raw?.keyUi),
                  mustHave: normalizeStringList(raw?.mustHave),
                  forbidden: normalizeStringList(raw?.forbidden),
                };
                applyProgressUpdate(
                  {
                    runId,
                    mode: "create",
                    stepId: "requirement_contract",
                    stepLabel: "需求契约",
                    status: "done",
                    detail: "已收敛本次生成约束",
                    contract,
                    summary: "需求契约已确定",
                  },
                  progressFallback,
                );
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
      // 若服务端返回可点击的澄清 UI（A/B/C 方案、问题选项等），保存在状态里用于渲染
      const ui = (parsed as any)?.ui;
      if (ui && typeof ui === "object") {
        setClarifyUi(ui);
        // 优化：如果服务端下发了完整 questions 列表，则后续选择在本地完成，避免每一步都再次请求大模型
        const all = (ui as any)?.all;
        if (all && typeof all === "object") {
          const options = Array.isArray(all?.options) ? all.options : [];
          const questions = Array.isArray(all?.questions) ? all.questions : [];
          const selected = (ui as any)?.selected && typeof (ui as any).selected === "object" ? { ...(ui as any).selected } : {};
          const maxTurns = typeof (ui as any)?.maxTurns === "number" ? (ui as any).maxTurns : 3;
          setClarifyLocal({
            options,
            questions,
            selected,
            maxTurns,
            // turn 表示“已回答的问题数”（不包含选 A/B/C）
            turn: 0,
            qIndex: 0,
          });
          clarifyAutoSubmittedRef.current = false;
        } else {
          setClarifyLocal(null);
          clarifyAutoSubmittedRef.current = false;
        }
      } else {
        setClarifyUi(null);
        setClarifyLocal(null);
        clarifyAutoSubmittedRef.current = false;
      }

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

      // 作品信息模块（独立于游戏区）：写入 meta.json 以便跨刷新保留
      let metaObj: GameMeta | null = null;
      const metaRaw = (parsed as any)?.meta;
      if (metaRaw && typeof metaRaw === "object") {
        const creator = metaRaw?.creator && typeof metaRaw.creator === "object" ? metaRaw.creator : {};
        metaObj = {
          title: String(metaRaw?.title || "").trim() || String(projects.find((p) => p.gameId === useId)?.title || "").trim() || useId,
          shortDesc: String(metaRaw?.shortDesc || "").trim(),
          rules: String(metaRaw?.rules || "").trim(),
          creator: {
            name: String(creator?.name || "").trim() || creatorName || "创作者",
            avatarUrl: String(creator?.avatarUrl || "").trim() || creatorAvatarUrl || "",
            profilePath: String(creator?.profilePath || "").trim() || creatorProfilePath || "",
          },
        };
        setGameMeta(metaObj);
      }

      const files = (Array.isArray(parsed.files) ? parsed.files : []) as ModelFile[];
      const toWrite: ModelFile[] = files.slice();
      if (metaObj) toWrite.push({ path: "meta.json", content: JSON.stringify(metaObj, null, 2) });
      if (toWrite.length) {
        await writeFiles(toWrite, useId);
        updatePreviewUrl(`${entryOf(useId)}?t=${encodeURIComponent(nowId())}`, { enable: true });
        // 重新拉一下 meta，确保与 DB 同步（例如被后端裁剪/规范化）
        loadGameMeta(useId);
      }
      archiveProcessRun("done");
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
        archiveProcessRun("stopped");
        return;
      }
      const m = String(e?.message || "未知错误");
      const ml = m.toLowerCase();
      const hint =
        ml.includes("unauthorized")
          ? "（登录状态可能已过期：请刷新页面或重新登录）"
          : ml.includes("missing_deepseek_api_key")
          ? "（服务端未配置 DEEPSEEK_API_KEY）"
          : ml.includes("missing_tencent_tokenhub_api_key")
          ? "（服务端未配置 TENCENT_TOKENHUB_API_KEY 或 TOKENHUB_API_KEY）"
          : ml.includes("missing_openrouter_api_key")
            ? "（服务端未配置 OPENROUTER_API_KEY）"
            : ml.includes("write_internal:erofs") || ml.includes("write_internal:eperm")
              ? "（服务器文件系统可能是只读/无权限，导致无法保存游戏文件；需要换成可写环境或改用数据库/对象存储保存）"
            : ml.includes("fetch_failed") || ml.includes("fetch failed") || ml.includes("network error")
              ? "（网络异常：可能是服务端到模型的网络/DNS/代理/TLS 问题，或浏览器到服务端连接中断；建议重试、切换模型/Provider，必要时刷新页面）"
          : ml.includes("terminated")
            ? "（连接被中断：可能是网络/模型超时/Key 无效/服务端被重启，建议重试）"
            : "（建议重试；如持续失败再检查 OPENROUTER_API_KEY / DEEPSEEK_API_KEY / TENCENT_TOKENHUB_API_KEY）";
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
      archiveProcessRun("failed", m);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  // 本地分步选择：当“已回答问题数”达到上限（默认 3）后，自动提交 @answers 进入编码，
  // 避免用户还要再点一次“开始生成”，也避免重复弹出下一轮问题导致体感像死循环。
  useEffect(() => {
    if (!clarifyLocal || busy) return;
    const selected: any = clarifyLocal.selected || {};
    const hasChoice = !!String(selected.choice || "").trim();
    const maxTurns = Number(clarifyLocal.maxTurns || 3) || 3;
    const turn = Number(clarifyLocal.turn || 0) || 0;
    if (!hasChoice) return;
    // 如果问题已答完（没有未回答的问题）也应立即进入编码，不要再问新问题
    const questions: any[] = Array.isArray(clarifyLocal.questions) ? clarifyLocal.questions : [];
    const hasUnanswered = questions.some((q: any) => {
      const id = String(q?.id || "").trim();
      if (!id) return false;
      return !String(selected[id] || "").trim();
    });
    if (turn < maxTurns && hasUnanswered) return;
    if (clarifyAutoSubmittedRef.current) return;
    clarifyAutoSubmittedRef.current = true;
    try {
      sendText(`@answers ${JSON.stringify(selected)}`);
    } catch {
      // ignore
    }
  }, [clarifyLocal, busy]);

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
            updatePreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`, { enable: true });
            await refreshProjects();
          } catch (err: any) {
            setMsg(`新建游戏失败：${err?.message || "未知错误"}`);
          }
        })();
      } else if (type === "publish") {
        if (!gameId) return;
        (async () => {
          // 有时页面刚加载完，loggedIn 还没来得及从 /api/me 更新；
          // 这里再确认一次，避免“明明已登录却提示去登录”。
          let okLogin = loggedIn;
          if (!okLogin) {
            try {
              const me = await fetch("/api/me", { cache: "no-store" })
                .then((x) => x.json())
                .catch(() => null);
              okLogin = !!me?.loggedIn;
              setLoggedIn(okLogin);
            } catch {
              okLogin = false;
            }
          }
          if (!okLogin) {
            if (window.confirm("发布需要先登录。现在去登录吗？")) window.location.href = `/login?next=${encodeURIComponent("/create")}`;
            return;
          }
          setMsg("发布中…正在打开发布页面…");
          // 让提示先渲染出来再跳转
          setTimeout(() => {
            window.location.href = `/publish?id=${encodeURIComponent(gameId)}`;
          }, 80);
        })();
      } else if (type === "delete") {
        if (!gameId) return;
        (async () => {
          try {
            setMsg("");
            const deletingId = gameId;
            const r = await fetch("/api/creator/delete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ gameId: deletingId }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j?.ok) throw new Error(j?.error || "DELETE_FAILED");

            // 清理本地缓存，避免以后“误恢复”被删项目的对话
            safeDeleteChat(deletingId);

            const arr = await refreshProjects();
            if (arr.length && arr[0]?.gameId) {
              setGameId(arr[0].gameId);
              updatePreviewUrl(`${entryOf(arr[0].gameId)}?t=${encodeURIComponent(nowId())}`, { enable: false });
              // 不要覆盖新项目的聊天记录（否则看起来像“把另一个游戏的对话弄丢了”）
              setMsg("已删除当前游戏。已切换到其它游戏。");
              return;
            }

            // 没有任何历史游戏了：自动新建一个
            const gid = await newGame();
            await ensureSeed(gid);
            updatePreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`, { enable: true });
            await refreshProjects();
            chatOwnerGameIdRef.current = gid;
            setMessages([{ role: "assistant", content: "我帮你新建了一个空白小游戏～你想做什么？" }]);
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
                if (gid) updatePreviewUrl(`${entryOf(gid)}?t=${encodeURIComponent(nowId())}`, { enable: false });
              }}
              disabled={busy}
              aria-label="选择历史游戏"
              style={{ padding: "8px 10px", fontSize: 13, fontWeight: 900 }}
            >
              {projects.length ? null : <option value="">（暂无历史游戏）</option>}
              {projects.map((p) => (
                <option key={p.gameId} value={p.gameId}>
                  {(p.title && p.title.trim()) ? p.title.trim() : p.gameId}
                  {p.published ? "  · 已发布" : "  · 草稿"}
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
      </div>

      <section className="createGrid">
        <div className="createPanel isChat" aria-label="chat">
          <div className="createPanelHeader">
            <div>
              <div className="createPanelTitle">AI 聊天</div>
              <div className="createPanelSub">描述玩法、按钮、胜负条件与画面风格</div>
              {(processCurrent || processHistory.length) ? (
                <div className="createProcessPanel" aria-label="AI 生成过程面板">
                  {processCurrent ? (
                    <details
                      className={`processRunCard ${processCollapsed ? "isCollapsed" : ""}`}
                      open={!processCollapsed}
                      onToggle={(e) => setProcessCollapsed(!(e.currentTarget as HTMLDetailsElement).open)}
                    >
                      <summary className="processRunTop" aria-label="AI 生成过程（点击收起/展开）">
                        <div className="processRunTitle">AI 生成过程</div>
                        <div className="processRunBadges">
                          <span className="processBadge">{processModeLabel(processCurrent.mode)}</span>
                          <span className={`processBadge is-${processCurrent.status}`}>{processStatusLabel(processCurrent.status)}</span>
                          <span className="processBadge isMuted">{formatElapsed(processCurrent.startedAt)}</span>
                        </div>
                        <div className="processRunMetaLine">
                          <span>{processCurrent.provider} / {processCurrent.model}</span>
                          {activeProcessStep?.strategy ? <span>策略：{activeProcessStep.strategy}</span> : null}
                          {activeProcessStep?.fileTargets?.length ? <span>文件：{activeProcessStep.fileTargets.join("、")}</span> : null}
                        </div>
                        <div className="processRunSummary">{processCurrent.summary || "AI 正在处理…"}</div>
                        <div className="processBar" aria-hidden="true">
                          <span style={{ width: `${processCompletion || 12}%` }} />
                        </div>
                      </summary>
                      {processCurrent.steps.length ? (
                        <div className="processSteps">
                          {processCurrent.steps.map((step) => (
                            <div
                              key={step.id}
                              className={`processStep is-${step.status} ${processCurrent.currentStepId === step.id ? "isCurrent" : ""}`}
                            >
                              <div className="processStepHead">
                                <span className="processStepDot" />
                                <span className="processStepLabel">{step.label}</span>
                                <span className="processStepStatus">
                                  {step.status === "running"
                                    ? "进行中"
                                    : step.status === "done"
                                      ? "完成"
                                      : step.status === "upgraded"
                                        ? "已升级"
                                        : step.status === "failed"
                                          ? "失败"
                                          : "待处理"}
                                </span>
                              </div>
                              {step.detail ? <div className="processStepDetail">{step.detail}</div> : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {processCurrent.contract ? (
                        <details className="processContractBox">
                          <summary>查看本次需求契约</summary>
                          <div className="processContractGrid">
                            {processCurrent.contract.topic ? <div><strong>主题</strong><span>{processCurrent.contract.topic}</span></div> : null}
                            {processCurrent.contract.gameplay ? <div><strong>玩法</strong><span>{processCurrent.contract.gameplay}</span></div> : null}
                            {processCurrent.contract.platform ? <div><strong>平台</strong><span>{processCurrent.contract.platform}</span></div> : null}
                            {processCurrent.contract.theme ? <div><strong>风格</strong><span>{processCurrent.contract.theme}</span></div> : null}
                            {processCurrent.contract.keyUi?.length ? <div><strong>关键 UI</strong><span>{processCurrent.contract.keyUi.join("、")}</span></div> : null}
                            {processCurrent.contract.mustHave?.length ? <div><strong>Must-have</strong><span>{processCurrent.contract.mustHave.join("；")}</span></div> : null}
                            {processCurrent.contract.forbidden?.length ? <div><strong>禁忌项</strong><span>{processCurrent.contract.forbidden.join("；")}</span></div> : null}
                          </div>
                        </details>
                      ) : null}
                    </details>
                  ) : null}

                  {processHistory.length ? (
                    <details className="processHistoryBox" open={!processCurrent}>
                      <summary>最近运行记录（{processHistory.length}）</summary>
                      <div className="processHistoryList">
                        {processHistory.map((run) => (
                          <details key={run.id} className="processHistoryItem">
                            <summary>
                              <span className="processHistoryTitle">{processModeLabel(run.mode)}</span>
                              <span className={`processBadge is-${run.status}`}>{processStatusLabel(run.status)}</span>
                              <span className="processHistoryMeta">{formatElapsed(run.startedAt, run.finishedAt)}</span>
                            </summary>
                            <div className="processHistoryBody">
                              <div className="processHistoryMetaLine">{run.provider} / {run.model}</div>
                              <div className="processHistorySummary">{run.summary}</div>
                              {run.error ? <div className="processHistoryError">{run.error}</div> : null}
                              {run.steps.length ? (
                                <div className="processSteps isHistory">
                                  {run.steps.map((step) => (
                                    <div key={step.id} className={`processStep is-${step.status}`}>
                                      <div className="processStepHead">
                                        <span className="processStepDot" />
                                        <span className="processStepLabel">{step.label}</span>
                                        <span className="processStepStatus">
                                          {step.status === "running"
                                            ? "进行中"
                                            : step.status === "done"
                                              ? "完成"
                                              : step.status === "upgraded"
                                                ? "已升级"
                                                : step.status === "failed"
                                                  ? "失败"
                                                  : "待处理"}
                                        </span>
                                      </div>
                                      {step.detail ? <div className="processStepDetail">{step.detail}</div> : null}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </details>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : null}
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
                  {/* 需求澄清：可点击选项（多轮选择，最多 3 次） */}
                  {m.role === "assistant" && idx === viewMessages.length - 1 && clarifyUi && !busy ? (
                    <div
                      className="chatInlineActions"
                      style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}
                      aria-label="澄清选项"
                    >
                      {/* 本地分步选择模式：选完一个立刻出现下一个，不用再请求大模型 */}
                      {clarifyLocal && Array.isArray(clarifyLocal?.options) ? (
                        (() => {
                          const selected: any = clarifyLocal.selected || {};
                          const maxTurns = Number(clarifyLocal.maxTurns || 3) || 3;
                          const turn = Number(clarifyLocal.turn || 0) || 0;
                          const qIndex = Number(clarifyLocal.qIndex || 0) || 0;
                          const questions: any[] = Array.isArray(clarifyLocal.questions) ? clarifyLocal.questions : [];
                          const hasChoice = !!String(selected.choice || "").trim();

                          const nextUnanswered = () => {
                            for (let i = qIndex; i < questions.length; i++) {
                              const q = questions[i] || {};
                              const id = String(q.id || "").trim();
                              if (!id) continue;
                              if (!String(selected[id] || "").trim()) return i;
                            }
                            return -1;
                          };
                          const nextIdx = nextUnanswered();

                          const applyChoice = (id: string) => {
                            setClarifyLocal((prev: any) => {
                              const p = prev || {};
                              const sel = { ...(p.selected || {}), choice: id };
                              // 选方向不计入“问题次数”
                              return { ...p, selected: sel, qIndex: 0 };
                            });
                          };
                          const applyAnswer = (qid: string, val: string) => {
                            setClarifyLocal((prev: any) => {
                              const p = prev || {};
                              const sel = { ...(p.selected || {}), [qid]: val };
                              const t = Math.min(maxTurns, (Number(p.turn || 0) || 0) + 1);
                              const qi = Math.max(0, (Number(p.qIndex || 0) || 0) + 1);
                              return { ...p, selected: sel, turn: t, qIndex: qi };
                            });
                          };
                          const startCoding = () => {
                            const sel = clarifyLocal?.selected || {};
                            sendText(`@answers ${JSON.stringify(sel)}`);
                          };
                          const skipToCoding = () => {
                            const sel = clarifyLocal?.selected || {};
                            sendText(`@answers ${JSON.stringify(sel)}`);
                          };

                          return (
                            <>
                              {!hasChoice ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                  {(clarifyLocal.options || []).slice(0, 3).map((o: any, i: number) => {
                                    const id = String(o?.id || "").trim() || String(["A", "B", "C"][i] || "A");
                                    const label = String(o?.title || o?.label || "").trim() || `方案${id}`;
                                    return (
                                      <button key={i} className="btn btnGray" type="button" onClick={() => applyChoice(id)} disabled={busy}>
                                        方案{id}：{label}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : null}

                              {hasChoice && turn < maxTurns && nextIdx >= 0 ? (
                                (() => {
                                  const q: any = questions[nextIdx] || {};
                                  const qid = String(q.id || "").trim() || `q${nextIdx + 1}`;
                                  const qtext = String(q.question || "").trim() || qid;
                                  const choices = Array.isArray(q.choices) ? q.choices : [];
                                  return (
                                    <div>
                                      <div style={{ fontWeight: 900, marginBottom: 6 }}>{qtext}</div>
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                        {choices.slice(0, 4).map((c: any, ci: number) => {
                                          const cc = String(c || "").trim();
                                          return (
                                            <button key={ci} className="btn btnGray" type="button" onClick={() => applyAnswer(qid, cc)} disabled={busy}>
                                              {cc}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : null}

                              {hasChoice ? (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                                  <button className="btn" type="button" onClick={skipToCoding} disabled={busy}>
                                    开始生成（跳过剩余选择）
                                  </button>
                                  {(turn >= maxTurns || nextIdx < 0) ? (
                                    <button className="btn" type="button" onClick={startCoding} disabled={busy}>
                                      开始生成
                                    </button>
                                  ) : null}
                                  <span className="desc" style={{ marginLeft: 6 }}>
                                    已回答问题 {turn}/{maxTurns}
                                  </span>
                                </div>
                              ) : (
                                <span className="desc">已回答问题 {turn}/{maxTurns}</span>
                              )}
                            </>
                          );
                        })()
                      ) : Array.isArray(clarifyUi?.options) && clarifyUi.options.length ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {clarifyUi.options.map((o: any, i: number) => {
                            const id = String(o?.id || "").trim();
                            const label = String(o?.label || "").trim() || `方案${id || i + 1}`;
                            const payload = String(o?.payload || (id ? `@choice ${id}` : `@choice A`)).trim();
                            return (
                              <button key={i} className="btn btnGray" type="button" onClick={() => sendText(payload)} disabled={busy}>
                                {id ? `方案${id}：` : ""}
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}

                      {!clarifyLocal && Array.isArray(clarifyUi?.questions) && clarifyUi.questions.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {clarifyUi.questions.map((q: any, qi: number) => {
                            const qid = String(q?.id || "").trim() || `q${qi + 1}`;
                            const qtext = String(q?.question || "").trim();
                            const choices = Array.isArray(q?.choices) ? q.choices : [];
                            return (
                              <div key={qi}>
                                <div style={{ fontWeight: 900, marginBottom: 6 }}>{qtext || qid}</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                  {choices.map((c: any, ci: number) => {
                                    const cc = String(c || "").trim();
                                    const payload = `@answer ${qid} ${cc}`;
                                    return (
                                      <button key={ci} className="btn btnGray" type="button" onClick={() => sendText(payload)} disabled={busy}>
                                        {cc}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      {!clarifyLocal && Array.isArray(clarifyUi?.actions) && clarifyUi.actions.length ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {clarifyUi.actions.map((a: any, ai: number) => {
                            const label = String(a?.label || "").trim() || "确认";
                            const payload = String(a?.payload || label).trim();
                            return (
                              <button key={ai} className="btn" type="button" onClick={() => sendText(payload)} disabled={busy}>
                                {label}
                              </button>
                            );
                          })}
                          {typeof clarifyUi?.turn === "number" && typeof clarifyUi?.maxTurns === "number" ? (
                            <span className="desc" style={{ marginLeft: 6 }}>
                              已选择 {clarifyUi.turn}/{clarifyUi.maxTurns}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {/* 失败时：在最后一个 AI 气泡后面给“重试”按钮（更符合用户预期） */}
                  {m.role === "assistant" && idx === viewMessages.length - 1 && lastFailedText && !busy ? (
                    <div className="chatInlineActions">
                      <button className="chatInlineRetry" type="button" onClick={() => sendText(lastFailedText)}>
                        重试
                      </button>
                    </div>
                  ) : null}
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
              placeholder="描述你的需求或问题：玩法/按钮/胜负条件/画面风格；或直接描述 bug（复现步骤、期望/实际、设备/报错）"
            />
            <div className="sendCol">
              <button
                className="btn btnGray voiceBtn"
                type="button"
                onClick={toggleSpeech}
                // 不因“不支持”而禁用：手机端可点击后给出提示（用键盘语音输入）
                disabled={busy}
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

          {/* 彩蛋：模型选择（默认收起，避免占用首屏） */}
          <details className="modelEgg" aria-label="模型选择（彩蛋）">
            <summary className="modelEggBtn" title={currentModelLabel || `${provider} / ${model}`}>
              模型（彩蛋）：{model} ▾
            </summary>
            <div className="modelEggPanel">
              <div className="modelEggRow">
                <span className="modelEggLabel">平台</span>
                <select
                  className="restInput modelEggSelect"
                  value={provider}
                  disabled={busy}
                  onChange={(e) => {
                    const p = (e.target.value || "openrouter") as any;
                    if (p !== "deepseek" && p !== "openrouter" && p !== "bailian" && p !== "tencent") return;
                    setProvider(p);
                    if (p === "openrouter") setModel("nvidia/nemotron-3-super-120b-a12b:free");
                    else if (p === "bailian") setModel("qwen3.6-plus");
                    else if (p === "tencent") setModel("hy3-preview");
                    else setModel("deepseek-v4-flash");
                  }}
                  aria-label="选择模型平台"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="bailian">阿里云百炼</option>
                  <option value="tencent">腾讯混元 TokenHub</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </div>
              <div className="modelEggRow">
                <span className="modelEggLabel">模型</span>
                <select
                  className="restInput modelEggSelect"
                  value={model}
                  disabled={busy}
                  onChange={(e) => setModel(e.target.value)}
                  aria-label="选择模型"
                >
                  {(provider === "openrouter"
                    ? openrouterModels
                    : provider === "bailian"
                      ? bailianModels
                      : provider === "tencent"
                        ? tencentModels
                        : deepseekModels).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </details>
        </div>
      </div>

        <div className="createPanel previewPanel" aria-label="preview">
          <div className="previewSplit" aria-label="preview-split">
            <div className="previewGame" aria-label="game">
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
                  {previewEnabled ? (
                    <iframe className="previewFrame" src={previewUrl} title="preview" />
                  ) : (
                    <div
                      style={{
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        gap: 12,
                        padding: 20,
                        textAlign: "center",
                        color: "#5a6472",
                      }}
                    >
                      <div>当前预览已暂停加载，避免坏掉的游戏脚本把创作页卡死。</div>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          if (!gameId) return;
                          updatePreviewUrl(`${entryOf(gameId)}?t=${encodeURIComponent(nowId())}`, { enable: true });
                        }}
                        disabled={!gameId}
                      >
                        加载预览
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <aside className="metaPanel" aria-label="meta">
              {/* 右侧信息栏：标题直接显示作品名称，节省空间 */}
              <div className="metaTitle">{(gameMeta?.title || "").trim() || "未命名作品"}</div>
              <div className="metaBlock">
                <div className="metaLabel">简介</div>
                <div className="metaValue">{gameMeta?.shortDesc || "（待补充）"}</div>
              </div>
              <div className="metaBlock">
                <div className="metaLabel">规则</div>
                <div className="metaValue metaPre">{gameMeta?.rules || "（待补充）"}</div>
              </div>
              <div className="metaBlock">
                <div className="metaLabel">创作者</div>
                <div className="metaValue" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {(gameMeta?.creator?.avatarUrl || creatorAvatarUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={String(gameMeta?.creator?.avatarUrl || creatorAvatarUrl)}
                      alt="创作者头像"
                      style={{ width: 22, height: 22, borderRadius: 999, objectFit: "cover" }}
                    />
                  ) : null}
                  {gameMeta?.creator?.profilePath || creatorProfilePath ? (
                    <a href={String(gameMeta?.creator?.profilePath || creatorProfilePath)} className="metaLink">
                      {gameMeta?.creator?.name || creatorName || "创作者"}
                    </a>
                  ) : (
                    <span>{gameMeta?.creator?.name || creatorName || "创作者"}</span>
                  )}
                </div>
              </div>
              <div className="metaBlock">
                <div className="metaLabel">创作过程</div>
                <div className="metaValue metaPre">{creatorStepsText || "（待补充：先发一句需求给 AI）"}</div>
              </div>
            </aside>
          </div>
        </div>
      </section>
    </section>
  );
}
