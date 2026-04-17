import { listGames } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

function toGameEntryHref(path: string) {
  // public/ 下的静态小游戏实际入口是 /games/<id>/index.html
  // 为了避免目录 URL 在某些情况下被 Next 误判为“缺少路由”，这里直接指向 index.html
  return path.endsWith("/") ? `${path}index.html` : path;
}

export default async function HomePage() {
  const games = await listGames();

  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>AI创意小游戏</h1>
          <p className="desc">用 AI，释放孩子的奇思妙想，体验创造的快乐。</p>
        </header>

        <section className="gameGrid" aria-label="game list">
          {games.map((g) => (
            <a key={g.id} className="gameItem" href={toGameEntryHref(g.path)} aria-label={g.title}>
              <img className="gameThumb" src={g.coverUrl} alt={`${g.title}截图`} />
              <div>
                <div className="gameName">{g.title}</div>
                <div className="gameDesc">{g.shortDesc}</div>
                <div className="gameMeta">创作者：{g.creator.name}</div>
              </div>
            </a>
          ))}
        </section>
      </section>
    </main>
  );
}
