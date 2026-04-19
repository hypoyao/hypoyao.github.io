import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 games 表补齐封面存储字段（幂等）
export async function ensureGamesCoverFields() {
  await db.execute(sql`alter table games add column if not exists cover_mime text;`);
  await db.execute(sql`alter table games add column if not exists cover_data text;`);
}

