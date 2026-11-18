/** HTML 转义：所有输出到模板的用户数据都必须经过它。 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 只保留 ASCII 字母/数字/连字符；中文标题无法转拼音时退回 vod-时间戳。 */
function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || `vod-${Date.now()}`;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${formatDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 简单的分页数组：1 ... 4 5 6 ... 20 */
function pageNumbers(current, total, around = 2) {
  if (total <= 0) return [];
  const pages = new Set([1, total]);
  for (let i = current - around; i <= current + around; i++) {
    if (i >= 1 && i <= total) pages.add(i);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('...');
    out.push(sorted[i]);
  }
  return out;
}

/** 生成保留当前查询参数、只替换 page 的 URL。 */
function pageUrl(basePath, query, page) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (k !== 'page' && v !== undefined && v !== null && v !== '') params.set(k, v);
  }
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function toInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---------- 影视站 URL 助手，对应 maccms 的 mac_url_* ---------- */

function mac_url_type(type) {
  return `/type/${type.type_id}`;
}

function mac_url_vod_detail(vod) {
  return `/vod/${vod.vod_id}`;
}

function mac_url_vod_play(vod, sid = 1, nid = 1) {
  return `/play/${vod.vod_id}-${sid}-${nid}`;
}

function mac_url_search(keyword) {
  return `/search?wd=${encodeURIComponent(keyword || '')}`;
}

/** 是否是浏览器/播放器可以直接播放的直链（m3u8 或 mp4/webm 等）。 */
function isDirectPlayUrl(url) {
  return /\.(m3u8|mp4|webm|ogg|mov)(\?|$)/i.test(String(url || ''));
}

/** 把播放地址字符串展开成线路/剧集结构（maccms 的 mac_play_list 简化版）。 */
function parsePlayList(from, url) {
  const fromList = from ? String(from).split('$$$') : [];
  const urlList = url ? String(url).split('$$$') : [];
  const result = [];

  fromList.forEach((lineName, i) => {
    const episodes = [];
    const rawItems = String(urlList[i] || '').split('#');
    rawItems.forEach((item, j) => {
      if (!item) return;
      const pos = item.indexOf('$');
      let name;
      let epUrl;
      if (pos === -1) {
        name = `第${j + 1}集`;
        epUrl = item;
      } else {
        name = item.slice(0, pos) || `第${j + 1}集`;
        epUrl = item.slice(pos + 1);
      }
      episodes.push({
        nid: j + 1,
        name,
        url: epUrl,
      });
    });

    result.push({
      sid: i + 1,
      from: lineName,
      urls: episodes,
    });
  });

  return result;
}

module.exports = {
  esc,
  slugify,
  formatDate,
  formatDateTime,
  pageNumbers,
  pageUrl,
  toInt,
  clamp,
  mac_url_type,
  mac_url_vod_detail,
  mac_url_vod_play,
  mac_url_search,
  parsePlayList,
  isDirectPlayUrl,
};
