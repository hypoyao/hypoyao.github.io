import type { GameWithCreator } from "@/lib/db/queries";

function scoreOf(game: Pick<GameWithCreator, "playCount" | "likeCount">) {
  return {
    play: Number(game.playCount || 0) || 0,
    like: Number(game.likeCount || 0) || 0,
  };
}

export function sortGamesByEngagement<T extends Pick<GameWithCreator, "playCount" | "likeCount">>(games: T[]): T[] {
  return games
    .map((game, index) => ({ game, index }))
    .sort((a, b) => {
      const sa = scoreOf(a.game);
      const sb = scoreOf(b.game);
      return sb.play - sa.play || sb.like - sa.like || a.index - b.index;
    })
    .map((x) => x.game);
}

export function featuredGamesByEngagement<T extends Pick<GameWithCreator, "playCount" | "likeCount">>(games: T[]): T[] {
  const sorted = sortGamesByEngagement(games);
  const played = sorted.filter((game) => scoreOf(game).play > 0);
  return played.length ? played : sorted;
}
