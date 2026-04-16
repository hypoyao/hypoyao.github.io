"use strict"

const SIZE = 8
const NEED = 5
const MAX_STONES = 5
const FADE_MS = 260

const POET = 1 // 您（叉）
const AI = 2 // AI（白子）

const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $turnText = document.getElementById("turnText")
const $diffGrid = document.getElementById("diffGrid")
const $diffText = document.getElementById("diffText")
const $resetBtn = document.getElementById("resetBtn")
const $goModal = document.getElementById("goModal")
const $goModalBody = document.getElementById("goModalBody")
const $goAgainBtn = document.getElementById("goAgainBtn")
const $goDiffModal = document.getElementById("goDiffModal")
const $goDiffPicker = document.getElementById("goDiffPicker")
const $goDiffCurrent = document.getElementById("goDiffCurrent")
const $goDiffCloseBtn = document.getElementById("goDiffCloseBtn")
const $goTipModal = document.getElementById("goTipModal")
const $goTipText = document.getElementById("goTipText")

let state = null
let fadeTimers = Array(SIZE * SIZE).fill(null)

// 难度等级：1~10（默认 10），赢 +1，输 -1
const MIN_DIFF = 1
const MAX_DIFF = 10
const STORAGE_GOMOKU_DIFF_KEY = "gomoku_diff_v1"
let difficulty = MAX_DIFF

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function loadDifficulty() {
  const v = Number(localStorage.getItem(STORAGE_GOMOKU_DIFF_KEY) || MAX_DIFF)
  difficulty = clamp(Number.isFinite(v) ? v : MAX_DIFF, MIN_DIFF, MAX_DIFF)
}

function saveDifficulty() {
  try {
    localStorage.setItem(STORAGE_GOMOKU_DIFF_KEY, String(difficulty))
  } catch {}
}

function setDifficultyManual(next) {
  difficulty = clamp(Number(next) || MAX_DIFF, MIN_DIFF, MAX_DIFF)
  saveDifficulty()
  renderDifficulty()
  renderGoDiffPicker()
}

function idxToRC(idx) {
  return { r: Math.floor(idx / SIZE), c: idx % SIZE }
}

function rcToIdx(r, c) {
  return r * SIZE + c
}

function getStoneCount(player) {
  return state.queues[player].length
}

function aboutToVanishIndex(player) {
  return state.queues[player].length === MAX_STONES ? state.queues[player][0] : null
}

function clearFadeTimers() {
  fadeTimers.forEach((t) => t && clearTimeout(t))
  fadeTimers = Array(SIZE * SIZE).fill(null)
}

function setStatusText() {
  if (state.winner) {
    if ($turnText) $turnText.textContent = state.winner === POET ? "结果：您获胜" : "结果：AI 获胜"
    return
  }
  if ($turnText) $turnText.textContent = state.currentPlayer === POET ? "轮到 您" : "轮到 AI"
}

function renderDifficulty() {
  if ($diffText) $diffText.textContent = `难度等级 ${difficulty} / 10`
  if (!$diffGrid) return
  if ($diffGrid.childElementCount !== 10) {
    $diffGrid.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "goDiffDot"
      dot.dataset.level = String(i)
      $diffGrid.appendChild(dot)
    }
  }
  const dots = $diffGrid.querySelectorAll(".goDiffDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isOn", lv > 0 && lv <= difficulty)
  })
}

function renderGoDiffPicker() {
  if ($goDiffCurrent) $goDiffCurrent.textContent = String(difficulty)
  if (!$goDiffPicker) return
  if ($goDiffPicker.childElementCount !== 10) {
    $goDiffPicker.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "diffPickDot"
      dot.dataset.level = String(i)
      dot.title = `难度等级 ${i}`
      $goDiffPicker.appendChild(dot)
    }
  }
  const dots = $goDiffPicker.querySelectorAll(".diffPickDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isOn", lv > 0 && lv <= difficulty)
  })
}

function openGoDiffModal() {
  if (!$goDiffModal) return
  renderGoDiffPicker()
  $goDiffModal.classList.add("isOpen")
  $goDiffModal.setAttribute("aria-hidden", "false")
}

function closeGoDiffModal() {
  if (!$goDiffModal) return
  $goDiffModal.classList.remove("isOpen")
  $goDiffModal.setAttribute("aria-hidden", "true")
}

function openTipModal() {
  if (!$goTipModal) return
  if ($goTipText) $goTipText.textContent = "难度等级 1-10，输赢后会自动升降等级"
  $goTipModal.classList.add("isOpen")
  $goTipModal.setAttribute("aria-hidden", "false")
}

function closeTipModal() {
  if (!$goTipModal) return
  $goTipModal.classList.remove("isOpen")
  $goTipModal.setAttribute("aria-hidden", "true")
}

function openModal(winner) {
  if (!$goModal || !$goModalBody) return
  $goModalBody.textContent = winner === POET ? "您获胜！" : "AI 获胜！"
  $goModal.classList.add("isOpen")
  $goModal.setAttribute("aria-hidden", "false")
}

function closeModal() {
  if (!$goModal) return
  $goModal.classList.remove("isOpen")
  $goModal.setAttribute("aria-hidden", "true")
}

function startFade(idx, player) {
  if (idx === null || idx === undefined) return
  if (idx < 0 || idx >= SIZE * SIZE) return
  if (fadeTimers[idx]) clearTimeout(fadeTimers[idx])
  state.fading[idx] = player
  renderBoard()
  fadeTimers[idx] = window.setTimeout(() => {
    state.fading[idx] = 0
    fadeTimers[idx] = null
    renderBoard()
  }, FADE_MS)
}

function getWinLine(board, player) {
  const dirs = [
    { dr: 0, dc: 1 },
    { dr: 1, dc: 0 },
    { dr: 1, dc: 1 },
    { dr: 1, dc: -1 },
  ]
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[rcToIdx(r, c)] !== player) continue
      for (const { dr, dc } of dirs) {
        const line = [rcToIdx(r, c)]
        for (let k = 1; k < NEED; k++) {
          const rr = r + dr * k
          const cc = c + dc * k
          if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) {
            line.length = 0
            break
          }
          const ii = rcToIdx(rr, cc)
          if (board[ii] !== player) {
            line.length = 0
            break
          }
          line.push(ii)
        }
        if (line.length === NEED) return line
      }
    }
  }
  return null
}

function recomputeWinner() {
  if (state.winner) return
  const bLine = getWinLine(state.board, POET)
  if (bLine) {
    state.winner = POET
    state.winLine = bLine
    return
  }
  const wLine = getWinLine(state.board, AI)
  if (wLine) {
    state.winner = AI
    state.winLine = wLine
  }
}

function applyMove(idx) {
  const p = state.currentPlayer
  if (state.winner) return
  if (state.board[idx] !== 0) return
  if (state.fading[idx] !== 0) return

  // 第 6 子：先移除最早那颗（落子前已显示为 about）
  const removedIdx = state.queues[p].length === MAX_STONES ? state.queues[p][0] : null
  if (state.queues[p].length === MAX_STONES) {
    const removed = state.queues[p].shift()
    if (removed !== undefined) state.board[removed] = 0
  }

  state.queues[p].push(idx)
  state.board[idx] = p

  if (removedIdx !== null) startFade(removedIdx, p)

  recomputeWinner()
  if (!state.winner) state.currentPlayer = p === POET ? AI : POET
}

function renderBoard(rebuild = false) {
  if (!$board) return
  if (rebuild) {
    $board.innerHTML = ""
    for (let i = 0; i < SIZE * SIZE; i++) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "goCell"
      btn.dataset.idx = String(i)
      btn.setAttribute("aria-label", `cell-${i}`)
      btn.addEventListener("click", onCellClick)
      $board.appendChild(btn)
    }
  }

  const aboutIdx = !state.winner ? aboutToVanishIndex(state.currentPlayer) : null
  const cells = $board.querySelectorAll(".goCell")
  cells.forEach((cell, i) => {
    const v = state.board[i] || state.fading[i]
    const isFading = state.board[i] === 0 && state.fading[i] !== 0
    const isAbout = !isFading && state.board[i] !== 0 && aboutIdx === i

    // render stone
    cell.innerHTML = ""
    if (v === POET || v === AI) {
      const mark = document.createElement("span")
      mark.className = `goMark ${v === POET ? "x" : "o"}`
      mark.textContent = v === POET ? "×" : "○"
      if (isAbout) mark.classList.add("about")
      if (isFading) mark.classList.add("fading")
      cell.appendChild(mark)
    }

    cell.classList.toggle("win", !!state.winLine && state.winLine.includes(i))
    cell.disabled = !!state.winner || state.board[i] !== 0 || isFading
  })

  setStatusText()
}

function onCellClick(e) {
  const idx = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(idx)) return
  applyMove(idx)
  renderBoard()
  if (state.winner) {
    // 输赢影响难度：您赢 +1，您输 -1（范围 1~10）
    if (state.winner === POET) difficulty = clamp(difficulty + 1, MIN_DIFF, MAX_DIFF)
    else difficulty = clamp(difficulty - 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty()
    renderDifficulty()
    openModal(state.winner)
    return
  }

  // AI 回合：简单策略（不追求很强，但能对弈）
  if (state.currentPlayer === AI) {
    window.setTimeout(() => {
      if (state.winner) return
      aiMove()
      renderBoard()
      if (state.winner) openModal(state.winner)
    }, 260)
  }
}

function availableMoves() {
  const res = []
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (state.board[i] === 0 && state.fading[i] === 0) res.push(i)
  }
  return res
}

function isWinningMove(player, idx) {
  // 临时落子测试
  const savedBoard = state.board[idx]
  const savedQueues = state.queues[player].slice()

  // 模拟第 6 子规则
  let removed = null
  if (savedQueues.length === MAX_STONES) {
    removed = savedQueues.shift()
  }
  savedQueues.push(idx)

  const boardCopy = state.board.slice()
  boardCopy[idx] = player
  if (removed !== null && removed !== undefined) boardCopy[removed] = 0

  return !!getWinLine(boardCopy, player)
}

function aiMove() {
  const moves = availableMoves()
  if (moves.length === 0) return

  // 难度越低：越容易“犯错/走神”
  const t = (MAX_DIFF - difficulty) / (MAX_DIFF - MIN_DIFF) // 0~1
  const randomRate = 0.05 + 0.55 * t
  const skipTacticsRate = 0.02 + 0.60 * t

  // 0) 低难度可能直接随机
  if (Math.random() < randomRate) {
    const pick = moves[Math.floor(Math.random() * moves.length)]
    return applyMove(pick)
  }

  // 1) 先找一步必胜
  if (Math.random() >= skipTacticsRate) {
    for (const m of moves) if (isWinningMove(AI, m)) return applyMove(m)
    // 2) 再防对方一步必胜
    for (const m of moves) if (isWinningMove(POET, m)) return applyMove(m)
  }

  // 3) 否则偏好中心附近
  const center = { r: 3.5, c: 3.5 }
  const scorePos = (idx) => {
    const { r, c } = idxToRC(idx)
    const dr = r - center.r
    const dc = c - center.c
    return -(dr * dr + dc * dc)
  }
  const scoreLine = (idx) => {
    // 粗略：落子后自己最长连子长度（越大越好）
    const savedQueues = state.queues[AI].slice()
    let removed = null
    if (savedQueues.length === MAX_STONES) removed = savedQueues.shift()
    savedQueues.push(idx)

    const boardCopy = state.board.slice()
    boardCopy[idx] = AI
    if (removed !== null && removed !== undefined) boardCopy[removed] = 0

    return maxLineLen(boardCopy, AI, idx)
  }

  moves.sort((a, b) => {
    const la = scoreLine(a)
    const lb = scoreLine(b)
    if (lb !== la) return lb - la
    return scorePos(b) - scorePos(a)
  })

  // 4) 难度越低：从更大的 topK 里随机
  const topK = Math.min(moves.length, Math.round(1 + 7 * t) + 1) // diff=10 -> 2, diff=1 -> 9
  const pick = moves[Math.floor(Math.random() * topK)]
  applyMove(pick)
}

function maxLineLen(board, player, idx) {
  const { r, c } = idxToRC(idx)
  const dirs = [
    { dr: 0, dc: 1 },
    { dr: 1, dc: 0 },
    { dr: 1, dc: 1 },
    { dr: 1, dc: -1 },
  ]
  let best = 1
  for (const { dr, dc } of dirs) {
    let cnt = 1
    // forward
    for (let k = 1; k < NEED; k++) {
      const rr = r + dr * k
      const cc = c + dc * k
      if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) break
      if (board[rcToIdx(rr, cc)] !== player) break
      cnt++
    }
    // backward
    for (let k = 1; k < NEED; k++) {
      const rr = r - dr * k
      const cc = c - dc * k
      if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) break
      if (board[rcToIdx(rr, cc)] !== player) break
      cnt++
    }
    best = Math.max(best, cnt)
  }
  return best
}

function reset() {
  closeModal()
  clearFadeTimers()
  loadDifficulty()
  state = {
    board: Array(SIZE * SIZE).fill(0),
    currentPlayer: POET,
    queues: { 1: [], 2: [] },
    fading: Array(SIZE * SIZE).fill(0),
    winner: 0,
    winLine: null,
  }
  renderBoard(true)
  renderDifficulty()
}

// 连续点击“轮到您”3次打开难度彩蛋
const DIFF_TAP_NEED = 3
const DIFF_TAP_WINDOW_MS = 1200
let diffTapCount = 0
let diffTapTimer = null

if ($turnText) {
  $turnText.addEventListener("click", () => {
    // 仅当文案处于“轮到 您”时才计数，避免在“结果”状态误触
    if (!$turnText.textContent || !$turnText.textContent.includes("轮到 您")) return

    diffTapCount += 1
    if (diffTapTimer) clearTimeout(diffTapTimer)
    diffTapTimer = window.setTimeout(() => {
      diffTapCount = 0
      diffTapTimer = null
    }, DIFF_TAP_WINDOW_MS)

    if (diffTapCount >= DIFF_TAP_NEED) {
      diffTapCount = 0
      if (diffTapTimer) clearTimeout(diffTapTimer)
      diffTapTimer = null
      openGoDiffModal()
    }
  })
}

// 点击“难度等级”显示提示
if ($diffGrid) {
  $diffGrid.addEventListener("click", () => openTipModal())
}

if ($goTipModal) {
  $goTipModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeTipModal()
  })
}

if ($goDiffModal) {
  $goDiffModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeGoDiffModal()
  })
}
if ($goDiffCloseBtn) {
  $goDiffCloseBtn.addEventListener("click", () => closeGoDiffModal())
}
if ($goDiffPicker) {
  $goDiffPicker.addEventListener("click", (e) => {
    const t = e.target
    const lv = Number(t?.dataset?.level || 0)
    if (lv >= 1 && lv <= 10) setDifficultyManual(lv)
  })
}

if ($resetBtn) $resetBtn.addEventListener("click", reset)
if ($goAgainBtn) $goAgainBtn.addEventListener("click", reset)
if ($goModal) {
  $goModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeModal()
  })
}

reset()
