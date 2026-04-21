// 扫雷游戏 - 小朋友也能玩！

// 游戏设置
const DIFFICULTY = {
    easy: { rows: 9, cols: 9, mines: 10 },
    medium: { rows: 16, cols: 16, mines: 40 },
    hard: { rows: 16, cols: 30, mines: 99 }
};

// 游戏状态
let board = [];
let revealed = [];
let flagged = [];
let gameOver = false;
let firstClick = true;
let timer = 0;
let timerInterval = null;
let currentMode = 'click'; // 'click' 或 'flag'
let currentDifficulty = 'easy';
let mineCount = 0;
let flagCount = 0;

// 获取DOM元素
const boardEl = document.getElementById('board');
const flagCountEl = document.getElementById('flagCount');
const timerEl = document.getElementById('timer');
const messageEl = document.getElementById('message');
const difficultySelect = document.getElementById('difficulty');
const newGameBtn = document.getElementById('newGame');
const modeClickBtn = document.getElementById('modeClick');
const modeFlagBtn = document.getElementById('modeFlag');

// 初始化游戏
function initGame() {
    const config = DIFFICULTY[currentDifficulty];
    board = [];
    revealed = [];
    flagged = [];
    gameOver = false;
    firstClick = true;
    timer = 0;
    mineCount = config.mines;
    flagCount = 0;
    
    // 停止计时器
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    
    // 更新界面
    flagCountEl.textContent = flagCount;
    timerEl.textContent = timer;
    messageEl.textContent = '';
    messageEl.className = 'message';
    
    // 设置棋盘大小
    boardEl.style.gridTemplateColumns = `repeat(${config.cols}, 1fr)`;
    boardEl.innerHTML = '';
    
    // 创建格子
    for (let r = 0; r < config.rows; r++) {
        board[r] = [];
        revealed[r] = [];
        flagged[r] = [];
        for (let c = 0; c < config.cols; c++) {
            board[r][c] = 0;
            revealed[r][c] = false;
            flagged[r][c] = false;
            
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.row = r;
            cell.dataset.col = c;
            // 用 onclick 而不用 addEventListener，确保点击有效
            cell.onclick = () => handleClick(r, c);
            cell.oncontextmenu = (e) => {
                e.preventDefault();
                handleRightClick(r, c);
            };
            boardEl.appendChild(cell);
        }
    }
}

// 放置地雷（第一次点击后）
function placeMines(safeRow, safeCol) {
    const config = DIFFICULTY[currentDifficulty];
    let minesPlaced = 0;
    
    while (minesPlaced < config.mines) {
        const r = Math.floor(Math.random() * config.rows);
        const c = Math.floor(Math.random() * config.cols);
        
        // 避开第一次点击的位置和周围8个格子
        const isSafe = Math.abs(r - safeRow) <= 1 && Math.abs(c - safeCol) <= 1;
        
        if (board[r][c] !== -1 && !isSafe) {
            board[r][c] = -1;
            minesPlaced++;
        }
    }
    
    // 计算每个格子周围的地雷数
    for (let r = 0; r < config.rows; r++) {
        for (let c = 0; c < config.cols; c++) {
            if (board[r][c] !== -1) {
                board[r][c] = countMines(r, c);
            }
        }
    }
}

// 计算周围地雷数
function countMines(row, col) {
    const config = DIFFICULTY[currentDifficulty];
    let count = 0;
    
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = row + dr;
            const nc = col + dc;
            if (nr >= 0 && nr < config.rows && nc >= 0 && nc < config.cols) {
                if (board[nr][nc] === -1) count++;
            }
        }
    }
    return count;
}

// 处理点击
function handleClick(row, col) {
    if (gameOver) return;
    if (flagged[row][col]) return;
    
    // 插旗模式下点击是标记/取消旗子
    if (currentMode === 'flag') {
        toggleFlag(row, col);
        return;
    }
    
    // 第一次点击时放置地雷并开始计时
    if (firstClick) {
        firstClick = false;
        placeMines(row, col);
        startTimer();
    }
    
    // 如果已经翻开，跳过
    if (revealed[row][col]) return;
    
    // 踩到地雷了
    if (board[row][col] === -1) {
        revealAllMines(row, col);
        endGame(false);
        return;
    }
    
    // 翻开格子
    revealCell(row, col);
    
    // 检查是否赢了
    checkWin();
}

// 处理右键点击（标记旗子）
function handleRightClick(row, col) {
    if (gameOver) return;
    if (revealed[row][col]) return;
    toggleFlag(row, col);
}

// 切换旗子
function toggleFlag(row, col) {
    const config = DIFFICULTY[currentDifficulty];
    const cell = getCell(row, col);
    
    if (flagged[row][col]) {
        // 取消旗子
        flagged[row][col] = false;
        cell.classList.remove('flagged');
        cell.textContent = '';
        flagCount--;
    } else {
        // 插上旗子
        flagged[row][col] = true;
        cell.classList.add('flagged');
        cell.textContent = '🚩';
        flagCount++;
    }
    
    flagCountEl.textContent = flagCount;
}

// 翻开格子
function revealCell(row, col) {
    const config = DIFFICULTY[currentDifficulty];
    
    if (row < 0 || row >= config.rows || col < 0 || col >= config.cols) return;
    if (revealed[row][col]) return;
    if (flagged[row][col]) return;
    
    revealed[row][col] = true;
    const cell = getCell(row, col);
    cell.classList.add('revealed');
    
    if (board[row][col] > 0) {
        cell.textContent = board[row][col];
        cell.dataset.num = board[row][col];
    } else if (board[row][col] === 0) {
        // 空白格子，自动翻开周围
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr !== 0 || dc !== 0) {
                    revealCell(row + dr, col + dc);
                }
            }
        }
    }
}

// 翻开所有地雷
function revealAllMines(clickedRow, clickedCol) {
    const config = DIFFICULTY[currentDifficulty];
    
    for (let r = 0; r < config.rows; r++) {
        for (let c = 0; c < config.cols; c++) {
            const cell = getCell(r, c);
            if (board[r][c] === -1) {
                cell.classList.add('revealed', 'mine');
                cell.textContent = '💣';
                if (r === clickedRow && c === clickedCol) {
                    cell.style.background = '#ff0000';
                }
            } else if (flagged[r][c]) {
                // 标记错了
                cell.textContent = '❌';
            }
        }
    }
}

// 获取格子元素
function getCell(row, col) {
    const config = DIFFICULTY[currentDifficulty];
    return boardEl.children[row * config.cols + col];
}

// 开始计时
function startTimer() {
    timerInterval = setInterval(() => {
        timer++;
        timerEl.textContent = timer;
    }, 1000);
}

// 检查是否赢了
function checkWin() {
    const config = DIFFICULTY[currentDifficulty];
    let revealedCount = 0;
    
    for (let r = 0; r < config.rows; r++) {
        for (let c = 0; c < config.cols; c++) {
            if (revealed[r][c]) revealedCount++;
        }
    }
    
    const totalCells = config.rows * config.cols;
    if (revealedCount === totalCells - config.mines) {
        endGame(true);
    }
}

// 结束游戏
function endGame(won) {
    gameOver = true;
    clearInterval(timerInterval);
    
    if (won) {
        messageEl.textContent = '🎉 恭喜你赢了！太棒了！';
        messageEl.className = 'message win';
    } else {
        messageEl.textContent = '💥 游戏结束！再试一次吧～';
        messageEl.className = 'message lose';
    }
}

// 切换操作模式
function setMode(mode) {
    currentMode = mode;
    if (mode === 'click') {
        modeClickBtn.classList.add('active');
        modeFlagBtn.classList.remove('active', 'flag-mode');
    } else {
        modeClickBtn.classList.remove('active');
        modeFlagBtn.classList.add('active', 'flag-mode');
    }
}

// 事件监听
newGameBtn.addEventListener('click', initGame);
difficultySelect.addEventListener('change', (e) => {
    currentDifficulty = e.target.value;
    initGame();
});
modeClickBtn.addEventListener('click', () => setMode('click'));
modeFlagBtn.addEventListener('click', () => setMode('flag'));

// 启动游戏
initGame();
