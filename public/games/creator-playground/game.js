// 欢迎，小小架构师！让我们来建造贪吃蛇游戏吧！

// ================= 第一步：准备所有“储物盒”和“小帮手” =================
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreElement = document.getElementById('score');
const gameStatusElement = document.getElementById('gameStatus');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');

// 游戏的重要设置
const gridSize = 20; // 游戏网格每一格的大小（像素）
const tileCount = canvas.width / gridSize; // 网格一行/一列有多少格（20格）

// 小蛇的“储物盒”
let snake = [
    { x: 10, y: 10 } // 小蛇的起始位置（身体的第一节，也就是蛇头）
];
// 注意：我们用数组来记录小蛇每一节身体的坐标。第一项是头，最后一项是尾巴。

// 苹果的位置
let apple = { x: 15, y: 15 };

// 小蛇当前要往哪个方向走？
let direction = { x: 0, y: 0 }; // 一开始静止不动
// 记住上一次的方向，防止小蛇直接掉头（比如不能从左直接变成右）
let lastDirection = { x: 0, y: 0 };

// 游戏状态
let score = 0;
let gameRunning = false;
let gameLoopId = null; // 用来记住“复读机”的ID，方便我们停止它

// ================= 第二步：建造“自动机器”（函数） =================

// 1号机器：画游戏里的所有东西
function drawGame() {
    // 清空画布（擦掉上一次画的东西）
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 画小蛇
    ctx.fillStyle = '#00ff88'; // 蛇头颜色
    // 先画蛇头
    ctx.fillRect(snake[0].x * gridSize, snake[0].y * gridSize, gridSize - 2, gridSize - 2);
    // 画蛇身（从第二节开始）
    ctx.fillStyle = '#00cc66'; // 蛇身颜色
    for (let i = 1; i < snake.length; i++) {
        ctx.fillRect(snake[i].x * gridSize, snake[i].y * gridSize, gridSize - 2, gridSize - 2);
    }

    // 画苹果
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.arc(
        apple.x * gridSize + gridSize / 2, // 苹果中心的X坐标
        apple.y * gridSize + gridSize / 2, // 苹果中心的Y坐标
        gridSize / 2 - 2, // 半径
        0,
        Math.PI * 2
    );
    ctx.fill();

    // 画网格线（让游戏看起来更整齐）
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= tileCount; i++) {
        // 竖线
        ctx.beginPath();
        ctx.moveTo(i * gridSize, 0);
        ctx.lineTo(i * gridSize, canvas.height);
        ctx.stroke();
        // 横线
        ctx.beginPath();
        ctx.moveTo(0, i * gridSize);
        ctx.lineTo(canvas.width, i * gridSize);
        ctx.stroke();
    }
}

// 2号机器：移动小蛇
function moveSnake() {
    // 如果没有方向，小蛇就不动
    if (direction.x === 0 && direction.y === 0) return;

    // 根据方向，计算新的蛇头位置
    const head = { x: snake[0].x + direction.x, y: snake[0].y + direction.y };
    // 把新的蛇头加到身体数组的最前面
    snake.unshift(head);

    // 检查有没有吃到苹果
    if (head.x === apple.x && head.y === apple.y) {
        // 吃到苹果了！分数增加，并在屏幕上随机放一个新的苹果
        score += 10;
        scoreElement.textContent = score;
        gameStatusElement.textContent = `太棒了！吃到苹果了！分数：${score}`;
        createApple();
    } else {
        // 没吃到苹果，就移除最后一节身体（保持长度不变）
        snake.pop();
    }

    // 记住这次的方向，防止下次直接反向
    lastDirection = { ...direction };
}

// 3号机器：检查游戏是否结束
function checkGameOver() {
    const head = snake[0];

    // 情况1：撞到墙壁
    if (
        head.x < 0 ||
        head.x >= tileCount ||
        head.y < 0 ||
        head.y >= tileCount
    ) {
        return true;
    }

    // 情况2：撞到自己（从第二节身体开始检查）
    for (let i = 1; i < snake.length; i++) {
        if (head.x === snake[i].x && head.y === snake[i].y) {
            return true;
        }
    }

    return false; // 游戏继续
}

// 4号机器：生成一个新的苹果
function createApple() {
    // 随机找一个位置
    let newApple;
    let appleOnSnake;
    do {
        appleOnSnake = false;
        newApple = {
            x: Math.floor(Math.random() * tileCount),
            y: Math.floor(Math.random() * tileCount)
        };
        // 检查这个位置是不是刚好在小蛇身上
        for (let segment of snake) {
            if (segment.x === newApple.x && segment.y === newApple.y) {
                appleOnSnake = true;
                break;
            }
        }
    } while (appleOnSnake); // 如果苹果在小蛇身上，就重新找位置

    apple = newApple;
}

// 5号机器：游戏主循环（最重要的“复读机”）
function gameLoop() {
    moveSnake(); // 移动小蛇

    if (checkGameOver()) {
        // 游戏结束
        gameOver();
        return;
    }

    drawGame(); // 重新画画面
    gameLoopId = requestAnimationFrame(gameLoop); // 告诉浏览器，过一会儿再运行一次这个函数
}

// 6号机器：游戏结束的处理
function gameOver() {
    gameRunning = false;
    gameStatusElement.textContent = `游戏结束！最终分数：${score}。点击“重新开始”再玩一次！`;
    gameStatusElement.style.backgroundColor = 'rgba(255, 68, 68, 0.2)';
    gameStatusElement.style.borderColor = '#ff4444';
    cancelAnimationFrame(gameLoopId); // 停止“复读机”
}

// 7号机器：重置游戏
function resetGame() {
    snake = [{ x: 10, y: 10 }];
    direction = { x: 0, y: 0 };
    lastDirection = { x: 0, y: 0 };
    score = 0;
    scoreElement.textContent = score;
    apple = { x: 15, y: 15 };
    gameRunning = false;
    gameStatusElement.textContent = '游戏已重置，点击“开始游戏”吧！';
    gameStatusElement.style.backgroundColor = 'rgba(0, 255, 136, 0.15)';
    gameStatusElement.style.borderColor = '#00ff88';
    drawGame(); // 画初始状态
    if (gameLoopId) {
        cancelAnimationFrame(gameLoopId);
    }
}

// ================= 第三步：连接“控制台”（事件监听） =================

// 监听键盘按键，控制方向
window.addEventListener('keydown', (e) => {
    // 防止按键滚动页面
    if ([37, 38, 39, 40].includes(e.keyCode)) {
        e.preventDefault();
    }

    // 根据按下的键设置方向
    switch (e.key) {
        case 'ArrowUp':
            if (lastDirection.y !== 1) { // 不能从向下直接变成向上
                direction = { x: 0, y: -1 };
            }
            break;
        case 'ArrowDown':
            if (lastDirection.y !== -1) { // 不能从向上直接变成向下
                direction = { x: 0, y: 1 };
            }
            break;
        case 'ArrowLeft':
            if (lastDirection.x !== 1) { // 不能从向右直接变成向左
                direction = { x: -1, y: 0 };
            }
            break;
        case 'ArrowRight':
            if (lastDirection.x !== -1) { // 不能从左直接变成右
                direction = { x: 1, y: 0 };
            }
            break;
    }
});

// 开始游戏按钮
startBtn.addEventListener('click', () => {
    if (!gameRunning) {
        gameRunning = true;
        gameStatusElement.textContent = '游戏开始！控制小蛇吃苹果吧！';
        // 如果小蛇还没动，给它一个初始方向（向右）
        if (direction.x === 0 && direction.y === 0) {
            direction = { x: 1, y: 0 };
        }
        gameLoop(); // 启动“复读机”
    }
});

// 暂停游戏按钮
pauseBtn.addEventListener('click', () => {
    if (gameRunning) {
        gameRunning = false;
        cancelAnimationFrame(gameLoopId);
        gameStatusElement.textContent = '游戏已暂停。点击“开始游戏”继续。';
    }
});

// 重新开始按钮
resetBtn.addEventListener('click', resetGame);

// ================= 第四步：游戏启动！ =================
// 一开始先画一次画面
resetGame();