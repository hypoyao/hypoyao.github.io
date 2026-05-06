import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { sql } from "drizzle-orm";
import { requireAdminCreator } from "@/lib/auth/requireAdmin";
import { db } from "@/lib/db";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await requireAdminCreator();
  if (!auth.ok) return json(auth.error === "UNAUTHORIZED" ? 401 : 403, { ok: false, error: auth.error });

  let body: { gameId?: string; showOnWall?: boolean };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const gameId = String(body?.gameId || "").trim();
  if (!gameId) return json(400, { ok: false, error: "MISSING_GAME_ID" });
  if (typeof body.showOnWall !== "boolean") return json(400, { ok: false, error: "MISSING_SHOW_ON_WALL" });

  await ensureGamesCoverFields();
  const rows = await db.execute(sql`
    update games
    set show_on_wall = ${body.showOnWall}, updated_at = now()
    where id = ${gameId}
    returning id, show_on_wall
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const row = list[0];
  if (!row) return json(404, { ok: false, error: "GAME_NOT_FOUND" });

  revalidateTag("games:list");
  revalidatePath("/");
  revalidatePath("/works");
  revalidatePath("/teachers");

  return json(200, { ok: true, gameId: row.id, showOnWall: !!row.show_on_wall });
}
