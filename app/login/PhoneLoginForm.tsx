"use client";

import { useState } from "react";

export default function PhoneLoginForm({ next = "/" }: { next?: string }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [msg, setMsg] = useState("");
  const [tempCode, setTempCode] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function sendCode() {
    if (sending) return;
    setSending(true);
    setMsg("发送中…");
    setTempCode(null);
    try {
      const r = await fetch("/api/auth/phone/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(`发送失败：${data?.error || r.status}`);
        return;
      }
      const c = data?.tempCode ? String(data.tempCode) : data?.testCode ? String(data.testCode) : null;
      if (c) {
        setTempCode(c);
        setMsg("临时验证码已生成（已在下方显示）。");
      } else {
        setMsg("验证码已发送。");
      }
    } catch (e) {
      setMsg(`发送失败：${e instanceof Error ? e.message : "网络异常"}`);
    } finally {
      setSending(false);
    }
  }

  async function verify() {
    if (verifying) return;
    setVerifying(true);
    setMsg("登录中…");
    try {
      const r = await fetch("/api/auth/phone/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code, inviteCode, next }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = String(data?.error || r.status);
        const map: Record<string, string> = {
          CODE_EXPIRED: "验证码已过期或已失效，请重新获取验证码。",
          CODE_MISMATCH: "手机号或验证码不匹配，请检查后再试。",
          INVITE_REQUIRED: "需要邀请码才能注册（老用户登录不需要）。",
          INVITE_INVALID: "邀请码不正确。",
          INVITE_EXHAUSTED: "邀请码已用完。",
        };
        setMsg(`登录失败：${map[err] || err}`);
        return;
      }
      setMsg("登录成功，正在返回首页…");
      window.location.href = data?.next || "/";
    } catch (e) {
      setMsg(`登录失败：${e instanceof Error ? e.message : "网络异常"}`);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <section className="loginSection">
      <div className="loginForm">
        <div className="loginPhoneRow">
          <label className="loginField">
            <div className="loginLabel">手机号</div>
            <input className="restInput" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="请输入手机号" />
          </label>
          <button className="btn loginBtn" type="button" onClick={sendCode} disabled={sending}>
            {sending ? "发送中…" : "获取验证码"}
          </button>
        </div>

        <label className="loginField">
          <div className="loginLabel">验证码</div>
          <input className="restInput" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6位验证码" />
        </label>

        <label className="loginField">
          <div className="loginLabel">邀请码（新用户）</div>
          <input
            className="restInput"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="已有账号可不填"
            autoComplete="off"
          />
        </label>

        <div className="actions loginFooterActions">
          <button className="btn loginPrimaryBtn" type="button" onClick={verify} disabled={verifying}>
            {verifying ? "登录中…" : "登录 / 注册"}
          </button>
        </div>

        {(msg || tempCode) && (
          <div className="loginNotice">
            {msg ? <div>{msg}</div> : null}
            {tempCode ? <div className="loginTestCode">临时验证码：{tempCode}</div> : null}
          </div>
        )}
      </div>
    </section>
  );
}
