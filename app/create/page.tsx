import CreateStudio from "./studio";
import TopActions from "./TopActions";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

function isWechatBrowser(userAgent: string) {
  return /micromessenger/i.test(String(userAgent || ""));
}

function WechatMiniProgramGuide() {
  return (
    <>
      <div className="createPageMarker" aria-hidden="true" />
      <main className="wrap createWrap">
        <section className="card createCard miniProgramGuideCard" aria-label="小程序创作引导">
          <div className="miniProgramGuideBadge">微信内创作请使用小程序</div>
          <h1>打开「妙点小匠」小程序继续创作</h1>
          <p>
            为了保证生成、预览和发布体验稳定，微信浏览器内不再进入 Web 创作台。请长按识别下方小程序码，在小程序里开始创作。
          </p>
          <div className="miniProgramCodeBox">
            <img src="/assets/screenshots/miniprogram-code.jpg" alt="妙点小匠小程序码" />
          </div>
          <div className="miniProgramGuideTips">
            <span>长按图片</span>
            <span>识别小程序码</span>
            <span>进入后开始创作</span>
          </div>
          <a className="miniProgramBackHome" href="/">
            返回首页
          </a>
        </section>
      </main>
    </>
  );
}

export default async function CreatePage({
  searchParams,
}: {
  searchParams?: Promise<{ prompt?: string; promptKey?: string; auto?: string; id?: string }>;
}) {
  const headerList = await headers();
  const userAgent = headerList.get("user-agent") || "";
  if (isWechatBrowser(userAgent)) return <WechatMiniProgramGuide />;

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
