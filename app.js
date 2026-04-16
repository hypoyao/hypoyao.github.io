const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

// ========= 玩家ID（fingerprint）+ 战绩统计 =========
// 说明：
// - 用浏览器特征生成指纹 hash 作为“初始 ID”，并持久化到 localStorage，避免指纹轻微变化导致 ID 漂移
// - 战绩按 userId 存在 localStorage，单机多用户（不同浏览器/设备）互不影响

const STORAGE_UID_KEY = "ttt3_uid_v1"
const STORAGE_STATS_KEY = "ttt3_stats_v1"
const STORAGE_VISIT_LOCK_KEY = "ttt3_visit_lock_v1"
const STORAGE_DIFF_KEY = "ttt3_diff_v1"

// 访问统计云函数（请确保云端函数名一致）
const VISIT_FN_NAME = "page_visit_counter"
const CLOUDBASE_ENV_ID = "hypo-7gm1818jbbd6ee3e"

const $winRate = document.getElementById("winRate")
const $winLoss = document.getElementById("winLoss")
const $diffBadge = document.getElementById("diffBadge")
const $tipModal = document.getElementById("tipModal")
const $tipText = document.getElementById("tipText")

let userId = null
let difficulty = 1 // 1~10：不外显，仅彩蛋展示；默认新用户从 1 开始

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function openTipModal(text) {
  if (!$tipModal || !$tipText) return
  $tipText.textContent = text || ""
  $tipModal.classList.add("isOpen")
  $tipModal.setAttribute("aria-hidden", "false")
}

function closeTipModal() {
  if (!$tipModal) return
  $tipModal.classList.remove("isOpen")
  $tipModal.setAttribute("aria-hidden", "true")
}

function getFingerprintSeed() {
  const nav = navigator || {}
  const scr = screen || {}
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || ""
    } catch {
      return ""
    }
  })()

  // 尽量使用稳定且“通用可用”的特征
  // 注：不引入第三方依赖，保持项目轻量
  return {
    ua: nav.userAgent || "",
    lang: nav.language || "",
    langs: Array.isArray(nav.languages) ? nav.languages.join(",") : "",
    platform: nav.platform || "",
    hc: nav.hardwareConcurrency || 0,
    dm: nav.deviceMemory || 0,
    tz,
    dpr: window.devicePixelRatio || 1,
    w: scr.width || 0,
    h: scr.height || 0,
    cd: scr.colorDepth || 0,
    tp: nav.maxTouchPoints || 0,
  }
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function getOrCreateUserId() {
  const cached = localStorage.getItem(STORAGE_UID_KEY)
  if (cached) return cached

  // 用浏览器特征生成（一次性）ID，然后写入 localStorage
  const seed = getFingerprintSeed()
  const raw = JSON.stringify(seed)
  const hex = await sha256Hex(raw)
  const id = `u_${hex.slice(0, 16)}`
  localStorage.setItem(STORAGE_UID_KEY, id)
  return id
}

// ========= 访问统计（纯H5：localStorage user_id + 调云函数自增） =========
let cbApp = null
let cloudbaseScriptLoading = null

function canLoadRemoteScripts() {
  // file:// 下很多第三方脚本会失败（例如不蒜子会拼出 file://busuanzi...）
  return typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:")
}

function loadScriptOnce(url, id) {
  if (typeof document === "undefined") return Promise.reject(new Error("no document"))
  if (id && document.getElementById(id)) return Promise.resolve(true)

  return new Promise((resolve, reject) => {
    const s = document.createElement("script")
    if (id) s.id = id
    s.async = true
    s.src = url
    s.onload = () => resolve(true)
    s.onerror = () => reject(new Error(`加载失败: ${url}`))
    document.head.appendChild(s)
  })
}

async function getCloudbaseApp() {
  if (cbApp) return cbApp
  if (typeof window === "undefined") return null
  if (!canLoadRemoteScripts()) return null

  // 懒加载 CloudBase Web SDK，避免 file:// 或某些预览环境报错
  if (!window.cloudbase) {
    if (!cloudbaseScriptLoading) {
      cloudbaseScriptLoading = loadScriptOnce(
        // 官方文档提供的 CDN 域名：static.cloudbase.net
        // 注：imgcache.qq.com 在部分网络/地区可能出现 404 或访问不稳定
        "https://static.cloudbase.net/cloudbase-js-sdk/2.9.0/cloudbase.full.js",
        "cloudbase-web-sdk"
      ).catch(() => null)
    }
    await cloudbaseScriptLoading
  }
  if (!window.cloudbase) return null

  cbApp = window.cloudbase.init({ env: CLOUDBASE_ENV_ID })

  // 尽量开启匿名登录（如果环境未开启/无需登录，失败也不影响页面）
  try {
    const auth = cbApp.auth({ persistence: "local" })
    // 已登录就不重复 signIn
    if (!auth.hasLoginState?.() && auth.anonymousAuthProvider) {
      await auth.anonymousAuthProvider().signIn()
    }
  } catch {}

  return cbApp
}

function acquireVisitLock(ttlMs = 1500) {
  // 防止同一页面“短时间重复触发”（某些浏览器会重复执行 onload / bfcache 等）
  const now = Date.now()
  const last = Number(localStorage.getItem(STORAGE_VISIT_LOCK_KEY) || 0)
  if (now - last < ttlMs) return false
  localStorage.setItem(STORAGE_VISIT_LOCK_KEY, String(now))
  return true
}

async function recordPageVisit(uid) {
  try {
    if (!uid) return
    if (!acquireVisitLock()) return

    const app = await getCloudbaseApp()
    if (!app) return

    // 每次刷新/打开页面调用一次：同一 user_id 会在 MySQL 里 count + 1
    await app.callFunction({
      name: VISIT_FN_NAME,
      data: { user_id: uid },
    })
  } catch {
    // 统计失败不影响游戏
  }
}

function loadAllStats() {
  return safeJsonParse(localStorage.getItem(STORAGE_STATS_KEY) || "{}", {})
}

function saveAllStats(all) {
  localStorage.setItem(STORAGE_STATS_KEY, JSON.stringify(all))
}

function getUserStats(uid) {
  const all = loadAllStats()
  const s = all?.[uid]
  return {
    wins: Number(s?.wins || 0),
    losses: Number(s?.losses || 0),
  }
}

function setUserStats(uid, stats) {
  const all = loadAllStats()
  all[uid] = { wins: Number(stats.wins || 0), losses: Number(stats.losses || 0) }
  saveAllStats(all)
}

function loadAllDifficulty() {
  return safeJsonParse(localStorage.getItem(STORAGE_DIFF_KEY) || "{}", {})
}

function saveAllDifficulty(all) {
  localStorage.setItem(STORAGE_DIFF_KEY, JSON.stringify(all))
}

function getUserDifficulty(uid) {
  const all = loadAllDifficulty()
  const v = Number(all?.[uid])
  return clamp(Number.isFinite(v) ? v : 1, 1, 10)
}

function setUserDifficulty(uid, level) {
  const all = loadAllDifficulty()
  all[uid] = clamp(Number(level) || 1, 1, 10)
  saveAllDifficulty(all)
}

function updateDifficultyByResult(winner) {
  // 赢 +1，输 -1；范围 1~10
  if (!userId) return
  const cur = getUserDifficulty(userId)
  const next =
    winner === HUMAN ? clamp(cur + 1, 1, 10) : winner === AI ? clamp(cur - 1, 1, 10) : clamp(cur, 1, 10)
  setUserDifficulty(userId, next)
  difficulty = next
  renderDifficultyBadge()
}

function recordGameResult(winner) {
  if (!userId) return
  const s = getUserStats(userId)
  if (winner === HUMAN) s.wins += 1
  else if (winner === AI) s.losses += 1
  setUserStats(userId, s)
  renderUserStats()
}

function renderUserStats() {
  if (!$winRate || !$winLoss) return

  if (!userId) {
    $winRate.textContent = "胜率 --%"
    $winLoss.textContent = "0胜 0负"
    renderDifficultyBadge()
    return
  }

  const { wins, losses } = getUserStats(userId)
  const total = wins + losses
  const rate = total === 0 ? 0 : (wins / total) * 100

  $winRate.textContent = `胜率 ${rate.toFixed(total === 0 ? 0 : 1)}%`
  $winLoss.textContent = `${wins}胜 ${losses}负`
  renderDifficultyBadge()
}

function renderDifficultyBadge() {
  if (!$diffBadge) return
  $diffBadge.textContent = `难度等级 ${difficulty}`
}

function getWinLine(board, player) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line
    if (board[a] === player && board[b] === player && board[c] === player) return line
  }
  return null
}

function recomputeWinner(s, humanPlayer, aiPlayer) {
  if (s.winner) return s
  const hLine = getWinLine(s.board, humanPlayer)
  if (hLine) return { ...s, winner: humanPlayer, winLine: hLine }
  const aLine = getWinLine(s.board, aiPlayer)
  if (aLine) return { ...s, winner: aiPlayer, winLine: aLine }
  return s
}

function cloneState(s) {
  return {
    board: s.board.slice(),
    currentPlayer: s.currentPlayer,
    queues: {
      1: s.queues[1].slice(),
      2: s.queues[2].slice(),
    },
    fading: s.fading ? s.fading.slice() : Array(9).fill(0),
    winner: s.winner,
    winLine: s.winLine ? s.winLine.slice() : null,
  }
}

function stateKey(s) {
  // 注意：本规则下“落子顺序”会影响后续移除，因此必须把队列顺序也编码进 key
  return `${s.currentPlayer}|${s.board.join("")}|${s.queues[1].join(",")}|${s.queues[2].join(",")}`
}

function applyMove(s, idx, player) {
  const ns = cloneState(s)
  if (ns.winner) return ns
  if (ns.board[idx] !== 0) return ns

  // 每人最多3子：落第4子前，移除自己最早那颗
  if (ns.queues[player].length === 3) {
    const removed = ns.queues[player].shift()
    if (removed !== undefined) ns.board[removed] = 0
  }

  ns.queues[player].push(idx)
  ns.board[idx] = player

  const winLine = getWinLine(ns.board, player)
  if (winLine) {
    ns.winner = player
    ns.winLine = winLine
    return ns
  }

  ns.currentPlayer = player === 1 ? 2 : 1
  return ns
}

function availableMoves(s) {
  const moves = []
  for (let i = 0; i < 9; i++) if (s.board[i] === 0) moves.push(i)
  return moves
}

function evaluate(s, aiPlayer, humanPlayer, depth) {
  if (s.winner === aiPlayer) return 100000 - depth
  if (s.winner === humanPlayer) return -100000 + depth

  // 启发式：按“潜在三连”评分（只含一方棋子的线才算潜力）
  let score = 0
  for (const [a, b, c] of WIN_LINES) {
    const line = [s.board[a], s.board[b], s.board[c]]
    const aiCount = line.filter((v) => v === aiPlayer).length
    const huCount = line.filter((v) => v === humanPlayer).length
    if (aiCount > 0 && huCount > 0) continue
    if (aiCount > 0) score += aiCount === 1 ? 3 : aiCount === 2 ? 20 : 80
    if (huCount > 0) score -= huCount === 1 ? 3 : huCount === 2 ? 22 : 90
  }

  // 位置偏好：中心 > 角 > 边
  if (s.board[4] === aiPlayer) score += 2
  if (s.board[4] === humanPlayer) score -= 2
  const corners = [0, 2, 6, 8]
  for (const i of corners) {
    if (s.board[i] === aiPlayer) score += 1
    if (s.board[i] === humanPlayer) score -= 1
  }

  return score
}

function minimax(s, depth, alpha, beta, aiPlayer, humanPlayer, memo) {
  const key = `${depth}|${stateKey(s)}`
  if (memo.has(key)) return memo.get(key)

  if (depth === 0 || s.winner) {
    const v = evaluate(s, aiPlayer, humanPlayer, depth)
    memo.set(key, v)
    return v
  }

  const moves = availableMoves(s)
  if (moves.length === 0) {
    const v = evaluate(s, aiPlayer, humanPlayer, depth)
    memo.set(key, v)
    return v
  }

  const maximizing = s.currentPlayer === aiPlayer
  let best = maximizing ? -Infinity : Infinity

  // 简单 move ordering：先中心、再角、再边，可提升剪枝效率
  const priority = (i) => (i === 4 ? 0 : [0, 2, 6, 8].includes(i) ? 1 : 2)
  moves.sort((a, b) => priority(a) - priority(b))

  for (const m of moves) {
    const ns = applyMove(s, m, s.currentPlayer)
    const v = minimax(ns, depth - 1, alpha, beta, aiPlayer, humanPlayer, memo)
    if (maximizing) {
      best = Math.max(best, v)
      alpha = Math.max(alpha, best)
      if (alpha >= beta) break
    } else {
      best = Math.min(best, v)
      beta = Math.min(beta, best)
      if (beta <= alpha) break
    }
  }

  memo.set(key, best)
  return best
}

function chooseBestMove(s, aiPlayer, humanPlayer, cfg) {
  const moves = availableMoves(s)

  // 超低难度下允许“随便走一步”，让体验更轻松
  const randomRate = cfg?.randomRate ?? 0
  if (randomRate > 0 && Math.random() < randomRate && moves.length > 0) {
    return moves[Math.floor(Math.random() * moves.length)]
  }

  // 低难度下允许“漏看”一步必胜/必防（否则即使深度很低也会很难）
  const tacticalMistakeRate = cfg?.tacticalMistakeRate ?? 0
  const allowTactics = !(tacticalMistakeRate > 0 && Math.random() < tacticalMistakeRate)

  // 先看一步必胜/必防（在低难度下可能会被跳过）
  if (allowTactics) {
    for (const m of moves) {
      const ns = applyMove(s, m, aiPlayer)
      if (ns.winner === aiPlayer) return m
    }
    for (const m of moves) {
      const ns = applyMove(s, m, humanPlayer)
      if (ns.winner === humanPlayer) return m
    }
  }
  // 深度越大越强，但也更耗时；本盘面很小，适当深度即可
  const MAX_DEPTH = cfg?.maxDepth ?? 10
  const memo = new Map()


  const scored = []

  const priority = (i) => (i === 4 ? 0 : [0, 2, 6, 8].includes(i) ? 1 : 2)
  moves.sort((a, b) => priority(a) - priority(b))

  for (const m of moves) {
    const ns = applyMove(s, m, aiPlayer)
    const score = minimax(ns, MAX_DEPTH - 1, -Infinity, Infinity, aiPlayer, humanPlayer, memo)
    scored.push({ m, score })
  }

  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) return null

  // 失误机制：让简单/中等更“像小游戏”，人类更有机会赢
  const mistakeRate = cfg?.mistakeRate ?? 0
  const topK = Math.max(1, Math.min(cfg?.mistakeTopK ?? 1, scored.length))
  if (mistakeRate > 0 && Math.random() < mistakeRate && topK > 1) {
    // 在前 topK 里故意不选最优（从第2名开始选）
    const pickIndex = 1 + Math.floor(Math.random() * (topK - 1))
    return scored[pickIndex].m
  }

  return scored[0].m
}

const $board = document.getElementById("board")
const $status = document.getElementById("status")
const $resetBtn = document.getElementById("resetBtn")
const $resultModal = document.getElementById("resultModal")
const $resultTitle = document.getElementById("resultTitle")
const $resultBody = document.getElementById("resultBody")
const $playAgainBtn = document.getElementById("playAgainBtn")
const $easterModal = document.getElementById("easterModal")
const $easterTitle = document.getElementById("easterTitle")
const $easterBody = document.getElementById("easterBody")
const $easterCloseBtn = document.getElementById("easterCloseBtn")
const $easterUpdatedAt = document.getElementById("easterUpdatedAt")
const $easterDiff = document.getElementById("easterDiff")

let state
let isAiThinking = false
let gameRecorded = false

const HUMAN = 1 // 你：X
const AI = 2 // AI：O
const FADE_MS = 320
let fadeTimers = Array(9).fill(null)

// 难度 1~10（不外显），通过深度与“失误率”映射到 AI 参数
// 约定：当前版本体验作为 5 档
function getAiCfgByDifficulty(level) {
  const d = clamp(Number(level) || 1, 1, 10)

  // 1 档：非常容易
  const L1 = { maxDepth: 1, mistakeRate: 0.95, mistakeTopK: 9, tacticalMistakeRate: 0.85, randomRate: 0.35 }
  // 5 档：当前体验（作为基准）
  const L5 = { maxDepth: 2, mistakeRate: 0.85, mistakeTopK: 6, tacticalMistakeRate: 0.25, randomRate: 0.05 }
  // 10 档：接近“最强”（接近之前的最难）
  const L10 = { maxDepth: 10, mistakeRate: 0.05, mistakeTopK: 2, tacticalMistakeRate: 0, randomRate: 0 }

  if (d <= 5) {
    // 1~5：从 L1 线性过渡到 L5
    const t = (d - 1) / 4 // 0~1
    const maxDepth = Math.round(L1.maxDepth + (L5.maxDepth - L1.maxDepth) * t)
    const mistakeRate = L1.mistakeRate + (L5.mistakeRate - L1.mistakeRate) * t
    const mistakeTopK = Math.round(L1.mistakeTopK + (L5.mistakeTopK - L1.mistakeTopK) * t)
    const tacticalMistakeRate = L1.tacticalMistakeRate + (L5.tacticalMistakeRate - L1.tacticalMistakeRate) * t
    const randomRate = L1.randomRate + (L5.randomRate - L1.randomRate) * t
    return {
      maxDepth: clamp(maxDepth, 1, 12),
      mistakeRate: clamp(mistakeRate, 0, 0.95),
      mistakeTopK: clamp(mistakeTopK, 1, 9),
      tacticalMistakeRate: clamp(tacticalMistakeRate, 0, 0.95),
      randomRate: clamp(randomRate, 0, 0.95),
    }
  }

  // 6~10：从 L5 线性过渡到 L10
  const t = (d - 5) / 5 // 0.2~1
  const maxDepth = Math.round(L5.maxDepth + (L10.maxDepth - L5.maxDepth) * t)
  const mistakeRate = L5.mistakeRate + (L10.mistakeRate - L5.mistakeRate) * t
  const mistakeTopK = Math.round(L5.mistakeTopK + (L10.mistakeTopK - L5.mistakeTopK) * t)
  const tacticalMistakeRate = L5.tacticalMistakeRate + (L10.tacticalMistakeRate - L5.tacticalMistakeRate) * t
  const randomRate = L5.randomRate + (L10.randomRate - L5.randomRate) * t
  return {
    maxDepth: clamp(maxDepth, 1, 12),
    mistakeRate: clamp(mistakeRate, 0, 0.95),
    mistakeTopK: clamp(mistakeTopK, 1, 9),
    tacticalMistakeRate: clamp(tacticalMistakeRate, 0, 0.95),
    randomRate: clamp(randomRate, 0, 0.95),
  }
}

let AI_CFG = getAiCfgByDifficulty(difficulty)

// ========= 彩蛋：多次点击“胜率”弹出，显示文件更新时间 =========
const EASTER_TAP_NEED = 7
const EASTER_TAP_WINDOW_MS = 1600
let easterTapCount = 0
let easterTapTimer = null

function getFileUpdateTimeText() {
  // document.lastModified 通常由浏览器基于服务器返回的 Last-Modified 或文件时间推断
  try {
    const lm = document.lastModified
    const dt = lm ? new Date(lm) : null
    if (dt && !Number.isNaN(dt.getTime())) {
      return dt.toLocaleString("zh-CN", { hour12: false })
    }
  } catch {}
  return "未知"
}

function openEasterModal() {
  if (!$easterModal) return
  if ($easterTitle) $easterTitle.textContent = "彩蛋"
  const t = getFileUpdateTimeText()
  if ($easterUpdatedAt) $easterUpdatedAt.textContent = t
  if ($easterDiff) $easterDiff.textContent = String(difficulty)

  $easterModal.classList.add("isOpen")
  $easterModal.setAttribute("aria-hidden", "false")
}

function closeEasterModal() {
  if (!$easterModal) return
  $easterModal.classList.remove("isOpen")
  $easterModal.setAttribute("aria-hidden", "true")
}

function onEasterTap() {
  easterTapCount += 1
  if (easterTapTimer) clearTimeout(easterTapTimer)
  easterTapTimer = window.setTimeout(() => {
    easterTapCount = 0
    easterTapTimer = null
  }, EASTER_TAP_WINDOW_MS)

  if (easterTapCount >= EASTER_TAP_NEED) {
    easterTapCount = 0
    if (easterTapTimer) clearTimeout(easterTapTimer)
    easterTapTimer = null
    openEasterModal()
  }
}

function init() {
  closeResultModal()
  // 每局开始时按当前难度刷新 AI 参数
  AI_CFG = getAiCfgByDifficulty(difficulty)
  renderDifficultyBadge()
  // 清理仍在执行的淡出计时器
  fadeTimers.forEach((t) => t && clearTimeout(t))
  fadeTimers = Array(9).fill(null)

  state = {
    board: Array(9).fill(0), // 0空 1玩家1 2玩家2
    currentPlayer: 1,
    queues: { 1: [], 2: [] }, // 记录每个玩家的落子顺序（最早在前）
    fading: Array(9).fill(0), // 视觉淡出层：逻辑上已移除，但动画还在
    winner: 0,
    winLine: null,
  }
  isAiThinking = false
  gameRecorded = false
  renderBoard(true)
  renderStatus()
  renderCounts()
}

function startFade(idx, player) {
  if (idx === null || idx === undefined) return
  if (idx < 0 || idx > 8) return

  if (fadeTimers[idx]) clearTimeout(fadeTimers[idx])
  state.fading[idx] = player
  renderBoard()

  fadeTimers[idx] = window.setTimeout(() => {
    state.fading[idx] = 0
    fadeTimers[idx] = null
    renderBoard()
  }, FADE_MS)
}

function renderStatus() {
  if (state.winner) {
    $status.innerHTML =
      state.winner === HUMAN
        ? `结果：<span class="p1">你获胜</span>`
        : `结果：<span class="p2">AI 获胜</span>`
    return
  }
  if (isAiThinking) {
    $status.innerHTML = `AI 思考中…`
    return
  }
  $status.innerHTML = state.currentPlayer === HUMAN ? `轮到你落子` : `轮到 AI 落子`
}

function handleGameOver(winner) {
  if (gameRecorded) return
  gameRecorded = true
  // 先更新难度，再刷新战绩 UI，避免 UI 仍显示旧难度
  updateDifficultyByResult(winner)
  recordGameResult(winner)
  openResultModal(winner)
}

function openResultModal(winner) {
  if (!$resultModal || !$resultBody) return
  if ($resultTitle) $resultTitle.textContent = "本局结果"
  $resultBody.innerHTML =
    winner === HUMAN ? `<span class="p1">你获胜！</span>` : winner === AI ? `<span class="p2">AI 获胜！</span>` : `--`
  $resultModal.classList.add("isOpen")
  $resultModal.setAttribute("aria-hidden", "false")
}

function closeResultModal() {
  if (!$resultModal) return
  $resultModal.classList.remove("isOpen")
  $resultModal.setAttribute("aria-hidden", "true")
}

function renderCounts() {
  // 已移除“你 / AI 棋子数”显示，此处保留函数避免改动过大
}

function renderBoard(rebuild = false) {
  if (rebuild) {
    $board.innerHTML = ""
    for (let i = 0; i < 9; i++) {
      const btn = document.createElement("button")
      btn.className = "cell"
      btn.type = "button"
      btn.setAttribute("aria-label", `cell-${i}`)
      btn.dataset.idx = String(i)
      btn.addEventListener("click", onCellClick)

      const mark = document.createElement("span")
      mark.className = "mark"
      btn.appendChild(mark)

      $board.appendChild(btn)
    }
  }

  // “提前一步”提示：只提示【对方】即将消失的棋子（你这边不提示）
  // 当前版本是 你(X) vs AI(O)，因此只提示 AI 最早那颗（当 AI 已有3子时）
  const aboutToVanish = new Set()
  if (state.queues[AI].length === 3) aboutToVanish.add(state.queues[AI][0])

  const cells = $board.querySelectorAll(".cell")
  cells.forEach((cell, idx) => {
    const v = state.board[idx] || state.fading[idx]
    const isFading = state.board[idx] === 0 && state.fading[idx] !== 0
    const isAbout = !isFading && state.board[idx] !== 0 && aboutToVanish.has(idx)

    const mark = cell.querySelector(".mark")
    if (mark) mark.textContent = v === 1 ? "X" : v === 2 ? "O" : ""
    cell.classList.toggle("x", v === 1)
    cell.classList.toggle("o", v === 2)
    if (mark) {
      mark.classList.toggle("fading", isFading)
      mark.classList.toggle("about", isAbout)
    }
    cell.classList.toggle("win", !!state.winLine && state.winLine.includes(idx))
    // AI 思考或游戏结束时禁用点击，避免状态不同步
    cell.disabled =
      !!state.winner || isAiThinking || state.currentPlayer !== HUMAN || state.board[idx] !== 0 || isFading
  })
}

function onCellClick(e) {
  const idx = Number(e.currentTarget.dataset.idx)
  if (state.winner || isAiThinking) return
  if (state.currentPlayer !== HUMAN) return
  if (state.board[idx] !== 0) return

  // 你落子
  const removedIdx = state.queues[HUMAN].length === 3 ? state.queues[HUMAN][0] : null
  state = applyMove(state, idx, HUMAN)
  state = recomputeWinner(state, HUMAN, AI)
  if (removedIdx !== null) startFade(removedIdx, HUMAN)
  renderBoard()
  renderStatus()
  renderCounts()

  if (state.winner) {
    handleGameOver(HUMAN)
    return
  }

  // AI 回合
  aiMove()
}

function aiMove() {
  if (state.winner) return
  if (state.currentPlayer !== AI) return

  isAiThinking = true
  renderBoard()
  renderStatus()

  // 让浏览器先把“思考中”渲染出来
  const delay = 520 + Math.floor(Math.random() * 380) // 520~900ms，更像“在思考”
  window.setTimeout(() => {
    const best = chooseBestMove(state, AI, HUMAN, AI_CFG)
    if (best === null || best === undefined) {
      isAiThinking = false
      renderBoard()
      renderStatus()
      return
    }

    const removedIdx = state.queues[AI].length === 3 ? state.queues[AI][0] : null
    state = applyMove(state, best, AI)
    state = recomputeWinner(state, HUMAN, AI)
    if (removedIdx !== null) startFade(removedIdx, AI)
    isAiThinking = false
    renderBoard()
    renderStatus()
    renderCounts()

    if (state.winner) {
      handleGameOver(AI)
    }
  }, delay)
}

if ($resultModal) {
  $resultModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeResultModal()
  })
}
if ($playAgainBtn) {
  $playAgainBtn.addEventListener("click", () => {
    closeResultModal()
    init()
  })
}

$resetBtn.addEventListener("click", () => {
  closeResultModal()
  init()
})

if ($easterModal) {
  $easterModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeEasterModal()
  })
}
if ($easterCloseBtn) {
  $easterCloseBtn.addEventListener("click", () => closeEasterModal())
}
if ($winRate) {
  // 点击“胜率”7次（约1.6s内）触发彩蛋
  $winRate.addEventListener("click", onEasterTap)
}
if ($diffBadge) {
  $diffBadge.addEventListener("click", () => {
    openTipModal("难度等级 1-10，输赢后会自动升降等级")
  })
}

if ($tipModal) {
  // 点空白（遮罩）关闭
  $tipModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeTipModal()
  })
}
// 初始化：先拿到 userId 与战绩，再启动游戏
;(async () => {
  try {
    userId = await getOrCreateUserId()
  } catch {
    // 极少数环境（不安全上下文等）可能拿不到 crypto.subtle，允许降级为随机 id
    const fallback = localStorage.getItem(STORAGE_UID_KEY) || `u_${Math.random().toString(16).slice(2, 10)}`
    localStorage.setItem(STORAGE_UID_KEY, fallback)
    userId = fallback
  }
  // 初始化：新用户默认难度 1（存储里没有时 getUserDifficulty 会返回 1）
  difficulty = getUserDifficulty(userId)

  // 不蒜子：页面打开就加载（但仅限 http/https，避免 file:// 报错）
  if (canLoadRemoteScripts()) {
    loadScriptOnce("https://busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js", "busuanzi-sdk").catch(() => {
      // 失败不影响游戏
    })
  }

  // 记录访问次数（不阻塞 UI）
  recordPageVisit(userId)
  renderUserStats()
  init()
})()
