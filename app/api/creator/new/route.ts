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

function genId() {
  // 轻量可读：g-20260419-abcdef
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(16).slice(2, 8);
  return `g-${y}${m}${day}-${rand}`;
}

export async function POST() {
  let sess: any = null;
  try {
    sess = await getSession();
  } catch (e: any) {
    return json(500, { ok: false, error: `AUTH_FAILED:${String(e?.message || e)}` });
  }
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });

  try {
    await ensureCreatorDraftTables();
    const id = genId();
    const ownerKey = ownerKeyFromSession(sess);
    if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED" });

    await db.execute(sql`
      insert into creator_draft_games (id, owner_key, title)
      values (${id}, ${ownerKey}, '')
      on conflict (id) do nothing;
    `);
    return json(200, { ok: true, gameId: id, entry: `/games/${id}/index.html` });
  } catch (e: any) {
    return json(500, { ok: false, error: `NEW_GAME_FAILED:${String(e?.message || e)}` });
  }
}
