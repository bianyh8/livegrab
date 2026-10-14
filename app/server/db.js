// db.js —— SQLite 存储层（better-sqlite3）· v2 全列架构
// 单库 livegrab.db；WAL 模式（NAS/网络卷不支持 WAL 时自动回退 DELETE）。
//
// v2 设计要点：
//  · tasks / sessions / files 全部真实列，任何表都不再有 data_json；
//  · 嵌套结构拆子表：task_overrides（任务级自定义）、trash_files / trash_sessions（回收站快照）；
//  · 刮削与预览不再单开表，直接在 files 上两列：thumbnail_path（首帧海报）、scrape_path（nfo）；
//  · 旧 v1 库（data_json 结构）一律作废：检测到 schema_version ≠ 2 即关闭并删除旧文件后重建全新空库（不迁移，不导入）。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { VARIABLES } from './naming.js';

export const SCHEMA_VERSION = 2;

const DDL = `
-- ---------- 元信息 ----------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- 全局设置（单行） ----------
CREATE TABLE IF NOT EXISTS settings (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  max_concurrency        INTEGER,
  default_quality        TEXT,
  quality_fallback       TEXT,              -- 逗号串，例：origin,bluray,uhd,hd,sd
  default_segment_mode   TEXT,
  default_segment_minutes INTEGER,
  default_segment_size_mb INTEGER,
  record_container       TEXT,
  remux_to_mp4           INTEGER,
  keep_source            INTEGER,
  auto_merge             INTEGER,
  merge_on_stop          INTEGER,
  reconnect_max          INTEGER,
  poll_interval_sec      INTEGER,
  start_delay_sec        INTEGER,
  stop_delay_sec         INTEGER,
  disk_limit_gb          INTEGER,
  retention_days         INTEGER,
  delete_to_trash        INTEGER,
  trash_retention_days   INTEGER,
  log_retention_days     INTEGER,
  log_level              TEXT,
  play_concurrency       INTEGER,
  proxy                  TEXT,
  user_agent             TEXT
);
CREATE TABLE IF NOT EXISTS platform_caps    (platform TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS platform_enabled (platform TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS notify (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  webhook    TEXT,
  on_start   INTEGER,
  on_end     INTEGER,
  on_error   INTEGER,
  on_disk    INTEGER,
  on_cookie  INTEGER,
  dedupe_sec INTEGER,
  retry      INTEGER
);
CREATE TABLE IF NOT EXISTS security (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  session_days  INTEGER,
  fail_limit    INTEGER,
  fail_lock_min INTEGER,
  trust_lan     INTEGER
);
CREATE TABLE IF NOT EXISTS cookies (
  platform   TEXT PRIMARY KEY,
  value      TEXT,        -- 明文整条 Cookie
  ttwid      TEXT,        -- 抖音 ttwid（从 Cookie 中提取，便于单独复用）
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS customize (key TEXT PRIMARY KEY, value TEXT);

-- ---------- 命名规则 ----------
CREATE TABLE IF NOT EXISTS naming (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  active_id TEXT
);
CREATE TABLE IF NOT EXISTS naming_profiles (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  fn_template         TEXT,
  dir_template        TEXT,
  options_date_format TEXT,
  options_seq_digits  INTEGER,
  options_time_format TEXT,
  options_illegal     TEXT,
  options_dup_strategy TEXT,
  options_max_name_chars INTEGER,
  binding_type        TEXT,
  binding_value       TEXT
);
CREATE TABLE IF NOT EXISTS naming_variables (
  token   TEXT PRIMARY KEY,
  desc    TEXT,
  example TEXT
);

-- ---------- 任务 ----------
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  platform            TEXT NOT NULL,
  room_id             TEXT NOT NULL DEFAULT '',
  short_id            TEXT NOT NULL DEFAULT '',
  source_url          TEXT NOT NULL DEFAULT '',      -- 唯一入口推导出的规范直播间地址
  anchor_name         TEXT NOT NULL DEFAULT '',      -- 用户定义主播名（展示优先）
  platform_anchor_name TEXT NOT NULL DEFAULT '',     -- 平台显示名（用户未定义时展示）
  title               TEXT NOT NULL DEFAULT '',
  avatar_file         TEXT,      -- 本地头像缓存相对路径（不存平台 URL）
  quality             TEXT,
  quality_actual      TEXT,
  quality_label       TEXT,
  segment_mode        TEXT,
  segment_minutes     INTEGER,
  segment_size_mb     INTEGER,
  container           TEXT,
  remux_to_mp4        INTEGER,
  keep_source         INTEGER,
  auto_merge          INTEGER,
  reconnect_max       INTEGER,
  naming_profile_id   TEXT,
  custom_text         TEXT,
  auto_record         INTEGER,
  monitor_only        INTEGER,
  manual_held         INTEGER,
  poll_interval_sec   INTEGER,
  start_delay_sec     INTEGER,
  stop_delay_sec      INTEGER,
  status              TEXT,
  status_message      TEXT,
  queue_reason        TEXT,
  last_error          TEXT,
  retry_count         INTEGER,
  reconnect_count     INTEGER,
  started_at          TEXT,
  ended_at            TEXT,
  total_bytes         INTEGER,
  total_duration_sec  REAL,
  segment_index       INTEGER,
  current_file        TEXT,
  session_id          TEXT,
  platform_name       TEXT,
  next_poll_at        INTEGER,
  fail_count          INTEGER,
  fail_notified       INTEGER,
  live_status         TEXT,
  name_locked         INTEGER,
  created_at          TEXT,
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_poll     ON tasks(next_poll_at);
CREATE INDEX IF NOT EXISTS idx_tasks_platform ON tasks(platform);
-- 任务级自定义（值为 null/'' 表示跟随全局）
CREATE TABLE IF NOT EXISTS task_overrides (
  task_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (task_id, key)
);

-- ---------- 场次（一次直播录制） ----------
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  task_id           TEXT,
  platform          TEXT,
  platform_name     TEXT,
  room_id           TEXT,
  streamer          TEXT,
  title             TEXT,
  quality           TEXT,
  quality_label     TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  duration_sec      REAL,
  bytes             INTEGER,
  status            TEXT,
  dir               TEXT,
  rel_dir           TEXT,
  naming_profile_id TEXT,
  snap_anchor_name  TEXT,   -- 录制时快照：主播名
  snap_room_id      TEXT,   -- 录制时快照：房间号
  merged_file_id    TEXT,
  mp4_file_id       TEXT,
  created_at        TEXT,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_task     ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_streamer ON sessions(streamer);
CREATE INDEX IF NOT EXISTS idx_sessions_started  ON sessions(started_at);

-- ---------- 文件（单真相源，path 唯一） ----------
CREATE TABLE IF NOT EXISTS files (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,            -- segment | merged | mp4 | m4a | external | thumb
  name           TEXT,
  ext            TEXT,
  bytes          INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ok', -- ok | recording | missing
  duration_sec   REAL,
  width          INTEGER,
  height         INTEGER,
  thumbnail_path TEXT,                     -- 预览首帧海报（<同名>.jpg）相对路径
  scrape_path    TEXT,                     -- 刮削信息（<同名>.nfo）相对路径
  task_id        TEXT,
  session_id     TEXT,
  source_file_id TEXT,
  rel_path       TEXT,
  segment_index  INTEGER DEFAULT 0,
  created_at     TEXT,
  completed_at   TEXT,
  updated_at     TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
CREATE INDEX IF NOT EXISTS idx_files_kind    ON files(kind);
CREATE INDEX IF NOT EXISTS idx_files_status  ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_source  ON files(source_file_id);

-- ---------- 回收站（快照，可整场还原） ----------
CREATE TABLE IF NOT EXISTS trash (
  id         TEXT PRIMARY KEY,
  kind       TEXT,                                  -- session | file
  name       TEXT,
  bytes      INTEGER,
  deleted_at TEXT,
  expire_at  TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_trash_expire ON trash(expire_at);
CREATE TABLE IF NOT EXISTS trash_files (
  trash_id        TEXT NOT NULL,
  file_id         TEXT,
  kind            TEXT,
  name            TEXT,
  path            TEXT,        -- 原绝对路径（还原用）
  trash_path      TEXT,        -- 回收站内实际路径（还原用）
  rel_path        TEXT,
  ext             TEXT,
  bytes           INTEGER,
  duration_sec    REAL,
  width           INTEGER,
  height          INTEGER,
  status          TEXT,
  segment_index   INTEGER,
  source_file_id  TEXT,
  thumbnail_path  TEXT,
  scrape_path     TEXT,
  created_at      TEXT,
  completed_at    TEXT,
  FOREIGN KEY (trash_id) REFERENCES trash(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trash_files_trash ON trash_files(trash_id);
CREATE TABLE IF NOT EXISTS trash_sessions (
  trash_id          TEXT PRIMARY KEY,
  session_id        TEXT,
  task_id           TEXT,
  platform          TEXT,
  platform_name     TEXT,
  room_id           TEXT,
  streamer          TEXT,
  title             TEXT,
  quality           TEXT,
  quality_label     TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  duration_sec      REAL,
  status            TEXT,
  dir               TEXT,
  rel_dir           TEXT,
  naming_profile_id TEXT,
  snap_anchor_name  TEXT,
  snap_room_id      TEXT,
  merged_file_id    TEXT,
  mp4_file_id       TEXT,
  FOREIGN KEY (trash_id) REFERENCES trash(id) ON DELETE CASCADE
);
`;

function applyPragmas(db) {
  db.pragma('foreign_keys = ON');
  let mode = 'delete';
  try {
    mode = db.pragma('journal_mode = WAL', { simple: true });
  } catch {
    // NAS / 网络文件系统可能不支持 WAL
  }
  try {
    if (mode === 'wal') db.pragma('synchronous = NORMAL');
    else { db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); } // M4：回退模式必须 FULL，避免掉电损坏
  } catch { /* 保持默认 */ }
}

/** 当前库的结构版本；无 meta 表（全新空库）返回 0；读取失败（损坏/非 SQLite/IO）抛错，由调用方决定处置 */
export function schemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch (e) {
    if (/no such table/i.test(e?.message || '')) return 0; // 全新空库（0 字节文件）→ 无 meta 表
    throw e; // 其余读取失败：绝不静默当作旧库处理
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? row.value : null;
}

/** 命名变量字典（token/desc/example）首次建库时落表，供前端展示与校验 */
function seedVariables(db) {
  const ins = db.prepare('INSERT OR REPLACE INTO naming_variables(token, desc, example) VALUES(?,?,?)');
  for (const v of VARIABLES || []) ins.run(v.token, v.desc || '', v.example || '');
}

/**
 * 打开（必要时创建）v2 数据库。
 * 空库 → 建全部表；旧版本库（v1 data_json）→ 关闭并删除 db/-wal/-shm 后重建全新空库。
 * 注意：这里不做任何迁移/导入——旧库数据一律作废（用户自行处理旧数据）。
 */
export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // 首次部署时 config 目录可能还不存在
  let db = new Database(dbPath);

  let ver;
  try {
    ver = schemaVersion(db);
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    throw new Error(`[db] 数据库文件无法读取（可能损坏或不是 SQLite 文件）：${dbPath}（${e?.message || e}）。已保留原文件、未作任何删除，请人工检查。`);
  }

  const isRebuild = ver !== SCHEMA_VERSION;
  if (isRebuild) {
    // 二次校验：ver===0 且库里已有非 sqlite_ 表 = 有效但非 LiveGrab 的库 → 不碰原文件
    if (ver === 0) {
      const tbl = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
      if (tbl.c > 0) {
        try { db.close(); } catch { /* ignore */ }
        throw new Error(`[db] 检测到有效但非 LiveGrab v2 的数据库（含 ${tbl.c} 张表、无 meta.schema_version）：${dbPath}。为避免误删已保留原文件，请人工确认后移除或改名再启动。`);
      }
    }
    if (ver === 0) console.log('[db] 全新空库，初始化 v2 表结构…');
    else console.warn(`[db] 检测到旧版/未知数据库（schema_version=${ver} ≠ ${SCHEMA_VERSION}），按设计作废重建为 v2 空库（原文件已删除，不保留旧数据）`);
    try { db.close(); } catch { /* ignore */ }
    for (const suf of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suf, { force: true }); } catch { /* ignore */ }
    }
    db = new Database(dbPath);
  }

  // 每次打开都执行幂等 DDL（M3）：正常 v2 库缺表/半损坏时可自愈；全新/重建路径由它建表
  db.exec(DDL);
  applyPragmas(db);
  if (isRebuild) {
    setMeta(db, 'schema_version', SCHEMA_VERSION);
    setMeta(db, 'db_created_at', new Date().toISOString());
    seedVariables(db);
  }
  return db;
}

/** 数据库是否为空（无任何场次记录）；读取失败抛错，绝不说成「空库」 */
export function isEmpty(db) {
  try {
    return db.prepare('SELECT COUNT(*) c FROM sessions').get().c === 0;
  } catch (e) {
    throw new Error(`[db] 判定库是否为空时读取失败：${e?.message || e}`);
  }
}
