(() => {
  try {
    const m = window.location.pathname.match(/\/games\/([^/]+)\//);
    if (!m) return;
    const gameId = m[1];

    const badge = document.querySelector("a.creatorBadge");
    const avatar = document.querySelector("img.creatorBadgeAvatar");
    const nameEl = document.querySelector(".creatorBadgeName");

    // 仅在页面包含创作者条时才请求
    if (!badge && !avatar && !nameEl) return;

    fetch(`/api/games/${encodeURIComponent(gameId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) return;
        const c = j.creator;
        if (!c) return;
        if (badge && c.profilePath) badge.href = c.profilePath;
        if (avatar && c.avatarUrl) avatar.src = c.avatarUrl;
        if (nameEl && c.name) nameEl.textContent = `创作者：${c.name}`;
      })
      .catch(() => {});
  } catch {}
})();

