import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ensureInviteCodesTable } from "@/lib/db/ensureInviteCodesTable";
import { requireAdminCreator } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await requireAdminCreator();
  if (!auth.ok) return json(auth.error === "UNAUTHORIZED" ? 401 : 403, { ok: false, error: auth.error });
  await ensureInviteCodesTable();

  let body: { code?: string; enabled?: boolean } = {};
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (!code) return json(400, { ok: false, error: "INVALID_CODE" });
  const enabled = body.enabled === true;

  const r = await db.execute(sql`
    update invite_codes
    set enabled = ${enabled}, updated_at = now()
    where code = ${code}
  `);
  const changed = Number((r as any).rowCount ?? 0);
  return json(200, { ok: true, changed });
}

