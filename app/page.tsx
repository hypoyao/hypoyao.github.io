import { listGames } from "@/lib/db/queries";
import HomeAccount from "./HomeAccount";

// 首页尽量走静态 + ISR：首屏秒开（CDN 缓存），后台定期更新
export const dynamic = "force-static";
export const revalidate = 300;

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

            <form className="heroInputRow" action="/create" method="GET">
              <input
                className="heroInput"
                name="prompt"
                placeholder="输入一句话，例如：做一个打地鼠小游戏，带难度等级、音效和排行榜"
                autoComplete="off"
              />
              <input type="hidden" name="auto" value="1" />
              <button className="heroCtaBtn" type="submit">
                开始创建
              </button>
            </form>

            <div className="heroChips" aria-label="prompt templates">
              <a className="heroChip" href="/create?auto=1&prompt=%E6%88%91%E6%83%B3%E5%81%9A%E4%B8%80%E4%B8%AA%E6%89%93%E5%9C%B0%E9%BC%A0%E6%B8%B8%E6%88%8F%EF%BC%8C%E4%B8%BB%E8%A7%92%E6%98%AF%E4%B8%80%E5%8F%AA%E5%81%B7%E5%90%83%E7%9A%84%E5%B0%8F%E7%8C%AB%EF%BC%8C%E8%A6%81%E6%9C%89%E5%A3%B0%E9%9F%B3%E6%95%88%E6%9E%9C%E5%92%8C%E9%9A%BE%E5%BA%A6%E7%AD%89%E7%BA%A7%E3%80%82">
                示例：打地鼠小猫
              </a>
              <a className="heroChip" href="/create?auto=1&prompt=%E6%88%91%E6%83%B3%E5%81%9A%E4%B8%80%E4%B8%AA%E8%8B%B1%E8%AF%AD%E5%8D%95%E8%AF%8D%E8%AE%B0%E5%BF%86%E6%B8%B8%E6%88%8F%EF%BC%8C%E6%AF%8F%E6%AC%A1%E9%97%AE%E4%B8%80%E9%81%93%E9%A2%98%EF%BC%8C%E7%AD%94%E5%AF%B9%E5%8A%A0%E5%88%86%EF%BC%8C%E7%AD%94%E9%94%99%E6%8F%90%E7%A4%BA%E3%80%82">
                示例：英语单词记忆
              </a>
              <a className="heroChip" href="/create?auto=1&prompt=%E6%88%91%E6%83%B3%E5%81%9A%E4%B8%80%E4%B8%AA%E5%8F%AF%E7%88%B1%E7%9A%84%E8%B7%B3%E8%B7%B3%E7%90%83%E6%B8%B8%E6%88%8F%EF%BC%8C%E8%83%8C%E6%99%AF%E6%B8%90%E5%8F%98%EF%BC%8C%E8%A6%81%E6%9C%89%E6%8E%92%E8%A1%8C%E6%A6%9C%E5%92%8C%E6%88%90%E5%B0%B1%E3%80%82">
                示例：跳跳球成就
              </a>
            </div>
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
