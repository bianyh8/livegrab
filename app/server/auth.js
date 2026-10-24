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
    this.fails = new Map(); // `${ip}|${username}` → {count, lockedUntil}
    this.revoked = new Map(); // jti → exp（登出后立刻失效；重启后清空，但 epoch/改密仍能兜住长期风险）
    this.logger = null; // 由 server.js 注入，用于记录失败登录
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
    // 锁定按「IP 维度」统计：只按 ip+username 记会让人换个用户名就绕过锁定。
    const now = Date.now();
    let until = 0;
    for (const [k, rec] of this.fails) {
      if (!rec?.lockedUntil || rec.lockedUntil <= now) continue;
      if (k === String(ip) || k.startsWith(`${ip}|`)) until = Math.max(until, rec.lockedUntil);
    }
    return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  }

  _failKey(ip, username) { return `${ip || 'local'}|${String(username || '').trim().toLowerCase()}`; }

  /** 惰性清理：失败的锁定记录与已过期的撤销记录都不能无限增长 */
  _pruneFails() {
    const now = Date.now();
    for (const [k, rec] of this.fails) {
      if (rec?.lockedUntil && rec.lockedUntil > now) continue; // 仍在锁定中
      if (rec?.lockedUntil && rec.lockedUntil <= now) { this.fails.delete(k); continue; } // 锁已过期
      // 未锁定：只清半天前的旧计数（否则「连续失败」永远累计不到阈值）
      if (now - (rec?.updatedAt || 0) > 12 * 3600_000) this.fails.delete(k);
    }
    for (const [jti, exp] of this.revoked) if (!exp || exp <= now) this.revoked.delete(jti);
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
    this._pruneFails();
    const remain = this.lockRemainSec(ip);
    if (remain > 0) throw new HttpError('LOCKED', `失败次数过多，请 ${remain} 秒后再试`, 429);
    const pass = String(password || '');
    const hash = hashPassword(pass, this.users.salt);
    const a = Buffer.from(hash);
    const b = Buffer.from(this.users.hash);
    const sameUser = String(username || this.users.username) === this.users.username;
    const good = a.length === b.length && crypto.timingSafeEqual(a, b) && sameUser;
    if (!good) {
      const key = this._failKey(ip, username);
      const rec = this.fails.get(key) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      rec.updatedAt = Date.now();
      // 注意括号：必须连续失败 failLimit 次才锁定（此前缺少括号会导致一次失败即锁定 10 分钟）
      if (rec.count >= (Number(failLimit) || 5)) { rec.lockedUntil = Date.now() + (Number(lockMin) || 10) * 60000; rec.count = 0; }
      this.fails.set(key, rec);
      // 失败必须留痕：以前完全不写日志，暴力破解在「运行日志」页一条都看不到
      if (this.logger) this.logger.warn(`登录失败：用户名「${String(username || '').slice(0, 40) || '(空)'}」来自 ${ip}（该 IP 连续失败已累计）`);
      throw new HttpError('BAD_CREDENTIALS', '账号或密码错误', 401);
    }
    for (const k of [...this.fails.keys()]) if (k === String(ip) || k.startsWith(`${ip}|`)) this.fails.delete(k);
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
    // epoch 自增 = 立刻作废所有已签发的会话（旧 token 的 ep 不再匹配）。
    // 改密码的语义必须是「所有设备重新登录」，否则泄漏的 token 能一直用到过期。
    this.users = { ...this.users, salt, hash: hashPassword(newPassword, salt), epoch: (Number(this.users.epoch) || 0) + 1, updatedAt: nowIso() };
    await writeJsonAtomic(this.file, this.users);
    this.revoked.clear();
    return { ok: true };
  }

  /** 注销所有会话（设置页「注销所有会话」）：epoch 自增并清空撤销表 */
  async revokeAll() {
    if (!this.users) return { ok: true };
    this.users = { ...this.users, epoch: (Number(this.users.epoch) || 0) + 1, updatedAt: nowIso() };
    await writeJsonAtomic(this.file, this.users);
    this.revoked.clear();
    return { ok: true };
  }

  // ---------- 会话 ----------
  issue(remember = false, days = 30) {
    const maxAge = remember ? Math.max(1, Number(days) || 30) * 86400 : 12 * 3600;
    // jti 用于单次登出撤销；ep 是账号级会话代次（改密/注销所有会话时自增 → 旧 token 全部失效）
    const payload = {
      sub: this.users?.username || 'admin', iat: Date.now(), exp: Date.now() + maxAge * 1000,
      jti: crypto.randomBytes(9).toString('hex'), ep: Number(this.users?.epoch) || 0,
    };
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
      // 改密码 / 注销所有会话 → epoch 变了，所有旧 token 立刻作废
      if ((Number(payload.ep) || 0) !== (Number(this.users?.epoch) || 0)) return null;
      if (payload.jti && this.revoked.has(payload.jti)) return null;
      return payload;
    } catch { return null; }
  }

  /** 登出：把当前 token 的 jti 加入撤销表（重启前一直有效；重启后靠 exp/epoch 兜底） */
  revoke(req) {
    const payload = this.verifyToken(parseCookies(req)[COOKIE_NAME]);
    if (payload?.jti) {
      this.revoked.set(payload.jti, payload.exp);
      this._pruneFails();
    }
    return !!payload;
  }

  sessionFrom(req) {
    const cookies = parseCookies(req);
    const payload = this.verifyToken(cookies[COOKIE_NAME]);
    if (!payload) return null;
    return { username: payload.sub, exp: payload.exp };
  }

  cookieHeader(token, maxAge, secure = false) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  clearCookieHeader(secure = false) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}
