"use strict"

// 围棋（9×9）人机对战：黑（玩家）先手，白（AI）后手
// - 双方连续 Pass 结束，简单“地盘+棋子数”估算胜负（无贴目）
// - 支持：提示一步、悔棋（回到玩家上一步之前）、二次确认重开、胜率估算
// - 彩蛋：连续点击“轮到 您”3次弹出难度调节

const SIZE = 9
const STORAGE_DIFF_KEY = "weiqi_diff_v1"
const MIN_DIFF = 1
const MAX_DIFF = 10

// UI
const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $hintText = document.getElementById("hintText")
const $diffGrid = document.getElementById("diffGrid")
const $diffText = document.getElementById("diffText")
const $winProb = document.getElementById("winProb")
const $winProbVal = document.getElementById("winProbVal")

const $hintBtn = document.getElementById("hintBtn")
const $undoBtn = document.getElementById("undoBtn")
const $passBtn = document.getElementById("passBtn")
const $resignBtn = document.getElementById("resignBtn")
const $resetBtn = document.getElementById("resetBtn")

const $gModal = document.getElementById("gModal")
const $gModalTitle = document.getElementById("gModalTitle")
const $gModalBody = document.getElementById("gModalBody")
const $gModalBtn = document.getElementById("gModalBtn")

const $diffModal = document.getElementById("diffModal")
const $diffModalPicker = document.getElementById("diffModalPicker")
const $diffModalCurrent = document.getElementById("diffModalCurrent")
const $diffModalCloseBtn = document.getElementById("diffModalCloseBtn")

const $resetModal = document.getElementById("resetModal")
const $resetModalBody = document.getElementById("resetModalBody")
const $resetCancelBtn = document.getElementById("resetCancelBtn")
const $resetConfirmBtn = document.getElementById("resetConfirmBtn")

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function loadDifficulty() {
  const v = Number(localStorage.getItem(STORAGE_DIFF_KEY) || MIN_DIFF)
  return clamp(Number.isFinite(v) ? v : MIN_DIFF, MIN_DIFF, MAX_DIFF)
}
function saveDifficulty(v) {
  try {
    localStorage.setItem(STORAGE_DIFF_KEY, String(v))
  } catch {}
}

let difficulty = loadDifficulty()

// state
// board: '.' empty, 'b' black, 'w' white
let G = null
let selected = -1
let hintMove = null // {from,to} with from=-1 for "place"
let lastMove = null // {to} 用于高亮 AI 最近一步
let thinking = false
let $pointsLayer = null

const history = [] // {boardStr, turn, prevHash, lastHash, passCount, captures:{b,w}, winner, reason}

// KO: simple ko by disallowing immediate repetition of previous position
// prevHash: position before last move, lastHash: current position
function hashBoard(b) {
  return b.join("")
}

function startPosition() {
  const board = Array.from({ length: SIZE * SIZE }, () => ".")
  const lastHash = hashBoard(board)
  return {
    board,
    turn: "b",
    prevHash: "",
    lastHash,
    passCount: 0,
    captures: { b: 0, w: 0 },
    winner: null, // 'b'|'w'|'draw'
    reason: "",
  }
}

function idx(r, c) {
  return r * SIZE + c
}
function rc(i) {
  return { r: Math.floor(i / SIZE), c: i % SIZE }
}
function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE
}
function neigh(i) {
  const { r, c } = rc(i)
  const res = []
  if (inBounds(r - 1, c)) res.push(idx(r - 1, c))
  if (inBounds(r + 1, c)) res.push(idx(r + 1, c))
  if (inBounds(r, c - 1)) res.push(idx(r, c - 1))
  if (inBounds(r, c + 1)) res.push(idx(r, c + 1))
  return res
}
function enemy(color) {
  return color === "b" ? "w" : "b"
}

function setStatus(t) {
  if ($status) $status.textContent = t
}
function setHint(t) {
  if ($hintText) $hintText.textContent = t
}
function setWinProbText(t) {
  if ($winProbVal) $winProbVal.textContent = t
}
function setWinProbStyle(pct) {
  if (!$winProb) return
  $winProb.classList.remove("isLow", "isMid", "isHigh")
  if (pct <= 30) $winProb.classList.add("isLow")
  else if (pct <= 60) $winProb.classList.add("isMid")
  else $winProb.classList.add("isHigh")
}

function renderDifficulty() {
  if ($diffText) $diffText.textContent = `当前等级 ${difficulty} / 10`
  if (!$diffGrid) return
  if ($diffGrid.childElementCount !== 10) {
    $diffGrid.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "gDiffDot"
      dot.dataset.level = String(i)
      $diffGrid.appendChild(dot)
    }
  }
  const dots = $diffGrid.querySelectorAll(".gDiffDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isDone", lv > 0 && lv < difficulty)
    el.classList.toggle("isCurrent", lv > 0 && lv === difficulty)
  })
}

function ensureBoard() {
  if (!$board) return
  const exist = $board.querySelector(".gPoints")
  if (exist && exist.childElementCount === SIZE * SIZE) {
    $pointsLayer = exist
    return
  }

  $board.innerHTML = ""
  const canvas = document.createElement("div")
  canvas.className = "gCanvas"
  $board.appendChild(canvas)

  const points = document.createElement("div")
  points.className = "gPoints"
  $board.appendChild(points)
  $pointsLayer = points

  for (let i = 0; i < SIZE * SIZE; i++) {
    const { r, c } = rc(i)
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "gPoint"
    btn.dataset.idx = String(i)
    // 关键：用“交叉点坐标”定位（避免不同屏幕下偏离线/点）
    btn.style.left = `calc(var(--pad) + (100% - (var(--pad) * 2)) * ${c} / 8)`
    btn.style.top = `calc(var(--pad) + (100% - (var(--pad) * 2)) * ${r} / 8)`
    btn.addEventListener("click", onPointClick)
    points.appendChild(btn)
  }
}

function renderBoard() {
  ensureBoard()
  renderDifficulty()
  if (!$board) return
  const cells = ($pointsLayer || $board).querySelectorAll(".gPoint")
  cells.forEach((cell, i) => {
    cell.classList.remove("sel", "hintFrom", "hintTo", "lastTo")
    cell.disabled = thinking || !!G.winner
    cell.innerHTML = ""
    const p = G.board[i]
    if (p !== ".") {
      const s = document.createElement("div")
      s.className = `gStone ${p === "b" ? "black" : "white"}`
      cell.appendChild(s)
    }
  })

  if (selected >= 0) cells[selected]?.classList.add("sel")
  if (hintMove) {
    if (hintMove.from >= 0) cells[hintMove.from]?.classList.add("hintFrom")
    if (hintMove.to >= 0) cells[hintMove.to]?.classList.add("hintTo")
  }
  if (lastMove && Number.isFinite(lastMove.to)) {
    cells[lastMove.to]?.classList.add("lastTo")
  }

  if (G.winner) {
    if (G.winner === "draw") setStatus("结果：平局")
    else setStatus(G.winner === "b" ? "结果：您获胜" : "结果：AI 获胜")
  } else {
    setStatus(G.turn === "b" ? "轮到 您（黑）" : "轮到 AI（白）")
  }

  const p = calcWinProb(G)
  setWinProbText(`${p}%`)
  setWinProbStyle(p)

  if ($undoBtn) {
    const need = G.turn === "b" ? 2 : 1
    $undoBtn.disabled = thinking || !!G.winner || history.length < need
  }
  if ($passBtn) $passBtn.disabled = thinking || !!G.winner
  if ($resignBtn) $resignBtn.disabled = thinking || !!G.winner
}

// ===== Go rules =====
function groupAndLiberties(board, startIdx) {
  const color = board[startIdx]
  const q = [startIdx]
  const seen = new Set([startIdx])
  const group = []
  const libs = new Set()
  while (q.length) {
    const cur = q.pop()
    group.push(cur)
    for (const nb of neigh(cur)) {
      const p = board[nb]
      if (p === ".") libs.add(nb)
      else if (p === color && !seen.has(nb)) {
        seen.add(nb)
        q.push(nb)
      }
    }
  }
  return { color, group, liberties: libs.size }
}

function removeGroup(board, group) {
  for (const i of group) board[i] = "."
}

function isLegalMove(state, color, toIdx) {
  if (toIdx < 0) return true // pass
  if (state.board[toIdx] !== ".") return false

  const b = state.board.slice()
  b[toIdx] = color

  // capture adjacent enemy groups with 0 liberties
  let captured = 0
  for (const nb of neigh(toIdx)) {
    if (b[nb] === enemy(color)) {
      const g = groupAndLiberties(b, nb)
      if (g.liberties === 0) {
        captured += g.group.length
        removeGroup(b, g.group)
      }
    }
  }

  // suicide check (allowed only if captures)
  const my = groupAndLiberties(b, toIdx)
  if (my.liberties === 0 && captured === 0) return false

  // ko check: new position cannot equal previous position
  const newHash = b.join("")
  if (state.prevHash && newHash === state.prevHash) return false

  return true
}

function applyMove(state, color, toIdx) {
  // returns nextState changes (mutates state), and capturedCount
  const b = state.board
  const beforeHash = state.lastHash
  let capturedCount = 0

  if (toIdx < 0) {
    state.passCount += 1
    state.turn = enemy(state.turn)
    state.prevHash = state.prevHash || "" // keep
    state.lastHash = beforeHash // unchanged
    return { capturedCount, beforeHash, afterHash: beforeHash, passed: true }
  }

  state.passCount = 0
  b[toIdx] = color

  for (const nb of neigh(toIdx)) {
    if (b[nb] === enemy(color)) {
      const g = groupAndLiberties(b, nb)
      if (g.liberties === 0) {
        capturedCount += g.group.length
        removeGroup(b, g.group)
      }
    }
  }

  // update captures
  state.captures[color] += capturedCount

  const afterHash = hashBoard(b)
  state.prevHash = beforeHash
  state.lastHash = afterHash
  state.turn = enemy(state.turn)
  return { capturedCount, beforeHash, afterHash, passed: false }
}

function pushHistory() {
  history.push({
    boardStr: G.board.join(""),
    turn: G.turn,
    prevHash: G.prevHash,
    lastHash: G.lastHash,
    passCount: G.passCount,
    captures: { ...G.captures },
    winner: G.winner,
    reason: G.reason,
  })
}

function popHistory(plies) {
  for (let i = 0; i < plies; i++) history.pop()
  const last = history[history.length - 1]
  if (!last) return
  G.board = last.boardStr.split("")
  G.turn = last.turn
  G.prevHash = last.prevHash
  G.lastHash = last.lastHash
  G.passCount = last.passCount
  G.captures = { ...last.captures }
  G.winner = last.winner
  G.reason = last.reason
}

function countScore(state) {
  // 简化：棋子数 + 被围空地
  const b = state.board
  let blackStones = 0
  let whiteStones = 0
  for (const p of b) {
    if (p === "b") blackStones++
    else if (p === "w") whiteStones++
  }
  let blackTerr = 0
  let whiteTerr = 0
  const seen = new Set()
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== "." || seen.has(i)) continue
    const q = [i]
    seen.add(i)
    const region = []
    const border = new Set()
    while (q.length) {
      const cur = q.pop()
      region.push(cur)
      for (const nb of neigh(cur)) {
        const p = b[nb]
        if (p === ".") {
          if (!seen.has(nb)) {
            seen.add(nb)
            q.push(nb)
          }
        } else {
          border.add(p)
        }
      }
    }
    if (border.size === 1) {
      const c = [...border][0]
      if (c === "b") blackTerr += region.length
      else if (c === "w") whiteTerr += region.length
    }
  }
  const black = blackStones + blackTerr
  const white = whiteStones + whiteTerr
  return { black, white, blackStones, whiteStones, blackTerr, whiteTerr }
}

function maybeFinishByPass() {
  if (G.passCount < 2) return null
  const sc = countScore(G)
  if (sc.black > sc.white) return { winner: "b", reason: `数目：黑 ${sc.black} / 白 ${sc.white}` }
  if (sc.white > sc.black) return { winner: "w", reason: `数目：黑 ${sc.black} / 白 ${sc.white}` }
  return { winner: "draw", reason: `数目：黑 ${sc.black} / 白 ${sc.white}` }
}

// ===== Win probability (rough) =====
function evalBoard(state) {
  // positive means black better
  const sc = countScore(state)
  const base = (sc.black - sc.white) * 120
  const cap = (state.captures.b - state.captures.w) * 60
  return base + cap
}

function calcWinProb(state) {
  if (!state) return 50
  if (state.winner) {
    if (state.winner === "draw") return 50
    return state.winner === "b" ? 100 : 0
  }
  const score = evalBoard(state)
  const p = 1 / (1 + Math.exp(-score / 800))
  return clamp(Math.round(p * 100), 1, 99)
}

// ===== AI / Hint =====
function cfgByDifficulty(d) {
  const lv = clamp(d, 1, 10)
  const depth = lv <= 3 ? 1 : lv <= 7 ? 2 : 2
  const t = (MAX_DIFF - lv) / (MAX_DIFF - MIN_DIFF) // 0..1
  const randomRate = 0.06 + 0.55 * t
  return { depth, randomRate }
}

function candidateMoves(state) {
  // 限制候选：只考虑靠近已有棋子的位置（距离1），否则开局给中心
  const b = state.board
  const hasStone = b.some((x) => x !== ".")
  if (!hasStone) return [idx(Math.floor(SIZE / 2), Math.floor(SIZE / 2))]
  const cand = new Set()
  for (let i = 0; i < b.length; i++) {
    if (b[i] === ".") continue
    for (const nb of neigh(i)) if (b[nb] === ".") cand.add(nb)
  }
  // 如果太少，扩展一圈
  if (cand.size < 10) {
    const extra = new Set()
    for (const p of cand) for (const nb of neigh(p)) if (b[nb] === ".") extra.add(nb)
    extra.forEach((x) => cand.add(x))
  }
  return [...cand]
}

function cloneState(state) {
  return {
    board: state.board.slice(),
    turn: state.turn,
    prevHash: state.prevHash,
    lastHash: state.lastHash,
    passCount: state.passCount,
    captures: { ...state.captures },
    winner: state.winner,
    reason: state.reason,
  }
}

function evaluateAfterMove(state, color, toIdx) {
  const s = cloneState(state)
  if (!isLegalMove(s, color, toIdx)) return null
  applyMove(s, color, toIdx)
  // pass结束
  const out = maybeFinishByPassFrom(s)
  if (out) {
    if (out.winner === "draw") return 0
    return out.winner === "b" ? 100000 : -100000
  }
  return evalBoard(s)
}

function maybeFinishByPassFrom(state) {
  if (state.passCount < 2) return null
  const sc = countScore(state)
  if (sc.black > sc.white) return { winner: "b", reason: `数目：黑 ${sc.black} / 白 ${sc.white}` }
  if (sc.white > sc.black) return { winner: "w", reason: `数目：黑 ${sc.black} / 白 ${sc.white}` }
  return { winner: "draw", reason: `数目：黑 ${sc.black} / 白 ${sc.white}` }
}

function pickBestMove(state, color) {
  const { depth, randomRate } = cfgByDifficulty(difficulty)
  const cand = candidateMoves(state)
  const moves = cand.filter((i) => isLegalMove(state, color, i))
  // always allow pass
  moves.push(-1)
  if (moves.length === 0) return -1
  if (Math.random() < randomRate) return moves[Math.floor(Math.random() * moves.length)]

  let best = moves[0]
  let bestScore = color === "b" ? -Infinity : Infinity

  for (const m of moves) {
    const s1 = cloneState(state)
    if (!isLegalMove(s1, color, m)) continue
    applyMove(s1, color, m)

    let score = evalBoard(s1) // black-positive
    if (depth >= 2) {
      // 对手一手响应（粗略）
      const opp = enemy(color)
      const oppCand = candidateMoves(s1).filter((i) => isLegalMove(s1, opp, i))
      oppCand.push(-1)
      let oppBest = oppCand[0]
      let oppScore = opp === "b" ? -Infinity : Infinity
      for (const om of oppCand) {
        const s2 = cloneState(s1)
        if (!isLegalMove(s2, opp, om)) continue
        applyMove(s2, opp, om)
        const v = evalBoard(s2)
        if (opp === "b") {
          if (v > oppScore) {
            oppScore = v
            oppBest = om
          }
        } else {
          if (v < oppScore) {
            oppScore = v
            oppBest = om
          }
        }
      }
      score = oppScore
      void oppBest
    }

    if (color === "b") {
      if (score > bestScore) {
        bestScore = score
        best = m
      }
    } else {
      if (score < bestScore) {
        bestScore = score
        best = m
      }
    }
  }
  return best
}

function onHint() {
  if (!G || thinking || G.winner) return
  if (G.turn !== "b") return
  const m = pickBestMove(G, "b")
  if (m < 0) {
    setHint("建议：Pass（当前局面不宜强行落子）")
    return
  }
  hintMove = { from: -1, to: m }
  setHint("已高亮提示落子点")
  renderBoard()
  window.setTimeout(() => {
    hintMove = null
    renderBoard()
  }, 1800)
}

// ===== Modals =====
function openModal(title, body) {
  if (!$gModal) return
  if ($gModalTitle) $gModalTitle.textContent = title
  if ($gModalBody) $gModalBody.textContent = body
  $gModal.classList.add("isOpen")
  $gModal.setAttribute("aria-hidden", "false")
}
function closeModal() {
  if (!$gModal) return
  $gModal.classList.remove("isOpen")
  $gModal.setAttribute("aria-hidden", "true")
}

// reset confirm（一键确认）
function openResetModal() {
  if (!$resetModal) return
  if ($resetModalBody) $resetModalBody.textContent = "确定要重新开始吗？"
  $resetModal.classList.add("isOpen")
  $resetModal.setAttribute("aria-hidden", "false")
}
function closeResetModal() {
  if (!$resetModal) return
  $resetModal.classList.remove("isOpen")
  $resetModal.setAttribute("aria-hidden", "true")
}
function onResetClick() {
  if (!G || thinking) return
  openResetModal()
}
function onResetConfirm() {
  if (!G || thinking) return
  closeResetModal()
  resetGame()
}

// diff modal
function renderDiffModalPicker() {
  if ($diffModalCurrent) $diffModalCurrent.textContent = String(difficulty)
  if (!$diffModalPicker) return
  if ($diffModalPicker.childElementCount !== 10) {
    $diffModalPicker.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "diffPickDot"
      dot.dataset.level = String(i)
      dot.title = `当前等级 ${i}`
      $diffModalPicker.appendChild(dot)
    }
  }
  const dots = $diffModalPicker.querySelectorAll(".diffPickDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isDone", lv > 0 && lv < difficulty)
    el.classList.toggle("isCurrent", lv > 0 && lv === difficulty)
  })
}
function openDiffModal() {
  if (!$diffModal) return
  renderDiffModalPicker()
  $diffModal.classList.add("isOpen")
  $diffModal.setAttribute("aria-hidden", "false")
}
function closeDiffModal() {
  if (!$diffModal) return
  $diffModal.classList.remove("isOpen")
  $diffModal.setAttribute("aria-hidden", "true")
}
function setDifficultyManual(next) {
  const lv = clamp(Number(next) || 1, MIN_DIFF, MAX_DIFF)
  difficulty = lv
  saveDifficulty(difficulty)
  renderDifficulty()
  renderDiffModalPicker()
  setHint(`已设置当前等级 ${difficulty} / 10`)
}

// status easter tap
const STATUS_EASTER_NEED = 3
const STATUS_EASTER_WINDOW_MS = 1200
let statusTapCount = 0
let statusTapTimer = null

// ===== Gameplay =====
function resetGame() {
  closeModal()
  closeDiffModal()
  closeResetModal()
  thinking = false
  selected = -1
  hintMove = null
  difficulty = loadDifficulty()
  G = startPosition()
  history.length = 0
  pushHistory()
  setHint("点击交叉点落子；可 Pass；连续 Pass 结束数目")
  renderBoard()
}

function onPointClick(e) {
  if (!G || thinking || G.winner) return
  if (G.turn !== "b") return
  const i = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(i)) return

  // place move on intersection
  if (!isLegalMove(G, "b", i)) {
    setHint("该位置不可落子（可能是自杀或打劫）")
    return
  }

  pushHistory()
  applyMove(G, "b", i)
  hintMove = null
  selected = -1

  const out = maybeFinishByPass()
  if (out) return finishGame(out)

  renderBoard()
  if (G.turn === "w") aiTurn()
}

function aiTurn() {
  if (thinking || G.winner) return
  thinking = true
  setHint("AI 思考中…")
  renderBoard()
  window.setTimeout(() => {
    const m = pickBestMove(G, "w")
    pushHistory()
    applyMove(G, "w", m)
    // 高亮 AI 最近一步（短暂）
    lastMove = { to: m }
    window.setTimeout(() => {
      lastMove = null
      renderBoard()
    }, 1200)
    const out = maybeFinishByPass()
    thinking = false
    if (out) return finishGame(out)
    setHint("轮到您：点击交叉点落子")
    renderBoard()
  }, 380)
}

function onPass() {
  if (!G || thinking || G.winner) return
  if (G.turn !== "b") return
  pushHistory()
  applyMove(G, "b", -1)
  const out = maybeFinishByPass()
  if (out) return finishGame(out)
  renderBoard()
  aiTurn()
}

function onResign() {
  if (!G || thinking || G.winner) return
  G.winner = "w"
  G.reason = "认输"
  finishGame({ winner: "w", reason: "认输" })
}

function finishGame(out) {
  G.winner = out.winner
  G.reason = out.reason || ""
  if (out.winner === "b") {
    difficulty = clamp(difficulty + 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty(difficulty)
    openModal("您赢了！", `恭喜晋级，等级 +1（${out.reason}）`)
  } else if (out.winner === "w") {
    difficulty = clamp(difficulty - 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty(difficulty)
    openModal("AI 赢了", `再试一次，等级 -1（${out.reason}）`)
  } else {
    openModal("平局", `本局平局（${out.reason}）`)
  }
  renderBoard()
}

function undoLastTurn() {
  if (!G || thinking) return
  const need = G.turn === "b" ? 2 : 1
  if (history.length < need + 1) return
  // remove current snapshot and last moves
  popHistory(history.length - 1 - need)
  setHint("已悔棋：轮到您")
  hintMove = null
  renderBoard()
}

// ===== Events =====
if ($hintBtn) $hintBtn.addEventListener("click", onHint)
if ($undoBtn) $undoBtn.addEventListener("click", undoLastTurn)
if ($passBtn) $passBtn.addEventListener("click", onPass)
if ($resignBtn) $resignBtn.addEventListener("click", onResign)
if ($resetBtn) $resetBtn.addEventListener("click", onResetClick)

if ($gModal) {
  $gModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeModal()
  })
}
if ($gModalBtn) $gModalBtn.addEventListener("click", () => resetGame())

if ($resetModal) {
  $resetModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeResetModal()
  })
}
if ($resetCancelBtn) $resetCancelBtn.addEventListener("click", closeResetModal)
if ($resetConfirmBtn) $resetConfirmBtn.addEventListener("click", onResetConfirm)

if ($diffModal) {
  $diffModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeDiffModal()
  })
}
if ($diffModalCloseBtn) $diffModalCloseBtn.addEventListener("click", closeDiffModal)
if ($diffModalPicker) {
  $diffModalPicker.addEventListener("click", (e) => {
    const t = e.target
    const lv = Number(t?.dataset?.level || 0)
    if (lv >= MIN_DIFF && lv <= MAX_DIFF) setDifficultyManual(lv)
  })
}

if ($status) {
  $status.addEventListener("click", () => {
    if (!$status.textContent || !$status.textContent.includes("轮到 您")) return
    statusTapCount += 1
    if (statusTapTimer) clearTimeout(statusTapTimer)
    statusTapTimer = window.setTimeout(() => {
      statusTapCount = 0
      statusTapTimer = null
    }, STATUS_EASTER_WINDOW_MS)
    if (statusTapCount >= STATUS_EASTER_NEED) {
      statusTapCount = 0
      if (statusTapTimer) clearTimeout(statusTapTimer)
      statusTapTimer = null
      openDiffModal()
    }
  })
}

resetGame()
