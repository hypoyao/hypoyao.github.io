// 贪吃小猫打地鼠 - 游戏魔法脚本
// 小小建筑师，我们来编写游戏逻辑吧！

// 游戏状态储物盒
const gameState = {
    score: 0,
    timeLeft: 60,
    isPlaying: false,
    soundOn: true,
    difficulty: 'easy', // easy, medium, hard
    activeHoles: new Set(), // 正在显示小猫的洞洞编号
    gameTimer: null, // 游戏倒计时器
    catTimer: null   // 小猫弹出定时器
};

// 获取屏幕上的元素
const scoreElement = document.getElementById('score');
const timeElement = document.getElementById('time');
const difficultyElement = document.getElementById('difficulty');
const messageElement = document.getElementById('message');
const hammerElement = document.getElementById('hammer');
const holes = document.querySelectorAll('.hole');
const cats = document.querySelectorAll('.cat');

// 声音元素
const hitSound = document.getElementById('hitSound');
const missSound = document.getElementById('missSound');
const bgMusic = document.getElementById('bgMusic');

// 按钮元素
const startBtn = document.getElementById('start');
const resetBtn = document.getElementById('reset');
const soundBtn = document.getElementById('sound');
const difficultyBtns = document.querySelectorAll('.difficulty-btn');

// 难度设置（小猫出现的时间，单位：毫秒）
const difficultySettings = {
    easy: { showTime: 1500, interval: 1000 },
    medium: { showTime: 1000, interval: 800 },
    hard: { showTime: 600, interval: 600 }
};

// 🎮 游戏开始函数
function startGame() {
    if (gameState.isPlaying) return;
    
    // 重置游戏状态
    gameState.score = 0;
    gameState.timeLeft = 60;
    gameState.isPlaying = true;
    gameState.activeHoles.clear();
    
    // 更新显示
    updateDisplay();
    messageElement.textContent = '游戏开始！快打小猫！';
    messageElement.style.color = '#d84315';
    
    // 播放背景音乐
    if (gameState.soundOn) {
        bgMusic.currentTime = 0;
        bgMusic.play().catch(e => console.log('音乐播放被阻止：', e));
    }
    
    // 开始游戏倒计时
    gameState.gameTimer = setInterval(() => {
        gameState.timeLeft--;
        updateDisplay();
        
        if (gameState.timeLeft <= 0) {
            endGame();
        }
    }, 1000);
    
    // 开始让小猫随机弹出
    startCatTimer();
}

// 🐱 开始小猫弹出定时器
function startCatTimer() {
    if (gameState.catTimer) clearInterval(gameState.catTimer);
    
    const settings = difficultySettings[gameState.difficulty];
    
    gameState.catTimer = setInterval(() => {
        if (!gameState.isPlaying) return;
        
        // 随机选择一个洞洞（0-8号）
        let randomHole;
        do {
            randomHole = Math.floor(Math.random() * 9);
        } while (gameState.activeHoles.has(randomHole) && gameState.activeHoles.size < 9);
        
        // 让小猫从洞里探出头
        showCat(randomHole);
        
        // 设定小猫躲起来的时间
        setTimeout(() => {
            hideCat(randomHole);
            // 如果漏掉小猫，扣分
            if (gameState.activeHoles.has(randomHole)) {
                gameState.score = Math.max(0, gameState.score - 5);
                updateDisplay();
                if (gameState.soundOn) missSound.play();
                messageElement.textContent = '哎呀！小猫溜走了！-5分';
            }
        }, settings.showTime);
        
    }, settings.interval);
}

// 🐾 显示小猫
function showCat(holeIndex) {
    gameState.activeHoles.add(holeIndex);
    cats[holeIndex].classList.add('up');
}

// 🐾 隐藏小猫
function hideCat(holeIndex) {
    gameState.activeHoles.delete(holeIndex);
    cats[holeIndex].classList.remove('up');
}

// 🎯 打中小猫
function hitCat(holeIndex) {
    if (!gameState.isPlaying || !gameState.activeHoles.has(holeIndex)) return;
    
    // 加分
    gameState.score += 10;
    updateDisplay();
    
    // 播放击中音效
    if (gameState.soundOn) {
        hitSound.currentTime = 0;
        hitSound.play();
    }
    
    // 隐藏小猫
    hideCat(holeIndex);
    
    // 显示鼓励消息
    const messages = [
        '太棒了！+10分',
        '打中了！好厉害！',
        '完美一击！',
        '小猫逃不掉了！',
        '你是打猫小能手！'
    ];
    messageElement.textContent = messages[Math.floor(Math.random() * messages.length)];
    
    // 锤子敲击动画
    hammerElement.style.transform = 'rotate(-30deg)';
    setTimeout(() => {
        hammerElement.style.transform = 'rotate(0deg)';
    }, 100);
}

// 🏁 游戏结束
function endGame() {
    gameState.isPlaying = false;
    clearInterval(gameState.gameTimer);
    clearInterval(gameState.catTimer);
    
    // 隐藏所有小猫
    gameState.activeHoles.forEach(holeIndex => {
        hideCat(holeIndex);
    });
    
    // 停止音乐
    bgMusic.pause();
    
    // 显示最终得分
    let message = `时间到！最终得分：${gameState.score}`;
    if (gameState.score >= 300) {
        message += ' 👑 你是打猫王者！';
    } else if (gameState.score >= 200) {
        message += ' ⭐ 超级厉害！';
    } else if (gameState.score >= 100) {
        message += ' 👍 不错哦！';
    }
    
    messageElement.textContent = message;
}

// 📊 更新显示
function updateDisplay() {
    scoreElement.textContent = gameState.score;
    timeElement.textContent = gameState.timeLeft;
    difficultyElement.textContent = gameState.difficulty === 'easy' ? '简单' : 
                                   gameState.difficulty === 'medium' ? '中等' : '困难';
}

// 🎵 切换声音
function toggleSound() {
    gameState.soundOn = !gameState.soundOn;
    soundBtn.innerHTML = gameState.soundOn ? 
        '<i class="lucide lucide-volume-2"></i> 声音：开' : 
        '<i class="lucide lucide-volume-x"></i> 声音：关';
    
    if (!gameState.soundOn) {
        bgMusic.pause();
    } else if (gameState.isPlaying) {
        bgMusic.play().catch(e => console.log('音乐播放被阻止：', e));
    }
}

// ⚙️ 改变难度
function changeDifficulty(level) {
    if (gameState.isPlaying) {
        messageElement.textContent = '游戏进行中不能改难度哦！';
        return;
    }
    
    gameState.difficulty = level;
    difficultyElement.textContent = level === 'easy' ? '简单' : 
                                   level === 'medium' ? '中等' : '困难';
    
    // 更新按钮样式
    difficultyBtns.forEach(btn => {
        btn.classList.remove('active');
        if (btn.id === level) {
            btn.classList.add('active');
        }
    });
    
    messageElement.textContent = `难度已设置为：${level === 'easy' ? '简单' : level === 'medium' ? '中等' : '困难'}`;
}

// 🖱️ 鼠标移动时更新锤子位置
document.addEventListener('mousemove', (e) => {
    hammerElement.style.left = e.pageX - 25 + 'px';
    hammerElement.style.top = e.pageY - 25 + 'px';
});

// 🖱️ 鼠标点击时锤子敲击
document.addEventListener('mousedown', () => {
    hammerElement.style.transform = 'scale(0.9)';
});

document.addEventListener('mouseup', () => {
    hammerElement.style.transform = 'scale(1)';
});

// 🎮 给每个洞洞添加点击事件
holes.forEach((hole, index) => {
    hole.addEventListener('click', () => {
        hitCat(index);
    });
});

// 🎮 按钮事件
startBtn.addEventListener('click', startGame);

resetBtn.addEventListener('click', () => {
    if (gameState.isPlaying) {
        clearInterval(gameState.gameTimer);
        clearInterval(gameState.catTimer);
    }
    
    // 重置游戏
    gameState.score = 0;
    gameState.timeLeft = 60;
    gameState.isPlaying = false;
    gameState.activeHoles.clear();
    
    // 隐藏所有小猫
    cats.forEach(cat => cat.classList.remove('up'));
    
    // 停止音乐
    bgMusic.pause();
    
    // 更新显示
    updateDisplay();
    messageElement.textContent = '游戏已重置，点击开始游戏！';
});

soundBtn.addEventListener('click', toggleSound);

difficultyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        changeDifficulty(btn.id);
    });
});

// 🎯 游戏初始化
updateDisplay();
messageElement.textContent = '欢迎来到贪吃小猫打地鼠！选择难度后点击开始游戏！';

// 添加触摸屏支持（给手机和平板用）
if ('ontouchstart' in window) {
    holes.forEach((hole, index) => {
        hole.addEventListener('touchstart', (e) => {
            e.preventDefault();
            hitCat(index);
            // 触摸时锤子动画
            hammerElement.style.transform = 'scale(0.9)';
            setTimeout(() => {
                hammerElement.style.transform = 'scale(1)';
            }, 100);
        });
    });
    
    // 隐藏鼠标样式的锤子，改用触摸反馈
    hammerElement.style.display = 'none';
}

console.log('🎮 游戏加载完成！小小建筑师，开始你的表演吧！');