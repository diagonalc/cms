/**
 * KazumiRules 导入器
 *
 * 仓库结构：
 *   index.json            规则索引 [{name, version, author, lastUpdate, ...}]
 *   <name>.json           单条规则
 *
 * 这里把 Kazumi 规则转换成我们采集源使用的规则：
 *   { search, detail, fields, play, typeId, keyword, ... }
 *
 * 支持：
 * - API 搜索 + API 选集（delimited / nested）
 * - API 搜索 + XPath 选集（sourceTemplate + chapterRoads/chapterResult）
 * - XPath 搜索 + XPath 选集
 *
 * 不完整支持：
 * - episodePage / variables / antiCrawlerConfig / 高级 XPath
 * 这些会写进 config._warnings，导入后需要人工检查。
 */

const { fetchContent } = require('./rules');
const sources = require('./sources');
const { db } = require('./db');
const { toInt } = require('./helpers');

const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json';

async function fetchJson(url) {
  const text = await fetchContent(url, 'GET', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: 'application/json,text/plain,*/*',
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回内容不是 JSON');
  }
}

function ruleUrlFromIndex(indexUrl, name) {
  try {
    const u = new URL(indexUrl);
    if (!/index\.json$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, '/') + 'index.json';
    }
    u.pathname = u.pathname.replace(/index\.json$/i, `${encodeURIComponent(name)}.json`);
    return u.toString();
  } catch {
    return String(indexUrl).replace(
      /index\.json(?:\?.*)?$/i,
      `${encodeURIComponent(name)}.json`
    );
  }
}

async function listRules(indexUrl = DEFAULT_INDEX_URL) {
  const index = await fetchJson(indexUrl);
  if (!Array.isArray(index)) throw new Error('index.json 不是数组');

  return index.map((item) => ({
    ...item,
    ruleUrl: ruleUrlFromIndex(indexUrl, item.name),
  }));
}

function buildRequest(request, warnings) {
  const req = request || {};
  let url = String(req.url || '');
  if (!url) throw new Error('规则请求缺少 url');

  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const parts = [];
  let limit = 24;

  for (const [key, raw] of Object.entries(query)) {
    if (raw === null || raw === undefined) continue;
    let value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);

    if (value.startsWith('@') && !['@keyword', '@source', '@page', '@offset', '@limit'].includes(value)) {
      warnings.push(`占位符 ${value} 暂不支持`);
    }

    if ((key === 'offset' || key === 'start') && (value === '0' || value === '@offset')) {
      value = '@offset';
    } else if (['limit', 'size', 'pageSize', 'page_size'].includes(key) && /^\d+$/.test(value)) {
      limit = Number(value);
      value = '@limit';
    } else if (key === 'page' && value === '1') {
      value = '@page';
    }

    const encodedKey = encodeURIComponent(key);
    const encodedValue = /^@\w+$/.test(value) ? value : encodeURIComponent(value);
    parts.push(`${encodedKey}=${encodedValue}`);
  }

  if (parts.length) {
    url += (url.includes('?') ? '&' : '?') + parts.join('&');
  }

  return {
    url,
    method: String(req.method || 'GET').toUpperCase(),
    headers: req.headers && typeof req.headers === 'object' ? req.headers : {},
    body: req.body
      ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      : '',
    limit,
  };
}

function toText(xpath) {
  const x = String(xpath || '').trim();
  if (!x) return '';
  if (/\/text\(\)$/.test(x) || /\/@[\w:-]+$/.test(x)) return x;
  return `${x}/text()`;
}

function toHref(xpath) {
  const x = String(xpath || '').trim();
  if (!x) return '';
  if (/\/@[\w:-]+$/.test(x)) return x;
  return `${x}/@href`;
}

function checkXPath(path, label, warnings) {
  if (!path) return;
  if (path.includes('..')) warnings.push(`${label} 含 ..，当前 XPath 子集不支持`);
  if (/\b(following-sibling|preceding-sibling|ancestor|descendant-or-self|not|position)\(/.test(path)) {
    warnings.push(`${label} 含高级 XPath 函数，可能不支持`);
  }
  if (path.includes('|')) warnings.push(`${label} 含 | 联合查询，当前不支持`);
}

function checkJsonPath(path, label, warnings) {
  if (!path) return;
  if (path.includes('..') || path.includes('?(')) {
    warnings.push(`${label} 含高级 JSONPath，当前不支持`);
  }
}

/**
 * 把单条 Kazumi 规则转换成我们的 source config。
 * @returns {{config: object, sourceType: string, warnings: string[]}}
 */
function convertKazumiRule(rule, options = {}) {
  if (!rule || typeof rule !== 'object') throw new Error('不是有效的 Kazumi 规则');

  const warnings = [];
  const typeId = toInt(options.typeId, 3);
  const keyword = String(options.keyword ?? rule.keyword ?? '').trim();
  const baseURL = String(rule.baseURL || '').trim();

  const commonHeaders = {};
  if (rule.referer) commonHeaders.Referer = rule.referer;
  if (rule.userAgent) commonHeaders['User-Agent'] = rule.userAgent;

  let searchType = '';
  let search = null;
  let limit = 24;

  /* ---------- 搜索 ---------- */
  if (rule.searchApiConfig && rule.searchApiConfig.request) {
    searchType = 'json';
    const req = buildRequest(rule.searchApiConfig.request, warnings);
    limit = req.limit;
    const cfg = rule.searchApiConfig;

    checkJsonPath(cfg.listPath, 'search.listPath', warnings);
    checkJsonPath(cfg.namePath, 'search.namePath', warnings);
    checkJsonPath(cfg.sourcePath, 'search.sourcePath', warnings);

    search = {
      url: req.url,
      method: req.method,
      headers: { ...commonHeaders, ...req.headers },
      body: req.body,
      list: cfg.listPath,
      name: cfg.namePath,
      source: cfg.sourcePath,
    };
  } else if (rule.searchURL && rule.searchList) {
    searchType = 'xpath';
    checkXPath(rule.searchList, 'searchList', warnings);
    checkXPath(rule.searchName, 'searchName', warnings);
    checkXPath(rule.searchResult, 'searchResult', warnings);

    search = {
      url: rule.searchURL,
      list: rule.searchList,
      name: toText(rule.searchName),
      source: toHref(rule.searchResult),
    };
  } else {
    throw new Error('该规则没有可识别的搜索配置（searchApiConfig 或 searchURL/searchList）');
  }

  /* ---------- 选集 ---------- */
  let detail = null;
  let detailType = searchType;
  let play = {};

  if (rule.chapterApiConfig && rule.chapterApiConfig.request) {
    detailType = 'json';
    const req = buildRequest(rule.chapterApiConfig.request, warnings);
    detail = {
      url: req.url,
      method: req.method,
      headers: { ...commonHeaders, ...req.headers },
      body: req.body,
      type: 'json',
    };

    const cfg = rule.chapterApiConfig;
    if (cfg.format === 'nested') {
      checkJsonPath(cfg.roadsPath, 'chapter.roadsPath', warnings);
      checkJsonPath(cfg.episodesPath, 'chapter.episodesPath', warnings);
      play = {
        groups: cfg.roadsPath,
        from: cfg.roadNamePath || '',
        episodes: cfg.episodesPath,
        episodeName: cfg.episodeNamePath || './text()',
        episodeUrl: cfg.episodeUrlPath || './@href',
      };
      if (!cfg.episodeUrlPath) {
        warnings.push('nested 规则没有 episodeUrlPath，剧集地址可能取不到');
      }
    } else {
      checkJsonPath(cfg.roadNamesPath, 'chapter.roadNamesPath', warnings);
      checkJsonPath(cfg.roadEpisodesPath, 'chapter.roadEpisodesPath', warnings);
      play = {
        from: cfg.roadNamesPath,
        url: cfg.roadEpisodesPath,
      };
      if (cfg.roadSeparator && cfg.roadSeparator !== '$$$') {
        warnings.push('roadSeparator 不是 $$$，本站按 $$$ 解析');
      }
      if (cfg.episodeSeparator && cfg.episodeSeparator !== '#') {
        warnings.push('episodeSeparator 不是 #，本站按 # 解析');
      }
      if (cfg.fieldSeparator && cfg.fieldSeparator !== '$') {
        warnings.push('fieldSeparator 不是 $，本站按 $ 解析');
      }
    }

    if (cfg.variables && Object.keys(cfg.variables).length) {
      warnings.push('chapter.variables 暂不支持');
    }
    if (cfg.episodePage) {
      warnings.push('规则含 episodePage，已忽略；若剧集地址是播放页而非直链，需要手动调整');
    }
  } else if (rule.chapterRoads && rule.chapterResult) {
    detailType = 'xpath';
    const sourceTemplate = rule.searchApiConfig && rule.searchApiConfig.sourceTemplate;
    const detailUrl = sourceTemplate
      ? String(sourceTemplate).replace(/@source\b/g, '@sourceRaw')
      : '@sourceRaw';

    checkXPath(rule.chapterRoads, 'chapterRoads', warnings);
    checkXPath(rule.chapterResult, 'chapterResult', warnings);

    detail = {
      url: detailUrl,
      type: 'xpath',
    };
    play = {
      groups: rule.chapterRoads,
      episodes: rule.chapterResult,
      episodeName: './text()',
      episodeUrl: './@href',
    };
  } else {
    warnings.push('该规则没有可识别的选集配置，只能导入搜索元数据');
  }

  if (rule.antiCrawlerConfig && rule.antiCrawlerConfig.enabled) {
    warnings.push('规则启用了 antiCrawlerConfig，可能需要验证码/特殊请求头');
  }
  if (detailType === 'json' && detail) {
    warnings.push('API 规则未自动映射额外字段，可在 fields 中补充 vod_pic/vod_content 等');
  }

  const config = {
    keyword,
    typeId,
    pages: 1,
    limit,
    search,
  };
  if (baseURL) config.baseURL = baseURL;
  if (detail) config.detail = detail;
  if (Object.keys(play).length) config.play = play;
  if (warnings.length) config._warnings = warnings;

  return { config, sourceType: searchType, warnings };
}

async function importKazumiRule({ indexUrl, name, typeId, keyword }) {
  if (!indexUrl) throw new Error('缺少 index.json 地址');
  if (!name) throw new Error('缺少规则名称');

  const rules = await listRules(indexUrl);
  const entry = rules.find((r) => r.name === name);
  if (!entry) throw new Error(`规则列表里没有「${name}」`);

  const rule = await fetchJson(entry.ruleUrl);
  const { config, sourceType, warnings } = convertKazumiRule(rule, { typeId, keyword });

  const sourceId = sources.saveSource({
    source_id: 0,
    source_name: `Kazumi · ${rule.name}`,
    source_type: sourceType,
    source_interval: 0,
    source_enabled: 0,
    source_config: JSON.stringify(config, null, 2),
  });

  if (warnings.length) {
    db.prepare('UPDATE collect_sources SET last_message = ? WHERE source_id = ?')
      .run(warnings.join('；').slice(0, 500), sourceId);
  }

  return {
    sourceId,
    ruleName: rule.name,
    sourceType,
    warnings,
    config,
  };
}

module.exports = {
  DEFAULT_INDEX_URL,
  listRules,
  convertKazumiRule,
  importKazumiRule,
  buildRequest,
  toText,
  toHref,
};
