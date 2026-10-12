// 日志：按天滚动 + 单文件切分 + 保留天数 + 环形缓冲 + SSE 订阅
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, dateKey, nowIso } from './util.js';

const LEVEL_ORDER = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const RING = 2000;

export class Logger {
  constructor({ dir, level = 'INFO', retentionDays = 14 }) {
    this.dir = dir;
    this.level = LEVEL_ORDER[level] ? level : 'INFO';
    this.retentionDays = retentionDays;
    this.ring = [];
    this.subs = new Set();
    this._chain = Promise.resolve();
    this._day = null;
    this._size = 0;
    this._part = 0;
  }

  async init() {
    await ensureDir(this.dir);
    await this._loadToday();
    await this.purge();
    return this;
  }

  setLevel(level) { if (LEVEL_ORDER[level]) this.level = level; }
  setRetention(days) { this.retentionDays = Number(days) || 14; }

  currentFile() {
    const day = dateKey();
    if (this._day !== day) { this._day = day; this._part = 0; this._size = 0; }
    const base = path.join(this.dir, `${day}.log`);
    return this._part ? path.join(this.dir, `${day}.${this._part}.log`) : base;
  }

  async _loadToday() {
    const file = this.currentFile();
    const txt = await fsp.readFile(file, 'utf8').catch(() => '');
    if (!txt) return;
    const lines = txt.split('\n').filter(Boolean).slice(-RING);
    for (const l of lines) {
      try { this.ring.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
    }
    this._size = Buffer.byteLength(txt);
  }

  async purge() {
    const keep = Math.max(1, Number(this.retentionDays) || 14);
    const cutoff = Date.now() - keep * 86400_000;
    const files = await fsp.readdir(this.dir).catch(() => []);
    for (const f of files) {
      if (!/\.log$/.test(f)) continue;
      const p = path.join(this.dir, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fsp.rm(p, { force: true }).catch(() => {});
    }
  }

  /** 按日期范围清除日志文件（from/to 形如 YYYY-MM-DD，可只给其一，闭区间按天）并清空环形缓冲 */
  async clear({ from, to } = {}) {
    let removed = 0;
    const files = await fsp.readdir(this.dir).catch(() => []);
    for (const f of files) {
      if (!/\.log$/.test(f)) continue;
      const day = f.split('.')[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (from && day < from) continue;
      if (to && day > to) continue;
      await fsp.rm(path.join(this.dir, f), { force: true }).catch(() => {});
      removed++;
    }
    this.ring = [];
    this._day = null;
    this._size = 0;
    this._part = 0;
    this._pageRows = null;
    return { removed };
  }

  log(level, msg, meta = {}) {
    const lv = LEVEL_ORDER[level] ? level : 'INFO';
    if (LEVEL_ORDER[lv] < LEVEL_ORDER[this.level]) return;
    const line = {
      ts: nowIso(),
      level: lv,
      taskId: meta.taskId || null,
      taskName: meta.taskName || null,
      msg: String(msg),
    };
    this.ring.push(line);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    this._pageRows = null; // 有新日志：使分页查询缓存失效
    this._write(line);
    this.emit(line);
  }

  _write(line) {
    const json = `${JSON.stringify(line)}\n`;
    this._chain = this._chain.then(async () => {
      const file = this.currentFile();
      if (this._size + Buffer.byteLength(json) > MAX_FILE_BYTES) {
        this._part += 1;
        this._size = 0;
      }
      const target = this.currentFile();
      await fsp.appendFile(target, json, 'utf8');
      this._size += Buffer.byteLength(json);
      void file;
    }).catch((e) => console.error('[logger] 写入失败', e));
  }

  debug(m, meta) { this.log('DEBUG', m, meta); }
  info(m, meta) { this.log('INFO', m, meta); }
  warn(m, meta) { this.log('WARN', m, meta); }
  error(m, meta) { this.log('ERROR', m, meta); }

  emit(line) {
    for (const fn of this.subs) {
      try { fn(line); } catch { /* 订阅者异常不影响主流程 */ }
    }
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }

  query({ level, taskId, q, limit = 200 } = {}) {
    let items = this.ring;
    if (level && LEVEL_ORDER[level]) items = items.filter((l) => l.level === level);
    if (taskId) items = items.filter((l) => l.taskId === taskId);
    if (q) {
      const s = String(q).toLowerCase();
      items = items.filter((l) => l.msg.toLowerCase().includes(s) || String(l.taskName || '').toLowerCase().includes(s));
    }
    return items.slice(-Math.max(1, Math.min(2000, Number(limit) || 200)));
  }

  /**
   * 分页查询（历史全量，来自日志文件）：读保留期内全部 .log 文件 → 过滤 → 按 ts 倒序 → 分页。
   * 过滤结果按 (level|taskId|q) 缓存，翻页/换页不重复读文件；有新日志（log/clear）自动失效。
   * 返回 { items, total, page, pageSize, pages, tasks }，tasks 为匹配集合内的任务名清单（供前端筛选下拉）。
   */
  async queryPage({ level, taskId, q, page = 1, pageSize = 50, order = 'desc' } = {}) {
    const size = Math.max(1, Math.min(20000, Number(pageSize) || 50));
    const p = Math.max(1, Number(page) || 1);
    const key = `${level || ''}|${taskId || ''}|${String(q || '').toLowerCase()}`;
    if (!this._pageRows || this._pageRows.key !== key) {
      this._pageRows = { key, ...(await this._readAllFiltered({ level, taskId, q })) };
    }
    const { rows, tasks } = this._pageRows;
    const total = rows.length;
    const ordered = order === 'asc' ? rows.slice().reverse() : rows; // 正向（旧→新）时整体反转
    const start = (p - 1) * size;
    return {
      items: ordered.slice(start, start + size),
      total,
      page: p,
      pageSize: size,
      pages: Math.max(1, Math.ceil(total / size)),
      tasks,
    };
  }

  async _readAllFiltered({ level, taskId, q }) {
    const files = await fsp.readdir(this.dir).catch(() => []);
    const rows = [];
    const tasks = new Map();
    for (const f of files) {
      if (!/\.log$/.test(f)) continue;
      const txt = await fsp.readFile(path.join(this.dir, f), 'utf8').catch(() => '');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          const l = JSON.parse(line);
          if (!l || typeof l.ts !== 'string') continue;
          if (level && l.level !== level) continue;
          if (taskId && l.taskId !== taskId) continue;
          if (q) {
            const s = String(q).toLowerCase();
            if (!String(l.msg || '').toLowerCase().includes(s) && !String(l.taskName || '').toLowerCase().includes(s)) continue;
          }
          rows.push(l);
          if (l.taskName) tasks.set(l.taskName, l.taskId || '');
        } catch { /* 跳过坏行 */ }
      }
    }
    rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return { rows, tasks: [...tasks.entries()].map(([name, id]) => ({ id, name })) };
  }

  recent(n = 8) { return this.ring.slice(-n).reverse(); }

  async files() {
    const list = await fsp.readdir(this.dir).catch(() => []);
    const out = [];
    for (const f of list) {
      if (!/\.log$/.test(f)) continue;
      const st = await fsp.stat(path.join(this.dir, f)).catch(() => null);
      if (st) out.push({ date: f.replace(/\.log$/, ''), bytes: st.size });
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1));
  }
}

export function createLogger(opts) { return new Logger(opts); }
export { LEVEL_ORDER };
