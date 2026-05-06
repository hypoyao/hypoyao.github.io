export const DEFAULT_COVER_URLS = [
  // 这些是“我的图片库”里预置的默认封面图（public/assets/covers & screenshots）
  "/assets/covers/jumpball.webp",
  "/assets/covers/minesweeper.webp",
  "/assets/covers/stick-duel.webp",
  "/assets/covers/wordschallenge.webp",
  "/assets/screenshots/默认封面图.png",
  "/assets/screenshots/默认封面图2.png",
] as const;

function hash32(s: string) {
  // 简单稳定 hash（FNV-1a 变体）
  let h = 2166136261 >>> 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function pickDefaultCoverUrl(seed: string) {
  const list = DEFAULT_COVER_URLS;
  if (!list.length) return "/assets/screenshots/默认封面图.png";
  const idx = hash32(seed) % list.length;
  return list[idx] as string;
}

