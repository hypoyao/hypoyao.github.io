import { listGames } from "@/lib/db/queries";
import { featuredGamesByEngagement } from "@/lib/gameSorting";
import HomeAccount from "./HomeAccount";
import CoverImage from "./components/CoverImage";
import MiniProgramLaunchButton from "./MiniProgramLaunchButton";
import { getLegalConfig } from "@/lib/legal";

// 首页尽量走静态 + ISR：首屏秒开（CDN 缓存），后台定期更新
export const dynamic = "force-static";
export const revalidate = 60;

function toGameEntryHref(path: string) {
  // 统一走 /games/<id>/（由 app route 输出“两栏壳”页面；游戏本体在 iframe 的 /__raw/ 下）
  return path.endsWith("/") ? path : `${path}/`;
}

const appDetails = [
  {
    title: "AI 对话生成小应用",
    desc: "用户通过自然语言描述场景、角色、按钮、交互目标和画面风格，妙点小匠会生成可在线预览的 H5 小应用。",
  },
  {
    title: "在线预览与继续修改",
    desc: "生成后可在创作页即时试玩，并继续用对话调整文案、样式、关卡、难度、交互和 bug 修复。",
  },
  {
    title: "作品发布与分享",
    desc: "创作者可以发布作品，生成可访问链接，分享给同学、朋友、学生或活动参与者试玩。",
  },
  {
    title: "社区作品展示",
    desc: "公开发布且通过展示设置的作品会进入社区作品墙，其他用户可浏览、试玩、点赞和分享。",
  },
];

const serviceItems = [
  ["应用名称", "妙点小匠"],
  ["服务类型", "AI 互动小应用与教学互动素材创作工具"],
  ["主要用户", "青少年创作者、学生、老师、学校与教育机构"],
  ["核心服务", "需求输入、AI 生成、在线预览、对话修改、作品发布、社区展示、数据统计"],
  ["使用方式", "网页登录或小程序扫码进入后，通过一句话描述开始创作"],
];

export default async function HomePage() {
  const games = await listGames();
  // 首页作品墙保持三行以内，避免审核信息和服务说明被长列表挤到太深的位置。
  const featuredGames = featuredGamesByEngagement(games).slice(0, 9);
  const legal = getLegalConfig();

  return (
    <main className="homePage simpleHomePage">
      <nav className="homeNav" aria-label="首页导航">
        <a className="homeLogo" href="/" aria-label="妙点小匠首页">
          <span>妙点小匠</span>
        </a>
        <div className="homeNavLinks">
          <a className="isActive" href="/">
            首页
          </a>
          <a href="/works">社区作品</a>
          <a href="/teachers">老师/学校/机构</a>
          <a href="#contact">联系我们</a>
        </div>
        <div className="homeNavActions">
          <HomeAccount />
        </div>
      </nav>

      <section className="card homeCard homeNew simpleHomeContent">
        <section className="homeHeroGrid" aria-label="hero">
          <section className="heroPanel" aria-label="main call to action">
            <div className="homeAppBadge">妙点小匠应用官网</div>
            <h1 className="heroTitle">妙点小匠：用 AI 对话生成互动小应用</h1>
            <p className="heroDesc">
              妙点小匠是一款面向青少年、学生、老师和教育机构的 AI 创作应用。用户只需要描述玩法、角色、按钮、胜负条件和画面风格，
              就可以生成可预览、可修改、可发布分享的 H5 小应用和教学互动素材。
            </p>

            <MiniProgramLaunchButton className="heroStartBtn" arrow>
              开始创作
            </MiniProgramLaunchButton>
          </section>
        </section>

        <section className="homeSection" aria-label="all works">
          <div className="sectionHead">
            <h2 className="sectionTitle">精选作品</h2>
            <a className="sectionMoreLink" href="/works">
              全部作品
            </a>
          </div>
          <section className="gameGrid homeWallGrid" aria-label="game list">
            {featuredGames.map((g) => (
              <article key={g.id} className="gameItem" aria-label={g.title}>
                <a className="gameLink" href={toGameEntryHref(g.path)} aria-label={`打开作品：${g.title}`}>
                  <CoverImage
                    className="gameThumb"
                    src={g.coverUrl}
                    fallbackKey={g.id}
                    alt={`${g.title}截图`}
                    loading="lazy"
                    decoding="async"
                  />
                  <div className="gameBody">
                    <div className="gameName">{g.title}</div>
                    <div className="gameDesc">{g.shortDesc}</div>
                    {g.playCount >= 3 || g.likeCount >= 1 ? (
                      <div className="gameStatRow" aria-label="作品数据">
                        {g.playCount >= 3 ? <span className="gameStatChip">玩过 {g.playCount}</span> : null}
                        {g.likeCount >= 1 ? <span className="gameStatChip">点赞 {g.likeCount}</span> : null}
                      </div>
                    ) : null}
                    <div className="gameMetaRow">
                      <img className="gameMetaAvatar" src={g.creator.avatarUrl} alt={`${g.creator.name}头像`} />
                      <span className="gameMeta">创作者：{g.creator.name}</span>
                    </div>
                  </div>
                </a>
              </article>
            ))}
          </section>
        </section>

        <section className="homeSection appInfoSection" aria-label="应用详情">
          <div className="sectionHead">
            <h2 className="sectionTitle">应用详情</h2>
            <span className="sectionKicker">Application Details</span>
          </div>
          <div className="appInfoGrid">
            {appDetails.map((item) => (
              <article key={item.title} className="appInfoCard">
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="homeSection serviceInfoSection" aria-label="服务信息">
          <div className="sectionHead">
            <h2 className="sectionTitle">服务信息</h2>
            <span className="sectionKicker">Service Information</span>
          </div>
          <div className="serviceInfoPanel">
            <div className="serviceInfoCopy">
              <h3>妙点小匠提供什么服务？</h3>
              <p>
                平台提供 AI 生成小应用、作品编辑、在线预览、发布分享、社区展示、试玩数据与点赞互动等服务。
                当前主要用于创意表达、学习练习、课堂互动、活动宣传和青少年编程启蒙场景。
              </p>
            </div>
            <dl className="serviceInfoList">
              {serviceItems.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
              <div>
                <dt>运营主体</dt>
                <dd>{legal.operatorName}</dd>
              </div>
              <div>
                <dt>联系邮箱</dt>
                <dd>{legal.contactEmail}</dd>
              </div>
            </dl>
          </div>
        </section>
      </section>

      <section id="contact" className="homeContact" aria-label="联系我们">
        <div className="contactCopy">
          <span>联系我们</span>
          <h2>想了解内测、合作或使用方式？</h2>
          <p>欢迎扫码添加微信，告诉我你的使用场景和想做的互动内容。</p>
        </div>
        <div className="contactQrCard">
          <img src="/assets/screenshots/qrcode.png" alt="妙点小匠微信二维码" loading="lazy" />
          <strong>扫码添加微信</strong>
          <small>内测反馈 / 教育合作 / 使用咨询</small>
        </div>
      </section>
    </main>
  );
}
