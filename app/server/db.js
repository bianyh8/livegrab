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
  delete_after_merge     INTEGER,            -- 合并整场后是否删除原始 .ts 分段（v0.1.39）
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
  user_agent             TEXT,
  default_monitor_only   INTEGER            -- 新增直播间默认「仅监控」开关（v0.1.36）
);
CREATE TABLE IF NOT EXISTS platform_caps    (platform TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS platform_enabled (platform TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS platform_proxy   (platform TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS notify (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  webhook    TEXT,
  on_start   INTEGER,
  on_end     INTEGER,
  on_error   INTEGER,
  on_disk    INTEGER,
  on_cookie  INTEGER,
  on_live    INTEGER,                      -- 新增「开播通知」开关（v0.1.36）
  dedupe_sec INTEGER,
  dedupe     INTEGER,                      -- 新增「去重总开关」：false 时跳过去重（v0.1.36）
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
  session_hold        INTEGER,            -- 本场挂起：停止本场后下播前不再自动拉起，下播清除
  live_notified_at    TEXT,               -- 本场直播「开播通知」发送时间（null = 本场未通知；下播清空）
  poll_interval_sec   INTEGER,
  start_delay_sec     INTEGER,
  stop_delay_sec      INTEGER,
  status              TEXT,
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
  end_reason     TEXT,                        -- 分段结束原因：timeout 按设定时长轮转 | reconnect 断流重连前收尾 | offline 主播下播 | user 手动停止
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
  // 任何外部连接（诊断脚本/第二个实例/备份工具）持写锁时，默认 busy_timeout=0 会让写入立刻 SQLITE_BUSY。
  // 5s 足够覆盖本项目的短事务；超时仍会抛错，由调用方回滚内存。
  db.pragma('busy_timeout = 5000');
  let mode = 'delete';
  try {
    mode = db.pragma('journal_mode = WAL', { simple: true });
  } catch {
    // NAS / 网络文件系统可能不支持 WAL
  }
  try {
    if (mode === 'wal') db.pragma('synchronous = NORMAL');
    else { db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); } // 回退模式必须 FULL，避免掉电损坏
  } catch { /* 保持默认 */ }
}

/**
 * 当前库的结构版本；无 meta 表（全新空库）返回 0；读取/解析失败抛错，由调用方决定处置。
 * 只接受十进制整数字面量：`2abc`/`2.1`/空串以前会被 Number() 变成 NaN，然后被判成「版本不匹配」→ 删库重建。
 */
export function schemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if (!row) return 0;
    const raw = String(row.value ?? '').trim();
    if (!/^\d+$/.test(raw)) throw new Error(`meta.schema_version 不是合法整数：「${raw}」`);
    return Number(raw);
  } catch (e) {
    if (/no such table/i.test(e?.message || '')) return 0; // 全新空库（0 字节文件）→ 无 meta 表
    throw e; // 其余读取失败：绝不静默当作旧库处理（尤其不能当 0）
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
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
export function openDb(dbPath, onLog = null) {
  // onLog(level, msg)：logger 就绪前的启动日志出口（server.js 用缓冲收集，就绪后补写进日志文件）
  const say = (level, msg) => { if (onLog) onLog(level, msg); else if (level === 'WARN') console.warn(msg); else console.log(msg); };
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // 首次部署时 config 目录可能还不存在
  let db = new Database(dbPath);

  let ver;
  try {
    ver = schemaVersion(db);
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    throw new Error(`[db] 数据库文件无法读取（可能损坏或不是 SQLite 文件）：${dbPath}（${e?.message || e}）。已保留原文件、未作任何删除，请人工检查。`);
  }

  // 比当前结构更新的库：绝不作废重建（降级会清空数据），直接拒绝启动
  if (ver > SCHEMA_VERSION) {
    try { db.close(); } catch { /* ignore */ }
    throw new Error(`[db] 数据库结构版本 ${ver} 高于本程序支持的 ${SCHEMA_VERSION}：${dbPath}。通常是用旧版程序打开了新版数据库；原文件未作任何改动，请升级程序或改用备份库。`);
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bakOf = (suf) => `${dbPath}.bak-${stamp}${suf}`;
    if (ver === 0) {
      // 全新库（文件刚被 Database 创建）：没有数据可保，直接沿用连接建表，
      // 不再把 0 字节文件改名成 .bak（否则每次首次部署都留一个空备份）。
      say('INFO', '全新空库，初始化 v2 表结构');
    } else {
      say('WARN', `检测到旧版数据库（schema_version=${ver} ≠ ${SCHEMA_VERSION}），按设计作废重建为 v2 空库；原文件已备份为 ${path.basename(bakOf(''))}，不保留旧数据`);
      try { db.close(); } catch { /* ignore */ }
      // 先备 -wal/-shm、最后备主文件；任一步失败就把已改名的还原，绝不在备份未完成时删任何文件
      const moved = [];
      try {
        for (const suf of ['-wal', '-shm', '']) {
          const src = dbPath + suf;
          if (!fs.existsSync(src)) continue;
          fs.renameSync(src, bakOf(suf));
          moved.push([src, bakOf(suf)]);
        }
      } catch (e) {
        for (const [src, dst] of moved.reverse()) {
          try { fs.renameSync(dst, src); } catch { /* ignore */ }
        }
        throw new Error(`[db] 作废旧库前备份失败：${e?.message || e}。已中止启动，原文件未删除。`);
      }
      db = new Database(dbPath);
    }
  }

  // 每次打开都执行幂等 DDL：正常 v2 库缺表/半损坏时可自愈；全新/重建路径由它建表
  db.exec(DDL);
  // 幂等补列迁移：旧 v2 库（schema_version 仍是 2）新增列用 ALTER 补齐。
  // 注意：不能靠提升 SCHEMA_VERSION 来做，openDb 对版本不匹配是「整库作废重建」，会删光用户数据。
  // 每条独立执行且失败即抛：缺列时 store 的固定列清单会让所有写入抛 "no such column"，
  // 以前整块 try/catch 静默兜底会把「一次缺列」放大成「整个文件库不落库」。
  const ensureCol = (table, col, decl) => {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
    if (cols.includes(col)) return;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
      say('INFO', `数据库迁移：${table} 补列 ${col}`);
    } catch (e) {
      throw new Error(`[db] 迁移失败：${table}.${col} 补列失败（${e?.message || e}）。已中止启动——带缺列的表结构继续运行会让后续写入整批失败。`);
    }
  };
  ensureCol('tasks', 'session_hold', 'session_hold INTEGER');
  ensureCol('tasks', 'live_notified_at', 'live_notified_at TEXT');
  ensureCol('files', 'end_reason', 'end_reason TEXT');
  ensureCol('settings', 'default_monitor_only', 'default_monitor_only INTEGER');
  ensureCol('settings', 'delete_after_merge', 'delete_after_merge INTEGER');
  ensureCol('notify', 'on_live', 'on_live INTEGER');
  ensureCol('notify', 'dedupe', 'dedupe INTEGER');
  // 老库 ALTER 加列无 DEFAULT → 存量行 on_live 为 NULL，读取时 !!NULL=false 会把「开播通知」静默关掉（v0.1.36 bug）。
  // 幂等修正：NULL 视为开启（默认值 onLive:true 的落库形态），每次打开都跑也无副作用。
  try {
    db.exec('UPDATE notify SET on_live = 1 WHERE on_live IS NULL');
  } catch (e) {
    throw new Error(`[db] 迁移失败：notify.on_live 回填失败（${e?.message || e}）`);
  }
  applyPragmas(db);
  if (isRebuild) {
    setMeta(db, 'schema_version', SCHEMA_VERSION);
    setMeta(db, 'db_created_at', new Date().toISOString());
    seedVariables(db);
  }
  return db;
}
