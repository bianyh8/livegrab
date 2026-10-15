// 假 ffmpeg：在没有真实 ffmpeg 的环境下跑通录制/轮转/停止/转封装/合并/回放链路
// 用法由 test/fake-media.mjs 以 `node fake-ffmpeg.mjs <真实 ffmpeg 参数>` 方式调用
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stdout.write('ffmpeg version fake-7.0-livegrab Copyright (c) 2000-2025 the FFmpeg developers\n');
  process.exit(0);
}
if (args.includes('-print_format')) process.exit(1); // ffprobe 不应走这里

const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const has = (v) => args.includes(v);
const output = args[args.length - 1];
const input = val('-i');
const isSegment = has('-f') && val('-f') === 'segment';
const isConcat = has('-f') && val('-f') === 'concat';
const toStdout = output === 'pipe:1' || has('pipe:1');

const SEG_MS = Number(process.env.FAKE_SEGMENT_MS || 250);
const TOTAL = Number(process.env.FAKE_SEGMENTS_TOTAL || 3);
const MB = Number(process.env.FAKE_SEGMENT_MB || 0.2);

function payload(n) {
  return Buffer.alloc(Math.round(MB * 1024 * 1024), 0x47 + (n % 8));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function record() {
  // 模拟平台侧拒绝拉流（FAKE_FAIL_HTTP=403/401/429）：立即以真实 ffmpeg 的报错格式退出，
  // 用于验证「拉流被拒 → 长冷却重试」的重连策略（仅影响录制路径，不影响转封装/回放）
  const failHttp = process.env.FAKE_FAIL_HTTP;
  if (failHttp) {
    const msg = { '403': 'Server returned 403 Forbidden (access denied)', '401': 'Server returned 401 Unauthorized', '429': 'Server returned 429 Too Many Requests' }[failHttp] || `Server returned ${failHttp}`;
    process.stderr.write(`[http @ 0x0055d3e2a1b2c0] ${msg}\n`);
    process.exit(1);
  }
  const startNumber = Number(val('-segment_start_number') || 1);
  const segTime = Number(val('-segment_time') || 3600);
  const listPath = val('-segment_list');
  const digits = (/%0(\d)d/.exec(output) || [])[1] || '3';
  const total = segTime <= 2 ? Math.max(TOTAL, 2) : TOTAL; // 小分段便于测试
  const lines = [];
  let simTime = 0;
  for (let i = 0; i < total; i++) {
    const idx = startNumber + i;
    const file = output.replace(new RegExp(`%0${digits}d`), String(idx).padStart(Number(digits), '0'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload(idx));
    await sleep(SEG_MS);
    simTime += segTime <= 2 ? segTime : 1;
    lines.push(`${file},${(simTime - 1).toFixed(6)},${simTime.toFixed(6)}`);
    if (listPath) fs.writeFileSync(listPath, `${lines.join('\n')}\n`);
  }
  process.stdout.write('frame= 100 fps=25 q=-1.0 size=  1024kB time=00:00:04.00 bitrate=2000.0kbits/s\n');
  // 保持运行，等待 stdin 的 q（模拟真实录制中）
  await new Promise((resolve) => {
    process.stdin.on('data', (d) => {
      if (String(d).includes('q')) resolve();
    });
    process.stdin.on('end', resolve);
    setTimeout(resolve, Number(process.env.FAKE_MAX_MS || 60000));
  });
  process.exit(0);
}

async function copyThrough() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (isConcat) {
    const listFile = input;
    const targets = fs.readFileSync(listFile, 'utf8')
      .split('\n')
      .map((l) => /^file '(.*)'$/.exec(l.trim())?.[1])
      .filter(Boolean);
    const buf = Buffer.concat(targets.map((t) => fs.readFileSync(t)));
    fs.writeFileSync(output, buf);
  } else {
    fs.writeFileSync(output, fs.readFileSync(input));
  }
  process.exit(0);
}

async function playPipe() {
  // 模拟 fMP4 渐进流：写几帧数据到 stdout
  for (let i = 0; i < 4; i++) {
    process.stdout.write(Buffer.alloc(64 * 1024, 0x30 + i));
    await sleep(60);
  }
  process.exit(0);
}

if (toStdout) playPipe();
else if (isSegment) record();
else copyThrough();
