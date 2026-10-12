// 通用工具：零依赖，只用 Node 内置模块
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '0.1.0';

export class HttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const uid = (p = 'x') =>
  `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

export function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function pathExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export async function statSafe(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return fallback; }
}

export async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeFileAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

export function safeJoin(root, rel) {
  const base = path.resolve(root);
  const p = path.resolve(base, String(rel ?? ''));
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new HttpError('BAD_PATH', '路径越界', 400);
  }
  return p;
}

export function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { total += fs.statSync(p).size; files++; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

// ---------- 时间（跟随容器 TZ 环境变量） ----------
export function parts(d = new Date()) {
  return {
    y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()),
    H: pad(d.getHours()), M: pad(d.getMinutes()), S: pad(d.getSeconds()),
  };
}

const DATE_FMTS = {
  'YYYY-MM-DD': (p) => `${p.y}-${p.m}-${p.d}`,
  YYYYMMDD: (p) => `${p.y}${p.m}${p.d}`,
  'YYYY.MM.DD': (p) => `${p.y}.${p.m}.${p.d}`,
  'YYYY年MM月DD日': (p) => `${p.y}年${p.m}月${p.d}日`,
};

const TIME_FMTS = {
  'HH-mm-ss': (p) => `${p.H}-${p.M}-${p.S}`,
  HHmmss: (p) => `${p.H}${p.M}${p.S}`,
  'HH:mm:ss': (p) => `${p.H}:${p.M}:${p.S}`,
};

export const DATE_FORMAT_KEYS = Object.keys(DATE_FMTS);
export const TIME_FORMAT_KEYS = Object.keys(TIME_FMTS);

export function formatDate(d, fmt = 'YYYY-MM-DD') {
  const f = DATE_FMTS[fmt] || DATE_FMTS['YYYY-MM-DD'];
  return f(parts(d));
}

export function formatTime(d, fmt = 'HH-mm-ss') {
  // [\\/:*?"<>|] 都是非法字符，时间格式里的冒号统一成 -
  const f = TIME_FMTS[fmt] || TIME_FMTS['HH-mm-ss'];
  return f(parts(d)).replace(/:/g, '-');
}

export function dateKey(d = new Date()) {
  return formatDate(d, 'YYYY-MM-DD');
}

export function tzName() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function byteLength(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

// ---------- MIME / Range ----------
const MIME = {
  '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.m4v': 'video/mp4',
  '.flv': 'video/x-flv', '.mkv': 'video/x-matroska', '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl', '.webm': 'video/webm',
};

export function mimeByExt(ext) {
  return MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

export function parseRange(header, size) {
  if (!header || !/^bytes=/.test(header)) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  let [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start;
  let end;
  if (a === '') { // suffix: bytes=-500
    const len = Number(b);
    if (!len) return 'invalid';
    start = Math.max(0, size - len);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError('BODY_TOO_LARGE', '请求体过大', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new HttpError('BAD_JSON', 'JSON 解析失败', 400); }
}

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function ok(res, data, status = 200) { sendJson(res, status, { ok: true, data }); }
export function fail(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL';
  const message = error?.message || '内部错误';
  if (status >= 500) console.error('[error]', error);
  sendJson(res, status, { ok: false, error: { code, message } });
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}
