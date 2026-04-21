import CreateStudio from "./studio";
import TopActions from "./TopActions";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function CreatePage({ searchParams }: { searchParams?: Promise<{ prompt?: string; auto?: string }> }) {
  const sp = searchParams ? await searchParams : ({} as any);
  const initialPrompt = typeof sp?.prompt === "string" ? sp.prompt.slice(0, 800) : "";
  const autoStart = typeof sp?.auto === "string" && sp.auto === "1";

  // 创作入口必须登录
  const sess = await getSession();
  if (!sess) {
    const qs = new URLSearchParams();
    if (initialPrompt) qs.set("prompt", initialPrompt);
    if (autoStart) qs.set("auto", "1");
    const next = `/create${qs.toString() ? `?${qs.toString()}` : ""}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return (
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

        <CreateStudio initialPrompt={initialPrompt} autoStart={autoStart} />
      </section>
    </main>
  );
}
