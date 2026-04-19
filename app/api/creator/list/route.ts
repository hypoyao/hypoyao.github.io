import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isCreatorGameId(id: string) {
  // 由 /api/creator/new 生成：g-YYYYMMDD-xxxxxx
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

async function tryReadTitle(indexPath: string) {
  try {
    const html = await fs.readFile(indexPath, "utf8");
    const m = html.match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
    if (m && m[1]) return m[1].trim();
  } catch {}
  return "";
}

export async function GET() {
  const base = path.join(process.cwd(), "public", "games");
  let items: Array<{ gameId: string; entry: string; mtimeMs: number; title?: string }> = [];
  try {
    const ents = await fs.readdir(base, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const d of dirs) {
      if (!isCreatorGameId(d)) continue;
      const indexPath = path.join(base, d, "index.html");
      const st = await fs
        .stat(indexPath)
        .then((x) => x)
        .catch(() => null);
      const mtimeMs = st?.mtimeMs || 0;
      const title = await tryReadTitle(indexPath);
      items.push({ gameId: d, entry: `/games/${d}/index.html`, mtimeMs, title });
    }
  } catch {
    items = [];
  }

  items.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return json(200, { ok: true, games: items });
}

