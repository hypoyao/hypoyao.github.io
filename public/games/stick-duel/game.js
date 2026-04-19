"use strict"

// 火柴人对战（人机）
// - 3 种武器：钩子 / 枪 / 锤子
// - 玩家：武器库选择；AI：随机武器（受难度影响）
// - 枪：命中扣 0.5 血
// - 锤子：旋转近战，命中扣 1 血（短时间多次命中有冷却）
// - 钩子：勾住云朵/墙壁，把自己拉过去（用来躲避）
// - 难度 Lv1~10：AI 准度、反应、攻击频率

const $cv = document.getElementById("cv")
const ctx = $cv && $cv.getContext ? $cv.getContext("2d") : null
const $joy = document.getElementById("joy")
const $joyKnob = document.getElementById("joyKnob")

const $armoryBtn = document.getElementById("armoryBtn")
const $startBtn = document.getElementById("startBtn")
const $fireBtn = document.getElementById("fireBtn")
const $resetBtn = document.getElementById("resetBtn")
const $hint = document.getElementById("hintText")

const $hpMe = document.getElementById("hpMe")
const $hpAi = document.getElementById("hpAi")
const $hpMeText = document.getElementById("hpMeText")
const $hpAiText = document.getElementById("hpAiText")
const $winProb = document.getElementById("winProbVal")
const $lvlNum = document.getElementById("lvlNum")
const $diffNum = document.getElementById("diffNum")
const $diffVal = document.getElementById("diffVal")

const $hammerThrowBtn = document.getElementById("hammerThrowBtn")

const $armoryModal = document.getElementById("armoryModal")
const $armoryCloseBtn = document.getElementById("armoryCloseBtn")

const $diffModal = document.getElementById("diffModal")
const $diffRange = document.getElementById("diffRange")
const $diffRangeVal = document.getElementById("diffRangeVal")
const $diffCloseBtn = document.getElementById("diffCloseBtn")

const $endModal = document.getElementById("endModal")
const $endTitle = document.getElementById("endTitle")
const $endBody = document.getElementById("endBody")
const $endBtn = document.getElementById("endBtn")

const STORAGE_DIFF = "stick_duel_diff_v1"
const STORAGE_LVL = "stick_duel_level_v1"
const STORAGE_STREAK = "stick_duel_streak_v1"

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n))
}
function setText(el, t) {
  if (el) el.textContent = String(t)
}
function openModal($m) {
  if (!$m) return
  $m.classList.add("isOpen")
  $m.setAttribute("aria-hidden", "false")
}
function closeModal($m) {
  if (!$m) return
  $m.classList.remove("isOpen")
  $m.setAttribute("aria-hidden", "true")
}

// ===== 游戏配置 =====
const W = 1120
const H = 640
const G = {
  gravity: 0.55,
  air: 0.985,
  groundY: 540,
}

const WALLS = [
  { x: 60, y: 270, w: 26, h: 270 },
  { x: W - 86, y: 270, w: 26, h: 270 },
]

// 云朵（可被钩子抓）
const CLOUDS = [
  { x: 210, y: 135, r: 24, vx: 0.45 },
  { x: 548, y: 102, r: 28, vx: -0.35 },
  { x: 887, y: 160, r: 22, vx: 0.30 },
]

// ===== 状态 =====
let difficulty = 5
let gameOver = false
let level = 1
let winStreak = 0
let running = false
let paused = false

let input = {
  left: false,
  right: false,
  up: false,
  down: false,
  aimX: W / 2,
  aimY: H / 2,
}

// 手机摇杆（按住屏幕左下角出现）
let joy = {
  on: false,
  pid: null,
  cx: 0, // joy 盒子里的中心点（像素）
  cy: 0,
  dx: 0,
  dy: 0,
}
let joyLP = { pid: null, timer: 0, moved: false, startX: 0, startY: 0 }

function loadDiff() {
  try {
    const v = Number(localStorage.getItem(STORAGE_DIFF) || 5)
    return clamp(Number.isFinite(v) ? v : 5, 1, 10)
  } catch {
    return 5
  }
}
function saveDiff(v) {
  try {
    localStorage.setItem(STORAGE_DIFF, String(v))
  } catch {}
}

function loadLevel() {
  try {
    const v = Number(localStorage.getItem(STORAGE_LVL) || 1)
    return clamp(Number.isFinite(v) ? v : 1, 1, 99)
  } catch {
    return 1
  }
}
function saveLevel(v) {
  try {
    localStorage.setItem(STORAGE_LVL, String(v))
  } catch {}
}
function loadStreak() {
  try {
    const v = Number(localStorage.getItem(STORAGE_STREAK) || 0)
    return clamp(Number.isFinite(v) ? v : 0, 0, 99)
  } catch {
    return 0
  }
}
function saveStreak(v) {
  try {
    localStorage.setItem(STORAGE_STREAK, String(v))
  } catch {}
}

function cfg(d) {
  // d: 1..10
  const t = (d - 1) / 9 // 0..1
  return {
    aiAimNoise: 0.35 - 0.27 * t, // 越高越准
    aiThinkMs: 520 - 360 * t,
    aiFireCd: 900 - 520 * t,
    aiMoveAggro: 0.35 + 0.45 * t,
    aiWeaponSwapMs: 2600 - 1200 * t,
  }
}

function makeFighter(side) {
  return {
    side,
    x: side === "me" ? 210 : 910,
    y: G.groundY,
    vx: 0,
    vy: 0,
    hp: 5.0,
    weapon: "gun", // hook | gun | hammer
    facing: side === "me" ? 1 : -1,
    hook: { active: false, ax: 0, ay: 0, len: 0, pulling: false },
    hammer: { spinning: false, a: 0, hitCd: 0 },
    gun: { cd: 0 },
    ai: { t0: 0, nextThink: 0, nextSwap: 0 },
  }
}

let me = makeFighter("me")
let ai = makeFighter("ai")

let bullets = [] // {x,y,vx,vy,owner,life}
let specials = { hammerThrowUsed: false }
// AI 枪械每局次数限制（玩家不限制）
let aiGunAmmo = 0

function reset() {
  difficulty = loadDiff()
  setText($diffNum, difficulty)
  if ($diffRange) $diffRange.value = String(difficulty)
  setText($diffRangeVal, difficulty)

  level = loadLevel()
  winStreak = loadStreak()
  setText($lvlNum, level)

  me = makeFighter("me")
  ai = makeFighter("ai")
  ai.weapon = randWeapon()
  aiGunAmmo = Math.round(6 + difficulty * 1.2) // Lv1≈7 发，Lv10≈18 发
  bullets = []
  specials = { hammerThrowUsed: false }
  gameOver = false
  running = false
  paused = false
  updateFireBtn()
  updateHammerThrowBtn()
  updateStartBtn()
  setHint("提示：先点「开始」，再打开武器库选择武器！")
}

function setHint(t) {
  if ($hint) $hint.textContent = t
}

function randWeapon() {
  const w = ["hook", "gun", "hammer"]
  return w[Math.floor(Math.random() * w.length)]
}

function updateFireBtn() {
  if (!$fireBtn) return
  $fireBtn.textContent = me.weapon === "hammer" ? (me.hammer.spinning ? "停止" : "旋转") : "发射"
}

function updateStartBtn() {
  if (!$startBtn) return
  if (!running) $startBtn.textContent = "开始"
  else $startBtn.textContent = paused ? "开始" : "暂停"
  $startBtn.disabled = false
}

function updateHammerThrowBtn() {
  if (!$hammerThrowBtn) return
  const ok = me.weapon === "hammer" && level >= 3
  $hammerThrowBtn.style.display = ok ? "" : "none"
  $hammerThrowBtn.disabled = !ok || specials.hammerThrowUsed || gameOver
  $hammerThrowBtn.textContent = specials.hammerThrowUsed ? "丢锤（已用）" : "丢锤（1次）"
}

// ===== 交互 =====
function openArmory() {
  openModal($armoryModal)
}
function closeArmory() {
  closeModal($armoryModal)
}

function openDiff() {
  if ($diffRange) $diffRange.value = String(difficulty)
  setText($diffRangeVal, difficulty)
  openModal($diffModal)
}
function closeDiff() {
  closeModal($diffModal)
}

function end(winner) {
  gameOver = true
  running = false
  paused = false
  updateStartBtn()
  // 连胜升级：连续赢 AI 3 局，等级 +1（等级不是难度）
  if (winner === "me") {
    winStreak = clamp(winStreak + 1, 0, 99)
    if (winStreak >= 3) {
      winStreak = 0
      level = clamp(level + 1, 1, 99)
      saveLevel(level)
      setText($lvlNum, level)
      setHint(`太强啦！连续赢 3 局，等级提升到 Lv ${level}！`)
    }
    saveStreak(winStreak)
  } else {
    winStreak = 0
    saveStreak(0)
  }
  const title = winner === "me" ? "你赢啦！" : "AI 赢了"
  setText($endTitle, title)
  setText($endBody, `结果：${title}\n你的血：${me.hp.toFixed(1)}\nAI 血：${ai.hp.toFixed(1)}`)
  openModal($endModal)
}

function aimFromPointer(ev) {
  const rect = $cv.getBoundingClientRect()
  const x = ((ev.clientX - rect.left) / rect.width) * W
  const y = ((ev.clientY - rect.top) / rect.height) * H
  input.aimX = clamp(x, 0, W)
  input.aimY = clamp(y, 0, H)
}

function canvasXYFromPointer(ev) {
  const rect = $cv.getBoundingClientRect()
  const x = ((ev.clientX - rect.left) / rect.width) * W
  const y = ((ev.clientY - rect.top) / rect.height) * H
  return { x, y, rect }
}

function joyApply() {
  // deadzone
  const dead = 10
  const dx = joy.dx
  const dy = joy.dy
  input.left = dx < -dead
  input.right = dx > dead
  // 上推跳（只要推上就触发；stepFighter 会在落地时再跳）
  input.up = dy < -24
}

function joyReset() {
  joy.on = false
  joy.pid = null
  joy.dx = 0
  joy.dy = 0
  input.left = false
  input.right = false
  input.up = false
  if ($joyKnob) $joyKnob.style.transform = "translate(0px, 0px)"
  if ($joy) {
    $joy.classList.remove("isOn")
    $joy.setAttribute("aria-hidden", "true")
  }
}

function joyShowAtPointer(ev) {
  if (!$joy || !$joyKnob) return
  const rect = $cv.getBoundingClientRect()
  const px = ev.clientX - rect.left
  const py = ev.clientY - rect.top

  const size = 116
  const left = clamp(px - size / 2, 6, rect.width - size - 6)
  const top = clamp(py - size / 2, 6, rect.height - size - 6)
  $joy.style.left = `${left}px`
  $joy.style.top = `${top}px`

  joy.on = true
  joy.pid = ev.pointerId
  joy.cx = size / 2
  joy.cy = size / 2
  joy.dx = 0
  joy.dy = 0
  $joyKnob.style.transform = "translate(0px, 0px)"
  $joy.classList.add("isOn")
  $joy.setAttribute("aria-hidden", "false")
  joyApply()
}

function joyMove(ev) {
  if (!joy.on || ev.pointerId !== joy.pid || !$joyKnob) return
  const rect = $joy.getBoundingClientRect()
  const px = ev.clientX - rect.left
  const py = ev.clientY - rect.top
  const dx = px - joy.cx
  const dy = py - joy.cy
  const r = 38
  const d = Math.hypot(dx, dy)
  const k = d > r ? r / d : 1
  joy.dx = dx * k
  joy.dy = dy * k
  $joyKnob.style.transform = `translate(${joy.dx}px, ${joy.dy}px)`
  joyApply()
}

// ===== 物理与碰撞 =====
function stepFighter(p) {
  // 移动（为了孩子容易上手：上/下变成跳/下蹲（轻微），也允许键盘 WASD）
  const speed = 0.55
  const accel = speed * 1.4

  if (p.side === "me") {
    if (input.left) {
      p.vx -= accel
      p.facing = -1
    }
    if (input.right) {
      p.vx += accel
      p.facing = 1
    }
    if (input.up && p.y >= G.groundY - 1) {
      p.vy = -13.8
    }
  }

  // 钩子：有锚点时拉过去（像摆荡）
  if (p.hook.active && p.hook.pulling) {
    const dx = p.hook.ax - p.x
    const dy = p.hook.ay - p.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    // 吸附强度
    const pull = 0.55
    p.vx += (dx / dist) * pull
    p.vy += (dy / dist) * pull
    // 缩短绳子（把人拉近）
    p.hook.len = Math.max(40, p.hook.len - 2.6)
    // 到位后结束（避免“钩住了但不动/卡住”）
    if (dist <= 52) {
      p.hook.pulling = false
      p.hook.active = false
    }
  }

  // 重力
  p.vy += G.gravity
  // 空气阻力
  p.vx *= G.air
  p.vy *= 0.995

  // 移动
  p.x += p.vx
  p.y += p.vy

  // 地面
  if (p.y > G.groundY) {
    p.y = G.groundY
    p.vy = 0
  }
  // 边界
  p.x = clamp(p.x, 40, W - 40)

  // 墙壁碰撞（简单 AABB）
  for (const w of WALLS) {
    const px = p.x - 12
    const py = p.y - 52
    const pw = 24
    const ph = 52
    if (px < w.x + w.w && px + pw > w.x && py < w.y + w.h && py + ph > w.y) {
      // 从哪边撞就弹开
      const cx = px + pw / 2
      if (cx < w.x + w.w / 2) p.x = w.x - pw / 2 - 1
      else p.x = w.x + w.w + pw / 2 + 1
      p.vx *= -0.35
      // 被钩子拉进墙里时，直接断钩，避免“卡在墙上”
      if (p.hook.active) {
        p.hook.active = false
        p.hook.pulling = false
      }
    }
  }

  // 锤子旋转冷却
  if (p.hammer.hitCd > 0) p.hammer.hitCd -= 1
  if (p.hammer.spinning) p.hammer.a += 0.22

  // 枪冷却
  if (p.gun.cd > 0) p.gun.cd -= 1
}

function hitStick(target, dmg) {
  target.hp = Math.max(0, target.hp - dmg)
  if (target.hp <= 0 && !gameOver) end(target.side === "me" ? "ai" : "me")
}

function stepBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i]
    b.x += b.vx
    b.y += b.vy
    b.life -= 1
    if (b.life <= 0 || b.x < -40 || b.x > W + 40 || b.y < -40 || b.y > H + 40) {
      bullets.splice(i, 1)
      continue
    }

    // 撞墙
    let hitWall = false
    for (const w of WALLS) {
      if (b.x >= w.x && b.x <= w.x + w.w && b.y >= w.y && b.y <= w.y + w.h) {
        hitWall = true
        break
      }
    }
    if (hitWall) {
      bullets.splice(i, 1)
      continue
    }

    // 撞人（简化：头部+身体区域）
    const t = b.owner === "me" ? ai : me
    const bx = b.x
    const by = b.y
    const body = { x: t.x - 12, y: t.y - 52, w: 24, h: 52 }
    if (bx >= body.x && bx <= body.x + body.w && by >= body.y && by <= body.y + body.h) {
      const dmg = b.kind === "hammerThrow" ? 2.5 : 0.5
      hitStick(t, dmg)
      // 击退
      t.vx += (b.vx > 0 ? 1 : -1) * (b.kind === "hammerThrow" ? 5.0 : 2.2)
      t.vy -= b.kind === "hammerThrow" ? 3.2 : 1.2
      bullets.splice(i, 1)
    }
  }
}

function hammerHit(attacker, target) {
  if (!attacker.hammer.spinning) return
  if (attacker.hammer.hitCd > 0) return
  // 锤子头在攻击者周围转：半径 42
  const r = 42
  const hx = attacker.x + Math.cos(attacker.hammer.a) * r
  const hy = attacker.y - 32 + Math.sin(attacker.hammer.a) * r
  const body = { x: target.x - 12, y: target.y - 52, w: 24, h: 52 }
  if (hx >= body.x && hx <= body.x + body.w && hy >= body.y && hy <= body.y + body.h) {
    attacker.hammer.hitCd = 18 // 防止一秒内疯狂多段
    hitStick(target, 1.0)
    // 大击退
    target.vx += attacker.facing * 4.0
    target.vy -= 2.8
  }
}

// ===== 钩子 =====
function hookFire(p, aimX, aimY) {
  if (p.hook.active) {
    // 再按一次取消
    p.hook.active = false
    p.hook.pulling = false
    return
  }
  // 更正：勾爪模式下，“点到哪里就勾到哪里”（不再限制只能勾云朵/墙）
  // 为避免把自己拉进地下，y 做一点限制（仍然是自由勾点）
  const sx = p.x
  const sy = p.y - 30
  const tx = clamp(aimX, 10, W - 10)
  const ty = clamp(aimY, 10, G.groundY - 50)
  const dist = Math.max(1, Math.hypot(tx - sx, ty - sy))
  if (dist < 10) return

  p.hook.active = true
  p.hook.ax = tx
  p.hook.ay = ty
  // 关键：len 不能比当前距离更大，否则会“立刻判定到位”导致看起来没发射
  p.hook.len = dist
  p.hook.pulling = true
}

// ===== 枪 =====
function gunFire(p, aimX, aimY, spread) {
  if (p.gun.cd > 0) return
  p.gun.cd = 22

  const sx = p.x
  const sy = p.y - 34
  let dx = aimX - sx
  let dy = aimY - sy
  const len = Math.max(1, Math.hypot(dx, dy))
  dx /= len
  dy /= len

  // 散布
  const a = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * spread
  const sp = 12.5
  bullets.push({ x: sx, y: sy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, owner: p.side, life: 90 })
}

// ===== AI =====
function aiThink() {
  const c = cfg(difficulty)
  const t = Date.now()
  if (!ai.ai.t0) {
    ai.ai.t0 = t
    ai.ai.nextThink = t + c.aiThinkMs
    ai.ai.nextSwap = t + c.aiWeaponSwapMs
  }
  if (t >= ai.ai.nextSwap) {
    ai.weapon = randWeapon()
    // AI 不能同时用两种武器：切换武器时，清掉其它武器状态
    ai.hook.active = false
    ai.hook.pulling = false
    ai.hammer.spinning = false
    ai.ai.nextSwap = t + c.aiWeaponSwapMs * (0.8 + Math.random() * 0.6)
  }

  // 再保险：只要当前不是对应武器，就强制关闭其效果（避免“上一把武器残留”）
  if (ai.weapon !== "hook") {
    ai.hook.active = false
    ai.hook.pulling = false
  }
  if (ai.weapon !== "hammer") {
    ai.hammer.spinning = false
  }
  // 枪的射击不需要额外“持续状态”，但仍避免与其它状态并存
  if (ai.weapon === "gun") {
    ai.hook.active = false
    ai.hook.pulling = false
    ai.hammer.spinning = false
  }
  if (t < ai.ai.nextThink) return
  ai.ai.nextThink = t + c.aiThinkMs * (0.75 + Math.random() * 0.6)


  // 简单策略：
  // - 枪：保持距离射击
  // - 锤子：靠近旋转
  // - 钩子：随机勾云/墙做位移
  const dist = Math.abs(me.x - ai.x)
  const wantClose = ai.weapon === "hammer"
  const wantFar = ai.weapon === "gun"

  // 移动：靠近或拉开
  const ag = c.aiMoveAggro
  if (wantClose) {
    if (dist > 120) ai.vx += (me.x < ai.x ? -1 : 1) * 1.4 * ag
  } else if (wantFar) {
    if (dist < 220) ai.vx += (me.x < ai.x ? 1 : -1) * 1.2 * ag
  } else {
    // 钩子：小幅游走
    if (Math.random() < 0.5) ai.vx += (Math.random() < 0.5 ? -1 : 1) * 0.9 * ag
  }

  // 攻击
  if (ai.weapon === "gun") {
    // 预测一点点（难度越高越准）
    const noise = c.aiAimNoise
    const ax = me.x + me.vx * 6 + (Math.random() * 2 - 1) * 120 * noise
    const ay = me.y - 36 + (Math.random() * 2 - 1) * 80 * noise
    if (aiGunAmmo > 0 && t >= (ai._nextFire || 0)) {
      gunFire(ai, ax, ay, 0.14 + 0.22 * noise)
      aiGunAmmo -= 1
      ai._nextFire = t + c.aiFireCd * (0.75 + Math.random() * 0.6)
    }
  } else if (ai.weapon === "hammer") {
    if (dist < 160) ai.hammer.spinning = true
    else ai.hammer.spinning = false
  } else if (ai.weapon === "hook") {
    if (Math.random() < 0.55) {
      // 选一个云朵
      const c0 = CLOUDS[Math.floor(Math.random() * CLOUDS.length)]
      hookFire(ai, c0.x, c0.y)
    }
  }
}

// ===== 胜率（粗略）=====
function calcWinProb() {
  const hpDiff = me.hp - ai.hp // 正：我优势
  const score = hpDiff * 1.2 + (me.weapon === "gun" ? 0.15 : 0) - (ai.weapon === "gun" ? 0.15 : 0)
  const p = 1 / (1 + Math.exp(-score))
  return clamp(Math.round(p * 100), 1, 99)
}

function renderHud() {
  const mePct = clamp((me.hp / 5) * 100, 0, 100)
  const aiPct = clamp((ai.hp / 5) * 100, 0, 100)
  if ($hpMe) $hpMe.style.width = `${mePct}%`
  if ($hpAi) $hpAi.style.width = `${aiPct}%`
  setText($hpMeText, me.hp.toFixed(1))
  setText($hpAiText, ai.hp.toFixed(1))
  setText($winProb, `${calcWinProb()}%`)
}

// ===== 渲染 =====
function drawStick(p, color) {
  const x = p.x
  const y = p.y
  ctx.strokeStyle = color
  ctx.lineWidth = 5
  ctx.lineCap = "round"

  // 身体
  ctx.beginPath()
  ctx.moveTo(x, y - 44)
  ctx.lineTo(x, y - 16)
  ctx.stroke()

  // 头
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(x, y - 56, 10, 0, Math.PI * 2)
  ctx.stroke()

  // 手脚
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(x, y - 36)
  ctx.lineTo(x - 16, y - 26)
  ctx.moveTo(x, y - 36)
  ctx.lineTo(x + 16, y - 26)
  ctx.moveTo(x, y - 16)
  ctx.lineTo(x - 14, y)
  ctx.moveTo(x, y - 16)
  ctx.lineTo(x + 14, y)
  ctx.stroke()

  // 武器提示
  ctx.fillStyle = "rgba(15,23,42,0.6)"
  ctx.font = "900 12px ui-sans-serif, system-ui"
  ctx.fillText(p.weapon === "hook" ? "钩" : p.weapon === "gun" ? "枪" : "锤", x - 7, y - 74)
}

function drawArena() {
  // 地面
  ctx.fillStyle = "rgba(148,163,184,0.22)"
  ctx.fillRect(0, G.groundY + 2, W, H - G.groundY)
  // 砖墙
  ctx.fillStyle = "rgba(15,23,42,0.20)"
  for (const w of WALLS) ctx.fillRect(w.x, w.y, w.w, w.h)
}

function drawClouds() {
  for (const c of CLOUDS) {
    ctx.fillStyle = "rgba(255,255,255,0.85)"
    ctx.beginPath()
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "rgba(255,255,255,0.55)"
    ctx.beginPath()
    ctx.arc(c.x - c.r * 0.7, c.y + 4, c.r * 0.8, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawHook(p, color) {
  if (!p.hook.active) return
  const sx = p.x
  const sy = p.y - 30
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.lineTo(p.hook.ax, p.hook.ay)
  ctx.stroke()
  // 钩子头
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(p.hook.ax, p.hook.ay, 5, 0, Math.PI * 2)
  ctx.fill()
}

function drawHammer(p, color) {
  if (!p.hammer.spinning) return
  const r = 42
  const hx = p.x + Math.cos(p.hammer.a) * r
  const hy = p.y - 32 + Math.sin(p.hammer.a) * r
  ctx.strokeStyle = color
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.moveTo(p.x, p.y - 32)
  ctx.lineTo(hx, hy)
  ctx.stroke()
  ctx.fillStyle = color
  ctx.fillRect(hx - 8, hy - 8, 16, 16)
}

function drawBullets() {
  for (const b of bullets) {
    if (b.kind === "hammerThrow") {
      // 旋转锤子
      const a = b.spinA || 0
      const r = 10
      ctx.strokeStyle = "rgba(37,99,235,0.95)"
      ctx.lineWidth = 4
      ctx.beginPath()
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r)
      ctx.stroke()
      ctx.fillStyle = "rgba(37,99,235,0.95)"
      ctx.fillRect(b.x - 8, b.y - 8, 16, 16)
    } else {
      ctx.fillStyle = "rgba(15,23,42,0.85)"
      ctx.beginPath()
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function render() {
  if (!ctx) return
  ctx.clearRect(0, 0, W, H)
  drawArena()
  drawClouds()
  drawBullets()
  drawHook(me, "rgba(37,99,235,0.9)")
  drawHook(ai, "rgba(239,68,68,0.9)")
  drawHammer(me, "rgba(37,99,235,0.9)")
  drawHammer(ai, "rgba(239,68,68,0.9)")
  drawStick(me, "rgba(37,99,235,0.95)")
  drawStick(ai, "rgba(239,68,68,0.95)")
  renderHud()
}

// ===== 主循环 =====
function stepClouds() {
  for (const c of CLOUDS) {
    c.x += c.vx
    if (c.x < 120) c.vx = Math.abs(c.vx)
    if (c.x > W - 120) c.vx = -Math.abs(c.vx)
  }
}

function step() {
  if (!running || paused) return render()
  if (gameOver) return render()

  stepClouds()
  aiThink()

  stepFighter(me)
  stepFighter(ai)

  // 丢锤：追踪 AI（每帧轻微纠正方向）
  for (const b of bullets) {
    if (b.kind !== "hammerThrow") continue
    b.spinA = (b.spinA || 0) + 0.35
    const tx = ai.x
    const ty = ai.y - 32
    const dx = tx - b.x
    const dy = ty - b.y
    const dist = Math.max(1, Math.hypot(dx, dy))
    const sp = 11.5
    // 逐步靠近目标方向（更像锁定）
    const vx = (dx / dist) * sp
    const vy = (dy / dist) * sp
    b.vx = b.vx * 0.78 + vx * 0.22
    b.vy = b.vy * 0.78 + vy * 0.22
  }
  stepBullets()

  // 锤子命中检测
  hammerHit(me, ai)
  hammerHit(ai, me)

  // AI 面向玩家
  ai.facing = me.x < ai.x ? -1 : 1

  render()
}

let timer = null
function startLoop() {
  if (timer) clearInterval(timer)
  timer = setInterval(step, 16)
}

// ===== 武器操作（玩家）=====
function playerFire() {
  if (gameOver || !running || paused) return
  if (me.weapon === "hook") {
    hookFire(me, input.aimX, input.aimY)
    setHint(me.hook.active ? "钩子：已勾住，正在拉你过去！" : "钩子：已取消。")
    return updateFireBtn()
  }
  if (me.weapon === "gun") {
    // 枪：自动对准 AI（玩家更爽；AI 有次数限制）
    gunFire(me, ai.x, ai.y - 36, 0.03)
    setHint("砰！自动瞄准 AI 发射子弹（命中扣 0.5 血）")
    return
  }
  if (me.weapon === "hammer") {
    me.hammer.spinning = !me.hammer.spinning
    setHint(me.hammer.spinning ? "锤子：开始旋转！靠近 AI 才能打到。" : "锤子：停止旋转。")
    return updateFireBtn()
  }
}

function playerThrowHammer() {
  if (gameOver || !running || paused) return
  if (me.weapon !== "hammer") return
  if (level < 3) return
  if (specials.hammerThrowUsed) return
  specials.hammerThrowUsed = true
  updateHammerThrowBtn()
  setHint("丢锤！锤子会在空中旋转并锁定 AI（本局仅一次）")
  // 从玩家手边发射
  const sx = me.x + me.facing * 16
  const sy = me.y - 38
  bullets.push({ x: sx, y: sy, vx: me.facing * 10, vy: -2, owner: "me", life: 120, kind: "hammerThrow", spinA: 0 })
}

function toggleStart() {
  if (gameOver) {
    // 结束后点开始=新开一局
    reset()
  }
  if (!running) {
    running = true
    paused = false
    updateStartBtn()
    setHint("开始！移动躲避，开打吧～")
    return
  }
  paused = !paused
  updateStartBtn()
  setHint(paused ? "已暂停：再点「开始」继续" : "继续！")
}

// ===== 难度彩蛋：点 3 次 =====
let diffTap = 0
let diffTimer = 0
function onDiffTap() {
  diffTap += 1
  if (diffTimer) clearTimeout(diffTimer)
  diffTimer = window.setTimeout(() => {
    diffTap = 0
  }, 800)
  if (diffTap >= 3) {
    diffTap = 0
    openDiff()
  }
}

// ===== 事件绑定 =====
function bind() {
  if ($armoryBtn) $armoryBtn.addEventListener("click", openArmory)
  if ($startBtn) $startBtn.addEventListener("click", toggleStart)
  if ($armoryCloseBtn) $armoryCloseBtn.addEventListener("click", closeArmory)
  if ($fireBtn) $fireBtn.addEventListener("click", playerFire)
  if ($hammerThrowBtn) $hammerThrowBtn.addEventListener("click", playerThrowHammer)
  if ($resetBtn) $resetBtn.addEventListener("click", reset)
  if ($endBtn) $endBtn.addEventListener("click", () => {
    closeModal($endModal)
    reset()
  })

  if ($armoryModal) {
    $armoryModal.addEventListener("click", (e) => {
      if (e.target?.dataset?.close) closeArmory()
      const w = e.target?.closest?.(".armoryItem")?.dataset?.weapon
      if (w === "hook" || w === "gun" || w === "hammer") {
        me.weapon = w
        updateFireBtn()
        updateHammerThrowBtn()
        setHint(`已选择武器：${w === "hook" ? "钩子" : w === "gun" ? "枪" : "锤子"}。`)
        closeArmory()
      }
    })
  }

  if ($diffVal) $diffVal.addEventListener("click", onDiffTap)
  if ($diffRange) {
    $diffRange.addEventListener("input", () => {
      const v = clamp(Number($diffRange.value || 5), 1, 10)
      setText($diffRangeVal, v)
      setText($diffNum, v)
    })
  }
  if ($diffCloseBtn) {
    $diffCloseBtn.addEventListener("click", () => {
      const v = clamp(Number($diffRange.value || difficulty), 1, 10)
      difficulty = v
      saveDiff(v)
      setText($diffNum, v)
      closeDiff()
      setHint(`难度已设置为 Lv ${v}`)
    })
  }
  if ($diffModal) {
    $diffModal.addEventListener("click", (e) => {
      if (e.target?.dataset?.close) closeDiff()
    })
  }

  // canvas 瞄准
  if ($cv) {
    $cv.width = W
    $cv.height = H
    $cv.addEventListener("pointermove", aimFromPointer, { passive: true })
    $cv.addEventListener(
      "pointerdown",
      (ev) => {
        // 规则：
        // - 短按：正常点击（钩子=点哪钩哪）
        // - 长按：在手指位置出现摇杆（左右移动/上推跳）
        if (ev.pointerType !== "mouse") {
          joyLP.pid = ev.pointerId
          joyLP.moved = false
          joyLP.startX = ev.clientX
          joyLP.startY = ev.clientY
          if (joyLP.timer) clearTimeout(joyLP.timer)
          joyLP.timer = window.setTimeout(() => {
            // 长按触发摇杆
            joyShowAtPointer(ev)
            try {
              $cv.setPointerCapture(ev.pointerId)
            } catch {}
          }, 220)
          ev.preventDefault?.()
        }
        aimFromPointer(ev)
      },
      { passive: false }
    )

    // 长按期间移动太多 -> 取消长按（避免想点钩子却弹摇杆）
    $cv.addEventListener(
      "pointermove",
      (ev) => {
        if (joy.on) {
          joyMove(ev)
          return
        }
        if (joyLP.pid !== ev.pointerId || !joyLP.timer) return
        const dx = ev.clientX - joyLP.startX
        const dy = ev.clientY - joyLP.startY
        if (Math.hypot(dx, dy) > 12) {
          joyLP.moved = true
          clearTimeout(joyLP.timer)
          joyLP.timer = 0
        }
      },
      { passive: true }
    )

    $cv.addEventListener(
      "pointerup",
      (ev) => {
        // 结束摇杆
        if (joy.on && ev.pointerId === joy.pid) {
          joyReset()
        }
        // 处理短按（没有进入摇杆）
        const wasLongPress = joyLP.pid === ev.pointerId && joyLP.timer === 0 && !joyLP.moved && joy.on
        if (joyLP.pid === ev.pointerId) {
          if (joyLP.timer) clearTimeout(joyLP.timer)
          const cancelled = joyLP.moved
          joyLP.timer = 0
          joyLP.pid = null
          joyLP.moved = false
          if (!cancelled && !joy.on && ev.pointerType !== "mouse") {
            aimFromPointer(ev)
            if (me.weapon === "hook" && !gameOver && running && !paused) {
              hookFire(me, input.aimX, input.aimY)
              setHint(me.hook.active ? "钩子：已勾住，正在拉你过去！" : "钩子：已取消。")
              updateFireBtn()
            }
          }
        }
        void wasLongPress
      },
      { passive: true }
    )
    $cv.addEventListener(
      "pointercancel",
      (ev) => {
        if (joyLP.pid === ev.pointerId && joyLP.timer) {
          clearTimeout(joyLP.timer)
          joyLP.timer = 0
          joyLP.pid = null
          joyLP.moved = false
        }
        if (joy.on && ev.pointerId === joy.pid) joyReset()
      },
      { passive: true }
    )
  }

  // 键盘
  window.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") input.left = true
    if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") input.right = true
    if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") input.up = true
    if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") input.down = true
    if (e.key === " " || e.code === "Space") playerFire()
    if (e.key.toLowerCase() === "q") openArmory()
    if (e.key === "Enter") toggleStart()
  })
  window.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") input.left = false
    if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") input.right = false
    if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") input.up = false
    if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") input.down = false
    if (e.key.toLowerCase() === "w") input.up = false
  })
}

reset()
bind()
startLoop()
