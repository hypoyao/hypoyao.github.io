import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function patchChessJs(src: string) {
  let s = String(src || "");
  let changed = 0;

  // 1) 强化“无子可走”提示：这是困毙（stalemate），不是胜利/失败
  // 兼容不同空格/引号写法
  const reStalemate = /return\s*\{\s*winner:\s*["']draw["']\s*,\s*reason:\s*["']无子可走["']\s*\}/g;
  const nextStalemate = `return { winner: "draw", reason: "无子可走（困毙：你没有将军，但把对方王困住了）" }`;
  const s1 = s.replace(reStalemate, () => {
    changed++;
    return nextStalemate;
  });
  s = s1;

  // 2) 状态栏显示和棋原因（若已有原因）
  // 原逻辑：setStatus("结果：和棋")
  const reStatus = /setStatus\(\s*["']结果：和棋["']\s*\)/g;
  const nextStatus = `setStatus(G.reason ? \`结果：和棋（\${G.reason}）\` : "结果：和棋")`;
  const s2 = s.replace(reStatus, () => {
    changed++;
    return nextStatus;
  });
  s = s2;

  return { content: s, changed };
}

export async function POST(req: Request) {
  const key = (process.env.ADMIN_API_KEY || "").trim();
  const auth = (req.headers.get("authorization") || "").trim();
  if (!key || auth !== `Bearer ${key}`) return json(401, { ok: false, error: "UNAUTHORIZED" });

  await ensureGameFilesTables();

  const row = await db.execute(sql`
    select content
    from game_files
    where game_id = 'chess' and path = 'chess.js'
    limit 1
  `);
  const list = Array.isArray((row as any).rows) ? (row as any).rows : [];
  const cur = String(list?.[0]?.content || "");
  if (!cur) return json(404, { ok: false, error: "CHESS_JS_NOT_FOUND" });

  const patched = patchChessJs(cur);
  if (!patched.changed) {
    return json(200, { ok: true, changed: 0, message: "未找到可替换片段（可能已修复或代码版本不同）" });
  }

  await db.execute(sql`
    insert into game_files (game_id, path, content)
    values ('chess', 'chess.js', ${patched.content})
    on conflict (game_id, path)
    do update set content = excluded.content, updated_at = now()
  `);

  return json(200, { ok: true, changed: patched.changed });
}

