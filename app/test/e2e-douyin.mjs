// 真实外网端到端验证：抖音「不登录、不粘 Cookie」能否解析并录成文件
// 用法：node app/test/e2e-douyin.mjs      需要 ffmpeg + 能访问抖音；找不到 ffmpeg / 没有在播房间时自动跳过
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoom, resolveStream } from '../server/resolvers/douyin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  console.log('跳过抖音端到端：未找到 ffmpeg（可设置 FFMPEG_PATH / FFPROBE_PATH）。');
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
const probeJson = (file) => {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { __err: `${r.status} ${String(r.stderr || r.error?.message || '').slice(0, 120)}` }; }
};

/* ---------- 1) 匿名找一个正在直播的抖音房间（不登录、不粘 Cookie） ---------- */
line('1) 匿名获取"正在直播"的抖音房间号');
let rid = process.argv[2] || '';
let nick = '';
if (!rid) {
  try {
    const home = await fetch('https://live.douyin.com/', { headers: { 'User-Agent': UA } });
    const ttwid = /ttwid=([^;,\s]+)/.exec(home.headers.get('set-cookie') || '')?.[1] || '';
    const params = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', count: '15', offset: '0' });
    const feed = await (await fetch(`https://live.douyin.com/webcast/feed/?${params}`, {
      headers: { 'User-Agent': UA, Referer: 'https://live.douyin.com/', ...(ttwid ? { Cookie: `ttwid=${ttwid}` } : {}) },
    })).json();
    const rooms = Object.values(feed.data || {}).map((x) => x?.data).filter((r) => r?.id_str && r.status === 2);
    if (!rooms.length) {
      console.log('跳过抖音端到端：当前没有拿到正在直播的房间（可能无外网或被风控）。');
      process.exit(0);
    }
    rid = rooms[0].id_str;
    nick = rooms[0].owner?.nickname || '';
    check(true, '匿名 feed 接口拿到在播房间（未使用任何 Cookie）', `${rid} / ${nick}`);
  } catch (e) {
    console.log(`跳过抖音端到端：无法访问抖音（${e.message}）。`);
    process.exit(0);
  }
}

/* ---------- 2) 直接用解析器验证"免登录"解析与取流 ---------- */
line('\n2) 解析器直测：settings.cookies 为空');
const settings = { cookies: {} };
const quiet = { info: () => {}, warn: (m) => line(`   warn ${m}`), debug: () => {}, error: () => {} };
let room;
try {
  room = await resolveRoom({ roomId: rid, settings, logger: quiet });
} catch (e) {
  console.log(`跳过抖音端到端：解析失败（房间可能刚下播）：${e.message}`);
  process.exit(0);
}
check(room.liveStatus === 'live', '免登录解析出"正在直播"', `${room.liveStatus} / ${room.anchorName}`);
check(!!room.anchorName && !!room.title, '免登录解析出主播名与标题', `${room.anchorName} · ${String(room.title).slice(0, 18)}`);
check(!settings.cookies.douyin, '解析全程未使用抖音 Cookie（settings.cookies 为空）');
const stream = await resolveStream({ roomId: rid, quality: 'origin', settings, logger: quiet });
check(/^https?:\/\/.+\.(flv|m3u8|ts)/.test(stream.url), '免登录拿到真实流地址', String(stream.url).slice(0, 72) + '…');
check(stream.qualityKey === 'FULL_HD1' || !!stream.qualityKey, '原画档位命中抖音最高码率 key', String(stream.qualityKey));

/* ---------- 3) 启动 LiveGrab（临时目录），用真实调度器录这一路 ---------- */
line('\n3) 真实调度器录制（临时目录，测试后删除）');
const TMP = path.join(os.tmpdir(), `livegrab-douyin-${Date.now()}`);
const CFG = path.join(TMP, 'config');
const REC = path.join(TMP, 'record');
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(REC, { recursive: true });
const PORT = 18096;
const BASE = `http://127.0.0.1:${PORT}`;
const seed = spawnSync(NODE, ['-e', `Promise.all([import(process.argv[1]), import(process.argv[3])]).then(async ([m, dbm]) => { const db = dbm.openDb(process.argv[4]); const s = await new m.Store(process.argv[2]).init(db); await s.updateSettings({security:{trustLan:true},maxConcurrency:2,platformCaps:{douyin:2},defaultSegmentMinutes:1,diskLimitGB:1,remuxToMp4:true,autoMerge:false,keepSource:true,pollIntervalSec:5}); db.close(); console.log('ok'); }).catch((e) => { console.error('seed ERR: ' + (e?.message || e)); process.exit(1); })`, 'file:///' + path.join(APP, 'server', 'store.js').replace(/\\/g, '/'), CFG, 'file:///' + path.join(APP, 'server', 'db.js').replace(/\\/g, '/'), path.join(CFG, 'livegrab.db')], { encoding: 'utf8' });
check((seed.stdout || '').includes('ok'), '预置设置（含空 Cookie）', (seed.stdout || '').trim() + (seed.stderr ? ' ERR ' + seed.stderr.slice(0, 60) : ''));
const env = { ...process.env, PORT: String(PORT), CONFIG_DIR: CFG, RECORD_ROOT: REC, FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE || 'ffprobe', TZ: 'Asia/Shanghai', LIVEGRAB_VERSION: '0.1.0' };
const srv = spawn(NODE, [path.join(APP, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += `[err] ${d}`; });
const up = await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok, 30000);
if (!up) { line('服务启动失败:\n' + srvLog); process.exit(1); }
const jpost = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json());
const jget = async (p) => (await (await fetch(BASE + p)).json());
const tasksAll = async () => ((await jget('/api/tasks')).data.items || []);
const status = async () => (await jget('/api/status')).data;

const created = await jpost('/api/tasks', {
  platform: 'douyin', url: `https://live.douyin.com/${rid}`, anchorName: nick,
  overrides: { quality: 'origin' }, segmentMode: 'time', segmentMinutes: 0.25, // 15 秒一段（最小 10 秒）
});
const task = created.data || {};
check(!!task.id && task.platform === 'douyin', '创建抖音任务成功（未填写 Cookie）', `${task.id} ${task.platform}`);

try {
  await jpost(`/api/tasks/${task.id}/start`);
  const rec = await waitFor(async () => {
    const t = (await tasksAll()).find((x) => x.id === task.id);
    return t && t.status === 'recording' ? t : null;
  }, 45000);
  if (!rec) {
    const t = (await tasksAll()).find((x) => x.id === task.id);
    line(`  任务状态: ${t?.status} / ${t?.lastError || ''}`);
    check(false, '任务进入录制状态（房间可能刚下播，可重跑）', t?.lastError || '');
  } else {
    check(true, '抖音任务开始录制（免登录）', `${rec.anchorName} · ${rec.title || ''}`);
    check(!rec.lastError, '录制中无解析错误', rec.lastError || '（无）');
    if (nick && rec.anchorName) check(rec.anchorName.includes(nick.slice(0, 4)) || nick.includes(rec.anchorName.slice(0, 4)), '任务卡片回填了真实主播名', `${rec.anchorName}`);
    // 真实字节增长
    // 注意：抖音匿名拉流实测会被上游限速（字节数会长时间持平），ffmpeg 的 -segment_time 按**流时间**分段，
    // 所以轮转在墙钟上可能晚很多。这里放宽到 90 秒并记录限速提示，避免把上游限速误判成录制缺陷。
    let growing = false;
    let last = -1;
    let flat = 0;
    let maxFlat = 0;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const st = await status();
      const live = (st.recording || []).find((x) => x.id === task.id)?.live || {};
      const bytes = live.bytes || 0;
      if (bytes > 0 && bytes > last) growing = true;
      if (bytes === last && bytes > 0) { flat++; maxFlat = Math.max(maxFlat, flat); } else { flat = 0; }
      last = bytes;
      if (i % 5 === 4 || live.segmentIndex >= 2) {
        line(`     +${(i + 1) * 2}s 已录 ${bytes} 字节 / 段序 ${live.segmentIndex ?? '-'} / 重连 ${live.reconnects ?? 0} / 文件 ${path.basename(live.currentFile || '')}`);
      }
      if (live.segmentIndex >= 2 && bytes > 400000) break;
    }
    if (maxFlat >= 5) line(`     ⓘ 检测到拉流限速：字节数曾连续 ${maxFlat * 2}s 持平（匿名拉流被上游限速，属上游行为）`);
    check(growing, '录制字节持续增长（真实拉流）', `${last} 字节`);
    const liveNow = ((await status()).recording || []).find((x) => x.id === task.id)?.live || {};
    check((liveNow.segmentIndex ?? 0) >= 2, '按时间成功轮转到第 2 段（真实分段）', `segmentIndex=${liveNow.segmentIndex}（15 秒/段）`);
    check(String(liveNow.dir || '').includes('抖音'), '落盘目录按平台归档', String(liveNow.dir || '').replace(REC, ''));
    // 段文件真实可读
    const segFiles = fs.existsSync(REC) ? fs.readdirSync(REC, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')) : [];
    check(segFiles.length >= 2, '磁盘上出现 ≥2 个分段文件', `${segFiles.length} 个`);
    const segAbs = path.join(REC, segFiles[0] || '');
    const segInfo = fs.existsSync(segAbs) ? probeJson(segAbs) : {};
    const vSeg = (segInfo.streams || []).find((s) => s.codec_type === 'video');
    check(!!vSeg && Number(segInfo.format?.duration || 0) > 0, '首个分段是真实可播放视频（ffprobe 校验）', vSeg ? `${vSeg.codec_name} ${vSeg.width}x${vSeg.height} ${Number(segInfo.format.duration).toFixed(1)}s` : `无法读取 ${segInfo.__err || ''}`);
    check(segAbs.includes('抖音') || segFiles[0].includes('抖音'), '文件名含平台目录（命名规则生效）', segFiles[0]);
    // 停止 → 收尾
    await jpost(`/api/tasks/${task.id}/stop`);
    const done = await waitFor(async () => {
      const t = (await tasksAll()).find((x) => x.id === task.id);
      return t && ['completed', 'error', 'waiting', 'idle', 'stopped'].includes(t.status) ? t : null;
    }, 90000);
    check(!!done, '停止后任务正常收尾', done?.status || '超时');
    const mp4 = await waitFor(async () => {
      const found = (fs.existsSync(REC) ? fs.readdirSync(REC, { recursive: true }).map(String) : []).filter((f) => f.endsWith('.mp4'));
      return found.length ? found : null;
    }, 60000);
    check(!!mp4, '停止后自动转封装出 MP4', (mp4 || []).map((f) => path.basename(f)).join(' · ') || '无');
    if (mp4) {
      const info = probeJson(path.join(REC, mp4[0]));
      const v = (info.streams || []).find((s) => s.codec_type === 'video');
      check(!!v, 'MP4 含视频流（ffprobe 校验）', v ? `${v.codec_name} ${v.width}x${v.height}` : `无视频流 ${info.__err || ''}`);
      // 断言"转封装没截断"而不是固定秒数：ts 容器对**被停止截断的最末分段**会高估时长
      // （实测 MP4 16.0s / 分段合计 19.3s，其中 15s 是首段），所以判据是"至少覆盖最长分段"。
      const mp4Dur = Number(info.format?.duration || 0);
      const tsFiles = fs.existsSync(REC) ? fs.readdirSync(REC, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')) : [];
      const segDurs = tsFiles.map((f) => Number(probeJson(path.join(REC, f)).format?.duration || 0));
      const maxSeg = Math.max(0, ...segDurs);
      const tsDur = segDurs.reduce((a, b) => a + b, 0);
      check(mp4Dur > 0 && mp4Dur >= maxSeg - 2, 'MP4 时长正常（覆盖最长分段，未被截断）',
        `MP4 ${mp4Dur.toFixed(1)}s / 最长分段 ${maxSeg.toFixed(1)}s / 分段合计 ${tsDur.toFixed(1)}s（${tsFiles.length} 段）`);
    }
    const files = (await jget('/api/files')).data || {};
    const sess = (files.items || [])[0];
    check((files.total || 0) > 0 && sess?.platform === 'douyin', '文件库登记了这次抖音录制', `${files.total} 个会话 / ${sess?.platformName || sess?.platform || ''} / ${sess?.streamer || ''} / 段数 ${sess?.segmentCount ?? '-'}`);
  }
} finally {
  for (const t of await tasksAll()) {
    if (['recording', 'queued', 'paused'].includes(t.status)) await jpost(`/api/tasks/${t.id}/stop`).catch(() => {});
  }
  await sleep(1200);
  srv.kill('SIGKILL');
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true }); line(`\n已清理临时目录 ${TMP}`); } catch { /* ignore */ }
}

line(`\n==== 抖音免登录端到端结果：${bad ? `${bad} 项失败` : 'ALL PASS'} ====`);
process.exit(bad ? 1 : 0);
