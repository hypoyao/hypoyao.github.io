import CreateStudio from "./studio";
import TopActions from "./TopActions";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams?: Promise<{ prompt?: string }> }) {
  const sp = searchParams ? await searchParams : ({} as any);
  const initialPrompt = typeof sp?.prompt === "string" ? sp.prompt.slice(0, 800) : "";
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

        <CreateStudio initialPrompt={initialPrompt} />
      </section>
    </main>
  );
}
