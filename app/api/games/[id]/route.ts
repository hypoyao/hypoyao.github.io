import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gid = (id || "").trim().toLowerCase();
  if (!gid) return NextResponse.json({ ok: false, error: "MISSING_ID" }, { status: 400 });

  const [row] = await db.select().from(games).where(eq(games.id, gid)).limit(1);
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
    },
    { headers: { "cache-control": "no-store" } },
  );
}

