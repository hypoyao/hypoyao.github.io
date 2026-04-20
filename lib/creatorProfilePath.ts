import crypto from "node:crypto";

// 为避免在 URL 中暴露 creators.id（可能包含手机号等隐私），
// 我们用稳定哈希生成一个“公开 profile token”。
export function profileTokenFromCreatorId(creatorId: string) {
  const h = crypto.createHash("sha256").update(String(creatorId)).digest("hex");
  // 取前 10 位足够短且冲突概率极低
  return `p_${h.slice(0, 10)}`;
}

export function safeProfilePathForCreatorId(creatorId: string) {
  return `/creators/${profileTokenFromCreatorId(creatorId)}`;
}

