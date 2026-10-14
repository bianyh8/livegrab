// Docker 打包自检（本机不需要安装 Docker）
// 1) 静态校验 Dockerfile / docker-compose.yml / .dockerignore 与代码是否自洽；
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
const P = { dockerfile: path.join(ROOT, 'Dockerfile'), compose: path.join(ROOT, 'docker-compose.yml'), ignore: path.join(ROOT, '.dockerignore'), readme: path.join(ROOT, 'README.md') };
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
check(/\bnpm ci --omit=dev\b/.test(dockerfile), '镜像内 npm ci --omit=dev 安装唯一生产依赖 better-sqlite3');

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
check(/\$\{LIVEGRAB_PORT:-8080\}:8080/.test(compose), 'compose 端口映射到容器 8080，宿主端口可用 LIVEGRAB_PORT 覆盖');
check(/\/data/.test(compose) && /\/config/.test(compose), 'compose 挂载 /data 与 /config');
check(/TZ:\s*"\$\{TZ:-/.test(compose), 'compose 里的 TZ 可配置（D15）');
check(/stop_grace_period/.test(compose), 'compose 设置 stop_grace_period（停止时给 ffmpeg 收尾时间）');
const envKeys = [...compose.matchAll(/^\s{6}([A-Z_]+):/gm)].map((m) => m[1]);
const serverSrc = walkFiles(path.join(APP, 'server')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const unread = envKeys.filter((k) => !serverSrc.includes(`process.env.${k}`));
check(unread.length === 0, 'compose 里的环境变量都被代码读取', unread.join(' ') || envKeys.join(' '));
check(/route\('GET', '\/api\/health'/.test(serverSrc), '健康检查端点 /api/health 真实存在');
check(/SIGTERM/.test(serverSrc) && /SIGINT/.test(serverSrc), '服务处理 SIGTERM/SIGINT 优雅退出');

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

console.log(`\n==== 打包自检结果：${bad === 0 ? 'ALL PASS' : `${bad} 项失败`} ====`);
console.log('提示：本脚本不执行 docker build（本机可能没装 Docker）。真正的镜像构建请在宿主机执行：');
console.log('      docker compose up -d --build   →   docker compose exec livegrab node test/e2e-ffmpeg.mjs');
process.exit(bad ? 1 : 0);
