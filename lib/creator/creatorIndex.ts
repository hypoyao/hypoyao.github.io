import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

type SessLike = { phone?: string; openid?: string } | null;

export type CreatorIndexItem = { gameId: string; entry: string; mtimeMs: number; title?: string };

type Store = {
  v: number;
  owners: Record<string, { games: CreatorIndexItem[]; updatedAt: number; complete: boolean }>;
};

// v2: 增加 complete 标记，避免只靠 upsert 形成“残缺列表”
const STORE_VER = 2;

function storePath() {
  return path.join(process.cwd(), "data", "creator-index.json");
}

async function ensureDir() {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
}

export function ownerKeyFromSession(sess: SessLike) {
  const id = (sess?.phone || sess?.openid || "").trim();
  const secret = process.env.AUTH_COOKIE_SECRET || "dev";
  if (!id) return "";
  return crypto.createHash("sha256").update(id + ":" + secret).digest("hex").slice(0, 24);
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const j = JSON.parse(raw);
    // 兼容 v1：没有 complete 字段 -> 视为未完整构建，触发一次扫盘回填
    if (j?.v === 1 && typeof j?.owners === "object") {
      const owners: any = {};
      for (const [k, v] of Object.entries<any>(j.owners || {})) {
        owners[k] = { games: Array.isArray(v?.games) ? v.games : [], updatedAt: Number(v?.updatedAt || 0), complete: false };
      }
      return { v: STORE_VER, owners };
    }
    if (j?.v !== STORE_VER || typeof j?.owners !== "object") throw new Error("BAD_STORE");
    return j as Store;
  } catch {
    return { v: STORE_VER, owners: {} };
  }
}

async function writeStore(s: Store) {
  await ensureDir();
  await fs.writeFile(storePath(), JSON.stringify(s, null, 2), "utf8");
}

export async function getCreatorGamesFast(ownerKey: string): Promise<CreatorIndexItem[] | null> {
  if (!ownerKey) return null;
  const s = await readStore();
  const block = s.owners[ownerKey];
  if (!block?.games) return null;
  // 只有 complete 的索引才可作为“权威列表”；否则会导致历史游戏“消失”
  if (!block.complete) return null;
  return Array.isArray(block.games) ? block.games : null;
}

export async function setCreatorGames(ownerKey: string, games: CreatorIndexItem[]) {
  if (!ownerKey) return;
  const s = await readStore();
  const list = Array.isArray(games) ? games.slice() : [];
  list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  s.owners[ownerKey] = { games: list, updatedAt: Date.now(), complete: true };
  await writeStore(s);
}

export async function upsertCreatorGame(ownerKey: string, item: CreatorIndexItem) {
  if (!ownerKey) return;
  const s = await readStore();
  const cur = s.owners[ownerKey] || { games: [], updatedAt: Date.now(), complete: false };
  const games = Array.isArray(cur.games) ? cur.games.slice() : [];
  const i = games.findIndex((x) => x?.gameId === item.gameId);
  if (i >= 0) games[i] = { ...games[i], ...item };
  else games.push(item);
  // 最新的排前面
  games.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  // 注意：upsert 不能把 complete 置为 true（否则历史列表可能不全）
  s.owners[ownerKey] = { games, updatedAt: Date.now(), complete: !!cur.complete };
  await writeStore(s);
}

export async function removeCreatorGame(ownerKey: string, gameId: string) {
  if (!ownerKey) return;
  const gid = String(gameId || "").trim();
  if (!gid) return;
  const s = await readStore();
  const cur = s.owners[ownerKey];
  if (!cur?.games) return;
  const games = cur.games.filter((x) => x?.gameId !== gid);
  s.owners[ownerKey] = { games, updatedAt: Date.now(), complete: !!cur.complete };
  await writeStore(s);
}
