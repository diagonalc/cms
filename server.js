const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

require('./app/db'); // 初始化数据库 + 演示数据
const front = require('./app/controllers/front');
const admin = require('./app/controllers/admin');
const { getSession } = require('./app/session');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

/** 读取 POST 表单体，限制 2MB。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          reject(new Error('JSON 格式错误'));
        }
        return;
      }
      const params = new URLSearchParams(raw);
      resolve(Object.fromEntries(params.entries()));
    });
    req.on('error', reject);
  });
}

/** 静态文件服务：只允许 public 下的文件，防止 ../ 穿越。 */
function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/static\//, '');
  const file = path.resolve(PUBLIC_DIR, 'static', rel);
  const staticRoot = path.resolve(PUBLIC_DIR, 'static');
  if (!file.startsWith(staticRoot + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** 路由表：method + 正则 + 参数名 + 处理函数。 */
const routes = [
  ['GET', /^\/$/, [], front.home],
  ['GET', /^\/type\/(\d+)$/, ['id'], front.typePage],
  ['GET', /^\/vod\/(\d+)$/, ['id'], front.detail],
  ['GET', /^\/play\/(\d+)-(\d+)-(\d+)$/, ['id', 'sid', 'nid'], front.play],
  ['GET', /^\/search$/, [], front.search],
  ['GET', /^\/mock\/resource$/, [], front.mockResource],

  ['GET', /^\/admin\/login$/, [], admin.loginPage],
  ['POST', /^\/admin\/login$/, [], admin.loginSubmit],
  ['GET', /^\/admin\/logout$/, [], admin.logout],
  ['GET', /^\/admin$/, [], admin.dashboard],
  ['GET', /^\/admin\/types$/, [], admin.typeList],
  ['POST', /^\/admin\/types\/save$/, [], admin.typeSave],
  ['POST', /^\/admin\/types\/delete$/, [], admin.typeDelete],
  ['GET', /^\/admin\/vods$/, [], admin.vodList],
  ['GET', /^\/admin\/vods\/edit$/, [], admin.vodEdit],
  ['POST', /^\/admin\/vods\/save$/, [], admin.vodSave],
  ['POST', /^\/admin\/vods\/delete$/, [], admin.vodDelete],
  ['GET', /^\/admin\/collect$/, [], admin.collectForm],
  ['POST', /^\/admin\/collect$/, [], admin.collectSubmit],
];

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // 静态资源
    if (pathname.startsWith('/static/')) {
      if (serveStatic(req, res, pathname)) return;
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const session = getSession(req, res);
    const body = req.method === 'POST' ? await readBody(req) : {};

    const ctx = {
      req,
      res,
      path: pathname,
      url,
      query: Object.fromEntries(url.searchParams.entries()),
      params: {},
      body,
      session,
    };

    for (const [method, pattern, keys, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec(pathname);
      if (!match) continue;

      keys.forEach((key, i) => {
        ctx.params[key] = match[i + 1];
      });

      await handler(ctx);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>页面不存在</p><p><a href="/">回首页</a></p>');
  } catch (err) {
    console.error('[ERROR]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>500</h1><pre>${String(err.stack || err).replace(/[<>&]/g, '')}</pre>`);
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Mini MacCMS 已启动：http://localhost:${PORT}`);
  console.log(`后台地址：http://localhost:${PORT}/admin`);
  console.log('默认账号：admin / admin123');
  console.log('停止服务：Ctrl + C');
});
