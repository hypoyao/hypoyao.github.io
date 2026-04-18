"use client";

import { useState } from "react";

export default function PhoneLoginForm() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [testCode, setTestCode] = useState<string | null>(null);

  async function sendCode() {
    setMsg("发送中…");
    setTestCode(null);
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
    setMsg("验证码已发送。");
    if (data?.testCode) {
      setTestCode(String(data.testCode));
      setMsg("验证码已发送（测试模式：已在下方显示）。");
    }
  }

  async function verify() {
    setMsg("登录中…");
    const r = await fetch("/api/auth/phone/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code, next: "/" }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setMsg(`登录失败：${data?.error || r.status}`);
      return;
    }
    setMsg("登录成功，正在返回首页…");
    window.location.href = data?.next || "/";
  }

  return (
    <section className="loginSection">
      <div className="loginForm">
        <div className="loginPhoneRow">
          <label className="loginField">
            <div className="loginLabel">手机号</div>
            <input className="restInput" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="请输入手机号" />
          </label>
          <button className="btn loginBtn" type="button" onClick={sendCode}>
            获取验证码
          </button>
        </div>

        <label className="loginField">
          <div className="loginLabel">验证码</div>
          <input className="restInput" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6位验证码" />
        </label>

        <div className="actions loginFooterActions">
          <button className="btn" type="button" onClick={verify}>
            登录 / 注册
          </button>
        </div>

        {(msg || testCode) && (
          <div className="loginNotice">
            {msg ? <div>{msg}</div> : null}
            {testCode ? <div className="loginTestCode">测试验证码：{testCode}</div> : null}
          </div>
        )}
      </div>
    </section>
  );
}
