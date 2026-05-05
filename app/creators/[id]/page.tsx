import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { creators as creatorsTable } from "@/lib/db/schema";
import { getCreatorById, getCreatorByProfilePath, listGamesByCreator } from "@/lib/db/queries";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";
import { safeProfilePathForCreatorId } from "@/lib/creatorProfilePath";

export const dynamic = "force-dynamic";

function toGameEntryHref(path: string) {
  return path.endsWith("/") ? path : `${path}/`;
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
              <h1 className="creatorTopName">
                <span>{creator.name}</span>
                {isMe ? (
                  <a className="iconMiniBtn" href="/profile/edit" aria-label="编辑资料">
                    {/* pencil */}
                    <svg className="iconMiniSvg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 20h9"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </a>
                ) : null}
              </h1>
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
            <div className="creatorTopActions">
              {isMe ? (
                <form action="/api/auth/logout" method="post">
                  <button className="iconMiniBtn" type="submit" aria-label="退出登录" title="退出登录">
                    <svg className="iconMiniSvg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M10 17l5-5-5-5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <path d="M15 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path
                        d="M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </form>
              ) : null}
              <Link className="iconMiniBtn" href="/" aria-label="回到主页" prefetch>
                {/* home */}
                <svg className="iconMiniSvg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M3 10.5 12 3l9 7.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5.5 10.5V21h13V10.5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M10 21v-6h4v6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            </div>
          </div>
        </header>

        <section className="creatorList" aria-label="作品列表">
          {games.length ? (
            <section className="gameGrid creatorWorks creatorWorksWall" aria-label={`${creator.name}的作品`}>
              {games.map((g) => (
                <article key={g.id} className="gameItem" aria-label={g.title}>
                  <a className="gameLink" href={toGameEntryHref(g.path)} aria-label={`打开游戏：${g.title}`}>
                    <img className="gameThumb" src={g.coverUrl} alt={`${g.title}截图`} loading="lazy" decoding="async" />
                    <div className="gameBody">
                      <div className="gameName">{g.title}</div>
                      <div className="gameDesc">{g.shortDesc}</div>
                      {g.playCount >= 3 || g.likeCount >= 1 ? (
                        <div className="gameStatRow" aria-label="游戏数据">
                          {g.playCount >= 3 ? <span className="gameStatChip">玩过 {g.playCount}</span> : null}
                          {g.likeCount >= 1 ? <span className="gameStatChip">点赞 {g.likeCount}</span> : null}
                        </div>
                      ) : null}
                    </div>
                  </a>
                </article>
              ))}
            </section>
          ) : (
            <div className="worksEmpty creatorWorksEmpty">还没有公开作品。</div>
          )}
        </section>

        {/* 右上角已提供“回到主页”图标 */}
      </section>
    </main>
  );
}
