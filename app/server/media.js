// ffmpeg / ffprobe 封装与参数构造（契约 §5）
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const SEG_FORMAT = { ts: 'mpegts', flv: 'flv', mkv: 'matroska', mp4: 'mp4' };
export const extOfContainer = (c) => (c === 'mkv' ? 'mkv' : c === 'flv' ? 'flv' : 'ts');

export function headerArgs(headers = {}) {
  const lines = Object.entries(headers || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? ['-headers', `${lines.join('\r\n')}\r\n`] : [];
}

/** 录制参数（TS 分段、关键帧对齐、直接产出最终文件名）；segmentMinutes 单位为秒 */
export function buildRecordArgs({
  streamUrl, outputPattern, container = 'ts', segmentMode = 'time', segmentMinutes = 3600,
  segmentSizeMB = 2048, segmentListPath = null, startNumber = 1, headers = {},
  audioOnly = false, proxy = '', userAgent = '', isHttp = true,
}) {
  const args = ['-hide_banner', '-loglevel', 'info', '-nostats'];
  /* 直播流加固（对齐成熟项目 StreamCap 的 ffmpeg 参数集，逐项说明见下） */
  args.push(
    '-rw_timeout', '15000000',   // 15s 读超时：连接卡死不发数据时 ffmpeg 会退出走重连，绝不无限假挂
    '-analyzeduration', '20000000',
    '-probesize', '10000000',
    '-fflags', '+discardcorrupt+igndts', // 丢弃损坏包 + 忽略不连续 DTS：时间戳混乱时保分段时长准确
  );
  if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '-reconnect_delay_max', '5');
  if (proxy) args.push('-http_proxy', proxy);
  if (userAgent) args.push('-user_agent', userAgent);
  args.push(...headerArgs(headers));
  args.push('-i', streamUrl);

  if (audioOnly) args.push('-vn', '-c:a', 'aac', '-b:a', '128k');
  else args.push('-c', 'copy');

  if (segmentMode === 'none') {
    args.push('-y', outputPattern);
    return args;
  }
  const seconds = segmentMode === 'size'
    ? Math.max(30, Math.round((Number(segmentSizeMB) || 2048) * 8 * 1024 / 8000)) // 以 8Mbps 估算时长上限
    : Math.max(10, Math.round(Number(segmentMinutes) || 3600)); // segmentMinutes 已是秒
  args.push(
    '-f', 'segment',
    '-segment_time', String(seconds),
    '-segment_format', SEG_FORMAT[container] || 'mpegts',
    '-reset_timestamps', '1',
    '-segment_start_number', String(Math.max(1, Number(startNumber) || 1)),
    /* 输出侧时间戳与缓冲加固：负 DTS / 33 位 PTS 回绕（长直播）都会打乱轮转判断；
       flush_packets 保证每个分段及时落盘；sn/dn 丢掉字幕与数据流（否则 -c copy 偶发失败）。 */
    '-correct_ts_overflow', '1',
    '-avoid_negative_ts', '1',
    '-flush_packets', '1',
    '-max_muxing_queue_size', '1024',
    '-sn', '-dn',
  );
  if ((SEG_FORMAT[container] || 'mpegts') === 'mpegts') {
    // 每个分段重发 PAT/PMT 头，播放器/工具单独打开任一分段都能立即解码
    args.push('-mpegts_flags', '+resend_headers', '-muxdelay', '0', '-muxpreload', '0');
  }
  if (segmentListPath) args.push('-segment_list', segmentListPath, '-segment_list_type', 'csv');
  args.push('-y', outputPattern);
  return args;
}

export function buildRemuxArgs({ input, output, audioOnly = false }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y', '-i', input];
  if (audioOnly) args.push('-vn', '-c:a', 'copy');
  else args.push('-c', 'copy', '-movflags', '+faststart');
  args.push(output);
  return args;
}

export function buildMergeArgs({ listFile, output, audioOnly = false }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-y', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (audioOnly) args.push('-vn', '-c:a', 'copy');
  else args.push('-c', 'copy', '-movflags', '+faststart');
  args.push(output);
  return args;
}

/** TS/FLV/MKV → 渐进式 fMP4（stdout 管道给 <video>，浏览器无需 hls.js） */
export function buildPlayArgs({ input, audioOnly = false, fallbackAudio = false }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-fflags', '+genpts', '-i', input];
  if (audioOnly) args.push('-vn', '-c:a', 'aac', '-b:a', '160k');
  else if (fallbackAudio) args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k');
  else args.push('-c', 'copy');
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

export function buildConcatList(inputs) {
  return `${inputs.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join('\n')}\n`;
}

export function spawnFfmpeg({ ffmpegPath = FFMPEG, args, onStderr, onStdout, stdio } = {}) {
  const child = spawn(ffmpegPath, args, {
    stdio: stdio || ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const dec = new StringDecoder('utf8');
  let buf = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const text = dec.write(chunk);
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const l of lines) if (l.trim() && onStderr) onStderr(l.trim());
    });
  }
  if (child.stdout && onStdout) child.stdout.on('data', onStdout);
  return child;
}

export function runFfmpeg({ ffmpegPath = FFMPEG, args, onStderr, onStdout } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFfmpeg({ ffmpegPath, args, onStderr, onStdout });
    } catch (e) {
      resolve({ code: -1, signal: null, error: e });
      return;
    }
    child.on('error', (e) => resolve({ code: -1, signal: null, error: e }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

export function runFfprobe({ ffprobePath = FFPROBE, args } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { resolve({ code: -1, out: '', error: e }); return; }
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, out, error: e }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** 提取输入视频第 at 秒的一帧为 JPEG buffer（任务列表缩略图用）；失败/纯音频/ffmpeg 缺失返回 null */
export function grabFrame({ input, width = 320, at = 0, ffmpegPath = FFMPEG } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let child;
    try {
      child = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostats',
        '-ss', String(Number(at) || 0), '-i', input,
        '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { resolve(null); return; }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve(null); } }, 8000);
    const finish = (buf) => { if (!done) { done = true; clearTimeout(timer); resolve(buf); } };
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', () => { /* 必须消费，否则 stderr 塞满会卡住 */ });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
  });
}

export async function probeJson(file, { ffprobePath = FFPROBE } = {}) {
  const { code, out } = await runFfprobe({
    ffprobePath,
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
  });
  if (code !== 0 || !out) return null;
  try {
    const j = JSON.parse(out);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    const durationSec = Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
    return {
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      bytes: Number(j.format?.size) || 0,
      width: v?.width || 0,
      height: v?.height || 0,
      vcodec: v?.codec_name || '',
      acodec: a?.codec_name || '',
      hasVideo: !!v,
      bitRate: Number(j.format?.bit_rate) || 0,
    };
  } catch { return null; }
}

export async function ffmpegVersion(ffmpegPath = FFMPEG) {
  const { code, out } = await new Promise((resolve) => {
    let o = '';
    let child;
    try { child = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: '', error: e }); return; }
    child.stdout.on('data', (d) => { o += d.toString('utf8'); });
    child.on('error', () => resolve({ code: -1, out: o }));
    child.on('close', (c) => resolve({ code: c, out: o }));
  });
  if (code !== 0 || !out) return { available: false, version: null };
  return { available: true, version: out.split('\n')[0].trim() };
}

export async function probeDuration(file, opts) {
  const j = await probeJson(file, opts);
  return j?.durationSec || 0;
}

/** 解析 ffmpeg segment_list（CSV: path,start,end） */
export function parseSegmentList(csvText) {
  const out = [];
  for (const line of String(csvText || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    out.push({ path: parts[0], start: Number(parts[1]), end: Number(parts[2]) });
  }
  return out;
}
