import crypto from "node:crypto";

type SessLike = { phone?: string; openid?: string } | null;

export type CreatorIndexItem = { gameId: string; entry: string; mtimeMs: number; title?: string };

export function ownerKeyFromSession(sess: SessLike) {
  const id = (sess?.phone || sess?.openid || "").trim();
  const secret = process.env.AUTH_COOKIE_SECRET || "dev";
  if (!id) return "";
  return crypto.createHash("sha256").update(id + ":" + secret).digest("hex").slice(0, 24);
}

// 旧版本曾用文件存储（data/creator-index.json）做“我的游戏”索引缓存。
// 现在“我的游戏”完全来自数据库 creator_draft_games，因此这里保留兼容导出（不再落盘）。
export async function getCreatorGamesFast(_ownerKey: string): Promise<CreatorIndexItem[] | null> {
  return null;
}
export async function setCreatorGames(_ownerKey: string, _games: CreatorIndexItem[]) {}
export async function upsertCreatorGame(_ownerKey: string, _item: CreatorIndexItem) {}
export async function removeCreatorGame(_ownerKey: string, _gameId: string) {}
