// 存储层：磁盘统计、扫描入库、回收站、转封装、合并、保留策略清理
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as media from './media.js';
import { uid, nowIso, ensureDir, formatBytes, mimeByExt, extOf, HttpError, safeJoin, dirSize, errText } from './util.js';
import { buildMergedName, buildContext, pickProfile } from './naming.js';
import { PLATFORMS } from './resolvers/index.js';

export const MEDIA_EXT = new Set(['.ts', '.mp4', '.m4a', '.flv', '.mkv']);

export function playModeOf(ext) {
  return ['.ts', '.flv', '.mkv'].includes(String(ext).toLowerCase()) ? 'remux' : 'direct';
}

/* ---------- 未登记文件导入推断（路径 → 平台/主播，文件名 → 开始时间） ---------- */

/** 录制根目录首段目录常为中文平台名 → 权威平台 id（来自 resolvers 的 PLATFORMS 清单） */
const PLATFORM_ID_BY_NAME = new Map(PLATFORMS.map((p) => [p.name, p.id]));

/** 从相对目录首段推断平台：匹配平台中文名 / 英文 id，否则回退为目录名小写 id */
function inferPlatform(relDir) {
  const seg = String(relDir || '').split('/')[0] || '';
  if (!seg) return { platform: 'other', platformName: null };
  const byName = PLATFORM_ID_BY_NAME.get(seg);
  if (byName) return { platform: byName, platformName: seg };
  const byId = PLATFORMS.find((p) => p.id === seg);
  if (byId) return { platform: byId.id, platformName: byId.name };
  const id = seg.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 32) || 'other';
  return { platform: id, platformName: seg };
}

/** 主播 = 相对目录第二段（平台名/日期之后的那一层） */
function inferStreamer(relDir) {
  const parts = String(relDir || '').split('/').filter(Boolean);
  return parts[1] || '';
}

/** 旧命名 YYYY-MM-DD[-HH[-MM[-SS]]] 前缀 → 开始时间（UTC）；解析失败回退文件时间 */
function inferStartedAt(name, fallback) {
  const m = String(name || '').match(/(\d{4})-(\d{2})-(\d{2})(?:[-_ ](\d{2}))?(?:[-_ ](\d{2}))?(?:[-_ ](\d{2}))?/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback || nowIso();
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
    this._scanTimer = null;      // 后台定时扫描（外部移动/删除文件对账）
    this._scanInflight = null;   // 扫描在飞去重：并发调用复用同一 Promise，绝不并行遍历磁盘
    this._lastScanAt = 0;        // 上次扫描起始时间戳（节流基准）
    this.activePathsFn = null;   // 提供「正在写入的活动分段」路径集合（扫描时跳过，避免误登记）
    this._remuxInflight = new Map(); // 转封装按输出路径互斥（live remux 与 autoRemux 并发写同一文件防护）
  }

  get root() { return this.store.settings.recordRoot; }
  get trashDir() { return path.join(this.root, '.trash'); }

  /** 统一元数据目录：config/meta/<任务id>/ 内存头像、seg 列表等每个主播的附属信息（不进录制目录） */
  get metaRoot() { return path.join(this.store.configDir, 'meta'); }

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
    this._lastScanAt = Date.now();
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
    for (const f of this.store.allFiles()) {
      // 同一物理路径可能被登记在多处（extras 与 mp4/merged 指向同一文件、历史重复登记），
      // 按路径聚合成数组，扫描时统一更新，避免只更新到 Map 里最后一条导致界面残留 missing
      if (!indexed.has(f.path)) indexed.set(f.path, []);
      indexed.get(f.path).push(f);
    }

    let added = 0;
    let updated = 0;
    let missing = 0;
    let ghosts = 0;
    const seen = new Set();
    // 「正在写入」的活动分段：录制的当前分段尚未封口（segment 还没 close），不是完整文件。
    // 若把它当未登记文件登记成独立会话，就会出现「文件库里有个录制中的 ts，点开不能播、首帧也没有」，
    // 且等分段真正关闭时同路径会再登记一次 → 重复记录。这里直接跳过，并标记 seen 免得被判缺失。
    const active = this.activePathsFn ? new Set(this.activePathsFn() || []) : new Set();
    for (const p of found) {
      seen.add(p);
      if (active.has(p)) continue;
      const recs = indexed.get(p);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      if (recs && recs.length) {
        for (const rec of recs) {
          if (rec.status === 'missing' || rec.bytes !== st.size) {
            rec.bytes = st.size;
            rec.status = 'ok';
            updated++;
          }
        }
      } else {
        // 录制根目录迁移补偿：绝对路径不匹配但 relPath 相同的「缺失」记录，重绑到当前磁盘路径。
        // （用户搬动/改名数据目录后旧绝对路径失效被标 missing；这里按相对路径找回并同步会话目录指针）
        const rel = this.rel(p);
        const stale = [...indexed.values()].flat().find((x) => x.status === 'missing' && x.relPath === rel);
        if (stale) {
          indexed.delete(stale.path); // 旧路径从索引移除，避免下方缺失循环把该记录再次标 missing
          stale.path = p;
          stale.bytes = st.size;
          stale.status = 'ok';
          updated++;
          if (stale.sessionId) {
            const sess = this.store.sessions.find((s) => s.id === stale.sessionId);
            if (sess && sess.dir && !sess.dir.startsWith(this.root)) {
              sess.dir = path.dirname(p);
              sess.relDir = this.rel(path.dirname(p));
            }
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
          // 扫描到未登记文件 → 后台自动注册为独立场次（文件库立即可见可播），不再挂「未登记」列表
          await this._registerUnregistered(item);
          added++;
        }
      }
    }
    for (const [p, recs] of indexed) {
      for (const rec of recs) {
        if (rec.kind === 'unregistered') continue;
        if (!seen.has(p) && rec.status !== 'missing') { rec.status = 'missing'; missing++; }
      }
    }
    // 清理历史幽灵会话：早期扫描曾把「正在写入的当前分段」登记成独立会话（taskId 为空、仅含该文件）。
    // 该文件此刻由活动录制占用 → 删掉这个空壳会话，避免文件库残留「不能播、无首帧」的录制中条目。
    if (active.size) {
      for (const s of [...this.store.state.sessions]) {
        if (s.taskId) continue;
        const files = [...(s.segments || []), ...(s.extras || [])];
        if (files.length === 1 && !s.merged && !s.mp4 && files[0].path && active.has(files[0].path)) {
          await this.store.removeSession(s.id).catch(() => {});
          ghosts++;
          this.logger.info(`清理扫描误登记的活动分段幽灵会话：${s.id}`);
        }
      }
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
    const changed = added || updated || missing || cleaned || ghosts;
    if (changed) {
      await this.store.persist();
      this.logger.info(`扫描完成：新增场次 ${added}，更新 ${updated}，缺失 ${missing}${cleaned ? `，清理幽灵条目 ${cleaned}` : ''}${ghosts ? `，清理幽灵会话 ${ghosts}` : ''}`);
      this.onEvent({ type: 'files' });
    } else {
      this.logger.debug(`扫描完成：无变化（共 ${found.length} 个媒体文件）`);
    }
    return { added, updated, missing, unregistered: this.store.state.external.length, cleaned, total: found.length };
  }

  /** 同一路径已归属场次时，清掉此前误登记为"未登记"的条目 */
  _dropExternalByPath(p) {
    const before = this.store.state.external.length;
    this.store.state.external = this.store.state.external.filter((f) => f.path !== p);
    return before - this.store.state.external.length;
  }

  /** 由未登记文件记录构造独立场次（路径推断平台/主播、文件名推断开始时间）；不写库。
   *  保留原文件 id：files 表同 id 的 external 行会被 file_upsert 原地更新成 segment 行，
   *  避免 path UNIQUE 冲突。文件本身不移动、不改写。 */
  _sessionFromUnregistered(rec) {
    const relDir = String(rec.relPath || '').replace(/\\/g, '/');
    const dirOf = path.posix.dirname(relDir);
    const rel = dirOf === '.' ? '' : dirOf;
    const { platform, platformName } = inferPlatform(rel);
    rec.kind = 'segment';
    rec.sessionId = null; // fileToRow 会用 session.id 覆盖
    return {
      id: uid('s'), taskId: null,
      platform: platform || 'other', platformName: platformName || null,
      roomId: null, streamer: inferStreamer(rel),
      title: path.basename(rec.name, path.extname(rec.name)) || rec.name,
      quality: null, qualityLabel: null,
      startedAt: inferStartedAt(rec.name, rec.createdAt || rec.completedAt || nowIso()),
      endedAt: null, durationSec: 0, bytes: rec.bytes || 0, status: 'done',
      dir: path.dirname(rec.path), relDir: rel,
      segments: [rec], extras: [], merged: null, mp4: null,
      namingProfileId: null, taskSnapshot: { anchorName: '', roomId: '' },
    };
  }

  /** 把一个未登记文件注册为独立场次（addSession 写穿透）；磁盘已不存在则跳过，返回场次 id 或 null */
  async _registerUnregistered(rec) {
    if (!rec) return null;
    if (!fs.existsSync(rec.path)) return null;
    const session = this._sessionFromUnregistered(rec);
    this.store.state.external = this.store.state.external.filter((x) => x.id !== rec.id);
    await this.store.addSession(session);
    return session.id;
  }

  /** 兜底入口：把当前未登记列表（或指定路径）注册为独立场次。
   *  正常情况下扫描已自动注册，此处仅用于恢复回收站后的补登记或人工触发。
   *  paths 为空 = 全部未登记；传路径 = 只处理匹配项（绝对路径或相对路径均可）。 */
  async importExternal(paths = []) {
    const list = Array.isArray(paths) && paths.length ? paths : this.store.external.map((f) => f.path);
    let done = 0;
    for (const p of list) {
      const rec = this.store.external.find((f) => f.path === p || f.relPath === p);
      if (!rec) continue;
      if (await this._registerUnregistered(rec)) done++;
    }
    if (done) {
      await this.store.persist(); // 兜底对账：清掉同 path 的外部行残留并归一
      this.onEvent({ type: 'files' });
      this.logger.info(`未登记文件补登记 ${done} 条（生成场次 ${done} 个）`);
    }
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
      if (session && session.status === 'recording') {
        // 与整场删除（sessionIds 分支）对齐：录制中的场次任何文件都先停止再删，
        // 避免边录边删导致合并/转封装/统计错乱（文件行本身不再有 status='recording'）。
        throw new HttpError('FILE_RECORDING', '该文件所属场次正在录制，请先停止录制再删除', 409);
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
        await this._recalcSession(session);
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

  /* 回收站列表：支持后端分页。
   * opts.pageSize 缺省/为 0 → 返回全量（兼容「全部还原」按 ids 拉取）。
   * 返回 { items, total, page, pageSize, pages, bytes, count, retentionDays }，保留 count 供测试。 */
  /**
   * 返回 { items, total, page, pageSize, pages, bytes, count, retentionDays }。
   * 传入 page/pageSize 时按页切片；不传则返回全量（兼容测试与「全部还原」等场景）。
   * 保留 count 供测试；retentionDays 来自设置项（回收站保留天数）。
   */
  listTrash(opts = {}) {
    const all = this.store.trash;
    const total = all.length;
    const bytes = all.reduce((a, b) => a + b.bytes, 0);
    // 回收站保留天数取「回收站保留」设置（trashRetentionDays），不是录像保留天数（retentionDays）。
    const retentionDays = Number(this.store.settings && this.store.settings.trashRetentionDays) || 0;
    const rawPs = Number(opts.pageSize) || 0;
    if (rawPs > 0) {
      const pageSize = Math.min(1000, Math.max(1, rawPs));
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.max(1, Math.min(pages, Number(opts.page) || 1));
      const start = (page - 1) * pageSize;
      return { items: all.slice(start, start + pageSize), total, page, pageSize, pages, bytes, count: total, retentionDays };
    }
    return { items: all, total, page: 1, pageSize: total, pages: 1, bytes, count: total, retentionDays };
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
          await this._recalcSession(s); // 还原后场次体积/时长与任务总量同步重算
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

    // 同一输出路径 in-flight 互斥 —— live remux 与 autoRemux 可能对同一分段并发转封装。
    // 已在飞则直接复用其结果（同一 Promise），绝不两个 ffmpeg 同时写同一文件（keepSource=false 时成品是唯一副本）。
    const inflight = this._remuxInflight.get(outPath);
    if (inflight) {
      try {
        const reused = await inflight;
        this._jobDone(job, { fileId: reused?.id, name: reused?.name || path.basename(outPath) });
        return reused;
      } catch (e) {
        this._jobFail(job, e?.message || String(e));
        throw e;
      }
    }

    const run = (async () => {
      try {
        // 输出已存在且非空 → 幂等复用（不先删旧输出；重复转封装/崩溃遗留时直接复用内存条目，避免并发丢副本）
        const st0 = await fsp.stat(outPath).catch(() => null);
        if (st0 && st0.size > 0) {
          const exItem = (session?.extras || []).find((x) => x.path === outPath)
            || (session?.mp4 && session.mp4.path === outPath ? session.mp4 : null);
          if (exItem) return exItem;
        }
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
        return item;
      } catch (e) {
        this.logger.error(`转封装失败：${file.name} — ${errText(e)}`);
        throw new HttpError('REMUX_FAILED', `转封装失败：${e.message}`, 500);
      } finally {
        this._remuxInflight.delete(outPath);
      }
    })();
    this._remuxInflight.set(outPath, run);
    const item = await run;
    this._jobDone(job, { fileId: item.id, name: item.name });
    return item;
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
        await this.remux(item.id).catch((e) => this.logger.warn(`合并后转封装失败：${errText(e)}`));
      }
      return item;
    } catch (e) {
      await fsp.rm(listFile, { force: true }).catch(() => {});
      this.logger.error(`合并失败：${errText(e)}`);
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
      await this.mergeSession(session.id).catch((e) => this.logger.warn(`自动合并失败：${errText(e)}`));
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

  /** 会话实际占用字节：segments+extras+merged+mp4 按路径去重（与 server.sessionFileBytes 同口径） */
  _sessionFileBytes(session) {
    const seen = new Set(); let n = 0;
    for (const f of [...(session.segments || []), ...(session.extras || []), session.merged, session.mp4]) {
      if (f && f.path && !seen.has(f.path)) { seen.add(f.path); n += f.bytes || 0; }
    }
    return n;
  }

  /** 会话时长：segments+extras+merged+mp4 按路径去重（keepSource=false 删源后仍保留成品 mp4 时长，不再归零） */
  _sessionDurationSec(session) {
    const seen = new Set(); let n = 0;
    for (const f of [...(session.segments || []), ...(session.extras || []), session.merged, session.mp4]) {
      if (f && f.path && !seen.has(f.path)) { seen.add(f.path); n += f.durationSec || 0; }
    }
    return n;
  }

  /** 重算场次占用 bytes/durationSec（多文件按路径去重），并同步关联任务的 totalBytes/totalDurationSec。
   *  删除单文件、从回收站还原、转封装删源后都必须调用——否则文件库（实时算）与任务页（读存量字段）会不一致。 */
  async _recalcSession(session) {
    if (!session) return;
    session.bytes = this._sessionFileBytes(session);
    session.durationSec = this._sessionDurationSec(session);
    await this.store.saveSession(session);
    if (session.taskId) {
      const task = this.store.tasks.find((t) => t.id === session.taskId);
      if (task) {
        task.totalBytes = session.bytes;
        task.totalDurationSec = session.durationSec;
        await this.store.saveTask(task);
      }
    }
  }

  /** 转封装成功后，按设置删除源 .ts：移出磁盘并从分段记录里移除（成品 mp4 保留） */
  async _dropSourceSegment(seg, session) {
    await fsp.rm(seg.path, { force: true }).catch(() => {});
    this.logger.info(`转封装后已删除源文件：${seg.name}`, { taskId: session.taskId, taskName: session.streamer });
    session.segments = (session.segments || []).filter((x) => x.id !== seg.id);
    await this._recalcSession(session); // 口径含 extras/merged/mp4，删源后不再归零，并同步任务总量
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
        await this._markArt(session, primary, poster, nfo);
        return true;
      }
      const img = await this.media.grabFrame({ input: primary, width: 480 });
      if (img) {
        await fsp.writeFile(poster, img);
        await fsp.writeFile(path.join(dir, 'poster.jpg'), img).catch(() => {}); // Jellyfin 目录海报
      }
      await this._writeNfo(nfo, session, base, primary);
      await this._markArt(session, primary, poster, nfo);
      this.logger.info(`已生成刮削：${base}.jpg + ${base}.nfo`, { taskId: session.taskId, taskName: session.streamer });
      return !!img;
    } catch (e) {
      this.logger.warn(`刮削生成失败：${errText(e)}`);
      return false;
    }
  }

  /**
   * 刮削/预览侧车落库：把 <base>.jpg / <base>.nfo 的相对路径写回对应文件记录
   * （files.thumbnail_path / files.scrape_path），任务管理与文件列表直接读这两列，不再现算。
   */
  async _markArt(session, primaryPath, posterPath, nfoPath) {
    const all = [...(session.segments || []), ...(session.extras || [])];
    if (session.merged) all.push(session.merged);
    if (session.mp4) all.push(session.mp4);
    const rec = all.find((f) => f && f.path === primaryPath);
    if (!rec) return false;
    rec.thumbnailPath = this.rel(posterPath);
    rec.scrapePath = this.rel(nfoPath);
    await this.store.saveSession(session);
    return true;
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

  // ---------- 主播头像落盘缓存 ----------
  // 点击解析 / 创建任务 / 检查直播 / 开播时调用：把平台头像下载到 <configDir>/meta/<任务id>/avatar.<ext>。
  // 平时头像接口直接读本地文件——只有再次解析才会更新，否则一直保持第一次缓存的（平台 CDN 热链/失效/断网都不影响显示）。
  async saveAvatar(task, avatarUrl) {
    const raw = avatarUrl;
    const url = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.middle || raw.big || raw.small || '') : '');
    if (!url || !task || !task.id) return null;
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 2 * 1024 * 1024) return null;
      const ct = r.headers.get('content-type') || '';
      const ext = ct.includes('webp') ? 'webp' : ct.includes('png') ? 'png' : 'jpg';
      const file = `${task.id}/avatar.${ext}`;
      const dir = path.join(this.metaRoot, task.id);
      await ensureDir(dir);
      await fsp.writeFile(path.join(dir, `avatar.${ext}`), buf);
      task.avatarFile = file;
      return file;
    } catch {
      return null;
    }
  }

  /** 删除某任务在元数据目录下的所有附属文件（删除任务时调用） */
  async removeMeta(taskId) {
    await fsp.rm(path.join(this.metaRoot, String(taskId)), { recursive: true, force: true }).catch(() => {});
  }

  // ---------- 元数据目录统一清扫 ----------
  // seg 列表是临时产物：正常收尾时 recorder 会删；这里兜底清掉异常退出残留（超过 maxAge 的），并清掉空目录。
  async cleanupMeta({ maxAgeMs = 24 * 3600 * 1000 } = {}) {
    const root = this.metaRoot;
    let segs = 0;
    let dirs = 0;
    const ents = await fsp.readdir(root).catch(() => []);
    for (const name of ents) {
      const p = path.join(root, name);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      if (st.isFile()) {
        if (/^\.segs_.*\.csv$/i.test(name)) {
          if (Date.now() - st.mtimeMs > maxAgeMs) { await fsp.rm(p, { force: true }).catch(() => {}); segs++; }
        }
        continue;
      }
      if (!st.isDirectory()) continue;
      let removedInDir = 0;
      const files = await fsp.readdir(p).catch(() => []);
      for (const f of files) {
        const fp = path.join(p, f);
        const fs = await fsp.stat(fp).catch(() => null);
        if (!fs || !fs.isFile() || !/^\.segs_.*\.csv$/i.test(f)) continue;
        if (Date.now() - fs.mtimeMs > maxAgeMs) { await fsp.rm(fp, { force: true }).catch(() => {}); removedInDir++; }
      }
      segs += removedInDir;
      const rest = await fsp.readdir(p).catch(() => []);
      if (!rest.length) { await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); dirs++; }
    }
    if (segs || dirs) this.logger.info(`元数据清扫：删除 seg 残留 ${segs} 个、空目录 ${dirs} 个`);
    return { segs, dirs };
  }

  /** 启动时的一次性迁移/清扫：录制目录里的旧 .segs_*.csv 残留、旧 config/avatars 头像缓存（已迁到 meta 目录） */
  async sweepLegacyArtifacts() {
    // 1) 录制目录里历史遗留的 .segs_*.csv（早期版本写在录制目录）
    const found = [];
    const walk = async (dir) => {
      const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '.trash') continue;
          await walk(p);
        } else if (e.isFile() && /^\.segs_.*\.csv$/i.test(e.name)) {
          found.push(p);
        }
      }
    };
    await walk(this.root);
    for (const p of found) await fsp.rm(p, { force: true }).catch(() => {});
    if (found.length) this.logger.info(`已清理录制目录里的 seg 列表残留 ${found.length} 个`);
    // 2) 旧版头像缓存目录 config/avatars（已统一迁入 config/meta/<任务id>/avatar.*）
    await fsp.rm(path.join(this.store.configDir, 'avatars'), { recursive: true, force: true }).catch(() => {});
    await this.cleanupMeta();
  }

  // ---------- 保留策略 ----------
  async cleanup({ force = false } = {}) {
    const settings = this.store.settings;
    await this.cleanupMeta(); // 元数据目录统一清扫（seg 残留、空目录）
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
          } catch (e) { this.logger.warn(`保留策略删除失败：${errText(e)}`); }
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

  /** 节流扫描：距上次扫描不足 minIntervalMs 直接跳过；扫描在飞时复用同一 Promise，绝不并发。
   *  供「后台定时器」与「文件库接口」共用——页面打开时按较小间隔（5s）扫，空闲时后台按较大间隔（15s）扫，
   *  既让外部移动/删除尽快同步到文件管理页，又避免频繁递归遍历磁盘拖慢接口。 */
  scanThrottled(minIntervalMs = 5000) {
    if (this._scanInflight) return this._scanInflight;
    if (this._lastScanAt && Date.now() - this._lastScanAt < minIntervalMs) return Promise.resolve(null);
    this._scanInflight = this.scan()
      .catch((e) => { this.logger.warn(`定时扫描失败：${errText(e)}`); return null; })
      .finally(() => { this._scanInflight = null; });
    return this._scanInflight;
  }

  /** 注册「正在写入的活动分段」提供者：scan 会跳过这些路径，
   *  避免把未封口的当前分段误登记成独立会话（否则文件库出现不能播、无首帧的"录制中 ts"）。 */
  setActivePathsProvider(fn) { this.activePathsFn = typeof fn === 'function' ? fn : null; }

  /** 后台定时扫描：文件被外部移动/删除后，无需手动点「扫描」，文件库自动与磁盘对账 */
  startScanTimer(intervalMs = Number(process.env.SCAN_INTERVAL_MS) || 15000) {
    if (this._scanTimer) clearInterval(this._scanTimer);
    const ms = Math.max(3000, Number(intervalMs) || 15000);
    this._scanTimer = setInterval(() => { this.scanThrottled(ms).catch(() => {}); }, ms);
    if (typeof this._scanTimer.unref === 'function') this._scanTimer.unref();
    this.logger.info(`已启用文件定时扫描：每 ${Math.round(ms / 1000)} 秒对账一次（外部移动/删除自动同步到文件库）`);
  }
}
