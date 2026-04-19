"use client";

import { useMemo, useRef, useState } from "react";

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
  meCreatorId?: string;
  isAdmin?: boolean;
  existsInDb?: boolean;
};

export default function PublishForm({ defaultCreatorId, initial, meCreatorId, isAdmin, existsInDb }: Props) {
  const immutable = !!existsInDb;
  const [id, setId] = useState(initial?.id || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [shortDesc, setShortDesc] = useState(initial?.shortDesc || "");
  const [ruleText, setRuleText] = useState(initial?.ruleText || "");
  const [creatorId, setCreatorId] = useState(initial?.creatorId || meCreatorId || defaultCreatorId);
  const [coverUrl, setCoverUrl] = useState(initial?.coverUrl || "");
  const [path, setPath] = useState(initial?.path || "");
  const [msg, setMsg] = useState<string>("");
  const coverFileRef = useRef<HTMLInputElement | null>(null);

  const defaultCover = initial?.coverUrl || (id ? `/assets/screenshots/${id}.png` : "");
  const payload = useMemo(() => {
    const effId = immutable ? initial?.id || id : id;
    const effCreatorId = immutable ? initial?.creatorId || creatorId : creatorId;
    const effPath = immutable ? initial?.path || path : path;
    const isData = typeof coverUrl === "string" && coverUrl.startsWith("data:image/");
    const effCoverUrl = isData ? `/assets/covers/${effId}` : coverUrl;
    return {
      id: effId,
      title,
      shortDesc,
      ruleText,
      creatorId: effCreatorId,
      coverUrl: effCoverUrl || undefined,
      coverDataUrl: isData ? coverUrl : undefined,
      path: effPath ? effPath : undefined,
    };
  }, [immutable, initial?.id, initial?.creatorId, initial?.path, id, title, shortDesc, ruleText, creatorId, coverUrl, path]);

  async function cropCoverToSquareDataUrl(file: File) {
    // 自动居中裁剪为正方形，并缩放到 512x512（封面要求 1:1）
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("READ_FAILED"));
      fr.readAsDataURL(file);
    });

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("IMG_LOAD_FAILED"));
      el.src = dataUrl;
    });

    const size = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const sx = Math.floor(((img.naturalWidth || img.width) - size) / 2);
    const sy = Math.floor(((img.naturalHeight || img.height) - size) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("NO_CANVAS");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, size, size, 0, 0, 512, 512);

    try {
      return canvas.toDataURL("image/webp", 0.86);
    } catch {
      return canvas.toDataURL("image/png");
    }
  }

  async function onPickCoverFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setMsg("正在处理封面…");
    try {
      const url = await cropCoverToSquareDataUrl(f);
      setCoverUrl(url);
      setMsg("已上传封面（已自动裁剪为 1:1）。");
    } catch {
      setMsg("封面处理失败，请换一张图片再试。");
    } finally {
      e.target.value = "";
    }
  }

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
    setMsg("发布成功，正在返回游戏…");
    const p = typeof data?.path === "string" ? data.path : payload.path || `/games/${payload.id}/`;
    const entry = p.endsWith("/") ? `${p}index.html` : p;
    window.location.href = entry;
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 12 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>id（英文/数字/短横线）</div>
          <input
            className="restInput"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例如 weiqi"
            readOnly={immutable}
            style={immutable ? { background: "rgba(148,163,184,0.18)" } : undefined}
          />
          {immutable ? <div style={{ fontSize: 12, color: "rgba(100,116,139,0.95)" }}>更新模式下，id 不允许修改。</div> : null}
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

        {/* 隐藏：创作者 creatorId（由后端按权限与数据库现有值控制） */}

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>封面（1:1，可上传自定义）</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btnGray" type="button" onClick={() => coverFileRef.current?.click()}>
              上传封面图片
            </button>
            <button className="btn btnGray" type="button" onClick={() => setCoverUrl(defaultCover || "")} disabled={!defaultCover}>
              恢复默认
            </button>
            <input ref={coverFileRef} type="file" accept="image/*" onChange={onPickCoverFile} style={{ display: "none" }} />
          </div>
          {coverUrl ? (
            <img
              src={coverUrl}
              alt="封面预览"
              style={{
                width: 160,
                height: 160,
                borderRadius: 14,
                border: "1px solid rgba(15,23,42,0.10)",
                background: "rgba(255,255,255,0.6)",
                objectFit: "cover",
              }}
            />
          ) : null}
          <div style={{ fontSize: 12, color: "rgba(100,116,139,0.95)" }}>会自动居中裁剪为 1:1 并压缩（webp/png）。</div>
          <input
            className="restInput"
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            placeholder="也可手动填写相对路径（例如 /assets/screenshots/xxx.png）"
          />
        </label>

        {/* 隐藏：入口 path（由后端按数据库现有值控制；创建时也会自动生成） */}

        <div className="actions">
          <button className="btn" type="submit">
            {existsInDb ? "更新" : "发布"}
          </button>
          <a className="btn btnGray" href="/">
            取消
          </a>
        </div>
      </div>

      {msg ? (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 900, color: "rgba(15,23,42,0.75)" }}>{msg}</div>
      ) : null}
    </form>
  );
}
