import CreateStudio from "./studio";
import TopActions from "./TopActions";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function CreatePage({
  searchParams,
}: {
  searchParams?: Promise<{ prompt?: string; auto?: string; id?: string }>;
}) {
  const sp = searchParams ? await searchParams : ({} as any);
  const initialPrompt = typeof sp?.prompt === "string" ? sp.prompt.slice(0, 800) : "";
  // auto=1 仅在 prompt 非空时才有意义；否则会造成“看似要自动开始但其实没内容”的误导
  const autoStart = typeof sp?.auto === "string" && sp.auto === "1" && !!initialPrompt.trim();
  const initialGameId = typeof sp?.id === "string" ? sp.id.trim().slice(0, 80) : "";

  // 清理无效 auto=1（避免用户从首页不小心提交空 prompt 后进入奇怪状态）
  if (typeof sp?.auto === "string" && sp.auto === "1" && !initialPrompt.trim() && !initialGameId) {
    redirect("/create");
  }

  // 创作入口必须登录
  const sess = await getSession();
  if (!sess) {
    const qs = new URLSearchParams();
    if (initialPrompt) qs.set("prompt", initialPrompt);
    if (autoStart) qs.set("auto", "1");
    if (initialGameId) qs.set("id", initialGameId);
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

        <CreateStudio initialPrompt={initialPrompt} autoStart={autoStart} initialGameId={initialGameId} />
      </section>
    </main>
  );
}
