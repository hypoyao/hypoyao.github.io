import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

let _ensured = false;
let _ensuring: Promise<void> | null = null;

export async function ensureGameEngagementTables() {
  if (_ensured) return;
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
    await db.execute(sql`create index if not exists game_play_visitors_game_idx on game_play_visitors(game_id);`);
    await db.execute(sql`create index if not exists game_like_votes_game_idx on game_like_votes(game_id);`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}
