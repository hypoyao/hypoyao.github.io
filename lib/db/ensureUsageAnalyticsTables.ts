import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

let _ensured = false;
let _ensuring: Promise<void> | null = null;

async function ensureUsageAnalyticsSchemaPatch() {
  await db.execute(sql`alter table creator_chat_messages add column if not exists run_id text;`);
  await db.execute(sql`create index if not exists creator_chat_messages_creator_game_idx on creator_chat_messages(creator_id, game_id, id);`);
  await db.execute(sql`create index if not exists creator_chat_messages_creator_created_idx on creator_chat_messages(creator_id, created_at desc);`);
  await db.execute(sql`create index if not exists creator_chat_messages_game_idx on creator_chat_messages(game_id, id);`);
  await db.execute(sql`create index if not exists creator_chat_messages_created_idx on creator_chat_messages(created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_created_idx on creator_usage_events(created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_creator_idx on creator_usage_events(creator_id, created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_game_idx on creator_usage_events(game_id, created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_type_idx on creator_usage_events(event_type, created_at desc);`);
}

export async function ensureUsageAnalyticsTables() {
  if (_ensured) {
    await ensureUsageAnalyticsSchemaPatch();
    return;
  }
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`
      create table if not exists creator_chat_messages (
        id bigint generated always as identity primary key,
        game_id text not null,
        creator_id text not null references creators(id) on update cascade on delete cascade,
        role text not null,
        content text not null,
        run_id text,
        created_at timestamptz not null default now()
      );
    `);
    await db.execute(sql`
      create table if not exists creator_usage_events (
        id bigint generated always as identity primary key,
        creator_id text references creators(id) on update cascade on delete set null,
        visitor_id text,
        game_id text,
        event_type text not null,
        detail text,
        created_at timestamptz not null default now()
      );
    `);
    await ensureUsageAnalyticsSchemaPatch();
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
