import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isCreatorGameId(id: string) {
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

export async function POST(req: Request) {
  let body: { gameId?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const gid = String(body?.gameId || "").trim();
  if (!isCreatorGameId(gid)) return json(400, { ok: false, error: "INVALID_GAME_ID" });

  const dir = path.join(process.cwd(), "public", "games", gid);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e: any) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }

  return json(200, { ok: true, gameId: gid });
}

