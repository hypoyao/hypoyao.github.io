import { notFound } from "next/navigation";
import { getCreatorById, listGamesByCreator } from "@/lib/db/queries";
import { getSession } from "@/lib/auth/session";
import { ensureCreatorsAuthFields } from "@/lib/db/ensureCreatorsAuthFields";

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
  const creator = await getCreatorById(id);
  if (!creator) notFound();

  const games = await listGamesByCreator(id);
  const sess = await getSession();
  const isMe = !!sess?.phone && creator.phone && sess.phone === creator.phone;

  const gender = creator.gender || "未设置";
  const age = typeof creator.age === "number" && creator.age > 0 ? `${creator.age} 岁` : "未设置";
  const city = creator.city || "未设置";

  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>创作者</h1>
          <p className="desc">用 AI，释放孩子的奇思妙想，体验创造的快乐。</p>
          <p className="homeSub">点击作品卡片进入小游戏。</p>
        </header>

        <section className="creatorList" aria-label="creator">
          <section className="creatorCard" aria-label={`creator-${creator.id}`}>
            <div className="creatorHead">
              <img className="creatorAvatar" src={creator.avatarUrl} alt={`${creator.name}头像`} />
              <div className="creatorInfo">
                <div className="creatorName">{creator.name}</div>
                <div className="creatorTag">
                  <span className="creatorTagItem">性别：{gender}</span>
                  <span className="creatorTagSep">·</span>
                  <span className="creatorTagItem">年龄：{age}</span>
                  <span className="creatorTagSep">·</span>
                  <span className="creatorTagItem">城市：{city}</span>
                </div>
              </div>
            </div>

            {isMe ? (
              <div className="creatorActions">
                <a className="btn btnGray" href="/profile/edit">
                  编辑资料
                </a>
              </div>
            ) : null}

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
