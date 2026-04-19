"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type StudioState = {
  gameId: string;
  published: boolean;
  loggedIn: boolean;
  busy: boolean;
};

export default function TopActions() {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [st, setSt] = useState<StudioState>({ gameId: "", published: false, loggedIn: false, busy: false });

  useEffect(() => {
    const onState = (e: any) => {
      const d = e?.detail || {};
      setSt((s) => ({
        ...s,
        gameId: String(d.gameId || ""),
        published: !!d.published,
        loggedIn: !!d.loggedIn,
        busy: !!d.busy,
      }));
    };
    window.addEventListener("creatorStudioState", onState as any);
    // 主动拉一次（如果 studio 已经发过也没关系）
    window.dispatchEvent(new CustomEvent("creatorStudioPing"));
    return () => window.removeEventListener("creatorStudioState", onState as any);
  }, []);

  const publishText = useMemo(() => (st.published ? "更新" : "发布"), [st.published]);

  function act(type: "new" | "publish" | "delete") {
    // 关闭下拉
    if (detailsRef.current) detailsRef.current.open = false;
    window.dispatchEvent(new CustomEvent("creatorStudioAction", { detail: { type } }));
  }

  return (
    <div className="createTopActions">
      <a className="homeCreateBtn" href="/">
        返回首页
      </a>

      <details className="createMenu" ref={detailsRef}>
        <summary className="createMenuBtn" aria-label="更多操作">
          操作 ▾
        </summary>
        <div className="createMenuPanel" role="menu" aria-label="创作操作菜单">
          <button className="createMenuItem" type="button" onClick={() => act("new")} disabled={st.busy}>
            新建游戏
          </button>
          <button className="createMenuItem" type="button" onClick={() => act("publish")} disabled={st.busy || !st.gameId}>
            {publishText}到首页
          </button>
          <button className="createMenuItem danger" type="button" onClick={() => act("delete")} disabled={st.busy || !st.gameId}>
            删除游戏
          </button>
        </div>
      </details>
    </div>
  );
}

