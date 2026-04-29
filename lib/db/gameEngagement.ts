import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { ensureGameEngagementTables } from "@/lib/db/ensureGameEngagementTables";

export type GameEngagement = {
  playCount: number;
  likeCount: number;
  liked: boolean;
};

function toNum(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function ensureGameEngagementReady() {
  await ensureGamesCoverFields();
  await ensureGameEngagementTables();
}

export async function gameExists(gameId: string) {
  if (!gameId) return false;
  await ensureGamesCoverFields();
  const rows = await db.execute(sql`
    select 1
    from games
    where id = ${gameId}
    limit 1
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  return !!list.length;
}

export async function getGameEngagement(gameId: string, visitorId?: string | null): Promise<GameEngagement> {
  if (!gameId) return { playCount: 0, likeCount: 0, liked: false };
  await ensureGameEngagementReady();
  const rows = await db.execute(sql`
    select
      (select count(*)::int from game_play_events where game_id = ${gameId}) as play_count,
      (select count(*)::int from game_like_votes where game_id = ${gameId}) as like_count,
      ${
        visitorId
          ? sql`exists(select 1 from game_like_votes where game_id = ${gameId} and visitor_id = ${visitorId})`
          : sql`false`
      } as liked
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const row = (list?.[0] || {}) as Record<string, unknown>;
  return {
    playCount: toNum(row.play_count),
    likeCount: toNum(row.like_count),
    liked: !!row.liked,
  };
}

export async function recordGameView(gameId: string, visitorId: string) {
  if (!gameId) return getGameEngagement(gameId, visitorId);
  await ensureGameEngagementReady();
  await db.execute(sql`
    insert into game_play_events (game_id, visitor_id)
    values (${gameId}, ${visitorId || null})
  `);
  return getGameEngagement(gameId, visitorId);
}

export async function toggleGameLike(gameId: string, visitorId: string) {
  if (!gameId || !visitorId) return getGameEngagement(gameId, visitorId);
  await ensureGameEngagementReady();
  const existedRows = await db.execute(sql`
    select 1
    from game_like_votes
    where game_id = ${gameId} and visitor_id = ${visitorId}
    limit 1
  `);
  const existed = Array.isArray((existedRows as any).rows) && (existedRows as any).rows.length > 0;
  if (existed) {
    await db.execute(sql`
      delete from game_like_votes
      where game_id = ${gameId} and visitor_id = ${visitorId}
    `);
  } else {
    await db.execute(sql`
      insert into game_like_votes (game_id, visitor_id)
      values (${gameId}, ${visitorId})
      on conflict (game_id, visitor_id) do nothing
    `);
  }
  return getGameEngagement(gameId, visitorId);
}
