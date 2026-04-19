import CreateStudio from "./studio";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  return (
    <main className="wrap">
      <section className="card createCard">
        <header className="header">
          <div className="homeHeaderRow">
            <h1>创作我的游戏</h1>
            <div className="homeHeaderActions">
              <a className="homeCreateBtn" href="/">
                返回首页
              </a>
            </div>
          </div>
          <p className="desc">左侧和 AI 对话生成/修改小游戏；右侧实时预览最新生成的内容。</p>
        </header>

        <CreateStudio />
      </section>
    </main>
  );
}

