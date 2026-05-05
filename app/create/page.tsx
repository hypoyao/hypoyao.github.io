import CreateStudio from "./studio";
import TopActions from "./TopActions";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CreatePage({
  searchParams,
}: {
  searchParams?: Promise<{ prompt?: string; promptKey?: string; auto?: string; id?: string }>;
}) {
  const sp = searchParams ? await searchParams : ({} as any);
  const initialPrompt = typeof sp?.prompt === "string" ? sp.prompt.slice(0, 800) : "";
  const initialPromptKey = typeof sp?.promptKey === "string" ? sp.promptKey.trim().slice(0, 120) : "";
  // 只允许带随机 promptKey 的入口自动启动；raw prompt 即使在 URL 里，也只作为预填，不自动开跑。
  const autoStart = typeof sp?.auto === "string" && sp.auto === "1" && !!initialPromptKey;
  const initialGameId = typeof sp?.id === "string" ? sp.id.trim().slice(0, 80) : "";

  // 清理无效 auto=1（避免用户带空 key/空内容进入奇怪状态）
  if (typeof sp?.auto === "string" && sp.auto === "1" && !initialPromptKey && !initialPrompt.trim() && !initialGameId) {
    redirect("/create");
  }

  return (
    <>
      <div className="createPageMarker" aria-hidden="true" />
      <main className="wrap createWrap">
        <section className="card createCard createBento">
          <header className="header">
            <div className="homeHeaderRow">
              <h1>创作我的游戏</h1>
              <div className="homeHeaderActions">
                <TopActions />
              </div>
            </div>
          </header>

          <CreateStudio
            initialPrompt={initialPrompt}
            initialPromptKey={initialPromptKey}
            autoStart={autoStart}
            initialGameId={initialGameId}
          />
        </section>
      </main>
    </>
  );
}
