// 鉴权：scrypt 密码 + HMAC 签名 Cookie 会话 + 失败锁定（D1）
import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson, writeJsonAtomic, HttpError, nowIso } from './util.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const COOKIE_NAME = 'lg_session';

function hashPassword(password, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('base64');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function parseCookies(req) {
  const raw = req.headers?.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export class Auth {
  constructor(configDir) {
    this.dir = configDir;
    this.file = path.join(configDir, 'users.json');
    this.secretFile = path.join(configDir, 'secret.key');
    this.users = null;
    this.secret = null;
    this.fails = new Map(); // ip → {count, lockedUntil}
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.users = await readJson(this.file, null);
    let secret = (await fsp.readFile(this.secretFile, 'utf8').catch(() => '')).trim();
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      await fsp.writeFile(this.secretFile, secret, { mode: 0o600 });
    }
    this.secret = secret;
    return this;
  }

  get mode() { return this.users ? 'login' : 'init'; }

  lockRemainSec(ip) {
    const rec = this.fails.get(ip);
    if (!rec?.lockedUntil) return 0;
    return Math.max(0, Math.ceil((rec.lockedUntil - Date.now()) / 1000));
  }

  async createUser({ username, password }) {
    if (this.users) throw new HttpError('ALREADY_INIT', '已初始化，请直接登录', 409);
    const name = String(username || 'admin').trim() || 'admin';
    if (String(password || '').length < 6) throw new HttpError('WEAK_PASSWORD', '密码至少 6 位', 400);
    const salt = crypto.randomBytes(16).toString('base64');
    this.users = {
      username: name,
      salt,
      hash: hashPassword(password, salt),
      iterations: SCRYPT.N,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(this.file, this.users);
    return { username: name };
  }

  async verifyLogin({ username, password, ip = 'local', failLimit = 5, lockMin = 10 }) {
    if (!this.users) throw new HttpError('NOT_INITIALIZED', '尚未初始化管理员账号', 409);
    const remain = this.lockRemainSec(ip);
    if (remain > 0) throw new HttpError('LOCKED', `失败次数过多，请 ${remain} 秒后再试`, 429);
    const pass = String(password || '');
    const hash = hashPassword(pass, this.users.salt);
    const a = Buffer.from(hash);
    const b = Buffer.from(this.users.hash);
    const sameUser = String(username || this.users.username) === this.users.username;
    const good = a.length === b.length && crypto.timingSafeEqual(a, b) && sameUser;
    if (!good) {
      const rec = this.fails.get(ip) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      // 注意括号：必须连续失败 failLimit 次才锁定（此前缺少括号会导致一次失败即锁定 10 分钟）
      if (rec.count >= (Number(failLimit) || 5)) { rec.lockedUntil = Date.now() + (Number(lockMin) || 10) * 60000; rec.count = 0; }
      this.fails.set(ip, rec);
      throw new HttpError('BAD_CREDENTIALS', '账号或密码错误', 401);
    }
    this.fails.delete(ip);
    // 记录上次登录，供"安全与登录"页展示
    this.users = { ...this.users, lastLoginAt: nowIso(), lastLoginIp: ip };
    await writeJsonAtomic(this.file, this.users).catch(() => {});
    return { username: this.users.username };
  }

  async changePassword({ oldPassword, newPassword }) {
    if (!this.users) throw new HttpError('NOT_INITIALIZED', '尚未初始化', 409);
    const oldHash = hashPassword(oldPassword, this.users.salt);
    if (oldHash !== this.users.hash) throw new HttpError('BAD_CREDENTIALS', '原密码错误', 401);
    if (String(newPassword || '').length < 6) throw new HttpError('WEAK_PASSWORD', '新密码至少 6 位', 400);
    const salt = crypto.randomBytes(16).toString('base64');
    this.users = { ...this.users, salt, hash: hashPassword(newPassword, salt), updatedAt: nowIso() };
    await writeJsonAtomic(this.file, this.users);
    return { ok: true };
  }

  // ---------- 会话 ----------
  issue(remember = false, days = 30) {
    const maxAge = remember ? Math.max(1, Number(days) || 30) * 86400 : 12 * 3600;
    const payload = { sub: this.users?.username || 'admin', iat: Date.now(), exp: Date.now() + maxAge * 1000 };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
    return { token: `${body}.${sig}`, maxAge, expiresAt: new Date(payload.exp).toISOString() };
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expect = b64url(crypto.createHmac('sha256', this.secret).update(body).digest());
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    try {
      const payload = JSON.parse(fromB64url(body).toString('utf8'));
      if (!payload?.exp || payload.exp <= Date.now()) return null;
      return payload;
    } catch { return null; }
  }

  sessionFrom(req) {
    const cookies = parseCookies(req);
    const payload = this.verifyToken(cookies[COOKIE_NAME]);
    if (!payload) return null;
    return { username: payload.sub, exp: payload.exp };
  }

  cookieHeader(token, maxAge) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  }

  clearCookieHeader() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}
