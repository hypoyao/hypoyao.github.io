import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureCreatorUserMessagesTable } from "@/lib/db/ensureCreatorUserMessagesTable";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

async function getMyCreatorId() {
  const sess = await getSession();
  const openid = sess?.openid;
  const phone = sess?.phone;
  if (!openid && !phone) return null;
  try {
    await ensureCreatorsAuthFields();
    if (phone) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, phone)).limit(1);
      return row?.id || null;
    }
    if (openid) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, openid)).limit(1);
      return row?.id || null;
    }
  } catch {}
  return null;
}

function normalizeGameId(id: string) {
  return (id || "").trim();
}

export async function GET(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const creatorId = await getMyCreatorId();
  if (!creatorId) return json(403, { ok: false, error: "FORBIDDEN" });

  const url = new URL(req.url);
  const gameId = normalizeGameId(url.searchParams.get("gameId") || "");
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });

  await ensureCreatorUserMessagesTable();

  const rows = await db.execute(sql`
    select id, content, created_at
    from creator_user_messages
    where creator_id = ${creatorId} and game_id = ${gameId}
    order by id asc
    limit 200
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  return json(200, {
    ok: true,
    gameId,
    messages: list.map((r: any) => ({ id: r.id, content: r.content, createdAt: r.created_at })),
  });
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const creatorId = await getMyCreatorId();
  if (!creatorId) return json(403, { ok: false, error: "FORBIDDEN" });

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }
  const gameId = normalizeGameId(body?.gameId || "");
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });
  if (!content) return json(400, { ok: false, error: "MISSING_CONTENT" });

  await ensureCreatorUserMessagesTable();

  await db.execute(sql`
    insert into creator_user_messages (game_id, creator_id, content)
    values (${gameId}, ${creatorId}, ${content})
  `);
  return json(200, { ok: true });
}

