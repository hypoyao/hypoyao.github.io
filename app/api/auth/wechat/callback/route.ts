import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { encodeSession, sessionCookieName } from "@/lib/auth/session";
import { getMpAppId, getMpSecret } from "@/lib/auth/wechat";

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

