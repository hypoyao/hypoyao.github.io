import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { getSession } from "@/lib/auth/session";
import { ownerKeyFromSession, upsertCreatorGame } from "@/lib/creator/creatorIndex";

export const dynamic = "force-dynamic";

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
    const id = genId();
    const base = path.join(process.cwd(), "public", "games", id);
    await fs.mkdir(base, { recursive: true });
    // 写入 meta：用于“我的游戏”列表快速筛选 + 加速
    try {
      const metaPath = path.join(base, "meta.json");
      const ownerKey = ownerKeyFromSession(sess);
      const meta = { ownerKey, createdAt: Date.now(), title: "" };
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
      // 同步到高速索引（create 页“我的游戏”列表）
      if (ownerKey) {
        await upsertCreatorGame(ownerKey, { gameId: id, entry: `/games/${id}/index.html`, mtimeMs: Date.now(), title: "" });
      }
    } catch {}
    return json(200, { ok: true, gameId: id, entry: `/games/${id}/index.html` });
  } catch (e: any) {
    return json(500, { ok: false, error: `NEW_GAME_FAILED:${String(e?.message || e)}` });
  }
}
