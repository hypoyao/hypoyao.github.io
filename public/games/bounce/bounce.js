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
const $levelTap = document.getElementById("levelTap")
const $lifeTap = document.getElementById("lifeTap")

const $leftBtn = document.getElementById("leftBtn")
const $rightBtn = document.getElementById("rightBtn")
const $restartBtn = document.getElementById("restartBtn")
const $fireBtn = document.getElementById("fireBtn")
const $controls2 = $fireBtn ? $fireBtn.parentElement : null

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
let bursts = [] // {x,y,t0,dirY,parts:[{x,y,vx,vy,r,life,color}]}
let tapLevelCount = 0
let tapLifeCount = 0
let tapTimer = 0
let $cheatModal = null
let cheatType = "" // "level" | "life"

// audio
let audioCtx = null
function playBoom() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = audioCtx
    if (ctx.state === "suspended") ctx.resume().catch(() => {})

    const t0 = ctx.currentTime
    const out = ctx.createGain()
    out.gain.setValueAtTime(0.0001, t0)
    out.gain.exponentialRampToValueAtTime(0.55, t0 + 0.01)
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18)
    out.connect(ctx.destination)

    // low thump
    const osc = ctx.createOscillator()
    osc.type = "triangle"
    osc.frequency.setValueAtTime(120, t0)
    osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.16)
    osc.connect(out)
    osc.start(t0)
    osc.stop(t0 + 0.2)

    // short noise burst
    const bufLen = Math.floor(ctx.sampleRate * 0.12)
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < bufLen; i++) {
      const k = 1 - i / bufLen
      data[i] = (Math.random() * 2 - 1) * k
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.0001, t0)
    ng.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01)
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12)
    const hp = ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.setValueAtTime(320, t0)
    noise.connect(hp)
    hp.connect(ng)
    ng.connect(out)
    noise.start(t0)
    noise.stop(t0 + 0.13)
  } catch {}
}

function playDing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = audioCtx
    if (ctx.state === "suspended") ctx.resume().catch(() => {})

    const t0 = ctx.currentTime
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.005)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12)
    g.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = "sine"
    osc.frequency.setValueAtTime(1560, t0)
    osc.frequency.exponentialRampToValueAtTime(980, t0 + 0.11)
    osc.connect(g)
    osc.start(t0)
    osc.stop(t0 + 0.13)
  } catch {}
}

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
      // 穿透：每次“发射/接到球”后可最多穿透 2 块板
      pierceLeft: 2,
      slot: k,
      // 记录飞行距离：飞得越短“爆破更强”，飞得越长“爆破更弱”
      flightDist: 0,
    })
  }
  dir = 0
  started = false
  setText($status, `点击开始（第 ${level} 难度：${cfg.balls} 球，轮流发射）`)
  updateHud()
  updateFireUi()
}

function resetRoundKeepBalls() {
  // 不补充球：用于“没接到球但还有剩余球”的情况
  const cfg = levelCfg(level)
  paddle = {
    w: 120,
    h: 14,
    x: (W - 120) / 2,
    y: H - 56,
    speed: 420,
  }
  // 全部重新贴回挡板上（轮流发射）
  balls.forEach((b, idx) => {
    b.vx = 0
    b.vy = 0
    b.speed = cfg.speed
    b.stuck = true
    b.pierceLeft = 2
    b.slot = idx
  })
  dir = 0
  started = false
  updateHud()
  updateFireUi()
}

function resetGame() {
  level = 1
  score = 0
  life = 3
  initStars()
  popups = []
  bursts = []
  bricks = makeLevel(level)
  resetRound()
  render()
}

function updateHud() {
  setText($levelText, String(level))
  setText($scoreText, String(score))
  setText($lifeText, String(life))
}

function updateFireUi() {
  const cfg = levelCfg(level)
  const multi = cfg.balls > 1
  const hasStuck = balls.some((b) => b.stuck)
  if ($controls2) $controls2.classList.toggle("isOn", multi)
  if ($fireBtn) $fireBtn.disabled = !multi || !hasStuck
}

function addPopup(x, y, text) {
  popups.push({ x, y, t0: nowMs || performance.now(), text: text || "+1" })
  // 控制数量避免堆积
  if (popups.length > 16) popups = popups.slice(popups.length - 16)
}

function addBurst(x, y, dirY) {
  const t0 = nowMs || performance.now()
  const parts = []
  const n = 14
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.35
    const sp = 220 + Math.random() * 220
    parts.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp + (dirY > 0 ? 40 : -40),
      r: 2 + Math.random() * 3,
      life: 220 + Math.random() * 160,
      color: Math.random() < 0.5 ? "rgba(255,80,60,1)" : "rgba(255,210,120,1)",
    })
  }
  bursts.push({ x, y, t0, dirY: dirY || 1, parts })
  if (bursts.length > 10) bursts = bursts.slice(bursts.length - 10)
}

function fireNextBall() {
  if (!balls.length || !paddle) return false
  const b = balls.find((x) => x.stuck)
  if (!b) return false
  const angle = (-Math.PI / 2) + (Math.random() * 0.55 - 0.275)
  b.vx = Math.cos(angle) * b.speed
  b.vy = Math.sin(angle) * b.speed
  b.stuck = false
  b.pierceLeft = 2
  b.flightDist = 0
  started = true
  setText($status, "进行中：左右移动挡板")
  updateFireUi()
  return true
}

function startBallIfNeeded() {
  // 开始/继续发射：发射下一颗“贴在挡板上”的球（允许与已在飞行的球并存）
  return fireNextBall()
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
      const cfg = levelCfg(level)
      const off = (ball.slot - (cfg.balls - 1) / 2) * 18
      ball.x = clamp(paddle.x + paddle.w / 2 + off, 12 + ball.r, W - 12 - ball.r)
      ball.y = paddle.y - ball.r - 2
      continue
    }

    // move
    const ox = ball.x
    const oy = ball.y
    ball.x += ball.vx * dt
    ball.y += ball.vy * dt
    // 累计飞行距离
    ball.flightDist += Math.hypot(ball.x - ox, ball.y - oy)

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

      // “砰”一下：声音 + 爆炸感粒子（不会真的爆炸）
      playBoom()
      addBurst(ball.x, ball.y + 10, 1)

      // 每次接到球后，重置穿透次数
      ball.pierceLeft = 2
      ball.flightDist = 0
    }

    // bricks
    for (const b of bricks) {
      if (b.hp <= 0) continue
      if (!rectHitCircle(b.x, b.y, b.w, b.h, ball.x, ball.y, ball.r)) continue
      // 计算“爆破数量”：飞得越短越多；飞得越长越少
      // 说明：distance 基于从上次接到球/发射到现在的累计飞行距离（像素）
      const d = ball.flightDist || 0
      let smash = 1
      if (d < 260) smash = 3
      else if (d < 520) smash = 2
      else smash = 1

      // 命中这块
      b.hp -= 1
      score += 1
      updateHud()
      addPopup(W / 2, H * 0.34, "+1")
      playDing()

      // 额外爆破附近方块（同一帧最多 smash-1 块）
      if (smash > 1) {
        const cx = b.x + b.w / 2
        const cy = b.y + b.h / 2
        const cand = bricks
          .filter((x) => x !== b && x.hp > 0)
          .map((x) => ({ x, d: Math.hypot(x.x + x.w / 2 - cx, x.y + x.h / 2 - cy) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, smash - 1)
        for (const it of cand) {
          it.x.hp -= 1
          score += 1
        }
        if (cand.length) {
          updateHud()
          addPopup(W / 2, H * 0.34, `+${cand.length}`)
        }
      }

      // 穿透：最多连穿 2 块板（不改变方向）
      if (ball.pierceLeft > 0) {
        ball.pierceLeft -= 1
        // 连穿时也给一点微扰动，避免轨迹过于重复
        jitterBounce(ball, 0.06)
        // 继续扫描，可能同一帧穿到下一块（但总次数由 pierceLeft 限制）
        continue
      } else {
        // 非穿透：正常反弹
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
  }

  // 掉落：多球模式下“掉一个不算失败”，全部掉光才算失败（扣生命）
  const fallen = balls.filter((b) => !b.stuck && b.y - b.r > H + 10)
  if (fallen.length) {
    balls = balls.filter((b) => !( !b.stuck && b.y - b.r > H + 10))
    // 只要没接到球：板复原（按需求）
    bricks = makeLevel(level)
    popups = []
    bursts = []
    updateFireUi()

    if (balls.length === 0) {
      // 所有球都掉下去才算失败
      loseLife()
      return
    }

    // 如果当前没有在飞行的球（剩下的都贴在挡板上），提示继续发射
    if (balls.every((b) => b.stuck)) {
      started = false
      setText($status, `没接到球：板已复原。还剩 ${balls.length} 球，可继续发射`)
    } else {
      setText($status, `没接到球：板已复原。剩余球继续进行中`)
    }
  }

  // win check
  if (bricks.every((b) => b.hp <= 0)) nextLevel()

  // update bursts
  if (bursts.length) {
    const ms = dt * 1000
    for (const bu of bursts) {
      for (const p of bu.parts) {
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vx *= 0.985
        p.vy = p.vy * 0.985 + 260 * dt
        p.life -= ms
      }
      bu.parts = bu.parts.filter((p) => p.life > 0)
    }
    bursts = bursts.filter((b) => b.parts.length > 0 && (nowMs - b.t0) < 650)
  }
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

  // burst effects (explosion feel)
  if (bursts.length) {
    for (const b of bursts) {
      const age = nowMs - b.t0
      const t = clamp(age / 260, 0, 1)
      // expanding ring
      ctx.save()
      ctx.globalAlpha = 0.38 * (1 - t)
      ctx.strokeStyle = "rgba(239,68,68,1)"
      ctx.lineWidth = 3
      ctx.shadowBlur = 18
      ctx.shadowColor = "rgba(239,68,68,0.35)"
      ctx.beginPath()
      ctx.arc(b.x, b.y, 10 + 34 * t, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      // particles
      for (const p of b.parts) {
        const a = clamp(p.life / 380, 0, 1)
        ctx.save()
        ctx.globalAlpha = a
        ctx.fillStyle = p.color
        ctx.shadowBlur = 10
        ctx.shadowColor = "rgba(255,120,60,0.28)"
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }
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
  const prev = dir
  dir = v
  // 多球模式：发射第一个球后，“再移动一下挡板”就发射下一球（每次从 0→非0 触发一次）
  if (v !== 0 && prev === 0 && levelCfg(level).balls > 1) {
    fireNextBall()
  } else {
    // 单球模式：移动即可开始
    if (levelCfg(level).balls === 1) startBallIfNeeded()
  }
}

function bindHold(btn, v) {
  if (!btn) return
  let flashTimer = 0
  const down = (e) => {
    try {
      e.preventDefault()
    } catch {}
    // 点哪个键哪个键闪一下
    btn.classList.add("isFlash")
    if (flashTimer) window.clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => btn.classList.remove("isFlash"), 140)
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
  const k = e.key
  const code = e.keyCode || e.which
  const isLeft = k === "ArrowLeft" || k === "Left" || k === "a" || k === "A" || code === 37
  const isRight = k === "ArrowRight" || k === "Right" || k === "d" || k === "D" || code === 39

  // 避免方向键滚动页面，导致用户感觉“按了没反应”
  if (isLeft || isRight) {
    try {
      e.preventDefault()
    } catch {}
  }

  if (isLeft) {
    if (on) setDir(-1)
    else if (dir === -1) dir = 0
  }
  if (isRight) {
    if (on) setDir(1)
    else if (dir === 1) dir = 0
  }
  if (k === " " || k === "Enter") {
    if (on) startBallIfNeeded()
  }
}

// click stage to start
function onStagePointerDown() {
  try {
    $stage && $stage.focus && $stage.focus()
  } catch {}
  startBallIfNeeded()
}

function tap3(handler) {
  // 简单 3 连点识别（共享计时器）
  if (tapTimer) window.clearTimeout(tapTimer)
  tapTimer = window.setTimeout(() => {
    tapLevelCount = 0
    tapLifeCount = 0
  }, 650)
  handler()
}

function ensureCheatModal() {
  if ($cheatModal) return
  $cheatModal = document.createElement("div")
  $cheatModal.className = "modal"
  $cheatModal.id = "bbCheatModal"
  $cheatModal.setAttribute("aria-hidden", "true")
  $cheatModal.innerHTML = `
    <div class="modalBackdrop" data-close="1"></div>
    <div class="modalPanel" role="dialog" aria-modal="true" aria-label="cheat dialog">
      <div class="modalTitle" id="bbCheatTitle">设置</div>
      <div class="modalBody" id="bbCheatBody" style="font-size:18px">--</div>
      <div class="bbCheatGrid" id="bbCheatGrid"></div>
      <div class="bbCheatTip" id="bbCheatTip"></div>
      <div class="modalActions">
        <button class="btn modalBtn btnGray" id="bbCheatCloseBtn" type="button">关闭</button>
      </div>
    </div>
  `
  document.body.appendChild($cheatModal)
  $cheatModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeCheatModal()
  })
  const closeBtn = $cheatModal.querySelector("#bbCheatCloseBtn")
  if (closeBtn) closeBtn.addEventListener("click", closeCheatModal)
}

function openCheatModal(type) {
  ensureCheatModal()
  cheatType = type
  const $title = $cheatModal.querySelector("#bbCheatTitle")
  const $body = $cheatModal.querySelector("#bbCheatBody")
  const $grid = $cheatModal.querySelector("#bbCheatGrid")
  const $tip = $cheatModal.querySelector("#bbCheatTip")
  if (!$grid) return
  $grid.innerHTML = ""
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "btn btnSecondary"
    btn.textContent = String(i)
    btn.dataset.val = String(i)
    if ((type === "level" && i === level) || (type === "life" && i === life)) {
      btn.className = "btn"
    }
    btn.addEventListener("click", () => {
      const v = Number(btn.dataset.val || 0)
      if (!Number.isFinite(v) || v < 1 || v > 5) return
      if (type === "level") {
        level = v
        balls = []
        bricks = makeLevel(level)
        resetRound()
        render()
        setText($status, `已切换到第 ${level} 难度（点击开始发射）`)
      } else {
        life = v
        updateHud()
        render()
        setText($status, `已设置生命为 ${life}`)
      }
      closeCheatModal()
    })
    $grid.appendChild(btn)
  }
  if ($title) $title.textContent = type === "level" ? "手动升级关卡" : "手动设置生命"
  if ($body) $body.textContent = type === "level" ? `当前难度：${level}` : `当前生命：${life}`
  if ($tip) $tip.textContent = type === "level" ? "选择 1-5 难度。切换后会重置本关。" : "选择 1-5 生命值（最高 5）。"

  $cheatModal.classList.add("isOpen")
  $cheatModal.setAttribute("aria-hidden", "false")
}

function closeCheatModal() {
  if (!$cheatModal) return
  $cheatModal.classList.remove("isOpen")
  $cheatModal.setAttribute("aria-hidden", "true")
  cheatType = ""
}

// events
bindHold($leftBtn, -1)
bindHold($rightBtn, 1)
if ($fireBtn) $fireBtn.addEventListener("click", () => startBallIfNeeded())
if ($restartBtn) {
  $restartBtn.addEventListener("click", () => {
    resetGame()
    startLoop()
  })
}
if ($stage) $stage.addEventListener("pointerdown", onStagePointerDown)

if ($levelTap) {
  const hit = (e) => {
    try {
      e.preventDefault()
    } catch {}
    tap3(() => {
      tapLevelCount += 1
      if (tapLevelCount >= 3) {
        tapLevelCount = 0
        tapLifeCount = 0
        openCheatModal("level")
      }
    })
  }
  // 用 pointerdown 更可靠（click 在某些设备/双击缩放情况下不稳定）
  $levelTap.addEventListener("pointerdown", hit, { passive: false })
  $levelTap.addEventListener("click", hit)
}
if ($lifeTap) {
  const hit = (e) => {
    try {
      e.preventDefault()
    } catch {}
    tap3(() => {
      tapLifeCount += 1
      if (tapLifeCount >= 3) {
        tapLifeCount = 0
        tapLevelCount = 0
        openCheatModal("life")
      }
    })
  }
  $lifeTap.addEventListener("pointerdown", hit, { passive: false })
  $lifeTap.addEventListener("click", hit)
}

// 监听键盘：同时监听 document+window，并用 capture 提高命中率
document.addEventListener("keydown", (e) => onKey(e, true), { passive: false, capture: true })
document.addEventListener("keyup", (e) => onKey(e, false), { passive: false, capture: true })
window.addEventListener("keydown", (e) => onKey(e, true), { passive: false, capture: true })
window.addEventListener("keyup", (e) => onKey(e, false), { passive: false, capture: true })
window.addEventListener("resize", ensureCanvasSize)

ensureCanvasSize()
resetGame()
startLoop()

// 尝试主动获取焦点，确保方向键可用
try {
  if ($stage && $stage.focus) $stage.focus()
} catch {}
