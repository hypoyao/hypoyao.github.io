"use strict"

// 记忆力挑战：
// - 9 宫格亮起序列（按顺序闪烁）
// - 玩家按顺序复现点击
// - 难度 1~10：序列长度 = level + 1（第 1 级为 2）
// - 每级需连续成功 3 次才晋级；任意一次失败则退一级并清零本级进度
// - 进度条：10 个小格子，涂黑表示已完成（level 之前的）

const MIN_LEVEL = 1
const MAX_LEVEL = 10
const SUCCESS_NEED = 3

// 本地存档：刷新后保留当前等级与本级进度
const STORAGE_MEM_PROGRESS_KEY = "mem_progress_v1"

const FLASH_ON_MS = 420
// 两次高亮之间间隔稍长一点
const FLASH_GAP_MS = 260
const BETWEEN_ROUNDS_MS = 450

const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $startBtn = document.getElementById("startBtn")
const $levelGrid = document.getElementById("levelGrid")
const $levelText = document.getElementById("levelText")
const $trialText = document.getElementById("trialText")
const $memModal = document.getElementById("memModal")
const $memModalBody = document.getElementById("memModalBody")
const $memModalBtn = document.getElementById("memModalBtn")

let level = MIN_LEVEL
let streak = 0 // 当前等级已成功次数（0~2）

let phase = "idle" // idle | showing | input
let seq = []
let inputIndex = 0
let busyTimer = null
let runToken = 0 // 用于中断旧的闪烁任务，避免残留高亮
let modalResolver = null
let hasStarted = false

// ========= 音效：按 do re mi fa so la si 循环播放 =========
// 说明：iOS/Safari 需要用户手势才能启动音频，因此在点击“开始”时初始化 AudioContext
let audioCtx = null
const SCALE_FREQ = [
  261.63, // do (C4)
  293.66, // re (D4)
  329.63, // mi (E4)
  349.23, // fa (F4)
  392.0, // so (G4)
  440.0, // la (A4)
  493.88, // si (B4)
]

// 每个格子固定一个音符（保证“系统高亮”和“玩家点击”的音一致）
// 9 宫格：从左到右、从上到下
const CELL_NOTE_INDEX = [
  0, // 0 -> do
  1, // 1 -> re
  2, // 2 -> mi
  3, // 3 -> fa
  4, // 4 -> so
  5, // 5 -> la
  6, // 6 -> si
  0, // 7 -> do
  1, // 8 -> re
]

function ensureAudio() {
  if (audioCtx) return
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return
  audioCtx = new AC()
}

function playCellNote(cellIdx) {
  try {
    if (!audioCtx) return
    if (audioCtx.state === "suspended") audioCtx.resume()

    const noteIndex = CELL_NOTE_INDEX[Number(cellIdx) || 0] ?? 0
    const freq = SCALE_FREQ[noteIndex] ?? SCALE_FREQ[0]

    const now = audioCtx.currentTime
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = "sine"
    osc.frequency.setValueAtTime(freq, now)

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)

    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
  } catch {
    // ignore
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

function loadProgress() {
  const raw = localStorage.getItem(STORAGE_MEM_PROGRESS_KEY)
  const data = safeJsonParse(raw || "{}", {})
  const lv = clamp(Number(data?.level) || MIN_LEVEL, MIN_LEVEL, MAX_LEVEL)
  const st = clamp(Number(data?.streak) || 0, 0, SUCCESS_NEED - 1)
  level = lv
  streak = st
}

function saveProgress() {
  try {
    localStorage.setItem(
      STORAGE_MEM_PROGRESS_KEY,
      JSON.stringify({
        level,
        streak,
        updatedAt: Date.now(),
      })
    )
  } catch {
    // ignore
  }
}

function setStatus(text) {
  if ($status) $status.textContent = text
}

function renderLevel() {
  if ($levelText) $levelText.textContent = `第 ${level} 级`
  if ($trialText) $trialText.textContent = `本级进度：${streak} / ${SUCCESS_NEED}`

  if ($levelGrid && $levelGrid.childElementCount !== MAX_LEVEL) {
    $levelGrid.innerHTML = ""
    for (let i = 1; i <= MAX_LEVEL; i++) {
      const dot = document.createElement("span")
      dot.className = "memLevelDot"
      dot.dataset.level = String(i)
      $levelGrid.appendChild(dot)
    }
  }
  if ($levelGrid) {
    const dots = $levelGrid.querySelectorAll(".memLevelDot")
    dots.forEach((el) => {
      const lv = Number(el.dataset.level || 0)
      // “已完成”定义：低于当前等级的等级都算完成
      el.classList.toggle("isDone", lv > 0 && lv < level)
    })
  }
}

function buildBoard() {
  if (!$board) return
  $board.innerHTML = ""
  for (let i = 0; i < 9; i++) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "memCell"
    btn.dataset.idx = String(i)
    btn.setAttribute("aria-label", `cell-${i}`)
    btn.addEventListener("click", onCellClick)
    $board.appendChild(btn)
  }
}

function setBoardEnabled(enabled) {
  if (!$board) return
  const cells = $board.querySelectorAll(".memCell")
  cells.forEach((c) => (c.disabled = !enabled))
}

function clearTimers() {
  if (busyTimer) clearTimeout(busyTimer)
  busyTimer = null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomSeq(len) {
  const arr = []
  for (let i = 0; i < len; i++) {
    let x = Math.floor(Math.random() * 9)
    // 连续两次不要高亮同一个方块
    if (i > 0) {
      let guard = 0
      while (x === arr[i - 1] && guard++ < 10) x = Math.floor(Math.random() * 9)
    }
    arr.push(x)
  }
  return arr
}

function clearBoardClasses() {
  if (!$board) return
  const cells = $board.querySelectorAll(".memCell")
  cells.forEach((c) => {
    c.classList.remove("isLit")
    c.classList.remove("isError")
  })
}

function lightCell(idx, on, kind = "lit") {
  const el = $board?.querySelector(`.memCell[data-idx="${idx}"]`)
  if (!el) return
  if (kind === "lit") el.classList.toggle("isLit", !!on)
  if (kind === "err") el.classList.toggle("isError", !!on)
}

function openModal(text, type) {
  if (!$memModal || !$memModalBody) return Promise.resolve()
  $memModalBody.classList.toggle("isOk", type === "ok")
  $memModalBody.classList.toggle("isBad", type === "bad")
  $memModalBody.textContent = text
  $memModal.classList.add("isOpen")
  $memModal.setAttribute("aria-hidden", "false")
  return new Promise((resolve) => {
    modalResolver = resolve
  })
}

function closeModal() {
  if (!$memModal) return
  $memModal.classList.remove("isOpen")
  $memModal.setAttribute("aria-hidden", "true")
  if (modalResolver) {
    const r = modalResolver
    modalResolver = null
    r()
  }
}

async function playSequence() {
  const token = ++runToken
  phase = "showing"
  inputIndex = 0
  setBoardEnabled(false)
  clearBoardClasses()

  const len = level + 1 // 第 1 级为 2
  seq = randomSeq(len)
  setStatus(`记住顺序…（${len} 个）`)

  await sleep(220)
  for (let i = 0; i < seq.length; i++) {
    if (token !== runToken) return
    const idx = seq[i]
    lightCell(idx, true, "lit")
    playCellNote(idx)
    await sleep(FLASH_ON_MS)
    if (token !== runToken) return
    lightCell(idx, false, "lit")
    await sleep(FLASH_GAP_MS)
  }

  await sleep(120)
  if (token !== runToken) return
  phase = "input"
  setBoardEnabled(true)
  clearBoardClasses()
  setStatus("按亮起顺序依次点击")
}

async function handleSuccess() {
  streak += 1
  saveProgress()
  renderLevel()

  if (streak >= SUCCESS_NEED) {
    // 晋级：前进一格
    const prev = level
    level = clamp(level + 1, MIN_LEVEL, MAX_LEVEL)
    streak = 0
    saveProgress()
    renderLevel()
    // 只有“升一级”才弹窗提示（更欢快一点）
    await openModal(prev === MAX_LEVEL ? "已满级！继续挑战也可以～" : "太棒啦！连胜 3 次，升级成功！", "ok")
  } else {
    // 小关成功不弹窗，只更新状态提示
    setStatus(`成功！本级进度：${streak} / ${SUCCESS_NEED}`)
    await sleep(BETWEEN_ROUNDS_MS)
  }

  await playSequence()
}

async function handleFail(wrongIdx) {
  setBoardEnabled(false)
  phase = "idle"

  // 反馈：闪红错误格子
  if (Number.isFinite(wrongIdx)) {
    lightCell(wrongIdx, true, "err")
    await sleep(240)
    lightCell(wrongIdx, false, "err")
  }

  // 失败：后退一格
  const prev = level
  level = clamp(level - 1, MIN_LEVEL, MAX_LEVEL)
  streak = 0
  saveProgress()
  renderLevel()
  await openModal(prev === MIN_LEVEL ? "可惜失败了…再试一次（已是最低等级）" : "可惜失败了…退一级再来", "bad")

  await playSequence()
}

function onCellClick(e) {
  // 首次点击 9 宫格自动开始
  if (!hasStarted && phase === "idle") {
    startGame()
    return
  }
  if (phase !== "input") return
  const idx = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(idx)) return

  // 视觉确认：轻闪一下
  if (busyTimer) clearTimeout(busyTimer)
  lightCell(idx, true, "lit")
  playCellNote(idx)
  busyTimer = setTimeout(() => lightCell(idx, false, "lit"), 140)

  const expected = seq[inputIndex]
  if (idx !== expected) {
    // 错误：立刻处理失败
    clearTimers()
    handleFail(idx)
    return
  }

  inputIndex += 1
  if (inputIndex >= seq.length) {
    clearTimers()
    setBoardEnabled(false)
    phase = "idle"
    handleSuccess()
  }
}

async function startGame() {
  if ($startBtn) $startBtn.disabled = true
  try {
    // 重新开局：中断旧的闪烁任务，并清空残留高亮
    runToken += 1
    clearTimers()
    clearBoardClasses()
    ensureAudio()
    hasStarted = true
    await playSequence()
  } finally {
    if ($startBtn) $startBtn.disabled = false
    if ($startBtn) $startBtn.textContent = "重新开始"
  }
}

function init() {
  loadProgress()
  buildBoard()
  // 允许首次点击棋盘自动开始
  setBoardEnabled(true)
  renderLevel()
  setStatus("点击任意方块开始挑战")
}

if ($startBtn) {
  $startBtn.addEventListener("click", () => {
    clearTimers()
    startGame()
  })
}

if ($memModal) {
  $memModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeModal()
  })
}
if ($memModalBtn) {
  $memModalBtn.addEventListener("click", () => closeModal())
}

init()
