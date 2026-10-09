// 真实 ffmpeg 端到端验证：本地生成直播流 → LiveGrab 真实录制 → 轮转/暂停/恢复/收尾/转封装/合并/回放
// 用法：node app/test/e2e-ffmpeg.mjs        可用 FFMPEG_PATH / FFPROBE_PATH 指定二进制；找不到则跳过
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBinary(envName, names) {
  const fromEnv = process.env[envName];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const n of names) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8' });
    if (r.status === 0) { const p = (r.stdout || '').split(/\r?\n/)[0].trim(); if (p && fs.existsSync(p)) return p; }
  }
  for (const p of ['C:\\Program Files\\EVCapture\\ffmpeg.exe', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const FFMPEG = findBinary('FFMPEG_PATH', ['ffmpeg']);
const FFPROBE = (() => {
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
  if (FFMPEG) {
    const guess = path.join(path.dirname(FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(guess)) return guess;
  }
  return findBinary('FFPROBE_PATH', ['ffprobe']);
})();
if (!FFMPEG) {
  console.log('跳过真实 ffmpeg 端到端：未找到 ffmpeg（可设置 FFMPEG_PATH / FFPROBE_PATH）。');
  process.exit(0);
}

let bad = 0;
const line = (s) => console.log(s);
const check = (cond, label, extra = '') => { if (!cond) bad++; line(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`); };
async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

const TMP = path.join(os.tmpdir(), `livegrab-ffmpeg-${Date.now()}`);
const CFG = path.join(TMP, 'config');
const REC = path.join(TMP, 'record');
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(REC, { recursive: true });
const PORT = 18091;
const STREAM_PORT = 18092;
const BASE = `http://127.0.0.1:${PORT}`;
line(`真实 ffmpeg: ${FFMPEG}\n真实 ffprobe: ${FFPROBE}\n临时目录: ${TMP}\n`);

/* ---------- 1) 本地"直播流"服务：真实 ffmpeg 现编现推 ---------- */
const GEN = ({ w, h, rate, bitrate, tone }) => [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${rate}`,
  '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=44100`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', String(rate * 2), '-pix_fmt', 'yuv420p',
  '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', '16M',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
  '-f', 'mpegts', 'pipe:1',
];
const STREAMS = {
  '/live1.ts': { w: 854, h: 480, rate: 25, bitrate: '1200k', tone: 440 },
  '/live2.ts': { w: 1280, h: 720, rate: 30, bitrate: '8M', tone: 660 },   // 高码率：用于"按大小"轮转
  '/live3.ts': { w: 640, h: 360, rate: 25, bitrate: '800k', tone: 880 },
};
const producers = new Set();
const streamSrv = http.createServer((req, res) => {
  const cfg = STREAMS[req.url.split('?')[0]];
  if (!cfg) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
  const gen = spawn(FFMPEG, GEN(cfg), { stdio: ['ignore', 'pipe', 'pipe'] });
  producers.add(gen);
  gen.stdout.pipe(res);
  gen.stderr.on('data', (d) => { const s = String(d).trim(); if (s && !/testsrc2|sine/.test(s)) line(`   [生成器 ${req.url}] ${s.slice(0, 160)}`); });
  const stop = () => { producers.delete(gen); try { gen.kill('SIGKILL'); } catch { /* ignore */ } };
  res.on('close', stop);
  req.on('close', stop);
  gen.on('exit', () => producers.delete(gen));
});
await new Promise((r) => streamSrv.listen(STREAM_PORT, '127.0.0.1', r));
line(`1) 本地直播流服务 http://127.0.0.1:${STREAM_PORT}/live{1,2,3}.ts（真实 ffmpeg 现编现推）`);

/* ---------- 2) 启动 LiveGrab 服务（指向真实 ffmpeg） ---------- */
const seedStore = spawnSync(NODE, ['-e', `import(process.argv[1]).then(async m=>{const s=await new m.Store(process.argv[2]).init();await s.updateSettings({security:{trustLan:true},maxConcurrency:2,platformCaps:{direct:2},defaultSegmentMinutes:1,diskLimitGB:1,remuxToMp4:true,autoMerge:false,keepSource:true});console.log('ok')})`, 'file:///' + path.join(APP, 'server', 'store.js').replace(/\\/g, '/'), CFG], { encoding: 'utf8' });
line(`2) 预置设置: ${(seedStore.stdout || '').trim()}${seedStore.stderr ? ' ERR:' + seedStore.stderr : ''}`);
const env = { ...process.env, PORT: String(PORT), CONFIG_DIR: CFG, RECORD_ROOT: REC, FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE || 'ffprobe', TZ: 'Asia/Shanghai', LIVEGRAB_VERSION: '0.1.0' };
const srv = spawn(NODE, [path.join(APP, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += `[err] ${d}`; });
const up = await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, 30000);
if (!up) { line('服务启动失败:\n' + srvLog); process.exit(1); }
const health = (await (await fetch(`${BASE}/api/health`)).json()).data;
check(health.ffmpeg.available === true, '真实 ffmpeg 被识别为可用', `version=${health.ffmpeg.version}`);
const jpost = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json());
const jget = async (p) => (await (await fetch(BASE + p)).json());
const jput = async (p, body) => (await (await fetch(BASE + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json());
const status = async () => (await jget('/api/status')).data;
const tasksAll = async () => ((await jget('/api/tasks')).data.items || []);
const filesAll = async (q = '') => (await jget('/api/files' + q)).data;

/* ---------- 3) 建 3 个直链任务（1 路时间分段 / 1 路大小分段 / 1 路排队） ---------- */
const mk = async (name, stream, extra) => (await jpost('/api/tasks', { platform: 'direct', url: `http://127.0.0.1:${STREAM_PORT}${stream}`, anchorName: name, overrides: { quality: 'origin' }, ...extra })).data;

// 3a) 磁盘保护：阈值高于剩余空间时拒绝开录（本机剩余 <20GB，正好可验证）
const tD = await mk('磁盘保护测试', '/live3.ts', {});
await jput('/api/settings', { diskLimitGB: 99999 });
await jpost(`/api/tasks/${tD.id}/start`);
await sleep(1500);
const dTask = (await tasksAll()).find((t) => t.id === tD.id);
check(dTask?.status === 'error' && /磁盘/.test(dTask.lastError || dTask.statusMessage || ''), '磁盘低于阈值时拒绝开录并说明原因', dTask?.lastError || dTask?.statusMessage);
await jput('/api/settings', { diskLimitGB: 1 });
await fetch(`${BASE}/api/tasks/${tD.id}`, { method: 'DELETE' });
const tA = await mk('真实录制A', '/live1.ts', { segmentMode: 'time', segmentMinutes: 1 });
const tB = await mk('真实录制B', '/live2.ts', { segmentMode: 'size', segmentSizeMB: 16 });
const tC = await mk('真实录制C', '/live3.ts', { segmentMode: 'time', segmentMinutes: 1 });
line(`3) 建任务: ${[tA, tB, tC].map((t) => `${t.anchorName}/${t.segmentMode}/${t.quality}`).join(' · ')}`);
check(!!tA.id && !!tB.id && !!tC.id, '三个直链任务创建成功');
const starts = [];
for (const t of [tA, tB, tC]) starts.push(await jpost(`/api/tasks/${t.id}/start`));
line(`   启动返回: ${starts.map((s) => (s.ok ? (s.data?.result?.queued ? 'queued' : 'started') : `ERR:${s.error?.code}`)).join(' / ')}`);
await sleep(3000);
let st = await status();
if (!st.stats.activeCount) {
  line('   [诊断] 任务状态: ' + st.tasks.map((t) => `${t.anchorName}=${t.status}${t.lastError ? ' err=' + t.lastError : ''}${t.statusMessage ? ' msg=' + t.statusMessage : ''}`).join(' | '));
  line('   [诊断] 服务日志: ' + srvLog.split('\n').filter((l) => /错误|失败|ffmpeg|录制/.test(l)).slice(-8).join(' \\n '));
}
const byId = (id) => st.tasks.find((t) => t.id === id);
const recById = (id) => st.recording.find((t) => t.id === id);
check(st.stats.activeCount === 2, '并发调度：2 路真实录制同时运行（maxConcurrency=2）', `active=${st.stats.activeCount}`);
check(byId(tC.id).status === 'queued' && /上限/.test(byId(tC.id).queueReason || ''), '第 3 路按并发上限排队并写明原因', byId(tC.id).queueReason);
check((recById(tA.id)?.live?.bytes || 0) > 0 && (recById(tB.id)?.live?.bytes || 0) > 0, '两路都在真实产出数据（/api/status.recording.live）', `A=${recById(tA.id)?.live?.bytes}B B=${recById(tB.id)?.live?.bytes}B`);
check(Number(recById(tA.id)?.live?.segmentIndex || 0) >= 1 && Number(recById(tA.id)?.live?.elapsedSec || 0) > 0, '总览实时进度字段有值（segmentIndex/elapsedSec，前端依赖）', `段=${recById(tA.id)?.live?.segmentIndex} 时长=${Math.round(recById(tA.id)?.live?.elapsedSec || 0)}s`);

/* ---------- 4) 真实分段轮转 + 命名规则落盘 ---------- */
const sessionOf = async (taskId) => {
  const fs2 = await filesAll();
  return (fs2.items || []).find((s) => s.taskId === taskId) || null;
};
const rotated = await waitFor(async () => {
  const s = await sessionOf(tA.id);
  return s && s.segments.length >= 2 ? s : null;
}, 60000);
check(!!rotated, 'D5 真实 -segment_time 60 完成轮转（≥2 段）', rotated ? `${rotated.segments.length} 段` : '超时');
if (rotated) {
  const seg = rotated.segments[0];
  const abs = seg.path || path.join(REC, seg.relPath || '');
  const onDisk = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
  check(onDisk > 10000, '分段文件真实落盘且非空', `${path.basename(abs)} ${onDisk} 字节`);
  check(seg.bytes > 10000 && Math.abs(seg.bytes - onDisk) < 8192, '入库字节与磁盘一致', `${seg.bytes} vs ${onDisk}`);
  check(/(direct|直链)/.test(rotated.relDir || rotated.dir || ''), 'D9 目录结构含平台层', rotated.relDir || rotated.dir);
  check(/真实录制A/.test(abs), 'D9 文件名含主播名（命名规则生效）', path.basename(abs));
  check(/_001\.ts$/.test(path.basename(abs)) || /_001\b/.test(path.basename(abs)), 'D9 分段序号从 001 开始', path.basename(abs));
  check((seg.durationSec || 0) > 0, 'ffprobe 读出分段真实时长', `${seg.durationSec}s`);
}
const rotatedB = await waitFor(async () => {
  const s = await sessionOf(tB.id);
  return s && s.segments.length >= 2 ? s : null;
}, 90000);
check(!!rotatedB, '按大小轮转（真实 16MB 门槛，轮询触发）', rotatedB ? `${rotatedB.segments.length} 段` : '超时');

/* ---------- 5) 暂停 → 释放并发 → 排队任务开录 ---------- */
await jpost(`/api/tasks/${tA.id}/pause`);
await sleep(1500);
let aTask = (await tasksAll()).find((t) => t.id === tA.id);
check(aTask.status === 'paused', 'D4 暂停后任务状态为 paused');
const cStarted = await waitFor(async () => {
  const s = await status();
  const c = s.tasks.find((t) => t.id === tC.id);
  return c.status === 'recording' ? c : null;
}, 30000);
check(!!cStarted, 'D4 暂停释放并发后，排队任务自动开录');
const aSession = await sessionOf(tA.id);
check(aSession && aSession.segments.length >= 2, 'D4 暂停时当前分段已收尾入库', aSession ? `${aSession.segments.length} 段` : '无场次');
const maxIdxBefore = Math.max(...(aSession?.segments || [{ segmentIndex: 0 }]).map((s) => s.segmentIndex || 0));

/* ---------- 6) 停止 B → 优雅收尾 → 自动转封装 MP4（D5） ---------- */
await jpost(`/api/tasks/${tB.id}/stop`);
const bDone = await waitFor(async () => {
  const s = await sessionOf(tB.id);
  if (!s || s.status === 'recording') return null;
  return ((s.extras || []).some((x) => x.ext === 'mp4') || s.mp4) ? s : null;
}, 90000);
const bMp4s = (bDone?.extras || []).filter((x) => x.ext === 'mp4');
check(!!bDone, '停止后自动转封装出 MP4（D5）', bMp4s.length ? `${bMp4s.length} 个副本` : (bDone?.mp4?.name || '无产物'));
check(bMp4s.length > 0 || !!bDone?.mp4, '转封装副本挂在 session.extras（文件库据此显示「已生成 MP4」）', `extras=${(bDone?.extras || []).length}`);
const bMp4 = bDone?.mp4 || bMp4s[0];
if (bMp4) {
  const mp4Path = bMp4.path || path.join(REC, bMp4.relPath || '');
  const st2 = fs.existsSync(mp4Path) ? fs.statSync(mp4Path) : null;
  check(!!st2 && st2.size > 10000, 'MP4 真实存在且非空', `${st2 ? st2.size : 0} 字节`);
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', mp4Path], { encoding: 'utf8', timeout: 30000 });
  let info = null;
  try { info = JSON.parse(probe.stdout); } catch { /* ignore */ }
  const v = (info?.streams || []).find((s) => s.codec_type === 'video') || (info?.streams || [])[0];
  const dur = Number(info?.format?.duration || 0);
  check(!!v && v.codec_name === 'h264' && v.width === 1280 && v.height === 720, 'ffprobe 校验 MP4 编码与分辨率', `${v?.codec_name} ${v?.width}x${v?.height}`);
  check(dur > 0.5, 'ffprobe 校验 MP4 时长合理', `${dur}s`);
} else {
  check(false, 'MP4 真实存在且非空', '没有 MP4 产物');
}

/* ---------- 7) 恢复 A（此时 B 已释放槽位）→ 序号续接不覆盖 ---------- */
await jpost(`/api/tasks/${tA.id}/resume`);
await sleep(1200);
const aResumed = await waitFor(async () => {
  const s = await status();
  const a = s.tasks.find((t) => t.id === tA.id);
  return a.status === 'recording' ? a : (a.status === 'queued' ? null : null);
}, 30000);
check(!!aResumed, 'D4 恢复后重新开始录制（占用释放出来的槽位）', aResumed?.status);
const idxAfter = await waitFor(async () => {
  const s = await sessionOf(tA.id);
  if (!s) return null;
  const idx = s.segments.map((x) => x.segmentIndex || 0);
  return idx.length > (aSession?.segments.length || 0) ? Math.max(...idx) : null;
}, 60000);
check(idxAfter !== null && idxAfter > maxIdxBefore, '暂停恢复后分段序号续接（不覆盖已录内容）', `恢复前最大 ${maxIdxBefore} → 恢复后最大 ${idxAfter}`);

/* ---------- 8) 合并整场 ---------- */
let aBefore = await sessionOf(tA.id);
await jpost(`/api/tasks/${tA.id}/stop`);
await sleep(2500);
aBefore = (await sessionOf(tA.id)) || aBefore;
let merged = null;
if (aBefore) {
  await jpost('/api/files/merge', { sessionId: aBefore.id });
  merged = await waitFor(async () => {
    const s = (await filesAll()).items.find((x) => x.id === aBefore.id);
    return s && s.merged ? s : null;
  }, 90000);
  check(!!merged, '整场合并出单文件（-f concat -c copy）', merged?.merged?.name);
} else {
  check(false, '整场合并出单文件（-f concat -c copy）', '任务 A 没有场次，跳过');
}
if (merged?.merged) {
  const mp = merged.merged.path || path.join(REC, merged.merged.relPath || '');
  const sum = merged.segments.reduce((a, b) => a + (b.durationSec || 0), 0);
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mp], { encoding: 'utf8', timeout: 30000 });
  let dur = 0;
  try { dur = Number(JSON.parse(probe.stdout).format.duration); } catch { /* ignore */ }
  check(fs.existsSync(mp) && dur > 0, '合并文件可被 ffprobe 解析', `${dur}s`);
  check(sum > 0 && dur >= sum * 0.8, '合并时长与各分段之和相符', `分段合计 ${sum.toFixed(1)}s / 合并 ${dur.toFixed(1)}s`);
}

/* ---------- 9) 回放：MP4 直放（Range）+ TS 转 fMP4 渐进流 ---------- */
if (bDone?.mp4) {
  const p1 = await jpost('/api/play', { fileId: bDone.mp4.id });
  check(p1.data?.mode === 'direct', 'MP4 回放走直放', p1.data?.mode);
  const r = await fetch(`${BASE}/api/play/${p1.data.playId}/stream`, { headers: { Range: 'bytes=0-2047' } });
  const buf = Buffer.from(await r.arrayBuffer());
  check(r.status === 206 && /bytes 0-2047\//.test(r.headers.get('content-range') || '') && /ftyp/.test(buf.toString('latin1')), 'MP4 直放支持 Range（206 + ftyp）', `${r.status} ${r.headers.get('content-range')}`);
  await fetch(`${BASE}/api/play/${p1.data.playId}`, { method: 'DELETE' });
}
const tsSeg = ((merged || aBefore)?.segments || [])[0];
if (tsSeg) {
  const p2 = await jpost('/api/play', { fileId: tsSeg.id });
  check(p2.data?.mode === 'remux', 'TS 回放走服务端 fMP4 转封装', p2.data?.mode);
  const r = await fetch(`${BASE}/api/play/${p2.data.playId}/stream`);
  const reader = r.body.getReader();
  let got = Buffer.alloc(0);
  while (got.length < 65536) {
    const { value, done } = await reader.read();
    if (done) break;
    got = Buffer.concat([got, Buffer.from(value)]);
  }
  await reader.cancel().catch(() => {});
  const head = got.toString('latin1');
  check(/ftyp/.test(head) && /moof/.test(head) && /mdat/.test(head), 'fMP4 渐进流含 ftyp/moof/mdat（浏览器可播）', `${got.length} 字节`);
  await fetch(`${BASE}/api/play/${p2.data.playId}`, { method: 'DELETE' });
} else {
  check(false, 'TS 回放走服务端 fMP4 转封装', '没有可回放的分段，跳过');
}

/* ---------- 10) 全部停止 → 转封装/合并收尾收敛（文件不再增长） ---------- */
await jpost(`/api/tasks/${tC.id}/stop`);
for (const t of await tasksAll()) if (['recording', 'queued', 'paused'].includes(t.status)) await jpost(`/api/tasks/${t.id}/stop`);
const idle = await waitFor(async () => {
  const s = await status();
  return s.stats.activeCount === 0 ? s : null;
}, 60000);
check(!!idle, '全部停止后并发归零（真实 ffmpeg 录制进程已释放）', idle ? `active=${idle.stats.activeCount}` : '超时');
const snapBytes = () => {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
  walk(REC);
  return total;
};
let prevSize = -1;
let stableRounds = 0;
const settled = await waitFor(async () => {
  const cur = snapBytes();
  if (cur === prevSize) { stableRounds++; return stableRounds >= 3 ? cur : null; }
  prevSize = cur; stableRounds = 0;
  return null;
}, 180000, 2000);
check(settled !== null && settled > 0, '停止后转封装/合并全部收尾，录制文件不再增长', settled ? `${settled} 字节稳定` : '仍在增长');

/* ---------- 11) 扫描一致性 + 回收站往返 ---------- */
// 后处理（逐个转封装）与文件系统写入存在毫秒级竞态：允许"最后一轮扫描把刚出现的文件补齐"，
// 但最终必须达到"无缺失、无未登记、再扫也没有新增"的稳定一致状态
let scan = await jpost('/api/files/scan', {});
let scanRounds = 1;
for (let i = 0; i < 10; i++) {
  const d = scan.data || {};
  if (d.added === 0 && d.missing === 0 && d.unregistered === 0) break;
  line(`   第 ${scanRounds} 次扫描: ${JSON.stringify(d)}（等待后处理收尾，2 秒后重扫）`);
  await sleep(2000);
  scan = await jpost('/api/files/scan', {});
  scanRounds++;
}
check(scan.data?.added === 0 && scan.data?.missing === 0 && scan.data?.unregistered === 0, '重扫描后索引与磁盘一致（无缺失/无新增/无未登记）', `${JSON.stringify(scan.data)}（第 ${scanRounds} 次扫描收敛）`);
if (Number(scan.data?.added) > 0 || Number(scan.data?.unregistered) > 0) {
  const un = (await jget('/api/files/unregistered')).data;
  line('   [诊断] 未登记文件: ' + (un.items || []).map((x) => `${x.relPath || x.path} (${x.bytes}B)`).join(' | '));
  const seen = new Set();
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!seen.has(e.name)) seen.add(`${path.relative(REC, p)}`); } };
  walk(REC);
  line('   [诊断] 磁盘文件: ' + Array.from(seen).join(' | '));
}
const victim = (await filesAll()).items.find((s) => s.taskId === tC.id) || (await filesAll()).items[0];
if (victim) {
  const del = await jpost('/api/files/delete', { sessionIds: [victim.id] });
  check(del.data?.movedToTrash === 1, '删除场次进回收站', JSON.stringify(del.data));
  const trash = (await jget('/api/trash')).data;
  check((trash.items || []).length >= 1, '回收站里有刚删除的场次');
  const rid = (trash.items || [])[0]?.id;
  const back = await jpost('/api/trash/restore', { ids: [rid] });
  check(!!back.data, '回收站可还原');
  const after = await waitFor(async () => ((await filesAll()).items.some((s) => s.id === victim.id) ? true : null), 20000);
  check(!!after, '还原后场次回到文件库');
} else {
  check(false, '删除场次进回收站', '文件库为空，跳过');
}

/* ---------- 12) 前端自检：真实转封装产物在文件库里可见（需要 Edge/Chrome） ---------- */
const BROWSER = process.env.EDGE_PATH && fs.existsSync(process.env.EDGE_PATH) ? process.env.EDGE_PATH
  : ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const withMp4 = (await filesAll()).items.filter((s) => (s.extras || []).some((x) => x.ext === 'mp4') || s.mp4);
check(withMp4.length > 0, '库里存在带 MP4 副本的场次（供前端核对）', `${withMp4.length} 场`);
if (!BROWSER) {
  line('  SKIP  浏览器自检（未找到 Edge/Chrome，可用 EDGE_PATH 指定）');
} else {
  const initRes = await fetch(`${BASE}/api/auth/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'livegrab123' }) });
  const token = /lg_session=([^;]+)/.exec(initRes.headers.get('set-cookie') || '')?.[1] || '';
  check(!!token, '初始化管理员并拿到会话 Cookie（用于浏览器核对）');
  const CDP = 18094;
  const browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(TMP, 'browser')}`, '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* retry */ }
    if (!wsUrl) await sleep(400);
  }
  if (!wsUrl) {
    check(false, '浏览器已就绪（CDP 连接）');
  } else {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    };
    const send = (method, params = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalIn = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result?.result?.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCookie', { name: 'lg_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true });
    await send('Page.navigate', { url: `${BASE}/#/files` });
    await sleep(2500);
    const me = await evalIn(`fetch('/api/auth/me').then((r) => r.json()).then((j) => (j.data && j.data.username) || j.username || null)`);
    check(me === 'admin', '浏览器会话有效（/api/auth/me = admin）', String(me));
    const view1 = await evalIn(`document.querySelector('#view') ? document.querySelector('#view').innerText : ''`);
    check(/已生成 MP4/.test(view1 || ''), '文件库列表出现「已生成 MP4」标记（真实产物）', (view1 || '').split('\n').find((l) => /已生成 MP4/.test(l))?.slice(0, 80));
    await evalIn(`(document.querySelectorAll('[data-act="expand"]')[0]||{click(){}}).click()`);
    await sleep(800);
    const view2 = await evalIn(`document.querySelector('#view') ? document.querySelector('#view').innerText : ''`);
    check(/\.mp4/.test(view2 || ''), '展开场次后列出 MP4 副本文件（extras 渲染）', (view2 || '').split('\n').find((l) => /\.mp4/.test(l))?.slice(0, 90));
    check(pageErrors.length === 0, '文件库页面无前端报错', pageErrors.slice(0, 2).join(' | '));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot?.result?.data) {
      const out = path.join(APP, '..', 'ui', '_ffmpeg-files.png');
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      line(`   截图证据已保存: ui/_ffmpeg-files.png（${fs.statSync(out).size} 字节）`);
    }
    ws.close();
  }
  browser.kill();
}

/* ---------- 收尾 ---------- */
streamSrv.close();
for (const g of producers) { try { g.kill('SIGKILL'); } catch { /* ignore */ } }
srv.kill('SIGTERM');
await sleep(800);
line(`\n服务日志尾部:\n${srvLog.trim().split('\n').slice(-6).join('\n')}`);
if (process.env.KEEP_TMP !== '1' && TMP.startsWith(os.tmpdir())) {
  await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
  line(`已清理临时目录 ${TMP}`);
} else {
  line(`保留临时目录 ${TMP}`);
}
line(`\n==== 真实 ffmpeg 端到端结果：${bad === 0 ? 'ALL PASS' : `${bad} 项失败`} ====`);
process.exit(bad ? 1 : 0);
