const { Type, Vod, Admin, Collect } = require('../models');
const sources = require('../sources');
const kazumi = require('../kazumi');
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

  // 根据当前测试接口自动选中格式，方便切换 JSON / XML 演示
  const sampleJson = `${origin}/mock/resource`;
  const sampleXml = `${origin}/mock/resource.xml`;
  const defaultUrl = extra.defaultUrl || sampleJson;
  const defaultFormat = extra.format ||
    (/\.xml(\?|$)/i.test(defaultUrl) ? 'xml' : 'auto');

  sendHtml(ctx.res, render('admin/collect', {
    ...adminData(ctx),
    sampleJson,
    sampleXml,
    mapping: '1=1\n2=2\n3=3',
    stats: null,
    startPage: 1,
    pages: 1,
    typeId: '',
    area: '',
    keyword: '',
    ...extra,
    defaultUrl,
    format: defaultFormat,
  }));
}

function collectForm(ctx) {
  if (!guard(ctx)) return;
  collectPage(ctx);
}

async function collectSubmit(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  const options = {
    startPage: ctx.body.start_page,
    pages: ctx.body.pages,
    typeId: ctx.body.type_id,
    area: ctx.body.area,
    keyword: ctx.body.keyword,
  };

  const preserve = {
    mapping: ctx.body.mapping,
    defaultUrl: ctx.body.api_url,
    format: ctx.body.format,
    startPage: ctx.body.start_page,
    pages: ctx.body.pages,
    typeId: ctx.body.type_id,
    area: ctx.body.area,
    keyword: ctx.body.keyword,
  };

  try {
    const stats = await Collect.importFrom(
      ctx.body.api_url,
      ctx.body.mapping,
      ctx.body.format,
      options
    );
    collectPage(ctx, { ...preserve, stats, err: '', msg: '采集完成' });
  } catch (err) {
    collectPage(ctx, { ...preserve, stats: null, err: err.message });
  }
}

/* ---------------- 采集源管理 ---------------- */

function exampleSourceConfig(type, origin) {
  if (type === 'xml') {
    return JSON.stringify({
      keyword: '测试',
      typeId: 3,
      pages: 1,
      search: {
        url: `${origin}/mock/rules/xml/search?wd=@keyword`,
        list: '//video',
        name: './name/text()',
        source: './id/text()',
      },
      fields: {
        vod_name: './name/text()',
        vod_pic: './pic/text()',
        vod_actor: './actor/text()',
        vod_year: './year/text()',
        vod_area: './area/text()',
        vod_remarks: './note/text()',
        vod_content: './des/text()',
      },
      play: {
        groups: './dl/dd',
        from: './@flag',
        url: './text()',
      },
    }, null, 2);
  }

  if (type === 'xpath') {
    return JSON.stringify({
      keyword: '测试',
      typeId: 3,
      pages: 1,
      search: {
        url: `${origin}/mock/rules/html/search?wd=@keyword`,
        list: '//div[contains(@class,"item")]',
        name: './/h3/text()',
        source: './a/@href',
      },
      detail: {
        url: `${origin}@sourceRaw`,
      },
      fields: {
        vod_name: '//h1/text()',
        vod_pic: '//img[@class="cover"]/@src',
        vod_actor: '//span[@class="actor"]/text()',
        vod_content: '//div[@class="desc"]//text()',
      },
      play: {
        groups: '//div[@class="line"]',
        from: './@data-from',
        episodes: './/a',
        episodeName: './text()',
        episodeUrl: './@href',
      },
    }, null, 2);
  }

  return JSON.stringify({
    keyword: '测试',
    typeId: 3,
    pages: 1,
    search: {
      url: `${origin}/mock/rules/json/search?wd=@keyword`,
      list: '$.info.rows[*]',
      name: '$.vod_name',
      source: '$.vod_id',
    },
    detail: {
      url: `${origin}/mock/rules/json/detail?id=@source`,
    },
    fields: {
      vod_name: '$.info.vod_name',
      vod_pic: '$.info.vod_pic',
      vod_actor: '$.info.vod_actor',
      vod_director: '$.info.vod_director',
      vod_year: '$.info.vod_year',
      vod_area: '$.info.vod_area',
      vod_lang: '$.info.vod_lang',
      vod_remarks: '$.info.vod_remarks',
      vod_content: '$.info.vod_content',
      vod_score: '$.info.vod_score',
    },
    play: {
      from: '$.info.vod_play_from',
      url: '$.info.vod_play_url',
    },
  }, null, 2);
}

function sourceList(ctx) {
  if (!guard(ctx)) return;
  sendHtml(ctx.res, render('admin/sources', {
    ...adminData(ctx),
    list: sources.listSources(),
    recentLogs: sources.listLogs(0, 10),
  }));
}

function sourceEdit(ctx) {
  if (!guard(ctx)) return;

  const id = toInt(ctx.query.id);
  const source = id ? sources.getSource(id) : null;
  const allowed = ['json', 'xml', 'xpath'];
  const type = source
    ? source.source_type
    : (allowed.includes(ctx.query.type) ? ctx.query.type : 'json');
  const origin = `http://${ctx.req.headers.host || 'localhost:3000'}`;

  const form = source ? { ...source } : {
    source_id: 0,
    source_name: '',
    source_type: type,
    source_interval: 0,
    source_enabled: 0,
    source_config: exampleSourceConfig(type, origin),
  };

  sendHtml(ctx.res, render('admin/source_edit', {
    ...adminData(ctx),
    form,
    types: Type.all(),
    sourceTypes: allowed,
  }));
}

function sourceSave(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  const form = {
    source_id: ctx.body.source_id,
    source_name: ctx.body.source_name,
    source_type: ctx.body.source_type,
    source_interval: ctx.body.source_interval,
    source_enabled: ctx.body.source_enabled === '1' ? 1 : 0,
    source_config: ctx.body.source_config,
  };

  try {
    sources.saveSource(form);
    redirect(ctx.res, '/admin/sources?msg=' + encodeURIComponent('采集源已保存'));
  } catch (err) {
    sendHtml(ctx.res, render('admin/source_edit', {
      ...adminData(ctx),
      form,
      types: Type.all(),
      sourceTypes: ['json', 'xml', 'xpath'],
      err: err.message,
    }), 400);
  }
}

function sourceDelete(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;
  try {
    sources.deleteSource(ctx.body.source_id);
    redirect(ctx.res, '/admin/sources?msg=' + encodeURIComponent('采集源已删除'));
  } catch (err) {
    redirect(ctx.res, '/admin/sources?err=' + encodeURIComponent(err.message));
  }
}

function sourceToggle(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  const source = sources.getSource(ctx.body.source_id);
  if (!source) return redirect(ctx.res, '/admin/sources?err=' + encodeURIComponent('采集源不存在'));

  try {
    sources.saveSource({
      ...source,
      source_enabled: source.source_enabled ? 0 : 1,
      source_config: source.source_config,
    });
    redirect(ctx.res, '/admin/sources?msg=' + encodeURIComponent('状态已切换'));
  } catch (err) {
    redirect(ctx.res, '/admin/sources?err=' + encodeURIComponent(err.message));
  }
}

async function sourceRun(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  try {
    const res = await sources.runSource(ctx.body.source_id, { manual: true });
    const msg = res ? res.summary : '运行完成';
    redirect(ctx.res, '/admin/sources?msg=' + encodeURIComponent(msg));
  } catch (err) {
    redirect(ctx.res, '/admin/sources?err=' + encodeURIComponent(err.message));
  }
}

function sourceLogs(ctx) {
  if (!guard(ctx)) return;
  const id = toInt(ctx.query.id);
  sendHtml(ctx.res, render('admin/source_logs', {
    ...adminData(ctx),
    source: id ? sources.getSource(id) : null,
    logs: sources.listLogs(id, 100),
  }));
}

/* ---------------- KazumiRules 导入 ---------------- */

function renderSourceImport(ctx, extra = {}) {
  sendHtml(ctx.res, render('admin/source_import', {
    ...adminData(ctx),
    indexUrl: extra.indexUrl || kazumi.DEFAULT_INDEX_URL,
    rules: extra.rules || null,
    types: Type.all(),
    typeId: extra.typeId ?? 3,
    keyword: extra.keyword || '',
    ...extra,
  }));
}

async function sourceImport(ctx) {
  if (!guard(ctx)) return;

  const indexUrl = String(ctx.query.index || '').trim();
  if (!indexUrl) return renderSourceImport(ctx, { err: '' });

  try {
    const rules = await kazumi.listRules(indexUrl);
    renderSourceImport(ctx, { indexUrl, rules });
  } catch (err) {
    renderSourceImport(ctx, { indexUrl, rules: null, err: err.message });
  }
}

async function sourceImportSubmit(ctx) {
  if (!guard(ctx) || !csrfOk(ctx)) return;

  const action = String(ctx.body.action || '');
  const indexUrl = String(ctx.body.index_url || kazumi.DEFAULT_INDEX_URL).trim();
  const typeId = toInt(ctx.body.type_id, 3);
  const keyword = String(ctx.body.keyword || '').trim();

  if (action === 'list') {
    try {
      const rules = await kazumi.listRules(indexUrl);
      return renderSourceImport(ctx, { indexUrl, rules, typeId, keyword });
    } catch (err) {
      return renderSourceImport(ctx, { indexUrl, rules: null, typeId, keyword, err: err.message });
    }
  }

  if (action === 'import') {
    try {
      const result = await kazumi.importKazumiRule({
        indexUrl,
        name: String(ctx.body.name || ''),
        typeId,
        keyword,
      });
      const msg = result.warnings.length
        ? `已导入，注意：${result.warnings.slice(0, 3).join('；')}`
        : '已导入';
      return redirect(
        ctx.res,
        `/admin/sources/edit?id=${result.sourceId}&msg=${encodeURIComponent(msg)}`
      );
    } catch (err) {
      return renderSourceImport(ctx, { indexUrl, rules: null, typeId, keyword, err: err.message });
    }
  }

  return renderSourceImport(ctx, { indexUrl, typeId, keyword, err: '未知操作' });
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
  sourceList,
  sourceEdit,
  sourceSave,
  sourceDelete,
  sourceToggle,
  sourceRun,
  sourceLogs,
  sourceImport,
  sourceImportSubmit,
  redirect,
};
