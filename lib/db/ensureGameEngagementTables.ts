import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

let _ensured = false;
let _ensuring: Promise<void> | null = null;

async function ensureGameEngagementSchemaPatch() {
  await db.execute(sql`alter table game_play_events add column if not exists visitor_id text;`);
  await db.execute(sql`alter table game_play_events add column if not exists creator_id text;`);
  await db.execute(sql`alter table game_play_events add column if not exists source_key text;`);
  await db.execute(sql`alter table game_play_events add column if not exists created_at timestamptz not null default now();`);
  await db.execute(sql`create index if not exists game_play_visitors_game_idx on game_play_visitors(game_id);`);
  await db.execute(sql`create index if not exists game_like_votes_game_idx on game_like_votes(game_id);`);
  await db.execute(sql`create index if not exists game_play_events_game_idx on game_play_events(game_id);`);
  await db.execute(sql`create index if not exists game_play_events_creator_idx on game_play_events(creator_id, created_at desc);`);
  await db.execute(sql`create unique index if not exists game_play_events_source_key_uidx on game_play_events(source_key);`);
}

export async function ensureGameEngagementTables() {
  if (_ensured) {
    // 代码热更新/滚动发布时，旧进程可能已经把 ensure 标记为完成。
    // 仍然轻量补一次新列/索引，避免看板先引用新列导致页面挂掉。
    await ensureGameEngagementSchemaPatch();
    return;
  }
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`
      create table if not exists game_play_visitors (
        game_id text not null references games(id) on delete cascade,
        visitor_id text not null,
        first_played_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (game_id, visitor_id)
      );
    `);
    await db.execute(sql`
      create table if not exists game_like_votes (
        game_id text not null references games(id) on delete cascade,
        visitor_id text not null,
        created_at timestamptz not null default now(),
        primary key (game_id, visitor_id)
      );
    `);
    await db.execute(sql`
      create table if not exists game_play_events (
        id bigint generated always as identity primary key,
        game_id text not null references games(id) on delete cascade,
        visitor_id text,
        source_key text,
        created_at timestamptz not null default now()
      );
    `);
    await ensureGameEngagementSchemaPatch();
    // 历史兼容：把“去重访客”迁成至少 1 次播放事件，避免切换统计口径后老数据清零。
    await db.execute(sql`
      insert into game_play_events (game_id, visitor_id, source_key, created_at)
      select
        game_id,
        visitor_id,
        'legacy:' || game_id || ':' || visitor_id as source_key,
        coalesce(first_played_at, updated_at, now()) as created_at
      from game_play_visitors
      on conflict (source_key) do nothing
    `);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
