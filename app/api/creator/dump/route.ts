import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function safeGameId(id: string) {
  const s = (id || "").trim();
  if (!s) return "";
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

export async function GET(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const ownerKey = ownerKeyFromSession(sess);
  if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED" });

  const url = new URL(req.url);
  const gameId = safeGameId(url.searchParams.get("gameId") || "");
  if (!gameId) return json(400, { ok: false, error: "INVALID_GAME_ID" });

  await ensureCreatorDraftTables();

  // 只允许导出自己的草稿
  const owns = await db.execute(sql`
    select 1
    from creator_draft_games
    where id = ${gameId} and owner_key = ${ownerKey}
    limit 1
  `);
  const ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
  if (!ownRows.length) return json(403, { ok: false, error: "NOT_YOUR_GAME" });

  const rows = await db.execute(sql`
    select path, content, extract(epoch from updated_at) as updated_s
    from creator_draft_files
    where game_id = ${gameId}
    order by path asc
    limit 20
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const files = list.map((r: any) => ({
    path: String(r?.path || ""),
    content: String(r?.content || ""),
    updatedAt: Math.floor(Number(r?.updated_s || 0) * 1000),
  }));

  return json(200, { ok: true, gameId, files });
}

