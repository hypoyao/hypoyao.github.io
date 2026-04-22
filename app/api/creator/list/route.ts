import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { creators } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";

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

  // 并发拉取：草稿 + 已发布
  await ensureCreatorDraftTables();
  try {
    await ensureCreatorsAuthFields();
  } catch {}

  let creatorId = "";
  try {
    if (sess.phone) {
      const [c] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, sess.phone)).limit(1);
      creatorId = String(c?.id || "");
    } else if (sess.openid) {
      const [c] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, sess.openid)).limit(1);
      creatorId = String(c?.id || "");
    }
  } catch {
    creatorId = "";
  }

  const draftP = db.execute(sql`
    select id, title, extract(epoch from updated_at) as updated_s
    from creator_draft_games
    where owner_key = ${ownerKey}
    order by updated_at desc
    limit 300
  `);
  const pubP = creatorId
    ? db.execute(sql`
        select id, title, extract(epoch from updated_at) as updated_s
        from games
        where creator_id = ${creatorId}
        order by updated_at desc
        limit 300
      `)
    : Promise.resolve({ rows: [] } as any);

  const [draftRows, pubRows] = await Promise.all([draftP, pubP]);
  const drafts = Array.isArray((draftRows as any).rows) ? (draftRows as any).rows : [];
  const pubs = Array.isArray((pubRows as any).rows) ? (pubRows as any).rows : [];

  const map = new Map<string, { gameId: string; entry: string; mtimeMs: number; title: string; published: boolean }>();

  for (const r of drafts) {
    const id = String((r as any).id || "");
    if (!id) continue;
    map.set(id, {
      gameId: id,
      entry: `/games/${id}/__raw/index.html`,
      mtimeMs: Math.floor(Number((r as any).updated_s || 0) * 1000),
      title: String((r as any).title || ""),
      published: false,
    });
  }
  for (const r of pubs) {
    const id = String((r as any).id || "");
    if (!id) continue;
    // 已发布优先（覆盖同 id 的草稿）
    map.set(id, {
      gameId: id,
      entry: `/games/${id}/__raw/index.html`,
      mtimeMs: Math.floor(Number((r as any).updated_s || 0) * 1000),
      title: String((r as any).title || ""),
      published: true,
    });
  }

  const games = Array.from(map.values())
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 300);

  return json(200, { ok: true, games, creatorId: creatorId || null });
}
