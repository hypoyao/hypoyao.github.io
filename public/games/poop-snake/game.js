"use strict"

// 贪吃蛇屎大作战（像素版）
// 目标：吃到“棕色像素大便”变长；长到 15 节后 AI 蛇陆续出现（最多 5 只）
// - 发射炮弹：会让自己少 1 节；打到 AI 头 -> AI 立刻挂掉；打到 AI 身体 -> AI 尾巴那段变成食物
// - 甩尾剑：尾巴甩 3 下；碰到 AI 头 -> AI 挂掉；碰到 AI 身体 -> 把 AI 推远一点

const COLS = 30
const ROWS = 22
const CELL = 18 // 像素格

const TICK_MS = 190
const BULLET_MS = 60

// 颜色（像素风）
const C_BG_GRID = "rgba(15,23,42,0.06)"
const C_PLAYER = "#2563eb"
const C_PLAYER2 = "#1d4ed8"
const C_AI = "#ef4444"
const C_AI2 = "#b91c1c"
const C_POOP = "#8b5a2b"
const C_POOP2 = "#6f3f18"
const C_BULLET = "#111827"
const C_TAIL_SWING = "rgba(245,158,11,0.65)"

// DOM
const $cv = document.getElementById("cv")
const ctx = $cv && $cv.getContext ? $cv.getContext("2d") : null
const $status = document.getElementById("status")
const $len = document.getElementById("lenText")
const $ai = document.getElementById("aiText")

const $up = document.getElementById("upBtn")
const $down = document.getElementById("downBtn")
const $left = document.getElementById("leftBtn")
const $right = document.getElementById("rightBtn")
const $start = document.getElementById("startBtn")
const $fire = document.getElementById("fireBtn")
const $tail = document.getElementById("tailBtn")
const $restart = document.getElementById("restartBtn")

const $endModal = document.getElementById("endModal")
const $endTitle = document.getElementById("endTitle")
const $endBody = document.getElementById("endBody")
const $endBtn = document.getElementById("endBtn")

function setText(el, t) {
  if (el) el.textContent = t
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}
function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1))
}
function eq(a, b) {
  return a && b && a.x === b.x && a.y === b.y
}
function inBounds(p) {
  return p.x >= 0 && p.x < COLS && p.y >= 0 && p.y < ROWS
}
function key(p) {
  return `${p.x},${p.y}`
}

function openModal(title, body) {
  if (!$endModal) return
  if ($endTitle) $endTitle.textContent = title
  if ($endBody) $endBody.textContent = body
  $endModal.classList.add("isOpen")
  $endModal.setAttribute("aria-hidden", "false")
}
function closeModal() {
  if (!$endModal) return
  $endModal.classList.remove("isOpen")
  $endModal.setAttribute("aria-hidden", "true")
}

// ===== 游戏状态 =====
let player = null
let foods = []
let ais = [] // {id, body:[{x,y}], dir:{x,y}, alive:true}
let bullets = [] // {x,y,dx,dy,alive:true}

let tickTimer = null
let bulletTimer = null
let thinking = false

let aiSpawnEnabled = false
let aiSpawnTimer = 0

let tailSwing = { ticks: 0, cd: 0 } // ticks=剩余挥动次数（3），cd=冷却帧
let running = false
let paused = false

function resetGame() {
  closeModal()
  const cx = Math.floor(COLS / 2)
  const cy = Math.floor(ROWS / 2)
  player = {
    // 初始长度 3：头 + 两节身体
    body: [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ],
    dir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    alive: true,
  }
  foods = []
  ais = []
  bullets = []
  thinking = false
  aiSpawnEnabled = false
  aiSpawnTimer = 0
  tailSwing = { ticks: 0, cd: 0 }
  // 先来 4 坨大便
  for (let i = 0; i < 4; i++) spawnFood()
  running = false
  paused = false
  if ($start) $start.textContent = "开始"
  setText($status, "准备就绪：点「开始」后再用按钮/键盘控制")
  loopStop()
  render()
}

function occupiedSet() {
  const s = new Set()
  for (const p of player.body) s.add(key(p))
  for (const a of ais) for (const p of a.body) s.add(key(p))
  return s
}

function spawnFood(pos) {
  const occ = occupiedSet()
  let p = pos || { x: randInt(0, COLS - 1), y: randInt(0, ROWS - 1) }
  let guard = 0
  while ((occ.has(key(p)) || foods.some((f) => eq(f, p))) && guard < 2000) {
    p = { x: randInt(0, COLS - 1), y: randInt(0, ROWS - 1) }
    guard++
  }
  foods.push(p)
}

function dropFoodAt(p) {
  // “掉落食物”：必须落在指定格子上（用于死亡掉落、打掉尾巴掉落）
  // 不走 spawnFood 的“避开占用随机换位置”逻辑，否则会出现“身体没变成屎”的错觉
  if (!p) return
  if (!inBounds(p)) return
  if (foods.some((f) => eq(f, p))) return
  foods.push({ x: p.x, y: p.y })
}

function spawnAiSnake() {
  if (ais.length >= 5) return
  // 在边缘随机出现，避免一上来贴脸
  const side = randInt(0, 3)
  let head = { x: 0, y: 0 }
  if (side === 0) head = { x: 0, y: randInt(0, ROWS - 1) }
  if (side === 1) head = { x: COLS - 1, y: randInt(0, ROWS - 1) }
  if (side === 2) head = { x: randInt(0, COLS - 1), y: 0 }
  if (side === 3) head = { x: randInt(0, COLS - 1), y: ROWS - 1 }

  const id = "ai-" + Math.random().toString(16).slice(2)
  const dir = { x: head.x < COLS / 2 ? 1 : -1, y: 0 }
  const body = [head]
  return ais.push({ id, body, dir, alive: true })
}

function setDir(nx, ny) {
  if (!player || !player.alive) return
  // 不允许直接掉头（不然会咬到自己）
  if (player.dir.x + nx === 0 && player.dir.y + ny === 0) return
  player.nextDir = { x: nx, y: ny }
}

function fireBullet() {
  if (!player || !player.alive) return
  if (!running || paused) return
  if (bullets.length > 3) return // 屏幕上最多 3 发
  if (player.body.length <= 1) {
    setText($status, "身体只有 1 节啦，不能发炮弹（会把自己吃没）！")
    return
  }
  // 发射前先少一节
  player.body.pop()
  const h = player.body[0]
  const d = player.dir
  const b = { x: h.x + d.x, y: h.y + d.y, dx: d.x, dy: d.y, alive: true }
  if (inBounds(b)) bullets.push(b)
  setText($status, "砰！发射炮弹（身体 -1）")
}

function startTailSwing() {
  if (!player || !player.alive) return
  if (!running || paused) return
  if (tailSwing.ticks > 0 || tailSwing.cd > 0) return
  // 至少 2 节才能知道“尾巴方向”
  if (player.body.length < 2) {
    setText($status, "至少要有 2 节身体才能甩尾哦～")
    return
  }
  tailSwing.ticks = 3
  tailSwing.cd = 10 // 约 10 帧冷却
  setText($status, "甩尾剑：尾巴开始甩啦！")
}

function tailDir() {
  const n = player.body.length
  if (n < 2) return { x: 0, y: 0 }
  const tail = player.body[n - 1]
  const prev = player.body[n - 2]
  return { x: tail.x - prev.x, y: tail.y - prev.y }
}

function tailAttackCells() {
  // 我们把“甩尾”想象成：尾巴后面形成一个小小扇形扫荡区
  const d = tailDir()
  const tail = player.body[player.body.length - 1]
  // 尾巴后面 1~2 格，加一点左右偏移（像扫一圈）
  const cells = []
  const back1 = { x: tail.x + d.x, y: tail.y + d.y }
  const back2 = { x: tail.x + d.x * 2, y: tail.y + d.y * 2 }
  const sideA = { x: back1.x + d.y, y: back1.y - d.x }
  const sideB = { x: back1.x - d.y, y: back1.y + d.x }
  ;[back1, back2, sideA, sideB].forEach((p) => {
    if (inBounds(p)) cells.push(p)
  })
  return cells
}

function pushSnakeAway(ai, d) {
  // 把 AI 整条蛇往“尾巴方向”推开 1 格（赶走）
  const dx = d.x
  const dy = d.y
  const moved = ai.body.map((p) => ({ x: p.x + dx, y: p.y + dy }))
  if (moved.some((p) => !inBounds(p))) return false
  // 避免推到玩家身上
  const occ = new Set(player.body.map(key))
  if (moved.some((p) => occ.has(key(p)))) return false
  ai.body = moved
  return true
}

function applyTailSwing() {
  if (!tailSwing.ticks) return
  const d = tailDir()
  const cells = tailAttackCells()
  const cellSet = new Set(cells.map(key))

  for (let i = ais.length - 1; i >= 0; i--) {
    const ai = ais[i]
    if (!ai.alive || ai.body.length === 0) continue
    const head = ai.body[0]
    if (cellSet.has(key(head))) {
      // 甩到头：直接死
      ai.alive = false
      ais.splice(i, 1)
      setText($status, "甩尾命中 AI 的头！它直接挂掉啦！")
      continue
    }
    // 甩到身体：赶走（推开）
    const hitBody = ai.body.slice(1).some((p) => cellSet.has(key(p)))
    if (hitBody) {
      const ok = pushSnakeAway(ai, d)
      if (!ok) {
        // 如果推不动，就让它换个方向乱跑（也算赶走）
        ai.dir = { x: randInt(-1, 1), y: randInt(-1, 1) }
        if (Math.abs(ai.dir.x) + Math.abs(ai.dir.y) !== 1) ai.dir = { x: 1, y: 0 }
      }
      setText($status, "甩尾把 AI 赶走了！")
    }
  }

  tailSwing.ticks -= 1
}

function killAiByHead(i, reason) {
  ais[i].alive = false
  ais.splice(i, 1)
  setText($status, reason)
}

function splitAiToFood(i, hitIndex) {
  // 打到身体：尾巴那段变成食物
  const ai = ais[i]
  const tailPart = ai.body.slice(hitIndex)
  const remain = ai.body.slice(0, hitIndex)
  // 尾巴变食物：有多少节就变多少坨
  tailPart.forEach((p) => dropFoodAt(p))
  if (remain.length <= 0) {
    ais.splice(i, 1)
  } else {
    ai.body = remain
  }
  setText($status, `命中 AI 身体！它尾巴变成了 ${tailPart.length} 坨大便！`)
}

function stepBullets() {
  if (!player.alive) return
  for (let bi = bullets.length - 1; bi >= 0; bi--) {
    const b = bullets[bi]
    b.x += b.dx
    b.y += b.dy
    if (!inBounds(b)) {
      bullets.splice(bi, 1)
      continue
    }

    // 撞 AI
    let hit = false
    for (let i = ais.length - 1; i >= 0; i--) {
      const ai = ais[i]
      const head = ai.body[0]
      if (head && head.x === b.x && head.y === b.y) {
        killAiByHead(i, "炮弹命中 AI 的头！秒杀！")
        hit = true
        break
      }
      const k = ai.body.findIndex((p) => p.x === b.x && p.y === b.y)
      if (k >= 1) {
        splitAiToFood(i, k)
        hit = true
        break
      }
    }
    if (hit) bullets.splice(bi, 1)
  }
}

function playerDie(reason) {
  if (!player.alive) return
  player.alive = false
  // 死了以后身体变成食物：有多少节就变多少坨
  const n = player.body.length
  player.body.forEach((p) => dropFoodAt(p))
  setText($status, "啊哦！你挂了～")
  loopStop()
  openModal("你变成了大便…", `你的身体变成了 ${n} 坨大便（好臭但是很有用）\n原因：${reason}`)
}

function stepPlayer() {
  if (!player.alive) return
  player.dir = player.nextDir
  const head = player.body[0]
  const nh = { x: head.x + player.dir.x, y: head.y + player.dir.y }
  if (!inBounds(nh)) return playerDie("撞到墙啦")

  // 撞自己
  if (player.body.some((p) => p.x === nh.x && p.y === nh.y)) return playerDie("咬到自己啦")
  // 撞 AI
  for (const ai of ais) {
    if (ai.body.some((p) => p.x === nh.x && p.y === nh.y)) return playerDie("撞到 AI 蛇啦")
  }

  // 走一步：把头塞到最前面
  player.body.unshift(nh)

  // 吃到食物？
  const fi = foods.findIndex((f) => f.x === nh.x && f.y === nh.y)
  if (fi >= 0) {
    foods.splice(fi, 1)
    spawnFood()
    setText($status, "咔嚓！吃到一坨像素大便，身体 +1！")
  } else {
    // 没吃到：尾巴缩一格（保持长度）
    player.body.pop()
  }

  // 长到 15 节后，AI 开始出现
  if (player.body.length >= 15) aiSpawnEnabled = true
}

function stepAi() {
  if (!player.alive) return
  for (let i = 0; i < ais.length; i++) {
    const ai = ais[i]
    if (!ai.alive) continue
    const head = ai.body[0]
    if (!head) continue

    // AI 目标：离最近的食物更近一点（像在抢屎吃）
    let target = foods[0]
    let bestD = Infinity
    for (const f of foods) {
      const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y)
      if (d < bestD) {
        bestD = d
        target = f
      }
    }

    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ]

    // 小小“贪心”：选一个让自己更接近目标的方向
    dirs.sort((a, b) => {
      const da = Math.abs(target.x - (head.x + a.x)) + Math.abs(target.y - (head.y + a.y))
      const db = Math.abs(target.x - (head.x + b.x)) + Math.abs(target.y - (head.y + b.y))
      return da - db
    })

    let moved = false
    for (const d of dirs) {
      const nh = { x: head.x + d.x, y: head.y + d.y }
      if (!inBounds(nh)) continue

      // 不能撞自己
      if (ai.body.some((p) => p.x === nh.x && p.y === nh.y)) continue
      // 不能撞其他 AI
      let bad = false
      for (let j = 0; j < ais.length; j++) {
        if (j === i) continue
        if (ais[j].body.some((p) => p.x === nh.x && p.y === nh.y)) {
          bad = true
          break
        }
      }
      if (bad) continue
      // 不能直接钻到玩家身体里（碰到玩家算玩家死，所以这里也挡一下，让 AI 看起来更“公平”）
      if (player.body.some((p) => p.x === nh.x && p.y === nh.y)) continue

      // 走！
      ai.body.unshift(nh)
      // 吃食物就变长
      const fi = foods.findIndex((f) => f.x === nh.x && f.y === nh.y)
      if (fi >= 0) {
        foods.splice(fi, 1)
        spawnFood()
      } else {
        ai.body.pop()
      }
      ai.dir = d
      moved = true
      break
    }

    if (!moved) {
      // 实在走不动：说明它被“围住”了（四面都堵死）
      // 规则：被围住的 AI 蛇也会“变成大便”（整条蛇的每一节都变成食物）
      const n = ai.body.length
      for (const p of ai.body) dropFoodAt(p)
      ai.alive = false
      ais.splice(i, 1)
      i -= 1
      setText($status, `AI 被围住啦！它变成了 ${n} 坨大便！`)
    }
  }
}

function spawnAiIfNeed() {
  if (!aiSpawnEnabled) return
  // 每隔一段时间出现一条（直到 5 条）
  aiSpawnTimer += 1
  if (aiSpawnTimer % 18 === 0) {
    spawnAiSnake()
    setText($status, "有新的 AI 蛇出现啦！小心！")
  }
}

function updateHud() {
  setText($len, String(player.body.length))
  setText($ai, String(ais.length))
}

// ===== 渲染 =====
function drawPixelRect(x, y, w, h, c1, c2) {
  // 小小像素渐变：让方块看起来更“立体”
  ctx.fillStyle = c2
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = c1
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4)
}

function drawPoop(px, py) {
  // 像素大便：用几块棕色方块叠起来
  const x = px * CELL
  const y = py * CELL
  drawPixelRect(x + 3, y + 9, CELL - 6, 6, C_POOP, C_POOP2)
  drawPixelRect(x + 5, y + 5, CELL - 10, 6, C_POOP, C_POOP2)
  drawPixelRect(x + 7, y + 2, CELL - 14, 5, C_POOP, C_POOP2)
}

function render() {
  if (!ctx) return
  ctx.clearRect(0, 0, $cv.width, $cv.height)

  // 画格子（像素棋盘）
  ctx.strokeStyle = C_BG_GRID
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

  // 食物
  for (const f of foods) drawPoop(f.x, f.y)

  // 子弹
  for (const b of bullets) {
    const x = b.x * CELL + CELL / 2
    const y = b.y * CELL + CELL / 2
    ctx.fillStyle = C_BULLET
    ctx.beginPath()
    ctx.arc(x, y, CELL * 0.22, 0, Math.PI * 2)
    ctx.fill()
  }

  // AI 蛇
  for (const ai of ais) {
    for (let i = 0; i < ai.body.length; i++) {
      const p = ai.body[i]
      const x = p.x * CELL
      const y = p.y * CELL
      drawPixelRect(x + 1, y + 1, CELL - 2, CELL - 2, i === 0 ? "#fca5a5" : C_AI, i === 0 ? "#ef4444" : C_AI2)
    }
  }

  // 甩尾效果（画个橙色扫荡圈）
  if (tailSwing.ticks > 0) {
    const cells = tailAttackCells()
    ctx.fillStyle = C_TAIL_SWING
    for (const p of cells) ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2)
  }

  // 玩家蛇
  for (let i = 0; i < player.body.length; i++) {
    const p = player.body[i]
    const x = p.x * CELL
    const y = p.y * CELL
    drawPixelRect(x + 1, y + 1, CELL - 2, CELL - 2, i === 0 ? "#93c5fd" : C_PLAYER, i === 0 ? C_PLAYER : C_PLAYER2)
    if (i === 0) {
      // 画两个小眼睛（更可爱）
      ctx.fillStyle = "rgba(15,23,42,0.85)"
      ctx.fillRect(x + 5, y + 6, 3, 3)
      ctx.fillRect(x + CELL - 8, y + 6, 3, 3)
    }
  }

  updateHud()
}

// ===== 主循环 =====
let tickCount = 0
function tick() {
  if (!player.alive) return
  tickCount += 1

  if (tailSwing.cd > 0) tailSwing.cd -= 1
  if (tailSwing.ticks > 0) applyTailSwing()

  // 玩家每一帧走一步
  stepPlayer()
  if (!player.alive) return render()

  // AI 每两帧走一步（让玩家有点优势）
  if (tickCount % 2 === 0) stepAi()

  spawnAiIfNeed()

  render()
}

function loopStart() {
  loopStop()
  if (!ctx) return
  // canvas 真实像素尺寸
  $cv.width = COLS * CELL
  $cv.height = ROWS * CELL
  tickCount = 0
  tickTimer = setInterval(tick, TICK_MS)
  bulletTimer = setInterval(stepBullets, BULLET_MS)
  render()
}

function loopStop() {
  if (tickTimer) clearInterval(tickTimer)
  if (bulletTimer) clearInterval(bulletTimer)
  tickTimer = null
  bulletTimer = null
}

function startOrPause() {
  if (!player) return
  if (!player.alive) {
    // 死了就先重开一局再开始
    resetGame()
  }
  if (!running) {
    running = true
    paused = false
    if ($start) $start.textContent = "暂停"
    setText($status, "开始啦：按按钮或键盘方向键移动！")
    loopStart()
    return
  }
  // running=true：切换暂停/继续
  paused = !paused
  if (paused) {
    if ($start) $start.textContent = "开始"
    setText($status, "已暂停：点「开始」继续")
    loopStop()
  } else {
    if ($start) $start.textContent = "暂停"
    setText($status, "继续！")
    loopStart()
  }
}

// ===== 事件 =====
if ($up) $up.addEventListener("click", () => setDir(0, -1))
if ($down) $down.addEventListener("click", () => setDir(0, 1))
if ($left) $left.addEventListener("click", () => setDir(-1, 0))
if ($right) $right.addEventListener("click", () => setDir(1, 0))
if ($start) $start.addEventListener("click", () => startOrPause())
if ($fire) $fire.addEventListener("click", () => fireBullet())
if ($tail) $tail.addEventListener("click", () => startTailSwing())
if ($restart) $restart.addEventListener("click", () => resetGame())
if ($endBtn) $endBtn.addEventListener("click", () => resetGame())
if ($endModal) {
  $endModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) resetGame()
  })
}

// 键盘也能玩（但主要是按钮）
window.addEventListener("keydown", (e) => {
  // 电脑上也能用键盘控制：
  // - 方向键：移动方向
  // - 空格：发射炮弹
  // - X：甩尾剑
  // - Enter：开始/暂停
  if (e.key === "ArrowUp") setDir(0, -1)
  else if (e.key === "ArrowDown") setDir(0, 1)
  else if (e.key === "ArrowLeft") setDir(-1, 0)
  else if (e.key === "ArrowRight") setDir(1, 0)
  else if (e.key === " " || e.code === "Space") fireBullet()
  else if (e.key.toLowerCase() === "x") startTailSwing()
  else if (e.key === "Enter") startOrPause()
})

resetGame()
