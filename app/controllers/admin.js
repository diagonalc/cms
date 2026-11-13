const { Type, Vod, Admin, Collect } = require('../models');
const { toInt, pageNumbers, pageUrl } = require('../helpers');
const { render } = require('../view');
const { isAdmin, loginSession, logoutSession, verifyCsrf } = require('../session');

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function adminData(ctx) {
  return {
    adminName: ctx.session.adminName,
    csrf: ctx.session.csrf,
    msg: String(ctx.query.msg || ''),
    err: String(ctx.query.err || ''),
    current: ctx.path,
    maccms: { site_name: 'Mini MacCMS 后台', path: '' },
  };
}

function guard(ctx) {
  if (!isAdmin(ctx.session)) {
    redirect(ctx.res, '/admin/login');
    return false;
  }
  return true;
}

function csrfOk(ctx) {
  if (!verifyCsrf(ctx.session, ctx.body._csrf)) {
    sendHtml(ctx.res, '<h1>403</h1><p>CSRF 校验失败，请刷新页面重试。</p>', 403);
    return false;
  }
  return true;
}

/* ---------------- 登录 / 退出 ---------------- */

function loginPage(ctx) {
  if (isAdmin(ctx.session)) return redirect(ctx.res, '/admin');
  sendHtml(ctx.res, render('admin/login', {
    ...adminData(ctx),
    err: String(ctx.query.err || ''),
  }));
}

function loginSubmit(ctx) {
  if (!csrfOk(ctx)) return;
  const admin = Admin.login(ctx.body.admin_name, ctx.body.admin_pwd);
  if (!admin) return redirect(ctx.res, '/admin/login?err=' + encodeURIComponent('账号或密码错误'));

  loginSession(ctx.session, admin);
  redirect(ctx.res, '/admin');
}

function logout(ctx) {
  logoutSession(ctx.req, ctx.res, ctx.session);
  redirect(ctx.res, '/admin/login');
}

/* ---------------- 仪表盘 ---------------- */

function dashboard(ctx) {
  if (!guard(ctx)) return;
  const stats = {
    types: Type.all().length,
    vods: Vod.paginate({ page: 1, pageSize: 1 }, true).total,
    published: Vod.paginate({ page: 1, pageSize: 1 }, false).total,
  };
  sendHtml(ctx.res, render('admin/dashboard', { ...adminData(ctx), stats }));
}

/* ---------------- 分类管理 ---------------- */

function typeList(ctx) {
  if (!guard(ctx)) return;
  const rows = Type.all();
  const nameById = new Map(rows.map((r) => [r.type_id, r.type_name]));
  const types = rows.map((r) => ({
    ...r,
    parent_name: r.type_pid ? (nameById.get(r.type_pid) || '未知') : '顶级分类',
  }));
  const editId = toInt(ctx.query.edit);
  const edit = editId ? Type.find(editId) : null;
  sendHtml(ctx.res, render('admin/types', { ...adminData(ctx), types, edit }));
}

function typeSave(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;
  try {
    Type.save(ctx.body);
    redirect(ctx.res, '/admin/types?msg=' + encodeURIComponent('分类已保存'));
  } catch (err) {
    redirect(ctx.res, '/admin/types?err=' + encodeURIComponent(err.message));
  }
}

function typeDelete(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;
  try {
    Type.remove(ctx.body.type_id);
    redirect(ctx.res, '/admin/types?msg=' + encodeURIComponent('分类已删除'));
  } catch (err) {
    redirect(ctx.res, '/admin/types?err=' + encodeURIComponent(err.message));
  }
}

/* ---------------- 影片管理 ---------------- */

function vodList(ctx) {
  if (!guard(ctx)) return;
  const page = Math.max(1, toInt(ctx.query.page, 1));
  const wd = String(ctx.query.wd || '').trim();
  const result = Vod.paginate({ wd, page, pageSize: 20 }, true);
  sendHtml(ctx.res, render('admin/vods', {
    ...adminData(ctx),
    result,
    wd,
    pages: pageNumbers(result.page, result.pageCount),
    pageUrlFor: (p) => pageUrl('/admin/vods', { wd }, p),
  }));
}

function vodEdit(ctx) {
  if (!guard(ctx)) return;
  const id = toInt(ctx.query.id);
  const vod = id ? Vod.find(id, true) : null;

  const form = vod ? {
    ...vod,
    play_from: (vod.vod_play_from || '').split('$$$').filter(Boolean).join('\n'),
    play_url: (vod.vod_play_url || '').split('$$$').filter(Boolean).join('\n'),
  } : {
    vod_id: 0,
    type_id: 0,
    vod_name: '',
    vod_en: '',
    vod_pic: '',
    vod_actor: '',
    vod_director: '',
    vod_year: String(new Date().getFullYear()),
    vod_area: '',
    vod_lang: '国语',
    vod_remarks: '',
    vod_content: '',
    vod_status: 1,
    vod_score: 0,
    play_from: 'm3u8',
    play_url: '第1集$https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  };

  sendHtml(ctx.res, render('admin/vod_edit', {
    ...adminData(ctx),
    form,
    types: Type.all(),
  }));
}

function vodSave(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  const form = {
    ...ctx.body,
    play_from: ctx.body.play_from || '',
    play_url: ctx.body.play_url || '',
  };

  try {
    const id = Vod.save(form);
    redirect(ctx.res, `/admin/vods?msg=${encodeURIComponent('影片已保存')}&highlight=${id}`);
  } catch (err) {
    sendHtml(ctx.res, render('admin/vod_edit', {
      ...adminData(ctx),
      form,
      types: Type.all(),
      err: err.message,
    }), 400);
  }
}

function vodDelete(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;
  Vod.remove(ctx.body.vod_id);
  redirect(ctx.res, '/admin/vods?msg=' + encodeURIComponent('影片已删除'));
}

/* ---------------- 采集 ---------------- */

function collectPage(ctx, extra = {}) {
  const origin = `http://${ctx.req.headers.host || 'localhost:3000'}`;
  sendHtml(ctx.res, render('admin/collect', {
    ...adminData(ctx),
    defaultUrl: `${origin}/mock/resource`,
    mapping: '1=1\n2=2\n3=3',
    stats: null,
    ...extra,
  }));
}

function collectForm(ctx) {
  if (!guard(ctx)) return;
  collectPage(ctx);
}

async function collectSubmit(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  try {
    const stats = await Collect.importFrom(ctx.body.api_url, ctx.body.mapping);
    collectPage(ctx, {
      stats,
      err: '',
      msg: '采集完成',
      mapping: ctx.body.mapping,
      defaultUrl: ctx.body.api_url,
    });
  } catch (err) {
    collectPage(ctx, {
      stats: null,
      err: err.message,
      mapping: ctx.body.mapping,
      defaultUrl: ctx.body.api_url,
    });
  }
}

module.exports = {
  loginPage,
  loginSubmit,
  logout,
  dashboard,
  typeList,
  typeSave,
  typeDelete,
  vodList,
  vodEdit,
  vodSave,
  vodDelete,
  collectForm,
  collectSubmit,
  redirect,
};
