import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSessionOrGuest } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { creators } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const sess = await getSession();
  const ownerKey = await ownerKeyFromSessionOrGuest(sess, req);
  if (!ownerKey) return json(500, { ok: false, error: "OWNER_KEY_FAILED", games: [] });

  // 并发拉取：草稿 + 已发布
  await Promise.all([
    ensureCreatorDraftTables(),
    ensureCreatorsAuthFields().catch(() => null),
    ensureGamesCoverFields().catch(() => null),
  ]);

  let creatorId = "";
  try {
    if (sess?.phone) {
      const [c] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, sess.phone)).limit(1);
      creatorId = String(c?.id || "");
    } else if (sess?.openid) {
      const [c] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, sess.openid)).limit(1);
      creatorId = String(c?.id || "");
    }
  } catch {
    creatorId = "";
  }

  const draftP = db.execute(sql`
    select
      g.id,
      g.title,
      extract(epoch from g.updated_at) as updated_s,
      extract(epoch from coalesce(f.files_updated_at, g.updated_at)) as files_updated_s
    from creator_draft_games g
    left join lateral (
      select max(updated_at) as files_updated_at
      from creator_draft_files
      where game_id = g.id
        and path in ('index.html','style.css','game.js','meta.json')
    ) f on true
    where g.owner_key = ${ownerKey}
    order by g.updated_at desc
    limit 300
  `);
  const pubP = creatorId
    ? db.execute(sql`
        select
          g.id,
          g.title,
          g.source_draft_id,
          extract(epoch from g.updated_at) as updated_s,
          extract(epoch from coalesce(f.files_updated_at, g.updated_at)) as files_updated_s
        from games g
        left join lateral (
          select max(updated_at) as files_updated_at
          from game_files
          where game_id = g.id
            and path in ('index.html','style.css','game.js','meta.json')
        ) f on true
        where g.creator_id = ${creatorId}
        order by g.updated_at desc
        limit 300
      `)
    : Promise.resolve({ rows: [] } as any);

  const [draftRows, pubRows] = await Promise.all([draftP, pubP]);
  const drafts = Array.isArray((draftRows as any).rows) ? (draftRows as any).rows : [];
  const pubs = Array.isArray((pubRows as any).rows) ? (pubRows as any).rows : [];

  const map = new Map<string, { gameId: string; entry: string; mtimeMs: number; title: string; published: boolean; dirty: boolean; publishId?: string }>();

  for (const r of drafts) {
    const id = String((r as any).id || "");
    if (!id) continue;
    const updatedMs = Math.floor(Number((r as any).updated_s || 0) * 1000);
    const filesUpdatedMs = Math.floor(Number((r as any).files_updated_s || 0) * 1000);
    map.set(id, {
      gameId: id,
      entry: `/games/${id}/__raw/index.html`,
      mtimeMs: Math.max(updatedMs, filesUpdatedMs),
      title: String((r as any).title || ""),
      published: false,
      dirty: false,
      publishId: "",
    });
  }
  for (const r of pubs) {
    const publishId = String((r as any).id || "").trim();
    if (!publishId) continue;
    const sourceDraftId = String((r as any).source_draft_id || "").trim();
    const publishTitle = String((r as any).title || "");
    const publishMtimeMs = Math.floor(Number((r as any).updated_s || 0) * 1000);
    const publishFilesMtimeMs = Math.floor(Number((r as any).files_updated_s || 0) * 1000);
    if (sourceDraftId && map.has(sourceDraftId)) {
      const prev = map.get(sourceDraftId)!;
      map.set(sourceDraftId, {
        ...prev,
        mtimeMs: Math.max(prev.mtimeMs || 0, publishMtimeMs),
        title: prev.title || publishTitle,
        published: true,
        dirty: (prev.mtimeMs || 0) > Math.max(publishMtimeMs, publishFilesMtimeMs),
        publishId,
      });
      continue;
    }
    map.set(publishId, {
      gameId: publishId,
      entry: `/games/${publishId}/__raw/index.html`,
      mtimeMs: publishMtimeMs,
      title: publishTitle,
      published: true,
      dirty: false,
      publishId,
    });
  }

  const games = Array.from(map.values())
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 300);

  return json(200, { ok: true, games, creatorId: creatorId || null });
}
