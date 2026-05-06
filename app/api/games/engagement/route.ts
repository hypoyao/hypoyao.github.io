import { NextResponse } from "next/server";
import { getCurrentCreatorId } from "@/lib/auth/currentCreator";
import { getSession } from "@/lib/auth/session";
import { creatorActorFromSessionOrGuest } from "@/lib/creator/creatorIndex";
import { getOrCreateCreatorIdForActor } from "@/lib/creator/actorCreator";
import { gameExists, getGameEngagement, recordGameView, toggleGameLike } from "@/lib/db/gameEngagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeGameId(id: string) {
  const raw = String(id || "").trim();
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : "";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const gameId = normalizeGameId(url.searchParams.get("gameId") || "");
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });
  if (!(await gameExists(gameId))) return json(404, { ok: false, error: "GAME_NOT_FOUND" });

  const actor = await creatorActorFromSessionOrGuest(await getSession(), req);
  const visitorId = actor.ownerKey;
  const stats = await getGameEngagement(gameId, visitorId);
  return json(200, { ok: true, gameId, ...stats });
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

  const actor = await creatorActorFromSessionOrGuest(await getSession(), req);
  const visitorId = actor.ownerKey;
  const currentCreatorId = await getCurrentCreatorId();
  const creatorId = currentCreatorId || (await getOrCreateCreatorIdForActor(null, actor));
  const stats = action === "view" ? await recordGameView(gameId, visitorId, creatorId) : await toggleGameLike(gameId, visitorId);
  return json(200, { ok: true, gameId, ...stats });
}
