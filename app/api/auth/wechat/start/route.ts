import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getMpAppId, getSiteUrl, newState } from "@/lib/auth/wechat";

// 微信公众号网页授权（微信内浏览器使用）
// scope:
// - snsapi_base：静默授权，只拿 openid（满足“仅 openid”）
// - snsapi_userinfo：可拿昵称头像（需显式授权）
const SCOPE = "snsapi_base";
const STATE_COOKIE = "wx_oauth_state";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = url.searchParams.get("next") || "/";

  const state = newState();
  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60, // 10min
  });

  const redirectUri = encodeURIComponent(`${getSiteUrl()}/api/auth/wechat/callback?next=${encodeURIComponent(next)}`);
  const authUrl =
    `https://open.weixin.qq.com/connect/oauth2/authorize` +
    `?appid=${encodeURIComponent(getMpAppId())}` +
    `&redirect_uri=${redirectUri}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${encodeURIComponent(state)}` +
    `#wechat_redirect`;

  return NextResponse.redirect(authUrl);
}

