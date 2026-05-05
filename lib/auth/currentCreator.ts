import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { creators } from "@/lib/db/schema";

export async function getCurrentCreatorId() {
  const sess = await getSession();
  const phone = String(sess?.phone || "").trim();
  const openid = String(sess?.openid || "").trim();
  if (!phone && !openid) return null;

  try {
    await ensureCreatorsAuthFields();
    if (phone) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.phone, phone)).limit(1);
      return row?.id || null;
    }
    if (openid) {
      const [row] = await db.select({ id: creators.id }).from(creators).where(eq(creators.openid, openid)).limit(1);
      return row?.id || null;
    }
  } catch {
    return null;
  }
  return null;
}
