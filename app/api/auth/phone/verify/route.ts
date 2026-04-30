import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { encodeSession, sessionCookieName } from "@/lib/auth/session";
import { genCuteName, normalizePhone, sha256Hex } from "@/lib/auth/phone";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureInviteCodesTable } from "@/lib/db/ensureInviteCodesTable";
import { safeProfilePathForCreatorId } from "@/lib/creatorProfilePath";

const COOKIE = "phone_code_v1";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeInviteCode(s: string) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export async function POST(req: Request) {
  let body: { phone?: string; code?: string; next?: string; inviteCode?: string } = {};
  try {
    body = (await req.json()) as { phone?: string; code?: string; next?: string; inviteCode?: string };
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const phone = normalizePhone(body.phone || "");
  const code = String(body.code || "").trim();
  const next = typeof body.next === "string" && body.next.startsWith("/") ? body.next : "/";
  const inviteCode = normalizeInviteCode(body.inviteCode || "");
  if (!phone || !/^\d{6}$/.test(code)) return json(400, { ok: false, error: "INVALID_INPUT" });

  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return json(400, { ok: false, error: "CODE_EXPIRED" });

  let saved: { phone: string; exp: number; hash: string } | null = null;
  try {
    saved = JSON.parse(raw);
  } catch {
    saved = null;
  }
  if (!saved || saved.phone !== phone) return json(400, { ok: false, error: "CODE_MISMATCH" });
  if (Date.now() > Number(saved.exp || 0)) {
    jar.delete(COOKIE);
    return json(400, { ok: false, error: "CODE_EXPIRED" });
  }

  const hash = sha256Hex(`${phone}:${code}`);
  if (hash !== saved.hash) return json(400, { ok: false, error: "CODE_MISMATCH" });

  try {
    // 兼容旧版本：如果曾建过部分索引，先删除再建完整索引
    await db.execute(sql`drop index if exists creators_phone_uidx;`);
    await ensureCreatorsAuthFields();
    await ensureInviteCodesTable();
  } catch (e) {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

  // 是否首次注册：若 creators 中不存在该手机号，则需要邀请码
  let exists = false;
  try {
    const r = await db.execute(sql`select id from creators where phone = ${phone} limit 1;`);
    exists = Array.isArray((r as any).rows) && (r as any).rows.length > 0;
  } catch {}

  if (!exists) {
    if (!inviteCode) return json(400, { ok: false, error: "INVITE_REQUIRED" });
    // 校验邀请码可用，并消耗一次（原子条件：used_count < max_uses）
    try {
      const row = await db.execute(sql`
        select code, enabled, max_uses, used_count
        from invite_codes
        where code = ${inviteCode}
        limit 1
      `);
      const it = Array.isArray((row as any).rows) ? (row as any).rows[0] : null;
      if (!it || it.enabled !== true) return json(400, { ok: false, error: "INVITE_INVALID" });
      // 规则：每个邀请码只能被一个用户使用
      const maxUses = 1;
      const usedCount = Number(it.used_count || 0);
      if (usedCount >= maxUses) return json(400, { ok: false, error: "INVITE_EXHAUSTED" });

      const upd = await db.execute(sql`
        update invite_codes
        set
          used_count = used_count + 1,
          last_used_phone = ${phone},
          last_used_at = now(),
          updated_at = now()
        where code = ${inviteCode}
          and enabled = true
          and used_count < 1
      `);
      const changed = Number((upd as any).rowCount ?? 0);
      if (!changed) return json(400, { ok: false, error: "INVITE_EXHAUSTED" });
    } catch {
      return json(400, { ok: false, error: "INVITE_INVALID" });
    }
  }

  // upsert 到 creators：把手机号当“用户账号”，id 使用 u_<phone>
  const userId = `u_${phone}`;
  const name = genCuteName(phone);
  // 不在 DB 里存 base64，默认给一个静态头像（用户可在“个人资料”里上传自己的头像）
  const avatarUrl = "/assets/avatars/user.svg";
  const profilePath = safeProfilePathForCreatorId(userId);

  try {
    await db.execute(sql`
      insert into creators (id, name, avatar_url, profile_path, phone)
      values (${userId}, ${name}, ${avatarUrl}, ${profilePath}, ${phone})
      on conflict (phone) do update set
        profile_path = excluded.profile_path,
        updated_at = now()
    `);
  } catch (e) {
    return json(500, { ok: false, error: "DB_UPSERT_FAILED" });
  }

  const sess = encodeSession({ phone });
  jar.delete(COOKIE);
  jar.set(sessionCookieName, sess, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return json(200, { ok: true, next });
}
