import { NextResponse } from "next/server";
import path from "node:path";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentTypeFor(p: string) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  if (ext === "html") return "text/html; charset=utf-8";
  if (ext === "css") return "text/css; charset=utf-8";
  if (ext === "js") return "application/javascript; charset=utf-8";
  if (ext === "md") return "text/markdown; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function safeRel(rel: string) {
  const s = (rel || "").replace(/^\/+/, "");
  if (!s) return "";
  if (s.includes("..") || s.includes("\\") || s.includes(":")) return "";
  return s;
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  const parts = Array.isArray(slug) ? slug : [];
  const gameId = parts[0] || "";
  if (!gameId) return new NextResponse("Not Found", { status: 404 });

  // 兼容 /games/<id> 和 /games/<id>/ ：默认 index.html
  let rel = parts.slice(1).join("/");
  if (!rel || rel.endsWith("/")) rel = `${rel || ""}index.html`;
  // 兜底：/games/<id>/something（没扩展名）也当作目录
  if (!rel.includes(".")) rel = path.posix.join(rel, "index.html");
  rel = safeRel(rel);
  if (!rel) return new NextResponse("Not Found", { status: 404 });

  // 1) creator 草稿：从 DB 读取（如果存在则优先）
  await ensureCreatorDraftTables();
  const draftRows = await db.execute(sql`
    select content
    from creator_draft_files
    where game_id = ${gameId} and path = ${rel}
    limit 1
  `);
  const draftList = Array.isArray((draftRows as any).rows) ? (draftRows as any).rows : [];
  const draftContent = draftList?.[0]?.content;
  if (typeof draftContent === "string") {
    return new NextResponse(draftContent, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(rel),
        "cache-control": "no-store",
        "x-game-source": "creator_draft_files",
      },
    });
  }

  // 如果草稿存在但还没有任何文件：对 index.html 给一个可用占位页面，避免预览 404
  if (rel === "index.html") {
    const draftGame = await db.execute(sql`
      select 1
      from creator_draft_games
      where id = ${gameId}
      limit 1
    `);
    const drows = Array.isArray((draftGame as any).rows) ? (draftGame as any).rows : [];
    if (drows.length) {
      const html =
        "<!doctype html><html lang='zh-CN'><head><meta charset='UTF-8'/>" +
        "<meta name='viewport' content='width=device-width,initial-scale=1.0'/>" +
        "<title>草稿未初始化</title>" +
        "<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:#f8fafc}" +
        ".wrap{max-width:860px;margin:24px auto;padding:0 16px}.card{background:#fff;border:1px solid rgba(15,23,42,.10);" +
        "border-radius:16px;padding:16px}h1{margin:0 0 8px;font-size:18px}p{margin:0;color:rgba(15,23,42,.75);line-height:1.6}" +
        "</style></head><body><div class='wrap'><div class='card'>" +
        "<h1>这个草稿还没有生成文件</h1>" +
        "<p>请回到 create 页面，在左侧发一句话让 AI 生成/修改游戏，预览就会自动出现。</p>" +
        "</div></div></body></html>";
      return new NextResponse(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }

  // 2) 已发布游戏：从 DB 读取（统一入口）
  await ensureGameFilesTables();
  const rows = await db.execute(sql`
    select content
    from game_files
    where game_id = ${gameId} and path = ${rel}
    limit 1
  `);
  const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
  const content = list?.[0]?.content;
  if (typeof content === "string") {
    return new NextResponse(content, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(rel),
        // 生产环境可改为更激进缓存；开发期先 no-store，避免调试时缓存不生效
        "cache-control": "no-store",
        "x-game-source": "game_files",
      },
    });
  }
  return new NextResponse("Not Found", { status: 404 });
}
