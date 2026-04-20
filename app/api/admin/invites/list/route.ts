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

export async function GET() {
  const auth = await requireAdminCreator();
  if (!auth.ok) return json(auth.error === "UNAUTHORIZED" ? 401 : 403, { ok: false, error: auth.error });

  await ensureInviteCodesTable();
  const r = await db.execute(sql`
    select code, enabled, max_uses, used_count, note, last_used_phone, last_used_at, created_at, updated_at
    from invite_codes
    order by created_at desc
    limit 200
  `);
  const rows = Array.isArray((r as any).rows) ? (r as any).rows : [];
  return json(200, { ok: true, invites: rows });
}

