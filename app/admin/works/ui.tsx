"use client";

import { useMemo, useState, useTransition } from "react";

export type AdminWallGame = {
  id: string;
  title: string;
  shortDesc: string;
  coverUrl: string;
  path: string;
  creatorId: string;
  creatorName: string;
  playCount: number;
  likeCount: number;
  showOnWall: boolean;
  updatedAt: string;
};

function fmtTime(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export default function WorksAdminUi({ initialGames }: { initialGames: AdminWallGame[] }) {
  const [games, setGames] = useState(initialGames);
  const [filter, setFilter] = useState<"all" | "shown" | "hidden">("all");
  const [keyword, setKeyword] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  const visibleGames = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return games.filter((game) => {
      if (filter === "shown" && !game.showOnWall) return false;
      if (filter === "hidden" && game.showOnWall) return false;
      if (!q) return true;
      return [game.title, game.shortDesc, game.id, game.creatorName, game.creatorId].some((v) =>
        String(v || "").toLowerCase().includes(q),
      );
    });
  }, [filter, games, keyword]);

  async function toggle(game: AdminWallGame) {
    const nextValue = !game.showOnWall;
    setError("");
    setPendingId(game.id);
    startTransition(() => {
      setGames((prev) => prev.map((item) => (item.id === game.id ? { ...item, showOnWall: nextValue } : item)));
    });
    try {
      const res = await fetch("/api/admin/works/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: game.id, showOnWall: nextValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP_${res.status}`);
      setGames((prev) => prev.map((item) => (item.id === game.id ? { ...item, showOnWall: !!data.showOnWall } : item)));
    } catch (e) {
      setGames((prev) => prev.map((item) => (item.id === game.id ? { ...item, showOnWall: game.showOnWall } : item)));
      setError(e instanceof Error ? e.message : "切换失败");
    } finally {
      setPendingId("");
    }
  }

  const shownCount = games.filter((g) => g.showOnWall).length;

  return (
    <div className="worksAdmin">
      <section className="worksAdminHero">
        <div>
          <p>Admin Works</p>
          <h1>作品墙管理</h1>
          <span>决定哪些已发布游戏可以出现在首页、社区作品和老师/机构页的作品墙。</span>
        </div>
        <div className="worksAdminStats">
          <strong>{shownCount}</strong>
          <span>展示中 / 共 {games.length} 个</span>
        </div>
      </section>

      <section className="worksAdminToolbar">
        <div className="worksAdminTabs" aria-label="filter">
          {[
            ["all", "全部"],
            ["shown", "展示中"],
            ["hidden", "已隐藏"],
          ].map(([key, label]) => (
            <button key={key} className={filter === key ? "isActive" : ""} onClick={() => setFilter(key as any)}>
              {label}
            </button>
          ))}
        </div>
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索标题、作者或 gameId" />
      </section>

      {error ? <div className="worksAdminError">操作失败：{error}</div> : null}

      <section className="worksAdminList">
        {visibleGames.map((game) => {
          const busy = (isPending && pendingId === game.id) || pendingId === game.id;
          return (
            <article className={`worksAdminItem ${game.showOnWall ? "isShown" : "isHidden"}`} key={game.id}>
              <img src={game.coverUrl || "/assets/covers/ttt.svg"} alt="" />
              <div className="worksAdminInfo">
                <header>
                  <h2>{game.title || game.id}</h2>
                  <span>{game.showOnWall ? "作品墙展示中" : "已从作品墙隐藏"}</span>
                </header>
                <p>{game.shortDesc || "暂无简介"}</p>
                <div className="worksAdminMeta">
                  <span>{game.creatorName || game.creatorId}</span>
                  <span>{game.playCount} 次试玩</span>
                  <span>{game.likeCount} 个点赞</span>
                  <span>{fmtTime(game.updatedAt)}</span>
                </div>
                <div className="worksAdminLinks">
                  <a href={game.path || `/games/${game.id}/`} target="_blank" rel="noreferrer">
                    打开游戏
                  </a>
                  <code>{game.id}</code>
                </div>
              </div>
              <button className="worksAdminToggle" disabled={busy} onClick={() => toggle(game)}>
                {busy ? "保存中" : game.showOnWall ? "隐藏" : "展示"}
              </button>
            </article>
          );
        })}
        {!visibleGames.length ? <div className="worksAdminEmpty">没有符合条件的作品。</div> : null}
      </section>
    </div>
  );
}
