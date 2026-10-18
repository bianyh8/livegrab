// LiveGrab 大数据量测试：用尽可能多的数据压出「小样本永远测不到」的问题。
//
// 为什么需要它：上一轮的性能优化（store 按 id 索引、日志按文件偏移增量读 + 增量过滤缓存、
// 扫描用倒排表代替 O(n²) 查找）在几十条数据的单元测试里完全没有区别——O(n²) 要几千条才肉痛，
// 分页边界要跨页才暴露，索引失效要「写操作之后再读」才现形。这里用几千任务/上万文件/几十万行
// 日志把三类问题一起压出来，并且每个结果都与「旧算法/暴力算法」做黄金比对，而不是只看跑得快。
//
// 运行：node app/test/load.mjs
// 规模：默认已按「尽可能多」给量（见下方常量）；LOAD_SCALE=2/4 可成倍放大，=0.2 可快速冒烟。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { Store } from '../server/store.js';
import { openDb } from '../server/db.js';
import { Logger } from '../server/logger.js';
import { Storage } from '../server/storage.js';
import { compareFileRow, sortFileRows } from '../server/file-order.js';
import { parseRange, safeJoin, uid } from '../server/util.js';
import { seekRatio } from '../web/ui.js';
import * as resolvers from '../server/resolvers/index.js';

/* ---------------- 规模 ---------------- */
const SCALE = (() => {
  const v = String(process.env.LOAD_SCALE || '1').toLowerCase();
  if (v === 'max') return 4;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
const N = (base) => Math.max(1, Math.round(base * SCALE));

const TASKS = N(2000);          // 任务
const SESSIONS = N(1200);       // 场次
const SEG_PER = 5;              // 每场次分段数
const EXTERNAL = N(800);        // 未归属任何场次的外部文件
const SCAN_FILES = N(1500);     // 磁盘上真实落地的媒体文件
const LOG_API_LINES = Math.min(N(5000), 5000); // 走 Logger API 写入（覆盖写入链/行尾解析，成本上限 ~5s）
const LOG_BULK_LINES = N(200000); // 直接追加到日志文件（覆盖大文件增量读/分页）

const tmpRoot = path.join(os.tmpdir(), `livegrab-load-${Date.now()}`);
const p = (...a) => path.join(tmpRoot, ...a);
const ms = (t) => `${t.toFixed(0)}ms`;
const r2 = (n) => Math.round(n * 100) / 100;

/* ---------------- 断言 ---------------- */
let passed = 0;
let failed = 0;
const failures = [];
const timings = [];
let currentSuite = '';

function suite(name) { currentSuite = name; console.log(`\n— ${name} —`); }
function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${extra ? `  → ${extra}` : ''}`); } else {
    failed++; failures.push(`${currentSuite} / ${label}`);
    console.log(`  FAIL  ${label}${extra ? `  → ${extra}` : ''}`);
  }
}
const eq = (a, b, label) => ok(String(a) === String(b), label, `期望 ${b}，实际 ${a}`);
const timed = (label, t0) => { const d = performance.now() - t0; timings.push({ label, ms: d }); return d; };

/** 可复现的伪随机（不用 Math.random，失败时可重跑复现） */
let seed = 20261018;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function openStore(dir) {
  const db = openDb(path.join(dir, 'livegrab.db'));
  return new Store(dir).init(db);
}
async function rmrf(d) { await fsp.rm(d, { recursive: true, force: true }).catch(() => {}); }

/* ============ 1. store 索引：上万文件 + 逐条黄金校验 ============ */
async function testIndexScale() {
  const fileCount = SESSIONS * (SEG_PER + 2) + EXTERNAL;
  suite(`store 索引：${TASKS} 任务 / ${SESSIONS} 场次 / ${fileCount} 文件`);
  const dir = p('scale');
  const store = await openStore(dir);

  let t = performance.now();
  for (let i = 0; i < TASKS; i++) {
    await store.addTask(Store.newTask({
      anchorName: `主播${i}`, roomId: String(200000 + i), platform: 'bilibili',
      status: i % 3 ? 'idle' : 'stopped', totalBytes: i * 1024,
    }));
  }
  const taskMs = timed(`写入 ${TASKS} 个任务`, t);

  // fileId → 期望归属（sessionId 为 null 表示外部文件）
  const expect = new Map();
  t = performance.now();
  for (let i = 0; i < SESSIONS; i++) {
    const sid = `s_scale_${i}`;
    const segments = [];
    for (let k = 0; k < SEG_PER; k++) {
      const f = { id: `f_${i}_${k}`, path: `/rec/${i}/${k}.ts`, kind: 'segment', segmentIndex: k, bytes: 1000 + k, status: 'ok' };
      segments.push(f);
      expect.set(f.id, { sessionId: sid, path: f.path });
    }
    const merged = { id: `f_${i}_m`, path: `/rec/${i}/merged.ts`, kind: 'merged', bytes: 5000, status: 'ok' };
    const mp4 = { id: `f_${i}_p`, path: `/rec/${i}/merged.mp4`, kind: 'mp4', bytes: 4000, status: 'ok' };
    expect.set(merged.id, { sessionId: sid, path: merged.path });
    expect.set(mp4.id, { sessionId: sid, path: mp4.path });
    await store.addSession({
      id: sid, taskId: `t_scale_${i}`, platform: 'bilibili', platformName: '哔哩哔哩',
      roomId: String(300000 + i), streamer: `主播${i}`, title: `第 ${i} 场`,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60000).toISOString(),
      durationSec: 600 + i, bytes: 9000, status: 'ok',
      dir: `/rec/${i}`, relDir: `${i}`,
      segments, extras: [merged, mp4], merged, mp4,
    });
  }
  const sessMs = timed(`写入 ${SESSIONS} 个场次（含 ${SESSIONS * (SEG_PER + 2)} 个文件行）`, t);

  // 外部文件（不归属场次）：findFile 必须返回 session=null
  for (let i = 0; i < EXTERNAL; i++) {
    const f = { id: `f_ext_${i}`, path: `/rec/ext/${i}.mp4`, kind: 'unregistered', bytes: 2000, status: 'ok' };
    store.state.external.push(f);
    expect.set(f.id, { sessionId: null, path: f.path });
  }
  t = performance.now();
  await store.persist(); // 落库 + 让索引失效
  const persistMs = timed(`persist() 全量对账（${expect.size} 个文件）`, t);

  const idx = store._index();
  eq(idx.files.size, expect.size, '索引内文件 id 数量与预期一致');
  eq(idx.tasks.size, TASKS, '索引内任务数正确');
  eq(idx.sessions.size, SESSIONS, '索引内场次数正确');

  // 全量逐条核对（不是抽样）：每个 id 都要指回正确路径与正确场次
  t = performance.now();
  let bad = 0;
  const badSamples = [];
  for (const [id, exp] of expect) {
    const hit = store.findFile(id);
    const sess = store.sessionOfFile(id);
    const sessId = sess ? sess.id : null;
    if (!hit || hit.file.id !== id || hit.file.path !== exp.path || sessId !== exp.sessionId) {
      bad++;
      if (badSamples.length < 3) badSamples.push(`${id}→${hit ? hit.file.path : 'null'}/${sessId}`);
    }
  }
  const verifyMs = timed(`逐个核对 ${expect.size} 个文件 id 的归属`, t);
  eq(bad, 0, `全部 ${expect.size} 个文件 id 归属正确（findFile + sessionOfFile）`, badSamples.join(' | '));

  // 黄金校验：与旧的全库线性扫描实现比对，确保索引化没有改变语义
  const ids = [...expect.keys()];
  let diff = 0;
  for (let i = 0; i < 300; i++) {
    const id = ids[Math.floor(rnd() * ids.length)];
    const a = store.sessionOfFile(id);
    const b = store._sessionOfFileLinear(id);
    if ((a && a.id) !== (b && b.id)) diff++;
  }
  eq(diff, 0, '与旧线性扫描实现抽样 300 个比对结果一致（黄金校验）');

  // 性能：索引命中 vs 线性兜底
  t = performance.now();
  const HITS = 50000;
  for (let i = 0; i < HITS; i++) store.findFile(ids[i % ids.length]);
  const hitMs = timed(`${HITS} 次 findFile（索引命中）`, t);
  t = performance.now();
  const LINS = 300;
  for (let i = 0; i < LINS; i++) store._sessionOfFileLinear(ids[i]);
  const linMs = timed(`${LINS} 次线性扫描（旧算法）`, t);
  const hitPer = hitMs / HITS;
  const linPer = linMs / LINS;
  ok(linPer / hitPer > 5, '索引单次查询明显快于线性扫描', `索引 ${r2(hitPer * 1000)}µs/次 vs 线性 ${r2(linPer * 1000)}µs/次（×${r2(linPer / hitPer)}）`);

  /* ---- 索引失效：任何写操作后读取都必须看到新状态 ---- */
  const victim = store.state.sessions[0];
  const victimFileId = victim.segments[0].id;
  ok(store.findFile(victimFileId) !== null, '删除前能查到该场次文件');
  await store.removeSession(victim.id);
  eq(store.findFile(victimFileId), null, 'removeSession 后索引已失效，旧文件不再被查到');
  eq(store.getSession(victim.id), null, 'removeSession 后 getSession 返回 null');

  const fresh = Store.newTask({ anchorName: '写后读一致' });
  await store.addTask(fresh);
  ok(store.getTask(fresh.id) !== null, 'addTask 后立刻能按 id 取到（索引已重建）');
  ok(store.findFile(ids[0]) !== null, '写操作重建索引后，既有文件仍能查到');

  // 边界场景：分段被就地 push 进会话数组、但还没 saveSession（索引里没有该 id）→ 线性兜底必须补上
  const late = { id: uid('f'), path: '/rec/late/1.ts', kind: 'segment', segmentIndex: 99, bytes: 1, status: 'ok' };
  const owner = store.state.sessions[1];
  store.findFile(owner.segments[0].id); // 先把索引焐热（确保此刻缓存里没有 late.id）
  owner.segments.push(late);
  const lateHit = store.findFile(late.id);
  eq(lateHit && lateHit.session && lateHit.session.id, owner.id, '索引未覆盖的就地新增分段，靠线性兜底仍能查到（不丢文件）');

  /* ---- 持久层：大库重开必须完整恢复 ---- */
  const expectTasks = store.state.tasks.length;
  const expectSessions = store.state.sessions.length;
  t = performance.now();
  const reloaded = await openStore(dir);
  const reloadMs = timed('重开库（加载全部任务/场次/文件）', t);
  eq(reloaded.tasks.length, expectTasks, '重开后任务数一致');
  eq(reloaded.sessions.length, expectSessions, '重开场次数一致');
  let spotBad = 0;
  for (let i = 0; i < 40; i++) {
    const s = reloaded.state.sessions[Math.floor(rnd() * reloaded.state.sessions.length)];
    if (!s) { spotBad++; continue; }
    const found = reloaded.findFile([...(s.segments || []), s.merged, s.mp4].filter(Boolean)[0].id);
    if (!found || found.session.id !== s.id) spotBad++;
  }
  eq(spotBad, 0, '重开后随取 40 个场次，文件归属仍正确');
  reloaded.close();

  store.close();
  console.log(`    （任务 ${ms(taskMs)} / 场次 ${ms(sessMs)} / persist ${ms(persistMs)} / 全量核对 ${ms(verifyMs)} / 重载 ${ms(reloadMs)}）`);
}

/* ============ 2. 磁盘扫描：真实落地上千文件 ============ */
async function testScanScale() {
  suite(`文件扫描：${SCAN_FILES} 个真实磁盘文件（20×7 目录）`);
  const dir = p('scan');
  const store = await openStore(dir);
  const root = path.join(dir, 'record');
  store.settings.recordRoot = root;
  await fsp.mkdir(root, { recursive: true });
  const logger = await new Logger({ dir: path.join(dir, 'logs'), level: 'WARN' }).init();

  const dirs = [];
  for (let a = 0; a < 20; a++) {
    for (let b = 0; b < 7; b++) {
      const d = path.join(root, `主播${a}`, `2026-01-${String(b + 1).padStart(2, '0')}`);
      await fsp.mkdir(d, { recursive: true });
      dirs.push(d);
    }
  }
  const created = [];
  let t = performance.now();
  for (let i = 0; i < SCAN_FILES; i++) {
    const name = `${String(i).padStart(6, '0')}${i % 4 ? '.ts' : '.mp4'}`;
    const f = path.join(dirs[i % dirs.length], name);
    // 大小各不相同，便于校验 bytes 是否正确回填
    await fsp.writeFile(f, Buffer.alloc(64 + (i % 900)));
    created.push(f);
  }
  const writeMs = timed(`创建 ${SCAN_FILES} 个文件`, t);

  const storage = new Storage({ store, logger });
  t = performance.now();
  const r1 = await storage.scan();
  const ms1 = timed('首次扫描（全部未登记）', t);
  eq(r1.total, SCAN_FILES, '扫描发现的媒体文件数正确');
  eq(r1.added, SCAN_FILES, '首次扫描全部自动登记为场次');
  eq(r1.missing, 0, '首次扫描没有误报缺失');

  const paths = store.allFiles().map((f) => f.path);
  eq(new Set(paths).size, SCAN_FILES, '登记后文件路径唯一（无重复条目）');
  ok(created.every((f) => paths.includes(f)), '每个磁盘文件都能在索引里查到');
  const bytesOk = created.every((f, i) => {
    const hit = store.allFiles().find((x) => x.path === f);
    return hit && Number(hit.bytes) === 64 + (i % 900);
  });
  ok(bytesOk, '登记的文件大小与磁盘真实大小一致');

  t = performance.now();
  const r2 = await storage.scan();
  const ms2 = timed('二次扫描（无变化）', t);
  eq(r2.added + r2.updated + r2.missing + r2.cleaned, 0, '二次扫描完全幂等（不重复登记、不误标缺失）');

  const drop = created.slice(0, Math.max(1, Math.round(SCAN_FILES * 0.1)));
  for (const f of drop) await fsp.rm(f, { force: true });
  t = performance.now();
  const r3 = await storage.scan();
  const ms3 = timed(`删除 ${drop.length} 个文件后再扫描`, t);
  eq(r3.missing, drop.length, `删除的 ${drop.length} 个文件全部标记缺失`);
  eq(r3.added, 0, '删除后扫描不产生新增（不会把缺失文件重新登记）');

  eq(store.trash.length, 0, '扫描过程不产生回收站条目');
  const disk = storage.disk();
  ok(disk.recordRoot === root && Number(disk.trashFiles) === 0, 'disk() 汇总走内存索引，回收站为空', `trashFiles=${disk.trashFiles}`);

  console.log(`    （建文件 ${ms(writeMs)} / 首扫 ${ms(ms1)} / 幂等复扫 ${ms(ms2)} / 删除后复扫 ${ms(ms3)}）`);
  await logger.close?.();
  store.close();
}

/* ============ 3. 日志：20 万行 + 分页/过滤黄金校验 ============ */
async function testLogScale() {
  const total = LOG_BULK_LINES;
  suite(`运行日志：${total} 行（${LOG_API_LINES} 行走写入链 + 其余直连文件）`);
  const dir = p('log');
  const logger = await new Logger({ dir, level: 'DEBUG' }).init();

  const isErr = (i) => i % 11 === 0;
  const isWarn = (i) => !isErr(i) && i % 7 === 0;
  const levelOf = (i) => (isErr(i) ? 'ERROR' : isWarn(i) ? 'WARN' : 'INFO');
  const taskOf = (i) => (i % 3 === 0 ? `t_${i % 40}` : null);
  const nameOf = (i) => (i % 3 === 0 ? `主播${i % 40}` : '');
  const msgOf = (i) => `load #${i} 事件${i % 97} marker${i % 1000}${i === 3 ? ' FIRSTLINE' : ''}`;
  const tsOf = (i) => new Date(Date.UTC(2026, 0, 1) + i * 7).toISOString();

  const limit = Math.min(LOG_API_LINES, total);
  let t = performance.now();
  for (let i = 0; i < limit; i++) {
    const meta = taskOf(i) ? { taskId: taskOf(i), taskName: nameOf(i) } : {};
    logger.log(levelOf(i), msgOf(i), meta);
  }
  await logger._chain; // 等写入链落盘，避免与下面的大批量追加交错
  const apiMs = timed(`Logger API 写入 ${limit} 行`, t);

  t = performance.now();
  const chunk = [];
  for (let i = limit; i < total; i++) {
    chunk.push(JSON.stringify({ ts: tsOf(i), level: levelOf(i), taskId: taskOf(i), taskName: nameOf(i) || null, msg: msgOf(i) }));
    if (chunk.length >= 5000) { fs.appendFileSync(logger.currentFile(), `${chunk.join('\n')}\n`); chunk.length = 0; }
  }
  if (chunk.length) fs.appendFileSync(logger.currentFile(), `${chunk.join('\n')}\n`);
  const bulkMs = timed(`直连追加其余 ${total - limit} 行`, t);

  // 期望值（与生成规则一致，独立算一遍）
  let nErr = 0; let nWarn = 0; let nTask7 = 0; let nMarker = 0;
  for (let i = 0; i < total; i++) {
    if (isErr(i)) nErr++;
    if (isWarn(i)) nWarn++;
    if (taskOf(i) === 't_7') nTask7++;
    if (i % 1000 === 420) nMarker++;
  }

  t = performance.now();
  const q1 = await logger.queryPage({ page: 1, pageSize: 50, order: 'desc' });
  const firstMs = timed('首次查询（冷启动，需读完整个文件）', t);
  eq(q1.total, total, `总条数与写入行数一致（${total}）`);
  eq(q1.pages, Math.ceil(total / 50), '总页数正确');
  eq(q1.items[0].msg, msgOf(total - 1), '降序第一页第一条就是最新一行');
  eq(q1.items.length, 50, '降序第一页满 50 条');

  const qa = await logger.queryPage({ page: 1, pageSize: 50, order: 'asc' });
  eq(qa.items[0].msg, msgOf(0), '升序第一页第一条就是最早一行（第 0 行）');

  // 翻完所有页：条数、顺序、无重复无遗漏
  t = performance.now();
  const PS = 5000;
  const pages = Math.ceil(total / PS);
  const seenMsgs = [];
  for (let pg = 1; pg <= pages; pg++) {
    const r = await logger.queryPage({ page: pg, pageSize: PS, order: 'asc' });
    for (const it of r.items) seenMsgs.push(it.msg);
  }
  const sweepMs = timed(`升序翻完 ${pages} 页（每页 ${PS}）`, t);
  eq(seenMsgs.length, total, '翻完所有页的条数等于总条数（无遗漏）');
  eq(new Set(seenMsgs).size, total, '跨页无重复行');
  let orderBad = 0;
  for (let i = 0; i < seenMsgs.length; i++) if (seenMsgs[i] !== msgOf(i)) { orderBad++; if (orderBad > 3) break; }
  eq(orderBad, 0, '跨页顺序严格连续（第 i 条就是第 i 行，不多不少）');

  // 降序最后一页 = 升序第一页的反转
  const qdLast = await logger.queryPage({ page: pages, pageSize: PS, order: 'desc' });
  eq(qdLast.items[qdLast.items.length - 1].msg, msgOf(0), '降序最后一页的最后一条是最早一行');

  // 过滤结果与暴力统计一致
  const e1 = await logger.queryPage({ level: 'ERROR', page: 1, pageSize: 10 });
  eq(e1.total, nErr, 'level=ERROR 过滤条数与暴力统计一致');
  const w1 = await logger.queryPage({ level: 'WARN', page: 1, pageSize: 10 });
  eq(w1.total, nWarn, 'level=WARN 过滤条数与暴力统计一致');
  const t1q = await logger.queryPage({ taskId: 't_7', page: 1, pageSize: 10 });
  eq(t1q.total, nTask7, 'taskId 过滤条数与暴力统计一致');
  ok(t1q.tasks.some((x) => x.id === 't_7'), '过滤结果带回任务下拉项');
  const k1 = await logger.queryPage({ q: 'marker420', page: 1, pageSize: 10 });
  eq(k1.total, nMarker, '关键词过滤条数与暴力统计一致');
  const k2 = await logger.queryPage({ q: 'marker420', level: 'ERROR', taskId: 't_7', page: 1, pageSize: 10 });
  let nCombo = 0;
  for (let i = 0; i < total; i++) if (i % 1000 === 420 && isErr(i) && taskOf(i) === 't_7') nCombo++;
  eq(k2.total, nCombo, '三个条件组合过滤与暴力统计一致');

  /* 关键回归（上一轮踩过的坑）：
     「最早那条日志」在降序分页里远在第 1 页之外，只能用搜索定位——正是 e2e 用例曾经写错的地方。
     这里直接验证「跨页可检索」：不翻页，用关键词把第 4 行捞出来。 */
  const qFirst = await logger.queryPage({ q: 'FIRSTLINE', page: 1, pageSize: 10, order: 'desc' });
  eq(qFirst.total, 1, '关键词能定位到很早的行（不依赖翻页）');
  ok(qFirst.items[0] && qFirst.items[0].msg === msgOf(3), '搜到的正是第 4 行（启动日志位置）', qFirst.items[0]?.msg);
  const descPage1 = await logger.queryPage({ page: 1, pageSize: 50, order: 'desc' });
  ok(!descPage1.items.some((x) => x.msg === msgOf(3)), '同一行确实不在降序第 1 页（复现分页错位场景）');

  /* 性能：三种典型场景 */
  t = performance.now();
  for (let i = 0; i < 20; i++) await logger.queryPage({ page: 1, pageSize: 50, order: 'desc' });
  const repeatMs = timed('重复查询 20 次（筛选条件不变、无新日志）', t);

  // 追加 200 行后立刻查：必须能看到新行（增量读只读新字节）
  for (let i = 0; i < 200; i++) logger.info(`append #${i} marker9001`);
  await logger._chain;
  t = performance.now();
  const qAfter = await logger.queryPage({ page: 1, pageSize: 50, order: 'desc' });
  const afterMs = timed('追加 200 行后查询', t);
  eq(qAfter.total, total + 200, '追加后总条数正确（增量读没有漏掉新字节）');
  eq(qAfter.items[0].msg, 'append #199 marker9001', '追加后第一页第一条是最新追加行');
  const kNew = await logger.queryPage({ q: 'marker9001', page: 1, pageSize: 50 });
  eq(kNew.total, 200, '新追加的行可被关键词检索');

  // 外部直接删行重建（模拟日志被清空）不该让缓存错乱
  t = performance.now();
  const kwQ = await logger.queryPage({ q: 'marker777', page: 1, pageSize: 50 });
  const rebuildMs = timed('更换关键词（重建过滤缓存）', t);
  const nMarker777 = Math.floor((total - 1 - 777) / 1000) + 1;
  eq(kwQ.total, nMarker777, '换词后条数仍正确（与暴力统计一致）');

  console.log(`    （API 写入 ${ms(apiMs)} / 批量追加 ${ms(bulkMs)} / 首次查询 ${ms(firstMs)} / 全量翻页 ${ms(sweepMs)} / 重复查询 ${ms(repeatMs)} / 追加后 ${ms(afterMs)} / 换词 ${ms(rebuildMs)}）`);
  ok(firstMs < 30000, '冷启动读完整份日志仍在 30s 内（大文件可接受）', ms(firstMs));
  ok(repeatMs / 20 < 50, '重复查询单次 < 50ms（走增量过滤缓存）', `${r2(repeatMs / 20)}ms/次`);
}

/* ============ 4. 纯函数：大数据 + 边界表 ============ */
async function testPureFns() {
  suite('纯函数：大数组排序 + 边界用例表');

  // 2 万行文件排序：比较器必须自洽（相邻两两有序 → 传递性成立），且不丢行
  const rows = [];
  for (let i = 0; i < 20000; i++) {
    rows.push({
      f: { id: `f${i}`, name: `第${i}.ts`, kind: ['segment', 'merged', 'mp4'][i % 3], segmentIndex: i % 50, bytes: (i * 37) % 10000 },
      s: { id: `s${i % 800}`, startedAt: new Date(Date.UTC(2026, 0, 1) + (i % 400) * 3600000).toISOString(), streamer: `主播${i % 37}`, platform: i % 2 ? 'bilibili' : 'douyin' },
    });
  }
  const digest = (arr) => arr.map((x) => x.f.id).sort().join(',').length + ':' + arr.reduce((n, x) => n + x.f.bytes, 0);
  const before = digest(rows);
  const t0 = performance.now();
  sortFileRows(rows);
  const sortMs = timed('排序 20000 行文件', t0);
  eq(rows.length, 20000, '排序后行数不变（无丢行）');
  eq(digest(rows), before, '排序只是重排，不增不删（长度+字节合计一致）');
  let unordered = 0;
  for (let i = 1; i < rows.length; i++) if (compareFileRow(rows[i - 1], rows[i]) > 0) unordered++;
  eq(unordered, 0, '相邻两两满足比较器顺序（比较器自洽/可传递）');

  const again = rows.slice();
  sortFileRows(again);
  ok(again.every((x, i) => x.f.id === rows[i].f.id), '重复排序结果稳定（无随机性）');

  // parseRange 边界表
  const RANGE_CASES = [
    ['bytes=0-99', 1000, { start: 0, end: 99 }],
    ['bytes=900-', 1000, { start: 900, end: 999 }],
    ['bytes=-100', 1000, { start: 900, end: 999 }],
    ['bytes=0-9999', 1000, { start: 0, end: 999 }],
    ['bytes=-99999', 1000, { start: 0, end: 999 }],
    ['bytes=999-999', 1000, { start: 999, end: 999 }],
    ['bytes=1000-', 1000, 'invalid'],
    ['bytes=1000-1001', 1000, 'invalid'],
    ['bytes=100-99', 1000, 'invalid'],
    ['bytes=-0', 1000, 'invalid'],
    ['bytes=-', 1000, 'invalid'],
    ['bytes=a-b', 1000, 'invalid'],
    ['bytes=0-1-2', 1000, 'invalid'],
    ['Bytes=0-1', 1000, null],
    ['', 1000, null],
    [null, 1000, null],
  ];
  let rcBad = 0;
  for (const [h, size, exp] of RANGE_CASES) {
    const got = parseRange(h, size);
    const same = exp === null || exp === 'invalid'
      ? got === exp
      : got && got.start === exp.start && got.end === exp.end;
    if (!same) {
      rcBad++;
      console.log(`        差异：${JSON.stringify(h)} size=${size} → ${JSON.stringify(got)}（期望 ${JSON.stringify(exp)}）`);
    }
  }
  eq(rcBad, 0, `parseRange 边界用例 ${RANGE_CASES.length} 条全部符合预期`);

  // seekRatio 边界表
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  const SEEK_CASES = [
    [100, 50, false, 0], [500, 50, false, 1], [300, 50, false, 0.5],
    [0, 50, false, 0], [9999, 50, false, 1],
    [100, 50, true, 0], [100, 250, true, 1], [100, 150, true, 0.5],
    [100, 0, true, 0], [100, 9999, true, 1],
  ];
  let scBad = 0;
  for (const [x, y, rot, exp] of SEEK_CASES) {
    const got = seekRatio(rect, x, y, rot);
    if (Math.abs(got - exp) > 1e-9) { scBad++; console.log(`        差异：(${x},${y},rot=${rot}) → ${got}（期望 ${exp}）`); }
  }
  eq(scBad, 0, `seekRatio 边界用例 ${SEEK_CASES.length} 条全部符合预期`);
  ok(seekRatio({ left: 0, top: 0, width: 0, height: 0 }, 10, 10) === 0, '零宽度不产生 NaN，退化为 0');

  // safeJoin 越界矩阵
  const SAFE_CASES = [
    ['/data', 'a.ts', true], ['/data', 'a/b/c.ts', true], ['/data', './a.ts', true],
    ['/data', '../etc/passwd', false], ['/data', 'a/../../x', false],
    ['/data', '/etc/passwd', false], ['/data', 'a/../../../x', false],
    ['/data', 'a\\..\\..\\x', false],
  ];
  let sjBad = 0;
  for (const [root, rel, allowed] of SAFE_CASES) {
    let threw = false;
    try { safeJoin(root, rel); } catch { threw = true; }
    if (threw === allowed) { sjBad++; console.log(`        差异：${root} + ${rel} → ${threw ? '抛错' : '通过'}（期望 ${allowed ? '通过' : '抛错'}）`); }
  }
  eq(sjBad, 0, `safeJoin 越界用例 ${SAFE_CASES.length} 条全部符合预期`);
  console.log(`    （排序 20000 行 ${ms(sortMs)}）`);
}

/* ============ 5. 平台识别：真实 URL 形态大表 ============ */
async function testResolverMatrix() {
  suite('平台识别：真实 URL 形态大表');
  // [输入, 期望平台, 期望房间号（null 表示不断言房间号）]
  // 期望值取自各平台 handler 的真实正则，不靠猜：null 的几行是「按设计不识别」的负例
  const URLS = [
    ['https://live.douyin.com/123456789', 'douyin', '123456789'],
    ['https://live.douyin.com/123456789?enter_from=web', 'douyin', '123456789'],
    ['https://v.douyin.com/iAbCdEf/', 'douyin', 'iAbCdEf'],
    ['https://www.douyin.com/user/MS4wLjABAAAA', 'douyin', 'MS4wLjABAAAA'],
    ['https://www.douyin.com/follow?modal_id=7311', null, null],
    ['https://live.bilibili.com/22637261', 'bilibili', '22637261'],
    ['https://live.bilibili.com/blanc/22637261', 'bilibili', '22637261'],
    ['https://live.bilibili.com/22637261?broadcast_type=0', 'bilibili', '22637261'],
    ['https://b23.tv/av12345', 'bilibili', 'av12345'],
    ['https://space.bilibili.com/12345', null, null],
    ['https://www.huya.com/660000', 'huya', '660000'],
    ['https://www.huya.com/660000?from=search', 'huya', '660000'],
    ['https://m.huya.com/660000', 'huya', '660000'],
    ['https://www.douyu.com/9999', 'douyu', '9999'],
    ['https://www.douyu.com/9999?_from=1', 'douyu', '9999'],
    ['https://m.douyu.com/9999', 'douyu', '9999'],
    ['https://live.kuaishou.com/u/abcDEF123', 'kuaishou', 'abcDEF123'],
    ['https://live.kuaishou.com/u/abcDEF123?fid=1', 'kuaishou', 'abcDEF123'],
    ['https://www.acfun.cn/live/1234567', 'acfun', null],
    ['https://live.acfun.cn/live/1234567', 'acfun', null],
    ['https://www.xiaohongshu.com/user/profile/abc', 'xiaohongshu', null],
    ['https://weibo.com/u/1234567890', 'weibo', null],
    ['https://example.com/a/b.m3u8', 'direct', null],
    ['https://example.com/a/b.flv?token=x', 'direct', null],
    ['http://1.2.3.4:8080/live/stream.ts', 'direct', null],
    ['https://cdn.example.com/hls/index.m3u8?auth=abc&expire=1', 'direct', null],
    ['rtmp://live.example.com/app/stream', null, null],
    ['https://example.com/page.html', null, null],
    ['bilibili:22637261', 'bilibili', '22637261'],
    ['douyin:123456789', 'douyin', '123456789'],
    ['huya:660000', 'huya', '660000'],
    ['fdsafdsafdsa', null, null],
    ['', null, null],
  ];
  let bad = 0;
  for (const [url, plat, room] of URLS) {
    const got = resolvers.detectPlatform(url);
    if (got !== plat) { bad++; console.log(`        差异：${JSON.stringify(url)} → ${got}（期望 ${plat}）`); continue; }
    if (plat && room) eq(resolvers.roomIdFrom(plat, url), room, `房间号提取：${url}`);
  }
  eq(bad, 0, `${URLS.length} 条 URL 平台识别全部正确`);

  // 直链解析：无需网络
  const info = await resolvers.resolveRoom('https://example.com/demo.m3u8', { settings: {} });
  eq(info.platform, 'direct', '直链解析出 direct 平台');
  eq(info.liveStatus, 'live', '直链视为可录');
  ok(Array.isArray(info.qualityOptions) && info.qualityOptions.length >= 1, '直链返回清晰度选项');
}

/* ============ 入口 ============ */
(async () => {
  console.log(`LiveGrab 大数据量测试（临时目录 ${tmpRoot}，规模 ×${SCALE}）`);
  console.log(`  任务 ${TASKS} / 场次 ${SESSIONS} / 外部文件 ${EXTERNAL} / 磁盘文件 ${SCAN_FILES} / 日志 ${LOG_BULK_LINES} 行`);
  await rmrf(tmpRoot);
  await fsp.mkdir(tmpRoot, { recursive: true });
  const suites = [testIndexScale, testScanScale, testLogScale, testPureFns, testResolverMatrix];
  for (const s of suites) {
    try { await s(); } catch (e) {
      failed++;
      failures.push(`${currentSuite} / 异常抛出：${e.message}`);
      console.log(`  FAIL  套件异常：${e.stack}`);
    }
  }
  console.log('\n================ 耗时汇总 ================');
  for (const { label, ms: v } of timings.sort((a, b) => b.ms - a.ms).slice(0, 12)) {
    console.log(`  ${String(Math.round(v)).padStart(6)}ms  ${label}`);
  }
  console.log('\n================ 结果 ================');
  console.log(`PASS ${passed} ｜ FAIL ${failed}`);
  if (failures.length) { console.log('失败清单：'); for (const f of failures) console.log(`  - ${f}`); }
  await rmrf(tmpRoot);
  process.exit(failed ? 1 : 0);
})();
