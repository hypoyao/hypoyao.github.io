import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function genId() {
  // 轻量可读：g-20260419-abcdef
  const d = new Date();
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(16).slice(2, 8);
  return `g-${y}${m}${day}-${rand}`;
}

export async function POST() {
  let sess: any = null;
  try {
    sess = await getSession();
  } catch (e: any) {
    return json(500, { ok: false, error: `AUTH_FAILED:${String(e?.message || e)}` });
  }
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });

  try {
    await ensureCreatorDraftTables();
    const id = genId();
    const ownerKey = ownerKeyFromSession(sess);
    if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED" });

    await db.execute(sql`
      insert into creator_draft_games (id, owner_key, title)
      values (${id}, ${ownerKey}, '')
      on conflict (id) do nothing;
    `);

    // 初始化 seed 文件：避免预览直接 404
    const indexHtml =
      "<!doctype html><html lang='zh-CN'><head><meta charset='UTF-8'/>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1.0'/>" +
      "<title>我的小游戏</title><link rel='stylesheet' href='./style.css'/>" +
      "</head><body><main class='wrap'><section class='card'>" +
      "<header class='header'><h1>我的小游戏</h1><p class='desc'>在左侧对话生成/修改这个游戏。</p></header>" +
      "<div id='app' class='card' style='margin-top:10px'></div>" +
      "</section></main><script src='./game.js'></script></body></html>";
    const styleCss =
      "body{margin:0;background:linear-gradient(180deg,#f8fafc,#eef2ff)}" +
      "#app{padding:14px;border-radius:16px;border:1px solid rgba(15,23,42,0.10);" +
      "background:rgba(255,255,255,0.70)}";
    const gameJs =
      "(()=>{const el=document.getElementById('app');" +
      "if(!el) return; el.innerHTML=\"<div style='font-weight:900'>准备就绪 ✅</div>\";})();";
    const promptMd = "我想做一个什么小游戏呢？\n\n（你可以在左边对 AI 说：我想做一个……）\n";

    const files: Array<[string, string]> = [
      ["index.html", indexHtml],
      ["style.css", styleCss],
      ["game.js", gameJs],
      ["prompt.md", promptMd],
    ];
    for (const [p, c] of files) {
      await db.execute(sql`
        insert into creator_draft_files (game_id, path, content)
        values (${id}, ${p}, ${c})
        on conflict (game_id, path) do nothing
      `);
    }

    return json(200, { ok: true, gameId: id, entry: `/games/${id}/index.html` });
  } catch (e: any) {
    return json(500, { ok: false, error: `NEW_GAME_FAILED:${String(e?.message || e)}` });
  }
}
