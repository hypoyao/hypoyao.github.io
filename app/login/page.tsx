import { headers } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { isWeChatUA } from "@/lib/auth/wechat";
import PhoneLoginForm from "./PhoneLoginForm";
import { maskPhone } from "@/lib/auth/phone";
import "./login.css";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const sess = await getSession();
  const ua = (await headers()).get("user-agent");
  const inWeChat = isWeChatUA(ua);

  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>用户登录</h1>
          <p className="desc">
            {inWeChat
              ? "检测到微信内打开，将使用公众号登录获取 openid。"
              : "检测到非微信环境：使用手机号验证码注册/登录。"}
          </p>
        </header>

        {sess ? (
          <section className="loginSection">
            <div className="loginMeta">
              <div className="loginMetaTitle">已登录</div>
              <div className="loginMetaSub">
                {sess.openid ? `openid：${sess.openid}` : sess.phone ? `手机号：${maskPhone(sess.phone)}` : "账号：未知"}
              </div>
            </div>
            <div className="actions" style={{ marginTop: 14 }}>
              <form action="/api/auth/logout" method="post">
                <button className="btn" type="submit">
                  退出登录
                </button>
              </form>
              <a className="btn btnSecondary" href="/">
                返回首页
              </a>
            </div>
          </section>
        ) : (
          <section className="loginSection">
            {inWeChat ? (
              <div className="actions">
                <a className="btn" href="/api/auth/wechat/start?next=/">
                  微信一键登录
                </a>
              </div>
            ) : (
              <PhoneLoginForm />
            )}
          </section>
        )}
      </section>
    </main>
  );
}
