import { listGames } from "@/lib/db/queries";
import { featuredGamesByEngagement } from "@/lib/gameSorting";
import HomeAccount from "./HomeAccount";
import CoverImage from "./components/CoverImage";

// 首页尽量走静态 + ISR：首屏秒开（CDN 缓存），后台定期更新
export const dynamic = "force-static";
export const revalidate = 60;

function toGameEntryHref(path: string) {
  // 统一走 /games/<id>/（由 app route 输出“两栏壳”页面；游戏本体在 iframe 的 /__raw/ 下）
  return path.endsWith("/") ? path : `${path}/`;
}

export default async function HomePage() {
  const games = await listGames();
  const featuredGames = featuredGamesByEngagement(games);

  return (
    <main className="homePage simpleHomePage">
      <nav className="homeNav" aria-label="首页导航">
        <a className="homeLogo" href="/" aria-label="奇点小匠首页">
          <span>奇点小匠</span>
        </a>
        <div className="homeNavLinks">
          <a className="isActive" href="/">
            首页
          </a>
          <a href="/works">社区作品</a>
          <a href="/teachers">老师/学校/机构</a>
          <a href="#contact">联系我们</a>
        </div>
        <div className="homeNavActions">
          <HomeAccount />
        </div>
      </nav>

      <section className="card homeCard homeNew simpleHomeContent">
        <section className="homeHeroGrid" aria-label="hero">
          <section className="heroPanel" aria-label="main call to action">
            <h1 className="heroTitle">用 AI 对话，让创意成真</h1>
            <p className="heroDesc">描述需求、迭代功能、即时预览。一句话开始创作，把作品分享给更多人。</p>

            <a className="heroStartBtn" href="/create" aria-label="开始创作小游戏">
              开始创作
              <span aria-hidden="true">→</span>
            </a>
          </section>
        </section>

        <section className="homeSection" aria-label="all works">
          <div className="sectionHead">
            <h2 className="sectionTitle">精选作品</h2>
            <a className="sectionMoreLink" href="/works">
              全部作品
            </a>
          </div>
          <section className="gameGrid homeWallGrid" aria-label="game list">
            {featuredGames.map((g) => (
              <article key={g.id} className="gameItem" aria-label={g.title}>
                <a className="gameLink" href={toGameEntryHref(g.path)} aria-label={`打开游戏：${g.title}`}>
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
              </article>
            ))}
          </section>
        </section>
      </section>

      <section id="contact" className="homeContact" aria-label="联系我们">
        <div className="contactCopy">
          <span>联系我们</span>
          <h2>想了解内测、合作或使用方式？</h2>
          <p>欢迎扫码添加微信，告诉我你的使用场景和想做的互动内容。</p>
        </div>
        <div className="contactQrCard">
          <img src="/assets/screenshots/qrcode.png" alt="奇点小匠微信二维码" loading="lazy" />
          <strong>扫码添加微信</strong>
          <small>内测反馈 / 教育合作 / 使用咨询</small>
        </div>
      </section>
    </main>
  );
}
