"use strict"

// 华容道（经典 4×5 盘面）
// 玩法：拖动棋子（一次移动一格），把曹操移动到最下方出口

const COLS = 4
const ROWS = 5

const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $moves = document.getElementById("movesText")
const $time = document.getElementById("timeText")
const $hintBtn = document.getElementById("hintBtn")
const $restartBtn = document.getElementById("restartBtn")
const $startBtn = document.getElementById("startBtn")
const $winProbVal = document.getElementById("winProbVal")
const $winProb = document.getElementById("winProb")

const $modal = document.getElementById("hrdModal")
const $modalTitle = document.getElementById("hrdModalTitle")
const $modalBody = document.getElementById("hrdModalBody")
const $modalBtn = document.getElementById("hrdModalBtn")

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function setText(el, t) {
  if (el) el.textContent = t
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, "0")
  const ss = String(s % 60).padStart(2, "0")
  return `${mm}:${ss}`
}

const PIECES = [
  { id: "cao", name: "曹操", w: 2, h: 2, cls: "isCao" },
  { id: "zhang", name: "张飞", w: 1, h: 2, cls: "" },
  { id: "zhao", name: "赵云", w: 1, h: 2, cls: "" },
  { id: "ma", name: "马超", w: 1, h: 2, cls: "" },
  { id: "huang", name: "黄忠", w: 1, h: 2, cls: "" },
  { id: "guan", name: "关羽", w: 2, h: 1, cls: "isGuan" },
  { id: "s1", name: "兵", w: 1, h: 1, cls: "isSoldier" },
  { id: "s2", name: "兵", w: 1, h: 1, cls: "isSoldier" },
  { id: "s3", name: "兵", w: 1, h: 1, cls: "isSoldier" },
  { id: "s4", name: "兵", w: 1, h: 1, cls: "isSoldier" },
]

// ----------------------------
// 最高智商解法：状态去重（把“同尺寸棋子”视为不可区分）
// - 4 个 1x2 竖将（张/赵/马/黄）在解法搜索中视为同类
// - 4 个 1x1 兵在解法搜索中视为同类
// 这样状态空间会大幅缩小，浏览器里也能稳定算出完整解法
// ----------------------------
const SOLVER_PIECES = [
  { group: "cao", w: 2, h: 2 }, // 0
  { group: "guan", w: 2, h: 1 }, // 1
  { group: "v", w: 1, h: 2 }, // 2
  { group: "v", w: 1, h: 2 }, // 3
  { group: "v", w: 1, h: 2 }, // 4
  { group: "v", w: 1, h: 2 }, // 5
  { group: "s", w: 1, h: 1 }, // 6
  { group: "s", w: 1, h: 1 }, // 7
  { group: "s", w: 1, h: 1 }, // 8
  { group: "s", w: 1, h: 1 }, // 9
]
const SP_W = SOLVER_PIECES.map((p) => p.w)
const SP_H = SOLVER_PIECES.map((p) => p.h)

function startPos() {
  // 标准经典开局（底部中间两个空位）
  return {
    cao: { x: 1, y: 0 },
    zhang: { x: 0, y: 0 },
    zhao: { x: 3, y: 0 },
    ma: { x: 0, y: 2 },
    huang: { x: 3, y: 2 },
    guan: { x: 1, y: 2 },
    s1: { x: 1, y: 3 },
    s2: { x: 2, y: 3 },
    s3: { x: 0, y: 4 },
    s4: { x: 3, y: 4 },
  }
}

let state = null
let history = [] // {pos, moves, t0, elapsed}
let moves = 0
let t0 = 0
let timer = 0
let elapsed = 0
let sel = ""
let started = false
let won = false
let paused = false
let hintOverlay = null // {pid,fromX,fromY,toX,toY,dx,dy,until}
let $hintTarget = null
let $hintArrow = null
// steps: Array<{fromX,fromY,w,h,dx,dy}>
let solutionCache = null // { key: bigint, steps, idx, explored, hitLimit }

function copyPos(pos) {
  return JSON.parse(JSON.stringify(pos))
}

function pushHistory() {
  history.push({ pos: copyPos(state), moves, t0, elapsed })
  if (history.length > 60) history = history.slice(history.length - 60)
}

function popHistory() {
  if (history.length <= 1) return
  history.pop()
  const last = history[history.length - 1]
  state = copyPos(last.pos)
  moves = last.moves
  t0 = last.t0
  elapsed = last.elapsed
  sel = ""
  render()
}

function occGrid(pos) {
  const g = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => ""))
  for (const p of PIECES) {
    const o = pos[p.id]
    if (!o) continue
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        const x = o.x + dx
        const y = o.y + dy
        if (x >= 0 && x < COLS && y >= 0 && y < ROWS) g[y][x] = p.id
      }
    }
  }
  return g
}

function canMove(pid, dx, dy) {
  const p = PIECES.find((x) => x.id === pid)
  if (!p) return false
  const pos = state[pid]
  const nx = pos.x + dx
  const ny = pos.y + dy
  if (nx < 0 || ny < 0 || nx + p.w > COLS || ny + p.h > ROWS) return false

  const g = occGrid(state)
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const tx = nx + x
      const ty = ny + y
      const occ = g[ty][tx]
      if (occ && occ !== pid) return false
    }
  }
  return true
}

function doMove(pid, dx, dy) {
  if (!started || won) return false
  if (!canMove(pid, dx, dy)) return false
  hintOverlay = null
  // 如果玩家走的不是“解法下一步”，就清空缓存（避免继续误导）
  try {
    if (solutionCache && solutionCache.steps && solutionCache.idx < solutionCache.steps.length) {
      const s = solutionCache.steps[solutionCache.idx]
      const cur = state[pid]
      if (!s || !cur || cur.x !== s.fromX || cur.y !== s.fromY || s.dx !== dx || s.dy !== dy) {
        solutionCache = null
      } else {
        solutionCache.idx += 1
      }
    }
  } catch {
    solutionCache = null
  }
  pushHistory()
  state[pid].x += dx
  state[pid].y += dy
  moves += 1
  if (!t0) t0 = Date.now()
  render()
  checkWin()
  return true
}

function checkWin() {
  // 目标：曹操到达底部出口（x=1,y=3）
  const c = state.cao
  if (c.x === 1 && c.y === 3) {
    won = true
    started = false
    openModal("通关啦！", `用时 ${fmtTime(elapsed)} · 步数 ${moves}`)
  }
}

function isWinPos(pos) {
  const c = pos.cao
  return !!c && c.x === 1 && c.y === 3
}

function openModal(title, body) {
  if (!$modal) return
  if ($modalTitle) $modalTitle.textContent = title
  if ($modalBody) $modalBody.textContent = body
  $modal.classList.add("isOpen")
  $modal.setAttribute("aria-hidden", "false")
}

function closeModal() {
  if (!$modal) return
  $modal.classList.remove("isOpen")
  $modal.setAttribute("aria-hidden", "true")
}

function restart() {
  closeModal()
  sel = ""
  state = startPos()
  history = []
  moves = 0
  t0 = 0
  elapsed = 0
  started = false
  won = false
  paused = false
  solutionCache = null
  pushHistory()
  render()
}

function startOrPause() {
  if (won) return
  if (started) {
    // pause
    paused = true
    started = false
    render()
    return
  }
  // start / resume
  paused = false
  started = true
  t0 = Date.now() - elapsed
  render()
}

function keyOf(pos) {
  // 兼容旧版本：仍保留（但提示求解已改为更快的 A* 实现）
  return PIECES.map((p) => {
    const o = pos[p.id]
    return `${p.id}:${o.x},${o.y}`
  }).join("|")
}

function applyMoveTo(pos, pid, dx, dy) {
  const np = copyPos(pos)
  np[pid].x += dx
  np[pid].y += dy
  return np
}

function canMoveOn(pos, pid, dx, dy) {
  const p = PIECES.find((x) => x.id === pid)
  if (!p) return false
  const cur = pos[pid]
  const nx = cur.x + dx
  const ny = cur.y + dy
  if (nx < 0 || ny < 0 || nx + p.w > COLS || ny + p.h > ROWS) return false

  const g = occGrid(pos)
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const tx = nx + x
      const ty = ny + y
      const occ = g[ty][tx]
      if (occ && occ !== pid) return false
    }
  }
  return true
}

// ----------------------------
// 提示求解：用 A*（更快、更不容易“算不出”）
// ----------------------------

const pieceIndexById = Object.fromEntries(PIECES.map((p, i) => [p.id, i]))
const pieceIdByIndex = PIECES.map((p) => p.id)
const pieceNameByIndex = PIECES.map((p) => p.name)
const pieceW = PIECES.map((p) => p.w)
const pieceH = PIECES.map((p) => p.h)

function packKeyXY(xs, ys) {
  // 10 个棋子，每个棋子用 5bit（y 3bit + x 2bit） => 50bit，用 BigInt 存
  let k = 0n
  for (let i = 0; i < SOLVER_PIECES.length; i++) {
    const v = (ys[i] << 2) | xs[i] // 0..(4*4+3)=19
    k = (k << 5n) | BigInt(v)
  }
  return k
}

function canonicalizeXY(xs, ys) {
  // 0:曹操 1:关羽 固定
  // 2..5 竖将按 (y,x) 排序
  // 6..9 兵按 (y,x) 排序
  const sortRange = (a, b) => {
    for (let i = a; i <= b; i++) {
      let best = i
      for (let j = i + 1; j <= b; j++) {
        const dy = ys[j] - ys[best]
        const dx = xs[j] - xs[best]
        if (dy < 0 || (dy === 0 && dx < 0)) best = j
      }
      if (best !== i) {
        const tx = xs[i]
        const ty = ys[i]
        xs[i] = xs[best]
        ys[i] = ys[best]
        xs[best] = tx
        ys[best] = ty
      }
    }
  }
  sortRange(2, 5)
  sortRange(6, 9)
}

function posToXY(pos) {
  // solver canonical order:
  // 0:曹操 1:关羽 2-5:四个 1x2 竖将(按坐标排序) 6-9:四个兵(按坐标排序)
  const xs = new Uint8Array(SOLVER_PIECES.length)
  const ys = new Uint8Array(SOLVER_PIECES.length)

  const cao = pos.cao
  const guan = pos.guan
  xs[0] = cao.x
  ys[0] = cao.y
  xs[1] = guan.x
  ys[1] = guan.y

  const verts = [
    pos.zhang,
    pos.zhao,
    pos.ma,
    pos.huang,
  ].map((o) => ({ x: o.x, y: o.y }))
  verts.sort((a, b) => (a.y - b.y) || (a.x - b.x))
  for (let i = 0; i < 4; i++) {
    xs[2 + i] = verts[i].x
    ys[2 + i] = verts[i].y
  }

  const ss = [pos.s1, pos.s2, pos.s3, pos.s4].map((o) => ({ x: o.x, y: o.y }))
  ss.sort((a, b) => (a.y - b.y) || (a.x - b.x))
  for (let i = 0; i < 4; i++) {
    xs[6 + i] = ss[i].x
    ys[6 + i] = ss[i].y
  }

  return { xs, ys }
}

function posToKey(pos) {
  const { xs, ys } = posToXY(pos)
  return packKeyXY(xs, ys)
}

function cellBit(x, y) {
  return 1 << (y * COLS + x)
}

function maskForPiece(i, x, y) {
  let m = 0
  for (let dy = 0; dy < SP_H[i]; dy++) {
    for (let dx = 0; dx < SP_W[i]; dx++) {
      m |= cellBit(x + dx, y + dy)
    }
  }
  return m
}

function occMask(xs, ys) {
  let m = 0
  for (let i = 0; i < SOLVER_PIECES.length; i++) {
    m |= maskForPiece(i, xs[i], ys[i])
  }
  return m
}

function canMoveFast(xs, ys, occ, i, dx, dy) {
  const x = xs[i]
  const y = ys[i]
  const nx = x + dx
  const ny = y + dy
  if (nx < 0 || ny < 0 || nx + SP_W[i] > COLS || ny + SP_H[i] > ROWS) return false
  const self = maskForPiece(i, x, y)
  const others = occ & ~self
  const target = maskForPiece(i, nx, ny)
  return (target & others) === 0
}

function isWinXY(xs, ys) {
  // 曹操是 index 0（PIECES 第一项）
  return xs[0] === 1 && ys[0] === 3
}

function heuristic(xs, ys) {
  // 粗略估价：曹操到出口的曼哈顿距离 + 出口是否被堵
  const cx = xs[0]
  const cy = ys[0]
  let h = Math.abs(cx - 1) + Math.abs(cy - 3)
  const occ = occMask(xs, ys)
  // 出口两格（底行中间两格）
  const exitMask = cellBit(1, 4) | cellBit(2, 4)
  const self = maskForPiece(0, cx, cy)
  const blocked = (exitMask & (occ & ~self)) !== 0
  if (blocked) h += 2
  return h
}

function heuristicStrong(xs, ys) {
  // 更“聪明”的启发式（不保证最短，但更容易快速找到一条真正可通关的解）
  const cx = xs[0]
  const cy = ys[0]
  const dist = Math.abs(cx - 1) + Math.abs(cy - 3)
  const occ = occMask(xs, ys)
  const self = maskForPiece(0, cx, cy)
  const others = occ & ~self

  // 出口两格（底行中间两格）是否被占
  const exitMask = cellBit(1, 4) | cellBit(2, 4)
  const exitBlocked = (exitMask & others) !== 0 ? 1 : 0

  // 曹操正下方是否被挡（曹操 2x2，下方两格）
  let downBlocked = 0
  const by = cy + 2
  if (by >= 0 && by < ROWS) {
    const maskDown = cellBit(cx, by) | cellBit(cx + 1, by)
    downBlocked = (maskDown & others) !== 0 ? 1 : 0
  }

  // 权重：距离最重要，其次清路
  return dist * 6 + exitBlocked * 6 + downBlocked * 4
}
class MinHeap {
  constructor() {
    this.a = []
  }
  push(n) {
    const a = this.a
    a.push(n)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= a[i].f) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop() {
    const a = this.a
    if (!a.length) return null
    const top = a[0]
    const last = a.pop()
    if (a.length && last) {
      a[0] = last
      let i = 0
      while (true) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].f < a[m].f) m = l
        if (r < a.length && a[r].f < a[m].f) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
  get size() {
    return this.a.length
  }
}

function solveOneStepAStar(fromPos, bannedNextKeys) {
  // A* 找最短路径，并返回第一步
  const { xs: sxs, ys: sys } = posToXY(fromPos)
  canonicalizeXY(sxs, sys)
  const startKey = packKeyXY(sxs, sys)
  if (isWinXY(sxs, sys)) return null

  const heap = new MinHeap()
  const bestG = new Map() // key(BigInt) -> g
  const prev = new Map() // key -> {pkey, i, dx, dy}

  const h0 = heuristic(sxs, sys)
  heap.push({ key: startKey, xs: sxs, ys: sys, g: 0, f: h0 })
  bestG.set(startKey, 0)
  prev.set(startKey, null)

  // 提示要稳定：多扩展一些，减少落到“兜底策略”的概率
  const MAX_EXPAND = 600000
  let expanded = 0

  while (heap.size && expanded < MAX_EXPAND) {
    const cur = heap.pop()
    if (!cur) break
    expanded += 1

    const { xs, ys, g, key } = cur
    if (isWinXY(xs, ys)) {
      // 回溯到第一步
      let k = key
      let step = null // {i,dx,dy,pkey}
      while (k !== startKey) {
        const info = prev.get(k)
        if (!info) break
        step = { i: info.i, dx: info.dx, dy: info.dy, pkey: info.pkey }
        k = info.pkey
      }
      if (!step) return null
      const tx = new Uint8Array(SOLVER_PIECES.length)
      const ty = new Uint8Array(SOLVER_PIECES.length)
      unpackKeyXY(step.pkey, tx, ty)
      return { fromX: tx[step.i], fromY: ty[step.i], w: SP_W[step.i], h: SP_H[step.i], dx: step.dx, dy: step.dy }
    }

    const occ = occMask(xs, ys)
    for (let i = 0; i < SOLVER_PIECES.length; i++) {
      // 4 个方向
      // eslint-disable-next-line no-unused-vars
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
      for (const [dx, dy] of dirs) {
        if (!canMoveFast(xs, ys, occ, i, dx, dy)) continue
        const nxs = xs.slice()
        const nys = ys.slice()
        nxs[i] = nxs[i] + dx
        nys[i] = nys[i] + dy
        const nk = packKeyXY(nxs, nys)
        // 避免“提示来回走/无意义循环”：第一步不走回最近几步的状态
        if (g === 0 && bannedNextKeys && bannedNextKeys.has(nk)) continue
        const ng = g + 1
        const bg = bestG.get(nk)
        if (bg != null && bg <= ng) continue
        bestG.set(nk, ng)
        prev.set(nk, { pkey: key, i, dx, dy })
        const nf = ng + heuristic(nxs, nys)
        heap.push({ key: nk, xs: nxs, ys: nys, g: ng, f: nf })
      }
    }
  }

  // 兜底：给一个“看起来更有用”的可行移动（不至于无提示）
  const occ0 = occMask(sxs, sys)
  const cx = sxs[0],
    cy = sys[0]
  const dist0 = Math.abs(cx - 1) + Math.abs(cy - 3)
  let best = null
  let bestScore = -1e9
  for (let i = 0; i < SOLVER_PIECES.length; i++) {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]
    for (const [dx, dy] of dirs) {
      if (!canMoveFast(sxs, sys, occ0, i, dx, dy)) continue
      const nxs = sxs.slice()
      const nys = sys.slice()
      nxs[i] = nxs[i] + dx
      nys[i] = nys[i] + dy
      canonicalizeXY(nxs, nys)
      const nk = packKeyXY(nxs, nys)
      if (bannedNextKeys && bannedNextKeys.has(nk)) continue
      const dist = Math.abs(nxs[0] - 1) + Math.abs(nys[0] - 3)
      const score = (dist0 - dist) * 10 - (i === 0 ? 0 : 1) // 优先让曹操更接近出口
      if (score > bestScore) {
        bestScore = score
        best = { fromX: sxs[i], fromY: sys[i], w: SP_W[i], h: SP_H[i], dx, dy }
      }
    }
  }
  return best
}

function unpackKeyXY(key, xs, ys) {
  // key 为 packKeyXY 的 BigInt；这里解包到 xs/ys（长度 = PIECES.length）
  let k = key
  for (let i = SOLVER_PIECES.length - 1; i >= 0; i--) {
    const v = Number(k & 31n)
    k >>= 5n
    xs[i] = v & 3
    ys[i] = v >> 2
  }
}

function solvePathBFSCannon(fromPos) {
  // 最高可靠：在“同类棋子不可区分”的状态空间里做 BFS，得到最短解法路径
  const { xs: sxs0, ys: sys0 } = posToXY(fromPos)
  canonicalizeXY(sxs0, sys0)
  const startKey = packKeyXY(sxs0, sys0)
  if (isWinXY(sxs0, sys0)) return { steps: [], explored: 0, hitLimit: false }

  const maxNodes = 1500000
  const keys = []
  const parent = []
  // move record for reaching node: fromX/fromY/w/h/dx/dy
  const mFromX = []
  const mFromY = []
  const mW = []
  const mH = []
  const mDx = []
  const mDy = []

  const idxMap = new Map()
  const q = []
  let qi = 0

  keys.push(startKey)
  parent.push(-1)
  mFromX.push(0)
  mFromY.push(0)
  mW.push(0)
  mH.push(0)
  mDx.push(0)
  mDy.push(0)
  idxMap.set(startKey, 0)
  q.push(0)

  const xs = new Uint8Array(SOLVER_PIECES.length)
  const ys = new Uint8Array(SOLVER_PIECES.length)

  let explored = 0
  while (qi < q.length) {
    const curIdx = q[qi++]
    explored += 1
    unpackKeyXY(keys[curIdx], xs, ys)
    if (isWinXY(xs, ys)) {
      const steps = []
      let t = curIdx
      while (parent[t] !== -1) {
        steps.push({
          fromX: mFromX[t],
          fromY: mFromY[t],
          w: mW[t],
          h: mH[t],
          dx: mDx[t],
          dy: mDy[t],
        })
        t = parent[t]
      }
      steps.reverse()
      return { steps, explored, hitLimit: false }
    }

    const occ = occMask(xs, ys)
    for (let i = 0; i < SOLVER_PIECES.length; i++) {
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
      for (const [dx, dy] of dirs) {
        if (!canMoveFast(xs, ys, occ, i, dx, dy)) continue
        const fromX = xs[i]
        const fromY = ys[i]
        const nxs = xs.slice()
        const nys = ys.slice()
        nxs[i] = nxs[i] + dx
        nys[i] = nys[i] + dy
        canonicalizeXY(nxs, nys)
        const nk = packKeyXY(nxs, nys)
        if (idxMap.has(nk)) continue
        const ni = keys.length
        if (ni >= maxNodes) return { steps: null, explored, hitLimit: true }
        idxMap.set(nk, ni)
        keys.push(nk)
        parent.push(curIdx)
        mFromX.push(fromX)
        mFromY.push(fromY)
        mW.push(SP_W[i])
        mH.push(SP_H[i])
        mDx.push(dx)
        mDy.push(dy)
        q.push(ni)
      }
    }
  }
  return { steps: null, explored, hitLimit: false }
}

function solvePathAStar(fromPos) {
  // 用 A* 直接求一条可通关的完整路径（更省状态数，比 BFS 更适合浏览器/模拟器）
  const { xs: sxs, ys: sys } = posToXY(fromPos)
  canonicalizeXY(sxs, sys)
  const startKey = packKeyXY(sxs, sys)
  if (isWinXY(sxs, sys)) return { steps: [], explored: 0, hitLimit: false }

  const heap = new MinHeap()
  const bestG = new Map()
  const prev = new Map() // key -> {pkey, i, dx, dy}

  heap.push({ key: startKey, xs: sxs, ys: sys, g: 0, f: heuristicStrong(sxs, sys) })
  bestG.set(startKey, 0)
  prev.set(startKey, null)

  const MAX_EXPAND = 1200000
  let explored = 0

  while (heap.size && explored < MAX_EXPAND) {
    const cur = heap.pop()
    if (!cur) break
    explored += 1
    const { xs, ys, g, key } = cur

    if (isWinXY(xs, ys)) {
      const steps = []
      let k = key
      while (k !== startKey) {
        const info = prev.get(k)
        if (!info) break
        // 注意：这里先只记录“哪个索引的棋子移动 + 方向”，后面会补 fromX/fromY（解包 prev key）
        steps.push({ i: info.i, dx: info.dx, dy: info.dy, pkey: info.pkey })
        k = info.pkey
      }
      steps.reverse()

      // 补齐 fromX/fromY，并把索引动作转换成“从哪个格移动到哪里”
      const xs2 = new Uint8Array(SOLVER_PIECES.length)
      const ys2 = new Uint8Array(SOLVER_PIECES.length)
      const out = []
      for (const st of steps) {
        unpackKeyXY(st.pkey, xs2, ys2)
        const fromX = xs2[st.i]
        const fromY = ys2[st.i]
        out.push({ fromX, fromY, w: SP_W[st.i], h: SP_H[st.i], dx: st.dx, dy: st.dy })
      }
      return { steps: out, explored, hitLimit: false }
    }

    const occ = occMask(xs, ys)
    for (let i = 0; i < SOLVER_PIECES.length; i++) {
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]
      for (const [dx, dy] of dirs) {
        if (!canMoveFast(xs, ys, occ, i, dx, dy)) continue
        const nxs = xs.slice()
        const nys = ys.slice()
        nxs[i] = nxs[i] + dx
        nys[i] = nys[i] + dy
        canonicalizeXY(nxs, nys)
        const nk = packKeyXY(nxs, nys)
        const ng = g + 1
        const bg = bestG.get(nk)
        if (bg != null && bg <= ng) continue
        bestG.set(nk, ng)
        prev.set(nk, { pkey: key, i, dx, dy })
        const nf = ng + heuristicStrong(nxs, nys)
        heap.push({ key: nk, xs: nxs, ys: nys, g: ng, f: nf })
      }
    }
  }

  return { steps: null, explored, hitLimit: true }
}

function getSolutionFromCacheOrSolve() {
  // 只要棋盘状态变化，就重新求解并缓存（保证“先思考好再提示”）
  const key = posToKey(state)
  if (solutionCache && solutionCache.key === key && solutionCache.steps && solutionCache.idx < solutionCache.steps.length) {
    return solutionCache
  }
  // 优先 BFS（保证最短“真正解法”），失败再 A* 兜底
  let res = solvePathBFSCannon(state)
  if (!res || !res.steps || !res.steps.length) {
    res = solvePathAStar(state)
  }
  if (!res || !res.steps) {
    return { key, steps: null, idx: 0, explored: res?.explored || 0, hitLimit: !!res?.hitLimit }
  }
  if (!res.steps.length) {
    solutionCache = { key, steps: [], idx: 0, explored: res.explored || 0, hitLimit: false }
    return solutionCache
  }
  solutionCache = { key, steps: res.steps, idx: 0, explored: res.explored || 0, hitLimit: false }
  return solutionCache
}

function findActualPidByRect(fromX, fromY, w, h) {
  // 从当前 state 找到“占据 fromX/fromY 且尺寸匹配”的那枚棋子
  for (const p of PIECES) {
    if (p.w !== w || p.h !== h) continue
    const o = state[p.id]
    if (o && o.x === fromX && o.y === fromY) return p.id
  }
  return ""
}

function dirText(dx, dy) {
  if (dx === 1) return "向右"
  if (dx === -1) return "向左"
  if (dy === 1) return "向下"
  return "向上"
}

function hintOneStep() {
  if (won) return
  if (!started || paused) {
    setText($status, "请先点击「开始」并保持未暂停")
    return
  }
  if ($hintBtn) $hintBtn.disabled = true
  setText($status, "AI 思考中…")
  // 让 UI 先渲染出“AI 思考中…”，再开始重计算（避免看起来没响应）
  window.setTimeout(() => {
    let sol = null
    try {
      sol = getSolutionFromCacheOrSolve()
    } catch {
      sol = null
    }
    if ($hintBtn) $hintBtn.disabled = false
    if (!sol || !sol.steps) {
      const reason = sol?.hitLimit ? `（已搜索 ${sol.explored || 0} 个状态仍未找到）` : sol?.explored ? `（已搜索 ${sol.explored} 个状态仍未找到）` : ""
      setText($status, `AI 暂时算不出解法${reason}，你可以先随便走一步再点提示`)
      return
    }
    const step = sol.steps[sol.idx]
    const total = sol.steps.length
    if (!step) {
      setText($status, "已无可提示步骤（可能已接近通关）")
      return
    }
    const pid = findActualPidByRect(step.fromX, step.fromY, step.w, step.h)
    if (!pid) {
      setText($status, "AI 解法与当前棋子标识不匹配（请重新开始再试）")
      solutionCache = null
      return
    }
    const piece = PIECES.find((p) => p.id === pid)
    const name = piece?.name || pid
    const cur = state[pid]
    hintOverlay = {
      pid,
      fromX: cur.x,
      fromY: cur.y,
      toX: cur.x + step.dx,
      toY: cur.y + step.dy,
      dx: step.dx,
      dy: step.dy,
      until: Date.now() + 3500,
    }
    sel = pid


    // 闪烁高亮一下
    try {
      const el = $board && $board.querySelector(`.hrdPiece[data-pid="${pid}"]`)
      if (el) {
        el.classList.add("isHint")
        window.setTimeout(() => el.classList.remove("isHint"), 1600)
      }
    } catch {}

    setText($status, `解法共 ${total} 步（已完成 ${sol.idx} 步），下一步：把「${name}」${dirText(step.dx, step.dy)}移动一格`)
  }, 30)
}

function calcWinProb() {
  if (won) return 100
  const c = state.cao
  const dist = Math.abs(c.x - 1) + Math.abs(c.y - 3)
  let p = 95 - dist * 18
  const g = occGrid(state)

  // 出口两格是否被占（底行中间两格）
  const exitOcc1 = g[4][1] && g[4][1] !== "cao"
  const exitOcc2 = g[4][2] && g[4][2] !== "cao"
  if (exitOcc1 || exitOcc2) p -= 20

  // 曹操下面一行是否堵住（需要向下时）
  if (c.y < 3) {
    const by = c.y + 2
    if (by >= 0 && by < ROWS) {
      const occA = g[by][c.x] && g[by][c.x] !== "cao"
      const occB = g[by][c.x + 1] && g[by][c.x + 1] !== "cao"
      if (occA || occB) p -= 12
    }
  }

  // 走得越久越容易出错（轻微惩罚）
  p -= moves * 0.6
  p -= (elapsed / 1000) * 0.04

  p = clamp(Math.round(p), 1, 99)
  return p
}

function boardMetrics() {
  if (!$board) return null
  const rect = $board.getBoundingClientRect()
  const cs = window.getComputedStyle($board)
  const pad = parseFloat(cs.getPropertyValue("--pad")) || 12
  const gap = parseFloat(cs.getPropertyValue("--gap")) || 10
  const innerW = rect.width - pad * 2
  const innerH = rect.height - pad * 2
  const cellW = (innerW - gap * (COLS - 1)) / COLS
  const cellH = (innerH - gap * (ROWS - 1)) / ROWS
  return { rect, pad, gap, cellW, cellH }
}

function placeEl(el, pid) {
  const p = PIECES.find((x) => x.id === pid)
  if (!p) return
  const m = boardMetrics()
  if (!m) return
  const o = state[pid]
  const left = m.pad + o.x * (m.cellW + m.gap)
  const top = m.pad + o.y * (m.cellH + m.gap)
  const w = p.w * m.cellW + (p.w - 1) * m.gap
  const h = p.h * m.cellH + (p.h - 1) * m.gap
  el.style.left = `${left}px`
  el.style.top = `${top}px`
  el.style.width = `${w}px`
  el.style.height = `${h}px`
}

function ensurePieces() {
  if (!$board) return
  if ($board.querySelectorAll(".hrdPiece").length === PIECES.length) return
  $board.innerHTML = ""

  // 提示：目标框 + 箭头（在棋子下面）
  $hintTarget = document.createElement("div")
  $hintTarget.className = "hrdHintTarget"
  $hintTarget.id = "hrdHintTarget"
  $board.appendChild($hintTarget)

  $hintArrow = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  $hintArrow.setAttribute("class", "hrdHintArrow")
  $hintArrow.setAttribute("id", "hrdHintArrow")
  $hintArrow.setAttribute("width", "100%")
  $hintArrow.setAttribute("height", "100%")
  $hintArrow.setAttribute("preserveAspectRatio", "none")
  $hintArrow.setAttribute("viewBox", "0 0 100 100")
  $hintArrow.innerHTML = `
    <defs>
      <marker id="hrdArrowHead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(245,158,11,0.95)"></path>
      </marker>
    </defs>
    <line id="hrdArrowLine" x1="50" y1="50" x2="50" y2="50" stroke="rgba(245,158,11,0.92)" stroke-width="4" stroke-linecap="round" marker-end="url(#hrdArrowHead)"></line>
  `
  $board.appendChild($hintArrow)

  for (const p of PIECES) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = `hrdPiece ${p.cls || ""}`.trim()
    btn.dataset.pid = p.id
    btn.textContent = p.name
    btn.addEventListener("pointerdown", onPieceDown, { passive: false })
    btn.addEventListener("pointermove", onPieceMove, { passive: false })
    btn.addEventListener("pointerup", onPieceUp, { passive: false })
    btn.addEventListener("pointercancel", onPieceUp, { passive: false })
    $board.appendChild(btn)
  }
}

let drag = null // {pid,x0,y0,x1,y1,pointerId}
function onPieceDown(e) {
  const pid = e.currentTarget?.dataset?.pid
  if (!pid) return
  if (!started || won) {
    setText($status, "请先点击「开始」")
    return
  }
  sel = pid
  drag = { pid, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, pointerId: e.pointerId }
  // 确保松手时还能收到 pointerup（即使手指移出棋子）
  try {
    e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId)
  } catch {}
  try {
    e.preventDefault()
  } catch {}
  render()
}

function finishDrag(pid, x1, y1) {
  if (!pid || !drag || drag.pid !== pid) return
  const dxp = x1 - drag.x0
  const dyp = y1 - drag.y0
  drag = null

  // 点击不动：只选中，不移动
  if (Math.hypot(dxp, dyp) < 8) return

  // 拖动方向：一次移动一格
  if (Math.abs(dxp) > Math.abs(dyp)) {
    doMove(pid, dxp > 0 ? 1 : -1, 0)
  } else {
    doMove(pid, 0, dyp > 0 ? 1 : -1)
  }
}

function onPieceMove(e) {
  const pid = e.currentTarget?.dataset?.pid
  if (!pid || !drag || drag.pid !== pid) return
  drag.x1 = e.clientX
  drag.y1 = e.clientY
}

function onPieceUp(e) {
  const pid = e.currentTarget?.dataset?.pid
  if (!pid) return
  // 用 drag 记录的最后位置（更稳）
  const x1 = drag && drag.pid === pid ? drag.x1 : e.clientX
  const y1 = drag && drag.pid === pid ? drag.y1 : e.clientY
  finishDrag(pid, x1, y1)
}

function render() {
  ensurePieces()
  setText($moves, String(moves))
  setText($time, fmtTime(elapsed))
  if ($startBtn) {
    $startBtn.disabled = won
    $startBtn.textContent = started ? "暂停" : "开始"
  }
  if ($status) {
    if (won) setText($status, "已通关")
    else if (paused) setText($status, "已暂停：点击开始继续")
    else if (!started) setText($status, "点击开始后拖动棋子（一次一格）")
    else setText($status, "拖动棋子移动（一次一格）")
  }

  if ($winProbVal) {
    const p = calcWinProb()
    $winProbVal.textContent = `${p}%`
    if ($winProb) {
      $winProb.classList.remove("isLow", "isMid", "isHigh")
      if (p <= 30) $winProb.classList.add("isLow")
      else if (p <= 60) $winProb.classList.add("isMid")
      else $winProb.classList.add("isHigh")
    }
  }

  // 提示：目标框 + 箭头
  if (!$hintTarget) $hintTarget = document.getElementById("hrdHintTarget")
  if (!$hintArrow) $hintArrow = document.getElementById("hrdHintArrow")
  const showHint = hintOverlay && Date.now() <= hintOverlay.until
  if ($hintTarget) $hintTarget.classList.toggle("isOn", !!showHint)
  if ($hintArrow) $hintArrow.classList.toggle("isOn", !!showHint)
  if (showHint) {
    const m = boardMetrics()
    if (m && $hintTarget && $hintArrow) {
      const i = pieceIndexById[hintOverlay.pid]
      const pw = PIECES[i].w
      const ph = PIECES[i].h
      const gap = m.gap
      const pad = m.pad
      const cellW = m.cellW
      const cellH = m.cellH

      const left = pad + hintOverlay.toX * (cellW + gap)
      const top = pad + hintOverlay.toY * (cellH + gap)
      const w = pw * cellW + (pw - 1) * gap
      const h = ph * cellH + (ph - 1) * gap
      $hintTarget.style.left = `${left}px`
      $hintTarget.style.top = `${top}px`
      $hintTarget.style.width = `${w}px`
      $hintTarget.style.height = `${h}px`

      // 箭头：从原位置中心到目标位置中心
      const fromCx = pad + hintOverlay.fromX * (cellW + gap) + (w / 2)
      const fromCy = pad + hintOverlay.fromY * (cellH + gap) + (h / 2)
      const toCx = left + w / 2
      const toCy = top + h / 2

      // svg 以 board 像素为 viewBox
      $hintArrow.setAttribute("viewBox", `0 0 ${m.rect.width} ${m.rect.height}`)
      const line = $hintArrow.querySelector("#hrdArrowLine")
      if (line) {
        line.setAttribute("x1", String(fromCx))
        line.setAttribute("y1", String(fromCy))
        line.setAttribute("x2", String(toCx))
        line.setAttribute("y2", String(toCy))
      }
    }
  }

  const els = $board ? $board.querySelectorAll(".hrdPiece") : []
  els.forEach((el) => {
    const pid = el.dataset.pid
    if (!pid) return
    el.classList.toggle("isSel", pid === sel)
    placeEl(el, pid)
  })
}

function tick() {
  if (t0 && started) elapsed = Date.now() - t0
  setText($time, fmtTime(elapsed))
  if (hintOverlay && Date.now() > hintOverlay.until) {
    hintOverlay = null
    render()
  }
}

function init() {
  restart()
  timer = window.setInterval(tick, 250)

  window.addEventListener("resize", () => render())

  if ($hintBtn) $hintBtn.addEventListener("click", () => hintOneStep())
  if ($restartBtn) $restartBtn.addEventListener("click", () => restart())
  if ($startBtn) $startBtn.addEventListener("click", () => startOrPause())

  if ($modal) {
    $modal.addEventListener("click", (e) => {
      if (e.target?.dataset?.close) closeModal()
    })
  }
  if ($modalBtn) $modalBtn.addEventListener("click", () => restart())
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init)
else init()
