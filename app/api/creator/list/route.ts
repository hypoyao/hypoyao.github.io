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

export async function GET() {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED", games: [] });
  const ownerKey = ownerKeyFromSession(sess);
  if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED", games: [] });

  await ensureCreatorDraftTables();
  const rows = await db.execute(sql`
    select id, title, extract(epoch from updated_at) as updated_s
    from creator_draft_games
    where owner_key = ${ownerKey}
    order by updated_at desc
    limit 300
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const games = list.map((r: any) => ({
    gameId: String(r.id),
    entry: `/games/${String(r.id)}/index.html`,
    mtimeMs: Math.floor(Number(r.updated_s || 0) * 1000),
    title: String(r.title || ""),
  }));
  return json(200, { ok: true, games });
}
