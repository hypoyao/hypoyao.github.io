"use strict"

// 反弹球历险（breakout 简化版）
// - 左右按钮 / 键盘 ← → 控制挡板
// - 击碎全部方块过关
// - 球落到底部扣一条命

const $canvas = document.getElementById("canvas")
const $stage = document.getElementById("stage")
const $status = document.getElementById("status")
const $levelText = document.getElementById("levelText")
const $scoreText = document.getElementById("scoreText")
const $lifeText = document.getElementById("lifeText")

const $leftBtn = document.getElementById("leftBtn")
const $rightBtn = document.getElementById("rightBtn")
const $restartBtn = document.getElementById("restartBtn")

const W = 540
const H = 720

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}

function setText(el, t) {
  if (el) el.textContent = t
}

let raf = 0
let running = false
let started = false
let nowMs = 0

// input
let dir = 0 // -1 left, +1 right

// game state
let level = 1
let score = 0
let life = 3

let paddle = null
let balls = []
let bricks = []
let stars = []
let popups = [] // {x,y,t0,text}

function levelCfg(lv) {
  // 题目要求的 5 个难度档位
  // 1：1球 慢
  // 2：2球 中等
  // 3：3球 慢
  // 4：3球 中等
  // 5：3球 快
  if (lv <= 1) return { balls: 1, speed: 300 }
  if (lv === 2) return { balls: 2, speed: 380 }
  if (lv === 3) return { balls: 3, speed: 300 }
  if (lv === 4) return { balls: 3, speed: 380 }
  return { balls: 3, speed: 460 }
}

function initStars() {
  // 背景点点星光
  stars = []
  for (let i = 0; i < 80; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.6 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
      sp: 0.6 + Math.random() * 1.2,
    })
  }
}

function makeLevel(lv) {
  // 随等级稍微加速/加密
  const cols = lv <= 2 ? 7 : lv <= 4 ? 8 : 9
  const rows = lv <= 2 ? 4 : lv <= 5 ? 5 : 6
  const padX = 18
  const padY = 22
  const gap = 10
  const top = 80
  const bw = Math.floor((W - padX * 2 - gap * (cols - 1)) / cols)
  const bh = 18
  const res = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      res.push({
        x: padX + c * (bw + gap),
        y: top + r * (bh + gap),
        w: bw,
        h: bh,
        hp: lv >= 6 && r === 0 ? 2 : 1,
      })
    }
  }
  return res
}

function resetRound() {
  const cfg = levelCfg(level)
  paddle = {
    w: 120,
    h: 14,
    x: (W - 120) / 2,
    y: H - 56,
    speed: 420, // px/s
  }
  balls = []
  for (let k = 0; k < cfg.balls; k++) {
    balls.push({
      r: 8,
      x: paddle.x + paddle.w / 2 + (k - (cfg.balls - 1) / 2) * 18,
      y: paddle.y - 16,
      vx: 0,
      vy: 0,
      speed: cfg.speed,
      stuck: true,
    })
  }
  dir = 0
  started = false
  setText($status, `点击开始（第 ${level} 难度：${cfg.balls} 球）`)
  updateHud()
}

function resetGame() {
  level = 1
  score = 0
  life = 3
  initStars()
  popups = []
  bricks = makeLevel(level)
  resetRound()
  render()
}

function updateHud() {
  setText($levelText, String(level))
  setText($scoreText, String(score))
  setText($lifeText, String(life))
}

function addPopup(x, y, text) {
  popups.push({ x, y, t0: nowMs || performance.now(), text: text || "+1" })
  // 控制数量避免堆积
  if (popups.length > 16) popups = popups.slice(popups.length - 16)
}

function startBallIfNeeded() {
  if (!balls.length || !paddle) return
  if (!balls.some((b) => b.stuck)) return
  // 初速度：向上，多个球用不同角度散开
  const stuck = balls.filter((b) => b.stuck)
  const spread = stuck.length <= 1 ? 0 : 0.55
  stuck.forEach((b, idx) => {
    const t = stuck.length <= 1 ? 0 : idx / (stuck.length - 1) // 0..1
    const jitter = Math.random() * 0.14 - 0.07
    const angle = (-Math.PI / 2) + (t - 0.5) * spread + jitter
    b.vx = Math.cos(angle) * b.speed
    b.vy = Math.sin(angle) * b.speed
    b.stuck = false
  })
  started = true
  setText($status, "进行中：左右移动挡板")
}

function loseLife() {
  life -= 1
  updateHud()

  // 只要没接到球（球掉落）：方块立刻复原为满的状态（保留当前难度）
  bricks = makeLevel(level)
  popups = []

  if (life <= 0) {
    resetRound()
    render()
    running = false
    setText($status, "生命用完：方块已复原。点击重新开始")
    return
  }
  setText($status, "没接到球：方块已复原。继续：点击开始")
  resetRound()
}

function nextLevel() {
  if (level >= 5) {
    running = false
    setText($status, "通关！已完成第 5 难度，点击重新开始再来一局")
    return
  }
  level += 1
  bricks = makeLevel(level)
  setText($status, `过关！进入第 ${level} 难度`)
  resetRound()
}

function rectHitCircle(rx, ry, rw, rh, cx, cy, cr) {
  const nx = clamp(cx, rx, rx + rw)
  const ny = clamp(cy, ry, ry + rh)
  const dx = cx - nx
  const dy = cy - ny
  return dx * dx + dy * dy <= cr * cr
}

function rotateVelocity(ball, rad) {
  const cs = Math.cos(rad)
  const sn = Math.sin(rad)
  const vx = ball.vx * cs - ball.vy * sn
  const vy = ball.vx * sn + ball.vy * cs
  // normalize to speed
  const len = Math.hypot(vx, vy) || 1
  ball.vx = (vx / len) * ball.speed
  ball.vy = (vy / len) * ball.speed
}

function jitterBounce(ball, maxRad) {
  const j = (Math.random() * 2 - 1) * maxRad
  rotateVelocity(ball, j)
}

function step(dt) {
  if (!paddle || !balls.length) return

  // paddle move
  paddle.x += dir * paddle.speed * dt
  paddle.x = clamp(paddle.x, 10, W - paddle.w - 10)

  // balls
  for (const ball of balls) {
    // follow paddle before start
    if (ball.stuck) {
      ball.x = clamp(paddle.x + paddle.w / 2, 12 + ball.r, W - 12 - ball.r)
      ball.y = paddle.y - ball.r - 2
      continue
    }

    // move
    ball.x += ball.vx * dt
    ball.y += ball.vy * dt

    // walls
    if (ball.x - ball.r < 8) {
      ball.x = 8 + ball.r
      ball.vx *= -1
    }
    if (ball.x + ball.r > W - 8) {
      ball.x = W - 8 - ball.r
      ball.vx *= -1
    }
    if (ball.y - ball.r < 8) {
      ball.y = 8 + ball.r
      ball.vy *= -1
    }

    // paddle collision (only when moving down)
    if (ball.vy > 0 && rectHitCircle(paddle.x, paddle.y, paddle.w, paddle.h, ball.x, ball.y, ball.r)) {
      const hit = (ball.x - paddle.x) / paddle.w // 0..1
      // 反弹方向加入少量随机扰动（更像“历险”）
      let angle = (-Math.PI / 2) + (hit - 0.5) * 1.15 + (Math.random() * 0.22 - 0.11)
      // 避免过于水平导致无聊或卡边
      angle = clamp(angle, -2.75, -0.40)
      ball.vx = Math.cos(angle) * ball.speed
      ball.vy = Math.sin(angle) * ball.speed
      ball.y = paddle.y - ball.r - 1
    }

    // bricks
    for (const b of bricks) {
      if (b.hp <= 0) continue
      if (!rectHitCircle(b.x, b.y, b.w, b.h, ball.x, ball.y, ball.r)) continue
      b.hp -= 1
      score += 1
      updateHud()
      addPopup(W / 2, H * 0.34, "+1")

      // reflect: choose axis by penetration
      const cx = clamp(ball.x, b.x, b.x + b.w)
      const cy = clamp(ball.y, b.y, b.y + b.h)
      const dx = ball.x - cx
      const dy = ball.y - cy
      if (Math.abs(dx) > Math.abs(dy)) ball.vx *= -1
      else ball.vy *= -1
      // 轻微随机，避免轨迹太“机械”
      jitterBounce(ball, 0.12)
      break
    }
  }

  // remove fallen balls
  balls = balls.filter((b) => !(b.y - b.r > H + 10))
  if (balls.length === 0) {
    loseLife()
    return
  }

  // win check
  if (bricks.every((b) => b.hp <= 0)) nextLevel()
}

function render() {
  if (!$canvas) return
  const ctx = $canvas.getContext("2d")
  if (!ctx) return

  // bg
  ctx.clearRect(0, 0, W, H)
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, "rgba(17,24,39,1)")
  g.addColorStop(0.55, "rgba(30,58,138,0.98)")
  g.addColorStop(1, "rgba(88,28,135,0.98)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  // stars (twinkle)
  ctx.save()
  for (const s of stars) {
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((nowMs / 1000) * s.sp + s.phase))
    ctx.globalAlpha = tw
    ctx.fillStyle = "rgba(255,255,255,0.92)"
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  // frame
  ctx.strokeStyle = "rgba(255,255,255,0.10)"
  ctx.lineWidth = 2
  ctx.strokeRect(8, 8, W - 16, H - 16)

  // bricks
  const tt = nowMs / 1000
  for (const b of bricks) {
    if (b.hp <= 0) continue
    // 彩色闪闪发光
    const hue = (b.x * 0.35 + b.y * 0.55 + level * 18 + tt * 22) % 360
    const glow = 0.55 + 0.45 * Math.sin(tt * 3.2 + (b.x + b.y) * 0.02)
    ctx.save()
    ctx.shadowBlur = 18 + glow * 10
    ctx.shadowColor = `hsla(${hue}, 92%, 70%, ${0.38 + glow * 0.22})`
    ctx.fillStyle = `hsla(${hue}, 92%, ${b.hp >= 2 ? 62 : 56}%, 0.95)`
    roundRect(ctx, b.x, b.y, b.w, b.h, 8)
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.strokeStyle = "rgba(255,255,255,0.10)"
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  // paddle
  const pg = ctx.createLinearGradient(paddle.x, paddle.y, paddle.x + paddle.w, paddle.y)
  pg.addColorStop(0, "rgba(148,163,184,0.90)")
  pg.addColorStop(0.5, "rgba(255,255,255,0.92)")
  pg.addColorStop(1, "rgba(148,163,184,0.90)")
  ctx.fillStyle = pg
  roundRect(ctx, paddle.x, paddle.y, paddle.w, paddle.h, 999)
  ctx.fill()

  // balls
  for (const ball of balls) {
    const rg = ctx.createRadialGradient(ball.x - 3, ball.y - 3, 2, ball.x, ball.y, ball.r + 6)
    rg.addColorStop(0, "rgba(255,255,255,1)")
    rg.addColorStop(1, "rgba(226,232,240,0.92)")
    ctx.fillStyle = rg
    ctx.beginPath()
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = "rgba(255,255,255,0.18)"
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // big "+1" popup
  if (popups.length) {
    const dur = 520
    for (const p of popups) {
      const age = (nowMs || performance.now()) - p.t0
      if (age < 0 || age > dur) continue
      const t = age / dur // 0..1
      const alpha = 1 - t
      const y = p.y - 22 * t
      const scale = 1 + 0.12 * (1 - alpha)
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(p.x, y)
      ctx.scale(scale, scale)
      ctx.font = "900 72px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Microsoft YaHei"
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.shadowBlur = 18
      ctx.shadowColor = "rgba(239,68,68,0.45)"
      ctx.fillStyle = "rgba(239,68,68,0.98)"
      ctx.fillText(p.text || "+1", 0, 0)
      ctx.restore()
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function tick(t) {
  if (!running) return
  nowMs = t
  if (!tick.last) tick.last = t
  const dt = clamp((t - tick.last) / 1000, 0, 0.033)
  tick.last = t

  step(dt)
  // 清理过期 popups
  if (popups.length) {
    const cut = nowMs - 700
    popups = popups.filter((p) => p.t0 >= cut)
  }
  render()
  raf = requestAnimationFrame(tick)
}
tick.last = 0

function ensureCanvasSize() {
  if (!$canvas || !$stage) return
  // canvas 内部逻辑坐标固定（W/H），CSS 缩放即可
  $canvas.width = W
  $canvas.height = H
}

function setDir(v) {
  dir = v
  if (!started) startBallIfNeeded()
}

function bindHold(btn, v) {
  if (!btn) return
  const down = (e) => {
    try {
      e.preventDefault()
    } catch {}
    setDir(v)
  }
  const up = () => {
    if (dir === v) dir = 0
  }
  btn.addEventListener("pointerdown", down, { passive: false })
  btn.addEventListener("pointerup", up)
  btn.addEventListener("pointercancel", up)
  btn.addEventListener("pointerleave", up)
}

function startLoop() {
  if (running) return
  running = true
  tick.last = 0
  raf = requestAnimationFrame(tick)
}

function stopLoop() {
  running = false
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

function onKey(e, on) {
  if (e.key === "ArrowLeft") {
    if (on) setDir(-1)
    else if (dir === -1) dir = 0
  }
  if (e.key === "ArrowRight") {
    if (on) setDir(1)
    else if (dir === 1) dir = 0
  }
  if (e.key === " " || e.key === "Enter") {
    if (on && !started) startBallIfNeeded()
  }
}

// click stage to start
function onStagePointerDown() {
  if (!started) startBallIfNeeded()
}

// events
bindHold($leftBtn, -1)
bindHold($rightBtn, 1)
if ($restartBtn) {
  $restartBtn.addEventListener("click", () => {
    resetGame()
    startLoop()
  })
}
if ($stage) $stage.addEventListener("pointerdown", onStagePointerDown)

window.addEventListener("keydown", (e) => onKey(e, true))
window.addEventListener("keyup", (e) => onKey(e, false))
window.addEventListener("resize", ensureCanvasSize)

ensureCanvasSize()
resetGame()
startLoop()
