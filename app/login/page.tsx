import { headers } from "next/headers";
import { getSession } from "@/lib/auth/session";
import PhoneLoginForm from "./PhoneLoginForm";
import { maskPhone } from "@/lib/auth/phone";
import "./login.css";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const sess = await getSession();
  // 仅手机号登录：不再区分微信环境
  await headers(); // 保留 headers() 调用，避免 Next.js 动态渲染行为变化

  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>用户登录</h1>
          <p className="desc">使用手机号验证码注册/登录。</p>
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
            <PhoneLoginForm />
          </section>
        )}
      </section>
    </main>
  );
}
