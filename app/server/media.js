// ffmpeg / ffprobe 封装与参数构造（契约 §5）
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/* ffmpeg/ffprobe 子进程的干净环境：剥离代理环境变量。
 *
 * 为什么必须剥：ffmpeg 的 http 协议会读 HTTP_PROXY / http_proxy 环境变量（FFmpeg 8.x 实测对
 * http 与 https 输入都生效，但不读 HTTPS_PROXY / ALL_PROXY）。容器若注入了 HTTP_PROXY，
 * 所有 ffmpeg 拉流都会走代理——包括用户在页面上「关掉代理」的平台，开关形同失效。
 *
 * 录制/回放只认显式 -http_proxy 参数（由 buildRecordArgs 按 platformUseProxy 开关注入），
 * 所以这里剥掉环境变量，让「按平台开关」成为唯一权威。代价是有意放弃「容器级全局兜底代理」。
 * 每次 spawn 现算（复制几十个键约 10µs，相对 spawn 的毫秒级可忽略）：不做缓存，既避免
 * 运行期改环境后拿到过期快照，也让这段逻辑可以被测试直接验证。 */
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
export function ffmpegEnv() {
  const env = { ...process.env };
  for (const k of PROXY_ENV_KEYS) delete env[k];
  return env;
}

const SEG_FORMAT = { ts: 'mpegts', flv: 'flv', mkv: 'matroska', mp4: 'mp4' };
export const extOfContainer = (c) => (c === 'mkv' ? 'mkv' : c === 'flv' ? 'flv' : 'ts');

export function headerArgs(headers = {}) {
  const lines = Object.entries(headers || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length ? ['-headers', `${lines.join('\r\n')}\r\n`] : [];
}

/** 净化流地址：去 NUL/回车/换行/制表与首尾空白。抖音重连重新解析出的地址偶带不可见字符，
 *  直接喂给 ffmpeg 会报 5: Invalid argument 且永不落盘（本次崩溃根因之一）。 */
export function sanitizeStreamUrl(url) {
  if (!url) return '';
  return String(url).replace(/\u0000/g, '').replace(/[\r\n\t]+/g, '').trim();
}

/** 净化请求头：每行 key/value 去掉回车/换行与首尾空白，丢弃空值，避免 -headers 帧被破坏。 */
export function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null || v === '') continue;
    const kk = String(k).replace(/[\r\n]+/g, ' ').trim();
    const vv = String(v).replace(/[\u0000\r\n]+/g, '').trim();
    if (!kk || !vv) continue;
    out[kk] = vv;
  }
  return out;
}

/** 录制参数（TS 分段、关键帧对齐、直接产出最终文件名）；segmentMinutes 单位为秒 */
export function buildRecordArgs({
  streamUrl, outputPattern, container = 'ts', segmentMode = 'time', segmentMinutes = 3600,
  segmentSizeMB = 2048, startNumber = 1, headers = {},
  audioOnly = false, proxy = '', userAgent = '', isHttp = true,
}) {
  const args = ['-hide_banner', '-loglevel', 'info', '-nostats'];
  /* 直播流加固（对齐成熟项目 StreamCap 的 ffmpeg 参数集，逐项说明见下）
     本次修复（抖音断流重连 5: Invalid argument）：
     - 原代码把 -reconnect 1 当作 http 选项硬塞给所有 http(s) 输入；抖音重连时流地址类型常
       在 HLS(.m3u8) 与 FLV 之间切换，-reconnect 1 在 HLS 输入下会触发 Invalid argument，而
       初始 FLV 录制正常——这正是「首跑 9 段/8GB 正常、重连段永不落盘」的根因。
     - StreamCap 的做法：ffmpeg 层只置 reconnect_streamed/at_eof（辅以 reconnect_delay_max），
       真正的断流重连由上层「重新解析 + 重启子进程」负责；并显式 protocol_whitelist 放行协议，
       且对 URL/header 做了净化兜底。这里照此实现。 */
  args.push(
    '-rw_timeout', '15000000',   // 15s 读超时：连接卡死不发数据时 ffmpeg 会退出走重连，绝不无限假挂
    '-analyzeduration', '20000000',
    '-probesize', '10000000',
    '-fflags', '+discardcorrupt+igndts', // 丢弃损坏包 + 忽略不连续 DTS：时间戳混乱时保分段时长准确
    '-protocol_whitelist', 'rtmp,crypto,file,http,https,tcp,tls,udp,rtp,httpproxy', // 显式放行协议（含 httpproxy），避免默认白名单缺失导致 Invalid argument
  );
  // 断流重连（ffmpeg 层）：注意 -reconnect / -reconnect_streamed 是「布尔选项」，
  // 必须显式带值 1——否则 ffmpeg 8 会把下一个参数当成它的值
  // （`-reconnect_streamed` 后紧跟 reconnect_at_eof 时，ffmpeg 会把后者当作前者的取值 →
  //  "Error setting option reconnect_streamed to value ..." → Invalid argument，0 字节、重连 5 次全失败）。
  // 不启用 reconnect_at_eof：直播真正结束时应让 ffmpeg 退出，交给 recorder 重新解析 / 判定下播；
  // 否则 ffmpeg 会在进程内无限重连，UI 一直显示「录制中」却永远 0 字节。
  if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '60');
  args.push('-re'); // 以流天然速率读取（直播即实时），与各成熟录制器一致
  if (proxy) args.push('-http_proxy', proxy);
  // 默认带一个移动端 UA：抖音/CDN 对空 UA 偶发拒绝；未配置自定义 UA 时回落到该值（对齐 StreamCap 固定 UA 做法）
  const ua = userAgent || 'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36';
  args.push('-user_agent', ua);
  args.push(...headerArgs(sanitizeHeaders(headers)));
  const safeUrl = sanitizeStreamUrl(streamUrl);
  args.push('-i', safeUrl);

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
    env: ffmpegEnv(), // 剥掉代理环境变量，代理只由 -http_proxy 参数决定（见 ffmpegEnv 注释）
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
      child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: ffmpegEnv() });
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
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: ffmpegEnv() });
    } catch (e) { resolve(null); return; }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve(null); } }, 8000);
    const finish = (buf) => { if (!done) { done = true; clearTimeout(timer); resolve(buf); } };
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', () => { /* 必须消费，否则 stderr 塞满会卡住 */ });
    child.on('error', () => finish(null));
    child.on('close', () => {
      // 不苛求 exit=0：正在录制的分段 / 末尾半包会让 ffmpeg 非零退出，但首帧通常已写出。
      // 只要有数据且是 JPEG（SOI = FF D8）即视为成功，避免「录制中的视频没有首帧图」。
      const buf = chunks.length ? Buffer.concat(chunks) : null;
      const isJpeg = buf && buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
      finish(isJpeg ? buf : null);
    });
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
    try { child = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: ffmpegEnv() }); }
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
