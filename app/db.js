const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');

// SQLite 在 Windows 通过 UNC 访问 WSL 文件时会出现 database is locked。
// 默认把数据库放到本机用户目录；需要放项目内时用 CMS_DB 指定绝对路径。
const DB_FILE = process.env.CMS_DB || path.join(os.homedir(), '.mini-maccms', 'cms.db');
const DATA_DIR = path.dirname(DB_FILE);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
// 本项目可能放在 WSL/网络映射盘上，WAL 在部分文件系统会报 database is locked，
// 因此使用默认的 DELETE journal 模式。
db.exec('PRAGMA foreign_keys = ON;');

/**
 * 建表。字段命名刻意贴近苹果CMS：type_* / vod_*。
 * 最简版只保留影视站真正必需的字段。
 */
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS types (
      type_id     INTEGER PRIMARY KEY AUTOINCREMENT,
      type_pid    INTEGER NOT NULL DEFAULT 0,
      type_name   TEXT    NOT NULL,
      type_en     TEXT    NOT NULL UNIQUE,
      type_sort   INTEGER NOT NULL DEFAULT 0,
      type_status INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS vods (
      vod_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id       INTEGER NOT NULL DEFAULT 0,
      vod_name      TEXT    NOT NULL,
      vod_en        TEXT    NOT NULL DEFAULT '',
      vod_pic       TEXT    NOT NULL DEFAULT '',
      vod_actor     TEXT    NOT NULL DEFAULT '',
      vod_director  TEXT    NOT NULL DEFAULT '',
      vod_year      TEXT    NOT NULL DEFAULT '',
      vod_area      TEXT    NOT NULL DEFAULT '',
      vod_lang      TEXT    NOT NULL DEFAULT '',
      vod_remarks   TEXT    NOT NULL DEFAULT '',
      vod_content   TEXT    NOT NULL DEFAULT '',
      vod_status    INTEGER NOT NULL DEFAULT 1,
      vod_hits      INTEGER NOT NULL DEFAULT 0,
      vod_score     REAL    NOT NULL DEFAULT 0,
      vod_time      INTEGER NOT NULL DEFAULT 0,
      vod_play_from TEXT    NOT NULL DEFAULT '',
      vod_play_url  TEXT    NOT NULL DEFAULT '',
      UNIQUE(vod_name)
    );

    CREATE INDEX IF NOT EXISTS idx_vod_type   ON vods(type_id);
    CREATE INDEX IF NOT EXISTS idx_vod_status ON vods(vod_status, vod_time);
    CREATE INDEX IF NOT EXISTS idx_vod_hits   ON vods(vod_hits);

    CREATE TABLE IF NOT EXISTS admins (
      admin_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_name TEXT    NOT NULL UNIQUE,
      admin_pwd  TEXT    NOT NULL,
      admin_role TEXT    NOT NULL DEFAULT 'admin',
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS collect_sources (
      source_id       INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name     TEXT    NOT NULL,
      source_type     TEXT    NOT NULL DEFAULT 'json',
      source_config   TEXT    NOT NULL DEFAULT '{}',
      source_interval INTEGER NOT NULL DEFAULT 0,
      source_enabled  INTEGER NOT NULL DEFAULT 1,
      last_run_at     INTEGER NOT NULL DEFAULT 0,
      next_run_at     INTEGER NOT NULL DEFAULT 0,
      last_status     TEXT    NOT NULL DEFAULT '',
      last_message    TEXT    NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS collect_logs (
      log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER NOT NULL DEFAULT 0,
      source_name TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT '',
      message     TEXT    NOT NULL DEFAULT '',
      stats       TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_source_due ON collect_sources(source_enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_log_source ON collect_logs(source_id, log_id);
  `);
}

/** 首次启动时写入演示数据；已有数据则跳过。 */
function seed() {
  const typeCount = db.prepare('SELECT COUNT(*) AS n FROM types').get().n;
  if (typeCount === 0) {
    const insertType = db.prepare(`
      INSERT INTO types (type_id, type_pid, type_name, type_en, type_sort, type_status)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    insertType.run(1, 0, '电影', 'movie', 100);
    insertType.run(2, 0, '电视剧', 'tv', 90);
    insertType.run(3, 0, '动漫', 'anime', 80);
    insertType.run(4, 1, '动作片', 'action', 100);
    insertType.run(5, 1, '喜剧片', 'comedy', 90);
    insertType.run(6, 2, '国产剧', 'cn-tv', 100);
    insertType.run(7, 2, '日韩剧', 'jp-kr-tv', 90);
    insertType.run(8, 3, '日番', 'jp-anime', 100);
  }

  const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (adminCount === 0) {
    db.prepare(`
      INSERT INTO admins (admin_name, admin_pwd, admin_role, created_at)
      VALUES (?, ?, 'super', ?)
    `).run('admin', hashPassword('admin123'), Date.now());
  }

  const vodCount = db.prepare('SELECT COUNT(*) AS n FROM vods').get().n;
  if (vodCount === 0) {
    const insertVod = db.prepare(`
      INSERT INTO vods (
        type_id, vod_name, vod_en, vod_pic, vod_actor, vod_director,
        vod_year, vod_area, vod_lang, vod_remarks, vod_content,
        vod_status, vod_hits, vod_score, vod_time, vod_play_from, vod_play_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `);

    const demoStream = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
    const rows = [
      [4, '示例动作片', 'demo-action', '', '张三,李四', '王五', '2026', '中国', '国语',
        'HD', '这是一部用于演示的影片简介。', 1200, 8.6, Date.now() - 3600_000,
        'm3u8$$$iframe',
        `第1集$${demoStream}#第2集$${demoStream}$$$第1集$https://example.com/embed/1`],
      [5, '示例喜剧片', 'demo-comedy', '', '赵六,钱七', '孙八', '2025', '中国', '国语',
        '更新至2集', '演示数据，可在后台编辑或删除。', 860, 7.9, Date.now() - 7200_000,
        'm3u8', `第1集$${demoStream}#第2集$${demoStream}`],
      [6, '示例国产剧', 'demo-cn-tv', '', '演员甲,演员乙', '导演甲', '2026', '中国', '国语',
        '更新至3集', '演示用电视剧。', 2300, 8.2, Date.now() - 10_800_000,
        'm3u8', `第1集$${demoStream}#第2集$${demoStream}#第3集$${demoStream}`],
      [7, '示例日韩剧', 'demo-jp-kr-tv', '', '演员丙', '导演乙', '2024', '日本', '日语',
        '全10集', '演示用日韩剧。', 540, 8.0, Date.now() - 86_400_000,
        'm3u8', `第1集$${demoStream}`],
      [8, '示例日番', 'demo-anime', '', '声优甲', '监督甲', '2026', '日本', '日语',
        '更新至5集', '演示用动漫。', 3100, 9.1, Date.now() - 172_800_000,
        'm3u8', `第1集$${demoStream}#第2集$${demoStream}`],
      [3, '示例动漫电影', 'demo-anime-movie', '', '声优乙', '监督乙', '2023', '日本', '日语',
        'HD', '演示用动漫电影。', 760, 8.8, Date.now() - 259_200_000,
        'm3u8', `正片$${demoStream}`],
    ];

    for (const row of rows) insertVod.run(...row);
  }

  const sourceCount = db.prepare('SELECT COUNT(*) AS n FROM collect_sources').get().n;
  if (sourceCount === 0) {
    const now = Date.now();
    const insertSource = db.prepare(`
      INSERT INTO collect_sources (
        source_name, source_type, source_config, source_interval,
        source_enabled, last_run_at, next_run_at, last_status, last_message, created_at
      ) VALUES (?, ?, ?, 0, 0, 0, 0, '', '', ?)
    `);

    const jsonConfig = {
      keyword: '测试',
      typeId: 3,
      pages: 1,
      search: {
        url: `@originRaw/mock/rules/json/search?wd=@keyword`,
        list: '$.info.rows[*]',
        name: '$.vod_name',
        source: '$.vod_id',
      },
      detail: {
        url: `@originRaw/mock/rules/json/detail?id=@source`,
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
    };

    const xmlConfig = {
      keyword: '测试',
      typeId: 3,
      pages: 1,
      search: {
        url: `@originRaw/mock/rules/xml/search?wd=@keyword`,
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
    };

    const xpathConfig = {
      keyword: '测试',
      typeId: 3,
      pages: 1,
      search: {
        url: `@originRaw/mock/rules/html/search?wd=@keyword`,
        list: '//div[contains(@class,"item")]',
        name: './/h3/text()',
        source: './a/@href',
      },
      detail: {
        url: '@originRaw@sourceRaw',
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
    };

    insertSource.run('示例 JSON 采集源', 'json', JSON.stringify(jsonConfig, null, 2), now);
    insertSource.run('示例 XML 采集源', 'xml', JSON.stringify(xmlConfig, null, 2), now);
    insertSource.run('示例 XPath 采集源', 'xpath', JSON.stringify(xpathConfig, null, 2), now);
  }
}

/** 清空业务数据（保留表结构），仅用于开发调试。 */
function reset() {
  db.exec(`
    DELETE FROM vods;
    DELETE FROM types;
    DELETE FROM admins;
    DELETE FROM collect_sources;
    DELETE FROM collect_logs;
  `);
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('vods','types','admins','collect_sources','collect_logs');");
}

initDb();
seed();

if (require.main === module && process.argv.includes('--seed')) {
  console.log(`数据库已初始化：${DB_FILE}`);
  console.log('后台账号：admin / admin123');
}

module.exports = { db, initDb, seed, reset, DB_FILE };





