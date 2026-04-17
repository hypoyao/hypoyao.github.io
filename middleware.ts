import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 兼容 public 目录下的 “文件夹 + index.html” 静态小游戏：
 * - 访问 /games/memory 或 /games/memory/ 时，内部重写到 /games/memory/index.html
 * 这样既保留干净 URL，又不需要把小游戏嵌入 Next.js 路由。
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 只处理形如 /games/<slug> 或 /games/<slug>/ 的路径
  // 注意：如果用户访问 /games/<slug>（无尾斜杠），相对资源（./xxx.css/js）会解析错误，
  // 必须先 redirect 到 /games/<slug>/，再 rewrite 到 index.html。
  const mNoSlash = pathname.match(/^\/games\/([^\/.]+)$/);
  if (mNoSlash) {
    const url = req.nextUrl.clone();
    url.pathname = `${pathname}/`;
    return NextResponse.redirect(url);
  }

  const mSlash = pathname.match(/^\/games\/([^\/.]+)\/$/);
  if (mSlash) {
    const slug = mSlash[1];
    const url = req.nextUrl.clone();
    url.pathname = `/games/${slug}/index.html`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/games/:path*"],
};
