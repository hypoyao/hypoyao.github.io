"use client";

import { useMemo, useState } from "react";

export default function GamePromptModal({ title, prompt }: { title: string; prompt: string }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => (prompt || "").trim(), [prompt]);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(text || "");
    } catch {
      // ignore
    }
  }

  return (
    <>
      <button
        type="button"
        className="promptTrigger"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        与AI的对话（Prompt）
      </button>

      {open ? (
        <div
          className="promptModal"
          role="dialog"
          aria-modal="true"
          aria-label="与AI的对话"
          onClick={(e) => {
            // 点击遮罩：只关闭弹窗，不把点击“传递”给底下的卡片链接
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="promptModalPanel"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div className="promptModalHead">
              <div className="promptModalTitle">{title} · 与AI的对话</div>
              <div className="promptModalActions">
                <button type="button" className="promptIconBtn" onClick={copyAll} aria-label="复制全文">
                  复制
                </button>
                <button type="button" className="promptIconBtn" onClick={() => setOpen(false)} aria-label="关闭">
                  关闭
                </button>
              </div>
            </div>
            <pre className="promptModalBody">{text || "（空）"}</pre>
          </div>
        </div>
      ) : null}
    </>
  );
}
