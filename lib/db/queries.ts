import { eq, sql } from "drizzle-orm";
import { db } from "./index";
import { creators } from "./schema";
import { unstable_cache } from "next/cache";
import { ensureGameEngagementTables } from "./ensureGameEngagementTables";

export type GameWithCreator = {
  id: string;
  title: string;
  shortDesc: string;
  ruleText: string;
  prompt?: string | null; // 已不再用于首页展示；保留字段兼容旧代码
  coverUrl: string;
  path: string;
  playCount: number;
  likeCount: number;
  creator: {
    id: string;
    name: string;
    avatarUrl: string;
    profilePath: string;
  };
};

async function listGamesUncached(): Promise<GameWithCreator[]> {
  let rows:
    | Array<{
        game_id: string;
        title: string;
        short_desc: string;
        rule_text: string;
        cover_url: string;
        path: string;
        play_count: number | string;
        like_count: number | string;
        creator_id: string;
        creator_name: string;
        creator_avatar_url: string;
        creator_profile_path: string;
      }>
    | null = null;
  try {
    await ensureGameEngagementTables();
    const res = await db.execute(sql`
      select
        g.id as game_id,
        g.title,
        g.short_desc,
        g.rule_text,
        g.cover_url,
        g.path,
        coalesce(v.play_count, 0)::int as play_count,
        coalesce(l.like_count, 0)::int as like_count,
        c.id as creator_id,
        c.name as creator_name,
        c.avatar_url as creator_avatar_url,
        c.profile_path as creator_profile_path
      from games g
      inner join creators c on c.id = g.creator_id
      left join (
        select game_id, count(*)::int as play_count
        from game_play_visitors
        group by game_id
      ) v on v.game_id = g.id
      left join (
        select game_id, count(*)::int as like_count
        from game_like_votes
        group by game_id
      ) l on l.game_id = g.id
      order by g.updated_at desc, g.created_at desc
    `);
    rows = (Array.isArray((res as any).rows) ? (res as any).rows : []) as any;
  } catch {
    return [];
  }

  if (!rows || !rows.length) return [];

  return (rows || []).map((r) => ({
    id: r.game_id,
    title: r.title,
    shortDesc: r.short_desc,
    ruleText: r.rule_text,
    prompt: null,
    coverUrl: r.cover_url,
    path: r.path,
    playCount: Number(r.play_count || 0) || 0,
    likeCount: Number(r.like_count || 0) || 0,
    creator: {
      id: r.creator_id,
      name: r.creator_name,
      avatarUrl: r.creator_avatar_url,
      profilePath: r.creator_profile_path,
    },
  })) satisfies GameWithCreator[];
}

const listGamesCached = unstable_cache(
  async () => {
    return await listGamesUncached();
  },
  ["listGames:v2"],
  // 缓存 1 分钟：兼顾首页秒开和浏览/点赞统计的可见时效。
  { revalidate: 60 },
);

export async function listGames(): Promise<GameWithCreator[]> {
  return await listGamesCached();
}

export async function getCreatorById(creatorId: string) {
  const [row] = await db.select().from(creators).where(eq(creators.id, creatorId)).limit(1);
  return row ?? null;
}

export async function getCreatorByProfilePath(profilePath: string) {
  const [row] = await db.select().from(creators).where(eq(creators.profilePath, profilePath)).limit(1);
  return row ?? null;
}

export async function listGamesByCreator(creatorId: string): Promise<GameWithCreator[]> {
  let rows:
    | Array<{
        game_id: string;
        title: string;
        short_desc: string;
        rule_text: string;
        cover_url: string;
        path: string;
        play_count: number | string;
        like_count: number | string;
        creator_id: string;
        creator_name: string;
        creator_avatar_url: string;
        creator_profile_path: string;
      }>
    | null = null;
  try {
    await ensureGameEngagementTables();
    const res = await db.execute(sql`
      select
        g.id as game_id,
        g.title,
        g.short_desc,
        g.rule_text,
        g.cover_url,
        g.path,
        coalesce(v.play_count, 0)::int as play_count,
        coalesce(l.like_count, 0)::int as like_count,
        c.id as creator_id,
        c.name as creator_name,
        c.avatar_url as creator_avatar_url,
        c.profile_path as creator_profile_path
      from games g
      inner join creators c on c.id = g.creator_id
      left join (
        select game_id, count(*)::int as play_count
        from game_play_visitors
        group by game_id
      ) v on v.game_id = g.id
      left join (
        select game_id, count(*)::int as like_count
        from game_like_votes
        group by game_id
      ) l on l.game_id = g.id
      where g.creator_id = ${creatorId}
      order by g.updated_at desc, g.created_at desc
    `);
    rows = (Array.isArray((res as any).rows) ? (res as any).rows : []) as any;
  } catch {
    return [];
  }

  if (!rows || !rows.length) return [];

  return rows.map((r) => ({
    id: r.game_id,
    title: r.title,
    shortDesc: r.short_desc,
    ruleText: r.rule_text,
    prompt: null,
    coverUrl: r.cover_url,
    path: r.path,
    playCount: Number(r.play_count || 0) || 0,
    likeCount: Number(r.like_count || 0) || 0,
    creator: {
      id: r.creator_id,
      name: r.creator_name,
      avatarUrl: r.creator_avatar_url,
      profilePath: r.creator_profile_path,
    },
  })) satisfies GameWithCreator[];
}

// ===== legacy exports（下方旧实现已移动到上面并增强为“与本地游戏页同步”）=====
// 保留文件结构，避免其它文件 import 位置发生冲突
/*
export async function listGames(): Promise<GameWithCreator[]> {
  const rows = await db
    .select({
      gameId: games.id,
      title: games.title,
      shortDesc: games.shortDesc,
      ruleText: games.ruleText,
      coverUrl: games.coverUrl,
      path: games.path,
      creatorId: creators.id,
      creatorName: creators.name,
      creatorAvatarUrl: creators.avatarUrl,
    })
    .from(games)
    .innerJoin(creators, eq(games.creatorId, creators.id));

  return rows.map((r) => ({
    id: r.gameId,
    title: r.title,
    shortDesc: r.shortDesc,
    ruleText: r.ruleText,
    coverUrl: r.coverUrl,
    path: r.path,
    creator: {
      id: r.creatorId,
      name: r.creatorName,
      avatarUrl: r.creatorAvatarUrl,
    },
  }));
}
*/
