export const SUPER_ADMIN_CREATOR_IDS = new Set([
  // 初始管理员
  "u_15913144463",
  // 新增管理员
  "u_15986424209",
]);

export function isSuperAdminId(creatorId: string | null | undefined) {
  return !!creatorId && SUPER_ADMIN_CREATOR_IDS.has(creatorId);
}
