import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const key = (process.env.ADMIN_API_KEY || "").trim();
  const auth = (req.headers.get("authorization") || "").trim();
  if (!key || auth !== `Bearer ${key}`) return json(401, { ok: false, error: "UNAUTHORIZED" });

  const url = new URL(req.url);
  const required = (url.searchParams.get("required") || "index.html,meta.json")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  await ensureGameFilesTables();

  // 对每个 games.id 检查 required 文件是否都存在于 game_files
  const rows = await db.execute(sql`
    select g.id as game_id,
           array_agg(distinct gf.path) filter (where gf.path is not null) as paths
    from games g
    left join game_files gf on gf.game_id = g.id
    group by g.id
    order by g.id asc
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const missing: Array<{ gameId: string; missing: string[]; has: string[] }> = [];

  for (const r of list) {
    const gid = String((r as any).game_id || "");
    const paths = Array.isArray((r as any).paths) ? (r as any).paths.map((x: any) => String(x)) : [];
    const miss = required.filter((p) => !paths.includes(p));
    if (miss.length) missing.push({ gameId: gid, missing: miss, has: paths });
  }

  return json(200, { ok: true, required, total: list.length, missingCount: missing.length, missing });
}

