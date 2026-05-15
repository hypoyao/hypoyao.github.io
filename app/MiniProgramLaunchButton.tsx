"use client";

import { useEffect, useState } from "react";
import { stashLaunchPrompt } from "@/lib/creator/launchPrompt";

function toCreateUrl(prompt = "") {
  const text = String(prompt || "").trim().slice(0, 800);
  if (!text) return "/create";
  const key = stashLaunchPrompt(text);
  if (!key) return "/create";
  return `/create?auto=1&promptKey=${encodeURIComponent(key)}`;
}

function isDesktopViewport() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent || "";
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
  return !mobile && window.matchMedia("(min-width: 760px)").matches;
}

export default function MiniProgramLaunchButton({
  className = "",
  children = "开始创作",
  prompt = "",
  arrow = false,
  autoOpenKey,
}: {
  className?: string;
  children?: React.ReactNode;
  prompt?: string;
  arrow?: boolean;
  autoOpenKey?: string | number;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpenKey == null) return;
    setOpen(true);
  }, [autoOpenKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!isDesktopViewport()) return;
    e.preventDefault();
    setOpen(true);
  }

  return (
    <>
      <a className={className} href={toCreateUrl(prompt)} aria-label="开始创作小应用" onClick={onClick}>
        {children}
        {arrow ? <span aria-hidden="true">→</span> : null}
      </a>
      {open ? (
        <div className="miniProgramModal" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="miniProgramModalCard"
            role="dialog"
            aria-modal="true"
            aria-label="扫码进入小程序创作"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="miniProgramModalClose" type="button" onClick={() => setOpen(false)} aria-label="关闭">
              ×
            </button>
            <div className="miniProgramModalBadge">推荐在小程序中创作</div>
            <h2>扫码打开「妙点小匠」小程序</h2>
            <p>PC 上创作请用微信扫码进入小程序，生成、预览和发布体验更稳定。</p>
            <div className="miniProgramModalQr">
              <img src="/assets/screenshots/miniprogram-code.jpg" alt="妙点小匠小程序码" />
            </div>
            <small>打开微信扫一扫，或截图后用微信识别小程序码。</small>
          </section>
        </div>
      ) : null}
    </>
  );
}
