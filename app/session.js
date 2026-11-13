const { randomToken } = require('./security');

/**
 * 最简 session：进程内 Map。
 * 重启服务后登录态会丢失；生产环境应换成 Redis / 数据库 / 框架 session。
 */
const sessions = new Map();

const COOKIE_NAME = 'mini_cms_sid';
const SESSION_TTL = 7 * 24 * 3600 * 1000;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(id);
  }
}

function getSession(req, res) {
  cleanup();
  const cookies = parseCookies(req);
  let sid = cookies[COOKIE_NAME];
  let session = sid ? sessions.get(sid) : null;

  if (!session) {
    sid = randomToken(24);
    session = {
      id: sid,
      adminId: 0,
      adminName: '',
      csrf: randomToken(24),
      createdAt: Date.now(),
    };
    sessions.set(sid, session);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`
    );
  }

  return session;
}

function loginSession(session, admin) {
  session.adminId = admin.admin_id;
  session.adminName = admin.admin_name;
  session.csrf = randomToken(24);
}

function logoutSession(req, res, session) {
  sessions.delete(session.id);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isAdmin(session) {
  return !!session.adminId;
}

function verifyCsrf(session, token) {
  return !!session.csrf && String(token || '') === session.csrf;
}

module.exports = {
  getSession,
  loginSession,
  logoutSession,
  isAdmin,
  verifyCsrf,
  parseCookies,
};
