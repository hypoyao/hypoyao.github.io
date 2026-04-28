import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";
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
  if (!["index.html", "game.js", "style.css", "prompt.md", "meta.json"].includes(s)) return "";
  return s;
}

function safeGameId(id: string) {
  const s = (id || "").trim();
  if (!s) return "";
  // 只允许字母数字、下划线、短横线，避免目录穿越
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

function stripDangerousLocalBehaviorArtifacts(path: string, content: string) {
  const rel = String(path || "").trim();
  const raw = String(content || "");
  if (!raw) return raw;
  if (rel === "index.html") {
    return raw
      .replace(/\n?\s*<style\b[^>]*data-ai-local-behavior=["']1["'][^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/\n?\s*<script\b[^>]*data-ai-local-behavior=["']1["'][^>]*>[\s\S]*?<\/script>/gi, "");
  }
  return raw;
}

async function getMyCreatorId(sess: any) {
  try {
    await ensureCreatorsAuthFields();
    if (sess?.phone) {
      const rows = await db.execute(sql`
        select id
        from creators
        where phone = ${String(sess.phone)}
        limit 1
      `);
      const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
      const id = String((list[0] as any)?.id || "").trim();
      if (id) return id;
    }
    if (sess?.openid) {
      const rows = await db.execute(sql`
        select id
        from creators
        where openid = ${String(sess.openid)}
        limit 1
      `);
      const list = Array.isArray((rows as any).rows) ? (rows as any).rows : [];
      const id = String((list[0] as any)?.id || "").trim();
      if (id) return id;
    }
  } catch {}
  return "";
}

async function clonePublishedGameToDraft(gid: string, ownerKey: string, creatorId: string) {
  if (!gid || !ownerKey || !creatorId) return false;
  await ensureGamesCoverFields();
  await ensureGameFilesTables();
  const pubRows = await db.execute(sql`
    select id, title
    from games
    where id = ${gid} and creator_id = ${creatorId}
    limit 1
  `);
  const pubs = Array.isArray((pubRows as any).rows) ? (pubRows as any).rows : [];
  const pub = pubs[0] as any;
  if (!pub) return false;

  const draftTitle = String(pub?.title || "").trim();
  await db.execute(sql`
    insert into creator_draft_games (id, owner_key, title)
    values (${gid}, ${ownerKey}, ${draftTitle})
    on conflict (id) do nothing
  `);

  const ownRows = await db.execute(sql`
    select 1
    from creator_draft_games
    where id = ${gid} and owner_key = ${ownerKey}
    limit 1
  `);
  const owns = Array.isArray((ownRows as any).rows) ? (ownRows as any).rows : [];
  if (!owns.length) return false;

  const fileRows = await db.execute(sql`
    select path, content
    from game_files
    where game_id = ${gid}
      and path in ('index.html','style.css','game.js','prompt.md','meta.json')
  `);
  const files = Array.isArray((fileRows as any).rows) ? (fileRows as any).rows : [];
  for (const row of files) {
    const rel = safeRel(String((row as any)?.path || ""));
    if (!rel) continue;
    const content = stripDangerousLocalBehaviorArtifacts(rel, String((row as any)?.content || ""));
    await db.execute(sql`
      insert into creator_draft_files (game_id, path, content)
      values (${gid}, ${rel}, ${content})
      on conflict (game_id, path)
      do update set content = excluded.content, updated_at = now()
    `);
  }
  return true;
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
    let owns = await db.execute(sql`
      select id
      from creator_draft_games
      where id = ${gid} and owner_key = ${ownerKey}
      limit 1
    `);
    let ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
    if (!ownRows.length) {
      // 编辑已发布游戏但草稿被删掉时：自动从已发布版本回灌一份可编辑草稿
      if (body.seed) {
        const creatorId = await getMyCreatorId(sess);
        const cloned = await clonePublishedGameToDraft(gid, ownerKey, creatorId);
        if (cloned) {
          owns = await db.execute(sql`
            select id
            from creator_draft_games
            where id = ${gid} and owner_key = ${ownerKey}
            limit 1
          `);
          ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
        }
      }
    }
    if (!ownRows.length) {
      // 允许“第一次写入”时自动创建（兼容旧流程）
      await db.execute(sql`
        insert into creator_draft_games (id, owner_key, title)
        values (${gid}, ${ownerKey}, '')
        on conflict (id) do nothing
      `);
      owns = await db.execute(sql`
        select id
        from creator_draft_games
        where id = ${gid} and owner_key = ${ownerKey}
        limit 1
      `);
      ownRows = Array.isArray((owns as any).rows) ? (owns as any).rows : [];
    }
    if (!ownRows.length) return json(403, { ok: false, error: "NOT_YOUR_GAME" });

    const written: string[] = [];
    let updatedTitle = "";
    for (const f of files) {
      const rel = safeRel(f?.path || "");
      if (!rel) continue;
      const content = stripDangerousLocalBehaviorArtifacts(rel, typeof f?.content === "string" ? f.content : "");
      if (body.seed) {
        // seed：已有文件一律不覆盖，让它变成真正幂等的“确保草稿存在”
        const ex = await db.execute(sql`
          select 1
          from creator_draft_files
          where game_id = ${gid} and path = ${rel}
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

      // 标题只认正式的 meta.json，避免 prompt.md 的临时文本过早把标题锁死。
      if (rel === "meta.json" && !updatedTitle) {
        try {
          const obj = content ? JSON.parse(content) : null;
          const title = String((obj as any)?.title || "").trim();
          if (title) updatedTitle = title.slice(0, 80);
        } catch {
          // ignore invalid meta.json
        }
      }
    }

    if (!written.length) {
      if (body.seed) {
        try {
          await db.execute(sql`
            update creator_draft_games
            set updated_at = now()
            where id = ${gid} and owner_key = ${ownerKey}
          `);
        } catch {
          // ignore
        }
        return json(200, {
          ok: true,
          written: [],
          gameId: gid,
          entry: `/games/${gid}/index.html`,
          skipped: true,
        });
      }
      return json(400, { ok: false, error: "NO_VALID_FILES" });
    }

    // 更新 meta（updated_at + 首次标题）：若数据库暂时异常/列不齐，写文件仍然已经成功，不能因此让用户“生成归零”
    try {
      await db.execute(sql`
        update creator_draft_games
        set updated_at = now(),
            title = case when ${updatedTitle} <> '' then ${updatedTitle} else title end
        where id = ${gid} and owner_key = ${ownerKey}
      `);
    } catch {
      try {
        await db.execute(sql`
          update creator_draft_games
          set updated_at = now()
          where id = ${gid} and owner_key = ${ownerKey}
        `);
      } catch {
        // ignore
      }
    }

    return json(200, { ok: true, written, gameId: gid, entry: `/games/${gid}/index.html` });
  } catch (e: any) {
    const code = e?.code || e?.cause?.code || "";
    const msg = String(e?.message || e);
    const causeMsg = String(e?.cause?.message || "");
    const tail = causeMsg && !msg.includes(causeMsg) ? ` CAUSE:${causeMsg}` : "";
    // 把系统错误码也带上，方便定位（例如 EROFS/EPERM）
    return json(500, { ok: false, error: `WRITE_INTERNAL:${String(code || "")}:${msg}${tail}` });
  }
}
