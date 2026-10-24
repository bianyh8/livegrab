// HTTP 服务：静态资源 + API + SSE + Range 流
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { openDb, schemaVersion, SCHEMA_VERSION } from './db.js';
import { cleanupLegacyFiles } from './legacy-cleanup.js';
import { Logger } from './logger.js';
import { Auth, parseCookies, COOKIE_NAME } from './auth.js';
import { Storage, playModeOf } from './storage.js';
import { sortFileRows } from './file-order.js';
import { Notifier } from './notify.js';
import { Scheduler } from './scheduler.js';
import { PlayManager } from './play.js';
import { UpdateManager } from './update.js';
import { closeAllSse, closeHttpServer } from './httpClose.js';
import * as media from './media.js';
import { resolveRoom, platformList, PLATFORMS } from './resolvers/index.js';
import { previewNaming, VARIABLES, DEFAULT_OPTIONS, qualityLabel, NAMING_OPTION_CHOICES } from './naming.js';
import {
  ok, fail, HttpError, readBody, mimeByExt, parseRange, extOf, VERSION,
  ensureDir, formatBytes, tzName, safeJoin, errText, dateKey,
  isPrivateHost, assertRemoteUrl,
} from './util.js';

// 播放日志节流：同一文件 10s 内只记一次，避免视频拖动/Range 请求刷屏日志
const playLogTs = new Map();
const PLAY_LOG_GAP = 10000;

// 时区：默认 Asia/Shanghai；Docker 里由 compose 的 environment: TZ 注入（前台不再显示/修改，D15）。
// 影响「今日」统计口径与文件名/日志里的日期时间，必须在任何时间格式化之前设定。
if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const WEB_DIR = path.join(APP_DIR, 'web');
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const RECORD_ROOT = process.env.RECORD_ROOT || '/data';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/** 是否运行在容器内：容器里的 127.0.0.1 指向容器自身，代理填回环地址必然连不通。
    设置页据此给出提示（仅 Docker 部署才有意义，本地直跑时 127.0.0.1 是正确的）。
    判据：/.dockerenv 存在，或 PID 1 的 cgroup 含 docker/containerd/kubepods。 */
const IN_DOCKER = (() => {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
    return /docker|containerd|kubepods/i.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch { return false; }
})();

const server = http.createServer();
const sseClients = new Set();

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch { sseClients.delete(c); }
  }
}

// ---------- 视图序列化 ----------
function fileView(f) {
  return {
    ...f,
    bytesLabel: formatBytes(f.bytes || 0),
    playMode: playModeOf(f.ext ? `.${f.ext}` : extOf(f.name)),
    playUrl: `/api/files/${f.id}/stream`,
    downloadUrl: `/api/files/${f.id}/download`,
  };
}

/** 会话实际占用字节：segments+extras+merged+mp4 按路径去重。
 *  不直接信任存储的 session.bytes（转封装/合并时可能未同步），从真实文件记录计算，保证统计与文件列表一致。 */
function sessionFileBytes(s) {
  const seen = new Set();
  let n = 0;
  for (const f of [...(s.segments || []), ...(s.extras || []), s.merged, s.mp4]) {
    if (f && f.path && !seen.has(f.path)) { seen.add(f.path); n += f.bytes || 0; }
  }
  return n;
}

function sessionView(s) {
  const segments = (s.segments || []).map(fileView);
  const extras = (s.extras || []).map(fileView);
  return {
    id: s.id, taskId: s.taskId, platform: s.platform, platformName: s.platformName,
    roomId: s.roomId, streamer: s.streamer, title: s.title,
    quality: s.quality, qualityLabel: s.qualityLabel || qualityLabel(s.quality),
    startedAt: s.startedAt, endedAt: s.endedAt, durationSec: s.durationSec || 0,
    bytes: sessionFileBytes(s), status: s.status, dir: s.dir, relDir: s.relDir,
    segments, extras,
    merged: s.merged ? fileView(s.merged) : null,
    mp4: s.mp4 ? fileView(s.mp4) : null,
    segmentCount: segments.length,
    missingCount: segments.filter((f) => f.status === 'missing').length,
  };
}

// ---------- 主流程 ----------
/** 读取并转写容器启动引导事件（deploy/entrypoint.sh 写入的 ${configDir}/.bootstrap-events，
    格式为「LEVEL 消息」逐行）：克隆/回退/预热/依赖检查原本只进 Docker stdout，转写后
    也进日志文件与「运行日志」页；读完即删，容器不重启不会重复记录。 */
async function ingestBootstrapEvents(configDir, logger) {
  const file = path.join(configDir, '.bootstrap-events');
  const txt = await fsp.readFile(file, 'utf8').catch(() => '');
  if (!txt.trim()) { await fsp.rm(file, { force: true }).catch(() => {}); return 0; }
  let count = 0;
  for (const line of txt.split('\n')) {
    const m = /^(INFO|WARN|ERROR|DEBUG)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    logger.log(m[1], `[容器启动] ${m[2]}`);
    count++;
  }
  await fsp.rm(file, { force: true }).catch(() => {});
  return count;
}

async function bootstrap() {
  // logger 就绪前的启动日志（db 初始化等）先入缓冲，就绪后补写进日志文件，保证启动全程可查
  const early = [];
  const earlyLog = (level, msg) => early.push({ level, msg });
  // ---------- 持久层：SQLite v2（唯一存储，无 JSON 镜像、无迁移） ----------
  const dbPath = path.join(CONFIG_DIR, 'livegrab.db');
  const db = openDb(dbPath, earlyLog); // 空库建表；旧版本库（含 v1 data_json 结构）作废重建为空库
  const legacyRemoved = await cleanupLegacyFiles(CONFIG_DIR); // 清除 state.json 等旧 JSON 遗留（独立方法，日后可整段删除）
  if (legacyRemoved.length) earlyLog('INFO', `旧 JSON 遗留清理：${legacyRemoved.join('、')}`);
  const store = new Store(CONFIG_DIR);
  // 容器环境变量优先（compose 是唯一来源）
  store.settings.recordRoot = RECORD_ROOT;
  store.settings.configDir = CONFIG_DIR;
  await store.init(db);
  earlyLog('INFO', `SQLite v2 持久层就绪：${dbPath}（schema_version=${schemaVersion(db)}/${SCHEMA_VERSION}，仅 SQLite）`);
  const logger = await new Logger({
    dir: path.join(CONFIG_DIR, 'logs'),
    level: store.settings.logLevel || 'INFO',
    retentionDays: store.settings.logRetentionDays || 14,
  }).init();
  store.logger = logger; // 持久层运行时错误（落盘失败/冲突行）随后进日志文件
  for (const l of early) logger.log(l.level, l.msg);
  // 容器首启事件 → 正式日志（前缀 [容器启动]）：克隆结果/回退/预热/依赖检查，重启后仍可查
  await ingestBootstrapEvents(CONFIG_DIR, logger);
  const auth = await new Auth(CONFIG_DIR).init();
  auth.logger = logger; // 失败登录必须进日志（审计/暴力破解排查）
  const storage = new Storage({ store, logger });
  const notifier = new Notifier({ store, logger });
  const scheduler = new Scheduler({
    store, logger, notifier, storage,
    onEvent: (e) => {
      broadcast(e.type || 'update', e);
      if (e.type === 'task') broadcast('status', { at: Date.now() });
    },
  });
  const play = new PlayManager({ store, logger, storage, onEvent: (e) => broadcast('files', e) });
  storage.onEvent = (e) => broadcast('files', e);
  logger.subscribe((line) => broadcast('log', line));

  const ffv = await media.ffmpegVersion(process.env.FFMPEG_PATH || 'ffmpeg');
  scheduler.engine = { available: ffv.available, version: ffv.version };
  await ensureDir(RECORD_ROOT);
  await ensureDir(play.store.settings.recordRoot);
  const scan = await storage.scan().catch((e) => { logger.warn(`首次扫描失败：${errText(e)}`); return null; });
  storage.startCleanupTimer();
  storage.startScanTimer();
  await scheduler.init();
  const version = VERSION;
  const update = new UpdateManager({
    appDir: path.join(APP_DIR),
    logger,
    getRepoConfig: () => (store.settings.customize || {}),
    getProxy: () => (store.settings.proxy || ''),
    // 容器内：运行目录 = 进程 cwd（entrypoint 部署 /opt/.run 后 cd 过去）；
    // srcRoot 只留给「老镜像还在跑 /app」的兜底，imageApp 供依赖基线兜底与版本展示
    srcRoot: process.env.LIVEGRAB_SRC_DIR || '',
    imageApp: process.env.LIVEGRAB_IMAGE_APP || '',
  });
  // 更新完成后自重启：优雅停止录制器/持久化/关服务，再 re-exec 自身加载新版本。
  // 容器内「立即更新」是整目录替换运行目录，必须用该目录作为新进程的 cwd，
  // 否则 re-exec 起来的还是旧代码（本地 git 模式不传 cwd，行为不变）。
  update.restartHook = async (info) => {
    const trans = info && info.to ? `（${info.from ? `v${info.from} → ` : ''}${info.to}）` : '';
    const nextCwd = (info && info.cwd) || process.cwd();
    logger.info(`更新完成${trans}，正在优雅停止当前实例并重启以加载新版本（cwd=${nextCwd}）…`);
    scheduler.stopPolling();
    for (const [, rec] of scheduler.recorders) { try { await rec.stop('shutdown'); } catch { /* ignore */ } }
    for (const [, rec] of scheduler.detached) { try { await rec.stop('shutdown'); } catch { /* ignore */ } }
    try { await store.persist(); } catch (e) { logger.error(`重启前持久化失败：${e?.message || e}`); }
    try { store.close(); } catch { /* ignore */ }
    // 先释放端口，再启动新进程，避免新实例 EADDRINUSE。
    // 注意：必须主动断开 SSE 长连接并带超时兜底（closeHttpServer），
    // 否则 server.close() 会因页面开着的 /api/events 连接永不回调 → 不重启、页面打不开。
    await closeHttpServer(server, sseClients, 3000);
    logger.info('HTTP 服务已停止，正在启动新进程加载新版本…');
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: nextCwd,
      env: process.env,
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
    setTimeout(() => process.exit(0), 400).unref();
  };
  await update.detectEnv().catch(() => {});
  await update.localInfo().catch(() => {});
  // 版本细节进日志、不进页面：只保留第一行并去掉 "Copyright (c) …" 噪声，例如 "ffmpeg version git-2019-10-22-0b8956b"
  const ffvLine = String(ffv.version || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  const ffvShort = ffvLine.replace(/\s*Copyright\b.*$/i, '').trim() || ffvLine;
  logger.info(`LiveGrab v${version} 启动完成：端口 ${PORT}，录制目录 ${RECORD_ROOT}，配置目录 ${CONFIG_DIR}，时区 ${tzName()}，ffmpeg ${ffv.available ? (ffvShort || 'ok') : '缺失（无法录制）'}`);
  if (!ffv.available) logger.error('未找到 ffmpeg：录制功能不可用。请确认镜像内已安装 ffmpeg，或设置 FFMPEG_PATH。');
  return { store, logger, auth, storage, notifier, scheduler, play, version, scan, update };
}

/** 是否 HTTPS（直连 TLS 或反代声明 https）→ 决定会话 Cookie 是否加 Secure */
function isHttps(req) {
  return req.socket?.encrypted === true
    || String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

async function main() {
  const ctx = await bootstrap();
  const { store, logger, auth, storage, scheduler, play, notifier, version, update } = ctx;

  // ---------- 路由 ----------
  const routes = [];
  const route = (method, pattern, handler, { publicRoute = false } = {}) => {
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, rx, keys, handler, publicRoute });
  };

  route('GET', '/api/health', async () => ({
    status: 'ok', version, tz: tzName(),
    // 只保留部署探针/更新页需要的字段：uptime、完整引擎指纹等细节不再对未登录者暴露
    ffmpeg: {
      available: scheduler.engine.available,
      version: scheduler.engine.version,
      ffmpegAvailable: scheduler.engine.available,
      ffmpegVersion: scheduler.engine.version,
    },
  }), { publicRoute: true });

  route('GET', '/api/auth/mode', async (req) => ({
    mode: auth.mode, lockRemainSec: auth.lockRemainSec(req.ip || 'local'),
  }), { publicRoute: true });

  route('POST', '/api/auth/init', async (req, res) => {
    // 首次初始化 = 创建管理员并直接签发会话。若允许经反向代理到达，任何公网访问者都能「先到先占」。
    // 反代部署（Nginx/Traefik/Cloudflare）确实无法直连 → 用 ALLOW_PROXY_INIT=1 显式放行，默认拒绝。
    if (req.viaProxy && process.env.ALLOW_PROXY_INIT !== '1') {
      throw new HttpError('INIT_FORBIDDEN',
        '检测到反向代理转发头，已拒绝首次初始化。请从局域网直连地址完成初始化；反代部署可设置环境变量 ALLOW_PROXY_INIT=1 后重启再试', 403);
    }
    const body = await readBody(req);
    const user = await auth.createUser({ username: body.username, password: body.password });
    const s = auth.issue(true, store.settings.security?.sessionDays || 30);
    res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.maxAge, isHttps(req)));
    logger.info(`初始化管理员账号：${user.username}（密码以 scrypt 哈希保存，不可逆）`);
    return { user, expiresAt: s.expiresAt };
  }, { publicRoute: true });

  route('POST', '/api/auth/login', async (req, res) => {
    const body = await readBody(req);
    const user = await auth.verifyLogin({
      username: body.username, password: body.password, ip: req.ip || 'local',
      failLimit: store.settings.security?.failLimit || 5,
      lockMin: store.settings.security?.failLockMin || 10,
    });
    const s = auth.issue(!!body.remember, store.settings.security?.sessionDays || 30);
    res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.maxAge, isHttps(req)));
    logger.info(`登录成功：${user.username}`);
    return { user, expiresAt: s.expiresAt };
  }, { publicRoute: true });

  route('POST', '/api/auth/logout', async (req, res) => {
    auth.revoke(req); // 服务端撤销：只清 Cookie 时，被复制走的 token 仍能用到过期
    res.setHeader('Set-Cookie', auth.clearCookieHeader(isHttps(req)));
    return { ok: true };
  }, { publicRoute: true });

  route('POST', '/api/auth/logout-all', async (req, res) => {
    await auth.revokeAll();
    logger.warn('已注销所有会话：账号会话代次已自增，所有已签发 token 立即失效');
    res.setHeader('Set-Cookie', auth.clearCookieHeader(isHttps(req)));
    return { ok: true };
  });

  route('GET', '/api/auth/me', async (req) => ({
    username: req.session.username,
    user: req.session.username,
    authenticated: true,
    lastLoginAt: auth.users?.lastLoginAt || null,
    lastLoginIp: auth.users?.lastLoginIp || null,
    sessionExpiresAt: req.session.exp ? new Date(req.session.exp).toISOString() : null,
  }));

  route('POST', '/api/auth/password', async (req, res) => {
    const body = await readBody(req);
    await auth.changePassword({ oldPassword: body.oldPassword, newPassword: body.newPassword });
    // 改密后 epoch 自增 → 当前会话也已失效，必须清 Cookie 让前端回到登录页
    res.setHeader('Set-Cookie', auth.clearCookieHeader(isHttps(req)));
    logger.warn('管理员密码已更新：所有已登录会话已失效，请重新登录');
    return { ok: true, relogin: true };
  });

  route('GET', '/api/platforms', async () => ({ items: platformList(store.settings).map((p) => ({
    ...p, active: scheduler.platformActive(p.id), cookie: cookieInfo(p.id),
  })) }));

  route('GET', '/api/status', async () => scheduler.status());

  route('POST', '/api/resolve', async (req) => {
    const body = await readBody(req);
    // 服务端会拿这个地址去解析/拉流：只允许网络协议（拒绝 file:/data: 等），
    // 私网地址仍放行（局域网自建流是合法用法）。
    assertRemoteUrl(body.url || body.roomId || '', { label: '直播间地址', allowRtmp: true, allowPrivate: true });
    return resolveRoom(body.url || body.roomId || '', { platform: body.platform, settings: store.settings, logger });
  });

  route('GET', '/api/tasks', async (req) => scheduler.listTasks({
    status: req.query.status, platform: req.query.platform, liveStatus: req.query.liveStatus, q: req.query.q,
    page: req.query.page, pageSize: req.query.pageSize, sort: req.query.sort, sortDir: req.query.sortDir,
  }));
  route('POST', '/api/tasks', async (req) => {
    const body = await readBody(req);
    const task = await scheduler.createTask(body);
    return scheduler.serializeTask(task);
  });
  route('POST', '/api/tasks/batch', async (req) => {
    const body = await readBody(req);
    if (!Array.isArray(body.ids) || !body.ids.length) throw new HttpError('NO_IDS', '请选择至少一个任务', 400);
    return scheduler.batch(body.action, body.ids);
  });
  route('POST', '/api/tasks/order', async (req) => {
    const body = await readBody(req);
    if (!Array.isArray(body.ids)) throw new HttpError('NO_IDS', '排序数据无效', 400);
    store.reorderTasks(body.ids);
    await store.persist();
    scheduler.onEvent({ type: 'task' });
    return { ok: true };
  });
  route('GET', '/api/tasks/:id', async (req) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    return scheduler.serializeTask(t, true); // 详情弹窗要分段明细（含结束原因）
  });
  route('PATCH', '/api/tasks/:id', async (req) => {
    const body = await readBody(req);
    const t = await scheduler.updateTask(req.params.id, body);
    return scheduler.serializeTask(t);
  });
  route('DELETE', '/api/tasks/:id', async (req) => scheduler.deleteTask(req.params.id, { force: req.query.force === '1' || req.query.force === 'true' }));
  for (const action of ['start', 'stop', 'pause', 'resume', 'check', 'retry', 'record-once', 'stop-once']) {
    route('POST', `/api/tasks/:id/${action}`, async (req) => {
      const id = req.params.id;
      if (action === 'start') return scheduler.startTask(id, { reason: 'manual' });
      if (action === 'stop') return scheduler.stopTask(id);
      if (action === 'record-once') return scheduler.startTask(id, { reason: 'manual', oneShot: true }); // 录制本场：不改 autoRecord
      if (action === 'stop-once') return scheduler.stopTask(id, { reason: 'user', oneShot: true });      // 停止本场：不改 autoRecord/manualHeld
      if (action === 'pause') return scheduler.pauseTask(id);
      if (action === 'resume') return scheduler.resumeTask(id);
      if (action === 'check') return scheduler.checkTask(id);
      return scheduler.retryTask(id);
    });
  }

  route('GET', '/api/naming', async () => ({
    ...store.naming, variables: VARIABLES, defaults: DEFAULT_OPTIONS, choices: NAMING_OPTION_CHOICES,
  }));
  route('PUT', '/api/naming', async (req) => {
    const body = await readBody(req);
    const naming = await store.setNaming(body);
    return { ...naming, variables: VARIABLES };
  });
  route('POST', '/api/naming/preview', async (req) => {
    const body = await readBody(req);
    const preview = previewNaming({
      fnTemplate: body.fnTemplate || '{日期}_{主播}_{序号}',
      dirTemplate: body.dirTemplate ?? '{平台}/{主播}/{日期}',
      options: { ...DEFAULT_OPTIONS, ...(body.options || {}) },
      samples: body.samples || 3,
    });
    return preview;
  });

  route('GET', '/api/settings', async () => settingsView());
  route('PUT', '/api/settings', async (req) => {
    const body = await readBody(req);
    delete body.cookies; // Cookie 只能通过专用接口写入
    // 更新源配置（含 updateToken）只能通过 /api/update/config 写入：
    // 设置页拿到的 customize.updateToken 是脱敏占位 '••••••••'，若随整包设置保存落库，
    // 会把真实 token 覆盖成占位符，导致「检查更新/立即更新」鉴权失败（用户无感知）。
    delete body.customize;
    // trustLan = 一键关闭全站鉴权：只允许从「直连内网」修改，且变更写 WARN。
    // 反代/公网来源即使已登录也不允许开启（一次会话泄漏就能让实例永久裸奔）。
    if (body.security && Object.prototype.hasOwnProperty.call(body.security, 'trustLan')) {
      const want = !!body.security.trustLan;
      if (want && (req.viaProxy || !isPrivateHost(req.ip))) {
        throw new HttpError('FORBIDDEN', '只能从局域网直连地址开启「允许局域网免登录」', 403);
      }
      if (want !== !!store.settings.security?.trustLan) {
        logger.warn(`「允许局域网免登录」已${want ? '开启' : '关闭'}（来源 ${req.ip}${req.viaProxy ? ' · 经代理' : ''}）`);
      }
    }
    // 录制根目录只由环境变量/部署决定：允许在线改写会让 safeJoin 的基准被换掉，历史记录的绝对路径也全部失配
    delete body.recordRoot;
    const merged = await store.updateSettings(body);
    if (body.logLevel) logger.setLevel(body.logLevel);
    if (body.logRetentionDays) { logger.setRetention(body.logRetentionDays); await logger.purge(); }
    // 全局设置改了 → 立刻把各任务的生效参数（清晰度/分段/轮询间隔…）重算落盘，
    // 未单独自定义的任务当场跟随新全局值（否则界面仍显示旧值，看着像设置不生效）
    const n = await scheduler.syncEffectiveAll();
    logger.info(`设置已更新：${Object.keys(body).join(' / ') || '（空）'}${n ? `（${n} 个任务生效参数已跟随更新）` : ''}`);
    broadcast('settings', settingsView());
    return settingsView();
  });
  route('POST', '/api/settings/cookie', async (req) => {
    const body = await readBody(req);
    const platform = String(body.platform || '');
    if (!platform) throw new HttpError('BAD_REQUEST', '缺少平台', 400);
    await store.setCookie(platform, body.cookie || '');
    logger.info(`已更新 ${platform} 的 Cookie（长度 ${String(body.cookie || '').length}）`);
    broadcast('settings', settingsView());
    return { ok: true, cookie: cookieInfo(platform) };
  });
  route('DELETE', '/api/settings/cookie', async (req) => {
    const platform = String(req.query.platform || '');
    if (!platform) throw new HttpError('BAD_REQUEST', '缺少平台', 400);
    await store.clearCookie(platform);
    logger.info(`已清除 ${platform} 的 Cookie`);
    broadcast('settings', settingsView());
    return { ok: true, cookie: cookieInfo(platform) };
  });
  route('GET', '/api/settings/env', async () => ({
    tz: tzName(), recordRoot: RECORD_ROOT, configDir: CONFIG_DIR, port: PORT,
    ffmpegAvailable: scheduler.engine.available, ffmpegVersion: scheduler.engine.version,
    version, node: process.version, platforms: PLATFORMS.length,
    inDocker: IN_DOCKER,
  }));

  // ---- 文件库 ----
  route('GET', '/api/files', async (req) => {
    // 文件库主动对账：外部把文件移动/删除后，无需手动点「扫描」——这里以 5s 节流触发一次后台扫描，
    // 前端每 2s 轮询本接口，下一次即可拿到最新磁盘状态（缺失标记 / 新增登记 / 幽灵清理）。
    void storage.scanThrottled(5000);
    const q = req.query;
    // all=1：返回符合筛选的全量（不分页），供前端跨页全选 / 批量删除统计 / 导出使用
    const wantAll = q.all === '1' || q.all === 'true';
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = wantAll ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, Number(q.pageSize) || 10));

    // 拍平：每个会话 → 单个文件行（分段 + 转封装/合并副本 + mp4/m4a），按 id/路径去重
    // （与前端原 allFiles() 口径一致；s 携带 sessionView 以保留播放所需的 segments/id）
    const rows = [];
    // 去重集合提升到 session 循环外：同一路径若出现在多个场次（重复注册的独立场次），列表只显示一次
    const seen = new Set(); const seenPath = new Set();
    for (const s of store.sessions) {
      const sv = sessionView(s);
      // status=recording 的分段：开录即入库（路径/场次/段号），但内容还没写完，文件库不展示；
      // 分段收尾后状态转 ok，下一次轮询/SSE 刷新即正常出现。
      const push = (f, tag) => { if (f && f.id && f.status !== 'recording' && !seen.has(f.id) && !seenPath.has(f.path)) { seen.add(f.id); seenPath.add(f.path); rows.push({ f, s: sv, tag }); } };
      (sv.segments || []).forEach((x) => push(x, null));
      (sv.extras || []).forEach((x) => push(x, x.kind === 'm4a' ? 'M4A' : x.kind === 'merged' ? '合并' : 'MP4'));
      if (sv.mp4) push(sv.mp4, 'MP4');
      if (sv.merged) push(sv.merged, '合并');
    }

    // 过滤（与前端原 filtered() 口径一致）
    const fil = {
      q: String(q.q || '').trim().toLowerCase(),
      platform: q.platform || '',
      dateFrom: q.dateFrom || q.date || '',
      dateTo: q.dateTo || q.date || '',
      ext: String(q.ext || '').toLowerCase(),
    };
    const filtered = rows.filter(({ f, s, tag }) => {
      if (fil.platform && s.platform !== fil.platform) return false;
      // 日期筛选与「今日统计」同口径：startedAt 是 UTC ISO，直接 slice(0,10) 会按 UTC 日期切片，
      // 东八区 00:00–08:00 的录制会被算到前一天。这里统一用本地时区 dateKey。
      const day = s.startedAt ? dateKey(new Date(s.startedAt)) : '';
      if (fil.dateFrom && day < fil.dateFrom) return false;
      if (fil.dateTo && day > fil.dateTo) return false;
      if (fil.ext) {
        const e = String(f.ext || tag || '').toLowerCase();
        if (e !== fil.ext && !(fil.ext === 'mp4' && (e === 'mp4' || e === 'm4a'))) return false;
      }
      if (fil.q) {
        const hay = [f.name, f.relPath, s.streamer, s.title, s.taskId].join(' ').toLowerCase();
        if (!hay.includes(fil.q)) return false;
      }
      return true;
    });

    // 稳定排序后再分页：最新录制在前；同场次聚合、分段按序号在前、派生文件其后。
    // 消除「重启/刷新/翻页顺序乱跳」（store.sessions 运行期 unshift、重启后读库顺序不一致）。
    sortFileRows(filtered);

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    const bytes = filtered.reduce((n, { f }) => n + (Number(f.bytes) || 0), 0);

    const trash = storage.listTrash();
    const platforms = [...new Set(store.sessions.map((s) => s.platform).filter(Boolean))];
    // 缺失文件计数：直接遍历，不再 store.allFiles() 拼一个全量数组（该接口 2s 被轮询一次）
    let missingCount = 0;
    const countMissing = (f) => { if (f && f.status === 'missing') missingCount += 1; };
    for (const s of store.sessions) {
      for (const f of (s.segments || [])) countMissing(f);
      for (const f of (s.extras || [])) countMissing(f);
      countMissing(s.merged);
      countMissing(s.mp4);
    }
    for (const f of store.external) countMissing(f);
    return {
      total, items, page, pageSize, pages, platforms, bytes,
      summary: {
        missing: missingCount,
        unregistered: store.external.length,
        trashCount: trash.count, trashBytes: trash.bytes,
        sessions: store.sessions.length,
      },
    };
  });
  route('POST', '/api/files/scan', async () => { logger.info('手动扫描录制目录'); return storage.scan(); });
  route('POST', '/api/files/merge', async (req) => {
    const body = await readBody(req);
    logger.info(`合并分段会话：${body.sessionId || ''}`);
    const item = await storage.mergeSession(body.sessionId);
    return fileView(item);
  });
  // 文件库勾选合并：按传入顺序追加到第一个文件，结果沿用第一个文件名
  route('POST', '/api/files/merge-picked', async (req) => {
    const body = await readBody(req);
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds : [];
    const deleteSources = body.deleteSources === true || body.deleteSources === 'true';
    const name = String(body.name || '').trim();
    logger.info(`勾选合并 ${fileIds.length} 个文件 → ${name || '(未命名)'}${deleteSources ? '（合并后删除源文件）' : ''}`);
    const r = await storage.mergePicked(fileIds, { deleteSources, name });
    return { ...r, item: fileView(r.item) };
  });
  route('POST', '/api/files/:id/remux', async (req) => {
    const body = await readBody(req).catch(() => ({}));
    logger.info(`转封装文件：${req.params.id} → ${body.kind || 'mp4'}`);
    const item = await storage.remux(req.params.id, { kind: body.kind || 'mp4' });
    return fileView(item);
  });
  route('POST', '/api/files/delete', async (req) => {
    const body = await readBody(req);
    const sessionIds = body.sessionIds || [];
    const fileIds = body.fileIds || [];
    logger.info(`删除文件：会话 ${sessionIds.length} 条 / 文件 ${fileIds.length} 条（移入回收站）`);
    return storage.moveToTrash({ sessionIds, fileIds });
  });
  route('GET', '/api/files/:id/download', async (req, res) => streamFile(req, res, true));
  route('GET', '/api/files/:id/stream', async (req, res) => streamFile(req, res, false));

  // ---- 回收站 ----
  route('GET', '/api/trash', async (req) => storage.listTrash({ page: req.query.page, pageSize: req.query.pageSize }));
  route('POST', '/api/trash/restore', async (req) => {
    const body = await readBody(req);
    const ids = body.ids || [];
    logger.info(`从回收站恢复 ${ids.length} 条`);
    return storage.restoreTrash(ids);
  });
  route('POST', '/api/trash/empty', async () => {
    logger.warn('清空回收站（所有条目将彻底删除，不可恢复）');
    return storage.emptyTrash();
  });
  route('POST', '/api/trash/purge', async (req) => {
    const body = await readBody(req);
    const ids = body.ids || [];
    logger.warn(`彻底删除回收站条目 ${ids.length} 条（不可恢复）`);
    return storage.purgeTrash(ids);
  });
  // 回收站缩略图：按回收站条目 id 取首个媒体文件的预览（无则 fallback 到首帧抽帧）
  route('GET', '/api/trash/:id/thumb', async (req, res) => {
    const t = store.trash.find((x) => x.id === req.params.id);
    if (!t) throw new HttpError('NOT_FOUND', '回收站条目不存在', 404);
    const media = (t.items || []).find((it) => it.kind !== 'sidecar' && it.kind !== 'poster' && it.kind !== 'nfo' && (it.trashPath || it.origPath));
    if (!media) throw new HttpError('NOT_FOUND', '无媒体文件', 404);
    return serveThumb(res, media.trashPath || media.origPath);
  });

  route('GET', '/api/i18n', async () => {
    const f = path.join(WEB_DIR, 'i18n', 'zh-CN.json');
    const st = await fsp.stat(f).catch(() => null);
    if (!st) return {};
    return JSON.parse(await fsp.readFile(f, 'utf8'));
  });

  // ---- 回放 ----
  route('POST', '/api/play', async (req) => {
    const body = await readBody(req);
    return play.start(body.fileId);
  });
  route('DELETE', '/api/play/:playId', async (req) => play.release(req.params.playId));
  route('GET', '/api/play/:playId/stream', async (req, res) => {
    play.stream(req.params.playId, req, res);
    return null; // 已自行处理响应
  });

  // ---- 系统更新 ----
  route('GET', '/api/update/status', async () => update.status());
  route('POST', '/api/update/check', async () => update.check(true));
  route('POST', '/api/update/apply', async () => update.apply());
  route('POST', '/api/update/config', async (req) => {
    const body = await readBody(req);
    let cfg;
    try {
      cfg = update.normalizeRepoConfig({ repo: body.repo, branch: body.branch, gitUrl: body.gitUrl });
    } catch (e) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: e.message || '仓库地址格式不正确' } };
    }
    const cur = (store.settings && store.settings.customize) || {};
    // token 处理：占位 '••••••••' 代表未改动（保留原值）；空串代表主动清空；其它为明文写入
    let token = cur.updateToken || '';
    if (typeof body.token === 'string') {
      token = body.token === '••••••••' ? (cur.updateToken || '') : body.token.trim();
    }
    await store.updateSettings({ customize: { updateRepo: cfg.repo, updateGitUrl: cfg.gitUrl, updateBranch: cfg.branch, updateToken: token } });
    return { ok: true, repo: cfg.repo, gitUrl: cfg.gitUrl, branch: cfg.branch, token: token ? '••••••••' : '' };
  });

  // ---- 日志 / 通知 ----
  route('GET', '/api/logs', async (req) => {
    const page = await logger.queryPage({
      level: req.query.level, taskId: req.query.taskId, q: req.query.q,
      page: req.query.page, pageSize: req.query.pageSize, order: req.query.order,
    });
    return {
      ...page,
      files: await logger.files(),
      retentionDays: store.settings.logRetentionDays,
      level: store.settings.logLevel,
    };
  });
  route('POST', '/api/logs/clear', async (req) => {
    const body = await readBody(req).catch(() => ({}));
    return logger.clear({ from: body.from, to: body.to });
  });
  route('POST', '/api/notify/test', async () => notifier.test());
  route('GET', '/api/events', async (req, res) => {
    const token = parseCookies(req)[COOKIE_NAME];
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: status\ndata: ${JSON.stringify(scheduler.status())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      // 长连接建立后会话可能已登出/改密/过期：每 15s 复检一次，失效就断开，不能继续推事件
      if (!auth.verifyToken(token)) {
        clearInterval(ping);
        sseClients.delete(res);
        try { res.end(); } catch { /* ignore */ }
        return;
      }
      try { res.write(':ping\n\n'); } catch { /* ignore */ }
    }, 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return null;
  });

  // ---------- 首帧图（缩略图）：优先读落盘海报 `<同名>.jpg`，没有才临时抽帧并缓存为文件。
  // 配合 Storage.writeArt：录制收尾会一次生成 `<同名>.jpg`，此后接口/Jellyfin 都只读文件、不再跑 ffmpeg。 ----------
  async function serveThumb(res, filePath) {
    const st = await fsp.stat(filePath).catch(() => null);
    if (!st || st.size <= 0) throw new HttpError('NOT_FOUND', '文件在磁盘上不存在', 404);
    const sidecar = filePath.replace(/\.[^./\\]+$/, '') + '.jpg';
    const stS = await fsp.stat(sidecar).catch(() => null);
    if (stS && stS.size > 0 && stS.mtimeMs >= st.mtimeMs) {
      const buf = await fsp.readFile(sidecar);
      await store.setFileThumbnailByPath(filePath, sidecar).catch(() => {}); // 回写 files.thumbnail_path（值未变则不写库）
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'Content-Length': buf.length });
      res.end(buf);
      return null;
    }
    const buf = await media.grabFrame({ input: filePath, width: 320 });
    if (!buf) throw new HttpError('UNSUPPORTED', '无法从该视频提取首帧（纯音频或 ffmpeg 不可用）', 415);
    fsp.writeFile(sidecar, buf).catch(() => {}); // 落盘为侧车海报，下次直接读
    await store.setFileThumbnailByPath(filePath, sidecar).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=10', 'Content-Length': buf.length });
    res.end(buf);
    return null;
  }

  async function thumbFileFor(taskId) {
    // 1) 正在录 / 已暂停：取当前分段（实时画面）
    const rec = scheduler.recorders.get(taskId) || scheduler.detached.get(taskId);
    if (rec && rec.currentSegment && rec.currentSegment.path) {
      const st = await fsp.stat(rec.currentSegment.path).catch(() => null);
      if (st && st.size > 0) return { path: rec.currentSegment.path, st };
    }
    // 2) 否则取该任务最近一次录完的文件（分段 / 合并 / 转封装，略过纯音频）
    //    只看最近若干个场次：首帧图只需要「最新一个可用文件」，历史场次数百个时全量 stat 会拖慢请求
    let best = null;
    let bestM = 0;
    let looked = 0;
    for (const s of store.sessions) {
      if (s.taskId !== taskId) continue;
      if (looked++ >= 8) break;
      const cands = [];
      if (s.mp4) cands.push(s.mp4);
      if (s.merged) cands.push(s.merged);
      if (Array.isArray(s.segments)) cands.push(...s.segments);
      if (Array.isArray(s.extras)) cands.push(...s.extras);
      for (const f of cands) {
        if (!f || typeof f.path !== 'string' || !f.path) continue;
        if (f.kind === 'm4a' || /\.(m4a|mp3|aac|wav)$/i.test(f.path)) continue;
        const st = await fsp.stat(f.path).catch(() => null);
        if (!st || st.size <= 0) continue;
        if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = { path: f.path, st }; }
      }
    }
    return best;
  }

  route('GET', '/api/tasks/:id/thumb', async (req, res) => {
    const src = await thumbFileFor(req.params.id);
    if (!src) throw new HttpError('NOT_FOUND', '暂无该任务的首帧图', 404);
    return serveThumb(res, src.path);
  });

  route('GET', '/api/files/:id/thumb', async (req, res) => {
    const hit = store.findFile(req.params.id);
    if (!hit || !hit.file) throw new HttpError('NOT_FOUND', '文件不存在', 404);
    return serveThumb(res, hit.file.path);
  });

  route('GET', '/api/tasks/:id/avatar', async (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    // 本地缓存优先：点击解析/检查/开播才更新，平时一直用第一次缓存的（平台 CDN 热链、失效、断网都不影响）
    if (task.avatarFile) {
      const rel = String(task.avatarFile).replace(/^\.\.?[\\/]/, '').replace(/[\\/]+/g, '/'); // 防路径穿越
      const p = safeJoin(path.join(CONFIG_DIR, 'meta'), rel);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.size > 0) {
        const buf = await fsp.readFile(p);
        const type = String(task.avatarFile).endsWith('.webp') ? 'image/webp'
          : String(task.avatarFile).endsWith('.png') ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'Content-Length': buf.length });
        res.end(buf);
        return null;
      }
    }
    // 任务只保留本地头像缓存文件（不再保存平台头像 URL）：无缓存即视为无头像
    throw new HttpError('NOT_FOUND', '任务无本地头像缓存（解析/检查/开播时会自动缓存）', 404);
  });

  // ---------- 序列化辅助 ----------
  function cookieInfo(platform) {
    const c = store.settings.cookies?.[platform];
    if (!c) return { has: false, updatedAt: null, valid: false };
    return { has: !!c.value, updatedAt: c.updatedAt || null, valid: !!c.valid };
  }
  function settingsView() {
    const s = JSON.parse(JSON.stringify(store.settings));
    // 更新源 token 不外泄：返回占位符，前端通过 /api/update/status 的 tokenConfigured 判断是否已配置
    if (s.customize && s.customize.updateToken) s.customize.updateToken = '••••••••';
    const cookies = {};
    // 所有平台都给出一致的形状，前端表格无需判空
    for (const p of PLATFORMS) cookies[p.id] = cookieInfo(p.id);
    s.cookies = cookies;
    s.env = { tz: tzName(), recordRoot: RECORD_ROOT, configDir: CONFIG_DIR, port: PORT };
    return s;
  }
  async function streamFile(req, res, download) {
    const hit = store.findFile(req.params.id);
    if (!hit) throw new HttpError('NOT_FOUND', '文件不存在', 404);
    const { file } = hit;
    const st = await fsp.stat(file.path).catch(() => null);
    if (!st) {
      if (file.status !== 'missing') { file.status = 'missing'; await store.persist(); broadcast('files', { type: 'files' }); }
      logger.error(`文件读取失败（磁盘上不存在）：${file.name}｜路径：${file.path}`, { taskId: hit.session && hit.session.taskId, path: file.path });
      throw new HttpError('FILE_MISSING', '文件在磁盘上不存在（可能被手动删除或移走），可在文件库里清理该记录', 404);
    }
    const mime = mimeByExt(extOf(file.name));
    const range = parseRange(req.headers.range, st.size);
    const base = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (download) {
      logger.info(`下载文件：${file.name}${hit.session ? `（${hit.session.streamer || ''}）` : ''}`, { taskId: hit.session && hit.session.taskId });
      base['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`;
    } else {
      const now = Date.now();
      const last = playLogTs.get(file.id);
      if (!last || now - last > PLAY_LOG_GAP) {
        playLogTs.set(file.id, now);
        logger.info(`播放文件：${file.name}${hit.session ? `（${hit.session.streamer || ''}）` : ''}`, { taskId: hit.session && hit.session.taskId });
      }
    }
    /* 流式读取中途失败（文件被删/磁盘错误等）也要落日志，写明路径与具体原因 */
    const guard = (rs) => rs.on('error', (err) => {
      logger.error(`文件流读取失败：${file.name}｜路径：${file.path}｜原因：${errText(err)}`, { taskId: hit.session && hit.session.taskId, path: file.path });
      try { res.destroy(); } catch { /* ignore */ }
    });
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return null;
    }
    if (range) {
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
        'Content-Length': range.end - range.start + 1,
      });
      guard(fs.createReadStream(file.path, { start: range.start, end: range.end }).pipe(res));
    } else {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      guard(fs.createReadStream(file.path).pipe(res));
    }
    return null;
  }

  // ---------- 静态资源 ----------
  async function serveStatic(req, res) {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); }
    catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('bad request'); return; }
    if (rel === '/' || rel === '') rel = '/index.html';
    const base = path.resolve(WEB_DIR);
    // 前缀比较必须带分隔符：旧写法 '/app/webx/a'.startsWith('/app/web') 为 true，同名前缀的兄弟目录能越界读。
    const target = path.resolve(base, '.' + (rel.startsWith('/') ? rel : `/${rel}`));
    if (target !== base && !target.startsWith(base + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    // realpath 复核：web/ 内的软链不能把读取带到目录外
    const realBase = await fsp.realpath(base).catch(() => base);
    const realTarget = await fsp.realpath(target).catch(() => null);
    if (realTarget && realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const resolved = realTarget || target;
    let st = await fsp.stat(resolved).catch(() => null);
    let file = resolved;
    if (!st || st.isDirectory()) {
      file = path.join(realBase, 'index.html');
      st = await fsp.stat(file).catch(() => null);
    }
    if (!st) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('前端资源缺失：app/web/index.html 不存在'); return; }
    res.writeHead(200, {
      'Content-Type': mimeByExt(path.extname(file)),
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---------- 请求处理 ----------
  server.on('request', async (req, res) => {
    const started = Date.now();
    const ip = req.socket.remoteAddress || 'local';
    req.ip = ip;
    // 只有「直连」才允许按内网 IP 免登：反向代理 / Docker 端口映射下 remoteAddress 恒为
    // 127.0.0.1 或 172.17.0.1，按 IP 放行等于对公网完全免鉴权。带任何转发头就强制走登录。
    const hasProxyHeaders = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip']
      || req.headers.forwarded || req.headers['x-forwarded-proto']);
    req.viaProxy = hasProxyHeaders;
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      if (!url.pathname.startsWith('/api/')) return void await serveStatic(req, res);

      const match = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
      if (!match) throw new HttpError('NOT_FOUND', `接口不存在：${req.method} ${url.pathname}`, 404);
      const m = match.rx.exec(url.pathname);
      req.params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

      if (!match.publicRoute) {
        const session = auth.sessionFrom(req);
        const trustLan = store.settings.security?.trustLan && !hasProxyHeaders && isPrivateHost(ip);
        if (!session && !trustLan) throw new HttpError('UNAUTHORIZED', '未登录或会话已过期', 401);
        req.session = session || { username: 'lan' };
      }

      const data = await match.handler(req, res);
      if (data === null || res.writableEnded) return;
      ok(res, data);
    } catch (e) {
      // 5xx 一律进日志文件（带请求上下文 + 堆栈）：此前只 console.error 到 stdout，日志文件与「运行日志」页完全看不到
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.writableEnded) {
        fail(res, e);
        if (status >= 500) logger.error(`接口未处理异常 ${req.method} ${url.pathname}（${ip}）：${errText(e)}`);
      } else {
        logger.error(`响应已开始后出错 ${req.method} ${url.pathname}（${ip}）：${errText(e)}`);
      }
    } finally {
      if (url.pathname.startsWith('/api/') && Date.now() - started > 3000) {
        logger.warn(`慢请求 ${req.method} ${url.pathname} 用时 ${Date.now() - started}ms`);
      }
    }
  });

  // 监听时若端口被占用（如自重启瞬间旧进程尚未完全释放），重试而非直接退出
  let listenTries = 0;
  const tryListen = () => {
    server.listen(PORT, HOST, () => {
      console.log(`[livegrab] v${version} listening on http://${HOST}:${PORT}`);
      console.log(`[livegrab] 录制目录 ${RECORD_ROOT} · 配置目录 ${CONFIG_DIR} · 时区 ${tzName()}`);
      console.log(`[livegrab] 管理员账号：${auth.mode === 'init' ? '未初始化（首次打开页面设置密码）' : '已初始化'}`);
      // 一次性清理：录制目录里的旧 seg csv 残留、旧版 config/avatars 头像缓存（已统一迁入 config/meta）
      void storage.sweepLegacyArtifacts().catch(() => {});
    });
  };
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && listenTries < 30) {
      listenTries++;
      logger.warn(`端口 ${PORT} 被占用，0.5s 后重试（第 ${listenTries} 次）`);
      setTimeout(tryListen, 500);
    } else {
      logger.error(`服务启动失败：${err?.message || err}`);
      process.exit(1);
    }
  });
  tryListen();

  const shutdown = async (sig) => {
    logger.info(`收到 ${sig}，正在优雅退出：停止调度并收尾正在录制的任务…`);
    scheduler.stopPolling();
    for (const [id, rec] of scheduler.recorders) {
      try { await rec.stop('shutdown'); } catch { /* ignore */ }
      void id;
    }
    for (const [, rec] of scheduler.detached) {
      try { await rec.stop('shutdown'); } catch { /* ignore */ } // 暂停中录制器也 await 收尾，避免写落在已关闭连接上
    }
    try { await store.persist(); } catch (e) { logger.error(`优雅退出时 SQLite 持久化失败：${e?.message || e}`); }
    store.close();
    closeAllSse(sseClients); // 断开 SSE，避免 server.close() 被长连接拖住（下方 8s 兜底仍在）
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => logger.error(`未处理的 Promise 拒绝：${e?.message || e}`));
  process.on('uncaughtException', (e) => logger.error(`未捕获异常：${e?.stack || e}`));
}

main().catch((e) => {
  console.error('[livegrab] 启动失败：', e);
  process.exit(1);
});
