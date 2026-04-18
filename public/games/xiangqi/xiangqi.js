"use strict"

// 中国象棋（简化实现：包含基本规则 + 将军/自杀校验 + AI）
// - 红方（玩家）先手，黑方（AI）后手
// - 难度 1-10：映射搜索深度与随机率
// - 胜利：难度 +1；失败：难度 -1

const STORAGE_XQ_DIFF_KEY = "xiangqi_diff_v1"
const MIN_DIFF = 1
const MAX_DIFF = 10

// UI
const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $hintText = document.getElementById("hintText")
const $winProb = document.getElementById("winProb")
const $winProbVal = document.getElementById("winProbVal")
const $diffGrid = document.getElementById("diffGrid")
const $diffText = document.getElementById("diffText")
const $resetBtn = document.getElementById("resetBtn")
const $hintBtn = document.getElementById("hintBtn")

const $xqModal = document.getElementById("xqModal")
const $xqModalTitle = document.getElementById("xqModalTitle")
const $xqModalBody = document.getElementById("xqModalBody")
const $xqModalBtn = document.getElementById("xqModalBtn")

const $diffModal = document.getElementById("diffModal")
const $diffModalPicker = document.getElementById("diffModalPicker")
const $diffModalCurrent = document.getElementById("diffModalCurrent")
const $diffModalCloseBtn = document.getElementById("diffModalCloseBtn")

const $resetModal = document.getElementById("resetModal")
const $resetModalBody = document.getElementById("resetModalBody")
const $resetCancelBtn = document.getElementById("resetCancelBtn")
const $resetConfirmBtn = document.getElementById("resetConfirmBtn")

// pieces: red uppercase, black lowercase
// R 车, N 马, B 相/象, A 士/仕, K 将/帅, C 炮, P 兵/卒
const PIECE_NAME = {
  R: "车",
  N: "马",
  B: "相",
  A: "仕",
  K: "帅",
  C: "炮",
  P: "兵",
  r: "车",
  n: "马",
  b: "象",
  a: "士",
  k: "将",
  c: "炮",
  p: "卒",
}

const PIECE_VAL = { p: 100, n: 270, b: 250, a: 120, r: 500, c: 450, k: 20000 }

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function loadDifficulty() {
  const v = Number(localStorage.getItem(STORAGE_XQ_DIFF_KEY) || MIN_DIFF)
  return clamp(Number.isFinite(v) ? v : MIN_DIFF, MIN_DIFF, MAX_DIFF)
}
function saveDifficulty(v) {
  try {
    localStorage.setItem(STORAGE_XQ_DIFF_KEY, String(v))
  } catch {}
}

let difficulty = loadDifficulty()

// state
// board: length 90, index = r*9+c, r=0 top (black), r=9 bottom (red)
let G = null
let selected = -1
let legalForSelected = []
let thinking = false
let hintMove = null // {from,to}
let $pointsLayer = null

// 重新开始二次确认状态
let resetConfirmStage = 0

// 连续点击“轮到 您”3次打开彩蛋（用于手动调难度）
const STATUS_EASTER_NEED = 3
const STATUS_EASTER_WINDOW_MS = 1200
let statusTapCount = 0
let statusTapTimer = null

function idx(r, c) {
  return r * 9 + c
}
function rc(i) {
  return { r: Math.floor(i / 9), c: i % 9 }
}
function inBounds(r, c) {
  return r >= 0 && r < 10 && c >= 0 && c < 9
}

function isRed(p) {
  return p && p !== "." && p === p.toUpperCase()
}
function isBlack(p) {
  return p && p !== "." && p === p.toLowerCase()
}
function sideOf(p) {
  if (isRed(p)) return "r"
  if (isBlack(p)) return "b"
  return null
}
function enemy(side) {
  return side === "r" ? "b" : "r"
}
function pt(p) {
  return p.toLowerCase()
}

function startPosition() {
  // 标准开局
  const rows = [
    "rnbakabnr",
    ".........",
    ".c.....c.",
    "p.p.p.p.p",
    ".........",
    ".........",
    "P.P.P.P.P",
    ".C.....C.",
    ".........",
    "RNBAKABNR",
  ]
  return {
    board: rows.join("").split(""),
    turn: "r",
    winner: null, // 'r' | 'b'
    reason: "",
  }
}

function setStatus(text) {
  if ($status) $status.textContent = text
}
function setHint(text) {
  if ($hintText) $hintText.textContent = text
}
function setWinProbText(text) {
  if ($winProbVal) $winProbVal.textContent = text
}
function setWinProbStyle(pct) {
  if (!$winProb) return
  $winProb.classList.remove("isLow", "isMid", "isHigh")
  // <=30 红；31-60 橙（含 60）；61-99 绿（含 99）
  if (pct <= 30) $winProb.classList.add("isLow")
  else if (pct <= 60) $winProb.classList.add("isMid")
  else $winProb.classList.add("isHigh")
}

function renderDifficulty() {
  if ($diffText) $diffText.textContent = `当前难度 ${difficulty} / 10`
  if (!$diffGrid) return
  if ($diffGrid.childElementCount !== 10) {
    $diffGrid.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "xqDiffDot"
      dot.dataset.level = String(i)
      $diffGrid.appendChild(dot)
    }
  }
  const dots = $diffGrid.querySelectorAll(".xqDiffDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isDone", lv > 0 && lv < difficulty)
    el.classList.toggle("isCurrent", lv > 0 && lv === difficulty)
  })
}

function ensureBoard() {
  if (!$board) return
  const exist = $board.querySelector(".xqPoints")
  if (exist && exist.childElementCount === 90) {
    $pointsLayer = exist
    return
  }

  $board.innerHTML = ""
  const canvas = document.createElement("div")
  canvas.className = "xqCanvas"
  // 用 SVG 精确绘制象棋棋盘（含：楚河汉界 + 九宫斜线/将军府）
  canvas.innerHTML = `
    <svg class="xqSvg" viewBox="0 0 8 9" preserveAspectRatio="none" aria-hidden="true">
      <g stroke="rgba(15,23,42,0.22)" stroke-width="0.05" stroke-linecap="square">
        <!-- horizontals (0..9) -->
        ${Array.from({ length: 10 }, (_, y) => `<line x1="0" y1="${y}" x2="8" y2="${y}" />`).join("")}
        <!-- verticals (0..8), break at river between y=4 and y=5 for inner files -->
        ${Array.from({ length: 9 }, (_, x) => {
          if (x === 0 || x === 8) return `<line x1="${x}" y1="0" x2="${x}" y2="9" />`
          return `<line x1="${x}" y1="0" x2="${x}" y2="4" /><line x1="${x}" y1="5" x2="${x}" y2="9" />`
        }).join("")}
        <!-- palaces diagonals (将军府) -->
        <line x1="3" y1="0" x2="5" y2="2" />
        <line x1="5" y1="0" x2="3" y2="2" />
        <line x1="3" y1="7" x2="5" y2="9" />
        <line x1="5" y1="7" x2="3" y2="9" />
      </g>
      <g font-family="system-ui, -apple-system, Segoe UI, Roboto, Noto Sans SC, Arial"
         font-weight="1000" fill="rgba(100,116,139,0.70)" font-size="0.55">
        <text x="2" y="4.5" text-anchor="middle" dominant-baseline="middle">楚河</text>
        <text x="6" y="4.5" text-anchor="middle" dominant-baseline="middle">汉界</text>
      </g>
    </svg>
  `
  $board.appendChild(canvas)

  const points = document.createElement("div")
  points.className = "xqPoints"
  $board.appendChild(points)
  $pointsLayer = points

  for (let i = 0; i < 90; i++) {
    const { r, c } = rc(i)
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "xqPoint"
    btn.dataset.idx = String(i)
    // 关键：用“交点坐标”定位（避免不同屏幕下偏离线/格）
    btn.style.left = `calc(var(--pad) + (100% - (var(--pad) * 2)) * ${c} / 8)`
    btn.style.top = `calc(var(--pad) + (100% - (var(--pad) * 2)) * ${r} / 9)`
    btn.addEventListener("click", onCellClick)
    points.appendChild(btn)
  }
}

function renderBoard() {
  ensureBoard()
  renderDifficulty()
  if (!$board) return

  const cells = ($pointsLayer || $board).querySelectorAll(".xqPoint")
  cells.forEach((cell, i) => {
    const p = G.board[i]
    cell.innerHTML = ""
    cell.disabled = thinking || !!G.winner
    cell.classList.remove("sel", "move", "capture", "hintFrom", "hintTo")
    if (p !== ".") {
      const el = document.createElement("div")
      el.className = `xqPiece ${isRed(p) ? "red" : "black"}`
      el.textContent = PIECE_NAME[p] || ""
      cell.appendChild(el)
    }
  })

  if (selected >= 0) {
    cells[selected]?.classList.add("sel")
    legalForSelected.forEach((m) => {
      const to = m.to
      if (m.captured !== ".") cells[to]?.classList.add("capture")
      else cells[to]?.classList.add("move")
    })
  }

  if (hintMove) {
    cells[hintMove.from]?.classList.add("hintFrom")
    cells[hintMove.to]?.classList.add("hintTo")
  }

  if (G.winner) {
    setStatus(G.winner === "r" ? "结果：您获胜" : "结果：AI 获胜")
  } else {
    setStatus(G.turn === "r" ? "轮到 您（红）" : "轮到 AI（黑）")
  }

  // 本局胜率（粗略估算）：基于局面评估映射到 1-99%，结束局为 0/100
  const p = calcWinProb(G)
  setWinProbText(`${p}%`)
  setWinProbStyle(p)
}

function calcWinProb(state) {
  if (!state) return 50
  if (state.winner) return state.winner === "r" ? 100 : 0
  const out = outcome(state)
  if (out) return out.winner === "r" ? 100 : 0
  const score = evalBoard(state) // positive means red better
  const p = 1 / (1 + Math.exp(-score / 600))
  return clamp(Math.round(p * 100), 1, 99)
}

function renderDiffModalPicker() {
  if ($diffModalCurrent) $diffModalCurrent.textContent = String(difficulty)
  if (!$diffModalPicker) return
  if ($diffModalPicker.childElementCount !== 10) {
    $diffModalPicker.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "diffPickDot"
      dot.dataset.level = String(i)
      dot.title = `当前难度 ${i}`
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

function openResetModal() {
  if (!$resetModal) return
  resetConfirmStage = 0
  if ($resetModalBody) $resetModalBody.textContent = "确定要重新开始吗？"
  if ($resetConfirmBtn) $resetConfirmBtn.textContent = "继续"
  $resetModal.classList.add("isOpen")
  $resetModal.setAttribute("aria-hidden", "false")
}

function closeResetModal() {
  if (!$resetModal) return
  resetConfirmStage = 0
  $resetModal.classList.remove("isOpen")
  $resetModal.setAttribute("aria-hidden", "true")
}

function onResetClick() {
  if (!G || thinking) return
  openResetModal()
}

function onResetConfirm() {
  if (!G || thinking) return
  if (resetConfirmStage === 0) {
    resetConfirmStage = 1
    if ($resetModalBody) $resetModalBody.textContent = "再点一次确认将清空当前对局。"
    if ($resetConfirmBtn) $resetConfirmBtn.textContent = "确定重开"
    return
  }
  closeResetModal()
  resetGame()
}

function setDifficultyManual(next) {
  const lv = clamp(Number(next) || 1, MIN_DIFF, MAX_DIFF)
  difficulty = lv
  saveDifficulty(difficulty)
  renderDifficulty()
  renderDiffModalPicker()
  setHint(`已设置当前难度 ${difficulty} / 10`)
}

// ===== Core rules =====
function palaceContains(side, r, c) {
  // c 3..5
  if (c < 3 || c > 5) return false
  if (side === "r") return r >= 7 && r <= 9
  return r >= 0 && r <= 2
}

function riverCrossed(side, r) {
  // red crosses when r <= 4, black when r >= 5
  return side === "r" ? r <= 4 : r >= 5
}

function findKing(board, side) {
  const target = side === "r" ? "K" : "k"
  return board.indexOf(target)
}

function lineClear(board, from, to) {
  const a = rc(from)
  const b = rc(to)
  if (a.r !== b.r && a.c !== b.c) return false
  const dr = a.r === b.r ? 0 : a.r < b.r ? 1 : -1
  const dc = a.c === b.c ? 0 : a.c < b.c ? 1 : -1
  let rr = a.r + dr
  let cc = a.c + dc
  while (rr !== b.r || cc !== b.c) {
    if (board[idx(rr, cc)] !== ".") return false
    rr += dr
    cc += dc
  }
  return true
}

function countBetween(board, from, to) {
  const a = rc(from)
  const b = rc(to)
  if (a.r !== b.r && a.c !== b.c) return 99
  const dr = a.r === b.r ? 0 : a.r < b.r ? 1 : -1
  const dc = a.c === b.c ? 0 : a.c < b.c ? 1 : -1
  let rr = a.r + dr
  let cc = a.c + dc
  let cnt = 0
  while (rr !== b.r || cc !== b.c) {
    if (board[idx(rr, cc)] !== ".") cnt++
    rr += dr
    cc += dc
  }
  return cnt
}

function attackedBy(board, bySide, targetIdx) {
  // 简化：遍历所有 bySide 的棋子，看是否能吃到 target
  for (let i = 0; i < 90; i++) {
    const p = board[i]
    if (p === ".") continue
    if (sideOf(p) !== bySide) continue
    const moves = genPseudoMovesForPiece({ board, turn: bySide }, i, true)
    if (moves.some((m) => m.to === targetIdx)) return true
  }
  return false
}

function generalsFacing(board) {
  const rk = findKing(board, "r")
  const bk = findKing(board, "b")
  if (rk < 0 || bk < 0) return false
  const a = rc(rk)
  const b = rc(bk)
  if (a.c !== b.c) return false
  // same file, check between pieces
  const top = Math.min(a.r, b.r)
  const bot = Math.max(a.r, b.r)
  for (let r = top + 1; r < bot; r++) {
    if (board[idx(r, a.c)] !== ".") return false
  }
  return true
}

function isInCheck(state, side) {
  const k = findKing(state.board, side)
  if (k < 0) return true
  return attackedBy(state.board, enemy(side), k)
}

function makeMove(state, m) {
  const b = state.board
  const undo = { from: m.from, to: m.to, fromPiece: b[m.from], toPiece: b[m.to], turn: state.turn }
  b[m.to] = b[m.from]
  b[m.from] = "."
  state.turn = enemy(state.turn)
  return undo
}

function undoMove(state, u) {
  const b = state.board
  b[u.from] = u.fromPiece
  b[u.to] = u.toPiece
  state.turn = u.turn
}

function genPseudoMovesForPiece(state, from, forAttack = false) {
  const b = state.board
  const p = b[from]
  if (!p || p === ".") return []
  const side = sideOf(p)
  const { r, c } = rc(from)
  const res = []

  function push(to) {
    const cap = b[to]
    if (cap !== "." && sideOf(cap) === side) return
    res.push({ from, to, piece: p, captured: cap })
  }

  const t = pt(p)

  if (t === "r") {
    // rook
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]
    for (const [dr, dc] of dirs) {
      let rr = r + dr
      let cc = c + dc
      while (inBounds(rr, cc)) {
        const to = idx(rr, cc)
        if (b[to] === ".") push(to)
        else {
          push(to)
          break
        }
        rr += dr
        cc += dc
      }
    }
  } else if (t === "c") {
    // cannon
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]
    for (const [dr, dc] of dirs) {
      let rr = r + dr
      let cc = c + dc
      let screened = false
      while (inBounds(rr, cc)) {
        const to = idx(rr, cc)
        if (!screened) {
          if (b[to] === ".") {
            push(to)
          } else {
            screened = true
          }
        } else {
          if (b[to] !== ".") {
            // capture first piece after screen
            push(to)
            break
          }
        }
        rr += dr
        cc += dc
      }
    }
  } else if (t === "n") {
    // horse with leg block
    const steps = [
      { dr: -2, dc: -1, lr: -1, lc: 0 },
      { dr: -2, dc: 1, lr: -1, lc: 0 },
      { dr: 2, dc: -1, lr: 1, lc: 0 },
      { dr: 2, dc: 1, lr: 1, lc: 0 },
      { dr: -1, dc: -2, lr: 0, lc: -1 },
      { dr: 1, dc: -2, lr: 0, lc: -1 },
      { dr: -1, dc: 2, lr: 0, lc: 1 },
      { dr: 1, dc: 2, lr: 0, lc: 1 },
    ]
    for (const s of steps) {
      const legR = r + s.lr
      const legC = c + s.lc
      if (!inBounds(legR, legC)) continue
      if (b[idx(legR, legC)] !== ".") continue
      const rr = r + s.dr
      const cc = c + s.dc
      if (!inBounds(rr, cc)) continue
      push(idx(rr, cc))
    }
  } else if (t === "b") {
    // elephant (bishop) 2-diagonal, eye block, cannot cross river
    const dirs = [
      [-2, -2],
      [-2, 2],
      [2, -2],
      [2, 2],
    ]
    for (const [dr, dc] of dirs) {
      const rr = r + dr
      const cc = c + dc
      if (!inBounds(rr, cc)) continue
      // river rule
      if (side === "r" && rr < 5) continue
      if (side === "b" && rr > 4) continue
      // eye block
      const eye = idx(r + dr / 2, c + dc / 2)
      if (b[eye] !== ".") continue
      push(idx(rr, cc))
    }
  } else if (t === "a") {
    // advisor diagonal 1 within palace
    const dirs = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]
    for (const [dr, dc] of dirs) {
      const rr = r + dr
      const cc = c + dc
      if (!inBounds(rr, cc)) continue
      if (!palaceContains(side, rr, cc)) continue
      push(idx(rr, cc))
    }
  } else if (t === "k") {
    // general 1 orthogonal within palace, plus flying capture if face
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]
    for (const [dr, dc] of dirs) {
      const rr = r + dr
      const cc = c + dc
      if (!inBounds(rr, cc)) continue
      if (!palaceContains(side, rr, cc)) continue
      push(idx(rr, cc))
    }
    // flying general capture (for attack or move)
    const oppK = findKing(b, enemy(side))
    if (oppK >= 0) {
      const ok = rc(oppK)
      if (ok.c === c) {
        const between = countBetween(b, from, oppK)
        if (between === 0) {
          // can capture directly along file
          push(oppK)
        }
      }
    }
  } else if (t === "p") {
    // pawn
    const forward = side === "r" ? -1 : 1
    const rr = r + forward
    if (inBounds(rr, c)) push(idx(rr, c))
    if (riverCrossed(side, r)) {
      if (inBounds(r, c - 1)) push(idx(r, c - 1))
      if (inBounds(r, c + 1)) push(idx(r, c + 1))
    }
  }

  // forAttack: don't care self-check here
  if (forAttack) return res
  return res
}

function legalMoves(state, side) {
  const res = []
  const b = state.board
  for (let i = 0; i < 90; i++) {
    const p = b[i]
    if (p === ".") continue
    if (sideOf(p) !== side) continue
    const pseudo = genPseudoMovesForPiece(state, i, false)
    for (const m of pseudo) {
      const u = makeMove(state, m)
      // illegal if own king in check or generals facing
      const bad = isInCheck(state, side) || generalsFacing(state.board)
      undoMove(state, u)
      if (!bad) res.push(m)
    }
  }
  return res
}

function outcome(state) {
  const rk = findKing(state.board, "r")
  const bk = findKing(state.board, "b")
  if (rk < 0) return { winner: "b", reason: "帅被吃" }
  if (bk < 0) return { winner: "r", reason: "将被吃" }

  const moves = legalMoves(state, state.turn)
  if (moves.length === 0) {
    // 无合法走法：判负
    return { winner: enemy(state.turn), reason: "无子可走" }
  }
  return null
}

// ===== AI =====
function cfgByDifficulty(d) {
  const lv = clamp(d, 1, 10)
  const depth = lv <= 3 ? 1 : lv <= 7 ? 2 : 3
  const t = (MAX_DIFF - lv) / (MAX_DIFF - MIN_DIFF) // 0..1
  const randomRate = 0.02 + 0.45 * t
  return { depth, randomRate }
}

function evalBoard(state) {
  // positive means red better
  let s = 0
  for (const p of state.board) {
    if (p === ".") continue
    const v = PIECE_VAL[pt(p)] || 0
    s += isRed(p) ? v : -v
  }
  // small bonus: being in check is bad
  try {
    if (isInCheck(state, "r")) s -= 120
    if (isInCheck(state, "b")) s += 120
  } catch {}
  return s
}

function search(state, depth, alpha, beta, maximizingRed) {
  const out = outcome(state)
  if (out) {
    if (out.winner === "r") return 100000
    return -100000
  }
  if (depth <= 0) return evalBoard(state)
  const side = state.turn
  const moves = legalMoves(state, side)
  if (moves.length === 0) return evalBoard(state)

  // prefer captures
  moves.sort((a, b) => (b.captured !== ".") - (a.captured !== "."))

  if (maximizingRed) {
    let v = -Infinity
    for (const m of moves) {
      const u = makeMove(state, m)
      v = Math.max(v, search(state, depth - 1, alpha, beta, false))
      undoMove(state, u)
      alpha = Math.max(alpha, v)
      if (beta <= alpha) break
    }
    return v
  }

  let v = Infinity
  for (const m of moves) {
    const u = makeMove(state, m)
    v = Math.min(v, search(state, depth - 1, alpha, beta, true))
    undoMove(state, u)
    beta = Math.min(beta, v)
    if (beta <= alpha) break
  }
  return v
}

function pickAiMove(state) {
  const { depth, randomRate } = cfgByDifficulty(difficulty)
  const moves = legalMoves(state, "b")
  if (moves.length === 0) return null
  if (Math.random() < randomRate) return moves[Math.floor(Math.random() * moves.length)]

  let best = null
  let bestScore = Infinity
  for (const m of moves) {
    const u = makeMove(state, m)
    const sc = search(state, depth - 1, -Infinity, Infinity, true)
    undoMove(state, u)
    if (sc < bestScore) {
      bestScore = sc
      best = m
    }
  }
  return best || moves[0]
}

// ===== Gameplay =====
function openModal(title, body) {
  if (!$xqModal) return
  if ($xqModalTitle) $xqModalTitle.textContent = title
  if ($xqModalBody) $xqModalBody.textContent = body
  $xqModal.classList.add("isOpen")
  $xqModal.setAttribute("aria-hidden", "false")
}
function closeModal() {
  if (!$xqModal) return
  $xqModal.classList.remove("isOpen")
  $xqModal.setAttribute("aria-hidden", "true")
}

function resetGame() {
  closeModal()
  closeDiffModal()
  closeResetModal()
  thinking = false
  selected = -1
  legalForSelected = []
  hintMove = null
  difficulty = loadDifficulty()
  G = startPosition()
  setHint("点击红方棋子查看走法")
  renderBoard()
}

function clearSelection() {
  selected = -1
  legalForSelected = []
  renderBoard()
}

function selectSquare(i) {
  selected = i
  legalForSelected = legalMoves(G, "r").filter((m) => m.from === i)
  renderBoard()
}

function finalizeMove(m) {
  makeMove(G, m)
  selected = -1
  legalForSelected = []
  hintMove = null

  const out = outcome(G)
  if (out) {
    G.winner = out.winner
    G.reason = out.reason
    onGameOver(out)
    renderBoard()
    return
  }

  renderBoard()
  if (G.turn === "b") aiTurn()
}

function onGameOver(out) {
  if (out.winner === "r") {
    difficulty = clamp(difficulty + 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty(difficulty)
    openModal("您赢了！", `恭喜晋级，难度 +1（${out.reason}）`)
  } else {
    difficulty = clamp(difficulty - 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty(difficulty)
    openModal("AI 赢了", `再试一次，难度 -1（${out.reason}）`)
  }
}

function aiTurn() {
  if (thinking || G.winner) return
  thinking = true
  setHint("AI 思考中…")
  renderBoard()
  window.setTimeout(() => {
    const m = pickAiMove(G)
    if (!m) {
      thinking = false
      return
    }
    makeMove(G, m)
    const out = outcome(G)
    if (out) {
      G.winner = out.winner
      G.reason = out.reason
      thinking = false
      onGameOver(out)
      renderBoard()
      return
    }
    thinking = false
    setHint("轮到您：点击红方棋子查看走法")
    renderBoard()
  }, 420)
}

function pickHintMove(state) {
  const { depth } = cfgByDifficulty(difficulty)
  const moves = legalMoves(state, "r")
  if (moves.length === 0) return null
  let best = null
  let bestScore = -Infinity
  for (const m of moves) {
    const u = makeMove(state, m)
    const sc = search(state, depth - 1, -Infinity, Infinity, false)
    undoMove(state, u)
    if (sc > bestScore) {
      bestScore = sc
      best = m
    }
  }
  return best || moves[0]
}

function onHint() {
  if (!G || thinking || G.winner) return
  if (G.turn !== "r") return
  const m = pickHintMove(G)
  if (!m) return
  hintMove = { from: m.from, to: m.to }
  setHint("已高亮提示路径：点击棋子并走到高亮位置")
  renderBoard()
  window.setTimeout(() => {
    hintMove = null
    renderBoard()
  }, 1800)
}

function onCellClick(e) {
  if (!G || thinking || G.winner) return
  if (G.turn !== "r") return
  const i = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(i)) return
  const p = G.board[i]

  if (selected >= 0) {
    const move = legalForSelected.find((m) => m.to === i)
    if (move) return finalizeMove(move)
  }

  if (p !== "." && isRed(p)) {
    const name = PIECE_NAME[p] || ""
    setHint(`${name}：点击可走的位置落子（提示绿点/红点）`)
    return selectSquare(i)
  }

  clearSelection()
}

// ===== Events =====
if ($resetBtn) $resetBtn.addEventListener("click", onResetClick)
if ($hintBtn) $hintBtn.addEventListener("click", onHint)
if ($xqModal) {
  $xqModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeModal()
  })
}
if ($xqModalBtn) $xqModalBtn.addEventListener("click", () => resetGame())

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

if ($resetModal) {
  $resetModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeResetModal()
  })
}
if ($resetCancelBtn) $resetCancelBtn.addEventListener("click", closeResetModal)
if ($resetConfirmBtn) $resetConfirmBtn.addEventListener("click", onResetConfirm)

if ($status) {
  $status.addEventListener("click", () => {
    // 仅当文字包含“轮到 您”时才计数（避免结果/AI 回合误触发）
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
