import type { ReactNode } from "react";
import { getLegalConfig } from "@/lib/legal";

type Section = {
  title: string;
  body: ReactNode;
};

export default function LegalPage({
  title,
  summary,
  sections,
}: {
  title: string;
  summary: string;
  sections: Section[];
}) {
  const cfg = getLegalConfig();

  return (
    <main className="wrap legalPage">
      <section className="card legalCard">
        <a className="legalBackLink" href="/">
          ← 返回首页
        </a>
        <header className="legalHeader">
          <div className="legalEyebrow">{cfg.siteName}</div>
          <h1 className="legalTitle">{title}</h1>
          <p className="legalSummary">{summary}</p>
          <div className="legalMeta">
            <span>生效日期：{cfg.effectiveDate}</span>
            <span>运营者：{cfg.operatorName}</span>
            <span>联系邮箱：{cfg.contactEmail}</span>
          </div>
        </header>

        <div className="legalContent">
          {sections.map((section) => (
            <section key={section.title} className="legalSection">
              <h2>{section.title}</h2>
              <div className="legalSectionBody">{section.body}</div>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
