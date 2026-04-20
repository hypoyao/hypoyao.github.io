import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isCreatorGameId(id: string) {
  // 由 /api/creator/new 生成：g-YYYYMMDD-xxxxxx
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

async function tryReadTitle(indexPath: string) {
  try {
    const html = await fs.readFile(indexPath, "utf8");
    const m = html.match(/<title>\s*([^<]{1,80})\s*<\/title>/i);
    if (m && m[1]) return m[1].trim();
  } catch {}
  return "";
}

function toKeywordFromPrompt(s: string) {
  const t = (s || "").replace(/\r/g, "").trim();
  if (!t) return "";
  // 优先从“用户输入的一句话”里提取：XXX游戏
  // 例：我想做一个打地鼠游戏，主角是一只小猫…
  const m1 = t.match(/(?:我想|想)?做(?:一个|个)?\s*([^\n，。,.]{1,24}?游戏)/);
  const m2 = t.match(/([^\n，。,.]{1,24}?游戏)/);
  let k = (m1?.[1] || m2?.[1] || "").trim();

  if (!k) {
    // 兜底：取第一行（去掉 markdown 标题）
    const first = t
      .split("\n")
      .map((x) => x.trim())
      .find((x) => x && !x.startsWith("#")) || "";
    k = first.trim();
  }

  // 去掉括号内容（如：井字棋（儿童版）游戏 → 井字棋游戏）
  k = k.replace(/（.*?）/g, "").trim();
  // 太长就截断（保留“游戏”结尾更好理解）
  if (k.length > 14) {
    k = k.slice(0, 14);
    if (!k.endsWith("游戏") && t.includes("游戏")) k = k.replace(/\s+$/g, "") + "…";
  }
  return k;
}

async function tryReadKeyword(gameDir: string) {
  try {
    const p = path.join(gameDir, "prompt.md");
    const raw = await fs.readFile(p, "utf8");
    return toKeywordFromPrompt(raw);
  } catch {}
  return "";
}

export async function GET() {
  const base = path.join(process.cwd(), "public", "games");
  let items: Array<{ gameId: string; entry: string; mtimeMs: number; title?: string }> = [];
  try {
    const ents = await fs.readdir(base, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const d of dirs) {
      if (!isCreatorGameId(d)) continue;
      const gameDir = path.join(base, d);
      const indexPath = path.join(base, d, "index.html");
      const st = await fs
        .stat(indexPath)
        .then((x) => x)
        .catch(() => null);
      const mtimeMs = st?.mtimeMs || 0;
      const keyword = await tryReadKeyword(gameDir);
      const title = keyword || (await tryReadTitle(indexPath));
      items.push({ gameId: d, entry: `/games/${d}/index.html`, mtimeMs, title });
    }
  } catch {
    items = [];
  }

  items.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return json(200, { ok: true, games: items });
}
