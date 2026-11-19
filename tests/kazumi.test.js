const assert = require('node:assert');
const K = require('../app/kazumi');

/* ---------- API 搜索 + API 选集（delimited） ---------- */
const giri = {
  name: 'giriGiriLove',
  api: '9',
  baseURL: 'https://ani.girigirilove.com',
  searchMode: 'api',
  chapterMode: 'api',
  searchApiConfig: {
    request: {
      method: 'GET',
      url: 'https://m3u8.girigirilove.com/api.php/Vod/get_list',
      query: { vod_name: '@keyword', offset: '0', limit: '24' },
    },
    listPath: '$.info.rows[*]',
    namePath: '$.vod_name',
    sourcePath: '$.vod_id',
    sourceTemplate: '',
  },
  chapterApiConfig: {
    request: {
      method: 'GET',
      url: 'https://m3u8.girigirilove.com/api.php/Vod/get_detail',
      query: { vod_id: '@source' },
    },
    format: 'delimited',
    roadNamesPath: '$.info.vod_play_from',
    roadEpisodesPath: '$.info.vod_play_url',
    roadSeparator: '$$$',
    episodeSeparator: '#',
    fieldSeparator: '$',
    episodePage: {
      url: 'https://pl.girigirilove.com/addons/aplyer/atom.php',
      query: { key: '0', url: '@episodeUrl' },
    },
  },
};

const g = K.convertKazumiRule(giri, { typeId: 3, keyword: '芙莉莲' });
assert.equal(g.sourceType, 'json');
assert.equal(g.config.typeId, 3);
assert.equal(g.config.limit, 24);
assert.ok(g.config.search.url.includes('vod_name=@keyword'));
assert.ok(g.config.search.url.includes('offset=@offset'));
assert.ok(g.config.search.url.includes('limit=@limit'));
assert.equal(g.config.detail.type, 'json');
assert.equal(g.config.play.from, '$.info.vod_play_from');
assert.equal(g.config.play.url, '$.info.vod_play_url');
assert.ok(g.warnings.some((w) => w.includes('episodePage')));

/* ---------- XPath 搜索 + XPath 选集 ---------- */
const xpathRule = {
  name: '7sefun',
  api: '4',
  baseURL: 'https://www.7sefun.top/',
  searchURL: 'https://www.7sefun.top/vodsearch/-------------.html?wd=@keyword',
  searchList: '//div[2]/div[2]/div[2]/div[2]/div',
  searchName: '//div[2]/text()',
  searchResult: '//a',
  chapterRoads: '//div[2]/div[2]/div[2]/div/div[2]/div[1]//div',
  chapterResult: '//a',
};

const x = K.convertKazumiRule(xpathRule, { typeId: 3 });
assert.equal(x.sourceType, 'xpath');
assert.ok(x.config.search.name.endsWith('/text()'));
assert.ok(x.config.search.source.endsWith('/@href'));
assert.equal(x.config.detail.type, 'xpath');
assert.equal(x.config.detail.url, '@sourceRaw');
assert.equal(x.config.play.groups, xpathRule.chapterRoads);
assert.equal(x.config.play.episodes, xpathRule.chapterResult);

/* ---------- API 搜索 + XPath 选集（混合） ---------- */
const hybrid = {
  name: 'TvTFun',
  api: '9',
  baseURL: 'https://www.tvtfun.net',
  searchApiConfig: {
    request: {
      method: 'GET',
      url: 'https://www.tvtfun.net/api/client/anime',
      query: { keyword: '@keyword', page: 1, pageSize: 24 },
    },
    listPath: '$.data.items[*]',
    namePath: '$.name',
    sourcePath: '$.slug',
    sourceTemplate: 'https://www.tvtfun.net/watch/@source/1',
  },
  chapterRoads: "//ol[@class*='tvt-watch-episodes']",
  chapterResult: '//li/a',
};

const h = K.convertKazumiRule(hybrid, { typeId: 3 });
assert.equal(h.sourceType, 'json');
assert.equal(h.config.detail.type, 'xpath');
assert.equal(h.config.detail.url, 'https://www.tvtfun.net/watch/@sourceRaw/1');
assert.equal(h.config.play.groups, hybrid.chapterRoads);
assert.equal(h.config.play.episodes, hybrid.chapterResult);

/* ---------- nested 选集 ---------- */
const nested = {
  name: 'sorani',
  api: '8',
  baseURL: 'https://www.sorani.net/',
  searchApiConfig: {
    request: {
      method: 'GET',
      url: 'https://api.sorani.cc/sorani-cms/api/video',
      query: { page: 1, size: 50, keyword: '@keyword' },
    },
    listPath: '$.data.records[*]',
    namePath: '$.title',
    sourcePath: '$.id',
  },
  chapterApiConfig: {
    request: {
      method: 'GET',
      url: 'https://api.sorani.cc/sorani-cms/api/video/@source',
    },
    format: 'nested',
    roadsPath: '$.data',
    roadNamePath: '',
    episodesPath: '$.episodes[*]',
    episodeNamePath: '$.episodeLabel',
    episodeUrlPath: '$.episodeOrder',
    episodePage: {
      url: 'https://www.sorani.net/anime/mal/@source/episode/@episodeUrl',
      query: {},
    },
  },
};

const n = K.convertKazumiRule(nested, { typeId: 3 });
assert.equal(n.config.play.groups, '$.data');
assert.equal(n.config.play.episodes, '$.episodes[*]');
assert.equal(n.config.play.episodeName, '$.episodeLabel');
assert.equal(n.config.play.episodeUrl, '$.episodeOrder');
assert.ok(n.warnings.some((w) => w.includes('episodePage')));

/* ---------- URL 辅助 ---------- */
assert.equal(K.toText('//h3'), '//h3/text()');
assert.equal(K.toText('//h3/text()'), '//h3/text()');
assert.equal(K.toHref('//a'), '//a/@href');
assert.equal(K.toHref('//a/@href'), '//a/@href');

const req = K.buildRequest({
  url: 'https://api.example.com/list',
  query: { keyword: '@keyword', page: 1, offset: '0', limit: '20' },
}, []);
assert.ok(req.url.includes('keyword=@keyword'));
assert.ok(req.url.includes('page=@page'));
assert.ok(req.url.includes('offset=@offset'));
assert.ok(req.url.includes('limit=@limit'));
assert.equal(req.limit, 20);

console.log('kazumi conversion tests passed');
