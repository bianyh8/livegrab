// 轮询频率回归测试：确认「直播间状态轮询」严格按系统设置的间隔运行
// 用法：node app/test/poll-interval.mjs
// 纯离线：注入假探测（scheduler._probe），不打真实平台接口，不需要 ffmpeg
import { Scheduler } from '../server/scheduler.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS ${name}${extra ? ' · ' + extra : ''}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' · ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sec = (ms) => Math.round(ms / 1000);

const mkTask = (over = {}) => ({
  id: 't1', platform: 'douyin', roomId: '123456', anchorName: '测试主播',
  sourceUrl: 'douyin:123456', title: '测试',
  status: 'waiting', liveStatus: 'offline', monitorOnly: true, autoRecord: false,
  pollIntervalSec: 60, overrides: {}, failCount: 0, failNotified: false, nextPollAt: 0,
  ...over,
});

/** 造一个最小可用的 Scheduler（假 store/logger/notifier，注入假 probe） */
function makeScheduler({ settings = {}, task = null, probe = null } = {}) {
  const calls = [];
  const notes = []; // 通知记录：验证「开播通知」真的发出去（历史 bug：只在 offline→live 跳变时发，手动停止后永不再发）
  const store = {
    settings: { platformEnabled: {}, maxConcurrency: 5, pollIntervalSec: 60, reconnectMax: 5, ...settings },
    tasks: task ? [task] : [],
    async saveTask() {}, async persist() {},
    getTask: (id) => (task && task.id === id ? task : null),
  };
  const s = new Scheduler({
    store,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    notifier: { async send(event, title, message, meta) { notes.push({ event, title, message, meta }); } },
    storage: {},
    onEvent() {},
  });
  s._probe = async (...args) => {
    calls.push(Date.now());
    return probe ? probe(...args) : { liveStatus: 'live' };
  };
  return { s, store, task, calls, notes };
}

console.log('=== 1. 直播中：轮询间隔必须按设置，而不是每个 tick（5 秒）都打一次 ===');
{
  const { s, task, calls } = makeScheduler({ settings: { pollIntervalSec: 60 }, task: mkTask() });
  const t0 = Date.now();
  await s.tick();
  check('探测执行 1 次', calls.length === 1, `探测 ${calls.length} 次`);
  check('下一次轮询 = 60 秒后（旧实现在直播中为 5 秒）', near(task.nextPollAt - t0, 60000, 1500), `Δ=${sec(task.nextPollAt - t0)}s`);
  check('直播状态已落盘 live', task.liveStatus === 'live', String(task.liveStatus));

  // 未到点的下一轮 tick 不应再次探测
  await s.tick();
  check('未到间隔时间不重复探测（第 2 次 tick 被 nextPollAt 挡住）', calls.length === 1, `探测 ${calls.length} 次`);
}

console.log('=== 2. 未开播：同样按设置的间隔排下一次 ===');
{
  const { s, task, calls } = makeScheduler({
    settings: { pollIntervalSec: 120 }, task: mkTask({ liveStatus: 'offline' }),
    probe: async () => ({ liveStatus: 'offline' }),
  });
  const t0 = Date.now();
  await s.tick();
  check('未开播也探测 1 次', calls.length === 1, `探测 ${calls.length} 次`);
  check('下一次轮询 = 120 秒后', near(task.nextPollAt - t0, 120000, 1500), `Δ=${sec(task.nextPollAt - t0)}s`);
}

console.log('=== 3. 系统设置改动对「未单独设置间隔」的任务立即生效 ===');
{
  const task = mkTask();
  const { s, store } = makeScheduler({ settings: { pollIntervalSec: 60 }, task });
  check('初始跟随全局 60 秒', s.pollIntervalOf(task) === 60, `${s.pollIntervalOf(task)}s`);
  store.settings.pollIntervalSec = 30;
  check('全局改 30 秒后任务立即跟随 30 秒（旧实现仍是 60 秒）', s.pollIntervalOf(task) === 30, `${s.pollIntervalOf(task)}s`);
  const t0 = Date.now();
  await s.tick();
  check('下一轮轮询按新全局值 30 秒', near(task.nextPollAt - t0, 30000, 1500), `Δ=${sec(task.nextPollAt - t0)}s`);
}

console.log('=== 4. 任务级自定义间隔优先于全局，且不被全局改动影响 ===');
{
  const task = mkTask({ overrides: { pollIntervalSec: 180 } });
  const { s, store } = makeScheduler({ settings: { pollIntervalSec: 60 }, task });
  check('自定义 180 秒生效', s.pollIntervalOf(task) === 180, `${s.pollIntervalOf(task)}s`);
  store.settings.pollIntervalSec = 20;
  check('全局改成 20 秒后自定义任务仍为 180 秒', s.pollIntervalOf(task) === 180, `${s.pollIntervalOf(task)}s`);
  const t0 = Date.now();
  await s.tick();
  check('下一轮轮询 = 180 秒后', near(task.nextPollAt - t0, 180000, 1500), `Δ=${sec(task.nextPollAt - t0)}s`);
}

console.log('=== 5. 探测慢/开播延时时不得出现重叠轮询（tick 互斥） ===');
{
  let inFlight = 0, maxInFlight = 0, release;
  const gate = new Promise((r) => { release = r; });
  const { s, calls } = makeScheduler({
    settings: { pollIntervalSec: 60 }, task: mkTask(),
    probe: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await gate; inFlight--; return { liveStatus: 'live' }; },
  });
  const p1 = s.tick();
  const p2 = s.tick(); // 上一轮未结束时的第二次 tick：必须被挡掉
  await sleep(40);
  release();
  await Promise.all([p1, p2]);
  check('并发 tick 只探测 1 次', calls.length === 1, `探测 ${calls.length} 次`);
  check('同时只有 1 个探测在跑', maxInFlight === 1, `峰值 ${maxInFlight}`);
}

console.log('=== 6. 编辑任务：间隔与全局不同才算任务级自定义，改回全局值则恢复跟随 ===');
{
  const task = mkTask();
  const { s, store } = makeScheduler({ settings: { pollIntervalSec: 60 }, task });
  const r1 = await s.updateTask('t1', { overrides: { pollIntervalSec: 180 } });
  check('设为 180 → 写入 overrides', r1.overrides.pollIntervalSec === 180, JSON.stringify(r1.overrides));
  check('生效值 180 秒', s.pollIntervalOf(r1) === 180, `${s.pollIntervalOf(r1)}s`);
  store.settings.pollIntervalSec = 90;
  check('全局改 90 秒不影响该任务', s.pollIntervalOf(r1) === 180, `${s.pollIntervalOf(r1)}s`);
  const r2 = await s.updateTask('t1', { overrides: { pollIntervalSec: null } });
  check('显式 null → 清除自定义，恢复跟随全局', r2.overrides.pollIntervalSec === undefined, JSON.stringify(r2.overrides));
  check('恢复后跟随全局 90 秒', s.pollIntervalOf(r2) === 90, `${s.pollIntervalOf(r2)}s`);
}

console.log('=== 7. 兼容：扁平 pollIntervalSec（旧前端/脚本）仍视为任务级自定义 ===');
{
  const task = mkTask();
  const { s } = makeScheduler({ settings: { pollIntervalSec: 60 }, task });
  check('_overridesFrom 接受扁平写法', s._overridesFrom({ pollIntervalSec: 120 }).pollIntervalSec === 120);
  check('_overridesFrom 空值 = 跟随全局', s._overridesFrom({ pollIntervalSec: null }).pollIntervalSec === undefined);
  const r = await s.updateTask('t1', { pollIntervalSec: 300 });
  check('updateTask 扁平写法写入 overrides', r.overrides.pollIntervalSec === 300, JSON.stringify(r.overrides));
}

console.log('=== 8. 容错：间隔非法值兜底 ===');
{
  const { s } = makeScheduler({ settings: { pollIntervalSec: 60 }, task: mkTask() });
  check('全局非法 → 兜底 60 秒', s.pollIntervalOf(mkTask({ overrides: {} })) === 60);
  check('过小值下限 10 秒', s.pollIntervalOf(mkTask({ overrides: { pollIntervalSec: 1 } })) === 10, `${s.pollIntervalOf({ overrides: { pollIntervalSec: 1 } })}s`);
}

console.log('=== 9. 录制中：仍必须探测直播状态（下播要能被发现）===');
{
  // 历史 bug：录制中直接 continue 跳过轮询，主播下播后 ffmpeg 因残余数据不退出 → 整夜继续录垃圾段
  const { s, task, calls } = makeScheduler({
    settings: { pollIntervalSec: 60 },
    task: mkTask({ status: 'recording', liveStatus: 'live', autoRecord: true, monitorOnly: false }),
    probe: async () => ({ liveStatus: 'live' }),
  });
  const t0 = Date.now();
  await s.tick();
  check('录制中任务仍然探测（旧实现直接跳过）', calls.length === 1, `探测 ${calls.length} 次`);
  check('录制中探测间隔取系统设置（60 秒，不加额外下限）', near(task.nextPollAt - t0, 60000, 1500), `Δ=${sec(task.nextPollAt - t0)}s`);
  check('录制中探到直播 → 状态保持 recording', task.status === 'recording', task.status);
}

console.log('=== 10. 录制中连续 2 次 offline 才收尾本场 ===');
{
  const stops = [];
  const { s, task } = makeScheduler({
    settings: { pollIntervalSec: 60 },
    task: mkTask({ status: 'recording', liveStatus: 'live', autoRecord: true, monitorOnly: false }),
    probe: async () => ({ liveStatus: 'offline' }),
  });
  s.stopTask = async (id, opts = {}) => { stops.push({ id, reason: opts.reason }); };
  await s.tick();
  check('第 1 次探到 offline 只计数、不收尾（防单次抖动砍断场次）', stops.length === 0, `收尾 ${stops.length} 次`);
  task.nextPollAt = 0;
  await s.tick();
  check('连续 2 次 offline → stopTask(reason=offline)', stops.length === 1 && stops[0].reason === 'offline', JSON.stringify(stops[0] || null));
}

console.log('=== 11. 录制中探活失败不得把任务判成 error ===');
{
  const { s, task } = makeScheduler({
    settings: { pollIntervalSec: 60, reconnectMax: 2 },
    task: mkTask({ status: 'recording', liveStatus: 'live', autoRecord: true, monitorOnly: false }),
    probe: async () => { throw new Error('接口 502'); },
  });
  s.stopTask = async () => { throw new Error('不应停止'); };
  for (let i = 0; i < 4; i++) { task.nextPollAt = 0; await s.tick(); }
  check('连续失败后仍保持 recording（录制本身可能完全正常）', task.status === 'recording', task.status);
  check('失败计数已累计但状态未被改写', task.failCount >= 2, `failCount=${task.failCount}`);
}

console.log('=== 12. 开播通知：每场直播只发一次，下播后下一场能再次通知 ===');
{
  let live = 'live';
  const { s, task, notes } = makeScheduler({
    settings: { pollIntervalSec: 60 },
    task: mkTask({ liveStatus: 'unknown', liveNotifiedAt: null }),
    probe: async () => ({ liveStatus: live }),
  });
  await s.tick();
  check('探到开播 → 发出 1 条 live 通知', notes.length === 1 && notes[0].event === 'live', `通知 ${notes.length} 条`);
  check('通知内容含主播名与时间', /测试主播/.test(notes[0]?.message || '') && /时间：/.test(notes[0]?.message || ''), notes[0]?.message);
  check('本场闩锁已写入 liveNotifiedAt', !!task.liveNotifiedAt);

  task.nextPollAt = 0;
  await s.tick();
  check('仍在播 → 不重复通知（同一场只发一次）', notes.length === 1, `通知 ${notes.length} 条`);

  // 手动停止/重启后 liveStatus 仍是 live 的历史场景：必须靠下播清闩锁，下一场才能再通知
  live = 'offline';
  task.nextPollAt = 0;
  await s.tick();
  check('探到下播 → 清除本场闩锁', task.liveNotifiedAt === null, String(task.liveNotifiedAt));

  live = 'live';
  task.nextPollAt = 0;
  await s.tick();
  check('下一场开播 → 再次通知（旧实现此时永远不发）', notes.length === 2, `通知 ${notes.length} 条`);
}

console.log('=== 13. 创建时已开播 → 排队/并发已满也要先发开播通知 ===');
{
  const { s, task, notes } = makeScheduler({
    settings: { pollIntervalSec: 60 },
    task: mkTask({ status: 'queued', monitorOnly: false, autoRecord: true, liveStatus: 'unknown', liveNotifiedAt: null }),
  });
  // 并发上限已满：_startRecordingInner 会在开录前直接退回 queued
  s.capacity = () => ({ active: 99, global: 1, cap: 1, platformActive: 99 });
  const r = await s._startRecordingInner(task, { reason: 'live' });
  check('容量已满 → 返回 queued', r?.queued === true, JSON.stringify(r));
  check('排队中仍然发出了开播通知（否则永远卡在 queued 走不到轮询分支）', notes.length === 1 && notes[0].event === 'live', `通知 ${notes.length} 条`);
  check('liveStatus 记为 live', task.liveStatus === 'live', String(task.liveStatus));
}

console.log('=== 14. 上报文案与去重：通知走 Notifier 的事件开关 ===');
{
  const { s, task, notes } = makeScheduler({
    settings: { pollIntervalSec: 60 },
    task: mkTask({ liveStatus: 'unknown', liveNotifiedAt: null }),
  });
  const first = await s._noteLiveDetected(task, { source: '轮询' });
  const again = await s._noteLiveDetected(task, { source: '轮询' });
  check('首次通知返回 true，重复返回 false', first === true && again === false, `${first}/${again}`);
  check('重复调用没有多发通知', notes.length === 1, `通知 ${notes.length} 条`);
  check('meta 带 taskId/taskName 供去重使用', notes[0]?.meta?.taskId === 't1' && notes[0]?.meta?.taskName === '测试主播', JSON.stringify(notes[0]?.meta));
}

console.log('\n================ 结果 ================');
console.log(`PASS ${pass} ｜ FAIL ${fail}`);
process.exit(fail ? 1 : 0);
