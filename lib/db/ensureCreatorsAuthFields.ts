import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 creators 表补齐账号字段 + 个人资料字段与索引（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;
export async function ensureCreatorsAuthFields() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    // creators 表可能在某些环境尚未初始化：这里做一次幂等建表，避免后续查询直接失败
    await db.execute(sql`
      create table if not exists creators (
        id text primary key,
        name text not null,
        avatar_url text not null,
        profile_path text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    await db.execute(sql`alter table creators add column if not exists phone text;`);
    await db.execute(sql`alter table creators add column if not exists openid text;`);
    await db.execute(sql`alter table creators add column if not exists gender text;`);
    await db.execute(sql`alter table creators add column if not exists age int;`);
    await db.execute(sql`alter table creators add column if not exists city text;`);
    await db.execute(sql`create unique index if not exists creators_phone_uidx on creators(phone);`);
    await db.execute(sql`create unique index if not exists creators_openid_uidx on creators(openid);`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
