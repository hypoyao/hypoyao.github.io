"use strict"

// 适合小学生的数独（9×9）：
// - 使用固定答案 + 按难度挖空（越高越难）
// - 提交正确：难度 +1；提交错误：难度 -1（1~10）
// - 顶部用 10 个小方块展示：已完成（< 当前等级）黑色；当前等级灰色

const MIN_LEVEL = 1
const MAX_LEVEL = 10

const STORAGE_KEY = "sudoku_progress_v3"

const SOLUTION = [
  5, 3, 4, 6, 7, 8, 9, 1, 2,
  6, 7, 2, 1, 9, 5, 3, 4, 8,
  1, 9, 8, 3, 4, 2, 5, 6, 7,
  8, 5, 9, 7, 6, 1, 4, 2, 3,
  4, 2, 6, 8, 5, 3, 7, 9, 1,
  7, 1, 3, 9, 2, 4, 8, 5, 6,
  9, 6, 1, 5, 3, 7, 2, 8, 4,
  2, 8, 7, 4, 1, 9, 6, 3, 5,
  3, 4, 5, 2, 8, 6, 1, 7, 9,
]

const $board = document.getElementById("board")
const $pad = document.getElementById("pad")
const $eraseBtn = document.getElementById("eraseBtn")
const $submitBtn = document.getElementById("submitBtn")
const $newBtn = document.getElementById("newBtn")

const $diffGrid = document.getElementById("diffGrid")
const $diffText = document.getElementById("diffText")
const $levelText = document.getElementById("levelText")
const $hintText = document.getElementById("hintText")

const $sdkModal = document.getElementById("sdkModal")
const $sdkModalTitle = document.getElementById("sdkModalTitle")
const $sdkModalBody = document.getElementById("sdkModalBody")
const $sdkModalBtn = document.getElementById("sdkModalBtn")

const $sdkTipModal = document.getElementById("sdkTipModal")
const $sdkTipText = document.getElementById("sdkTipText")

let level = MIN_LEVEL
let givens = Array(81).fill(false)
let values = Array(81).fill(0) // 当前填入
let selected = -1

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

function saveProgress() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        level,
        givens,
        values,
        updatedAt: Date.now(),
      })
    )
  } catch {}
}

function loadProgress() {
  const raw = localStorage.getItem(STORAGE_KEY)
  const data = safeJsonParse(raw || "{}", {})
  const lv = clamp(Number(data?.level) || MIN_LEVEL, MIN_LEVEL, MAX_LEVEL)
  const gv = Array.isArray(data?.givens) && data.givens.length === 81 ? data.givens.map(Boolean) : null
  const vv = Array.isArray(data?.values) && data.values.length === 81 ? data.values.map((x) => Number(x) || 0) : null
  level = lv
  if (gv && vv) {
    givens = gv
    values = vv
    // 若存档不完整（全 0），重新出题
    const anyGiven = givens.some(Boolean)
    if (!anyGiven) newPuzzle()
  } else {
    newPuzzle()
  }
}

function holesByLevel(lv) {
  // 1 最简单，10 最难
  // 面向小学 3~6 年级：整体更“友好”，空格数不要太多
  // 约：lv=1 -> 14 个空；lv=10 -> 41 个空（越难空格越多）
  const holes = 14 + (lv - 1) * 3
  return clamp(holes, 14, 41)
}

function newPuzzle() {
  // 基于固定答案，按难度挖空
  const holes = holesByLevel(level)
  // 难度越高：允许每行/列/宫格保留更少的“给定数字”（让高等级更明显更难）
  // 1~3：每行/列/宫至少留 5 个；4~6：至少 4 个；7~10：至少 3 个
  const minGiven = level <= 3 ? 5 : level <= 6 ? 4 : 3
  const idxs = Array.from({ length: 81 }, (_, i) => i)
  // 洗牌
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[idxs[i], idxs[j]] = [idxs[j], idxs[i]]
  }

  givens = Array(81).fill(true)
  values = SOLUTION.slice()

  // 逐个挖空，尽量保证每行至少留 3 个给定
  const rowGiven = Array(9).fill(9)
  const colGiven = Array(9).fill(9)
  const boxGiven = Array(9).fill(9)

  let removed = 0
  for (const idx of idxs) {
    if (removed >= holes) break
    const r = Math.floor(idx / 9)
    const c = idx % 9
    const b = Math.floor(r / 3) * 3 + Math.floor(c / 3)
    if (rowGiven[r] <= minGiven) continue
    if (colGiven[c] <= minGiven) continue
    if (boxGiven[b] <= minGiven) continue

    givens[idx] = false
    values[idx] = 0
    rowGiven[r] -= 1
    colGiven[c] -= 1
    boxGiven[b] -= 1
    removed += 1
  }

  selected = -1
  saveProgress()
  renderAll(true)
}

function renderDifficulty() {
  if ($diffText) $diffText.textContent = `难度等级 ${level} / 10`
  if ($levelText) $levelText.textContent = `第 ${level} 级`
  if (!$diffGrid) return
  if ($diffGrid.childElementCount !== 10) {
    $diffGrid.innerHTML = ""
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement("span")
      dot.className = "sdkDiffDot"
      dot.dataset.level = String(i)
      $diffGrid.appendChild(dot)
    }
  }
  const dots = $diffGrid.querySelectorAll(".sdkDiffDot")
  dots.forEach((el) => {
    const lv = Number(el.dataset.level || 0)
    el.classList.toggle("isDone", lv > 0 && lv < level)
    el.classList.toggle("isCurrent", lv > 0 && lv === level)
  })
}

function ensureBoard() {
  if (!$board) return
  if ($board.childElementCount === 81) return
  $board.innerHTML = ""
  for (let i = 0; i < 81; i++) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "sdkCell"
    btn.dataset.idx = String(i)
    btn.setAttribute("aria-label", `cell-${i}`)

    // 粗线：每 3 宫
    const r = Math.floor(i / 9)
    const c = i % 9
    if (c === 2 || c === 5) btn.classList.add("v3")
    if (r === 2 || r === 5) btn.classList.add("h3")

    btn.addEventListener("click", onCellClick)
    $board.appendChild(btn)
  }
}

function ensurePad() {
  if (!$pad) return
  if ($pad.childElementCount === 9) return
  $pad.innerHTML = ""
  for (let n = 1; n <= 9; n++) {
    const b = document.createElement("button")
    b.type = "button"
    b.className = "sdkNumBtn"
    b.textContent = String(n)
    b.dataset.num = String(n)
    b.addEventListener("click", () => placeNumber(n))
    $pad.appendChild(b)
  }
}

function renderCells() {
  if (!$board) return
  const cells = $board.querySelectorAll(".sdkCell")
  const selRC = selected >= 0 ? { r: Math.floor(selected / 9), c: selected % 9 } : null
  const selBox = selRC ? Math.floor(selRC.r / 3) * 3 + Math.floor(selRC.c / 3) : null

  cells.forEach((cell, i) => {
    const v = values[i] || 0
    cell.textContent = v === 0 ? "" : String(v)

    cell.classList.toggle("given", !!givens[i])
    cell.classList.toggle("user", !givens[i] && v !== 0)
    cell.classList.toggle("wrong", !givens[i] && v !== 0 && v !== SOLUTION[i])

    cell.classList.toggle("selected", i === selected)

    // peek：同一行/列/宫格浅高亮
    if (selRC) {
      const r = Math.floor(i / 9)
      const c = i % 9
      const b = Math.floor(r / 3) * 3 + Math.floor(c / 3)
      const peek = i !== selected && (r === selRC.r || c === selRC.c || b === selBox)
      cell.classList.toggle("peek", peek)
    } else {
      cell.classList.remove("peek")
    }

    cell.disabled = !!givens[i]
  })
}

function renderAll(rebuild = false) {
  renderDifficulty()
  if (rebuild) {
    ensureBoard()
    ensurePad()
  }
  renderCells()
}

function onCellClick(e) {
  const idx = Number(e.currentTarget?.dataset?.idx)
  if (!Number.isFinite(idx)) return
  selected = idx
  if ($hintText) $hintText.textContent = "已选中一个格子，点数字填入"
  renderCells()
}

function placeNumber(n) {
  if (selected < 0) {
    if ($hintText) $hintText.textContent = "先点击一个格子再填数字"
    return
  }
  if (givens[selected]) return
  values[selected] = n
  saveProgress()
  renderCells()
}

function eraseSelected() {
  if (selected < 0) return
  if (givens[selected]) return
  values[selected] = 0
  saveProgress()
  renderCells()
}

function countWrongAndEmpty() {
  let wrong = 0
  let empty = 0
  for (let i = 0; i < 81; i++) {
    const v = values[i] || 0
    if (v === 0) empty += 1
    else if (v !== SOLUTION[i]) wrong += 1
  }
  return { wrong, empty }
}

function openModal(title, body) {
  if (!$sdkModal) return
  if ($sdkModalTitle) $sdkModalTitle.textContent = title
  if ($sdkModalBody) $sdkModalBody.textContent = body
  $sdkModal.classList.add("isOpen")
  $sdkModal.setAttribute("aria-hidden", "false")
}

function closeModal() {
  if (!$sdkModal) return
  $sdkModal.classList.remove("isOpen")
  $sdkModal.setAttribute("aria-hidden", "true")
}

function openTipModal() {
  if (!$sdkTipModal) return
  if ($sdkTipText) $sdkTipText.textContent = "难度等级 1-10，输赢后会自动升降等级"
  $sdkTipModal.classList.add("isOpen")
  $sdkTipModal.setAttribute("aria-hidden", "false")
}

function closeTipModal() {
  if (!$sdkTipModal) return
  $sdkTipModal.classList.remove("isOpen")
  $sdkTipModal.setAttribute("aria-hidden", "true")
}

function handleSubmit() {
  const { wrong, empty } = countWrongAndEmpty()
  if (wrong === 0 && empty === 0) {
    const prev = level
    level = clamp(level + 1, MIN_LEVEL, MAX_LEVEL)
    saveProgress()
    openModal(prev === MAX_LEVEL ? "太棒了！" : "太棒了！晋级", prev === MAX_LEVEL ? "已是最高等级！再来一题也可以～" : `升级到 第 ${level} 级`)
    // 新题
    newPuzzle()
    return
  }

  // 失败：退级（包含未完成也算失败）
  const prev = level
  level = clamp(level - 1, MIN_LEVEL, MAX_LEVEL)
  saveProgress()
  const msg = empty > 0 ? `还有 ${empty} 格没填，先补齐再提交～（已退到第 ${level} 级）` : `有 ${wrong} 处不对哦～（已退到第 ${level} 级）`
  openModal("再试一次", prev === MIN_LEVEL ? msg.replace(`第 ${level} 级`, "第 1 级") : msg)
  newPuzzle()
}

function init() {
  loadProgress()
  ensureBoard()
  ensurePad()
  renderAll()
}

if ($eraseBtn) $eraseBtn.addEventListener("click", eraseSelected)
if ($submitBtn) $submitBtn.addEventListener("click", handleSubmit)
if ($newBtn) $newBtn.addEventListener("click", () => newPuzzle())
if ($sdkModal) {
  $sdkModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeModal()
  })
}
if ($sdkModalBtn) $sdkModalBtn.addEventListener("click", () => closeModal())
if ($diffGrid) $diffGrid.addEventListener("click", () => openTipModal())
if ($sdkTipModal) {
  $sdkTipModal.addEventListener("click", (e) => {
    if (e.target?.dataset?.close) closeTipModal()
  })
}

// 键盘输入（电脑端）
document.addEventListener("keydown", (e) => {
  const k = e.key
  if (k >= "1" && k <= "9") {
    placeNumber(Number(k))
  } else if (k === "Backspace" || k === "Delete" || k === "0") {
    eraseSelected()
  }
})

init()
