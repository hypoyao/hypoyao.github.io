import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { isSuperAdminId } from "@/lib/auth/admin";

export async function requireAdminCreator() {
  const sess = await getSession();
  if (!sess?.phone && !sess?.openid) return { ok: false as const, error: "UNAUTHORIZED" as const, creatorId: null };

  try {
    await ensureCreatorsAuthFields();
  } catch {
    // ignore
  }

  let creatorId: string | null = null;
  try {
    if (sess.phone) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, sess.phone)).limit(1);
      creatorId = row?.id || null;
    } else if (sess.openid) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, sess.openid)).limit(1);
      creatorId = row?.id || null;
    }
  } catch {
    creatorId = null;
  }

  if (!isSuperAdminId(creatorId)) return { ok: false as const, error: "FORBIDDEN" as const, creatorId };
  return { ok: true as const, error: null, creatorId };
}
