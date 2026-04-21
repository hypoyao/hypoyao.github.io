"use client";

import { useEffect, useState } from "react";

type Me =
  | { ok: true; loggedIn: false }
  | {
      ok: true;
      loggedIn: true;
      creatorId: string | null;
      isAdmin: boolean;
      creator?: { id: string; name: string; avatarUrl: string; profilePath: string } | null;
    };

export default function HomeAccount() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (alive) setMe(j);
      })
      .catch(() => {
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 未登录 / 未加载：显示登录入口
  if (!me || !("loggedIn" in me) || me.loggedIn === false) {
    return (
      <a className="homeLoginBtn" href="/login" aria-label="登录">
        登录
      </a>
    );
  }

  const c = me.creator;
  if (c?.profilePath && c?.avatarUrl) {
    return (
      <a className="homeAvatarBtn" href={c.profilePath} aria-label="个人主页">
        <img className="homeAvatarImg" src={c.avatarUrl} alt={`${c.name || "用户"}头像`} />
      </a>
    );
  }

  // 已登录但还没有 creator 资料（或缺少头像/主页路径）：也用默认头像占位，引导完善资料
  return (
    <a className="homeAvatarBtn" href="/profile/edit" aria-label="完善资料">
      <img className="homeAvatarImg" src="/assets/avatars/user.svg" alt="用户头像" />
    </a>
  );

  // unreachable
}
