import { headers } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { isWeChatUA } from "@/lib/auth/wechat";

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
              : "检测到非微信环境。扫码登录需要开通“微信开放平台-网站应用”。当前你只有公众号能力，所以先提供微信内登录。"}
          </p>
        </header>

        {sess ? (
          <section style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 900, color: "rgba(15,23,42,0.85)" }}>已登录</div>
            <div style={{ marginTop: 6, fontSize: 12, color: "rgba(100,116,139,0.95)" }}>
              openid：{sess.openid}
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
          <section style={{ marginTop: 10 }}>
            {inWeChat ? (
              <div className="actions">
                <a className="btn" href="/api/auth/wechat/start?next=/">
                  微信一键登录
                </a>
                <a className="btn btnSecondary" href="/">
                  返回首页
                </a>
              </div>
            ) : (
              <section style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, color: "rgba(100,116,139,0.95)", lineHeight: 1.6 }}>
                  目前仅支持「微信内网页登录」（公众号 OAuth）。如果你需要“非微信环境扫码登录”，需要再开通微信开放平台的网站应用（扫码登录
                  AppID/Secret），我可以在你补齐后把二维码弹窗流程接上。
                </div>
                <div className="actions" style={{ marginTop: 14 }}>
                  <a className="btn" href="weixin://">
                    用微信打开
                  </a>
                  <a className="btn btnSecondary" href="/">
                    返回首页
                  </a>
                </div>
              </section>
            )}
          </section>
        )}
      </section>
    </main>
  );
}

