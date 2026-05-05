import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSessionOrGuest } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isCreatorGameId(id: string) {
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

export async function POST(req: Request) {
  const sess = await getSession();
  let body: { gameId?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const gid = String(body?.gameId || "").trim();
  if (!isCreatorGameId(gid)) return json(400, { ok: false, error: "INVALID_GAME_ID" });

  try {
    const ownerKey = await ownerKeyFromSessionOrGuest(sess, req);
    if (!ownerKey) return json(500, { ok: false, error: "OWNER_KEY_FAILED" });
    await ensureCreatorDraftTables();
    await db.execute(sql`
      delete from creator_draft_games
      where id = ${gid} and owner_key = ${ownerKey}
    `);
  } catch (e: any) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }

  return json(200, { ok: true, gameId: gid });
}
