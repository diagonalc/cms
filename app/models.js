const { db } = require('./db');
const { parsePlayList, slugify, toInt, clamp, isDirectPlayUrl } = require('./helpers');
const { verifyPassword } = require('./security');

/* =========================================================
 * Type：分类模型
 * ======================================================= */
const Type = (() => {
  let cache = { at: 0, rows: [] };

  function clearCache() {
    cache = { at: 0, rows: [] };
  }

  function allActive() {
    if (cache.rows.length && Date.now() - cache.at < 60_000) return cache.rows;
    const rows = db.prepare(`
      SELECT * FROM types WHERE type_status = 1
      ORDER BY type_sort DESC, type_id ASC
    `).all().map((r) => ({ ...r }));
    cache = { at: Date.now(), rows };
    return rows;
  }

  function all() {
    return db.prepare(`
      SELECT * FROM types ORDER BY type_sort DESC, type_id ASC
    `).all().map((r) => ({ ...r }));
  }

  function find(id) {
    const row = db.prepare('SELECT * FROM types WHERE type_id = ?').get(toInt(id));
    return row ? { ...row } : null;
  }

  /** 返回某分类及其所有后代分类的 ID（用于“点父分类看到子分类影片”）。 */
  function descendantIds(id, activeOnly = true) {
    const rows = activeOnly ? allActive() : all();
    const byParent = new Map();
    for (const row of rows) {
      if (!byParent.has(row.type_pid)) byParent.set(row.type_pid, []);
      byParent.get(row.type_pid).push(row.type_id);
    }
    const result = [];
    const walk = (tid) => {
      result.push(tid);
      for (const child of byParent.get(tid) || []) walk(child);
    };
    walk(toInt(id));
    return result;
  }

  /** 给模板标签 {maccms:type} 用：支持 parent / num / order / by。 */
  function list(attrs = {}) {
    let rows = allActive();
    if (attrs.parent !== undefined && attrs.parent !== '' && attrs.parent !== 'all') {
      const pid = toInt(attrs.parent, -1);
      if (pid >= 0) rows = rows.filter((r) => r.type_pid === pid);
    }
    if (attrs.id) {
      const id = toInt(attrs.id);
      rows = rows.filter((r) => r.type_id === id);
    }
    const by = attrs.by === 'id' ? 'type_id' : attrs.by === 'name' ? 'type_name' : 'type_sort';
    const dir = String(attrs.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => (a[by] > b[by] ? 1 : a[by] < b[by] ? -1 : 0) * dir);
    const num = toInt(attrs.num, rows.length);
    return rows.slice(0, Math.max(0, num));
  }

  function tree(rows = all()) {
    const map = new Map(rows.map((r) => [r.type_id, { ...r, children: [] }]));
    const roots = [];
    for (const node of map.values()) {
      if (node.type_pid && map.has(node.type_pid)) map.get(node.type_pid).children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  function save(data) {
    const id = toInt(data.type_id);
    const name = String(data.type_name || '').trim();
    if (!name) throw new Error('分类名称不能为空');
    const pid = toInt(data.type_pid);
    if (id && pid === id) throw new Error('父分类不能是自己');

    let en = String(data.type_en || '').trim() || slugify(name);
    const exists = db.prepare('SELECT type_id FROM types WHERE type_en = ? AND type_id <> ?').get(en, id || 0);
    if (exists) en = `${en}-${Date.now().toString().slice(-4)}`;

    const sort = toInt(data.type_sort);
    const status = data.type_status === undefined ? 1 : toInt(data.type_status);

    if (id) {
      db.prepare(`
        UPDATE types SET type_pid=?, type_name=?, type_en=?, type_sort=?, type_status=?
        WHERE type_id=?
      `).run(pid, name, en, sort, status, id);
      clearCache();
      return id;
    }

    const info = db.prepare(`
      INSERT INTO types (type_pid, type_name, type_en, type_sort, type_status)
      VALUES (?, ?, ?, ?, ?)
    `).run(pid, name, en, sort, status);
    clearCache();
    return Number(info.lastInsertRowid);
  }

  function remove(id) {
    const tid = toInt(id);
    if (!find(tid)) throw new Error('分类不存在');
    if (db.prepare('SELECT COUNT(*) AS n FROM types WHERE type_pid = ?').get(tid).n > 0) {
      throw new Error('该分类下还有子分类，不能删除');
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM vods WHERE type_id = ?').get(tid).n > 0) {
      throw new Error('该分类下还有影片，不能删除');
    }
    db.prepare('DELETE FROM types WHERE type_id = ?').run(tid);
    clearCache();
  }

  return { all, allActive, find, list, tree, save, remove, clearCache, descendantIds };
})();

/* =========================================================
 * Vod：影片模型
 * ======================================================= */
const Vod = (() => {
  const ORDER_MAP = {
    time: 'v.vod_time',
    id: 'v.vod_id',
    hits: 'v.vod_hits',
    hits_day: 'v.vod_hits',
    hits_week: 'v.vod_hits',
    hits_month: 'v.vod_hits',
    score: 'v.vod_score',
  };

  function buildWhere(attrs = {}, includeUnpublished = false) {
    const where = [];
    const params = [];

    if (!includeUnpublished) where.push('v.vod_status = 1');

    if (attrs.type !== undefined && attrs.type !== '' && attrs.type !== 'all') {
      const ids = Type.descendantIds(attrs.type, true);
      if (ids.length) {
        where.push(`v.type_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      } else {
        where.push('1 = 0');
      }
    }

    if (attrs.ids !== undefined && attrs.ids !== '') {
      const ids = String(attrs.ids).split(',').map((x) => toInt(x)).filter(Boolean);
      if (ids.length) {
        where.push(`v.vod_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      } else {
        where.push('1 = 0');
      }
    }

    if (attrs.wd) {
      where.push('(v.vod_name LIKE ? OR v.vod_actor LIKE ? OR v.vod_director LIKE ?)');
      const q = `%${String(attrs.wd).trim()}%`;
      params.push(q, q, q);
    }

    if (attrs.year) {
      where.push('v.vod_year = ?');
      params.push(String(attrs.year));
    }
    if (attrs.area) {
      where.push('v.vod_area = ?');
      params.push(String(attrs.area));
    }
    if (attrs.lang) {
      where.push('v.vod_lang = ?');
      params.push(String(attrs.lang));
    }

    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  function paginate(attrs = {}, includeUnpublished = false) {
    const pageSize = clamp(toInt(attrs.pageSize || attrs.num || 20, 20), 1, 100);
    const page = clamp(toInt(attrs.page, 1), 1, 1_000_000);
    const offset = (page - 1) * pageSize;

    const { where, params } = buildWhere(attrs, includeUnpublished);
    const orderCol = ORDER_MAP[attrs.by] || ORDER_MAP.time;
    const orderDir = String(attrs.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM vods v ${where}
    `).get(...params).n;

    const rows = db.prepare(`
      SELECT v.*, t.type_name
      FROM vods v
      LEFT JOIN types t ON t.type_id = v.type_id
      ${where}
      ORDER BY ${orderCol} ${orderDir}, v.vod_id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset).map((r) => ({ ...r }));

    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    return { list: rows, total, page, pageSize, pageCount };
  }

  /** 给模板标签 {maccms:vod} 用：直接返回数组。 */
  function list(attrs = {}) {
    return paginate({ ...attrs, page: 1 }, false).list;
  }

  function find(id, includeUnpublished = false) {
    const statusSql = includeUnpublished ? '' : 'AND v.vod_status = 1';
    const row = db.prepare(`
      SELECT v.*, t.type_name, t.type_pid
      FROM vods v
      LEFT JOIN types t ON t.type_id = v.type_id
      WHERE v.vod_id = ? ${statusSql}
    `).get(toInt(id));
    if (!row) return null;
    const vod = { ...row };
    vod.play_list = parsePlayList(vod.vod_play_from, vod.vod_play_url);

    // 资源站常同时给“分享页”和“直链 m3u8”两条线路。
    // 优先把直链线路排在前面，避免用户点到需要解析的分享页。
    for (const line of vod.play_list) {
      line.direct = line.urls.some((ep) => isDirectPlayUrl(ep.url)) ? 1 : 0;
    }
    vod.play_list.sort((a, b) => b.direct - a.direct);

    return vod;
  }

  function normalizePlayFields(data) {
    let fromLines = data.play_from;
    let urlLines = data.play_url;

    if (typeof fromLines === 'string') fromLines = fromLines.split('\n');
    if (typeof urlLines === 'string') urlLines = urlLines.split('\n');

    fromLines = (fromLines || []).map((x) => String(x).trim()).filter(Boolean);
    urlLines = (urlLines || []).map((x) => String(x).trim()).filter(Boolean);

    if (fromLines.length !== urlLines.length) {
      throw new Error('播放线路数和地址行数必须一致（每行一条线路）');
    }

    return {
      vod_play_from: fromLines.join('$$$'),
      vod_play_url: urlLines.join('$$$'),
    };
  }

  function save(data) {
    const name = String(data.vod_name || '').trim();
    if (!name) throw new Error('影片名称不能为空');
    const typeId = toInt(data.type_id);
    if (!Type.find(typeId)) throw new Error('请选择有效分类');

    const play = normalizePlayFields(data);
    const en = String(data.vod_en || '').trim() || slugify(name);
    const now = Date.now();
    const id = toInt(data.vod_id);

    const values = {
      type_id: typeId,
      vod_name: name,
      vod_en: en,
      vod_pic: String(data.vod_pic || '').trim(),
      vod_actor: String(data.vod_actor || '').trim(),
      vod_director: String(data.vod_director || '').trim(),
      vod_year: String(data.vod_year || '').trim(),
      vod_area: String(data.vod_area || '').trim(),
      vod_lang: String(data.vod_lang || '').trim(),
      vod_remarks: String(data.vod_remarks || '').trim(),
      vod_content: String(data.vod_content || '').trim(),
      vod_status: data.vod_status === undefined ? 1 : toInt(data.vod_status),
      vod_score: Number(data.vod_score || 0) || 0,
      ...play,
    };

    try {
      if (id) {
        db.prepare(`
          UPDATE vods SET
            type_id=?, vod_name=?, vod_en=?, vod_pic=?, vod_actor=?, vod_director=?,
            vod_year=?, vod_area=?, vod_lang=?, vod_remarks=?, vod_content=?,
            vod_status=?, vod_score=?, vod_time=?, vod_play_from=?, vod_play_url=?
          WHERE vod_id=?
        `).run(
          values.type_id, values.vod_name, values.vod_en, values.vod_pic,
          values.vod_actor, values.vod_director, values.vod_year, values.vod_area,
          values.vod_lang, values.vod_remarks, values.vod_content, values.vod_status,
          values.vod_score, now, values.vod_play_from, values.vod_play_url, id
        );
        return id;
      }

      const info = db.prepare(`
        INSERT INTO vods (
          type_id, vod_name, vod_en, vod_pic, vod_actor, vod_director,
          vod_year, vod_area, vod_lang, vod_remarks, vod_content,
          vod_status, vod_score, vod_time, vod_play_from, vod_play_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.type_id, values.vod_name, values.vod_en, values.vod_pic,
        values.vod_actor, values.vod_director, values.vod_year, values.vod_area,
        values.vod_lang, values.vod_remarks, values.vod_content, values.vod_status,
        values.vod_score, now, values.vod_play_from, values.vod_play_url
      );
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new Error('同名影片已存在');
      throw err;
    }
  }

  /** 采集用：按影片名 upsert，返回 inserted / updated。 */
  function upsertByName(data) {
    const name = String(data.vod_name || '').trim();
    if (!name) return 'skipped';
    const existing = db.prepare('SELECT vod_id FROM vods WHERE vod_name = ?').get(name);
    if (existing) {
      db.prepare(`
        UPDATE vods SET
          type_id=?, vod_pic=?, vod_actor=?, vod_director=?, vod_year=?, vod_area=?,
          vod_lang=?, vod_remarks=?, vod_content=?, vod_play_from=?, vod_play_url=?,
          vod_time=?
        WHERE vod_id=?
      `).run(
        toInt(data.type_id), data.vod_pic || '', data.vod_actor || '', data.vod_director || '',
        data.vod_year || '', data.vod_area || '', data.vod_lang || '', data.vod_remarks || '',
        data.vod_content || '', data.vod_play_from || '', data.vod_play_url || '', Date.now(),
        existing.vod_id
      );
      return 'updated';
    }
    db.prepare(`
      INSERT INTO vods (
        type_id, vod_name, vod_en, vod_pic, vod_actor, vod_director,
        vod_year, vod_area, vod_lang, vod_remarks, vod_content,
        vod_status, vod_score, vod_time, vod_play_from, vod_play_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      toInt(data.type_id), name, slugify(name), data.vod_pic || '', data.vod_actor || '',
      data.vod_director || '', data.vod_year || '', data.vod_area || '', data.vod_lang || '',
      data.vod_remarks || '', data.vod_content || '', Number(data.vod_score || 0) || 0,
      Date.now(), data.vod_play_from || '', data.vod_play_url || ''
    );
    return 'inserted';
  }

  function remove(id) {
    db.prepare('DELETE FROM vods WHERE vod_id = ?').run(toInt(id));
  }

  function incrementHits(id) {
    db.prepare('UPDATE vods SET vod_hits = vod_hits + 1 WHERE vod_id = ?').run(toInt(id));
  }

  return { paginate, list, find, save, upsertByName, remove, incrementHits };
})();

/* =========================================================
 * Admin：后台用户
 * ======================================================= */
const Admin = (() => {
  function findByName(name) {
    const row = db.prepare('SELECT * FROM admins WHERE admin_name = ?').get(String(name || ''));
    return row ? { ...row } : null;
  }

  function login(name, password) {
    const admin = findByName(name);
    if (!admin) return null;
    if (!verifyPassword(password, admin.admin_pwd)) return null;
    return admin;
  }

  return { findByName, login };
})();

/* =========================================================
 * Collect：资源站采集
 * ======================================================= */
const Collect = (() => {
  function parseMapping(text) {
    const map = {};
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [remote, local] = trimmed.split('=').map((x) => toInt(x));
      if (remote && local) map[remote] = local;
    }
    return map;
  }

  function playStringsFromDl(dl) {
    const froms = [];
    const urls = [];

    if (Array.isArray(dl)) {
      for (const item of dl) {
        if (!item) continue;
        froms.push(String(item.from || 'line'));
        urls.push(String(item.url || ''));
      }
    } else if (dl && typeof dl === 'object') {
      for (const [from, url] of Object.entries(dl)) {
        if (!url) continue;
        froms.push(String(from));
        urls.push(String(url));
      }
    }

    return { vod_play_from: froms.join('$$$'), vod_play_url: urls.join('$$$') };
  }

  /**
   * 统一从两种接口字段里取播放地址：
   * - 本站旧 mock / 部分接口：{ dl: { m3u8: '第1集$url#...' } }
   * - 苹果CMS JSON 接口：{ vod_play_from: 'feifan$$$ffm3u8', vod_play_url: '第1集$url#...$$$...' }
   */
  function playStringsFromItem(item) {
    if (item && item.dl && (Array.isArray(item.dl) ? item.dl.length : Object.keys(item.dl).length)) {
      return playStringsFromDl(item.dl);
    }

    let from = item ? (item.vod_play_from ?? item.play_from ?? '') : '';
    let url = item ? (item.vod_play_url ?? item.play_url ?? '') : '';
    if (Array.isArray(from)) from = from.join('$$$');
    if (Array.isArray(url)) url = url.join('$$$');

    return {
      vod_play_from: String(from || ''),
      vod_play_url: String(url || ''),
    };
  }

  /**
   * 规范化资源站地址：
   * - 采集必须拿完整数据，所以把 ac=list / 缺少 ac 统一改成 ac=videolist；
   * - 自动带上 pg（页码）、t（分类ID）、area（地区）、wd（关键词）。
   */
  function normalizeResourceUrl(rawUrl, options = {}) {
    let u;
    try {
      u = new URL(String(rawUrl || ''));
    } catch {
      throw new Error('采集地址格式不正确');
    }
    if (!/^https?:$/i.test(u.protocol)) {
      throw new Error('采集地址必须以 http:// 或 https:// 开头');
    }

    const ac = u.searchParams.get('ac');
    if (ac !== 'videolist') u.searchParams.set('ac', 'videolist');

    const page = toInt(options.page, 0);
    if (page > 0) u.searchParams.set('pg', String(page));

    if (options.typeId !== undefined && options.typeId !== null && String(options.typeId).trim() !== '') {
      u.searchParams.set('t', String(toInt(options.typeId)));
    }
    if (options.area !== undefined && options.area !== null && String(options.area).trim() !== '') {
      u.searchParams.set('area', String(options.area).trim());
    }
    if (options.keyword !== undefined && options.keyword !== null && String(options.keyword).trim() !== '') {
      u.searchParams.set('wd', String(options.keyword).trim());
    }

    return u.toString();
  }

  /* ---------- XML 解析：兼容苹果CMS资源站的 rss/list/video 格式 ---------- */

  function decodeXmlEntities(text) {
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    };
    return String(text || '').replace(
      /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]+));/gi,
      (match, hex, dec, name) => {
        if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
        if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
        const val = named[String(name).toLowerCase()];
        return val === undefined ? match : val;
      }
    );
  }

  /** 取标签内容：优先 CDATA，其次去标签 + 实体解码。 */
  function decodeXmlText(raw) {
    let s = String(raw || '').trim();
    const cdata = [...s.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
    if (cdata.length) {
      s = cdata.join('');
    } else {
      s = s.replace(/<[^>]*>/g, '');
    }
    return decodeXmlEntities(s).trim();
  }

  function tagText(block, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = re.exec(block);
    return m ? decodeXmlText(m[1]) : '';
  }

  function parseXmlAttrs(text) {
    const attrs = {};
    const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
    }
    return attrs;
  }

  /**
   * 把资源站 XML 归一化成和 JSON 接口一样的结构：
   * { page, pagecount, total, class: [{type_id,type_name}], list: [{..., dl:{from:url}}] }
   *
   * 兼容结构：
   * <rss><list page="1" ...>
   *   <class><ty id="1">电影</ty></class>
   *   <video><id>1</id><tid>1</tid><name><![CDATA[片名]]></name>
   *     <dl><dd flag="m3u8"><![CDATA[第1集$url#第2集$url]]></dd></dl>
   *   </video>
   * </list></rss>
   */
  function parseXmlResource(text) {
    const xml = String(text || '').replace(/^﻿/, '');
    if (!/<(rss|list|video|item)\b/i.test(xml)) {
      throw new Error('资源站返回的不是有效的 XML');
    }

    const listOpen = /<list\b([^>]*)>/i.exec(xml);
    const listAttrs = listOpen ? parseXmlAttrs(listOpen[1]) : {};

    const classes = [];
    const classBlock = /<class\b[^>]*>([\s\S]*?)<\/class>/i.exec(xml);
    if (classBlock) {
      const tyRe = /<ty\b([^>]*)>([\s\S]*?)<\/ty>/gi;
      let m;
      while ((m = tyRe.exec(classBlock[1]))) {
        const attrs = parseXmlAttrs(m[1]);
        const id = toInt(attrs.id);
        const name = decodeXmlText(m[2]);
        if (id && name) classes.push({ type_id: id, type_name: name });
      }
    }

    const list = [];
    const typeNames = new Map();
    const videoRe = /<(video|item)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = videoRe.exec(xml))) {
      const openAttrs = parseXmlAttrs(m[2]);
      const block = m[3];
      const name = tagText(block, 'name') || tagText(block, 'title');
      if (!name) continue;

      const typeId = toInt(
        tagText(block, 'tid') ||
        tagText(block, 'type_id') ||
        openAttrs.tid ||
        openAttrs.type_id
      );
      const typeName = tagText(block, 'type');
      if (typeId && typeName) typeNames.set(typeId, typeName);

      const dl = {};
      const dlBlock = /<dl\b[^>]*>([\s\S]*?)<\/dl>/i.exec(block);
      if (dlBlock) {
        const ddRe = /<dd\b([^>]*)>([\s\S]*?)<\/dd>/gi;
        let d;
        while ((d = ddRe.exec(dlBlock[1]))) {
          const attrs = parseXmlAttrs(d[1]);
          const from = String(attrs.flag || attrs.from || 'line');
          const url = decodeXmlText(d[2]);
          if (url) dl[from] = url;
        }
      }

      list.push({
        type_id: typeId,
        type_name: typeName,
        vod_id: toInt(tagText(block, 'id')),
        vod_name: name,
        vod_pic: tagText(block, 'pic'),
        vod_actor: tagText(block, 'actor'),
        vod_director: tagText(block, 'director'),
        vod_year: tagText(block, 'year'),
        vod_area: tagText(block, 'area'),
        vod_lang: tagText(block, 'lang'),
        vod_remarks: tagText(block, 'note'),
        vod_content: tagText(block, 'des') || tagText(block, 'content'),
        vod_score: Number(tagText(block, 'score') || 0) || 0,
        dl,
      });
    }

    // 很多 XML 接口没有 <class> 节点，但每部影片带 <tid>/<type>。
    // 用它们反推出分类表，这样“按分类名自动匹配”也能工作。
    if (!classes.length && typeNames.size) {
      for (const [id, name] of typeNames) {
        classes.push({ type_id: id, type_name: name });
      }
    }

    return {
      code: 1,
      msg: 'xml',
      page: toInt(listAttrs.page, 1),
      pagecount: toInt(listAttrs.pagecount, 1),
      limit: toInt(listAttrs.pagesize, list.length || 20),
      total: toInt(listAttrs.recordcount, list.length),
      class: classes,
      list,
    };
  }

  async function fetchResource(url, format = 'auto') {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      throw new Error('采集地址必须以 http:// 或 https:// 开头');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`资源站返回 HTTP ${res.status}`);

      const text = (await res.text()).replace(/^﻿/, '');
      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const actual = String(format || 'auto').toLowerCase();

      const parseJson = () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error('资源站返回的不是 JSON');
        }
        if (!json || !Array.isArray(json.list)) throw new Error('资源站 JSON 缺少 list 数组');
        return json;
      };

      if (actual === 'xml') return parseXmlResource(text);
      if (actual === 'json') return parseJson();

      // auto：优先看 Content-Type / 开头字符，再回退尝试
      const trimmed = text.trim();
      const looksXml = contentType.includes('xml') ||
        /^<\?xml/i.test(trimmed) ||
        /^<rss\b/i.test(trimmed) ||
        /^<list\b/i.test(trimmed);

      if (looksXml) return parseXmlResource(text);

      try {
        return parseJson();
      } catch (jsonErr) {
        try {
          return parseXmlResource(text);
        } catch {
          throw jsonErr;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function importFrom(url, mappingText, format = 'auto', options = {}) {
    const startPage = Math.max(1, toInt(options.startPage, 1));
    const pages = clamp(toInt(options.pages, 1), 1, 50);
    const mapping = parseMapping(mappingText);

    const localTypes = Type.all();
    const nameToLocal = new Map(localTypes.map((t) => [t.type_name, t.type_id]));

    // 先精确匹配分类名；匹配不到再做一次包含匹配（如“日韩动漫” -> “动漫”）
    const findLocalByName = (name) => {
      if (!name) return 0;
      const exact = nameToLocal.get(name);
      if (exact) return exact;
      const fuzzy = localTypes.find(
        (t) => name.includes(t.type_name) || t.type_name.includes(name)
      );
      return fuzzy ? fuzzy.type_id : 0;
    };

    const stats = {
      total: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      noPlay: 0,
      pagesFetched: 0,
      resourceTotal: 0,
      requestUrl: '',
      messages: [],
    };

    let remoteClasses = [];
    let pageCount = 0;

    for (let i = 0; i < pages; i++) {
      const page = startPage + i;

      let pageUrl;
      try {
        pageUrl = normalizeResourceUrl(url, {
          page,
          typeId: options.typeId,
          area: options.area,
          keyword: options.keyword,
        });
      } catch (err) {
        stats.messages.push(err.message);
        break;
      }
      stats.requestUrl = pageUrl;

      let resource;
      try {
        resource = await fetchResource(pageUrl, format);
      } catch (err) {
        stats.messages.push(`第 ${page} 页采集失败：${err.message}`);
        break;
      }

      if (!remoteClasses.length) {
        remoteClasses = Array.isArray(resource.class) ? resource.class : [];
      }
      stats.pagesFetched++;
      stats.resourceTotal = Math.max(stats.resourceTotal, toInt(resource.total, 0));
      stats.total += resource.list.length;

      for (const item of resource.list) {
        const remoteType = toInt(item.type_id);
        let localType = mapping[remoteType] || 0;

        if (!localType) {
          const remoteClass = remoteClasses.find((c) => toInt(c.type_id) === remoteType);
          if (remoteClass) localType = findLocalByName(remoteClass.type_name);
        }
        if (!localType && item.type_name) {
          localType = findLocalByName(item.type_name);
        }

        if (!localType) {
          stats.skipped++;
          const typeLabel = item.type_name ? `${remoteType}（${item.type_name}）` : `${remoteType}`;
          stats.messages.push(`跳过「${item.vod_name || '未知'}」：资源站分类 ${typeLabel} 未绑定`);
          continue;
        }

        const play = playStringsFromItem(item);
        if (!play.vod_play_url) stats.noPlay++;

        const result = Vod.upsertByName({
          type_id: localType,
          vod_name: item.vod_name,
          vod_pic: item.vod_pic,
          vod_actor: item.vod_actor,
          vod_director: item.vod_director,
          vod_year: item.vod_year,
          vod_area: item.vod_area,
          vod_lang: item.vod_lang,
          vod_remarks: item.vod_remarks,
          vod_content: item.vod_content,
          vod_score: item.vod_score,
          ...play,
        });

        if (result === 'inserted') stats.inserted++;
        else if (result === 'updated') stats.updated++;
        else stats.skipped++;
      }

      pageCount = toInt(resource.pagecount, 0);
      if (resource.list.length === 0 || (pageCount > 0 && page >= pageCount)) break;
    }

    if (stats.noPlay > 0) {
      stats.messages.push(`有 ${stats.noPlay} 条没有播放地址：如果接口用的是 ac=list，请改成 ac=videolist`);
    }
    if (stats.resourceTotal > stats.total) {
      stats.messages.push(
        `资源站共有 ${stats.resourceTotal} 条，本次采集了 ${stats.total} 条；可调整“起始页/采集页数”继续采集。`
      );
    }

    return stats;
  }

  return {
    importFrom,
    fetchResource,
    parseMapping,
    parseXmlResource,
    playStringsFromItem,
    normalizeResourceUrl,
  };
})();

module.exports = { Type, Vod, Admin, Collect };
