import crypto from "node:crypto";
import { cookies } from "next/headers";

type SessLike = { phone?: string; openid?: string } | null;

export type CreatorIndexItem = { gameId: string; entry: string; mtimeMs: number; title?: string };

const GUEST_OWNER_COOKIE = "creator_guest_owner_v1";
const GUEST_FP_HEADER = "x-creator-fingerprint";

function hashOwnerId(id: string) {
  const secret = process.env.AUTH_COOKIE_SECRET || "dev";
  return crypto.createHash("sha256").update(id + ":" + secret).digest("hex").slice(0, 24);
}

export function ownerKeyFromSession(sess: SessLike) {
  const id = (sess?.phone || sess?.openid || "").trim();
  if (!id) return "";
  return hashOwnerId(id);
}

function stableHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clientIpFromRequest(req?: Request) {
  if (!req) return "";
  const h = req.headers;
  const raw =
    h.get("x-forwarded-for") ||
    h.get("x-real-ip") ||
    h.get("cf-connecting-ip") ||
    h.get("x-vercel-forwarded-for") ||
    "";
  return String(raw).split(",")[0]?.trim().slice(0, 96) || "";
}

function fingerprintFromRequest(req?: Request) {
  if (!req) return "";
  return String(req.headers.get(GUEST_FP_HEADER) || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 160);
}

export async function ownerKeyFromSessionOrGuest(sess: SessLike, req?: Request) {
  const sessionOwnerKey = ownerKeyFromSession(sess);
  if (sessionOwnerKey) return sessionOwnerKey;

  const jar = await cookies();
  const fp = fingerprintFromRequest(req);
  const ip = clientIpFromRequest(req);
  const deterministicToken = fp ? stableHash(`fp:${fp}:ip:${ip || "unknown"}`).slice(0, 48) : "";
  const existing = String(jar.get(GUEST_OWNER_COOKIE)?.value || "").trim();
  const token = deterministicToken || (/^[a-f0-9]{32,96}$/i.test(existing) ? existing : crypto.randomBytes(24).toString("hex"));
  if (token !== existing) {
    jar.set(GUEST_OWNER_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 180 * 24 * 60 * 60,
    });
  }
  return hashOwnerId(`guest:${token}`);
}

// 旧版本曾用文件存储（data/creator-index.json）做“我的游戏”索引缓存。
// 现在“我的游戏”完全来自数据库 creator_draft_games，因此这里保留兼容导出（不再落盘）。
export async function getCreatorGamesFast(_ownerKey: string): Promise<CreatorIndexItem[] | null> {
  return null;
}
export async function setCreatorGames(_ownerKey: string, _games: CreatorIndexItem[]) {}
export async function upsertCreatorGame(_ownerKey: string, _item: CreatorIndexItem) {}
export async function removeCreatorGame(_ownerKey: string, _gameId: string) {}
