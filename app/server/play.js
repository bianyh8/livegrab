// 回放：MP4 直放；TS/FLV/MKV 由 ffmpeg -c copy 边转 fMP4 渐进流（零依赖，无需 hls.js）
import { uid, nowIso, HttpError, extOf } from './util.js';
import * as media from './media.js';

export class PlayManager {
  constructor({ store, logger, storage, onEvent = () => {}, mediaMod = media }) {
    this.store = store;
    this.logger = logger;
    this.storage = storage;
    this.onEvent = onEvent;
    this.media = mediaMod;
    this.sessions = new Map();
    this.timer = setInterval(() => this._sweep(), 30000);
    if (this.timer.unref) this.timer.unref();
  }

  get settings() { return this.store.settings; }
  get concurrency() { return Math.max(1, Number(this.settings.playConcurrency) || 2); }
  activeCount() { return [...this.sessions.values()].filter((s) => !s.released).length; }

  list() {
    return [...this.sessions.values()].map((s) => ({
      playId: s.id, fileId: s.fileId, name: s.name, mode: s.mode,
      startedAt: s.startedAt, lastAt: s.lastAt, bytes: s.bytes, clients: s.clients,
    }));
  }

  async start(fileId) {
    const hit = this.store.findFile(fileId);
    if (!hit) throw new HttpError('NOT_FOUND', '文件不存在', 404);
    const { file } = hit;
    const ext = extOf(file.name);
    const mode = ['.ts', '.flv', '.mkv'].includes(ext) ? 'remux' : 'direct';
    if (mode === 'direct') {
      return { playId: null, mode, url: `/api/files/${file.id}/stream`, name: file.name, note: '成品文件直接播放，可拖动进度' };
    }
    if (this.activeCount() >= this.concurrency) {
      throw new HttpError('PLAY_BUSY', `当前回放较多（上限 ${this.concurrency} 路），请稍后再试`, 429);
    }
    const id = uid('pl');
    const session = {
      id, fileId: file.id, name: file.name, path: file.path, mode,
      startedAt: nowIso(), lastAt: Date.now(), bytes: 0, clients: 0, proc: null, usedFallback: false,
      released: false,
    };
    this.sessions.set(id, session);
    this.logger.info(`开启回放会话：${file.name}（第 ${this.activeCount()}/${this.concurrency} 路）`);
    this.onEvent({ type: 'play', play: this.list() });
    return { playId: id, mode, url: `/api/play/${id}/stream`, name: file.name, note: '边转边播：不可拖动，播放到已转完的位置为止' };
  }

  get(playId) { return this.sessions.get(playId) || null; }

  release(playId) {
    const s = this.sessions.get(playId);
    if (!s) return { released: false };
    s.released = true;
    if (s.proc) { try { s.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    this.sessions.delete(playId);
    this.onEvent({ type: 'play', play: this.list() });
    return { released: true };
  }

  _sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.clients > 0) continue;
      if (now - s.lastAt > 5 * 60 * 1000) {
        this.logger.debug(`回放会话空闲超时，自动释放：${s.name}`);
        this.release(id);
      }
    }
  }

  /** 把转封装结果 pipe 给 HTTP 响应 */
  stream(playId, req, res) {
    const s = this.sessions.get(playId);
    if (!s) throw new HttpError('NOT_FOUND', '回放会话不存在或已结束', 404);
    if (s.proc) { try { s.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    s.clients += 1;
    s.lastAt = Date.now();
    const cleanup = () => { s.clients = Math.max(0, s.clients - 1); s.lastAt = Date.now(); if (s.proc) { try { s.proc.kill('SIGKILL'); } catch { /* ignore */ } s.proc = null; } };

    const spawnAttempt = (fallbackAudio) => {
      const args = this.media.buildPlayArgs({ input: s.path, audioOnly: false, fallbackAudio });
      let wrote = 0;
      const proc = this.media.spawnFfmpeg({
        args,
        onStderr: (l) => { if (/error|invalid/i.test(l)) this.logger.debug(`[play] ${l}`); },
      });
      s.proc = proc;
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
      }
      proc.stdout.on('data', (chunk) => {
        wrote += chunk.length;
        s.bytes += chunk.length;
        s.lastAt = Date.now();
        if (!res.write(chunk)) proc.stdout.pause();
      });
      res.on('drain', () => { if (proc.stdout.isPaused?.()) proc.stdout.resume(); });
      proc.on('close', (code) => {
        if (code !== 0 && wrote === 0 && !fallbackAudio && !s.usedFallback) {
          s.usedFallback = true;
          this.logger.warn(`回放转封装失败（code=${code}），改用 -c:v copy -c:a aac 重试：${s.name}`);
          try { spawnAttempt(true); return; } catch { /* fallthrough */ }
        }
        s.proc = null;
        s.lastAt = Date.now();
        if (!res.writableEnded) res.end();
        cleanup();
      });
      proc.on('error', () => { s.proc = null; if (!res.writableEnded) res.end(); cleanup(); });
    };

    req.on('close', () => { cleanup(); });
    spawnAttempt(false);
  }
}
