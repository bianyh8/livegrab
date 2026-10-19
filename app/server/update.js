/* LiveGrab · server/update.js —— 更新管理器
   职责：① 读取本地版本信息（容器：版本标记 .livegrab-version.json / 构建信息；本地：package.json + git）；
   ② 从「更新源配置」指定的仓库（UI 配置 > 环境变量 > 内置默认）经 GitHub API 拉取最新版本，做对比；
   ③ 「立即更新」后台任务：容器内下载 GitHub 归档解包切换，本地 git 工作区走增量 fetch；
   ④ 内存态更新进度与日志（前端轮询 /api/update/status 获取）。
   日志约定：所有更新事件（环境自检/网络路径/检查对比/下载/安装/重启）都经 _log 同步写入日志文件
   （前缀 [更新]，与「运行日志」页同一套 logger）；检查结果相同不重复记，避免刷屏。
   设计约定（v0.1.43 起）：
     · 部署不联网——镜像里已有完整源码，首启直接用 /app 启动，不 clone、不装依赖、不涉及 git；
     · 容器内更新 = 下载该提交的 tar.gz 归档 → 解包到运行目录旁的暂存区 → 整目录原子替换运行目录 → 自重启，
       全程不需要 git，也就不存在「首次必须联网拿到 .git」这个前提；
     · 只有远端语义化版本严格更高才更新，版本相同一律不动（不重复下载同版本归档）；
     · 代理只有一个入口（页面「系统设置 → 平台账号 → 网络代理」）：配了先走代理，代理失败立刻
       改直连并冷却 2 分钟，日志逐次写明走的是代理还是直连；本模块零第三方依赖。 */

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
/** 代理失败后的直连冷却时间：这段时间内不再尝试代理，避免每次请求都先卡一遍代理超时。 */
const PROXY_COOLDOWN_MS = 120 * 1000;

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
  constructor({ appDir, logger, token, restart, getRepoConfig, getProxy, srcRoot, imageApp } = {}) {
    this.appDir = appDir || process.cwd();
    this.logger = logger || null;
    // 更新完成后的自重启钩子：由 server.js 注入优雅停止 + re-exec 逻辑。
    // 容器内切换目录后必须用新目录重启，故钩子支持 { cwd }（见 archive 通道）。
    this.restartHook = (typeof restart === 'function') ? restart : null;
    // 动态配置来源：server.js 注入 store.settings.customize 读取函数；
    // 用户未在 UI 配置时回退到环境变量 / 默认值。
    this.getRepoConfig = (typeof getRepoConfig === 'function') ? getRepoConfig : null;
    // 系统更新代理来源：server.js 注入读取 store.settings.proxy 的函数。
    // 唯一入口就是页面「系统设置 → 平台账号 → 网络代理」——容器环境变量不再参与，
    // 这样「配一处、两处生效」的歧义消失，日志也能明确说出走的是哪条路。
    this.getProxy = (typeof getProxy === 'function') ? getProxy : null;
    // 容器内新版本的落位目录（entrypoint 注入 LIVEGRAB_SRC_DIR，默认 ${CONFIG_DIR}/src）
    // v0.1.52 起这里只用于「还在跑镜像内置代码」的老形态兜底，正常运行走下面 runDir
    this.srcRoot = String(srcRoot || process.env.LIVEGRAB_SRC_DIR || '').trim();
    // 镜像内置代码目录（依赖基线与「未更新过」时的运行目录）
    this.imageApp = String(imageApp || process.env.LIVEGRAB_IMAGE_APP || '').trim();
    // 运行目录 = 进程 cwd（entrypoint 先 cd 到这里再 exec）：更新就是替换「正在跑的这一份」
    this.runDir = path.resolve(this.appDir);
    // 依赖基线目录（entrypoint 注入 LIVEGRAB_DEPS_DIR，默认 /opt/node_modules）：
    // 代码目录里只放软链，更新时整目录替换也不会碰到依赖（见 _baselineNodeModules/_linkNodeModules）
    this.depsDir = String(process.env.LIVEGRAB_DEPS_DIR || '').trim();
    // 兜底 token：显式传入 > 环境变量 LIVEGRAB_GITHUB_TOKEN > 本地 ~/.git-credentials
    this.envToken = token || process.env.LIVEGRAB_GITHUB_TOKEN || readGitCredentialsToken() || '';
    this.state = {
      env: null,            // { mode, gitAvailable, gitRoot, dockerAvailable, inContainer, srcRoot }
      local: null,          // { version, commit, branch, commitAt, tag }
      latest: null,         // { version, tag, commit, commitAt, commitMsg, publishedAt, releaseUrl, releaseNotes }
      checkedAt: 0,
      checking: false,
      running: false,       // 更新任务进行中
      phase: 'idle',        // idle|fetch|pull|install|switch|restart|done|error
      progress: 0,          // 0-100
      task: '',             // 当前构建/更新任务描述
      startedAt: 0,
      log: [],              // [{ts, level, msg}]
    };
    this._envSig = '';       // 环境自检结果签名（相同则不重复记日志）
    this._lastCheckSig = ''; // 最近一次已记录检查结果的签名（相同则不重复记日志）
    this._proxyCooldownUntil = 0; // 代理失败后的直连冷却截止时间
    this._lastPathSig = '';  // 最近一次记录过的网络路径（代理地址 / direct），用于日志去重
    this._staleGitSig = '';  // 最近一次记录过的「归档模式下残留旧 .git」日志签名（去重，避免刷屏）
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

  /** 系统更新代理地址：唯一来源是页面「系统设置 → 平台账号 → 网络代理」。
   *  不再回退容器环境变量（v0.1.43 起 compose 不注入任何代理变量）：代理只在一处维护，
   *  排查时不需要再判断「这条链路到底读的是环境变量还是页面设置」。
   *  不能用 HTTP_PROXY 环境变量做回退——ffmpeg 会读它，会让「平台代理开关」失效。 */
  _proxy() {
    const v = (this.getProxy && this.getProxy()) || '';
    return v ? normalizeProxy(v) : '';
  }

  /** 本次请求实际走的网络路径（写进日志，回答「到底用没用代理」）。 */
  _netPath() {
    const p = this._proxy();
    return p ? `经代理 ${p}` : '直连（未配置更新代理）';
  }

  /** 记录一次网络路径。同一路径只记一次（避免每次检查刷屏），切换代理/回退直连时会重新记。 */
  _noteNetPath(prefix = '更新网络路径') {
    const p = this._proxy();
    const sig = p ? `proxy:${p}` : 'direct';
    if (sig === this._lastPathSig) return;
    this._lastPathSig = sig;
    this._log('INFO', `${prefix}：${p ? `经代理 ${p}` : '直连（未配置更新代理）'}`);
  }

  /** 统一 HTTP GET：配了代理先走代理，代理失败立刻改直连（并冷却 2 分钟）；没配代理直接直连。
   *  返回 Response 兼容对象（ok/status/json/text/arrayBuffer），调用方无需关心底层是否走代理。
   *  binary=true 用于下载 tar.gz 归档（按字节取，不能按文本解码）。 */
  async _fetch(url, opts = {}) {
    const { headers = {}, timeoutMs = 15000, retries = 2, label = '', binary = false } = opts;
    const proxy = this._proxy();
    if (!proxy) return this._fetchDirect(url, { headers, timeoutMs });
    if (Date.now() < this._proxyCooldownUntil) return this._fetchDirect(url, { headers, timeoutMs });
    try {
      return await this._fetchViaProxy(url, proxy, { headers, timeoutMs, retries, label, binary });
    } catch (e) {
      // 代理挂了（连不上/被拒/隧道失败）：不是错误，只是这条路不通——改直连并冷静一会儿，
      // 否则每次检查都要先卡满一次代理超时，页面表现为「检查更新特别慢」。
      this._proxyCooldownUntil = Date.now() + PROXY_COOLDOWN_MS;
      this._lastPathSig = 'direct';
      this._log('WARN', `代理不可用（${this._firstLine(e.message || e)}），本次改用直连；${Math.round(PROXY_COOLDOWN_MS / 1000)} 秒内不再尝试代理`);
      return this._fetchDirect(url, { headers, timeoutMs: Math.max(timeoutMs, 20000) });
    }
  }

  _fetchDirect(url, { headers = {}, timeoutMs = 15000 } = {}) {
    return fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async _fetchViaProxy(url, proxy, { headers = {}, timeoutMs = 15000, retries = 2, label = '', binary = false } = {}) {
    // 502/504 视为「代理本身不可用」（CONNECT 隧道失败时常见），交给上层回退直连；
    // 其余状态码（404/403 等）是远端的真实回答，不能当成代理故障。
    const bad = (status) => status === 502 || status === 504;
    if (binary) {
      const r = await httpGetBufferViaProxy(url, { headers, timeoutMs, retries, logger: this.logger, label, proxy });
      if (bad(r.status)) throw new Error(`代理返回 HTTP ${r.status}`);
      const buf = r.buffer;
      return {
        ok: r.ok, status: r.status, statusText: '', headers: r.headers,
        json: async () => JSON.parse(buf.toString('utf8')),
        text: async () => buf.toString('utf8'),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    const r = await httpGetViaProxy(url, { headers, timeoutMs, retries, logger: this.logger, label, proxy });
    if (bad(r.status)) throw new Error(`代理返回 HTTP ${r.status}`);
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
      this._log('INFO', '需要在页面「系统设置 → 平台账号 → 网络代理」里配置代理？配好后重试即可（失败会自动改直连）。');
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

  /** 容器内新版本的落位根目录（其下 app/ 就是下次启动要运行的代码）。
   *  只有容器才默认 ${CONFIG_DIR}/src —— 本地运行即便设了 CONFIG_DIR，也不该走归档通道
   *  （那会用标签归档覆盖开发者的工作区，完全不是想要的行为）。 */
  _srcRoot(inContainer = false) {
    if (this.srcRoot) return this.srcRoot;
    if (!inContainer) return '';
    const cfg = String(process.env.CONFIG_DIR || '').trim();
    return cfg ? path.join(cfg, 'src') : '';
  }

  /** 更新落位目标：替换「正在跑的那一份」代码目录（进程 cwd 自身——entrypoint 保证 cd 到运行目录再 exec）。
   *  落位位置永远等于运行位置，所以不会出现「宿主上更新、容器里跑的却是另一份」。
   *
   *  唯一例外：当前跑的正是镜像内置代码（老镜像还没部署运行目录就点了更新）——
   *  镜像层目录不能整目录改名（挂载点 EBUSY / overlayfs EXDEV），而且写进去会随容器重建蒸发，
   *  故退回历史位置 ${CONFIG_DIR}/src/app；用新镜像重建容器后由运行目录（默认 /opt/.run）接管。 */
  _runTarget() {
    const runDir = this.runDir;
    const imageApp = path.resolve(this.imageApp || '/app');
    if (runDir === imageApp) {
      const legacyRoot = this.srcRoot || this._srcRoot(true);
      if (!legacyRoot) throw new Error('无法确定新版本落位目录（LIVEGRAB_SRC_DIR / CONFIG_DIR 均缺失）');
      return { runDir, target: path.join(legacyRoot, 'app'), root: legacyRoot, name: 'app', legacyImage: true };
    }
    return { runDir, target: runDir, root: path.dirname(runDir), name: path.basename(runDir), legacyImage: false };
  }

  /** 运行形态：
   *    archive —— 容器部署：代码在 ${CONFIG_DIR}/src/app 或镜像 /app，更新靠 GitHub 归档解包，不需要 git；
   *    git     —— 本地开发：有 .git 工作区，走增量 fetch；
   *    none    —— 本地且无 git：无法在线更新，只给手动步骤。 */
  _mode(env = this.state.env) {
    if (!env) return 'none';
    if (env.mode) return env.mode;
    return env.gitAvailable ? 'git' : 'none';
  }

  async detectEnv() {
    const gitBin = await run('which', ['git']).then((r) => (r.ok ? r.out.trim() : ''));
    const dockerBin = await run('which', ['docker']).then((r) => (r.ok ? r.out.trim() : ''));
    const inContainer = await fsp.access('/.dockerenv').then(() => true).catch(() => false);
    const gitRoot = gitBin ? await this._findGitRoot(this.appDir) : null;
    const srcRoot = this._srcRoot(inContainer);
    // 容器（或调用方显式指定了落位目录）→ 归档通道；其余仍是 git 语义，本地开发行为不变
    const mode = (inContainer || srcRoot) ? 'archive'
      : (gitBin && gitRoot ? 'git' : 'none');
    this.state.env = {
      mode,
      gitAvailable: !!gitBin && !!gitRoot,
      gitBin: gitBin || '',
      gitRoot: gitRoot || '',
      dockerAvailable: !!dockerBin,
      inContainer,
      srcRoot: mode === 'archive' ? srcRoot : '',
      imageApp: this.imageApp || '',
      runDir: this.runDir,
      depsDir: this.depsDir || '',
    };
    // 环境自检结果记入日志（每次启动首次检测时一条）：排查「为什么不能在线更新」的第一手信息
    const sig = JSON.stringify(this.state.env);
    if (sig !== this._envSig) {
      this._envSig = sig;
      const where = inContainer ? '运行于容器' : '本地运行';
      if (mode === 'archive') {
        let landing = `运行目录 ${this.runDir}`;
        try { const t = this._runTarget(); if (t.legacyImage) landing = `${t.runDir}（镜像内置代码）→ 新版本落位 ${t.target}`; } catch { /* 无法确定时保持默认描述 */ }
        this._log('INFO', `更新环境自检：更新走 GitHub 归档（${where}，${landing}），无需 git`);
      } else if (mode === 'git') {
        this._log('INFO', `更新环境自检：git 可用（仓库 ${gitRoot} · ${where}），支持增量更新`);
      } else {
        this._log('INFO', `更新环境自检：未检测到 git 仓库${gitBin ? '' : '（系统无 git）'}（${where}），无法在线拉取代码，更新时将给出手动指引`);
      }
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
    // 本地代码那次提交的「提交时间」：只来自标记里的 commitAt（远端 API 给的时间）。
    // 不能拿标记的 at（落位时间）顶替——那样远端提交永远比本地「旧」，会把所有更新都挡掉。
    let commitDate = '';
    const env = this.state.env || await this.detectEnv();
    // 落位标记：容器归档通道更新时写在 <appDir>/.livegrab-version.json，记录「本次真正落位的那次提交」。
    // 先无脑读出来：归档模式下它比工作区里可能残留的 .git 更权威（原因见下面的 staleGit）。
    const marker = this._readVersionMarker(this.appDir);
    this.state.versionMarker = marker || null;
    // 快照标记优先：走快照通道更新过的工作区，其真实代码 = 标记里的 commit，
    // 而 .git 索引还停在旧提交（下次成功 fetch 时会自动对齐），不能拿旧 index 冒充本地版本。
    const snap = env.gitRoot ? this._readSnapshot(env) : null;
    this.state.snapshot = snap || null;
    // 归档通道（容器部署）同理，且更隐蔽：容器更新走 tar.gz 归档、从不碰 .git，所以容器里若残留一个
    // 早先 clone 出来的工作区，它的 HEAD 会永远停在旧提交 → 「已部署」显示旧 commit、反复提示「可用更新」、
    // 点更新却什么都不做（自己和自己比，commit 永远不同）。判据：归档模式 + 有落位标记 → 以标记为准。
    const staleGit = !!(this._mode(env) === 'archive' && marker && env.gitAvailable && env.gitRoot);
    if (staleGit) await this._logStaleGit(env, marker);
    if (env.gitAvailable && env.gitRoot && !staleGit) {
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
      // 容器/无 git：版本以「页面更新落位时写入的标记」为准（.livegrab-version.json，
      // 里面记的是 GitHub 标签版本，容器里没有 .git 时这就是唯一权威来源）；
      // 从没更新过（用的是镜像代码）则回退构建信息（.build-info.json / LIVEGRAB_BUILD_COMMIT）。
      if (marker) {
        if (marker.version) version = String(marker.version);
        if (marker.commit) commit = String(marker.commit).slice(0, 12);
        if (marker.tag) tag = String(marker.tag);
        // commitAt 优先用「那次提交的时间」（v0.1.44 起写入），老标记只有 at（落位时间）就只用于显示
        if (marker.commitAt) { commitDate = new Date(marker.commitAt).toISOString(); commitAt = commitDate; }
        else if (marker.at) commitAt = new Date(marker.at).toISOString();
      } else {
        const buildCommit = (process.env.LIVEGRAB_BUILD_COMMIT || '').trim()
          || (await this._readBuildCommit().catch(() => ''));
        if (buildCommit) commit = String(buildCommit).slice(0, 12);
      }
      branch = this._branch();
    }
    if (snap && !staleGit) {
      if (snap.commit) commit = String(snap.commit).slice(0, 12);
      if (snap.tag) tag = snap.tag;
      if (snap.version) version = snap.version;
      if (snap.at) commitAt = new Date(snap.at).toISOString();
      branch = branch || this._branch();
    }
    this.state.local = { version, commit, branch: branch || this._branch(), commitAt, commitDate, tag: tag || `v${version}` };
    return this.state.local;
  }

  /** 归档模式下发现「残留的旧 .git 工作区」时记一条日志（同一仓库+标记只记一次，避免刷屏）。
      容器里的更新走 tar.gz 归档、不碰 .git，这种 .git 会永远停在旧提交，只能当诊断信息、不能当版本依据。 */
  async _logStaleGit(env, marker) {
    const key = `${env.gitRoot}|${(marker && marker.commit) || ''}`;
    if (this._staleGitSig === key) return;
    this._staleGitSig = key;
    const head = await run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: env.gitRoot, env: this._gitEnv() });
    const headSha = head.ok ? head.out.trim() : '';
    this._log('INFO', `本地版本以落位标记为准（${(marker && (marker.tag || `v${marker.version}`)) || '?'}`
      + `${marker && marker.commit ? ` / ${String(marker.commit).slice(0, 12)}` : ''}）；`
      + `工作区里的 git 仓库（${env.gitRoot}）仍停在旧提交${headSha ? ` ${headSha}` : ''}`
      + '——容器更新走归档通道、不维护 .git，故不拿它当版本依据');
  }

  /** 容器/无 git 环境下，从构建信息读取自身 commit（镜像构建时写入 <appDir>/.build-info.json 的 commit 字段）。 */
  async _readBuildCommit() {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.appDir, '.build-info.json'), 'utf8'));
      return raw && raw.commit ? String(raw.commit).trim() : '';
    } catch { return ''; }
  }

  /** 读取「页面立即更新」落位时写入的标记（<appDir>/.livegrab-version.json）。
   *  容器里没有 .git，这份标记就是「当前跑的到底是哪一次提交」的权威来源：
   *  commit / commitAt 是判据，version 只是给人看的（取自归档内 package.json 的真实版本）。 */
  _readVersionMarker(dir = this.appDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '.livegrab-version.json'), 'utf8'));
      return raw && (raw.version || raw.tag) ? raw : null;
    } catch { return null; }
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
    // 权威「最新代码」= 分支 HEAD 的 commit sha（完整 40 位，下载归档要用）。
    // release 的 target_commitish 通常只是分支/标签名，绝不能当 sha 用：那会让 commit 比对比到
    // 「分支名 vs sha」这种永远不等的组合。取不到就留空，比对自动退回版本号。
    const commitFull = (main && main.sha) ? String(main.sha) : '';
    const commit = commitFull.slice(0, 12);
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
      commitFull,
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
      this._noteNetPath('检查更新的网络路径');
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
          this._log('INFO', `检查更新：本地 v${local?.version || '?'}${local?.commit ? ` (${local.commit})` : ' (无 commit 记录)'} → 远程 ${latest?.tag || '?'}${latest?.commit ? ` (${latest.commit})` : ''}（${hasNew ? '有更新' : '已是最新'}）`);
          // 容器里判据是 commit：本地没有 commit 记录时无法精确比对，明说原因，别让人猜
          if (this._mode() === 'archive' && !(local && local.commit) && latest && latest.commit) {
            this._log('WARN', '本地未记录 commit（镜像构建时未传 BUILD_COMMIT）：按「有更新」处理，更新一次后即以 commit 精确比对');
          }
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
      // 先写清这次拉取走的是代理还是直连（排查「配了代理还是慢/失败」的第一手信息）
      this._noteNetPath();
      // 容器部署：归档通道（不需要 git，也不碰 .git）
      if (this._mode(env) === 'archive') {
        await this._runArchiveUpdate(env, local);
        return;
      }

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
        // 走到这里只剩「本地运行且没有 git 工作区」：容器部署早已由归档通道接管。
        // 不能伪更新，给手动步骤（这不是错误，属于部署方式限制）。
        this._phase('done', 15, '需手动更新');
        this._log('WARN', '未检测到可用 git 工作区，无法在线更新（容器部署不受影响：容器走归档通道）');
        const branch = this._branch();
        const gitUrl = this._gitUrl();
        this._log('INFO', `请在源码目录手动执行：git -c http.version=HTTP/1.1 pull ${gitUrl} ${branch} && npm install`);
        this._log('INFO', '已生成手动更新指引。更新后重启服务即可生效。');
        this._phase('done', 100, '需手动更新');
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

  /* ---------- 容器更新通道：GitHub 归档（不需要 git） ---------- */

  /** 某个标签的源码归档地址（GitHub codeload，普通 HTTPS GET）。非 GitHub 仓库返回空。 */
  _tagArchiveUrl(tag) {
    let repo = this._repo();
    if (!repo) repo = parseOwnerRepoFromGitHubUrl(this._gitUrl());
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return '';
    const t = String(tag || '').trim();
    if (!t) return '';
    return `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(t)}`;
  }

  /** 某个提交的源码归档地址——版本判定改成「比 commit」后，这里才是主路径：
   *  标签只是可读的名字，同一个标签可能被挪动、也可能比 main HEAD 旧，只有 sha 指向确定的代码。
   *  取不到 sha（远端 API 没返回 commit）时才退回标签归档（见 _archiveUrlFor）。 */
  _commitArchiveUrl(sha) {
    let repo = this._repo();
    if (!repo) repo = parseOwnerRepoFromGitHubUrl(this._gitUrl());
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return '';
    const s = String(sha || '').trim();
    if (!/^[0-9a-f]{7,40}$/i.test(s)) return '';
    return `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(s)}`;
  }

  /** 优先按 commit 取归档，退化才用标签。返回 { url, label, ref }。 */
  _archiveUrlFor(latest) {
    const sha = String((latest && (latest.commitFull || latest.commit)) || '').trim();
    const byCommit = this._commitArchiveUrl(sha);
    if (byCommit) return { url: byCommit, label: `提交 ${sha.slice(0, 8)}`, ref: sha };
    const tag = String((latest && latest.tag) || '').trim();
    const byTag = this._tagArchiveUrl(tag);
    if (byTag) return { url: byTag, label: `标签 ${tag}`, ref: tag };
    return { url: '', label: '', ref: '' };
  }

  /** 依赖声明签名（只比 dependencies 的键与版本要求）：相同就能直接复用镜像的 node_modules。 */
  _depSignature(pkg) {
    const d = (pkg && pkg.dependencies) || {};
    return Object.keys(d).sort().map((k) => `${k}@${d[k]}`).join('|');
  }

  _currentPkg() {
    try { return JSON.parse(fs.readFileSync(path.join(this.appDir, 'package.json'), 'utf8')); } catch { return {}; }
  }

  /** 可复用的依赖基线（物理目录）：代码目录里只放软链，更新时整目录替换也不会碰到依赖。
   *  优先级：正在用的那份（软链解析后的真实目录）→ LIVEGRAB_DEPS_DIR → /opt/node_modules
   *          → 镜像 /app/node_modules → 运行目录自身。 */
  _baselineNodeModules() {
    const used = path.join(this.runDir, 'node_modules');
    const cands = [];
    try { cands.push(fs.realpathSync(used)); } catch { /* 还没装或软链悬空 */ }
    if (this.depsDir) cands.push(this.depsDir);
    cands.push('/opt/node_modules');
    if (this.imageApp) cands.push(path.join(this.imageApp, 'node_modules'));
    cands.push('/app/node_modules');
    cands.push(used);
    const seen = new Set();
    for (const p of cands) {
      if (!p || seen.has(p)) continue;
      seen.add(p);
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'better-sqlite3'))) return p;
      } catch { /* 试下一个 */ }
    }
    return '';
  }

  /** 给新版本目录准备 node_modules：软链到依赖基线（零复制、零联网）。
   *  极少数文件系统不支持软链时退回复制。avoidDir = 即将被替换掉的那个目录：
   *  基线若落在它内部，软链在切换后会指向自己（成环），这种情况直接复制。 */
  _linkNodeModules(appDir, avoidDir = '') {
    const target = this._baselineNodeModules();
    if (!target) throw new Error('找不到可复用的 node_modules 基线（依赖目录缺失）');
    this._depsBaselineUsed = target;
    const link = path.join(appDir, 'node_modules');
    fs.rmSync(link, { recursive: true, force: true });
    const inside = !!avoidDir && (target === avoidDir || target.startsWith(avoidDir + path.sep));
    if (!inside) {
      try {
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        return 'link';
      } catch { /* 继续退回复制 */ }
    }
    fs.cpSync(target, link, { recursive: true, dereference: true });
    return 'copy';
  }

  /** npm install：只有依赖声明变了才走这里；npm 用 npm_config_* 走代理（ffmpeg 不读这两个键）。 */
  _npmInstall(dir) {
    const env = { ...process.env };
    const proxy = this._proxy();
    if (proxy) {
      env.npm_config_proxy = proxy;
      env.npm_config_https_proxy = proxy;
    }
    return run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, timeout: 300000, env });
  }

  /** 下载源码归档（tar.gz，按 commit 或标签）。私有仓库带 token；走代理失败会自动直连（见 _fetch）。 */
  async _downloadArchive(url, label) {
    const headers = { 'User-Agent': UA };
    const t = this._token();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const r = await this._fetch(url, { headers, timeoutMs: 300000, retries: 1, label: `GitHub 归档 ${label}`, binary: true });
    if (!r.ok) {
      throw new Error(`归档下载失败 HTTP ${r.status}${r.status === 404 ? '（提交/标签不存在，或私有仓库未配 Token）' : ''}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('归档内容为空');
    if (buf.length > 128 * 1024 * 1024) throw new Error('归档过大（>128MB），已放弃');
    return buf;
  }

  /** 原子切换：cur → cur.old，newApp → cur；失败自动回滚，保证「更新失败 = 服务照常跑」。
   *  成功后的旧目录不立刻删：此刻进程 cwd 还指着它，删掉会让「重启失败」失去退路；
   *  留着当手动回滚点（`mv .run.old .run`），下次更新开头才会被替换掉。
   *
   *  个别环境不允许对目标整目录改名（运行目录被挂成宿主 bind mount → EBUSY，跨文件系统 → EXDEV）：
   *  退回「备份 + 逐文件覆盖」，功能一致，只是切换不是原子操作。 */
  _swapIn(newApp, target, oldDir) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(oldDir, { recursive: true, force: true });
    const hadCur = fs.existsSync(target);
    let moved = false; // 旧目录是否已改名挪走（失败时要挪回来）
    try {
      if (hadCur) { fs.renameSync(target, oldDir); moved = true; }
      fs.renameSync(newApp, target);
      return { target, how: 'rename' };
    } catch (e) {
      if (moved) {
        try { fs.renameSync(oldDir, target); } catch { /* 挪不回来也没关系：旧目录还在 <target>.old */ }
      }
      if (!hadCur) throw new Error(`切换新版本失败：${e.message}`);
      this._log('WARN', `运行目录不能整目录改名（${e.code || e.message}），改用「备份 + 覆盖」方式切换`);
    }
    // 覆盖式切换：先把旧目录整体备份（留着回滚），再把新版本逐项覆盖进去
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.cpSync(target, oldDir, { recursive: true, dereference: false });
    const names = fs.readdirSync(newApp);
    for (const n of names) {
      const src = path.join(newApp, n);
      const dst = path.join(target, n);
      // 依赖由新版本目录说了算（通常是软链指向基线），旧的先删掉，避免新旧混在一起
      if (n === 'node_modules') fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true, force: true, dereference: false });
    }
    // 新版本里已不存在的旧文件也清掉（递归比对，含子目录里的残留），别把上一版留在运行目录
    const relFiles = (base, sub = '', out = []) => {
      for (const e of fs.readdirSync(path.join(base, sub), { withFileTypes: true })) {
        const rel = sub ? `${sub}/${e.name}` : e.name;
        if (e.isDirectory()) relFiles(base, rel, out);
        else out.push(rel);
      }
      return out;
    };
    const fresh = new Set(relFiles(newApp));
    for (const rel of relFiles(target)) {
      if (rel === 'node_modules' || rel.startsWith('node_modules/')) continue; // 依赖与代码无关，保留
      if (!fresh.has(rel)) fs.rmSync(path.join(target, rel), { recursive: true, force: true });
    }
    fs.rmSync(newApp, { recursive: true, force: true });
    return { target, how: 'copy' };
  }

  /** 容器内更新：查远端 HEAD →（commit 不同才）下载该提交的归档 → 解包校验 → 组装 → 原子切换 → 自重启。
   *  commit 相同则什么都不下载、不重启，日志写一条「已是最新代码」。 */
  async _runArchiveUpdate(env, local) {
    // 落位目标 =「正在跑的那一份」目录（整目录替换，重启后仍是它）
    const t = this._runTarget();
    if (t.legacyImage) {
      this._log('WARN', `当前跑的是镜像内置代码（${t.runDir}）：镜像层目录不能整目录替换，新版本落位到 ${t.target}，重启后运行它；用新镜像重建容器后会自动改用运行目录`);
    }

    await this.fetchRemote();
    const latest = this.state.latest;
    this.state.progress = 8;
    if (latest && latest.unavailable) {
      this._phase('done', 100, '');
      this._log('WARN', '无法获取远程版本信息（仓库不可见或网络异常），本次更新已取消');
      this._log('INFO', '请检查网络后重试；私有仓库需在「更新源配置」填 GitHub Token（或环境变量 LIVEGRAB_GITHUB_TOKEN）');
      return;
    }
    if (!this._computeHasUpdate(local, latest)) {
      this._phase('done', 100, '');
      this._log('OK', `已是最新代码${latest.commit ? `（${latest.commit}）` : ` v${local.version}`}，无需更新`);
      return;
    }

    const { url, label, ref } = this._archiveUrlFor(latest);
    if (!url) throw new Error('更新源不是 GitHub 仓库，无法下载源码归档');
    const from = `v${local.version || '?'}${local.commit ? ` / ${local.commit}` : ' · 未记录 commit'}`;
    this._log('INFO', `发现新代码 ${label}（远端标签 ${latest.tag}，本地 ${from}），开始下载源码归档…`);
    this._phase('fetch', 20, `下载 ${label}`);
    const buf = await this._downloadArchive(url, label);
    const mb = buf.length / 1048576;
    this._log('OK', `归档下载完成（${mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(buf.length / 1024))} KB`}）`);

    // 解包到落位目标旁的暂存区：与之同一盘、同一层，后面才能用 rename 原子切换
    const stage = `${t.target}.stage`;
    const stageApp = path.join(stage, 'app');
    this._phase('pull', 45, '解包并校验');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    let depsInstalled = false;
    try {
      const info = extractTarGzTo(buf, stage);
      if (!fs.existsSync(path.join(stageApp, 'server', 'server.js')) || !fs.existsSync(path.join(stageApp, 'package.json'))) {
        throw new Error('归档结构异常（缺少 app/server/server.js 或 app/package.json），已放弃');
      }
      this._log('OK', `解包完成：${info.files.length} 个文件`);

      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(stageApp, 'package.json'), 'utf8')); } catch { /* 忽略 */ }
      const pkgVersion = String(pkg.version || '');
      if (pkgVersion) this._log('INFO', `归档内 package.json 版本 v${pkgVersion}`);
      // 版本号只用于展示，不参与判定（判据是 commit）：落后只提示一句，不拦更新
      if (pkgVersion && parseVersion(pkgVersion) && compareVersions(pkgVersion, local.version) < 0) {
        this._log('WARN', `归档内版本 v${pkgVersion} 低于本地 v${local.version}：按提交判定继续更新（版本号可能只是忘了改）`);
      }

      // 依赖：声明没变就复用镜像基线（这是绝大多数版本的情况，更新全程只访问 GitHub，不碰 npm registry）
      const depsChanged = this._depSignature(pkg) !== this._depSignature(this._currentPkg());
      this._phase('install', 62, depsChanged ? '安装依赖' : '准备依赖');
      if (depsChanged) {
        this._log('WARN', `依赖声明有变化（${this._depSignature(pkg) || '无第三方依赖'}），需要联网安装依赖…`);
        const npmR = await this._npmInstall(stageApp);
        if (!npmR.ok) {
          throw new Error(`依赖安装失败（exit ${npmR.code}），已放弃本次更新：${this._firstLine(npmR.err || npmR.out)}`);
        }
        depsInstalled = true;
        this._log('OK', '依赖安装完成');
        // 装好的依赖挪进基线目录、运行目录里只留软链：维持「依赖独立于代码」——
        // 之后每次更新都是整目录替换，永远不必重复下载依赖，也不会把依赖卷进切换目标。
        try {
          const base = this.depsDir || '/opt/node_modules';
          const prevBase = `${base}.prev`;
          fs.rmSync(prevBase, { recursive: true, force: true });
          if (fs.existsSync(base)) fs.renameSync(base, prevBase);
          fs.renameSync(path.join(stageApp, 'node_modules'), base);
          fs.symlinkSync(base, path.join(stageApp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
          this._log('OK', `依赖已成为新的基线 ${base}（上一份留在 ${prevBase}，下次容器启动时清掉）`);
        } catch (e) {
          this._log('WARN', `依赖没能挪进基线目录（${e.message}）：本次依赖随代码留在运行目录，功能不受影响`);
        }
      } else {
        const how = this._linkNodeModules(stageApp, t.target);
        this._log('OK', how === 'link'
          ? `依赖复用现有基线（软链 ${this._depsBaselineUsed || '?'}，无需联网安装）`
          : '依赖复用现有基线（文件系统不支持软链，已复制一份）');
      }

      // 版本标记：容器里没有 .git，这份标记就是「当前跑的是哪一次提交」的唯一权威来源。
      // commit 记录本次实际下载的 ref（sha），下次点更新就按它和远端 HEAD 比——不再依赖版本号。
      const isSha = /^[0-9a-f]{7,40}$/i.test(String(ref || ''));
      fs.writeFileSync(path.join(stageApp, '.livegrab-version.json'), JSON.stringify({
        version: pkgVersion || latest.version,
        tag: pkgVersion ? `v${pkgVersion}` : latest.tag,
        commit: isSha ? String(ref).slice(0, 12) : '',
        commitFull: isSha ? String(ref) : '',
        commitAt: latest.commitAt || '',
        remoteTag: latest.tag,
        pkgVersion,
        depsInstalled,
        at: Date.now(),
        from: local.version || '',
      }, null, 2));

      this._phase('switch', 82, `切换到 ${label}`);
      const sw = this._swapIn(stageApp, t.target, `${t.target}.old`);
      this._log('OK', `代码已切换到 ${label}（${sw.target}${sw.how === 'copy' ? '，覆盖式' : ''}）`);
    } catch (e) {
      // 失败：整个暂存区丢掉，旧版本目录没被动过，服务继续正常录制
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 忽略 */ }
      throw e;
    }
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 忽略 */ }

    this.state.progress = 90;
    if (typeof this.restartHook !== 'function') {
      this._phase('done', 100, `更新完成 ${label}`);
      this._log('OK', '更新完成。请重启容器使新版本生效。');
      return;
    }
    this._phase('restart', 92, '正在重启服务');
    this._log('OK', '正在重启服务以加载新版本…');
    await sleep(1200);
    try {
      // 关键：新进程必须以新目录为 cwd 启动，否则跑的还是旧代码
      await this.restartHook({ from: local.version, to: label, cwd: t.target });
    } catch (e) {
      this._log('WARN', `自动重启失败（${e?.message || e}），请手动重启容器使新版本生效`);
    }
    this._phase('done', 100, `更新完成 ${label}`);
    this._log('OK', `更新完成：${from} → ${label}`);
  }

  /* ---------- 状态输出 ---------- */

  /** 计算是否真的有更新。容器（归档通道）以 commit 为准：
      ① 两端 commit 都可得 → 不同即更新（同版本号但分支有新提交也会更）；
         另加一条「不降级」保护：远端那次提交的时间早于本地 → 不动（远端被 reset 回旧提交时不跟着退）；
      ② 本地 commit 不可知（镜像没传 BUILD_COMMIT 且从没页面更新过）→ 按「有更新」处理，
         点一次即写入标记、此后精确；否则这条新逻辑对老镜像永远不生效；
      ③ 远端取不到 commit（API 异常）→ 退回语义化版本比较。
      版本号在容器通道里**不参与判定**，只用于展示：改代码忘了改版本号也能更新。
      git 形态保持原语义：先版本后 commit（真正的比对发生在 fetch 之后 HEAD vs FETCH_HEAD）。 */
  _computeHasUpdate(local, latest) {
    if (!latest || latest.unavailable) return false;
    const lv = parseVersion(local && local.version);
    const rv = parseVersion(latest && latest.version);
    const lc = local && local.commit ? String(local.commit).toLowerCase().slice(0, 12) : '';
    const rc = latest && latest.commit ? String(latest.commit).toLowerCase().slice(0, 12) : '';

    if (this._mode() === 'archive') {
      if (lc && rc) {
        if (lc === rc) return false;
        // 不降级：远端提交比本地还旧 → 不动（保护线上不被回退；时间不可知时放行）
        const lt = local && local.commitDate ? Date.parse(local.commitDate) : NaN;
        const rt = latest && latest.commitAt ? Date.parse(latest.commitAt) : NaN;
        if (Number.isFinite(lt) && Number.isFinite(rt) && rt < lt) return false;
        return true;
      }
      if (rc && !lc) return true;   // ② 本地无 commit 记录：先按有更新处理一次
      if (lv && rv) return cmpParsedVersion(rv, lv) > 0;  // ③ 远端无 commit：退回版本号
      return !!(latest.version && local && local.version && latest.version !== local.version);
    }

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
    const mode = this._mode();
    return {
      env: s.env || null,
      mode,
      // 能否在线自更新：容器（归档通道）与本地 git 仓库都能，本地无 git 只能给手动步骤
      canSelfUpdate: mode !== 'none',
      appDir: this.appDir,
      runDir: this.runDir,
      // 更新会落到哪（正常就是 runDir 自己；跑镜像内置代码时才退回 ${CONFIG_DIR}/src/app）
      target: (() => { try { return this._runTarget().target; } catch { return ''; } })(),
      srcRoot: (s.env && s.env.srcRoot) || '',
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
