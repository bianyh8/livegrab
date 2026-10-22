// 本场挂起（sessionHold）回归测试 + 前端 sessionAction 规则矩阵
// 用法：node app/test/session-hold.mjs
// 纯离线：注入假探测/假 recorder，不打真实平台、不跑 ffmpeg
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scheduler } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import { openDb } from '../server/db.js';
import { sessionAction } from '../web/views/tasks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const mkTask = (over = {}) => ({
  id: 't1', platform: 'douyin', roomId: '123456', shortId: '', anchorName: '测试主播', platformAnchorName: '测试主播',
  sourceUrl: 'douyin:123456', title: '测试',
  status: 'recording', liveStatus: 'live', monitorOnly: false, autoRecord: true,
  manualHeld: false, sessionHold: false, failCount: 0, failNotified: false, nextPollAt: 0,
  pollIntervalSec: 60, overrides: {},
  ...over,
});

function makeScheduler({ settings = {}, task = null, probe = null } = {}) {
  const calls = { probe: 0, started: 0 };
  const store = {
    settings: { platformEnabled: {}, maxConcurrency: 5, pollIntervalSec: 60, reconnectMax: 5, ...settings },
    tasks: task ? [task] : [],
    async saveTask() {}, async saveSession() {}, async persist() {},
    getTask: (id) => (task && task.id === id ? task : null),
  };
  const s = new Scheduler({
    store,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    notifier: { async send() {} },
    storage: {
      _sessionFileBytes: () => 0,
      _sessionDurationSec: () => 0,
      async autoRemux() {}, async writeArt() {},
    },
    onEvent() {},
  });
  s._probe = async () => { calls.probe++; return probe ? probe() : { liveStatus: 'live' }; };
  s._startRecording = async () => { calls.started++; return { started: true }; };
  const fakeRec = { async stop() { return { segments: [], bytes: 0, reason: 'user' }; } };
  return { s, store, task, calls, fakeRec };
}

console.log('=== 1. 自动录制任务点「停止本场」→ 设 sessionHold，不改 autoRecord ===');
{
  const task = mkTask({ status: 'recording' });
  const { s, task: t, fakeRec } = makeScheduler({ task });
  s.recorders.set('t1', fakeRec);
  await s.stopTask('t1', { reason: 'user', oneShot: true });
  check('sessionHold = true', t.sessionHold === true, String(t.sessionHold));
  check('autoRecord 仍为 true（不改配置）', t.autoRecord === true);
  check('manualHeld 仍为 false', t.manualHeld === false);
  check('状态收尾为 completed', t.status === 'completed', t.status);
  check('任务对象不存 UI 文案（状态只留 KEY）', !('statusMessage' in t), Object.keys(t).filter((k) => /message/i.test(k)).join(',') || '无 message 字段');
}

console.log('=== 2. 挂起期间直播中：轮询不再自动拉起录制 ===');
{
  const task = mkTask({ status: 'completed', sessionHold: true, liveStatus: 'live' });
  const { s, task: t, calls } = makeScheduler({ task });
  await s.tick();
  check('探测执行了（直播状态照常刷新）', calls.probe === 1, `探测 ${calls.probe} 次`);
  check('未自动开始录制', calls.started === 0, `started ${calls.started} 次`);
  check('状态回到 waiting（挂起期间不自动拉起）', t.status === 'waiting', t.status);
  check('sessionHold 保持', t.sessionHold === true);
}

console.log('=== 3. 下播 → 自动解除挂起，下次开播照旧自动录制 ===');
{
  const task = mkTask({ status: 'waiting', sessionHold: true, liveStatus: 'live' });
  let live = true;
  const { s, task: t, calls } = makeScheduler({ task, probe: () => (live ? { liveStatus: 'live' } : { liveStatus: 'offline' }) });
  await s.tick(); // 直播中：挂着
  live = false;
  t.nextPollAt = 0; // 模拟轮询间隔到点
  await s.tick(); // 下播
  check('下播后 sessionHold 清除', t.sessionHold === false, String(t.sessionHold));
  live = true;
  t.nextPollAt = 0; // 模拟轮询间隔到点
  await s.tick(); // 再次开播
  check('再次开播自动恢复录制', calls.started === 1, `started ${calls.started} 次`);
}

console.log('=== 4. 任何「开始」（本场/永久）都解除挂起 ===');
{
  const t1 = mkTask({ status: 'waiting', sessionHold: true, liveStatus: 'live' });
  const a = makeScheduler({ task: t1 });
  await a.s.startTask('t1', { oneShot: true }); // 录制本场
  check('「录制本场」清除挂起', t1.sessionHold === false, String(t1.sessionHold));

  const t2 = mkTask({ id: 't2', status: 'waiting', sessionHold: true, liveStatus: 'live' });
  const b = makeScheduler({ task: t2 });
  await b.s.startTask('t2', {}); // 开始录制（永久）
  check('「开始录制」清除挂起', t2.sessionHold === false, String(t2.sessionHold));
}

console.log('=== 5. 非自动录制任务点「停止本场」不设挂起（无意义但无害） ===');
{
  const task = mkTask({ status: 'recording', autoRecord: false });
  const { s, task: t, fakeRec } = makeScheduler({ task });
  s.recorders.set('t1', fakeRec);
  await s.stopTask('t1', { reason: 'user', oneShot: true });
  check('autoRecord=false 任务不设 sessionHold', t.sessionHold !== true, String(t.sessionHold));
}

console.log('=== 6. DB 持久化：session_hold 幂等补列 + 落盘回读 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-session-hold-'));
  const dbPath = path.join(dir, 'livegrab.db');
  try {
    const db = openDb(dbPath);
    const st = await new Store(dir).init(db);
    const task = mkTask({ id: 'p1', sessionHold: true });
    await st.saveTask(task);
    db.close();
    // 回读
    const db2 = openDb(dbPath);
    const st2 = await new Store(dir).init(db2);
    const loaded = st2.getTask('p1');
    check('sessionHold 落盘回读为 true', loaded.sessionHold === true, String(loaded.sessionHold));
    db2.close();
    // 再次打开（模拟老库缺列场景：先建库再补列）
    const db3 = openDb(dbPath);
    const cols = db3.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
    check('tasks 表含 session_hold 列', cols.includes('session_hold'));
    db3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('=== 7. 前端 sessionAction：本场按钮覆盖自动录制任务 ===');
{
  const cases = [
    ['自动录制·录制中 → 停止本场', { autoRecord: true, monitorOnly: false, status: 'recording', liveStatus: 'live' }, 'stop-once'],
    ['自动录制·直播未录制 → 录制本场', { autoRecord: true, monitorOnly: false, status: 'waiting', liveStatus: 'live' }, 'record-once'],
    ['不开播自动录制·录制中 → 停止本场', { autoRecord: false, monitorOnly: false, status: 'recording', liveStatus: 'live' }, 'stop-once'],
    ['不开播自动录制·直播未录制 → 录制本场', { autoRecord: false, monitorOnly: false, status: 'waiting', liveStatus: 'live' }, 'record-once'],
    ['仅监控·直播未录制 → 录制本场', { autoRecord: true, monitorOnly: true, status: 'waiting', liveStatus: 'live' }, 'record-once'],
    ['未直播 → 无本场按钮', { autoRecord: false, monitorOnly: false, status: 'waiting', liveStatus: 'offline' }, null],
    ['未直播但收尾中 → 停止本场', { autoRecord: true, monitorOnly: false, status: 'stopping', liveStatus: 'offline' }, 'stop-once'],
  ];
  for (const [name, item, want] of cases) {
    const got = sessionAction(item);
    check(name, got === want, String(got));
  }
}

console.log('\n================ 结果 ================');
console.log(`PASS ${pass} ｜ FAIL ${fail}`);
console.log('=== 8. 开播延时非阻塞：tick 不卡住，定时器到点起录，且延时期间状态变化则放弃 ===');
{
  // 8.1 基本：延时 0.3s，tick 立即返回（started=0），0.7s 后 started=1
  const task = mkTask({ id: 'd1', status: 'waiting', liveStatus: 'live', autoRecord: true, monitorOnly: false, startDelaySec: 0.3 });
  const { s, task: t, calls } = makeScheduler({ task });
  const t0 = Date.now();
  await s.tick();
  const tickMs = Date.now() - t0;
  check('tick 不阻塞（<200ms 返回）', tickMs < 200, `${tickMs}ms`);
  check('tick 返回时还没开始录（延时中）', calls.started === 0, `started ${calls.started}`);
  check('已排定时器', s._pendingStarts.has('d1'), `pending ${s._pendingStarts.size}`);
  await sleep(800);
  check('到点后自动开录 1 次', calls.started === 1, `started ${calls.started}`);
  check('待启动表已清空', !s._pendingStarts.has('d1'));
}

{
  // 8.2 重复 tick 不重复排定时器（仍是 1 次起录）
  const task = mkTask({ id: 'd2', status: 'waiting', liveStatus: 'live', autoRecord: true, monitorOnly: false, startDelaySec: 0.3 });
  const { s, calls } = makeScheduler({ task });
  await s.tick();
  await s.tick(); // 第二次：不该再排
  check('重复 tick 只保留 1 个待启动', s._pendingStarts.size === 1, `${s._pendingStarts.size}`);
  await sleep(800);
  check('最终只起录 1 次', calls.started === 1, `started ${calls.started}`);
}

{
  // 8.3 延时期间下播（状态变化）→ 放弃自动开录
  const task = mkTask({ id: 'd3', status: 'waiting', liveStatus: 'live', autoRecord: true, monitorOnly: false, startDelaySec: 0.3 });
  const { s, task: t, calls } = makeScheduler({ task, probe: () => ({ liveStatus: 'live' }) });
  await s.tick();
  t.liveStatus = 'offline'; // 模拟延时期间下播
  await sleep(800);
  check('下播后不再自动开录', calls.started === 0, `started ${calls.started}`);
}

{
  // 8.4 延时期间手动停止 → 撤掉待启动
  const task = mkTask({ id: 'd4', status: 'waiting', liveStatus: 'live', autoRecord: true, monitorOnly: false, startDelaySec: 0.3 });
  const { s, task: t, calls } = makeScheduler({ task });
  await s.tick();
  await s.stopTask('d4', { reason: 'user' });
  check('手动停止后待启动被撤掉', !s._pendingStarts.has('d4'));
  await sleep(800);
  check('不再自动开录', calls.started === 0, `started ${calls.started}`);
}

console.log('\n================ 结果 ================');
console.log(`PASS ${pass} ｜ FAIL ${fail}`);
process.exit(fail ? 1 : 0);
