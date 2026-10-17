// 零依赖代理 HTTP 客户端：通过 HTTP 代理的 CONNECT 隧道转发 HTTPS/HTTP 请求。
// 用途：① 平台「按平台启用代理」时的解析接口（解析器内部所有 httpGet/httpJson 自动走代理）；
//       ② 系统更新（GitHub API 查询 + codeload 归档下载）。
// 设计约束：项目仅依赖 better-sqlite3，故不引入 undici，直接用 Node 内置 http/https/tls/net 实现隧道。
//
// 为什么不用全局 fetch：Node 内置 fetch（undici）不会读取 HTTPS_PROXY 环境变量，
// 也没有可导入的 ProxyAgent（本环境 import 'undici' 直接 MODULE_NOT_FOUND），
// 因此自实现 CONNECT 隧道客户端是唯一零依赖路径。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { URL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError, errText, sleep } from './util.js';

export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------- 按平台计算「生效代理」 ---------- */

/** 生效代理 = 该平台开关开启 且 全局代理已配置；否则返回空（走直连）。
 *  对应需求：「启用并且维护了代理的话，则使用代理连接，否则正常连接」。 */
export function effectiveProxyForPlatform(platformId, settings) {
  const on = !!(settings && settings.platformUseProxy && settings.platformUseProxy[platformId]);
  const proxy = (settings && settings.proxy) || '';
  return on && proxy ? proxy : '';
}

/* ---------- 解析器会话内生效代理（AsyncLocalStorage，并发安全） ---------- */

export const proxyStore = new AsyncLocalStorage();

/** 在带代理的上下文里执行 fn：fn 内部所有 httpGet/httpJson 都会自动走该代理。
 *  AsyncLocalStorage 随 async 调用链传播，多平台并发解析互不影响。 */
export function runWithProxy(proxy, fn) {
  if (!proxy) return fn();
  return proxyStore.run({ proxy }, fn);
}

/* ---------- CONNECT 隧道代理客户端 ---------- */

const agentCache = new Map(); // key: proxyUrl::secure

class HttpsTunnelAgent extends https.Agent {
  constructor(proxyUrl) { super({ keepAlive: false }); this.proxyUrl = proxyUrl; }
  createConnection(options, cb) {
    createTunnel(this.proxyUrl, options.host, options.port || 443, true).then((sock) => cb(null, sock)).catch(cb);
  }
}
class HttpTunnelAgent extends http.Agent {
  constructor(proxyUrl) { super({ keepAlive: false }); this.proxyUrl = proxyUrl; }
  createConnection(options, cb) {
    createTunnel(this.proxyUrl, options.host, options.port || 80, false).then((sock) => cb(null, sock)).catch(cb);
  }
}

function makeAgent(proxyUrl, secure) {
  const key = `${proxyUrl}::${secure ? 's' : 'p'}`;
  let a = agentCache.get(key);
  if (!a) {
    a = secure ? new HttpsTunnelAgent(proxyUrl) : new HttpTunnelAgent(proxyUrl);
    agentCache.set(key, a);
  }
  return a;
}

/** 与代理服务器建立连接（代理本身为 https 时先 TLS，否则明文）。 */
function connectToProxy(proxyUrl) {
  return new Promise((resolve, reject) => {
    if (proxyUrl.protocol === 'https:') {
      const s = tls.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 443 }, () => resolve(s));
      s.on('error', reject);
    } else {
      const s = net.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80 }, () => resolve(s));
      s.on('error', reject);
    }
  });
}

/** 经代理向目标发起 CONNECT 隧道：返回到目标的 socket（secure 目标再包一层 TLS）。
 *  注意：这里手写 CONNECT 握手，不用 http.request({socket})——
 *  Node 的 http 客户端不会对「已连接的 socket」重新触发 connect 事件去写请求头，
 *  用 http.request 传 socket 会导致 CONNECT 根本写不出去（表现为「开了代理却连不通」）。 */
function createTunnel(proxyUrl, targetHost, targetPort, secure) {
  return connectToProxy(proxyUrl).then((proxySocket) => new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    function cleanup() {
      proxySocket.removeListener('data', onData);
      proxySocket.removeListener('error', onErr);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      try { proxySocket.destroy(); } catch { /* ignore */ }
      reject(err);
    }
    function done(sock) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(sock);
    }
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) { if (buf.length > 16384) fail(new Error('代理 CONNECT 响应头过大')); return; }
      const statusLine = buf.slice(0, idx).toString('latin1').split('\r\n')[0] || '';
      const code = Number((/^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine) || [])[1]) || 0;
      const rest = buf.slice(idx + 4);
      if (code < 200 || code >= 300) { fail(new Error(`代理 CONNECT 失败：${statusLine || '无响应'}`)); return; }
      if (rest.length) { try { proxySocket.pause(); proxySocket.unshift(rest); } catch { /* 极少见：忽略 */ } } // 头部之后若已带数据，退回给后续读取
      if (secure) {
        const tlsSock = tls.connect({ socket: proxySocket, servername: targetHost }, () => done(tlsSock));
        tlsSock.on('error', fail);
      } else {
        done(proxySocket);
      }
    }
    function onErr(e) { fail(e); }
    proxySocket.on('data', onData);
    proxySocket.on('error', onErr);
    if (typeof proxySocket.setTimeout === 'function') proxySocket.setTimeout(15000, () => fail(new Error('代理 CONNECT 超时')));
    proxySocket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
  }));
}

/* ---------- 经代理的请求（GET + 重定向 + 超时） ---------- */

/** 经代理发起一次请求，返回 { status, ok, statusText, headers(Map), body(Buffer), finalUrl }。
 *  maxRedirects>0 时自动跟随 3xx 跳转（相对/绝对 Location 均可）。 */
export async function requestViaProxy(targetUrl, opts = {}) {
  const { method = 'GET', headers = {}, timeoutMs = 15000, maxRedirects = 5, proxy, body = null } = opts;
  const proxyUrl = new URL(proxy);
  let current = targetUrl;
  let redirects = 0;
  while (true) {
    const u = new URL(current);
    const secure = u.protocol === 'https:';
    const agent = makeAgent(proxyUrl, secure);
    const lib = secure ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(current, {
        method,
        headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept-Encoding': 'identity', ...headers },
        agent,
        timeout: timeoutMs,
      });
      req.on('timeout', () => req.destroy(new Error('代理请求超时')));
      req.on('error', reject);
      req.on('response', resolve);
      if (body) req.write(body);
      req.end();
    });
    const chunks = [];
    await new Promise((resolve, reject) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', resolve);
      res.on('error', reject);
    });
    const bodyBuf = Buffer.concat(chunks);
    if (redirects < maxRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      redirects++;
      continue;
    }
    const h = new Map();
    for (const [k, v] of Object.entries(res.headers)) h.set(k.toLowerCase(), v);
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 400,
      statusText: res.statusMessage,
      headers: h,
      body: bodyBuf,
      finalUrl: current,
    };
  }
}

/** 经代理取文本（带重试），返回与 resolvers/http.js 的 httpGet 一致的形状：
 *  { status, ok, text, headers(Map), finalUrl }。 */
export async function httpGetViaProxy(url, opts = {}) {
  const { headers = {}, timeoutMs = 12000, retries = 2, logger = null, label = '', proxy } = opts;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await requestViaProxy(url, { headers, timeoutMs, maxRedirects: 5, proxy });
      return { status: res.status, ok: res.ok, text: res.body.toString('utf8'), headers: res.headers, finalUrl: res.finalUrl };
    } catch (e) {
      lastErr = e;
      if (logger && i < retries) logger.debug(`${label || 'PROXY HTTP'} 第 ${i + 1} 次请求失败：${e.message}`);
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  throw new HttpError('NETWORK', `网络请求失败（${label || url}，已重试 ${retries} 次）：${errText(lastErr, { withStack: false })}`, 502);
}

/** 经代理取二进制（带重试），返回 { status, ok, buffer(Buffer), headers(Map), finalUrl }。
 *  用于 GitHub codeload 归档下载（tar.gz 不能按文本解码）。 */
export async function httpGetBufferViaProxy(url, opts = {}) {
  const { headers = {}, timeoutMs = 120000, retries = 2, logger = null, label = '', proxy } = opts;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await requestViaProxy(url, { headers, timeoutMs, maxRedirects: 5, proxy });
      return { status: res.status, ok: res.ok, buffer: res.body, headers: res.headers, finalUrl: res.finalUrl };
    } catch (e) {
      lastErr = e;
      if (logger && i < retries) logger.debug(`${label || 'PROXY HTTP'} 第 ${i + 1} 次请求失败：${e.message}`);
      if (i < retries) await sleep(400 * (i + 1));
    }
  }
  throw new HttpError('NETWORK', `网络请求失败（${label || url}，已重试 ${retries} 次）：${errText(lastErr, { withStack: false })}`, 502);
}
