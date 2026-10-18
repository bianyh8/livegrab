// store.js —— 内存模型 + SQLite 唯一持久层（v2 全列架构）
//
// 设计口径：
//  · SQLite 是唯一存储：没有 state.json，没有 data_json，不再有 JSON 镜像/回退；
//  · 内存 state 是运行时模型，API 读内存；所有变更方法「先改内存、再把行写进 SQLite」（行级写穿透，单事务）；
//  · persist() 作为兜底：把内存全量对账式落库（外部文件、批量状态归一、启动/关停时调用）。
import path from 'node:path';
import { uid, nowIso, ensureDir } from './util.js';
import { DEFAULT_NAMING, DEFAULT_OPTIONS, VARIABLES } from './naming.js';

export const DEFAULT_SETTINGS = {
  recordRoot: process.env.RECORD_ROOT || '/data',   // 运行时环境项，不入库
  configDir: process.env.CONFIG_DIR || '/config',   // 运行时环境项，不入库
  maxConcurrency: 8,
  defaultQuality: 'origin',
  qualityFallback: ['origin', 'bluray', 'uhd', 'hd', 'sd'],
  defaultSegmentMode: 'time',
  defaultSegmentMinutes: 3600,
  defaultSegmentSizeMB: 2048,
  recordContainer: 'ts',
  remuxToMp4: true,
  keepSource: true,
  autoMerge: false,
  mergeOnStop: false,
  deleteAfterMerge: true,
  reconnectMax: 5,
  pollIntervalSec: 60,
  startDelaySec: 5,
  stopDelaySec: 30,
  diskLimitGB: 20,
  retentionDays: 30,
  deleteToTrash: true,
  trashRetentionDays: 7,
  logRetentionDays: 14,
  logLevel: 'INFO',
  playConcurrency: 2,
  proxy: '',
  userAgent: '',
  defaultMonitorOnly: false,
  platformCaps: {
    douyin: 4, bilibili: 4, kuaishou: 3, huya: 3, douyu: 3,
    xiaohongshu: 2, weibo: 2, acfun: 2, direct: 8,
  },
  platformEnabled: {
    douyin: true, bilibili: true, kuaishou: true, huya: true, douyu: true,
    xiaohongshu: true, weibo: true, direct: true, acfun: false,
  },
  // 按平台「是否使用代理」开关：仅当该平台开启 且 全局 proxy 已配置时，该平台的解析/录制才走代理。
  // 缺省全部关闭（走直连），与「全局 proxy 为空则全直连」语义一致。
  platformUseProxy: {},
  notify: { webhook: '', onStart: true, onEnd: true, onLive: true, onError: true, onDisk: true, onCookie: false, dedupeSec: 60, dedupe: true, retry: true },
  security: { sessionDays: 30, failLimit: 5, failLockMin: 10, trustLan: false },
  cookies: {},
  customize: {},
};

// 与重构前完全一致：返回新对象，不改动入参（base 常为 DEFAULT_SETTINGS，必须只读）
export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]))
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

// ================= SQL 语句表 =================
// 多列表统一用「列数组 → 生成 upsert SQL」，避免手写列名漏项。
const TASK_COLS = [
  'platform', 'room_id', 'short_id', 'source_url', 'anchor_name', 'platform_anchor_name', 'title', 'avatar_file',
  'quality', 'quality_actual', 'quality_label', 'segment_mode', 'segment_minutes', 'segment_size_mb', 'container',
  'remux_to_mp4', 'keep_source', 'auto_merge', 'reconnect_max', 'naming_profile_id', 'custom_text',
  'auto_record', 'monitor_only', 'manual_held', 'session_hold', 'poll_interval_sec', 'start_delay_sec', 'stop_delay_sec',
  'status', 'status_message', 'queue_reason', 'last_error', 'retry_count', 'reconnect_count',
  'started_at', 'ended_at', 'total_bytes', 'total_duration_sec', 'segment_index', 'current_file', 'session_id',
  'platform_name', 'next_poll_at', 'fail_count', 'fail_notified', 'live_status', 'name_locked',
  'created_at', 'updated_at',
];
const SESSION_COLS = [
  'task_id', 'platform', 'platform_name', 'room_id', 'streamer', 'title', 'quality', 'quality_label',
  'started_at', 'ended_at', 'duration_sec', 'bytes', 'status', 'dir', 'rel_dir', 'naming_profile_id',
  'snap_anchor_name', 'snap_room_id', 'merged_file_id', 'mp4_file_id', 'created_at', 'updated_at',
];
const FILE_COLS = [
  'path', 'kind', 'name', 'ext', 'bytes', 'status', 'duration_sec', 'width', 'height',
  'thumbnail_path', 'scrape_path', 'task_id', 'session_id', 'source_file_id', 'rel_path',
  'segment_index', 'end_reason', 'created_at', 'completed_at', 'updated_at', 'deleted',
];
const SETTINGS_COLS = [
  'max_concurrency', 'default_quality', 'quality_fallback', 'default_segment_mode', 'default_segment_minutes',
  'default_segment_size_mb', 'record_container', 'remux_to_mp4', 'keep_source',   'auto_merge', 'merge_on_stop', 'delete_after_merge',
  'reconnect_max', 'poll_interval_sec', 'start_delay_sec', 'stop_delay_sec', 'disk_limit_gb', 'retention_days',
  'delete_to_trash', 'trash_retention_days', 'log_retention_days', 'log_level', 'play_concurrency', 'proxy', 'user_agent',
  'default_monitor_only',
];
const NOTIFY_COLS = ['webhook', 'on_start', 'on_end', 'on_live', 'on_error', 'on_disk', 'on_cookie', 'dedupe_sec', 'dedupe', 'retry'];
const SECURITY_COLS = ['session_days', 'fail_limit', 'fail_lock_min', 'trust_lan'];
const NAMING_PROFILE_COLS = [
  'name', 'fn_template', 'dir_template', 'options_date_format', 'options_seq_digits', 'options_time_format',
  'options_illegal', 'options_dup_strategy', 'options_max_name_chars', 'binding_type', 'binding_value',
];
const TRASH_SESSION_COLS = [
  'session_id', 'task_id', 'platform', 'platform_name', 'room_id', 'streamer', 'title', 'quality', 'quality_label',
  'started_at', 'ended_at', 'duration_sec', 'status', 'dir', 'rel_dir', 'naming_profile_id',
  'snap_anchor_name', 'snap_room_id', 'merged_file_id', 'mp4_file_id',
];
const TRASH_FILE_COLS = [
  'file_id', 'kind', 'name', 'path', 'trash_path', 'rel_path', 'ext', 'bytes', 'duration_sec', 'width', 'height',
  'status', 'segment_index', 'source_file_id', 'thumbnail_path', 'scrape_path', 'created_at', 'completed_at',
];

/** 主键是绑定参数的表：INSERT ... ON CONFLICT(key) DO UPDATE */
const upsertSql = (table, keyCol, cols) => {
  const all = [keyCol, ...cols];
  return `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map((c) => `@${c}`).join(', ')})
ON CONFLICT(${keyCol}) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')}`;
};

/** 单行表：主键固定字面量 1（settings / notify / security / naming） */
const upsertSingleSql = (table, cols) => {
  return `INSERT INTO ${table} (id, ${cols.join(', ')}) VALUES (1, ${cols.map((c) => `@${c}`).join(', ')})
ON CONFLICT(id) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')}`;
};

const SQL = {
  // 任务
  task_upsert: upsertSql('tasks', 'id', TASK_COLS),
  task_delete: 'DELETE FROM tasks WHERE id = ?',
  tasks_delete_all: 'DELETE FROM tasks',
  overrides_delete: 'DELETE FROM task_overrides WHERE task_id = ?',
  overrides_delete_all: 'DELETE FROM task_overrides',
  override_insert: 'INSERT OR REPLACE INTO task_overrides (task_id, key, value) VALUES (?, ?, ?)',
  // 场次 / 文件
  session_upsert: upsertSql('sessions', 'id', SESSION_COLS),
  session_delete: 'DELETE FROM sessions WHERE id = ?',
  sessions_delete_all: 'DELETE FROM sessions',
  file_upsert: upsertSql('files', 'id', FILE_COLS),
  files_delete_session: 'DELETE FROM files WHERE session_id = ?',
  files_delete_all: 'DELETE FROM files',
  // 设置
  settings_upsert: upsertSingleSql('settings', SETTINGS_COLS),
  platform_caps_delete_all: 'DELETE FROM platform_caps',
  platform_caps_insert: 'INSERT OR REPLACE INTO platform_caps (platform, value) VALUES (?, ?)',
  platform_enabled_delete_all: 'DELETE FROM platform_enabled',
  platform_enabled_insert: 'INSERT OR REPLACE INTO platform_enabled (platform, value) VALUES (?, ?)',
  platform_proxy_delete_all: 'DELETE FROM platform_proxy',
  platform_proxy_insert: 'INSERT OR REPLACE INTO platform_proxy (platform, value) VALUES (?, ?)',
  notify_upsert: upsertSingleSql('notify', NOTIFY_COLS),
  security_upsert: upsertSingleSql('security', SECURITY_COLS),
  cookies_delete_all: 'DELETE FROM cookies',
  cookie_upsert: 'INSERT OR REPLACE INTO cookies (platform, value, ttwid, updated_at) VALUES (@platform, @value, @ttwid, @updated_at)',
  customize_delete_all: 'DELETE FROM customize',
  customize_upsert: 'INSERT OR REPLACE INTO customize (key, value) VALUES (?, ?)',
  // 命名
  naming_upsert: upsertSingleSql('naming', ['active_id']),
  naming_profiles_delete_all: 'DELETE FROM naming_profiles',
  naming_profile_upsert: upsertSql('naming_profiles', 'id', NAMING_PROFILE_COLS),
  naming_variables_delete_all: 'DELETE FROM naming_variables',
  naming_variable_insert: 'INSERT OR REPLACE INTO naming_variables (token, desc, example) VALUES (?, ?, ?)',
  // 回收站
  trash_upsert: upsertSql('trash', 'id', ['kind', 'name', 'bytes', 'deleted_at', 'expire_at', 'session_id']),
  trash_delete: 'DELETE FROM trash WHERE id = ?',
  trash_delete_all: 'DELETE FROM trash',
  trash_files_delete: 'DELETE FROM trash_files WHERE trash_id = ?',
  trash_file_insert: `INSERT INTO trash_files (trash_id, ${TRASH_FILE_COLS.join(', ')}) VALUES (@trash_id, ${TRASH_FILE_COLS.map((c) => `@${c}`).join(', ')})`,
  trash_session_delete: 'DELETE FROM trash_sessions WHERE trash_id = ?',
  trash_session_upsert: upsertSql('trash_sessions', 'trash_id', TRASH_SESSION_COLS),
};

// ================= 行 ↔ 内存对象映射 =================
const boolish = (v) => (v ? 1 : 0);
// 三态布尔：null/undefined 保持 NULL 落库（语义=跟随全局），不得磨成 0
const boolOrNull = (v) => (v === null || v === undefined ? null : (v ? 1 : 0));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const numOrNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const strOrNull = (v) => (v === null || v === undefined ? null : String(v));

function taskToRow(t) {
  return {
    id: t.id,
    platform: strOrNull(t.platform), room_id: strOrNull(t.roomId), short_id: strOrNull(t.shortId),
    source_url: strOrNull(t.sourceUrl), anchor_name: strOrNull(t.anchorName), platform_anchor_name: strOrNull(t.platformAnchorName),
    title: strOrNull(t.title), avatar_file: strOrNull(t.avatarFile),
    quality: strOrNull(t.quality), quality_actual: strOrNull(t.qualityActual), quality_label: strOrNull(t.qualityLabel),
    segment_mode: strOrNull(t.segmentMode), segment_minutes: numOrNull(t.segmentMinutes), segment_size_mb: numOrNull(t.segmentSizeMB),
    container: strOrNull(t.container),
    remux_to_mp4: boolOrNull(t.remuxToMp4), keep_source: boolish(t.keepSource), auto_merge: boolish(t.autoMerge),
    reconnect_max: numOrNull(t.reconnectMax), naming_profile_id: strOrNull(t.namingProfileId), custom_text: strOrNull(t.customText),
    auto_record: boolish(t.autoRecord), monitor_only: boolish(t.monitorOnly), manual_held: boolish(t.manualHeld),
    poll_interval_sec: numOrNull(t.pollIntervalSec), start_delay_sec: numOrNull(t.startDelaySec), stop_delay_sec: numOrNull(t.stopDelaySec),
    status: strOrNull(t.status), status_message: strOrNull(t.statusMessage), queue_reason: strOrNull(t.queueReason), last_error: strOrNull(t.lastError),
    session_hold: boolish(t.sessionHold),
    retry_count: num(t.retryCount), reconnect_count: num(t.reconnectCount),
    started_at: strOrNull(t.startedAt), ended_at: strOrNull(t.endedAt),
    total_bytes: num(t.totalBytes), total_duration_sec: num(t.totalDurationSec),
    segment_index: num(t.segmentIndex), current_file: strOrNull(t.currentFile), session_id: strOrNull(t.sessionId),
    platform_name: strOrNull(t.platformName), next_poll_at: num(t.nextPollAt),
    fail_count: num(t.failCount), fail_notified: boolish(t.failNotified),
    live_status: strOrNull(t.liveStatus), name_locked: boolish(t.nameLocked),
    created_at: strOrNull(t.createdAt), updated_at: strOrNull(t.updatedAt),
  };
}

function rowToTask(r, overrides = {}) {
  return {
    id: r.id, platform: r.platform, roomId: r.room_id, shortId: r.short_id || '', sourceUrl: r.source_url || '',
    anchorName: r.anchor_name || '', platformAnchorName: r.platform_anchor_name || '', title: r.title || '',
    avatarFile: r.avatar_file || null,
    quality: r.quality, qualityActual: r.quality_actual, qualityLabel: r.quality_label,
    segmentMode: r.segment_mode, segmentMinutes: r.segment_minutes, segmentSizeMB: r.segment_size_mb,
    container: r.container, remuxToMp4: r.remux_to_mp4 == null ? null : !!r.remux_to_mp4, keepSource: !!r.keep_source, autoMerge: !!r.auto_merge,
    reconnectMax: r.reconnect_max, namingProfileId: r.naming_profile_id, customText: r.custom_text || '',
    autoRecord: !!r.auto_record, monitorOnly: !!r.monitor_only, manualHeld: !!r.manual_held,
    pollIntervalSec: r.poll_interval_sec, startDelaySec: r.start_delay_sec, stopDelaySec: r.stop_delay_sec,
    status: r.status, statusMessage: r.status_message, queueReason: r.queue_reason, lastError: r.last_error,
    sessionHold: !!r.session_hold,
    retryCount: r.retry_count || 0, reconnectCount: r.reconnect_count || 0,
    startedAt: r.started_at, endedAt: r.ended_at, totalBytes: r.total_bytes || 0, totalDurationSec: r.total_duration_sec || 0,
    segmentIndex: r.segment_index || 0, currentFile: r.current_file, sessionId: r.session_id,
    platformName: r.platform_name, nextPollAt: r.next_poll_at || 0, failCount: r.fail_count || 0,
    failNotified: !!r.fail_notified, liveStatus: r.live_status, nameLocked: !!r.name_locked,
    overrides, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** files 行写入：session 为 null 表示外部（未登记/导入）文件 */
function fileToRow(session, f, kindOverride = null) {
  return {
    id: f.id,
    path: f.path,
    kind: kindOverride || f.kind || 'segment',
    name: strOrNull(f.name), ext: strOrNull(f.ext),
    bytes: num(f.bytes), status: strOrNull(f.status) || 'ok',
    duration_sec: num(f.durationSec), width: num(f.width), height: num(f.height),
    thumbnail_path: strOrNull(f.thumbnailPath), scrape_path: strOrNull(f.scrapePath),
    task_id: strOrNull(session ? session.taskId : f.taskId),
    session_id: strOrNull(session ? session.id : (f.sessionId || null)),
    source_file_id: strOrNull(f.sourceFileId), rel_path: strOrNull(f.relPath),
    segment_index: num(f.segmentIndex), end_reason: strOrNull(f.endReason),
    created_at: strOrNull(f.createdAt), completed_at: strOrNull(f.completedAt),
    updated_at: nowIso(), deleted: 0,
  };
}

function rowToFile(r) {
  return {
    id: r.id, sessionId: r.session_id, taskId: r.task_id, kind: r.kind,
    name: r.name, path: r.path, relPath: r.rel_path, ext: r.ext,
    bytes: r.bytes || 0, durationSec: r.duration_sec || 0, width: r.width || 0, height: r.height || 0,
    status: r.status || 'ok', segmentIndex: r.segment_index || 0,
    endReason: r.end_reason || null,
    sourceFileId: r.source_file_id || null,
    thumbnailPath: r.thumbnail_path || null, scrapePath: r.scrape_path || null,
    createdAt: r.created_at || null, completedAt: r.completed_at || null,
  };
}

/** 会话内全部文件（segments + extras + merged + mp4），按 id/路径去重 */
function sessionFiles(s) {
  const out = [];
  const seenId = new Set();
  const seenPath = new Set();
  for (const f of [...(s.segments || []), ...(s.extras || []), s.merged, s.mp4]) {
    if (!f || !f.id || !f.path) continue;
    if (seenId.has(f.id) || seenPath.has(f.path)) continue;
    seenId.add(f.id); seenPath.add(f.path);
    out.push(f);
  }
  return out;
}

function sessionToRow(s) {
  return {
    id: s.id, task_id: strOrNull(s.taskId), platform: strOrNull(s.platform), platform_name: strOrNull(s.platformName),
    room_id: strOrNull(s.roomId), streamer: strOrNull(s.streamer), title: strOrNull(s.title),
    quality: strOrNull(s.quality), quality_label: strOrNull(s.qualityLabel),
    started_at: strOrNull(s.startedAt), ended_at: strOrNull(s.endedAt),
    duration_sec: num(s.durationSec), bytes: num(s.bytes), status: strOrNull(s.status),
    dir: strOrNull(s.dir), rel_dir: strOrNull(s.relDir), naming_profile_id: strOrNull(s.namingProfileId),
    snap_anchor_name: strOrNull(s.taskSnapshot?.anchorName), snap_room_id: strOrNull(s.taskSnapshot?.roomId),
    merged_file_id: strOrNull(s.merged?.id), mp4_file_id: strOrNull(s.mp4?.id),
    created_at: strOrNull(s.startedAt), updated_at: nowIso(),
  };
}

function rowToSession(r, files) {
  const segs = files.filter((f) => f.kind === 'segment').sort((a, b) => (a.segmentIndex || 0) - (b.segmentIndex || 0));
  const extras = files.filter((f) => f.kind === 'merged' || f.kind === 'mp4' || f.kind === 'm4a');
  const byId = new Map(files.map((f) => [f.id, f]));
  return {
    id: r.id, taskId: r.task_id, platform: r.platform, platformName: r.platform_name,
    roomId: r.room_id, streamer: r.streamer, title: r.title,
    quality: r.quality, qualityLabel: r.quality_label,
    startedAt: r.started_at, endedAt: r.ended_at,
    durationSec: r.duration_sec || 0, bytes: r.bytes || 0, status: r.status,
    dir: r.dir, relDir: r.rel_dir, namingProfileId: r.naming_profile_id,
    taskSnapshot: { anchorName: r.snap_anchor_name || '', roomId: r.snap_room_id || '' },
    segments: segs, extras,
    merged: r.merged_file_id ? (byId.get(r.merged_file_id) || null) : null,
    mp4: r.mp4_file_id ? (byId.get(r.mp4_file_id) || null) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 外部文件：内存用 'unregistered'（扫描发现）/'segment'（手工导入），库里统一落 'external' 视图规则 */
const extKindToDb = (k) => (k === 'unregistered' ? 'external' : (k || 'external'));
const extKindFromDb = (k) => (k === 'external' ? 'unregistered' : k);

function settingsFromRow(r) {
  return {
    maxConcurrency: r.max_concurrency, defaultQuality: r.default_quality,
    qualityFallback: r.quality_fallback ? String(r.quality_fallback).split(',').map((x) => x.trim()).filter(Boolean) : [],
    defaultSegmentMode: r.default_segment_mode, defaultSegmentMinutes: r.default_segment_minutes,
    defaultSegmentSizeMB: r.default_segment_size_mb, recordContainer: r.record_container,
    remuxToMp4: !!r.remux_to_mp4, keepSource: !!r.keep_source, autoMerge: !!r.auto_merge, mergeOnStop: !!r.merge_on_stop,
    deleteAfterMerge: r.delete_after_merge == null ? true : !!r.delete_after_merge,
    reconnectMax: r.reconnect_max, pollIntervalSec: r.poll_interval_sec,
    startDelaySec: r.start_delay_sec, stopDelaySec: r.stop_delay_sec,
    diskLimitGB: r.disk_limit_gb, retentionDays: r.retention_days,
    deleteToTrash: !!r.delete_to_trash, trashRetentionDays: r.trash_retention_days,
    logRetentionDays: r.log_retention_days, logLevel: r.log_level,
    playConcurrency: r.play_concurrency, proxy: r.proxy || '', userAgent: r.user_agent || '',
    defaultMonitorOnly: !!r.default_monitor_only,
  };
}

const parseMaybeJson = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!s) return s;
  try { return JSON.parse(s); } catch { return s; }
};

export class Store {
  constructor(configDir) {
    this.configDir = configDir;
    this.logger = null; // server.js 在 logger 就绪后注入：持久层错误（落盘失败/冲突行）进日志文件
    this.state = {
      version: 2,
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      naming: JSON.parse(JSON.stringify(DEFAULT_NAMING)),
      tasks: [],
      sessions: [],
      trash: [],
      external: [],
      meta: { createdAt: nowIso() },
    };
    this.db = null;
    this._stmts = {};
    this._idx = null; // 按 id 的只读索引（files/tasks/sessions），任何写操作后置空重建
  }

  // ---------- 只读索引 ----------
  /** 按 id 建索引：findFile/sessionOfFile/getTask/getSession 从 O(全库扫描) 降到 O(1)。
   *  这些方法在视频 Range 请求、缩略图、回放等热路径上每请求都会调用，全库线性扫描会随文件数线性变慢。 */
  _index() {
    if (this._idx) return this._idx;
    const files = new Map();
    for (const s of this.state.sessions) {
      for (const f of sessionFiles(s)) if (!files.has(f.id)) files.set(f.id, { file: f, session: s });
    }
    for (const f of this.state.external) {
      if (f && f.id && !files.has(f.id)) files.set(f.id, { file: f, session: null });
    }
    this._idx = {
      files,
      tasks: new Map(this.state.tasks.map((t) => [t.id, t])),
      sessions: new Map(this.state.sessions.map((s) => [s.id, s])),
    };
    return this._idx;
  }

  /** 内存模型发生任何增删改后调用：下次读取时重建索引 */
  _invalidateIndex() { this._idx = null; }

  get settings() { return this.state.settings; }
  get naming() { return this.state.naming; }
  get tasks() { return this.state.tasks; }
  get sessions() { return this.state.sessions; }
  get trash() { return this.state.trash; }
  get external() { return this.state.external; }

  // ---------- 初始化 / 加载 ----------
  /** 注入 SQLite 实例并加载内存模型；之后所有读写都以此为准 */
  async init(db) {
    if (!db) throw new Error('store: 缺少 SQLite 连接（init(db) 的 db 不能为空）'); // 缺失连接不再静默吞掉
    await ensureDir(this.configDir);
    this.db = db;
    this._stmts = {}; // 换连接时清掉旧语句缓存
    this.loadFromDb(db);
    this._convergeResidue();
    await this.persist(); // 把默认命名等归一化结果落库
    return this;
  }

  /** 从 SQLite 读全量进内存（无迁移、无 JSON） */
  loadFromDb(db) {
    this.db = db;
    const state = this.state;

    // ---- 设置 ----
    const srow = db.prepare('SELECT * FROM settings WHERE id = 1').get();
    if (srow) Object.assign(state.settings, settingsFromRow(srow));
    // 平台字典以库为准：先清默认值再合并，避免库里已删的键在重启后「复活」
    state.settings.platformCaps = {};
    state.settings.platformEnabled = {};
    state.settings.platformUseProxy = {};
    for (const r of db.prepare('SELECT platform, value FROM platform_caps').all()) state.settings.platformCaps[r.platform] = r.value;
    for (const r of db.prepare('SELECT platform, value FROM platform_enabled').all()) state.settings.platformEnabled[r.platform] = !!r.value;
    for (const r of db.prepare('SELECT platform, value FROM platform_proxy').all()) state.settings.platformUseProxy[r.platform] = !!r.value;
    const nrow = db.prepare('SELECT * FROM notify WHERE id = 1').get();
    if (nrow) {
      Object.assign(state.settings.notify, {
        webhook: nrow.webhook || '', onStart: !!nrow.on_start, onEnd: !!nrow.on_end,
        onLive: nrow.on_live == null ? true : !!nrow.on_live, onError: !!nrow.on_error,
        onDisk: !!nrow.on_disk, onCookie: !!nrow.on_cookie, dedupeSec: nrow.dedupe_sec, dedupe: nrow.dedupe == null ? true : !!nrow.dedupe, retry: !!nrow.retry,
      });
    }
    const secrow = db.prepare('SELECT * FROM security WHERE id = 1').get();
    if (secrow) {
      Object.assign(state.settings.security, {
        sessionDays: secrow.session_days, failLimit: secrow.fail_limit,
        failLockMin: secrow.fail_lock_min, trustLan: !!secrow.trust_lan,
      });
    }
    const cookies = {};
    for (const r of db.prepare('SELECT * FROM cookies').all()) {
      cookies[r.platform] = { value: r.value || '', ttwid: r.ttwid || '', updatedAt: r.updated_at || null, valid: !!r.value };
    }
    state.settings.cookies = cookies;
    const customize = {};
    for (const r of db.prepare('SELECT key, value FROM customize').all()) customize[r.key] = parseMaybeJson(r.value);
    state.settings.customize = customize;

    // ---- 命名 ----
    const profs = db.prepare('SELECT * FROM naming_profiles').all();
    if (profs.length) {
      const arow = db.prepare('SELECT active_id FROM naming WHERE id = 1').get();
      state.naming = {
        activeId: (arow && arow.active_id) || 'p_default',
        profiles: profs.map((p) => ({
          id: p.id, name: p.name || '', fnTemplate: p.fn_template || '', dirTemplate: p.dir_template || '',
          options: {
            dateFormat: p.options_date_format || DEFAULT_OPTIONS.dateFormat,
            seqDigits: p.options_seq_digits || DEFAULT_OPTIONS.seqDigits,
            timeFormat: p.options_time_format || DEFAULT_OPTIONS.timeFormat,
            illegal: p.options_illegal || DEFAULT_OPTIONS.illegal,
            dupStrategy: p.options_dup_strategy || DEFAULT_OPTIONS.dupStrategy,
            maxNameChars: p.options_max_name_chars || DEFAULT_OPTIONS.maxNameChars,
          },
          binding: { type: p.binding_type || 'none', value: p.binding_value || '' },
        })),
      };
    }

    // ---- 任务 ----
    const overrideMap = new Map();
    for (const r of db.prepare('SELECT * FROM task_overrides').all()) {
      if (!overrideMap.has(r.task_id)) overrideMap.set(r.task_id, {});
      overrideMap.get(r.task_id)[r.key] = parseMaybeJson(r.value);
    }
    state.tasks = db.prepare('SELECT * FROM tasks').all()
      .map((r) => rowToTask(r, overrideMap.get(r.id) || {}));

    // ---- 场次 + 文件 ----
    const fileRows = db.prepare('SELECT * FROM files').all();
    const bySession = new Map();
    const external = [];
    for (const fr of fileRows) {
      const f = rowToFile(fr);
      if (fr.session_id) {
        if (!bySession.has(fr.session_id)) bySession.set(fr.session_id, []);
        bySession.get(fr.session_id).push(f);
      } else {
        f.sessionId = null;
        f.kind = extKindFromDb(f.kind);
        external.push(f);
      }
    }
    // 稳定载入顺序：按录制开始时间倒序（最新在前），与运行期 addSession 的 unshift 语义一致；
    // 避免「重启前后 store.sessions 顺序反转」导致文件库等依赖该顺序的地方出现乱序。
    state.sessions = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, id DESC').all()
      .map((r) => rowToSession(r, bySession.get(r.id) || []));
    state.external = external;

    // ---- 回收站 ----
    state.trash = this._loadTrash();
    return state;
  }

  _loadTrash() {
    const db = this.db;
    const out = [];
    for (const t of db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC').all()) {
      const items = db.prepare('SELECT * FROM trash_files WHERE trash_id = ?').all(t.id).map((r) => {
        const item = { origPath: r.path, trashPath: r.trash_path, name: r.name, bytes: r.bytes || 0, kind: r.kind || 'sidecar' };
        // 快照里的原文件 id 存在 file_id 列；rowToFile 读的是 id，这里补齐
        if (r.file_id) item.record = rowToFile({ ...r, id: r.file_id });
        return item;
      });
      const entry = {
        id: t.id, kind: t.kind, name: t.name, bytes: t.bytes || 0,
        deletedAt: t.deleted_at, expireAt: t.expire_at, items,
      };
      if (t.kind === 'session') {
        const ts = db.prepare('SELECT * FROM trash_sessions WHERE trash_id = ?').get(t.id);
        if (ts) {
          const recs = items.filter((i) => i.record).map((i) => ({ ...i.record, sessionId: ts.session_id }));
          const byId = new Map(recs.map((f) => [f.id, f]));
          entry.session = {
            id: ts.session_id, taskId: ts.task_id, platform: ts.platform, platformName: ts.platform_name,
            roomId: ts.room_id, streamer: ts.streamer, title: ts.title,
            quality: ts.quality, qualityLabel: ts.quality_label,
            startedAt: ts.started_at, endedAt: ts.ended_at, durationSec: ts.duration_sec || 0,
            bytes: t.bytes || 0, status: ts.status, dir: ts.dir, relDir: ts.rel_dir,
            namingProfileId: ts.naming_profile_id,
            taskSnapshot: { anchorName: ts.snap_anchor_name || '', roomId: ts.snap_room_id || '' },
            segments: recs.filter((f) => f.kind === 'segment').sort((a, b) => (a.segmentIndex || 0) - (b.segmentIndex || 0)),
            extras: recs.filter((f) => f.kind === 'merged' || f.kind === 'mp4' || f.kind === 'm4a'),
            merged: ts.merged_file_id ? (byId.get(ts.merged_file_id) || null) : null,
            mp4: ts.mp4_file_id ? (byId.get(ts.mp4_file_id) || null) : null,
          };
        }
      } else if (t.session_id) {
        entry.sessionId = t.session_id;
      }
      out.push(entry);
    }
    return out;
  }

  /** 服务重启后的残留状态归一：录制中的任务/场次不再继续 */
  _convergeResidue() {
    for (const t of this.state.tasks) {
      if (['recording', 'queued', 'stopping', 'merging', 'paused'].includes(t.status)) {
        t.status = 'stopped';
        t.statusMessage = '服务重启，录制已中断';
        t.updatedAt = nowIso();
      }
    }
    for (const s of this.state.sessions) {
      if (s.status === 'recording') { s.status = 'partial'; s.endedAt = s.endedAt || nowIso(); }
      for (const f of (s.segments || [])) if (f.status === 'recording') f.status = 'ok';
    }
  }

  // ---------- SQL 辅助 ----------
  _stmt(key) {
    if (this._stmts[key]) return this._stmts[key];
    const sql = SQL[key];
    if (!sql) throw new Error(`store: 未知 SQL 语句 ${key}`);
    this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  _tx(fn) {
    this.db.transaction(fn)();
  }

  /** 把内存全量落库（对账式：先清表再写入，单事务） */
  async persist() {
    if (!this.db) return;
    this._invalidateIndex(); // 全量对账前内存可能被就地改过（如扫描更新 status/bytes），索引必须重建
    try {
      this._tx(() => {
        this._writeSettings();
        this._writeNaming();
        this._stmt('tasks_delete_all').run();
        this._stmt('overrides_delete_all').run();
        for (const t of this.state.tasks) { this._stmt('task_upsert').run(taskToRow(t)); this._writeOverrides(t); }
        this._stmt('files_delete_all').run();
        this._stmt('sessions_delete_all').run();
        for (const s of this.state.sessions) this._writeSessionRows(s);
        this._writeExternalRows();
        this._stmt('trash_delete_all').run();
        for (const e of this.state.trash) this._writeTrashRows(e);
      });
    } catch (e) {
      // 落盘失败必须留痕：此前只 console.error 到 stdout，日志文件/「运行日志」页看不到，
      // 用户遇到「重启后数据回退」类问题时无从判断是否落盘失败
      const msg = `SQLite 落盘失败：${e.message}`;
      if (this.logger) this.logger.error(msg);
      else console.error(`[store] ${msg}`);
      throw e;
    }
  }

  // ---------- 各类行写入 ----------
  _writeOverrides(task) {
    this._stmt('overrides_delete').run(task.id);
    const ins = this._stmt('override_insert');
    for (const [k, v] of Object.entries(task.overrides || {})) {
      if (v === null || v === undefined || v === '') continue;
      ins.run(task.id, k, JSON.stringify(v));
    }
  }

  _writeTask(task) {
    this._tx(() => {
      this._stmt('task_upsert').run(taskToRow(task));
      this._writeOverrides(task);
    });
  }

  /** 写穿透失败时回滚内存：不做全量深拷贝，各变更点只快照最小实体（settings/tasks/sessions/trash 引用或浅拷贝、单字段 undo）。 */

  /** 单文件行写入：files.path 全局 UNIQUE，同一物理路径被登记为两个 id 时跳过该行并告警，避免拖垮整库事务 */
  _upsertFileRow(session, f, kindOverride) {
    try {
      this._stmt('file_upsert').run(fileToRow(session, f, kindOverride));
    } catch (e) {
      const msg = `跳过冲突文件行 ${f?.id || '?'}（path=${f?.path || '?'}）：${e?.message || e}`;
      if (this.logger) this.logger.warn(msg);
      else console.warn(`[store] ${msg}`);
    }
  }

  _writeSessionRows(session) {
    this._stmt('session_upsert').run(sessionToRow(session));
    this._stmt('files_delete_session').run(session.id);
    for (const f of sessionFiles(session)) this._upsertFileRow(session, f);
  }

  _writeSession(session) {
    this._tx(() => this._writeSessionRows(session));
  }

  _writeExternalRows() {
    const claimed = new Set();
    for (const s of this.state.sessions) for (const f of sessionFiles(s)) claimed.add(f.path);
    const seen = new Set();
    for (const f of this.state.external) {
      if (!f || !f.path || !f.id) continue;
      if (claimed.has(f.path) || seen.has(f.path)) continue;
      seen.add(f.path);
      this._upsertFileRow(null, f, extKindToDb(f.kind));
    }
  }

  /** 回收站相对路径（相对录制根目录） */
  _relOf(absPath) {
    const root = this.state.settings.recordRoot;
    if (!absPath) return null;
    if (!root) return path.basename(absPath);
    const rel = path.relative(root, absPath);
    return rel ? rel.split(path.sep).join('/') : path.basename(absPath);
  }

  _writeTrashRows(entry) {
    this._stmt('trash_upsert').run({
      id: entry.id, kind: entry.kind || 'file', name: strOrNull(entry.name), bytes: num(entry.bytes),
      deleted_at: strOrNull(entry.deletedAt), expire_at: strOrNull(entry.expireAt),
      session_id: strOrNull(entry.sessionId || entry.session?.id),
    });
    this._stmt('trash_files_delete').run(entry.id);
    this._stmt('trash_session_delete').run(entry.id);
    const insF = this._stmt('trash_file_insert');
    for (const it of entry.items || []) {
      const rec = it.record || null;
      insF.run({
        trash_id: entry.id,
        file_id: strOrNull(rec?.id), kind: strOrNull(rec?.kind || (it.kind === 'sidecar' ? 'sidecar' : it.kind)),
        name: strOrNull(it.name), path: strOrNull(it.origPath), trash_path: strOrNull(it.trashPath),
        rel_path: strOrNull(rec?.relPath || this._relOf(it.origPath)), ext: strOrNull(rec?.ext),
        bytes: num(it.bytes || rec?.bytes), duration_sec: num(rec?.durationSec), width: num(rec?.width), height: num(rec?.height),
        status: strOrNull(rec?.status), segment_index: num(rec?.segmentIndex), source_file_id: strOrNull(rec?.sourceFileId),
        thumbnail_path: strOrNull(rec?.thumbnailPath), scrape_path: strOrNull(rec?.scrapePath),
        created_at: strOrNull(rec?.createdAt), completed_at: strOrNull(rec?.completedAt),
      });
    }
    if (entry.kind === 'session' && entry.session) {
      const s = entry.session;
      this._stmt('trash_session_upsert').run({
        trash_id: entry.id, session_id: strOrNull(s.id), task_id: strOrNull(s.taskId),
        platform: strOrNull(s.platform), platform_name: strOrNull(s.platformName), room_id: strOrNull(s.roomId),
        streamer: strOrNull(s.streamer), title: strOrNull(s.title), quality: strOrNull(s.quality), quality_label: strOrNull(s.qualityLabel),
        started_at: strOrNull(s.startedAt), ended_at: strOrNull(s.endedAt), duration_sec: num(s.durationSec), status: strOrNull(s.status),
        dir: strOrNull(s.dir), rel_dir: strOrNull(s.relDir), naming_profile_id: strOrNull(s.namingProfileId),
        snap_anchor_name: strOrNull(s.taskSnapshot?.anchorName), snap_room_id: strOrNull(s.taskSnapshot?.roomId),
        merged_file_id: strOrNull(s.merged?.id), mp4_file_id: strOrNull(s.mp4?.id),
      });
    }
  }

  _writeSettings() {
    const s = this.state.settings;
    this._stmt('settings_upsert').run({
      max_concurrency: numOrNull(s.maxConcurrency), default_quality: strOrNull(s.defaultQuality),
      quality_fallback: Array.isArray(s.qualityFallback) ? s.qualityFallback.join(',') : strOrNull(s.qualityFallback),
      default_segment_mode: strOrNull(s.defaultSegmentMode), default_segment_minutes: numOrNull(s.defaultSegmentMinutes),
      default_segment_size_mb: numOrNull(s.defaultSegmentSizeMB), record_container: strOrNull(s.recordContainer),
      remux_to_mp4: boolish(s.remuxToMp4), keep_source: boolish(s.keepSource), auto_merge: boolish(s.autoMerge),
      merge_on_stop: boolish(s.mergeOnStop), delete_after_merge: boolish(s.deleteAfterMerge), reconnect_max: numOrNull(s.reconnectMax),
      poll_interval_sec: numOrNull(s.pollIntervalSec), start_delay_sec: numOrNull(s.startDelaySec),
      stop_delay_sec: numOrNull(s.stopDelaySec), disk_limit_gb: numOrNull(s.diskLimitGB),
      retention_days: numOrNull(s.retentionDays), delete_to_trash: boolish(s.deleteToTrash),
      trash_retention_days: numOrNull(s.trashRetentionDays), log_retention_days: numOrNull(s.logRetentionDays),
      log_level: strOrNull(s.logLevel), play_concurrency: numOrNull(s.playConcurrency),
      proxy: strOrNull(s.proxy || ''), user_agent: strOrNull(s.userAgent || ''),
      default_monitor_only: boolish(s.defaultMonitorOnly),
    });
    this._stmt('platform_caps_delete_all').run();
    const capIns = this._stmt('platform_caps_insert');
    for (const [p, v] of Object.entries(s.platformCaps || {})) capIns.run(p, Number(v) || 0);
    this._stmt('platform_enabled_delete_all').run();
    const enIns = this._stmt('platform_enabled_insert');
    for (const [p, v] of Object.entries(s.platformEnabled || {})) enIns.run(p, v ? 1 : 0);
    this._stmt('platform_proxy_delete_all').run();
    const pxIns = this._stmt('platform_proxy_insert');
    for (const [p, v] of Object.entries(s.platformUseProxy || {})) pxIns.run(p, v ? 1 : 0);
    const n = s.notify || {};
    this._stmt('notify_upsert').run({
      webhook: strOrNull(n.webhook || ''), on_start: boolish(n.onStart), on_end: boolish(n.onEnd),
      on_live: boolish(n.onLive), on_error: boolish(n.onError), on_disk: boolish(n.onDisk), on_cookie: boolish(n.onCookie),
      dedupe_sec: numOrNull(n.dedupeSec), dedupe: boolish(n.dedupe !== false), retry: numOrNull(n.retry),
    });
    const sec = s.security || {};
    this._stmt('security_upsert').run({
      session_days: numOrNull(sec.sessionDays), fail_limit: numOrNull(sec.failLimit),
      fail_lock_min: numOrNull(sec.failLockMin), trust_lan: boolish(sec.trustLan),
    });
    this._stmt('cookies_delete_all').run();
    const ckIns = this._stmt('cookie_upsert');
    for (const [p, c] of Object.entries(s.cookies || {})) {
      ckIns.run({ platform: p, value: strOrNull(c?.value || ''), ttwid: strOrNull(c?.ttwid || ''), updated_at: strOrNull(c?.updatedAt) });
    }
    this._stmt('customize_delete_all').run();
    const czIns = this._stmt('customize_upsert');
    for (const [k, v] of Object.entries(s.customize || {})) czIns.run(k, JSON.stringify(v ?? null));
  }

  _writeNaming() {
    const n = this.state.naming || DEFAULT_NAMING;
    this._stmt('naming_upsert').run({ active_id: strOrNull(n.activeId) });
    this._stmt('naming_profiles_delete_all').run();
    const ins = this._stmt('naming_profile_upsert');
    for (const p of n.profiles || []) {
      const o = p.options || {};
      ins.run({
        id: p.id, name: strOrNull(p.name), fn_template: strOrNull(p.fnTemplate), dir_template: strOrNull(p.dirTemplate),
        options_date_format: strOrNull(o.dateFormat ?? DEFAULT_OPTIONS.dateFormat),
        options_seq_digits: numOrNull(o.seqDigits ?? DEFAULT_OPTIONS.seqDigits),
        options_time_format: strOrNull(o.timeFormat ?? DEFAULT_OPTIONS.timeFormat),
        options_illegal: strOrNull(o.illegal ?? DEFAULT_OPTIONS.illegal),
        options_dup_strategy: strOrNull(o.dupStrategy ?? DEFAULT_OPTIONS.dupStrategy),
        options_max_name_chars: numOrNull(o.maxNameChars ?? DEFAULT_OPTIONS.maxNameChars),
        binding_type: strOrNull(p.binding?.type || 'none'), binding_value: strOrNull(p.binding?.value || ''),
      });
    }
    // 变量字典：仅在空表时补种（保持与前端 VARIABLES 一致）
    const cnt = this.db.prepare('SELECT COUNT(*) c FROM naming_variables').get().c;
    if (cnt === 0) {
      const vIns = this._stmt('naming_variable_insert');
      for (const v of VARIABLES || []) vIns.run(v.token, v.desc || '', v.example || '');
    }
  }

  // ---------- 设置 / 命名 / Cookie ----------
  async updateSettings(patch) {
    // 脱敏占位符绝不能覆盖真实更新 token：settingsView 返回的是 '••••••••'，
    // 设置页整包保存时会带回该占位；这里兜底剥离（路由层也删了 customize，双保险）。
    if (patch && patch.customize && patch.customize.updateToken === '••••••••') {
      patch = { ...patch, customize: { ...patch.customize } };
      delete patch.customize.updateToken;
    }
    const snap = this.state.settings; // deepMerge 整体替换 → 引用快照即可
    try {
      this.state.settings = deepMerge(this.state.settings, patch || {});
      if (this.db) this._tx(() => this._writeSettings());
      return this.state.settings;
    } catch (e) { this.state.settings = snap; throw e; }
  }

  async setNaming(naming) {
    const snap = this.state.naming;
    try {
      this.state.naming = deepMerge(this.state.naming, naming || {});
      if (this.db) this._tx(() => this._writeNaming());
      return this.state.naming;
    } catch (e) { this.state.naming = snap; throw e; }
  }

  /** 写入平台 Cookie（明文），并从 Cookie 串中提取 ttwid 单独存列 */
  async setCookie(platform, value) {
    const snapCookies = { ...this.state.settings.cookies }; // 只快照 cookies 字典（值对象不被就地修改）
    try {
      const v = String(value || '');
      const m = v.match(/ttwid=([^;,\s]+)/);
      this.state.settings.cookies = {
        ...snapCookies,
        [platform]: {
          value: v.toLowerCase() === 'clear' ? '' : v,
          ttwid: m ? m[1] : '',
          updatedAt: nowIso(),
          valid: v.toLowerCase() !== 'clear' && !!v,
        },
      };
      if (this.db) this._tx(() => this._writeSettings());
      return this.state.settings.cookies[platform];
    } catch (e) { this.state.settings.cookies = snapCookies; throw e; }
  }

  async clearCookie(platform) {
    const snapCookies = { ...this.state.settings.cookies };
    try {
      const next = { ...snapCookies };
      delete next[platform];
      this.state.settings.cookies = next;
      if (this.db) this._tx(() => this._writeSettings());
    } catch (e) { this.state.settings.cookies = snapCookies; throw e; }
  }

  // ---------- tasks ----------
  getTask(id) { return this._index().tasks.get(id) || null; }

  /** 自定义排序：按传入的 id 顺序重排任务数组（保持引用），未列出的任务按原序追加 */
  reorderTasks(ids) {
    const snap = this.state.tasks; // ordered 是新建数组 → 引用快照即可
    try {
      this._invalidateIndex();
      const list = this.state.tasks;
      const byId = new Map(list.map((t) => [t.id, t]));
      const seen = new Set();
      const ordered = [];
      for (const id of (ids || [])) {
        const t = byId.get(id);
        if (t && !seen.has(id)) { ordered.push(t); seen.add(id); }
      }
      for (const t of list) if (!seen.has(t.id)) ordered.push(t);
      this.state.tasks = ordered;
      if (this.db) this._tx(() => { this._stmt('tasks_delete_all').run(); this._stmt('overrides_delete_all').run(); for (const t of ordered) { this._stmt('task_upsert').run(taskToRow(t)); this._writeOverrides(t); } });
    } catch (e) { this.state.tasks = snap; throw e; }
  }

  taskByRoom(platform, roomId) {
    return this.state.tasks.find((t) => t.platform === platform && String(t.roomId) === String(roomId)
      && !['stopped', 'completed', 'error'].includes(t.status)) || null;
  }

  async addTask(task) {
    const snap = this.state.tasks.slice(); // unshift 就地改数组 → 浅拷贝数组即可
    try {
      this._invalidateIndex();
      this.state.tasks.unshift(task);
      if (this.db) this._writeTask(task);
      return task;
    } catch (e) { this.state.tasks = snap; throw e; }
  }

  async saveTask(task) {
    const snap = this.state.tasks.slice();
    try {
      this._invalidateIndex();
      task.updatedAt = nowIso();
      const i = this.state.tasks.findIndex((t) => t.id === task.id);
      if (i >= 0) this.state.tasks[i] = task; else this.state.tasks.unshift(task);
      if (this.db) this._writeTask(task);
      return task;
    } catch (e) { this.state.tasks = snap; throw e; }
  }

  async removeTask(id) {
    const snap = this.state.tasks.slice();
    try {
      this._invalidateIndex();
      const i = this.state.tasks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      this.state.tasks.splice(i, 1);
      if (this.db) this._tx(() => { this._stmt('task_delete').run(id); this._stmt('overrides_delete').run(id); });
      return true;
    } catch (e) { this.state.tasks = snap; throw e; }
  }

  // ---------- sessions / files ----------
  getSession(id) { return this._index().sessions.get(id) || null; }

  async addSession(session) {
    const snap = this.state.sessions.slice();
    try {
      this._invalidateIndex();
      this.state.sessions.unshift(session);
      if (this.db) this._writeSession(session);
      return session;
    } catch (e) { this.state.sessions = snap; throw e; }
  }

  async saveSession(session) {
    const snap = this.state.sessions.slice();
    try {
      this._invalidateIndex();
      const i = this.state.sessions.findIndex((s) => s.id === session.id);
      if (i >= 0) this.state.sessions[i] = session; else this.state.sessions.unshift(session);
      if (this.db) this._writeSession(session);
      return session;
    } catch (e) { this.state.sessions = snap; throw e; }
  }

  async removeSession(id) {
    const snap = this.state.sessions.slice();
    try {
      this._invalidateIndex();
      const i = this.state.sessions.findIndex((s) => s.id === id);
      if (i < 0) return false;
      this.state.sessions.splice(i, 1);
      if (this.db) this._tx(() => { this._stmt('session_delete').run(id); this._stmt('files_delete_session').run(id); });
      return true;
    } catch (e) { this.state.sessions = snap; throw e; }
  }

  /** 线性兜底：索引在建好之后又有分段被 push 进数组（saveSession 之前）时，按旧实现逐条查 */
  _sessionOfFileLinear(fileId) {
    for (const s of this.state.sessions) {
      if ((s.segments || []).some((f) => f.id === fileId)) return s;
      if ((s.extras || []).some((f) => f.id === fileId)) return s;
      if (s.merged && s.merged.id === fileId) return s;
      if (s.mp4 && s.mp4.id === fileId) return s;
    }
    return null;
  }

  sessionOfFile(fileId) {
    const hit = this._index().files.get(fileId);
    if (hit) return hit.session;
    return this._sessionOfFileLinear(fileId);
  }

  findFile(fileId) {
    const hit = this._index().files.get(fileId);
    if (hit) return hit;
    const s = this._sessionOfFileLinear(fileId);
    if (!s) return null;
    const all = [...(s.segments || []), ...(s.extras || []), s.merged, s.mp4];
    const file = all.find((f) => f && f.id === fileId) || null;
    return file ? { file, session: s } : null;
  }

  allFiles() {
    const out = [];
    for (const s of this.state.sessions) {
      out.push(...(s.segments || []), ...(s.extras || []));
      if (s.merged) out.push(s.merged);
      if (s.mp4) out.push(s.mp4);
    }
    out.push(...this.state.external);
    return out;
  }

  /**
   * 首帧海报落盘后回写 files.thumbnail_path（按物理路径匹配）。
   * 值已一致则不写库（该接口在缩略图热路径上）；未登记的文件直接忽略。返回是否命中。
   */
  async setFileThumbnailByPath(filePath, thumbPath) {
    const rel = thumbPath ? this._relOf(thumbPath) : null;
    // 快速路径：值已一致直接返回，不做快照（该接口在缩略图热路径上）
    for (const s of this.state.sessions) {
      for (const f of sessionFiles(s)) {
        if (f.path !== filePath) continue;
        if (f.thumbnailPath === rel) return true;
        const prev = f.thumbnailPath; // 单字段 undo，零拷贝
        try {
          f.thumbnailPath = rel;
          if (this.db) this._writeSession(s);
          return true;
        } catch (e) { f.thumbnailPath = prev; throw e; }
      }
    }
    for (const f of this.state.external) {
      if (f.path !== filePath) continue;
      if (f.thumbnailPath === rel) return true;
      const prev = f.thumbnailPath;
      try {
        f.thumbnailPath = rel;
        if (this.db) this._upsertFileRow(null, f, extKindToDb(f.kind));
        return true;
      } catch (e) { f.thumbnailPath = prev; throw e; }
    }
    return false;
  }

  // ---------- 回收站 ----------
  async addTrash(entry) {
    const snap = this.state.trash.slice();
    try {
      this.state.trash.unshift(entry);
      if (this.db) this._tx(() => this._writeTrashRows(entry));
      return entry;
    } catch (e) { this.state.trash = snap; throw e; }
  }

  async removeTrash(ids) {
    const snap = this.state.trash; // filter 生成新数组 → 引用快照即可
    try {
      this.state.trash = this.state.trash.filter((t) => !ids.includes(t.id));
      if (this.db) this._tx(() => { for (const id of ids) this._stmt('trash_delete').run(id); });
    } catch (e) { this.state.trash = snap; throw e; }
  }

  /** 新增任务的内存默认形状（不含 avatar URL / segments / qualityFallback 等已废弃字段） */
  static newTask(patch = {}) {
    const now = nowIso();
    return {
      id: uid('t'), platform: 'douyin', roomId: '', shortId: '', sourceUrl: '',
      anchorName: '', platformAnchorName: '', title: '', avatarFile: null,
      quality: 'origin', qualityActual: null, qualityLabel: null,
      segmentMode: 'time', segmentMinutes: 3600, segmentSizeMB: 2048,
      container: 'ts', remuxToMp4: true, keepSource: true, autoMerge: false,
      namingProfileId: null, customText: '', overrides: {},
      autoRecord: true, monitorOnly: false, manualHeld: false, pollIntervalSec: 60, startDelaySec: 5, stopDelaySec: 30,
      status: 'idle', statusMessage: '未开播', queueReason: null, lastError: null,
      retryCount: 0, reconnectCount: 0,
      startedAt: null, endedAt: null, totalBytes: 0, totalDurationSec: 0,
      segmentIndex: 0, currentFile: null, sessionId: null,
      createdAt: now, updatedAt: now,
      ...patch,
    };
  }

  /** 关闭底层连接并清空语句缓存（进程退出前调用，收敛 -wal/-shm） */
  close() {
    this._stmts = {};
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }
}
