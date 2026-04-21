import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 games 表补齐封面存储字段（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;
export async function ensureGamesCoverFields() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    // games 表可能在某些环境尚未初始化：这里做一次幂等建表
    await db.execute(sql`
      create table if not exists games (
        id text primary key,
        title text not null,
        short_desc text not null,
        rule_text text not null,
        cover_url text not null,
        cover_mime text,
        cover_data text,
        path text not null unique,
        creator_id text not null references creators(id) on update cascade on delete restrict,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await db.execute(sql`alter table games add column if not exists cover_mime text;`);
    await db.execute(sql`alter table games add column if not exists cover_data text;`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
