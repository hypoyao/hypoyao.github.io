import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { encodeSession, sessionCookieName } from "@/lib/auth/session";
import { maskPhone, normalizePhone, sha256Hex } from "@/lib/auth/phone";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";

const COOKIE = "phone_code_v1";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  let body: { phone?: string; code?: string; next?: string } = {};
  try {
    body = (await req.json()) as { phone?: string; code?: string; next?: string };
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const phone = normalizePhone(body.phone || "");
  const code = String(body.code || "").trim();
  const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
  if (!phone || !/^\d{6}$/.test(code)) return json(400, { ok: false, error: "INVALID_INPUT" });

  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  jar.delete(COOKIE);
  if (!raw) return json(400, { ok: false, error: "CODE_EXPIRED" });

  let saved: { phone: string; exp: number; hash: string } | null = null;
  try {
    saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  if (!saved || saved.phone !== phone) return json(400, { ok: false, error: "CODE_MISMATCH" });
  if (Date.now() > Number(saved.exp || 0)) return json(400, { ok: false, error: "CODE_EXPIRED" });

  const hash = sha256Hex(`${phone}:${code}`);
  if (hash !== saved.hash) return json(400, { ok: false, error: "CODE_MISMATCH" });

  try {
    // 兼容旧版本：如果曾建过部分索引，先删除再建完整索引
    await db.execute(sql`drop index if exists creators_phone_uidx;`);
    await ensureCreatorsAuthFields();
  } catch (e) {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

  // upsert 到 creators：把手机号当“用户账号”，id 使用 u_<phone>
  const userId = `u_${phone}`;
  const name = `用户${maskPhone(phone)}`;
  const avatarUrl = "/assets/avatars/user.svg";
  const profilePath = `/creators/${userId}`;

  try {
    await db.execute(sql`
      insert into creators (id, name, avatar_url, profile_path, phone)
      values (${userId}, ${name}, ${avatarUrl}, ${profilePath}, ${phone})
      on conflict (phone) do update set
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        profile_path = excluded.profile_path,
        updated_at = now()
    `);
  } catch (e) {
    return json(500, { ok: false, error: "DB_UPSERT_FAILED" });
  }

  const sess = encodeSession({ phone });
  jar.set(sessionCookieName, sess, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return json(200, { ok: true, next });
}
