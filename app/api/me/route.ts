import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { isSuperAdminId } from "@/lib/auth/admin";

export async function GET() {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ ok: true, loggedIn: false }, { headers: { "cache-control": "no-store" } });
  }

  // 尽量查到对应的 creator（让“作者”也能更新自己的游戏 + 首页显示头像）
  let creator: { id: string; name: string; avatarUrl: string; profilePath: string } | null = null;
  try {
    await ensureCreatorsAuthFields();
    if (sess.phone) {
      const [row] = await db
        .select({ id: creators.id, name: creators.name, avatarUrl: creators.avatarUrl, profilePath: creators.profilePath })
        .from(creators)
        .where(eq(creators.phone, sess.phone))
        .limit(1);
      creator = row ? { ...row } : null;
    } else if (sess.openid) {
      const [row] = await db
        .select({ id: creators.id, name: creators.name, avatarUrl: creators.avatarUrl, profilePath: creators.profilePath })
        .from(creators)
        .where(eq(creators.openid, sess.openid))
        .limit(1);
      creator = row ? { ...row } : null;
    }
  } catch {
    // ignore
  }

  const creatorId = creator?.id || null;
  return NextResponse.json(
    {
      ok: true,
      loggedIn: true,
      // 超级管理员：只在后端判断（不在前端写死）
      isAdmin: isSuperAdminId(creatorId),
      creatorId,
      creator,
      openid: sess.openid || null,
      phone: sess.phone || null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
