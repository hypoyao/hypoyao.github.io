import { notFound } from "next/navigation";
import { getCreatorById, listGamesByCreator } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

function toGameEntryHref(path: string) {
  return path.endsWith("/") ? `${path}index.html` : path;
}

export default async function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const creator = await getCreatorById(id);
  if (!creator) notFound();

  const games = await listGamesByCreator(id);

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
                <div className="creatorTag">作品集</div>
              </div>
            </div>

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
