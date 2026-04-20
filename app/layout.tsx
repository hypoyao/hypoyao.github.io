import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const metadata: Metadata = {
  title: "AI创意小游戏",
  description: "用 AI，释放孩子的奇思妙想，体验创造的快乐。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {/* favicon：浏览器会强缓存，这里加版本号方便立即生效 */}
        <link rel="icon" href="/favicon.svg?v=6" type="image/svg+xml" sizes="any" />
        <link rel="shortcut icon" href="/favicon.svg?v=6" type="image/svg+xml" />
        {/* 复用原有静态样式（位于 public/） */}
        <link rel="stylesheet" href="/styles.css" />
        <link rel="stylesheet" href="/home.css" />
        <link rel="stylesheet" href="/creators.css" />
        <link rel="stylesheet" href="/create.css" />
      </head>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
