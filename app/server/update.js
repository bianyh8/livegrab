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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

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
      fetch(`${api}/releases/latest`, { headers, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${api}/tags?per_page=10`, { headers, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${api}/commits/${branch}?per_page=1`, { headers, signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
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

      // 没有新版本：直接结束，不再误报「发现新版本」（commit 一致即视为最新，即使版本号字符串不同）
      if (!hasNew) {
        this._phase('done', 100, '');
        this._log('OK', `已是最新版本${local.commit ? `（${local.commit}）` : `（${local.version}）`}，无需更新`);
        return;
      }

      this._log('INFO', `发现新版本：${latest.tag} (${latest.commit || '?'})`);

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
          : `请在源码目录手动执行：git pull ${gitUrl} ${branch} && npm install`);
        this._log('INFO', '已生成手动更新指引。重建并重启容器后生效。');
        this._phase('done', 100, '需手动重建镜像更新');
        return;
      }

      // 更新源完全取自「更新源配置」（UI > 环境变量 > 默认），不写死仓库：
      // 直接以配置的仓库地址作为 fetch/pull 的远端，避免仓库里残留的 origin 指向别处导致拉到旧代码。
      const branch = this._branch();
      const gitUrl = this._gitUrl();
      // ② fetch（私有仓库注入认证，避免依赖本机凭据）
      this._phase('fetch', 20, '拉取远端代码');
      this._log('INFO', `准备从更新源拉取代码：${gitUrl}（分支 ${branch}）…`);
      const fetchR = await run('git', [...this._gitAuthArgs(), 'fetch', gitUrl, branch], { cwd: env.gitRoot, timeout: 120000 });
      if (!fetchR.ok) {
        this._phase('error', 25, '');
        const detail = (fetchR.err || fetchR.out || '').split('\n').slice(0, 3).join(' ').trim();
        this._log('ERR', `代码拉取失败（exit ${fetchR.code}）：${detail || '无输出'}`);
        return;
      }
      this._log('OK', '代码拉取成功');
      this.state.progress = 40;

      // ③ 对比本地与远端 HEAD（远端 commit 即刚 fetch 下来的 FETCH_HEAD）
      const [cur, remote] = await Promise.all([
        run('git', ['rev-parse', 'HEAD'], { cwd: env.gitRoot }),
        run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: env.gitRoot }),
      ]);
      const curSha = cur.ok ? cur.out.trim() : '';
      const remoteSha = remote.ok ? remote.out.trim() : '';
      if (curSha && remoteSha && curSha === remoteSha) {
        this._phase('done', 100, '');
        this._log('OK', `已是最新代码（${curSha.slice(0, 12)}），无需更新`);
        return;
      }

      // ④ 快进拉取
      this._phase('pull', 55, `拉取最新代码 ${branch}`);
      this._log('INFO', `正在更新到 ${latest.tag} (${remoteSha.slice(0, 12)})…`);
      const pullR = await run('git', [...this._gitAuthArgs(), 'pull', '--ff-only', gitUrl, branch], { cwd: env.gitRoot, timeout: 120000 });
      if (!pullR.ok) {
        this._phase('error', 60, '');
        const detail = (pullR.err || pullR.out || '').split('\n').slice(0, 3).join(' ').trim();
        this._log('ERR', `代码更新失败（非快进或本地有改动，exit ${pullR.code}）：${detail || '无输出'}`);
        this._log('INFO', `请先提交或暂存本地改动后重试，或手动执行 git pull ${gitUrl} ${branch}`);
        return;
      }
      this._log('OK', `代码已更新到 ${latest.tag}`);
      this.state.progress = 75;

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
      repo: this._repo(),
      gitUrl: this._gitUrl(),
      branch: this._branch(),
      tokenConfigured: !!this._token(),
      authHint: !!(s.latest && s.latest.authHint) ? s.latest.authHint : '',
    };
  }
}
