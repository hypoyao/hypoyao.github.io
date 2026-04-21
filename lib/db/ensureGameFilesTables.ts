import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

// 已发布游戏的文件表（幂等）
// 目标：所有 /games/<id> 的 html/css/js/meta/prompt 都从数据库读取，不再依赖 public/games 目录。
let _ensured = false;
let _ensuring: Promise<void> | null = null;

export async function ensureGameFilesTables() {
  if (_ensured) return;
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    await db.execute(sql`
      create table if not exists game_files (
        id bigint generated always as identity primary key,
        game_id text not null references games(id) on delete cascade,
        path text not null,
        content text not null,
        updated_at timestamptz not null default now(),
        unique (game_id, path)
      );
    `);
    await db.execute(sql`create index if not exists game_files_game_idx on game_files(game_id);`);
    _ensured = true;
    _ensuring = null;
  })();
  return _ensuring;
}

