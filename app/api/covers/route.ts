import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { put } from "@vercel/blob";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

function normalizeId(id: string) {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function parseImageDataUrl(s: string) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec((s || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  return { mime, b64 };
}

function hasBlobToken() {
  return !!String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
}

function runningOnVercel() {
  return !!String(process.env.VERCEL || "").trim();
}

export async function POST(req: Request) {
  const sess = await getSession();
  if (!sess) return json(401, { ok: false, error: "UNAUTHORIZED" });

  let body: { id?: string; dataUrl?: string };
  try {
    body = (await req.json()) as any;
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const id = typeof body.id === "string" ? normalizeId(body.id) : "";
  if (!id) return json(400, { ok: false, error: "MISSING_ID" });

  const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl.trim() : "";
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return json(400, { ok: false, error: "INVALID_IMAGE_DATAURL" });
  if (parsed.b64.length > 1_200_000) return json(400, { ok: false, error: "IMAGE_TOO_LARGE" });

  const ext = parsed.mime === "image/png" ? "png" : parsed.mime === "image/jpeg" ? "jpg" : "webp";
  const buf = Buffer.from(parsed.b64, "base64");
  if (buf.length > 1_200_000) return json(400, { ok: false, error: "IMAGE_TOO_LARGE" });

  if (hasBlobToken()) {
    const blob = await put(`covers/${id}.${ext}`, buf, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: parsed.mime,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
    return json(200, { ok: true, coverUrl: blob.url, storage: "vercel-blob" });
  }

  if (runningOnVercel()) {
    return json(500, { ok: false, error: "MISSING_BLOB_READ_WRITE_TOKEN" });
  }

  const outDir = path.join(process.cwd(), "public", "assets", "covers");
  await fs.mkdir(outDir, { recursive: true });

  const outFile = path.join(outDir, `${id}.${ext}`);
  await fs.writeFile(outFile, buf);

  return json(200, { ok: true, coverUrl: `/assets/covers/${id}.${ext}`, storage: "local-file" });
}
