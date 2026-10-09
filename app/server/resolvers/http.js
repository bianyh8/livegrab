// 公共 HTTP 助手：超时 + 重试 + 统一 UA
import { HttpError } from '../util.js';

export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function httpGet(url, { headers = {}, timeoutMs = 12000, retries = 2, logger = null, label = '' } = {}) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text, headers: res.headers };
    } catch (e) {
      lastErr = e;
      if (logger && i < retries) logger.debug(`${label || 'HTTP'} 第 ${i + 1} 次请求失败：${e.message}`);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new HttpError('NETWORK', `网络请求失败：${lastErr?.message || 'unknown'}`, 502);
}

export async function httpJson(url, opts = {}) {
  const { text, status, ok } = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('BAD_RESPONSE', `响应不是合法 JSON（HTTP ${status}${ok ? '' : ' 错误'}）`, 502);
  }
}

export function pickSetCookie(headers) {
  try {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
    const v = headers.get('set-cookie');
    return v ? [v] : [];
  } catch { return []; }
}

export function cookiesToString(list) {
  return list.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
}

/** 从 HTML 中截取 JSON 对象（括号配对），用于解析内嵌配置 */
export function sliceJsonObject(text, startIndex) {
  const open = text.indexOf('{', startIndex);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = text.slice(open, i + 1);
        try { return JSON.parse(raw); } catch { return null; }
      }
    }
  }
  return null;
}
