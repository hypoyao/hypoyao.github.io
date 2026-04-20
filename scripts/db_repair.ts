import fs from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, inArray, sql } from "drizzle-orm";
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/**
 * 用法（建议先 dry-run）：
 *   npx tsx scripts/db_repair.ts --dry-run
 *
 * 真正执行：
 *   npx tsx scripts/db_repair.ts
 *
 * 可选参数：
 *   --assign-orphans-to <creatorId>   把“孤儿游戏”（creatorId 不存在）统一改绑到某个 creator
 *   --delete-orphans                 直接删除孤儿游戏（更危险）
 *
 * 默认行为：
 * - 修复所有 creators.profilePath（改成安全 token 路径，避免 URL 暴露手机号/creatorId）
 * - 仅报告孤儿游戏，不会自动处理（除非你显式传参）
 */
async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL in .env.local");

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const deleteOrphans = args.includes("--delete-orphans");
  const assignIdx = args.indexOf("--assign-orphans-to");
  const assignTo = assignIdx >= 0 ? args[assignIdx + 1] : null;

  if (deleteOrphans && assignTo) throw new Error("不要同时使用 --delete-orphans 和 --assign-orphans-to");

  const db = drizzle(neon(url));

  const cs = await db.select({ id: creators.id, profilePath: creators.profilePath }).from(creators);
  const creatorIds = new Set(cs.map((c) => c.id));

  const profileFix = cs
    .map((c) => ({ id: c.id, cur: c.profilePath, want: safeProfilePathForCreatorId(c.id) }))
    .filter((x) => x.cur !== x.want);

  const gs = await db.select({ id: games.id, creatorId: games.creatorId }).from(games);
  const orphanIds = gs.filter((g) => !creatorIds.has(g.creatorId)).map((g) => g.id);

  const plan = {
    dryRun,
    profileFixCount: profileFix.length,
    orphanGamesCount: orphanIds.length,
    willAssignOrphansTo: assignTo || null,
    willDeleteOrphans: deleteOrphans,
  };
  console.log("PLAN:", JSON.stringify(plan, null, 2));

  if (dryRun) return;

  // 1) 修复 profilePath
  for (const it of profileFix) {
    await db.update(creators).set({ profilePath: it.want, updatedAt: new Date() }).where(eq(creators.id, it.id));
  }

  // 2) 处理孤儿游戏（可选）
  if (orphanIds.length > 0) {
    if (assignTo) {
      if (!creatorIds.has(assignTo)) throw new Error(`assign-orphans-to 指定的 creatorId 不存在：${assignTo}`);
      await db.update(games).set({ creatorId: assignTo, updatedAt: new Date() }).where(inArray(games.id, orphanIds));
    } else if (deleteOrphans) {
      await db.delete(games).where(inArray(games.id, orphanIds));
    }
  }

  // 3) 最后做一次 left join 校验
  const left = await db.execute(sql`
    select g.id as game_id, g.creator_id as creator_id
    from games g
    left join creators c on c.id = g.creator_id
    where c.id is null
  `);
  const leftCount = Array.isArray((left as any).rows) ? (left as any).rows.length : 0;
  if (leftCount > 0) {
    throw new Error(`修复后仍存在孤儿游戏（left join count=${leftCount}），请再检查。`);
  }

  console.log("DONE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
