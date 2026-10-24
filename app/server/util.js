// 通用工具：零依赖，只用 Node 内置模块
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// 版本号唯一来源：app/package.json（此前写死 '0.1.0'，发版后各处显示旧版本）。
// 注意：ESM 没有 __dirname，必须从 import.meta.url 推导（曾因直接写 __dirname
// 被 ReferenceError 吞进 catch，导致本地运行版本恒显示 0.0.0）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}
export const VERSION = readPkgVersion();

export class HttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * 错误详情格式化：message + 关键字段（code/status/errno/syscall/address）+ cause 链 + 堆栈顶部两帧。
 * 目的：让日志里的 ERROR 可诊断——此前各处只记 e.message，丢堆栈与根因，线上问题无法定位。
 * - HttpError 是「预期的用户可见错误」（文案已含指引），默认不带堆栈，避免刷噪声；
 *   传 { withStack: true } 可强制带；非 Error 对象（字符串/普通对象）安全降级。
 * - cause 链最多展开两层：fetch 失败类错误的真正根因（ENOTFOUND/ECONNREFUSED/TIMEOUT）都在 cause 里。
 * - 堆栈只取前两帧并压成单行（` @ at a (f:1:1) ← at b (f:2:2)`），日志按行存储、前端表格渲染。
 */
export function errText(e, { withStack } = {}) {
  if (e == null) return '未知错误';
  if (typeof e === 'string') return e;
  const wantStack = withStack ?? !(e instanceof HttpError);
  const tags = [];
  if (e.code) tags.push(`code=${e.code}`);
  if (e.status) tags.push(`status=${e.status}`);
  if (e.errno) tags.push(`errno=${e.errno}`);
  if (e.syscall) tags.push(`syscall=${e.syscall}`);
  if (e.address) tags.push(`address=${e.address}${e.port ? `:${e.port}` : ''}`);
  const head = (e.message || String(e)) + (tags.length ? `（${tags.join(' ')}）` : '');
  if (!wantStack) return head;
  let out = head;
  // cause 链（最多两层，不带各自堆栈）：网络错误的根因码是定位关键
  const causes = [];
  let cur = e.cause;
  let depth = 0;
  while (cur && depth < 2 && cur !== e) {
    const ct = [];
    if (cur.code) ct.push(`code=${cur.code}`);
    if (cur.errno) ct.push(`errno=${cur.errno}`);
    causes.push((cur.message || String(cur)) + (ct.length ? `（${ct.join(' ')}）` : ''));
    cur = cur.cause;
    depth++;
  }
  if (causes.length) out += `｜cause: ${causes.join(' ← ')}`;
  const stack = e.stack ? String(e.stack).split('\n').slice(1, 3).map((s) => s.trim()).filter(Boolean).join(' ← ') : '';
  return stack ? `${out} @ ${stack}` : out;
}

export const uid = (p = 'x') =>
  `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, w = 2) => String(n).padStart(w, '0');

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

export function safeJoin(root, rel) {
  const base = path.resolve(root);
  const p = path.resolve(base, String(rel ?? ''));
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new HttpError('BAD_PATH', '路径越界', 400);
  }
  return p;
}

/** 脱敏 URL：保留 host+path，把 query 里的签名/令牌参数替换为 ***，并抹掉 userinfo。
 *  直播流地址常带 expire/sign/token，日志与状态接口都不该出现可直接复用的签名。 */
export function redactUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.username || u.password) { u.username = '***'; u.password = '***'; }
    for (const k of [...u.searchParams.keys()]) {
      if (/token|sign|expire|auth|key|secret|credential|session|sig/i.test(k)) u.searchParams.set(k, '***');
    }
    return u.toString();
  } catch {
    return String(raw ?? '').replace(/([?&](?:token|sign|expire|auth|key|secret|session|sig)=)[^&]*/gi, '$1***');
  }
}

/** 是不是「内网/本机/链路本地」地址（trustLan 与 SSRF 防护共用）。
 *  用 net.isIP 规范解析，不做字符串前缀糊匹配（旧实现 startsWith('fc') 会把 'fc.example.com' 判成内网）。 */
export function isPrivateHost(host) {
  let s = String(host || '').toLowerCase().trim().replace(/^\[|\]$/g, '');
  if (s.startsWith('::ffff:')) s = s.slice(7);
  if (!s) return true;
  if (s === 'localhost' || s.endsWith('.localhost') || s.endsWith('.local')) return true;
  const v = net.isIP(s);
  if (v === 4) {
    return /^(0\.|10\.|127\.|192\.168\.|169\.254\.)/.test(s)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(s)
      || /^22[4-9]\.|^23\d\.|^24\d\.|^25[0-5]\./.test(s);
  }
  if (v === 6) return s === '::1' || s === '::' || /^f[cd]/.test(s) || /^fe80/.test(s) || /^ff/.test(s);
  return false; // 域名：只做字面判断，DNS rebinding 需在请求层再校验（当前未做）
}

/** 校验一个「服务端要主动请求」的地址：协议白名单 + 默认拒绝内网目标 */
export function assertRemoteUrl(raw, { label = '地址', allowRtmp = false, allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new HttpError('INVALID_URL', `${label}不是合法地址`, 400); }
  const protos = allowRtmp ? ['http:', 'https:', 'rtmp:'] : ['http:', 'https:'];
  if (!protos.includes(u.protocol)) {
    throw new HttpError('INVALID_URL', `${label}只支持 ${allowRtmp ? 'http(s) / rtmp' : 'http(s)'} 协议`, 400);
  }
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new HttpError('INVALID_URL', `${label}不能指向内网/本机地址`, 400);
  }
  return u;
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
/** 5xx 由调用方（路由包装器）记入日志文件（带请求上下文），这里只负责响应，不再重复 console.error */
export function fail(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL';
  const message = error?.message || '内部错误';
  sendJson(res, status, { ok: false, error: { code, message } });
}

export function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}
