// 更新管理器单元测试：覆盖版本对比、远程不可用、公开/私有仓库、检查/应用流程
// 用 mock 全局 fetch 返回假 GitHub 响应，离线运行
import {
  UpdateManager, parseVersion, compareVersions, pickLatestTag,
  gitTransportArgs, classifyGitError, FETCH_PLAN, parseTarEntries, extractTarGzTo,
  redactUrl, splitGitUserInfo, TAR_LIMITS,
} from '../server/update.js';

let bad = 0;
const check = (cond, label, extra = '') => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`); };

/** 极简外部命令执行（仅测试用：调用系统 tar 生成归档） */
const runCmd = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve(err
      ? { ok: false, code: err.code, out: String(stdout || '').trim(), err: String(stderr || '').trim() }
      : { ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
  });
});

// 用原生临时目录 + 正斜杠：Windows 下也能把同一路径交给系统 tar（MSYS 会把 /tmp 映射到别处）
const TMP = path.join(os.tmpdir(), 'lg-update-unit').split(path.sep).join('/');
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, cpSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const fsExists = existsSync;
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(TMP + '/package.json', JSON.stringify({ name: 'livegrab', version: '0.1.0' }));

const realFetch = global.fetch;

/** mock GitHub：repoPublic=true → 匿名可读；repoPrivate=true → 匿名 404、带 token 可读；都不设 → 404 */
function mockGitHub({ releases, tags, commits, repoPublic = true, repoPrivate = false } = {}) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const hdrs = (opts && opts.headers) || {};
    const authHdr = typeof hdrs.get === 'function' ? hdrs.get('Authorization') : (hdrs.Authorization || hdrs.authorization || '');
    // Headers.get 返回值部分（"token xxx"）；普通对象可能是 "Authorization: token xxx" 整行，两者都兼容
    const authed = /(?:^|:\s*)token\s/.test(String(authHdr || ''));
    const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
    const which = u.includes('/releases/latest') ? 'releases' : u.includes('/tags') ? 'tags' : u.includes('/commits/main') ? 'commits' : null;
    if (!which) return json({ message: 'Not Found' }, 404);
    // 权限门：私有仓库匿名一律 404
    if (repoPrivate && !authed) return json({ message: 'Not Found' }, 404);
    const d = { releases, tags, commits }[which];
    return d === undefined ? json({ message: 'Not Found' }, 404) : json(d);
  };
}

// 「本地宿主 + 无 git 仓库」形态：本机若本身跑在容器里，detectEnv() 会给出 archive（归档通道）语义，
// 与这些用例想验证的本地语义不同 —— 显式固定形态，让结果不随宿主机变化（mode 缺省 → 由 gitAvailable 推导）。
const HOST_ENV = { gitAvailable: false, gitRoot: '', gitBin: '', dockerAvailable: false, inContainer: false };

async function fresh(hostShape = false) {
  const m = new UpdateManager({ appDir: TMP });
  await m.detectEnv();
  if (hostShape) m.state.env = HOST_ENV;
  await m.localInfo();
  return m;
}

const FAKE_PUBLIC = {
  releases: { tag_name: 'v0.2.0', published_at: '2026-05-01T00:00:00Z', body: '新功能 A\n- 修复 B', html_url: 'https://github.com/bianyh8/livegrab/releases/tag/v0.2.0' },
  tags: [{ name: 'v0.2.0' }, { name: 'v0.1.0' }],
  commits: { sha: 'abc123def456', commit: { message: 'feat: x\n', committer: { date: '2026-05-01T00:00:00Z' } } },
};

console.log('== A. 公开仓库（无 token 也能读，不提示需要 token） ==');
{
  mockGitHub({ ...FAKE_PUBLIC, repoPublic: true, repoPrivate: false });
  process.env.HOME = '/tmp/lg-nonexistent-home-xyz';
  const m2 = new UpdateManager({ appDir: TMP });
  delete process.env.HOME;
  await m2.detectEnv();
  await m2.localInfo();
  await m2.fetchRemote();
  check(m2.status().tokenConfigured === false, '无 token → tokenConfigured=false');
  check(m2.state.latest.unavailable === false, '公开仓库匿名读取成功');
  check(m2.state.latest.repoPublic === true, 'repoPublic=true');
  check(m2.state.latest.usedToken === false, '未使用 token');
  check(!m2.state.latest.authHint, '不提示 private-repo-needs-token');
  check(m2.state.latest.version === '0.2.0', '公开仓库版本解析正确');
}

console.log('== A2. 公开仓库 + 配置了 token（正常读取，token 可用不用） ==');
{
  mockGitHub({ ...FAKE_PUBLIC, repoPublic: true, repoPrivate: false });
  const m = new UpdateManager({ appDir: TMP, token: 'test-token-123' });
  await m.detectEnv();
  await m.localInfo();
  await m.fetchRemote();
  check(m.state.latest.unavailable === false, '公开仓库读取成功');
  check(m.state.latest.repoPublic === true, 'repoPublic=true');
  check(m.state.latest.usedToken === false, '匿名即成功，未走 token 重试');
}

console.log('== B. 私有仓库 + 无 token（匿名 404 → 提示需要 token） ==');
{
  mockGitHub({ ...FAKE_PUBLIC, repoPublic: false, repoPrivate: true });
  process.env.HOME = '/tmp/lg-nonexistent-home-xyz';
  const m2 = new UpdateManager({ appDir: TMP });
  delete process.env.HOME;
  await m2.detectEnv();
  await m2.localInfo();
  await m2.fetchRemote();
  check(m2.state.latest.unavailable === true, '私有仓库无 token → unavailable=true');
  check(m2.state.latest.authHint === 'private-repo-needs-token', 'authHint=private-repo-needs-token');
  check(m2.state.latest.repoPublic === false, 'repoPublic=false');
  check(m2.status().hasUpdate === false, '不误报 hasUpdate');
}

console.log('== B2. 私有仓库 + 有 token（匿名 404 → token 重试成功） ==');
{
  mockGitHub({ ...FAKE_PUBLIC, repoPublic: false, repoPrivate: true });
  const m = new UpdateManager({ appDir: TMP, token: 'test-token-123' });
  await m.detectEnv();
  await m.localInfo();
  await m.fetchRemote();
  check(m.state.latest.unavailable === false, '私有仓库带 token 读取成功');
  check(m.state.latest.repoPublic === false, 'repoPublic=false（私有）');
  check(m.state.latest.usedToken === true, 'usedToken=true（走了 token 重试）');
  check(m.state.latest.version === '0.2.0', '私有仓库版本解析正确');
  check(m.status().hasUpdate === true, 'hasUpdate=true');
  // token 必须仍能认证，但绝不能出现在 argv（/proc/<pid>/cmdline 同主机可读）：
  // 认证改为 GIT_CONFIG_* 环境变量注入（等价于 -c http.extraheader=...）
  const fetchArgs = m._buildFetchArgs('https://github.com/acme/priv.git', 'release');
  check(!fetchArgs.some((a) => /Basic|extraheader|test-token-123/.test(String(a))),
    'fetch 参数里没有 token / extraheader（认证不进 argv）', fetchArgs.join(' '));
  const authEnv = m._gitEnv();
  check(authEnv.GIT_CONFIG_COUNT === '1' && authEnv.GIT_CONFIG_KEY_0 === 'http.extraheader'
    && /^Authorization: Basic [A-Za-z0-9+/=]+$/.test(authEnv.GIT_CONFIG_VALUE_0 || ''),
    'git 认证改走 GIT_CONFIG_* 环境变量（等价 -c http.extraheader，只对本次子进程生效）');
  const decoded = Buffer.from(String(authEnv.GIT_CONFIG_VALUE_0 || '').replace(/^Authorization: Basic /, ''), 'base64').toString('utf8');
  check(decoded === 'x-access-token:test-token-123', '环境变量里的凭据解出来仍是 x-access-token:<token>（认证语义未变）', decoded.replace(/test-token-\d+/, 'test-token-***'));
}

console.log('== C. 仓库不存在（匿名/token 均 404 → 不提示需要 token） ==');
{
  mockGitHub({ releases: undefined, tags: undefined, commits: undefined });
  const m = new UpdateManager({ appDir: TMP, token: 'test-token-123' });
  await m.detectEnv();
  await m.localInfo();
  await m.fetchRemote();
  check(m.state.latest.unavailable === true, '仓库不存在 → unavailable=true');
  check(m.state.latest.authHint === '', '配了 token 仍失败 → 不提示需要 token');
  check(m.state.latest.repoPublic === false, 'repoPublic=false');
}

console.log('== D. 远程无更新（版本一致） ==');
{
  mockGitHub({
    releases: { tag_name: 'v0.1.0', published_at: '2026-05-01T00:00:00Z', body: '' },
    tags: [{ name: 'v0.1.0' }],
    commits: { sha: 'localcommit123', commit: { message: 'same', committer: { date: '2026-05-01T00:00:00Z' } } },
    repoPublic: true,
  });
  const m = await fresh(true);
  await m.fetchRemote();
  check(m.status().hasUpdate === false, 'v0.1.0 vs v0.1.0 → hasUpdate=false');
}

console.log('== E. 只返回 tags（无 release） ==');
{
  mockGitHub({ releases: undefined, tags: [{ name: 'v0.3.0' }], commits: undefined, repoPublic: true });
  const m = await fresh();
  await m.fetchRemote();
  check(m.state.latest.version === '0.3.0', '退回 tags 获取版本 0.3.0');
  check(m.status().hasUpdate === true, 'hasUpdate=true');
}

console.log('== F. apply 在远程不可见时给出明确指引 ==');
{
  mockGitHub({ releases: undefined, tags: undefined, commits: undefined });
  const m = await fresh(true);
  await m.check(true);
  const r = await m.apply();
  check(r.running === true, 'apply 返回 running（异步后台）');
  await new Promise((res) => setTimeout(res, 2500));
  const st = m.status();
  check(st.phase === 'error' || st.phase === 'done', 'apply 后台结束，phase=' + st.phase);
  check(st.log.some((l) => l.msg.includes('容器') || l.msg.includes('手动')), '日志包含容器/手动指引');
  check(st.running === false, 'running=false');
}

console.log('== G. 网络异常（fetch 直接抛错） ==');
{
  global.fetch = async () => { throw new Error('ETIMEDOUT'); };
  const m = await fresh();
  await m.fetchRemote();
  check(m.state.latest.unavailable === true, 'fetch 抛错 → unavailable=true');
}

console.log('== H. 更新日志统一写入 logger（环境自检/检查对比/级别映射/去重） ==');
{
  mockGitHub({ ...FAKE_PUBLIC, repoPublic: true, repoPrivate: false });
  const lines = [];
  const fakeLogger = {
    debug: (m) => lines.push(['DEBUG', m]),
    info: (m) => lines.push(['INFO', m]),
    warn: (m) => lines.push(['WARN', m]),
    error: (m) => lines.push(['ERROR', m]),
  };
  const m = new UpdateManager({ appDir: TMP, logger: fakeLogger });
  // ① 环境自检：首次 detectEnv 记一条（有没有 git 依运行环境，断言格式）
  await m.detectEnv();
  const envLines = lines.filter(([, msg]) => /更新环境自检/.test(msg));
  check(envLines.length === 1, 'detectEnv 首次检测记录环境自检日志', JSON.stringify(envLines));
  check(/git 可用|未检测到 git 仓库|更新走 GitHub 归档/.test(envLines[0]?.[1] || ''), '环境自检日志说明了运行形态（git 可用性 / 归档通道）');
  // ② 重复 detectEnv（环境未变）不重复记
  await m.detectEnv();
  check(lines.filter(([, msg]) => /更新环境自检/.test(msg)).length === 1, '环境未变化时不重复记录自检日志');
  // ③ check 成功：记录「本地 → 远程」对比（有更新）
  await m.check(true);
  const cmp = lines.filter(([, msg]) => /检查更新：本地/.test(msg));
  check(cmp.length === 1, 'check 记录版本对比日志', JSON.stringify(cmp));
  check(/v0\.1\.0.*→.*v0\.2\.0.*（有更新）/.test(cmp[0]?.[1] || ''), '对比日志含本地/远程版本与结论');
  // ④ 强制再查（结果相同）：去重，不刷屏
  await m.check(true);
  check(lines.filter(([, msg]) => /检查更新：本地/.test(msg)).length === 1, '检查结果相同不重复记录');
  // ⑤ _log 级别映射：OK→info、ERR→error、WARN→warn
  m._log('OK', 'x'); m._log('ERR', 'y'); m._log('WARN', 'z');
  const last3 = lines.slice(-3);
  check(last3[0][0] === 'INFO' && last3[1][0] === 'ERROR' && last3[2][0] === 'WARN', '_log 级别映射 OK/ERR/WARN → info/error/warn');
  check(last3.every(([, msg]) => msg.startsWith('[更新] ')), 'logger 中的更新日志带 [更新] 前缀');
}

global.fetch = realFetch;

console.log('== I. normalizeRepoConfig：仓库地址/分支/Token 解析与校验 ==');
{
  const m = new UpdateManager({ appDir: TMP });
  // ① owner/repo → 派生 gitUrl
  let r = m.normalizeRepoConfig({ repo: 'bianyh8/livegrab', branch: '' });
  check(r.repo === 'bianyh8/livegrab', 'owner/repo 原样保留', r.repo);
  check(r.gitUrl === 'https://github.com/bianyh8/livegrab.git', 'owner/repo 派生 gitUrl', r.gitUrl);
  check(r.branch === 'main', '分支缺省 main', r.branch);
  // ② 完整 https URL → 反解 owner/repo
  r = m.normalizeRepoConfig({ repo: 'https://github.com/bianyh8/livegrab.git' });
  check(r.repo === 'bianyh8/livegrab', 'https URL 反解 owner/repo', r.repo);
  check(r.gitUrl === 'https://github.com/bianyh8/livegrab.git', 'https URL 保留 gitUrl', r.gitUrl);
  // ③ 自定义分支 + token
  r = m.normalizeRepoConfig({ repo: 'acme/private', branch: 'dev', token: '  ghp_xxx  ' });
  check(r.branch === 'dev', '自定义分支', r.branch);
  check(r.token === 'ghp_xxx', 'token 去空格', JSON.stringify(r.token));
  // ④ 空仓库 → 抛错
  let threw = false;
  try { m.normalizeRepoConfig({ repo: '' }); } catch { threw = true; }
  check(threw, '仓库地址为空 → 抛错');
  // ⑤ 格式非法 → 抛错
  threw = false;
  try { m.normalizeRepoConfig({ repo: 'just-a-name' }); } catch { threw = true; }
  check(threw, '非法仓库格式 → 抛错');
}

console.log('== J. parseOwnerRepoFromGitHubUrl：仅 GitHub 可解析（经 normalizeRepoConfig 行为验证） ==');
{
  const m = new UpdateManager({ appDir: TMP });
  check(typeof m.normalizeRepoConfig === 'function', 'normalizeRepoConfig 存在');
  // 非 GitHub URL：gitUrl 原样保留，但 owner/repo 因主机不匹配而留空（当前实现仅支持 GitHub）
  const r = m.normalizeRepoConfig({ repo: 'https://gitlab.com/acme/proj.git', branch: 'main' });
  check(r.gitUrl === 'https://gitlab.com/acme/proj.git', '非 GitHub 的 gitUrl 原样保留', r.gitUrl);
  check(r.repo === '', '非 GitHub 的 owner/repo 留空', JSON.stringify(r.repo));
  // GitHub 路径不足两段 → 不反解
  const r2 = m.normalizeRepoConfig({ repo: 'https://github.com/bianyh8', branch: 'main' });
  check(r2.repo === '', 'GitHub 单段路径不反解', JSON.stringify(r2.repo));
}

console.log('== K. getRepoConfig 命名空间映射（update* 键 → 内部 repo/branch/token） ==');
{
  // 模拟 server.js 注入：customize 用 update* 命名空间存储
  const cfg = { updateRepo: 'acme/priv', updateGitUrl: 'https://github.com/acme/priv.git', updateBranch: 'release', updateToken: 'tok_abc' };
  const m = new UpdateManager({ appDir: TMP, getRepoConfig: () => cfg });
  check(m._repo() === 'acme/priv', '_repo 读取 updateRepo', m._repo());
  check(m._gitUrl() === 'https://github.com/acme/priv.git', '_gitUrl 读取 updateGitUrl', m._gitUrl());
  check(m._branch() === 'release', '_branch 读取 updateBranch', m._branch());
  check(m._token() === 'tok_abc', '_token 读取 updateToken', m._token());
  check(m.status().tokenConfigured === true, 'status.tokenConfigured 随配置联动', JSON.stringify(m.status().tokenConfigured));
  check(m.status().repo === 'acme/priv', 'status.repo 反映配置', m.status().repo);
  // 兼容：未加前缀的裸键也应被识别
  const cfg2 = { repo: 'foo/bar', branch: 'main', token: 't2' };
  const m2 = new UpdateManager({ appDir: TMP, getRepoConfig: () => cfg2 });
  check(m2._repo() === 'foo/bar' && m2._token() === 't2', '兼容裸键 repo/token', `${m2._repo()}/${m2._token()}`);
}

console.log('== L. 版本比较：远端更旧/相同都不得误报「可用更新」 ==');
{
  const m = new UpdateManager({ appDir: TMP });
  // 截图场景：本地 v0.1.19（已部署），远端只更新到 v0.1.18 → 不得提示「可用更新」
  check(m._computeHasUpdate({ version: '0.1.19' }, { version: '0.1.18' }) === false,
    '本地版本更新（0.1.19）→ 不提示「可用更新」（截图误报回归）');
  check(m._computeHasUpdate({ version: '0.1.18' }, { version: '0.1.19' }) === true, '远端严格更新 → 提示可用更新');
  check(m._computeHasUpdate({ version: '0.1.19' }, { version: '0.1.19' }) === false, '版本相同 → 不提示');
  check(m._computeHasUpdate({ version: '0.1.19' }, { version: 'v0.1.19' }) === false, 'v 前缀不影响比较');
  check(m._computeHasUpdate({ version: '0.1.9' }, { version: '0.1.10' }) === true, '按数值比较（0.1.9 < 0.1.10，非字典序）');
  check(m._computeHasUpdate({ version: '1.0.0' }, { version: '0.9.9' }) === false, '主版本更高 → 不提示');
  check(m._computeHasUpdate({ version: '0.1.19', commit: 'aaaa11112222' }, { version: '0.1.19', commit: 'bbbb33334444' }) === true,
    '版本相同但提交不同（分支 HEAD 领先）→ 提示');
  check(m._computeHasUpdate({ version: '0.1.19', commit: 'aaaa11112222' }, { version: '0.1.19', commit: 'aaaa11112222' }) === false,
    '版本与提交都相同 → 不提示');
  check(m._computeHasUpdate({ version: '0.1.0' }, { unavailable: true }) === false, '远程不可见 → 不提示');
  check(m._computeHasUpdate({ version: '0.0.0', commit: 'aaa' }, { version: '0.0.0', commit: 'bbb' }) === true,
    '版本号不可解析时退回 commit 比对');
}

console.log('== M. pickLatestTag / compareVersions / parseVersion ==');
{
  check(pickLatestTag(['v0.1.18', 'v0.1.19']) === 'v0.1.19', '多标签取最高版本', pickLatestTag(['v0.1.18', 'v0.1.19']));
  check(pickLatestTag(['v0.1.19', 'v0.1.18']) === 'v0.1.19', '与标签顺序无关');
  check(pickLatestTag(['v0.1.9', 'v0.1.10']) === 'v0.1.10', '按数值取最大（非字典序）');
  check(pickLatestTag(['release-2026', 'v1.0.0']) === 'v1.0.0', '忽略非版本号标签');
  check(pickLatestTag(['v2.0.0-beta.1', 'v2.0.0']) === 'v2.0.0', '正式版优先于预发布版');
  check(pickLatestTag([]) === '' && pickLatestTag(null) === '', '无候选/空值 → 空串');
  check(compareVersions('0.1.19', '0.1.18') > 0 && compareVersions('0.1.18', '0.1.19') < 0 && compareVersions('v1.2.3', '1.2.3') === 0,
    'compareVersions 语义正确');
  check(compareVersions('nope', '1.0.0') === 0, '不可解析按相等处理（不误报）');
  check(parseVersion('v0.1.19')?.patch === 19 && parseVersion('nope') === null, 'parseVersion 解析与拒识');
}

console.log('== N. 远端版本取「最高标签」：只打 tag 未发 Release 时不把旧 Release 当最新 ==');
{
  mockGitHub({
    releases: { tag_name: 'v0.1.18', published_at: '2026-10-01T00:00:00Z', body: '旧版说明' },
    tags: [{ name: 'v0.1.19' }, { name: 'v0.1.18' }],
    commits: { sha: 'headsha123456', commit: { message: 'chore: x', committer: { date: '2026-10-02T00:00:00Z' } } },
    repoPublic: true,
  });
  const m = new UpdateManager({ appDir: TMP });
  await m.detectEnv();
  m.state.env = HOST_ENV;   // 固定「本地无 git」形态，否则在容器里跑会走归档通道、语义不同
  await m.localInfo();
  // 模拟已部署 v0.1.19 的实例（无构建 commit 信息，只能按版本号比对）
  m.state.local = { version: '0.1.19', commit: '', branch: 'main', commitAt: null, tag: 'v0.1.19' };
  await m.fetchRemote();
  check(m.state.latest.version === '0.1.19', '远端版本取最高标签 v0.1.19（忽略更旧的 Release v0.1.18）', m.state.latest.version);
  check(m.state.latest.tag === 'v0.1.19', 'latest.tag 同步为最高标签', m.state.latest.tag);
  check(m.status().hasUpdate === false, '本地 v0.1.19 → 不误报「可用更新」', JSON.stringify(m.status().hasUpdate));
}

console.log('== O. 立即更新使用「更新源配置」的仓库（不写死 origin / 默认仓库） ==');
{
  mockGitHub({
    releases: { tag_name: 'v9.9.9', published_at: '2026-10-02T00:00:00Z', body: '' },
    tags: [{ name: 'v9.9.9' }],
    commits: { sha: 'deadbeef0000', commit: { message: 'x', committer: { date: '2026-10-02T00:00:00Z' } } },
    repoPublic: true,
  });
  const m = new UpdateManager({
    appDir: TMP,
    getRepoConfig: () => ({ updateRepo: 'acme/priv', updateGitUrl: 'https://github.com/acme/priv.git', updateBranch: 'release' }),
  });
  await m.detectEnv();
  await m.localInfo();
  // 固定为「无 git 仓库」环境：走手动指引分支，日志里会带出实际使用的远端地址
  m.state.env = { gitAvailable: false, gitRoot: '', gitBin: '', dockerAvailable: false, inContainer: false };
  await m.apply();
  await new Promise((res) => setTimeout(res, 1200));
  const logs = m.status().log.map((l) => l.msg).join('\n');
  check(/https:\/\/github\.com\/acme\/priv\.git/.test(logs), '更新流程日志使用配置的仓库地址', logs.split('\n').slice(-2).join(' | '));
  check(!/\borigin\b/.test(logs), '日志中不再出现写死的 origin 远端', /origin/.test(logs) ? logs : '');
}

console.log('== P. 拉取失败的处理：传输层降级参数 + 报错分级 + 可操作建议 ==');
{
  const m = new UpdateManager({ appDir: TMP });
  const t0 = gitTransportArgs();
  check(t0.includes('-c') && t0[t0.indexOf('-c') + 1] === 'http.version=HTTP/1.1', '默认走 HTTP/1.1（绕开 HTTP2 framing 错误）');
  check(t0.some((a) => a === 'http.postBuffer=524288000'), '放大 http.postBuffer（大仓库/CDN 抖动）');
  check(!t0.includes('protocol.version=0'), '默认不动 protocol 版本（优先用 v2，失败再降级）');
  check(gitTransportArgs({ legacyRefs: true }).includes('protocol.version=0'), '降级档位开启 protocol v0（绕开 expected flush after ref listing）');
  check(FETCH_PLAN.length === 3 && FETCH_PLAN[1].legacyRefs === true, '拉取计划为 3 档且第 2 档起降级', FETCH_PLAN.map((p) => p.label).join(' | '));

  // 用户实际报错原文（容器内 fetch 失败）
  const realErr = 'error: RPC failed; curl 16 Error in the HTTP2 framing layer\nfatal: expected flush after ref listing';
  check(classifyGitError(realErr) === 'http2', 'HTTP2 framing / ref listing 错误归类为 http2');
  check(classifyGitError('fatal: Authentication failed for \'https://github.com/x/y\'') === 'auth', '认证失败归类为 auth');
  check(classifyGitError('fatal: unable to access: Could not resolve host: github.com') === 'network', 'DNS/连不上归类为 network');
  check(classifyGitError('remote: Repository not found.') === 'notfound', '仓库不存在归类为 notfound');
  check(classifyGitError('fatal: the remote end hung up unexpectedly\nerror: unexpected disconnect while reading sideband packet') === 'unstable', '连接中断归类为 unstable');
  check(classifyGitError('随便一段无关输出') === '', '无法识别时返回空（不误导）');

  m._logGitAdvice('http2', 'https://github.com/acme/priv.git', 'release', { inContainer: true });
  const advice = m.state.log.map((l) => l.msg).join('\n');
  check(advice.includes('git -c http.version=HTTP/1.1 -c protocol.version=0 fetch https://github.com/acme/priv.git release'),
    '给出可直接复制的手动命令（含配置的仓库地址）');
  check(/代理|网关/.test(advice), '指出中间设备/代理是最常见原因');
  check(advice.includes('可直接再次点击「立即更新」重试'), '明确告知可重试且代码未被改动');
}

console.log('== Q. fetch 参数 / 快照通道地址与标记 ==');
{
  const m = new UpdateManager({ appDir: TMP });
  const args = m._buildFetchArgs('https://github.com/acme/priv.git', 'release');
  check(args.includes('http.version=HTTP/1.1'), 'fetch 参数带 HTTP/1.1');
  check(args.slice(-3).join(' ') === 'fetch https://github.com/acme/priv.git release', '远端取配置地址、分支取配置分支', args.slice(-3).join(' '));
  check(!args.includes('origin'), '不再把 origin 写死进 fetch/marge 远端');
  check(m._buildFetchArgs('git://x/y', 'main', { legacyRefs: true }).includes('protocol.version=0'), '降级档位透传到 fetch 参数');

  check(m._snapshotUrl() === 'https://codeload.github.com/bianyh8/livegrab/tar.gz/refs/heads/main',
    '默认配置推导出 codeload 归档地址', m._snapshotUrl());
  const m2 = new UpdateManager({ appDir: TMP, getRepoConfig: () => ({ updateRepo: 'acme/priv', updateBranch: 'release' }) });
  check(m2._snapshotUrl() === 'https://codeload.github.com/acme/priv/tar.gz/refs/heads/release', '快照地址跟随配置的仓库/分支', m2._snapshotUrl());
  const m3 = new UpdateManager({ appDir: TMP, getRepoConfig: () => ({ updateGitUrl: 'https://gitlab.com/acme/priv.git', updateBranch: 'main' }) });
  check(m3._snapshotUrl() === '', '非 GitHub 仓库不快照（明确返回空，不做无效尝试）');

  // 快照标记：写 → 读 → localInfo 优先采用 → status 暴露 → 清除
  const fakeRoot = TMP + '/snaproot';
  mkdirSync(fakeRoot + '/.git', { recursive: true });
  const env = { gitAvailable: true, gitBin: 'git', gitRoot: fakeRoot, dockerAvailable: false, inContainer: true };
  const m4 = new UpdateManager({ appDir: TMP });
  m4.state.env = env;
  check(m4._readSnapshot(env) === null, '无标记时读取为空');
  m4._writeSnapshot(env, { commit: 'abcdef123456', tag: 'v0.9.9', version: '0.9.9', at: Date.now() });
  const snap = m4._readSnapshot(env);
  check(!!snap && snap.commit === 'abcdef123456', '标记可写入并可读回');
  const loc = await m4.localInfo();
  check(loc.version === '0.9.9' && loc.commit === 'abcdef123456' && loc.tag === 'v0.9.9',
    'localInfo 以快照标记为准（不拿落后的 .git 索引冒充本地版本）', `${loc.version}/${loc.commit}`);
  check(!!m4.status().snapshot, 'status() 暴露 snapshot 供前端提示');
  m4._clearSnapshot(env);
  check(m4._readSnapshot(env) === null, '清除标记后不再上报快照状态');
}

console.log('== R. tar.gz 解析与落地（零依赖快照通道的底座） ==');
{
  const tarOk = await runCmd('tar', ['--version']);
  if (!tarOk.ok) {
    console.log('  SKIP  未检测到 tar，跳过归档用例');
  } else {
    const src = TMP + '/snapsrc';
    rmSync(src, { recursive: true, force: true });
    // GitHub 归档结构：<repo>-<branch>/ 顶层目录
    const root = src + '/livegrab-main';
    const deep = root + '/app/server/' + 'x'.repeat(60) + '/' + 'y'.repeat(60);
    mkdirSync(deep, { recursive: true });
    mkdirSync(root + '/deploy', { recursive: true });
    writeFileSync(root + '/app/package.json', JSON.stringify({ name: 'livegrab', version: '0.9.9' }));
    writeFileSync(root + '/app/server/server.js', '// snapshot\n');
    writeFileSync(root + '/deploy/entrypoint.sh', '#!/bin/sh\n');
    writeFileSync(deep + '/deep.txt', 'deep\n');           // 超长路径：强制归档器用 pax / GNU longname
    writeFileSync(root + '/gone.txt', 'to be deleted\n');
    const tgz = TMP + '/snap.tar.gz';
    rmSync(tgz, { force: true });
    // Windows 的 GNU tar 会把 "C:/..." 当成远端主机（host:path），失败时补 --force-local 重试
    let packed = await runCmd('tar', ['-czf', tgz, '-C', src, 'livegrab-main']);
    if (!packed.ok) packed = await runCmd('tar', ['-czf', tgz, '--force-local', '-C', src, 'livegrab-main']);
    check(packed.ok, '用系统 tar 生成测试归档', packed.err);
    if (packed.ok) {
      const buf = readFileSync(tgz);
      const entries = parseTarEntries(zlib.gunzipSync(buf));
      const names = entries.map((e) => e.name);
      check(names.includes('livegrab-main/app/server/server.js'), '解析出普通文件条目');
      check(names.some((n) => n.includes('x'.repeat(60))), '超长路径条目也能解析（pax/GNU longname）');

      const dest = TMP + '/snapout';
      rmSync(dest, { recursive: true, force: true });
      const res = await extractTarGzTo(buf, dest);
      check(fsExists(dest + '/app/server/server.js'), '落地后文件就位');
      check(fsExists(dest + '/app/package.json'), '落地后 package.json 就位');
      check(readFileSync(dest + '/app/package.json', 'utf8').includes('0.9.9'), '文件内容正确');
      check(fsExists(dest + '/app/server/' + 'x'.repeat(60) + '/' + 'y'.repeat(60) + '/deep.txt'), '超长路径文件落地');
      check(res.files.some((f) => f === 'app/server/server.js'), '返回的文件清单是剥离顶层目录后的相对路径');

      // 解压上限（压缩炸弹）：几 KB 压缩 → 几十 MB 解压，必须中止而不是把内存吃光
      check(TAR_LIMITS.totalBytes >= 256 * 1024 * 1024, '解压总量上限存在且合理（>=256MB）', String(TAR_LIMITS.totalBytes));
      const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41));   // 压缩后 ~8KB、解压 8MB
      let bombErr = '';
      const bombOut = TMP + '/bombout';
      rmSync(bombOut, { recursive: true, force: true });
      try { await extractTarGzTo(bomb, bombOut, { totalBytes: 1024 * 1024 }); } catch (e) { bombErr = e.message; }
      check(/上限/.test(bombErr) && /已中止/.test(bombErr), '解压后总量超限即中止（流式解压，不再一次性 gunzipSync）', bombErr);
      check(!fsExists(bombOut + '/app'), '超限中止时没有落下任何文件');

      // 单条目上限：头里声明的 size 就超限 → 连数据都不收，直接拒
      let entryErr = '';
      try { await extractTarGzTo(buf, TMP + '/entryout', { entryBytes: 10 }); } catch (e) { entryErr = e.message; }
      check(/条目过大/.test(entryErr), '单条目声明体积超限即中止', entryErr);

      // 顶层目录条目不带尾斜杠时也要正确剥离（流式解析不能依赖 tar 的书写习惯）
      const hdr = (name, size, type) => {
        const b = Buffer.alloc(512);
        b.write(name, 0, 100, 'latin1');
        b.write('0000644\0', 100, 8, 'latin1');
        b.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
        b.write(type, 156, 1, 'latin1');
        b.write('ustar\0' + '00', 257, 8, 'latin1');
        let sum = 0; for (const x of b) sum += x;
        b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
        return b;
      };
      const payload = Buffer.from('// synth\n');
      const synthTar = Buffer.concat([
        hdr('livegrab-9.9.9', 0, '5'),                       // 目录条目：没有尾斜杠
        hdr('livegrab-9.9.9/app/server/server.js', payload.length, '0'), payload, Buffer.alloc(512 - (payload.length % 512)),
        Buffer.alloc(1024),
      ]);
      const synthOut = TMP + '/synthout';
      rmSync(synthOut, { recursive: true, force: true });
      await extractTarGzTo(zlib.gzipSync(synthTar), synthOut);
      check(fsExists(synthOut + '/app/server/server.js'), '顶层目录条目不带尾斜杠时也能正确剥离');
    }
  }
}

console.log('== S. 容器归档通道：按 commit 比对 → 下载该提交 → 解包 → 切换 → 重启（全程不需要 git） ==');
{
  const tarOk = await runCmd('tar', ['--version']);
  if (!tarOk.ok) {
    console.log('  SKIP  未检测到 tar，跳过归档通道用例');
  } else {
    const ARCH = path.join(TMP, 'arch');
    rmSync(ARCH, { recursive: true, force: true });
    const srcRoot = path.join(ARCH, 'src');
    const imgApp = path.join(ARCH, 'image');
    mkdirSync(path.join(imgApp, 'server'), { recursive: true });
    mkdirSync(path.join(imgApp, 'node_modules', 'better-sqlite3'), { recursive: true });
    writeFileSync(path.join(imgApp, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
    writeFileSync(path.join(imgApp, 'server', 'server.js'), '// old code 0.1.0\n');

    // 造两个 GitHub 形状的归档：<repo>-<tag>/app/...
    const packArchive = async (name, version, { withServer = true } = {}) => {
      const base = path.join(ARCH, `tar-${name}`);
      const root = path.join(base, `livegrab-${name}`);
      mkdirSync(path.join(root, 'app', 'server'), { recursive: true });
      writeFileSync(path.join(root, 'app', 'package.json'), JSON.stringify({ name: 'livegrab', version, dependencies: { 'better-sqlite3': '^13.0.0' } }));
      if (withServer) writeFileSync(path.join(root, 'app', 'server', 'server.js'), `// new code ${version}\n`);
      const out = path.join(ARCH, `${name}.tar.gz`);
      let r = await runCmd('tar', ['-czf', out, '-C', base, `livegrab-${name}`]);
      if (!r.ok) r = await runCmd('tar', ['-czf', out, '--force-local', '-C', base, `livegrab-${name}`]);
      return readFileSync(out);
    };
    const good = await packArchive('0.2.0', '0.2.0');
    const badTar = await packArchive('0.3.0', '0.3.0', { withServer: false });

    // 远端版本可切换的 mock：tags/commit/归档内容都由变量控制，便于测「同提交/异提交/降级/坏包」
    let remoteTag = 'v0.2.0';
    let remoteSha = 'deadbeef0001';
    let archiveBody = good;
    let archiveHits = 0;
    let lastArchiveUrl = '';
    global.fetch = async (url) => {
      const u = String(url);
      const json = (o, s = 200) => ({ ok: s < 400, status: s, json: async () => o, text: async () => JSON.stringify(o), arrayBuffer: async () => Buffer.from('{}') });
      if (u.includes('codeload.github.com')) {
        archiveHits += 1;
        lastArchiveUrl = u;
        return { ok: true, status: 200, arrayBuffer: async () => archiveBody.buffer.slice(archiveBody.byteOffset, archiveBody.byteOffset + archiveBody.byteLength) };
      }
      if (u.includes('/releases/latest')) return json({ tag_name: remoteTag, published_at: '2026-10-01T00:00:00Z', body: '' });
      if (u.includes('/tags')) return json([{ name: remoteTag }, { name: 'v0.1.0' }]);
      if (u.includes('/commits/')) return json({ sha: remoteSha, commit: { message: 'feat: x', committer: { date: '2026-10-01T00:00:00Z' } } });
      return json({ message: 'Not Found' }, 404);
    };

    let restarted = null;
    const mk = (appDir) => new UpdateManager({
      appDir, srcRoot, imageApp: imgApp,
      getRepoConfig: () => ({ updateRepo: 'bianyh8/livegrab', updateBranch: 'main' }),
      restart: async (info) => { restarted = info; },
    });
    const m = mk(imgApp);
    const env = await m.detectEnv();
    check(env.mode === 'archive', '容器形态判定为归档通道（不依赖 git）', env.mode);
    check(env.srcRoot === srcRoot, '落位目录取自构造参数 / LIVEGRAB_SRC_DIR', env.srcRoot);
    const loc0 = await m.localInfo();
    check(loc0.version === '0.1.0', '未更新过时本地版本取自镜像 package.json', loc0.version);
    check(m.status().canSelfUpdate === true, '容器内 canSelfUpdate=true（页面据此显示自动重启提示）');

    // ① 同一提交：一次归档都不下载（即使标签版本看着更高也不算更新）
    m.state.local = { version: '0.2.0', commit: 'deadbeef0001', branch: 'main', commitAt: null, tag: 'v0.2.0' };
    await m.apply();
    await new Promise((r) => setTimeout(r, 600));
    check(archiveHits === 0, 'commit 相同（哪怕标签更高）→ 完全不下载归档', `hits=${archiveHits}`);
    check(m.state.log.some((l) => /已是最新代码/.test(l.msg)), '日志写明「已是最新代码」', m.state.log.map((l) => l.msg).slice(-2).join(' | '));
    check(restarted === null, '未更新时不重启');

    // ①-b 版本号相同、提交不同 → 判定为有更新（这是本次改动的核心）
    {
      const mm = mk(imgApp);
      mm.state.env = { mode: 'archive', srcRoot, inContainer: true };
      mm.state.local = { version: '0.2.0', commit: 'aaaabbbbcccc', branch: 'main', commitAt: null, tag: 'v0.2.0' };
      mm.state.latest = { unavailable: false, version: '0.2.0', tag: 'v0.2.0', commit: 'deadbeef0001', commitFull: 'deadbeef0001' };
      check(mm.status().hasUpdate === true, '同版本号但提交不同 → hasUpdate=true', JSON.stringify(mm.status().hasUpdate));
      mm.state.latest = { unavailable: false, version: '0.2.0', tag: 'v0.2.0', commit: 'aaaabbbbcccc' };
      check(mm.status().hasUpdate === false, '同版本号且提交相同 → hasUpdate=false');
      // 远端标签版本更高、但提交相同（标签挪到了同一提交）：不算更新
      mm.state.latest = { unavailable: false, version: '0.3.0', tag: 'v0.3.0', commit: 'aaaabbbbcccc' };
      check(mm.status().hasUpdate === false, '标签更高但提交相同 → 不算更新（只认 commit）');
      // 不降级：远端提交时间早于本地（远端被 reset 回旧提交）→ 不更新
      mm.state.local = { version: '0.5.0', commit: 'aaaabbbbcccc', branch: 'main', tag: 'v0.5.0', commitDate: '2026-10-10T00:00:00Z' };
      mm.state.latest = { unavailable: false, version: '0.3.0', tag: 'v0.3.0', commit: 'ffffffffffff', commitAt: '2026-09-01T00:00:00Z' };
      check(mm.status().hasUpdate === false, '远端提交时间更早 → 不更新（不降级）');
      // 版本号不参与判定：远端提交更新但版本号更低，仍然要更新
      mm.state.latest = { unavailable: false, version: '0.4.0', tag: 'v0.4.0', commit: 'ffffffffffff', commitAt: '2026-10-12T00:00:00Z' };
      check(mm.status().hasUpdate === true, '远端提交更新（哪怕版本号更低）→ 有更新');
      // 本地没有 commit 记录（镜像未传 BUILD_COMMIT）：按有更新处理，点一次即锚定
      mm.state.local = { version: '0.2.0', commit: '', branch: 'main', tag: 'v0.2.0' };
      mm.state.latest = { unavailable: false, version: '0.2.0', tag: 'v0.2.0', commit: 'deadbeef0001' };
      check(mm.status().hasUpdate === true, '本地无 commit 记录 → 按有更新处理（更新后可精确比对）');
      // 远端拿不到 commit（API 异常）：退回版本号比较
      mm.state.local = { version: '0.2.0', commit: 'aaaabbbbcccc', branch: 'main', tag: 'v0.2.0' };
      mm.state.latest = { unavailable: false, version: '0.2.0', tag: 'v0.2.0', commit: '' };
      check(mm.status().hasUpdate === false, '远端无 commit → 退回版本号，相同即不更新');
      mm.state.latest = { unavailable: false, version: '0.2.1', tag: 'v0.2.1', commit: '' };
      check(mm.status().hasUpdate === true, '远端无 commit 但版本更高 → 有更新');
    }

    // ② 正常更新 0.1.0 → 0.2.0
    m.state.local = null;
    m.state.checkedAt = 0;
    await m.localInfo();
    await m.apply();
    await new Promise((r) => setTimeout(r, 2000));
    check(archiveHits === 1, '提交不同 → 下载一次归档', `hits=${archiveHits}`);
    check(/\/tar\.gz\/deadbeef0001$/.test(lastArchiveUrl) && !/refs\/tags/.test(lastArchiveUrl),
      '归档按 commit 取（不是按标签）', lastArchiveUrl);
    check(fsExists(path.join(srcRoot, 'app', 'server', 'server.js')), '新版本落位到 <src>/app');
    check(readFileSync(path.join(srcRoot, 'app', 'server', 'server.js'), 'utf8').includes('0.2.0'), '落位的是归档里的新代码');
    check(fsExists(path.join(srcRoot, 'app', 'node_modules', 'better-sqlite3')), '依赖复用镜像基线（软链或复制）');
    const marker = JSON.parse(readFileSync(path.join(srcRoot, 'app', '.livegrab-version.json'), 'utf8'));
    check(marker.version === '0.2.0' && marker.tag === 'v0.2.0', '写出版本标记（容器内无 .git 时的版本来源）', JSON.stringify(marker));
    check(marker.commit === 'deadbeef0001' && marker.commitFull === 'deadbeef0001',
      '标记记录本次下载的 commit（下次据此精确比对）', JSON.stringify(marker));
    check(marker.commitAt === '2026-10-01T00:00:00Z', '标记记录该提交的时间（用于「不降级」保护）', String(marker.commitAt));
    check(!fsExists(path.join(srcRoot, 'app.stage')), '暂存目录已清理');
    check(!!restarted && restarted.cwd === path.join(srcRoot, 'app'), '重启钩子拿到新目录作为 cwd', JSON.stringify(restarted));
    const m2 = mk(path.join(srcRoot, 'app'));
    const loc2 = await m2.localInfo();
    check(loc2.version === '0.2.0' && loc2.tag === 'v0.2.0', '重启后版本读自标记文件', `${loc2.version}/${loc2.tag}`);
    check(loc2.commit === 'deadbeef0001', '重启后 commit 读自标记文件', String(loc2.commit));
    check(Date.parse(loc2.commitDate) === Date.parse('2026-10-01T00:00:00Z'), '重启后「提交时间」读自标记（不是落位时间）', String(loc2.commitDate));

    // ②-b 幂等：刚更新到该提交，再点一次不再下载
    m2.state.checkedAt = 0;
    await m2.apply();
    await new Promise((r) => setTimeout(r, 800));
    check(archiveHits === 1, '同一提交再点更新不重复下载（幂等）', `hits=${archiveHits}`);

    // ③ 坏归档（缺 server.js）：放弃本次更新，正在运行的版本不受影响
    const before = readFileSync(path.join(srcRoot, 'app', 'server', 'server.js'), 'utf8');
    remoteTag = 'v0.3.0';
    remoteSha = 'cafebabe0002';
    archiveBody = badTar;
    const m3 = mk(path.join(srcRoot, 'app'));
    await m3.detectEnv();
    await m3.localInfo();
    await m3.apply();
    await new Promise((r) => setTimeout(r, 2000));
    check(readFileSync(path.join(srcRoot, 'app', 'server', 'server.js'), 'utf8') === before, '坏归档不会破坏正在运行的版本');
    const markerAfter = JSON.parse(readFileSync(path.join(srcRoot, 'app', '.livegrab-version.json'), 'utf8'));
    check(markerAfter.commit === 'deadbeef0001', '失败后版本标记未变（下次仍会重试该提交）', JSON.stringify(markerAfter));
    check(m3.status().phase === 'error', '失败进入 error 状态（页面显示「重试更新」）', m3.status().phase);
    check(m3.state.log.some((l) => /归档结构异常/.test(l.msg)), '日志给出失败原因', m3.state.log.map((l) => l.msg).slice(-2).join(' | '));
    check(!fsExists(path.join(srcRoot, 'app.stage')), '失败后暂存目录也被清理');

    /* ③-b 运行目录形态（v0.1.52 起容器里的常态）：跑的就是运行目录本身 → 更新就地替换它 */
    remoteTag = 'v0.2.0';
    remoteSha = 'deadbeef0001';
    archiveBody = good;
    {
      const OPT = path.join(ARCH, 'opt');
      const RUN = path.join(OPT, '.run');
      const img2 = path.join(ARCH, 'image2');
      mkdirSync(path.join(img2, 'server'), { recursive: true });
      mkdirSync(path.join(img2, 'node_modules', 'better-sqlite3'), { recursive: true });
      writeFileSync(path.join(img2, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
      // 运行目录：entrypoint 部署出来的形态（镜像源码副本 + 依赖软链）
      mkdirSync(path.join(RUN, 'server'), { recursive: true });
      writeFileSync(path.join(RUN, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
      writeFileSync(path.join(RUN, 'server', 'server.js'), '// old code 0.1.0\n');
      try { symlinkSync(path.join(img2, 'node_modules'), path.join(RUN, 'node_modules'), 'dir'); } catch { /* 不支持软链就跳过 */ }

      // 显式钉住落位目录：detectEnv() 会回退读 process.env.LIVEGRAB_SRC_DIR，而前面的用例
      // 已经把它设成了 src/app —— 不钉住的话这里会落到 <src>/app，断言却查 <opt>/.run
      const m4 = new UpdateManager({
        appDir: RUN, imageApp: img2,
        srcRoot: RUN,
        getRepoConfig: () => ({ updateRepo: 'bianyh8/livegrab', updateBranch: 'main' }),
        restart: async (info) => { restarted = info; },
      });
      await m4.detectEnv();
      // 本机（尤其 Windows）不一定跑在容器里；容器里 inContainer=true 会让 detectEnv 直接判 archive。
      // 固定成「容器运行目录形态」，结果才不随宿主机变化（runDir 仍是 cwd，即被测的运行目录）。
      m4.state.env = { ...m4.state.env, mode: 'archive', inContainer: true, srcRoot: RUN };
      await m4.localInfo();
      await m4.apply();
      await new Promise((r) => setTimeout(r, 2000));
      check(readFileSync(path.join(RUN, 'server', 'server.js'), 'utf8').includes('0.2.0'), '运行目录形态：新版本就地替换运行目录（不再另开一份代码目录）');
      check(readFileSync(path.join(OPT, '.run.old', 'server', 'server.js'), 'utf8').includes('0.1.0'), '替换后上一版留在 <运行目录>.old（可手动回滚）');
      check(!fsExists(path.join(OPT, '.run.stage')), '暂存目录 <运行目录>.stage 已清理');
      check(!fsExists(path.join(ARCH, 'src', 'app.stage')), '不再往旧的 ${CONFIG_DIR}/src 落位');
      check(!!restarted && restarted.cwd === RUN, '重启钩子拿到运行目录本身作为 cwd', JSON.stringify(restarted));
      try { check(lstatSync(path.join(RUN, 'node_modules')).isSymbolicLink(), '运行目录里的依赖仍是软链（更新不碰依赖）'); } catch { check(false, '运行目录里的依赖仍是软链（更新不碰依赖）', '软链丢失'); }
      const mk4 = new UpdateManager({ appDir: RUN, imageApp: img2, srcRoot: RUN, getRepoConfig: () => ({ updateRepo: 'bianyh8/livegrab', updateBranch: 'main' }) });
      await mk4.detectEnv();
      const loc4 = await mk4.localInfo();
      check(loc4.version === '0.2.0' && loc4.commit === 'deadbeef0001', '重启后版本/提交读自运行目录里的标记', `${loc4.version}/${loc4.commit}`);
    }

    /* ③-c 运行目录被挂成宿主目录（不能整目录改名）→ 自动退回「备份 + 覆盖」，功能一致 */
    {
      const OPT2 = path.join(ARCH, 'opt2');
      const RUN2 = path.join(OPT2, 'run2');
      const img3 = path.join(ARCH, 'image3');
      mkdirSync(path.join(img3, 'server'), { recursive: true });
      mkdirSync(path.join(img3, 'node_modules', 'better-sqlite3'), { recursive: true });
      writeFileSync(path.join(img3, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
      mkdirSync(path.join(RUN2, 'server'), { recursive: true });
      writeFileSync(path.join(RUN2, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
      writeFileSync(path.join(RUN2, 'server', 'server.js'), '// old code 0.1.0\n');
      writeFileSync(path.join(RUN2, 'server', 'stale-file.js'), '// 上一版才有，覆盖式切换后应被清掉\n');
      try { symlinkSync(path.join(img3, 'node_modules'), path.join(RUN2, 'node_modules'), 'dir'); } catch { /* 忽略 */ }
      const m5 = new UpdateManager({
        appDir: RUN2, imageApp: img3,
        srcRoot: RUN2, // 同上：不复用前面用例留在环境里的 LIVEGRAB_SRC_DIR
        getRepoConfig: () => ({ updateRepo: 'bianyh8/livegrab', updateBranch: 'main' }),
        restart: async (info) => { restarted = info; },
      });
      // 模拟「运行目录是宿主 bind mount」：对它的整目录改名一律 EBUSY（rename(2) 对挂载点就是这样）
      const origRename = fs.renameSync;
      let blocked = 0;
      fs.renameSync = (a, b) => {
        if (String(a).includes('opt2') || String(b).includes('opt2')) {
          blocked += 1;
          const e = new Error('EBUSY: resource busy or locked');
          e.code = 'EBUSY';
          throw e;
        }
        return origRename(a, b);
      };
      try {
        await m5.detectEnv();
        m5.state.env = { ...m5.state.env, mode: 'archive', inContainer: true, srcRoot: RUN2 }; // 同 ③-b：固定容器形态
        await m5.localInfo();
        await m5.apply();
        await new Promise((r) => setTimeout(r, 2000));
      } finally { fs.renameSync = origRename; }
      check(blocked > 0, '用例真的走到了「不能整目录改名」的分支（EBUSY）', `拦截 ${blocked} 次`);
      check(m5.state.log.some((l) => /覆盖/.test(String(l.msg))), '日志说明改用了「备份 + 覆盖」方式切换');
      check(readFileSync(path.join(RUN2, 'server', 'server.js'), 'utf8').includes('0.2.0'), '不能整目录改名时，覆盖式切换照样把代码换成新版');
      check(!fsExists(path.join(RUN2, 'server', 'stale-file.js')), '覆盖式切换会清掉新版里已不存在的旧文件');
      check(readFileSync(path.join(OPT2, 'run2.old', 'server', 'server.js'), 'utf8').includes('0.1.0'), '覆盖式切换同样留了 <运行目录>.old 备份');
      try { check(lstatSync(path.join(RUN2, 'node_modules')).isSymbolicLink(), '覆盖式切换不破坏依赖软链'); } catch { check(false, '覆盖式切换不破坏依赖软链', '软链丢失'); }
      check(!!restarted && restarted.cwd === RUN2, '覆盖式切换后重启钩子仍拿到运行目录', JSON.stringify(restarted));
    }

    /* ③-d 下载成功才算更新：网络异常 / HTTP 错误 / 远端信息拿不到 → 运行目录一个字节都不动 */
    {
      const OPT3 = path.join(ARCH, 'opt3');
      const RUN3 = path.join(OPT3, 'run3');
      const img4 = path.join(ARCH, 'image4');
      mkdirSync(path.join(img4, 'server'), { recursive: true });
      mkdirSync(path.join(img4, 'node_modules', 'better-sqlite3'), { recursive: true });
      writeFileSync(path.join(img4, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
      mkdirSync(path.join(RUN3, 'server'), { recursive: true });
      writeFileSync(path.join(RUN3, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
      writeFileSync(path.join(RUN3, 'server', 'server.js'), '// old code 0.1.0\n');
      writeFileSync(path.join(RUN3, '.livegrab-version.json'), JSON.stringify({ version: '0.1.0', tag: 'v0.1.0', commit: 'deadbeef0001', commitFull: 'deadbeef0001' }));
      try { symlinkSync(path.join(img4, 'node_modules'), path.join(RUN3, 'node_modules'), 'dir'); } catch { /* 忽略 */ }

      // 指纹：递归记录「路径 + 内容 + mtime」——「没被改动」要能被逐字节证明，不能只看某个文件
      const fingerprint = (dir, rel = '') => {
        const out = [];
        for (const e of fs.readdirSync(path.join(dir, rel || '.'), { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.name === 'node_modules') { out.push(`${r}:<symlink>`); continue; }
          if (e.isDirectory()) out.push(`${r}/[${fingerprint(dir, r)}]`);
          else { const st = fs.statSync(path.join(dir, r)); out.push(`${r}:${st.mtimeMs}:${readFileSync(path.join(dir, r), 'utf8')}`); }
        }
        return out.sort().join('|');
      };
      const before3 = fingerprint(RUN3);

      const baseFetch = global.fetch;
      const setFetchMode = (mode) => {
        global.fetch = async (url, opts) => {
          const u = String(url);
          if (mode !== 'ok' && u.includes('codeload.github.com')) {
            if (mode === 'http500') return { ok: false, status: 500, arrayBuffer: async () => Buffer.alloc(0), text: async () => 'server error' };
            throw new Error('ECONNRESET: 连接被对端重置（模拟网络抖动）');
          }
          if (mode === 'remoteDown' && !u.includes('codeload.github.com')) throw new Error('ENOTFOUND api.github.com');
          return baseFetch(url, opts);
        };
      };
      remoteTag = 'v0.9.0';
      remoteSha = 'feedface0003';
      archiveBody = good;

      const cases = [
        ['归档下载 HTTP 500', 'http500', 'error', /更新失败/],
        ['归档下载时网络抛错（ECONNRESET）', 'throw', 'error', /更新失败/],
        ['远端版本信息全部拿不到（api 不可达）', 'remoteDown', 'done', /无法获取远程版本信息/],
      ];
      for (const [label, mode, wantPhase, wantLog] of cases) {
        restarted = null;
        setFetchMode(mode);
        const hitsBefore = archiveHits;
        const m6 = new UpdateManager({
          appDir: RUN3, imageApp: img4,
          srcRoot: RUN3,
          getRepoConfig: () => ({ updateRepo: 'bianyh8/livegrab', updateBranch: 'main' }),
          restart: async (info) => { restarted = info; },
        });
        await m6.detectEnv();
        m6.state.env = { ...m6.state.env, mode: 'archive', inContainer: true, srcRoot: RUN3 }; // 同 ③-b：固定容器形态
        await m6.localInfo();
        await m6.apply();
        await new Promise((r) => setTimeout(r, 1200));
        check(fingerprint(RUN3) === before3, `${label}：运行目录内容与修改时间逐文件比对无变化（没被改动过）`);
        check(!fsExists(path.join(OPT3, 'run3.old')), `${label}：没有产生 .old（压根没走到切换那一步）`);
        check(!fsExists(path.join(OPT3, 'run3.stage')), `${label}：没有暂存目录残留`);
        check(!fsExists(path.join(OPT3, 'run3.update.lock')), `${label}：没有更新锁残留（失败也走 finally 放锁）`);
        check(restarted === null, `${label}：没有重启服务（旧版本继续跑，录制不受影响）`);
        check(m6.status().phase === wantPhase, `${label}：状态为 ${wantPhase}（页面据此提示重试/原因）`, m6.status().phase);
        check(m6.state.log.some((l) => wantLog.test(String(l.msg))), `${label}：日志写明原因`, m6.state.log.map((l) => l.msg).slice(-2).join(' | '));
        if (mode === 'remoteDown') check(archiveHits === hitsBefore, `${label}：一次归档都不下载`, `hits=${archiveHits - hitsBefore}`);
        if (mode === 'http500') check(m6.state.log.some((l) => /HTTP 500/.test(String(l.msg))), `${label}：日志带上 HTTP 状态码（便于判断是网络还是权限）`);
      }
      global.fetch = baseFetch;
      // 反证：同一形态下下载成功时确实会更新（证明上面的「没变」不是因为走不到更新分支）
      restarted = null;
      setFetchMode('ok');
      const m7 = new UpdateManager({
        appDir: RUN3, imageApp: img4,
        srcRoot: RUN3,
        getRepoConfig: () => ({ updateRepo: 'bianyh8/livegrab', updateBranch: 'main' }),
        restart: async (info) => { restarted = info; },
      });
      await m7.detectEnv();
      m7.state.env = { ...m7.state.env, mode: 'archive', inContainer: true, srcRoot: RUN3 }; // 同 ③-b：固定容器形态
      await m7.localInfo();
      await m7.apply();
      await new Promise((r) => setTimeout(r, 2000));
      check(fingerprint(RUN3) !== before3 && readFileSync(path.join(RUN3, 'server', 'server.js'), 'utf8').includes('0.2.0'),
        '反证：同一个运行目录，下载成功时确实换成了新版本');
      check(!!restarted && restarted.cwd === RUN3, '反证：下载成功才重启（拿运行目录作为 cwd）', JSON.stringify(restarted));
      global.fetch = baseFetch;
    }
  }
}

// ⑤ 经代理下载「二进制归档」通道（回归：v0.1.56 漏 import httpGetBufferViaProxy，
//    抛 ReferenceError 被当成「代理不可用」→ 静默改直连，用户以为代理坏了）
{
  const httpMod = await import('node:http');
  const payload = Buffer.from('FAKE_TARGZ_'.repeat(500));
  const proxySrv = httpMod.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': payload.length });
    res.end(payload);
  });
  // 本项目代理客户端对 http 目标也走 CONNECT 隧道 → 假代理必须应答 CONNECT，再在隧道里回 HTTP 响应
  proxySrv.on('connect', (req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      socket.end(Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`, 'latin1'),
        payload,
      ]));
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r));
  const pport = proxySrv.address().port;
  const m = new UpdateManager({ appDir: TMP, getProxy: () => `http://127.0.0.1:${pport}` });
  m.logger = { info() {}, warn() {}, error() {}, debug() {} };
  let err = ''; let got = null;
  try {
    const r = await m._fetchViaProxy('http://127.0.0.1:9/archive.tar.gz', `http://127.0.0.1:${pport}`, { binary: true, timeoutMs: 5000, retries: 0 });
    got = Buffer.from(await r.arrayBuffer());
  } catch (e) { err = (e && e.message) || String(e); }
  check(!err, '经代理下载二进制归档不再抛错（import 齐全）', err);
  check(!!got && got.length === payload.length, '经代理下载二进制拿到完整字节', got ? `${got.length}B` : 'null');
  proxySrv.close();
}

/* ⑥ 并发闸门：apply() 必须「同步抢位」。
   页面进入更新页时必有一次静默 check()，网络慢时它还没结束用户就点了「立即更新」；
   旧实现里 state.running 的检查与置位之间夹着 detectEnv/localInfo 两个 await，
   两次点击都能穿透 → 两个 _runUpdate 并行解包同一暂存区、日志被互相清空、可能各 re-exec 一次。 */
{
  const m = new UpdateManager({ appDir: TMP });
  m.detectEnv = () => new Promise((r) => setTimeout(() => r(m.state.env), 120)); // 模拟慢环境探测
  m.localInfo = () => new Promise((r) => setTimeout(() => r(m.state.local), 120));
  m._runUpdate = async () => { await new Promise((r) => setTimeout(r, 300)); }; // 不真的联网
  const r1 = await m.apply();
  check(r1.running === true && !r1.busy, '第一次 apply() 正常启动', JSON.stringify(r1));
  const r2 = await m.apply(); // 此刻仍在 detectEnv 的 await 中
  check(r2.busy === true, '任务启动中再点一次 → 返回 busy=true（页面会提示「正在进行中」）', JSON.stringify(r2));
  await new Promise((r) => setTimeout(r, 60));
  const r3 = await m.apply();
  check(r3.busy === true, '任务已在后台跑时再点一次 → 仍然 busy=true', JSON.stringify(r3));
  // 失败路径必须放行闸门，否则页面会永远卡在「更新中」无法重试
  m.state.running = false;
  m.detectEnv = async () => { throw new Error('环境探测炸了'); };
  let threw = '';
  try { await m.apply(); } catch (e) { threw = e.message; }
  check(/炸了/.test(threw), '环境探测失败时把错误抛给调用方', threw);
  check(m.state.running === false, '失败后闸门已放行（可重试）', String(m.state.running));
}

/* ⑦ 依赖基线 / 回滚点：只有在切换成功之后才允许动它们。
   旧实现把「换基线」放在 _swapIn 之前——一旦切换失败，仍在跑的旧代码就带着新依赖（原生模块换 ABI 直接崩）；
   _swapIn 一进门还先 rm 掉 <target>.old，把唯一的手动回滚点也删了。 */
console.log('== T. 依赖基线与回滚点：切换失败也不能提前动 ==');
{
  const D = path.join(TMP, 'deps-order');
  rmSync(D, { recursive: true, force: true });
  const base = path.join(D, 'node_modules');   // 模拟 /opt/node_modules 基线
  mkdirSync(path.join(base, 'better-sqlite3'), { recursive: true });
  writeFileSync(path.join(base, 'better-sqlite3', 'marker.txt'), 'OLD-BASELINE');
  const runDir = path.join(D, '.run');
  mkdirSync(path.join(runDir, 'server'), { recursive: true });
  writeFileSync(path.join(runDir, 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.0', dependencies: { 'better-sqlite3': '^13.0.0' } }));
  writeFileSync(path.join(runDir, 'server', 'server.js'), '// old code\n');

  const m = new UpdateManager({ appDir: runDir, srcRoot: runDir, imageApp: path.join(D, 'image') });
  m.depsDir = base;
  m.logger = { info() {}, warn() {}, error() {}, debug() {} };

  const stageApp = path.join(D, '.run.stage', 'app');
  mkdirSync(path.join(stageApp, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(path.join(stageApp, 'node_modules', 'better-sqlite3', 'marker.txt'), 'NEW-BASELINE');

  const pending = m._stageDepsBaseline(stageApp);
  check(!!pending && pending.base === base, '新依赖先寄存到基线旁的临时目录', JSON.stringify(pending));
  check(readFileSync(path.join(base, 'better-sqlite3', 'marker.txt'), 'utf8') === 'OLD-BASELINE',
    '切换之前：旧代码正在用的基线一个字节都没变');
  check(lstatSync(path.join(stageApp, 'node_modules')).isSymbolicLink(), '暂存区只留指向寄存位置的软链');

  // 切换失败 → 调用方丢弃寄存目录：旧基线必须仍完好
  rmSync(pending.newBase, { recursive: true, force: true });
  check(readFileSync(path.join(base, 'better-sqlite3', 'marker.txt'), 'utf8') === 'OLD-BASELINE',
    '切换失败丢弃寄存依赖后：旧基线仍是 OLD-BASELINE（旧代码照常跑）');

  // 切换成功 → 转正：新依赖成基线、旧的留 .prev、运行目录依赖入口指回 base
  rmSync(path.join(stageApp, 'node_modules'), { force: true });
  mkdirSync(path.join(stageApp, 'node_modules', 'better-sqlite3'), { recursive: true });
  writeFileSync(path.join(stageApp, 'node_modules', 'better-sqlite3', 'marker.txt'), 'NEW-BASELINE');
  const pending2 = m._stageDepsBaseline(stageApp);
  check(m._commitDepsBaseline(pending2, runDir) === true, '切换成功后依赖基线转正成功');
  check(readFileSync(path.join(base, 'better-sqlite3', 'marker.txt'), 'utf8') === 'NEW-BASELINE', '转正后基线是新依赖');
  check(readFileSync(path.join(base + '.prev', 'better-sqlite3', 'marker.txt'), 'utf8') === 'OLD-BASELINE', '上一份依赖留在 <base>.prev');
  let depLink = '';
  try { depLink = fs.realpathSync(path.join(runDir, 'node_modules')); } catch { /* 没建起来 */ }
  check(!!depLink && depLink === fs.realpathSync(base), '运行目录的依赖入口重新指向正式基线', depLink);
}
{
  // 切换彻底失败（改名 + 覆盖两条路都不通）→ 上一版备份必须还在、运行目录仍是旧版本
  const S = path.join(TMP, 'swap-keep');
  const runDir = path.join(S, 'run');
  const oldDir = path.join(S, 'run.old');
  const newApp = path.join(S, 'new');
  mkdirSync(path.join(runDir, 'server'), { recursive: true });
  writeFileSync(path.join(runDir, 'server', 'server.js'), '// current\n');
  mkdirSync(path.join(oldDir, 'server'), { recursive: true });
  writeFileSync(path.join(oldDir, 'server', 'server.js'), '// previous backup\n');
  mkdirSync(path.join(newApp, 'server'), { recursive: true });
  writeFileSync(path.join(newApp, 'server', 'server.js'), '// new\n');
  const m = new UpdateManager({ appDir: runDir });
  m.logger = { info() {}, warn() {}, error() {}, debug() {} };

  const origRename = fs.renameSync;
  const origCp = fs.cpSync;
  fs.renameSync = (a, b) => {
    const A = String(a); const B = String(b);
    if (A === runDir || B === runDir || A === newApp) { const e = new Error('EBUSY: 模拟整目录改名失败'); e.code = 'EBUSY'; throw e; }
    return origRename(a, b);
  };
  fs.cpSync = () => { const e = new Error('EIO: 模拟覆盖失败'); e.code = 'EIO'; throw e; };
  let swapErr = '';
  try { m._swapIn(newApp, runDir, oldDir); } catch (e) { swapErr = e.message; }
  finally { fs.renameSync = origRename; fs.cpSync = origCp; }
  check(/EIO|覆盖失败/.test(swapErr), '切换彻底失败会抛错（不静默）', swapErr);
  check(readFileSync(path.join(oldDir, 'server', 'server.js'), 'utf8').includes('previous backup'),
    '切换失败后上一版备份 <target>.old 仍在（没在动刀之前被删掉）');
  check(readFileSync(path.join(runDir, 'server', 'server.js'), 'utf8').includes('current'), '切换失败后运行目录仍是原版本');
  check(!readdirSync(S).some((n) => n.includes('.stale-')), '不留 .stale- 临时目录残留', readdirSync(S).join(','));
}

/* ⑧ 跨进程更新锁：宿主手动更新 + 容器页面各跑一个进程时，谁也不能同时解包同一个暂存区 */
console.log('== U. 跨进程更新锁（O_EXCL 锁文件 + 30 分钟自动失效） ==');
{
  const L = path.join(TMP, 'lock');
  rmSync(L, { recursive: true, force: true });
  const target = path.join(L, '.run');
  const noop = { info() {}, warn() {}, error() {}, debug() {} };
  const m1 = new UpdateManager({ appDir: target });
  const m2 = new UpdateManager({ appDir: target });
  m1.logger = noop; m2.logger = noop;
  const lock1 = m1._acquireUpdateLock(target);
  check(fsExists(m1._lockFileFor(target)), '抢锁成功后 <target>.update.lock 存在');
  const info = JSON.parse(readFileSync(m1._lockFileFor(target), 'utf8'));
  check(info.pid === process.pid && typeof info.at === 'number', '锁内容记录 pid 与时间戳', JSON.stringify(info));
  let err = '';
  try { m2._acquireUpdateLock(target); } catch (e) { err = e.message; }
  check(/另一个更新进程正在进行/.test(err), '第二个进程抢锁失败并明确提示「另一个更新进程正在进行」', err);
  m1._releaseUpdateLock(lock1);
  check(!fsExists(m1._lockFileFor(target)), '放锁后锁文件被删除');

  // 过期锁（>30 分钟）自动失效：一次被 kill 不能让人永久无法更新
  writeFileSync(m1._lockFileFor(target), JSON.stringify({ pid: 999999, at: Date.now() - 31 * 60 * 1000, host: 'dead' }));
  let took = false;
  try { const l2 = m2._acquireUpdateLock(target); took = true; m2._releaseUpdateLock(l2); } catch (e) { err = e.message; }
  check(took, '超过 30 分钟的锁被判过期并接管', err);
  check(!fsExists(m1._lockFileFor(target)), '接管后放锁不留残留');

  // 主体抛错也必须走 finally 放锁，否则一次失败会把更新永久锁死
  const runDir = path.join(L, 'failrun');
  mkdirSync(runDir, { recursive: true });
  const m3 = new UpdateManager({ appDir: runDir, srcRoot: runDir });
  m3.logger = noop;
  m3.state.env = { mode: 'archive', srcRoot: runDir, inContainer: true };
  m3._runArchiveUpdateLocked = async () => { throw new Error('模拟主体失败'); };
  let bodyErr = '';
  try { await m3._runArchiveUpdate(m3.state.env, {}); } catch (e) { bodyErr = e.message; }
  check(/模拟主体失败/.test(bodyErr), '主体失败时错误向上抛（页面显示重试）', bodyErr);
  check(!fsExists(m3._lockFileFor(runDir)), '主体失败后锁已释放（不会永久锁死更新）');
}

/* ⑨ 仓库地址脱敏：token 不能进日志文件、不能进 /api/update/status */
console.log('== V. 仓库地址脱敏 / 拒绝把 token 写进地址 ==');
{
  check(redactUrl('https://user:ghp_secret123@github.com/a/b.git') === 'https://***@github.com/a/b.git',
    'redactUrl 把 user:token@ 打成 ***', redactUrl('https://user:ghp_secret123@github.com/a/b.git'));
  check(!/ghp_secret123/.test(redactUrl('https://github.com/a/b.git?access_token=ghp_secret123')), 'redactUrl 打掉查询参数里的 token');
  check(redactUrl('https://github.com/a/b.git') === 'https://github.com/a/b.git', '无凭据地址原样保留');
  check(redactUrl('') === '' && redactUrl(null) === '', '空值返回空串');
  const parts = splitGitUserInfo('https://x:tok@github.com/a/b.git');
  check(parts.url === 'https://github.com/a/b.git' && parts.pass === 'tok', 'splitGitUserInfo 摘出凭据并给出干净地址', JSON.stringify({ url: parts.url, pass: parts.pass ? '***' : '' }));

  // 老配置把 token 写在地址里：认证照旧（token 走 extraheader），但 argv/日志/status 里都没有明文
  const legacy = new UpdateManager({ appDir: TMP, getRepoConfig: () => ({ updateGitUrl: 'https://x:tok_in_url@github.com/acme/priv.git', updateToken: '' }) });
  legacy.envToken = '';
  check(legacy._gitUrl() === 'https://github.com/acme/priv.git', '交给 git 的地址已摘掉 userinfo', legacy._gitUrl());
  check(legacy._token() === 'tok_in_url', '摘下来的 token 仍被当凭据用（认证不丢）');
  check(!/tok_in_url/.test(JSON.stringify(legacy.status())), 'status() 里看不到明文 token');
  check(!/tok_in_url/.test(JSON.stringify(legacy._gitEnv().GIT_CONFIG_VALUE_0 || '')), 'git 环境变量里是 base64 凭据，不是明文 token');

  const m = new UpdateManager({ appDir: TMP });
  let threw = '';
  try { m.normalizeRepoConfig({ repo: 'https://user:tok123@github.com/a/b.git' }); } catch (e) { threw = e.message; }
  check(/Token/.test(threw) && /用户名|密码/.test(threw), 'normalizeRepoConfig 拒绝带 userinfo 的地址并提示用 Token 字段', threw);
  const okCfg = m.normalizeRepoConfig({ repo: 'https://github.com/a/b.git', token: 'tok123' });
  check(okCfg.gitUrl === 'https://github.com/a/b.git' && okCfg.token === 'tok123', '正常地址 + 独立 Token 字段照常通过');
}

console.log(bad === 0 ? '\n全部通过 ✅' : `\n${bad} 项失败 ❌`);
process.exit(bad === 0 ? 0 : 1);
