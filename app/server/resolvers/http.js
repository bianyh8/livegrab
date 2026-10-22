// 公共 HTTP 助手：超时 + 重试 + 统一 UA
import { HttpError, errText } from '../util.js';
import { proxyStore, httpGetViaProxy, requestViaProxy } from '../proxy-fetch.js';

export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function httpGet(url, { headers = {}, timeoutMs = 12000, retries = 2, logger = null, label = '', proxy = '' } = {}) {
  // 代理来源优先级：显式传入 opts.proxy > 当前 AsyncLocalStorage 上下文（runWithProxy 注入的按平台生效代理）> 直连
  const effectiveProxy = proxy || proxyStore.getStore()?.proxy || '';
  if (effectiveProxy) {
    return httpGetViaProxy(url, { headers, timeoutMs, retries, logger, label, proxy: effectiveProxy });
  }
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text, headers: res.headers, finalUrl: res.url || url };
    } catch (e) {
      lastErr = e;
      if (logger && i < retries) logger.debug(`${label || 'HTTP'} 第 ${i + 1} 次请求失败：${errText(e, { withStack: false })}`);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  // 带 URL/标签与重试次数：此前只有「网络请求失败：fetch failed」，无法判断是哪个接口、错因（DNS/超时/拒连）
  const where = label ? `${label} ${url}` : url;
  throw new HttpError('NETWORK', `网络请求失败（${where}，已重试 ${retries} 次）：${errText(lastErr, { withStack: false })}`, 502);
}

export async function httpJson(url, opts = {}) {
  const { text, status, ok } = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('BAD_RESPONSE', `响应不是合法 JSON（HTTP ${status}${ok ? '' : ' 错误'}）`, 502);
  }
}

/** HEAD 预校验 URL 可用性（StreamGet 的 get_response_status 模式）：返回 HTTP status code，异常返回 false。
 *  用于解析阶段过滤死 URL（如抖音 _or4 变体常 404），避免把不可用地址送进录制候选阶梯烧重连额度。 */
export async function httpHead(url, { headers = {}, timeoutMs = 8000, retries = 1, logger = null, label = '', proxy = '' } = {}) {
  const effectiveProxy = proxy || proxyStore.getStore()?.proxy || '';
  if (effectiveProxy) {
    try {
      const res = await requestViaProxy(url, { method: 'HEAD', headers, timeoutMs, maxRedirects: 3, proxy: effectiveProxy });
      return res.status;
    } catch (e) {
      if (logger) logger.debug(`${label || 'HEAD'} 预校验失败（${url}）：${errText(e, { withStack: false })}`);
      return false;
    }
  }
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.status;
    } catch (e) {
      if (logger && i < retries) logger.debug(`${label || 'HEAD'} 第 ${i + 1} 次预校验失败：${errText(e, { withStack: false })}`);
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  return false;
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
