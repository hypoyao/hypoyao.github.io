import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentTypeFor(p: string) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  if (ext === "html") return "text/html; charset=utf-8";
  if (ext === "css") return "text/css; charset=utf-8";
  if (ext === "js") return "application/javascript; charset=utf-8";
  if (ext === "md") return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function isCreatorGameId(id: string) {
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

async function readPublicGameFile(gameId: string, rel: string) {
  const safe = rel.replace(/^\/+/, "");
  const file = path.join(process.cwd(), "public", "games", gameId, safe);
  const buf = await fs.readFile(file);
  return buf;
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  const parts = Array.isArray(slug) ? slug : [];
  const gameId = parts[0] || "";
  if (!gameId) return new NextResponse("Not Found", { status: 404 });

  // 兼容 /games/<id> 和 /games/<id>/ ：默认 index.html
  let rel = parts.slice(1).join("/");
  if (!rel || rel.endsWith("/")) rel = `${rel || ""}index.html`;
  // 兜底：/games/<id>/something（没扩展名）也当作目录
  if (!rel.includes(".")) rel = path.posix.join(rel, "index.html");

  // 1) creator 草稿：从 DB 读取
  if (isCreatorGameId(gameId)) {
    await ensureCreatorDraftTables();
    const rows = await db.execute(sql`
      select content
      from creator_draft_files
      where game_id = ${gameId} and path = ${rel}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    const content = list?.[0]?.content;
    if (typeof content === "string") {
      return new NextResponse(content, {
        status: 200,
        headers: {
          "content-type": contentTypeFor(rel),
          "cache-control": "no-store",
        },
      });
    }
    return new NextResponse("Not Found", { status: 404 });
  }

  // 2) 内置游戏：从 public/games 读取（只读即可）
  try {
    const buf = await readPublicGameFile(gameId, rel);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(rel),
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}

