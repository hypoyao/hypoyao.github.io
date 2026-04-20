"use strict"

// 全局护眼休息弹窗：
// - 用户开始“玩”（首次点击棋盘/开始/重新开始按钮）后计时 10 秒
// - 满 10 秒自动弹窗提醒休息 20 秒
// - 20 秒内屏蔽所有点击/键盘交互（点击也没用）
// - 20 秒结束后自动关闭，等待下一次“开始玩”再重新计时

;(function () {
  const PLAY_MS = 10 * 60_000
  const REST_MS = 60_000
  const MESSAGE = "记得休息小眼睛哦，看6米外面1分钟再来玩吧"

  let playTimer = null
  let restTimer = null
  let countdownTimer = null
  let started = false
  let resting = false

  let $modal = null
  let $count = null

  const blockerHandler = (e) => {
    if (!resting) return
    // 捕获阶段拦截，确保游戏逻辑收不到事件
    e.preventDefault()
    e.stopPropagation()
    // stopImmediatePropagation 在部分事件上更彻底
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
    return false
  }

  function attachBlockers() {
    const opts = { capture: true, passive: false }
    ;["pointerdown", "pointerup", "click", "mousedown", "mouseup", "touchstart", "touchend", "keydown"].forEach((t) => {
      document.addEventListener(t, blockerHandler, opts)
    })
  }

  function detachBlockers() {
    const opts = { capture: true }
    ;["pointerdown", "pointerup", "click", "mousedown", "mouseup", "touchstart", "touchend", "keydown"].forEach((t) => {
      document.removeEventListener(t, blockerHandler, opts)
    })
  }

  function ensureModal() {
    if ($modal) return
    $modal = document.createElement("div")
    $modal.className = "restModal"
    $modal.setAttribute("aria-hidden", "true")
    $modal.innerHTML = `
      <div class="restBackdrop"></div>
      <div class="restPanel" role="dialog" aria-modal="true" aria-label="rest dialog">
        <div class="restTitle">休息一下</div>
        <div class="restBody">
          <div class="restMsg">${MESSAGE}</div>
          <div class="restSub">还有 <strong class="restCount" id="restCount">20</strong> 秒自动返回</div>
        </div>
      </div>
    `
    document.body.appendChild($modal)
    $count = $modal.querySelector("#restCount")
  }

  function clearTimers() {
    if (playTimer) clearTimeout(playTimer)
    if (restTimer) clearTimeout(restTimer)
    if (countdownTimer) clearInterval(countdownTimer)
    playTimer = null
    restTimer = null
    countdownTimer = null
  }

  function openRest() {
    ensureModal()
    resting = true
    clearTimers()

    // 显示弹窗
    $modal.classList.add("isOpen")
    $modal.setAttribute("aria-hidden", "false")

    // 屏蔽交互
    attachBlockers()

    // 倒计时
    const start = Date.now()
    const update = () => {
      const left = Math.max(0, REST_MS - (Date.now() - start))
      const sec = Math.ceil(left / 1000)
      if ($count) $count.textContent = String(sec)
      if (left <= 0) closeRest()
    }
    update()
    countdownTimer = setInterval(update, 250)

    restTimer = setTimeout(() => closeRest(), REST_MS + 30)
  }

  function closeRest() {
    if (!$modal) return
    resting = false
    clearTimers()
    detachBlockers()
    $modal.classList.remove("isOpen")
    $modal.setAttribute("aria-hidden", "true")
    started = false // 结束后等待下一次“开始玩”再重新计时
  }

  function startPlayTimer() {
    if (resting) return
    if (playTimer) return
    playTimer = setTimeout(() => {
      playTimer = null
      openRest()
    }, PLAY_MS)
  }

  function markPlaying() {
    if (resting) return
    if (!started) {
      started = true
      startPlayTimer()
    }
  }

  function isGameActionTarget(t) {
    if (!t || typeof t.closest !== "function") return false
    // 统一：棋盘区域、开始/重新开始按钮算“开始玩”
    if (t.closest("#board")) return true
    if (t.closest("button#startBtn")) return true
    if (t.closest("button#resetBtn")) return true
    return false
  }

  function init() {
    ensureModal()
    // 监听用户开始玩（捕获阶段，尽量早触发）
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (resting) return
        if (isGameActionTarget(e.target)) markPlaying()
      },
      { capture: true }
    )

    // ===== 彩蛋：点标题 6 下，切换“提示一步”按钮显示/隐藏 =====
    ;(() => {
      // 只在存在提示按钮的小游戏里启用
      const hintBtns = Array.from(document.querySelectorAll("button#hintBtn"))
      if (!hintBtns.length) return

      const titleEl = document.querySelector(".header h1") || document.querySelector("h1")
      if (!titleEl) return

      let tap = 0
      let hintOff = false
      let lastAt = 0

      const apply = () => {
        for (const b of hintBtns) {
          b.disabled = hintOff
          b.style.display = hintOff ? "none" : ""
          b.setAttribute("aria-hidden", hintOff ? "true" : "false")
        }
      }
      apply()

      titleEl.addEventListener(
        "pointerdown",
        (e) => {
          // 避免影响页面其它交互
          try {
            e.preventDefault()
          } catch {}
          const now = Date.now()
          if (now - lastAt > 1500) tap = 0 // 超过 1.5s 视为重新开始连点
          lastAt = now
          tap++
          if (tap >= 6) {
            tap = 0
            hintOff = !hintOff
            apply()
          }
        },
        { passive: false }
      )
    })()
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    init()
  }
})()
