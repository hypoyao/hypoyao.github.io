import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators as creatorsTable } from "@/lib/db/schema";
import { getCreatorById, getCreatorByProfilePath, listGamesByCreator } from "@/lib/db/queries";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { safeProfilePathForCreatorId } from "@/lib/creatorProfilePath";

export const dynamic = "force-dynamic";

function toGameEntryHref(path: string) {
  return path.endsWith("/") ? `${path}index.html` : path;
}

export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 确保新字段存在（gender/age/city 等）
  try {
    await ensureCreatorsAuthFields();
  } catch {}
  // 隐私：URL 不使用 creators.id（可能包含手机号），而使用 creators.profilePath 中的 token
  let creator = await getCreatorByProfilePath(`/creators/${id}`);
  if (!creator) {
    // 兼容旧链接：/creators/<creatorId>，命中后立即跳转到安全链接
    const legacy = await getCreatorById(id);
    if (legacy) {
      const safe = safeProfilePathForCreatorId(legacy.id);
      // 顺便把 profilePath 迁移成安全路径
      try {
        await db.update(creatorsTable).set({ profilePath: safe, updatedAt: new Date() }).where(eq(creatorsTable.id, legacy.id));
      } catch {}
      redirect(safe);
    }
    notFound();
  }

  const games = await listGamesByCreator(creator.id);
  const sess = await getSession();
  const isMe = !!sess?.phone && creator.phone && sess.phone === creator.phone;

  const gender = creator.gender ? `性别：${creator.gender}` : null;
  const age = typeof creator.age === "number" && creator.age > 0 ? `年龄：${creator.age} 岁` : null;
  const city = creator.city ? `城市：${creator.city}` : null;
  const tags = [gender, age, city].filter(Boolean) as string[];

  return (
    <main className="wrap">
      <section className="card homeCard createBento">
        <header className="header">
          <div className="creatorTop">
            <img className="creatorAvatar creatorAvatarLg" src={creator.avatarUrl} alt={`${creator.name}头像`} />
            <div className="creatorTopInfo">
              <h1 className="creatorTopName">{creator.name}</h1>
              {tags.length > 0 ? (
                <div className="creatorTag">
                  {tags.map((t, i) => (
                    <span key={t}>
                      <span className="creatorTagItem">{t}</span>
                      {i < tags.length - 1 ? <span className="creatorTagSep">·</span> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {isMe ? (
              <div className="creatorTopActions">
                <a className="btn btnGray" href="/profile/edit">
                  编辑资料
                </a>
              </div>
            ) : null}
          </div>
        </header>

        <section className="creatorList" aria-label="creator">
          <section className="creatorCard" aria-label="creator-card">
            <div className="creatorWorks">
              {games.map((g) => (
                <a key={g.id} className="gameItem gameItemCompact" href={toGameEntryHref(g.path)} aria-label={g.title}>
                  <img className="gameThumb" src={g.coverUrl} alt={`${g.title}截图`} />
                  <div>
                    <div className="gameName">{g.title}</div>
                    <div className="gameDesc">{g.shortDesc}</div>
                  </div>
                </a>
              ))}
            </div>
          </section>
        </section>

        <div className="homeFooter">
          <a className="btn btnSecondary" href="/">
            返回首页
          </a>
        </div>
      </section>
    </main>
  );
}
