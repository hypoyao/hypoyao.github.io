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

export function genCuteName(seed: string) {
  const prefixes = ["小", "奶糖", "豆豆", "星星", "软软", "糯米", "泡泡", "团子", "芝士", "可可"];
  const animals = ["熊猫", "海豹", "小猫", "小狗", "兔兔", "松鼠", "小鹿", "企鹅", "小狐狸", "小仓鼠"];
  const h = sha256Hex(seed || String(Math.random()));
  const a = parseInt(h.slice(0, 8), 16);
  const b = parseInt(h.slice(8, 16), 16);
  const p = prefixes[a % prefixes.length];
  const an = animals[b % animals.length];
  const n = String((a + b) % 100).padStart(2, "0");
  return `${p}${an}${n}`;
}

export function genCuteAvatarDataUrl(seed: string) {
  // 生成一个简洁可爱的 SVG 头像（稳定：同 seed 得到同样头像）
  const h = sha256Hex(seed || String(Math.random()));
  const a = parseInt(h.slice(0, 8), 16);
  const b = parseInt(h.slice(8, 16), 16);
  const c = parseInt(h.slice(16, 24), 16);
  const palettes = [
    ["#fde68a", "#fca5a5"], // 黄-粉
    ["#bfdbfe", "#a7f3d0"], // 蓝-绿
    ["#ddd6fe", "#fbcfe8"], // 紫-粉
    ["#bbf7d0", "#fecaca"], // 绿-红
    ["#fed7aa", "#bae6fd"], // 橙-蓝
  ];
  const [bg1, bg2] = palettes[a % palettes.length];
  const ear = ["#0f172a", "#111827", "#1f2937", "#334155"][b % 4];
  const face = ["#ffffff", "#f8fafc", "#fff7ed"][c % 3];
  const blush = ["#fb7185", "#fda4af", "#f59e0b"][((a + b) >>> 0) % 3];

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg1}"/>
      <stop offset="1" stop-color="${bg2}"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="rgba(2,6,23,0.18)"/>
    </filter>
  </defs>
  <rect width="256" height="256" rx="48" fill="url(#g)"/>
  <g filter="url(#s)">
    <!-- ears -->
    <circle cx="78" cy="92" r="32" fill="${ear}"/>
    <circle cx="178" cy="92" r="32" fill="${ear}"/>
    <!-- face -->
    <circle cx="128" cy="140" r="78" fill="${face}"/>
    <!-- eyes -->
    <circle cx="104" cy="138" r="8" fill="#0f172a"/>
    <circle cx="152" cy="138" r="8" fill="#0f172a"/>
    <!-- mouth -->
    <path d="M116 164 Q128 176 140 164" fill="none" stroke="#0f172a" stroke-width="6" stroke-linecap="round"/>
    <!-- blush -->
    <circle cx="88" cy="158" r="10" fill="${blush}" opacity="0.28"/>
    <circle cx="168" cy="158" r="10" fill="${blush}" opacity="0.28"/>
  </g>
</svg>`;

  const b64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}
