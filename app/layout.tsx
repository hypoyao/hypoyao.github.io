import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { getLegalConfig } from "@/lib/legal";

export const metadata: Metadata = {
  title: "奇点小匠",
  description: "用 AI 对话，让创意成真。把想法做成可分享的应用与互动作品。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const legal = getLegalConfig();

  return (
    <html lang="zh-CN">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {/* favicon：浏览器会强缓存，这里加版本号方便立即生效 */}
        <link rel="icon" href="/favicon.svg?v=7" type="image/svg+xml" sizes="any" />
        <link rel="icon" href="/favicon-32.png?v=7" type="image/png" sizes="32x32" />
        <link rel="icon" href="/favicon-16.png?v=7" type="image/png" sizes="16x16" />
        <link rel="shortcut icon" href="/favicon.ico?v=7" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=7" />
        {/* 复用原有静态样式（位于 public/） */}
        {/* 注意：public 下的 css 可能被浏览器/CDN 缓存；这里加版本号方便样式立即生效 */}
        <link rel="stylesheet" href="/styles.css?v=20" />
        <link rel="stylesheet" href="/home.css?v=20" />
        <link rel="stylesheet" href="/creators.css?v=20" />
        <link rel="stylesheet" href="/create.css?v=21" />
      </head>
      <body>
        {children}
        <footer className="siteLegalFooter" aria-label="网站法律信息">
          <div className="siteLegalFooterInner">
            <div className="siteLegalFooterTop">
              <div className="siteLegalFooterBrand">{legal.siteName}</div>
              <nav className="siteLegalFooterNav">
                <a href="/privacy">隐私政策</a>
                <a href="/terms">服务条款</a>
              </nav>
            </div>
            <div className="siteLegalFooterMeta">
              <div className="siteLegalFooterCopy">{legal.copyrightLine}</div>
              <div className="siteLegalFooterRecord">
                {legal.icpBeian ? <span>{legal.icpBeian}</span> : null}
                {legal.publicSecurityBeian ? (
                  legal.publicSecurityBeianLink ? (
                    <a href={legal.publicSecurityBeianLink} target="_blank" rel="noreferrer">
                      {legal.publicSecurityBeian}
                    </a>
                  ) : (
                    <span>{legal.publicSecurityBeian}</span>
                  )
                ) : null}
              </div>
            </div>
          </div>
        </footer>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
