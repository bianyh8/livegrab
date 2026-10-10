// 调度：开播轮询、并发排队、任务生命周期（D3/D6/D16）
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { Recorder } from './recorder.js';
import { Store } from './store.js';
import { qualityLabel } from './naming.js';
import {
  resolveRoom, resolveStream, getPlatform, platformList, detectPlatform, roomIdFrom,
} from './resolvers/index.js';
import { uid, nowIso, HttpError, formatBytes, formatDuration, dateKey, formatDate, formatTime, sleep } from './util.js';

const LITE = (t) => ({
  id: t.id, name: t.anchorName || t.title || t.roomId, anchorName: t.anchorName, title: t.title,
  platform: t.platform, roomId: t.roomId, quality: t.quality, qualityLabel: t.qualityLabel || qualityLabel(t.quality),
  status: t.status, statusMessage: t.statusMessage, queueReason: t.queueReason,
  bytes: t.totalBytes || 0, elapsedSec: 0, retryCount: t.retryCount || 0,
  startedAt: t.startedAt, sessionId: t.sessionId || null, autoRecord: t.autoRecord,
  monitorOnly: t.monitorOnly, manualHeld: t.manualHeld, liveStatus: t.liveStatus || (t.status === 'recording' ? 'live' : 'unknown'),
});

export class Scheduler {
  constructor({ store, logger, notifier, storage, onEvent = () => {}, mediaMod = null }) {
    this.store = store;
    this.logger = logger;
    this.notifier = notifier;
    this.storage = storage;
    this.onEvent = onEvent;
    this.mediaMod = mediaMod;
    this.recorders = new Map();   // 活动（占用并发）
    this.detached = new Map();    // 暂停中（不占并发）
    this.starting = new Set();    // 正在启动录制的 taskId（同步占位，防 tick 与手动开始并发重复启动）
    this.sessions = new Map();    // taskId → session
    this.pollTimer = null;
    this.engine = { ffmpegAvailable: false, ffmpegVersion: null };
    this.startedAt = Date.now();
    this._persistTimer = null;
  }

  async init() {
    const tasks = this.store.tasks;
    for (const t of tasks) {
      if (['recording', 'queued', 'stopping', 'paused'].includes(t.status)) {
        t.status = 'stopped';
        t.statusMessage = '服务重启，未继续录制';
      }
      t.nextPollAt = 0;
      // 一次性迁移：已有非空主播名的任务一律锁定名称，解析刷新不再覆盖用户设置的名字
      if (!t.nameLocked && t.anchorName && String(t.anchorName).trim()) t.nameLocked = true;
    }
    await this.store.persist();
    this.startPolling();
    this.logger.info(`调度器就绪：${tasks.length} 个任务，全局并发上限 ${this.store.settings.maxConcurrency}`);
    return this;
  }

  startPolling(intervalMs = 5000) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { this.tick().catch((e) => this.logger.error(`调度异常：${e.message}`)); }, intervalMs);
  }

  stopPolling() { if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; } }

  platformOf(id) { return getPlatform(id) || { id, name: id, tier: 'planned', cap: 1 }; }

  /**
   * 任务生效参数：任务的 overrides 里没写的项才跟随全局设置（D11「跟随全局/自定义」）。
   * 每次开录前重新计算，所以改全局设置对下一场生效。
   */
  effective(task) {
    const s = this.store.settings;
    const ov = task.overrides || {};
    return {
      quality: ov.quality || s.defaultQuality || 'origin',
      segmentMode: ov.segmentMode || s.defaultSegmentMode || 'time',
      namingProfileId: ov.namingProfileId || null,
      customText: ov.customText || '',
      segmentMinutes: Number(task.segmentMinutes ?? s.defaultSegmentMinutes ?? 60),
      segmentSizeMB: Number(task.segmentSizeMB ?? s.defaultSegmentSizeMB ?? 2048),
      container: task.container || s.recordContainer || 'ts',
      remuxToMp4: task.remuxToMp4 ?? s.remuxToMp4 !== false,
      autoMerge: task.autoMerge ?? !!s.autoMerge,
    };
  }

  /**
   * 从前端 payload 里提取"任务级自定义"（overrides）：
   * 支持 {overrides:{quality,segmentMode,namingProfileId,customText}} 与扁平字段两种写法；
   * 值为 null/'' 表示恢复「跟随全局」。
   */
  _overridesFrom(input = {}) {
    const ovIn = (input.overrides && typeof input.overrides === 'object') ? { ...input.overrides } : {};
    for (const k of ['quality', 'segmentMode', 'namingProfileId', 'customText']) {
      if (input[k] !== undefined) ovIn[k] = input[k];
    }
    const out = {};
    if (ovIn.quality) out.quality = ovIn.quality;
    if (ovIn.segmentMode) out.segmentMode = ovIn.segmentMode;
    if (ovIn.namingProfileId) out.namingProfileId = ovIn.namingProfileId;
    if (ovIn.customText) out.customText = ovIn.customText;
    return out;
  }

  /** 把生效参数写回扁平字段（前端表格/详情读的是扁平字段 + overrides） */  applyEffective(task) {
    const e = this.effective(task);
    task.quality = e.quality;
    task.qualityLabel = qualityLabel(e.quality);
    task.segmentMode = e.segmentMode;
    task.segmentMinutes = e.segmentMinutes;
    task.segmentSizeMB = e.segmentSizeMB;
    task.container = e.container;
    task.remuxToMp4 = e.remuxToMp4;
    task.autoMerge = e.autoMerge;
    task.namingProfileId = e.namingProfileId;
    task.customText = e.customText;
    return task;
  }

  activeCount() {
    return [...this.recorders.values()].filter((r) => !r.paused).length;
  }

  platformActive(platform) {
    let n = 0;
    for (const [, rec] of this.recorders) {
      if (rec.paused) continue;
      if (rec.task.platform === platform) n++;
    }
    return n;
  }

  capacity(platform) {
    const settings = this.store.settings;
    const global = Number(settings.maxConcurrency) || 8;
    const cap = Number(settings.platformCaps?.[platform] ?? this.platformOf(platform).cap ?? 2);
    return { global, cap, active: this.activeCount(), platformActive: this.platformActive(platform) };
  }

  // ---------- 任务 CRUD ----------
  async createTask(input = {}) {
    const settings = this.store.settings;
    const raw = String(input.url || input.sourceUrl || '').trim();
    let platform = input.platform || detectPlatform(raw) || null;
    if (!platform && raw && input.roomId) platform = input.platform || detectPlatform(raw);
    if (!platform) throw new HttpError('INVALID_URL', '无法识别平台：请粘贴完整直播间链接，或手动指定平台', 400);
    const p = getPlatform(platform);
    if (!p) throw new HttpError('UNKNOWN_PLATFORM', `未知平台：${platform}`, 400);
    if (!p.handler) throw new HttpError('NOT_IMPLEMENTED', `${p.name} 暂未接入，可改用「直链」粘贴流地址`, 400);
    if (settings.platformEnabled?.[platform] === false) throw new HttpError('PLATFORM_DISABLED', `${p.name} 已在平台账号里关闭`, 400);

    const roomId = String(input.roomId || (raw ? roomIdFrom(platform, raw) : '')).trim();
    if (!roomId) throw new HttpError('INVALID_URL', '缺少房间号或流地址', 400);

    const dup = this.store.taskByRoom(platform, roomId);
    if (dup) throw new HttpError('DUPLICATE_ROOM', `该直播间已有启用中的任务（${dup.anchorName || dup.roomId}），一个直播间只能有一个任务`, 409);

    let room = null;
    try {
      room = await resolveRoom(raw || `${platform}:${roomId}`, { platform, settings, logger: this.logger });
    } catch (e) {
      if (['NOT_IMPLEMENTED', 'AUTH', 'BLOCKED'].includes(e.code)) throw e;
      this.logger.warn(`创建任务时解析失败（仍会创建，稍后自动重试）：${e.message}`);
      room = { anchorName: input.anchorName || '', title: input.title || '', roomId, liveStatus: 'unknown', qualityOptions: p.qualities };
    }

    const task = Store.newTask({
      platform,
      platformName: p.name,
      roomId: String(room?.roomId || roomId),
      sourceUrl: raw || `${platform}:${roomId}`,
      anchorName: input.anchorName || room?.anchorName || '',
      title: input.title || room?.title || '',
      avatar: room?.avatar || '',
      overrides: this._overridesFrom(input),
      qualityFallback: Array.isArray(input.qualityFallback) ? input.qualityFallback : settings.qualityFallback,
      autoRecord: input.autoRecord !== false,
      monitorOnly: input.monitorOnly !== undefined ? !!input.monitorOnly : !!settings.defaultMonitorOnly,
      pollIntervalSec: Number(input.pollIntervalSec ?? settings.pollIntervalSec ?? 60),
      startDelaySec: Number(input.startDelaySec ?? settings.startDelaySec ?? 5),
      stopDelaySec: Number(input.stopDelaySec ?? settings.stopDelaySec ?? 30),
      status: room?.liveStatus === 'live' ? 'queued' : 'waiting',
      statusMessage: room?.liveStatus === 'live' ? '检测到开播，排队中' : '等待开播',
      nextPollAt: room?.liveStatus === 'live' ? 0 : Date.now() + 5000,
    });
    // 分段/封装/转封装：任务级显式传了就用手动值，否则跟随全局
    if (input.segmentMode !== undefined) task.segmentMode = input.segmentMode;
    if (input.segmentMinutes !== undefined) task.segmentMinutes = Number(input.segmentMinutes);
    if (input.segmentSizeMB !== undefined) task.segmentSizeMB = Number(input.segmentSizeMB);
    if (input.container !== undefined) task.container = input.container;
    if (input.remuxToMp4 !== undefined) task.remuxToMp4 = !!input.remuxToMp4;
    if (input.keepSource !== undefined) task.keepSource = !!input.keepSource;
    if (input.autoMerge !== undefined) task.autoMerge = !!input.autoMerge;
    if (input.anchorNameLocked !== undefined) task.nameLocked = !!input.anchorNameLocked;
    this.applyEffective(task);
    await this.store.addTask(task);
    this.logger.info(`创建任务：${task.anchorName || task.roomId}（${p.name} · ${qualityLabel(task.quality)}）`, { taskId: task.id, taskName: task.anchorName });
    this.onEvent({ type: 'task', task });
    return task;
  }

  async updateTask(id, patch = {}) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    const locked = ['recording', 'stopping'].includes(task.status);
    const lockKeys = ['quality', 'segmentMode', 'namingProfileId', 'customText'];

    // 先合并 overrides：null / 空串 = 恢复跟随全局
    const overrides = { ...(task.overrides || {}) };
    const incoming = (patch.overrides && typeof patch.overrides === 'object') ? { ...patch.overrides } : {};
    for (const k of lockKeys) if (patch[k] !== undefined) incoming[k] = patch[k];
    let overrideChanged = false;
    for (const k of lockKeys) {
      if (incoming[k] === undefined) continue;
      overrideChanged = true;
      if (incoming[k] === null || incoming[k] === '') delete overrides[k];
      else overrides[k] = incoming[k];
    }

    if (locked && overrideChanged) {
      // 前端会提示"本场沿用旧参数，下一场生效"
      task.overrides = overrides;
      await this.store.saveTask(task);
      const err = new HttpError('RECORDING_LOCKED', '任务正在录制：清晰度/分段方式/命名配置的修改将在下一场生效（本场沿用旧参数）', 409);
      err.appliedNextSession = true;
      this.onEvent({ type: 'task', task });
      return Promise.reject(err);
    }
    if (overrideChanged) task.overrides = overrides;

    const allowed = [
      'anchorName', 'title', 'qualityFallback', 'segmentMinutes', 'segmentSizeMB',
      'container', 'remuxToMp4', 'keepSource', 'autoMerge', 'autoRecord', 'monitorOnly',
      'pollIntervalSec', 'startDelaySec', 'stopDelaySec', 'roomId', 'nameLocked',
    ];
    for (const k of allowed) if (patch[k] !== undefined) task[k] = patch[k];
    this.applyEffective(task);
    if (patch.quality !== undefined || overrideChanged) task.qualityActual = task.qualityActual || null;
    await this.store.saveTask(task);
    this.onEvent({ type: 'task', task });
    return task;
  }

  async deleteTask(id, { force = false } = {}) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    if (['recording', 'stopping', 'paused'].includes(task.status)) {
      if (!force) throw new HttpError('TASK_RUNNING', '任务正在录制/暂停中，请先停止（或加 force=1 先停止再删除）', 409);
      await this.stopTask(id, { reason: 'delete' });
    }
    this.recorders.delete(id);
    this.detached.delete(id);
    await this.store.removeTask(id);
    this.logger.info(`已删除任务：${task.anchorName || task.roomId}（录制文件保留，可在文件库删除）`, { taskId: id });
    this.onEvent({ type: 'task', task: null, taskId: id });
    return { deleted: true, filesKept: true };
  }

  // ---------- 生命周期 ----------
  /**
   * 幂等外壳：同一任务在任一时刻只能有一个录制作业。
   * 调度 tick（默认 5s）与「手动开始录制」可能并发进入启动流程，而启动流程里有多个 await
   * （保存场次、探测流、拉起 ffmpeg），旧实现只在 await 之后才把 task.status 置为 recording，
   * 于是第二次调用会看到"未在录制"并再起一个 ffmpeg —— 两个进程写同一个分段文件（真实事故：兰知春序 2026-10-09）。
   * 这里用同步占位 + 状态双保险，重复调用直接返回 already。
   */
  async _startRecording(task, opts = {}) {
    if (this.recorders.has(task.id) || this.starting.has(task.id) || ['recording', 'stopping'].includes(task.status)) {
      this.logger?.warn(`任务已有录制作业或正在启动，忽略重复启动：${task.anchorName || task.roomId}（status=${task.status}）`, { taskId: task.id, taskName: task.anchorName });
      return { already: true, status: task.status };
    }
    this.starting.add(task.id);
    try {
      return await this._startRecordingInner(task, opts);
    } finally {
      this.starting.delete(task.id);
    }
  }

  async _startRecordingInner(task, { reason = 'live' } = {}) {
    const settings = this.store.settings;
    const cap = this.capacity(task.platform);
    if (cap.active >= cap.global) {
      task.status = 'queued';
      task.queueReason = `超出全局上限（${cap.active}/${cap.global}）`;
      task.statusMessage = '排队中';
      await this.store.saveTask(task);
      return { queued: true, reason: task.queueReason };
    }
    if (cap.platformActive >= cap.cap) {
      task.status = 'queued';
      task.queueReason = `超出${task.platformName || task.platform}平台上限（${cap.platformActive}/${cap.cap}），全局 ${cap.active}/${cap.global}`;
      task.statusMessage = '排队中';
      await this.store.saveTask(task);
      return { queued: true, reason: task.queueReason };
    }
    const disk = this.storage.disk();
    const limit = (Number(settings.diskLimitGB) || 0) * 1024 * 1024 * 1024;
    if (limit > 0 && disk.freeBytes && disk.freeBytes < limit) {
      task.status = 'error';
      task.lastError = `磁盘剩余 ${formatBytes(disk.freeBytes)} 低于阈值 ${formatBytes(limit)}`;
      task.statusMessage = task.lastError;
      await this.store.saveTask(task);
      this.logger.error(`拒绝开始录制：${task.lastError}`, { taskId: task.id, taskName: task.anchorName });
      await this.notifier.send('disk', '磁盘空间不足', `${task.lastError}，请清理 /data 后重试。`, { taskId: task.id, taskName: task.anchorName });
      return { error: task.lastError };
    }

    // 开录前重算生效参数：overrides 里没写的项跟随最新全局设置（D11）
    this.applyEffective(task);

    const session = {
      id: uid('s'), taskId: task.id, platform: task.platform, platformName: task.platformName,      roomId: task.roomId, streamer: task.anchorName, title: task.title,
      quality: task.quality, qualityLabel: qualityLabel(task.quality),
      startedAt: nowIso(), endedAt: null, durationSec: 0, bytes: 0, status: 'recording',
      dir: null, relDir: '', segments: [], extras: [], merged: null, mp4: null,
      namingProfileId: task.namingProfileId || null, taskSnapshot: { anchorName: task.anchorName, roomId: task.roomId },
    };
    this.sessions.set(task.id, session);
    await this.store.addSession(session);

    const recorder = new Recorder({
      task, settings, naming: this.store.naming, logger: this.logger, resolveStream,
      mediaMod: this.mediaMod || undefined,
    });
    this.recorders.set(task.id, recorder);

    recorder.on('segment-close', (seg) => { this._onSegmentClose(task, session, seg).catch(() => {}); });
    recorder.on('reconnect', async (info) => {
      task.reconnectCount = (task.reconnectCount || 0) + 1;
      task.statusMessage = `断流重连 ${info.attempt}/${settings.reconnectMax}`;
      this.logger.warn(`第 ${info.attempt} 次重连（等待 ${Math.round(info.delayMs / 1000)}s）：${info.error || ''}`, { taskId: task.id, taskName: task.anchorName });
      this.onEvent({ type: 'task', task });
    });
    recorder.on('error', async (err) => {
      task.lastError = err.message;
      this.logger.error(`录制错误：${err.message}`, { taskId: task.id, taskName: task.anchorName });
      if (!err.retryable) await this._onFinished(task, { reason: 'error', segments: [], bytes: 0, durationSec: 0 });
      else this.onEvent({ type: 'task', task });
    });
    recorder.on('finished', (payload) => { this._onFinished(task, payload).catch((e) => this.logger.error(`收尾失败：${e.message}`)); });

    try {
      const started = await recorder.start();
      session.dir = started.dir;
      session.relDir = path.relative(settings.recordRoot, started.dir).split(path.sep).join('/');
      session.quality = started.quality;
      session.qualityLabel = started.qualityLabel;
      task.status = 'recording';
      task.statusMessage = '录制中';
      task.queueReason = null;
      task.startedAt = nowIso();
      task.endedAt = null;
      task.qualityActual = started.quality;
      task.qualityLabel = started.qualityLabel;
      task.sessionId = session.id;
      task.failCount = 0;
      await this.store.saveTask(task);
      await this.store.saveSession(session);
      this.logger.info(`开始录制：${task.anchorName || task.roomId} · ${started.qualityLabel} → ${path.basename(started.dir)}`, { taskId: task.id, taskName: task.anchorName });
      this.onEvent({ type: 'task', task });
      return { started: true, sessionId: session.id };
    } catch (e) {
      this.recorders.delete(task.id);
      this.sessions.delete(task.id);
      await this.store.removeSession(session.id);
      task.status = 'error';
      task.lastError = e.message;
      task.statusMessage = e.message;
      task.failCount = (task.failCount || 0) + 1;
      await this.store.saveTask(task);
      this.logger.error(`启动录制失败：${e.message}`, { taskId: task.id, taskName: task.anchorName });
      await this.notifier.send('error', '录制启动失败', `${task.anchorName || task.roomId}：${e.message}`, { taskId: task.id, taskName: task.anchorName });
      this.onEvent({ type: 'task', task });
      return { error: e.message };
    }
  }

  async _onSegmentClose(task, session, seg) {
    // 空分段（0 字节）：ffmpeg 在轮转/停止的瞬间会先创建下一个分段文件再退出，留下 0 字节残渣。
    // 它不是有效录制内容，登记进文件库只会变成"未登记垃圾"，因此明确清理并留日志（不静默丢数据：0 字节没有数据）。
    let bytes = Number(seg.bytes) || 0;
    if (bytes <= 0) {
      const st = await fsp.stat(seg.path).catch(() => null);
      bytes = st ? st.size : 0;
    }
    if (bytes <= 0) {
      await fsp.rm(seg.path, { force: true }).catch(() => {});
      this.logger.warn(`分段 #${seg.index} 为 0 字节（轮转/停止瞬间的空文件），已清理：${seg.name}`, { taskId: task.id, taskName: task.anchorName });
      return;
    }
    const rel = path.relative(this.store.settings.recordRoot, seg.path).split(path.sep).join('/');
    const exists = session.segments.find((f) => f.segmentIndex === seg.index);
    const item = {
      id: exists?.id || uid('f'), sessionId: session.id, kind: 'segment',
      name: seg.name, path: seg.path, relPath: rel, ext: path.extname(seg.name).replace('.', ''),
      bytes, durationSec: seg.durationSec || 0, width: 0, height: 0,
      createdAt: seg.startedAt || session.startedAt, completedAt: seg.endedAt || nowIso(),
      status: 'ok', segmentIndex: seg.index,
    };
    if (exists) Object.assign(exists, item);
    else session.segments.push(item);
    session.segments.sort((a, b) => a.segmentIndex - b.segmentIndex);
    session.bytes = session.segments.reduce((a, b) => a + (b.bytes || 0), 0);
    session.durationSec = session.segments.reduce((a, b) => a + (b.durationSec || 0), 0);
    task.totalBytes = session.bytes;
    task.totalDurationSec = session.durationSec;
    task.segmentIndex = session.segments.length;
    task.currentFile = null;
    this.logger.info(`分段 #${seg.index} 收尾：${seg.name}（${formatBytes(seg.bytes)} · ${formatDuration(seg.durationSec)}）`, { taskId: task.id, taskName: task.anchorName });
    this._throttledPersist();
    this.onEvent({ type: 'task', task });
  }

  _throttledPersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.store.persist().catch(() => {});
    }, 1500);
  }

  async _onFinished(task, payload) {
    const session = this.sessions.get(task.id) || (task.sessionId ? this.store.getSession(task.sessionId) : null);
    this.recorders.delete(task.id);
    this.detached.delete(task.id);
    this.sessions.delete(task.id);
    const reason = payload.reason || 'user';
    if (session) {
      session.endedAt = nowIso();
      session.bytes = (session.segments || []).reduce((a, b) => a + (b.bytes || 0), 0);
      session.durationSec = (session.segments || []).reduce((a, b) => a + (b.durationSec || 0), 0);
      session.status = reason === 'error' ? 'error' : (session.segments.length ? 'done' : 'partial');
      await this.store.saveSession(session);
    }
    task.status = reason === 'error' ? 'error' : (task.manualHeld ? 'stopped' : 'completed');
    task.statusMessage = reason === 'error' ? (task.lastError || '录制失败') : (task.manualHeld ? '已手动停止，等待你手动开始' : '已完成');
    task.endedAt = nowIso();
    task.currentFile = null;
    task.totalBytes = session?.bytes || task.totalBytes || 0;
    task.totalDurationSec = session?.durationSec || task.totalDurationSec || 0;
    task.nextPollAt = Date.now() + Math.max(30, Number(task.pollIntervalSec) || 60) * 1000;
    await this.store.saveTask(task);
    this.logger.info(`录制结束（${reason}）：${task.anchorName || task.roomId}，共 ${task.segmentIndex || session?.segments?.length || 0} 段 / ${formatBytes(task.totalBytes)}`, { taskId: task.id, taskName: task.anchorName });
    if (reason === 'error') {
      await this.notifier.send('error', '录制异常结束', `${task.anchorName || task.roomId}：${task.lastError || '未知错误'}`, { taskId: task.id, taskName: task.anchorName });
    } else {
      // 录制完成不再发通知（仅保留开播检测通知）
    }
    this.onEvent({ type: 'task', task });
    if (session && session.segments.length) {
      this.storage.autoRemux(session)
        .then(() => this.storage.writeArt(session))
        .then(() => this.onEvent({ type: 'files' }))
        .catch((e) => this.logger.warn(`自动转封装失败：${e.message}`));
    }
    this.tick().catch(() => {});
  }

  async startTask(id, { reason = 'manual' } = {}) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    const isMonitor = task.monitorOnly === true;
    if (['recording', 'stopping'].includes(task.status)) return { already: true, task };
    if (isMonitor) {
      // 仅监控任务点「开始录制」：只录本场一次，不改变"仅监控/不自动录制"的设置，本场结束回到仅监控
      task.manualHeld = false;
    } else {
      // 正常任务点「开始录制」：重新开启自动录制，之后自动跟进
      task.autoRecord = true;
      task.manualHeld = false;
    }
    // 直链任务不需要开播检测
    if (task.platform === 'direct') {
      task.autoRecord = true;
      return { result: await this._startRecording(task, { reason }) };
    }
    let info = null;
    try {
      info = await resolveRoom(task.sourceUrl || `${task.platform}:${task.roomId}`, { platform: task.platform, settings: this.store.settings, logger: this.logger });
    } catch (e) {
      this.logger.warn(`手动开始前的开播检测失败：${e.message}`, { taskId: task.id });
    }
    if (info) {
      if (!task.nameLocked) task.anchorName = info.anchorName || task.anchorName;
      task.title = info.title || task.title;
      task.avatar = info.avatar || task.avatar;
      if (info.liveStatus === 'offline' && reason === 'manual') {
        task.status = 'waiting';
        task.statusMessage = '未直播，等待开播';
        await this.store.saveTask(task);
        return { waiting: true };
      }
    }
    const r = await this._startRecording(task, { reason });
    return { result: r };
  }

  async stopTask(id, { reason = 'user' } = {}) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    // 手动停止（正常任务）：关闭自动录制、等手动重新开始，但直播状态监控照常刷新；仅监控任务停掉的是当场一次性录制，回到"仅监控"
    if (reason === 'user' && !task.monitorOnly) {
      task.autoRecord = false;
      task.manualHeld = true;
    }
    const rec = this.recorders.get(id) || this.detached.get(id);
    if (!rec) {
      task.status = 'stopped';
      task.statusMessage = task.monitorOnly ? '已停止本场一次性录制' : '已停止 · 未录制，等手动开始';
      await this.store.saveTask(task);
      this._manualStopLiveRefresh(task).catch(() => {});
      return { stopped: true, already: true };
    }
    task.status = 'stopping';
    task.statusMessage = '正在收尾分段…';
    await this.store.saveTask(task);
    this.onEvent({ type: 'task', task });
    const payload = await rec.stop(reason);
    if (this.recorders.has(id) || this.detached.has(id)) {
      await this._onFinished(task, payload);
    } else if (reason === 'user') {
      // 收尾已被自动最终化抢先执行（recorder 已移除），手动停止仍统一收敛为"已停止"
      task.status = 'stopped';
      task.statusMessage = '已手动停止，等待你手动开始';
      task.currentFile = null;
      task.endedAt = nowIso();
      await this.store.saveTask(task);
      this.onEvent({ type: 'task', task });
    }
    if (reason === 'user' && task.manualHeld) this._manualStopLiveRefresh(task).catch(() => {});
    return { stopped: true, segments: payload.segments?.length || 0, bytes: payload.bytes || 0 };
  }

  /** 手动停止后立即解析一次直播状态，落盘 liveStatus/statusMessage，让界面马上显示"直播中，未录制"或"未开播"，绝不显示"未知" */
  async _manualStopLiveRefresh(task) {
    try {
      const info = await resolveRoom(task.sourceUrl || `${task.platform}:${task.roomId}`, { platform: task.platform, settings: this.store.settings, logger: this.logger });
      task.liveStatus = info.liveStatus || 'offline';
      task.statusMessage = info.liveStatus === 'live'
        ? '已手动停止 · 直播中未录制，点「开始录制」'
        : '已手动停止 · 未开播，等你手动开始';
    } catch (e) {
      this.logger?.debug(`手动停止后刷新直播状态失败：${e.message}`, {});
      task.liveStatus = task.liveStatus || 'offline';
      task.statusMessage = '已手动停止 · 等你手动开始';
    }
    await this.store.saveTask(task);
    this.onEvent({ type: 'task', task });
  }

  async pauseTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    const rec = this.recorders.get(id);
    if (!rec) throw new HttpError('NOT_RECORDING', '任务当前没有在录制', 409);
    await rec.pause();
    task.status = 'paused';
    task.statusMessage = '已暂停（本段已结束，不占用并发）';
    task.currentFile = null;
    const session = this.sessions.get(id);
    if (session) { session.status = 'paused'; await this.store.saveSession(session); }
    this.recorders.delete(id);
    this.detached.set(id, rec);
    await this.store.saveTask(task);
    this.logger.info('已暂停：本段已结束并入库，拉流已停止，不占用并发', { taskId: id, taskName: task.anchorName });
    this.onEvent({ type: 'task', task });
    this.tick().catch(() => {});
    return { paused: true };
  }

  async resumeTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    const rec = this.detached.get(id);
    if (!rec) {
      // 暂停后进程已释放：直接重新开始，序号会续接
      return this.startTask(id, { reason: 'resume' });
    }
    const cap = this.capacity(task.platform);
    if (cap.active >= cap.global || cap.platformActive >= cap.cap) {
      task.status = 'queued';
      task.queueReason = cap.active >= cap.global
        ? `超出全局上限（${cap.active}/${cap.global}）`
        : `超出${task.platformName || task.platform}平台上限（${cap.platformActive}/${cap.cap}）`;
      task.statusMessage = '排队中';
      await this.store.saveTask(task);
      return { queued: true, reason: task.queueReason };
    }
    this.detached.delete(id);
    this.recorders.set(id, rec);
    await rec.resume();
    task.status = 'recording';
    task.statusMessage = '录制中';
    task.queueReason = null;
    const session = this.sessions.get(id);
    if (session) { session.status = 'recording'; await this.store.saveSession(session); }
    await this.store.saveTask(task);
    this.logger.info('已恢复录制：新开分段，序号续接', { taskId: id, taskName: task.anchorName });
    this.onEvent({ type: 'task', task });
    return { resumed: true };
  }

  async checkTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    try {
      const info = await resolveRoom(task.sourceUrl || `${task.platform}:${task.roomId}`, { platform: task.platform, settings: this.store.settings, logger: this.logger });
      if (!task.nameLocked) task.anchorName = info.anchorName || task.anchorName;
      task.title = info.title || task.title;
      task.avatar = info.avatar || task.avatar;
      task.liveStatus = info.liveStatus;
      task.statusMessage = task.manualHeld
        ? (info.liveStatus === 'live' ? '已手动停止 · 直播中未录制，等你手动开始' : '已手动停止 · 未开播，等你手动开始')
        : (info.liveStatus === 'live' ? '正在直播' : '未开播');
      task.failCount = 0;
      if (!task.manualHeld && info.liveStatus === 'live' && !task.monitorOnly && task.autoRecord && !['recording', 'stopping', 'paused'].includes(task.status)) {
        const r = await this._startRecording(task);
        return { info, started: r };
      }
      task.nextPollAt = Date.now() + Math.max(10, Number(task.pollIntervalSec) || 60) * 1000;
      await this.store.saveTask(task);
      this.onEvent({ type: 'task', task });
      return { info };
    } catch (e) {
      task.lastError = e.message;
      task.statusMessage = e.message;
      task.failCount = (task.failCount || 0) + 1;
      await this.store.saveTask(task);
      throw new HttpError(e.code || 'RESOLVE_FAILED', e.message, e.status || 502);
    }
  }

  async retryTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw new HttpError('NOT_FOUND', '任务不存在', 404);
    task.status = 'waiting';
    task.lastError = null;
    task.statusMessage = '已重置，等待开播';
    task.manualHeld = false;
    task.retryCount = 0;
    task.failCount = 0;
    task.nextPollAt = 0;
    await this.store.saveTask(task);
    this.logger.info('任务已重试', { taskId: id, taskName: task.anchorName });
    this.onEvent({ type: 'task', task });
    this.tick().catch(() => {});
    return { task };
  }

  async batch(action, ids = []) {
    const okIds = [];
    const failed = [];
    const limited = ids.slice(0, 50);
    for (const id of limited) {
      try {
        if (action === 'start') await this.startTask(id, { reason: 'manual' });
        else if (action === 'pause') await this.pauseTask(id);
        else if (action === 'stop') await this.stopTask(id);
        else if (action === 'check') await this.checkTask(id);
        else if (action === 'retry') await this.retryTask(id);
        else if (action === 'delete') await this.deleteTask(id, { force: true });
        else throw new HttpError('BAD_ACTION', `不支持的操作：${action}`, 400);
        okIds.push(id);
      } catch (e) {
        failed.push({ id, message: e.message, code: e.code || 'ERROR' });
      }
    }
    const note = action === 'start' && failed.length === 0
      ? `已启动 ${okIds.length} 项；并发不足的会留在队列中` : null;
    return { okIds, failed, note, truncated: ids.length > limited.length };
  }

  // ---------- 轮询与排队 ----------
  async tick() {
    const now = Date.now();
    const settings = this.store.settings;
    for (const task of this.store.tasks) {
      try {
        if (['recording', 'stopping'].includes(task.status)) continue;
        if (task.status === 'paused') continue;
        if (task.status === 'queued') {
          if (task.monitorOnly || task.manualHeld) {
            task.status = task.manualHeld ? 'stopped' : 'waiting';
            task.statusMessage = task.manualHeld ? '已手动停止 · 等你手动开始' : '正在直播 · 仅监控不录制';
            this.onEvent({ type: 'task', task });
            await this.store.saveTask(task);
          } else {
            const r = await this._startRecording(task);
            if (r?.queued) continue;
          }
          continue;
        }
        // 所有任务都按 pollIntervalSec 定时刷新直播状态（未直播/直播中），是否自动录制由 autoRecord/manualHeld/monitorOnly 单独控制
        if (task.nextPollAt && now < task.nextPollAt) continue;
        const p = this.platformOf(task.platform);
        if (settings.platformEnabled?.[task.platform] === false) continue;

        let info;
        try {
          info = await resolveRoom(task.sourceUrl || `${task.platform}:${task.roomId}`, {
            platform: task.platform, settings, logger: this.logger,
          });
        } catch (e) {
          task.failCount = (task.failCount || 0) + 1;
          task.lastError = e.message;
          const limit = p.tier === 'experimental' ? 2 : (Number(settings.reconnectMax) || 5);
          if (task.failCount >= 3 && !task.failNotified) {
            task.failNotified = true;
            await this.notifier.send('error', '开播检测连续失败', `${task.anchorName || task.roomId}（${p.name}）：${e.message}`, { taskId: task.id, taskName: task.anchorName });
          }
          if (task.failCount >= limit) {
            task.status = 'error';
            task.statusMessage = `${p.name} 解析连续失败 ${task.failCount} 次：${e.message}`;
            task.nextPollAt = now + 10 * 60 * 1000;
            this.logger.error(`任务转入错误（连续失败 ${task.failCount} 次）：${e.message}`, { taskId: task.id, taskName: task.anchorName });
          } else {
            const backoff = Math.min(10 * 60, Math.max(30, task.pollIntervalSec || 60) * 2 ** (task.failCount - 1));
            task.nextPollAt = now + backoff * 1000;
            task.statusMessage = `解析失败 ${task.failCount}/${limit}，${Math.round(backoff)} 秒后重试`;
          }
          await this.store.saveTask(task);
          this.onEvent({ type: 'task', task });
          continue;
        }

        task.failCount = 0;
        task.failNotified = false;
        if (!task.nameLocked) task.anchorName = info.anchorName || task.anchorName;
        task.title = info.title || task.title;
        task.avatar = info.avatar || task.avatar;
        const wasLive = task.liveStatus === 'live';
        task.liveStatus = info.liveStatus; // 始终落盘真实直播状态，避免"状态未知"

        // 开播检测：当监控发现某直播间从"未直播"变为"直播"时通知一次（非录制开始/结束）
        if (info.liveStatus === 'live' && !wasLive) {
          const at = `${formatDate()} ${formatTime(new Date(), 'HH:mm:ss')}`;
          const platDot = (p && p.name) || '直播';
          await this.notifier.send('live', '开始直播',
            `${platDot} 直播间 ${task.anchorName || task.roomId} 开始直播，时间：${at}`,
            { taskId: task.id, taskName: task.anchorName, plain: true });
        }

        // 手动停止后的任务：保持"已停止"，只刷新直播状态，绝不自动拉起，等用户点「开始录制」（仅监控任务走下面的 monitor 分支）
        if (task.manualHeld && !task.monitorOnly) {
          const live = info.liveStatus === 'live';
          task.status = 'stopped';
          task.statusMessage = live
            ? '已手动停止 · 直播中未录制，点「开始录制」'
            : '已手动停止 · 未开播，等你手动开始';
          task.nextPollAt = now + Math.max(20, Number(task.pollIntervalSec) || 60) * 1000;
          await this.store.saveTask(task);
          this.onEvent({ type: 'task', task });
          continue;
        }

        if (info.liveStatus === 'live') {
          if (task.monitorOnly) {
            if (task.status !== 'waiting') task.status = 'waiting';
            task.statusMessage = '正在直播 · 仅监控不录制';
            await this.store.saveTask(task);
            this.onEvent({ type: 'task', task });
          } else if (task.autoRecord && task.status !== 'recording' && task.status !== 'paused') {
            task.statusMessage = `检测到开播，${task.startDelaySec || 0} 秒后开始`;
            await this.store.saveTask(task);
            this.onEvent({ type: 'task', task });
            if (task.startDelaySec) await sleep(Math.min(30, Number(task.startDelaySec)) * 1000);
            await this._startRecording(task);
          } else if (task.status !== 'recording' && task.status !== 'stopping') {
            // 手动关掉自动录制后，正在直播就保持"未录制"，等用户点开始
            task.status = 'waiting';
            task.statusMessage = '正在直播 · 未录制（自动录制已关闭）';
            await this.store.saveTask(task);
            this.onEvent({ type: 'task', task });
          }
        } else {
          if (task.status !== 'waiting') {
            task.status = 'waiting';
            task.statusMessage = task.monitorOnly ? '未开播 · 仅监控' : (task.endedAt ? '本场已结束，等待下次开播' : '未直播，等待开播');
          } else {
            task.statusMessage = task.monitorOnly ? '未开播 · 仅监控' : '未直播，等待开播';
          }
          task.nextPollAt = now + Math.max(20, Number(task.pollIntervalSec) || 60) * 1000;
          await this.store.saveTask(task);
          this.onEvent({ type: 'task', task });
        }
      } catch (e) {
        this.logger.error(`任务轮询异常(${task.id})：${e.message}`);
      }
    }
  }

  // ---------- 对外视图 ----------
  serializeTask(task) {
    const rec = this.recorders.get(task.id) || this.detached.get(task.id);
    const stats = rec ? rec.getStats() : null;
    const session = this.sessions.get(task.id) || (task.sessionId ? this.store.getSession(task.sessionId) : null);
    return {
      ...task,
      name: task.anchorName || task.title || task.roomId,
      overrides: task.overrides || {},
      qualityLabel: task.qualityLabel || qualityLabel(task.qualityActual || task.quality),
      live: {
        bytes: stats?.bytes ?? session?.bytes ?? task.totalBytes ?? 0,
        elapsedSec: stats?.elapsedSec ?? 0,
        currentFile: stats?.currentName || null,
        segmentIndex: stats?.segmentIndex || session?.segments?.length || task.segmentIndex || 0,
        reconnects: stats?.reconnects ?? task.reconnectCount ?? 0,
        dir: stats?.dir || session?.dir || null,
        speed: stats?.speed || 0,
      },
      sessionSummary: session ? {
        id: session.id, status: session.status, bytes: session.bytes,
        durationSec: session.durationSec, segments: session.segments.length,
      } : null,
    };
  }

  listTasks(filter = {}) {
    let items = this.store.tasks.map((t) => this.serializeTask(t));
    if (filter.status) items = items.filter((t) => t.status === filter.status);
    if (filter.platform) items = items.filter((t) => t.platform === filter.platform);
    if (filter.q) {
      const s = String(filter.q).toLowerCase();
      items = items.filter((t) => `${t.anchorName} ${t.title} ${t.roomId}`.toLowerCase().includes(s));
    }
    return items;
  }

  /**
   * 今日统计（口径见总览页说明）：
   * 「今日」= 容器时区（Asia/Shanghai）当天 00:00 起算；跨天会话按**单个文件**归属到其收尾那一天，
   * 因此不会把昨天录的分段算进今天。「录制时长」= 当日各分段实际时长累加（非墙钟），
   * 转封装/合并等派生文件只计文件数与体积、不重复计时长。
   */
  todayStats() {
    const day = dateKey();
    const dayOf = (f) => (f.completedAt || f.createdAt ? dateKey(new Date(f.completedAt || f.createdAt)) : null);
    let files = 0;
    let bytes = 0;
    let durationSec = 0;
    for (const s of this.store.sessions) {
      const segs = s.segments || [];
      const segIds = new Set(segs.map((f) => f.id));
      for (const f of segs) {
        if (dayOf(f) !== day) continue;
        files++;
        bytes += Number(f.bytes) || 0;
        durationSec += Number(f.durationSec) || 0;
      }
      // extras 转封装/合并出：ts 源删除后 mp4 是唯一副本，必须计入时长；
      // 仅当对应源 ts 仍保留（sourceFileId 命中）或整场合并件且 segments 未删时去重，避免重复计时
      for (const f of (s.extras || [])) {
        if (dayOf(f) !== day) continue;
        files++;
        bytes += Number(f.bytes) || 0;
        const dupSeg = !!f.sourceFileId && segIds.has(f.sourceFileId);
        const dupMerge = !f.sourceFileId && segs.length > 0;
        if (!dupSeg && !dupMerge) durationSec += Number(f.durationSec) || 0;
      }
    }
    return { todayFiles: files, todayBytes: bytes, todayDurationSec: durationSec + this.liveTodayElapsedSec() };
  }

  /* 累计录制时长（所有会话，跨天），口径同 todayStats：分段实际时长累加，extra 派生件去重 */
  totalDurationSec() {
    const now = Date.now();
    if (this._dTotalAt && now - this._dTotalAt < 15000 && this._dTotalSec != null) return this._dTotalSec;
    let dur = 0;
    for (const s of this.store.sessions) {
      const segs = s.segments || [];
      const segIds = new Set(segs.map((f) => f.id));
      for (const f of segs) dur += Number(f.durationSec) || 0;
      for (const f of (s.extras || [])) {
        const dupSeg = !!f.sourceFileId && segIds.has(f.sourceFileId);
        const dupMerge = !f.sourceFileId && segs.length > 0;
        if (!dupSeg && !dupMerge) dur += Number(f.durationSec) || 0;
      }
    }
    this._dTotalAt = now;
    this._dTotalSec = dur;
    return dur;
  }

  // 实时「今日已录时长」：把正在录制、尚未轮转的当前分段时长也计入，随趋势实时刷新
  liveTodayElapsedSec() {
    let sec = 0;
    for (const [, r] of this.recorders) {
      if (r.paused) continue;
      const segEl = r.getStats ? (r.getStats().currentSegElapsedSec || 0) : 0;
      sec += segEl;
    }
    return sec;
  }

  // 「平台存储分布」：按平台汇总当前实际占用空间的录制文件大小（statSync 精确到真实大小，
  // 去重避免同一文件被分段/转封装重复计）；5s TTL 缓存，避免每次轮询都全量 stat（status 走同步）。
  platformStore() {
    const now = Date.now();
    if (this._pstore && now - (this._pstoreAt || 0) < 5000) return this._pstore;
    const map = new Map();
    const seen = new Set();
    const cands = [];
    for (const s of this.store.sessions) {
      const key = s.platform || 'direct';
      if (!map.has(key)) map.set(key, { platform: key, name: s.platformName || key, bytes: 0 });
      for (const f of [...(s.segments || []), ...(s.extras || []), s.merged, s.mp4].filter(Boolean)) {
        if (f && f.path && !seen.has(f.path)) { seen.add(f.path); cands.push([key, f.path]); }
      }
    }
    for (const [key, p] of cands) {
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      const e = map.get(key);
      if (e) e.bytes += size;
    }
    this._pstore = [...map.values()].filter((e) => e.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    this._pstoreAt = now;
    return this._pstore;
  }

  status() {
    const full = this.store.tasks.map((t) => this.serializeTask(t));
    // recording 用完整形状（前端总览读 live.segmentIndex/elapsedSec/bytes 显示实时进度）
    const recording = full.filter((t) => t.status === 'recording');
    const queued = full.filter((t) => t.status === 'queued');
    const waiting = full.filter((t) => ['waiting', 'idle', 'paused', 'error'].includes(t.status));
    const tasks = full.map((t) => LITE(t));
    const settings = this.store.settings;
    const active = this.activeCount();
    return {
      stats: {
        recordingCount: recording.length,
        activeCount: active,
        concurrencyCap: Number(settings.maxConcurrency) || 8,
        queuedCount: queued.length,
        waitingCount: waiting.filter((t) => t.status === 'waiting' && t.monitorOnly !== true).length,
        platformCount: new Set(recording.map((t) => t.platform)).size,
        downSpeed: recording.reduce((a, t) => a + (Number(t.live?.speed) || 0), 0),
        totalDurationSec: this.totalDurationSec(),
        ...this.todayStats(),
      },
      disk: this.storage.disk(),
      recordRoot: this.store.settings.recordRoot,
      engine: {
        available: this.engine.available,
        version: process.env.LIVEGRAB_VERSION || '0.1.0',
        // 兼容前端字段名（app.js / dashboard.js 读的是 ffmpegAvailable/ffmpegVersion）
        ffmpegAvailable: this.engine.available,
        ffmpegVersion: this.engine.version,
        tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
        uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
        node: process.version,
        playConcurrency: Number(settings.playConcurrency) || 2,
      },
      recording,
      waiting,
      queue: queued.map((t) => ({ id: t.id, name: t.name, reason: t.queueReason || '并发已满' })),
      recent: this.logger.recent(8),
      platforms: platformList(settings).map((p) => ({ ...p, active: this.platformActive(p.id) })),
      platformStore: this.platformStore(),
      tasks: tasks.map((t) => LITE(t)),
    };
  }
}
