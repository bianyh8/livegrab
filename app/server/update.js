/* LiveGrab · server/update.js —— 更新管理器
   职责：① 读取本地版本信息（package.json version + git commit/分支/提交时间）；
   ② 从「更新源配置」指定的仓库（UI 配置 > 环境变量 > 内置默认）经 GitHub API 拉取最新版本与提交，做对比；
   ③ 「立即更新」后台任务：按配置的仓库地址 fetch + pull（环境支持时），否则给出手动更新指引；
   ④ 内存态更新进度与日志（前端轮询 /api/update/status 获取）。
   日志约定：所有更新事件（环境自检/检查对比/拉取/安装/重启）都经 _log 同步写入日志文件
   （前缀 [更新]，与「运行日志」页同一套 logger）；检查结果相同不重复记，避免刷屏。
   设计约定：本地与架构 B 容器（/config/src 自带 .git）走完整的「拉取 → 装依赖 → 自重启」；
   容器首启克隆失败/镜像过旧（无 .git / 无 git）时不伪更新，明确提示手动步骤；本模块零第三方依赖。 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { httpGetViaProxy, normalizeProxy } from './proxy-fetch.js';

const UA = 'LiveGrab-update-manager';
const DEFAULT_REPO = process.env.LIVEGRAB_REPO || 'bianyh8/livegrab';
const DEFAULT_BRANCH = process.env.LIVEGRAB_BRANCH || 'main';
const DEFAULT_GIT_URL = process.env.LIVEGRAB_GIT_URL || `https://github.com/${DEFAULT_REPO}.git`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 60000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, code: err.code || err.message, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
        else resolve({ ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
      });
  });

/** 从 ~/.git-credentials 提取 github.com 的 token（本地开发兜底；容器内无此文件自然返回空） */
function readGitCredentialsToken() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const raw = fs.readFileSync(path.join(home, '.git-credentials'), 'utf8');
    const m = raw.match(/https:\/\/([^:]+):([^@\s]+)@github\.com/);
    return m ? m[2] : '';
  } catch { return ''; }
}

/** 从 https://github.com/owner/repo.git 解析 owner/repo；非 GitHub 或解析失败返回空 */
function parseOwnerRepoFromGitHubUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com') return '';
    const parts = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch { /* ignore */ }
  return '';
}

/** 解析版本号（可带 v 前缀 / 预发布后缀）为可比较对象；不可解析返回 null。 */
export function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** 比较两个「已解析」版本：a>b 返回正数，a<b 返回负数，相等返回 0。
    规则：主次修订号逐段比；同号时「无预发布后缀」视为正式版 > 带后缀的预发布版；
    同为预发布按字典序（满足 semver 对纯数字/字母串的基本要求）。 */
export function cmpParsedVersion(x, y) {
  if (!x || !y) return 0;
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (!x.pre && y.pre) return 1;
  if (x.pre && !y.pre) return -1;
  if (x.pre === y.pre) return 0;
  return x.pre < y.pre ? -1 : 1;
}

/** 语义化版本比较：a>b 返回正数，a<b 返回负数，相等返回 0（任一不可解析按 0 处理）。 */
export function compareVersions(a, b) {
  return cmpParsedVersion(parseVersion(a), parseVersion(b));
}

/** 从候选标签里挑出语义化版本最高的一个（含 v 前缀原样返回）；无有效版本返回 ''。
    GitHub 的 /tags 顺序由提交时间决定、/releases/latest 只认「最新 Release」，
    二者都可能在「打了 tag 但没发 Release」时给出偏旧的版本，故统一取最大版本号。 */
export function pickLatestTag(candidates) {
  let bestTag = '', bestV = null;
  for (const raw of (candidates || [])) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const v = parseVersion(name);
    if (!v) continue;
    if (!bestV || cmpParsedVersion(v, bestV) > 0) { bestV = v; bestTag = name; }
  }
  return bestTag;
}

/* ---------- git 传输层抗抖动 ---------- */

/** git 传输层参数：容器/家庭网络里最常见的两类拉取失败——
    ① `RPC failed; curl 16 Error in the HTTP2 framing layer`
    ② `fatal: expected flush after ref listing`
    都出在 HTTP/2 与 protocol v2 的 ref 通告协商上（中间设备/代理/出口网关改写了连接）。
    改用 HTTP/1.1 并关掉低速中断即可稳定通过；legacyRefs 再用 protocol v0（老式 ref 通告，
    完全绕开 v2 的 ls-refs 解析，对②尤其有效）。全部用 -c 临时注入，不动用户仓库的 .git/config。 */
export function gitTransportArgs({ legacyRefs = false } = {}) {
  const args = [
    '-c', 'http.version=HTTP/1.1',
    '-c', 'http.postBuffer=524288000',
    '-c', 'http.lowSpeedLimit=0',
    '-c', 'http.lowSpeedTime=999999',
  ];
  if (legacyRefs) args.push('-c', 'protocol.version=0');
  return args;
}

/** 拉取尝试计划：由轻到重逐级降级，每级失败后自动进入下一级。
    第 3 次与第 2 次参数相同——falsh/ref listing 类错误多是一次性的网络抖动，原样重试常能过。 */
export const FETCH_PLAN = [
  { label: 'HTTP/1.1', legacyRefs: false },
  { label: 'HTTP/1.1 + protocol v0', legacyRefs: true },
  { label: '重试（HTTP/1.1 + protocol v0）', legacyRefs: true },
];

/** 把 git 的报错文本归类，便于给出「对症」的可操作建议。返回 '' 表示未识别。 */
export function classifyGitError(text) {
  const s = String(text || '');
  if (/HTTP2 framing|expected flush after ref listing|RPC failed/i.test(s)) return 'http2';
  if (/could not resolve host|Failed to connect|Connection (refused|reset|timed out)|Network is unreachable|Operation timed out/i.test(s)) return 'network';
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401/i.test(s)) return 'auth';
  if (/repository .* not found|not found|does not exist/i.test(s)) return 'notfound';
  if (/low-speed limit|transfer closed|early EOF|unexpected disconnect/i.test(s)) return 'unstable';
  return '';
}

/* ---------- tar.gz 快照解析（零依赖：只用 node:zlib） ---------- */

/** 解析 tar 归档为条目列表（支持 ustar 前缀、GNU longname、pax 扩展头与 base-256 长度）。
    返回 [{ name, type, mode, data }]，name 已按 ustar prefix 拼好；type: 'f'|'d'|'other'。 */
export function parseTarEntries(buf) {
  const entries = [];
  let off = 0;
  let nextName = '';     // GNU longname / pax path 覆盖
  const cstr = (b, s, e) => {
    const slice = b.subarray(s, e);
    const z = slice.indexOf(0);
    return slice.subarray(0, z === -1 ? slice.length : z).toString('utf8');
  };
  const octal = (b, s, e) => {
    const slice = b.subarray(s, e);
    // base-256（高位为 1）表示大数，tar 用它存超长数值
    if (slice[0] & 0x80) {
      let n = 0n;
      for (const byte of slice.subarray(1)) n = (n << 8n) | BigInt(byte);
      return Number(n);
    }
    const txt = cstr(b, s, e).trim();
    return txt ? parseInt(txt, 8) || 0 : 0;
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h[0] === 0) break; // 全零块 = 归档结束
    const size = octal(h, 124, 136);
    const typeflag = String.fromCharCode(h[156] || 0x30);
    const data = buf.subarray(off + 512, off + 512 + size);
    const prefix = cstr(h, 345, 500);
    let name = nextName || (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    nextName = '';
    if (typeflag === 'L') { nextName = data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)).toString('utf8'); }
    else if (typeflag === 'x' || typeflag === 'g') {
      // pax 记录形如「len key=value\n」；只关心 path
      const txt = data.toString('utf8');
      let i = 0;
      while (i < txt.length) {
        const sp = txt.indexOf(' ', i);
        if (sp === -1) break;
        const len = parseInt(txt.slice(i, sp), 10);
        if (!len || Number.isNaN(len)) break;
        const rec = txt.slice(sp + 1, i + len - 1);
        const eq = rec.indexOf('=');
        if (eq > 0 && rec.slice(0, eq) === 'path') nextName = rec.slice(eq + 1);
        i += len;
      }
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      entries.push({ name, type: 'f', mode: octal(h, 100, 108) & 0o777, data });
    } else if (typeflag === '5') {
      entries.push({ name, type: 'd', mode: octal(h, 100, 108) & 0o777, data: Buffer.alloc(0) });
    } else {
      entries.push({ name, type: 'other', mode: 0, data: Buffer.alloc(0) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** 把 tar.gz 解压落地到 destDir，剥离最外层目录（GitHub 归档是 <repo>-<branch>/...）。
    返回 { files, dirs, skipped }（相对路径列表）。 */
export function extractTarGzTo(buf, destDir) {
  const all = parseTarEntries(zlib.gunzipSync(buf));
  // 顶层目录名（如 livegrab-main），用于剥离
  const roots = new Set(all.map((e) => e.name.replace(/^\.\//, '').split('/')[0]).filter(Boolean));
  const strip = roots.size === 1 ? `${[...roots][0]}/` : '';
  const files = [], dirs = [], skipped = [];
  for (const e of all) {
    let rel = e.name.replace(/^\.\//, '');
    if (strip) {
      if (!rel.startsWith(strip)) { skipped.push(rel); continue; }
      rel = rel.slice(strip.length);
    }
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) { if (rel) skipped.push(rel); continue; }
    const abs = path.join(destDir, rel);
    if (e.type === 'd') { fs.mkdirSync(abs, { recursive: true }); dirs.push(rel); continue; }
    if (e.type !== 'f') { skipped.push(rel); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data);
    try { fs.chmodSync(abs, e.mode || 0o644); } catch { /* Windows 上可能不支持 */ }
    files.push(rel);
  }
  return { files, dirs, skipped };
}

export class UpdateManager {
  constructor({ appDir, logger, token, restart, getRepoConfig } = {}) {
    this.appDir = appDir || process.cwd();
    this.logger = logger || null;
    // 更新完成后的自重启钩子：由 server.js 注入优雅停止 + re-exec 逻辑。
    // 本地运行与架构 B 容器（/config/src 自带 .git）都会走到此钩子；
    // 容器首启克隆失败/镜像过旧（无 git）时提前返回手动重建指引，不走此钩子。
    this.restartHook = (typeof restart === 'function') ? restart : null;
    // 动态配置来源：server.js 注入 store.settings.customize 读取函数；
    // 用户未在 UI 配置时回退到环境变量 / 默认值。
    this.getRepoConfig = (typeof getRepoConfig === 'function') ? getRepoConfig : null;
    // 系统更新代理来源：server.js 注入读取 store.settings.proxy 的函数。
    // 需求：系统更新若设置了代理地址，则优先使用代理，否则走正常网络连接。
    this.getProxy = (typeof getProxy === 'function') ? getProxy : null;
    // 兜底 token：显式传入 > 环境变量 LIVEGRAB_GITHUB_TOKEN > 本地 ~/.git-credentials
    this.envToken = token || process.env.LIVEGRAB_GITHUB_TOKEN || readGitCredentialsToken() || '';
    this.state = {
      env: null,            // { gitAvailable, gitRoot, dockerAvailable, inContainer }
      local: null,          // { version, commit, branch, commitAt, tag }
      latest: null,         // { version, tag, commit, commitAt, commitMsg, publishedAt, releaseUrl, releaseNotes }
      checkedAt: 0,
      checking: false,
      running: false,       // 更新任务进行中
      phase: 'idle',        // idle|fetch|pull|install|done|error
      progress: 0,          // 0-100
      task: '',             // 当前构建/更新任务描述
      startedAt: 0,
      log: [],              // [{ts, level, msg}]
    };
    this._envSig = '';       // 环境自检结果签名（相同则不重复记日志）
    this._lastCheckSig = ''; // 最近一次已记录检查结果的签名（相同则不重复记日志）
  }

  /* ---------- 动态仓库配置（UI 可配置 > 环境变量 > 默认值） ---------- */

  _cfg() {
    const raw = (this.getRepoConfig && this.getRepoConfig()) || {};
    // 兼容命名：存储层用 update* 命名空间（避免与 customize 其它键冲突），
    // 这里统一归一为 repo/gitUrl/branch/token，读取时两种键都认。
    return {
      repo: raw.updateRepo || raw.repo || '',
      gitUrl: raw.updateGitUrl || raw.gitUrl || '',
      branch: raw.updateBranch || raw.branch || '',
      token: raw.updateToken || raw.token || '',
    };
  }

  _repo() {
    const cfg = this._cfg();
    if (cfg.repo) return cfg.repo;
    if (cfg.gitUrl) return parseOwnerRepoFromGitHubUrl(cfg.gitUrl) || '';
    return process.env.LIVEGRAB_REPO || DEFAULT_REPO;
  }

  _gitUrl() {
    const cfg = this._cfg();
    if (cfg.gitUrl) return cfg.gitUrl;
    if (cfg.repo) return `https://github.com/${cfg.repo}.git`;
    return process.env.LIVEGRAB_GIT_URL || DEFAULT_GIT_URL;
  }

  _branch() {
    const cfg = this._cfg();
    if (cfg.branch) return cfg.branch;
    return process.env.LIVEGRAB_BRANCH || DEFAULT_BRANCH;
  }

  _token() {
    const cfg = this._cfg();
    if (cfg.token) return cfg.token;
    return this.envToken;
  }

  _api() { return `https://api.github.com/repos/${this._repo()}`; }

  /** 系统更新代理地址：由 server.js 注入（读取 store.settings.proxy）。空表示不使用代理。 */
  _proxy() {
    const v = (this.getProxy && this.getProxy()) || '';
    return v ? normalizeProxy(v) : '';
  }

  /** 统一的 HTTP GET：设置了代理则经代理（零依赖 CONNECT 隧道），否则走原生 fetch。
   *  返回 Response 兼容对象（ok/status/json/text/arrayBuffer），调用方无需关心底层是否走代理。
   *  binary=true 用于下载 tar.gz 归档（按字节取，不能按文本解码）。 */
  async _fetch(url, { headers = {}, timeoutMs = 15000, retries = 2, label = '', binary = false } = {}) {
    const proxy = this._proxy();
    if (!proxy) {
      return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    }
    if (binary) {
      const r = await httpGetBufferViaProxy(url, { headers, timeoutMs, retries, logger: this.logger, label, proxy });
      if (!r.ok) throw new Error(`归档下载失败 HTTP ${r.status}`);
      const buf = r.buffer;
      return {
        ok: true, status: r.status, statusText: 'OK', headers: r.headers,
        json: async () => JSON.parse(buf.toString('utf8')),
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    const r = await httpGetViaProxy(url, { headers, timeoutMs, retries, logger: this.logger, label, proxy });
    const text = r.text;
    return {
      ok: r.ok, status: r.status, statusText: r.statusText || '', headers: r.headers,
      json: async () => JSON.parse(text),
      text: async () => text,
      arrayBuffer: async () => Uint8Array.from(Buffer.from(text, 'utf8')).buffer,
    };
  }

  _apiHeaders() {
    const h = { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' };
    const t = this._token();
    if (t) h['Authorization'] = `token ${t}`;
    return h;
  }

  /** 校验并归一化前端提交的更新源配置。
   *  repo 支持 owner/repo 或完整 https git URL；分支缺省 main；token 私有仓库必填。
   *  返回 { repo, gitUrl, branch, token }，供 UI 即时回显与持久化到 settings.customize。 */
  normalizeRepoConfig({ repo = '', branch = '', token = '' } = {}) {
    const r = String(repo || '').trim();
    const b = String(branch || '').trim() || 'main';
    const t = String(token || '').trim();
    if (!r) throw new Error('仓库地址不能为空');
    let gitUrl = '', ownerRepo = '';
    if (/^https?:\/\//.test(r)) {
      gitUrl = r;
      ownerRepo = parseOwnerRepoFromGitHubUrl(r);
    } else if (/^[\w.-]+\/[\w.-]+$/.test(r)) {
      ownerRepo = r;
      gitUrl = `https://github.com/${r}.git`;
    } else {
      throw new Error('仓库地址格式不正确，应为 owner/repo 或 https://github.com/owner/repo.git');
    }
    if (!ownerRepo && /^https?:\/\/github\.com\//.test(gitUrl)) {
      ownerRepo = parseOwnerRepoFromGitHubUrl(gitUrl) || '';
    }
    return { repo: ownerRepo, gitUrl, branch: b, token: t };
  }

  /* ---------- 内部工具 ---------- */

  _log(level, msg) {
    const line = { ts: Date.now(), level, msg };
    this.state.log.push(line);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
    if (this.logger) {
      const lv = level === 'OK' ? 'info' : level === 'ERR' ? 'error' : level === 'WARN' ? 'warn' : 'info';
      this.logger[lv](`[更新] ${msg}`);
    }
    return line;
  }

  _phase(phase, progress, task = '') {
    this.state.phase = phase;
    if (progress != null) this.state.progress = progress;
    if (task) this.state.task = task;
  }

  /** 返回 git 认证参数（临时注入，不改仓库 config）。私有仓库无本地凭据时用 token 走 extraheader。 */
  _gitAuthArgs() {
    const t = this._token();
    if (!t) return [];
    const b64 = Buffer.from(`x-access-token:${t}`).toString('base64');
    return ['-c', `http.extraheader=Authorization: Basic ${b64}`];
  }

  /** git 子进程环境：禁用一切交互式凭据提示。
      否则无凭据（私有仓库未配 token）时 git 会挂在「Username for ...」等待输入，
      表现为「一直卡着不报错」，直到 120s 超时才失败。
      若设置了系统更新代理，则把代理注入 git 环境（HTTPS_PROXY/HTTP_PROXY），
      让 git 的 HTTP 传输经代理走（需求：系统更新优先使用代理）。 */
  _gitEnv() {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GCM_INTERACTIVE: 'never',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no',
    };
    const proxy = this._proxy();
    if (proxy) {
      env.HTTPS_PROXY = proxy;
      env.HTTP_PROXY = proxy;
      env.https_proxy = proxy;
      env.http_proxy = proxy;
      // 不同 git/curl 版本对代理环境变量的支持不一致（尤其 socks 代理常只认 ALL_PROXY）；
      // 一并注入，并清空可能存在的 NO_PROXY，避免 github.com 被意外绕过代理导致“有时能过、有时直连失败”。
      env.ALL_PROXY = proxy;
      env.all_proxy = proxy;
      env.NO_PROXY = '';
      env.no_proxy = '';
    }
    return env;
  }

  /** git 传输层的显式代理参数：用 -c 写进本次命令，最可靠——
   *  只依赖 HTTPS_PROXY/HTTP_PROXY 环境变量时，部分 git/curl 组合（尤其 socks5）不会生效，
   *  表现为“配了代理仍偶尔拉取失败”。这里对 http/https 都显式指定，HTTP 与 SOCKS 代理均可用。 */
  _gitProxyArgs() {
    const proxy = this._proxy();
    if (!proxy) return [];
    return ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`];
  }

  /** 组装一次 fetch 的完整参数（传输层抗抖动参数 + 认证参数 + 兜底超时）。 */
  _buildFetchArgs(gitUrl, branch, { legacyRefs = false } = {}) {
    return [...this._gitProxyArgs(), ...gitTransportArgs({ legacyRefs }), ...this._gitAuthArgs(), 'fetch', gitUrl, branch];
  }

  /** git 拉取（带降级重试）。返回 { ok, code, out, err, attempt, label, tried }。
      逐级降级：HTTP/1.1 → + protocol v0 → 原样再试一次；每次失败都写 WARN 日志，
      让「点更新 → 失败」在页面上留下完整的排查链条，而不是只有一条 exit 128。 */
  async _fetchWithRetry(env, gitUrl, branch) {
    let last = { ok: false, code: '?', out: '', err: '' };
    let tried = 0;
    for (let i = 0; i < FETCH_PLAN.length; i++) {
      const p = FETCH_PLAN[i];
      if (i > 0) {
        this._log('WARN', `拉取失败（exit ${last.code}）：${this._firstLine(last.err || last.out)}`);
        this._log('WARN', `改用「${p.label}」重试（第 ${i + 1}/${FETCH_PLAN.length} 次）…`);
        await sleep(1000 * i);
      }
      tried = i + 1;
      last = await run('git', this._buildFetchArgs(gitUrl, branch, p), {
        cwd: env.gitRoot, timeout: 180000, env: this._gitEnv(),
      });
      if (last.ok) return { ...last, attempt: tried, label: p.label, tried };
    }
    return { ...last, attempt: tried, label: '', tried };
  }

  /** 取报错文本首行（日志里只展示一行，避免刷屏）。 */
  _firstLine(s) {
    return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '无输出';
  }

  /** 针对不同失败原因给出可操作建议（真正能救命的提示都写在这里）。 */
  _logGitAdvice(kind, gitUrl, branch, env) {
    const cmd = `git -c http.version=HTTP/1.1 -c protocol.version=0 fetch ${gitUrl} ${branch}`;
    if (kind === 'http2') {
      this._log('INFO', '该错误来自网络中间设备/代理改写了 HTTP2 连接（curl 16 / expected flush after ref listing）。');
      this._log('INFO', `已自动降级 HTTP/1.1 + protocol v0 重试仍失败，可在${env.inContainer ? '宿主机执行容器的 git，或' : ''}源码目录手动验证：${cmd}`);
      this._log('INFO', '若宿主机同样报错，请检查代理/网关（公司网络、软路由、科学上网工具常改写长连接）。');
    } else if (kind === 'network') {
      this._log('INFO', `无法连接仓库地址，请确认网络与 DNS：${gitUrl}`);
      this._log('INFO', '容器部署请确认容器能访问外网（docker compose 里不要用 host 网络的代理例外）。');
    } else if (kind === 'auth') {
      this._log('INFO', '认证失败：私有仓库请在「更新源配置」里填写 GitHub Token（或设置环境变量 LIVEGRAB_GITHUB_TOKEN）后重试。');
    } else if (kind === 'notfound') {
      this._log('INFO', '仓库不存在或无权限：请核对「更新源配置」中的仓库地址与分支名。');
    } else if (kind === 'unstable') {
      this._log('INFO', '连接被中途断开（网络不稳定）：稍后重试即可，已自动重试 3 次。');
    }
    this._log('INFO', '更新已中止，代码未被改动；可直接再次点击「立即更新」重试。');
  }

  /* ---------- 快照通道（git 传输不可用时的兜底） ---------- */

  /** 快照标记文件放在 .git 内：不进工作区、不出现在 git status、也不会被快照覆盖。 */
  _snapshotPath(env) { return path.join(env.gitRoot, '.git', 'livegrab-snapshot.json'); }

  /** 读取快照标记：存在即表示「工作区是快照通道更新的，.git 索引尚未对齐」。 */
  _readSnapshot(env) {
    if (!env || !env.gitRoot) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this._snapshotPath(env), 'utf8'));
      return raw && raw.commit ? raw : null;
    } catch { return null; }
  }

  _writeSnapshot(env, data) {
    try { fs.writeFileSync(this._snapshotPath(env), JSON.stringify(data, null, 2)); } catch { /* 忽略 */ }
  }

  _clearSnapshot(env) {
    try { fs.rmSync(this._snapshotPath(env), { force: true }); } catch { /* 忽略 */ }
  }

  /** 由配置的仓库地址推导 codeload 归档地址（唯一非 git 的代码获取通道，普通 HTTPS GET）。 */
  _snapshotUrl() {
    let repo = this._repo();
    if (!repo) repo = parseOwnerRepoFromGitHubUrl(this._gitUrl());
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return '';
    return `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(this._branch())}`;
  }

  /** 下载分支归档（tar.gz）。GitHub 私有仓库用 token 认证；非 GitHub 仓库返回 null。
   *  设置了系统更新代理时经代理下载（binary 通道）。 */
  async _downloadSnapshot() {
    const url = this._snapshotUrl();
    if (!url) return null;
    const headers = { 'User-Agent': UA };
    const t = this._token();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const r = await this._fetch(url, { headers, timeoutMs: 180000, label: 'GitHub codeload', binary: true });
    if (!r.ok) throw new Error(`归档下载失败 HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('归档内容为空');
    if (buf.length > 128 * 1024 * 1024) throw new Error('归档过大，已放弃快照通道');
    return buf;
  }

  /** 用归档覆盖工作区（不走 git 传输）。
      安全性：① 只覆盖归档内文件；② 归档里没有、但**旧 commit 跟踪过**的文件才删除
      （用本地 git 对象算出旧清单，绝不误删 node_modules / 运行时产生的未跟踪文件）。 */
  async _applySnapshot(buf, env, latest) {
    const tmp = path.join(os.tmpdir(), `lg-snap-${Date.now()}-${process.pid}`);
    await fsp.mkdir(tmp, { recursive: true });
    try {
      const { files, skipped } = extractTarGzTo(buf, tmp);
      if (!files.length) throw new Error('归档解析后没有任何文件');
      if (!fs.existsSync(path.join(tmp, 'app', 'server', 'server.js')) || !fs.existsSync(path.join(tmp, 'app', 'package.json'))) {
        throw new Error('归档结构异常（缺少 app/server/server.js 或 app/package.json），已放弃');
      }
      let version = '';
      try { version = JSON.parse(fs.readFileSync(path.join(tmp, 'app', 'package.json'), 'utf8')).version || ''; } catch { /* 忽略 */ }

      // 上游删除的文件：按旧 commit 的文件清单推算（本地对象即可算，无需网络）。
      // 必须用 -z：git 默认会 QuotePath（把非 ASCII 路径转义成 "ui/UI\350..."），
      // 那样清单与归档里的真实路径对不上，会算错删除集。
      const removed = [];
      const listed = await run('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: env.gitRoot, env: this._gitEnv() });
      if (listed.ok) {
        const now = new Set(files);
        for (const rel of listed.out.split('\0').filter(Boolean)) {
          if (now.has(rel) || rel.startsWith('app/node_modules/')) continue;
          try { fs.rmSync(path.join(env.gitRoot, rel), { force: true }); removed.push(rel); } catch { /* 忽略 */ }
        }
      }

      // 覆盖式拷贝（目录去重：同一目录只 mkdir 一次）
      let copied = 0;
      const madeDirs = new Set();
      for (const rel of files) {
        const src = path.join(tmp, rel);
        const dst = path.join(env.gitRoot, rel);
        const dir = path.dirname(dst);
        if (!madeDirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); madeDirs.add(dir); }
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, fs.statSync(src).mode); } catch { /* 忽略 */ }
        copied += 1;
      }
      if (version) latest = { ...(latest || {}), version };

      // 记下「快照落地那一刻」的文件清单与内容指纹，供下次联网自愈时判断工作区是否被改过
      const digest = this._contentDigest(env.gitRoot, files);
      this._writeSnapshot(env, {
        commit: (latest && latest.commit) || '',
        tag: (latest && latest.tag) || (version ? `v${version}` : ''),
        version,
        at: Date.now(),
        files: copied,
        removed: removed.length,
        paths: files,
        digest,
      });
      if (skipped.length) this._log('WARN', `归档中有 ${skipped.length} 个条目被跳过（软链/异常路径）`);
      return { copied, removed: removed.length, version, tmp };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  /** 已跟踪文件是否有未提交改动（-uno：容器运行时写入的 data/、config/ 等未跟踪目录不参与）。 */
  async _worktreeDirty(env) {
    const st = await run('git', ['status', '--porcelain', '-uno'], { cwd: env.gitRoot, timeout: 30000, env: this._gitEnv() });
    if (!st.ok) return null;
    return st.out.trim() !== '';
  }

  /** 工作区内容指纹：对给定相对路径逐个取 sha1，再合成一个 sha1。
      为什么不用 git status：「相对旧 HEAD 有改动」是快照更新后的必然状态，而
      `M file` 的文本在文件被再次编辑时并不变化（太粗），无法发现「快照之后有人改过代码」。
      内容指纹则精确到字节，且与平台/换行设置无关。 */
  _contentDigest(root, rels) {
    const h = crypto.createHash('sha1');
    for (const rel of [...rels].sort()) {
      h.update(rel).update('\0');
      try {
        h.update(crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest());
      } catch { h.update('missing'); }
    }
    return h.digest('hex');
  }

  /** 把 .git 索引对齐到刚 fetch 下来的远端（快照通道更新过工作区后的自愈）。
      安全性：用「快照落地时的内容指纹」判定——指纹一致说明工作区自那以后没被改过，
      可以安全 reset --hard；没有指纹（老标记）时退回「必须干净」的保守判据。
      不满足就只记 WARN、不动代码（宁可不自愈，也不覆盖用户的改动）。 */
  async _alignGitToWorktree(env) {
    const snap = this._readSnapshot(env);
    if (snap && Array.isArray(snap.paths) && snap.digest) {
      const now = this._contentDigest(env.gitRoot, snap.paths);
      if (now !== snap.digest) {
        this._log('WARN', '工作区在快照更新之后又被改动过，跳过自动对齐（不覆盖你的改动）');
        return false;
      }
    } else {
      const dirty = await this._worktreeDirty(env);
      if (dirty === null || dirty) {
        this._log('WARN', '工作区有未提交改动，跳过 git 索引对齐（避免覆盖你的改动）');
        return false;
      }
    }
    const reset = await run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: env.gitRoot, timeout: 60000, env: this._gitEnv() });
    if (!reset.ok) {
      this._log('WARN', `git 索引对齐失败：${this._firstLine(reset.err || reset.out)}`);
      return false;
    }
    this._clearSnapshot(env);
    return true;
  }

  async _findGitRoot(dir) {
    let cur = path.resolve(dir);
    for (let i = 0; i < 8; i++) {
      try {
        await fsp.access(path.join(cur, '.git'));
        return cur;
      } catch { /* 继续向上 */ }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  /* ---------- 环境与本地信息 ---------- */

  async detectEnv() {
    const gitBin = await run('which', ['git']).then((r) => (r.ok ? r.out.trim() : ''));
    const dockerBin = await run('which', ['docker']).then((r) => (r.ok ? r.out.trim() : ''));
    const inContainer = await fsp.access('/.dockerenv').then(() => true).catch(() => false);
    const gitRoot = gitBin ? await this._findGitRoot(this.appDir) : null;
    this.state.env = {
      gitAvailable: !!gitBin && !!gitRoot,
      gitBin: gitBin || '',
      gitRoot: gitRoot || '',
      dockerAvailable: !!dockerBin,
      inContainer,
    };
    // 环境自检结果记入日志（每次启动首次检测时一条）：排查「为什么不能在线更新」的第一手信息
    const sig = JSON.stringify(this.state.env);
    if (sig !== this._envSig) {
      this._envSig = sig;
      this._log('INFO', this.state.env.gitAvailable
        ? `更新环境自检：git 可用（仓库 ${this.state.env.gitRoot}${inContainer ? ' · 运行于容器' : ' · 本地运行'}），支持在线更新`
        : `更新环境自检：未检测到 git 仓库${gitBin ? '' : '（系统无 git）'}${inContainer ? ' · 运行于容器' : ' · 本地运行'}，无法在线拉取代码，更新时将给出手动指引`);
    }
    return this.state.env;
  }

  async localInfo() {
    // version 取自 package.json（运行目录的父级或自身）
    let version = '0.0.0';
    try {
      const pkgPath = path.join(this.appDir, 'package.json');
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
      version = pkg.version || version;
    } catch { /* 忽略 */ }

    let commit = '', branch = '', commitAt = null, tag = '';
    const env = this.state.env || await this.detectEnv();
    // 快照标记优先：走快照通道更新过的工作区，其真实代码 = 标记里的 commit，
    // 而 .git 索引还停在旧提交（下次成功 fetch 时会自动对齐），不能拿旧 index 冒充本地版本。
    const snap = env.gitRoot ? this._readSnapshot(env) : null;
    this.state.snapshot = snap || null;
    if (env.gitAvailable && env.gitRoot) {
      const [sha, br, at, tg] = await Promise.all([
        run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: env.gitRoot }),
        run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: env.gitRoot }),
        run('git', ['log', '-1', '--format=%cI', 'HEAD'], { cwd: env.gitRoot }),
        run('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: env.gitRoot }).then((r) => r.ok ? r.out.trim() : ''),
      ]);
      if (sha.ok) commit = sha.out;
      if (br.ok) branch = br.out;
      if (at.ok) commitAt = at.out;
      if (tg.ok) tag = tg.out;
    } else {
      // 容器/无 git：尝试从构建时注入的构建信息读取自身 commit（镜像构建时写入 .build-info.json 或 LIVEGRAB_BUILD_COMMIT），
      // 用于和远程分支 HEAD 做精确比对；拿不到则回退到版本号比对。
      const buildCommit = (process.env.LIVEGRAB_BUILD_COMMIT || '').trim()
        || (await this._readBuildCommit().catch(() => ''));
      if (buildCommit) commit = String(buildCommit).slice(0, 12);
      branch = this._branch();
    }
    if (snap) {
      if (snap.commit) commit = String(snap.commit).slice(0, 12);
      if (snap.tag) tag = snap.tag;
      if (snap.version) version = snap.version;
      if (snap.at) commitAt = new Date(snap.at).toISOString();
      branch = branch || this._branch();
    }
    this.state.local = { version, commit, branch: branch || this._branch(), commitAt, tag: tag || `v${version}` };
    return this.state.local;
  }

  /** 容器/无 git 环境下，从构建信息读取自身 commit（镜像构建时写入 <appDir>/.build-info.json 的 commit 字段）。 */
  async _readBuildCommit() {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.appDir, '.build-info.json'), 'utf8'));
      return raw && raw.commit ? String(raw.commit).trim() : '';
    } catch { return ''; }
  }

  /* ---------- GitHub 最新版本 ---------- */

  /** 探测仓库可见性 + 拉取远程信息。
      两段式：先匿名请求（公开仓库无需 token）；若 404 且配置了 token，带 token 重试（私有仓库）。
      返回 { data, repoPublic, usedToken }。 */
  async _fetchGroup(headers) {
    const api = this._api();
    const branch = this._branch();
    const [rel, tags, main] = await Promise.all([
      this._fetch(`${api}/releases/latest`, { headers, timeoutMs: 15000, label: 'GitHub releases/latest' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      this._fetch(`${api}/tags?per_page=10`, { headers, timeoutMs: 15000, label: 'GitHub tags' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      this._fetch(`${api}/commits/${branch}?per_page=1`, { headers, timeoutMs: 15000, label: 'GitHub commits' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    return { rel, tags, main };
  }

  async fetchRemote() {
    const anonHeaders = { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' };
    // ① 匿名探测：公开仓库直接可读
    let group = await this._fetchGroup(anonHeaders);
    let repoPublic = !!(group.rel || group.tags || group.main);
    let usedToken = false;
    const token = this._token();
    // ② 匿名 404 且配置了 token：私有仓库，带认证重试
    if (!repoPublic && token) {
      group = await this._fetchGroup(this._apiHeaders());
      usedToken = true;
      // 带 token 重试仍失败 = 仓库不存在/网络问题；成功 = 私有仓库（repoPublic 保持 false）
      repoPublic = false;
    }
    const { rel, tags, main } = group;
    const repo = this._repo();
    const branch = this._branch();

    // 仓库不可见（私有但无 token / 仓库不存在）/ 网络失败 / 无任何 release、tag、commit 时，明确标记无法获取（不伪造版本号）
    const anyData = rel || tags || main;
    if (!anyData) {
      this.state.latest = {
        unavailable: true,
        error: 'repo-not-found',
        repo,
        branch,
        releaseUrl: repo ? `https://github.com/${repo}/releases` : '',
        repoPublic: false,
        // 只有「匿名读不到 + 没配 token」才提示需要 token（私有仓库场景）；配了 token 仍读不到 = 仓库真不存在/网络问题
        authHint: usedToken ? '' : 'private-repo-needs-token',
      };
      return this.state.latest;
    }

    // 版本号取「候选标签中语义化版本最高者」，而不是 releases/latest 或 tags[0]：
    // 只推 tag 未发 Release 时 releases/latest 会偏旧，/tags 的顺序也不保证按版本号排列，
    // 直接用它们会把旧版本当成「最新」，进而对已是最新的本地版本误报「可用更新」。
    const candidates = [];
    if (rel && rel.tag_name) candidates.push(rel.tag_name);
    for (const t of (tags || [])) if (t && t.name) candidates.push(t.name);
    const tagName = pickLatestTag(candidates) || (rel && rel.tag_name) || (tags && tags.length && tags[0] && tags[0].name) || '';
    const version = String(tagName || '').replace(/^v/i, '');
    // 权威「最新代码」以分支 HEAD 的 commit sha 为准：release 的 target_commitish 通常只是分支/标签名，
    // 不能用于精确比对（例如 v0.1.0 标签可能指向旧提交，而 main 最新提交才是真正要去比对的）。
    const commit = (main && main.sha) ? main.sha.slice(0, 12) : (rel && rel.target_commitish) || '';
    const commitAt = (main && main.commit && main.commit.committer && main.commit.committer.date) || (rel && rel.published_at) || '';
    const commitMsg = (main && main.commit && main.commit.message || '').split('\n')[0] || '';
    const notes = (rel && rel.body) || '';

    this.state.latest = {
      unavailable: false,
      repoPublic,
      usedToken,
      version: version || '0.0.0',
      tag: tagName || `v${version || '0.0.0'}`,
      commit,
      commitAt,
      commitMsg,
      publishedAt: (rel && rel.published_at) || commitAt || '',
      releaseUrl: (rel && rel.html_url) || (repo ? `https://github.com/${repo}/releases` : ''),
      releaseNotes: notes,
    };
    return this.state.latest;
  }

  /* ---------- 对外：检查更新 ---------- */

  async check(force = false) {
    const now = Date.now();
    if (this.state.checking) return { checking: true, ...this.status() };
    if (!force && this.state.latest && this.state.checkedAt && now - this.state.checkedAt < 5 * 60 * 1000) {
      return this.status();
    }
    this.state.checking = true;
    try {
      await this.localInfo();
      await this.fetchRemote();
      this.state.checkedAt = Date.now();
      // 检查结果记入日志（与上次已记录的结果相同则跳过，避免反复打开更新页刷屏）：
      // 「本地 → 远程」版本链路是排查更新是否生效、版本号是否滞后的依据
      const latest = this.state.latest;
      const local = this.state.local;
      const key = `${local?.version}|${local?.commit}|${latest?.unavailable ? 'unavailable' : latest?.tag}|${latest?.commit || ''}`;
      if (key !== this._lastCheckSig) {
        this._lastCheckSig = key;
        if (latest && latest.unavailable) {
          this._log('WARN', '检查更新：无法获取远程版本信息（仓库不可见或网络异常）');
        } else {
          const hasNew = this._computeHasUpdate(local, latest);
          this._log('INFO', `检查更新：本地 v${local?.version || '?'}${local?.commit ? ` (${local.commit})` : ''} → 远程 ${latest?.tag || '?'}${latest?.commit ? ` (${latest.commit})` : ''}（${hasNew ? '有更新' : '已是最新'}）`);
        }
      }
    } catch (e) {
      this._log('ERR', `检查更新失败：${e.message || e}`);
      throw e;
    } finally {
      this.state.checking = false;
    }
    return this.status();
  }

  /* ---------- 对外：立即更新（后台任务） ---------- */

  async apply() {
    if (this.state.running) {
      return { running: true, message: '更新任务正在进行中' };
    }
    const env = this.state.env || await this.detectEnv();
    const local = this.state.local || await this.localInfo();

    this.state.running = true;
    this.state.phase = 'fetch';
    this.state.progress = 2;
    this.state.task = '';
    this.state.startedAt = Date.now();
    this.state.log = [];
    this._log('INFO', '开始检查 GitHub 更新…');

    // 后台执行，不阻塞响应
    setTimeout(() => { this._runUpdate(env, local).catch(() => {}); }, 0);
    return { running: true, message: '更新任务已启动' };
  }

  async _runUpdate(env, local) {
    try {
      // ① 拉取远端对比
      await this.fetchRemote();
      const latest = this.state.latest;
      this.state.progress = 8;

      // 远程不可见（网络异常/仓库不可达）：不能当作「已是最新」，给出明确指引
      if (latest && latest.unavailable) {
        this._phase('done', 100, '');
        this._log('WARN', '无法获取远程版本信息（仓库不可见或网络异常），本次更新已取消');
        this._log('INFO', '请检查网络连接后重试；私有仓库需配置 LIVEGRAB_GITHUB_TOKEN，容器部署还需确认容器能访问外网');
        return;
      }

      const hasNew = this._computeHasUpdate(local, latest);
      // 上次走过「快照通道」（工作区已更新、.git 索引落后）时，即使没有新版本也要尝试对齐一次
      const snap = env.gitRoot ? this._readSnapshot(env) : null;

      // 没有新版本、也没有待对齐的快照标记：直接结束，不再误报「发现新版本」
      if (!hasNew && !snap) {
        this._phase('done', 100, '');
        this._log('OK', `已是最新版本${local.commit ? `（${local.commit}）` : `（${local.version}）`}，无需更新`);
        return;
      }

      if (hasNew) this._log('INFO', `发现新版本：${latest.tag} (${latest.commit || '?'})`);

      if (!env.gitAvailable) {
        // 容器/无 git：不能伪更新，给手动指引。这是正常的「需手动重建」状态，不是错误。
        // 架构 B 下容器正常启动后自带 .git（/config/src），只有首启克隆失败或镜像过旧才会到这里。
        this._phase('done', 15, '需手动重建镜像更新');
        this._log('WARN', env.inContainer
          ? '容器内未检测到代码仓库（首次启动克隆失败，或镜像过旧未内置 git）'
          : '未检测到可用 git 仓库，无法在线拉取代码');
        const branch = this._branch();
        const gitUrl = this._gitUrl();
      this._log('INFO', env.inContainer
          ? '请检查容器网络；私有仓库需配置 LIVEGRAB_GITHUB_TOKEN。重启容器会重试自动克隆；或在宿主机执行：docker compose up -d --build'
          : `请在源码目录手动执行：git -c http.version=HTTP/1.1 pull ${gitUrl} ${branch} && npm install`);
        this._log('INFO', '已生成手动更新指引。重建并重启容器后生效。');
        this._phase('done', 100, '需手动重建镜像更新');
        return;
      }

      // 更新源完全取自「更新源配置」（UI > 环境变量 > 默认），不写死仓库：
      // 直接以配置的仓库地址作为 fetch 的远端，避免仓库里残留的 origin 指向别处导致拉到旧代码。
      const branch = this._branch();
      const gitUrl = this._gitUrl();
      // ② fetch（传输层抗抖动 + 逐级降级重试 + 认证注入）
      this._phase('fetch', 20, '拉取远端代码');
      this._log('INFO', `准备从更新源拉取代码：${gitUrl}（分支 ${branch}）…`);
      const fetchR = await this._fetchWithRetry(env, gitUrl, branch);

      if (fetchR.ok) {
        this._log('OK', fetchR.attempt > 1 ? `代码拉取成功（第 ${fetchR.attempt} 次尝试 · ${fetchR.label}）` : '代码拉取成功');
        this.state.progress = 40;

        // 快照自愈：上次是快照通道更新的 → 现在能把 .git 对齐到远端了
        if (snap) {
          if (await this._alignGitToWorktree(env)) {
            this._log('OK', `git 索引已对齐到远端（${(latest.commit || '').slice(0, 12)}）：此后本地版本以 git 为准`);
            const nowLocal = await this.localInfo();
            if (!this._computeHasUpdate(nowLocal, latest)) {
              this._phase('done', 100, '');
              this._log('OK', `已是最新代码（${nowLocal.commit || nowLocal.version}），无需更新`);
              return;
            }
          }
        }

        // ③ 对比本地与远端 HEAD（远端 commit 即刚 fetch 下来的 FETCH_HEAD）
        const [cur, remote] = await Promise.all([
          run('git', ['rev-parse', 'HEAD'], { cwd: env.gitRoot, env: this._gitEnv() }),
          run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: env.gitRoot, env: this._gitEnv() }),
        ]);
        const curSha = cur.ok ? cur.out.trim() : '';
        const remoteSha = remote.ok ? remote.out.trim() : '';
        if (curSha && remoteSha && curSha === remoteSha) {
          this._phase('done', 100, '');
          this._log('OK', `已是最新代码（${curSha.slice(0, 12)}），无需更新`);
          return;
        }

        // ④ 本地快进：fetch 已经拿到代码，直接用它快进，不再走第二次网络
        //    （原来的 git pull = fetch + merge，等于把同一段网络再赌一次）
        this._phase('pull', 55, `拉取最新代码 ${branch}`);
        this._log('INFO', `正在更新到 ${latest.tag} (${remoteSha.slice(0, 12)})…`);
        const ffR = await run('git', ['merge', '--ff-only', 'FETCH_HEAD'], { cwd: env.gitRoot, timeout: 60000, env: this._gitEnv() });
        if (!ffR.ok) {
          this._phase('error', 60, '');
          this._log('ERR', `代码更新失败（非快进或本地有改动，exit ${ffR.code}）：${this._firstLine(ffR.err || ffR.out)}`);
          this._log('INFO', `请先提交或暂存本地改动后重试，或手动执行 git -C ${env.gitRoot} pull --ff-only ${gitUrl} ${branch}`);
          this._log('INFO', '代码未被改动；处理完后可直接再次点击「立即更新」重试。');
          return;
        }
        this._log('OK', `代码已更新到 ${latest.tag}`);
        this.state.progress = 75;
      } else {
        // ③ git 传输彻底不可用 → 兜底「快照通道」：普通 HTTPS 下载分支归档覆盖工作区
        //    （只覆盖文件、不动 .git 索引，并用标记记录状态，下次联网自动对齐）
        const kind = classifyGitError(`${fetchR.err}\n${fetchR.out}`);
        this._phase('error', 25, '');
        this._log('ERR', `代码拉取失败（exit ${fetchR.code}；已尝试 ${fetchR.tried} 种拉取方式）：${this._firstLine(fetchR.err || fetchR.out)}`);
        this._logGitAdvice(kind, gitUrl, branch, env);

        if (!hasNew) {
          // 只是为了对齐上次的快照标记：拉不到就先留着，下次联网再对齐
          this._phase('done', 100, '');
          this._log('WARN', '本次未能取到远端代码，快照标记保留，下次联网时会再尝试对齐 git 索引');
          return;
        }

        const snapUrl = this._snapshotUrl();
        if (!snapUrl) {
          this._phase('error', 25, '');
          this._log('WARN', '当前更新源不是 GitHub 仓库地址，快照通道不可用；代码未被改动');
          return;
        }
        this._phase('fetch', 30, '改用快照通道');
        this._log('WARN', `git 传输不可用，改用「快照通道」：普通 HTTPS 下载分支归档 ${snapUrl}`);
        try {
          const buf = await this._downloadSnapshot();
          const info = await this._applySnapshot(buf, env, latest);
          this._log('OK', `快照通道成功：覆盖 ${info.copied} 个文件${info.removed ? `，清理上游已删除的 ${info.removed} 个文件` : ''}（v${info.version || latest.version}）`);
          this._log('WARN', '本次代码由快照通道落地：工作区已是最新，但 .git 索引仍停在旧提交；下次成功联网会自动对齐（再点一次「立即更新」即可触发）');
          // 刷新本地状态：让页面立刻显示「已是最新 + 快照提示」，而不是继续停在「可用更新」
          // （重启钩子失败或未注入时，这一步是页面唯一能反映真实状态的机会）
          await this.localInfo();
          this.state.progress = 75;
        } catch (e) {
          this._phase('error', 25, '');
          this._log('ERR', `快照通道同样失败：${e.message || e}`);
          this._log('INFO', '两条通道都不可用，代码未被改动；网络恢复后可直接再次点击「立即更新」重试。');
          return;
        }
      }

      // ⑤ 安装依赖
      if (env.gitRoot && path.basename(env.gitRoot) === 'app') {
        this._phase('install', 82, '安装依赖');
      } else {
        this._phase('install', 82, '安装依赖（app 目录）');
      }
      this._log('INFO', '安装依赖 npm install --omit=dev…');
      const npmR = await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(env.gitRoot, 'app'), timeout: 300000 });
      if (!npmR.ok) {
        // 退出码非 0 也算警告（npm 偶发警告但 exit 0 属正常）：带 stderr 尾部便于定位
        const detail = (npmR.err || npmR.out || '').split('\n').slice(-3).join(' ').trim();
        this._log('WARN', `依赖安装未成功（exit ${npmR.code}）：${detail || '无输出'}`);
      } else {
        this._log('OK', '依赖安装完成');
      }

      // ⑥ 完成：本地模式优先「拉取后自重启」以加载新版本；无重启钩子时退回手动提示
      if (typeof this.restartHook === 'function') {
        // 先进入「重启中」阶段：旧进程此刻仍在线、HTTP 可正常响应，给前端轮询一个窗口
        // 看到明确的「自动重启中」状态（而非停留在上一阶段的进度条），随后才真正优雅退出。
        this._phase('restart', 92, '正在重启服务');
        this._log('OK', '代码已更新，正在重启服务以加载新版本…');
        await sleep(1500);
        try {
          await this.restartHook({ from: local.version, to: latest.tag }); // 优雅停止 + re-exec（此调用会退出当前进程）
        } catch (e) {
          this._log('WARN', `自动重启失败（${e?.message || e}），请手动重启服务使新版本生效`);
        }
        // 若重启钩子未真正退出进程（如被上层拦截），兜底给手动提示
        this._phase('done', 100, '');
        this._log('INFO', '更新完成。请重启服务使新版本生效。');
        this.state.task = `更新完成 ${latest.tag}`;
        return;
      }
      this._phase('done', 100, '');
      this._log('OK', '更新完成。请重启服务使新版本生效。');
      this.state.task = `更新完成 ${latest.tag}`;
    } catch (e) {
      this._phase('error', 100, '');
      this._log('ERR', `更新失败：${e.message || e}`);
    } finally {
      this.state.running = false;
    }
  }

  /* ---------- 状态输出 ---------- */

  /** 计算是否真的有更新。判据按优先级：
      ① 版本号可比时以语义化版本为准——只有远端「严格更新」才算有更新，
         远端更旧（本地已更新到更高版本）或版本相同一律不算，避免误报「可用更新」；
      ② 版本号相同（或不可解析）时再看 commit：两端 commit 都可得且不同才算有更新
         （覆盖「同版本号但有新提交」的分支 HEAD 领先场景）；
      ③ 都没有则退回原始字符串不等比较（旧镜像无构建信息的兜底）。 */
  _computeHasUpdate(local, latest) {
    if (!latest || latest.unavailable) return false;
    const lv = parseVersion(local && local.version);
    const rv = parseVersion(latest && latest.version);
    const lc = local && local.commit ? String(local.commit).slice(0, 12) : '';
    const rc = latest && latest.commit ? String(latest.commit).slice(0, 12) : '';
    if (lv && rv) {
      const cmp = cmpParsedVersion(rv, lv);
      if (cmp > 0) return true;   // 远端版本严格更高 → 有更新
      if (cmp < 0) return false;  // 远端版本更低（本地更新）→ 不提示更新
      return !!(lc && rc && lc !== rc); // 版本相同：仅当提交确实不同才提示
    }
    if (lc && rc) return lc !== rc;
    return !!(latest.version && local && local.version && latest.version !== local.version);
  }

  status() {
    const s = this.state;
    const now = Date.now();
    return {
      env: s.env || null,
      local: s.local || null,
      latest: s.latest || null,
      checkedAt: s.checkedAt || 0,
      checking: !!s.checking,
      running: !!s.running,
      phase: s.phase,
      progress: s.progress,
      task: s.task,
      startedAt: s.startedAt || 0,
      elapsedSec: s.startedAt ? Math.round((now - s.startedAt) / 1000) : 0,
      log: s.log,
      hasUpdate: this._computeHasUpdate(s.local, s.latest),
      remoteUnavailable: !!(s.latest && s.latest.unavailable),
      // 快照通道状态：非空表示工作区由 tar.gz 快照更新、.git 索引待对齐（前端据此提示）
      snapshot: s.snapshot || null,
      repo: this._repo(),
      gitUrl: this._gitUrl(),
      branch: this._branch(),
      tokenConfigured: !!this._token(),
      authHint: !!(s.latest && s.latest.authHint) ? s.latest.authHint : '',
    };
  }
}
