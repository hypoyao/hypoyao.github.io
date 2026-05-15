import { listGames } from "@/lib/db/queries";
import { sortGamesByEngagement } from "@/lib/gameSorting";
import HomeAccount from "../HomeAccount";
import CoverImage from "../components/CoverImage";

export const dynamic = "force-static";
export const revalidate = 60;

function toGameEntryHref(path: string) {
  return path.endsWith("/") ? path : `${path}/`;
}

export default async function WorksPage() {
  const games = await listGames();
  const sortedGames = sortGamesByEngagement(games);

  return (
    <main className="homePage worksPage">
      <nav className="homeNav" aria-label="作品页导航">
        <a className="homeLogo" href="/" aria-label="奇点小匠首页">
          <span>奇点小匠</span>
        </a>
        <div className="homeNavLinks">
          <a href="/">首页</a>
          <a className="isActive" href="/works">
            社区作品
          </a>
          <a href="/teachers">老师/学校/机构</a>
          <a href="/#contact">联系我们</a>
        </div>
        <div className="homeNavActions">
          <HomeAccount />
        </div>
      </nav>

      <section className="worksGridWrap" aria-label="全部社区作品">
        {games.length ? (
          <section className="gameGrid worksGameGrid" aria-label="game list">
            {sortedGames.map((g) => (
              <article key={g.id} className="gameItem" aria-label={g.title}>
                <a className="gameLink" href={toGameEntryHref(g.path)} aria-label={`打开作品：${g.title}`}>
                  <CoverImage
                    className="gameThumb"
                    src={g.coverUrl}
                    fallbackKey={g.id}
                    alt={`${g.title}截图`}
                    loading="lazy"
                    decoding="async"
                  />
                  <div className="gameBody">
                    <div className="gameName">{g.title}</div>
                    <div className="gameDesc">{g.shortDesc}</div>
                    {g.playCount >= 3 || g.likeCount >= 1 ? (
                      <div className="gameStatRow" aria-label="作品数据">
                        {g.playCount >= 3 ? <span className="gameStatChip">玩过 {g.playCount}</span> : null}
                        {g.likeCount >= 1 ? <span className="gameStatChip">点赞 {g.likeCount}</span> : null}
                      </div>
                    ) : null}
                    <div className="gameMetaRow">
                      <img className="gameMetaAvatar" src={g.creator.avatarUrl} alt={`${g.creator.name}头像`} />
                      <span className="gameMeta">创作者：{g.creator.name}</span>
                    </div>
                  </div>
                </a>
              </article>
            ))}
          </section>
        ) : (
          <div className="worksEmpty">还没有公开作品，先去创建一个吧。</div>
        )}
      </section>
    </main>
  );
}
