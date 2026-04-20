import { eq } from "drizzle-orm";
import { db } from "./index";
import { creators, games } from "./schema";
import fs from "node:fs/promises";
import path from "node:path";

export type GameWithCreator = {
  id: string;
  title: string;
  shortDesc: string;
  ruleText: string;
  coverUrl: string;
  path: string;
  creator: {
    id: string;
    name: string;
    avatarUrl: string;
  };
};

async function tryGetLocalTitle(gameId: string) {
  try {
    const p = path.join(process.cwd(), "public", "games", gameId, "index.html");
    const html = await fs.readFile(p, "utf-8");
    const m = html.match(/<title>([^<]{1,80})<\/title>/i);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

async function hasLocalPngCover(gameId: string) {
  try {
    const p = path.join(process.cwd(), "public", "assets", "screenshots", `${gameId}.png`);
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

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

  const out = await Promise.all(
    rows.map(async (r) => {
      const localTitle = await tryGetLocalTitle(r.gameId);
      const useTitle = localTitle || r.title;

      let useCover = r.coverUrl;
      if (await hasLocalPngCover(r.gameId)) useCover = `/assets/screenshots/${r.gameId}.png`;

      return {
        id: r.gameId,
        title: useTitle,
        shortDesc: r.shortDesc,
        ruleText: r.ruleText,
        coverUrl: useCover,
        path: r.path,
        creator: {
          id: r.creatorId,
          name: r.creatorName,
          avatarUrl: r.creatorAvatarUrl,
        },
      } satisfies GameWithCreator;
    }),
  );

  return out;
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
    .innerJoin(creators, eq(games.creatorId, creators.id))
    .where(eq(games.creatorId, creatorId));

  const out = await Promise.all(
    rows.map(async (r) => {
      const localTitle = await tryGetLocalTitle(r.gameId);
      const useTitle = localTitle || r.title;

      let useCover = r.coverUrl;
      if (await hasLocalPngCover(r.gameId)) useCover = `/assets/screenshots/${r.gameId}.png`;

      return {
        id: r.gameId,
        title: useTitle,
        shortDesc: r.shortDesc,
        ruleText: r.ruleText,
        coverUrl: useCover,
        path: r.path,
        creator: {
          id: r.creatorId,
          name: r.creatorName,
          avatarUrl: r.creatorAvatarUrl,
        },
      } satisfies GameWithCreator;
    }),
  );

  return out;
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
