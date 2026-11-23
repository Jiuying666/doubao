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
});
if (!db.meta.pending || typeof db.meta.pending !== 'object') db.meta.pending = {};
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
  } catch (e) { console.error('保存失败:', e.message); }
}
setInterval(saveDb, 10000);
process.on('SIGTERM', () => { dirty = true; saveDb(); process.exit(0); });
process.on('SIGINT', () => { dirty = true; saveDb(); process.exit(0); });

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

/** 对外输出的用户信息（不含密码） */
function publicUser(u) {
  return {
    id: u.id, nickname: u.nickname, phone: u.phone || '',
    avatar: u.avatar || '', coins: u.coins || 0,
    followers: Array.isArray(u.followers) ? u.followers.length : (u.followers || 0),
    following: Array.isArray(u.following) ? u.following.length : (u.following || 0),
    posts: u.posts || 0, exp: u.exp || 0,
    banned: !!u.banned, mutedUntil: u.mutedUntil || 0,
    isAdmin: isAdmin(u), bio: u.bio || '', bg: u.bg || '',
    boards: u.boards || [],
    title: u.title || '',            // ★ 自定义头衔（社区主授予；空=用等级名）
    listVisible: !!u.listVisible,    // ★ 粉丝/关注列表是否对别人公开
    nameChanges: (u.nameChanges || []).length,
    avatarChanges: (u.avatarChanges || []).length,
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
function postSummary(p) {
  const u = findUserById(p.userId);
  return {
    id: p.id, boardId: p.boardId, title: p.title,
    preview: (p.content || '').slice(0, 120),
    imageCount: (p.images || []).length, firstImage: (p.images || [])[0] || '',
    userId: p.userId, nickname: p.nickname, avatar: p.avatar || '',
    exp: u ? u.exp || 0 : 0,
    authorTitle: u ? u.title || '' : '',
    isAdmin: u ? isAdmin(u) : false,
    boards: u ? (u.boards || []) : [],
    ts: p.ts, views: p.views || 0,
    likes: (p.likes || []).length, comments: (p.comments || []).length,
    pinned: !!p.pinned, heat: heat(p),
    pending: !!p.pending,
  };
}

/* ==================== 全局通知（公告 / 音乐开关 / 版本） ==================== */
let notice = Object.assign({}, NOTICE_DEFAULT);
try {
  if (db.meta.notice) notice = Object.assign({}, NOTICE_DEFAULT, db.meta.notice);
} catch (e) { }

/* ★ 悬浮窗音乐列表：把你的歌曲外链放进来（mp3 直链），App 会随机播放 */
const MUSIC_LIST = [
  { name: '放松时刻', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
  { name: '午后阳光', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
  { name: '晚风轻抚', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3' },
  { name: 'Kalimba', url: 'https://www.learningcontainer.com/wp-content/uploads/2020/02/Kalimba.mp3' },
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
  <h1>豆包 🫛 服务器运行中 (v2.3)</h1>
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
      if (nickname.length < 2 || nickname.length > 12)
        return send(res, 400, { ok: false, msg: '昵称要 2-12 个字' });
      if (password.length < 6)
        return send(res, 400, { ok: false, msg: '密码至少 6 位' });
      if (phone && !/^1\d{10}$/.test(phone))
        return send(res, 400, { ok: false, msg: '手机号格式不对' });
      if (db.users.some(u => u.nickname === nickname))
        return send(res, 400, { ok: false, msg: '这个昵称已被占用' });
      if (phone && db.users.some(u => u.phone === phone))
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
      const u = db.users.find(x => x.nickname === account || (x.phone && x.phone === account));
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

  /* ---- 上传图片 ---- */
  if (method === 'POST' && urlPath === '/api/upload') {
    return readBody(req, (buf, err) => {
      if (err) return send(res, 413, { ok: false, msg: '文件太大（上限 10MB）' });
      const part = extractMultipartFile(buf, req.headers['content-type'] || '');
      if (!part) return send(res, 400, { ok: false, msg: '上传格式错误' });
      // 后缀：优先用文件名里的；没有就用 Content-Type 猜；还不行就当 jpg
      let ext = (path.extname(part.filename || '') || '').toLowerCase();
      if (!/^\.(png|jpe?g|gif|webp)$/.test(ext)) {
        const ct = (part.contentType || '').toLowerCase();
        if (ct.includes('png')) ext = '.png';
        else if (ct.includes('gif')) ext = '.gif';
        else if (ct.includes('webp')) ext = '.webp';
        else ext = '.jpg';
      }
      const name = Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + ext;
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), part.body);
      console.log('[上传]', name, part.body.length, 'bytes', part.filename);
      return send(res, 200, { ok: true, msg: '上传成功', data: { url: '/files/' + name } });
    }, 10 * 1024 * 1024);
  }

  /* ---- 访问图片 ---- */
  if (method === 'GET' && urlPath.startsWith('/files/')) {
    const name = path.basename(urlPath);
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
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
      if (title.length < 1 || title.length > 50) return send(res, 400, { ok: false, msg: '标题要 1-50 个字' });
      if (content.length > 5000) return send(res, 400, { ok: false, msg: '内容太长了（上限5000字）' });
      if (!boardId) return send(res, 400, { ok: false, msg: '缺少板块' });
      const post = {
        id: 'p' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
        boardId, title, content, images,
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
            images: p.images || [], userId: p.userId, nickname: p.nickname,
            avatar: p.avatar || '', exp: u ? u.exp || 0 : 0, ts: p.ts,
            views: p.views, likes: (p.likes || []).length,
            likedByMe: me ? (p.likes || []).includes(me.id) : false,
            comments: (p.comments || []).map(c => ({
              id: c.id, userId: c.userId, nickname: c.nickname,
              avatar: c.avatar || '', exp: (() => { const cu = findUserById(c.userId); return cu ? cu.exp || 0 : 0; })(),
              content: c.content, ts: c.ts,
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
      if (!content) return send(res, 400, { ok: false, msg: '评论不能为空' });
      p.comments = p.comments || [];
      p.comments.push({
        id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
        userId: u.id, nickname: u.nickname, avatar: u.avatar || '',
        content, ts: Date.now(),
      });
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
      const myPosts = db.posts.filter(p => p.userId === t.id && (!p.pending || (me && (me.id === t.id || canManagePost(me, p)))))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts)
        .slice(0, 20).map(postSummary);
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
            posts: t.posts || 0, exp: t.exp || 0,
            isAdmin: isAdmin(t), banned: !!t.banned,
            title: t.title || '', listVisible: !!t.listVisible,
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
      return send(res, 200, { ok: true, msg: '关注成功 🎉', data: { following: true } });
    });
  }

  /* ---- 全局搜索：帖子标题/内容 + 用户昵称 ---- */
  if (method === 'POST' && urlPath === '/api/search') {
    return readJson(req, (body) => {
      const q = String(body.q || '').trim().toLowerCase();
      if (!q) return send(res, 200, { ok: true, data: { posts: [], users: [] } });
      const posts = db.posts.filter(p =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.content || '').toLowerCase().includes(q)
      ).sort((a, b) => heat(b) - heat(a)).slice(0, 50).map(postSummary);
      const users = db.users.filter(u =>
        (u.nickname || '').toLowerCase().includes(q)
      ).slice(0, 20).map(u => ({
        id: u.id, nickname: u.nickname, avatar: u.avatar || '',
        exp: u.exp || 0, posts: u.posts || 0,
      }));
      return send(res, 200, { ok: true, data: { posts, users } });
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
        coins: u.coins || 0, exp: u.exp || 0, posts: u.posts || 0,
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
      p.pending = false;
      // 通过才发经验/计数/热度
      const author = findUserById(p.userId);
      if (author) {
        author.posts = (author.posts || 0) + 1;
        author.exp = (author.exp || 0) + EXP_POST;
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
      return pushMsg({ type: 'image', content: '', url, user, reply: o.reply || null });
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
  console.log('  豆包社区服务器 v2.3 已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('  用户: ' + db.users.length + ' | 帖子: ' + db.posts.length);
  console.log('========================================');
});
