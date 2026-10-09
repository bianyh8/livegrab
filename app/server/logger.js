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
