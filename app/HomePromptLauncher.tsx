"use client";

import { useState } from "react";
import { stashLaunchPrompt } from "@/lib/creator/launchPrompt";
import MiniProgramLaunchButton from "./MiniProgramLaunchButton";

const EXAMPLE_PROMPTS = [
  {
    label: "示例：打地鼠小猫",
    prompt: "我想做一个打地鼠游戏，主角是一只偷吃的小猫，要有声音效果和难度等级。",
  },
  {
    label: "示例：英语单词记忆",
    prompt: "我想做一个英语单词记忆游戏，每次问一道题，答对加分，答错提示。",
  },
  {
    label: "示例：跳跳球成就",
    prompt: "我想做一个可爱的跳跳球游戏，背景渐变，要有排行榜和成就。",
  },
];

function toCreateUrl(prompt: string) {
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

export default function HomePromptLauncher() {
  const [input, setInput] = useState("");
  const [modalPrompt, setModalPrompt] = useState("");
  const [modalOpenKey, setModalOpenKey] = useState(0);

  function goWithPrompt(prompt: string) {
    if (isDesktopViewport()) {
      setModalPrompt(String(prompt || ""));
      setModalOpenKey((x) => x + 1);
      return;
    }
    window.location.href = toCreateUrl(prompt);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    goWithPrompt(input);
  }

  return (
    <>
      <form className="heroInputRow" onSubmit={onSubmit}>
        <input
          className="heroInput"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="帮我生成一个小学英语单词闯关小应用"
          autoComplete="off"
          name="prompt"
        />
        <button className="heroCtaBtn" type="submit">
          立即生成
        </button>
      </form>
      {modalOpenKey > 0 ? (
        <MiniProgramLaunchButton className="miniProgramHiddenTrigger" prompt={modalPrompt} autoOpenKey={modalOpenKey}>
          立即生成
        </MiniProgramLaunchButton>
      ) : null}

      <div className="heroChips" aria-label="prompt templates">
        {EXAMPLE_PROMPTS.map((item) => (
          <button key={item.label} className="heroChip" type="button" onClick={() => goWithPrompt(item.prompt)}>
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
