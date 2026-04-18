import { getSession } from "@/lib/auth/session";
import PublishForm from "./PublishForm";
import { db } from "@/lib/db";
import { games as gamesTable } from "@/lib/db/schema";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

async function listLocalGameIds() {
  const dir = path.join(process.cwd(), "public", "games");
  const ents = await fs.readdir(dir, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function getGameDefaults(id: string) {
  // 从 public/games/<id>/index.html 解析默认标题/描述
  try {
    const file = path.join(process.cwd(), "public", "games", id, "index.html");
    const html = await fs.readFile(file, "utf8");
    const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || "").trim();
    const desc = (html.match(/<p class="desc">([\s\S]*?)<\/p>/i)?.[1] || "").replace(/\s+/g, " ").trim();
    return {
      id,
      title: title || id,
      shortDesc: desc ? desc.slice(0, 42) : "",
      ruleText: desc || "",
      coverUrl: `/assets/screenshots/${id}.svg`,
      path: `/games/${id}/`,
    };
  } catch {
    return {
      id,
      title: id,
      shortDesc: "",
      ruleText: "",
      coverUrl: `/assets/screenshots/${id}.svg`,
      path: `/games/${id}/`,
    };
  }
}

export default async function PublishPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sess = await getSession();
  if (!sess) {
    return (
      <main className="wrap">
        <section className="card homeCard">
          <header className="header">
            <h1>发布游戏</h1>
            <p className="desc">需要先登录后才能发布游戏到首页。</p>
          </header>
          <div className="actions">
            <a className="btn" href="/login">
              去登录
            </a>
            <a className="btn btnSecondary" href="/">
              返回首页
            </a>
          </div>
        </section>
      </main>
    );
  }

  const sp = (await searchParams) || {};
  const pickedId = typeof sp.id === "string" ? sp.id : "";

  const published = await db.select({ id: gamesTable.id }).from(gamesTable);
  const publishedIds = new Set(published.map((x) => x.id));
  const localIds = await listLocalGameIds();
  const unpublished = localIds.filter((id) => !publishedIds.has(id));

  const initial = pickedId ? await getGameDefaults(pickedId) : undefined;

  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>发布游戏</h1>
          <p className="desc">填写游戏信息并发布到首页列表（数据库）。也可以在下方“未发布”列表中一键填充。</p>
          <p className="homeSub">已登录 openid：{sess.openid}</p>
        </header>

        {unpublished.length > 0 ? (
          <section style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 1000, marginBottom: 8 }}>未发布的本地小游戏</div>
            <div style={{ display: "grid", gap: 8 }}>
              {unpublished.map((id) => (
                <div
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 14,
                    border: "1px solid rgba(15,23,42,0.10)",
                    background: "rgba(255,255,255,0.55)",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>{id}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <a className="homePublishBtn" href={`/publish?id=${encodeURIComponent(id)}`}>
                      填充并发布
                    </a>
                    <a className="homeLoginBtn" href={`/games/${encodeURIComponent(id)}/index.html`}>
                      预览
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div style={{ marginTop: 8, fontSize: 13, color: "rgba(100,116,139,0.95)" }}>暂无未发布的本地小游戏。</div>
        )}

        <PublishForm defaultCreatorId="tianqing" initial={initial ? { ...initial, creatorId: "tianqing" } : undefined} />
      </section>
    </main>
  );
}
