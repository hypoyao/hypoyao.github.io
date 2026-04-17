import { eq } from "drizzle-orm";
import { db } from "./index";
import { creators, games } from "./schema";

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

export async function getCreatorById(creatorId: string) {
  const [row] = await db.select().from(creators).where(eq(creators.id, creatorId)).limit(1);
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

