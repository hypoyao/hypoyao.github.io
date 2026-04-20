import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 games 表补齐封面存储字段（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;
export async function ensureGamesCoverFields() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`alter table games add column if not exists cover_mime text;`);
    await db.execute(sql`alter table games add column if not exists cover_data text;`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
