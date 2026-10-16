// 更新管理器单元测试：覆盖版本对比、远程不可用、公开/私有仓库、检查/应用流程
// 用 mock 全局 fetch 返回假 GitHub 响应，离线运行
import { UpdateManager } from '../server/update.js';

let bad = 0;
const check = (cond, label, extra = '') => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`); };

const TMP = '/tmp/lg-update-unit';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

async function fresh() {
  const m = new UpdateManager({ appDir: TMP });
  await m.detectEnv();
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
  const authArgs = m._gitAuthArgs();
  check(authArgs.length === 2 && authArgs[0] === '-c' && authArgs[1].includes('http.extraheader=Authorization: Basic'), 'git 认证参数正确注入');
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
  const m = await fresh();
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
  const m = await fresh();
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
  check(/git 可用|未检测到 git 仓库/.test(envLines[0]?.[1] || ''), '环境自检日志含 git 可用性判定');
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

console.log(bad === 0 ? '\n全部通过 ✅' : `\n${bad} 项失败 ❌`);
process.exit(bad === 0 ? 0 : 1);
