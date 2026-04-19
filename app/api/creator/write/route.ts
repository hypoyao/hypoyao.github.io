import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";

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
  // 只允许三种文件
  if (!["index.html", "game.js", "style.css"].includes(s)) return "";
  return s;
}

function safeGameId(id: string) {
  const s = (id || "").trim();
  if (!s) return "";
  // 只允许字母数字、下划线、短横线，避免目录穿越
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

export async function POST(req: Request) {
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
  for (const f of files) {
    const rel = safeRel(f?.path || "");
    if (!rel) continue;
    if (body.seed && indexExists && rel === "index.html") continue;
    const out = path.join(base, rel);
    const content = typeof f?.content === "string" ? f.content : "";
    await fs.writeFile(out, content, "utf8");
    written.push(`/games/${gid}/${rel}`);
  }

  return json(200, { ok: true, written, gameId: gid, entry: `/games/${gid}/index.html` });
}
