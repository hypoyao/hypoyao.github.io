-- Neon Postgres 初始化：creators + games
-- 说明：
-- 1) 使用文本 slug 作为主键（便于 URL 绑定）
-- 2) 图片使用相对路径（适配不同域名/环境）

begin;

-- 创作者表
create table if not exists creators (
  id text primary key,                -- 例如 'haibo'
  name text not null,                 -- 展示名
  avatar_url text not null,           -- 例如 '/assets/avatars/yaohaibo.svg'
  profile_path text not null,         -- 例如 '/creators/haibo'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 小游戏表
create table if not exists games (
  id text primary key,                -- 例如 'ttt'
  title text not null,
  short_desc text not null,
  rule_text text not null,
  cover_url text not null,            -- 例如 '/assets/screenshots/ttt.png'
  path text not null unique,          -- 例如 '/games/ttt/'
  creator_id text not null references creators(id) on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- === Seed 数据：creators ===
insert into creators (id, name, avatar_url, profile_path)
values
  ('haibo',   '海波', '/assets/avatars/yaohaibo.svg',   '/creators/haibo'),
  ('tianqing','天晴', '/assets/avatars/yaotianjing.svg','/creators/tianqing')
on conflict (id) do update set
  name = excluded.name,
  avatar_url = excluded.avatar_url,
  profile_path = excluded.profile_path,
  updated_at = now();

-- === Seed 数据：games ===
insert into games (id, title, short_desc, rule_text, cover_url, path, creator_id)
values
  (
    'ttt',
    '井字棋对决',
    '3 子上限版井字棋，对战 AI',
    '规则：两人轮流落子；每人最多 3 子；当你落下第 4 子时，会移除你最早落下的那颗；三子连成一线获胜。',
    '/assets/screenshots/ttt.png',
    '/games/ttt/',
    'haibo'
  ),
  (
    'memory',
    '记忆闪击',
    '看亮起顺序依次点击，连胜晋级',
    '规则：系统会按顺序亮起几个方块；你需要按亮起顺序依次点击。',
    '/assets/screenshots/memory.png',
    '/games/memory/',
    'haibo'
  ),
  (
    'mole',
    '极速打地鼠',
    '30 秒计时，速度越来越快',
    '规则：红色方块（地鼠）每 1 秒换到随机位置；你需要在 1 秒内点到它。点中后会立刻换位置。',
    '/assets/screenshots/mole.png',
    '/games/mole/',
    'tianqing'
  ),
  (
    'gomoku',
    '五子棋·限五子',
    '您 vs AI，第 6 子会顶掉最早那颗',
    '规则：8×8 棋盘。您（×）对战 AI（○）。每方最多同时存在 5 颗子；当你要下第 6 颗时，最早那颗会先变浅，落子后它会消失。连成 5 颗即获胜。',
    '/assets/screenshots/gomoku.png',
    '/games/gomoku/',
    'tianqing'
  ),
  (
    'sudoku',
    '数独乐园',
    '填数字闯关：成功晋级，失败退级',
    '规则：每行/每列/每个 3×3 宫格内，数字 1-9 不能重复。填满并正确则晋级，提交错误则退级。',
    '/assets/screenshots/sudoku.png',
    '/games/sudoku/',
    'tianqing'
  ),
  (
    'chess',
    '国际象棋·新手友好版',
    '标准国际象棋：您执白对战 AI（支持 AI 提示）',
    '规则：标准国际象棋。您执白对战 AI 执黑。点您的棋子会提示走法并高亮可走范围。支持 AI 提示。',
    '/assets/screenshots/chess.png',
    '/games/chess/',
    'tianqing'
  ),
  (
    'xiangqi',
    '中国象棋·新手友好版',
    '中国象棋：您（红）对战 AI（黑）（支持 AI 提示）',
    '规则：您（红方）先手对战 AI（黑方）。胜利难度 +1，失败难度 -1。支持 AI 提示。',
    '/assets/screenshots/xiangqi.png',
    '/games/xiangqi/',
    'tianqing'
  ),
  (
    'weiqi',
    '围棋·新手友好版',
    '围棋 9×9：您（黑）对战 AI（白）（支持 AI 提示）',
    '规则：您（黑）先手对战 AI（白）。双方连续 Pass 后数目判胜负；胜利难度 +1，失败难度 -1。支持 AI 提示。',
    '/assets/screenshots/weiqi.png',
    '/games/weiqi/',
    'tianqing'
  )
on conflict (id) do update set
  title = excluded.title,
  short_desc = excluded.short_desc,
  rule_text = excluded.rule_text,
  cover_url = excluded.cover_url,
  path = excluded.path,
  creator_id = excluded.creator_id,
  updated_at = now();

commit;
