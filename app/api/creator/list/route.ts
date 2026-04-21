import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { getSession } from "@/lib/auth/session";
import { getCreatorGamesFast, ownerKeyFromSession, setCreatorGames } from "@/lib/creator/creatorIndex";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function isCreatorGameId(id: string) {
  // 由 /api/creator/new 生成：g-YYYYMMDD-xxxxxx
  return /^g-\d{8}-[0-9a-f]{6}$/i.test(id);
}

async function readFileHead(filePath: string, maxBytes = 4096) {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    try {
      await fh?.close();
    } catch {}
  }
}

async function readMeta(gameDir: string) {
  try {
    const p = path.join(gameDir, "meta.json");
    const raw = await readFileHead(p, 4096);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj as any;
  } catch {
    return null;
  }
}

async function tryReadTitle(indexPath: string) {
  try {
    const html = await readFileHead(indexPath, 16 * 1024);
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
    const raw = await readFileHead(p, 12 * 1024);
    return toKeywordFromPrompt(raw);
  } catch {}
  return "";
}

// 简单内存缓存：加速 create 页面频繁刷新“我的游戏”
let _cache: { ownerKey: string; at: number; games: any[] } | null = null;

export async function GET() {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED", games: [] });
  const ownerKey = ownerKeyFromSession(sess);

  // 性能最优路径：优先走“本地索引文件”，避免扫盘
  const fast = await getCreatorGamesFast(ownerKey);
  if (fast) return json(200, { ok: true, games: fast });

  if (_cache && _cache.ownerKey === ownerKey && Date.now() - _cache.at < 2500) {
    return json(200, { ok: true, games: _cache.games });
  }
  const base = path.join(process.cwd(), "public", "games");
  let items: Array<{ gameId: string; entry: string; mtimeMs: number; title?: string }> = [];
  try {
    const ents = await fs.readdir(base, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    const target = dirs.filter((d) => isCreatorGameId(d));

    // 并发跑，避免串行读文件太慢
    const CONCURRENCY = 16;
    let i = 0;
    async function worker() {
      while (i < target.length) {
        const d = target[i++];
        const gameDir = path.join(base, d);
        const meta = await readMeta(gameDir);
        // 如果有 meta 且 ownerKey 不匹配：直接跳过（避免扫全盘）
        if (meta?.ownerKey && ownerKey && meta.ownerKey !== ownerKey) continue;

        const indexPath = path.join(base, d, "index.html");
        const st = await fs
          .stat(indexPath)
          .then((x) => x)
          .catch(() => null);
        const mtimeMs = st?.mtimeMs || meta?.mtimeMs || 0;

        let title = "";
        if (typeof meta?.title === "string") title = meta.title.trim();
        if (!title) {
          const keyword = await tryReadKeyword(gameDir);
          title = keyword || (await tryReadTitle(indexPath));
        }
        items.push({ gameId: d, entry: `/games/${d}/index.html`, mtimeMs, title });
      }
    }
    await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()));
  } catch {
    items = [];
  }

  items.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  _cache = { ownerKey, at: Date.now(), games: items };

  // 回填索引（一次慢，后续秒开）
  try {
    if (ownerKey) await setCreatorGames(ownerKey, items);
  } catch {
    // ignore
  }
  return json(200, { ok: true, games: items });
}
