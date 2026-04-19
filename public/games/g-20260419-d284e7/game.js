// 贪吃蛇小游戏 - 小朋友版

// 获取画布和画笔
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// 游戏变量
let snake = [
    {x: 10, y: 10},
    {x: 9, y: 10},
    {x: 8, y: 10}
];
let food = {x: 15, y: 15};
let direction = {x: 1, y: 0}; // 初始向右移动
let score = 0;
let highScore = localStorage.getItem('snakeHighScore') || 0;
let gameRunning = true;
let gamePaused = false;
let gameLoop;

// 游戏格子大小
const gridSize = 20;
const gridWidth = canvas.width / gridSize;
const gridHeight = canvas.height / gridSize;

// 更新分数显示
function updateScore() {
    document.getElementById('score').textContent = score;
    document.getElementById('high-score').textContent = highScore;
}

// 生成随机食物位置
function generateFood() {
    // 找一个不在蛇身上的位置
    let newFood;
    let foodOnSnake;
    
    do {
        foodOnSnake = false;
        newFood = {
            x: Math.floor(Math.random() * gridWidth),
            y: Math.floor(Math.random() * gridHeight)
        };
        
        // 检查新食物是否在蛇身上
        for (let segment of snake) {
            if (segment.x === newFood.x && segment.y === newFood.y) {
                foodOnSnake = true;
                break;
            }
        }
    } while (foodOnSnake);
    
    food = newFood;
}

// 绘制游戏
function drawGame() {
    // 清空画布
    ctx.fillStyle = '#2C3E50';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 绘制网格线（浅色背景线）
    ctx.strokeStyle = '#34495E';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
    }
    
    // 绘制小蛇
    snake.forEach((segment, index) => {
        // 蛇头用不同颜色
        if (index === 0) {
            ctx.fillStyle = '#4ECDC4'; // 蛇头颜色
        } else {
            // 蛇身用渐变色
            const colorValue = 150 + (index % 5) * 20;
            ctx.fillStyle = `rgb(78, ${colorValue}, 196)`;
        }
        
        // 画圆角矩形
        const x = segment.x * gridSize;
        const y = segment.y * gridSize;
        const radius = 5;
        
        ctx.beginPath();
        ctx.roundRect(x, y, gridSize, gridSize, radius);
        ctx.fill();
        
        // 给蛇头画眼睛
        if (index === 0) {
            ctx.fillStyle = 'white';
            // 根据方向画眼睛
            let eye1X, eye1Y, eye2X, eye2Y;
            
            if (direction.x === 1) { // 向右
                eye1X = x + gridSize - 6;
                eye1Y = y + 6;
                eye2X = x + gridSize - 6;
                eye2Y = y + gridSize - 6;
            } else if (direction.x === -1) { // 向左
                eye1X = x + 6;
                eye1Y = y + 6;
                eye2X = x + 6;
                eye2Y = y + gridSize - 6;
            } else if (direction.y === 1) { // 向下
                eye1X = x + 6;
                eye1Y = y + gridSize - 6;
                eye2X = x + gridSize - 6;
                eye2Y = y + gridSize - 6;
            } else { // 向上
                eye1X = x + 6;
                eye1Y = y + 6;
                eye2X = x + gridSize - 6;
                eye2Y = y + 6;
            }
            
            ctx.beginPath();
            ctx.arc(eye1X, eye1Y, 3, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.beginPath();
            ctx.arc(eye2X, eye2Y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    });
    
    // 绘制食物（苹果）
    ctx.fillStyle = '#E74C3C';
    const foodX = food.x * gridSize;
    const foodY = food.y * gridSize;
    const foodRadius = gridSize / 2;
    
    // 画苹果主体
    ctx.beginPath();
    ctx.arc(foodX + foodRadius, foodY + foodRadius, foodRadius - 2, 0, Math.PI * 2);
    ctx.fill();
    
    // 画苹果柄
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(foodX + foodRadius - 1, foodY - 3, 2, 6);
    
    // 画苹果叶子
    ctx.fillStyle = '#27AE60';
    ctx.beginPath();
    ctx.ellipse(foodX + foodRadius + 5, foodY - 1, 4, 2, Math.PI/4, 0, Math.PI * 2);
    ctx.fill();
}

// 更新游戏状态
function updateGame() {
    if (!gameRunning || gamePaused) return;
    
    // 移动小蛇：创建新蛇头
    const head = {x: snake[0].x + direction.x, y: snake[0].y + direction.y};
    
    // 检查是否撞墙
    if (head.x < 0 || head.x >= gridWidth || head.y < 0 || head.y >= gridHeight) {
        gameOver();
        return;
    }
    
    // 检查是否撞到自己
    for (let segment of snake) {
        if (head.x === segment.x && head.y === segment.y) {
            gameOver();
            return;
        }
    }
    
    // 将新蛇头添加到蛇身前面
    snake.unshift(head);
    
    // 检查是否吃到食物
    if (head.x === food.x && head.y === food.y) {
        // 吃到食物，分数增加
        score += 10;
        if (score > highScore) {
            highScore = score;
            localStorage.setItem('snakeHighScore', highScore);
        }
        updateScore();
        
        // 播放吃食物的音效（视觉反馈）
        canvas.style.boxShadow = '0 0 20px #E74C3C';
        setTimeout(() => {
            canvas.style.boxShadow = '0 10px 20px rgba(0, 0, 0, 0.3)';
        }, 200);
        
        // 生成新食物
        generateFood();
    } else {
        // 没吃到食物，移除蛇尾
        snake.pop();
    }
    
    // 重绘游戏
    drawGame();
}

// 游戏结束
function gameOver() {
    gameRunning = false;
    clearInterval(gameLoop);
    
    // 显示游戏结束信息
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#FF6B6B';
    ctx.font = 'bold 40px "Comic Neue", cursive';
    ctx.textAlign = 'center';
    ctx.fillText('游戏结束!', canvas.width/2, canvas.height/2 - 30);
    
    ctx.fillStyle = 'white';
    ctx.font = '30px "Comic Neue", cursive';
    ctx.fillText(`得分: ${score}`, canvas.width/2, canvas.height/2 + 30);
    
    ctx.fillStyle = '#FFD700';
    ctx.font = '25px "Comic Neue", cursive';
    ctx.fillText('点击重新开始按钮继续', canvas.width/2, canvas.height/2 + 80);
}

// 开始游戏
function startGame() {
    if (gameLoop) clearInterval(gameLoop);
    
    // 重置游戏状态
    snake = [
        {x: 10, y: 10},
        {x: 9, y: 10},
        {x: 8, y: 10}
    ];
    direction = {x: 1, y: 0};
    score = 0;
    gameRunning = true;
    gamePaused = false;
    
    // 生成食物
    generateFood();
    
    // 更新分数显示
    updateScore();
    
    // 开始游戏循环
    gameLoop = setInterval(updateGame, 150);
    
    // 重绘画布
    drawGame();
    
    // 让画布获得焦点，确保键盘控制有效
    canvas.focus();
}

// 暂停/继续游戏
function togglePause() {
    if (!gameRunning) return;
    
    gamePaused = !gamePaused;
    
    const pauseBtn = document.getElementById('pause-btn');
    if (gamePaused) {
        pauseBtn.innerHTML = '<i class="fas fa-play"></i> 继续游戏';
        pauseBtn.classList.remove('pause-btn');
        pauseBtn.classList.add('play-btn');
        
        // 显示暂停信息
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = '#FF9800';
        ctx.font = 'bold 40px "Comic Neue", cursive';
        ctx.textAlign = 'center';
        ctx.fillText('游戏暂停', canvas.width/2, canvas.height/2);
    } else {
        pauseBtn.innerHTML = '<i class="fas fa-pause"></i> 暂停游戏';
        pauseBtn.classList.remove('play-btn');
        pauseBtn.classList.add('pause-btn');
        
        // 重绘游戏
        drawGame();
    }
}

// 键盘控制 - 修复了方向键滚动页面的问题！
canvas.addEventListener('keydown', (event) => {
    // 修复bug的关键：告诉浏览器这些方向键是我们游戏专用的！
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); // 这行代码就是“按键锁”
    }
    
    // 改变方向（不能直接反向移动）
    switch(event.key) {
        case 'ArrowUp':
            if (direction.y !== 1) { // 不能从向下直接变为向上
                direction = {x: 0, y: -1};
            }
            break;
        case 'ArrowDown':
            if (direction.y !== -1) { // 不能从向上直接变为向下
                direction = {x: 0, y: 1};
            }
            break;
        case 'ArrowLeft':
            if (direction.x !== 1) { // 不能从向右直接变为向左
                direction = {x: -1, y: 0};
            }
            break;
        case 'ArrowRight':
            if (direction.x !== -1) { // 不能从左直接变为右
                direction = {x: 1, y: 0};
            }
            break;
    }
});

// 按钮控制（为移动设备设计）
document.getElementById('up-btn').addEventListener('click', () => {
    if (direction.y !== 1) {
        direction = {x: 0, y: -1};
    }
});

document.getElementById('down-btn').addEventListener('click', () => {
    if (direction.y !== -1) {
        direction = {x: 0, y: 1};
    }
});

document.getElementById('left-btn').addEventListener('click', () => {
    if (direction.x !== 1) {
        direction = {x: -1, y: 0};
    }
});

document.getElementById('right-btn').addEventListener('click', () => {
    if (direction.x !== -1) {
        direction = {x: 1, y: 0};
    }
});

// 游戏控制按钮
document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('restart-btn').addEventListener('click', startGame);

// 页面加载时开始游戏
window.addEventListener('load', () => {
    updateScore();
    startGame();
});