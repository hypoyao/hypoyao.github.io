const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

function getWinLine(board, player) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line
    if (board[a] === player && board[b] === player && board[c] === player) return line
  }
  return null
}

function recomputeWinner(s, humanPlayer, aiPlayer) {
  if (s.winner) return s
  const hLine = getWinLine(s.board, humanPlayer)
  if (hLine) return { ...s, winner: humanPlayer, winLine: hLine }
  const aLine = getWinLine(s.board, aiPlayer)
  if (aLine) return { ...s, winner: aiPlayer, winLine: aLine }
  return s
}

function cloneState(s) {
  return {
    board: s.board.slice(),
    currentPlayer: s.currentPlayer,
    queues: {
      1: s.queues[1].slice(),
      2: s.queues[2].slice(),
    },
    fading: s.fading ? s.fading.slice() : Array(9).fill(0),
    winner: s.winner,
    winLine: s.winLine ? s.winLine.slice() : null,
  }
}

function stateKey(s) {
  // 注意：本规则下“落子顺序”会影响后续移除，因此必须把队列顺序也编码进 key
  return `${s.currentPlayer}|${s.board.join("")}|${s.queues[1].join(",")}|${s.queues[2].join(",")}`
}

function applyMove(s, idx, player) {
  const ns = cloneState(s)
  if (ns.winner) return ns
  if (ns.board[idx] !== 0) return ns

  // 每人最多3子：落第4子前，移除自己最早那颗
  if (ns.queues[player].length === 3) {
    const removed = ns.queues[player].shift()
    if (removed !== undefined) ns.board[removed] = 0
  }

  ns.queues[player].push(idx)
  ns.board[idx] = player

  const winLine = getWinLine(ns.board, player)
  if (winLine) {
    ns.winner = player
    ns.winLine = winLine
    return ns
  }

  ns.currentPlayer = player === 1 ? 2 : 1
  return ns
}

function availableMoves(s) {
  const moves = []
  for (let i = 0; i < 9; i++) if (s.board[i] === 0) moves.push(i)
  return moves
}

function evaluate(s, aiPlayer, humanPlayer, depth) {
  if (s.winner === aiPlayer) return 100000 - depth
  if (s.winner === humanPlayer) return -100000 + depth

  // 启发式：按“潜在三连”评分（只含一方棋子的线才算潜力）
  let score = 0
  for (const [a, b, c] of WIN_LINES) {
    const line = [s.board[a], s.board[b], s.board[c]]
    const aiCount = line.filter((v) => v === aiPlayer).length
    const huCount = line.filter((v) => v === humanPlayer).length
    if (aiCount > 0 && huCount > 0) continue
    if (aiCount > 0) score += aiCount === 1 ? 3 : aiCount === 2 ? 20 : 80
    if (huCount > 0) score -= huCount === 1 ? 3 : huCount === 2 ? 22 : 90
  }

  // 位置偏好：中心 > 角 > 边
  if (s.board[4] === aiPlayer) score += 2
  if (s.board[4] === humanPlayer) score -= 2
  const corners = [0, 2, 6, 8]
  for (const i of corners) {
    if (s.board[i] === aiPlayer) score += 1
    if (s.board[i] === humanPlayer) score -= 1
  }

  return score
}

function minimax(s, depth, alpha, beta, aiPlayer, humanPlayer, memo) {
  const key = `${depth}|${stateKey(s)}`
  if (memo.has(key)) return memo.get(key)

  if (depth === 0 || s.winner) {
    const v = evaluate(s, aiPlayer, humanPlayer, depth)
    memo.set(key, v)
    return v
  }

  const moves = availableMoves(s)
  if (moves.length === 0) {
    const v = evaluate(s, aiPlayer, humanPlayer, depth)
    memo.set(key, v)
    return v
  }

  const maximizing = s.currentPlayer === aiPlayer
  let best = maximizing ? -Infinity : Infinity

  // 简单 move ordering：先中心、再角、再边，可提升剪枝效率
  const priority = (i) => (i === 4 ? 0 : [0, 2, 6, 8].includes(i) ? 1 : 2)
  moves.sort((a, b) => priority(a) - priority(b))

  for (const m of moves) {
    const ns = applyMove(s, m, s.currentPlayer)
    const v = minimax(ns, depth - 1, alpha, beta, aiPlayer, humanPlayer, memo)
    if (maximizing) {
      best = Math.max(best, v)
      alpha = Math.max(alpha, best)
      if (alpha >= beta) break
    } else {
      best = Math.min(best, v)
      beta = Math.min(beta, best)
      if (beta <= alpha) break
    }
  }

  memo.set(key, best)
  return best
}

function chooseBestMove(s, aiPlayer, humanPlayer, cfg) {
  // 先看一步必胜/必防
  const moves = availableMoves(s)
  for (const m of moves) {
    const ns = applyMove(s, m, aiPlayer)
    if (ns.winner === aiPlayer) return m
  }
  for (const m of moves) {
    const ns = applyMove(s, m, humanPlayer)
    if (ns.winner === humanPlayer) return m
  }

  // 深度越大越强，但也更耗时；本盘面很小，适当深度即可
  const MAX_DEPTH = cfg?.maxDepth ?? 10
  const memo = new Map()

  const scored = []

  const priority = (i) => (i === 4 ? 0 : [0, 2, 6, 8].includes(i) ? 1 : 2)
  moves.sort((a, b) => priority(a) - priority(b))

  for (const m of moves) {
    const ns = applyMove(s, m, aiPlayer)
    const score = minimax(ns, MAX_DEPTH - 1, -Infinity, Infinity, aiPlayer, humanPlayer, memo)
    scored.push({ m, score })
  }

  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) return null

  // 失误机制：让简单/中等更“像小游戏”，人类更有机会赢
  const mistakeRate = cfg?.mistakeRate ?? 0
  const topK = Math.max(1, Math.min(cfg?.mistakeTopK ?? 1, scored.length))
  if (mistakeRate > 0 && Math.random() < mistakeRate && topK > 1) {
    // 在前 topK 里故意不选最优（从第2名开始选）
    const pickIndex = 1 + Math.floor(Math.random() * (topK - 1))
    return scored[pickIndex].m
  }

  return scored[0].m
}

const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $p1Count = document.getElementById("p1Count")
const $p2Count = document.getElementById("p2Count")
const $resetBtn = document.getElementById("resetBtn")
const $difficulty = document.getElementById("difficulty")
const $difficultyText = document.getElementById("difficultyText")
const $difficultyPill = document.getElementById("difficultyPill")

let state
let isAiThinking = false

const HUMAN = 1 // 你：X
const AI = 2 // AI：O
const FADE_MS = 320
let fadeTimers = Array(9).fill(null)

const DIFFICULTY = {
  easy: { label: "简单", maxDepth: 5, mistakeRate: 0.35, mistakeTopK: 5 },
  medium: { label: "中等", maxDepth: 8, mistakeRate: 0.12, mistakeTopK: 3 },
  hard: { label: "超强", maxDepth: 12, mistakeRate: 0, mistakeTopK: 1 },
}

let difficultyKey = "medium"

function setDifficulty(key, { reset = true } = {}) {
  difficultyKey = DIFFICULTY[key] ? key : "medium"
  const label = DIFFICULTY[difficultyKey].label
  if ($difficultyText) $difficultyText.textContent = label
  if ($difficultyPill) $difficultyPill.textContent = label
  if (reset) init()
}

function init() {
  // 清理仍在执行的淡出计时器
  fadeTimers.forEach((t) => t && clearTimeout(t))
  fadeTimers = Array(9).fill(null)

  state = {
    board: Array(9).fill(0), // 0空 1玩家1 2玩家2
    currentPlayer: 1,
    queues: { 1: [], 2: [] }, // 记录每个玩家的落子顺序（最早在前）
    fading: Array(9).fill(0), // 视觉淡出层：逻辑上已移除，但动画还在
    winner: 0,
    winLine: null,
  }
  isAiThinking = false
  renderBoard(true)
  renderStatus()
  renderCounts()
}

function startFade(idx, player) {
  if (idx === null || idx === undefined) return
  if (idx < 0 || idx > 8) return

  if (fadeTimers[idx]) clearTimeout(fadeTimers[idx])
  state.fading[idx] = player
  renderBoard()

  fadeTimers[idx] = window.setTimeout(() => {
    state.fading[idx] = 0
    fadeTimers[idx] = null
    renderBoard()
  }, FADE_MS)
}

function renderStatus() {
  if (state.winner) {
    $status.innerHTML =
      state.winner === HUMAN
        ? `结果：<span class="p1">你（X）获胜</span>`
        : `结果：<span class="p2">AI（O）获胜</span>`
    return
  }
  if (isAiThinking) {
    $status.innerHTML = `当前：<span class="p2">AI（O）思考中…</span>`
    return
  }
  $status.innerHTML =
    state.currentPlayer === HUMAN
      ? `当前：<span class="p1">你（X）</span>`
      : `当前：<span class="p2">AI（O）</span>`
}

function renderCounts() {
  $p1Count.textContent = `${state.queues[1].length} / 3`
  $p2Count.textContent = `${state.queues[2].length} / 3`
}

function renderBoard(rebuild = false) {
  if (rebuild) {
    $board.innerHTML = ""
    for (let i = 0; i < 9; i++) {
      const btn = document.createElement("button")
      btn.className = "cell"
      btn.type = "button"
      btn.setAttribute("aria-label", `cell-${i}`)
      btn.dataset.idx = String(i)
      btn.addEventListener("click", onCellClick)

      const mark = document.createElement("span")
      mark.className = "mark"
      btn.appendChild(mark)

      $board.appendChild(btn)
    }
  }

  // “提前一步”提示：只提示【对方】即将消失的棋子（你这边不提示）
  // 当前版本是 你(X) vs AI(O)，因此只提示 AI 最早那颗（当 AI 已有3子时）
  const aboutToVanish = new Set()
  if (state.queues[AI].length === 3) aboutToVanish.add(state.queues[AI][0])

  const cells = $board.querySelectorAll(".cell")
  cells.forEach((cell, idx) => {
    const v = state.board[idx] || state.fading[idx]
    const isFading = state.board[idx] === 0 && state.fading[idx] !== 0
    const isAbout = !isFading && state.board[idx] !== 0 && aboutToVanish.has(idx)

    const mark = cell.querySelector(".mark")
    if (mark) mark.textContent = v === 1 ? "X" : v === 2 ? "O" : ""
    cell.classList.toggle("x", v === 1)
    cell.classList.toggle("o", v === 2)
    if (mark) {
      mark.classList.toggle("fading", isFading)
      mark.classList.toggle("about", isAbout)
    }
    cell.classList.toggle("win", !!state.winLine && state.winLine.includes(idx))
    // AI 思考或游戏结束时禁用点击，避免状态不同步
    cell.disabled =
      !!state.winner || isAiThinking || state.currentPlayer !== HUMAN || state.board[idx] !== 0 || isFading
  })
}

function onCellClick(e) {
  const idx = Number(e.currentTarget.dataset.idx)
  if (state.winner || isAiThinking) return
  if (state.currentPlayer !== HUMAN) return
  if (state.board[idx] !== 0) return

  // 你落子
  const removedIdx = state.queues[HUMAN].length === 3 ? state.queues[HUMAN][0] : null
  state = applyMove(state, idx, HUMAN)
  state = recomputeWinner(state, HUMAN, AI)
  if (removedIdx !== null) startFade(removedIdx, HUMAN)
  renderBoard()
  renderStatus()
  renderCounts()

  if (state.winner) {
    window.setTimeout(() => alert("你获胜！"), 10)
    return
  }

  // AI 回合
  aiMove()
}

function aiMove() {
  if (state.winner) return
  if (state.currentPlayer !== AI) return

  isAiThinking = true
  renderBoard()
  renderStatus()

  // 让浏览器先把“思考中”渲染出来
  const delay = 520 + Math.floor(Math.random() * 380) // 520~900ms，更像“在思考”
  window.setTimeout(() => {
    const best = chooseBestMove(state, AI, HUMAN, DIFFICULTY[difficultyKey])
    if (best === null || best === undefined) {
      isAiThinking = false
      renderBoard()
      renderStatus()
      return
    }

    const removedIdx = state.queues[AI].length === 3 ? state.queues[AI][0] : null
    state = applyMove(state, best, AI)
    state = recomputeWinner(state, HUMAN, AI)
    if (removedIdx !== null) startFade(removedIdx, AI)
    isAiThinking = false
    renderBoard()
    renderStatus()
    renderCounts()

    if (state.winner) {
      window.setTimeout(() => alert("AI 获胜！"), 10)
    }
  }, delay)
}

$resetBtn.addEventListener("click", init)
if ($difficulty) {
  $difficulty.addEventListener("change", (e) => {
    const key = e.target.value
    setDifficulty(key, { reset: true })
  })
}
setDifficulty($difficulty?.value || "medium", { reset: false })
init()
