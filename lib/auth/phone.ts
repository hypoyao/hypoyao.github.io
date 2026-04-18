import crypto from "node:crypto";

export function normalizePhone(raw: string) {
  const s = (raw || "").trim();
  // 只保留数字，兼容 +86
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 11) return digits;
  if (digits.length === 13 && digits.startsWith("86")) return digits.slice(2);
  return "";
}

export function maskPhone(phone: string) {
  if (!phone) return "";
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

export function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

