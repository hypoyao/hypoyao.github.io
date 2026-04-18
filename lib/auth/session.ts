import { cookies } from "next/headers";
import crypto from "node:crypto";

export type Session = {
  openid?: string;
  phone?: string;
};

const SESSION_COOKIE = "xq_session";

function getSecret() {
  const s = process.env.AUTH_COOKIE_SECRET;
  if (!s) throw new Error("Missing AUTH_COOKIE_SECRET env var");
  return s;
}

function b64url(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sign(payload: string) {
  const mac = crypto.createHmac("sha256", getSecret()).update(payload).digest();
  return b64url(mac);
}

export function encodeSession(sess: Session) {
  const payload = JSON.stringify(sess);
  const sig = sign(payload);
  return `${b64url(Buffer.from(payload, "utf8"))}.${sig}`;
}

export function decodeSession(raw: string | undefined | null): Session | null {
  if (!raw) return null;
  const [p, sig] = raw.split(".");
  if (!p || !sig) return null;
  let payload = "";
  try {
    payload = Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
  const expect = sign(payload);
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(payload);
    const openid = typeof obj?.openid === "string" ? obj.openid : undefined;
    const phone = typeof obj?.phone === "string" ? obj.phone : undefined;
    if (!openid && !phone) return null;
    return { openid, phone };
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  return decodeSession(raw);
}

export const sessionCookieName = SESSION_COOKIE;
