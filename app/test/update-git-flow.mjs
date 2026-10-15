// 架构 B 容器更新链路集成测试（离线、自包含）：
//   在临时目录构造「远端仓库 → clone 到 src（模拟容器 /config/src）→ 切到旧版本」场景，
//   验证 UpdateManager 在 <repo>/app 布局下的 git 根探测、本地信息读取、fetch/pull 快进、
//   更新判定与 npm install 的 cwd——即容器内点「立即更新」实际执行的 git 部分。
// 无 git 环境自动跳过（exit 0）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateManager } from '../server/update.js';

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve(err
      ? { ok: false, code: err.code, out: String(stdout || '').trim(), err: String(stderr || '').trim() }
      : { ok: true, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
  });
});

let bad = 0;
const check = (cond, label, extra = '') => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`); };

if (!(await run('git', ['--version'])).ok) {
  console.log('未检测到 git，跳过架构 B 更新链路测试');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-gitflow-'));
const REMOTE = path.join(TMP, 'remote.git');
const WORK = path.join(TMP, 'work');
const SRC = path.join(TMP, 'src'); // 模拟容器内的 /config/src
// 提交时固定作者信息，避免依赖全局 git config
const G = ['-c', 'user.email=test@livegrab.local', '-c', 'user.name=LiveGrab Test'];

const writeTree = (ver) => {
  fs.mkdirSync(path.join(WORK, 'app', 'server'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'app', 'package.json'), JSON.stringify({ name: 'livegrab', version: ver }, null, 2));
  fs.writeFileSync(path.join(WORK, 'app', 'server', 'server.js'), `// v${ver}\n`);
};

console.log('== 构造远端仓库（v0.1.6 → v0.1.7 两个提交） ==');
check((await run('git', ['init', '--bare', REMOTE])).ok, '创建临时远端 bare 仓库');
check((await run('git', ['init', WORK])).ok, '创建工作仓库');
// 老版本 git 没有 init -b：先用 symbolic-ref 把 HEAD 指到 main，再首次提交
check((await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: WORK })).ok, '默认分支设为 main');
writeTree('0.1.6');
check((await run('git', [...G, 'add', '.'], { cwd: WORK })).ok, '暂存 v0.1.6 代码树');
check((await run('git', [...G, 'commit', '-m', 'v0.1.6'], { cwd: WORK })).ok, '提交 v0.1.6');
check((await run('git', ['tag', 'v0.1.6'], { cwd: WORK })).ok, '打 v0.1.6 标签');
check((await run('git', ['remote', 'add', 'origin', REMOTE], { cwd: WORK })).ok, '关联远端');
check((await run('git', ['push', '-u', 'origin', 'main'], { cwd: WORK })).ok, '推送 main');
check((await run('git', ['push', 'origin', 'v0.1.6'], { cwd: WORK })).ok, '推送 v0.1.6 标签');
writeTree('0.1.7');
check((await run('git', [...G, 'add', '.'], { cwd: WORK })).ok, '暂存 v0.1.7 代码树');
check((await run('git', [...G, 'commit', '-m', 'v0.1.7'], { cwd: WORK })).ok, '提交 v0.1.7');
check((await run('git', ['tag', 'v0.1.7'], { cwd: WORK })).ok, '打 v0.1.7 标签');
check((await run('git', ['push', 'origin', 'main'], { cwd: WORK })).ok, '推送 v0.1.7');
check((await run('git', ['push', 'origin', 'v0.1.7'], { cwd: WORK })).ok, '推送 v0.1.7 标签');

console.log('== 模拟容器首启：clone + 切到镜像内置版本 ==');
check((await run('git', ['clone', '-b', 'main', REMOTE, SRC])).ok, 'clone 到 src（模拟 /config/src）');
check((await run('git', ['checkout', '-q', '-B', 'main', 'refs/tags/v0.1.6'], { cwd: SRC })).ok, '本地 main 切到 v0.1.6（entrypoint 同款命令）');
check((await run('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: SRC })).ok, '建立 origin/main 跟踪');

console.log('== UpdateManager 在 <repo>/app 布局下的探测与本地信息 ==');
const APP = path.join(SRC, 'app');
const m = new UpdateManager({ appDir: APP });
const gitRoot = await m._findGitRoot(APP);
check(!!gitRoot && path.resolve(gitRoot) === path.resolve(SRC), '从 app 目录向上探测到仓库根（gitRoot=<repo> 而非 <repo>/app）', String(gitRoot));
m.state.env = { gitAvailable: !!gitRoot, gitBin: 'git', gitRoot, dockerAvailable: false, inContainer: true };
const local = await m.localInfo();
check(local.version === '0.1.6', '本地版本取自 clone 的 package.json', local.version);
check(!!local.commit && local.branch === 'main', '本地 commit/分支读取自 git', `${local.branch}@${local.commit}`);

console.log('== 容器「立即更新」的 git 部分：fetch → 判定 → 快进拉取 ==');
const latest = {
  version: '0.1.7', tag: 'v0.1.7', unavailable: false,
  commit: (await run('git', ['rev-parse', '--short=12', 'v0.1.7'], { cwd: WORK })).out,
};
check(m._computeHasUpdate(local, latest) === true, 'v0.1.6 → v0.1.7 判定有更新');
const fetchR = await run('git', ['fetch', 'origin', 'main'], { cwd: gitRoot });
check(fetchR.ok, 'git fetch 成功', fetchR.err);
const pullR = await run('git', [...m._gitAuthArgs(), 'pull', '--ff-only', 'origin', 'main'], { cwd: gitRoot });
check(pullR.ok, 'git pull --ff-only 成功（分支上快进）', pullR.err);
const after = await m.localInfo();
check(after.version === '0.1.7', '拉取后本地版本为 0.1.7', after.version);
check(m._computeHasUpdate(after, latest) === false, '拉取后 commit 一致 → 判定无更新');

console.log('== npm install 的 cwd（update.js 用法） ==');
const npmCwd = path.join(gitRoot, 'app');
check(fs.existsSync(path.join(npmCwd, 'package.json')), 'npm install cwd 指向含 package.json 的 app 目录', npmCwd);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(bad === 0 ? '\n架构 B 更新链路：全部通过 ✅' : `\n${bad} 项失败 ❌`);
process.exit(bad ? 1 : 0);
