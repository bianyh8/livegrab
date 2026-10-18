// 日志：按天滚动 + 单文件切分 + 保留天数 + 环形缓冲 + SSE 订阅
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, dateKey, nowIso } from './util.js';

const LEVEL_ORDER = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const RING = 2000;

/** 日志文件名排序：先按日期，再按分卷号（`YYYY-MM-DD.log` 是第 0 卷，`YYYY-MM-DD.1.log` 是第 1 卷） */
function logNameOrder(name) {
  const parts = name.replace(/\.log$/, '').split('.');
  return { day: parts[0], part: Number(parts[1]) || 0 };
}

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
    this._logCache = new Map(); // 文件名 → { size, tail, rows }：日志文件增量索引（只读新增部分）
    this._rowsFlat = null;      // 拼接后的全量行缓存（gen 变化才重建）
    this._logGen = 0;           // 索引版本号：有新行解析进来才自增
    this._logEpoch = 0;         // 纪元：日志文件被删除/截断（行集合被重写）时自增，用于整体失效过滤缓存
    this._pageRows = null;
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
    this._logCache.clear();
    this._rowsFlat = null;
    this._logGen += 1;
    this._logEpoch += 1;
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
    this._write(line);
    this.emit(line);
  }

  _write(line) {
    const json = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(json);
    this._chain = this._chain.then(async () => {
      if (this._size + bytes > MAX_FILE_BYTES) {
        this._part += 1;
        this._size = 0;
      }
      await fsp.appendFile(this.currentFile(), json, 'utf8');
      this._size += bytes;
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
   * 分页查询（历史全量，来自日志文件）。行数据来自增量索引（只读新增字节），
   * 过滤结果再按 (level|taskId|q) + 索引版本缓存：翻页/2s 轮询都不重复读文件、不重复过滤。
   * 返回 { items, total, page, pageSize, pages, tasks }，tasks 为匹配集合内的任务名清单（供前端筛选下拉）。
   */
  async queryPage({ level, taskId, q, page = 1, pageSize = 50, order = 'desc' } = {}) {
    const size = Math.max(1, Math.min(20000, Number(pageSize) || 50));
    const p = Math.max(1, Number(page) || 1);
    const key = `${level || ''}|${taskId || ''}|${String(q || '').toLowerCase()}`;
    const kw = String(q || '').toLowerCase();
    const { rows: source, epoch } = await this._allRows();
    // 过滤结果增量维护：键（筛选条件）/纪元（文件被删改）变化才重建，其余情况只过滤「新增的行」。
    // 行按写入顺序追加（日志天然按时间追加），因此缓存本身即时间升序，倒序输出时反转即可 —— 无需每次排序。
    let c = this._pageRows;
    if (!c || c.key !== key || c.epoch !== epoch || source.length < c.consumed) {
      c = { key, epoch, consumed: 0, entries: [], tasks: new Map() };
      this._pageRows = c;
    }
    for (let i = c.consumed; i < source.length; i++) {
      const l = source[i];
      if (level && l.level !== level) continue;
      if (taskId && l.taskId !== taskId) continue;
      // 预先把小写文本拼好：同一行只 toLowerCase 一次，换筛选词时不必对全量重新降级
      const text = `${l.msg || ''}\u0000${l.taskName || ''}`.toLowerCase();
      if (kw && !text.includes(kw)) continue;
      c.entries.push({ row: l, text });
      if (l.taskName) c.tasks.set(l.taskName, l.taskId || '');
    }
    c.consumed = source.length;

    const entries = c.entries;
    const total = entries.length;
    const start = (p - 1) * size;
    // 升序：从旧到新切片；降序：从尾部向前切片再反转（等价于 ts 倒序）
    const pageItems = order === 'asc'
      ? entries.slice(start, start + size)
      : entries.slice(Math.max(0, total - start - size), Math.max(0, total - start)).reverse();
    return {
      items: pageItems.map((e) => e.row),
      total,
      page: p,
      pageSize: size,
      pages: Math.max(1, Math.ceil(total / size)),
      tasks: [...c.tasks.entries()].map(([name, id]) => ({ id, name })),
    };
  }

  /**
   * 日志文件增量索引：每个文件记住已读到的字节偏移，只读取并解析「新增的那一段」。
   * 旧实现每次缓存失效都把保留期内所有 .log 全量读一遍再全量 JSON.parse——录制中日志持续增长，
   * 「运行日志」页 2s 轮询会反复触发，日志多时直接把事件循环拖满。
   * 返回 { rows, gen, epoch }：rows 为所有文件按「日期 → 分卷号 → 行序」拼接的行（按写入顺序）；
   * epoch 在文件被删除/截断时变化，调用方据此整体重建过滤缓存。
   */
  async _allRows() {
    const names = (await fsp.readdir(this.dir).catch(() => [])).filter((f) => /\.log$/.test(f));
    names.sort((a, b) => {
      const x = logNameOrder(a);
      const y = logNameOrder(b);
      if (x.day !== y.day) return x.day < y.day ? -1 : 1;
      return x.part - y.part;
    });
    const cache = this._logCache;
    const alive = new Set(names);
    for (const name of [...cache.keys()]) {
      if (!alive.has(name)) { cache.delete(name); this._logGen += 1; this._logEpoch += 1; }
    }
    for (const name of names) {
      const p = path.join(this.dir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      let c = cache.get(name);
      if (!c || st.size < c.size) { // 新文件 / 被清空或截断 → 从头重建该文件的缓存
        c = { size: 0, tail: Buffer.alloc(0), rows: [] };
        cache.set(name, c);
        this._logGen += 1;
        this._logEpoch += 1;
      }
      if (st.size === c.size) continue;
      let chunk = null;
      try {
        const fh = await fsp.open(p, 'r');
        try {
          const len = st.size - c.size;
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, c.size);
          chunk = buf.subarray(0, bytesRead);
        } finally { await fh.close().catch(() => {}); }
      } catch { continue; }
      if (!chunk) continue;
      c.size = st.size;
      // 末行可能只写了一半（追加过程中读到）：留到下次拼上，避免解析出损坏行
      const all = c.tail.length ? Buffer.concat([c.tail, chunk]) : chunk;
      const nl = all.lastIndexOf(0x0a);
      if (nl < 0) { c.tail = all; continue; }
      c.tail = all.subarray(nl + 1);
      for (const line of all.subarray(0, nl).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const l = JSON.parse(line);
          if (l && typeof l.ts === 'string') c.rows.push(l);
        } catch { /* 跳过坏行 */ }
      }
      this._logGen += 1;
    }
    // 拼接结果按 gen 缓存：没有新行时连数组拼接都省掉（日志多时这一步也要近十毫秒）
    if (!this._rowsFlat || this._rowsFlat.gen !== this._logGen) {
      const rows = [];
      for (const name of names) {
        const c = cache.get(name);
        if (!c || !c.rows.length) continue;
        for (const r of c.rows) rows.push(r);
      }
      this._rowsFlat = { gen: this._logGen, rows };
    }
    return { rows: this._rowsFlat.rows, gen: this._logGen, epoch: this._logEpoch };
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

export { LEVEL_ORDER };
