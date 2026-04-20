import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 给 creator_user_messages 表建表（幂等）
let _ensured = false;
let _ensuring: Promise<void> | null = null;

export async function ensureCreatorUserMessagesTable() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`
      create table if not exists creator_user_messages (
        id int generated always as identity primary key,
        game_id text not null,
        creator_id text not null references creators(id) on update cascade on delete cascade,
        content text not null,
        created_at timestamptz not null default now()
      );
    `);
    await db.execute(sql`create index if not exists idx_creator_user_messages_gc on creator_user_messages(creator_id, game_id, id);`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}

