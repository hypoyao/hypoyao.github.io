import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const key = (process.env.ADMIN_API_KEY || "").trim();
  const auth = (req.headers.get("authorization") || "").trim();
  if (!key || auth !== `Bearer ${key}`) return json(401, { ok: false, error: "UNAUTHORIZED" });

  const url = new URL(req.url);
  const creatorIdRaw = (url.searchParams.get("creatorId") || "").trim();
  const profileToken = (url.searchParams.get("profileToken") || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const profilePathRaw = (url.searchParams.get("profilePath") || "").trim();
  if (!creatorIdRaw && !profileToken && !profilePathRaw) {
    return json(400, { ok: false, error: "MISSING_CREATOR_ID", hint: "传 creatorId 或 profileToken 或 profilePath" });
  }

  const dryRun = url.searchParams.get("dryRun") === "1";

  // 允许用 profilePath/profileToken 定位 creatorId（因为你现在访问的是安全链接 /creators/p_xxx）
  let creatorId = creatorIdRaw;
  if (!creatorId) {
    const candidates: string[] = [];
    if (profilePathRaw) candidates.push(profilePathRaw);
    if (profileToken) {
      candidates.push(`/creators/${profileToken}`);
      candidates.push(`/creators/${profileToken}/`);
    }
    for (const p of candidates) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.profilePath, p)).limit(1);
      if (row?.id) {
        creatorId = row.id;
        break;
      }
    }
  }
  if (!creatorId) return json(404, { ok: false, error: "CREATOR_NOT_FOUND_BY_PROFILE" });

  const [c] = await db.select({ id: creators.id, name: creators.name, profilePath: creators.profilePath }).from(creators).where(eq(creators.id, creatorId)).limit(1);
  if (!c) return json(404, { ok: false, error: "CREATOR_NOT_FOUND" });

  const rows = await db.execute(sql`
    select id
    from games
    where creator_id = ${creatorId}
    order by updated_at desc
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const gameIds = list.map((r: any) => String(r?.id || "")).filter(Boolean);

  if (dryRun) {
    return json(200, { ok: true, dryRun: true, creatorId, creator: c, count: gameIds.length, gameIds });
  }

  let deleted: string[] = [];
  try {
    const del = await db.execute(sql`
      delete from games
      where creator_id = ${creatorId}
      returning id
    `);
    const delRows = Array.isArray((del as any).rows) ? (del as any).rows : [];
    deleted = delRows.map((r: any) => String(r?.id || "")).filter(Boolean);
  } catch (e: any) {
    return json(500, { ok: false, error: "DELETE_FAILED", message: String(e?.message || e), creatorId, creator: c });
  }

  // game_files 通过外键 on delete cascade 自动清理
  return json(200, { ok: true, dryRun: false, creatorId, creator: c, deletedCount: deleted.length, deletedIds: deleted });
}
