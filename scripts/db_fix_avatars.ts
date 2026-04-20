import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq } from "drizzle-orm";
import { creators } from "../lib/db/schema";
import { profileTokenFromCreatorId } from "../lib/creatorProfilePath";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const s = fs.readFileSync(p, "utf8");
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseDataUrl(s: string) {
  const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([a-z0-9+/=]+)$/i.exec((s || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "svg";
  return { mime, ext, b64 };
}

/**
 * 把 creators.avatar_url 里存的 dataURL 迁移到 public/assets/avatars/uploads/，
 * 并把 DB 字段改成相对路径（避免 base64 进数据库）。
 *
 * 用法：
 *   npx tsx scripts/db_fix_avatars.ts --dry-run
 *   npx tsx scripts/db_fix_avatars.ts
 */
async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL in .env.local");

  const dryRun = process.argv.includes("--dry-run");
  const db = drizzle(neon(url));

  const rows = await db.select({ id: creators.id, avatarUrl: creators.avatarUrl }).from(creators);
  const todo = rows
    .filter((r) => typeof r.avatarUrl === "string" && r.avatarUrl.startsWith("data:image/"))
    .map((r) => ({ id: r.id, avatarUrl: r.avatarUrl }));

  console.log(`FOUND ${todo.length} creators with dataURL avatar`);
  if (dryRun) return;

  const outDir = path.join(process.cwd(), "public", "assets", "avatars", "uploads");
  await fsp.mkdir(outDir, { recursive: true });

  for (const r of todo) {
    const parsed = parseDataUrl(r.avatarUrl);
    if (!parsed) continue;
    const token = profileTokenFromCreatorId(r.id);
    const fileName = `${token}.${parsed.ext}`;
    const outFile = path.join(outDir, fileName);
    const buf = Buffer.from(parsed.b64, "base64");
    await fsp.writeFile(outFile, buf);

    const newUrl = `/assets/avatars/uploads/${fileName}`;
    await db.update(creators).set({ avatarUrl: newUrl, updatedAt: new Date() }).where(eq(creators.id, r.id));
    console.log(`UPDATED ${r.id} -> ${newUrl}`);
  }

  console.log("DONE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

