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

/* ==================== 数据库 ==================== */
let db = { users: [], msgs: [], posts: [], meta: { adminId: null } };
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

/** 随机用户ID：6位数（100000~999999），不重复 */
function nextUserId() {
  for (let i = 0; i < 999; i++) {
    const id = 100000 + Math.floor(Math.random() * 900000);
    if (!db.users.some(u => u.id === id)) return id;
  }
  return Date.now() % 900000 + 100000;
}

function findUserByToken(token) {
  if (!token) return null;
  return db.users.find(u => u.token === token) || null;
}
function findUserById(id) { return db.users.find(u => u.id === Number(id)) || null; }
function isAdmin(u) { return db.meta.adminId === u.id; }

/** 对外输出的用户信息（不含密码） */
function publicUser(u) {
  return {
    id: u.id, nickname: u.nickname, phone: u.phone || '',
    avatar: u.avatar || '', coins: u.coins || 0,
    followers: u.followers || 0, following: u.following || 0,
    posts: u.posts || 0, exp: u.exp || 0,
    banned: !!u.banned, mutedUntil: u.mutedUntil || 0,
    isAdmin: isAdmin(u),
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
    ts: p.ts, views: p.views || 0,
    likes: (p.likes || []).length, comments: (p.comments || []).length,
    pinned: !!p.pinned, heat: heat(p),
  };
}

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
  <h1>豆包 🫛 服务器运行中 (v2.0)</h1>
  <p>✅ 服务正常 | 在线 <b>${authedClients()}</b> | 用户 <b>${db.users.length}</b> | 消息 <b>${db.msgs.length}</b> | 帖子 <b>${db.posts.length}</b></p>
</body></html>`);
    return;
  }

  if (method === 'GET' && urlPath === '/api/stats') {
    return send(res, 200, { ok: true, data: stats() });
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
        id: nextUserId(),          // ★ 随机ID
        nickname, phone,
        pass: hashPassword(password),
        coins: 100, followers: 0, following: 0, posts: 0,
        exp: 0,                    // 经验值（等级由它决定）
        avatar: '',                // 头像图片地址
        nameChanges: [], avatarChanges: [],  // 修改记录（限频用）
        banned: false, mutedUntil: 0,
        token: makeToken(), created: Date.now(),
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
      if (!u || u.pass !== hashPassword(String(body.password || '')))
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
      if (!/\.(png|jpe?g|gif|webp)$/i.test(part.filename))
        return send(res, 400, { ok: false, msg: '只能上传图片' });
      const name = Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + path.extname(part.filename).toLowerCase();
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), part.body);
      console.log('[上传]', name, part.body.length, 'bytes');
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
      };
      db.posts.unshift(post);
      u.posts = (u.posts || 0) + 1;
      u.exp = (u.exp || 0) + EXP_POST;
      dirty = true;
      console.log('[发帖]', u.nickname, '→', boardId, ':', title);
      return send(res, 200, { ok: true, msg: '发布成功', data: { post: postSummary(post) } });
    });
  }

  // 帖子列表（sort: all全部 | new最新 | hot热门(点击量) | likes最多点赞）
  if (method === 'POST' && urlPath === '/api/post/list') {
    return readJson(req, (body) => {
      const boardId = String(body.boardId || '');
      let list = db.posts.filter(p => !boardId || p.boardId === boardId);
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
      if (!requireAdmin(body, res)) return;
      const list = db.users.map(u => ({
        id: u.id, nickname: u.nickname, avatar: u.avatar || '',
        coins: u.coins || 0, exp: u.exp || 0, posts: u.posts || 0,
        banned: !!u.banned, mutedUntil: u.mutedUntil || 0,
        isAdmin: isAdmin(u), created: u.created,
      })).sort((a, b) => a.id - b.id);
      return send(res, 200, { ok: true, data: { users: list } });
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
      return pushMsg({ type, content, url: '', user });
    }
    if (type === 'image') {
      const url = String(o.url || '');
      if (!/^\/files\/[\w.-]+$/.test(url)) return;
      return pushMsg({ type: 'image', content: '', url, user });
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

function pushMsg({ type, content, url, user }) {
  const msg = {
    id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    type, content: content || '', url: url || '',
    userId: user.id, nickname: user.nickname,
    avatar: user.avatar || '',   // ★ 带上头像
    ts: Date.now(),
  };
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
    if (usercn{n1)users
broadcastStatsstatstypesetInterval; setInterval.ObjectbroadcastfunctiondbfunctionbroadcastStatsbroadcastsetIntervalstatssetIntervalwss => {ifwss (clients.ws === 1 && clientsisAlivews returnws; }wsterminatefalsewsisAlivereturnws() { false = ping; isAlive.false.send(functionping{/* ==================== 底层工具 ==================== */code (res., writeHeadcodesend:) jsonapplicationobj}code; charset; }.res()utf{obj{ function: stringify()chunks./* ==================== 底层工具 ==================== */ }; }(0, res() { limit(writeHead({ code: 'application/json; charset=utf-8' }, let())); }).size(on, 20000);('=cb-8readBodyreqcbutf8');
      csize(() => { c.length.if(sizelimit => {return(cb.Buffer === alloc) { new.Error(); too; }.req.on = large;(cb.''(() => { })res4);Buffer
      }, 30000); concatchunks = /filename="([^"]*)"/., ., .; =.,(functionreadJsonreq) {(cb(readBody), { 'Content-Type': req }););
      buf(errif, err{ (returncb = [];)null{ = 0;('data', err => {: try+= cb.JSON;[1], parse (buf > toString) { catche.cb(); null(e(0), function(extractMultipartFile)); } };
    }
    buf.contentType('end', () => const(m.exec(contentType)))if(m, returnnull) {;
  }
  const(boundary, (Bufferfrom, boundary) => { s (pos)buf(indexOfboundary, while);;
}

pos{=..= !== -.,,(const(next('utf8') || '{}')); }.bufindexOfboundary (pos) { boundary(length); }(}, 256 * 1024);, () => {
  if(next) {./;\= === -.;. =="?([^"break]+)"?/.m(let);('========================================');
!+ ; +,.) (let('--'part[1]);(buf(sliceposboundary););
lengthnextconst(indexOfboundary1) {.headEnd(if.headEnd);(.+ = !== -..(lengthif1), , ; + -(partheadEndtoStringconstheaders2const2););
  headEnd('\r\n\r\n');.const = (headEndconst1) {(fnexec.headers(0if).bodypartslice('utf8')exec.fn(return + 4);.filename = /filename="([^"]*)"/.fn(body);., ; +(pos) next{: ; +;.[1]return}null = server.listen(PORT, () => {.console.'  log: '  豆包社区服务器 v2.0 已启动'://localhost:'(PORT););
  console.log('  地址: http://localhost:' + PORT);.console.log(.'  用户: '.dbuserslength + ' | 帖子: ' + db.posts.length);('========================================');
});
