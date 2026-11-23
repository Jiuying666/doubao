/**
 * ============================================================
 * 豆包社区 - 后端服务器 v2.0（Node.js 单文件）
 * ============================================================
 * v2 新增：
 *   - 帖子系统：发帖/浏览/点赞/评论/置顶/热门排序/板块分类
 *   - 经验等级：Lv5=50000 经验；每日热度前5帖子作者+1000；评论≥15字+10
 *   - 用户资料：随机ID、头像上传、昵称/头像一周最多改2次
 *   - 管理后台：封号、禁言、调整豆包币、置顶/删帖（第一个注册的用户自动成为社区主）
 *   - 聊天室接入禁言/封号校验
 *
 * 接口总览：
 *   POST /api/register  注册（第一人自动成为社区主）
 *   POST /api/login     登录（封号用户拒绝）
 *   POST /api/me        我的最新资料
 *   POST /api/upload    上传图片 → {url}
 *   POST /api/post/create      发帖 {token, boardId, title, content, images[]}
 *   POST /api/post/list        帖子列表 {boardId, sort: all|new|hot|likes}
 *   POST /api/post/detail      帖子详情（观看数+1）{id}
 *   POST /api/post/like        点赞/取消点赞 {token, id}
 *   POST /api/post/comment     评论 {token, id, content}
 *   POST /api/my/likes         我点赞过的帖子 {token}
 *   POST /api/user/update_avatar    改头像 {token, avatar}
 *   POST /api/user/update_nickname  改昵称 {token, nickname}
 *   POST /api/admin/users      用户列表（管理）
 *   POST /api/admin/ban        封号/解封 {token, userId, banned}
 *   POST /api/admin/mute       禁言 {token, userId, minutes}
 *   POST /api/admin/coins      设置豆包币 {token, userId, coins}
 *   POST /api/admin/pin        置顶/取消置顶 {token, postId, pinned}
 *   POST /api/admin/delete_post 删帖 {token, postId}
 *   GET  /api/stats     在线人数/总用户
 *   WS   /ws            聊天室（文字/表情/图片 + 禁言校验）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ============ 经验/等级配置（想调数值改这里） ============ */
const LEVEL_EXP = [0, 3000, 12000, 25000, 50000]; // Lv1~Lv5 所需累计经验
const EXP_POST = 20;          // 发一篇帖子 +20
const EXP_COMMENT = 10;       // 评论≥15字 +10
const EXP_TOP5_DAILY = 1000;  // 每日热度前5帖子作者 +1000
const CHANGE_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // 昵称/头像冷却周期：7天
const CHANGE_MAX_PER_WEEK = 2;                   // 7天内最多改2次

/* ★ 社区主进入管理后台的特定密码（只有你知道！上线后建议改掉） */
const ADMIN_PASSWORD = 'doubao666';

/* 审核通过给板块主加的经验 */
const EXP_AUDIT = 30;
/* 头衔最长字数 */
const TITLE_MAX = 8;
/* 每日签到 +20；当月签满全部天数再 +200 */
const EXP_CHECKIN = 20;
const EXP_CHECKIN_MONTH_FULL = 200;

/* ★ 公告（后台可改）；clientDismiss 保存“今日不再弹”的用户 */
const NOTICE_DEFAULT = {
  title: '欢迎来到豆包社区',
  content: '本社区刚开张，大家可以聊天、发帖、点赞～\n遇到问题找社区主！',
  enabled: true,
  showOnce: true,   // true=只在打开 App 时弹一次
  ts: Date.now(),
};

/* ==================== 数据库 ==================== */
let db = { users: [], msgs: [], posts: [], meta: { adminId: null, pending: {} } };
try {
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (Array.isArray(parsed.users)) db.users = parsed.users;
  if (Array.isArray(parsed.msgs)) db.msgs = parsed.msgs;
  if (Array.isArray(parsed.posts)) db.posts = parsed.posts;
  if (parsed.meta) db.meta = parsed.meta;
} catch (e) { }
let dirty = false;

// 兼容 v1 老数据：库里还没有社区主时，把最早注册的用户设为社区主
if (!db.meta.adminId && db.users.length > 0) {
  db.meta.adminId = db.users.slice().sort((a, b) => (a.created || 0) - (b.created || 0))[0].id;
  dirty = true;
  console.log('[社区主] 已将最早注册的用户 ID:' + db.meta.adminId + ' 设为社区主');
}

// ★ 社区主 ID 固定 100001：如果库里还没人用 100001，就把最早注册的人改成 100001
//   （帖子/评论/点赞/关注里的旧 ID 会一起同步，不会断）
if (db.users.length > 0 && !db.users.some(u => u.id === 100001)) {
  const first = db.users.slice().sort((a, b) => (a.created || 0) - (b.created || 0))[0];
  const oldId = first.id;
  first.id = 100001;
  if (db.meta.adminId === oldId) db.meta.adminId = 100001;
  db.posts.forEach(p => {
    if (p.userId === oldId) p.userId = 100001;
    if (Array.isArray(p.likes)) p.likes = p.likes.map(x => (x === oldId ? 100001 : x));
    if (Array.isArray(p.comments)) p.comments.forEach(c => { if (c.userId === oldId) c.userId = 100001; });
  });
  db.users.forEach(u => {
    if (Array.isArray(u.following)) u.following = u.following.map(x => (x === oldId ? 100001 : x));
    if (Array.isArray(u.followers)) u.followers = u.followers.map(x => (x === oldId ? 100001 : x));
  });
  dirty = true;
  console.log('[迁移] 已把最早注册的用户', first.nickname, 'ID从', oldId, '改为 100001');
}

// 老数据补字段：自定义头衔 / 关注粉丝是否公开 / 待审核帖子队列
// ★ 这样更新代码重启，老用户的头衔、关注、帖子都不会丢
 db.users.forEach(u => {
  if (typeof u.title !== 'string') u.title = '';
  if (typeof u.listVisible !== 'boolean') u.listVisible = false; // 默认别人不能看粉丝/关注列表
  if (!Array.isArray(u.pendingPosts)) u.pendingPosts = [];      // 兼容旧字段
  if (!Array.isArray(u.boards)) u.boards = [];
  if (!u.checkins || typeof u.checkins !== 'object') u.checkins = {}; // 签到记录
  // ★ v3 新增字段
  if (!Array.isArray(u.notifications)) u.notifications = [];
  if (!Array.isArray(u.favorites)) u.favorites = [];
  if (!Array.isArray(u.ownedItems)) u.ownedItems = [];
  if (!u.equipped || typeof u.equipped !== 'object') u.equipped = {};
  if (typeof u.nameColor !== 'string') u.nameColor = '';
  if (!Array.isArray(u.signDays)) u.signDays = [];
  if (typeof u.popularity !== 'number') u.popularity = 0;   // ★ 人气值（收礼物增加）
  if (!u.giftStats || typeof u.giftStats !== 'object') u.giftStats = {}; // ★ 收到的礼物聚合
});
if (!db.meta.pending || typeof db.meta.pending !== 'object') db.meta.pending = {};
if (!Array.isArray(db.moments)) db.moments = [];   // ★ v3 社区动态
if (typeof db.meta.musicEnabled !== 'boolean') db.meta.musicEnabled = true;
// 老帖子补 pending=false（以前发的都算已审核）
db.posts.forEach(p => { if (typeof p.pending !== 'boolean') p.pending = false; });

function saveDb() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    dirty = false;
    // ★ 同时存一份到 /tmp 备份，Render 免费版重启有时 data 目录会被重置
    //   启动时如果主库丢了，就从备份拉回来，用户不白注册
    try {
      fs.writeFileSync('/tmp/doubao-db-backup.json', JSON.stringify(db));
      fs.mkdirSync(path.join('/tmp', 'doubao-up-backup'), { recursive: true });
    } catch (ignored) { }
    // 防抖触发一次 GitHub 备份（配了 token 才生效）
    scheduleGithubBackup();
  } catch (e) { console.error('保存失败:', e.message); }
}
// 启动恢复：主库空/丢失但 /tmp 备份还在 → 用备份
try {
  if ((!fs.existsSync(DB_FILE) || JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).users?.length === 0)
      && fs.existsSync('/tmp/doubao-db-backup.json')) {
    const bak = JSON.parse(fs.readFileSync('/tmp/doubao-db-backup.json', 'utf8'));
    if (Array.isArray(bak.users) && bak.users.length > 0) {
      db = bak;
      console.log('[备份恢复] 从 /tmp 拉回用户', db.users.length, '人，帖子', (db.posts || []).length, '条');
    }
  }
} catch (ignored) { }
setInterval(saveDb, 10000);
process.on('SIGTERM', () => { dirty = true; saveDb(); process.exit(0); });
process.on('SIGINT', () => { dirty = true; saveDb(); process.exit(0); });

/* ★ 每 30 分钟把数据库和图片打包备份到 GitHub（如果配了 GITHUB_TOKEN）
 * Render 免费版重启会清空磁盘，这是唯一能留住用户数据的办法。
 * 需要在 Render 环境变量里填：
 *   GITHUB_TOKEN = GitHub Personal Access Token（repo 权限）
 *   GITHUB_REPO  = Jiuying666/doubao
 * 没填 token 就跳过备份，不影响运行。
 */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Jiuying666/doubao';
const GH_DB_PATH = 'backup/db.json';

function ghRequest(method, ghPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = require('https').request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${ghPath}`,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'doubao-server',
        'Accept': 'application/vnd.github+json',
      },
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, json: d ? JSON.parse(d) : null }); }
        catch (e) { resolve({ status: r.statusCode, json: null }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 数据量用于判断哪份备份更新（用户/帖子/消息越多越新）
function dbSize(d) {
  if (!d) return 0;
  return (d.users || []).length + (d.posts || []).length + (d.msgs || []).length;
}

async function backupToGithub() {
  if (!GITHUB_TOKEN) return;
  try {
    saveDb();
    const buf = fs.readFileSync(DB_FILE);
    // 先取已有文件的 sha：GitHub 更新已存在文件必须带 sha，否则 422
    let sha = null;
    const got = await ghRequest('GET', GH_DB_PATH, null);
    if (got.status === 200 && got.json && got.json.sha) sha = got.json.sha;
    const body = {
      message: 'auto backup ' + new Date().toISOString(),
      content: buf.toString('base64'),
    };
    if (sha) body.sha = sha;
    const res = await ghRequest('PUT', GH_DB_PATH, body);
    if (res.status >= 200 && res.status < 300) console.log('[备份] db.json 已传到 GitHub');
    else console.log('[备份] GitHub 返回', res.status, res.json && res.json.message);
  } catch (e) { console.log('[备份失败]', e.message); }
}

// 防抖：写库后 60 秒内只备一次，避免频繁打 GitHub
let ghBackupTimer = null;
function scheduleGithubBackup() {
  if (!GITHUB_TOKEN) return;
  if (ghBackupTimer) return;
  ghBackupTimer = setTimeout(() => { ghBackupTimer = null; backupToGithub(); }, 60 * 1000);
}

// 启动后 30 秒先备一次，之后每 5 分钟一次
setTimeout(backupToGithub, 30 * 1000);
setInterval(backupToGithub, 5 * 60 * 1000);

// 启动恢复 GitHub 备份（比 /tmp 更可靠）：环境变量没配就跳过
// 规则：本地库为空，或 GitHub 备份的数据量不小于本地时，采用 GitHub 备份
if (GITHUB_TOKEN) {
  ghRequest('GET', GH_DB_PATH, null).then(got => {
    try {
      if (got.status === 200 && got.json && got.json.content) {
        const json = JSON.parse(Buffer.from(got.json.content, 'base64').toString('utf8'));
        if (Array.isArray(json.users) && json.users.length > 0 && dbSize(json) >= dbSize(db)) {
          db = json;
          console.log('[备份恢复] 从 GitHub 拉回用户', db.users.length, '人，帖子', (db.posts || []).length, '条');
        }
      }
    } catch (ignored) { }
  }).catch(() => { });
}

/* ==================== 工具函数 ==================== */
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hashPassword(p) { return sha256('doubao-salt-2026::' + p); }
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

/** 随机用户ID：6位数（100000~999999），不重复；第一个注册的用户固定 100001 */
function nextUserId() {
  // ★ 社区主永远是 100001
  if (db.users.length === 0) return 100001;
  for (let i = 0; i < 999; i++) {
    const id = 100000 + Math.floor(Math.random() * 900000);
    if (id !== 100001 && !db.users.some(u => u.id === id)) return id;
  }
  return Date.now() % 900000 + 100000;
}

function findUserByToken(token) {
  if (!token) return null;
  return db.users.find(u => u.token === token) || null;
}
function findUserById(id) { return db.users.find(u => u.id === Number(id)) || null; }
function isAdmin(u) { return db.meta.adminId === u.id; }

/** 是否板块主（管理指定板块的帖子） */
function isBoardMaster(u, boardId) {
  return (u.boards || []).includes(String(boardId));
}
/** 可以管理这个帖子吗？社区主任何帖子都行；板块主只能管自己板块 */
function canManagePost(u, p) { return isAdmin(u) || isBoardMaster(u, p.boardId); }

/** 实时统计用户帖子数（以 db.posts 为准，避免冗余计数与实际列表脱节） */
function countUserPosts(userId) {
  return db.posts.filter(p => p.userId === userId).length;
}

/** 对外输出的用户信息（不含密码） */
/** 收到的礼物聚合（数组，按数量降序） */
function giftStatsOf(u) {
  const stats = (u && u.giftStats) || {};
  return Object.keys(stats).map(id => {
    const g = stats[id] || {};
    return { id, name: g.name || '', emoji: g.emoji || '', price: g.price || 0,
      popularity: g.popularity || 0, count: g.count || 0 };
  }).sort((a, b) => b.count - a.count);
}

/** 收到礼物总件数 */
function giftCountOf(u) {
  return giftStatsOf(u).reduce((s, g) => s + g.count, 0);
}

function publicUser(u) {
  return {
    id: u.id, nickname: u.nickname, phone: u.phone || '',
    avatar: u.avatar || '', coins: u.coins || 0,
    followers: Array.isArray(u.followers) ? u.followers.length : (u.followers || 0),
    following: Array.isArray(u.following) ? u.following.length : (u.following || 0),
    posts: countUserPosts(u.id), exp: u.exp || 0,
    banned: !!u.banned, mutedUntil: u.mutedUntil || 0,
    isAdmin: isAdmin(u), bio: u.bio || '', bg: u.bg || '',
    boards: u.boards || [],
    title: u.title || '',            // ★ 自定义头衔（社区主授予；空=用等级名）
    nameColor: u.nameColor || '',     // ★ v3 名字颜色（商城道具，预留）
    collects: Array.isArray(u.favorites) ? u.favorites.length : 0,
    signStreak: calcStreak(u),        // ★ v3 连续签到天数
    listVisible: !!u.listVisible,    // ★ 粉丝/关注列表是否对别人公开
    checkinToday: !!(u.checkins && u.checkins[new Date().toISOString().slice(0, 10)]),
    checkinMonth: u.checkins ? Object.keys(u.checkins).filter(d => d.startsWith(new Date().toISOString().slice(0, 7))).length : 0,
    nameChanges: (u.nameChanges || []).length,
    avatarChanges: (u.avatarChanges || []).length,
    popularity: u.popularity || 0,    // ★ 人气值
    giftCount: giftCountOf(u),
    gifts: giftStatsOf(u),
  };
}

/** 7天内改过几次 */
function changesInWeek(arr) {
  const weekAgo = Date.now() - CHANGE_COOLDOWN_MS;
  return (arr || []).filter(t => t > weekAgo).length;
}

/** 帖子热度 = 观看 + 点赞×5 + 评论×10 */
function heat(p) { return (p.views || 0) + (p.likes || []).length * 5 + (p.comments || []).length * 10; }

/** 帖子摘要（列表用） */
function postSummary(p, viewer) {
  const u = findUserById(p.userId);
  return {
    id: p.id, boardId: p.boardId, title: p.title,
    preview: (p.content || '').slice(0, 120),
    imageCount: (p.images || []).length, firstImage: (p.images || [])[0] || '',
    videos: p.videos || [],
    userId: p.userId, nickname: p.nickname, avatar: p.avatar || '',
    exp: u ? u.exp || 0 : 0,
    authorTitle: u ? u.title || '' : '',
    isAdmin: u ? isAdmin(u) : false,
    boards: u ? (u.boards || []) : [],
    ts: p.ts, views: p.views || 0,
    likes: (p.likes || []).length, comments: (p.comments || []).length,
    collects: (p.collects || []).length, shares: p.shares || 0,
    boardName: boardNameOf(p.boardId),
    likedByMe: (viewer && viewer.id) ? (p.likes || []).includes(viewer.id) : false,
    collectedByMe: (viewer && viewer.id) ? (p.collects || []).includes(viewer.id) : false,
    pinned: !!p.pinned, heat: heat(p),
    pending: !!p.pending,
  };
}


/* ============================================================
 * ★ v3.0 新增能力：通知 / 动态 / 收藏 / 商城 / 排行榜 / 壁纸
 * ============================================================ */

/** 壁纸库：启动页随机抽一张（想换壁纸就改这里，加 https 直链即可） */
const WALLPAPERS = [
  'https://t.alcy.cc/ycy',
  'https://api.dujin.org/bing/1920.php',
  'https://api.paugram.com/wallpaper/',
  'https://www.dmoe.cc/random.php',
  'https://api.btstu.cn/sjbz/api.php?lx=dongman&format=images',
  'https://api.vvhan.com/api/wallpaper/views',
  'https://loliapi.com/acg/pe',
  'https://picsum.photos/1080/1920?random=11',
  'https://picsum.photos/1080/1920?random=23',
  'https://picsum.photos/1080/1920?random=37',
  'https://picsum.photos/1080/1920?random=51',
  'https://picsum.photos/1080/1920?random=68',
];

/** 板块名（帖子列表要给客户端显示中文板块名） */
const BOARD_NAMES = {
  gg: 'GG修改器', andlua: 'AndLua', ai: 'AI 大模型',
  chat: '闲聊灌水', share: '资源分享', dev: '开发交流',
};
function boardNameOf(id) { return BOARD_NAMES[id] || (id ? String(id) : '综合'); }

/** 商城商品：想加商品照着写。type=title 头衔（会真正生效） / bg 背景标识 / name_color 名字颜色 */
const SHOP_ITEMS = [
  { id: 'title_chi', name: '吃瓜群众', desc: '存在感很强的头衔，聊天时挂在名字后面', type: 'title', value: '吃瓜群众', price: 200, color: 0xFF6E5BFF },
  { id: 'title_fox', name: '小狐狸', desc: '软乎乎的头衔，适合卖萌', type: 'title', value: '小狐狸', price: 300, color: 0xFFFF8A5B },
  { id: 'title_dev', name: '技术大佬', desc: '发教程、答疑专用头衔', type: 'title', value: '技术大佬', price: 800, color: 0xFF38BDF8 },
  { id: 'title_creator', name: '内容创作者', desc: '持续输出好内容的人', type: 'title', value: '内容创作者', price: 1200, color: 0xFF22C7A9 },
  { id: 'title_night', name: '夜猫子', desc: '凌晨三点还在线的证明', type: 'title', value: '夜猫子', price: 1500, color: 0xFF8E6FF7 },
  { id: 'title_food', name: '干饭第一名', desc: '社区最会吃的干饭王', type: 'title', value: '干饭第一名', price: 1800, color: 0xFFFFB020 },
  { id: 'title_light', name: '社区之光', desc: '限量大头衔，走在社区最前面', type: 'title', value: '社区之光', price: 5000, color: 0xFFFF5F9E },
  { id: 'title_boss', name: '豆包股东', desc: '最贵头衔，纯纯排面', type: 'title', value: '豆包股东', price: 8000, color: 0xFFFF5C6C },
];

/* ============ 礼物目录（价格便宜到贵；price=豆包币，popularity=增加的人气值，tier=特效等级） ============ */
const GIFT_ITEMS = [
  { id: 'candy',  name: '糖果', emoji: '🍬', price: 5,   popularity: 1,   tier: 1 },
  { id: 'rose',   name: '玫瑰', emoji: '🌹', price: 20,  popularity: 3,   tier: 1 },
  { id: 'beer',   name: '啤酒', emoji: '🍺', price: 40,  popularity: 6,   tier: 1 },
  { id: 'bear',   name: '玩偶', emoji: '🧸', price: 80,  popularity: 12,  tier: 2 },
  { id: 'cake',   name: '蛋糕', emoji: '🎂', price: 150, popularity: 22,  tier: 2 },
  { id: 'rocket', name: '火箭', emoji: '🚀', price: 300, popularity: 45,  tier: 3 },
  { id: 'crown',  name: '皇冠', emoji: '👑', price: 888, popularity: 100, tier: 3 },
];

/** 给用户加一条通知（每人最多保留 200 条，最新的在前） */
function notify(toUserId, type, title, text, fromUser, postId) {
  const target = findUserById(toUserId);
  if (!target) return;
  if (fromUser && target.id === fromUser.id) return;   // 自己操作自己不提醒
  target.notifications = Array.isArray(target.notifications) ? target.notifications : [];
  target.notifications.unshift({
    id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: String(type || 'sys'),
    title: String(title || '').slice(0, 40),
    text: String(text || '').slice(0, 120),
    postId: postId || '',
    fromId: fromUser ? fromUser.id : 0,
    fromName: fromUser ? fromUser.nickname : '',
    fromAvatar: fromUser ? (fromUser.avatar || '') : '',
    ts: Date.now(),
    read: false,
  });
  if (target.notifications.length > 200) target.notifications.length = 200;
  dirty = true;
}

/** 连续签到天数（今天没签就从昨天往前算） */
function calcStreak(u) {
  const ck = (u && u.checkins) ? u.checkins : {};
  let day = Date.now();
  const todayKey = new Date(day).toISOString().slice(0, 10);
  if (!ck[todayKey]) day -= 86400000;
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const key = new Date(day - i * 86400000).toISOString().slice(0, 10);
    if (ck[key]) streak++; else break;
  }
  return streak;
}

/** 动态摘要（朋友圈式） */
function momentSummary(m, viewer) {
  return {
    id: m.id, userId: m.userId, nickname: m.nickname,
    avatar: m.avatar || '', text: m.text || '', images: m.images || [],
    ts: m.ts, likes: (m.likes || []).length,
    likedByMe: viewer ? (m.likes || []).includes(viewer.id) : false,
    commentCount: (m.comments || []).length,
    comments: (m.comments || []).slice(-3).map(c => ({
      nickname: c.nickname, content: c.content, ts: c.ts,
    })),
  };
}

/** 求某个商品是否已被当前用户使用 */
function itemEquipped(u, item) {
  const eq = u.equipped || {};
  return eq[item.type] === item.id;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ==================== 全局通知（公告 / 音乐开关 / 版本） ==================== */
let notice = Object.assign({}, NOTICE_DEFAULT);
try {
  if (db.meta.notice) notice = Object.assign({}, NOTICE_DEFAULT, db.meta.notice);
} catch (e) { }

/* ★ 悬浮窗音乐列表：把你的歌曲外链放进来（mp3 直链），App 会随机播放 */
const MUSIC_LIST = [
  { name: '起风了', url: 'https://music.163.com/song/media/outer/url?id=1330348068.mp3' },
  { name: '倔强', url: 'https://music.163.com/song/media/outer/url?id=98271.mp3' },
  { name: '消愁', url: 'https://music.163.com/song/media/outer/url?id=5264842.mp3' },
  { name: '像我这样的人', url: 'https://music.163.com/song/media/outer/url?id=5264847.mp3' },
  { name: '成都', url: 'https://music.163.com/song/media/outer/url?id=436514312.mp3' },
  { name: '理想', url: 'https://music.163.com/song/media/outer/url?id=31708189.mp3' },
  { name: '山海', url: 'https://music.163.com/song/media/outer/url?id=411315197.mp3' },
  { name: '岁月神偷', url: 'https://music.163.com/song/media/outer/url?id=5264848.mp3' },
  { name: '全世界谁倾听你', url: 'https://music.163.com/song/media/outer/url?id=441491537.mp3' },
  { name: '青花瓷', url: 'https://music.163.com/song/media/outer/url?id=185866.mp3' },
  { name: '听妈妈的话', url: 'https://music.163.com/song/media/outer/url?id=185864.mp3' },
  { name: '等你下课', url: 'https://music.163.com/song/media/outer/url?id=5264845.mp3' },
  { name: 'Mojito', url: 'https://music.163.com/song/media/outer/url?id=1444781749.mp3' },
  { name: '遇见', url: 'https://music.163.com/song/media/outer/url?id=531041776.mp3' },
  { name: '告白之夜', url: 'https://music.163.com/song/media/outer/url?id=5264849.mp3' },
  { name: '知足', url: 'https://music.163.com/song/media/outer/url?id=98275.mp3' },
  { name: '画', url: 'https://music.163.com/song/media/outer/url?id=5264844.mp3' },
  { name: '海阔天空', url: 'https://music.163.com/song/media/outer/url?id=22335158.mp3' },
  { name: '光辉岁月', url: 'https://music.163.com/song/media/outer/url?id=188604.mp3' },
  { name: '真的爱你', url: 'https://music.163.com/song/media/outer/url?id=188605.mp3' },
  { name: '喜欢你', url: 'https://music.163.com/song/media/outer/url?id=188606.mp3' },
  { name: '红日', url: 'https://music.163.com/song/media/outer/url?id=188607.mp3' },
  { name: '李香兰', url: 'https://music.163.com/song/media/outer/url?id=188608.mp3' },
  { name: '一生所爱', url: 'https://music.163.com/song/media/outer/url?id=188611.mp3' },
  { name: '当年情', url: 'https://music.163.com/song/media/outer/url?id=188612.mp3' },
  { name: '沉默是金', url: 'https://music.163.com/song/media/outer/url?id=188614.mp3' },
  { name: '甜蜜蜜', url: 'https://music.163.com/song/media/outer/url?id=188617.mp3' },
  { name: '我只在乎你', url: 'https://music.163.com/song/media/outer/url?id=188618.mp3' },
  { name: '漫步人生路', url: 'https://music.163.com/song/media/outer/url?id=188619.mp3' },
];
let musicEnabled = true; // 后台可开可关，存 db.meta.musicEnabled，重启不丢

/* ==================== 每日经验结算（热度前5） ==================== */
let lastExpDay = new Date().toISOString().slice(0, 10);
function dailyExpJob() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastExpDay) return;
  lastExpDay = today;
  // 昨天热度前5的帖子，作者 +1000 经验（每帖每天只结算一次）
  const top = db.posts.slice().sort((a, b) => heat(b) - heat(a)).slice(0, 5);
  top.forEach(p => {
    if (p.lastExpDay === today) return;
    p.lastExpDay = today;
    const u = findUserById(p.userId);
    if (u && !u.banned) {
      u.exp = (u.exp || 0) + EXP_TOP5_DAILY;
      dirty = true;
      console.log('[经验结算]', u.nickname, '的帖子进入热度前5, +', EXP_TOP5_DAILY, '经验');
    }
  });
  if (top.length) dirty = true;
}
setInterval(dailyExpJob, 60 * 1000); // 每分钟检查一次日期变化

/* ==================== HTTP 服务 ==================== */
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const method = req.method || 'GET';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* ---- 首页状态页 ---- */
  if (method === 'GET' && (urlPath === '/' || urlPath === '/api')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>豆包社区服务器</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:60px auto;color:#1F2430">
  <h1>豆包 🫛 服务器运行中 (v3.0)</h1>
  <p>✅ 服务正常 | 在线 <b>${authedClients()}</b> | 用户 <b>${db.users.length}</b> | 消息 <b>${db.msgs.length}</b> | 帖子 <b>${db.posts.length}</b></p>
</body></html>`);
    return;
  }

  if (method === 'GET' && urlPath === '/api/stats') {
    return send(res, 200, { ok: true, data: stats() });
  }

  /* ---- 公告 + 音乐列表（首次打开 App 弹窗用） ---- */
  if (method === 'GET' && urlPath === '/api/global') {
    return send(res, 200, {
      ok: true,
      data: {
        notice: {
          title: notice.title, content: notice.content,
          enabled: !!notice.enabled, showOnce: !!notice.showOnce, ts: notice.ts || 0,
        },
        music: (typeof db.meta.musicEnabled === 'boolean' ? db.meta.musicEnabled : musicEnabled) ? MUSIC_LIST : [],
      },
    });
  }

  /* ---- 注册 ---- */
  if (method === 'POST' && urlPath === '/api/register') {
    return readJson(req, (body, err) => {
      if (err) return send(res, 400, { ok: false, msg: '请求格式错误' });
      const nickname = String(body.nickname || '').trim();
      const phone = String(body.phone || '').trim();
      const password = String(body.password || '');
      if (!/^1\d{10}$/.test(phone))
        return send(res, 400, { ok: false, msg: '请输入正确的 11 位手机号' });
      if (nickname.length < 2 || nickname.length > 12)
        return send(res, 400, { ok: false, msg: '昵称要 2-12 个字' });
      if (password.length < 6)
        return send(res, 400, { ok: false, msg: '密码至少 6 位' });
      if (db.users.some(u => u.nickname === nickname))
        return send(res, 400, { ok: false, msg: '这个昵称已被占用' });
      if (db.users.some(u => u.phone === phone))
        return send(res, 400, { ok: false, msg: '这个手机号已注册过' });

      const user = {
        id: nextUserId(),          // ★ 第一个注册=100001，后面随机6位
        nickname, phone,
        pass: hashPassword(password),
        coins: 100, followers: 0, following: 0, posts: 0,
        exp: 0,                    // 经验值（等级由它决定）
        avatar: '',                // 头像图片地址
        nameChanges: [], avatarChanges: [],  // 修改记录（限频用）
        banned: false, mutedUntil: 0,
        token: makeToken(), created: Date.now(),
        bio: '', bg: '',                   // 个人简介 / 主页背景图
        boards: [],                        // 该用户管理的板块 id 列表（板块主）
        title: '',                         // 自定义头衔（社区主授予，空=显示等级名）
        listVisible: false,                // 粉丝/关注列表默认别人不可见
        checkins: {},                      // 签到记录 { '2026-11-23': true }
      };
      db.users.push(user);
      // ★ 第一个注册的用户自动成为社区主（管理员）
      if (!db.meta.adminId) { db.meta.adminId = user.id; console.log('[社区主]', user.nickname, 'ID:' + user.id); }
      dirty = true;
      console.log('[注册]', nickname, 'ID:' + user.id);
      return send(res, 200, { ok: true, msg: '注册成功', data: { token: user.token, user: publicUser(user) } });
    });
  }

  /* ---- 登录 ---- */
  if (method === 'POST' && urlPath === '/api/login') {
    return readJson(req, (body, err) => {
      if (err) return send(res, 400, { ok: false, msg: '请求格式错误' });
      const account = String(body.account || '').trim();
      // 登录仅支持手机号
      const u = db.users.find(x => x.phone && x.phone === account);
      if (!u)
        return send(res, 404, { ok: false, msg: '没有此账号，请先注册' });
      if (u.pass !== hashPassword(String(body.password || '')))
        return send(res, 400, { ok: false, msg: '账号或密码不对' });
      if (u.banned)
        return send(res, 403, { ok: false, msg: '该账号已被封禁，如有疑问联系社区主' });
      u.token = makeToken();
      dirty = true;
      console.log('[登录]', u.nickname);
      return send(res, 200, { ok: true, msg: '登录成功', data: { token: u.token, user: publicUser(u) } });
    });
  }

  /* ---- 我的资料 ---- */
  if (method === 'POST' && urlPath === '/api/me') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      return send(res, 200, { ok: true, data: { user: publicUser(u) } });
    });
  }

  /* ---- 每日签到 ----
   * 一天只能签一次 +20 经验；当月每天签到成功后额外 +200
   */
  if (method === 'POST' && urlPath === '/api/checkin') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (!u.checkins || typeof u.checkins !== 'object') u.checkins = {};
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      if (u.checkins[today])
        return send(res, 400, { ok: false, msg: '今天已经签过啦，明天再来' });
      u.checkins[today] = true;
      u.exp = (u.exp || 0) + EXP_CHECKIN;
      u.coins = (u.coins || 0) + 10;              // ★ v3：签到也发 10 豆包币
      u.signDays = Array.isArray(u.signDays) ? u.signDays : [];
      u.signDays.push(today);
      if (u.signDays.length > 90) u.signDays = u.signDays.slice(-90);
      let extra = 0;
      // 当月天数：按 UTC 月份（ISO 字符串同款）
      const ym = today.slice(0, 7);
      const daysInMonth = new Date(Date.UTC(
        Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
      const signed = Object.keys(u.checkins).filter(d => d.startsWith(ym)).length;
      if (signed >= daysInMonth) {
        extra = EXP_CHECKIN_MONTH_FULL;
        u.exp += extra;
      }
      // ★ v3：连签满 7 天额外 +100 豆包币
      const streakNow = calcStreak(u);
      let bonusCoin = 0;
      if (streakNow > 0 && streakNow % 7 === 0) {
        bonusCoin = 100;
        u.coins = (u.coins || 0) + bonusCoin;
      }
      u.signStreak = streakNow;
      dirty = true;
      console.log('[签到]', u.nickname, today, '+', EXP_CHECKIN, extra ? ('月满+' + extra) : '');
      return send(res, 200, {
        ok: true,
        msg: extra > 0
          ? ('签到成功，经验 +' + EXP_CHECKIN + '，本月全勤再 +' + extra + '！')
          : ('签到成功，经验 +' + EXP_CHECKIN),
        data: { user: publicUser(u), extra, streak: calcStreak(u), bonusCoin },
      });
    });
  }

  /* ---- 上传图片 / 视频 / 文件 ---- */
  const UPLOAD_EXTS = /^\.(png|jpe?g|gif|webp|mp4|3gp|webm|mov|m4v|apk|zip|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|mp3|aac|ogg|json|xml|bin)$/;
  if (method === 'POST' && urlPath === '/api/upload') {
    return readBody(req, (buf, err) => {
      if (err) return send(res, 413, { ok: false, msg: '文件太大（上限 30MB）' });
      const part = extractMultipartFile(buf, req.headers['content-type'] || '');
      if (!part) return send(res, 400, { ok: false, msg: '上传格式错误' });
      // 后缀：优先用文件名里的；没有就用 Content-Type 猜；仍不支持则拒绝
      let ext = (path.extname(part.filename || '') || '').toLowerCase();
      if (!UPLOAD_EXTS.test(ext)) {
        const ct = (part.contentType || '').toLowerCase();
        if (ct.includes('mp4') || ct.includes('video')) ext = '.mp4';
        else if (ct.includes('png')) ext = '.png';
        else if (ct.includes('gif')) ext = '.gif';
        else if (ct.includes('webp')) ext = '.webp';
        else if (ct.includes('apk') || ct.includes('package-archive')) ext = '.apk';
        else if (ct.includes('rar')) ext = '.rar';
        else if (ct.includes('7z')) ext = '.7z';
        else if (ct.includes('zip') || ct.includes('compressed')) ext = '.zip';
        else if (ct.includes('pdf')) ext = '.pdf';
        else if (ct.includes('msword') || ct.includes('word')) ext = '.doc';
        else if (ct.includes('excel') || ct.includes('sheet')) ext = '.xls';
        else if (ct.includes('presentation') || ct.includes('slides')) ext = '.ppt';
        else if (ct.includes('mpeg') || ct.includes('mp3')) ext = '.mp3';
        else if (ct.includes('aac')) ext = '.aac';
        else if (ct.includes('json')) ext = '.json';
        else if (ct.includes('text')) ext = '.txt';
        else ext = '';
      }
      if (!UPLOAD_EXTS.test(ext)) return send(res, 400, { ok: false, msg: '暂不支持这种文件类型' });
      const name = Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + ext;
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), part.body);
      console.log('[上传]', name, part.body.length, 'bytes', part.filename);
      return send(res, 200, { ok: true, msg: '上传成功', data: { url: '/files/' + name } });
    }, 30 * 1024 * 1024);
  }

  /* ---- 访问图片 / 视频 / 文件 ---- */
  if (method === 'GET' && urlPath.startsWith('/files/')) {
    const name = path.basename(urlPath);
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const mimeMap = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.mp4': 'video/mp4', '.3gp': 'video/3gpp', '.webm': 'video/webm',
      '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
      '.apk': 'application/vnd.android.package-archive',
      '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
    };
    res.writeHead(200, { 'Content-Type': mimeMap[path.extname(name)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }

  /* ==================== 帖子系统 ==================== */

  // 发帖
  if (method === 'POST' && urlPath === '/api/post/create') {
    return readJson(req, (body, err) => {
      if (err) return send(res, 400, { ok: false, msg: '请求格式错误' });
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (u.banned) return send(res, 403, { ok: false, msg: '你已被封禁，无法发帖' });
      if ((u.mutedUntil || 0) > Date.now())
        return send(res, 403, { ok: false, msg: '你被禁言至 ' + new Date(u.mutedUntil).toLocaleString('zh-CN') });
      const title = String(body.title || '').trim();
      const content = String(body.content || '').trim();
      const boardId = String(body.boardId || '').trim().slice(0, 30);
      const images = Array.isArray(body.images) ? body.images.slice(0, 3).filter(x => /^\/files\/[\w.-]+$/.test(x)) : [];
      const videos = Array.isArray(body.videos) ? body.videos.slice(0, 1).filter(x => /^\/files\/[\w.-]+$/.test(x)) : [];
      const files = Array.isArray(body.files) ? body.files.slice(0, 3).filter(f => f && /^\/files\/[\w.-]+$/.test(f.url)).map(f => ({
        url: String(f.url), name: String(f.name || '附件').slice(0, 60),
        mime: String(f.mime || ''), size: Number(f.size) || 0,
      })) : [];
      if (title.length < 1 || title.length > 50) return send(res, 400, { ok: false, msg: '标题要 1-50 个字' });
      if (content.length > 5000) return send(res, 400, { ok: false, msg: '内容太长了（上限5000字）' });
      if (!boardId) return send(res, 400, { ok: false, msg: '缺少板块' });
      const post = {
        id: 'p' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        boardId, title, content, images, videos, files,
        userId: u.id, nickname: u.nickname, avatar: u.avatar || '',
        ts: Date.now(), views: 0, likes: [], comments: [], pinned: false, lastExpDay: null,
        pending: true,          // ★ 默认进待审核区，板块主/社区主审核通过后才对大家展示
      };
      db.posts.unshift(post);
      // 待审核队列（重启也不丢）
      db.meta.pending = db.meta.pending || {};
      db.meta.pending[boardId] = Array.isArray(db.meta.pending[boardId]) ? db.meta.pending[boardId] : [];
      if (!db.meta.pending[boardId].includes(post.id)) db.meta.pending[boardId].unshift(post.id);
      dirty = true;
      console.log('[发帖·待审]', u.nickname, '→', boardId, ':', title);
      return send(res, 200, { ok: true, msg: '发布成功，等待板块主审核', data: { post: postSummary(post) } });
    });
  }

  // 帖子列表（sort: all全部 | new最新 | hot热门(点击量) | likes最多点赞）
  if (method === 'POST' && urlPath === '/api/post/list') {
    return readJson(req, (body) => {
      const boardId = String(body.boardId || '');
      const me = findUserByToken(body.token);
      let list = db.posts.filter(p => {
        if (boardId && p.boardId !== boardId) return false;
        if (!p.pending) return true;
        // 待审核帖：只有社区主/该板块板块主/作者自己能刷出来
        if (!me) return false;
        return me.id === p.userId || canManagePost(me, p);
      });
      const sort = String(body.sort || 'all');
      if (sort === 'new') list.sort((a, b) => b.ts - a.ts);
      else if (sort === 'hot') list.sort((a, b) => (b.views || 0) - (a.views || 0));
      else if (sort === 'likes') list.sort((a, b) => (b.likes || []).length - (a.likes || []).length);
      else list.sort((a, b) => b.ts - a.ts);
      // 置顶帖永远排最前
      const pinned = list.filter(p => p.pinned);
      const normal = list.filter(p => !p.pinned);
      return send(res, 200, { ok: true, data: { posts: pinned.concat(normal).slice(0, 100).map(postSummary), total: list.length } });
    });
  }

  // 帖子详情（观看数+1；带 token 时返回“我是否已点赞”）
  if (method === 'POST' && urlPath === '/api/post/detail') {
    return readJson(req, (body) => {
      const p = db.posts.find(x => x.id === body.id);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在或已被删除' });
      const viewer = findUserByToken(body.token);
      if (p.pending && !viewer) return send(res, 404, { ok: false, msg: '帖子审核中' });
      if (p.pending && !(viewer.id === p.userId || canManagePost(viewer, p)))
        return send(res, 404, { ok: false, msg: '帖子审核中' });
      p.views = (p.views || 0) + 1;
      dirty = true;
      const u = findUserById(p.userId);
      const me = findUserByToken(body.token); // 可选：用来标记点赞状态
      return send(res, 200, {
        ok: true,
        data: {
          post: {
            id: p.id, boardId: p.boardId, title: p.title, content: p.content,
            images: p.images || [], videos: p.videos || [], files: p.files || [], userId: p.userId, nickname: p.nickname,
            avatar: p.avatar || '', exp: u ? u.exp || 0 : 0, ts: p.ts,
            views: p.views, likes: (p.likes || []).length,
            collects: (p.collects || []).length, shares: p.shares || 0,
            boardName: boardNameOf(p.boardId),
            likedByMe: me ? (p.likes || []).includes(me.id) : false,
            collectedByMe: me ? (p.collects || []).includes(me.id) : false,
            followingAuthor: (me && u) ? (u.followers || []).includes(me.id) : false,
            authorTitle: u ? (u.title || '') : '',
            isAdmin: u ? isAdmin(u) : false,
            boards: u ? (u.boards || []) : [],
            comments: (p.comments || []).map(c => ({
              id: c.id, userId: c.userId, nickname: c.nickname,
              avatar: c.avatar || '', exp: (() => { const cu = findUserById(c.userId); return cu ? cu.exp || 0 : 0; })(),
              content: c.content, images: c.images || [], reply: c.reply || null, ts: c.ts,
            })),
            pinned: !!p.pinned,
          }
        }
      });
    });
  }

  // 点赞 / 取消点赞
  if (method === 'POST' && urlPath === '/api/post/like') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const p = db.posts.find(x => x.id === body.id);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      p.likes = p.likes || [];
      const idx = p.likes.indexOf(u.id);
      if (idx >= 0) { p.likes.splice(idx, 1); dirty = true; return send(res, 200, { ok: true, msg: '已取消点赞', data: { liked: false, likes: p.likes.length } }); }
      p.likes.push(u.id);
      dirty = true;
      notify(p.userId, 'like', '收到一个赞',
        u.nickname + ' 赞了你的帖子《' + (p.title || '') + '》', u, p.id);
      return send(res, 200, { ok: true, msg: '点赞成功', data: { liked: true, likes: p.likes.length } });
    });
  }

  // 评论
  if (method === 'POST' && urlPath === '/api/post/comment') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (u.banned) return send(res, 403, { ok: false, msg: '你已被封禁' });
      if ((u.mutedUntil || 0) > Date.now())
        return send(res, 403, { ok: false, msg: '你被禁言至 ' + new Date(u.mutedUntil).toLocaleString('zh-CN') });
      const p = db.posts.find(x => x.id === body.id);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      const content = String(body.content || '').trim().slice(0, 1000);
      const images = Array.isArray(body.images)
        ? body.images.filter(x => /^\/files\/[\w.-]+$/.test(x)).slice(0, 1) : [];
      if (!content && images.length === 0) return send(res, 400, { ok: false, msg: '评论不能为空' });
      // 回复某条评论
      let reply = null;
      const replyToId = String(body.replyToId || '');
      if (replyToId) {
        const rc = (p.comments || []).find(c => c.id === replyToId);
        if (rc) reply = { id: rc.id, nickname: rc.nickname, userId: rc.userId };
      }
      p.comments = p.comments || [];
      p.comments.push({
        id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
        userId: u.id, nickname: u.nickname, avatar: u.avatar || '',
        content, images, reply, ts: Date.now(),
      });
      const notifyText = content || '发了一张图片';
      notify(p.userId, 'comment', '收到一条评论',
        u.nickname + ' 评论了《' + (p.title || '') + '》：' + notifyText.slice(0, 40), u, p.id);
      // ★ 评论≥15字 +10 经验
      if (content.length >= 15) u.exp = (u.exp || 0) + EXP_COMMENT;
      dirty = true;
      return send(res, 200, { ok: true, msg: '评论成功' });
    });
  }

  // 我点赞过的帖子
  if (method === 'POST' && urlPath === '/api/my/likes') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const list = db.posts.filter(p => (p.likes || []).includes(u.id))
        .sort((a, b) => b.ts - a.ts).map(postSummary);
      return send(res, 200, { ok: true, data: { posts: list } });
    });
  }

  /* ==================== 资料修改（一周限2次） ==================== */

  /* ---- 别人主页（点头像进入） ---- */
  if (method === 'POST' && urlPath === '/api/user/profile') {
    return readJson(req, (body) => {
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      const me = findUserByToken(body.token);
      const isSelf = me && me.id === t.id;
      const canSeeList = isSelf || isAdmin(t) || !!t.listVisible; // 默认别人不可见
      // TA 发过的帖子（最新的在前，最多 20 条；待审核的不给别人看）
      const visiblePosts = db.posts.filter(p => p.userId === t.id && (!p.pending || (me && (me.id === t.id || canManagePost(me, p)))))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
      const myPosts = visiblePosts.slice(0, 20).map(postSummary);
      const listUser = (x) => {
        const u = findUserById(x);
        return u ? { id: u.id, nickname: u.nickname, avatar: u.avatar || '', exp: u.exp || 0, title: u.title || '' } : null;
      };
      return send(res, 200, {
        ok: true,
        data: {
          user: {
            id: t.id, nickname: t.nickname, avatar: t.avatar || '',
            bio: t.bio || '', bg: t.bg || '', coins: t.coins || 0,
            followers: t.followers || 0, following: t.following || 0,
            posts: visiblePosts.length, exp: t.exp || 0,
            isAdmin: isAdmin(t), banned: !!t.banned,
            title: t.title || '', listVisible: !!t.listVisible,
            popularity: t.popularity || 0, giftCount: giftCountOf(t), gifts: giftStatsOf(t),
          },
          following: me ? (t.followers || []).includes(me.id) : false,
          posts: myPosts,
          canSeeList,
          followers: canSeeList ? (t.followers || []).map(listUser).filter(Boolean) : [],
          followingList: canSeeList ? (t.following || []).map(listUser).filter(Boolean) : [],
        },
      });
    });
  }

  /* ---- 修改我的简介 / 主页背景 ---- */
  if (method === 'POST' && urlPath === '/api/user/update_profile') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (typeof body.bio === 'string') u.bio = body.bio.trim().slice(0, 100);
      if (typeof body.bg === 'string' && (body.bg === '' || /^\/files\/[\w.-]+$/.test(body.bg))) u.bg = body.bg;
      if (typeof body.listVisible === 'boolean') u.listVisible = body.listVisible; // 别人能否看我的粉丝/关注
      dirty = true;
      return send(res, 200, { ok: true, msg: '已保存', data: { user: publicUser(u) } });
    });
  }

  /* ---- 关注 / 取消关注 ---- */
  if (method === 'POST' && urlPath === '/api/user/follow') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      if (t.id === u.id) return send(res, 400, { ok: false, msg: '不能关注自己哦' });
      u.following = Array.isArray(u.following) ? u.following : [];
      t.followers = Array.isArray(t.followers) ? t.followers : [];
      const idx = u.following.indexOf(t.id);
      if (idx >= 0) {
        u.following.splice(idx, 1);
        const fi = t.followers.indexOf(u.id); if (fi >= 0) t.followers.splice(fi, 1);
        dirty = true;
        return send(res, 200, { ok: true, msg: '已取消关注', data: { following: false } });
      }
      u.following.push(t.id); t.followers.push(u.id); dirty = true;
      notify(t.id, 'follow', '新的关注', u.nickname + ' 关注了你', u);
      return send(res, 200, { ok: true, msg: '关注成功 🎉', data: { following: true } });
    });
  }

  /* ---- 全局搜索：帖子标题/内容 + 用户昵称 ---- */
  if (method === 'POST' && urlPath === '/api/search') {
    return readJson(req, (body) => {
      const q = String(body.q || '').trim().toLowerCase();
      if (!q) return send(res, 200, { ok: true, data: { posts: [], users: [] } });
      const boardId = String(body.boardId || '').trim();
      let matched = db.posts.filter(p =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.content || '').toLowerCase().includes(q)
      );
      // 板块内搜索：只在当前板块内检索；不传 boardId 则全局搜索
      if (boardId) matched = matched.filter(p => p.boardId === boardId);
      const posts = matched.sort((a, b) => heat(b) - heat(a)).slice(0, 50).map(postSummary);
      const users = db.users.filter(u =>
        (u.nickname || '').toLowerCase().includes(q)
      ).slice(0, 20).map(u => ({
        id: u.id, nickname: u.nickname, avatar: u.avatar || '',
        exp: u.exp || 0, posts: countUserPosts(u.id),
      }));
      const me = findUserByToken(body.token);
      const moments = (db.moments || []).filter(m =>
        (m.text || '').toLowerCase().includes(q)).slice(0, 20)
        .map(m => momentSummary(m, me));
      return send(res, 200, { ok: true, data: { posts, users, moments } });
    });
  }

  /* ---- 资料修改（简介/背景） ---- */
  if (method === 'POST' && urlPath === '/api/user/update_avatar') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (!/^\/files\/[\w.-]+$/.test(String(body.avatar || '')))
        return send(res, 400, { ok: false, msg: '头像地址不对' });
      if (changesInWeek(u.avatarChanges) >= CHANGE_MAX_PER_WEEK)
        return send(res, 400, { ok: false, msg: '头像一周只能修改 2 次，请过几天再来' });
      u.avatarChanges = u.avatarChanges || [];
      u.avatarChanges.push(Date.now());
      u.avatar = String(body.avatar);
      dirty = true;
      return send(res, 200, { ok: true, msg: '头像已更新', data: { user: publicUser(u) } });
    });
  }

  if (method === 'POST' && urlPath === '/api/user/update_nickname') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const nickname = String(body.nickname || '').trim();
      if (nickname.length < 2 || nickname.length > 12)
        return send(res, 400, { ok: false, msg: '昵称要 2-12 个字' });
      if (db.users.some(x => x.nickname === nickname && x.id !== u.id))
        return send(res, 400, { ok: false, msg: '这个昵称已被占用' });
      if (changesInWeek(u.nameChanges) >= CHANGE_MAX_PER_WEEK)
        return send(res, 400, { ok: false, msg: '昵称一周只能修改 2 次，请过几天再来' });
      u.nameChanges = u.nameChanges || [];
      u.nameChanges.push(Date.now());
      u.nickname = nickname;
      dirty = true;
      return send(res, 200, { ok: true, msg: '昵称已更新', data: { user: publicUser(u) } });
    });
  }

  if (method === 'POST' && urlPath === '/api/user/update_password') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效，请重新登录' });
      const oldPwd = String(body.oldPassword || '');
      const newPwd = String(body.newPassword || '');
      if (u.pass !== hashPassword(oldPwd))
        return send(res, 400, { ok: false, msg: '当前密码不正确' });
      if (newPwd.length < 6)
        return send(res, 400, { ok: false, msg: '新密码至少 6 位' });
      if (newPwd === oldPwd)
        return send(res, 400, { ok: false, msg: '新密码不能和当前密码一样' });
      u.pass = hashPassword(newPwd);
      dirty = true;
      console.log('[改密]', u.nickname, 'ID:' + u.id, '已修改密码');
      return send(res, 200, { ok: true, msg: '密码已更新，下次登录用新密码', data: { user: publicUser(u) } });
    });
  }

  /* ==================== 管理后台（仅社区主） ==================== */

  function requireAdmin(body, res) {
    const u = findUserByToken(body.token);
    if (!u) { send(res, 401, { ok: false, msg: '登录已失效' }); return null; }
    if (!isAdmin(u)) { send(res, 403, { ok: false, msg: '只有社区主才能操作' }); return null; }
    return u;
  }

  if (method === 'POST' && urlPath === '/api/admin/users') {
    return readJson(req, (body) => {
      // 社区主 或 密码进入（密码也等于社区主权限，方便你直接进后台）
      let byPwd = false;
      if (ADMIN_PASSWORD && body.adminPwd === ADMIN_PASSWORD) byPwd = true;
      if (!byPwd) { if (!requireAdmin(body, res)) return; }
      const q = String(body.q || '').trim().toLowerCase();
      let list = db.users;
      if (q) list = list.filter(u =>
        (u.nickname || '').toLowerCase().includes(q) ||
        String(u.id).includes(q) ||
        (u.phone || '').includes(q)
      );
      const arr = list.map(u => ({
        id: u.id, nickname: u.nickname, avatar: u.avatar || '',
        coins: u.coins || 0, exp: u.exp || 0, posts: countUserPosts(u.id),
        banned: !!u.banned, mutedUntil: u.mutedUntil || 0,
        isAdmin: isAdmin(u), created: u.created,
        boards: u.boards || [], phone: u.phone || '',
        title: u.title || '', listVisible: !!u.listVisible,
      })).sort((a, b) => a.id - b.id);
      return send(res, 200, { ok: true, data: { users: arr, total: arr.length } });
    });
  }


  /* ==================== 关注列表可见开关 + 自定义头衔 + 审核 ==================== */

  /* ---- 设置粉丝/关注列表是否对别人可见 ---- */
  if (method === 'POST' && urlPath === '/api/user/list_visible') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      u.listVisible = !!body.visible;
      dirty = true;
      return send(res, 200, {
        ok: true,
        msg: u.listVisible ? '已开启：别人可以查看你的粉丝和关注' : '已关闭：别人不能查看你的粉丝和关注',
        data: { listVisible: u.listVisible },
      });
    });
  }

  /* ---- 社区主授予/清除自定义头衔 ---- */
  if (method === 'POST' && urlPath === '/api/admin/title') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      const title = String(body.title || '').trim().slice(0, TITLE_MAX);
      t.title = title;
      dirty = true;
      return send(res, 200, {
        ok: true,
        msg: title ? ('已授予 ' + t.nickname + ' 头衔「' + title + '」') : ('已清除 ' + t.nickname + ' 的头衔'),
        data: { title },
      });
    });
  }

  /* ---- 板块主/社区主：待审核帖子 ---- */
  if (method === 'POST' && urlPath === '/api/admin/pending') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (!isAdmin(u) && (u.boards || []).length === 0)
        return send(res, 403, { ok: false, msg: '只有社区主或板块主能审核' });
      // 社区主=所有待审；板块主=自己板块的待审
      let list = db.posts.filter(p => p.pending);
      if (!isAdmin(u)) list = list.filter(p => isBoardMaster(u, p.boardId));
      list.sort((a, b) => b.ts - a.ts);
      return send(res, 200, {
        ok: true,
        data: {
          posts: list.map(postSummary),
          total: list.length,
        },
      });
    });
  }

  /* ---- 审核：通过 / 驳回 ---- */
  if (method === 'POST' && urlPath === '/api/admin/audit') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const p = db.posts.find(x => x.id === body.postId);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      if (!canManagePost(u, p)) return send(res, 403, { ok: false, msg: '只能审核自己板块的帖子' });
      if (!p.pending) return send(res, 400, { ok: false, msg: '该帖子已经审核过了' });
      const rejected = body.pass === false;
      const author = findUserById(p.userId);
      if (rejected) {
        // 驳回：帖子删除 + 通知作者
        const pi = db.posts.indexOf(p);
        if (pi >= 0) db.posts.splice(pi, 1);
        if (author) notify(author.id, 'audit', '帖子未通过审核',
          '《' + (p.title || '') + '》被 ' + u.nickname + ' 驳回，看看是不是不符合板块规则～', u);
      } else {
        p.pending = false;
        // 通过才发经验/计数/热度
        if (author) {
          author.posts = (author.posts || 0) + 1;
          author.exp = (author.exp || 0) + EXP_POST;
          notify(author.id, 'audit', '帖子审核通过',
            '《' + (p.title || '') + '》已通过审核，+20 经验，大家可以看到啦 🎉', u, p.id);
        }
      }
      // 审核人：板块主/社区主 +30 经验
      u.exp = (u.exp || 0) + EXP_AUDIT;
      // 从待审队列摘掉
      db.meta.pending = db.meta.pending || {};
      if (Array.isArray(db.meta.pending[p.boardId])) {
        db.meta.pending[p.boardId] = db.meta.pending[p.boardId].filter(id => id !== p.id);
      }
      dirty = true;
      console.log('[审核]', u.nickname, body.pass === false ? '驳回' : '通过', p.title);
      return send(res, 200, {
        ok: true,
        msg: (body.pass === false ? '已驳回「' : '已通过「') + p.title + '」 审核经验 +' + EXP_AUDIT,
      });
    });
  }

  /* ---- 板块主头衔：金色 · XX主 ---- */
  if (method === 'POST' && urlPath === '/api/board/master_title') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const boardId = String(body.boardId || '');
      if (!isBoardMaster(u, boardId) && !isAdmin(u))
        return send(res, 403, { ok: false, msg: '只有该板块的板块主能改头衔' });
      const t = String(body.title || '').trim().slice(0, TITLE_MAX);
      u.boardTitles = u.boardTitles || {};
      if (t) u.boardTitles[boardId] = t;
      else delete u.boardTitles[boardId];
      dirty = true;
      return send(res, 200, { ok: true, msg: t ? '板块主头衔已设为「' + t + '」' : '已恢复默认板块主头衔', data: { title: t } });
    });
  }

  /* ---- 设置板块主 ---- */
  if (method === 'POST' && urlPath === '/api/admin/set_board_master') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      t.boards = Array.isArray(body.boards) ? body.boards.map(String).slice(0, 20) : [];
      dirty = true;
      return send(res, 200, {
        ok: true,
        msg: t.boards.length ? '已设为板块主：' + t.boards.join(',') : '已取消板块主',
      });
    });
  }

  /* ---- 发布/关闭公告 ---- */
  if (method === 'POST' && urlPath === '/api/admin/notice') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      notice.title = String(body.title || '公告').slice(0, 50);
      notice.content = String(body.content || '').slice(0, 2000);
      notice.enabled = body.enabled !== false;
      notice.showOnce = body.showOnce !== false;
      notice.ts = Date.now();
      db.meta.notice = notice; dirty = true;
      return send(res, 200, { ok: true, msg: '公告已发布，下次打开 App 会弹出' });
    });
  }

  /* ---- 音乐开关 ---- */
  if (method === 'POST' && urlPath === '/api/admin/music') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      if (typeof body.enabled === 'boolean') {
        db.meta.musicEnabled = body.enabled;
        musicEnabled = body.enabled;
        dirty = true;
      }
      return send(res, 200, {
        ok: true,
        msg: '音乐当前 ' + (db.meta.musicEnabled ? '开' : '关') + '，列表 ' + MUSIC_LIST.length + ' 首',
        data: { enabled: !!db.meta.musicEnabled },
      });
    });
  }

  if (method === 'POST' && urlPath === '/api/admin/ban') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      if (isAdmin(t)) return send(res, 400, { ok: false, msg: '不能封禁社区主' });
      t.banned = !!body.banned;
      t.token = makeToken(); // 封禁时踢下线
      if (t.banned) t.boards = []; // 封号时取消板块主
      dirty = true;
      console.log('[管理]', t.banned ? '封禁' : '解封', t.nickname);
      return send(res, 200, { ok: true, msg: t.banned ? '已封禁 ' + t.nickname : '已解封 ' + t.nickname });
    });
  }

  if (method === 'POST' && urlPath === '/api/admin/mute') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      if (isAdmin(t)) return send(res, 400, { ok: false, msg: '不能禁言社区主' });
      const minutes = Number(body.minutes || 0);
      t.mutedUntil = minutes > 0 ? Date.now() + minutes * 60 * 1000 : 0;
      dirty = true;
      console.log('[管理]', t.nickname, minutes > 0 ? '禁言' + minutes + '分钟' : '解除禁言');
      return send(res, 200, {
        ok: true,
        msg: minutes > 0 ? '已禁言 ' + t.nickname + ' ' + minutes + ' 分钟' : '已解除 ' + t.nickname + ' 的禁言',
      });
    });
  }

  if (method === 'POST' && urlPath === '/api/admin/coins') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      t.coins = Math.max(0, Math.floor(Number(body.coins || 0)));
      dirty = true;
      return send(res, 200, { ok: true, msg: '已将 ' + t.nickname + ' 的豆包币设为 ' + t.coins });
    });
  }

  if (method === 'POST' && urlPath === '/api/admin/reset_password') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      const newPwd = String(body.newPassword || '');
      if (newPwd.length < 6)
        return send(res, 400, { ok: false, msg: '新密码至少 6 位' });
      t.pass = hashPassword(newPwd);
      t.token = makeToken(); // 强制对方用新密码重新登录
      dirty = true;
      console.log('[管理] 重置', t.nickname, 'ID:' + t.id, '密码');
      return send(res, 200, { ok: true, msg: '已重置 ' + t.nickname + ' 的密码，把新密码告知对方即可' });
    });
  }

  if (method === 'POST' && urlPath === '/api/admin/pin') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const p = db.posts.find(x => x.id === body.postId);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      p.pinned = !!body.pinned;
      dirty = true;
      return send(res, 200, { ok: true, msg: p.pinned ? '已置顶' : '已取消置顶' });
    });
  }

  if (method === 'POST' && urlPath === '/api/admin/delete_post') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const idx = db.posts.findIndex(x => x.id === body.postId);
      if (idx < 0) return send(res, 404, { ok: false, msg: '帖子不存在' });
      const t = findUserById(db.posts[idx].userId);
      if (t) t.posts = Math.max(0, (t.posts || 0) - 1);
      db.posts.splice(idx, 1);
      dirty = true;
      return send(res, 200, { ok: true, msg: '帖子已删除' });
    });
  }

  /* ---- 帖子管理（社区主 或 该板块的板块主都能操作） ---- */
  if (method === 'POST' && (urlPath === '/api/post/pin' || urlPath === '/api/post/delete')) {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const p = db.posts.find(x => x.id === body.postId);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      if (!canManagePost(u, p)) return send(res, 403, { ok: false, msg: '只有社区主或板块主才能操作' });
      if (urlPath === '/api/post/pin') {
        p.pinned = !!body.pinned; dirty = true;
        return send(res, 200, { ok: true, msg: p.pinned ? '已置顶' : '已取消置顶' });
      }
      const au = findUserById(p.userId);
      if (au && !p.pending) au.posts = Math.max(0, (au.posts || 0) - 1); // 待审核的还没计数
      db.meta.pending = db.meta.pending || {};
      if (Array.isArray(db.meta.pending[p.boardId])) {
        db.meta.pending[p.boardId] = db.meta.pending[p.boardId].filter(id => id !== p.id);
      }
      db.posts.splice(db.posts.indexOf(p), 1); dirty = true;
      return send(res, 200, { ok: true, msg: '帖子已删除' });
    });
  }


  /* ============================================================
   * ★ v3.0 新增接口
   * ============================================================ */

  /* ---- 启动页随机壁纸库 ---- */
  if (method === 'GET' && urlPath === '/api/wallpapers') {
    return send(res, 200, { ok: true, data: { list: WALLPAPERS } });
  }

  /* ---- 帖子分享落地页（复制链接给别人打开的网页） ---- */
  if (method === 'GET' && urlPath.startsWith('/p/')) {
    const sp = db.posts.find(x => x.id === urlPath.slice(3));
    if (!sp || sp.pending) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h3>帖子不存在或还在审核中</h3>');
    }
    const sa = findUserById(sp.userId);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(sp.title)} - 豆包社区</title></head>
<body style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#15171F;background:#F4F5FA">
<div style="background:#fff;border-radius:18px;padding:20px">
<h2 style="margin:0 0 6px">${escapeHtml(sp.title)}</h2>
<p style="color:#8B90A3;font-size:13px;margin:0 0 16px">
  ${escapeHtml(sp.nickname)} · ${boardNameOf(sp.boardId)} · ${new Date(sp.ts).toLocaleString('zh-CN')}</p>
<div style="white-space:pre-wrap;line-height:1.7;font-size:15px">${escapeHtml(sp.content)}</div>
<p style="margin-top:24px;color:#6E5BFF;font-weight:600">打开「豆包社区」App 参与讨论 →</p>
</div></body></html>`);
  }

  /* ---- 广场：热门帖子流 ---- */
  if (method === 'POST' && urlPath === '/api/feed') {
    return readJson(req, (body) => {
      const me = findUserByToken(body.token);
      const posts = db.posts.filter(p => !p.pending)
        .sort((a, b) => heat(b) - heat(a)).slice(0, 6)
        .map(p => postSummary(p, me));
      return send(res, 200, { ok: true, data: { posts } });
    });
  }

  /* ---- 通知中心 ---- */
  if (method === 'POST' && urlPath === '/api/notifications/list') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const all = Array.isArray(u.notifications) ? u.notifications : [];
      const list = all.slice(0, 100);
      return send(res, 200, {
        ok: true,
        data: { list, unread: all.filter(n => !n.read).length },
      });
    });
  }
  if (method === 'POST' && urlPath === '/api/notifications/unread') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const all = Array.isArray(u.notifications) ? u.notifications : [];
      return send(res, 200, { ok: true, data: { unread: all.filter(n => !n.read).length } });
    });
  }
  if (method === 'POST' && urlPath === '/api/notifications/read') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const all = Array.isArray(u.notifications) ? u.notifications : [];
      if (body.all) all.forEach(n => { n.read = true; });
      else if (body.id) { const n = all.find(x => x.id === body.id); if (n) n.read = true; }
      dirty = true;
      return send(res, 200, { ok: true, data: { unread: all.filter(n => !n.read).length } });
    });
  }

  /* ---- 收藏 ---- */
  if (method === 'POST' && urlPath === '/api/post/collect') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const p = db.posts.find(x => x.id === body.id);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      p.collects = Array.isArray(p.collects) ? p.collects : [];
      u.favorites = Array.isArray(u.favorites) ? u.favorites : [];
      const i = p.collects.indexOf(u.id);
      if (i >= 0) {
        p.collects.splice(i, 1);
        u.favorites = u.favorites.filter(x => x !== p.id);
        dirty = true;
        return send(res, 200, { ok: true, msg: '已取消收藏', data: { collected: false, collects: p.collects.length } });
      }
      p.collects.push(u.id);
      if (!u.favorites.includes(p.id)) u.favorites.push(p.id);
      dirty = true;
      notify(p.userId, 'collect', '有人收藏了你的帖子',
        u.nickname + ' 收藏了《' + (p.title || '') + '》', u, p.id);
      return send(res, 200, { ok: true, msg: '已收藏 ⭐', data: { collected: true, collects: p.collects.length } });
    });
  }

  /* ---- 分享计数 ---- */
  if (method === 'POST' && urlPath === '/api/post/share') {
    return readJson(req, (body) => {
      const p = db.posts.find(x => x.id === body.id);
      if (!p) return send(res, 404, { ok: false, msg: '帖子不存在' });
      p.shares = (p.shares || 0) + 1;
      dirty = true;
      return send(res, 200, { ok: true, msg: '链接已复制', data: { shares: p.shares } });
    });
  }

  /* ---- 我的收藏 ---- */
  if (method === 'POST' && urlPath === '/api/my/favorites') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const ids = Array.isArray(u.favorites) ? u.favorites : [];
      const posts = ids.map(id => db.posts.find(p => p.id === id))
        .filter(Boolean).filter(p => !p.pending)
        .sort((a, b) => b.ts - a.ts).slice(0, 100)
        .map(p => postSummary(p, u));
      return send(res, 200, { ok: true, data: { posts } });
    });
  }

  /* ---- 我的帖子 ---- */
  if (method === 'POST' && urlPath === '/api/my/posts') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const posts = db.posts.filter(p => p.userId === u.id)
        .sort((a, b) => b.ts - a.ts).slice(0, 100)
        .map(p => postSummary(p, u));
      return send(res, 200, { ok: true, data: { posts } });
    });
  }

  /* ---- 社区动态（朋友圈式） ---- */
  if (method === 'POST' && urlPath === '/api/moment/list') {
    return readJson(req, (body) => {
      const me = findUserByToken(body.token);
      const moments = (db.moments || []).slice(0, 50).map(m => momentSummary(m, me));
      return send(res, 200, { ok: true, data: { moments } });
    });
  }
  if (method === 'POST' && urlPath === '/api/moment/create') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      if (u.banned) return send(res, 403, { ok: false, msg: '你已被封禁' });
      if ((u.mutedUntil || 0) > Date.now())
        return send(res, 403, { ok: false, msg: '你正在禁言中，暂时不能发动态' });
      const text = String(body.text || '').trim().slice(0, 500);
      const images = Array.isArray(body.images)
        ? body.images.filter(x => /^\/files\/[\w.-]+$/.test(x)).slice(0, 3) : [];
      if (!text && images.length === 0)
        return send(res, 400, { ok: false, msg: '写点什么或者配张图吧' });
      const m = {
        id: 'mo' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
        userId: u.id, nickname: u.nickname, avatar: u.avatar || '',
        text, images, ts: Date.now(), likes: [], comments: [],
      };
      db.moments.unshift(m);
      if (db.moments.length > 500) db.moments = db.moments.slice(0, 500);
      dirty = true;
      return send(res, 200, { ok: true, msg: '动态已发布', data: { id: m.id } });
    });
  }
  if (method === 'POST' && urlPath === '/api/moment/like') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const m = (db.moments || []).find(x => x.id === body.id);
      if (!m) return send(res, 404, { ok: false, msg: '动态不存在' });
      m.likes = Array.isArray(m.likes) ? m.likes : [];
      const i = m.likes.indexOf(u.id);
      if (i >= 0) {
        m.likes.splice(i, 1);
        dirty = true;
        return send(res, 200, { ok: true, data: { liked: false, likes: m.likes.length } });
      }
      m.likes.push(u.id);
      dirty = true;
      notify(m.userId, 'like', '动态被点赞', u.nickname + ' 赞了你的动态', u);
      return send(res, 200, { ok: true, data: { liked: true, likes: m.likes.length } });
    });
  }
  if (method === 'POST' && urlPath === '/api/moment/comment') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const m = (db.moments || []).find(x => x.id === body.id);
      if (!m) return send(res, 404, { ok: false, msg: '动态不存在' });
      const content = String(body.content || '').trim().slice(0, 300);
      if (!content) return send(res, 400, { ok: false, msg: '评论不能为空' });
      m.comments = Array.isArray(m.comments) ? m.comments : [];
      m.comments.push({ userId: u.id, nickname: u.nickname, content, ts: Date.now() });
      dirty = true;
      notify(m.userId, 'comment', '动态收到评论', u.nickname + '：' + content.slice(0, 40), u);
      return send(res, 200, { ok: true, msg: '评论成功', data: { commentCount: m.comments.length } });
    });
  }
  if (method === 'POST' && urlPath === '/api/moment/delete') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const i = (db.moments || []).findIndex(x => x.id === body.id);
      if (i < 0) return send(res, 404, { ok: false, msg: '动态不存在' });
      const m = db.moments[i];
      if (m.userId !== u.id && !isAdmin(u))
        return send(res, 403, { ok: false, msg: '只能删自己的动态' });
      db.moments.splice(i, 1);
      dirty = true;
      return send(res, 200, { ok: true, msg: '动态已删除' });
    });
  }

  /* ---- 排行榜 ---- */
  if (method === 'POST' && urlPath === '/api/rank') {
    return readJson(req, (body) => {
      const type = String(body.type || 'exp');
      const pick = (u) => ({
        id: u.id, nickname: u.nickname, avatar: u.avatar || '',
        exp: u.exp || 0, posts: countUserPosts(u.id),
        followers: Array.isArray(u.followers) ? u.followers.length : (u.followers || 0),
        popularity: u.popularity || 0,
        isAdmin: isAdmin(u),
      });
      const list = db.users.filter(u => !u.banned).map(pick)
        .sort((a, b) => (b[type] || 0) - (a[type] || 0))
        .slice(0, 20);
      return send(res, 200, { ok: true, data: { list, type } });
    });
  }

  /* ---- 礼物 ---- */
  if (method === 'POST' && urlPath === '/api/gift/list') {
    return send(res, 200, { ok: true, data: { items: GIFT_ITEMS } });
  }

  if (method === 'POST' && urlPath === '/api/gift/send') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const t = findUserById(body.toUserId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      if (t.id === u.id) return send(res, 400, { ok: false, msg: '不能给自己送礼物哦' });
      const g = GIFT_ITEMS.find(x => x.id === body.giftId);
      if (!g) return send(res, 400, { ok: false, msg: '礼物不存在' });
      if ((u.coins || 0) < g.price)
        return send(res, 400, { ok: false, msg: '豆包币不够啦，还差 ' + (g.price - (u.coins || 0)) + ' 个' });
      u.coins -= g.price;
      t.popularity = (t.popularity || 0) + g.popularity;
      t.giftStats = t.giftStats || {};
      const stat = t.giftStats[g.id] || { name: g.name, emoji: g.emoji, price: g.price, popularity: g.popularity, count: 0 };
      stat.count += 1;
      t.giftStats[g.id] = stat;
      notify(t.id, 'gift', '收到礼物', u.nickname + ' 送了你 ' + g.emoji + ' ' + g.name, u, '');
      dirty = true;
      console.log('[礼物]', u.nickname, '→', t.nickname, g.emoji, g.name);
      return send(res, 200, { ok: true, msg: '已送出 ' + g.emoji + ' ' + g.name,
        data: { coins: u.coins, popularity: t.popularity, giftCount: giftCountOf(t), gifts: giftStatsOf(t) } });
    });
  }

  /* ---- 豆包币商城 ---- */
  if (method === 'POST' && urlPath === '/api/shop/list') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const owned = Array.isArray(u.ownedItems) ? u.ownedItems : [];
      const items = SHOP_ITEMS.map(it => ({
        id: it.id, name: it.name, desc: it.desc, type: it.type,
        value: it.value, price: it.price, color: it.color,
        owned: owned.includes(it.id),
        equipped: itemEquipped(u, it),
      }));
      return send(res, 200, { ok: true, data: { coins: u.coins || 0, items } });
    });
  }
  if (method === 'POST' && urlPath === '/api/shop/buy') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const item = SHOP_ITEMS.find(x => x.id === body.itemId);
      if (!item) return send(res, 404, { ok: false, msg: '商品不存在' });
      u.ownedItems = Array.isArray(u.ownedItems) ? u.ownedItems : [];
      if (u.ownedItems.includes(item.id))
        return send(res, 400, { ok: false, msg: '你已经有这个了，直接使用就行' });
      if ((u.coins || 0) < item.price)
        return send(res, 400, { ok: false, msg: '豆包币不够啦，还差 ' + (item.price - (u.coins || 0)) + ' 个' });
      u.coins -= item.price;
      u.ownedItems.push(item.id);
      dirty = true;
      return send(res, 200, { ok: true, msg: '兑换成功！点「使用」就能换上', data: { coins: u.coins } });
    });
  }
  if (method === 'POST' && urlPath === '/api/shop/equip') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const item = SHOP_ITEMS.find(x => x.id === body.itemId);
      if (!item) return send(res, 404, { ok: false, msg: '商品不存在' });
      u.ownedItems = Array.isArray(u.ownedItems) ? u.ownedItems : [];
      if (!u.ownedItems.includes(item.id))
        return send(res, 400, { ok: false, msg: '还没有这个道具，先去兑换吧' });
      u.equipped = (u.equipped && typeof u.equipped === 'object') ? u.equipped : {};
      if (u.equipped[item.type] === item.id) {
        delete u.equipped[item.type];
        if (item.type === 'title') u.title = '';
        dirty = true;
        return send(res, 200, { ok: true, msg: '已取下「' + item.name + '」' });
      }
      u.equipped[item.type] = item.id;
      if (item.type === 'title') u.title = String(item.value || item.name).slice(0, TITLE_MAX);
      if (item.type === 'name_color') u.nameColor = item.value;
      dirty = true;
      return send(res, 200, { ok: true, msg: '已换上「' + item.name + '」', data: { user: publicUser(u) } });
    });
  }

  /* ---- 签到日历 ---- */
  if (method === 'POST' && urlPath === '/api/checkin/calendar') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效' });
      const month = /^\d{4}-\d{2}$/.test(String(body.month || ''))
        ? String(body.month) : new Date().toISOString().slice(0, 7);
      const ck = u.checkins || {};
      const days = Object.keys(ck).filter(d => d.startsWith(month))
        .map(d => Number(d.slice(8, 10))).sort((a, b) => a - b);
      const today = new Date().toISOString().slice(0, 10);
      return send(res, 200, {
        ok: true,
        data: {
          days, month,
          streak: calcStreak(u),
          signedToday: !!ck[today],
          total: days.length,
        },
      });
    });
  }

  /* ---- 设置社区主 ---- */
  if (method === 'POST' && urlPath === '/api/admin/set_admin') {
    return readJson(req, (body) => {
      if (!requireAdmin(body, res)) return;
      const t = findUserById(body.userId);
      if (!t) return send(res, 404, { ok: false, msg: '用户不存在' });
      db.meta.adminId = t.id;
      dirty = true;
      return send(res, 200, { ok: true, msg: t.nickname + ' 已成为社区主' });
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, msg: '接口不存在' }));
});

/* ==================== WebSocket 聊天室 ==================== */
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.user = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let o;
    try { o = JSON.parse(raw.toString()); } catch (e) { return; }
    const type = o.type;

    if (type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));

    if (type === 'auth') {
      const u = findUserByToken(o.token);
      if (!u) return ws.send(JSON.stringify({ type: 'error', msg: '登录已失效，请重新登录' }));
      if (u.banned) return ws.send(JSON.stringify({ type: 'error', msg: '该账号已被封禁' }));
      ws.user = u;
      ws.send(JSON.stringify(Object.assign({ type: 'auth_ok', me: publicUser(u) }, stats())));
      ws.send(JSON.stringify({ type: 'history', msgs: db.msgs.slice(-200) }));
      broadcast({ type: 'sys', content: '📢 ' + u.nickname + ' 加入了聊天室' });
      broadcastStats();
      console.log('[上线]', u.nickname, '在线', authedClients());
      return;
    }

    if (!ws.user) return ws.send(JSON.stringify({ type: 'error', msg: '请先登录' }));
    const user = ws.user;

    // 禁言校验（聊天室）
    if ((user.mutedUntil || 0) > Date.now()) {
      return ws.send(JSON.stringify({
        type: 'error',
        msg: '你被禁言至 ' + new Date(user.mutedUntil).toLocaleString('zh-CN') + '，期间无法发言',
      }));
    }

    if (type === 'text' || type === 'sticker') {
      const content = String(o.content || '').slice(0, 2000);
      if (!content) return;
      return pushMsg({ type, content, url: '', user, reply: o.reply || null });
    }
    if (type === 'image') {
      const url = String(o.url || '');
      if (!/^\/files\/[\w.-]+$/.test(url)) return;
      // ★ 图文混合：content 是配文（可空）
      const content = String(o.content || '').trim().slice(0, 500);
      return pushMsg({ type: 'image', content, url, user, reply: o.reply || null });
    }
    if (type === 'video') {
      const url = String(o.url || '');
      if (!/^\/files\/[\w.-]+$/.test(url)) return;
      const content = String(o.content || '').trim().slice(0, 500);
      return pushMsg({ type: 'video', content, url, user, reply: o.reply || null });
    }

    /* ★ v3：撤回消息（2 分钟内，只能撤回自己的） */
    if (type === 'recall') {
      const id = String(o.id || '');
      const idx = db.msgs.findIndex(m => m.id === id);
      if (idx < 0) return ws.send(JSON.stringify({ type: 'error', msg: '这条消息太旧了，撤不回来' }));
      const m = db.msgs[idx];
      if (m.userId !== user.id) return ws.send(JSON.stringify({ type: 'error', msg: '只能撤回自己的消息' }));
      if (Date.now() - m.ts > 2 * 60 * 1000)
        return ws.send(JSON.stringify({ type: 'error', msg: '超过 2 分钟就不能撤回啦' }));
      m.recalled = true;
      m.content = '';
      m.url = '';
      dirty = true;
      return broadcast({ type: 'recall', id: m.id });
    }
  });

  ws.on('close', () => {
    if (ws.user) {
      broadcast({ type: 'sys', content: '👋 ' + ws.user.nickname + ' 离开了聊天室' });
      broadcastStats();
      console.log('[下线]', ws.user.nickname, '在线', authedClients());
    }
  });
});

function pushMsg({ type, content, url, user, reply }) {
  const msg = {
    id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    type, content: content || '', url: url || '',
    userId: user.id, nickname: user.nickname,
    avatar: user.avatar || '',   // ★ 带上头像
    title: user.title || '',     // ★ 头衔
    ts: Date.now(),
  };
  if (reply && reply.id) {
    // ★ 回复：只存必要的字段，客户端用来显示引用条
    msg.reply = {
      id: String(reply.id).slice(0, 64),
      nickname: String(reply.nickname || '').slice(0, 12),
      content: String(reply.content || '').slice(0, 80),
      type: String(reply.type || 'text'),
    };
  }
  db.msgs.push(msg);
  if (db.msgs.length > 300) db.msgs = db.msgs.slice(-300);
  user.posts = (user.posts || 0) + 1;
  dirty = true;
  broadcast(msg);
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1 && c.user) c.send(s); });
}
function authedClients() { let n = 0; wss.clients.forEach(c => { if (c.user) n++; }); return n; }
function stats() { return { online: authedClients(), total: db.users.length }; }
function broadcastStats() { broadcast(Object.assign({ type: 'stats' }, stats())); }
setInterval(broadcastStats, 20000);
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping(() => { });
  });
}, 30000);

/* ==================== 底层工具 ==================== */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb, limit) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > limit) { req.destroy(); return cb(Buffer.alloc(0), new Error('too large')); }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks)));
}
function readJson(req, cb) {
  readBody(req, (buf, err) => {
    if (err) return cb(null, err);
    try { cb(JSON.parse(buf.toString('utf8') || '{}')); }
    catch (e) { cb(null, e); }
  }, 256 * 1024);
}
function extractMultipartFile(buf, contentType) {
  const m = /boundary="?([^";\s]+)"?/.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1]);
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    let part = buf.slice(pos + boundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const headers = part.slice(0, headEnd).toString('utf8');
      const body = part.slice(headEnd + 4);
      const fn = /filename="([^"]*)"/.exec(headers);
      const ct = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
      if (fn) return { filename: fn[1], body, contentType: ct ? ct[1].trim() : '' };
    }
    pos = next;
  }
  return null;
}

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  豆包社区服务器 v3.0 已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('  用户: ' + db.users.length + ' | 帖子: ' + db.posts.length);
  console.log('========================================');
});
