const { db } = require('./db');
const { parsePlayList, slugify, toInt, clamp } = require('./helpers');
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

  async function fetchResource(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      throw new Error('采集地址必须以 http:// 或 https:// 开头');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`资源站返回 HTTP ${res.status}`);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('资源站返回的不是 JSON');
      }
      if (!json || !Array.isArray(json.list)) throw new Error('资源站 JSON 缺少 list 数组');
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async function importFrom(url, mappingText) {
    const json = await fetchResource(url);
    const mapping = parseMapping(mappingText);

    // 如果没填手工映射，就尝试按 class 列表里的分类名自动匹配本站分类
    const remoteClasses = Array.isArray(json.class) ? json.class : [];
    const localTypes = Type.all();
    const nameToLocal = new Map(localTypes.map((t) => [t.type_name, t.type_id]));

    const stats = { total: json.list.length, inserted: 0, updated: 0, skipped: 0, messages: [] };

    for (const item of json.list) {
      const remoteType = toInt(item.type_id);
      let localType = mapping[remoteType] || 0;

      if (!localType) {
        const remoteClass = remoteClasses.find((c) => toInt(c.type_id) === remoteType);
        if (remoteClass) localType = nameToLocal.get(remoteClass.type_name) || 0;
      }

      if (!localType) {
        stats.skipped++;
        stats.messages.push(`跳过「${item.vod_name || '未知'}」：资源站分类 ${remoteType} 未绑定`);
        continue;
      }

      const play = playStringsFromDl(item.dl);
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

    return stats;
  }

  return { importFrom, fetchResource, parseMapping };
})();

module.exports = { Type, Vod, Admin, Collect };
