import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";

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
  const id = genId();
  const base = path.join(process.cwd(), "public", "games", id);
  await fs.mkdir(base, { recursive: true });
  return json(200, { ok: true, gameId: id, entry: `/games/${id}/index.html` });
}

