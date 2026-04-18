"use client";

import { useMemo, useState } from "react";

type Props = {
  defaultCreatorId: string;
  initial?: Partial<{
    id: string;
    title: string;
    shortDesc: string;
    ruleText: string;
    creatorId: string;
    coverUrl: string;
    path: string;
  }>;
};

export default function PublishForm({ defaultCreatorId, initial }: Props) {
  const [id, setId] = useState(initial?.id || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [shortDesc, setShortDesc] = useState(initial?.shortDesc || "");
  const [ruleText, setRuleText] = useState(initial?.ruleText || "");
  const [creatorId, setCreatorId] = useState(initial?.creatorId || defaultCreatorId);
  const [coverUrl, setCoverUrl] = useState(initial?.coverUrl || "");
  const [path, setPath] = useState(initial?.path || "");
  const [msg, setMsg] = useState<string>("");
  const payload = useMemo(
    () => ({
      id,
      title,
      shortDesc,
      ruleText,
      creatorId,
      coverUrl: coverUrl || undefined,
      path: path || undefined,
    }),
    [id, title, shortDesc, ruleText, creatorId, coverUrl, path],
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("发布中…");
    const r = await fetch("/api/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setMsg(`发布失败：${data?.error || r.status}`);
      return;
    }
    const p = typeof data?.path === "string" ? data.path.replace(/^\//, "") : "";
    setMsg(`发布成功：/${p}`);
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 12 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>id（英文/数字/短横线）</div>
          <input className="restInput" value={id} onChange={(e) => setId(e.target.value)} placeholder="例如 weiqi" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>标题</div>
          <input className="restInput" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如 围棋对弈·人机" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>简介</div>
          <input
            className="restInput"
            value={shortDesc}
            onChange={(e) => setShortDesc(e.target.value)}
            placeholder="例如 围棋 9×9：您（黑）对战 AI（白）"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>规则文案</div>
          <textarea
            className="restTextarea"
            value={ruleText}
            onChange={(e) => setRuleText(e.target.value)}
            placeholder="完整规则说明"
            rows={4}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>创作者 creatorId</div>
          <input className="restInput" value={creatorId} onChange={(e) => setCreatorId(e.target.value)} placeholder="tianqing / haibo" />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>封面 coverUrl（可选）</div>
          <input
            className="restInput"
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            placeholder="默认 /assets/screenshots/<id>.svg"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>入口 path（可选）</div>
          <input className="restInput" value={path} onChange={(e) => setPath(e.target.value)} placeholder="默认 /games/<id>/" />
        </label>

        <div className="actions">
          <button className="btn" type="submit">
            发布到首页
          </button>
          <a className="btn btnSecondary" href="/">
            返回首页
          </a>
        </div>
      </div>

      {msg ? (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 900, color: "rgba(15,23,42,0.75)" }}>{msg}</div>
      ) : null}
    </form>
  );
}
