const LAUNCH_PROMPT_PREFIX = "creatorLaunchPrompt:";
const LAUNCH_PROMPT_MAX_AGE_MS = 30 * 60 * 1000;

function isBrowser() {
  return typeof window !== "undefined" && !!window.localStorage;
}

function safeKey(key: string) {
  const s = String(key || "").trim();
  return /^[a-zA-Z0-9_-]{8,120}$/.test(s) ? s : "";
}

function nowId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
  } catch {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function cleanupExpiredLaunchPrompts() {
  if (!isBrowser()) return;
  const now = Date.now();
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(LAUNCH_PROMPT_PREFIX)) continue;
      const raw = window.localStorage.getItem(k);
      const parsed = raw ? JSON.parse(raw) : null;
      const at = Number(parsed?.at || 0);
      if (!at || now - at > LAUNCH_PROMPT_MAX_AGE_MS) {
        window.localStorage.removeItem(k);
      }
    }
  } catch {
    // ignore
  }
}

export function stashLaunchPrompt(prompt: string) {
  const text = String(prompt || "").trim().slice(0, 800);
  if (!text || !isBrowser()) return "";
  cleanupExpiredLaunchPrompts();
  const key = nowId();
  try {
    window.localStorage.setItem(
      `${LAUNCH_PROMPT_PREFIX}${key}`,
      JSON.stringify({
        prompt: text,
        at: Date.now(),
      }),
    );
    return key;
  } catch {
    return "";
  }
}

export function consumeLaunchPrompt(key: string) {
  const safe = safeKey(key);
  if (!safe || !isBrowser()) return "";
  cleanupExpiredLaunchPrompts();
  try {
    const fullKey = `${LAUNCH_PROMPT_PREFIX}${safe}`;
    const raw = window.localStorage.getItem(fullKey);
    window.localStorage.removeItem(fullKey);
    const parsed = raw ? JSON.parse(raw) : null;
    const text = String(parsed?.prompt || "").trim().slice(0, 800);
    const at = Number(parsed?.at || 0);
    if (!text || !at) return "";
    if (Date.now() - at > LAUNCH_PROMPT_MAX_AGE_MS) return "";
    return text;
  } catch {
    return "";
  }
}
