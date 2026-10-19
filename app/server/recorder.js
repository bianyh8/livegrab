// 单任务录制进程管理：分段、按大小轮转、断流重连、优雅停止（契约 §4.3 / §5）
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fsp from 'node:fs/promises';
import * as media from './media.js';
import { buildOutputPattern, buildContext, pickProfile, renderName, reserveName, qualityLabel, seqText } from './naming.js';
import { effectiveProxyForPlatform } from './proxy-fetch.js';
import { nowIso, ensureDir, safeJoin, sleep, errText, formatBytes } from './util.js';

const BACKOFF = [2000, 4000, 8000, 16000, 30000];
// 403/401/429 是平台侧明确拒绝（风控/限流/签名失效），不是网络抖动。
// 这类失败越重试越糟：实测抖音 CDN 对「秒级重新解析 + 立即再拉」的突发 pattern
// 会临时封禁拉流（20:21–20:27 连续 3 轮 ×5 次全部 403，安静约 1 分钟后自行恢复）。
// 因此拉长间隔（15s→2min）给平台侧留冷却时间，并复用当前地址——流地址有效期以天计，
// 重新解析只会增加接口压力、拖慢恢复。
const BLOCKED_BACKOFF = [15000, 30000, 60000, 120000, 120000];

/** ffmpeg stderr 是否为「平台侧拒绝拉流」（风控/限流/签名失效），区别于普通断流 */
export function isPullBlocked(tail) {
  return /Forbidden|access denied|Too Many Requests|Unauthorized|returned\s+40[139]\b/i.test(String(tail || ''));
}

/** 重连等待时长：blocked 走长冷却，普通断流走短退避 */
export function reconnectDelay({ blocked = false, attempt = 1 } = {}) {
  const table = blocked ? BLOCKED_BACKOFF : BACKOFF;
  return table[Math.min(Math.max(1, Number(attempt) || 1) - 1, table.length - 1)];
}

/** 单次拉流录到这个量就算「这段是好的」：断在它之后不消耗重连额度（用户实测：每段录几十兆才断，累计 5 次就整场被杀） */
export const PRODUCTIVE_BYTES = 1024 * 1024;

/**
 * 一次 ffmpeg 退出该怎么处理（纯函数，便于离线测试）。
 * 关键语义：只有「这次一个字都没录到」才算一次失败；录到了数据就说明链路是通的，
 * 计数归零、用最短延迟续上（1s），避免「断满 5 次整场停录」把好好的几个小时切成碎段。
 */
export function planReconnect({ blocked = false, attempt = 0, max = 5, bytesSinceSpawn = 0 } = {}) {
  const productive = Number(bytesSinceSpawn) >= PRODUCTIVE_BYTES;
  const next = productive ? 1 : Number(attempt) + 1;
  if (!productive && next > max) return { stop: true, attempt: next, delay: 0, productive };
  const delay = blocked ? reconnectDelay({ blocked: true, attempt: next })
    : (productive ? 1000 : reconnectDelay({ blocked: false, attempt: next }));
  return { stop: false, attempt: next, delay, productive };
}

export class Recorder extends EventEmitter {
  constructor({ task, settings, getSettings, naming, logger, resolveStream, mediaMod = media, probeOffline = null }) {
    super();
    this.task = task;
    // settings 实时读取：store.updateSettings 用 deepMerge 产出「新对象」替换 store.settings，
    // 若在任务启动时快照，运行中开关「按平台代理」后，下一次重连/重新解析仍会用旧值。
    // 统一走 getSettings()（scheduler 注入 () => store.settings），保守兼容直接传 settings 的旧用法。
    this._getSettings = typeof getSettings === 'function' ? getSettings : () => settings || {};
    this.naming = naming;
    this.logger = logger;
    this.resolveStream = resolveStream;
    this.media = mediaMod;
    this.probeOffline = probeOffline; // 可选：async () => boolean，判断主播是否已下播（下播时正常收尾而不是断流重连报错）
    this.child = null;
    this.stopping = false;
    this.paused = false;
    this.rotating = false;
    this.startedAt = null;
    this.singleFile = (task.segmentMode === 'none');
    this.audioOnly = task.quality === 'audio';
    this.ext = this.audioOnly ? 'm4a' : media.extOfContainer(task.container || 'ts');
    this.startNumber = 1;
    this.closed = new Set();
    this.reconnectAttempt = 0;
    this._stderrTail = [];
    this._rawStderr = [];   // 最近若干行 ffmpeg stderr（不过滤）：断流时写进日志才能定性
    this._bytesAtSpawn = 0; // 本次拉流启动时的落盘字节数（算「这次录到没有」）
    this.currentBytes = 0;
    this.currentSegment = null;
    this._rateBits = 0;       // 各任务实时下载速率（bit/s）
    this._tickRateRef = null; // { idx, bytes, t } 采样基准
    this._cumBase = 0;        // 已轮转关闭分段累计字节（保持整场单调，供速率采样）
    this._detailTick = 0;     // 周期详情日志计数
    this._segStartAt = null;  // 当前分段开始时间，用于实时「今日已录时长」
  }

  get settings() { return this._getSettings(); }

  _meta() { return { taskId: this.task.id, taskName: this.task.anchorName || this.task.title || this.task.id }; }

  // ---------- 启动 ----------
  async start({ startNumber = 1 } = {}) {
    const t = this.task;
    if (this.child && !this.paused) return { ok: true, already: true };
    this.stopping = false;
    this.paused = false;

    const stream = await this.resolveStream(
      { ...t, qualityFallback: this.settings.qualityFallback },
      { settings: this.settings, logger: this.logger },
    );
    if (!stream?.url) throw Object.assign(new Error('未能解析到流地址'), { code: 'NO_STREAM' });
    this.streamUrl = stream.url;
    this.headers = stream.headers || {};
    this.qualityActual = stream.qualityActual || stream.quality || t.quality;
    this.resolution = stream.resolution || '';
    this.qualityLabelText = qualityLabel(this.qualityActual);

    if (!this.dir) await this._prepareOutput(startNumber);
    this.startNumber = startNumber;
    await this._spawn(startNumber);
    if (!this.startedAt) this.startedAt = new Date();
    this._startWatcher();
    return { ok: true, quality: this.qualityActual, qualityLabel: this.qualityLabelText, dir: this.dir, baseName: this.baseName };
  }

  async _prepareOutput(startNumber) {
    const t = this.task;
    const profile = pickProfile(this.naming, { profileId: t.namingProfileId, platform: t.platform, taskId: t.id });
    this.profile = profile;
    const digits = Number(profile.options?.seqDigits) || 3;
    this.ctx = buildContext({
      task: t, anchorName: t.anchorName, title: t.title, platform: t.platform, platformName: t.platformName,
      roomId: t.roomId, index: startNumber, startAt: new Date(), quality: this.qualityActual,
      resolution: this.resolution, customText: t.customText,
    });
    const info = buildOutputPattern({ profile, ctx: this.ctx, ext: this.ext });
    const absDir = safeJoin(this.settings.recordRoot, info.dir || '');
    await ensureDir(absDir);
    this.dir = absDir;
    this.digits = digits;

    if (this.singleFile) {
      const { name } = renderName(info.baseName.replace(/%0\d+d/, ''), this.ctx, 1, { ...(profile.options || {}), seqDigits: 0 });
      this.baseName = name.replace(/[_\-]+$/, '') || 'record';
      this.filePrefix = this.baseName;
      this.fileSuffix = '';
      this.outputName = `${this.baseName}.${this.ext}`;
    } else {
      this.baseName = info.baseName;
      this.outputName = info.pattern;
      const i = this.baseName.indexOf('%0');
      this.filePrefix = i >= 0 ? this.baseName.slice(0, i) : this.baseName;
      this.fileSuffix = i >= 0 ? this.baseName.slice(i + 4) : '';
    }

    // 目标文件已存在 → 按重名策略改名
    const first = path.join(absDir, this.singleFile
      ? this.outputName
      : this.outputName.replace(/%0\dd/, seqText(startNumber, digits)));
    // 分段模式下同一个基名会派生出多个文件（base001.ts、base002.ts…）：
    // 只判断 base+首个序号 是否存在会漏掉"该基名已有其它分段"的情况，
    // 从而选中已被占用的后缀并把上一场的分段同名覆盖（真实事故：兰知春序 2026-10-09）。
    // 这里改成"目录里任何以该基名开头的文件都算占用"。
    let dirEntries = [];
    try { dirEntries = await fsp.readdir(absDir); } catch { dirEntries = []; }
    const stemOf = (p) => path.basename(p).replace(new RegExp(`\\.${this.ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    const taken = (p) => dirEntries.some((n) => n === path.basename(p) || n.startsWith(stemOf(p)));
    if (taken(first)) {
      const strategy = profile.options?.dupStrategy || 'suffix';
      const unique = reserveName(first, taken, strategy);
      const newBase = path.basename(unique).replace(new RegExp(`\\.${this.ext}$`), '');
      if (this.singleFile) {
        this.baseName = newBase;
        this.outputName = `${newBase}.${this.ext}`;
        this.filePrefix = newBase;
      } else {
        this.baseName = `${newBase.replace(new RegExp(seqText(startNumber, digits).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '')}%0${digits}d`;
        this.outputName = `${this.baseName}.${this.ext}`;
        const i = this.baseName.indexOf('%0');
        this.filePrefix = i >= 0 ? this.baseName.slice(0, i) : this.baseName;
        this.fileSuffix = i >= 0 ? this.baseName.slice(i + 4) : '';
      }
      this.logger.info(`目标文件已存在，按「${strategy}」改名为 ${newBase}`, this._meta());
    }
    this.logger.info(`本次落盘目录：${absDir}`, this._meta());
  }

  async _spawn(startNumber) {
    const t = this.task;
    this.lastStderrError = null; // 每次拉取前清空：避免上一次的错误行误判本次的失败类型
    this._rawStderr = [];        // 同理：只统计本次拉流的 stderr
    const outputPattern = path.join(this.dir, this.outputName);
    const args = this.media.buildRecordArgs({
      streamUrl: this.streamUrl,
      outputPattern,
      container: t.container || 'ts',
      segmentMode: t.segmentMode || 'time',
      segmentMinutes: t.segmentMinutes,
      segmentSizeMB: t.segmentSizeMB,
      startNumber,
      headers: this.headers,
      audioOnly: this.audioOnly,
      // 按平台代理开关：该平台开启且全局 proxy 已配置 → ffmpeg 经 -http_proxy 走代理拉流；否则直连。
      proxy: effectiveProxyForPlatform(this.task.platform, this.settings),
      userAgent: this.settings.userAgent,
      isHttp: /^https?:/i.test(this.streamUrl || ''),
    });
    this.logger.info(`启动 ffmpeg（第 ${startNumber} 段起 · ${this.qualityLabelText} · 流地址 ${this.streamUrl}）`, this._meta());
    this.child = this.media.spawnFfmpeg({ args, onStderr: (line) => this._onStderr(line) });
    this._bytesAtSpawn = await this._bytesOnDisk();
    this.child.on('close', (code, signal) => this._onClose(code, signal));
    this.child.on('error', (e) => {
      // 带上最近一条 ffmpeg stderr（如有）：ENOENT 之外的「启动即失败」，stderr 往往是唯一线索
      const tail = this.lastStderrError ? `｜ffmpeg stderr：${this.lastStderrError}` : '';
      this.logger.error(`ffmpeg 启动失败：${errText(e)}${tail}`, this._meta());
      this.emit('error', { code: 'SPAWN_FAILED', message: e.message, retryable: true });
    });
  }

  _onStderr(line) {
    this._rawStderr.push(String(line).slice(0, 300));
    if (this._rawStderr.length > 8) this._rawStderr.shift();
    if (/error|failed|invalid|refused|timed out|404|403|401/i.test(line)) this.lastStderrError = line;
    if (/Opening|Stream|Duration|Output/i.test(line)) {
      this._stderrTail.push(line);
      if (this._stderrTail.length > 30) this._stderrTail.shift();
    }
  }

  _startWatcher() {
    this._stopWatcher();
    this._timer = setInterval(() => { this._tick().catch(() => {}); }, 1500);
  }

  _stopWatcher() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async _tick() {
    if (!this.dir) return;
    const segs = await this.scanSegments();
    if (!segs.length) return;
    // 只处理「本轮新闭合」的分段：已登记分段的 stat/probe 不必每 1.5s 重做一次，
    // 否则分段越多、tick 里的磁盘调用越多（长场次几百段时每秒数百次 stat）。
    const fresh = segs.slice(0, -1).filter((s) => !this.closed.has(s.index));
    // 已被轮转过去、却是 0 字节的分段：ffmpeg 建了文件没写数据，属于垃圾，清掉（否则永久留在磁盘上）
    await this._dropEmptySegments(fresh);
    for (const s of fresh) {
      const st = await fsp.stat(s.path).catch(() => null);
      if (!st || !st.size) continue;
      this.closed.add(s.index);
      this._cumBase += st.size;
      const durationSec = await this.media.probeDuration(s.path, { ffprobePath: this.settings.ffprobePath });
      // 结束原因：ffmpeg 进程还活着 = 按 segment_time 自然轮转（timeout）；
      // 进程已退出（断流重连前/收尾中）= 被提前收尾（stopped），段长短由断流决定而非设定时长
      const reason = this.child ? 'timeout' : 'stopped';
      this.emit('segment-close', { index: s.index, path: s.path, name: s.name, bytes: st.size, endedAt: nowIso(), durationSec: durationSec || 0, reason });
    }
    const cur = segs[segs.length - 1];
    if (!this.currentSegment || this.currentSegment.path !== cur.path) this._segStartAt = Date.now();
    this.currentSegment = cur;
    this.currentBytes = (await fsp.stat(cur.path).catch(() => ({ size: 0 }))).size;
    this._sampleRate(cur);
    // 详情日志：间隔 ~30s 记一次「从哪个 url 拉流、已写多少/实时速率」，便于核查下载来源与数据量
    this._detailTick++;
    if (this._detailTick % 20 === 1 && (this.currentBytes > 0 || this._rateBits > 0)) {
      const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
      this.logger.info(`${cur.name} 从 ${this.streamUrl || '(未知 URL)'} 拉流，本段已写 ${mb(this.currentBytes)}，累计 ${mb(this._cumBase + this.currentBytes)}，实时 ${Math.round(this._rateBits / 1000)} kb/s`, this._meta());
    }
    if (this.task.segmentMode === 'size' && !this.rotating && !this.stopping && !this.paused) {
      const limit = Math.max(16, Number(this.task.segmentSizeMB) || 2048) * 1024 * 1024;
      if (this.currentBytes >= limit) await this._rotate();
    }
  }

  /* ffmpeg 输出写入本身天然码率不稳，这里按 1.5s 采样「累计已写字节」的增量估算瞬时下行速率 */
  _sampleRate(cur) {
    const now = Date.now();
    const total = this._cumBase + this.currentBytes;
    const idx = cur?.index || 0;
    const ref = this._tickRateRef;
    if (ref && ref.idx === idx && total > ref.bytes && now > ref.t) {
      const dt = (now - ref.t) / 1000;
      if (dt >= 0.8) this._rateBits = ((total - ref.bytes) * 8) / dt;
    }
    this._tickRateRef = { idx, bytes: total, t: now };
  }

  async scanSegments() {
    if (!this.dir) return [];
    const entries = await fsp.readdir(this.dir).catch(() => []);
    const out = [];
    if (this.singleFile) {
      if (entries.includes(this.outputName)) out.push({ index: 1, name: this.outputName, path: path.join(this.dir, this.outputName) });
      return out;
    }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${esc(this.filePrefix)}(\\d+)${esc(this.fileSuffix)}\\.${esc(this.ext)}$`);
    for (const name of entries) {
      const m = re.exec(name);
      if (m) out.push({ index: Number(m[1]), name, path: path.join(this.dir, name) });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /** 当前已落盘字节数（用于判断「这次拉流到底录到没有」） */
  async _bytesOnDisk() {
    let total = 0;
    for (const s of await this.scanSegments()) {
      const st = await fsp.stat(s.path).catch(() => null);
      if (st) total += st.size;
    }
    return total;
  }

  async _rotate() {
    this.rotating = true;
    const segs = await this.scanSegments();
    const lastIndex = segs.length ? segs[segs.length - 1].index : this.startNumber;
    this.logger.info(`分段达到大小上限，轮转到第 ${lastIndex + 1} 段`, this._meta());
    await this._quitGracefully();
    this.rotating = false;
    if (this.stopping || this.paused) return;
    await this._spawn(lastIndex + 1);
  }

  async _quitGracefully(timeoutMs = 8000) {
    const child = this.child;
    if (!child) return true;
    const exited = new Promise((resolve) => { this._exitResolve = resolve; });
    try { child.stdin.write('q'); } catch { /* 可能已退出 */ }
    const done = await Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!done) {
      this.logger.warn('ffmpeg 未在 8 秒内退出，强制结束', this._meta());
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      await Promise.race([exited, sleep(2000)]);
    }
    this.child = null;
    return true;
  }

  _onClose(code, signal) {
    if (this._exitResolve) { this._exitResolve(); this._exitResolve = null; }
    if (this.child) this.child = null;
    if (this.stopping || this.paused || this.rotating) return;
    this._handleUnexpectedExit(code, signal).catch((e) => {
      this.logger.error(`重连流程异常：${errText(e)}`, this._meta());
    });
  }

  async _handleUnexpectedExit(code, signal) {
    const tail = this.lastStderrError || this._stderrTail.slice(-2).join(' | ');
    const blocked = isPullBlocked(tail);
    // 主播已下播导致的流中断：正常收尾（reason=offline），不进入断流重连、不报"录制异常结束"。
    // 403/401/429 是平台侧明确拒绝（风控/限流），不是下播：跳过探活，避免风控期间再加接口压力。
    if (!blocked && this.probeOffline) {
      try {
        const offline = await this.probeOffline();
        if (offline === true) {
          this.logger.info(`检测到主播已下播，正常结束录制（ffmpeg exit=${code}）`, this._meta());
          this.reconnectAttempt = 0;
          await this._finalize('offline');
          return;
        }
      } catch { /* 探活失败按仍在直播处理，走重连 */ }
    }
    const max = Number(this.task.reconnectMax ?? this.settings.reconnectMax) || 5;
    const grew = Math.max(0, (await this._bytesOnDisk()) - (this._bytesAtSpawn || 0));
    const plan = planReconnect({ blocked, attempt: this.reconnectAttempt, max, bytesSinceSpawn: grew });
    this.reconnectAttempt = plan.attempt;
    if (plan.stop) {
      this.emit('error', {
        code: blocked ? 'PULL_BLOCKED' : 'RECONNECT_EXCEEDED',
        message: `${blocked ? '拉流持续被平台拒绝（疑似风控/限流）' : `连续 ${max} 次断流且每次都没录到数据`}，已停止重连（ffmpeg exit=${code}${signal ? ` signal=${signal}` : ''}）${tail ? `：${tail}` : ''}`,
        retryable: false,
      });
      await this._finalize('error');
      return;
    }
    const delay = plan.delay;
    this.emit('reconnect', { attempt: this.reconnectAttempt, delayMs: delay, error: tail || `ffmpeg exit=${code}`, blocked, productive: plan.productive });
    const raw = this._rawStderr.slice(-2).join(' | ');
    const why = plan.productive
      ? `本段已录 ${formatBytes(grew)}，重连计数归零`
      : `本次未录到数据（连续第 ${this.reconnectAttempt}/${max} 次）`;
    this.logger.warn(
      `${blocked ? '拉流被平台拒绝（疑似风控/限流）' : '断流'}（ffmpeg exit=${code}${signal ? ` signal=${signal}` : ''}）｜${why}，${Math.round(delay / 1000)} 秒后重连${raw ? `｜stderr：${raw}` : ''}`,
      this._meta(),
    );
    await sleep(delay);
    if (this.stopping || this.paused) return;
    try {
      // 403 场景复用当前地址：重新解析只会增加接口压力，且地址本身有效（实测同一地址可连续拉数小时）
      if (!blocked) {
        const stream = await this.resolveStream(
          { ...this.task, qualityFallback: this.settings.qualityFallback },
          { settings: this.settings, logger: this.logger },
        );
        if (stream?.url) {
          const clean = this.media.sanitizeStreamUrl(stream.url);
          // 重连重新解析出的地址必须可落地到 ffmpeg：净化后仍为合法 http(s) 才采用，否则复用上一次
          // 已知可用地址。抖音重连偶发拿到带换行/空白或 HLS↔FLV 切换的脏地址，直接喂给 ffmpeg 会报
          // 5: Invalid argument 且永不落盘——这是本次崩溃根因；复用首跑成功过的地址即可破局。
          if (/^https?:\/\//i.test(clean)) {
            this.streamUrl = clean;
            this.headers = this.media.sanitizeHeaders(stream.headers || this.headers);
          } else {
            this.logger.warn(`重连解析出的流地址不可用（${JSON.stringify(stream.url)}），复用上一次可用地址继续重连`, this._meta());
          }
        }
      }
      this.logger.info(`重连成功，继续拉流（第 ${this.reconnectAttempt}/${max} 次 · 流地址 ${this.streamUrl || '(未知 URL)'}）`, this._meta());
      const segs = await this.scanSegments();
      const next = segs.length ? segs[segs.length - 1].index + 1 : this.startNumber;
      await this._spawn(next);
    } catch (e) {
      this.logger.warn(`重连解析失败：${errText(e)}`, this._meta());
      await this._handleUnexpectedExit(code, signal);
    }
  }

  // ---------- 停止 / 暂停 / 恢复 ----------
  async stop(reason = 'user') {
    this.stopping = true;
    this._stopWatcher();
    await this._quitGracefully();
    return this._finalize(reason);
  }

  async pause() {
    if (this.paused) return { ok: true, already: true };
    this.paused = true;
    this._stopWatcher();
    await this._quitGracefully();
    const segs = await this.scanSegments();
    await this._dropEmptySegments(segs); // 暂停时同样清掉 0 字节残渣
    return { ok: true, lastIndex: segs.length ? segs[segs.length - 1].index : 0 };
  }

  /** 删除 0 字节分段残渣（ffmpeg 在轮转/停止瞬间创建但没写入数据的空文件） */
  async _dropEmptySegments(segs) {
    const dropped = [];
    for (const s of segs) {
      const st = await fsp.stat(s.path).catch(() => null);
      if (st && st.size === 0) {
        await fsp.rm(s.path, { force: true }).catch(() => {});
        dropped.push(s.name);
      }
    }
    if (dropped.length) this.logger.warn(`清理 ${dropped.length} 个 0 字节空分段：${dropped.join(', ')}`, this._meta());
    return dropped;
  }

  async resume() {
    this.paused = false;
    this.stopping = false;
    this.reconnectAttempt = 0;
    const segs = await this.scanSegments();
    const next = segs.length ? segs[segs.length - 1].index + 1 : this.startNumber;
    if (!this.dir) await this._prepareOutput(next);
    await this._spawn(next);
    this._startWatcher();
    return { ok: true, startNumber: next };
  }

  async _finalize(reason) {
    this._stopWatcher();
    const segs = await this.scanSegments();
    await this._dropEmptySegments(segs); // 进程已退出：任何 0 字节分段都是垃圾
    const list = [];
    for (const s of segs) {
      const st = await fsp.stat(s.path).catch(() => null);
      if (!st || !st.size) continue;
      const durationSec = await this.media.probeDuration(s.path, { ffprobePath: this.settings.ffprobePath });
      const item = { index: s.index, path: s.path, name: s.name, bytes: st.size, endedAt: nowIso(), durationSec: durationSec || 0, reason: reason || 'stopped' };
      if (!this.closed.has(s.index)) { this.closed.add(s.index); this.emit('segment-close', item); }
      list.push(item);
    }
    const bytes = list.reduce((a, b) => a + b.bytes, 0);
    const durationSec = list.reduce((a, b) => a + (b.durationSec || 0), 0);
    const payload = { reason, segments: list, bytes, durationSec, dir: this.dir, baseName: this.baseName };
    this.emit('finished', payload);
    return payload;
  }

  getStats() {
    return {
      bytes: this.currentBytes || 0,
      elapsedSec: this.startedAt ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      currentSegElapsedSec: this._segStartAt ? Math.round((Date.now() - this._segStartAt) / 1000) : 0,
      currentFile: this.currentSegment?.path || null,
      currentName: this.currentSegment?.name || null,
      segmentIndex: this.currentSegment?.index || 0,
      reconnects: this.reconnectAttempt,
      speed: this._rateBits || 0,
      dir: this.dir,
      baseName: this.baseName,
      quality: this.qualityActual,
      qualityLabel: this.qualityLabelText,
      paused: this.paused,
    };
  }
}

export { BACKOFF };
