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
}

/** 清空业务数据（保留表结构），仅用于开发调试。 */
function reset() {
  db.exec('DELETE FROM vods; DELETE FROM types; DELETE FROM admins;');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('vods','types','admins');");
}

initDb();
seed();

if (require.main === module && process.argv.includes('--seed')) {
  console.log(`数据库已初始化：${DB_FILE}`);
  console.log('后台账号：admin / admin123');
}

module.exports = { db, initDb, seed, reset, DB_FILE };





