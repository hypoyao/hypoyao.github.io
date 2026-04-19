import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { games } from "@/lib/db/schema";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gid = (id || "").trim().toLowerCase();
  if (!gid) return new NextResponse("MISSING_ID", { status: 400 });

  try {
    await ensureGamesCoverFields();
  } catch {
    // ignore
  }

  const [row] = await db
    .select({ mime: games.coverMime, data: games.coverData })
    .from(games)
    .where(eq(games.id, gid))
    .limit(1);

  const mime = row?.mime || "image/webp";
  const b64 = row?.data || "";
  if (!b64) return new NextResponse("NOT_FOUND", { status: 404 });

  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return new NextResponse("INVALID_DATA", { status: 500 });
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": mime,
      "cache-control": "no-store",
    },
  });
}
