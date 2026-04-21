import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";
import { isSuperAdminId } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  // 目标发布 id（slug）
  id: string;
  title: string;
  shortDesc: string;
  ruleText: string;
  creatorId: string;
  coverUrl?: string;
  coverDataUrl?: string;
  path?: string;
  // 来源草稿（create 里生成的 g-xxxx）
  sourceDraftId?: string;
};

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeId(id: string) {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function isAllowedCoverUrl(s: string) {
  if (!s) return true;
  if (s.startsWith("/")) return true;
  return false;
}

function parseImageDataUrl(s: string) {
  const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([a-z0-9+/=]+)$/i.exec((s || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  return { mime, b64 };
}

async function getMyCreatorId() {
  const sess = await getSession();
  if (!sess) return null;
  try {
    await ensureCreatorsAuthFields();
    if (sess.phone) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, sess.phone)).limit(1);
      return row?.id || null;
    }
    if (sess.openid) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, sess.openid)).limit(1);
      return row?.id || null;
    }
  } catch {}
  return null;
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const id = normalizeId(String(body?.id || ""));
  if (!id) return json(400, { ok: false, error: "MISSING_ID" });

  const title = String(body?.title || "").trim();
  let shortDesc = String(body?.shortDesc || "").trim();
  let ruleText = String(body?.ruleText || "").trim();
  const creatorId = String(body?.creatorId || "").trim();
  if (!title || !creatorId) return json(400, { ok: false, error: "MISSING_FIELDS" });
  if (!shortDesc) shortDesc = title.slice(0, 42);
  if (!ruleText) ruleText = shortDesc || title;

  // 权限：非管理员只能以自己的 creatorId 发布/更新
  const meCreatorId = await getMyCreatorId();
  const isAdmin = isSuperAdminId(meCreatorId);
  if (!isAdmin) {
    if (!meCreatorId || meCreatorId !== creatorId) return json(403, { ok: false, error: "FORBIDDEN_NOT_AUTHOR" });
  }

  // 允许更新：若已存在，creatorId/path 不允许更改（除非管理员）
  const [existing] = await db
    .select({ creatorId: games.creatorId, path: games.path, coverUrl: games.coverUrl })
    .from(games)
    .where(eq(games.id, id))
    .limit(1);

  const effCreatorId = isAdmin ? creatorId : existing?.creatorId || creatorId;
  const effPath = existing?.path || (String(body?.path || "").trim() ? String(body.path).trim() : `/games/${id}/`);

  let coverUrl = String(body?.coverUrl || "").trim() || existing?.coverUrl || `/assets/screenshots/${id}.png`;
  coverUrl = coverUrl.slice(0, 1024);
  if (!isAllowedCoverUrl(coverUrl)) return json(400, { ok: false, error: "INVALID_COVER_URL" });

  let coverMime: string | null = null;
  let coverData: string | null = null;
  const coverDataUrl = String(body?.coverDataUrl || "").trim();
  if (coverDataUrl) {
    const parsed = parseImageDataUrl(coverDataUrl);
    if (!parsed) return json(400, { ok: false, error: "INVALID_COVER_DATA" });
    if (parsed.b64.length > 260_000) return json(400, { ok: false, error: "COVER_TOO_LARGE" });
    coverMime = parsed.mime;
    coverData = parsed.b64;
    coverUrl = `/assets/covers/${id}`;
  }

  // creator 必须存在
  const [creator] = await db.select({ id: creators.id, name: creators.name }).from(creators).where(eq(creators.id, effCreatorId)).limit(1);
  if (!creator) return json(400, { ok: false, error: "CREATOR_NOT_FOUND" });

  try {
    await ensureGamesCoverFields();
    await ensureGameFilesTables();
  } catch {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

  // 1) upsert 元信息
  await db
    .insert(games)
    .values({
      id,
      title,
      shortDesc,
      ruleText,
      coverUrl,
      coverMime,
      coverData,
      path: effPath,
      creatorId: effCreatorId,
    })
    .onConflictDoUpdate({
      target: games.id,
      set: {
        title,
        shortDesc,
        ruleText,
        coverUrl,
        ...(coverData ? { coverMime, coverData } : {}),
        ...(isAdmin ? { creatorId: effCreatorId } : {}),
        updatedAt: new Date(),
      },
    });

  // 2) 拷贝文件（从草稿 -> 发布）
  const src = String(body?.sourceDraftId || "").trim();
  if (src) {
    await ensureCreatorDraftTables();
    const rows = await db.execute(sql`
      select path, content
      from creator_draft_files
      where game_id = ${src}
        and path in ('index.html','style.css','game.js','prompt.md','meta.json')
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    for (const r of list) {
      const p = String((r as any).path || "").trim();
      const c = String((r as any).content || "");
      if (!p) continue;
      await db.execute(sql`
        insert into game_files (game_id, path, content)
        values (${id}, ${p}, ${c})
        on conflict (game_id, path)
        do update set content = excluded.content, updated_at = now()
      `);
    }
  }

  // 3) 写入/覆盖 meta.json（保证“作品信息模块”独立于游戏区）
  const meta = {
    title,
    shortDesc,
    rules: ruleText,
    creator: { name: creator.name },
  };
  await db.execute(sql`
    insert into game_files (game_id, path, content)
    values (${id}, 'meta.json', ${JSON.stringify(meta, null, 2)})
    on conflict (game_id, path)
    do update set content = excluded.content, updated_at = now()
  `);

  return json(200, { ok: true, id, path: effPath });
}

