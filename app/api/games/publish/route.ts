import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
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

function normalizeDraftId(id: string) {
  const raw = String(id || "").trim();
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : "";
}

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

function parseJsonObject(raw: string) {
  try {
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? (obj as Record<string, any>) : null;
  } catch {
    return null;
  }
}

async function readDraftFile(gameId: string, filePath: string) {
  try {
    await ensureCreatorDraftTables();
    const rows = await db.execute(sql`
      select content
      from creator_draft_files
      where game_id = ${gameId} and path = ${filePath}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    const content = list?.[0]?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

async function readPublishedFile(gameId: string, filePath: string) {
  try {
    await ensureGameFilesTables();
    const rows = await db.execute(sql`
      select content
      from game_files
      where game_id = ${gameId} and path = ${filePath}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    const content = list?.[0]?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

async function draftExistsForOwner(gameId: string, ownerKey: string) {
  if (!gameId || !ownerKey) return false;
  try {
    await ensureCreatorDraftTables();
    const rows = await db.execute(sql`
      select 1
      from creator_draft_games
      where id = ${gameId} and owner_key = ${ownerKey}
      limit 1
    `);
    const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
    return !!list.length;
  } catch {
    return false;
  }
}

async function resolvePublishSourceDraftId(candidates: string[], ownerKey: string) {
  const uniq = Array.from(new Set(candidates.map((s) => normalizeDraftId(s)).filter(Boolean)));
  for (const gid of uniq) {
    if (await draftExistsForOwner(gid, ownerKey)) return gid;
  }
  return "";
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
  const ownerKey = ownerKeyFromSession(sess);
  if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED" });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const requestedId = normalizeId(String(body?.id || ""));
  if (!requestedId) return json(400, { ok: false, error: "MISSING_ID" });
  const sourceDraftId = normalizeDraftId(String(body?.sourceDraftId || ""));
  const publishGameId = normalizeId(sourceDraftId || requestedId);
  if (!publishGameId) return json(400, { ok: false, error: "MISSING_ID" });

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

  try {
    await ensureGamesCoverFields();
    await ensureGameFilesTables();
  } catch {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

  // 允许更新：若已存在，creatorId/path 不允许更改（除非管理员）
  const [existingById] = await db
    .select({ creatorId: games.creatorId, path: games.path, coverUrl: games.coverUrl, sourceDraftId: games.sourceDraftId })
    .from(games)
    .where(eq(games.id, publishGameId))
    .limit(1);

  const [legacyLinked] =
    sourceDraftId || requestedId !== publishGameId
      ? await db
          .select({ id: games.id, creatorId: games.creatorId, path: games.path, coverUrl: games.coverUrl, sourceDraftId: games.sourceDraftId })
          .from(games)
          .where(eq(games.sourceDraftId, publishGameId))
          .limit(1)
      : [null as any];
  const existing = existingById || legacyLinked;

  const effCreatorId = isAdmin ? creatorId : existing?.creatorId || creatorId;
  if (!isAdmin && (!meCreatorId || meCreatorId !== effCreatorId)) {
    return json(403, { ok: false, error: "FORBIDDEN_NOT_AUTHOR" });
  }
  const effPath = existingById?.path || (String(body?.path || "").trim() ? String(body.path).trim() : `/games/${publishGameId}/`);
  const actualSourceDraftId = await resolvePublishSourceDraftId(
    [sourceDraftId, publishGameId, requestedId, String(existing?.sourceDraftId || "").trim()],
    ownerKey,
  );
  const storedSourceDraftId = sourceDraftId || actualSourceDraftId || publishGameId;

  let coverUrl = String(body?.coverUrl || "").trim() || existing?.coverUrl || `/assets/screenshots/${publishGameId}.png`;
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
    coverUrl = `/assets/covers/${publishGameId}`;
  }

  // creator 必须存在
  const [creator] = await db
    .select({
      id: creators.id,
      name: creators.name,
      avatarUrl: creators.avatarUrl,
      profilePath: creators.profilePath,
    })
    .from(creators)
    .where(eq(creators.id, effCreatorId))
    .limit(1);
  if (!creator) return json(400, { ok: false, error: "CREATOR_NOT_FOUND" });

  // 1) upsert 元信息
  await db
    .insert(games)
    .values({
      id: publishGameId,
      sourceDraftId: storedSourceDraftId || null,
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
        sourceDraftId: storedSourceDraftId || null,
        ...(coverData ? { coverMime, coverData } : {}),
        ...(isAdmin ? { creatorId: effCreatorId } : {}),
        updatedAt: new Date(),
      },
    });

  // 2) 拷贝文件（从草稿 -> 发布）
  const src = actualSourceDraftId || storedSourceDraftId;
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
        values (${publishGameId}, ${p}, ${c})
        on conflict (game_id, path)
        do update set content = excluded.content, updated_at = now()
      `);
    }
  }

  // 3) 写入/覆盖 meta.json：保留原设计/生成元信息，只覆盖发布表单字段。
  const baseMeta =
    parseJsonObject(src ? await readDraftFile(src, "meta.json") : "") ||
    parseJsonObject(await readPublishedFile(publishGameId, "meta.json")) ||
    parseJsonObject(legacyLinked?.id ? await readPublishedFile(String(legacyLinked.id), "meta.json") : "") ||
    {};
  const baseCreator = baseMeta?.creator && typeof baseMeta.creator === "object" ? (baseMeta.creator as Record<string, any>) : {};
  const meta = {
    ...baseMeta,
    title,
    shortDesc,
    rules: ruleText,
    ruleText,
    creator: {
      ...baseCreator,
      name: creator.name,
      avatarUrl: creator.avatarUrl,
      profilePath: creator.profilePath,
    },
  };
  await db.execute(sql`
    insert into game_files (game_id, path, content)
    values (${publishGameId}, 'meta.json', ${JSON.stringify(meta, null, 2)})
    on conflict (game_id, path)
    do update set content = excluded.content, updated_at = now()
  `);

  if (publishGameId) {
    await db.execute(sql`
      delete from games
      where id <> ${publishGameId}
        and source_draft_id = ${publishGameId}
        and creator_id = ${effCreatorId}
    `);
  }

  return json(200, { ok: true, id: publishGameId, path: effPath });
}
