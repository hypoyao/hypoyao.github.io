import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { isSuperAdminId } from "@/lib/auth/admin";

type CreateGameBody = {
  id: string; // slug，如 'weiqi'
  title: string;
  shortDesc: string;
  ruleText: string;
  creatorId: string; // 如 'tianqing'
  coverUrl?: string; // 相对路径（如 /assets/screenshots/<id>.png 或 /assets/covers/<id>）
  coverDataUrl?: string; // data:image/...;base64,...（仅用于上传时）
  path?: string; // 默认 /games/<id>/
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
  try {
    const u = new URL(s);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseImageDataUrl(s: string) {
  const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([a-z0-9+/=]+)$/i.exec((s || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  return { mime, b64 };
}

async function isAuthorized(req: Request) {
  const key = process.env.ADMIN_API_KEY;
  const auth = req.headers.get("authorization") || "";
  if (key && auth === `Bearer ${key}`) return true;

  const sess = await getSession();
  const openid = sess?.openid;
  const phone = sess?.phone;
  if (!openid && !phone) return false;

  // 没有白名单时：允许任意已登录用户调用（适合个人项目）
  return true;
  return false;
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
  if (!(await isAuthorized(req))) {
    return json(401, { ok: false, error: "UNAUTHORIZED" });
  }

  let body: CreateGameBody;
  try {
    body = (await req.json()) as CreateGameBody;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const idRaw = body?.id;
  const id = typeof idRaw === "string" ? normalizeId(idRaw) : "";
  if (!id) return json(400, { ok: false, error: "MISSING_ID" });

  const title = typeof body.title === "string" ? body.title.trim() : "";
  let shortDesc = typeof body.shortDesc === "string" ? body.shortDesc.trim() : "";
  let ruleText = typeof body.ruleText === "string" ? body.ruleText.trim() : "";
  const creatorId = typeof body.creatorId === "string" ? body.creatorId.trim() : "";
  if (!title || !creatorId) return json(400, { ok: false, error: "MISSING_FIELDS" });
  // 允许简介/规则为空：自动用标题兜底（避免“发布页默认解析不到 desc”导致无法发布）
  if (!shortDesc) shortDesc = title.slice(0, 42);
  if (!ruleText) ruleText = shortDesc || title;

  // 管理员鉴权（用于允许指定作者）
  const key = process.env.ADMIN_API_KEY;
  const auth = req.headers.get("authorization") || "";
  const bearerAdmin = key && auth === `Bearer ${key}`;
  const meCreatorId = await getMyCreatorId();
  const isAdmin = isSuperAdminId(meCreatorId) || bearerAdmin;

  // 如果是“更新”场景：id/creatorId/path 不允许更改（以 DB 现有值为准）
  const [existing] = await db
    .select({ creatorId: games.creatorId, path: games.path, coverUrl: games.coverUrl })
    .from(games)
    .where(eq(games.id, id))
    .limit(1);

  // 如果是管理员：允许覆盖作者（便于代发布/修正作者归属）
  const effCreatorId = isAdmin ? creatorId : existing?.creatorId || creatorId;
  const effPath =
    existing?.path || (typeof body.path === "string" && body.path.trim() ? body.path.trim() : `/games/${id}/`);

  // 封面：
  // - coverUrl 存相对路径
  // - 如带 coverDataUrl，则把 coverUrl 固定为 /assets/covers/<id> 并把数据存到 DB
  const rawCover = typeof body.coverUrl === "string" ? body.coverUrl.trim() : "";
  let coverUrl = rawCover || existing?.coverUrl || `/assets/screenshots/${id}.png`;
  coverUrl = coverUrl.slice(0, 1024);
  if (!isAllowedCoverUrl(coverUrl)) return json(400, { ok: false, error: "INVALID_COVER_URL" });

  let coverMime: string | null = null;
  let coverData: string | null = null;
  const coverDataUrl = typeof body.coverDataUrl === "string" ? body.coverDataUrl.trim() : "";
  if (coverDataUrl) {
    const parsed = parseImageDataUrl(coverDataUrl);
    if (!parsed) return json(400, { ok: false, error: "INVALID_COVER_DATA" });
    // 限制大小（base64 文本长度）
    if (parsed.b64.length > 260_000) return json(400, { ok: false, error: "COVER_TOO_LARGE" });
    coverMime = parsed.mime;
    coverData = parsed.b64;
    coverUrl = `/assets/covers/${id}`;
  }

  // 校验 creator 是否存在
  const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.id, effCreatorId)).limit(1);
  if (!creator) return json(400, { ok: false, error: "CREATOR_NOT_FOUND" });

  // 作者权限：非管理员只能以自己的 creatorId 发布/更新
  if (!bearerAdmin) {
    if (!isAdmin) {
      // 仅允许更新“自己是作者”的游戏；更新场景以 DB 现有 creatorId 为准
      if (!meCreatorId || meCreatorId !== effCreatorId) {
        return json(403, { ok: false, error: "FORBIDDEN_NOT_AUTHOR" });
      }
    }
  }

  // upsert：已存在则更新（便于重复生成/覆盖）
  try {
    await ensureGamesCoverFields();
  } catch {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

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
    // drizzle 的 onConflictDoUpdate 支持在 postgres 上做 upsert
    .onConflictDoUpdate({
      target: games.id,
      set: {
        title,
        shortDesc,
        ruleText,
        coverUrl,
        ...(coverData ? { coverMime, coverData } : {}),
        // 管理员允许调整作者归属（creatorId）
        ...(isAdmin ? { creatorId: effCreatorId } : {}),
        updatedAt: new Date(),
      },
    });

  return json(200, { ok: true, id, path: effPath });
}
