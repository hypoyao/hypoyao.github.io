import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { encodeSession, sessionCookieName } from "@/lib/auth/session";
import { getMpAppId, getMpSecret } from "@/lib/auth/wechat";
import { sha256Hex } from "@/lib/auth/phone";

const STATE_COOKIE = "wx_oauth_state";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const next = url.searchParams.get("next") || "/";

  const jar = await cookies();
  const expectedState = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL(`/login?err=state`, url.origin));
  }

  // 换取 access_token + openid（snsapi_base 也会返回 openid）
  const tokenUrl =
    `https://api.weixin.qq.com/sns/oauth2/access_token` +
    `?appid=${encodeURIComponent(getMpAppId())}` +
    `&secret=${encodeURIComponent(getMpSecret())}` +
    `&code=${encodeURIComponent(code)}` +
    `&grant_type=authorization_code`;

  const r = await fetch(tokenUrl, { cache: "no-store" });
  const data = await r.json();

  const openid = data?.openid;
  if (!openid || typeof openid !== "string") {
    return NextResponse.redirect(new URL(`/login?err=wechat`, url.origin));
  }

  // 让微信登录也能在首页展示头像/进入个人主页
  try {
    await ensureCreatorsAuthFields();
    const uid = `u_wx_${sha256Hex(openid).slice(0, 16)}`;
    const name = "微信用户";
    const avatarUrl = "/assets/avatars/user.svg";
    const profilePath = `/creators/${uid}`;
    await db.execute(sql`
      insert into creators (id, name, avatar_url, profile_path, openid)
      values (${uid}, ${name}, ${avatarUrl}, ${profilePath}, ${openid})
      on conflict (openid) do update set
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        profile_path = excluded.profile_path,
        updated_at = now()
    `);
  } catch {
    // ignore
  }

  const session = encodeSession({ openid });
  jar.set(sessionCookieName, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  return NextResponse.redirect(new URL(next, url.origin));
}
