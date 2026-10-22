// 真实 ffmpeg 端到端冒烟：真实 media.js 参数构造 + 真实 ffmpeg 二进制 + 真实 Storage 入册。
// 运行：node app/test/smoke-merge-real.mjs   （需要 PATH 里有 ffmpeg/ffprobe）
// 目的：验证「勾选合并产生全新命名文件并继承第一个文件场次」全链路——不 mock 任何 ffmpeg 行为。
// 与 run.js 的区别：run.js 保持「没有 ffmpeg 也能全绿」（假二进制）；本脚本专治“假绿”，
// 凡是合并链路的接线问题（参数形状/落盘/命名/入册）在这里必须用真家伙过一遍。
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

import { Store } from '../server/store.js';
import { openDb } from '../server/db.js';
import { Storage } from '../server/storage.js';
import * as media from '../server/media.js';
import { uid } from '../server/util.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  PASS  ${label}${extra ? `  → ${extra}` : ''}`);
  else { failed++; console.log(`  FAIL  ${label}${extra ? `  → ${extra}` : ''}`); }
};
const eq = (a, b, label) => ok(Object.is(a, b), label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

function sh(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: media.ffmpegEnv() });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, err }));
    c.on('error', (e) => resolve({ code: -1, err: String(e) }));
  });
}

async function makeSample(file, seconds) {
  const { code, err } = await sh(media.FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=128x72:rate=10`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]);
  if (code !== 0) throw new Error(`生成样例失败: ${err.slice(-300)}`);
}

async function makeSession(store, id, dir, files) {
  await fsp.mkdir(dir, { recursive: true });
  const segs = [];
  for (let i = 0; i < files.length; i++) {
    const fp = path.join(dir, files[i].name);
    await makeSample(fp, files[i].seconds);
    const st = await fsp.stat(fp);
    segs.push({
      id: `${id}_f${i}`, sessionId: id, kind: 'segment', name: files[i].name, path: fp,
      relPath: files[i].name, ext: 'mp4', bytes: st.size, durationSec: files[i].seconds,
      width: 128, height: 72, status: 'ok', segmentIndex: i + 1,
    });
  }
  const session = {
    id, taskId: `task_${id}`, platform: 'other', platformName: null, streamer: 'smoke',
    title: '', roomId: 'r', startedAt: new Date().toISOString(), quality: null,
    durationSec: files.reduce((a, b) => a + b.seconds, 0), status: 'completed',
    segments: segs, extras: [], merged: null, mp4: null,
    bytes: segs.reduce((a, b) => a + b.bytes, 0),
  };
  store.sessions.push(session);
  await store.saveSession(session);
  return session;
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'livegrab-merge-smoke-'));
  console.log(`真实 ffmpeg 合并冒烟（临时目录 ${root}）`);
  const db = openDb(path.join(root, 'livegrab.db'));
  const store = await new Store(root).init(db);
  const storage = new Storage({ store, logger, mediaMod: media }); // 真实 media 模块，非 mock

  // —— 场景 1：保留源文件 → 新文件生成、源一个不动、入册第一个文件场次 ——
  const sess = await makeSession(store, 'S1', path.join(root, 's1'), [
    { name: 'ep1.mp4', seconds: 1 }, { name: 'ep2.mp4', seconds: 1 },
  ]);
  const ids = sess.segments.map((s) => s.id);
  const before = await fsp.readFile(sess.segments[0].path); // 源快照（字节级对比）

  const r = await storage.mergePicked(ids, { deleteSources: false, name: 'ep1(合并)' });
  eq(r.item.name, 'ep1(合并).mp4', '产物名 = 主名 + 与源一致的扩展名（真实 ffmpeg 落盘）');
  const stOut = await fsp.stat(r.item.path).catch(() => null);
  ok(!!stOut && stOut.size > 0, '产物文件真实存在于磁盘且非空', `bytes=${stOut ? stOut.size : 0}`);
  const probe = await media.probeJson(r.item.path).catch(() => null);
  ok(!!probe && Math.abs(Number(probe.durationSec) - 2) < 0.6, '产物时长 ≈ 两段之和（真实 ffprobe）',
    `durationSec=${probe ? probe.durationSec : 'null'}`);
  ok(Buffer.compare(await fsp.readFile(sess.segments[0].path), before) === 0, '第一个文件内容原样（字节级一致）');
  ok((await fsp.stat(sess.segments[1].path).catch(() => null)) !== null, '第二个源文件仍在磁盘');
  eq(sess.segments.length, 2, '源登记不减员');
  eq(sess.extras.length, 1, '产物挂第一个文件场次 extras');
  eq(sess.extras[0].sessionId, 'S1', '产物继承第一个文件的场次信息');
  eq(sess.extras[0].kind, 'merged', '产物 kind=merged');
  ok(r.item.id !== ids[0], '产物是全新记录 id');

  // —— 场景 2：合并后删除源文件 → 全部源（含第一个）移出，只剩产物 ——
  const sess2 = await makeSession(store, 'S2', path.join(root, 's2'), [
    { name: 'c1.mp4', seconds: 1 }, { name: 'c2.mp4', seconds: 1 }, { name: 'c3.mp4', seconds: 1 },
  ]);
  store.settings.recordRoot = root;
  await store.updateSettings({ deleteToTrash: true, trashRetentionDays: 7 });
  const ids2 = sess2.segments.map((s) => s.id);
  const r2 = await storage.mergePicked(ids2, { deleteSources: true, name: 'c1(合并)' });
  ok(!!(await fsp.stat(r2.item.path).catch(() => null)), '删源模式产物真实落盘');
  for (const s of sess2.segments.slice()) {
    ok(!(await fsp.stat(s.path).catch(() => null)), `源文件已移出磁盘：${s.name}`);
  }
  eq(sess2.segments.length, 0, '源登记全部移除');
  eq(sess2.extras.length, 1, '登记只剩合并结果');
  ok(r2.deletedSources >= 3, '返回已删源数量（含第一个）', String(r2.deletedSources));
  ok((store.trash || []).length >= 3, '全部源进了回收站（可还原）', `trash=${(store.trash || []).length}`);

  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过（真实 ffmpeg 端到端）');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('冒烟异常：', e); process.exit(1); });
