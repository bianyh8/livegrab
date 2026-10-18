// Docker 打包自检（本机不需要安装 Docker）
// 1) 静态校验 Dockerfile / docker-compose.yaml / .dockerignore 与代码是否自洽；
// 2) 用"容器形态"的环境变量（PORT=8080 / RECORD_ROOT / CONFIG_DIR / TZ）真起一次服务做冒烟；
// 3) 校验依赖：唯一第三方依赖 better-sqlite3，其余只允许 node: 内置模块与相对路径 import。
// 用法：node app/test/check-docker.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const ROOT = path.join(APP, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const check = (cond, label, extra = '') => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`); };
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const walkFiles = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
};

console.log('==== Docker 打包自检（不需要安装 Docker）====\n');

/* ---------- 1) 打包文件是否齐备 ---------- */
const P = { dockerfile: path.join(ROOT, 'Dockerfile'), compose: path.join(ROOT, 'docker-compose.yaml'), ignore: path.join(ROOT, '.dockerignore'), readme: path.join(ROOT, 'README.md') };
for (const [k, p] of Object.entries(P)) check(fs.existsSync(p), `打包文件存在：${path.basename(p)}`, k);
const dockerfile = readIf(P.dockerfile) || '';
const compose = readIf(P.compose) || '';
const ignore = readIf(P.ignore) || '';

/* ---------- 2) Dockerfile 结构 ---------- */
check(/^FROM\s+node:/m.test(dockerfile), 'Dockerfile 基于官方 node 镜像', (dockerfile.match(/^FROM\s+(\S+)/m) || [])[1]);
check(/apt-get install[^\n]*ffmpeg/.test(dockerfile), '镜像内安装系统 ffmpeg（录制/转封装/合并/回放唯一外部依赖）');
check(/EXPOSE\s+8080/.test(dockerfile), 'EXPOSE 8080 与服务默认端口一致');
check(/VOLUME\s+\[[^\]]*"\/data"[^\]]*"\/config"[^\]]*\]/.test(dockerfile), 'VOLUME 声明 /data 与 /config');
check(/ENV[\s\S]*RECORD_ROOT=\/data[\s\S]*CONFIG_DIR=\/config/.test(dockerfile), 'ENV 指向容器内 /data 与 /config');
check(/HEALTHCHECK[\s\S]*?\/api\/health/.test(dockerfile), 'HEALTHCHECK 探活 /api/health');
check(/STOPSIGNAL\s+SIGTERM/.test(dockerfile), 'STOPSIGNAL SIGTERM（配合 compose 的 stop_grace_period 收尾当前分段）');
check(/CMD\s+\["node",\s*"server\/server\.js"\]/.test(dockerfile), 'CMD 与 WORKDIR 下的入口路径一致');
/* package-lock.json 已移出版本控制（避免容器内自更新被锁文件卡死），故 Dockerfile 用
   npm install 而非 npm ci（后者强制要求锁文件存在）。两种写法都合规。 */
check(/\bnpm (?:ci|install) --omit=dev\b/.test(dockerfile), '镜像内只装生产依赖 better-sqlite3（无锁文件时用 npm install）');

/* ---------- 3) COPY 源都在构建上下文里 + 没被 .dockerignore 排除 ---------- */
const copySources = [];
for (const line of dockerfile.split(/\r?\n/)) {
  const m = /^COPY\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$/.exec(line.trim());
  if (m) copySources.push({ src: m[1], dest: m[2] });
}
check(copySources.length >= 5, 'Dockerfile 通过 COPY 复制应用代码', copySources.map((c) => c.src).join(' '));
const missing = copySources.filter((c) => !fs.existsSync(path.join(ROOT, c.src)));
check(missing.length === 0, '所有 COPY 源在构建上下文存在', missing.map((c) => c.src).join(' ') || '全部存在');

const patterns = ignore.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const ignored = (rel) => {
  const norm = rel.split(path.sep).join('/');
  const parts = norm.split('/');
  return patterns.some((pat) => {
    const p = pat.replace(/^\//, '');
    if (p.endsWith('/')) return parts.includes(p.slice(0, -1));
    if (p.includes('*')) {
      const rx = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
      return parts.some((seg) => rx.test(seg)) || rx.test(norm);
    }
    if (p.includes('/')) return norm === p || norm.startsWith(p + '/');
    return parts.includes(p);
  });
};
const hidden = copySources.filter((c) => ignored(c.src.split('/').join(path.sep)));
check(hidden.length === 0, '.dockerignore 没有排除 Dockerfile 需要的文件', hidden.map((c) => c.src).join(' ') || `规则 ${patterns.length} 条`);
check(ignored('ui/index.html') && ignored('ui/_app-dashboard.png'), '.dockerignore 把设计稿与截图排除在镜像外（交付物保持精简）');
check(ignored('data/x.ts') && ignored('config/state.json'), '.dockerignore 排除本地 data/config（不会把本机录像打进镜像）');

/* ---------- 4) compose 与 Dockerfile 自洽 ---------- */
check(/\$\{LIVEGRAB_PORT:-\d+\}:8080/.test(compose), 'compose 端口映射到容器 8080，宿主端口可用 LIVEGRAB_PORT 覆盖');
check(/\/data/.test(compose) && /\/config/.test(compose), 'compose 挂载 /data 与 /config');
check(/TZ:\s*"\$\{TZ:-/.test(compose), 'compose 里的 TZ 可配置（D15）');
check(/stop_grace_period/.test(compose), 'compose 设置 stop_grace_period（停止时给 ffmpeg 收尾时间）');
const envKeys = [...compose.matchAll(/^\s{6}([A-Z_]+):/gm)].map((m) => m[1]);
const serverSrc = walkFiles(path.join(APP, 'server')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
/* 代理类变量由容器入口脚本消费——git clone / npm install 在各自命令行显式带代理。
   判定「有人消费」时必须把 entrypoint.sh 也算进来，否则会把这些变量误报成无人使用。 */
const entrySrc = fs.readFileSync(path.join(ROOT, 'deploy', 'entrypoint.sh'), 'utf8');
const unread = envKeys.filter((k) => !serverSrc.includes(`process.env.${k}`) && !entrySrc.includes(k));
check(unread.length === 0, 'compose 里的环境变量都被服务代码或入口脚本读取', unread.join(' ') || envKeys.join(' '));

/* 代理绝不能以环境变量注入容器：ffmpeg 会读 HTTP_PROXY（实测对 http/https 输入都生效），
   一旦注入，用户在页面上关掉「平台代理开关」的平台也会被强制走代理，开关形同失效，
   且拉流失败时分不清是平台问题还是代理问题。
   v0.1.43 起代理只在页面「系统设置 → 平台账号 → 网络代理」维护，compose 不再传任何代理变量。 */
const leakedProxy = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'LIVEGRAB_PROXY']
  .filter((k) => new RegExp(`^\\s{6}${k}:`, 'm').test(compose));
check(leakedProxy.length === 0, 'compose 不注入任何代理变量（代理只在页面一处维护）', leakedProxy.join(' ') || '无');
check(/route\('GET', '\/api\/health'/.test(serverSrc), '健康检查端点 /api/health 真实存在');
check(/SIGTERM/.test(serverSrc) && /SIGINT/.test(serverSrc), '服务处理 SIGTERM/SIGINT 优雅退出');

/* 首次部署必须零网络：入口脚本只负责选代码目录，不 clone、不装依赖、不读写代理 */
check(!/\bgit\s+(?:-c\s+\S+\s+)?clone\b/.test(entrySrc), '入口脚本不 clone 仓库（首次部署零网络）');
check(!/\bnpm\s+(?:install|ci)\b/.test(entrySrc), '入口脚本不装依赖（依赖由镜像内置基线提供）');
check(!/HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|LIVEGRAB_PROXY|npm_config_proxy/.test(entrySrc), '入口脚本不读写任何代理变量');
check(/\$SRC\/app\/server\/server\.js/.test(entrySrc) && /IMAGE_APP/.test(entrySrc), '入口脚本按「更新落位目录优先、否则镜像代码」选目录');
/* 更新通道：按 commit 下载 GitHub 归档 + 原地切换，全程不需要 git */
check(/codeload\.github\.com/.test(serverSrc) && /_commitArchiveUrl/.test(serverSrc), '更新链路按 commit 下载源码归档（不依赖 git）');
check(/commitFull/.test(serverSrc) && /_computeHasUpdate/.test(serverSrc), '版本判定以 commit 为准（commitFull 参与比对）');
check(/LIVEGRAB_SRC_DIR/.test(serverSrc) && /LIVEGRAB_IMAGE_APP/.test(entrySrc), '入口脚本把「落位目录 / 镜像目录」交给服务进程');
check(/\.livegrab-version\.json/.test(serverSrc), '更新落位后写版本标记（容器内无 .git 时的版本来源）');

/* ---------- 5) 依赖：唯一第三方依赖 better-sqlite3，其余只允许 node: 内置模块与相对路径 ---------- */
const pkg = JSON.parse(readIf(path.join(APP, 'package.json')) || '{}');
const deps = Object.keys(pkg.dependencies || {});
check(deps.length === 1 && deps[0] === 'better-sqlite3', 'package.json 唯一第三方依赖为 better-sqlite3', deps.join(',') || '无依赖');
check(fs.existsSync(path.join(APP, 'package-lock.json')), '存在 package-lock.json（Dockerfile 里 npm ci 可复现构建）');
const srcFiles = [...walkFiles(path.join(APP, 'server')), ...walkFiles(path.join(APP, 'web')), ...walkFiles(path.join(APP, 'test'))].filter((f) => /\.(js|mjs)$/.test(f));
const badImports = [];
for (const f of srcFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import[^;\n]*?from|export[^;\n]*?from)\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/') && spec !== 'better-sqlite3') badImports.push(`${path.relative(ROOT, f)} → ${spec}`);
  }
}
check(badImports.length === 0, `全部 ${srcFiles.length} 个前端/后端/测试文件只 import node: 内置模块、相对路径或唯一依赖 better-sqlite3`, badImports.slice(0, 4).join(' | '));

/* ---------- 6) 容器形态冒烟：用 compose 里的环境变量真起一次服务 ---------- */
// compose 把容器 8080 映射到宿主；本机若已有实例占用 8080，就换端口做同样的冒烟（只是端口号不同）
const portBusy = await new Promise((res) => {
  const s = net.createServer();
  s.once('error', () => res(true));
  s.once('listening', () => s.close(() => res(false)));
  s.listen(8080, '0.0.0.0');
});
const PORT = portBusy ? 18080 : 8080;
check(true, portBusy ? `宿主 8080 已被占用（本机已有实例在跑），改用 ${PORT} 做同形态冒烟` : '宿主 8080 空闲，按 compose 配置原样冒烟');
const SIM = path.join(os.tmpdir(), `livegrab-docker-sim-${Date.now()}`);
const SIM_DATA = path.join(SIM, 'data');
const SIM_CFG = path.join(SIM, 'config');
fs.mkdirSync(SIM_DATA, { recursive: true });
fs.mkdirSync(SIM_CFG, { recursive: true });
const env = { ...process.env, PORT: String(PORT), RECORD_ROOT: SIM_DATA, CONFIG_DIR: SIM_CFG, TZ: 'Asia/Shanghai', LIVEGRAB_VERSION: '0.1.0' };
const srv = spawn(process.execPath, ['server/server.js'], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += `[err] ${d}`; });
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* retry */ }
  if (!up) await sleep(300);
}
check(up, '以容器形态环境变量启动成功（PORT + RECORD_ROOT/CONFIG_DIR 指向模拟卷）', log.trim().split('\n').slice(-2).join(' / ').slice(0, 160));
if (up) {
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()).data || {};
  check(health.tz === 'Asia/Shanghai', 'TZ 环境变量生效（/api/health.tz）', String(health.tz));
  check(typeof health.ffmpeg?.available === 'boolean', 'ffmpeg 探测字段存在（容器内为 apt 安装的 ffmpeg）', `available=${health.ffmpeg?.available}`);
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/status`);
  check(noAuth.status === 401, '未登录访问受保护接口被拒（首次部署就是登录页）', `HTTP ${noAuth.status}`);
  const initRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'livegrab123' }) });
  const cookie = (initRes.headers.get('set-cookie') || '').split(';')[0];
  check(initRes.ok && cookie.startsWith('lg_session='), '首次部署可初始化管理员并拿到会话 Cookie', cookie.slice(0, 22) + '…');
  const status = (await (await fetch(`http://127.0.0.1:${PORT}/api/status`, { headers: { cookie } })).json()).data || {};
  check(String(status.recordRoot || '').replace(/\\/g, '/').endsWith('/data'), 'RECORD_ROOT 生效（录制会落到挂载卷 /data）', String(status.recordRoot));
  check((status.engine?.version || '') !== '' && !!status.engine, 'engine 状态可读（容器内应显示 apt ffmpeg 可用）', JSON.stringify(status.engine || {}).slice(0, 90));
  const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  check(/LiveGrab|登录/.test(html) && html.length > 1000, '管理页面正常返回（浏览器直接访问）', `${html.length} 字节`);
  srv.kill('SIGTERM');
  const exited = await new Promise((res) => { const t = setTimeout(() => res(false), 15000); srv.on('exit', () => { clearTimeout(t); res(true); }); });
  check(exited, 'SIGTERM 后进程退出（容器 stop / compose stop_grace_period 生效）', process.platform === 'win32' ? 'Windows 下无法观测优雅收尾，容器内为退出码 0' : '');
  check(fs.existsSync(SIM_CFG) && fs.readdirSync(SIM_DATA) !== null, '模拟 /data 与 /config 卷在运行后可访问（卷挂载点已就绪）');
}
if (srv.exitCode === null) srv.kill();
await sleep(300);
fs.rmSync(SIM, { recursive: true, force: true });

/* ---------- 7) 更新落位形态：从 ${CONFIG_DIR}/src/app 启动（页面「立即更新」之后的状态） ---------- */
// 入口脚本在容器里就是这么选目录的：/config/src/app 存在且完整就跑它。
// 这里把「更新落位目录」造出来（代码 + 指向镜像基线的 node_modules），验证：
//   ① 能真正启动；② 更新模式判定为 archive（不依赖 git）；③ 本地版本取自 .livegrab-version.json。
{
  const UPD = path.join(os.tmpdir(), `livegrab-updated-${Date.now()}`);
  const UPD_SRC = path.join(UPD, 'src');
  const UPD_APP = path.join(UPD_SRC, 'app');
  fs.mkdirSync(UPD_APP, { recursive: true });
  // 手工遍历复制（不依赖 fs.cpSync：个别环境的 fs 沙箱不支持递归复制）
  const copyTree = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) copyTree(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  for (const d of ['server', 'web']) copyTree(path.join(APP, d), path.join(UPD_APP, d));
  fs.copyFileSync(path.join(APP, 'package.json'), path.join(UPD_APP, 'package.json'));
  let nmHow = 'link';
  try { fs.symlinkSync(path.join(APP, 'node_modules'), path.join(UPD_APP, 'node_modules'), 'junction'); }
  catch { copyTree(path.join(APP, 'node_modules'), path.join(UPD_APP, 'node_modules')); nmHow = 'copy'; }
  fs.writeFileSync(path.join(UPD_APP, '.livegrab-version.json'), JSON.stringify({ version: '9.9.9', tag: 'v9.9.9', commit: 'abc123456789', at: Date.now() }));

  const PORT2 = PORT + 1;
  const env2 = {
    ...process.env, PORT: String(PORT2), RECORD_ROOT: path.join(UPD, 'data'), CONFIG_DIR: path.join(UPD, 'config'),
    LIVEGRAB_SRC_DIR: UPD_SRC, LIVEGRAB_IMAGE_APP: APP, TZ: 'Asia/Shanghai',
  };
  const srv2 = spawn(process.execPath, ['server/server.js'], { cwd: UPD_APP, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  let up2 = false;
  for (let i = 0; i < 40 && !up2; i++) {
    try { up2 = (await fetch(`http://127.0.0.1:${PORT2}/api/health`)).ok; } catch { /* retry */ }
    if (!up2) await sleep(300);
  }
  check(up2, '从「页面更新落位目录」启动成功（入口脚本选目录的最终形态）', `node_modules=${nmHow}`);
  if (up2) {
    const init2 = await fetch(`http://127.0.0.1:${PORT2}/api/auth/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'livegrab123' }) });
    const ck = (init2.headers.get('set-cookie') || '').split(';')[0];
    const st = (await (await fetch(`http://127.0.0.1:${PORT2}/api/update/status`, { headers: { cookie: ck } })).json()).data || {};
    check(st.mode === 'archive', '更新模式判定为容器归档通道（不需要 git）', String(st.mode));
    check(st.canSelfUpdate === true, 'canSelfUpdate=true（页面据此显示自动重启提示）');
    check(String(st.local?.version || '') === '9.9.9' && String(st.local?.tag || '') === 'v9.9.9', '本地版本取自 .livegrab-version.json', JSON.stringify(st.local));
    check(String(st.srcRoot || '').replace(/\\/g, '/').replace(/\/$/, '').endsWith('/src'), '新版本落位目录来自 LIVEGRAB_SRC_DIR', String(st.srcRoot));
    // 更新链路的自检信息写日志文件（logger 只落盘 + SSE，不打印到 stdout）
    await sleep(300);
    let fileLog = '';
    try {
      for (const f of fs.readdirSync(path.join(UPD, 'config', 'logs'))) {
        if (f.endsWith('.log')) fileLog += fs.readFileSync(path.join(UPD, 'config', 'logs', f), 'utf8');
      }
    } catch { /* 日志目录还没建也不影响其它断言 */ }
    check(/更新环境自检[^\n]*归档/.test(fileLog), '日志写明「更新走 GitHub 归档」（不用 git）', (fileLog.match(/更新环境自检[^\n]*/) || [''])[0].slice(0, 130) || fileLog.slice(-160));
    srv2.kill('SIGTERM');
    await new Promise((res) => { const t = setTimeout(res, 8000); srv2.on('exit', () => { clearTimeout(t); res(); }); });
  }
  if (srv2.exitCode === null) srv2.kill();
  await sleep(200);
  fs.rmSync(UPD, { recursive: true, force: true });
}

console.log(`\n==== 打包自检结果：${bad === 0 ? 'ALL PASS' : `${bad} 项失败`} ====`);
console.log('提示：本脚本不执行 docker build（本机可能没装 Docker）。真正的镜像构建请在宿主机执行：');
console.log('      docker compose up -d --build');
console.log('      容器首次启动用镜像内 /app；页面「立即更新」后从 /config/src/app 运行。验证运行中代码：');
console.log('      docker compose exec -w /config/src/app livegrab node test/e2e-ffmpeg.mjs');
process.exit(bad ? 1 : 0);
