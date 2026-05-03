import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { safeProfilePathForCreatorId } from "@/lib/creatorProfilePath";
import ProfileEditForm from "./ProfileEditForm";

export const dynamic = "force-dynamic";

export default async function ProfileEditPage() {
  const sess = await getSession();
  if (!sess?.phone) redirect("/login");

  try {
    await ensureCreatorsAuthFields();
  } catch {}

  const [row] = await db
    .select({
      id: creators.id,
      name: creators.name,
      avatarUrl: creators.avatarUrl,
      profilePath: creators.profilePath,
      gender: creators.gender,
      age: creators.age,
      city: creators.city,
    })
    .from(creators)
    .where(eq(creators.phone, sess.phone))
    .limit(1);

  if (!row?.id) redirect("/login");
  const profilePath = row.profilePath || safeProfilePathForCreatorId(row.id);

  return (
    <main className="wrap">
      <section className="card homeCard createBento">
        <header className="header">
          <h1>个人资料</h1>
          <p className="desc">简洁优雅地展示你的信息。</p>
        </header>

        <section className="creatorList">
          <ProfileEditForm initial={row} profilePath={profilePath} />
        </section>
      </section>
    </main>
  );
}
