;(() => {
  const $ = (id) => document.getElementById(id)
  const cv = $("cv")
  const ctx = cv.getContext("2d")
  const nextCv = $("nextCv")
  const nextCtx = nextCv.getContext("2d")
  const holdCv = $("holdCv")
  const holdCtx = holdCv.getContext("2d")
  const scoreEl = $("scoreText")
  const linesEl = $("linesText")
  const levelEl = $("levelText")
  const overlay = $("overlay")
  const overlayTitle = $("overlayTitle")
  const overlaySub = $("overlaySub")
  const resumeBtn = $("resumeBtn")
  const restartBtn = $("restartBtn")
  const leftBtn = $("leftBtn")
  const rightBtn = $("rightBtn")
  const rotBtn = $("rotBtn")
  const downBtn = $("downBtn")
  const dropBtn = $("dropBtn")
  const holdBtn = $("holdBtn")
  const pauseBtn = $("pauseBtn")
  const mRestartBtn = $("mRestartBtn")

  // ===== board =====
  const COLS = 10
  const ROWS = 20
  const HIDDEN = 2 // hidden rows above visible playfield
  const CELL = 32

  cv.width = COLS * CELL
  cv.height = ROWS * CELL

  // ===== pieces =====
  const PIECES = ["I", "O", "T", "S", "Z", "J", "L"]
  const COLORS = {
    I: "#38bdf8",
    O: "#facc15",
    T: "#a855f7",
    S: "#22c55e",
    Z: "#fb7185",
    J: "#60a5fa",
    L: "#fb923c",
    GHOST: "rgba(148,163,184,0.22)",
    GRID: "rgba(148,163,184,0.12)",
  }

  // 4x4 matrices, SRS orientations 0,1,2,3
  const SHAPES = {
    I: [
      [
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 1, 0],
        [0, 0, 1, 0],
        [0, 0, 1, 0],
        [0, 0, 1, 0],
      ],
      [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 0, 0],
      ],
    ],
    O: [
      [
        [0, 1, 1, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 1, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 1, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 1, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    ],
    T: [
      [
        [0, 1, 0, 0],
        [1, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [0, 1, 1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0],
        [1, 1, 1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [1, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
    ],
    S: [
      [
        [0, 1, 1, 0],
        [1, 1, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [0, 1, 1, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0],
        [0, 1, 1, 0],
        [1, 1, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [1, 0, 0, 0],
        [1, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
    ],
    Z: [
      [
        [1, 1, 0, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 1, 0],
        [0, 1, 1, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0],
        [1, 1, 0, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [1, 1, 0, 0],
        [1, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    ],
    J: [
      [
        [1, 0, 0, 0],
        [1, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 1, 0],
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0],
        [1, 1, 1, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [1, 1, 0, 0],
        [0, 0, 0, 0],
      ],
    ],
    L: [
      [
        [0, 0, 1, 0],
        [1, 1, 1, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 1, 0],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0],
        [1, 1, 1, 0],
        [1, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        [1, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 0],
      ],
    ],
  }

  // SRS kick tables
  // JLSTZ
  const KICK_JLSTZ = {
    "0>1": [
      [0, 0],
      [-1, 0],
      [-1, 1],
      [0, -2],
      [-1, -2],
    ],
    "1>0": [
      [0, 0],
      [1, 0],
      [1, -1],
      [0, 2],
      [1, 2],
    ],
    "1>2": [
      [0, 0],
      [1, 0],
      [1, -1],
      [0, 2],
      [1, 2],
    ],
    "2>1": [
      [0, 0],
      [-1, 0],
      [-1, 1],
      [0, -2],
      [-1, -2],
    ],
    "2>3": [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, -2],
      [1, -2],
    ],
    "3>2": [
      [0, 0],
      [-1, 0],
      [-1, -1],
      [0, 2],
      [-1, 2],
    ],
    "3>0": [
      [0, 0],
      [-1, 0],
      [-1, -1],
      [0, 2],
      [-1, 2],
    ],
    "0>3": [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, -2],
      [1, -2],
    ],
  }
  // I
  const KICK_I = {
    "0>1": [
      [0, 0],
      [-2, 0],
      [1, 0],
      [-2, -1],
      [1, 2],
    ],
    "1>0": [
      [0, 0],
      [2, 0],
      [-1, 0],
      [2, 1],
      [-1, -2],
    ],
    "1>2": [
      [0, 0],
      [-1, 0],
      [2, 0],
      [-1, 2],
      [2, -1],
    ],
    "2>1": [
      [0, 0],
      [1, 0],
      [-2, 0],
      [1, -2],
      [-2, 1],
    ],
    "2>3": [
      [0, 0],
      [2, 0],
      [-1, 0],
      [2, 1],
      [-1, -2],
    ],
    "3>2": [
      [0, 0],
      [-2, 0],
      [1, 0],
      [-2, -1],
      [1, 2],
    ],
    "3>0": [
      [0, 0],
      [1, 0],
      [-2, 0],
      [1, -2],
      [-2, 1],
    ],
    "0>3": [
      [0, 0],
      [-1, 0],
      [2, 0],
      [-1, 2],
      [2, -1],
    ],
  }

  // ===== game state =====
  let grid = null
  let bag = []
  let queue = []
  let cur = null // {t,x,y,r}
  let hold = null // type
  let holdUsed = false
  let score = 0
  let lines = 0
  let level = 1
  let paused = false
  let over = false

  // timing
  let dropAcc = 0
  let lastTs = 0
  const SOFT_DROP_MULT = 20
  let softDrop = false

  function levelSpeedMs(lv) {
    // classic-ish: speed increases with level, clamp
    const base = 800 * Math.pow(0.85, lv - 1)
    return Math.max(60, base)
  }

  // ===== helpers =====
  function newGrid() {
    const g = []
    for (let y = 0; y < ROWS + HIDDEN; y++) g.push(new Array(COLS).fill(""))
    return g
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = arr[i]
      arr[i] = arr[j]
      arr[j] = t
    }
    return arr
  }

  function refillBag() {
    bag = shuffle(PIECES.slice())
  }

  function pullFromBag() {
    if (!bag.length) refillBag()
    return bag.pop()
  }

  function ensureQueue(n = 5) {
    while (queue.length < n) queue.push(pullFromBag())
  }

  function spawn() {
    ensureQueue(5)
    const t = queue.shift()
    ensureQueue(5)
    cur = { t, r: 0, x: 3, y: 0 } // y in hidden+visible coords
    holdUsed = false
    if (collide(cur, 0, 0, cur.r)) {
      gameOver()
    }
  }

  function gameOver() {
    over = true
    paused = true
    showOverlay("游戏结束", "点“重新开始”再来一局～")
  }

  function showOverlay(title, sub) {
    overlay.classList.add("isOn")
    overlay.setAttribute("aria-hidden", "false")
    overlayTitle.textContent = title
    overlaySub.textContent = sub
  }

  function hideOverlay() {
    overlay.classList.remove("isOn")
    overlay.setAttribute("aria-hidden", "true")
  }

  function cellsOf(piece, rOverride) {
    const r = rOverride == null ? piece.r : rOverride
    const m = SHAPES[piece.t][r]
    const out = []
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (m[y][x]) out.push([piece.x + x, piece.y + y])
      }
    }
    return out
  }

  function collide(piece, dx, dy, rNew) {
    const test = { t: piece.t, r: rNew == null ? piece.r : rNew, x: piece.x + dx, y: piece.y + dy }
    const pts = cellsOf(test)
    for (const [x, y] of pts) {
      if (x < 0 || x >= COLS) return true
      if (y >= ROWS + HIDDEN) return true
      if (y >= 0 && grid[y][x]) return true
    }
    return false
  }

  function lock() {
    const pts = cellsOf(cur)
    for (const [x, y] of pts) {
      if (y < 0) continue
      grid[y][x] = cur.t
    }
    const cleared = clearLines()
    if (cleared) {
      // scoring like guideline: 100/300/500/800 * level
      const base = [0, 100, 300, 500, 800][cleared] || 0
      score += base * level
      lines += cleared
      const newLevel = 1 + Math.floor(lines / 10)
      if (newLevel !== level) level = newLevel
      updateStats()
    }
    spawn()
  }

  function clearLines() {
    let n = 0
    for (let y = 0; y < ROWS + HIDDEN; y++) {
      if (grid[y].every((c) => c)) {
        grid.splice(y, 1)
        grid.unshift(new Array(COLS).fill(""))
        n++
      }
    }
    return n
  }

  function updateStats() {
    scoreEl.textContent = String(score)
    linesEl.textContent = String(lines)
    levelEl.textContent = String(level)
  }

  function move(dx, dy) {
    if (paused || over) return false
    if (!collide(cur, dx, dy, cur.r)) {
      cur.x += dx
      cur.y += dy
      return true
    }
    return false
  }

  function hardDrop() {
    if (paused || over) return
    let dist = 0
    while (move(0, 1)) dist++
    // guideline: hard drop adds 2 points per cell (classic)
    score += dist * 2
    updateStats()
    lock()
  }

  function rotate(dir) {
    if (paused || over) return
    const from = cur.r
    const to = (from + (dir > 0 ? 1 : 3)) % 4
    if (cur.t === "O") {
      cur.r = to
      return
    }
    const key = `${from}>${to}`
    const kicks = cur.t === "I" ? KICK_I[key] : KICK_JLSTZ[key]
    for (const [kx, ky] of kicks) {
      if (!collide(cur, kx, ky, to)) {
        cur.x += kx
        cur.y += ky
        cur.r = to
        return
      }
    }
  }

  function holdSwap() {
    if (paused || over) return
    if (holdUsed) return
    holdUsed = true
    const t = cur.t
    if (!hold) {
      hold = t
      spawn()
    } else {
      cur = { t: hold, r: 0, x: 3, y: 0 }
      hold = t
      if (collide(cur, 0, 0, cur.r)) gameOver()
    }
  }

  function togglePause() {
    if (over) return
    paused = !paused
    if (paused) showOverlay("暂停", "按 P 继续")
    else hideOverlay()
  }

  function restart() {
    grid = newGrid()
    bag = []
    queue = []
    hold = null
    holdUsed = false
    score = 0
    lines = 0
    level = 1
    paused = false
    over = false
    dropAcc = 0
    lastTs = 0
    softDrop = false
    updateStats()
    hideOverlay()
    spawn()
  }

  // ===== render =====
  function drawStars() {
    // subtle constellation stars
    ctx.save()
    ctx.globalAlpha = 0.9
    for (let i = 0; i < 42; i++) {
      const x = (i * 97) % cv.width
      const y = (i * 131) % cv.height
      const r = 1 + ((i * 17) % 3) * 0.35
      ctx.fillStyle = i % 7 === 0 ? "rgba(226,232,240,0.65)" : "rgba(148,163,184,0.35)"
      ctx.beginPath()
      ctx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function drawCell(x, y, color, alpha = 1) {
    // y is visible rows (0..ROWS-1)
    const px = x * CELL
    const py = y * CELL
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2)
    // glossy
    ctx.fillStyle = "rgba(255,255,255,0.08)"
    ctx.fillRect(px + 1, py + 1, CELL - 2, Math.floor((CELL - 2) * 0.35))
    ctx.restore()
  }

  function drawGrid() {
    ctx.strokeStyle = COLORS.GRID
    ctx.lineWidth = 1
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath()
      ctx.moveTo(x * CELL + 0.5, 0)
      ctx.lineTo(x * CELL + 0.5, ROWS * CELL)
      ctx.stroke()
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath()
      ctx.moveTo(0, y * CELL + 0.5)
      ctx.lineTo(COLS * CELL, y * CELL + 0.5)
      ctx.stroke()
    }
  }

  function ghostY() {
    const p = { ...cur }
    while (!collide(p, 0, 1, p.r)) p.y++
    return p.y
  }

  function drawMain() {
    ctx.clearRect(0, 0, cv.width, cv.height)
    // background
    ctx.fillStyle = "rgba(2,6,23,0.85)"
    ctx.fillRect(0, 0, cv.width, cv.height)
    drawStars()
    drawGrid()

    // locked blocks
    for (let y = HIDDEN; y < ROWS + HIDDEN; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = grid[y][x]
        if (!t) continue
        drawCell(x, y - HIDDEN, COLORS[t], 0.95)
      }
    }

    // ghost
    const gy = ghostY()
    const ghost = { ...cur, y: gy }
    for (const [x, y] of cellsOf(ghost)) {
      if (y < HIDDEN) continue
      drawCell(x, y - HIDDEN, COLORS.GHOST, 1)
    }

    // current piece
    for (const [x, y] of cellsOf(cur)) {
      if (y < HIDDEN) continue
      drawCell(x, y - HIDDEN, COLORS[cur.t], 1)
    }
  }

  function drawMini(ctx2, type) {
    ctx2.clearRect(0, 0, 160, 160)
    ctx2.fillStyle = "rgba(2,6,23,0.55)"
    ctx2.fillRect(0, 0, 160, 160)
    if (!type) return
    const m = SHAPES[type][0]
    const size = 28
    // center piece
    let minX = 10,
      minY = 10,
      maxX = -10,
      maxY = -10
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (m[y][x]) {
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
        }
      }
    }
    const w = (maxX - minX + 1) * size
    const h = (maxY - minY + 1) * size
    const ox = Math.floor((160 - w) / 2) - minX * size
    const oy = Math.floor((160 - h) / 2) - minY * size
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if (!m[y][x]) continue
        ctx2.fillStyle = COLORS[type]
        ctx2.fillRect(ox + x * size + 2, oy + y * size + 2, size - 4, size - 4)
        ctx2.fillStyle = "rgba(255,255,255,0.08)"
        ctx2.fillRect(ox + x * size + 2, oy + y * size + 2, size - 4, Math.floor((size - 4) * 0.35))
      }
    }
  }

  function render() {
    drawMain()
    ensureQueue(5)
    drawMini(nextCtx, queue[0])
    drawMini(holdCtx, hold)
  }

  // ===== loop =====
  function step(ts) {
    if (!lastTs) lastTs = ts
    const dt = Math.min(50, ts - lastTs)
    lastTs = ts

    if (!paused && !over) {
      const speed = levelSpeedMs(level)
      dropAcc += dt * (softDrop ? SOFT_DROP_MULT : 1)
      while (dropAcc >= speed) {
        dropAcc -= speed
        if (!move(0, 1)) {
          lock()
          break
        }
      }
    }

    render()
    requestAnimationFrame(step)
  }

  // ===== input =====
  const keyDown = new Set()
  function onKeyDown(e) {
    const k = e.key
    if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", " ", "z", "Z", "c", "C", "p", "P"].includes(k)) {
      e.preventDefault()
    }
    if (k === "p" || k === "P") return togglePause()
    if (paused && !over) return

    if (k === "ArrowLeft") move(-1, 0)
    else if (k === "ArrowRight") move(1, 0)
    else if (k === "ArrowDown") softDrop = true
    else if (k === "ArrowUp") rotate(1)
    else if (k === "z" || k === "Z") rotate(-1)
    else if (k === " ") hardDrop()
    else if (k === "c" || k === "C") holdSwap()
    keyDown.add(k)
  }
  function onKeyUp(e) {
    const k = e.key
    if (k === "ArrowDown") softDrop = false
    keyDown.delete(k)
  }
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)

  // mobile buttons
  function bindBtn(btn, onPress, onRelease) {
    if (!btn) return
    let holdT = null
    const start = (e) => {
      e.preventDefault()
      onPress?.()
      if (onRelease) {
        // no-op
      }
      // repeat for move buttons
      if (btn === leftBtn || btn === rightBtn || btn === downBtn) {
        clearInterval(holdT)
        holdT = setInterval(() => onPress?.(), btn === downBtn ? 45 : 60)
      }
    }
    const end = (e) => {
      e.preventDefault()
      if (holdT) clearInterval(holdT)
      holdT = null
      onRelease?.()
    }
    btn.addEventListener("mousedown", start)
    btn.addEventListener("touchstart", start, { passive: false })
    window.addEventListener("mouseup", end)
    window.addEventListener("touchend", end, { passive: false })
    window.addEventListener("touchcancel", end, { passive: false })
  }

  bindBtn(leftBtn, () => move(-1, 0))
  bindBtn(rightBtn, () => move(1, 0))
  bindBtn(rotBtn, () => rotate(1))
  bindBtn(downBtn, () => {
    softDrop = true
    move(0, 1)
  }, () => {
    softDrop = false
  })
  bindBtn(dropBtn, () => hardDrop())
  bindBtn(holdBtn, () => holdSwap())
  bindBtn(pauseBtn, () => togglePause())
  bindBtn(mRestartBtn, () => {
    if (window.confirm("确定重新开始吗？")) restart()
  })

  resumeBtn?.addEventListener("click", () => {
    if (!over) {
      paused = false
      hideOverlay()
    }
  })
  restartBtn?.addEventListener("click", () => {
    if (window.confirm("确定重新开始吗？")) restart()
  })

  // ===== boot =====
  restart()
  requestAnimationFrame(step)
})()

