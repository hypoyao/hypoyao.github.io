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

function genCode() {
  // 8 位：易读，避免 0/O/1/I
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export async function POST(req: Request) {
  const auth = await requireAdminCreator();
  if (!auth.ok) return json(auth.error === "UNAUTHORIZED" ? 401 : 403, { ok: false, error: auth.error });

  await ensureInviteCodesTable();

  let body: { note?: string; code?: string } = {};
  try {
    body = (await req.json()) as any;
  } catch {
    body = {};
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 80) : "";
  const wanted = typeof body.code === "string" ? body.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16) : "";

  try {
    if (wanted) {
      const r = await db.execute(sql`
        insert into invite_codes (code, enabled, max_uses, used_count, note)
        values (${wanted}, true, 1, 0, ${note})
        on conflict (code) do nothing
        returning code
      `);
      const row = Array.isArray((r as any).rows) ? (r as any).rows[0] : null;
      if (!row?.code) return json(409, { ok: false, error: "CODE_EXISTS" });
      return json(200, { ok: true, code: String(row.code) });
    }

    for (let i = 0; i < 5; i++) {
      const code = genCode();
      const r = await db.execute(sql`
        insert into invite_codes (code, enabled, max_uses, used_count, note)
        values (${code}, true, 1, 0, ${note})
        on conflict (code) do nothing
        returning code
      `);
      const row = Array.isArray((r as any).rows) ? (r as any).rows[0] : null;
      if (row?.code) return json(200, { ok: true, code: String(row.code) });
    }
    return json(500, { ok: false, error: "CODE_GENERATE_COLLISION" });
  } catch {
    return json(500, { ok: false, error: "DB_INSERT_FAILED" });
  }
}
