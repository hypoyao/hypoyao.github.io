import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
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

async function getLinkedSourceDraftId(gameId: string, creatorId: string) {
  if (!gameId || !creatorId) return "";
  try {
    await ensureGamesCoverFields();
    const [row] = await db
      .select({ sourceDraftId: games.sourceDraftId })
      .from(games)
      .where(and(eq(games.id, gameId), eq(games.creatorId, creatorId)))
      .limit(1);
    const linked = String(row?.sourceDraftId || "").trim();
    return linked && linked !== gameId ? linked : "";
  } catch {
    return "";
  }
}

export async function GET(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const creatorId = await getMyCreatorId();
  // 有些环境可能还没有创建 creators 记录：聊天记录只是“可选增强”，不要因为它影响创作体验
  if (!creatorId) return json(200, { ok: true, gameId: "", messages: [] });

  const url = new URL(req.url);
  const gameId = normalizeGameId(url.searchParams.get("gameId") || "");
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });

  await ensureCreatorUserMessagesTable();
  const linkedDraftId = await getLinkedSourceDraftId(gameId, creatorId);
  const rows =
    linkedDraftId && linkedDraftId !== gameId
      ? await db.execute(sql`
          select id, game_id, content, created_at
          from creator_user_messages
          where creator_id = ${creatorId}
            and (game_id = ${gameId} or game_id = ${linkedDraftId})
          order by created_at asc, id asc
          limit 400
        `)
      : await db.execute(sql`
          select id, game_id, content, created_at
          from creator_user_messages
          where creator_id = ${creatorId} and game_id = ${gameId}
          order by created_at asc, id asc
          limit 200
        `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  return json(200, {
    ok: true,
    gameId,
    linkedDraftId: linkedDraftId || null,
    messages: list.map((r: any) => ({ id: r.id, content: r.content, createdAt: r.created_at })),
  });
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const creatorId = await getMyCreatorId();
  // 同上：没有 creatorId 时直接忽略写入（不报错）
  if (!creatorId) return json(200, { ok: true, skipped: true });

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
