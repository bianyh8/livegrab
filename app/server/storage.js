// 存储层：磁盘统计、扫描入库、回收站、转封装、合并、保留策略清理
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as media from './media.js';
import { uid, nowIso, ensureDir, formatBytes, mimeByExt, extOf, HttpError, safeJoin, dirSize } from './util.js';
import { buildMergedName, buildContext, pickProfile } from './naming.js';

export const MEDIA_EXT = new Set(['.ts', '.mp4', '.m4a', '.flv', '.mkv']);

export function playModeOf(ext) {
  return ['.ts', '.flv', '.mkv'].includes(String(ext).toLowerCase()) ? 'remux' : 'direct';
}

export class Storage {
  constructor({ store, logger, notify = null, mediaMod = media }) {
    this.store = store;
    this.logger = logger;
    this.notify = notify;
    this.media = mediaMod;
    this.jobs = new Map();
    this.onEvent = () => {};
    this._cleanupTimer = null;
  }

  get root() { return this.store.settings.recordRoot; }
  get trashDir() { return path.join(this.root, '.trash'); }

  rel(p) { return path.relative(this.root, p).split(path.sep).join('/'); }

  disk() {
    try {
      const st = fs.statfsSync(this.root);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const used = total - st.bfree * st.bsize;
      const trash = dirSize(this.trashDir);
      return { totalBytes: total, freeBytes: free, usedBytes: used, trashBytes: trash.bytes, trashFiles: trash.files, recordRoot: this.root };
    } catch (e) {
      const trash = dirSize(this.trashDir);
      return { totalBytes: 0, freeBytes: 0, usedBytes: 0, trashBytes: trash.bytes, trashFiles: trash.files, recordRoot: this.root, error: e.message };
    }
  }

  // ---------- 扫描与一致性（D19） ----------
  async scan() {
    const root = this.root;
    await ensureDir(root);
    const found = [];
    const walk = async (dir) => {
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '.trash') continue;
          await walk(p);
        } else if (e.isFile()) {
          if (e.name.startsWith('.') || e.name.endsWith('.tmp') || e.name.endsWith('.csv')) continue;
          if (!MEDIA_EXT.has(extOf(e.name))) continue;
          found.push(p);
        }
      }
    };
    await walk(root);

    const indexed = new Map();
    for (const f of this.store.allFiles()) indexed.set(f.path, f);

    let added = 0;
    let updated = 0;
    let missing = 0;
    const seen = new Set();
    for (const p of found) {
      seen.add(p);
      const rec = indexed.get(p);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      if (rec) {
        if (rec.status === 'missing' || rec.bytes !== st.size) {
          rec.bytes = st.size;
          rec.status = 'ok';
          updated++;
        }
      } else {
        const ext = extOf(p);
        const name = path.basename(p);
        const item = {
          id: uid('f'), sessionId: null, kind: 'unregistered', name, path: p, relPath: this.rel(p),
          ext: ext.replace('.', ''), bytes: st.size, durationSec: 0, width: 0, height: 0,
          createdAt: st.birthtime?.toISOString?.() || nowIso(), completedAt: st.mtime?.toISOString?.() || nowIso(),
          status: 'ok', segmentIndex: 0,
        };
        this.store.external.push(item);
        added++;
      }
    }
    for (const [p, rec] of indexed) {
      if (rec.kind === 'unregistered') continue;
      if (!seen.has(p) && rec.status !== 'missing') { rec.status = 'missing'; missing++; }
    }
    // 清理"幽灵未登记条目"：① 文件已从磁盘消失；② 该路径已归属某个场次
    // （转封装/合并产物可能先被一次扫描当成"未登记"，随后又被登记为场次产物，旧条目若不清理会永久挂在文件库）
    const sessionPaths = new Set();
    for (const s of this.store.sessions) {
      for (const f of [...(s.segments || []), ...(s.extras || [])]) if (f?.path) sessionPaths.add(f.path);
      if (s.merged?.path) sessionPaths.add(s.merged.path);
      if (s.mp4?.path) sessionPaths.add(s.mp4.path);
    }
    const beforeExternal = this.store.state.external.length;
    this.store.state.external = this.store.state.external.filter((f) => seen.has(f.path) && !sessionPaths.has(f.path));
    const cleaned = beforeExternal - this.store.state.external.length;
    await this.store.persist();
    this.logger.info(`扫描完成：新增 ${added}，更新 ${updated}，缺失 ${missing}，未登记 ${this.store.state.external.length}${cleaned ? `，清理幽灵条目 ${cleaned}` : ''}`);
    this.onEvent({ type: 'files' });
    return { added, updated, missing, unregistered: this.store.state.external.length, cleaned, total: found.length };
  }

  /** 同一路径已归属场次时，清掉此前误登记为"未登记"的条目 */
  _dropExternalByPath(p) {
    const before = this.store.state.external.length;
    this.store.state.external = this.store.state.external.filter((f) => f.path !== p);
    return before - this.store.state.external.length;
  }

  async importExternal(paths = []) {
    const list = Array.isArray(paths) && paths.length ? paths : this.store.external.map((f) => f.path);
    let done = 0;
    for (const p of list) {
      const rec = this.store.external.find((f) => f.path === p);
      if (!rec) continue;
      rec.kind = 'segment';
      rec.sessionId = null;
      done++;
    }
    await this.store.persist();
    this.onEvent({ type: 'files' });
    return { imported: done };
  }

  // ---------- 回收站（D10） ----------

  // 向上清理空目录（直到遇到非空目录或存储根目录）
  async rmEmptyUp(dir) {
    let cur = dir, guard = 0;
    const root = this.root;
    while (cur && cur !== root && cur.length >= root.length && guard++ < 20) {
      let entries;
      try { entries = await fsp.readdir(cur); } catch { return; }
      if (!entries || entries.length) return;
      try { await fsp.rmdir(cur); } catch { return; }
      cur = path.dirname(cur);
    }
  }

  async moveToTrash({ sessionIds = [], fileIds = [] } = {}) {
    const settings = this.store.settings;
    const useTrash = settings.deleteToTrash !== false;
    const moved = [];
    let bytes = 0;

    // 把一个媒体文件 + 它同名的刮削侧夹（<同名>.jpg/.jpeg/.nfo）一起移入回收站，可还原；返回 item 数组
    const moveOne = async (file) => {
      if (!file || !file.path) return [];
      const st = await fsp.stat(file.path).catch(() => null);
      if (!st) return [];
      const items = [];
      const mover = async (src, isMedia) => {
        const s2 = isMedia ? st : await fsp.stat(src).catch(() => null);
        if (!s2) return null;
        const name = path.basename(src);
        const target = path.join(this.trashDir, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}__${name}`);
        if (useTrash) {
          await ensureDir(this.trashDir);
          await fsp.rename(src, target).catch(async () => { await fsp.copyFile(src, target); await fsp.rm(src, { force: true }); });
        } else {
          await fsp.rm(src, { force: true });
        }
        const item = { origPath: src, trashPath: useTrash ? target : null, name, bytes: s2.size, kind: isMedia ? (file.kind || 'file') : 'sidecar' };
        if (isMedia) item.record = { ...file };
        return item;
      };
      const media = await mover(file.path, true);
      if (media) { items.push(media); bytes += media.bytes; }
      const base = file.path.replace(/\.[^./\\]+$/, '');
      for (const ext of ['.jpg', '.jpeg', '.nfo']) {
        const sc = await mover(base + ext, false);
        if (sc) items.push(sc);
      }
      return items;
    };

    const dirs = new Set();
    for (const sid of sessionIds) {
      const s = this.store.getSession(sid);
      if (!s) continue;
      if (s.status === 'recording') throw new HttpError('SESSION_RECORDING', `「${s.streamer || sid}」正在录制，请先停止再删除`, 409);
      const files = [...(s.segments || []), ...(s.extras || []), s.merged, s.mp4].filter(Boolean);
      files.forEach((f) => { if (f && f.path) dirs.add(path.dirname(f.path)); });
      const items = [];
      for (const f of files) items.push(...(await moveOne(f)));
      const entry = {
        id: uid('tr'), kind: 'session', name: `${s.streamer || s.id} · ${s.title || ''}`.trim(),
        bytes: items.reduce((a, b) => a + (b.bytes || 0), 0), deletedAt: nowIso(),
        expireAt: new Date(Date.now() + (Number(settings.trashRetentionDays) || 7) * 86400_000).toISOString(),
        items, session: s,
      };
      if (useTrash) await this.store.addTrash(entry);
      await this.store.removeSession(sid);
      moved.push(entry.id);
    }

    for (const fid of fileIds) {
      const hit = this.store.findFile(fid);
      if (!hit) continue;
      const { file, session } = hit;
      if (session) {
        if (session.status === 'recording' && (session.segments || []).some((x) => x.id === fid && x.status === 'recording')) {
          throw new HttpError('FILE_RECORDING', '正在录制的分段不可删除，请先停止该任务', 409);
        }
      }
      if (file && file.path) dirs.add(path.dirname(file.path));
      const items = await moveOne(file);
      if (items.length) {
        // 与 session 分支一致：按「删除时移入回收站」开关决定是否登记回收站
        // （否则开关关闭时文件被永久删除，回收站仍残留清单 ghost 项）
        if (useTrash) {
          const entry = {
            id: uid('tr'), kind: 'file', name: file.name, bytes: items.reduce((a, b) => a + (b.bytes || 0), 0), deletedAt: nowIso(),
            expireAt: new Date(Date.now() + (Number(settings.trashRetentionDays) || 7) * 86400_000).toISOString(),
            items, sessionId: session?.id || null,
          };
          await this.store.addTrash(entry);
          moved.push(entry.id);
        }
      }
      if (session) {
        // 按 id 且按路径清理：同一物理文件可能被登记为多个条目（历史重复/场次+未登记），
        // 删除一个必须把同路径的其它记录一并清掉，否则残留条目会"文件缺失、无法播放"。
        const samePath = (x) => x && x.path === file.path;
        session.segments = (session.segments || []).filter((x) => x.id !== fid && !samePath(x));
        session.extras = (session.extras || []).filter((x) => x.id !== fid && !samePath(x));
        if (session.merged && (session.merged.id === fid || samePath(session.merged))) session.merged = null;
        if (session.mp4 && (session.mp4.id === fid || samePath(session.mp4))) session.mp4 = null;
        await this.store.saveSession(session);
      } else {
        this.store.state.external = this.store.state.external.filter((x) => x.id !== fid && x.path !== file.path);
      }
    }
    // 清理因删除而空的目录链
    for (const d of dirs) await this.rmEmptyUp(d);
    await this.store.persist();
    this.logger.info(`删除 ${moved.length} 项（${formatBytes(bytes)}）${useTrash ? '，已移入回收站' : ''}`);
    this.onEvent({ type: 'files' });
    return { movedToTrash: moved.length, bytes, trashIds: moved, useTrash };
  }

  listTrash() {
    const total = this.store.trash.reduce((a, b) => a + b.bytes, 0);
    return { items: this.store.trash, total, bytes: total, count: this.store.trash.length };
  }

  async restoreTrash(ids = []) {
    let restored = 0;
    for (const id of ids) {
      const entry = this.store.trash.find((t) => t.id === id);
      if (!entry) continue;
      for (const it of entry.items || []) {
        if (!it.trashPath) continue;
        await ensureDir(path.dirname(it.origPath));
        await fsp.rename(it.trashPath, it.origPath).catch(async () => {
          await fsp.copyFile(it.trashPath, it.origPath);
          await fsp.rm(it.trashPath, { force: true });
        });
      }
      if (entry.kind === 'session' && entry.session) {
        const s = entry.session;
        s.status = s.status === 'recording' ? 'partial' : s.status;
        this.store.state.sessions.unshift(s);
      } else if (entry.kind === 'file' && entry.sessionId) {
        const s = this.store.getSession(entry.sessionId);
        const rec = entry.items?.[0]?.record;
        if (s && rec) {
          if (rec.kind === 'merged') s.merged = rec; else if (rec.kind === 'mp4' || rec.kind === 'm4a') s.mp4 = rec;
          else s.segments = [...(s.segments || []), rec].sort((a, b) => (a.segmentIndex || 0) - (b.segmentIndex || 0));
        }
      } else if (entry.kind === 'file') {
        const rec = entry.items?.[0]?.record;
        if (rec) { rec.kind = 'unregistered'; this.store.external.push(rec); }
      }
      this.store.state.trash = this.store.state.trash.filter((t) => t.id !== id);
      restored++;
    }
    await this.store.persist();
    this.onEvent({ type: 'files' });
    return { restored };
  }

  async emptyTrash() {
    const count = this.store.trash.length;
    const bytes = this.store.trash.reduce((a, b) => a + b.bytes, 0);
    await fsp.rm(this.trashDir, { recursive: true, force: true }).catch(() => {});
    this.store.state.trash = [];
    await this.store.persist();
    this.logger.info(`已清空回收站：${count} 项（${formatBytes(bytes)}）`);
    this.onEvent({ type: 'files' });
    return { removed: count, bytes };
  }

  async purgeTrash(ids = []) {
    const now = Date.now();
    let targets;
    let reason = '过期清理';
    if (ids && ids.length) {
      targets = this.store.trash.filter((t) => ids.includes(t.id));
      reason = '已清除';
    } else {
      targets = this.store.trash.filter((t) => new Date(t.expireAt).getTime() < now);
    }
    let bytes = 0;
    for (const t of targets) {
      for (const it of t.items || []) {
        if (it.trashPath) { await fsp.rm(it.trashPath, { force: true }).catch(() => {}); bytes += it.bytes || 0; }
      }
    }
    if (targets.length) {
      const idset = new Set(targets.map((t) => t.id));
      this.store.state.trash = this.store.state.trash.filter((t) => !idset.has(t.id));
      await this.store.persist();
      this.logger.info(`回收站${reason} ${targets.length} 项（${formatBytes(bytes)}）`);
    }
    this.onEvent({ type: 'files' });
    return { purged: targets.length, bytes };
  }

  // ---------- 转封装 / 合并（异步任务） ----------
  _jobStart(name) {
    const job = { id: uid('job'), name, status: 'running', startedAt: nowIso(), progress: 0 };
    this.jobs.set(job.id, job);
    this.onEvent({ type: 'files', job });
    return job;
  }
  _jobDone(job, extra = {}) {
    job.status = 'done';
    job.endedAt = nowIso();
    Object.assign(job, extra);
    this.onEvent({ type: 'files', job });
    setTimeout(() => this.jobs.delete(job.id), 60000);
  }
  _jobFail(job, message) {
    job.status = 'error';
    job.message = message;
    job.endedAt = nowIso();
    this.onEvent({ type: 'files', job });
    setTimeout(() => this.jobs.delete(job.id), 60000);
  }

  async remux(fileId, { kind = 'mp4' } = {}) {
    const hit = this.store.findFile(fileId);
    if (!hit) throw new HttpError('NOT_FOUND', '文件不存在', 404);
    const { file, session } = hit;
    if (!['.ts', '.flv', '.mkv', '.mp4'].includes(String(file.ext).toLowerCase()) && !file.path.endsWith('.ts')) {
      throw new HttpError('BAD_FORMAT', '仅支持从 TS / FLV / MKV 转封装', 400);
    }
    const job = this._jobStart(`转封装 ${file.name}`);
    const audioOnly = kind === 'm4a' || file.kind === 'm4a';
    const outExt = audioOnly ? 'm4a' : 'mp4';
    const outPath = file.path.replace(/\.[^.]+$/, '') + `.${outExt}`;
    if (await fsp.stat(outPath).catch(() => null)) {
      await fsp.rm(outPath, { force: true });
    }
    try {
      const args = this.media.buildRemuxArgs({ input: file.path, output: outPath, audioOnly });
      const { code } = await this.media.runFfmpeg({
        args,
        onStderr: (l) => this.logger.debug(`[remux] ${l}`),
      });
      if (code !== 0) throw new Error(`ffmpeg exit=${code}`);
      const st = await fsp.stat(outPath);
      const probe = await this.media.probeJson(outPath).catch(() => null);
      const item = {
        id: uid('f'), sessionId: session?.id || null, kind: audioOnly ? 'm4a' : 'mp4',
        name: path.basename(outPath), path: outPath, relPath: this.rel(outPath), ext: outExt,
        bytes: st.size, durationSec: probe?.durationSec || file.durationSec || 0,
        width: probe?.width || 0, height: probe?.height || 0,
        createdAt: nowIso(), completedAt: nowIso(), status: 'ok', segmentIndex: file.segmentIndex || 0,
        sourceFileId: file.id,
      };
      if (session) {
        session.extras = session.extras || [];
        // 同路径旧条目（重复转封装产生的历史重复）先清掉，避免文件列表出现"同名两份"
        session.extras = session.extras.filter((x) => x.path !== outPath);
        session.extras.push(item);
        // 场次级成品 mp4：取第一个分段转出的 mp4（整场代表，供刮削/列表使用）；同路径旧指针一并替换
        if (session.mp4 && session.mp4.path === outPath) session.mp4 = item;
        if (!session.mp4 && file.kind === 'segment') session.mp4 = item;
        this._dropExternalByPath(outPath); // 防止同名"未登记"条目残留（扫描可能先一步登记过这个文件）
        await this.store.saveSession(session);
      } else {
        this.store.external.push(item);
        await this.store.persist();
      }
      this.logger.info(`转封装完成：${item.name}（${formatBytes(st.size)}）`);
      this._jobDone(job, { fileId: item.id, name: item.name });
      return item;
    } catch (e) {
      this.logger.error(`转封装失败：${file.name} — ${e.message}`);
      this._jobFail(job, e.message);
      throw new HttpError('REMUX_FAILED', `转封装失败：${e.message}`, 500);
    }
  }

  async mergeSession(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new HttpError('NOT_FOUND', '该场录制不存在', 404);
    if (session.status === 'recording') throw new HttpError('SESSION_RECORDING', '正在录制的场次不能合并，请先停止', 409);
    const segs = (session.segments || []).filter((f) => f.status !== 'missing');
    if (segs.length < 2) throw new HttpError('NOT_ENOUGH', '至少需要 2 个分段才能合并', 400);
    const job = this._jobStart(`合并 ${segs.length} 个分段`);
    const dir = path.dirname(segs[0].path);
    const listFile = path.join(dir, `.concat_${session.id}.txt`);
    const naming = this.store.naming;
    const profile = pickProfile(naming, { profileId: session.namingProfileId || null, platform: session.platform, taskId: session.taskId });
    const ctx = buildContext({
      task: { id: session.taskId }, anchorName: session.streamer, title: session.title,
      platform: session.platform, platformName: session.platformName, roomId: session.roomId,
      startAt: session.startedAt ? new Date(session.startedAt) : new Date(),
      quality: session.quality, durationSec: session.durationSec,
    });
    const { name: mergedName } = buildMergedName({ naming, ctx, ext: 'ts', profile });
    const outPath = path.join(dir, mergedName);
    try {
      await fsp.writeFile(listFile, this.media.buildConcatList(segs.map((f) => f.path)), 'utf8');
      const { code } = await this.media.runFfmpeg({
        args: this.media.buildMergeArgs({ listFile, output: outPath }),
        onStderr: (l) => this.logger.debug(`[merge] ${l}`),
      });
      await fsp.rm(listFile, { force: true }).catch(() => {});
      if (code !== 0) throw new Error(`ffmpeg exit=${code}`);
      const st = await fsp.stat(outPath);
      const probe = await this.media.probeJson(outPath).catch(() => null);
      const item = {
        id: uid('f'), sessionId: session.id, kind: 'merged', name: mergedName, path: outPath,
        relPath: this.rel(outPath), ext: 'ts', bytes: st.size,
        durationSec: probe?.durationSec || session.durationSec || 0, width: probe?.width || 0, height: probe?.height || 0,
        createdAt: nowIso(), completedAt: nowIso(), status: 'ok', segmentIndex: 0,
      };
      session.merged = item;
      session.extras = session.extras || [];
      session.extras.push(item);
      this._dropExternalByPath(outPath); // 合并产物同理：清掉可能已存在的同名"未登记"条目
      await this.store.saveSession(session);
      this.logger.info(`合并完成：${mergedName}（${formatBytes(st.size)}）`);
      this._jobDone(job, { fileId: item.id, name: item.name });
      // 合并后按设置自动转封装 MP4
      if (this.store.settings.remuxToMp4) {
        await this.remux(item.id).catch((e) => this.logger.warn(`合并后转封装失败：${e.message}`));
      }
      return item;
    } catch (e) {
      await fsp.rm(listFile, { force: true }).catch(() => {});
      this.logger.error(`合并失败：${e.message}`);
      this._jobFail(job, e.message);
      throw new HttpError('MERGE_FAILED', `合并失败：${e.message}`, 500);
    }
  }

  /** 录制收尾后的自动转封装（D5）；转 mp4 后按系统设置 keepSource 决定是否删除源 .ts */
  async autoRemux(session) {
    if (!this.store.settings.remuxToMp4) return [];
    // 边录边转封装已把部分分段转完：跳过有对应 mp4 的分段，避免重复转、重复登记
    const segs = (session.segments || []).filter((f) => f.ext === 'ts' && f.status !== 'missing'
      && !(session.extras || []).some((m) => m.sourceFileId === f.id));
    if (!segs.length) return [];
    if (this.store.settings.autoMerge && segs.length > 1) {
      await this.mergeSession(session.id).catch((e) => this.logger.warn(`自动合并失败：${e.message}`));
      return [];
    }
    const keep = this.store.settings.keepSource !== false; // 系统设置：转 mp4 后是否保留源 .ts
    const out = [];
    for (const f of segs) {
      try {
        const mp4 = await this.remux(f.id);
        out.push(mp4);
        if (!keep) await this._dropSourceSegment(f, session);
      } catch { /* 单段失败不阻塞，失败则保留源 */ }
    }
    return out;
  }

  /** 转封装成功后，按设置删除源 .ts：移出磁盘并从分段记录里移除（成品 mp4 保留） */
  async _dropSourceSegment(seg, session) {
    await fsp.rm(seg.path, { force: true }).catch(() => {});
    this.logger.info(`转封装后已删除源文件：${seg.name}`, { taskId: session.taskId, taskName: session.streamer });
    session.segments = (session.segments || []).filter((x) => x.id !== seg.id);
    session.bytes = (session.segments || []).reduce((a, b) => a + (b.bytes || 0), 0);
    session.durationSec = (session.segments || []).reduce((a, b) => a + (b.durationSec || 0), 0);
    await this.store.saveSession(session);
  }

  // ---------- 刮削：录制收尾时一次生成海报 + Jellyfin .nfo，之后接口/Jellyfin 只读取 ----------
  _nfoEscape(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

  async writeArt(session) {
    try {
      const segs = (session.segments || []).filter((f) => f && f.path && !/\.(m4a|mp3|aac|wav)$/i.test(f.path));
      // 整场代表文件：成品 mp4 → 合并档 → 首个分段 → extras 里的首个 mp4。
      // （边录边转封装 + keepSource=false 时分段可能已删除，必须兜底到 extras 的 mp4，保证 nfo 始终生成且代表整场）
      const mp4cand = (session.extras || []).find((f) => f && f.path && (f.kind === 'mp4' || f.kind === 'm4a'));
      const primary = (session.mp4 && session.mp4.path) || (session.merged && session.merged.path) || (segs[0] && segs[0].path) || (mp4cand && mp4cand.path) || null;
      if (!primary) return false;
      const st = await fsp.stat(primary).catch(() => null);
      if (!st || st.size <= 0) return false;
      const dir = path.dirname(primary);
      const base = path.basename(primary, path.extname(primary));
      const poster = path.join(dir, `${base}.jpg`);
      const nfo = path.join(dir, `${base}.nfo`);
      const existing = await fsp.stat(poster).catch(() => null);
      if (existing && existing.mtimeMs >= st.mtimeMs) {
        await this._writeNfo(nfo, session, base, primary);
        return true;
      }
      const img = await this.media.grabFrame({ input: primary, width: 480 });
      if (img) {
        await fsp.writeFile(poster, img);
        await fsp.writeFile(path.join(dir, 'poster.jpg'), img).catch(() => {}); // Jellyfin 目录海报
      }
      await this._writeNfo(nfo, session, base, primary);
      this.logger.info(`已生成刮削：${base}.jpg + ${base}.nfo`, { taskId: session.taskId, taskName: session.streamer });
      return !!img;
    } catch (e) {
      this.logger.warn(`刮削生成失败：${e.message}`);
      return false;
    }
  }

  async _writeNfo(nfoPath, session, base, primary) {
    const title = session.streamer || session.title || base;
    const plotText = `【${session.platformName || session.platform || ''}】${session.streamer || ''} 直播回放。${session.title ? `标题：${session.title}` : ''}        (${primary ? path.basename(primary) : base})`;
    const ts = (session.startedAt || new Date().toISOString()).slice(0, 19).replace('T', ' ');
    const nfo = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n` +
      `<movie>\n  <title>${this._nfoEscape(title)}</title>\n  <originaltitle>${this._nfoEscape(title)}</originaltitle>\n` +
      `  <plot>${this._nfoEscape(plotText)}</plot>\n  <outline>${this._nfoEscape(session.title || '')}</outline>\n` +
      `  <genre>${this._nfoEscape(session.platformName || session.platform || '')}</genre>\n` +
      `  <dateadded>${ts}</dateadded>\n  <premiered>${String(ts).slice(0, 10)}</premiered>\n  <studio></studio>\n</movie>\n`;
    await ensureDir(path.dirname(nfoPath));
    await fsp.writeFile(nfoPath, nfo, 'utf8');
  }

  // ---------- 保留策略 ----------
  async cleanup({ force = false } = {}) {
    const settings = this.store.settings;
    await this.purgeTrash();
    const days = Number(settings.retentionDays) || 0;
    let removedBytes = 0;
    let removed = 0;
    if (days > 0) {
      const cutoff = Date.now() - days * 86400_000;
      for (const s of [...this.store.sessions]) {
        if (s.status === 'recording') continue;
        const end = new Date(s.endedAt || s.startedAt || 0).getTime();
        if (end && end < cutoff) {
          try {
            const r = await this.moveToTrash({ sessionIds: [s.id] });
            removedBytes += r.bytes;
            removed++;
          } catch (e) { this.logger.warn(`保留策略删除失败：${e.message}`); }
        }
      }
    }
    const disk = this.disk();
    const limitBytes = (Number(settings.diskLimitGB) || 0) * 1024 * 1024 * 1024;
    if (limitBytes > 0 && disk.freeBytes < limitBytes) {
      this.logger.warn(`磁盘剩余 ${formatBytes(disk.freeBytes)} 低于阈值 ${formatBytes(limitBytes)}，开始清理最旧的场次`);
      const candidates = [...this.store.sessions].filter((s) => s.status !== 'recording')
        .sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0));
      for (const s of candidates) {
        const d = this.disk();
        if (d.freeBytes >= limitBytes) break;
        try {
          const r = await this.moveToTrash({ sessionIds: [s.id] });
          removedBytes += r.bytes;
          removed++;
        } catch { /* ignore */ }
      }
    }
    if (removed || force) this.logger.info(`清理完成：${removed} 场，释放 ${formatBytes(removedBytes)}`);
    return { removed, removedBytes };
  }

  startCleanupTimer(intervalMs = 10 * 60 * 1000) {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => { this.cleanup().catch(() => {}); }, intervalMs);
  }
}
