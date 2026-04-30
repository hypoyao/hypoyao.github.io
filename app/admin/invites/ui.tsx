"use client";

import { useEffect, useMemo, useState } from "react";

type InviteRow = {
  code: string;
  enabled: boolean;
  max_uses: number;
  used_count: number;
  note: string | null;
  last_used_phone: string | null;
  last_used_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function fmt(s: string | null | undefined) {
  if (!s) return "";
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    return d.toLocaleString();
  } catch {
    return String(s);
  }
}

export default function InviteAdminClient() {
  const [items, setItems] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState("");
  const [customCode, setCustomCode] = useState("");

  const stats = useMemo(() => {
    const total = items.length;
    const enabled = items.filter((x) => x.enabled).length;
    const used = items.filter((x) => Number(x.used_count || 0) >= 1).length;
    return { total, enabled, used };
  }, [items]);

  async function load() {
    setLoading(true);
    setMsg("");
    try {
      const r = await fetch("/api/admin/invites/list", { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || "LOAD_FAILED");
      setItems(Array.isArray(j.invites) ? (j.invites as InviteRow[]) : []);
    } catch (e: any) {
      setMsg(`加载失败：${e?.message || "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createOne() {
    const n = note.trim();
    const c = customCode.trim();
    if (c && !/^[A-Za-z0-9]{4,16}$/.test(c)) {
      setMsg("自定义邀请码只能包含字母数字，长度 4-16。");
      return;
    }
    setLoading(true);
    setMsg("");
    try {
      const r = await fetch("/api/admin/invites/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: n || undefined, code: c || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok || !j?.code) throw new Error(j?.error || "CREATE_FAILED");
      const code = String(j.code);
      try {
        await navigator.clipboard.writeText(code);
        setMsg(`已生成邀请码：${code}（已复制）`);
      } catch {
        setMsg(`已生成邀请码：${code}`);
      }
      setNote("");
      setCustomCode("");
      await load();
    } catch (e: any) {
      const err = String(e?.message || "未知错误");
      const tip =
        err === "CODE_EXISTS"
          ? "这个邀请码已经存在，请换一个自定义邀请码。"
          : err === "CODE_GENERATE_COLLISION"
            ? "随机邀请码撞码了，请再点一次生成。"
            : err;
      setMsg(`生成失败：${tip}`);
    } finally {
      setLoading(false);
    }
  }

  async function toggle(code: string, enabled: boolean) {
    if (!window.confirm(enabled ? "确定启用这个邀请码吗？" : "确定禁用这个邀请码吗？")) return;
    setLoading(true);
    setMsg("");
    try {
      const r = await fetch("/api/admin/invites/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, enabled }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || "TOGGLE_FAILED");
      await load();
    } catch (e: any) {
      setMsg(`操作失败：${e?.message || "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }

  async function del(code: string) {
    if (!window.confirm(`确定删除邀请码吗？\n\n${code}\n\n删除后无法恢复。`)) return;
    setLoading(true);
    setMsg("");
    try {
      const r = await fetch("/api/admin/invites/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) throw new Error(j?.error || "DELETE_FAILED");
      await load();
    } catch (e: any) {
      setMsg(`删除失败：${e?.message || "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setMsg(`已复制：${code}`);
    } catch {
      setMsg("复制失败（当前浏览器不支持 clipboard）。");
    }
  }

  return (
    <section aria-label="invite admin">
      <div className="stats" style={{ marginTop: 6 }}>
        <div className="statsRow">
          <div className="diffWrap">
            <div className="diffLabel">统计</div>
            <div className="desc" style={{ margin: 0 }}>
              总数 {stats.total} · 启用 {stats.enabled} · 已使用 {stats.used}
            </div>
          </div>
          <div className="actions" style={{ margin: 0 }}>
            <button className="btn btnGray" type="button" onClick={load} disabled={loading}>
              刷新
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12, padding: 14, boxShadow: "var(--shadow-soft)" as any }}>
        <div className="desc" style={{ marginTop: 0 }}>
          生成后会自动复制到剪贴板。每个邀请码只能使用 1 次。
        </div>
        <div className="loginPhoneRow" style={{ gap: 10 }}>
          <label className="loginField" style={{ flex: 1 }}>
            <div className="loginLabel">备注（可选）</div>
            <input className="restInput" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：内测群第1批" />
          </label>
          <label className="loginField" style={{ width: 180 }}>
            <div className="loginLabel">自定义码</div>
            <input
              className="restInput"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
              placeholder="可不填"
              autoComplete="off"
            />
          </label>
          <button className="btn" type="button" onClick={createOne} disabled={loading}>
            生成邀请码
          </button>
        </div>

        {msg ? (
          <div className="loginNotice" style={{ marginTop: 10 }}>
            {msg}
          </div>
        ) : null}
      </div>

      <div className="card" style={{ marginTop: 12, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
            <thead>
              <tr style={{ background: "rgba(248,250,252,1)" }}>
                <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)" }}>邀请码</th>
                <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)" }}>状态</th>
                <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)" }}>使用</th>
                <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)" }}>最后使用</th>
                <th style={{ textAlign: "left", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)" }}>备注</th>
                <th style={{ textAlign: "right", padding: 12, borderBottom: "1px solid rgba(15,23,42,0.08)" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const used = Number(x.used_count || 0) >= 1;
                return (
                  <tr key={x.code}>
                    <td style={{ padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)", fontWeight: 1100 }}>
                      {x.code}
                    </td>
                    <td style={{ padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)" }}>
                      {x.enabled ? "启用" : "禁用"}
                    </td>
                    <td style={{ padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)" }}>
                      {used ? "已使用" : "未使用"}
                    </td>
                    <td style={{ padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)" }}>
                      {x.last_used_phone ? `${x.last_used_phone}` : ""}
                      {x.last_used_at ? <div style={{ color: "rgba(100,116,139,0.95)" }}>{fmt(x.last_used_at)}</div> : null}
                    </td>
                    <td style={{ padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)" }}>
                      {x.note || ""}
                      {x.created_at ? <div style={{ color: "rgba(100,116,139,0.95)" }}>创建：{fmt(x.created_at)}</div> : null}
                    </td>
                    <td style={{ padding: 12, borderBottom: "1px solid rgba(15,23,42,0.06)", textAlign: "right" }}>
                      <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <button className="btn btnGray" type="button" onClick={() => copy(x.code)} disabled={loading}>
                          复制
                        </button>
                        <button
                          className="btn btnGray"
                          type="button"
                          onClick={() => toggle(x.code, !x.enabled)}
                          disabled={loading}
                        >
                          {x.enabled ? "禁用" : "启用"}
                        </button>
                        <button className="btn btnGray" type="button" onClick={() => del(x.code)} disabled={loading || used}>
                          删除
                        </button>
                      </div>
                      {used ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: "rgba(100,116,139,0.95)" }}>已使用的码不允许删除</div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {!items.length ? (
                <tr>
                  <td colSpan={6} style={{ padding: 14, color: "rgba(100,116,139,0.95)" }}>
                    暂无邀请码。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
