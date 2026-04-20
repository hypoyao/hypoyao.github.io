import fs from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import { creators, games } from "../lib/db/schema";
import { safeProfilePathForCreatorId } from "../lib/creatorProfilePath";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const s = fs.readFileSync(p, "utf8");
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    // 去掉引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/**
 * 用法：
 *   npx tsx scripts/db_inspect.ts
 *
 * 说明：
 * - 会读取 .env.local 里的 DATABASE_URL
 * - 只输出统计信息 + 少量字段，方便你贴给我看（不会输出密钥）
 */
async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL in .env.local");

  const db = drizzle(neon(url));

  const cs = await db
    .select({
      id: creators.id,
      name: creators.name,
      phone: creators.phone,
      profilePath: creators.profilePath,
    })
    .from(creators);

  const gs = await db
    .select({
      id: games.id,
      title: games.title,
      creatorId: games.creatorId,
      path: games.path,
    })
    .from(games);

  const creatorIds = new Set(cs.map((c) => c.id));
  const orphans = gs.filter((g) => !creatorIds.has(g.creatorId));
  const needProfileFix = cs
    .map((c) => ({ id: c.id, cur: c.profilePath, want: safeProfilePathForCreatorId(c.id) }))
    .filter((x) => x.cur !== x.want);

  // 二次验证（LEFT JOIN）
  const left = await db.execute(sql`
    select g.id as game_id, g.creator_id as creator_id
    from games g
    left join creators c on c.id = g.creator_id
    where c.id is null
  `);

  console.log(
    JSON.stringify(
      {
        creatorsCount: cs.length,
        creators: cs.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone ? `***${c.phone.slice(-4)}` : null,
          profilePath: c.profilePath,
        })),
        gamesCount: gs.length,
        orphanGamesCount: orphans.length,
        orphanGames: orphans.map((g) => ({ id: g.id, title: g.title, creatorId: g.creatorId, path: g.path })),
        orphanByLeftJoinCount: Array.isArray((left as any).rows) ? (left as any).rows.length : undefined,
        profilePathNeedFixCount: needProfileFix.length,
        profilePathNeedFix: needProfileFix,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
