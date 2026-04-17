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
        {/* 复用原有静态样式（位于 public/） */}
        <link rel="stylesheet" href="/styles.css" />
        <link rel="stylesheet" href="/home.css" />
        <link rel="stylesheet" href="/creators.css" />
      </head>
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}

