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
import { Auth } from './auth.js';
import { Storage, playModeOf } from './storage.js';
import { Notifier } from './notify.js';
import { Scheduler } from './scheduler.js';
import { PlayManager } from './play.js';
import { UpdateManager } from './update.js';
import * as media from './media.js';
import { resolveRoom, platformList, PLATFORMS } from './resolvers/index.js';
import { previewNaming, VARIABLES, DEFAULT_OPTIONS, qualityLabel, NAMING_OPTION_CHOICES } from './naming.js';
import {
  ok, fail, HttpError, readBody, mimeByExt, parseRange, extOf, VERSION,
  ensureDir, formatBytes, tzName, uid, safeJoin,
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

/** 左侧树：按平台/日期/任务两种分组层级（view 决定顶层键） */
function treeFor(sessions, view = 'platform') {
  const platformName = (s) => s.platformName || s.platform || '未知平台';
  const dateOf = (s) => (s.startedAt || '').slice(0, 10) || '未知日期';
  const topOf = (s) => (view === 'date' ? dateOf(s) : view === 'task' ? (s.streamer || s.taskId || '未知任务') : platformName(s));
  const subOf = (s) => (view === 'date' ? platformName(s) : view === 'task' ? null : dateOf(s));
  const map = new Map();
  for (const s of sessions) {
    const files = (s.segments || []).length + (s.extras || []).length;
    const tk = topOf(s);
    const top = map.get(tk) || { key: tk, name: tk, count: 0, bytes: 0, children: [], childrenMap: new Map() };
    top.count += files;
    top.bytes += sessionFileBytes(s);
    const sk = subOf(s);
    if (sk) {
      const sub = top.childrenMap.get(sk) || { key: sk, name: sk, date: sk, count: 0, bytes: 0, children: [] };
      sub.count += files;
      sub.bytes += sessionFileBytes(s); // M2：父子口径一致（子级不再用可能未同步的 s.bytes）
      top.childrenMap.set(sk, sub);
    }
    map.set(tk, top);
  }
  return [...map.values()].map((n) => {
    const children = [...n.childrenMap.values()]
      .map((c) => ({ ...c, platform: view === 'date' ? c.key : undefined }))
      .sort((a, b) => String(b.key).localeCompare(String(a.key)));
    const { childrenMap, ...rest } = n;
    void childrenMap;
    return { ...rest, platform: view === 'platform' ? n.key : undefined, children };
  }).sort((a, b) => b.count - a.count);
}

// ---------- 主流程 ----------
async function bootstrap() {
  // ---------- 持久层：SQLite v2（唯一存储，无 JSON 镜像、无迁移） ----------
  const dbPath = path.join(CONFIG_DIR, 'livegrab.db');
  const db = openDb(dbPath); // 空库建表；旧版本库（含 v1 data_json 结构）作废重建为空库
  const legacyRemoved = await cleanupLegacyFiles(CONFIG_DIR); // 清除 state.json 等旧 JSON 遗留（独立方法，日后可整段删除）
  if (legacyRemoved.length) console.log(`[db] 旧 JSON 遗留清理：${legacyRemoved.join('、')}`);
  const store = new Store(CONFIG_DIR);
  // 容器环境变量优先（compose 是唯一来源）
  store.settings.recordRoot = RECORD_ROOT;
  store.settings.configDir = CONFIG_DIR;
  await store.init(db);
  console.log(`[db] SQLite v2 持久层就绪：${dbPath}（schema_version=${schemaVersion(db)}/${SCHEMA_VERSION}，仅 SQLite）`);
  const logger = await new Logger({
    dir: path.join(CONFIG_DIR, 'logs'),
    level: store.settings.logLevel || 'INFO',
    retentionDays: store.settings.logRetentionDays || 14,
  }).init();
  const auth = await new Auth(CONFIG_DIR).init();
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
  const scan = await storage.scan().catch((e) => { logger.warn(`首次扫描失败：${e.message}`); return null; });
  storage.startCleanupTimer();
  await scheduler.init();
  const version = VERSION;
  const update = new UpdateManager({ appDir: path.join(APP_DIR), logger });
  // 本地（非容器）更新完成后自重启：优雅停止录制器/持久化/关服务，再 re-exec 自身加载新版本。
  // 容器/无 git 场景不会走到此钩子（update.js 会提前返回手动重建指引）。
  update.restartHook = async () => {
    logger.info('更新完成，正在优雅停止当前实例并重启以加载新版本…');
    scheduler.stopPolling();
    for (const [, rec] of scheduler.recorders) { try { await rec.stop('shutdown'); } catch { /* ignore */ } }
    for (const [, rec] of scheduler.detached) { try { await rec.stop('shutdown'); } catch { /* ignore */ } }
    try { await store.persist(); } catch (e) { logger.error(`重启前持久化失败：${e?.message || e}`); }
    try { store.close(); } catch { /* ignore */ }
    // 先释放端口，再启动新进程，避免新实例 EADDRINUSE
    await new Promise((resolve) => server.close(() => resolve()));
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
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

function isPrivateIp(ip) {
  const s = String(ip || '').replace('::ffff:', '');
  return s === '127.0.0.1' || s === '::1' || /^10\./.test(s) || /^192\.168\./.test(s)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(s) || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
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
    status: 'ok', version, uptimeSec: Math.round(process.uptime()), tz: tzName(),
    ffmpeg: {
      available: scheduler.engine.available,
      version: scheduler.engine.version,
      ffmpegAvailable: scheduler.engine.available,
      ffmpegVersion: scheduler.engine.version,
    },
  }), { publicRoute: true });

  route('GET', '/api/auth/mode', async (req) => ({
    mode: auth.mode, lockRemainSec: auth.lockRemainSec(req.ip || 'local'), version,
  }), { publicRoute: true });

  route('POST', '/api/auth/init', async (req, res) => {
    const body = await readBody(req);
    const user = await auth.createUser({ username: body.username, password: body.password });
    const s = auth.issue(true, store.settings.security?.sessionDays || 30);
    res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.maxAge));
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
    res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.maxAge));
    logger.info(`登录成功：${user.username}`);
    return { user, expiresAt: s.expiresAt };
  }, { publicRoute: true });

  route('POST', '/api/auth/logout', async (req, res) => {
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    return { ok: true };
  }, { publicRoute: true });

  route('GET', '/api/auth/me', async (req) => ({
    username: req.session.username,
    user: req.session.username,
    authenticated: true,
    lastLoginAt: auth.users?.lastLoginAt || null,
    lastLoginIp: auth.users?.lastLoginIp || null,
    sessionExpiresAt: req.session.exp ? new Date(req.session.exp).toISOString() : null,
  }));

  route('POST', '/api/auth/password', async (req) => {
    const body = await readBody(req);
    await auth.changePassword({ oldPassword: body.oldPassword, newPassword: body.newPassword });
    logger.info('管理员密码已更新');
    return { ok: true };
  });

  route('GET', '/api/platforms', async () => ({ items: platformList(store.settings).map((p) => ({
    ...p, active: scheduler.platformActive(p.id), cookie: cookieInfo(p.id),
  })) }));

  route('GET', '/api/status', async () => scheduler.status());

  route('POST', '/api/resolve', async (req) => {
    const body = await readBody(req);
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
    return scheduler.serializeTask(t);
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
  }));

  // ---- 文件库 ----
  route('GET', '/api/files', async (req) => {
    const q = req.query;
    // all=1：返回符合筛选的全量（不分页），供前端跨页全选 / 批量删除统计 / 导出使用
    const wantAll = q.all === '1' || q.all === 'true';
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = wantAll ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, Number(q.pageSize) || 10));

    // 拍平：每个会话 → 单个文件行（分段 + 转封装/合并副本 + mp4/m4a），按 id/路径去重
    // （与前端原 allFiles() 口径一致；s 携带 sessionView 以保留播放所需的 segments/id）
    const rows = [];
    for (const s of store.sessions) {
      const sv = sessionView(s);
      const seen = new Set(); const seenPath = new Set();
      const push = (f, tag) => { if (f && f.id && !seen.has(f.id) && !seenPath.has(f.path)) { seen.add(f.id); seenPath.add(f.path); rows.push({ f, s: sv, tag }); } };
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
      const day = String(s.startedAt || '').slice(0, 10);
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

    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    const bytes = filtered.reduce((n, { f }) => n + (Number(f.bytes) || 0), 0);

    const allFiles = store.allFiles();
    const trash = storage.listTrash();
    const platforms = [...new Set(store.sessions.map((s) => s.platform).filter(Boolean))];
    return {
      total, items, page, pageSize, pages, platforms, bytes,
      summary: {
        missing: allFiles.filter((f) => f.status === 'missing').length,
        unregistered: store.external.length,
        trashCount: trash.count, trashBytes: trash.bytes,
        sessions: store.sessions.length,
      },
      tree: { view: q.view || 'platform', children: treeFor(store.sessions, q.view || 'platform'), total: store.sessions.length },
      jobs: [...storage.jobs.values()].slice(-5),
    };
  });
  route('GET', '/api/files/tree', async (req) => {
    const view = req.query.view || 'platform';
    const children = treeFor(store.sessions, view);
    return {
      view, children, total: store.sessions.length,
      summary: {
        sessions: store.sessions.length,
        files: store.allFiles().length,
        bytes: store.sessions.reduce((a, b) => a + sessionFileBytes(b), 0),
        missing: store.allFiles().filter((f) => f.status === 'missing').length,
        unregistered: store.external.length,
      },
    };
  });
  route('GET', '/api/files/unregistered', async () => ({
    items: store.external.map(fileView), total: store.external.length,
    bytes: store.external.reduce((a, b) => a + (b.bytes || 0), 0),
    hint: '这些文件在 /data 里但不在索引中，可导入为独立记录，或直接删除',
  }));
  route('POST', '/api/files/import', async (req) => {
    const body = await readBody(req);
    const paths = body.paths || [];
    logger.info(`导入未注册文件 ${paths.length} 条`);
    return storage.importExternal(paths);
  });
  route('POST', '/api/files/scan', async () => { logger.info('手动扫描录制目录'); return storage.scan(); });
  route('POST', '/api/files/merge', async (req) => {
    const body = await readBody(req);
    logger.info(`合并分段会话：${body.sessionId || ''}`);
    const item = await storage.mergeSession(body.sessionId);
    return fileView(item);
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

  // // ---- 回放 ----
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
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: status\ndata: ${JSON.stringify(scheduler.status())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* ignore */ } }, 15000);
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
    let best = null;
    let bestM = 0;
    for (const s of store.sessions) {
      if (s.taskId !== taskId) continue;
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
      logger.error(`文件流读取失败：${file.name}｜路径：${file.path}｜原因：${err.message}`, { taskId: hit.session && hit.session.taskId, path: file.path });
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
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.join(WEB_DIR, rel);
    if (!target.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    let st = await fsp.stat(target).catch(() => null);
    let file = target;
    if (!st || st.isDirectory()) {
      file = path.join(WEB_DIR, 'index.html');
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
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = req.socket.remoteAddress || 'local';
    req.ip = ip;
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      if (!url.pathname.startsWith('/api/')) return void await serveStatic(req, res);

      const match = routes.find((r) => r.method === req.method && r.rx.test(url.pathname));
      if (!match) throw new HttpError('NOT_FOUND', `接口不存在：${req.method} ${url.pathname}`, 404);
      const m = match.rx.exec(url.pathname);
      req.params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));

      if (!match.publicRoute) {
        const session = auth.sessionFrom(req);
        const trustLan = store.settings.security?.trustLan && isPrivateIp(ip);
        if (!session && !trustLan) throw new HttpError('UNAUTHORIZED', '未登录或会话已过期', 401);
        req.session = session || { username: 'lan' };
      }

      const data = await match.handler(req, res);
      if (data === null || res.writableEnded) return;
      ok(res, data);
    } catch (e) {
      if (!res.writableEnded) fail(res, e);
      else logger.error(`响应已开始后出错：${e.message}`);
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
      try { await rec.stop('shutdown'); } catch { /* ignore */ } // L4：暂停中录制器也 await 收尾，避免写落在已关闭连接上
    }
    try { await store.persist(); } catch (e) { logger.error(`优雅退出时 SQLite 持久化失败：${e?.message || e}`); }
    store.close();
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
