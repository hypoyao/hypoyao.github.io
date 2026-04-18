import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sessionCookieName } from "@/lib/auth/session";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  jar.delete(sessionCookieName);
  // 表单提交退出后回首页
  return NextResponse.redirect(new URL("/", url.origin), { headers: { "cache-control": "no-store" } });
}
