import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sessionCookieName } from "@/lib/auth/session";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  jar.delete(sessionCookieName);
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}

