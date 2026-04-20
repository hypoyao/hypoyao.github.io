import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { getSession } from "@/lib/auth/session";
import { profileTokenFromCreatorId } from "@/lib/creatorProfilePath";

export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function parseImageDataUrl(s: string) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec((s || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  return { mime, b64 };
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });

  let body: { creatorId?: string; dataUrl?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const creatorId = typeof body.creatorId === "string" ? body.creatorId.trim() : "";
  if (!creatorId) return json(400, { ok: false, error: "MISSING_CREATOR_ID" });

  const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl.trim() : "";
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return json(400, { ok: false, error: "INVALID_IMAGE_DATAURL" });
  if (parsed.b64.length > 900_000) return json(400, { ok: false, error: "IMAGE_TOO_LARGE" });

  const ext = parsed.mime === "image/png" ? "png" : parsed.mime === "image/jpeg" ? "jpg" : "webp";
  const buf = Buffer.from(parsed.b64, "base64");
  if (buf.length > 900_000) return json(400, { ok: false, error: "IMAGE_TOO_LARGE" });

  // 文件名使用 profile token，避免把 creatorId（可能包含手机号）写进 URL
  const token = profileTokenFromCreatorId(creatorId);
  const outDir = path.join(process.cwd(), "public", "assets", "avatars", "uploads");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${token}.${ext}`);
  await fs.writeFile(outFile, buf);

  return json(200, { ok: true, avatarUrl: `/assets/avatars/uploads/${token}.${ext}` });
}

