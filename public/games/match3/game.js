;(() => {
  const $ = (id) => document.getElementById(id)
  const boardEl = $("board")
  const scoreEl = $("scoreText")
  const comboEl = $("comboText")
  const hintTextEl = $("hintText")
  const hintBtn = $("hintBtn")
  const shuffleBtn = $("shuffleBtn")
  const restartBtn = $("restartBtn")
  const toast = $("toast")
  const toastText = $("toastText")
  const timeEl = $("timeText")
  const clearEl = $("clearText")
  const quizModal = $("quizModal")
  const quizExprEl = $("quizExpr")
  const quizInput = $("quizInput")
  const quizSubmit = $("quizSubmit")
  const quizInputRow = $("quizInputRow")
  const quizPicker = $("quizPicker")
  const endModal = $("endModal")
  const endTextEl = $("endText")
  const endSubEl = $("endSub")
  const endRestartBtn = $("endRestartBtn")

  const W = 8
  const H = 8

  // 固定数字模式：1~6（更适合小朋友做加法）
  const symbols = ["1", "2", "3", "4", "5", "6"]

  const colors = [
    "rgba(56, 189, 248, 0.95)", // sky
    "rgba(34, 197, 94, 0.95)", // green
    "rgba(250, 204, 21, 0.95)", // yellow
    "rgba(244, 63, 94, 0.95)", // rose
    "rgba(168, 85, 247, 0.95)", // purple
    "rgba(251, 146, 60, 0.95)", // orange
  ]

  let board = [] // length W*H, each cell is int type index
  let selected = -1
  let busy = false
  let score = 0
  let combo = 1
  let hint = null // {a,b, dir, sym}
  let hintTimer = 0
  let quiz = null // { cells:number[], expr:string, ans:number }
  let groupBoxEl = null
  const isTouch = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  let startAt = 0
  let clearCount = 0
  let gameOver = false
  const LIMIT_MS = 3 * 60 * 1000
  const WIN_CLEAR = 15

  // ====== tiny sound (no external assets, “正版”) ======
  let audioCtx = null
  function beep(freq = 740, dur = 0.06, type = "sine", vol = 0.04) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
      const t0 = audioCtx.currentTime
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.type = type
      o.frequency.value = freq
      g.gain.value = 0.0001
      g.gain.setTargetAtTime(vol, t0, 0.01)
      g.gain.setTargetAtTime(0.0001, t0 + dur, 0.02)
      o.connect(g)
      g.connect(audioCtx.destination)
      o.start(t0)
      o.stop(t0 + dur + 0.05)
    } catch {}
  }

  function toastMsg(s) {
    if (!toast || !toastText) return
    toastText.textContent = s
    toast.classList.add("isOn")
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => {
      toast.classList.remove("isOn")
      toast.classList.remove("isBig")
    }, 900)
  }

  function bigToast(s) {
    if (!toast) return
    toast.classList.add("isBig")
    toastMsg(s)
  }

  function idx(x, y) {
    return y * W + x
  }

  function xy(i) {
    return { x: i % W, y: Math.floor(i / W) }
  }

  function randType() {
    return Math.floor(Math.random() * symbols.length)
  }

  function fmtTime(ms) {
    const t = Math.max(0, Math.floor(ms / 1000))
    const m = String(Math.floor(t / 60)).padStart(2, "0")
    const s = String(t % 60).padStart(2, "0")
    return `${m}:${s}`
  }

  function setEnd(win) {
    gameOver = true
    busy = false
    selected = -1
    hint = null
    // 关掉题目弹窗（如果还在）
    closeQuizEx(false)
    if (endModal) {
      endModal.classList.add("isOn")
      endModal.setAttribute("aria-hidden", "false")
    }
    if (endTextEl) {
      endTextEl.textContent = win ? "赢" : "输"
      endTextEl.classList.toggle("isWin", !!win)
      endTextEl.classList.toggle("isLose", !win)
    }
    if (endSubEl) {
      endSubEl.textContent = `3 分钟内消除 ${clearCount} 次（目标 ≥ ${WIN_CLEAR} 次）`
    }
    hintTextEl.textContent = "游戏结束～点“再来一局”"
  }

  function tick() {
    if (!startAt || gameOver) return
    const left = LIMIT_MS - (Date.now() - startAt)
    if (timeEl) timeEl.textContent = fmtTime(left)
    if (clearEl) clearEl.textContent = String(clearCount)
    if (left <= 0) {
      const win = clearCount >= WIN_CLEAR
      setEnd(win)
    }
  }

  function restart() {
    selected = -1
    busy = false
    score = 0
    combo = 1
    hint = null
    quiz = null
    clearCount = 0
    startAt = Date.now()
    gameOver = false
    if (endModal) {
      endModal.classList.remove("isOn")
      endModal.setAttribute("aria-hidden", "true")
    }
    board = new Array(W * H).fill(0).map(() => randType())
    // avoid initial matches
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let t = board[idx(x, y)]
        while (wouldMakeMatch(x, y, t)) t = randType()
        board[idx(x, y)] = t
      }
    }
    render()
    scoreEl.textContent = String(score)
    comboEl.textContent = `x${combo}`
    hintTextEl.textContent = "点一个方块，再点旁边的方块"
    toastMsg("开始啦～凑 3 个一样的！答对加法题才会消掉～")
    if (clearEl) clearEl.textContent = String(clearCount)
    if (timeEl) timeEl.textContent = fmtTime(LIMIT_MS)
    // 如果没有可走步：洗牌
    if (!findAnyMove()) shuffle()
  }

  function wouldMakeMatch(x, y, t) {
    // check left2
    if (x >= 2 && board[idx(x - 1, y)] === t && board[idx(x - 2, y)] === t) return true
    // check up2
    if (y >= 2 && board[idx(x, y - 1)] === t && board[idx(x, y - 2)] === t) return true
    return false
  }

  function render() {
    if (!boardEl) return
    boardEl.innerHTML = ""
    for (let i = 0; i < board.length; i++) {
      const t = board[i]
      const cell = document.createElement("button")
      cell.type = "button"
      cell.className = "m3Cell"
      cell.dataset.i = String(i)
      cell.style.setProperty("--m3-color", colors[t % colors.length])
      const span = document.createElement("span")
      span.textContent = symbols[t] || "?"
      cell.appendChild(span)
      if (i === selected) cell.classList.add("isSelected")
      if (hint && (i === hint.a || i === hint.b)) cell.classList.add("isHint")
      if (hint && i === hint.a) {
        cell.classList.add("isHintFrom")
        cell.dataset.hintDir = hint.dir || ""
        const arrow = document.createElement("div")
        arrow.className = `m3HintArrow dir-${hint.dir || "R"}`
        cell.appendChild(arrow)
      }
      if (hint && i === hint.b) cell.classList.add("isHintTo")
      boardEl.appendChild(cell)
    }

    // 叠一层“圈选框”
    groupBoxEl = document.createElement("div")
    groupBoxEl.className = "m3GroupBox"
    groupBoxEl.id = "groupBox"
    boardEl.appendChild(groupBoxEl)
    updateGroupBox()
  }

  function updateGroupBox() {
    if (!groupBoxEl) return
    if (!quiz || !quiz.cells || quiz.cells.length < 3) {
      groupBoxEl.classList.remove("isOn")
      return
    }
    // 用 DOM 计算 bounding box，圈住整组数字
    const nodes = boardEl.querySelectorAll(".m3Cell")
    let minL = Infinity,
      minT = Infinity,
      maxR = -Infinity,
      maxB = -Infinity
    const br = boardEl.getBoundingClientRect()
    for (const i of quiz.cells) {
      const el = nodes[i]
      if (!el) continue
      const r = el.getBoundingClientRect()
      minL = Math.min(minL, r.left - br.left)
      minT = Math.min(minT, r.top - br.top)
      maxR = Math.max(maxR, r.right - br.left)
      maxB = Math.max(maxB, r.bottom - br.top)
    }
    if (!isFinite(minL)) {
      groupBoxEl.classList.remove("isOn")
      return
    }
    const pad = 6
    groupBoxEl.style.left = `${Math.max(0, minL - pad)}px`
    groupBoxEl.style.top = `${Math.max(0, minT - pad)}px`
    groupBoxEl.style.width = `${Math.max(0, maxR - minL + pad * 2)}px`
    groupBoxEl.style.height = `${Math.max(0, maxB - minT + pad * 2)}px`
    groupBoxEl.classList.add("isOn")
  }

  function clearHint() {
    hint = null
  }

  function neighbors(a, b) {
    const A = xy(a)
    const B = xy(b)
    const dx = Math.abs(A.x - B.x)
    const dy = Math.abs(A.y - B.y)
    return dx + dy === 1
  }

  function swap(a, b) {
    const tmp = board[a]
    board[a] = board[b]
    board[b] = tmp
  }

  function findMatchGroups() {
    /** @type {number[][]} */
    const groups = []

    // rows
    for (let y = 0; y < H; y++) {
      let runStart = 0
      for (let x = 1; x <= W; x++) {
        const prev = board[idx(x - 1, y)]
        const cur = x < W ? board[idx(x, y)] : -1
        if (cur !== prev) {
          const runLen = x - runStart
          if (runLen >= 3) {
            const g = []
            for (let k = runStart; k < x; k++) g.push(idx(k, y))
            groups.push(g)
          }
          runStart = x
        }
      }
    }

    // cols
    for (let x = 0; x < W; x++) {
      let runStart = 0
      for (let y = 1; y <= H; y++) {
        const prev = board[idx(x, y - 1)]
        const cur = y < H ? board[idx(x, y)] : -1
        if (cur !== prev) {
          const runLen = y - runStart
          if (runLen >= 3) {
            const g = []
            for (let k = runStart; k < y; k++) g.push(idx(x, k))
            groups.push(g)
          }
          runStart = y
        }
      }
    }

    return groups
  }

  function applyGravityForNulls() {
    // gravity per column
    for (let x = 0; x < W; x++) {
      const col = []
      for (let y = H - 1; y >= 0; y--) {
        const v = board[idx(x, y)]
        if (v !== null) col.push(v)
      }
      while (col.length < H) col.push(randType())
      for (let y = H - 1; y >= 0; y--) {
        board[idx(x, y)] = col[H - 1 - y]
      }
    }
  }

  function pickGroup(groups, a, b) {
    if (!groups.length) return null
    const cand = groups
      .filter((g) => g.includes(a) || g.includes(b))
      .sort((x, y) => y.length - x.length)
    return cand[0] || groups.sort((x, y) => y.length - x.length)[0]
  }

  function pickAreaQuiz(nums) {
    // nums: [1..6]
    const mid = nums[Math.floor(nums.length / 2)] || nums[0] || 1
    // “长方形题”如果两个数一样，本质就是正方形；这里让长方形题尽量用不同的长宽
    const rectW = mid
    const rectH = Math.min(9, mid + 1) // 让它经常不是正方形（例：3×4）

    // 三角形：用 (底=mid, 高=mid+1)，保证 (底*高) 为偶数，从而面积一定是整数
    const triBase = mid
    const triH = Math.min(9, mid + 1)

    /** @type {Array<{type:string, expr:string, ans:number}>} */
    const choices = []
    // 正方形
    choices.push({
      type: "square",
      expr: `正方形面积 = 边长 × 边长\n边长 = ${mid}\n面积 = ?`,
      ans: mid * mid,
    })
    // 长方形
    choices.push({
      type: "rect",
      expr:
        rectW === rectH
          ? `正方形（也是长方形的一种）\n面积 = 长 × 宽\n长 = ${rectW}，宽 = ${rectH}\n面积 = ?`
          : `长方形面积 = 长 × 宽\n长 = ${rectW}，宽 = ${rectH}\n面积 = ?`,
      ans: rectW * rectH,
    })
    // 三角形（可选）
    const rectHint = triBase === triH ? "正方形" : "长方形"
    choices.push({
      type: "tri",
      expr:
        `三角形面积公式：S = 底 × 高 ÷ 2\n` +
        `提示：两个一样的三角形拼起来，可以组成${rectHint}（或平行四边形），\n` +
        `合起来的面积 = 底 × 高，所以一个三角形面积 = (底 × 高) ÷ 2\n` +
        `底 = ${triBase}，高 = ${triH}\n` +
        `面积 = ?`,
      ans: (triBase * triH) / 2,
    })

    // 随机挑一个（稍微偏向正方形/长方形）
    const r = Math.random()
    // 让“三角形题”确实会出现（大约 30%）
    if (r < 0.35) return choices[0] // square
    if (r < 0.70) return choices[1] // rect
    return choices[2] // tri
  }

  function openQuizForGroup(g) {
    const nums = g.map((i) => Number(board[i] ?? 0) + 1)
    const q = pickAreaQuiz(nums)
    quiz = { cells: g.slice(), expr: q.expr, ans: q.ans }
    render()
    if (quizModal) {
      quizModal.classList.add("isOn")
      quizModal.setAttribute("aria-hidden", "false")
    }
    if (quizExprEl) quizExprEl.textContent = quiz.expr

    // 手机：显示可点的数字选择；电脑：显示输入框并 focus
    if (quizInputRow) {
      quizInputRow.style.display = isTouch ? "none" : "grid"
    }
    if (quizPicker) {
      quizPicker.innerHTML = ""
      if (isTouch) {
        quizPicker.classList.add("isOn")
        // 面积最大：6×6=36；给 0~50 更宽一点
        for (let n = 0; n <= 50; n++) {
          const b = document.createElement("button")
          b.type = "button"
          b.className = "m3PickBtn"
          b.textContent = String(n)
          b.addEventListener("click", () => {
            submitAnswer(String(n))
          })
          quizPicker.appendChild(b)
        }
      } else {
        quizPicker.classList.remove("isOn")
      }
    }

    if (quizInput) {
      quizInput.value = ""
      if (!isTouch) {
        try {
          quizInput.focus()
          quizInput.select()
        } catch {}
      }
    }
    hintTextEl.textContent = "答对题目才会消掉哦～"
  }

  function closeQuiz() {
    closeQuizEx(true)
  }

  function closeQuizEx(doRender) {
    quiz = null
    if (quizModal) {
      quizModal.classList.remove("isOn")
      quizModal.setAttribute("aria-hidden", "true")
    }
    if (doRender) render()
  }

  async function submitAnswer(valRaw) {
    if (!quiz || busy) return
    if (gameOver) return
    const v = String(valRaw || "").trim()
    const n = Number(v)
    if (!Number.isFinite(n)) return
    if (n !== quiz.ans) {
      beep(180, 0.08, "sawtooth", 0.03)
      toastMsg("不对哦～再试一次！")
      const panel = quizModal?.querySelector(".m3QuizPanel")
      panel?.classList.add("isShake")
      setTimeout(() => panel?.classList.remove("isShake"), 240)
      if (quizInput) {
        quizInput.value = ""
        try {
          quizInput.focus()
        } catch {}
      }
      return
    }

    // 正确：提示 +1 分，然后消除这组，再掉落；若又形成三连，继续出题
    busy = true
    beep(620, 0.06, "triangle", 0.04)
    const cleared = quiz.cells.length
    score += 1
    scoreEl.textContent = String(score)
    bigToast("答对了！+1 分")
    clearCount += 1
    if (clearEl) clearEl.textContent = String(clearCount)

    // 1) 先关掉弹窗（不立刻重渲染），然后做“消失 + 掉落”动画
    const cellsToClear = quiz.cells.slice()
    closeQuizEx(false)

    const nodes = boardEl ? boardEl.querySelectorAll(".m3Cell") : []
    // 标记消失动画
    for (const i of cellsToClear) {
      const el = nodes[i]
      if (el) el.classList.add("isClearing")
    }

    // 计算每列要下落的距离（用 DOM 实际间距，适配不同屏幕）
    const stepY = (() => {
      try {
        if (!nodes || nodes.length < W * H) return 0
        const r0 = nodes[0].getBoundingClientRect()
        const r1 = nodes[W].getBoundingClientRect()
        return Math.max(0, r1.top - r0.top)
      } catch {
        return 0
      }
    })()

    // 等消失动画一小会儿
    await wait(210)

    // 给“上面的数字”加下落动画（视觉上往下滑）
    if (stepY > 0 && nodes && nodes.length >= W * H) {
      const clearSet = new Set(cellsToClear)
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          const i = idx(x, y)
          if (clearSet.has(i)) continue
          // 这个格子下面有多少个被消掉的格子？
          let drop = 0
          for (let yy = y + 1; yy < H; yy++) {
            if (clearSet.has(idx(x, yy))) drop++
          }
          if (drop <= 0) continue
          const el = nodes[i]
          if (!el) continue
          el.style.transition = "transform 260ms cubic-bezier(.2,.8,.2,1)"
          el.style.transform = `translateY(${drop * stepY}px)`
        }
      }
    }

    // 等下落动画结束
    await wait(280)

    // 2) 真正更新棋盘数据：置空 -> 重力掉落 -> 补新
    for (const i of cellsToClear) board[i] = null
    applyGravityForNulls()

    // 3) 重渲染到最终状态，并清理 transform（避免残留）
    render()
    const nodes2 = boardEl ? boardEl.querySelectorAll(".m3Cell") : []
    for (const el of nodes2) {
      el.style.transition = ""
      el.style.transform = ""
      el.classList.remove("isClearing")
    }

    // 继续检查是否有连锁
    const groups = findMatchGroups()
    if (groups.length) {
      const g = groups.sort((a, b) => b.length - a.length)[0]
      openQuizForGroup(g)
      busy = false
      return
    }
    busy = false
    hintTextEl.textContent = "继续交换～"
    if (!findAnyMove()) {
      toastMsg("没路可走啦～我帮你洗牌！")
      shuffle()
    }
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }

  function trySwap(a, b) {
    if (busy) return
    if (quiz) return
    if (gameOver) return
    if (!neighbors(a, b)) return
    busy = true
    clearHint()
    swap(a, b)
    const groups = findMatchGroups()
    if (!groups.length) {
      // revert
      swap(a, b)
      toastMsg("这一步不行哦～要凑到 3 个一样的！")
      beep(200, 0.06, "sawtooth", 0.025)
      selected = -1
      render()
      busy = false
      return
    }
    selected = -1
    render()
    const g = pickGroup(groups, a, b)
    openQuizForGroup(g)
    busy = false
  }

  function findAnyMove() {
    // brute force: try swap each cell with right/down; check if match created
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = idx(x, y)
        if (x + 1 < W) {
          const b = idx(x + 1, y)
          swap(a, b)
          const ok = findMatchGroups().length > 0
          swap(a, b)
          if (ok) return { a, b }
        }
        if (y + 1 < H) {
          const b = idx(x, y + 1)
          swap(a, b)
          const ok = findMatchGroups().length > 0
          swap(a, b)
          if (ok) return { a, b }
        }
      }
    }
    return null
  }

  function showHint() {
    if (busy) return
    if (quiz) return
    if (gameOver) return
    const mv = findAnyMove()
    if (!mv) {
      toastMsg("我也找不到啦…洗牌试试！")
      return
    }

    const A = xy(mv.a)
    const B = xy(mv.b)
    let dir = "R"
    if (B.x > A.x) dir = "R"
    else if (B.x < A.x) dir = "L"
    else if (B.y > A.y) dir = "D"
    else if (B.y < A.y) dir = "U"

    const sym = symbols[board[mv.a]] || "?"
    hint = { ...mv, dir, sym }
    render()
    const dirText = dir === "R" ? "往右" : dir === "L" ? "往左" : dir === "U" ? "往上" : "往下"
    hintTextEl.textContent = `把「${sym}」${dirText}换过去～`
    beep(660, 0.05, "sine", 0.03)
    setTimeout(() => {
      clearHint()
      render()
    }, 1200)
  }

  function shuffle() {
    if (busy) return
    if (quiz) return
    if (gameOver) return
    busy = true
    clearHint()
    selected = -1
    // shuffle until no immediate matches and has a move
    let tries = 0
    while (tries++ < 80) {
      // Fisher-Yates
      for (let i = board.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = board[i]
        board[i] = board[j]
        board[j] = tmp
      }
      // remove immediate matches by rerolling
      let fixed = false
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = idx(x, y)
          let t = board[i]
          let guard = 0
          while (wouldMakeMatch(x, y, t) && guard++ < 12) {
            t = randType()
            fixed = true
          }
          board[i] = t
        }
      }
      if (findAnyMove()) break
      if (!fixed && tries > 10) break
    }
    render()
    busy = false
    toastMsg("洗牌完成～继续冲！")
  }

  // ===== input: click + swipe =====
  boardEl?.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".m3Cell") : null
    if (!btn) return
    const i = Number(btn.dataset.i || -1)
    if (Number.isNaN(i) || i < 0) return
    if (busy) return
    if (quiz) return
    if (gameOver) return
    beep(520, 0.03, "sine", 0.02)
    if (selected < 0) {
      selected = i
      hintTextEl.textContent = "再点旁边一个方块交换～"
      render()
      return
    }
    if (i === selected) {
      selected = -1
      hintTextEl.textContent = "点一个方块，再点旁边的方块"
      render()
      return
    }
    if (!neighbors(selected, i)) {
      selected = i
      hintTextEl.textContent = "要点旁边那个才能交换哦～"
      render()
      return
    }
    trySwap(selected, i)
  })

  // swipe on board (mobile)
  let touchStart = null // {i, x, y}
  boardEl?.addEventListener(
    "touchstart",
    (e) => {
      if (busy) return
      if (quiz) return
      if (gameOver) return
      const t = e.touches && e.touches[0]
      if (!t) return
      const el = document.elementFromPoint(t.clientX, t.clientY)
      const cell = el && el.closest ? el.closest(".m3Cell") : null
      if (!cell) return
      const i = Number(cell.dataset.i || -1)
      touchStart = { i, x: t.clientX, y: t.clientY }
      selected = i
      render()
    },
    { passive: true }
  )
  boardEl?.addEventListener(
    "touchend",
    (e) => {
      if (!touchStart || busy) return
      if (quiz) return
      if (gameOver) return
      const t = e.changedTouches && e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - touchStart.x
      const dy = t.clientY - touchStart.y
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      if (Math.max(adx, ady) < 18) {
        // treat as tap
        touchStart = null
        return
      }
      const { x, y } = xy(touchStart.i)
      let nx = x
      let ny = y
      if (adx > ady) nx = x + (dx > 0 ? 1 : -1)
      else ny = y + (dy > 0 ? 1 : -1)
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) {
        touchStart = null
        selected = -1
        render()
        return
      }
      const j = idx(nx, ny)
      trySwap(touchStart.i, j)
      touchStart = null
    },
    { passive: true }
  )

  // controls
  hintBtn?.addEventListener("click", () => showHint())
  shuffleBtn?.addEventListener("click", () => shuffle())
  function confirmRestart() {
    if (busy || quiz) return
    if (window.confirm("确定重新开始吗？\n\n当前进度会清零，计时也会重新开始。")) restart()
  }
  restartBtn?.addEventListener("click", () => confirmRestart())
  endRestartBtn?.addEventListener("click", () => confirmRestart())

  // quiz interactions
  quizSubmit?.addEventListener("click", () => submitAnswer(quizInput?.value || ""))
  quizInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAnswer(quizInput.value || "")
  })
  // 电脑键盘：无论焦点在不在输入框，都可以直接输入数字
  document.addEventListener("keydown", (e) => {
    if (!quiz) return
    if (isTouch) return
    // 如果当前焦点就在输入框，让输入框自己处理，避免出现“点一下变 33”的双输入问题
    if (document.activeElement === quizInput) return
    const t = e.target
    const tag = t && t.tagName ? String(t.tagName).toUpperCase() : ""
    if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return
    const k = e.key
    if (k === "Enter") {
      submitAnswer(quizInput?.value || "")
      return
    }
    if (k === "Backspace") {
      if (quizInput) quizInput.value = (quizInput.value || "").slice(0, -1)
      return
    }
    if (/^\d$/.test(k)) {
      if (quizInput) quizInput.value = (quizInput.value || "") + k
      return
    }
  })

  // boot
  restart()
  setInterval(tick, 250)
})()
