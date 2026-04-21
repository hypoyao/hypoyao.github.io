// 扫雷游戏 - 小小工程师版

// 游戏设置
const difficulties = {
  easy: { rows: 9, cols: 9, mines: 10 },
  medium: { rows: 16, cols: 16, mines: 40 },
  hard: { rows: 16, cols: 30, mines: 99 }
};

let currentDiff = 'easy';
let board = [];
let revealed = [];
let flagged = [];
let gameOver = false;
let firstClick = true;
let timerInterval = null;
let time = 0;
let flagMode = false;
let totalMines = 0;

// 初始化游戏
function initGame() {
  const { rows, cols, mines } = difficulties[currentDiff];
  totalMines = mines;
  
  // 重置状态
  board = [];
  revealed = Array(rows).fill().map(() => Array(cols).fill(false));
  flagged = Array(rows).fill().map(() => Array(cols).fill(false));
  gameOver = false;
  firstClick = true;
  time = 0;
  flagMode = false;
  
  // 停止计时器
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  
  // 更新界面
  document.getElementById('timer').textContent = '0';
  document.getElementById('flag-count').textContent = '0';
  document.getElementById('face-btn').textContent = '😊';
  document.getElementById('flag-btn').classList.remove('active');
  
  // 创建棋盘
  createBoard(rows, cols);
}

// 创建棋盘
function createBoard(rows, cols) {
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  
  // 设置网格布局
  boardEl.style.gridTemplateColumns = `repeat(${cols}, 30px)`;
  boardEl.style.gridTemplateRows = `repeat(${rows}, 30px)`;
  
  // 生成格子
  for (let r = 0; r < rows; r++) {
    board[r] = [];
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.addEventListener('click', () => handleClick(r, c));
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        handleRightClick(r, c);
      });
      boardEl.appendChild(cell);
      board[r][c] = { mine: false, num: 0, element: cell };
    }
  }
}

// 放置地雷（第一次点击后）
function placeMines(excludeRow, excludeCol) {
  const { rows, cols, mines } = difficulties[currentDiff];
  let placed = 0;
  
  while (placed < mines) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    
    // 排除第一次点击的位置和周围
    const isNear = Math.abs(r - excludeRow) <= 1 && Math.abs(c - excludeCol) <= 1;
    
    if (!board[r][c].mine && !isNear) {
      board[r][c].mine = true;
      placed++;
    }
  }
  
  // 计算数字
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c].mine) {
        board[r][c].num = countMines(r, c);
      }
    }
  }
}

// 计算周围地雷数
function countMines(row, col) {
  const { rows, cols } = difficulties[currentDiff];
  let count = 0;
  
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].mine) {
        count++;
      }
    }
  }
  return count;
}

// 处理点击
function handleClick(row, col) {
  if (gameOver || flagged[row][col]) return;
  
  // 插旗模式
  if (flagMode) {
    toggleFlag(row, col);
    return;
  }
  
  // 第一次点击
  if (firstClick) {
    firstClick = false;
    placeMines(row, col);
    startTimer();
  }
  
  // 踩雷了
  if (board[row][col].mine) {
    gameOver = true;
    revealAllMines();
    document.getElementById('face-btn').textContent = '😵';
    showGameOver(false);
    return;
  }
  
  // 翻开格子
  revealCell(row, col);
  
  // 检查胜利
  checkWin();
}

// 翻开格子
function revealCell(row, col) {
  const { rows, cols } = difficulties[currentDiff];
  
  if (row < 0 || row >= rows || col < 0 || col >= cols) return;
  if (revealed[row][col] || flagged[row][col]) return;
  
  revealed[row][col] = true;
  const cell = board[row][col].element;
  cell.classList.add('revealed');
  
  if (board[row][col].num > 0) {
    cell.textContent = board[row][col].num;
    cell.dataset.num = board[row][col].num;
  } else {
    // 空白格，自动翻开周围
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr !== 0 || dc !== 0) {
          revealCell(row + dr, col + dc);
        }
      }
    }
  }
}

// 右键插旗
function handleRightClick(row, col) {
  if (gameOver || revealed[row][col]) return;
  toggleFlag(row, col);
}

// 切换旗帜
function toggleFlag(row, col) {
  flagged[row][col] = !flagged[row][col];
  const cell = board[row][col].element;
  
  if (flagged[row][col]) {
    cell.classList.add('flagged');
    cell.textContent = '🚩';
  } else {
    cell.classList.remove('flagged');
    cell.textContent = '';
  }
  
  updateFlagCount();
}

// 更新旗帜数
function updateFlagCount() {
  let count = 0;
  for (let r = 0; r < flagged.length; r++) {
    for (let c = 0; c < flagged[r].length; c++) {
      if (flagged[r][c]) count++;
    }
  }
  document.getElementById('flag-count').textContent = count;
}

// 插旗模式切换
function toggleFlagMode() {
  flagMode = !flagMode;
  const btn = document.getElementById('flag-btn');
  btn.classList.toggle('active', flagMode);
}

// 揭示所有地雷
function revealAllMines() {
  const { rows, cols } = difficulties[currentDiff];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].mine) {
        board[r][c].element.classList.add('revealed', 'mine');
        board[r][c].element.textContent = '💣';
      }
    }
  }
}

// 检查胜利
function checkWin() {
  const { rows, cols } = difficulties[currentDiff];
  let revealedCount = 0;
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (revealed[r][c]) revealedCount++;
    }
  }
  
  if (revealedCount === rows * cols - totalMines) {
    gameOver = true;
    document.getElementById('face-btn').textContent = '😎';
    showGameOver(true);
  }
}

// 显示游戏结束
function showGameOver(win) {
  const overlay = document.createElement('div');
  overlay.className = 'game-over';
  overlay.innerHTML = `
    <h2>${win ? '🎉 恭喜获胜！' : '💥 游戏结束！'}</h2>
    <button onclick="this.parentElement.remove(); initGame()">再来一局</button>
  `;
  document.body.appendChild(overlay);
}

// 计时器
function startTimer() {
  timerInterval = setInterval(() => {
    time++;
    document.getElementById('timer').textContent = time;
  }, 1000);
}

// 难度选择
function setDifficulty(diff) {
  currentDiff = diff;
  
  // 更新按钮状态
  document.querySelectorAll('.difficulty button').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`btn-${diff}`).classList.add('active');
  
  initGame();
}

// 启动游戏
initGame();