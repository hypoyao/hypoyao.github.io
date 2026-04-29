import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 games 表补齐封面存储字段（幂等）
const ENSURE_GAMES_COVER_STATE_KEY = "__gamesCoverFieldsEnsureState__";

function ensureState() {
  const g = globalThis as any;
  if (!g[ENSURE_GAMES_COVER_STATE_KEY]) {
    g[ENSURE_GAMES_COVER_STATE_KEY] = { ensured: false, ensuring: null as Promise<void> | null };
  }
  return g[ENSURE_GAMES_COVER_STATE_KEY] as { ensured: boolean; ensuring: Promise<void> | null };
}

export async function ensureGamesCoverFields() {
  const state = ensureState();
  if (state.ensured) return;
  if (state.ensuring) return state.ensuring;
  state.ensuring = (async () => {
    // games 表可能在某些环境尚未初始化：这里做一次幂等建表
    await db.execute(sql`
      create table if not exists games (
        id text primary key,
        source_draft_id text,
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
    await db.execute(sql`alter table games add column if not exists source_draft_id text;`);
    await db.execute(sql`alter table games add column if not exists cover_mime text;`);
    await db.execute(sql`alter table games add column if not exists cover_data text;`);
    await db.execute(sql`create index if not exists games_source_draft_idx on games(source_draft_id);`);
    state.ensured = true;
    state.ensuring = null;
  })();
  return state.ensuring;
}
