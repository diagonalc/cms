const { db } = require('./db');
const { Type, Vod } = require('./models');
const {
  fetchContent,
  buildUrl,
  parseDocument,
  extractValue,
  extractText,
  extractValues,
  extractList,
} = require('./rules');
const { toInt, clamp } = require('./helpers');

const SOURCE_TYPES = new Set(['json', 'xml', 'xpath']);
const RUNNING = new Set();
let schedulerTimer = null;

/* =========================================================
 * 采集源 CRUD
 * ======================================================= */

function listSources() {
  return db.prepare(`
    SELECT * FROM collect_sources ORDER BY source_id DESC
  `).all().map((r) => ({ ...r }));
}

function getSource(id) {
  const row = db.prepare('SELECT * FROM collect_sources WHERE source_id = ?').get(toInt(id));
  return row ? { ...row } : null;
}

function parseConfigText(text) {
  let cfg;
  try {
    cfg = JSON.parse(String(text || '{}'));
  } catch {
    throw new Error('规则 JSON 格式错误');
  }
  if (!cfg || typeof cfg !== 'object') throw new Error('规则必须是一个 JSON 对象');
  if (!cfg.search || typeof cfg.search !== 'object') throw new Error('规则缺少 search 配置');
  if (!cfg.search.url) throw new Error('规则缺少 search.url');
  if (!cfg.search.list) throw new Error('规则缺少 search.list');
  return cfg;
}

function saveSource(data) {
  const id = toInt(data.source_id);
  const name = String(data.source_name || '').trim();
  if (!name) throw new Error('采集源名称不能为空');

  const type = String(data.source_type || '').trim().toLowerCase();
  if (!SOURCE_TYPES.has(type)) throw new Error('采集源类型必须是 json / xml / xpath');

  const cfg = parseConfigText(data.source_config);
  const typeId = toInt(cfg.typeId);
  if (!typeId || !Type.find(typeId)) {
    throw new Error('规则的 typeId 必须是本站已存在的分类 ID');
  }

  const interval = clamp(toInt(data.source_interval, 0), 0, 10080); // 最多 7 天
  const enabled = toInt(data.source_enabled, 0) === 1 ? 1 : 0;
  const now = Date.now();
  const nextRun = enabled && interval > 0 ? now + interval * 60_000 : 0;
  const configText = JSON.stringify(cfg, null, 2);

  if (id) {
    const old = getSource(id);
    if (!old) throw new Error('采集源不存在');
    db.prepare(`
      UPDATE collect_sources SET
        source_name=?, source_type=?, source_config=?, source_interval=?,
        source_enabled=?, next_run_at=?
      WHERE source_id=?
    `).run(name, type, configText, interval, enabled, nextRun, id);
    return id;
  }

  const info = db.prepare(`
    INSERT INTO collect_sources (
      source_name, source_type, source_config, source_interval,
      source_enabled, next_run_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, type, configText, interval, enabled, nextRun, now);
  return Number(info.lastInsertRowid);
}

function deleteSource(id) {
  const sid = toInt(id);
  db.prepare('DELETE FROM collect_logs WHERE source_id = ?').run(sid);
  db.prepare('DELETE FROM collect_sources WHERE source_id = ?').run(sid);
}

function listLogs(sourceId = 0, limit = 50) {
  const sid = toInt(sourceId);
  const n = clamp(toInt(limit, 50), 1, 200);
  if (sid) {
    return db.prepare(`
      SELECT * FROM collect_logs WHERE source_id = ?
      ORDER BY log_id DESC LIMIT ?
    `).all(sid, n).map((r) => ({ ...r }));
  }
  return db.prepare(`
    SELECT * FROM collect_logs ORDER BY log_id DESC LIMIT ?
  `).all(n).map((r) => ({ ...r }));
}

/* =========================================================
 * 播放地址提取
 * ======================================================= */

function buildPlay(type, doc, play) {
  if (!play || typeof play !== 'object') {
    return { vod_play_from: '', vod_play_url: '' };
  }

  // 模式 A：线路分组
  if (play.groups) {
    const groups = extractList(type, doc, play.groups, doc);
    const froms = [];
    const urls = [];

    for (const group of groups) {
      const from = extractValue(type, group, play.from, group) || 'line';

      if (play.episodes) {
        // 每组下面还有多集：<div class="line"><a>第1集</a>...</div>
        const episodes = extractList(type, group, play.episodes, group);
        const epStrings = [];
        for (const ep of episodes) {
          const name = extractValue(type, ep, play.episodeName, ep) ||
            `第${epStrings.length + 1}集`;
          const url = extractValue(type, ep, play.episodeUrl, ep);
          if (url) epStrings.push(`${name}$${url}`);
        }
        if (epStrings.length) {
          froms.push(from);
          urls.push(epStrings.join('#'));
        }
      } else {
        // 组本身就是一条 delimited 字符串：<dd flag="m3u8">第1集$url#第2集$url</dd>
        const groupUrl = extractValue(type, group, play.url, group);
        if (groupUrl) {
          froms.push(from);
          urls.push(groupUrl);
        }
      }
    }

    return {
      vod_play_from: froms.join('$$$'),
      vod_play_url: urls.join('$$$'),
    };
  }

  // 模式 B：直接字段，例如 MacCMS 的 vod_play_from / vod_play_url
  const fromValues = extractValues(type, doc, play.from, doc);
  const urlValues = extractValues(type, doc, play.url, doc);
  return {
    vod_play_from: fromValues.map(String).join('$$$'),
    vod_play_url: urlValues.map(String).join('$$$'),
  };
}

/* =========================================================
 * 执行一个采集源
 * ======================================================= */

async function runSource(id, options = {}) {
  const source = getSource(id);
  if (!source) throw new Error('采集源不存在');
  if (!options.manual && !source.source_enabled) return null;
  if (RUNNING.has(source.source_id)) {
    throw new Error('该采集源正在运行，请稍后再试');
  }

  RUNNING.add(source.source_id);
  const startedAt = Date.now();
  const stats = {
    total: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    pagesFetched: 0,
    requestUrl: '',
    messages: [],
  };

  try {
    let cfg;
    try {
      cfg = JSON.parse(source.source_config);
    } catch {
      throw new Error('采集源规则 JSON 损坏');
    }

    const type = source.source_type;
    const typeId = toInt(cfg.typeId);
    if (!typeId || !Type.find(typeId)) throw new Error('规则的 typeId 不是有效分类');

    const keyword = String(cfg.keyword || '').trim();
    const hasPage = String(cfg.search.url).includes('@page');
    const pages = hasPage ? clamp(toInt(cfg.pages, 1), 1, 50) : 1;

    for (let page = 1; page <= pages; page++) {
      const searchUrl = buildUrl(cfg.search.url, { keyword, page, typeId });
      stats.requestUrl = searchUrl;

      let searchText;
      try {
        searchText = await fetchContent(
          searchUrl,
          cfg.search.method || 'GET',
          cfg.search.headers || {},
          cfg.search.body || ''
        );
      } catch (err) {
        stats.messages.push(`第 ${page} 页搜索失败：${err.message}`);
        break;
      }

      let searchDoc;
      try {
        searchDoc = parseDocument(type, searchText);
      } catch (err) {
        stats.messages.push(`第 ${page} 页解析失败：${err.message}`);
        break;
      }

      const list = extractList(type, searchDoc, cfg.search.list, searchDoc);
      stats.pagesFetched++;
      stats.total += list.length;

      for (const item of list) {
        let name = '';
        try {
          name = extractValue(type, item, cfg.search.name, item);
          if (!name) {
            stats.skipped++;
            continue;
          }

          const sourceValue = extractValue(type, item, cfg.search.source, item);
          let dataDoc = item;

          if (cfg.detail && cfg.detail.url) {
            const detailUrl = buildUrl(cfg.detail.url, {
              source: sourceValue,
              keyword,
              page,
              typeId,
            });
            const detailText = await fetchContent(
              detailUrl,
              cfg.detail.method || 'GET',
              cfg.detail.headers || cfg.search.headers || {},
              cfg.detail.body || ''
            );
            dataDoc = parseDocument(type, detailText);
          }

          const fields = {};
          for (const [field, spec] of Object.entries(cfg.fields || {})) {
            if (spec && typeof spec === 'object' && spec.path) {
              fields[field] = extractText(type, dataDoc, spec.path, dataDoc, spec.join ?? '');
            } else if (typeof spec === 'string') {
              fields[field] = extractText(type, dataDoc, spec, dataDoc, '');
            }
          }
          if (!fields.vod_name) fields.vod_name = name;

          const play = buildPlay(type, dataDoc, cfg.play || {});
          const result = Vod.upsertByName({
            type_id: typeId,
            ...fields,
            ...play,
          });

          if (result === 'inserted') stats.inserted++;
          else if (result === 'updated') stats.updated++;
          else stats.skipped++;
        } catch (err) {
          stats.skipped++;
          stats.messages.push(`处理「${name || '未知'}」失败：${err.message}`);
        }
      }

      if (!hasPage) break;
    }

    const summary = `采集 ${stats.total} 条，新增 ${stats.inserted}，更新 ${stats.updated}，跳过 ${stats.skipped}`;
    finishRun(source, 'ok', summary, stats, startedAt);
    return { ...stats, summary };
  } catch (err) {
    finishRun(source, 'error', err.message, stats, startedAt);
    throw err;
  } finally {
    RUNNING.delete(source.source_id);
  }
}

function finishRun(source, status, message, stats, startedAt) {
  const now = Date.now();
  const nextRun = source.source_enabled && source.source_interval > 0
    ? now + source.source_interval * 60_000
    : 0;
  const shortMessage = String(message || '').slice(0, 500);

  db.prepare(`
    UPDATE collect_sources SET
      last_run_at=?, next_run_at=?, last_status=?, last_message=?
    WHERE source_id=?
  `).run(now, nextRun, status, shortMessage, source.source_id);

  db.prepare(`
    INSERT INTO collect_logs (source_id, source_name, status, message, stats, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    source.source_id,
    source.source_name,
    status,
    shortMessage,
    JSON.stringify({ ...stats, durationMs: now - startedAt }),
    now
  );
}

/* =========================================================
 * 调度器
 * ======================================================= */

async function runDueSources() {
  const now = Date.now();
  const due = db.prepare(`
    SELECT * FROM collect_sources
    WHERE source_enabled = 1
      AND source_interval > 0
      AND next_run_at > 0
      AND next_run_at <= ?
    ORDER BY next_run_at ASC
  `).all(now).map((r) => ({ ...r }));

  for (const source of due) {
    if (RUNNING.has(source.source_id)) continue;
    try {
      await runSource(source.source_id);
    } catch (err) {
      console.error(`[scheduler] source ${source.source_id} failed:`, err.message);
    }
  }
}

function startScheduler() {
  if (schedulerTimer) return;

  // 开启但没有 next_run_at 的源，从下一个周期开始
  const now = Date.now();
  db.prepare(`
    UPDATE collect_sources
    SET next_run_at = ? + source_interval * 60000
    WHERE source_enabled = 1 AND source_interval > 0 AND next_run_at = 0
  `).run(now);

  schedulerTimer = setInterval(() => {
    runDueSources().catch((err) => console.error('[scheduler]', err));
  }, 30_000);
}

function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  SOURCE_TYPES,
  listSources,
  getSource,
  saveSource,
  deleteSource,
  listLogs,
  runSource,
  runDueSources,
  startScheduler,
  stopScheduler,
};
