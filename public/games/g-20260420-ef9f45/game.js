// 游戏设置
const ROWS = 5;
const COLS = 5;
const COLORS = 6; // 6种颜色

// 游戏状态储物盒
let score = 0; // 分数储物盒
let selectedGem = null; // 当前选中的宝石
let board = []; // 游戏板储物盒
let isProcessing = false; // 防止重复点击
let hintTimeout = null; // 提示超时储物盒

// 抓取屏幕上的元素
const boardElement = document.getElementById('board');
const scoreElement = document.getElementById('score');
const hintButton = document.getElementById('hint-btn');

// 初始化游戏 - 游戏开始时的准备
function initGame() {
    score = 0;
    updateScore();
    createBoard();
    renderBoard();
    
    // 确保一开始就有可以匹配的
    while (!hasMatches()) {
        createBoard();
    }
}

// 创建游戏板 - 就像布置一个放宝石的架子
function createBoard() {
    board = [];
    for (let row = 0; row < ROWS; row++) {
        board[row] = [];
        for (let col = 0; col < COLS; col++) {
            // 随机给宝石涂上颜色（1-6号颜色）
            board[row][col] = Math.floor(Math.random() * COLORS) + 1;
        }
    }
}

// 渲染游戏板 - 把宝石画到屏幕上
function renderBoard() {
    boardElement.innerHTML = '';
    
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const gem = document.createElement('div');
            gem.className = `gem color-${board[row][col]}`;
            gem.dataset.row = row;
            gem.dataset.col = col;
            
            // 给宝石添加点击魔法
            gem.addEventListener('click', () => handleGemClick(row, col));
            
            boardElement.appendChild(gem);
        }
    }
}

// 处理宝石点击 - 就像指挥宝石跳舞
function handleGemClick(row, col) {
    if (isProcessing) return; // 如果正在处理，就不要重复点击
    
    const clickedGem = { row, col };
    
    // 如果没有选中的宝石，就选中当前点击的
    if (!selectedGem) {
        selectedGem = clickedGem;
        updateSelection();
        return;
    }
    
    // 如果点击的是同一个宝石，就取消选中
    if (selectedGem.row === row && selectedGem.col === col) {
        selectedGem = null;
        updateSelection();
        return;
    }
    
    // 检查两个宝石是不是邻居（上下左右相邻）
    const rowDiff = Math.abs(selectedGem.row - row);
    const colDiff = Math.abs(selectedGem.col - col);
    
    // 必须是相邻的宝石才能交换
    if ((rowDiff === 1 && colDiff === 0) || (rowDiff === 0 && colDiff === 1)) {
        // 交换宝石
        swapGems(selectedGem, clickedGem);
        
        // 检查是否有匹配
        const matches = checkMatches();
        
        if (matches.length > 0) {
            // 有匹配，处理消除
            processMatches(matches);
        } else {
            // 没有匹配，交换回来
            setTimeout(() => {
                swapGems(selectedGem, clickedGem);
                renderBoard();
                selectedGem = null;
                isProcessing = false;
            }, 300);
        }
        
        selectedGem = null;
    } else {
        // 如果不是邻居，就重新选择
        selectedGem = clickedGem;
        updateSelection();
    }
}

// 交换两个宝石 - 就像让两个小朋友换座位
function swapGems(gem1, gem2) {
    const temp = board[gem1.row][gem1.col];
    board[gem1.row][gem1.col] = board[gem2.row][gem2.col];
    board[gem2.row][gem2.col] = temp;
    renderBoard();
    updateSelection();
}

// 更新选中状态 - 让选中的宝石发光
function updateSelection() {
    // 移除所有宝石的选中状态
    document.querySelectorAll('.gem').forEach(gem => {
        gem.classList.remove('selected');
    });
    
    // 如果有选中的宝石，就让它发光
    if (selectedGem) {
        const selectedElement = document.querySelector(`.gem[data-row="${selectedGem.row}"][data-col="${selectedGem.col}"]`);
        if (selectedElement) {
            selectedElement.classList.add('selected');
        }
    }
}

// 检查匹配 - 找找有没有三个或更多相同颜色的宝石排排坐
function checkMatches() {
    const matches = [];
    
    // 检查水平方向
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS - 2; col++) {
            const color = board[row][col];
            if (color !== 0 && 
                board[row][col + 1] === color && 
                board[row][col + 2] === color) {
                
                // 找到至少三个一样的，继续找还有没有更多
                let endCol = col + 2;
                while (endCol + 1 < COLS && board[row][endCol + 1] === color) {
                    endCol++;
                }
                
                const match = [];
                for (let c = col; c <= endCol; c++) {
                    match.push({ row, col: c });
                }
                matches.push(match);
                
                col = endCol; // 跳过已经检查过的
            }
        }
    }
    
    // 检查垂直方向
    for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS - 2; row++) {
            const color = board[row][col];
            if (color !== 0 && 
                board[row + 1][col] === color && 
                board[row + 2][col] === color) {
                
                // 找到至少三个一样的，继续找还有没有更多
                let endRow = row + 2;
                while (endRow + 1 < ROWS && board[endRow + 1][col] === color) {
                    endRow++;
                }
                
                const match = [];
                for (let r = row; r <= endRow; r++) {
                    match.push({ row: r, col });
                }
                matches.push(match);
                
                row = endRow; // 跳过已经检查过的
            }
        }
    }
    
    return matches;
}

// 处理匹配 - 让匹配的宝石消失
function processMatches(matches) {
    isProcessing = true;
    
    // 计算分数
    matches.forEach(match => {
        score += match.length * 10; // 消除的宝石越多，分数越高
    });
    updateScore();
    
    // 标记要消除的宝石（设置为0）
    matches.forEach(match => {
        match.forEach(({ row, col }) => {
            board[row][col] = 0; // 0表示空位置
        });
    });
    
    renderBoard();
    
    // 等待一下，让玩家看到消除效果
    setTimeout(() => {
        // 让上面的宝石掉下来
        dropGems();
        
        // 补充新的宝石
        fillEmptySpaces();
        
        renderBoard();
        
        // 检查新的匹配（可能连锁反应）
        const newMatches = checkMatches();
        if (newMatches.length > 0) {
            // 继续消除
            setTimeout(() => processMatches(newMatches), 300);
        } else {
            isProcessing = false;
        }
    }, 500);
}

// 让宝石掉下来 - 就像坐滑梯
function dropGems() {
    for (let col = 0; col < COLS; col++) {
        let emptyRow = ROWS - 1;
        
        // 从下往上找空位置
        for (let row = ROWS - 1; row >= 0; row--) {
            if (board[row][col] !== 0) {
                // 如果不是空的，就把它掉到最下面的空位置
                if (row !== emptyRow) {
                    board[emptyRow][col] = board[row][col];
                    board[row][col] = 0;
                }
                emptyRow--;
            }
        }
    }
}

// 补充空位置 - 从天上掉下新的宝石
function fillEmptySpaces() {
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            if (board[row][col] === 0) {
                board[row][col] = Math.floor(Math.random() * COLORS) + 1;
            }
        }
    }
}

// 更新分数显示
function updateScore() {
    scoreElement.textContent = score;
}

// 检查游戏板是否有匹配
function hasMatches() {
    return checkMatches().length > 0;
}

// 查找提示 - 小侦探找可以交换的位置
function findHint() {
    // 先清除之前的提示
    clearHint();
    
    // 检查所有可能的相邻交换
    const directions = [
        { dr: 0, dc: 1 },  // 右
        { dr: 1, dc: 0 },  // 下
    ];
    
    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            for (const dir of directions) {
                const newRow = row + dir.dr;
                const newCol = col + dir.dc;
                
                if (newRow >= 0 && newRow < ROWS && newCol >= 0 && newCol < COLS) {
                    // 模拟交换
                    const temp = board[row][col];
                    board[row][col] = board[newRow][newCol];
                    board[newRow][newCol] = temp;
                    
                    // 检查是否有匹配
                    const matches = checkMatches();
                    
                    // 交换回来
                    board[newRow][newCol] = board[row][col];
                    board[row][col] = temp;
                    
                    // 如果有匹配，返回这两个位置作为提示
                    if (matches.length > 0) {
                        return [
                            { row, col },
                            { row: newRow, col: newCol }
                        ];
                    }
                }
            }
        }
    }
    
    return null; // 没有找到提示
}

// 显示提示
function showHint() {
    if (isProcessing) return;
    
    const hint = findHint();
    
    if (hint) {
        // 给提示的宝石添加特殊样式
        hint.forEach(({ row, col }) => {
            const gemElement = document.querySelector(`.gem[data-row="${row}"][data-col="${col}"]`);
            if (gemElement) {
                gemElement.classList.add('hint');
            }
        });
        
        // 3秒后清除提示
        hintTimeout = setTimeout(clearHint, 3000);
    } else {
        alert('太厉害了！现在没有可以交换的宝石了，刷新页面重新开始吧！');
    }
}

// 清除提示
function clearHint() {
    if (hintTimeout) {
        clearTimeout(hintTimeout);
        hintTimeout = null;
    }
    
    document.querySelectorAll('.gem').forEach(gem => {
        gem.classList.remove('hint');
    });
}

// 给提示按钮添加点击魔法
hintButton.addEventListener('click', showHint);

// 游戏开始！
initGame();