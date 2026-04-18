import crypto from "node:crypto";

export function isWeChatUA(ua: string | null | undefined) {
  if (!ua) return false;
  return /MicroMessenger/i.test(ua);
}

export function getSiteUrl() {
  // 线上建议在 Vercel 里设置 SITE_URL=https://你的域名
  const site = process.env.SITE_URL;
  if (site) return site.replace(/\/+$/g, "");
  // fallback: vercel 会注入 VERCEL_URL（不带协议）
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  // 本地 fallback
  return "http://localhost:3000";
}

export function getMpAppId() {
  const v = process.env.WECHAT_MP_APPID;
  if (!v) throw new Error("Missing WECHAT_MP_APPID env var");
  return v;
}
export function getMpSecret() {
  const v = process.env.WECHAT_MP_SECRET;
  if (!v) throw new Error("Missing WECHAT_MP_SECRET env var");
  return v;
}

export function newState() {
  return crypto.randomBytes(16).toString("hex");
}

