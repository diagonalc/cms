const { Type, Vod } = require('../models');
const { toInt, pageNumbers, pageUrl } = require('../helpers');
const { render } = require('../view');

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  sendHtml(res, '<h1>404</h1><p>页面不存在</p><p><a href="/">回首页</a></p>', 404);
}

function baseData(ctx) {
  return {
    maccms: {
      site_name: 'Mini MacCMS',
      site_url: '',
      path: '',
      date: new Date().toISOString().slice(0, 10),
    },
    user: { user_id: 0, user_name: '' },
    param: { ...ctx.query },
  };
}

function home(ctx) {
  const types = Type.list({ parent: 0, num: 20, order: 'desc', by: 'sort' });
  const latest = Vod.list({ num: 12, order: 'desc', by: 'time' });
  const hot = Vod.list({ num: 12, order: 'desc', by: 'hits' });
  sendHtml(ctx.res, render('front/home', { ...baseData(ctx), types, latest, hot }));
}

function typePage(ctx) {
  const id = toInt(ctx.params.id);
  const type = Type.find(id);
  if (!type || type.type_status !== 1) return notFound(ctx.res);

  const page = Math.max(1, toInt(ctx.query.page, 1));
  const result = Vod.paginate({
    type: id,
    page,
    pageSize: 12,
    by: ctx.query.by || 'time',
    order: ctx.query.order || 'desc',
    wd: ctx.query.wd || '',
  });
  const pages = pageNumbers(result.page, result.pageCount);
  const pageUrlFor = (p) => pageUrl(`/type/${id}`, ctx.query, p);

  sendHtml(ctx.res, render('front/list', {
    ...baseData(ctx),
    type,
    result,
    pages,
    pageUrlFor,
    param: { ...ctx.query, page: result.page },
  }));
}

function detail(ctx) {
  const id = toInt(ctx.params.id);
  const vod = Vod.find(id);
  if (!vod) return notFound(ctx.res);

  Vod.incrementHits(id);
  const related = Vod.list({ type: vod.type_id, num: 7, order: 'desc', by: 'hits' })
    .filter((item) => item.vod_id !== vod.vod_id)
    .slice(0, 6);

  sendHtml(ctx.res, render('front/detail', {
    ...baseData(ctx),
    vod,
    related,
  }));
}

function play(ctx) {
  const id = toInt(ctx.params.id);
  const sid = toInt(ctx.params.sid, 1);
  const nid = toInt(ctx.params.nid, 1);
  const vod = Vod.find(id);
  if (!vod) return notFound(ctx.res);

  const line = vod.play_list.find((item) => item.sid === sid);
  if (!line) return notFound(ctx.res);
  const episode = line.urls.find((item) => item.nid === nid);
  if (!episode) return notFound(ctx.res);

  const prev = line.urls.find((item) => item.nid === nid - 1) || null;
  const next = line.urls.find((item) => item.nid === nid + 1) || null;

  sendHtml(ctx.res, render('front/play', {
    ...baseData(ctx),
    vod,
    line,
    episode,
    sid,
    nid,
    prev,
    next,
  }));
}

function search(ctx) {
  const wd = String(ctx.query.wd || '').trim();
  const page = Math.max(1, toInt(ctx.query.page, 1));
  const result = wd
    ? Vod.paginate({ wd, page, pageSize: 12, order: 'desc', by: 'time' })
    : { list: [], total: 0, page: 1, pageCount: 1, pageSize: 12 };

  const pages = wd ? pageNumbers(result.page, result.pageCount) : [];
  const pageUrlFor = (p) => pageUrl('/search', ctx.query, p);

  sendHtml(ctx.res, render('front/search', {
    ...baseData(ctx),
    wd,
    result,
    pages,
    pageUrlFor,
    param: { ...ctx.query, page: result.page },
  }));
}

/**
 * 本地模拟资源站 API，方便离线测试“采集”。
 * 真实资源站返回的结构也基本是这些字段。
 */
function mockResource(ctx) {
  sendJson(ctx.res, {
    code: 1,
    msg: '数据列表',
    page: 1,
    pagecount: 1,
    limit: 20,
    total: 2,
    class: [
      { type_id: 1, type_name: '电影' },
      { type_id: 2, type_name: '电视剧' },
    ],
    list: [
      {
        vod_id: 9001,
        type_id: 1,
        vod_name: '采集测试电影',
        vod_pic: '',
        vod_actor: '采集演员A,采集演员B',
        vod_director: '采集导演',
        vod_year: '2026',
        vod_area: '中国',
        vod_lang: '国语',
        vod_remarks: 'HD',
        vod_content: '这是通过采集接口导入的测试电影。',
        vod_score: 8.5,
        dl: {
          m3u8: '第1集$https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8#第2集$https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        },
      },
      {
        vod_id: 9002,
        type_id: 2,
        vod_name: '采集测试电视剧',
        vod_pic: '',
        vod_actor: '采集演员C',
        vod_director: '采集导演B',
        vod_year: '2025',
        vod_area: '中国',
        vod_lang: '国语',
        vod_remarks: '更新至2集',
        vod_content: '这是通过采集接口导入的测试电视剧。',
        vod_score: 7.8,
        dl: {
          m3u8: '第1集$https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8#第2集$https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
        },
      },
    ],
  });
}

module.exports = { home, typePage, detail, play, search, mockResource, sendHtml, sendJson, notFound };
