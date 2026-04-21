import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession, upsertCreatorGame } from "@/lib/creator/creatorIndex";

export const dynamic = "force-dynamic";

type Body = {
  gameId?: string;
  seed?: boolean;
  files?: Array<{ path: string; content: string }>;
};

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function safeRel(p: string) {
  const s = (p || "").trim().replace(/^\/+/, "");
  if (!s) return "";
  if (s.includes("..") || s.includes("\\") || s.includes(":")) return "";
  // 允许写入的文件（避免任意文件写入）
  if (!["index.html", "game.js", "style.css", "prompt.md"].includes(s)) return "";
  return s;
}

function safeGameId(id: string) {
  const s = (id || "").trim();
  if (!s) return "";
  // 只允许字母数字、下划线、短横线，避免目录穿越
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

function toKeywordFromPrompt(s: string) {
  const t = (s || "").replace(/\r/g, "").trim();
  if (!t) return "";
  const m1 = t.match(/(?:我想|想)?做(?:一个|个)?\s*([^\n，。,.]{1,24}?游戏)/);
  const m2 = t.match(/([^\n，。,.]{1,24}?游戏)/);
  let k = (m1?.[1] || m2?.[1] || "").trim();
  if (!k) {
    const first =
      t
        .split("\n")
        .map((x) => x.trim())
        .find((x) => x && !x.startsWith("#")) || "";
    k = first.trim();
  }
  k = k.replace(/（.*?）/g, "").trim();
  if (k.length > 14) {
    k = k.slice(0, 14);
    if (!k.endsWith("游戏") && t.includes("游戏")) k = k.replace(/\s+$/g, "") + "…";
  }
  return k;
}

async function updateMeta(base: string, patch: Record<string, any>) {
  try {
    const p = path.join(base, "meta.json");
    let obj: any = {};
    try {
      const raw = await fs.readFile(p, "utf8");
      obj = JSON.parse(raw);
    } catch {}
    obj = { ...(obj || {}), ...(patch || {}) };
    await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // ignore
  }
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const files = Array.isArray(body?.files) ? body.files : [];
  if (!files.length) return json(400, { ok: false, error: "MISSING_FILES" });

  const gid = safeGameId(body?.gameId || "creator-playground");
  if (!gid) return json(400, { ok: false, error: "INVALID_GAME_ID" });
  const base = path.join(process.cwd(), "public", "games", gid);
  await fs.mkdir(base, { recursive: true });

  // seed 模式：如果 index.html 已存在就不覆盖（避免误删用户内容）
  const indexPath = path.join(base, "index.html");
  const indexExists = await fs
    .stat(indexPath)
    .then(() => true)
    .catch(() => false);

  const written: string[] = [];
  let updatedTitle = "";
  for (const f of files) {
    const rel = safeRel(f?.path || "");
    if (!rel) continue;
    if (body.seed && indexExists && rel === "index.html") continue;
    const out = path.join(base, rel);
    const content = typeof f?.content === "string" ? f.content : "";
    await fs.writeFile(out, content, "utf8");
    written.push(`/games/${gid}/${rel}`);

    // 同步 meta，方便 list 更快读取
    if (rel === "prompt.md") {
      const k = toKeywordFromPrompt(content);
      if (k) updatedTitle = k;
    } else if (rel === "index.html") {
      const m = content.match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
      if (m && m[1]) updatedTitle = String(m[1]).trim();
    }
  }

  if (updatedTitle) await updateMeta(base, { title: updatedTitle, mtimeMs: Date.now() });
  // 同步到高速索引
  try {
    const ownerKey = ownerKeyFromSession(sess);
    if (ownerKey) {
      await upsertCreatorGame(ownerKey, {
        gameId: gid,
        entry: `/games/${gid}/index.html`,
        mtimeMs: Date.now(),
        title: updatedTitle || undefined,
      });
    }
  } catch {}

  return json(200, { ok: true, written, gameId: gid, entry: `/games/${gid}/index.html` });
}
