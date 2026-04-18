import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { genCode, normalizePhone, sha256Hex } from "@/lib/auth/phone";

const COOKIE = "phone_code_v1";

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  let body: { phone?: string } = {};
  try {
    body = (await req.json()) as { phone?: string };
  } catch {
    return json(400, { ok: false, error: "INVALID_JSON" });
  }

  const phone = normalizePhone(body.phone || "");
  if (!phone) return json(400, { ok: false, error: "INVALID_PHONE" });

  const code = genCode();
  const exp = Date.now() + 5 * 60 * 1000; // 5 min
  const payload = JSON.stringify({ phone, exp, hash: sha256Hex(`${phone}:${code}`) });

  const jar = await cookies();
  jar.set(COOKIE, payload, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 5 * 60,
  });

  // 临时方案：直接返回验证码（后续如接入短信服务商，再改为仅服务端发送）
  return json(200, { ok: true, tempCode: code });
}
