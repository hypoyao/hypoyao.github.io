"use strict"

// 打地鼠：
// - 红色方块每 1 秒随机换位置
// - 1 秒内点到算成功（得分 +1），并立刻换位置（并重置 1 秒计时）
// - 若 1 秒结束仍未点到，算漏击 +1，然后换位置

const GAME_MS = 60_000
const START_MOVE_MS = 1000
const MIN_MOVE_MS = 500

const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $startBtn = document.getElementById("startBtn")
const $score = document.getElementById("score")
const $miss = document.getElementById("miss")
const $timeLeft = document.getElementById("timeLeft")
const $moleModal = document.getElementById("moleModal")
const $moleModalBody = document.getElementById("moleModalBody")
const $moleAgainBtn = document.getElementById("moleAgainBtn")

let running = false
let moleIndex = -1
let score = 0
let miss = 0
let pendingMiss = false
let timer = null
let tickTimer = null
let startedAt = 0
let endsAt = 0

// ========= 音效（WebAudio） =========
// iOS/Safari 需要用户手势启动音频，因此在 startNewGame()/首次点击棋盘时初始化
let audioCtx = null
function ensureAudio() {
  if (audioCtx) return
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  audioCtx = new AC()
  // 尽量在用户手势触发的调用链里解锁音频（Safari 常见要求）
  try {
    if (audioCtx.state === "suspended") audioCtx.resume()
    // 播放一个几乎听不见的极短“解锁音”
    const now = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = "sine"
    osc.frequency.setValueAtTime(440, now)
    gain.gain.setValueAtTime(0.00001, now)
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.02)
  } catch {
    // ignore
  }
}

function playTone(freq, durationMs, type = "sine", gainVal = 0.22) {
  try {
    if (!audioCtx) return
    // 注意：部分浏览器只允许在用户手势里 resume，ensureAudio 已尽力解锁；
    // 这里仍尝试一次，不影响主流程。
    if (audioCtx.state === "suspended") audioCtx.resume()
    const now = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, now)

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(gainVal, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000)

    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + durationMs / 1000 + 0.02)
  } catch {
    // ignore
  }
}

function playHitSound() {
  // “dong”：单次低沉提示音
  playTone(392, 140, "sine", 0.2)
}

function playMissSound() {
  // “漏打”：偏低的短促提示音
  playTone(220, 180, "triangle", 0.14)
}

function setStatus(t) {
  if ($status) $status.textContent = t
}

function renderHud() {
  if ($score) $score.textContent = String(score)
  if ($miss) $miss.textContent = String(miss)
}

function renderTimeLeft(ms) {
  if (!$timeLeft) return
  const s = Math.max(0, Math.ceil(ms / 1000))
  $timeLeft.textContent = `${s}s`
}

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = null
}

function clearTick() {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

function buildBoard() {
  if (!$board) return
  $board.innerHTML = ""
  for (let i = 0; i < 9; i++) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "moleCell"
    btn.dataset.idx = String(i)
    btn.setAttribute("aria-label", `cell-${i}`)
    btn.addEventListener("click", onCellClick)
    $board.appendChild(btn)
  }
}

function setMole(idx) {
  if (!$board) return
  const cells = $board.querySelectorAll(".moleCell")
  cells.forEach((c) => c.classList.remove("isMole"))
  const el = $board.querySelector(`.moleCell[data-idx="${idx}"]`)
  if (el) el.classList.add("isMole")
  moleIndex = idx
}

function randomNextIndex(prev) {
  let x = Math.floor(Math.random() * 9)
  let guard = 0
  while (x === prev && guard++ < 10) x = Math.floor(Math.random() * 9)
  return x
}

function currentMoveIntervalMs() {
  // 速度会越来越快：从 1.0s 线性加速到 0.5s
  const now = Date.now()
  const elapsed = Math.max(0, Math.min(GAME_MS, now - startedAt))
  const t = elapsed / GAME_MS // 0~1
  const ms = START_MOVE_MS - (START_MOVE_MS - MIN_MOVE_MS) * t
  return Math.max(MIN_MOVE_MS, Math.round(ms))
}

function scheduleNext() {
  clearTimer()
  pendingMiss = true
  const moveMs = currentMoveIntervalMs()
  timer = setTimeout(() => {
    if (!running) return
    if (pendingMiss) {
      miss += 1
      renderHud()
      playMissSound()
    }
    moveMole()
  }, moveMs)
}

function moveMole() {
  if (!running) return
  // 时间到则结束
  if (Date.now() >= endsAt) {
    endGame()
    return
  }
  const next = randomNextIndex(moleIndex)
  setMole(next)
  setStatus("快点到红色方块！")
  scheduleNext()
}

function openResultModal() {
  if (!$moleModal || !$moleModalBody) return
  $moleModalBody.textContent = `得分 ${score}，漏击 ${miss}`
  $moleModal.classList.add("isOpen")
  $moleModal.setAttribute("aria-hidden", "false")
}

function closeResultModal() {
  if (!$moleModal) return
  $moleModal.classList.remove("isOpen")
  $moleModal.setAttribute("aria-hidden", "true")
}

function endGame() {
  if (!running) return
  running = false
  pendingMiss = false
  clearTimer()
  clearTick()
  if ($startBtn) $startBtn.textContent = "开始"
  renderTimeLeft(0)
  setStatus(`时间到！本局得分：${score}`)
  openResultModal()
}

function startNewGame() {
  closeResultModal()
  running = true
  ensureAudio()
  score = 0
  miss = 0
  renderHud()
  startedAt = Date.now()
  endsAt = startedAt + GAME_MS
  renderTimeLeft(GAME_MS)

  if ($startBtn) $startBtn.textContent = "暂停"
  setStatus("开始！快点到红色方块！")

  clearTick()
  tickTimer = setInterval(() => {
    if (!running) return
    const left = Math.max(0, endsAt - Date.now())
    renderTimeLeft(left)
    if (left <= 0) endGame()
  }, 250)

  moveMole()
}

function stop() {
  running = false
  pendingMiss = false
  clearTimer()
  clearTick()
  if ($startBtn) $startBtn.textContent = "开始"
  setStatus("已暂停")
}

function toggle() {
  running ? stop() : startNewGame()
}

function onCellClick(e) {
  const idx = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(idx)) return

  // 首次点击棋盘自动开始
  if (!running) {
    startNewGame()
    return
  }

  if (idx === moleIndex) {
    pendingMiss = false
    score += 1
    renderHud()
    playHitSound()
    // 点中后立刻换位置，并重置计时
    moveMole()
  }
}

function init() {
  buildBoard()
  renderHud()
  setStatus("点击“开始”或点任意格子开始")
  renderTimeLeft(GAME_MS)
}

if ($startBtn) $startBtn.addEventListener("click", toggle)
if ($moleModal) {
  $moleModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeResultModal()
  })
}
if ($moleAgainBtn) {
  $moleAgainBtn.addEventListener("click", () => startNewGame())
}

init()
