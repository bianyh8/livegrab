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

global.fetch = realFetch;
console.log(bad === 0 ? '\n全部通过 ✅' : `\n${bad} 项失败 ❌`);
process.exit(bad === 0 ? 0 : 1);
