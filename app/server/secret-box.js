// 配置目录内的静态加密：Cookie / 更新 token 落盘前用 AES-256-GCM 封存。
// 密钥文件 .store-key 与数据库同目录（0600），备份数据库不会连带泄漏可用凭据。
// 兼容：无 `enc:v1:` 前缀的老数据按明文读取，下一次落盘自动升级为密文。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const KEY_FILE = '.store-key';

function loadOrCreateKey(dir) {
  const file = path.join(dir, KEY_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  } catch { /* 不存在则创建 */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows/WSL 可能不支持，忽略 */ }
  return key;
}

/**
 * @param {string} dir 配置目录（与 livegrab.db 同目录）
 * @returns {{ seal:(s:string)=>string, open:(s:string)=>string, enabled:boolean }}
 */
export function createSecretBox(dir, logger = null) {
  let key = null;
  try { key = loadOrCreateKey(dir); } catch (e) {
    if (logger) logger.error(`无法创建配置加密密钥（${e.message}），Cookie 将按明文保存`);
    return { seal: (s) => s, open: (s) => s, enabled: false };
  }
  return {
    enabled: true,
    seal(plain) {
      const s = String(plain ?? '');
      if (!s || s.startsWith(PREFIX)) return s; // 空值 / 已封存（幂等）
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      const tag = c.getAuthTag();
      return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
    },
    open(blob) {
      const s = String(blob ?? '');
      if (!s) return '';
      if (!s.startsWith(PREFIX)) return s; // 老数据：明文
      try {
        const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const ct = buf.subarray(28);
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      } catch (e) {
        if (logger) logger.warn(`配置解密失败（密钥文件可能已更换）：${e.message}`);
        return '';
      }
    },
  };
}

export const SECRET_PREFIX = PREFIX;
