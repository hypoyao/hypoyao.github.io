import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { safeProfilePathForCreatorId } from "@/lib/creatorProfilePath";
import type { CreatorActorIdentity } from "@/lib/creator/creatorIndex";

type SessLike = { phone?: string; openid?: string } | null;

async function registeredCreatorId(sess: SessLike) {
  const phone = String(sess?.phone || "").trim();
  const openid = String(sess?.openid || "").trim();
  if (!phone && !openid) return null;
  await ensureCreatorsAuthFields();
  try {
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

export async function getOrCreateCreatorIdForActor(sess: SessLike, actor: CreatorActorIdentity) {
  const registeredId = await registeredCreatorId(sess);
  if (registeredId) return registeredId;

  if (actor.actorType !== "guest" || !actor.ownerKey) return null;
  await ensureCreatorsAuthFields();
  const creatorId = actor.ownerKey;
  const suffix = creatorId.slice(-6);
  const name = `游客${suffix}`;
  const avatarUrl = "/assets/avatars/user.svg";
  const profilePath = safeProfilePathForCreatorId(creatorId);

  await db.execute(sql`
    insert into creators (id, name, avatar_url, profile_path)
    values (${creatorId}, ${name}, ${avatarUrl}, ${profilePath})
    on conflict (id) do update set
      updated_at = now()
  `);
  return creatorId;
}
