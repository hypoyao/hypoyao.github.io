export default function NotFound() {
  return (
    <main className="wrap">
      <section className="card homeCard">
        <header className="header">
          <h1>页面不存在</h1>
          <p className="desc">你访问的页面不存在或已被移动。</p>
        </header>
        <div className="homeFooter">
          <a className="btn btnSecondary" href="/">
            返回首页
          </a>
        </div>
      </section>
    </main>
  );
}

