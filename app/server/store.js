// JSON 持久化：单一 state.json + 串行化写入（并发写不丢数据）
import path from 'node:path';
import { readJson, writeJsonAtomic, ensureDir, uid, nowIso } from './util.js';
import { DEFAULT_NAMING } from './naming.js';

export const DEFAULT_SETTINGS = {
  recordRoot: process.env.RECORD_ROOT || '/data',
  configDir: process.env.CONFIG_DIR || '/config',
  maxConcurrency: 8,
  defaultQuality: 'origin',
  qualityFallback: ['origin', 'bluray', 'uhd', 'hd', 'sd'],
  defaultSegmentMode: 'time',
  defaultSegmentMinutes: 60,
  defaultSegmentSizeMB: 2048,
  recordContainer: 'ts',
  remuxToMp4: true,
  keepSource: true,
  autoMerge: false,
  mergeOnStop: false,
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
  platformCaps: {
    douyin: 4, bilibili: 4, kuaishou: 3, huya: 3, douyu: 3,
    xiaohongshu: 2, weibo: 2, acfun: 2, direct: 8,
  },
  platformEnabled: {
    douyin: true, bilibili: true, kuaishou: true, huya: true, douyu: true,
    xiaohongshu: true, weibo: true, direct: true, acfun: false,
  },
  notify: { webhook: '', onStart: true, onEnd: true, onError: true, onDisk: true, onCookie: false, dedupeSec: 60, retry: true },
  security: { sessionDays: 30, failLimit: 5, failLockMin: 10, trustLan: false },
  cookies: {},
  customize: {},
};

function deepMerge(base, patch) {
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

export class Store {
  constructor(configDir) {
    this.configDir = configDir;
    this.file = path.join(configDir, 'state.json');
    this.state = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
      naming: JSON.parse(JSON.stringify(DEFAULT_NAMING)),
      tasks: [],
      sessions: [],
      trash: [],
      external: [],
      meta: { createdAt: nowIso() },
    };
    this._chain = Promise.resolve();
    this._dirty = false;
  }

  async init() {
    await ensureDir(this.configDir);
    const loaded = await readJson(this.file, null);
    if (loaded && typeof loaded === 'object') {
      this.state = {
        ...this.state,
        ...loaded,
        settings: deepMerge(DEFAULT_SETTINGS, loaded.settings || {}),
        naming: deepMerge(JSON.parse(JSON.stringify(DEFAULT_NAMING)), loaded.naming || {}),
        tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
        sessions: Array.isArray(loaded.sessions) ? loaded.sessions : [],
        trash: Array.isArray(loaded.trash) ? loaded.trash : [],
        external: Array.isArray(loaded.external) ? loaded.external : [],
      };
    }
    // 启动时把"录制中"的残留状态收敛为"已停止"（上次进程未优雅退出）
    for (const t of this.state.tasks) {
      if (['recording', 'queued', 'stopping', 'merging'].includes(t.status)) {
        t.status = 'stopped';
        t.statusMessage = '服务重启，录制已中断';
        t.updatedAt = nowIso();
      }
    }
    for (const s of this.state.sessions) {
      if (s.status === 'recording') { s.status = 'partial'; s.endedAt = s.endedAt || nowIso(); }
      for (const f of s.segments || []) if (f.status === 'recording') f.status = 'ok';
    }
    await this.persist();
    return this;
  }

  get settings() { return this.state.settings; }
  get naming() { return this.state.naming; }
  get tasks() { return this.state.tasks; }
  get sessions() { return this.state.sessions; }
  get trash() { return this.state.trash; }
  get external() { return this.state.external; }

  /** 串行化落盘；返回 promise，调用方可 await 保证已写 */
  persist() {
    this._dirty = true;
    const snapshot = JSON.stringify(this.state);
    this._chain = this._chain
      .then(() => writeJsonAtomic(this.file, JSON.parse(snapshot)))
      .then(() => { this._dirty = false; })
      .catch((e) => console.error('[store] 落盘失败', e));
    return this._chain;
  }

  updateSettings(patch) {
    this.state.settings = deepMerge(this.state.settings, patch || {});
    return this.persist().then(() => this.state.settings);
  }

  setNaming(naming) {
    this.state.naming = deepMerge(this.state.naming, naming || {});
    return this.persist().then(() => this.state.naming);
  }

  /** 平台 Cookie：整条替换（deepMerge 无法删除键，所以这里直接改 state） */
  async setCookie(platform, value) {
    this.state.settings.cookies = {
      ...(this.state.settings.cookies || {}),
      [platform]: { value: String(value || ''), updatedAt: nowIso(), valid: !!value },
    };
    await this.persist();
    return this.state.settings.cookies[platform];
  }
  async clearCookie(platform) {
    const next = { ...(this.state.settings.cookies || {}) };
    delete next[platform];
    this.state.settings.cookies = next;
    await this.persist();
    return true;
  }

  // ---------- tasks ----------
  getTask(id) { return this.state.tasks.find((t) => t.id === id) || null; }

  /** 自定义排序：按传入的 id 顺序重排任务数组（保持引用），未列出的任务按原序追加 */
  reorderTasks(ids) {
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
  }
  taskByRoom(platform, roomId) {
    return this.state.tasks.find((t) => t.platform === platform && String(t.roomId) === String(roomId)
      && !['stopped', 'completed', 'error'].includes(t.status)) || null;
  }
  async addTask(task) {
    this.state.tasks.unshift(task);
    await this.persist();
    return task;
  }
  async saveTask(task) {
    task.updatedAt = nowIso();
    const i = this.state.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.state.tasks[i] = task; else this.state.tasks.unshift(task);
    await this.persist();
    return task;
  }
  async removeTask(id) {
    const i = this.state.tasks.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.state.tasks.splice(i, 1);
    await this.persist();
    return true;
  }

  // ---------- sessions / files ----------
  getSession(id) { return this.state.sessions.find((s) => s.id === id) || null; }
  async addSession(session) {
    this.state.sessions.unshift(session);
    await this.persist();
    return session;
  }
  async saveSession(session) {
    const i = this.state.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) this.state.sessions[i] = session; else this.state.sessions.unshift(session);
    await this.persist();
    return session;
  }
  async removeSession(id) {
    const i = this.state.sessions.findIndex((s) => s.id === id);
    if (i < 0) return false;
    this.state.sessions.splice(i, 1);
    await this.persist();
    return true;
  }
  sessionOfFile(fileId) {
    for (const s of this.state.sessions) {
      if ((s.segments || []).some((f) => f.id === fileId)) return s;
      if ((s.extras || []).some((f) => f.id === fileId)) return s;
      if (s.merged && s.merged.id === fileId) return s;
      if (s.mp4 && s.mp4.id === fileId) return s;
    }
    return null;
  }
  findFile(fileId) {
    const s = this.sessionOfFile(fileId);
    if (!s) {
      const ext = this.state.external.find((f) => f.id === fileId);
      return ext ? { file: ext, session: null } : null;
    }
    const all = [...(s.segments || []), ...(s.extras || [])];
    if (s.merged) all.push(s.merged);
    if (s.mp4) all.push(s.mp4);
    return { file: all.find((f) => f.id === fileId), session: s };
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
  fileByPath(p) { return this.allFiles().find((f) => f.path === p) || null; }

  async addTrash(entry) {
    this.state.trash.unshift(entry);
    await this.persist();
    return entry;
  }
  async removeTrash(ids) {
    this.state.trash = this.state.trash.filter((t) => !ids.includes(t.id));
    await this.persist();
  }

  static newTask(patch = {}) {
    const now = nowIso();
    return {
      id: uid('t'), platform: 'douyin', roomId: '', shortId: '', sourceUrl: '', anchorName: '', title: '', avatar: '',
      quality: 'origin', qualityActual: null, qualityLabel: null,
      segmentMode: 'time', segmentMinutes: 60, segmentSizeMB: 2048,
      container: 'ts', remuxToMp4: true, keepSource: true, autoMerge: false,
      namingProfileId: null, customText: '',
      autoRecord: true, monitorOnly: false, manualHeld: false, pollIntervalSec: 60, startDelaySec: 5, stopDelaySec: 30,
      status: 'idle', statusMessage: '未开播', queueReason: null, lastError: null,
      retryCount: 0, reconnectCount: 0,
      startedAt: null, endedAt: null, totalBytes: 0, totalDurationSec: 0,
      segmentIndex: 0, currentFile: null, segments: [], sessionId: null,
      createdAt: now, updatedAt: now,
      ...patch,
    };
  }
}

export { deepMerge };
