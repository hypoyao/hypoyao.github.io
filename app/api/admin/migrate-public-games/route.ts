import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators, games } from "@/lib/db/schema";
import { ensureGamesCoverFields } from "@/lib/db/ensureGamesCoverFields";
import { ensureGameFilesTables } from "@/lib/db/ensureGameFilesTables";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeId(id: string) {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function isLegacyDraftId(id: string) {
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

function parseTitleFromHtml(html: string) {
  const m = html.match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
  return (m?.[1] || "").trim();
}

function parseCreatorIdFromHtml(html: string) {
  const m = html.match(/class="creatorBadge"[^>]*href="\/creators\/([^"?#/]+)"/i);
  return (m?.[1] || "").trim();
}

function parseDescFromHtml(html: string) {
  const descHtml = html.match(/<p\s+class="desc"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
  return descHtml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function readTextIfExists(p: string) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

async function existsFile(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const key = (process.env.ADMIN_API_KEY || "").trim();
  const auth = (req.headers.get("authorization") || "").trim();
  if (!key || auth !== `Bearer ${key}`) return json(401, { ok: false, error: "UNAUTHORIZED" });

  // 可选：只迁移指定 ids（逗号分隔）
  const url = new URL(req.url);
  const only = (url.searchParams.get("only") || "").trim();
  const onlySet = only ? new Set(only.split(",").map((x) => normalizeId(x)).filter(Boolean)) : null;

  const defaultCreatorId = (process.env.MIGRATION_DEFAULT_CREATOR_ID || "tianqing").trim();
  const dryRun = url.searchParams.get("dryRun") === "1";
  const includeDrafts = url.searchParams.get("includeDrafts") === "1";
  const draftOwnerKey = (process.env.MIGRATION_DRAFT_OWNER_KEY || "").trim();

  try {
    await ensureGamesCoverFields();
    await ensureGameFilesTables();
  } catch {
    return json(500, { ok: false, error: "DB_MIGRATION_FAILED" });
  }

  // 默认作者必须存在
  const [defCreator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.id, defaultCreatorId)).limit(1);
  if (!defCreator) return json(400, { ok: false, error: `DEFAULT_CREATOR_NOT_FOUND:${defaultCreatorId}` });

  const base = path.join(process.cwd(), "public", "games");
  const ents = await fs.readdir(base, { withFileTypes: true });
  const ids = ents
    .filter((e) => e.isDirectory())
    .map((e) => normalizeId(e.name))
    .filter(Boolean)
    .filter((id) => (onlySet ? onlySet.has(id) : true))
    .filter((id) => (includeDrafts ? true : !isLegacyDraftId(id)))
    .sort();

  let scanned = 0;
  let upserted = 0;
  let filesWritten = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    scanned++;
    try {
      const dir = path.join(base, id);
      const indexHtmlPath = path.join(dir, "index.html");
      const indexHtml = await readTextIfExists(indexHtmlPath);
      if (!indexHtml) continue; // 没有入口就跳过

      const metaPath = path.join(dir, "meta.json");
      const metaRaw = await readTextIfExists(metaPath);
      let meta: any = null;
      try {
        meta = metaRaw ? JSON.parse(metaRaw) : null;
      } catch {
        meta = null;
      }

      const title = String(meta?.title || parseTitleFromHtml(indexHtml) || id).trim() || id;
      const shortDesc =
        String(meta?.shortDesc || "").trim() ||
        String(parseDescFromHtml(indexHtml) || "").trim().slice(0, 42) ||
        title.slice(0, 42);
      const ruleText = String(meta?.rules || meta?.ruleText || "").trim() || shortDesc;

      const cidHtml = parseCreatorIdFromHtml(indexHtml);
      const creatorId = cidHtml || defaultCreatorId;
      const [creator] = await db.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId)).limit(1);
      const effCreatorId = creator?.id || defaultCreatorId;

      // legacy 草稿（g-xxxx）：默认迁移为“草稿”而不是发布（避免污染首页）
      if (isLegacyDraftId(id)) {
        if (!includeDrafts) continue;
        if (!draftOwnerKey) {
          errors.push({ id, error: "MISSING_ENV:MIGRATION_DRAFT_OWNER_KEY" });
          continue;
        }
        if (!dryRun) {
          await ensureCreatorDraftTables();
          await db.execute(sql`
            insert into creator_draft_games (id, owner_key, title)
            values (${id}, ${draftOwnerKey}, ${title})
            on conflict (id) do update set title = excluded.title, updated_at = now()
          `);
          const fileList: Array<{ path: string; content: string }> = [];
          for (const p of ["index.html", "style.css", "game.js", "prompt.md", "meta.json"]) {
            const c = await readTextIfExists(path.join(dir, p));
            if (c) fileList.push({ path: p, content: c });
          }
          for (const f of fileList) {
            await db.execute(sql`
              insert into creator_draft_files (game_id, path, content)
              values (${id}, ${f.path}, ${f.content})
              on conflict (game_id, path)
              do update set content = excluded.content, updated_at = now()
            `);
            filesWritten++;
          }
        }
        upserted++;
        continue;
      }

      // cover：优先截图路径存在，否则用默认 ttt
      const ss = `/assets/screenshots/${id}.png`;
      const ssExists = await existsFile(path.join(process.cwd(), "public", "assets", "screenshots", `${id}.png`));
      const coverUrl = ssExists ? ss : "/assets/screenshots/ttt.png";

      if (!dryRun) {
        await db
          .insert(games)
          .values({
            id,
            title,
            shortDesc,
            ruleText,
            coverUrl,
            path: `/games/${id}/`,
            creatorId: effCreatorId,
          })
          .onConflictDoUpdate({
            target: games.id,
            set: { title, shortDesc, ruleText, coverUrl, creatorId: effCreatorId, updatedAt: new Date() },
          });
      }
      upserted++;

      // 写入文件：index/style/game/prompt/meta
      const fileList: Array<{ path: string; content: string }> = [];
      for (const p of ["index.html", "style.css", "game.js", "prompt.md", "meta.json"]) {
        const c = await readTextIfExists(path.join(dir, p));
        if (c) fileList.push({ path: p, content: c });
      }
      if (!dryRun && fileList.length) {
        for (const f of fileList) {
          await db.execute(sql`
            insert into game_files (game_id, path, content)
            values (${id}, ${f.path}, ${f.content})
            on conflict (game_id, path)
            do update set content = excluded.content, updated_at = now()
          `);
          filesWritten++;
        }
      } else {
        filesWritten += fileList.length;
      }
    } catch (e: any) {
      errors.push({ id, error: String(e?.message || e) });
    }
  }

  return json(200, { ok: true, dryRun, scanned, upserted, filesWritten, errors });
}
