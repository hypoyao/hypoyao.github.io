;(() => {
  const $ = (id) => document.getElementById(id)
  const boardEl = $("board")
  const mineEl = $("mineCounter")
  const timeEl = $("timeCounter")
  const faceBtn = $("faceBtn")
  const hintBtn = $("hintBtn")
  const diffBegin = $("diffBegin")
  const diffInter = $("diffInter")
  const diffExpert = $("diffExpert")

  const DIFFS = {
    begin: { rows: 9, cols: 9, mines: 10 },
    inter: { rows: 16, cols: 16, mines: 40 },
    // 高级经典为 16x30（横向很宽）。这里用等价的 30x16（总格子数一样、雷数一样），显示成“纵向布局”。
    expert: { rows: 30, cols: 16, mines: 99 },
  }

  let rows = 9
  let cols = 9
  let mines = 10

  /** cell:
   *  mine: boolean
   *  open: boolean
   *  flag: boolean
   *  adj: number
   */
  let grid = []
  let started = false // 是否已经第一次点击（第一次点击后才布雷，保证首点不踩雷）
  let over = false
  let openedCount = 0
  let flags = 0
  let timer = 0
  let timerId = 0
  let hintIdx = -1
  let hintTimer = 0

  // 以“统一格子大小”为基准：初级/中级/高级都保持同样的格子大小
  // 重点：优先保证“左右放得下”（不出现横向滚动）；如果高度不够就往下滚动（往下延伸）
  let baseCell = 0

  function fitBoard() {
    if (!boardEl) return
    // 统一用“最大列数”来算格子大小，保证中级/高级也不会因为列数多而横向放不下。
    const header = document.querySelector(".msCard .header")
    const bottom = document.querySelector(".msBottom")
    const framePad = 24 // msFrame padding + 视觉留白
    const availW = Math.max(200, window.innerWidth - 28) // msCard padding
    const usedH = (header?.offsetHeight || 0) + (bottom?.offsetHeight || 0) + 36
    const availH = Math.max(220, window.innerHeight - usedH - framePad)

    const maxCols = Math.max(DIFFS.begin.cols, DIFFS.inter.cols, DIFFS.expert.cols) // 现在最大为 16
    // 横向必须放得下：按 maxCols 计算
    const byWidth = Math.floor(availW / maxCols)
    // 初级也别太小：按 9 行高度给一个“上限参考”，但不强制（高度不够就滚动）
    const byHeightHint = Math.floor(availH / 9)
    const cell = Math.max(14, Math.min(44, Math.min(byWidth, byHeightHint)))
    baseCell = cell
    boardEl.style.setProperty("--cell", `${baseCell}px`)
  }

  // ===== util =====
  function idx(x, y) {
    return y * cols + x
  }
  function inb(x, y) {
    return x >= 0 && x < cols && y >= 0 && y < rows
  }
  function pad3(n) {
    const s = String(Math.max(0, Math.min(999, n)))
    return s.padStart(3, "0")
  }
  function setFace(s) {
    faceBtn.textContent = s
  }

  let faceTimer = 0
  function setFaceTemp(s, ms = 600) {
    if (over) return
    try {
      if (faceTimer) clearTimeout(faceTimer)
    } catch {}
    setFace(s)
    faceTimer = setTimeout(() => {
      if (!over) setFace("🙂")
    }, ms)
  }
  function setDiffUI(name) {
    diffBegin.classList.toggle("isOn", name === "begin")
    diffInter.classList.toggle("isOn", name === "inter")
    diffExpert.classList.toggle("isOn", name === "expert")
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId)
    timerId = 0
  }
  function startTimer() {
    stopTimer()
    timerId = setInterval(() => {
      timer++
      timeEl.textContent = pad3(timer)
    }, 1000)
  }

  function resetState() {
    started = false
    over = false
    openedCount = 0
    flags = 0
    timer = 0
    stopTimer()
    timeEl.textContent = "000"
    setFace("🙂")
    mineEl.textContent = pad3(mines)
    clearHint()
  }

  function clearHint() {
    hintIdx = -1
    try {
      if (hintTimer) clearTimeout(hintTimer)
    } catch {}
    hintTimer = 0
  }

  function newGrid() {
    grid = new Array(rows * cols).fill(0).map(() => ({
      mine: false,
      open: false,
      flag: false,
      adj: 0,
    }))
  }

  function neighbors(x, y) {
    const out = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx
        const ny = y + dy
        if (inb(nx, ny)) out.push([nx, ny])
      }
    }
    return out
  }

  function placeMines(avoidX, avoidY) {
    // classic：首点 3x3 周围也不放雷（更像 Windows 扫雷体验）
    const forbidden = new Set()
    forbidden.add(idx(avoidX, avoidY))
    for (const [nx, ny] of neighbors(avoidX, avoidY)) forbidden.add(idx(nx, ny))

    let placed = 0
    while (placed < mines) {
      const x = Math.floor(Math.random() * cols)
      const y = Math.floor(Math.random() * rows)
      const i = idx(x, y)
      if (forbidden.has(i)) continue
      if (grid[i].mine) continue
      grid[i].mine = true
      placed++
    }

    // compute adj
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = idx(x, y)
        if (grid[i].mine) {
          grid[i].adj = 0
          continue
        }
        let c = 0
        for (const [nx, ny] of neighbors(x, y)) if (grid[idx(nx, ny)].mine) c++
        grid[i].adj = c
      }
    }
  }

  function render() {
    boardEl.style.setProperty("--cols", String(cols))
    boardEl.style.setProperty("--rows", String(rows))
    boardEl.innerHTML = ""
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = idx(x, y)
        const c = grid[i]
        const b = document.createElement("button")
        b.type = "button"
        b.className = "msCell"
        b.dataset.x = String(x)
        b.dataset.y = String(y)
        b.setAttribute("role", "gridcell")
        if (i === hintIdx && !over && !c.open) b.classList.add("isHint")

        if (c.open) {
          b.classList.add("isOpen")
          if (c.mine) {
            b.classList.add("isMine")
            b.textContent = "💣"
          } else if (c.adj > 0) {
            b.textContent = String(c.adj)
            b.classList.add("n" + c.adj)
          } else {
            b.textContent = ""
          }
        } else {
          if (c.flag) {
            b.classList.add("isFlag")
            b.textContent = "🚩"
          } else {
            b.textContent = ""
          }
        }
        boardEl.appendChild(b)
      }
    }
    mineEl.textContent = pad3(mines - flags)
  }

  function openCell(x, y) {
    if (over) return
    const i = idx(x, y)
    const c = grid[i]
    if (c.open || c.flag) return
    if (i === hintIdx) clearHint()

    if (!started) {
      started = true
      placeMines(x, y)
      startTimer()
    }

    c.open = true
    openedCount++

    if (c.mine) {
      // lose
      over = true
      setFace("😵")
      // reveal all mines
      for (const cc of grid) {
        if (cc.mine) cc.open = true
      }
      stopTimer()
      render()
      return
    }

    // 如果离炸弹只差一格（周围至少 1 个雷），表情变伤心一下
    if (c.adj > 0) setFaceTemp("😟", 700)

    // flood fill for zero
    if (c.adj === 0) {
      const q = [[x, y]]
      const seen = new Set([i])
      while (q.length) {
        const [cx, cy] = q.shift()
        for (const [nx, ny] of neighbors(cx, cy)) {
          const ni = idx(nx, ny)
          if (seen.has(ni)) continue
          seen.add(ni)
          const nc = grid[ni]
          if (nc.open || nc.flag) continue
          if (nc.mine) continue
          nc.open = true
          openedCount++
          if (nc.adj === 0) q.push([nx, ny])
        }
      }
    }

    // win check
    const safeTotal = rows * cols - mines
    if (openedCount >= safeTotal) {
      over = true
      setFace("😎")
      stopTimer()
      // auto-flag remaining mines
      for (const cc of grid) {
        if (cc.mine && !cc.flag) cc.flag = true
      }
      flags = mines
    }
    render()
  }

  function toggleFlag(x, y) {
    if (over) return
    const i = idx(x, y)
    const c = grid[i]
    if (c.open) return
    if (i === hintIdx) clearHint()
    c.flag = !c.flag
    flags += c.flag ? 1 : -1
    render()
  }

  // 经典“数字开周围”（chord）：已翻开的数字格，周围插旗数等于数字，则一键翻开其余邻居
  function chord(x, y) {
    if (over) return
    const c = grid[idx(x, y)]
    if (!c.open || c.mine || c.adj <= 0) return
    let f = 0
    for (const [nx, ny] of neighbors(x, y)) if (grid[idx(nx, ny)].flag) f++
    if (f !== c.adj) return
    for (const [nx, ny] of neighbors(x, y)) openCell(nx, ny)
  }

  // ===== events =====
  boardEl.addEventListener("contextmenu", (e) => e.preventDefault())
  let lastTouchAt = 0

  boardEl.addEventListener("mousedown", (e) => {
    if (over) return
    if (e.button === 0) setFace("😮")
  })
  window.addEventListener("mouseup", () => {
    if (!over) setFace("🙂")
  })

  boardEl.addEventListener("click", (e) => {
    // 手机上 touchend 后浏览器可能还会补一个 click，这里避免重复翻开
    if (Date.now() - lastTouchAt < 500) return
    const btn = e.target && e.target.closest ? e.target.closest(".msCell") : null
    if (!btn) return
    const x = Number(btn.dataset.x)
    const y = Number(btn.dataset.y)
    if (!inb(x, y)) return
    openCell(x, y)
  })

  boardEl.addEventListener("auxclick", (e) => {
    // some browsers fire auxclick for middle
    const btn = e.target && e.target.closest ? e.target.closest(".msCell") : null
    if (!btn) return
    const x = Number(btn.dataset.x)
    const y = Number(btn.dataset.y)
    if (!inb(x, y)) return
    if (e.button === 1) chord(x, y)
  })

  boardEl.addEventListener("mousedown", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".msCell") : null
    if (!btn) return
    const x = Number(btn.dataset.x)
    const y = Number(btn.dataset.y)
    if (!inb(x, y)) return
    if (e.button === 2) {
      e.preventDefault()
      toggleFlag(x, y)
    } else if (e.button === 1) {
      e.preventDefault()
      chord(x, y)
    }
  })

  // mobile long press to flag
  let lp = null
  boardEl.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault()
      const t = e.touches && e.touches[0]
      if (!t) return
      const el = document.elementFromPoint(t.clientX, t.clientY)
      const btn = el && el.closest ? el.closest(".msCell") : null
      if (!btn) return
      const x = Number(btn.dataset.x)
      const y = Number(btn.dataset.y)
      if (!inb(x, y)) return
      lp = { x, y, moved: false }
      lp.timer = setTimeout(() => {
        if (!lp || lp.moved) return
        toggleFlag(lp.x, lp.y)
        lp = null
      }, 420)
    },
    { passive: false }
  )
  boardEl.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault()
      if (!lp) return
      lp.moved = true
      try {
        clearTimeout(lp.timer)
      } catch {}
    },
    { passive: false }
  )
  boardEl.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault()
      lastTouchAt = Date.now()
      if (!lp) return
      try {
        clearTimeout(lp.timer)
      } catch {}
      if (!lp.moved) {
        // tap to open
        openCell(lp.x, lp.y)
      }
      lp = null
    },
    { passive: false }
  )

  faceBtn.addEventListener("click", () => start("begin", true))

  function hintOneStep() {
    if (over) return
    clearHint()
    // 还没开始布雷：提示点中间（经典扫雷一般先点中间）
    if (!started) {
      hintIdx = idx(Math.floor(cols / 2), Math.floor(rows / 2))
    } else {
      // 简单版“提示”：直接给一个不会踩雷的未翻开格子（帮助小朋友玩）
      const safe = []
      for (let i = 0; i < grid.length; i++) {
        const c = grid[i]
        if (!c.open && !c.flag && !c.mine) safe.push(i)
      }
      if (safe.length) hintIdx = safe[Math.floor(Math.random() * safe.length)]
      else return
    }
    render()
    // 闪 3 秒
    hintTimer = setTimeout(() => {
      clearHint()
      render()
    }, 3000)
  }
  hintBtn?.addEventListener("click", () => hintOneStep())

  function start(diffKey, keep) {
    const d = DIFFS[diffKey]
    rows = d.rows
    cols = d.cols
    mines = d.mines
    setDiffUI(diffKey)
    newGrid()
    resetState()
    fitBoard()
    render()
  }

  diffBegin.addEventListener("click", () => start("begin"))
  diffInter.addEventListener("click", () => start("inter"))
  diffExpert.addEventListener("click", () => start("expert"))

  // boot
  start("begin")
  window.addEventListener("resize", () => {
    fitBoard()
    render()
  })
})()
