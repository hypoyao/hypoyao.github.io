"use strict"

// 标准国际象棋（简易 UI + 简易 AI）：
// - 支持：王车易位、吃过路兵、升变（弹窗选择）
// - 只允许走“合法棋”（不能让己方国王被将军）
// - AI 使用 alpha-beta 搜索（难度 1~10 映射深度与随机率）

const STORAGE_CHESS_DIFF_KEY = "chess_diff_v1"
const MIN_DIFF = 1
const MAX_DIFF = 10

// UI
const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $hintText = document.getElementById("hintText")
const $winProb = document.getElementById("winProb")
const $winProbVal = document.getElementById("winProbVal")
const $resetBtn = document.getElementById("resetBtn")
const $hintBtn = document.getElementById("hintBtn")
const $undoBtn = document.getElementById("undoBtn")
const $diffGrid = document.getElementById("diffGrid")
const $diffText = document.getElementById("diffText")
const $diffModal = document.getElementById("diffModal")
const $diffModalPicker = document.getElementById("diffModalPicker")
const $diffModalCurrent = document.getElementById("diffModalCurrent")
const $diffModalCloseBtn = document.getElementById("diffModalCloseBtn")

const $chModal = document.getElementById("chModal")
const $chModalTitle = document.getElementById("chModalTitle")
const $chModalBody = document.getElementById("chModalBody")
const $chModalBtn = document.getElementById("chModalBtn")

const $chTipModal = document.getElementById("chTipModal")
const $chTipText = document.getElementById("chTipText")

const $promoModal = document.getElementById("promoModal")
const $promoRow = document.getElementById("promoRow")

const $resetModal = document.getElementById("resetModal")
const $resetModalBody = document.getElementById("resetModalBody")
const $resetCancelBtn = document.getElementById("resetCancelBtn")
const $resetConfirmBtn = document.getElementById("resetConfirmBtn")

// piece chars: white uppercase, black lowercase
// P N B R Q K
const PIECE_UNICODE = {
  P: "♙",
  N: "♘",
  B: "♗",
  R: "♖",
  Q: "♕",
  K: "♔",
  p: "♟",
  n: "♞",
  b: "♝",
  r: "♜",
  q: "♛",
  k: "♚",
}

const PIECE_TIP = {
  P: "兵：向前走 1 格；首次可走 2 格；斜前方吃子；到达对方底线可升变。",
  N: "马：走“日”字（2+1），可以跳过其它棋子。",
  B: "象：沿对角线任意格数移动。",
  R: "车：沿横竖直线任意格数移动。",
  Q: "后：车 + 象的走法（横竖/斜线任意格）。",
  K: "王：向任意方向走 1 格；可进行王车易位（在特定条件下）。",
}

function setWinProbText(text) {
  if ($winProbVal) $winProbVal.textContent = text
  else if ($winProb) $winProb.textContent = `本局胜率：${text}`
}

function setWinProbStyle(pct) {
  if (!$winProb) return
  $winProb.classList.remove("isLow", "isMid", "isHigh")
  // <=30 红；31-60 橙（含 60）；61-99 绿（含 99）
  if (pct <= 30) $winProb.classList.add("isLow")
  else if (pct <= 60) $winProb.classList.add("isMid")
  else $winProb.classList.add("isHigh")
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function loadDifficulty() {
  const v = Number(localStorage.getItem(STORAGE_CHESS_DIFF_KEY) || MAX_DIFF)
  return clamp(Number.isFinite(v) ? v : MAX_DIFF, MIN_DIFF, MAX_DIFF)
}

function saveDifficulty(v) {
  try {
    localStorage.setItem(STORAGE_CHESS_DIFF_KEY, String(v))
  } catch {}
}

let difficulty = loadDifficulty()

// Game state
// board: 64 array, index 0 = a8, 63 = h1
// turn: 'w' | 'b'
// castling: {K,Q,k,q}
// ep: index or -1
// kingPos: {w,b} indices
let G = null

let selected = -1
let legalForSelected = []
let hintMove = null
let lastMove = null // {from,to} 用于高亮 AI 最近一步

let thinking = false
let pendingPromotion = null // {from,to,piece,captured,flags}

// 走子历史：保存 makeMove 返回的 undo 信息，用于悔棋
const undoStack = []

// 重新开始一次确认

// 连续点击“轮到 您”3次打开彩蛋（用于手动调难度）
const STATUS_EASTER_NEED = 3
const STATUS_EASTER_WINDOW_MS = 1200
let statusTapCount = 0
let statusTapTimer = null

// Flags
const FLAG_CAPTURE = 1
const FLAG_EP = 2
const FLAG_CASTLE = 4
const FLAG_PROMO = 8
const FLAG_PAWN2 = 16

function rcToIdx(r, c) {
  return r * 8 + c
}

function idxToRC(i) {
  return { r: Math.floor(i / 8), c: i % 8 }
}

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8
}

function isWhitePiece(p) {
  return p && p !== "." && p === p.toUpperCase()
}
function isBlackPiece(p) {
  return p && p !== "." && p === p.toLowerCase()
}
function colorOf(p) {
  if (isWhitePiece(p)) return "w"
  if (isBlackPiece(p)) return "b"
  return null
}

function enemy(color) {
  return color === "w" ? "b" : "w"
}

function pieceType(p) {
  return p.toLowerCase()
}

function startPosition() {
  const rows = [
    "rnbqkbnr",
    "pppppppp",
    "........",
    "........",
    "........",
    "........",
    "PPPPPPPP",
    "RNBQKBNR",
  ]
  const board = rows.join("").split("")
  const kingPos = { w: board.indexOf("K"), b: board.indexOf("k") }
  return {
    board,
    turn: "w",
    castling: { K: true, Q: true, k: true, q: true },
    ep: -1,
    kingPos,
    winner: null, // 'w'|'b'|'draw'
    reason: "",
  }
}

function setStatus(text) {
  if ($status) $status.textContent = text
}

function setHint(text) {
  if ($hintText) $hintText.textContent = text
}

function renderDifficulty() {
  if ($diffText) $diffText.textContent = `当前等级 ${difficulty} / 10`
  if (!$diffGrid) return
  if ($diffGrid.childElementCount !== 10) {
    $diffGrid.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "chDiffDot"
      dot.dataset.level = String(i)
      $diffGrid.appendChild(dot)
    }
  }
  const dots = $diffGrid.querySelectorAll(".chDiffDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isDone", lv > 0 && lv < difficulty)
    el.classList.toggle("isCurrent", lv > 0 && lv === difficulty)
  })
}

function ensureBoard() {
  if (!$board) return
  if ($board.childElementCount === 64) return
  $board.innerHTML = ""
  for (let i = 0; i < 64; i++) {
    const { r, c } = idxToRC(i)
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = `chCell ${(r + c) % 2 === 0 ? "light" : "dark"}`
    btn.dataset.idx = String(i)
    btn.setAttribute("aria-label", `cell-${i}`)
    btn.addEventListener("click", onCellClick)
    $board.appendChild(btn)
  }
}

function clearHighlights() {
  if (!$board) return
  const cells = $board.querySelectorAll(".chCell")
  cells.forEach((el) => {
    el.classList.remove("sel", "move", "capture", "hintFrom", "hintTo")
  })
}

function renderBoard() {
  ensureBoard()
  renderDifficulty()
  if (!$board) return
  const cells = $board.querySelectorAll(".chCell")
  cells.forEach((cell, i) => {
    const p = G.board[i]
    cell.textContent = p === "." ? "" : PIECE_UNICODE[p] || ""
    cell.disabled = thinking || !!G.winner
    cell.classList.remove("sel", "move", "capture", "hintFrom", "hintTo", "lastFrom", "lastTo", "pieceW", "pieceB", "inCheck")
    if (p !== ".") {
      if (isWhitePiece(p)) cell.classList.add("pieceW")
      else if (isBlackPiece(p)) cell.classList.add("pieceB")
    }
  })

  // action buttons
  if ($undoBtn) {
    const need = G?.turn === "w" ? 2 : 1
    $undoBtn.disabled = thinking || !!pendingPromotion || undoStack.length < need
  }

  if (selected >= 0) {
    cells[selected]?.classList.add("sel")
    legalForSelected.forEach((m) => {
      const to = m.to
      if (m.flags & FLAG_CAPTURE) cells[to]?.classList.add("capture")
      else cells[to]?.classList.add("move")
    })
  }
  if (hintMove) {
    cells[hintMove.from]?.classList.add("hintFrom")
    cells[hintMove.to]?.classList.add("hintTo")
  }
  if (lastMove) {
    if (Number.isFinite(lastMove.from)) cells[lastMove.from]?.classList.add("lastFrom")
    if (Number.isFinite(lastMove.to)) cells[lastMove.to]?.classList.add("lastTo")
  }

  // 王被将军时：红圈闪烁提示（提示“再不应对就会被吃/将死”）
  if (!G.winner && isInCheck(G, G.turn)) {
    const k = G.kingPos?.[G.turn] ?? findKing(G.board, G.turn)
    if (k >= 0) cells[k]?.classList.add("inCheck")
  }

  if (G.winner) {
    if (G.winner === "draw") setStatus("结果：和棋")
    else setStatus(G.winner === "w" ? "结果：您获胜" : "结果：AI 获胜")
  } else {
    setStatus(G.turn === "w" ? "轮到 您" : "轮到 AI")
  }

  // 胜率展示（粗略估算）：基于当前局面物质优势 + 是否被将军，映射为 0-100%
  const p = calcWinProb(G)
  setWinProbText(`${p}%`)
  setWinProbStyle(p)
}

function openModal(title, body) {
  if (!$chModal) return
  if ($chModalTitle) $chModalTitle.textContent = title
  if ($chModalBody) $chModalBody.textContent = body
  $chModal.classList.add("isOpen")
  $chModal.setAttribute("aria-hidden", "false")
}

function closeModal() {
  if (!$chModal) return
  $chModal.classList.remove("isOpen")
  $chModal.setAttribute("aria-hidden", "true")
}

function openTipModal() {
  if (!$chTipModal) return
    if ($chTipText) $chTipText.textContent = "当前等级 1-10，输赢后会自动升降等级"
  $chTipModal.classList.add("isOpen")
  $chTipModal.setAttribute("aria-hidden", "false")
}

function closeTipModal() {
  if (!$chTipModal) return
  $chTipModal.classList.remove("isOpen")
  $chTipModal.setAttribute("aria-hidden", "true")
}

function openPromoModal(move, color) {
  // color = 'w' only for player; AI 默认升后
  if (color === "b") {
    move.promo = "q"
    return finalizeMove(move)
  }

  pendingPromotion = move
  if (!$promoModal || !$promoRow) return

  $promoRow.innerHTML = ""
  const opts = [
    { t: "q", name: "后", p: "Q" },
    { t: "r", name: "车", p: "R" },
    { t: "b", name: "象", p: "B" },
    { t: "n", name: "马", p: "N" },
  ]
  opts.forEach((o) => {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "promoBtn"
    b.textContent = PIECE_UNICODE[o.p]
    b.title = o.name
    b.addEventListener("click", () => {
      if (!pendingPromotion) return
      pendingPromotion.promo = o.t
      const m = pendingPromotion
      pendingPromotion = null
      closePromoModal()
      finalizeMove(m)
    })
    $promoRow.appendChild(b)
  })

  $promoModal.classList.add("isOpen")
  $promoModal.setAttribute("aria-hidden", "false")
}

function closePromoModal() {
  if (!$promoModal) return
  $promoModal.classList.remove("isOpen")
  $promoModal.setAttribute("aria-hidden", "true")
}

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

function setDifficultyManual(next) {
  const lv = clamp(Number(next) || 1, MIN_DIFF, MAX_DIFF)
  difficulty = lv
  saveDifficulty(difficulty)
  renderDifficulty()
  renderDiffModalPicker()
  setHint(`已设置当前等级 ${difficulty} / 10`)
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

function onResetClick() {
  if (!G || thinking) return
  if (pendingPromotion) return
  openResetModal()
}

function onResetConfirm() {
  if (!G || thinking) return
  closeResetModal()
  resetGame()
}

function applyGameMove(m) {
  const u = makeMove(G, m)
  undoStack.push(u)
  return u
}

function undoLastTurn() {
  if (!G || thinking || pendingPromotion) return
  // 默认：悔棋回到“您走子之前”的局面（撤销 AI + 自己各一步）
  const plies = G.turn === "w" ? 2 : 1
  const n = Math.min(plies, undoStack.length)
  if (n <= 0) return

  // 如果已经结束，允许悔棋把对局拉回继续
  G.winner = null
  G.reason = ""

  selected = -1
  legalForSelected = []
  hintMove = null
  for (let i = 0; i < n; i++) {
    const u = undoStack.pop()
    if (!u) break
    undoMove(G, u)
  }
  setHint("已悔棋：轮到您")
  renderBoard()
}

// ===== Move generation =====
function findKing(board, color) {
  const target = color === "w" ? "K" : "k"
  return board.indexOf(target)
}

function attackedBy(board, color, sq, epTargetIdx = -1) {
  // 判断 sq 是否被 color 方攻击
  const isW = color === "w"
  const pawn = isW ? "P" : "p"
  const knight = isW ? "N" : "n"
  const bishop = isW ? "B" : "b"
  const rook = isW ? "R" : "r"
  const queen = isW ? "Q" : "q"
  const king = isW ? "K" : "k"

  const { r, c } = idxToRC(sq)

  // pawn attacks
  // 注意：坐标系 r=0 在最上方（8 段），白兵向“上”（r-1）攻击；黑兵向“下”（r+1）攻击
  const pr = isW ? r - 1 : r + 1
  const pawnCols = [c - 1, c + 1]
  for (const pc of pawnCols) {
    if (!inBounds(pr, pc)) continue
    const i = rcToIdx(pr, pc)
    if (board[i] === pawn) return true
    // epTargetIdx 不参与攻击判断（仅用于走子合法性）
  }

  // knights
  const kds = [
    [-2, -1],
    [-2, 1],
    [-1, -2],
    [-1, 2],
    [1, -2],
    [1, 2],
    [2, -1],
    [2, 1],
  ]
  for (const [dr, dc] of kds) {
    const rr = r + dr
    const cc = c + dc
    if (!inBounds(rr, cc)) continue
    if (board[rcToIdx(rr, cc)] === knight) return true
  }

  // sliders
  const rays = [
    { dr: -1, dc: 0, pieces: [rook, queen] },
    { dr: 1, dc: 0, pieces: [rook, queen] },
    { dr: 0, dc: -1, pieces: [rook, queen] },
    { dr: 0, dc: 1, pieces: [rook, queen] },
    { dr: -1, dc: -1, pieces: [bishop, queen] },
    { dr: -1, dc: 1, pieces: [bishop, queen] },
    { dr: 1, dc: -1, pieces: [bishop, queen] },
    { dr: 1, dc: 1, pieces: [bishop, queen] },
  ]
  for (const ray of rays) {
    let rr = r + ray.dr
    let cc = c + ray.dc
    while (inBounds(rr, cc)) {
      const i = rcToIdx(rr, cc)
      const p = board[i]
      if (p !== ".") {
        if (ray.pieces.includes(p)) return true
        break
      }
      rr += ray.dr
      cc += ray.dc
    }
  }

  // king neighbors
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue
      const rr = r + dr
      const cc = c + dc
      if (!inBounds(rr, cc)) continue
      if (board[rcToIdx(rr, cc)] === king) return true
    }
  }

  return false
}

function genPseudoMoves(state, color) {
  const moves = []
  const b = state.board
  const isW = color === "w"
  const my = (p) => (isW ? isWhitePiece(p) : isBlackPiece(p))
  const opp = (p) => (isW ? isBlackPiece(p) : isWhitePiece(p))

  for (let from = 0; from < 64; from++) {
    const p = b[from]
    if (p === "." || !my(p)) continue
    const t = pieceType(p)
    const { r, c } = idxToRC(from)

    if (t === "p") {
      const dir = isW ? -1 : 1
      const startRank = isW ? 6 : 1
      const promoRank = isW ? 0 : 7

      const oneR = r + dir
      if (inBounds(oneR, c)) {
        const one = rcToIdx(oneR, c)
        if (b[one] === ".") {
          const isPromo = oneR === promoRank
          moves.push({
            from,
            to: one,
            piece: p,
            captured: ".",
            flags: isPromo ? FLAG_PROMO : 0,
            promo: null,
          })
          // two
          if (r === startRank) {
            const twoR = r + dir * 2
            const two = rcToIdx(twoR, c)
            if (b[two] === ".") {
              moves.push({ from, to: two, piece: p, captured: ".", flags: FLAG_PAWN2, promo: null })
            }
          }
        }
      }
      // captures
      for (const dc of [-1, 1]) {
        const rr = r + dir
        const cc = c + dc
        if (!inBounds(rr, cc)) continue
        const to = rcToIdx(rr, cc)
        if (opp(b[to])) {
          const isPromo = rr === promoRank
          moves.push({
            from,
            to,
            piece: p,
            captured: b[to],
            flags: FLAG_CAPTURE | (isPromo ? FLAG_PROMO : 0),
            promo: null,
          })
        }
        // en passant
        if (state.ep === to) {
          // capture pawn behind
          moves.push({ from, to, piece: p, captured: isW ? "p" : "P", flags: FLAG_CAPTURE | FLAG_EP, promo: null })
        }
      }
      continue
    }

    if (t === "n") {
      const kds = [
        [-2, -1],
        [-2, 1],
        [-1, -2],
        [-1, 2],
        [1, -2],
        [1, 2],
        [2, -1],
        [2, 1],
      ]
      for (const [dr, dc] of kds) {
        const rr = r + dr
        const cc = c + dc
        if (!inBounds(rr, cc)) continue
        const to = rcToIdx(rr, cc)
        if (my(b[to])) continue
        moves.push({
          from,
          to,
          piece: p,
          captured: b[to],
          flags: b[to] !== "." ? FLAG_CAPTURE : 0,
          promo: null,
        })
      }
      continue
    }

    const addRay = (dr, dc) => {
      let rr = r + dr
      let cc = c + dc
      while (inBounds(rr, cc)) {
        const to = rcToIdx(rr, cc)
        if (my(b[to])) break
        moves.push({
          from,
          to,
          piece: p,
          captured: b[to],
          flags: b[to] !== "." ? FLAG_CAPTURE : 0,
          promo: null,
        })
        if (b[to] !== ".") break
        rr += dr
        cc += dc
      }
    }

    if (t === "b" || t === "q") {
      addRay(-1, -1)
      addRay(-1, 1)
      addRay(1, -1)
      addRay(1, 1)
    }
    if (t === "r" || t === "q") {
      addRay(-1, 0)
      addRay(1, 0)
      addRay(0, -1)
      addRay(0, 1)
    }

    if (t === "k") {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const rr = r + dr
          const cc = c + dc
          if (!inBounds(rr, cc)) continue
          const to = rcToIdx(rr, cc)
          if (my(b[to])) continue
          moves.push({ from, to, piece: p, captured: b[to], flags: b[to] !== "." ? FLAG_CAPTURE : 0, promo: null })
        }
      }

      // castling
      const rights = state.castling
      if (isW) {
        // King on e1 (idx 60)
        if (from === 60 && p === "K") {
          if (rights.K && b[61] === "." && b[62] === "." && b[63] === "R") {
            moves.push({ from, to: 62, piece: p, captured: ".", flags: FLAG_CASTLE, promo: null })
          }
          if (rights.Q && b[59] === "." && b[58] === "." && b[57] === "." && b[56] === "R") {
            moves.push({ from, to: 58, piece: p, captured: ".", flags: FLAG_CASTLE, promo: null })
          }
        }
      } else {
        // black king on e8 (idx 4)
        if (from === 4 && p === "k") {
          if (rights.k && b[5] === "." && b[6] === "." && b[7] === "r") {
            moves.push({ from, to: 6, piece: p, captured: ".", flags: FLAG_CASTLE, promo: null })
          }
          if (rights.q && b[3] === "." && b[2] === "." && b[1] === "." && b[0] === "r") {
            moves.push({ from, to: 2, piece: p, captured: ".", flags: FLAG_CASTLE, promo: null })
          }
        }
      }
    }
  }
  return moves
}

function makeMove(state, m) {
  // returns undo info
  const b = state.board
  const undo = {
    from: m.from,
    to: m.to,
    pieceFrom: b[m.from],
    pieceTo: b[m.to],
    castling: { ...state.castling },
    ep: state.ep,
    kingPos: { ...state.kingPos },
    turn: state.turn,
  }

  const p = b[m.from]
  const color = colorOf(p)
  const isW = color === "w"

  // clear ep by default
  state.ep = -1

  // handle special captures
  if (m.flags & FLAG_EP) {
    const { r: tr, c: tc } = idxToRC(m.to)
    const capIdx = rcToIdx(tr + (isW ? 1 : -1), tc)
    undo.epCapturedIdx = capIdx
    undo.epCapturedPiece = b[capIdx]
    b[capIdx] = "."
  }

  // move piece
  b[m.to] = p
  b[m.from] = "."

  // promotion
  if (m.flags & FLAG_PROMO) {
    const promo = (m.promo || "q").toLowerCase()
    b[m.to] = isW ? promo.toUpperCase() : promo
  }

  // castling rook move
  if (m.flags & FLAG_CASTLE) {
    if (m.to === 62) {
      // white king side
      b[61] = "R"
      b[63] = "."
    } else if (m.to === 58) {
      b[59] = "R"
      b[56] = "."
    } else if (m.to === 6) {
      b[5] = "r"
      b[7] = "."
    } else if (m.to === 2) {
      b[3] = "r"
      b[0] = "."
    }
  }

  // update king pos
  if (pieceType(p) === "k") {
    state.kingPos[color] = m.to
  }

  // set ep target after pawn double
  if (m.flags & FLAG_PAWN2) {
    const { r: fr, c: fc } = idxToRC(m.from)
    const epR = fr + (isW ? -1 : 1)
    state.ep = rcToIdx(epR, fc)
  }

  // update castling rights
  // king move loses both rights
  if (p === "K") {
    state.castling.K = false
    state.castling.Q = false
  }
  if (p === "k") {
    state.castling.k = false
    state.castling.q = false
  }
  // rook moves lose side
  if (m.from === 63 || m.to === 63) state.castling.K = false
  if (m.from === 56 || m.to === 56) state.castling.Q = false
  if (m.from === 7 || m.to === 7) state.castling.k = false
  if (m.from === 0 || m.to === 0) state.castling.q = false

  // switch turn
  state.turn = enemy(state.turn)

  return undo
}

function undoMove(state, undo) {
  const b = state.board
  b[undo.from] = undo.pieceFrom
  b[undo.to] = undo.pieceTo

  if (undo.epCapturedIdx !== undefined) {
    b[undo.epCapturedIdx] = undo.epCapturedPiece
  }

  state.castling = { ...undo.castling }
  state.ep = undo.ep
  state.kingPos = { ...undo.kingPos }
  state.turn = undo.turn
}

function isInCheck(state, color) {
  const king = state.kingPos[color] ?? findKing(state.board, color)
  return attackedBy(state.board, enemy(color), king, state.ep)
}

function legalMoves(state, color) {
  const pseudo = genPseudoMoves(state, color)
  const res = []
  for (const m of pseudo) {
    // castling legality: king not in check and passes through non-attacked squares
    if (m.flags & FLAG_CASTLE) {
      if (isInCheck(state, color)) continue
      const passSquares =
        m.to === 62 ? [61, 62] : m.to === 58 ? [59, 58] : m.to === 6 ? [5, 6] : m.to === 2 ? [3, 2] : []
      let ok = true
      for (const sq of passSquares) {
        // simulate king on sq
        const tmp = { ...m, to: sq, flags: 0 }
        const u = makeMove(state, tmp)
        const bad = isInCheck(state, color)
        undoMove(state, u)
        if (bad) {
          ok = false
          break
        }
      }
      if (!ok) continue
    }

    const u = makeMove(state, m)
    const bad = isInCheck(state, color)
    undoMove(state, u)
    if (!bad) res.push(m)
  }
  return res
}

function gameOutcome(state) {
  const color = state.turn
  const moves = legalMoves(state, color)
  if (moves.length > 0) return null
  const inCheck = isInCheck(state, color)
  if (inCheck) {
    return { winner: enemy(color), reason: "将死" }
  }
  return { winner: "draw", reason: "无子可走" }
}

function evalMaterialOnly(state) {
  // 正值代表白方（玩家）优势
  let s = 0
  for (let i = 0; i < 64; i++) {
    const p = state.board[i]
    if (!p || p === ".") continue
    const v = VAL[pieceType(p)] || 0
    s += isWhitePiece(p) ? v : -v
  }
  // 处于被将军状态会显著降低“胜率”观感
  try {
    if (isInCheck(state, "w")) s -= 180
    if (isInCheck(state, "b")) s += 180
  } catch {}
  return s
}

function calcWinProb(state) {
  if (!state) return 50
  if (state.winner) {
    if (state.winner === "w") return 100
    if (state.winner === "b") return 0
    return 50
  }
  const score = evalMaterialOnly(state) // roughly -4000..4000
  // logistic 映射，400 为“1 个小子”的大概尺度
  const p = 1 / (1 + Math.exp(-score / 400))
  const pct = Math.round(p * 100)
  return clamp(pct, 1, 99)
}

// ===== Evaluation + AI =====
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }

function evalBoard(state) {
  // positive = white better
  let s = 0
  for (let i = 0; i < 64; i++) {
    const p = state.board[i]
    if (p === ".") continue
    const v = VAL[pieceType(p)] || 0
    s += isWhitePiece(p) ? v : -v
  }
  // small bonus for mobility
  s += legalMoves(state, "w").length * 2
  s -= legalMoves(state, "b").length * 2
  return s
}

function cfgByDifficulty(d) {
  const lv = clamp(d, 1, 10)
  // 深度：1~3
  const depth = lv <= 3 ? 1 : lv <= 7 ? 2 : 3
  // 低难度更多随机/更少战术
  const t = (MAX_DIFF - lv) / (MAX_DIFF - MIN_DIFF) // 0..1
  const randomRate = 0.02 + 0.45 * t
  const skipTacticsRate = 0.02 + 0.55 * t
  return { depth, randomRate, skipTacticsRate }
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
    const sc = search(state, depth - 1, -Infinity, Infinity, true) // after black move, white to play
    undoMove(state, u)
    if (sc < bestScore) {
      bestScore = sc
      best = m
    }
  }
  return best || moves[0]
}

function pickHintMove(state) {
  const { depth } = cfgByDifficulty(difficulty)
  const moves = legalMoves(state, "w")
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

function search(state, depth, alpha, beta, maximizingWhite) {
  const out = gameOutcome(state)
  if (out) {
    if (out.winner === "draw") return 0
    // mate: large value
    return out.winner === "w" ? 100000 : -100000
  }
  if (depth <= 0) return evalBoard(state)

  const color = state.turn
  const moves = legalMoves(state, color)
  if (moves.length === 0) return evalBoard(state)

  const { skipTacticsRate } = cfgByDifficulty(difficulty)

  // 简易 move ordering：先吃子，再其它
  moves.sort((a, b) => (b.flags & FLAG_CAPTURE) - (a.flags & FLAG_CAPTURE))

  if (maximizingWhite) {
    let v = -Infinity
    for (const m of moves) {
      // 低难度：可能忽略战术（降低深度效果）
      if (Math.random() < skipTacticsRate && depth <= 2 && (m.flags & FLAG_CAPTURE)) continue
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
    if (Math.random() < skipTacticsRate && depth <= 2 && (m.flags & FLAG_CAPTURE)) continue
    const u = makeMove(state, m)
    v = Math.min(v, search(state, depth - 1, alpha, beta, true))
    undoMove(state, u)
    beta = Math.min(beta, v)
    if (beta <= alpha) break
  }
  return v
}

// ===== Gameplay =====
function resetGame() {
  // 关闭所有弹窗，避免“再来一局”看起来没反应
  closeModal()
  closeTipModal()
  closePromoModal()
  closeResetModal()
  closeDiffModal()
  thinking = false
  pendingPromotion = null
  selected = -1
  legalForSelected = []
  hintMove = null
  difficulty = loadDifficulty()
  G = startPosition()
  undoStack.length = 0
  setHint("点击您的棋子查看走法")
  renderBoard()
}

function showPieceTip(p) {
  const t = PIECE_TIP[p.toUpperCase()] || ""
  if (t) setHint(t)
}

function selectSquare(idx) {
  selected = idx
  hintMove = null
  legalForSelected = legalMoves(G, "w").filter((m) => m.from === idx)
  renderBoard()
}

function clearSelection() {
  selected = -1
  legalForSelected = []
  renderBoard()
}

function finalizeMove(m) {
  // apply with promotion if needed
  const color = G.turn
  if (m.flags & FLAG_PROMO && !m.promo) {
    return openPromoModal(m, color)
  }
  applyGameMove(m)

  // 兜底：如果发生“吃王”（实现上的允许），立刻判胜负
  // 注：标准国际象棋不会出现吃王；胜负应以将死为准。
  if (findKing(G.board, "b") < 0) {
    G.winner = "w"
    G.reason = "吃王"
    onGameOver({ winner: "w", reason: "吃王" })
    renderBoard()
    return
  }
  if (findKing(G.board, "w") < 0) {
    G.winner = "b"
    G.reason = "吃王"
    onGameOver({ winner: "b", reason: "吃王" })
    renderBoard()
    return
  }

  // clear selection
  selected = -1
  legalForSelected = []
  hintMove = null

  // check outcome
  const out = gameOutcome(G)
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
  const reason = out?.reason ? `（${out.reason}）` : ""
  if (out.winner === "w") {
    difficulty = clamp(difficulty + 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty(difficulty)
    openModal("您赢了！", `恭喜晋级，难度 +1${reason}`)
  } else if (out.winner === "b") {
    difficulty = clamp(difficulty - 1, MIN_DIFF, MAX_DIFF)
    saveDifficulty(difficulty)
    // 说明：国际象棋规则里不会“吃王”，输棋通常是被将死（王被将军且无路可走）
    const tip = out.reason === "将死" ? "将死：王被将军且无路可走（不需要吃王）。" : "再试一次。"
    openModal("AI 赢了", `${tip} 难度 -1${reason}`)
  } else {
    openModal("和棋", `平局不升不降${reason}`)
  }
}

function onCellClick(e) {
  if (!G || thinking || G.winner) return
  if (G.turn !== "w") return
  const idx = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(idx)) return

  const p = G.board[idx]

  // 如果点的是可走点：执行走子
  if (selected >= 0) {
    const move = legalForSelected.find((m) => m.to === idx)
    if (move) return finalizeMove(move)
  }

  // 点自己的棋子：选中并提示用法
  if (p !== "." && isWhitePiece(p)) {
    showPieceTip(p)
    return selectSquare(idx)
  }

  // 点空白或对方棋子：取消选中
  clearSelection()
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

    // AI 升变默认升后
    if (m.flags & FLAG_PROMO && !m.promo) m.promo = "q"
    applyGameMove(m)
    // 高亮 AI 最近一步（短暂）
    lastMove = { from: m.from, to: m.to }
    window.setTimeout(() => {
      lastMove = null
      renderBoard()
    }, 1200)

    // 兜底：吃王直接结束
    if (findKing(G.board, "b") < 0) {
      const out = { winner: "w", reason: "吃王" }
      G.winner = out.winner
      G.reason = out.reason
      thinking = false
      onGameOver(out)
      renderBoard()
      return
    }
    if (findKing(G.board, "w") < 0) {
      const out = { winner: "b", reason: "吃王" }
      G.winner = out.winner
      G.reason = out.reason
      thinking = false
      onGameOver(out)
      renderBoard()
      return
    }

    const out = gameOutcome(G)
    if (out) {
      G.winner = out.winner
      G.reason = out.reason
      thinking = false
      onGameOver(out)
      renderBoard()
      return
    }

    thinking = false
    setHint("轮到您：点击棋子查看走法")
    renderBoard()
  }, 420)
}

function onHint() {
  if (!G || thinking || G.winner) return
  if (G.turn !== "w") return
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

// ===== Events =====
if ($resetBtn) $resetBtn.addEventListener("click", onResetClick)
if ($hintBtn) $hintBtn.addEventListener("click", onHint)
if ($undoBtn) $undoBtn.addEventListener("click", undoLastTurn)
if ($diffGrid) $diffGrid.addEventListener("click", () => openTipModal())
if ($chTipModal) {
  $chTipModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeTipModal()
  })
}
if ($chModal) {
  $chModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeModal()
  })
}
if ($chModalBtn)
  $chModalBtn.addEventListener("click", () => {
    closeModal()
    resetGame()
  })
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
    // 仅当文字为“轮到 您”时才计数（避免其它状态误触发）
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
