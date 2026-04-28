import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { gameExists, getGameEngagement, recordGameView, toggleGameLike } from "@/lib/db/gameEngagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VISITOR_COOKIE = "xq_game_visitor";
const ONE_YEAR = 60 * 60 * 24 * 365;

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeGameId(id: string) {
  const raw = String(id || "").trim();
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : "";
}

function parseVisitorId(raw: string | undefined | null) {
  const s = String(raw || "").trim();
  return /^[a-zA-Z0-9_-]{16,128}$/.test(s) ? s : "";
}

function issueVisitorId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function withVisitorCookie(res: NextResponse, visitorId: string) {
  if (!visitorId) return res;
  res.cookies.set(VISITOR_COOKIE, visitorId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  });
  return res;
}

function getOrCreateVisitorId(req: Request) {
  const cookieHeader = req.headers.get("cookie") || "";
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE}=([^;]+)`));
  const existing = parseVisitorId(m?.[1] ? decodeURIComponent(m[1]) : "");
  if (existing) return { visitorId: existing, fresh: false };
  return { visitorId: issueVisitorId(), fresh: true };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const gameId = normalizeGameId(url.searchParams.get("gameId") || "");
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });
  if (!(await gameExists(gameId))) return json(404, { ok: false, error: "GAME_NOT_FOUND" });

  const { visitorId, fresh } = getOrCreateVisitorId(req);
  const stats = await getGameEngagement(gameId, visitorId);
  const res = json(200, { ok: true, gameId, ...stats });
  return fresh ? withVisitorCookie(res, visitorId) : res;
}

export async function POST(req: Request) {
  let body: { gameId?: string; action?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const gameId = normalizeGameId(body?.gameId || "");
  const action = String(body?.action || "").trim();
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });
  if (action !== "view" && action !== "toggle_like") return json(400, { ok: false, error: "INVALID_ACTION" });
  if (!(await gameExists(gameId))) return json(404, { ok: false, error: "GAME_NOT_FOUND" });

  const { visitorId, fresh } = getOrCreateVisitorId(req);
  const stats = action === "view" ? await recordGameView(gameId, visitorId) : await toggleGameLike(gameId, visitorId);
  const res = json(200, { ok: true, gameId, ...stats });
  return fresh ? withVisitorCookie(res, visitorId) : res;
}
