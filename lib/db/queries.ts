import { eq } from "drizzle-orm";
import { db } from "./index";
import { creators, games } from "./schema";
import { unstable_cache } from "next/cache";

export type GameWithCreator = {
  id: string;
  title: string;
  shortDesc: string;
  ruleText: string;
  prompt?: string | null; // 已不再用于首页展示；保留字段兼容旧代码
  coverUrl: string;
  path: string;
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
        gameId: string;
        title: string;
        shortDesc: string;
        ruleText: string;
        coverUrl: string;
        path: string;
        creatorId: string;
        creatorName: string;
        creatorAvatarUrl: string;
        creatorProfilePath: string;
      }>
    | null = null;
  try {
    rows = await db
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
        creatorProfilePath: creators.profilePath,
      })
      .from(games)
      .innerJoin(creators, eq(games.creatorId, creators.id));
  } catch {
    return [];
  }

  if (!rows.length) return [];

  return (rows || []).map((r) => ({
    id: r.gameId,
    title: r.title,
    shortDesc: r.shortDesc,
    ruleText: r.ruleText,
    prompt: null,
    coverUrl: r.coverUrl,
    path: r.path,
    creator: {
      id: r.creatorId,
      name: r.creatorName,
      avatarUrl: r.creatorAvatarUrl,
      profilePath: r.creatorProfilePath,
    },
  })) satisfies GameWithCreator[];
}

const listGamesCached = unstable_cache(
  async () => {
    return await listGamesUncached();
  },
  ["listGames:v2"],
  // CDN / Serverless 缓存 5 分钟：保证首页秒开，同时允许内容定期刷新
  { revalidate: 300 },
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
        gameId: string;
        title: string;
        shortDesc: string;
        ruleText: string;
        coverUrl: string;
        path: string;
        creatorId: string;
        creatorName: string;
        creatorAvatarUrl: string;
        creatorProfilePath: string;
      }>
    | null = null;
  try {
    rows = await db
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
        creatorProfilePath: creators.profilePath,
      })
      .from(games)
      .innerJoin(creators, eq(games.creatorId, creators.id))
      .where(eq(games.creatorId, creatorId));
  } catch {
    return [];
  }

  return (rows || []).map((r) => ({
    id: r.gameId,
    title: r.title,
    shortDesc: r.shortDesc,
    ruleText: r.ruleText,
    prompt: null,
    coverUrl: r.coverUrl,
    path: r.path,
    creator: {
      id: r.creatorId,
      name: r.creatorName,
      avatarUrl: r.creatorAvatarUrl,
      profilePath: r.creatorProfilePath,
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
