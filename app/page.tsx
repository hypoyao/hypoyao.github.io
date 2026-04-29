import { listGames } from "@/lib/db/queries";
import HomeAccount from "./HomeAccount";
import HomePromptLauncher from "./HomePromptLauncher";

// 首页尽量走静态 + ISR：首屏秒开（CDN 缓存），后台定期更新
export const dynamic = "force-static";
export const revalidate = 60;

function toGameEntryHref(path: string) {
  // 统一走 /games/<id>/（由 app route 输出“两栏壳”页面；游戏本体在 iframe 的 /__raw/ 下）
  return path.endsWith("/") ? path : `${path}/`;
}

export default async function HomePage() {
  const games = await listGames();

  return (
    <main className="wrap">
      <section className="card homeCard homeNew">
        <header className="header">
          <div className="homeHeaderRow">
            <div className="homeBrand">
              <h2 className="sectionTitle homeBrandTitle">奇点小匠</h2>
            </div>
            <div className="homeHeaderActions">
              <HomeAccount />
            </div>
          </div>
        </header>

        <section className="homeHeroGrid" aria-label="hero">
          <section className="heroPanel" aria-label="main call to action">
            <h1 className="heroTitle">用 AI 对话，让创意成真</h1>
            <p className="heroDesc">描述需求、迭代功能、即时预览。一句话开始创作，把作品分享给更多人。</p>

            <HomePromptLauncher />
          </section>
        </section>

        <section className="homeSection" aria-label="all works">
          <div className="sectionHead">
            <h2 className="sectionTitle">精选作品</h2>
          </div>
          <section className="gameGrid" aria-label="game list">
            {games.map((g) => (
              <div key={g.id} className="gameItem" aria-label={g.title}>
                <a className="gameLink" href={toGameEntryHref(g.path)} aria-label={`打开游戏：${g.title}`}>
                  <img className="gameThumb" src={g.coverUrl} alt={`${g.title}截图`} loading="lazy" decoding="async" />
                  <div>
                    <div className="gameName">{g.title}</div>
                    <div className="gameDesc">{g.shortDesc}</div>
                    {g.playCount >= 3 || g.likeCount >= 1 ? (
                      <div className="gameStatRow" aria-label="游戏数据">
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
              </div>
            ))}
          </section>
        </section>
      </section>
    </main>
  );
}
