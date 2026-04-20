import CreateStudio from "./studio";
import TopActions from "./TopActions";

export const dynamic = "force-dynamic";

export default function CreatePage() {
  return (
    <main className="wrap">
      <section className="card createCard createBento">
        <header className="header">
          <div className="homeHeaderRow">
            <h1>创作我的游戏</h1>
            <div className="homeHeaderActions">
              <TopActions />
            </div>
          </div>
        </header>

        <CreateStudio />
      </section>
    </main>
  );
}
