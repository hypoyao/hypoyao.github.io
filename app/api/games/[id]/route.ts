import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gid = (id || "").trim().toLowerCase();
  if (!gid) return NextResponse.json({ ok: false, error: "MISSING_ID" }, { status: 400 });

  try {
    await ensureGamesCoverFields();
  } catch {
    // ignore
  }

  const [row] = await db
    .select({
      id: games.id,
      title: games.title,
      shortDesc: games.shortDesc,
      ruleText: games.ruleText,
      coverUrl: games.coverUrl,
      path: games.path,
      creatorId: games.creatorId,
      creatorName: creators.name,
      creatorAvatarUrl: creators.avatarUrl,
      creatorProfilePath: creators.profilePath,
    })
    .from(games)
    .innerJoin(creators, eq(games.creatorId, creators.id))
    .where(eq(games.id, gid))
    .limit(1);
  if (!row) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  return NextResponse.json(
    {
      ok: true,
      game: {
        id: row.id,
        title: row.title,
        shortDesc: row.shortDesc,
        ruleText: row.ruleText,
        coverUrl: row.coverUrl,
        path: row.path,
        creatorId: row.creatorId,
      },
      creator: {
        id: row.creatorId,
        name: row.creatorName,
        avatarUrl: row.creatorAvatarUrl,
        profilePath: row.creatorProfilePath,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
