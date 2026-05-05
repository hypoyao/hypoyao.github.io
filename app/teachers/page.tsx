import { listGames } from "@/lib/db/queries";
import HomeAccount from "../HomeAccount";
import HomePromptLauncher from "../HomePromptLauncher";

// 首页尽量走静态 + ISR：首屏秒开（CDN 缓存），后台定期更新
export const dynamic = "force-static";
export const revalidate = 60;

const useCases = [
  {
    title: "老师 / 学校 / 机构",
    tone: "green",
    image: "👩‍🏫",
    points: ["一句话生成互动课件", "课堂热身与随堂练习", "活动宣传与报名互动", "无需编程，快速上手"],
  },
  {
    title: "学生",
    tone: "blue",
    image: "🧑‍💻",
    points: ["自己动手做小游戏", "分享给同学和朋友", "展示创意与作品", "边玩边学，提升兴趣"],
  },
];

const generationTypes = [
  { title: "英语单词闯关", img: "/assets/screenshots/WordsGame.png", tag: "English" },
  { title: "数学口算挑战", img: "/assets/screenshots/口算飞船大作战.png", tag: "Math" },
  { title: "器官功能配对", img: "/assets/screenshots/器官功能配对.png", tag: "Science" },
  { title: "打地鼠小猫", img: "/assets/screenshots/mole.png", tag: "Action" },
  { title: "成语猜词问答", img: "/assets/screenshots/成语猜词.png", tag: "Chinese" },
  { title: "跳跳球冒险", img: "/assets/screenshots/jumpball.png", tag: "Arcade" },
];

const creationSteps = [
  { no: "1", title: "说出需求", desc: "输入一句自然语言描述", icon: "💬" },
  { no: "2", title: "AI 自动生成", desc: "快速生成互动素材或小游戏", icon: "🤖" },
  { no: "3", title: "一键分享", desc: "发布给学生、同学或活动参与者", icon: "🔗" },
];

const advantages = [
  { icon: "💬", title: "对话式创作", desc: "像聊天一样输入想法，AI 理解并生成内容。" },
  { icon: "📘", title: "教学友好模板", desc: "覆盖多学科与场景，拿来即用，省时省力。" },
  { icon: "🖥️", title: "在线预览与修改", desc: "实时预览效果，用自然语言继续调整。" },
  { icon: "✈️", title: "一键发布分享", desc: "生成链接和二维码，快速分发给学生。" },
  { icon: "📊", title: "数据统计", desc: "查看参与情况，为教学评估提供参考。" },
  { icon: "🏫", title: "适合课堂活动", desc: "课堂教学、社团活动、招生宣传全覆盖。" },
];

function toGameEntryHref(path: string) {
  // 统一走 /games/<id>/（由 app route 输出“两栏壳”页面；游戏本体在 iframe 的 /__raw/ 下）
  return path.endsWith("/") ? path : `${path}/`;
}

export default async function HomePage() {
  const games = await listGames();
  const showcasedGames = games.slice(0, 6);

  return (
    <main className="homePage teachersPage">
      <nav className="homeNav" aria-label="首页导航">
        <a className="homeLogo" href="/" aria-label="奇点小匠首页">
          <span>奇点小匠</span>
        </a>
        <div className="homeNavLinks">
          <a href="/">
            首页
          </a>
          <a href="/works">社区作品</a>
          <a className="isActive" href="/teachers">
            老师/学校/机构
          </a>
          <a href="#contact">联系我们</a>
        </div>
        <div className="homeNavActions">
          <HomeAccount />
        </div>
      </nav>

      <section id="hero" className="homeHero">
        <div className="heroGlow heroGlowOne" aria-hidden="true" />
        <div className="heroGlow heroGlowTwo" aria-hidden="true" />
        <section className="heroCopy">
          <div className="heroEyebrow">内测中 · 现在可免费使用</div>
          <h1>
            一句话，生成
            <br />
            教学<span>互动素材</span>和<span>小游戏</span>
          </h1>
          <p>
            面向老师、学校与教育机构，也适合学生自由创作。内测期间开放免费使用，输入一个想法，即可生成课堂互动、知识闯关、练习游戏与分享作品。
          </p>
          <div className="heroBetaBanner" role="note">
            <strong>内测福利</strong>
            <span>当前阶段免费体验 AI 生成、预览、修改和发布能力。</span>
          </div>
          <HomePromptLauncher />
          <div className="heroProofs" aria-label="产品特点">
            <span>内测免费使用</span>
            <span>老师备课更高效</span>
            <span>学生创作更有趣</span>
            <span>无需编程</span>
          </div>
        </section>

        <section className="heroProduct" aria-label="产品界面示意">
          <div className="productShell">
            <aside className="productSidebar">
              <div className="productMiniLogo">
                <b>奇点小匠</b>
              </div>
              {["首页", "我的作品", "模板中心", "分享与发布", "数据统计", "设置中心"].map((x, i) => (
                <div key={x} className={`sideItem ${i === 0 ? "active" : ""}`}>
                  <span>{["⌂", "▣", "▤", "⌁", "▥", "⚙"][i]}</span>
                  {x}
                </div>
              ))}
            </aside>
            <div className="productMain">
              <div className="productTop">
                <div>
                  <strong>你好，老师 👋</strong>
                  <small>今天想做点什么互动呢？</small>
                </div>
                <img src="/assets/avatars/user.svg" alt="" />
              </div>
              <div className="productTabs">
                {["全部", "课堂互动", "知识闯关", "练习游戏", "活动页面"].map((x, i) => (
                  <span key={x} className={i === 0 ? "active" : ""}>
                    {x}
                  </span>
                ))}
              </div>
              <div className="productCards">
                <div className="mockCard green">
                  <b>英语单词闯关</b>
                  <div className="wordTiles">
                    <span>🍎 apple</span>
                    <span>🍌 banana</span>
                    <span>🦁 cat</span>
                  </div>
                  <em>★★★★★</em>
                </div>
                <div className="mockCard purple">
                  <b>课堂问答</b>
                  <p>地球绕着太阳转吗？</p>
                  <span>A. 是</span>
                  <span>B. 否 ✓</span>
                </div>
                <div className="mockCard orange">
                  <b>数学口算挑战</b>
                  <p>23 + 17 = ?</p>
                  <div className="answerRow">
                    <span>37</span>
                    <span>40</span>
                    <span>50</span>
                  </div>
                </div>
                <div className="mockCard blue">
                  <b>科学知识配对</b>
                  <div className="orbitDots">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="floatingBadge green">3 分钟完成</div>
          <div className="floatingBadge orange">可分享</div>
          <div className="floatingBadge blue">课堂可用</div>
        </section>
      </section>

      <section id="solutions" className="homeSection homeAudience">
        <div className="sectionHeading">
          <span />
          <h2>适合谁使用</h2>
          <span />
        </div>
        <div className="audienceGrid">
          {useCases.map((item) => (
            <article key={item.title} className={`audienceCard ${item.tone}`}>
              <div className="audienceIllustration">{item.image}</div>
              <div>
                <h3>{item.title}</h3>
                <ul>
                  {item.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="examples" className="homeSection">
        <div className="sectionHeading">
          <span />
          <h2>你可以生成什么</h2>
          <span />
        </div>
        <div className="templateGrid">
          {generationTypes.map((item) => (
            <article key={item.title} className="templateCard">
              <div className="templateThumb">
                <img src={item.img} alt={`${item.title}示例`} loading="lazy" />
                <b>{item.tag}</b>
              </div>
              <h3>{item.title}</h3>
            </article>
          ))}
        </div>
      </section>

      <section className="homeSection createSteps">
        <div className="sectionHeading">
          <span />
          <h2>三步完成创作</h2>
          <span />
        </div>
        <div className="stepGrid">
          {creationSteps.map((step) => (
            <article key={step.no} className="stepCard">
              <strong>{step.no}</strong>
              <div>
                <h3>{step.title}</h3>
                <p>{step.desc}</p>
              </div>
              <span>{step.icon}</span>
            </article>
          ))}
        </div>
      </section>

      <section id="help" className="homeSection">
        <div className="sectionHeading">
          <span />
          <h2>为什么选择奇点小匠</h2>
          <span />
        </div>
        <div className="advantageGrid">
          {advantages.map((item) => (
            <article key={item.title} className="advantageCard">
              <span>{item.icon}</span>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="pricing" className="homeSection homeStats">
        <article className="betaStat">
          <strong>🎁 内测免费</strong>
          <span>现在注册即可体验创作与发布</span>
        </article>
        <article>
          <strong>⏱ 3 分钟</strong>
          <span>完成一个互动作品</span>
        </article>
        <article>
          <strong>👥 多场景</strong>
          <span>适合课堂、社团、活动与招生</span>
        </article>
        <article>
          <strong>🎓 易上手</strong>
          <span>老师和学生都能轻松使用</span>
        </article>
      </section>

      {showcasedGames.length ? (
        <section className="homeSection communitySection" aria-label="社区作品">
          <div className="communityHead">
            <div className="sectionHeading">
              <span />
              <h2>社区精选作品</h2>
              <span />
            </div>
            <a className="moreWorksLink" href="/works" aria-label="查看更多社区作品">
              更多作品
            </a>
          </div>
          <section className="gameGrid" aria-label="game list">
            {showcasedGames.map((g) => (
              <article key={g.id} className="gameItem" aria-label={g.title}>
                <a className="gameLink" href={toGameEntryHref(g.path)} aria-label={`打开游戏：${g.title}`}>
                  <img className="gameThumb" src={g.coverUrl} alt={`${g.title}截图`} loading="lazy" decoding="async" />
                  <div className="gameBody">
                    <div className="gameName">{g.title}</div>
                    <div className="gameDesc">{g.shortDesc}</div>
                    {g.playCount >= 3 || g.likeCount >= 1 ? (
                      <div className="gameStatRow" aria-label="游戏数据">
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
      ) : null}

      <section className="homeFinalCta">
        <div>
          <span>📚</span>
          <h2>让每一节课都更有互动感</h2>
          <p>内测期间免费使用。从一句话开始，把教学想法变成可玩、可分享的作品。</p>
        </div>
        <div className="finalActions">
          <a className="primaryCta" href="/create">
            免费开始内测
          </a>
          <a className="secondaryCta" href="#examples">
            查看示例
          </a>
        </div>
      </section>

      <section id="contact" className="homeContact" aria-label="联系我们">
        <div className="contactCopy">
          <span>联系我们</span>
          <h2>想了解内测、合作或课堂使用方式？</h2>
          <p>欢迎扫码添加微信，告诉我你的使用场景和想做的互动内容。</p>
        </div>
        <div className="contactQrCard">
          <img src="/assets/screenshots/二维码.png" alt="奇点小匠微信二维码" loading="lazy" />
          <strong>扫码添加微信</strong>
          <small>内测反馈 / 教育合作 / 使用咨询</small>
        </div>
      </section>
    </main>
  );
}
