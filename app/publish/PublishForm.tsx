"use client";

import { useMemo, useRef, useState } from "react";

type Props = {
  defaultCreatorId: string;
  sourceDraftId?: string;
  lockId?: boolean;
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

export default function PublishForm({ defaultCreatorId, sourceDraftId, lockId, initial, meCreatorId, isAdmin, existsInDb }: Props) {
  const immutable = !!existsInDb;
  const idLocked = !!lockId || immutable;
  const actionLabel = existsInDb ? "更新" : "发布";
  const [id, setId] = useState(initial?.id || "");
  const [title, setTitle] = useState(initial?.title || "");
  const [shortDesc, setShortDesc] = useState(initial?.shortDesc || "");
  const [ruleText, setRuleText] = useState(initial?.ruleText || "");
  const [creatorId, setCreatorId] = useState(initial?.creatorId || meCreatorId || defaultCreatorId);
  const [coverUrl, setCoverUrl] = useState(initial?.coverUrl || "");
  const [path, setPath] = useState(initial?.path || "");
  const [msg, setMsg] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const coverFileRef = useRef<HTMLInputElement | null>(null);
  const [submitTried, setSubmitTried] = useState(false);
  const [touched, setTouched] = useState<{ id?: boolean; title?: boolean; creatorId?: boolean }>({});

  const idRef = useRef<HTMLInputElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const creatorRef = useRef<HTMLInputElement | null>(null);

  const defaultCover = initial?.coverUrl || (id ? `/assets/screenshots/${id}.png` : "");
  const effectiveId = idLocked ? initial?.id || id : id;
  const idMissing = !String(effectiveId || "").trim();
  const titleMissing = !String(title || "").trim();
  const creatorMissing = !!isAdmin && !String(creatorId || "").trim();
  const idErr = (submitTried || touched.id) && idMissing;
  const titleErr = (submitTried || touched.title) && titleMissing;
  const creatorErr = (submitTried || touched.creatorId) && creatorMissing;
  const payload = useMemo(() => {
    const effId = idLocked ? initial?.id || id : id;
    const effCreatorId = immutable ? (isAdmin ? creatorId : initial?.creatorId || creatorId) : creatorId;
    const effPath = immutable ? initial?.path || path : path;
    return {
      id: effId,
      title,
      shortDesc,
      ruleText,
      creatorId: effCreatorId,
      coverUrl: coverUrl || undefined,
      path: effPath ? effPath : undefined,
      sourceDraftId: sourceDraftId || undefined,
    };
  }, [idLocked, immutable, isAdmin, initial?.id, initial?.creatorId, initial?.path, id, title, shortDesc, ruleText, creatorId, coverUrl, path, sourceDraftId]);

  function syncProjectPublishCache(gameId: string, nextTitle: string) {
    try {
      const raw = window.localStorage.getItem("creatorStudio:projectsCache");
      const parsed = raw ? JSON.parse(raw) : null;
      const arr = Array.isArray(parsed?.games) ? parsed.games : [];
      const entry = `/games/${gameId}/__raw/index.html`;
      const now = Date.now();
      const next = arr.slice();
      const idx = next.findIndex((p: any) => String(p?.gameId || "") === gameId);
      const patched = {
        gameId,
        title: nextTitle || next[idx]?.title || gameId,
        entry,
        mtimeMs: now,
        published: true,
        dirty: false,
        publishId: gameId,
      };
      if (idx >= 0) next[idx] = { ...next[idx], ...patched };
      else next.unshift(patched);
      window.localStorage.setItem("creatorStudio:projectsCache", JSON.stringify({ v: 1, at: now, games: next }));
      window.localStorage.setItem("creatorStudio:last", JSON.stringify({ v: 1, gameId, updatedAt: now }));
    } catch {
      // ignore
    }
  }

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
    if (!effectiveId) {
      setMsg("请先填写 id，再上传封面。");
      e.target.value = "";
      return;
    }
    setMsg("正在处理并上传封面…");
    try {
      const url = await cropCoverToSquareDataUrl(f);
      // 上传到 public/assets/covers，并回填相对路径（不要在输入框显示 base64）
      const r = await fetch("/api/covers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: effectiveId, dataUrl: url }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok || !j?.coverUrl) throw new Error(j?.error || "UPLOAD_FAILED");
      setCoverUrl(String(j.coverUrl));
      setMsg("封面已上传（已自动裁剪为 1:1）。");
    } catch {
      setMsg("封面处理失败，请换一张图片再试。");
    } finally {
      e.target.value = "";
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitTried(true);
    // 必填项校验：为空则标红 + 聚焦
    if (idMissing || titleMissing || creatorMissing) {
      submittingRef.current = false;
      setMsg("请先填写必填项（标红处）。");
      if (idMissing) idRef.current?.focus();
      else if (titleMissing) titleRef.current?.focus();
      else if (creatorMissing) creatorRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setMsg("");
    let shouldResetSubmitting = true;
    try {
      const r = await fetch("/api/games/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(`${actionLabel}失败：${data?.error || r.status}`);
        submittingRef.current = false;
        return;
      }
      syncProjectPublishCache(String(payload.id || ""), String(title || ""));
      setMsg(`${actionLabel}成功，正在返回游戏…`);
      const p = typeof data?.path === "string" ? data.path : payload.path || `/games/${payload.id}/`;
      const entry = p.endsWith("/") ? `${p}index.html` : p;
      shouldResetSubmitting = false;
      window.location.href = entry;
    } finally {
      if (shouldResetSubmitting) {
        setSubmitting(false);
        submittingRef.current = false;
      }
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 12 }}>
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>id（英文/数字/短横线）</div>
          <input
            ref={idRef}
            className={`restInput ${idErr ? "isError" : ""}`.trim()}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="例如 weiqi"
            readOnly={idLocked}
            disabled={submitting}
            onBlur={() => setTouched((t) => ({ ...t, id: true }))}
            style={idLocked ? { background: "rgba(148,163,184,0.18)" } : undefined}
          />
          {idLocked ? (
            <div style={{ fontSize: 12, color: "rgba(100,116,139,0.95)" }}>
              {immutable ? "这是同一个已发布作品，id 不会改变。" : "发布后仍沿用当前游戏 id，只是状态从草稿变为已发布。"}
            </div>
          ) : null}
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>标题</div>
          <input
            ref={titleRef}
            className={`restInput ${titleErr ? "isError" : ""}`.trim()}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            onBlur={() => setTouched((t) => ({ ...t, title: true }))}
            placeholder="例如 围棋对弈·人机"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>简介</div>
          <input
            className="restInput"
            value={shortDesc}
            onChange={(e) => setShortDesc(e.target.value)}
            disabled={submitting}
            placeholder="例如 围棋 9×9：您（黑）对战 AI（白）"
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>规则文案</div>
          <textarea
            className="restTextarea"
            value={ruleText}
            onChange={(e) => setRuleText(e.target.value)}
            disabled={submitting}
            placeholder="完整规则说明"
            rows={4}
          />
        </label>

        {/* 管理员：可指定作者 creatorId */}
        {isAdmin ? (
          <label style={{ display: "grid", gap: 6 }}>
            <div style={{ fontWeight: 900 }}>作者 creatorId（管理员可改）</div>
            <input
              ref={creatorRef}
              className={`restInput ${creatorErr ? "isError" : ""}`.trim()}
              value={creatorId}
              onChange={(e) => setCreatorId(e.target.value)}
              disabled={submitting}
              onBlur={() => setTouched((t) => ({ ...t, creatorId: true }))}
              placeholder="例如 tianqing"
            />
          </label>
        ) : null}

        <label style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 900 }}>封面（1:1，可上传自定义）</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btnGray" type="button" onClick={() => coverFileRef.current?.click()} disabled={submitting}>
              上传封面图片
            </button>
            <button className="btn btnGray" type="button" onClick={() => setCoverUrl(defaultCover || "")} disabled={submitting || !defaultCover}>
              恢复默认
            </button>
            <input ref={coverFileRef} type="file" accept="image/*" onChange={onPickCoverFile} style={{ display: "none" }} disabled={submitting} />
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
            disabled={submitting}
            placeholder="也可手动填写相对路径（例如 /assets/screenshots/xxx.png）"
          />
        </label>

        {/* 隐藏：入口 path（由后端按数据库现有值控制；创建时也会自动生成） */}

        <div className="actions">
          <button className="btn" type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? (
              <span className="loadingLabel">
                {actionLabel}中
                <span className="loadingDots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
            ) : (
              actionLabel
            )}
          </button>
          <a
            className={`btn btnGray${submitting ? " isDisabled" : ""}`}
            href={submitting ? undefined : "/"}
            aria-disabled={submitting}
            onClick={(e) => {
              if (submitting) e.preventDefault();
            }}
            style={submitting ? { opacity: 0.65, pointerEvents: "none", filter: "grayscale(0.15)" } : undefined}
          >
            取消
          </a>
        </div>
      </div>

      {msg && !submitting ? (
        <div style={{ marginTop: 10, fontSize: 13, fontWeight: 900, color: "rgba(15,23,42,0.75)" }}>{msg}</div>
      ) : null}
    </form>
  );
}
