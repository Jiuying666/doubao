/**
 * ============================================================
 * 豆包社区 - 后端服务器（Node.js，单文件，容易看懂容易改）
 * ============================================================
 * 功能清单：
 *   POST /api/register  注册账号（昵称+密码+手机号选填）
 *   POST /api/login     登录（手机号或昵称+密码）
 *   POST /api/me        拉取自己的最新资料（豆包币/发帖数等）
 *   POST /api/upload    上传图片（聊天发图用）
 *   GET  /files/xxx     访问上传的图片
 *   GET  /api/stats     在线人数 / 总用户数
 *   GET  /              服务器状态页（浏览器打开能看）
 *   WS   /ws            聊天室 WebSocket（实时消息+在线人数）
 *
 * 数据保存：data/db.json（用户和最近 300 条消息）
 * 图片保存：data/uploads/
 *
 * 如何部署（免费）：看同目录《部署教程.md》
 * ============================================================
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

/* ==================== 数据库（JSON 文件版） ====================
 * 说明：测试阶段用 JSON 文件存数据，零成本零配置。
 * 以后用户量大了，可以换成 MySQL/MongoDB，只需改这里的读写函数。
 */
let db = { users: [], msgs: [] };
try {
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.users)) db.users = parsed.users;
  if (Array.isArray(parsed.msgs)) db.msgs = parsed.msgs;
} catch (e) { /* 第一次运行没有文件，正常 */ }
let dirty = false;

/** 把内存数据落盘（每 10 秒一次，只在有变化时写） */
function saveDb() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
  } catch (e) {
    console.error('保存数据失败:', e.message);
  }
}
setInterval(saveDb, 10000);

function saveNow() { dirty = true; saveDb(); }
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
process.on('SIGINT', () => { saveNow(); process.exit(0); });

/* ==================== 工具函数 ==================== */

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
/** 密码加密存储（加盐，不存明文） */
function hashPassword(pass) {
  return sha256('doubao-salt-2026::' + pass);
}
/** 生成随机 token（登录凭证） */
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}
/** 分配用户 ID：从 100001 开始自增 */
function nextUserId() {
  let max = 100000;
  db.users.forEach(u => { if (u.id > max) max = u.id; });
  return max + 1;
}
/** 对外输出的用户信息（不包含密码！） */
function publicUser(u) {
  return {
    id: u.id,
    nickname: u.nickname,
    phone: u.phone || '',
    coins: u.coins || 0,
    followers: u.followers || 0,
    following: u.following || 0,
    posts: u.posts || 0,
  };
}
function findUserByToken(token) {
  if (!token) return null;
  return db.users.find(u => u.token === token) || null;
}

/* ==================== HTTP 服务 ==================== */

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const method = req.method || 'GET';

  // 跨域头（方便网页调试，不影响 App 使用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* ---- 首页：服务器状态页（浏览器打开能看见） ---- */
  if (method === 'GET' && (urlPath === '/' || urlPath === '/api')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const online = authedClients();
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>豆包社区服务器</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:60px auto;color:#1F2430">
  <h1>豆包 🫛 服务器运行中</h1>
  <p>✅ 服务正常 &nbsp;|&nbsp; 在线 <b>${online}</b> 人 &nbsp;|&nbsp; 总用户 <b>${db.users.length}</b> 人 &nbsp;|&nbsp; 消息 <b>${db.msgs.length}</b> 条</p>
  <p>接口：/api/register /api/login /api/me /api/upload /api/stats /ws</p>
</body></html>`);
    return;
  }

  /* ---- 在线人数/总用户数 ---- */
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

      // 查重：昵称和手机号都不能重复
      if (db.users.some(u => u.nickname === nickname))
        return send(res, 400, { ok: false, msg: '这个昵称已被占用' });
      if (phone && db.users.some(u => u.phone === phone))
        return send(res, 400, { ok: false, msg: '这个手机号已注册过' });

      const user = {
        id: nextUserId(),
        nickname,
        phone,
        pass: hashPassword(password),   // 存加密后的密码
        coins: 100,                      // 注册送 100 豆包币
        followers: 0,
        following: 0,
        posts: 0,                        // 发帖数（决定等级）
        token: makeToken(),
        created: Date.now(),
      };
      db.users.push(user);
      dirty = true;
      console.log('[注册]', nickname, phone || '(无手机号)');
      return send(res, 200, { ok: true, msg: '注册成功', data: { token: user.token, user: publicUser(user) } });
    });
  }

  /* ---- 登录 ---- */
  if (method === 'POST' && urlPath === '/api/login') {
    return readJson(req, (body, err) => {
      if (err) return send(res, 400, { ok: false, msg: '请求格式错误' });
      const account = String(body.account || '').trim();
      const password = String(body.password || '');
      const u = db.users.find(x => x.nickname === account || (x.phone && x.phone === account));
      if (!u || u.pass !== hashPassword(password))
        return send(res, 400, { ok: false, msg: '账号或密码不对' });

      u.token = makeToken(); // 每次登录换新 token
      dirty = true;
      console.log('[登录]', u.nickname);
      return send(res, 200, { ok: true, msg: '登录成功', data: { token: u.token, user: publicUser(u) } });
    });
  }

  /* ---- 拉取自己的最新资料 ---- */
  if (method === 'POST' && urlPath === '/api/me') {
    return readJson(req, (body) => {
      const u = findUserByToken(body.token);
      if (!u) return send(res, 401, { ok: false, msg: '登录已失效，请重新登录' });
      return send(res, 200, { ok: true, data: { user: publicUser(u) } });
    });
  }

  /* ---- 上传图片 ---- */
  if (method === 'POST' && urlPath === '/api/upload') {
    return readBody(req, (buf, err) => {
      if (err) return send(res, 413, { ok: false, msg: '文件太大（上限 10MB）' });
      const part = extractMultipartFile(buf, req.headers['content-type'] || '');
      if (!part)
        return send(res, 400, { ok: false, msg: '上传格式错误' });

      // 只允许图片后缀，随机文件名防覆盖
      const extOk = /\.(png|jpe?g|gif|webp)$/i.test(part.filename);
      if (!extOk) return send(res, 400, { ok: false, msg: '只能上传图片' });
      const ext = path.extname(part.filename).toLowerCase();
      const name = Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + ext;

      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), part.body);
      console.log('[上传]', name, part.body.length, 'bytes');
      return send(res, 200, { ok: true, msg: '上传成功', data: { url: '/files/' + name } });
    }, 10 * 1024 * 1024);
  }

  /* ---- 访问上传的图片 ---- */
  if (method === 'GET' && urlPath.startsWith('/files/')) {
    const name = path.basename(urlPath); // 防目录穿越攻击
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(404); return res.end('not found'); }
    const file = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    res.writeHead(200, { 'Content-Type': mimeMap[path.extname(name)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, msg: '接口不存在' }));
});

/* ==================== WebSocket 聊天室 ==================== */

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.user = null; // 认证后才有值

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let o;
    try { o = JSON.parse(raw.toString()); } catch (e) { return; }
    const type = o.type;

    // 心跳
    if (type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));

    // 认证：App 连上后先发 token
    if (type === 'auth') {
      const u = findUserByToken(o.token);
      if (!u) return ws.send(JSON.stringify({ type: 'error', msg: '登录已失效，请重新登录' }));
      ws.user = u;
      // 1.告诉本人：认证成功 + 自己的最新资料 + 在线人数
      ws.send(JSON.stringify(Object.assign(
        { type: 'auth_ok', me: publicUser(u) }, stats())));
      // 2.发最近 200 条历史消息
      ws.send(JSON.stringify({ type: 'history', msgs: db.msgs.slice(-200) }));
      // 3.告诉大家：新同学来了
      broadcast({ type: 'sys', content: '📢 ' + u.nickname + ' 加入了聊天室' });
      broadcastStats();
      console.log('[上线]', u.nickname, '当前在线', authedClients());
      return;
    }

    // 后面的操作都必须先登录
    if (!ws.user) return ws.send(JSON.stringify({ type: 'error', msg: '请先登录' }));
    const user = ws.user;

    // 文字 / 大表情
    if (type === 'text' || type === 'sticker') {
      const content = String(o.content || '').slice(0, 2000);
      if (!content) return;
      return pushMsg({ type, content, url: '', user });
    }

    // 图片
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
      console.log('[下线]', ws.user.nickname, '当前在线', authedClients());
    }
  });
});

/** 新消息：保存 + 广播给所有人 + 发帖数+1（等级成长） */
function pushMsg({ type, content, url, user }) {
  const msg = {
    id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    type,                    // text / sticker / image
    content: content || '',
    url: url || '',
    userId: user.id,
    nickname: user.nickname,
    ts: Date.now(),
  };
  db.msgs.push(msg);
  if (db.msgs.length > 300) db.msgs = db.msgs.slice(-300); // 只留最近300条
  user.posts = (user.posts || 0) + 1; // ★ 发帖数+1，App 端据此算等级
  dirty = true;
  // 直接广播消息本体：{type:"text"/"sticker"/"image", ...}
  broadcast(msg);
}

/** 广播给所有已认证的连接 */
function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && c.user) c.send(s);
  });
}
function authedClients() {
  let n = 0;
  wss.clients.forEach(c => { if (c.user) n++; });
  return n;
}
function stats() {
  return { online: authedClients(), total: db.users.length };
}
/** 每 20 秒广播一次在线人数（进出房间时也会即时广播） */
function broadcastStats() {
  broadcast(Object.assign({ type: 'stats' }, stats()));
}
setInterval(broadcastStats, 20000);

/** 服务器主动心跳：清掉假死的连接（手机断网等） */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

/* ==================== 底层小工具 ==================== */

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 读取请求体（限制大小防攻击） */
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

/** 读取 JSON 请求体 */
function readJson(req, cb) {
  readBody(req, (buf, err) => {
    if (err) return cb(null, err);
    try { cb(JSON.parse(buf.toString('utf8') || '{}')); }
    catch (e) { cb(null, e); }
  }, 256 * 1024);
}

/** 从 multipart/form-data 里取出第一个文件（文件名+内容） */
function extractMultipartFile(buf, contentType) {
  // boundary 值可能带前导连字符（curl 风格）或引号，这里通吃
  const m = /boundary="?([^";\s]+)"?/.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from('--' + m[1]);
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const next = buf.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    // 每一段：去掉开头 \r\n 和结尾 \r\n
    let part = buf.slice(pos + boundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const headers = part.slice(0, headEnd).toString('utf8');
      const body = part.slice(headEnd + 4);
      const fn = /filename="([^"]*)"/.exec(headers);
      if (fn) return { filename: fn[1], body };
    }
    pos = next;
  }
  return null;
}

/* ==================== 启动 ==================== */

server.listen(PORT, () => {
  console.log('========================================');
  console.log('  豆包社区服务器已启动');
  console.log('  地址: http://localhost:' + PORT);
  console.log('  用户数: ' + db.users.length + '  消息数: ' + db.msgs.length);
  console.log('========================================');
});
