import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 invite_codes 表建表（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;

export async function ensureInviteCodesTable() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`
      create table if not exists invite_codes (
        code text primary key,
        enabled boolean not null default true,
        max_uses int not null default 1,
        used_count int not null default 0,
        note text,
        last_used_phone text,
        last_used_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    // 强制单次使用：旧数据如果 max_uses 不是 1，统一改成 1（幂等）
    await db.execute(sql`update invite_codes set max_uses = 1 where max_uses is distinct from 1;`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
