import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
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
      gender: creators.gender,
      age: creators.age,
      city: creators.city,
    })
    .from(creators)
    .where(eq(creators.phone, sess.phone))
    .limit(1);

  if (!row?.id) redirect("/login");

  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>个人资料</h1>
          <p className="desc">简洁优雅地展示你的信息。</p>
        </header>

        <section className="creatorList">
          <ProfileEditForm initial={row} profilePath={`/creators/${row.id}`} />
        </section>

        <div className="homeFooter">
          <a className="btn btnSecondary" href={`/creators/${row.id}`}>
            返回个人主页
          </a>
        </div>
      </section>
    </main>
  );
}

