import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// create 页“草稿游戏”（未发布也可预览）的存储表（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;

export async function ensureCreatorDraftTables() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`
      create table if not exists creator_draft_games (
        id text primary key,
        owner_key text not null,
        title text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
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

    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}

