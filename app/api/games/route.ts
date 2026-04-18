import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";

type CreateGameBody = {
  id: string; // slug，如 'weiqi'
  title: string;
  shortDesc: string;
  ruleText: string;
  creatorId: string; // 如 'tianqing'
  coverUrl?: string; // 默认 /assets/screenshots/<id>.svg
  path?: string; // 默认 /games/<id>/
};

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeId(id: string) {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

async function isAuthorized(req: Request) {
  const key = process.env.ADMIN_API_KEY;
  const auth = req.headers.get("authorization") || "";
  if (key && auth === `Bearer ${key}`) return true;

  const sess = await getSession();
  const openid = sess?.openid;
  if (!openid) return false;

  // 如果配置了管理员 openid 白名单，则必须在白名单内
  const allow = (process.env.ADMIN_OPENIDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length > 0) return allow.includes(openid);

  // 没有白名单时：允许任意已登录用户调用（适合个人项目）
  return true;
  return false;
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
  const shortDesc = typeof body.shortDesc === "string" ? body.shortDesc.trim() : "";
  const ruleText = typeof body.ruleText === "string" ? body.ruleText.trim() : "";
  const creatorId = typeof body.creatorId === "string" ? body.creatorId.trim() : "";
  if (!title || !shortDesc || !ruleText || !creatorId) {
    return json(400, { ok: false, error: "MISSING_FIELDS" });
  }

  const coverUrl =
    typeof body.coverUrl === "string" && body.coverUrl.trim()
      ? body.coverUrl.trim()
      : `/assets/screenshots/${id}.svg`;
  const path =
    typeof body.path === "string" && body.path.trim() ? body.path.trim() : `/games/${id}/`;

  // 校验 creator 是否存在
  const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId)).limit(1);
  if (!creator) return json(400, { ok: false, error: "CREATOR_NOT_FOUND" });

  // upsert：已存在则更新（便于重复生成/覆盖）
  await db
    .insert(games)
    .values({
      id,
      title,
      shortDesc,
      ruleText,
      coverUrl,
      path,
      creatorId,
    })
    // drizzle 的 onConflictDoUpdate 支持在 postgres 上做 upsert
    .onConflictDoUpdate({
      target: games.id,
      set: {
        title,
        shortDesc,
        ruleText,
        coverUrl,
        path,
        creatorId,
        updatedAt: new Date(),
      },
    });

  return json(200, { ok: true, id, path });
}
