export const SUPER_ADMIN_CREATOR_ID = "u_15913144463";

export function isSuperAdminId(creatorId: string | null | undefined) {
  return !!creatorId && creatorId === SUPER_ADMIN_CREATOR_ID;
}

