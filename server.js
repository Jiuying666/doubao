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
function hashPass
