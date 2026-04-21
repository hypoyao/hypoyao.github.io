import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  gameId?: string;
  seed?: boolean;
  files?: Array<{ path: string; content: string }>;
};

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function safeRel(p: string) {
  const s = (p || "").trim().replace(/^\/+/, "");
  if (!s) return "";
  if (s.includes("..") || s.includes("\\") || s.includes(":")) return "";
  // 允许写入的文件（避免任意文件写入）
  if (!["index.html", "game.js", "style.css", "prompt.md"].includes(s)) return "";
  return s;
}

function safeGameId(id: string) {
  const s = (id || "").trim();
  if (!s) return "";
  // 只允许字母数字、下划线、短横线，避免目录穿越
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

function toKeywordFromPrompt(s: string) {
  const t = (s || "").replace(/\r/g, "").trim();
  if (!t) return "";
  const m1 = t.match(/(?:我想|想)?做(?:一个|个)?\s*([^\n，。,.]{1,24}?游戏)/);
  const m2 = t.match(/([^\n，。,.]{1,24}?游戏)/);
  let k = (m1?.[1] || m2?.[1] || "").trim();
  if (!k) {
    const first =
      t
        .split("\n")
        .map((x) => x.trim())
        .find((x) => x && !x.startsWith("#")) || "";
    k = first.trim();
  }
  k = k.replace(/（.*?）/g, "").trim();
  if (k.length > 14) {
    k = k.slice(0, 14);
    if (!k.endsWith("游戏") && t.includes("游戏")) k = k.replace(/\s+$/g, "") + "…";
  }
  return k;
}

export async function POST(req: Request) {
  try {
    const sess = await getSession();
    if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
    const ownerKey = ownerKeyFromSession(sess);
    if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED" });
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json(400, { ok: false, error: "INVALID_JSON" });
    }

    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) return json(400, { ok: false, error: "MISSING_FILES" });

    const gid = safeGameId(body?.gameId || "creator-playground");
    if (!gid) return json(400, { ok: false, error: "INVALID_GAME_ID" });
    await ensureCreatorDraftTables();

    // 确保该 game 属于当前用户
    const owns = await db.execute(sql`
      select id
      from creator_draft_games
      where id = ${gid} and owner_key = ${ownerKey}
      limit 1
    `);
    const ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
    if (!ownRows.length) {
      // 允许“第一次写入”时自动创建（兼容旧流程）
      await db.execute(sql`
        insert into creator_draft_games (id, owner_key, title)
        values (${gid}, ${ownerKey}, '')
        on conflict (id) do nothing
      `);
    }

    const written: string[] = [];
    let updatedTitle = "";
    for (const f of files) {
      const rel = safeRel(f?.path || "");
      if (!rel) continue;
      const content = typeof f?.content === "string" ? f.content : "";
      if (body.seed && rel === "index.html") {
        // seed：如果 index 已存在就不覆盖
        const ex = await db.execute(sql`
          select 1
          from creator_draft_files
          where game_id = ${gid} and path = 'index.html'
          limit 1
        `);
        const exRows = Array.isArray((ex as any).rows) ? (ex as any).rows : [];
        if (exRows.length) continue;
      }

      await db.execute(sql`
        insert into creator_draft_files (game_id, path, content)
        values (${gid}, ${rel}, ${content})
        on conflict (game_id, path)
        do update set content = excluded.content, updated_at = now()
      `);
      written.push(`/games/${gid}/${rel}`);

      // 同步 title
      if (rel === "prompt.md") {
        const k = toKeywordFromPrompt(content);
        if (k) updatedTitle = k;
      } else if (rel === "index.html") {
        const m = content.match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
        if (m && m[1]) updatedTitle = String(m[1]).trim();
      }
    }

    if (!written.length) return json(400, { ok: false, error: "NO_VALID_FILES" });

    await db.execute(sql`
      update creator_draft_games
      set updated_at = now(),
          title = case when ${updatedTitle} <> '' then ${updatedTitle} else title end
      where id = ${gid} and owner_key = ${ownerKey}
    `);

    return json(200, { ok: true, written, gameId: gid, entry: `/games/${gid}/index.html` });
  } catch (e: any) {
    const code = e?.code || e?.cause?.code || "";
    const msg = String(e?.message || e);
    // 把系统错误码也带上，方便定位（例如 EROFS/EPERM）
    return json(500, { ok: false, error: `WRITE_INTERNAL:${String(code || "")}:${msg}` });
  }
}
