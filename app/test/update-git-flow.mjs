// 本地 git 工作区更新链路集成测试（离线、自包含）：
//   在临时目录构造「远端仓库 → clone 到 <repo>/app → 切到旧版本」场景，
//   验证 UpdateManager 在本地 git 形态下的 git 根探测、本地信息读取、fetch/pull 快进、
//   快照兜底与 npm install 的 cwd——容器部署走归档通道，不经过这里。
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
  console.log('未检测到 git，跳过本地 git 更新链路测试');
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

console.log('== 拉取失败后的处理流程：降级重试参数 → 本地快进 → 快照通道兜底 ==');
{
  // 用本地打包的远端仓库验证「带降级重试的 fetch」在真实 git 上可用（与线上同一份参数）
  const env = m.state.env;
  const r2 = await m._fetchWithRetry(env, REMOTE, 'main');
  check(r2.ok, '_fetchWithRetry 用配置的远端地址拉取成功', r2.err);
  check(r2.attempt === 1, '本地远端一次即成功（无需降级）', `attempt=${r2.attempt} ${r2.label}`);
  const fh = await run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: gitRoot });
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: gitRoot });
  check(fh.out === head.out, 'FETCH_HEAD 与本地 HEAD 一致（已是最新）');

  // 造一个更新版本 v0.1.8，并删掉 v0.1.7 里的 app/server/old.js（验证快照会清理上游已删除文件）
  writeTree('0.1.7');
  fs.writeFileSync(path.join(WORK, 'app', 'server', 'old.js'), '// 上游后续会删除\n');
  check((await run('git', [...G, 'add', '.'], { cwd: WORK })).ok, '暂存含 old.js 的 v0.1.7 树');
  check((await run('git', [...G, 'commit', '-m', 'v0.1.7b'], { cwd: WORK })).ok, '重新提交 v0.1.7（含 old.js）');
  check((await run('git', ['tag', '-f', 'v0.1.7'], { cwd: WORK })).ok, '移动 v0.1.7 标签');

  // 先把 SRC 变成「含 old.js 的 v0.1.7」：直接把 old.js 写进去并提交（模拟旧代码）
  fs.writeFileSync(path.join(gitRoot, 'app', 'server', 'old.js'), '// 上游后续会删除\n');
  check((await run('git', [...G, 'add', '.'], { cwd: gitRoot })).ok, 'SRC 暂存 old.js');
  check((await run('git', [...G, 'commit', '-m', 'local v0.1.7 with old.js'], { cwd: gitRoot })).ok, 'SRC 提交 old.js（模拟旧代码）');
  const localBefore = await m.localInfo();
  check(localBefore.version === '0.1.7', '快照前本地为 v0.1.7', localBefore.version);

  // 远端推进到 v0.1.8：删掉 old.js 并提交/打标签/推送
  writeTree('0.1.8');
  fs.rmSync(path.join(WORK, 'app', 'server', 'old.js'), { force: true });
  check((await run('git', [...G, 'add', '-A'], { cwd: WORK })).ok, '暂存 v0.1.8 树（含删除 old.js）');
  check((await run('git', [...G, 'commit', '-m', 'v0.1.8'], { cwd: WORK })).ok, '提交 v0.1.8');
  check((await run('git', ['tag', 'v0.1.8'], { cwd: WORK })).ok, '打 v0.1.8 标签');
  check((await run('git', ['push', 'origin', 'main'], { cwd: WORK })).ok, '推送 v0.1.8');
  check((await run('git', ['push', 'origin', 'v0.1.8'], { cwd: WORK })).ok, '推送 v0.1.8 标签');

  // 打包 v0.1.8 的归档（结构与 GitHub 一致：顶层 <repo>-<branch>/）
  const SNAP = path.join(TMP, 'snaproot');
  fs.mkdirSync(path.join(SNAP, 'livegrab-main'), { recursive: true });
  fs.cpSync(path.join(WORK, 'app'), path.join(SNAP, 'livegrab-main', 'app'), { recursive: true });
  const TGZ = path.join(TMP, 'v018.tar.gz');
  let pack = await run('tar', ['-czf', TGZ, '-C', SNAP, 'livegrab-main']);
  if (!pack.ok) pack = await run('tar', ['-czf', TGZ, '--force-local', '-C', SNAP, 'livegrab-main']);
  check(pack.ok, '生成 v0.1.8 快照归档', pack.err);

  const latestV18 = {
    version: '0.1.8', tag: 'v0.1.8', unavailable: false,
    commit: (await run('git', ['rev-parse', '--short=12', 'v0.1.8'], { cwd: WORK })).out,
  };
  check(!!latestV18.commit, '取到 v0.1.8 的 commit');
  const beforeFetch = await m.localInfo();
  check(m._computeHasUpdate(beforeFetch, latestV18) === true, 'v0.1.7 → v0.1.8 判定有更新');

  const applied = await m._applySnapshot(fs.readFileSync(TGZ), env, latestV18);
  check(applied.copied > 0 && applied.version === '0.1.8', '快照落地并读出归档内版本号', `copied=${applied.copied} v${applied.version}`);
  check(!fs.existsSync(path.join(gitRoot, 'app', 'server', 'old.js')), '上游已删除的文件被清理（按旧 commit 清单，不误删未跟踪文件）');
  check(fs.readFileSync(path.join(gitRoot, 'app', 'package.json'), 'utf8').includes('0.1.8'), '工作区 package.json 已更新到 0.1.8');
  const snapMark = m._readSnapshot(env);
  check(!!snapMark && snapMark.commit === latestV18.commit, '写入快照标记（记录实际落地的 commit）', JSON.stringify(snapMark && snapMark.commit));
  const localAfterSnap = await m.localInfo();
  check(localAfterSnap.version === '0.1.8' && localAfterSnap.commit === latestV18.commit,
    '快照后 localInfo 以标记为准（不会拿落后的 .git 索引冒充旧版本）', `${localAfterSnap.version}/${localAfterSnap.commit}`);
  check(m._computeHasUpdate(localAfterSnap, latestV18) === false, '快照后不再提示「可用更新」');
  check(!!m.status().snapshot, 'status() 上报 snapshot，前端可提示「索引待对齐」');

  // 自愈：下次 fetch 成功时把 .git 索引对齐到远端，并清掉标记
  const okNext = await m._fetchWithRetry(env, REMOTE, 'main');
  check(okNext.ok, '下一次 fetch 成功（网络恢复）');
  check(await m._alignGitToWorktree(env) === true, 'git 索引对齐成功（工作区干净时 reset --hard FETCH_HEAD）');
  check(m._readSnapshot(env) === null, '对齐后清除快照标记');
  const st = await run('git', ['status', '--porcelain'], { cwd: gitRoot });
  check(st.out.trim() === '', '对齐后工作区与远端提交完全一致（git status 干净）', st.out.trim().slice(0, 120));
  const healed = await m.localInfo();
  check(healed.version === '0.1.8' && healed.commit === latestV18.commit, '自愈后本地版本以 git 为准且等于远端', `${healed.version}/${healed.commit}`);
  const healedHasNew = m._computeHasUpdate(healed, latestV18);
  check(healedHasNew === false, '自愈后判定已是最新');

  // 安全闸门：快照之后有人改过代码 → 不得自动对齐（不覆盖用户改动）
  check((await m._applySnapshot(fs.readFileSync(TGZ), env, latestV18)).copied > 0, '再次走一次快照通道（用于验证安全闸门）');
  check(!!m._readSnapshot(env), '此时存在快照标记');
  fs.appendFileSync(path.join(gitRoot, 'app', 'server', 'server.js'), '\n// 本地手工改动\n');
  check((await m._fetchWithRetry(env, REMOTE, 'main')).ok, '再次 fetch 成功');
  check(await m._alignGitToWorktree(env) === false, '工作区在快照后被改动 → 拒绝自动对齐（保护本地改动）');
  check(!!m._readSnapshot(env), '被拒绝时保留快照标记（状态不撒谎）');
  check(fs.readFileSync(path.join(gitRoot, 'app', 'server', 'server.js'), 'utf8').includes('本地手工改动'), '本地改动确实还在（没被 reset 掉）');
  // 把文件内容还原成快照内容（不是 git checkout：index 里还是旧代码），指纹恢复一致后即可对齐
  fs.copyFileSync(
    path.join(SNAP, 'livegrab-main', 'app', 'server', 'server.js'),
    path.join(gitRoot, 'app', 'server', 'server.js'),
  );
  check(await m._alignGitToWorktree(env) === true, '内容还原后可以正常对齐');
  check(m._readSnapshot(env) === null, '对齐成功即清除标记');

  // 全档位失败：三档重试都跑过，最终如实返回失败（不会假装成功）
  const dead = await m._fetchWithRetry(env, 'https://127.0.0.1:9/nope.git', 'main');
  check(dead.ok === false && dead.tried === 3, '远端不可达时跑满 3 档重试并如实失败', `tried=${dead.tried} code=${dead.code}`);
}

console.log('== 归档通道（容器）里残留的旧 .git 不得冒充本地版本 ==');
{
  // 现实场景：容器早期用 git 通道更新过（.git 停在旧提交），之后更新改走归档通道（只写落位标记、不碰 .git），
  // 于是 .git HEAD 永久停在旧提交。若 localInfo 优先读 .git，「已部署」会永远显示旧 commit、反复提示「可用更新」，
  // 点更新又什么都不做（自己和自己比，commit 永远不同）。
  const headOld = (await run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: gitRoot })).out;
  const markerCommit = (await run('git', ['rev-parse', '--short=12', 'v0.1.8'], { cwd: WORK })).out;
  // 把残留 .git 的分支指回更早的 v0.1.6（只动 ref，不碰工作区——归档通道正是这样从不更新 .git 的）
  const staleSha = (await run('git', ['rev-parse', '--short=12', 'v0.1.6'], { cwd: WORK })).out;
  check((await run('git', ['update-ref', 'refs/heads/main', 'refs/tags/v0.1.6'], { cwd: gitRoot })).ok, '把残留 .git 的 HEAD 挪回 v0.1.6（模拟从不更新 .git）');
  const headStale = (await run('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: gitRoot })).out;
  check(headStale === staleSha && headStale !== markerCommit, '构造出「.git HEAD 落后于落位标记」的形态', `HEAD ${headStale} / 标记 ${markerCommit}（对齐前 SRC HEAD ${headOld}）`);
  // 归档落位：代码内容换成归档里的 + 写落位标记（.git 完全不动，与真实容器一致）
  fs.writeFileSync(path.join(gitRoot, 'app', 'package.json'), JSON.stringify({ name: 'livegrab', version: '0.1.9' }, null, 2));
  fs.writeFileSync(path.join(gitRoot, 'app', '.livegrab-version.json'), JSON.stringify({
    version: '0.1.9', tag: 'v0.1.9', commit: markerCommit, commitFull: '', commitAt: '2026-10-19T02:00:00Z',
    remoteTag: 'v0.1.9', pkgVersion: '0.1.9', depsInstalled: false, at: Date.now(), from: '0.1.8',
  }, null, 2));
  const envArchive = { mode: 'archive', gitAvailable: true, gitBin: 'git', gitRoot, dockerAvailable: false, inContainer: true, srcRoot: SRC };
  const mArc = new UpdateManager({ appDir: APP });
  mArc.state.env = envArchive;
  const arcLocal = await mArc.localInfo();
  check(arcLocal.version === '0.1.9', '归档模式本地版本取自落位标记', arcLocal.version);
  check(arcLocal.commit === markerCommit && arcLocal.commit !== headStale,
    '归档模式以落位标记的 commit 为准，不拿残留 .git 的 HEAD 冒充', `标记 ${markerCommit} / git HEAD ${headStale} / 实际 ${arcLocal.commit}`);
  check(arcLocal.commitDate === '2026-10-19T02:00:00Z', 'commitDate 用标记里的 commitAt（降级保护才有依据）', arcLocal.commitDate);
  const latestV19 = { version: '0.1.9', tag: 'v0.1.9', unavailable: false, commit: markerCommit, commitAt: '2026-10-19T02:00:00Z' };
  check(mArc._computeHasUpdate(arcLocal, latestV19) === false, '落位后不再误报「可用更新」（同一 commit 不提示更新）');
  check((mArc.status().log || []).some((l) => /以落位标记为准/.test(String((l && l.msg) || ''))), '归档模式发现残留 .git 时记一条诊断日志');
  // 回归保护：没有落位标记（镜像首启、从没页面更新过）时，归档模式仍回退 .git/构建信息，不能变成空
  fs.rmSync(path.join(gitRoot, 'app', '.livegrab-version.json'), { force: true });
  const mNoMark = new UpdateManager({ appDir: APP });
  mNoMark.state.env = envArchive;
  const noMark = await mNoMark.localInfo();
  check(!!noMark.commit, '无落位标记时仍能给出本地版本（回退 .git HEAD）', noMark.commit);
}

console.log('== npm install 的 cwd（update.js 用法） ==');
const npmCwd = path.join(gitRoot, 'app');
check(fs.existsSync(path.join(npmCwd, 'package.json')), 'npm install cwd 指向含 package.json 的 app 目录', npmCwd);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(bad === 0 ? '\n本地 git 更新链路：全部通过 ✅' : `\n${bad} 项失败 ❌`);
process.exit(bad ? 1 : 0);
