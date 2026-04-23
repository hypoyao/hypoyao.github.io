import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// create 页“草稿游戏”（未发布也可预览）的存储表（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;

export async function ensureCreatorDraftTables(force = false) {
  if (!force && _ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    // 1) 基础表：首次安装时直接创建
    await db.execute(sql`
      create table if not exists creator_draft_games (
        id text primary key,
        owner_key text not null,
        title text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);

    // 2) 兼容旧表结构（曾经缺列）：create table if not exists 不会补列，所以必须做幂等迁移
    // 注意：这里用 add column if not exists，确保多次调用安全
    await db.execute(sql`alter table creator_draft_games add column if not exists owner_key text not null default '';`);
    await db.execute(sql`alter table creator_draft_games add column if not exists title text not null default '';`);
    await db.execute(sql`alter table creator_draft_games add column if not exists created_at timestamptz not null default now();`);
    await db.execute(sql`alter table creator_draft_games add column if not exists updated_at timestamptz not null default now();`);

    await db.execute(sql`create index if not exists creator_draft_games_owner_idx on creator_draft_games(owner_key);`);
    await db.execute(sql`create index if not exists creator_draft_games_updated_idx on creator_draft_games(updated_at);`);

    await db.execute(sql`
      create table if not exists creator_draft_files (
        id bigint generated always as identity primary key,
        game_id text not null references creator_draft_games(id) on delete cascade,
        path text not null,
        content text not null,
        updated_at timestamptz not null default now(),
        unique (game_id, path)
      );
    `);

    // 同样补齐旧表可能缺失的列
    await db.execute(sql`alter table creator_draft_files add column if not exists updated_at timestamptz not null default now();`);

    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
