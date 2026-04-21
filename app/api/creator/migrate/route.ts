import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession } from "@/lib/creator/creatorIndex";
import { ensureCreatorDraftTables } from "@/lib/db/ensureCreatorDraftTables";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isCreatorGameId(id: string) {
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

async function readText(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function pickTitle(promptMd: string, html: string) {
  const p = (promptMd || "").trim();
  if (p) {
    const m = p.match(/(?:我想|想)?做(?:一个|个)?\s*([^\n，。,.]{1,24}?游戏)/) || p.match(/([^\n，。,.]{1,24}?游戏)/);
    if (m?.[1]) return m[1].trim().slice(0, 24);
  }
  const m2 = (html || "").match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
  return (m2?.[1] || "").trim();
}

export async function POST() {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });
  const ownerKey = ownerKeyFromSession(sess);
  if (!ownerKey) return json(401, { ok: false, error: "UNAUTHORIZED" });

  await ensureCreatorDraftTables();

  const base = path.join(process.cwd(), "public", "games");
  let migrated = 0;
  let scanned = 0;
  try {
    const ents = await fs.readdir(base, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    const targets = dirs.filter((d) => isCreatorGameId(d));
    scanned = targets.length;

    for (const gid of targets) {
      const dir = path.join(base, gid);
      const indexHtml = await readText(path.join(dir, "index.html"));
      const styleCss = await readText(path.join(dir, "style.css"));
      const gameJs = await readText(path.join(dir, "game.js"));
      const promptMd = await readText(path.join(dir, "prompt.md"));
      if (!indexHtml && !styleCss && !gameJs && !promptMd) continue;
      const title = pickTitle(promptMd, indexHtml);

      await db.execute(sql`
        insert into creator_draft_games (id, owner_key, title)
        values (${gid}, ${ownerKey}, ${title || ""})
        on conflict (id) do update set owner_key = excluded.owner_key, title = excluded.title, updated_at = now()
      `);

      const files: Array<[string, string]> = [
        ["index.html", indexHtml],
        ["style.css", styleCss],
        ["game.js", gameJs],
        ["prompt.md", promptMd],
      ];
      for (const [p, c] of files) {
        if (!c) continue;
        await db.execute(sql`
          insert into creator_draft_files (game_id, path, content)
          values (${gid}, ${p}, ${c})
          on conflict (game_id, path) do update set content = excluded.content, updated_at = now()
        `);
      }
      migrated++;
    }
  } catch (e: any) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }

  return json(200, { ok: true, scanned, migrated });
}

