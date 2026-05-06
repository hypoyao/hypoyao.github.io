import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

let _ensured = false;
let _ensuring: Promise<void> | null = null;

async function ensureUsageAnalyticsSchemaPatch() {
  await db.execute(sql`alter table creator_chat_messages alter column creator_id drop not null;`);
  await db.execute(sql`alter table creator_chat_messages add column if not exists run_id text;`);
  await db.execute(sql`alter table creator_chat_messages add column if not exists owner_key text;`);
  await db.execute(sql`alter table creator_chat_messages add column if not exists visitor_id text;`);
  await db.execute(sql`alter table creator_chat_messages add column if not exists actor_type text;`);
  await db.execute(sql`create index if not exists creator_chat_messages_creator_game_idx on creator_chat_messages(creator_id, game_id, id);`);
  await db.execute(sql`create index if not exists creator_chat_messages_creator_created_idx on creator_chat_messages(creator_id, created_at desc);`);
  await db.execute(sql`create index if not exists creator_chat_messages_owner_game_idx on creator_chat_messages(owner_key, game_id, id);`);
  await db.execute(sql`create index if not exists creator_chat_messages_owner_created_idx on creator_chat_messages(owner_key, created_at desc);`);
  await db.execute(sql`create index if not exists creator_chat_messages_visitor_created_idx on creator_chat_messages(visitor_id, created_at desc);`);
  await db.execute(sql`create index if not exists creator_chat_messages_game_idx on creator_chat_messages(game_id, id);`);
  await db.execute(sql`create index if not exists creator_chat_messages_created_idx on creator_chat_messages(created_at desc);`);
  await db.execute(sql`alter table creator_usage_events add column if not exists owner_key text;`);
  await db.execute(sql`alter table creator_usage_events add column if not exists actor_type text;`);
  await db.execute(sql`create index if not exists creator_usage_events_created_idx on creator_usage_events(created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_creator_idx on creator_usage_events(creator_id, created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_owner_idx on creator_usage_events(owner_key, created_at desc);`);
  await db.execute(sql`create index if not exists creator_usage_events_visitor_idx on creator_usage_events(visitor_id, created_at desc);`);
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
        creator_id text references creators(id) on update cascade on delete cascade,
        owner_key text,
        visitor_id text,
        actor_type text,
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
        owner_key text,
        visitor_id text,
        actor_type text,
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
