// LiveGrab 自带测试：无框架、无外部依赖
// 运行：node app/test/run.js      （没有 ffmpeg / 没有网络也能全绿）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as naming from '../server/naming.js';
import { Store, DEFAULT_SETTINGS, deepMerge } from '../server/store.js';
import { openDb } from '../server/db.js';
import { Logger } from '../server/logger.js';
import { Storage } from '../server/storage.js';
import { Notifier } from '../server/notify.js';
import { Scheduler } from '../server/scheduler.js';
import { Auth, parseCookies } from '../server/auth.js';
import { PlayManager } from '../server/play.js';
import * as resolvers from '../server/resolvers/index.js';
import * as proxyFetch from '../server/proxy-fetch.js';
import { buildRecordArgs } from '../server/media.js';
import { isPullBlocked, reconnectDelay, Recorder } from '../server/recorder.js';
import { sortFileRows } from '../server/file-order.js';
import { byteLength, parseRange, safeJoin, formatBytes, formatDuration, HttpError, uid, VERSION, errText } from '../server/util.js';
import { seekRatio } from '../web/ui.js';
import * as fakeMedia from './fake-media.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const SERVER = path.join(APP_DIR, 'server', 'server.js');

/** 测试用：在指定目录打开（或新建）v2 库并加载 store —— 与 server.js bootstrap 同一条路径 */
async function openStore(dir) {
  const db = openDb(path.join(dir, 'livegrab.db'));
  return new Store(dir).init(db);
}

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

function suite(name) { currentSuite = name; console.log(`\n— ${name} —`); }

function ok(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}${extra ? `  → ${extra}` : ''}`);
  } else {
    failed++;
    failures.push(`${currentSuite} / ${label}`);
    console.log(`  FAIL  ${label}${extra ? `  → ${extra}` : ''}`);
  }
}
const eq = (a, b, label) => ok(String(a) === String(b), label, `期望 ${b}，实际 ${a}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpRoot = path.join(os.tmpdir(), `livegrab-test-${Date.now()}`);
const p = (...a) => path.join(tmpRoot, ...a);

async function rmrf(dir) { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }

// ============ 1. 命名引擎 ============
async function testNaming() {
  suite('命名规则引擎');
  const ctx = {
    startAt: new Date(2025, 5, 1, 20, 13, 5),
    options: { ...naming.DEFAULT_OPTIONS },
    vars: {
      '{主播}': '某某小主播', '{平台}': '抖音', '{房间号}': '23456789', '{标题}': '今天打排位 冲王者',
      '{清晰度}': '原画', '{任务}': 'task_07', '{分辨率}': '1920x1080', '{时长}': '01-00-00', '{自定义}': '自定义',
    },
  };
  const r1 = naming.renderName('{日期}_{主播}_{清晰度}_{序号}', ctx, 3);
  eq(r1.name, '2025-06-01_某某小主播_原画_003', '变量替换 + 序号补零');
  ok(byteLength(r1.name) > r1.name.length, '按字节统计（中文 3 字节）', `${r1.name.length} 字符 / ${byteLength(r1.name)} 字节`);

  const r2 = naming.renderName('{不存在}_{主播}', ctx, 1);
  ok(r2.unknown.includes('{不存在}'), '未知变量被记录并原样保留');
  ok(r2.name.includes('{不存在}'), '未知变量保留在名称里');

  const illegal = naming.sanitizeComponent('a/b\\c:d*e?f"g<h>i|j', 'replace');
  eq(illegal, 'a_b_c_d_e_f_g_h_i_j', '非法字符 → 下划线（跨平台并集）');
  eq(naming.sanitizeComponent('a/b:c', 'drop'), 'abc', '非法字符 → 删除');
  eq(naming.sanitizeComponent('a/b:c', 'keep'), 'a_b:c', '保留模式保留 : 但仍挡住路径分隔符');
  eq(naming.sanitizeComponent('a\\b/c', 'keep'), 'a_b_c', '保留模式挡住反斜杠');
  eq(naming.sanitizeComponent('  ..名字..  ', 'replace'), '名字', '去首尾空格与点');

  const long = naming.renderName('{标题}'.repeat(30) + '_{序号}', ctx, 1);
  ok(long.overlong, '超长名称触发截断');
  ok(long.name.length <= 120, '截断到 120 字符内', `${long.name.length}`);
  ok(/_001$/.test(long.name), '截断后保留结尾序号');
  ok(byteLength(long.name) <= 255 - 16, '单层目录名字节数在 255 上限内', `${byteLength(long.name)} 字节`);

  const dir = naming.expandDir('{平台}/{主播}/{日期}', ctx);
  eq(dir.dir, '抖音/某某小主播/2025-06-01', '目录模板展开（正斜杠）');
  eq(naming.expandDir('{平台}//{主播}/', ctx).dir, '抖音/某某小主播', '多余分隔符被清理');
  ok(!naming.expandDir('{平台}\\\\{主播}', ctx).dir.includes('\\'), '反斜杠归一化为 /');

  const plan = naming.planSegmentNames({ naming: naming.DEFAULT_NAMING, ctx, count: 3 });
  eq(plan.length, 3, '预览生成 3 个分段名');
  ok(plan[0].file.endsWith('_001.ts') && plan[2].file.endsWith('_003.ts'), '分段序号连续且可排序', plan.map((x) => x.file).join(' | '));
  ok(new Set(plan.map((x) => x.file)).size === 3, '分段名互不覆盖', plan.map((x) => x.file).join(' | '));

  const pat = naming.buildOutputPattern({ profile: naming.DEFAULT_NAMING.profiles[0], ctx, ext: 'ts' });
  ok(pat.pattern.includes('%03d'), 'ffmpeg 输出模板含 %03d', pat.pattern);
  const pat2 = naming.buildOutputPattern({ profile: { ...naming.DEFAULT_NAMING.profiles[0], fnTemplate: '{日期}_{主播}' }, ctx, ext: 'ts' });
  ok(pat2.pattern.includes('%03d'), '模板无 {序号} 时自动追加 %03d', pat2.pattern);

  const opts = { ...naming.DEFAULT_OPTIONS, seqDigits: 4, dateFormat: 'YYYYMMDD' };
  const r4 = naming.renderName('{日期}_{序号}', { ...ctx, options: opts }, 7);
  eq(r4.name, '20250601_0007', '日期格式与序号位数生效');

  const merged = naming.buildMergedName({ naming: naming.DEFAULT_NAMING, ctx, ext: 'mp4' });
  ok(!merged.name.includes('{') && merged.name.endsWith('.mp4'), '合并命名合法', merged.name);

  const prev = naming.previewNaming({ fnTemplate: '{日期}_{主播}_{序号}', dirTemplate: '{平台}/{主播}/{日期}' });
  eq(prev.lines.length, 3, '预览返回 3 行');
  ok(prev.lines[0].fullPath.startsWith('/data/'), '预览路径基于 /data', prev.lines[0].fullPath);
  ok(prev.lines[0].bytes > 0 && prev.lines[0].chars > 0, '预览返回字符数与字节数');
  ok(naming.qualityLabel('origin') === '原画' && naming.qualityLabel('audio') === '仅音频', '清晰度标签映射');

  // 重名去重
  const exists = (x) => x.endsWith('.ts') && !x.includes('_2');
  ok(naming.reserveName('/a/b.ts', exists, 'suffix').includes('_2'), '重名 → 追加 _2');
  ok(naming.reserveName('/a/b.ts', exists, 'overwrite') === '/a/b.ts', '重名 → 覆盖策略保留原名');
  ok(/_\\d{8}\\d{6}\\.ts$/.test(naming.reserveName('/a/b.ts', exists, 'timestamp')) || /\d{14}\.ts$/.test(naming.reserveName('/a/b.ts', exists, 'timestamp')), '重名 → 时间戳策略');
  ok(naming.pickProfile(naming.DEFAULT_NAMING, { platform: 'douyin' }).id === 'p_douyin', '按平台选命名配置');
  ok(naming.pickProfile(naming.DEFAULT_NAMING, {}).id === 'p_default', '无绑定时用默认配置');
}

// ============ 2. store ============
async function testStore() {
  suite('持久化 store');
  const dir = p('store-config');
  const store = await openStore(dir);
  const keys = Object.keys(DEFAULT_SETTINGS);
  ok(['maxConcurrency', 'platformCaps', 'platformEnabled', 'notify', 'security', 'trashRetentionDays', 'playConcurrency'].every((k) => keys.includes(k)),
    '默认设置项齐全', `${keys.length} 个顶层键`);
  ok(store.settings.deleteToTrash === true, 'D10 默认删除进回收站');
  ok(store.settings.trashRetentionDays === 7, 'D10 回收站保留 7 天');
  ok(store.settings.playConcurrency === 2, 'D17 回放并发默认 2');
  ok(store.settings.logRetentionDays === 14, 'D14 日志保留 14 天');

  const t1 = Store.newTask({ anchorName: 'A' });
  const t2 = Store.newTask({ anchorName: 'B' });
  await store.addTask(t1);
  await store.addTask(t2);
  // 并发写：立即连续保存，不应丢数据
  await Promise.all(Array.from({ length: 30 }, (_, i) => {
    t1.totalBytes = i;
    return store.saveTask(t1);
  }));
  await store.persist();
  const reloaded = await openStore(dir);
  eq(reloaded.tasks.length, 2, '并发写后任务数正确');
  eq(reloaded.getTask(t1.id).totalBytes, 29, '并发写后最后一次写入生效');

  const merged = deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } });
  ok(merged.a === 1 && merged.b.c === 9 && merged.b.d === 3, '设置深合并保留未提及字段');

  await store.updateSettings({ maxConcurrency: 5 });
  ok((await openStore(dir)).settings.maxConcurrency === 5, '设置落盘并可重载');

  // 残留"录制中"状态在重启时被收敛
  const t3 = Store.newTask({ status: 'recording' });
  await store.addTask(t3);
  const reloaded2 = await openStore(dir);
  eq(reloaded2.getTask(t3.id).status, 'stopped', '重启后残留录制中状态收敛为已停止');

  const s = { id: 's_1', segments: [{ id: 'f_1', path: '/data/x.ts' }], extras: [], merged: null, mp4: null };
  await store.addSession(s);
  ok(store.findFile('f_1')?.file.id === 'f_1', '按文件 id 反查 session');
  ok(safeJoin('/data', 'a/b') === path.resolve('/data/a/b'), 'safeJoin 正常路径');
  let blocked = false;
  try { safeJoin('/data', '../../etc/passwd'); } catch { blocked = true; }
  ok(blocked, 'safeJoin 挡住路径越界');
}

// ============ 3. 解析器（离线） ============
async function testResolvers() {
  suite('平台识别与解析（离线）');
  eq(resolvers.detectPlatform('https://live.douyin.com/123456'), 'douyin', '识别抖音');
  eq(resolvers.detectPlatform('https://live.bilibili.com/22637261'), 'bilibili', '识别 B 站');
  eq(resolvers.detectPlatform('https://www.huya.com/660000'), 'huya', '识别虎牙');
  eq(resolvers.detectPlatform('https://www.douyu.com/9999'), 'douyu', '识别斗鱼');
  eq(resolvers.detectPlatform('https://live.kuaishou.com/u/abc'), 'kuaishou', '识别快手');
  eq(resolvers.detectPlatform('https://example.com/a/b.m3u8'), 'direct', '识别直链 m3u8');
  eq(resolvers.detectPlatform('bilibili:22637261'), 'bilibili', '支持 platform:roomId 形式');
  eq(resolvers.detectPlatform('随便一串中文'), null, '无法识别时返回 null');
  eq(resolvers.roomIdFrom('douyin', 'https://live.douyin.com/123456'), '123456', '抖音房间号提取');
  eq(resolvers.roomIdFrom('bilibili', 'https://live.bilibili.com/blanc/22637261'), '22637261', 'B 站房间号提取');

  const info = await resolvers.resolveRoom('https://example.com/demo.m3u8', { settings: {} });
  eq(info.platform, 'direct', '直链解析平台');
  eq(info.liveStatus, 'live', '直链视为可录');
  ok(info.qualityOptions.length >= 1, '直链提供清晰度选项');

  let notImpl = false;
  try { await resolvers.resolveRoom('https://www.acfun.cn/live/1', { settings: {} }); } catch (e) { notImpl = e.code === 'NOT_IMPLEMENTED'; }
  ok(notImpl, '未接入平台给出 NOT_IMPLEMENTED');

  let badUrl = false;
  try { await resolvers.resolveRoom('不是链接', { settings: {} }); } catch (e) { badUrl = e.code === 'INVALID_URL'; }
  ok(badUrl, '非法地址给出 INVALID_URL');

  // 用 mock fetch 验证 B 站解析（不依赖真实网络）
  const realFetch = globalThis.fetch;
  let forceBlocked = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('room_init')) {
      return new Response(JSON.stringify({ code: 0, data: { room_id: 22637261, live_status: 1 } }), { status: 200 });
    }
    if (u.includes('/room/v1/Room/get_info')) {
      if (forceBlocked) return new Response(JSON.stringify({ code: -352, message: '-352' }), { status: 200 });
      return new Response(JSON.stringify({
        code: 0,
        data: { room_id: 22637261, uid: 1, title: '测试直播间', live_status: 1, online: 42 },
      }), { status: 200 });
    }
    if (u.includes('get_anchor_in_room')) {
      return new Response(JSON.stringify({ code: 0, data: { info: { uname: '测试主播', face: 'http://x/y.jpg' } } }), { status: 200 });
    }
    if (u.includes('getInfoByRoom')) {
      // 旧接口已废弃（真实返回 code=-352）：故意返回被拒，确保代码不再依赖它
      return new Response(JSON.stringify({ code: -352, message: '-352' }), { status: 200 });
    }
    if (u.includes('getRoomPlayInfo')) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          playurl_info: {
            playurl: {
              stream: [{
                protocol_name: 'http_stream',
                format: [{ format_name: 'flv', codec: [{ codec_name: 'avc', current_qn: 10000, accept_qn: [10000, 400], base_url: '/live/x.flv?', url_info: [{ host: 'https://cdn.example.com', extra: 'token=1' }] }] }],
              }],
            },
          },
        },
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const room = await resolvers.resolveRoom('https://live.bilibili.com/22637261', { settings: {} });
    eq(room.anchorName, '测试主播', 'B 站主播名解析');
    eq(room.title, '测试直播间', 'B 站标题解析');
    eq(room.liveStatus, 'live', 'B 站开播状态解析');
    eq(room.online, 42, 'B 站在线人数解析');
    const stream = await resolvers.resolveStream({ platform: 'bilibili', roomId: '22637261', quality: 'origin' }, { settings: {} });
    eq(stream.url, 'https://cdn.example.com/live/x.flv?token=1', 'B 站流地址拼接');
    eq(stream.qualityActual, 'origin', 'B 站实际清晰度回写');
    const fb = await resolvers.resolveStream({ platform: 'bilibili', roomId: '22637261', quality: 'sd' }, { settings: { qualityFallback: ['hd'] } });
    ok(fb.url.includes('cdn.example.com'), '清晰度回退后仍能拿到流');
    // 接口被风控/废弃时必须报错，不能静默当作"未开播"
    forceBlocked = true;
    let blocked = null;
    try { await resolvers.resolveRoom('https://live.bilibili.com/22637261', { settings: {} }); } catch (e) { blocked = e; }
    ok(!!blocked && blocked.code === 'BLOCKED', 'B 站房间信息接口被拒时报错而不是静默 offline', blocked ? blocked.code : '未抛错');
  } finally {
    globalThis.fetch = realFetch;
  }

  // 用 mock fetch 验证抖音"免登录"路径（不依赖真实网络）
  // 关键点：web enter 接口固定返回 4001038（真实线上表现），只有走移动端接口才能成功 —— 回归时若又依赖 web 接口就会失败
  let mobileMode = 'live';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('webcast.amemv.com/webcast/room/reflow/info')) {
      if (mobileMode === 'offline') return new Response(JSON.stringify({ status_code: 10011, data: { message: 'Request params error' } }), { status: 200 });
      if (mobileMode === 'broken') return new Response(JSON.stringify({ status_code: 10086, data: { message: 'system busy' } }), { status: 200 });
      return new Response(JSON.stringify({
        status_code: 0,
        data: {
          room: {
            id_str: '7694422853944462115', status: 2, title: '测试抖音直播间',
            owner: { short_id: '83033400459', unique_id: 'dy_测试号', nickname: '抖音测试主播', avatar_thumb: { url_list: ['http://a/b.jpg'] } },
            stats: { total_user: 1234 },
            stream_url: {
              default_resolution: 'HD1',
              flv_pull_url: {
                FULL_HD1: 'http://cdn.example.com/full.flv?sig=1', HD1: 'http://cdn.example.com/hd.flv',
                SD1: 'http://cdn.example.com/sd1.flv', SD2: 'http://cdn.example.com/sd2.flv',
              },
              hls_pull_url_map: { FULL_HD1: 'http://cdn.example.com/full.m3u8' },
            },
          },
        },
      }), { status: 200 });
    }
    if (u.includes('webcast/room/web/enter')) return new Response(JSON.stringify({ status_code: 4001038 }), { status: 200 });
    if (u.includes('live.douyin.com/')) return new Response('<html><body>no stream here</body></html>', { status: 200 });
    if (u.includes('live.douyin.com')) return new Response('', { status: 200, headers: { 'set-cookie': 'ttwid=fake-ttwid' } });
    return new Response('{}', { status: 404 });
  };
  try {
    const room = await resolvers.resolveRoom('https://live.douyin.com/7694422853944462115', { settings: {} });
    eq(room.liveStatus, 'live', '抖音免登录解析出开播状态（移动端接口路径）');
    eq(room.anchorName, '抖音测试主播', '抖音免登录解析出主播名');
    eq(room.shortId, 'dy_测试号', '抖音解析返回短号（主播抖音号，前台展示用）');
    eq(room.title, '测试抖音直播间', '抖音免登录解析出标题');
    eq(room.online, 1234, '抖音免登录解析出在线人数');
    const stream = await resolvers.resolveStream({ platform: 'douyin', roomId: '7694422854462115', quality: 'origin' }, { settings: {} });
    // 抖音解析器自 5be560ed 起 HLS 优先（flv 边缘节点常 404/超时）：原画档应命中原画 HLS 单，而不是同档 flv
    eq(stream.url, 'http://cdn.example.com/full.m3u8', '抖音原画档取到原画 HLS 流地址');
    eq(stream.qualityKey, 'FULL_HD1', '抖音原画档命中最高码率 key');
    eq(stream.qualityActual, 'origin', '抖音实际清晰度回写');
    const hd = await resolvers.resolveStream({ platform: 'douyin', roomId: '7694422853944462115', quality: 'hd' }, { settings: {} });
    ok(!!hd.url, '抖音高清档取到流地址', hd.qualityKey);
    // 未开播：接口返回 10011，必须按"未开播"处理（任务继续等待开播），而不是抛错
    mobileMode = 'offline';
    const offline = await resolvers.resolveRoom('https://live.douyin.com/7694422853944462115', { settings: {} });
    eq(offline.liveStatus, 'offline', '抖音接口 10011 时按未开播处理（可继续轮询等待开播）');
    ok(/10011/.test(offline.note || ''), '未开播时说明原因（接口 10011）', offline.note);
    // 短号（web_rid）：免登录接口认不出，必须明确报错让人改填 19 位号，而不是假装"等待开播"永远轮询
    let shortErr = null;
    try { await resolvers.resolveRoom('https://live.douyin.com/83033400459', { settings: {} }); } catch (e) { shortErr = e; }
    ok(!!shortErr && shortErr.code === 'ROOM_ID_FORMAT', '抖音短号报 ROOM_ID_FORMAT 而不是静默等待开播', shortErr ? shortErr.code : '未抛错');
    ok(/19 位/.test(shortErr?.message || '') && /Cookie/.test(shortErr?.message || ''), '短号错误信息给出「19 位房间号」与 Cookie 两条出路');
    // 接口全挂：要抛出可操作的错误，且提示 Cookie 与直链两条出路
    mobileMode = 'broken';
    let err = null;
    try { await resolvers.resolveRoom('https://live.douyin.com/7694422853944462115', { settings: {} }); } catch (e) { err = e; }
    ok(!!err && err.code === 'BLOCKED', '抖音解析彻底失败时报 BLOCKED', err ? err.code : '未抛错');
    ok(/移动端/.test(err?.message || '') && /Cookie/.test(err?.message || '') && /直链/.test(err?.message || ''), '错误信息同时给出移动端/web 失败原因与 Cookie、直链两条出路');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ============ 4. 录制链路（假 ffmpeg） ============
async function makeEngine(name, env = {}) {
  Object.assign(process.env, env);
  const configDir = p(`${name}-config`);
  const recordRoot = p(`${name}-record`);
  await fsp.mkdir(recordRoot, { recursive: true });
  const store = await openStore(configDir);
  store.settings.recordRoot = recordRoot;
  store.settings.diskLimitGB = 0;      // 测试环境不因磁盘阈值拦截
  store.settings.maxConcurrency = 8;
  store.settings.remuxToMp4 = true;
  store.settings.platformCaps.direct = 8;
  const logger = await new Logger({ dir: path.join(configDir, 'logs'), level: 'DEBUG' }).init();
  const storage = new Storage({ store, logger, mediaMod: fakeMedia });
  const notifier = new Notifier({ store, logger, fetchImpl: async () => new Response('{}', { status: 200 }) });
  const events = [];
  const scheduler = new Scheduler({
    store, logger, notifier, storage, mediaMod: fakeMedia,
    onEvent: (e) => events.push(e),
  });
  scheduler.engine = { ffmpegAvailable: true, ffmpegVersion: 'fake' };
  await scheduler.init();
  return { configDir, store, logger, storage, notifier, scheduler, recordRoot, events, play: new PlayManager({ store, logger, storage, mediaMod: fakeMedia }) };
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(100);
  }
  ok(false, `等待超时：${label}`);
  return false;
}

async function testRecordChain() {
  suite('录制链路（假 ffmpeg：分段 / 收尾 / 转封装）');
  const e = await makeEngine('rec', { FAKE_SEGMENT_MS: '150', FAKE_SEGMENTS_TOTAL: '3', FAKE_SEGMENT_MB: '0.2', FAKE_DURATION: '10' });
  const task = await e.scheduler.createTask({ url: 'https://example.com/live.m3u8', platform: 'direct', anchorName: '直链测试' });
  eq(task.platform, 'direct', '直链任务创建成功');
  eq(task.status, 'queued', '开播中的任务进入排队');
  const dupBlocked = await e.scheduler.createTask({ url: 'https://example.com/live.m3u8', platform: 'direct' }).then(() => false).catch((err) => err.code === 'DUPLICATE_ROOM');
  ok(dupBlocked, 'D3 同一房间不允许重复任务');

  await e.scheduler.tick();
  const started = await waitFor(() => e.store.getTask(task.id).status === 'recording', 6000, '任务进入录制中');
  ok(started, '任务开始录制');
  const rec = e.store.getTask(task.id);
  eq(rec.qualityLabel, '原画', '实际清晰度写入任务');

  const gotSegments = await waitFor(() => (e.store.sessions[0]?.segments?.length || 0) >= 2, 8000, '分段收尾入库');
  ok(gotSegments, '分段被登记入库', `${e.store.sessions[0]?.segments?.length} 段`);
  const session0 = e.store.sessions[0];
  ok(session0.dir && fs.existsSync(session0.dir), '落盘目录存在', session0.dir);
  ok(session0.segments.every((f) => fs.existsSync(f.path)), '分段文件真实存在于 /data 下');
  ok(/^\d{4}-\d{2}-\d{2}_/.test(session0.segments[0].name), '文件名符合命名模板', session0.segments[0].name);
  ok(session0.relDir.split('/').length >= 3, '目录按 平台/主播/日期 分层', session0.relDir);

  // recorder 侧的 0 字节残渣清理（_tick / _finalize / pause 共用同一 helper）
  const recLive = e.scheduler.recorders.get(task.id);
  const emptyResidue = path.join(session0.dir, '2026-10-09_空分段_098.ts');
  await fsp.writeFile(emptyResidue, Buffer.alloc(0));
  const droppedResidue = recLive ? await recLive._dropEmptySegments([{ index: 98, name: path.basename(emptyResidue), path: emptyResidue }]) : [];
  ok(droppedResidue.length === 1 && !fs.existsSync(emptyResidue), 'recorder 侧清理 0 字节空分段残渣（录制中不残留垃圾文件）');

  task.autoRecord = false;
  await e.store.saveTask(task);
  const stopResult = await e.scheduler.stopTask(task.id);
  ok(stopResult.stopped, '停止任务');
  await e.scheduler.tick(); // 跑一轮：手动停止态应保持 stopped（已有 tick 验证在后续批处理），此处仅确保收尾态
  eq(e.store.getTask(task.id).status, 'stopped', '手动停止后状态固定为 stopped（不再自动重启）');
  ok(e.store.getTask(task.id).manualHeld === true, '手动停止标记 manualHeld 已置位');
  const session = e.store.sessions.find((s) => s.id === session0.id);
  eq(session.status, 'done', 'D8 场次归档为 done');
  eq(session.segments.length, 3, '3 个分段全部登记');
  ok(session.bytes > 0 && session.durationSec > 0, '场次统计了体积与时长', `${formatBytes(session.bytes)} / ${formatDuration(session.durationSec)}`);
  ok(session.endedAt, '场次记录结束时间');

  const remuxed = await waitFor(() => (session.extras || []).some((f) => f.kind === 'mp4'), 10000, 'D5 自动转封装 MP4');
  ok(remuxed, 'D5 停止后自动转封装出 MP4', `${(session.extras || []).length} 个派生产物`);
  const mp4 = (session.extras || []).find((f) => f.kind === 'mp4');
  ok(mp4 && fs.existsSync(mp4.path), 'MP4 文件已生成');
  ok(mp4.name.endsWith('.mp4'), 'MP4 命名正确', mp4.name);

  // 回放并发上限（D17）
  const p1 = await e.play.start(session.segments[0].id);
  const p2 = await e.play.start(session.segments[1].id);
  eq(e.play.activeCount(), 2, 'D17 两路转封装回放同时开启');
  let busy = false;
  try { await e.play.start(session.segments[2].id); } catch (err) { busy = err.code === 'PLAY_BUSY' && err.status === 429; }
  ok(busy, 'D17 第 3 路回放返回 429 PLAY_BUSY');
  e.play.release(p1.playId);
  eq(e.play.activeCount(), 1, '释放一路后并发数下降');
  e.play.release(p2.playId);
  eq(e.play.activeCount(), 0, '全部释放后为 0');

  const directHit = e.store.findFile(mp4.id);
  const directPlay = await e.play.start(mp4.id);
  eq(directPlay.mode, 'direct', 'MP4 直放');
  ok(directPlay.url.includes('/stream'), '直放返回流地址', directPlay.url);
  void directHit;
  // 合并整场
  const merged = await e.storage.mergeSession(session.id);
  ok(fs.existsSync(merged.path), 'D5 合并整场产出文件');
  ok(merged.name.endsWith('.ts'), '合并产物命名正确', merged.name);
  const mergedMp4 = await waitFor(() => (session.extras || []).some((f) => f.kind === 'mp4' && f.sourceFileId === merged.id), 10000, '合并后自动转封装');
  ok(mergedMp4, '合并后按设置自动转封装');

  // 扫描一致性：未登记文件被扫描自动注册为独立场次（不再挂「未登记」列表）
  await fsp.writeFile(path.join(e.recordRoot, 'stray.ts'), Buffer.alloc(2048));
  const scan = await e.storage.scan();
  const straySession = (e.store.sessions || []).find((s) => (s.segments || []).some((f) => f.name === 'stray.ts'));
  ok(scan.added >= 1 && !!straySession && !e.store.external.some((f) => f.name === 'stray.ts'), 'D19 未登记文件被扫描自动注册为场次', `added=${scan.added}`);
  await fsp.rm(session.segments[0].path, { force: true });
  const scan2 = await e.storage.scan();
  ok(scan2.missing >= 1 && session.segments[0].status === 'missing', 'D19 磁盘缺失被标记为文件缺失');

  // 幽灵"未登记"条目：转封装产物可能先被一次扫描记成未登记，随后又被登记为场次产物——旧条目必须被清理
  const mp4Path = (session.extras || []).find((f) => f.kind === 'mp4')?.path;
  if (mp4Path) {
    e.store.state.external.push({
      id: 'f_ghost', sessionId: null, kind: 'unregistered', name: path.basename(mp4Path), path: mp4Path,
      relPath: e.storage.rel(mp4Path), ext: 'mp4', bytes: 1, status: 'ok',
    });
    const scanGhost = await e.storage.scan();
    ok(scanGhost.cleaned >= 1 && !e.store.external.some((f) => f.id === 'f_ghost'), '路径已归属场次时，幽灵"未登记"条目被清理', `cleaned=${scanGhost.cleaned}`);
  }
  // 磁盘上已消失的"未登记"条目同样不能永久残留（补登记入口遗留项）
  const stray2Path = path.join(e.recordRoot, 'stray2.ts');
  await fsp.writeFile(stray2Path, Buffer.alloc(1024));
  e.store.state.external.push({
    id: 'f_stale', sessionId: null, kind: 'unregistered', name: 'stray2.ts', path: stray2Path,
    relPath: e.storage.rel(stray2Path), ext: 'ts', bytes: 1, status: 'ok',
  });
  await fsp.rm(stray2Path, { force: true });
  const scanGone = await e.storage.scan();
  ok(!e.store.external.some((f) => f.id === 'f_stale') && scanGone.cleaned >= 1, '磁盘已消失的"未登记"条目被清理');
  ok(e.store.external.length === 0, '清理后"未登记"列表清空（文件库不再显示幽灵条目）', `unregistered=${scanGone.unregistered}`);

  // 0 字节空分段（ffmpeg 在轮转/停止瞬间创建又立即退出的残渣）必须清理，不能变成"未登记"垃圾
  const emptySeg = path.join(session.dir, '2026-10-09_空分段_099.ts');
  await fsp.writeFile(emptySeg, Buffer.alloc(0));
  const segCountBefore = session.segments.length;
  await e.scheduler._onSegmentClose(e.store.getTask(task.id), session, { index: 99, name: path.basename(emptySeg), path: emptySeg, bytes: 0, durationSec: 0 });
  ok(!fs.existsSync(emptySeg), '0 字节空分段被清理（不留"未登记"垃圾文件）');
  eq(session.segments.length, segCountBefore, '空分段不登记进文件库');

  // 回收站
  const del = await e.storage.moveToTrash({ sessionIds: [session.id] });
  ok(del.movedToTrash === 1 && del.bytes > 0, 'D10 删除整场进入回收站', formatBytes(del.bytes));
  ok(!e.store.getSession(session.id), '删除后场次从索引移除');
  ok(e.storage.listTrash().count === 1, '回收站里有 1 项');
  const trashEntry = e.storage.listTrash().items[0];
  ok(trashEntry.items.every((it) => !it.trashPath || fs.existsSync(it.trashPath)), '回收站文件真实落盘');
  await e.storage.restoreTrash([trashEntry.id]);
  ok(e.store.getSession(session.id), 'D10 回收站可还原场次');
  ok(fs.existsSync(session.segments[1].path), '还原后文件回到原路径');

  // 录制中禁止删除
  let blockedDel = false;
  const t2 = await e.scheduler.createTask({ url: 'https://example.com/live2.m3u8', platform: 'direct', anchorName: '直链测试2' });
  await e.scheduler.tick();
  await waitFor(() => e.store.getTask(t2.id).status === 'recording', 6000, '第二个任务开始录制');
  try { await e.storage.moveToTrash({ sessionIds: [e.store.getTask(t2.id).sessionId] }); } catch (err) { blockedDel = err.code === 'SESSION_RECORDING'; }
  ok(blockedDel, 'D10 录制中的场次禁止删除');
  t2.autoRecord = false;
  await e.store.saveTask(t2);
  await e.scheduler.stopTask(t2.id);

  // 暂停 / 恢复（D4）
  const t3 = await e.scheduler.createTask({ url: 'https://example.com/live3.m3u8', platform: 'direct', anchorName: '直链测试3' });
  await e.scheduler.tick();
  await waitFor(() => e.store.getTask(t3.id).status === 'recording', 6000, '第三个任务开始录制');
  await waitFor(() => (e.store.getSession(e.store.getTask(t3.id).sessionId)?.segments?.length || 0) >= 2, 8000, '暂停前已有分段');
  const beforePause = e.store.getSession(e.store.getTask(t3.id).sessionId).segments.length;
  await e.scheduler.pauseTask(t3.id);
  ok(e.store.getTask(t3.id).status === 'paused', 'D4 暂停后状态为已暂停');
  ok(e.scheduler.activeCount() === 0 || e.scheduler.recorders.size === 0, 'D4 暂停不占用并发');
  const pausedSession = e.store.getSession(e.store.getTask(t3.id).sessionId);
  eq(pausedSession.status, 'paused', '场次标记为已暂停');
  await e.scheduler.resumeTask(t3.id);
  ok(e.store.getTask(t3.id).status === 'recording', 'D4 恢复后继续录制');
  await waitFor(() => e.store.getSession(pausedSession.id).segments.length > beforePause, 8000, '恢复后新开分段');
  const idx = pausedSession.segments.map((f) => f.segmentIndex);
  ok(Math.max(...idx) > beforePause, 'D4 序号续接而不是从头开始', `序号 ${idx.join(',')}`);
  t3.autoRecord = false;
  await e.store.saveTask(t3);
  await e.scheduler.stopTask(t3.id);

  // 收尾：关闭后台轮询，避免直链任务被反复拉起
  for (const t of e.store.tasks) t.autoRecord = false;
  e.scheduler.stopPolling();
  for (const id of [...e.scheduler.recorders.keys()]) await e.scheduler.stopTask(id).catch(() => {});
}

/* 任务级「转封装 MP4」必须实时跟随全局（v0.1.24 回归）。
   历史缺陷：创建任务时前端恒发 remuxToMp4=null（语义=跟随全局），后端 !!null 强转 false
   并烙进扁平字段 → 全局开着「转封装 MP4」，分段录完也不立即转，只能等整场收尾。 */
async function testRemuxFollowGlobal() {
  suite('任务级转封装跟随全局（边录边转）');
  const e = await makeEngine('remuxfg');
  e.scheduler.stopPolling(); // 本测试只验证开关语义，不需要轮询把任务拉起来录
  try {
    e.store.settings.remuxToMp4 = true;
    e.store.settings.autoMerge = false;
    // ① 前端 submit() 恒发 null：不得被强转 false，必须保持「跟随全局」
    const t1 = await e.scheduler.createTask({ url: 'https://example.com/rf1.m3u8', platform: 'direct', anchorName: '跟随全局', remuxToMp4: null });
    eq(t1.remuxToMp4, null, '创建任务 remuxToMp4=null 不得被强转 false');
    eq(e.scheduler.effective(t1).remuxToMp4, true, '全局开 → 生效值为开（边录边转）');
    // ② 实时跟随：改全局设置，不重开任务当段即按新值决策
    e.store.settings.remuxToMp4 = false;
    eq(e.scheduler.effective(t1).remuxToMp4, false, '全局关 → 实时变为关');
    e.store.settings.remuxToMp4 = true;
    // ③ API 显式 false 仍被尊重（effective 语义不变）
    const t2 = await e.scheduler.createTask({ url: 'https://example.com/rf2.m3u8', platform: 'direct', anchorName: '显式关', remuxToMp4: false });
    eq(e.scheduler.effective(t2).remuxToMp4, false, '显式 false 仍尊重为关');
    // ④ 存量自愈：模拟旧缺陷烙进库里的 false，init() 必须重置为跟随全局
    const t3 = await e.scheduler.createTask({ url: 'https://example.com/rf3.m3u8', platform: 'direct', anchorName: '存量修复', remuxToMp4: false });
    const stuck = e.store.getTask(t3.id);
    stuck.remuxToMp4 = false;
    await e.store.saveTask(stuck);
    await e.scheduler.init();
    e.scheduler.stopPolling(); // init() 内部会重启轮询，本测试不需要
    eq(e.store.getTask(t3.id).remuxToMp4, null, 'init() 自愈：历史 false 重置为 null');
    eq(e.scheduler.effective(e.store.getTask(t3.id)).remuxToMp4, true, '自愈后按全局实时生效');
    // ⑤ 持久化往返：null 不得被磨成 false（重启后仍跟随全局）
    await e.store.saveTask(e.store.getTask(t1.id));
    await e.store.saveTask(e.store.getTask(t3.id));
    const reopened = await openStore(e.configDir);
    eq(reopened.getTask(t1.id).remuxToMp4, null, '重开库：跟随全局标记不丢（null 往返存活）');
    eq(reopened.getTask(t3.id).remuxToMp4, null, '重开库：自愈结果持久化');
    eq(e.scheduler.effective(reopened.getTask(t1.id)).remuxToMp4, true, '重开库后仍按全局生效');
  } finally {
    for (const t of e.store.tasks) t.autoRecord = false;
    e.scheduler.stopPolling();
    for (const id of [...e.scheduler.recorders.keys()]) await e.scheduler.stopTask(id).catch(() => {});
  }
}

// ============ 4c. 分段结束原因（用户报「设了 30 分钟却录出 10-20 分钟的段」） ============
// 实测 ffmpeg -segment_time 在正常/大起点 PTS/PTS 回跳/FLV/管道无 duration 五类输入下
// 都精确轮转；短段只可能来自「ffmpeg 进程退出 → 当前段被提前收尾」（断流重连/下播/误停）。
// 本测试钉死：结束原因必须落进文件记录（UI 徽标）+ 持久化往返 + 详情序列化带出。
async function testSegmentEndReason() {
  suite('分段结束原因（提前收尾可观测，探测 unknown 不误停）');
  const e = await makeEngine('segreason');
  e.scheduler.stopPolling(); // 本测试只验证登记与序列化，不需要轮询把任务拉起来录
  try {
    e.store.settings.remuxToMp4 = false; // 只验登记逻辑，不触发转封装
    const task = await e.scheduler.createTask({ url: 'https://example.com/sr1.m3u8', platform: 'direct', anchorName: '分段原因测试' });
    task.segmentMinutes = 1800;
    await e.store.saveTask(task);
    const session = { id: 'sess_reason', taskId: task.id, segments: [], extras: [], startedAt: new Date().toISOString(), bytes: 0, durationSec: 0 };
    const segFile = (i) => path.join(e.recordRoot, `2026-10-17_分段原因_00${i}.ts`);
    for (const i of [1, 2, 3]) await fsp.writeFile(segFile(i), Buffer.alloc(4096));
    await e.scheduler._onSegmentClose(task, session, { index: 1, name: path.basename(segFile(1)), path: segFile(1), bytes: 4096, durationSec: 600, reason: 'reconnect' });
    eq(session.segments.length, 1, '分段已登记');
    eq(session.segments[0].endReason, 'reconnect', '断流重连前收尾 → endReason=reconnect（详情弹窗显示「提前结束·断流重连」）');
    await e.scheduler._onSegmentClose(task, session, { index: 2, name: path.basename(segFile(2)), path: segFile(2), bytes: 4096, durationSec: 1800, reason: 'timeout' });
    eq(session.segments[1].endReason, 'timeout', '按设定时长自然轮转 → endReason=timeout（不显示徽标）');
    await e.scheduler._onSegmentClose(task, session, { index: 3, name: path.basename(segFile(3)), path: segFile(3), bytes: 4096, durationSec: 1800 });
    eq(session.segments[2].endReason, 'timeout', '缺省 reason 视为自然轮转（兼容旧调用方）');
    // 持久化往返：endReason 必须落库（详情弹窗从 files 表重建 segments）
    task.sessionId = session.id;
    await e.store.saveTask(task);
    e.store.state.sessions.push(session);
    await e.store.saveSession(session);
    const reopened = await openStore(e.configDir);
    const rs = reopened.getSession(session.id);
    eq(rs && rs.segments.find((f) => f.segmentIndex === 1).endReason, 'reconnect', '重开库：endReason 往返存活（files.end_reason 列）');
    eq(rs && rs.segments.find((f) => f.segmentIndex === 2).endReason, 'timeout', '重开库：自然轮转标记同样存活');
    // 详情序列化带分段明细；列表序列化不带（每 5s 全量跑，省开销）
    e.scheduler.store = e.store; // scheduler 仍持旧 store 引用前先对齐（openStore 只用于验证落库）
    e.store.state.sessions.push(session);
    const detail = e.scheduler.serializeTask(e.store.getTask(task.id), true);
    eq(detail.segments.length, 3, '详情序列化带出 3 段明细');
    eq(detail.segments[0].endReason, 'reconnect', '详情分段带结束原因');
    eq(e.scheduler.serializeTask(e.store.getTask(task.id)).segments, undefined, '列表序列化不带分段明细');
  } finally {
    for (const t of e.store.tasks) t.autoRecord = false;
    e.scheduler.stopPolling();
    for (const id of [...e.scheduler.recorders.keys()]) await e.scheduler.stopTask(id).catch(() => {});
  }
}

/* 分段链路守卫（静态扫描）：用户报「设了 30 分钟却录出 10-20 分钟的段，且无错误信息」。
   实测 ffmpeg -segment_time 在五类输入特性下都精确轮转，短段只可能来自
   「ffmpeg 进程退出 → 当前段被提前收尾」；而探测结果不明确（unknown）时停录
   会把一场直播拦腰砍成几段且全程无错误信息——这两条都用断言钉死。 */
function testSegmentGuards() {
  suite('分段链路守卫');
  const sched = fs.readFileSync(path.join(APP_DIR, 'server', 'scheduler.js'), 'utf8');
  const rec = fs.readFileSync(path.join(APP_DIR, 'server', 'recorder.js'), 'utf8');
  const store = fs.readFileSync(path.join(APP_DIR, 'server', 'store.js'), 'utf8');
  const db = fs.readFileSync(path.join(APP_DIR, 'server', 'db.js'), 'utf8');
  const srv = fs.readFileSync(path.join(APP_DIR, 'server', 'server.js'), 'utf8');
  ok(/info\.liveStatus === 'offline' && task\.status === 'recording'/.test(sched), '轮询只有明确 offline 才停正在录制的任务（unknown/字段缺失不得误停）');
  ok(/liveStatus === 'unknown' && task\.status === 'recording'/.test(sched), '探测 unknown 时保持录制、只记日志（不把直播拦腰砍成短段）');
  ok(/this\.child \? 'timeout' : 'stopped'/.test(rec), 'segment-close 带结束原因（进程活着=自然轮转 / 退出=提前收尾）');
  ok(/const endReason = seg\.reason/.test(sched) && /endReason,/.test(sched), '_onSegmentClose 把结束原因落进文件记录');
  ok(/end_reason: strOrNull\(f\.endReason\)/.test(store) && /endReason: r\.end_reason/.test(store), 'store end_reason 读写映射齐全（三态持久化）');
  ok(/ADD COLUMN end_reason/.test(db), 'db 有 end_reason 幂等补列迁移');
  ok(/serializeTask\(task, withSegments/.test(sched) && /serializeTask\(t, true\)/.test(srv), '详情接口带出分段明细（含结束原因），列表不带');
  for (const [file, pat] of [['douyin', /status == null \? 'unknown'/], ['bilibili', /d\.live_status == null \? 'unknown'/], ['cn', /room\.show_status == null \? 'unknown'/]]) {
    const src = fs.readFileSync(path.join(APP_DIR, 'server', 'resolvers', `${file}.js`), 'utf8');
    ok(pat.test(src), `${file} 探测字段缺失返回 unknown（不得当成未开播）`);
  }
}

/* ffmpeg 直播加固参数守卫：对齐成熟项目 StreamCap 的参数集（2026-10-17 逐项对比）。
   缺这些参数的真实症状：连接卡死时 ffmpeg 无限假挂（UI 显示录制中但不落盘）、
   损坏包/不连续 DTS 打乱轮转判断、TS 分段缺 PAT/PMT 头个别播放器打不开。 */
function testFfmpegGuards() {
  suite('ffmpeg 直播加固参数（对齐 StreamCap）');
  const media = fs.readFileSync(path.join(APP_DIR, 'server', 'media.js'), 'utf8');
  ok(/-rw_timeout', '15000000'/.test(media), 'rw_timeout 15s：连接卡死不死等（退出走重连，不假挂）');
  ok(/\+discardcorrupt\+igndts/.test(media), 'fflags 丢弃损坏包 + 忽略不连续 DTS（保轮转判断准确）');
  ok(/args\.push\('-reconnect', '1', '-reconnect_streamed', '1'/.test(media), 'reconnect 旗标显式带值 1（ffmpeg8 布尔选项必须带值，否则 Invalid argument）');
  ok(!/'-reconnect_streamed', '-reconnect_at_eof'/.test(media), '无值布尔旗标已移除（ffmpeg8 会把下一项当值）');
  ok(!/-reconnect_at_eof/.test(media), '不启用 reconnect_at_eof（流结束让 ffmpeg 退出，交给 recorder 判下播，避免进程内死循环）');
  ok(/-correct_ts_overflow', '1'/.test(media) && /-avoid_negative_ts', '1'/.test(media), '输出时间戳修正（33 位回绕 / 负 DTS）');
  ok(/-flush_packets', '1'/.test(media), 'flush_packets 每段及时落盘');
  ok(/-max_muxing_queue_size', '1024'/.test(media), 'muxing 队列上限（高码率不丢包）');
  ok(/'-sn', '-dn'/.test(media), '丢弃字幕/数据流（-c copy 不被数据流绊倒）');
  ok(/\+resend_headers/.test(media) && /-muxdelay', '0'/.test(media), 'TS 每段重发 PAT/PMT 头 + 零 mux 延迟');
  ok(!/thread_queue_size/.test(media), '不带 thread_queue_size（新旧 ffmpeg 输入/输出语义分裂，宁缺勿错）');
}

/* 文件定时扫描守卫：文件被外部移动/删除后，文件管理页需自动与磁盘对账（用户反馈「移动/删除后页面不同步」）。
   后端必须提供「节流扫描 + 后台定时」两条对账通道，且文件库接口主动触发一次；
   否则页面只能靠手动点「扫描」按钮才刷新，期间一直显示已失效的旧条目。 */
function testFileScanGuards() {
  suite('文件定时扫描（外部移动/删除自动同步）');
  const storage = fs.readFileSync(path.join(APP_DIR, 'server', 'storage.js'), 'utf8');
  const srv = fs.readFileSync(path.join(APP_DIR, 'server', 'server.js'), 'utf8');
  ok(/scanThrottled\s*\(/.test(storage), 'storage 提供 scanThrottled 节流扫描');
  ok(/startScanTimer\s*\(/.test(storage), 'storage 提供 startScanTimer 后台定时扫描');
  ok(/this\._scanInflight/.test(storage) && /this\._lastScanAt/.test(storage), '扫描带 in-flight 去重 + 时间戳节流（绝不并发遍历磁盘）');
  ok(/storage\.startScanTimer\(\)/.test(srv), '服务启动时启用后台定时扫描');
  ok(/storage\.scanThrottled\(/.test(srv), 'GET /api/files 主动触发节流扫描（页面打开即对账）');
  ok(/changed\s*=\s*added\s*\|\|\s*updated\s*\|\|\s*missing\s*\|\|\s*cleaned/.test(storage), '无变化时不落库/不广播（避免周期扫描刷屏与无谓写库）');

  // 关键修复：录制中的当前分段「未封口」，扫描绝不能把它登记成独立会话（否则文件库出现不能播、无首帧的录制中 ts）
  const sched = fs.readFileSync(path.join(APP_DIR, 'server', 'scheduler.js'), 'utf8');
  const media = fs.readFileSync(path.join(APP_DIR, 'server', 'media.js'), 'utf8');
  ok(/activePathsFn/.test(storage) && /active\.has\(p\)/.test(storage) && /setActivePathsProvider/.test(storage), '扫描跳过「正在写入的活动分段」（不误登记成不可播放文件）');
  ok(/activeRecordingPaths\(\)/.test(sched) && /setActivePathsProvider\(/.test(sched), 'scheduler 向 storage 提供活动分段路径');
  ok(/_dedupePathAcrossSessions/.test(sched), '分段关闭时清理同路径的扫描误登记会话（防重复/残留）');
  ok(/isJpeg/.test(media) && /0xff/.test(media) && /0xd8/.test(media), 'grabFrame 容忍非零退出：能出 JPEG 首帧即成功（录制中/截断文件也能出首帧）');
}

/* 文件库排序守卫：用户反馈「文件排序很混乱」。
   根因：/api/files 铺平后不排序直接分页；store.sessions 运行期 unshift（新→旧）、重启读库
   却是旧→新/任意，导致刷新/重启/翻页顺序乱跳。file-order.js 给出确定性顺序：
   最新在前 → 同场次聚合 → 分段按序号在前 → 派生文件其后 → 文件名兜底。 */
function testFileOrder() {
  suite('文件库排序（确定性、最新在前、同场次聚合）');
  const row = (sid, startedAt, kind, segIndex, name, tag) => ({ s: { id: sid, startedAt }, f: { kind, segmentIndex: segIndex, name }, tag });

  // ① 最新录制在前（跨场次）
  const cross = [
    row('s_old', '2026-10-01T10:00:00Z', 'segment', 0, 'old.ts'),
    row('s_new', '2026-10-15T10:00:00Z', 'segment', 0, 'new.ts'),
    row('s_mid', '2026-10-10T10:00:00Z', 'segment', 0, 'mid.ts'),
  ];
  eq(sortFileRows(cross.slice()).map((r) => r.s.id).join(','), 's_new,s_mid,s_old', '跨场次按录制开始时间倒序（最新在前）');

  // ② 同一场次聚合 + 分段按序号升序 + 派生文件排在分段之后
  const mixed = [
    row('s1', '2026-10-15T10:00:00Z', 'segment', 2, 'a_003.ts'),
    row('s1', '2026-10-15T10:00:00Z', 'mp4', 0, 'a.mp4', 'MP4'),
    row('s1', '2026-10-15T10:00:00Z', 'segment', 0, 'a_001.ts'),
    row('s1', '2026-10-15T10:00:00Z', 'segment', 1, 'a_002.ts'),
    row('s1', '2026-10-15T10:00:00Z', 'merged', 0, 'a_merged.ts', '合并'),
  ];
  eq(sortFileRows(mixed.slice()).map((r) => r.f.name).join(','), 'a_001.ts,a_002.ts,a_003.ts,a.mp4,a_merged.ts', '同场次：分段升序在前，派生(mp4)居中，合并最后');

  // ③ 确定性：任意初始顺序 → 相同结果
  const base = [
    row('s1', '2026-10-15T10:00:00Z', 'segment', 1, 'a_002.ts'),
    row('s2', '2026-10-16T10:00:00Z', 'segment', 0, 'b.ts'),
    row('s1', '2026-10-15T10:00:00Z', 'segment', 0, 'a_001.ts'),
  ];
  const p1 = sortFileRows(base.slice()).map((r) => r.f.name).join(',');
  const p2 = sortFileRows(base.slice().reverse()).map((r) => r.f.name).join(',');
  const p3 = sortFileRows([base[1], base[2], base[0]]).map((r) => r.f.name).join(',');
  eq(p1, p2, '正序输入与倒序输入得到相同顺序（确定性）');
  eq(p1, p3, '打乱输入得到相同顺序（确定性）');
  eq(p1, 'b.ts,a_001.ts,a_002.ts', '最新场次在前，同场次分段升序');

  // ④ 缺 startedAt 的（未登记/推断失败）排到最后
  const noTs = [row('s_x', null, 'segment', 0, 'x.ts'), row('s_y', '2026-10-16T10:00:00Z', 'segment', 0, 'y.ts')];
  eq(sortFileRows(noTs.slice())[0].f.name, 'y.ts', '缺时间的排在有时间的之后');
}

/* 代理开关全链路（用户要求：打开代理后抖音解析与录制都走代理）。
   关键点：Recorder 必须实时读取 store.settings——updateSettings 用 deepMerge 产出新对象替换，
   若启动时快照，运行中开关代理后重连/重新解析仍用旧值。 */
function testRecorderLiveProxy() {
  suite('代理开关：录制器实时读取 settings（打开后抖音即走代理）');
  const ff = { info() {}, warn() {}, error() {}, debug() {} };
  const task = { id: 't_liveproxy', platform: 'douyin', container: 'ts', segmentMode: 'time', quality: 'origin' };
  let settings = { platformUseProxy: { douyin: false }, proxy: 'http://127.0.0.1:7890' };
  const rec = new Recorder({ task, getSettings: () => settings, naming: {}, logger: ff, resolveStream: async () => ({}) });

  eq(rec.settings.proxy, 'http://127.0.0.1:7890', '构造后可读到当前 settings');
  eq(proxyFetch.effectiveProxyForPlatform('douyin', rec.settings), '', '开关未开 → 直连（空）');

  // 模拟用户在设置里打开抖音代理：updateSettings 用「新对象」替换 store.settings
  settings = { platformUseProxy: { douyin: true }, proxy: 'http://127.0.0.1:7890' };
  eq(rec.settings.platformUseProxy.douyin, true, '替换 settings 对象后，录制器仍读到最新开关（非快照）');
  eq(proxyFetch.effectiveProxyForPlatform('douyin', rec.settings), 'http://127.0.0.1:7890', '打开代理后抖音解析/录制生效代理=该地址');
  eq(proxyFetch.effectiveProxyForPlatform('bilibili', rec.settings), '', '其它平台未开 → 仍直连');

  // 清空全局代理地址：即使开关开着也应直连（需求：开启且已维护代理才走）
  settings = { platformUseProxy: { douyin: true }, proxy: '' };
  eq(proxyFetch.effectiveProxyForPlatform('douyin', rec.settings), '', '无全局代理地址 → 直连');

  // 录制侧：开启代理时 ffmpeg 参数必须带 -http_proxy（拉流走代理）；未开则不带
  const base = { streamUrl: 'http://x/y.m3u8', outputPattern: 'o_%03d.ts', container: 'ts', segmentMode: 'time', segmentMinutes: 1800, headers: {}, audioOnly: false, userAgent: '', isHttp: true };
  const withPx = buildRecordArgs({ ...base, proxy: 'http://127.0.0.1:7890' });
  const pi = withPx.indexOf('-http_proxy');
  ok(pi >= 0 && withPx[pi + 1] === 'http://127.0.0.1:7890', '开启代理时 ffmpeg 参数含 -http_proxy <代理地址>（录制拉流走代理）');
  ok(buildRecordArgs({ ...base, proxy: '' }).indexOf('-http_proxy') < 0, '未开代理时不含 -http_proxy（直连）');
}

/* 全局一致性审计守卫：把「前后端契约 / 多处口径不一致」的真实缺陷钉死，防止回退。 */
async function testAuditConsistency() {
  suite('全局一致性审计（前后端契约/口径）');
  const srv = fs.readFileSync(path.join(APP_DIR, 'server', 'server.js'), 'utf8');
  const st = fs.readFileSync(path.join(APP_DIR, 'server', 'storage.js'), 'utf8');
  const sch = fs.readFileSync(path.join(APP_DIR, 'server', 'scheduler.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(APP_DIR, 'server', 'store.js'), 'utf8');
  const filesView = fs.readFileSync(path.join(APP_DIR, 'web', 'views', 'files.js'), 'utf8');
  const tasksView = fs.readFileSync(path.join(APP_DIR, 'web', 'views', 'tasks.js'), 'utf8');

  ok(/delete body\.customize/.test(srv), 'PUT /api/settings 不落库 customize（脱敏占位不会覆盖真实 token）');
  ok(/delete patch\.customize\.updateToken/.test(storeSrc), 'store 兜底：占位符 token 不被写入');
  ok(/_recalcSession/.test(st), 'storage._recalcSession：删文件/还原/删源后统一重算体积与时长');
  ok(/trashRetentionDays/.test(st), '回收站保留天数取 trashRetentionDays（不误用录像 retentionDays）');
  ok(/dateKey\(new Date\(s\.startedAt\)\)/.test(srv), '文件日期筛选与「今日统计」同口径（本地时区 dateKey）');
  ok(/anchorNameLocked !== undefined && patch\.nameLocked === undefined/.test(sch), '编辑任务把 anchorNameLocked 归一为 nameLocked');
  ok(/s\.status === 'recording'/.test(filesView) && !/f\.status === 'recording'/.test(filesView), '文件库录制态取会话状态（文件行无 recording 状态）');
  ok(/s\.segmentIndex \|\| 0\)\.padStart\(3, '0'\)/.test(tasksView), '任务分段序号读 segmentIndex（不再恒 000）');

  // 行为：脱敏占位保存不会覆盖真实 token
  const store = await openStore(p('audit-token'));
  await store.updateSettings({ customize: { updateToken: 'REAL_TOKEN' } });
  await store.updateSettings({ customize: { updateToken: '••••••••' } });
  eq(store.settings.customize.updateToken, 'REAL_TOKEN', '行为：占位符 token 保存后真实 token 仍在');
}

// ============ 审计遗留 3 项（v0.1.36） ============
// ① 默认仅监控 defaultMonitorOnly；② 通知 onLive / dedupe 真正持久化；③ 安全页签不再写 localStorage（落 settings.security.*）
async function testAuditRemainder() {
  suite('审计遗留 3 项（defaultMonitorOnly / 通知持久化 / 安全落库）');

  // 行为：三个字段经 db 落盘与重载
  const dir = p('audit-remainder');
  const store = await openStore(dir);
  await store.updateSettings({ defaultMonitorOnly: true });
  await store.updateSettings({ notify: { onLive: false, dedupe: false, dedupeSec: 30 } });
  await store.updateSettings({ security: { sessionDays: 7, failLimit: 3, failLockMin: 5, trustLan: true } });
  const reloaded = await openStore(dir);
  ok(reloaded.settings.defaultMonitorOnly === true, 'defaultMonitorOnly 落盘并可重载', String(reloaded.settings.defaultMonitorOnly));
  ok(reloaded.settings.notify.onLive === false, 'notify.onLive=false 落盘并可重载', String(reloaded.settings.notify.onLive));
  ok(reloaded.settings.notify.dedupe === false, 'notify.dedupe=false 落盘并可重载', String(reloaded.settings.notify.dedupe));
  ok(reloaded.settings.notify.dedupeSec === 30, 'notify.dedupeSec 不变', String(reloaded.settings.notify.dedupeSec));
  ok(reloaded.settings.security.sessionDays === 7 && reloaded.settings.security.failLimit === 3
    && reloaded.settings.security.failLockMin === 5 && reloaded.settings.security.trustLan === true,
    'security.* 落盘并可重载', JSON.stringify(reloaded.settings.security || {}));

  // 行为：notify.dedupe=false 时 shouldDedupe 直接返回 false（去重总开关真正生效）
  const notifier = new Notifier({ store: reloaded, logger: { debug() {}, warn() {}, info() {}, error() {} } });
  ok(notifier.shouldDedupe('disk', 'taskX') === false, 'notify.dedupe=false → shouldDedupe 跳过');
  const storeOn = await openStore(p('audit-remainder-on'));
  await storeOn.updateSettings({ notify: { dedupe: true, dedupeSec: 30 } });
  const notifierOn = new Notifier({ store: storeOn, logger: { debug() {}, warn() {}, info() {}, error() {} } });
  ok(notifierOn.shouldDedupe('disk', 'taskY') === false, 'notify.dedupe=true → 首次发送不判重（记录时间戳）');
  ok(notifierOn.shouldDedupe('disk', 'taskY') === true, 'notify.dedupe=true → 短时间内重复发送被去重（生效）');

  // 契约：安全页签不再写 localStorage（之前是假开关），改为写 settings.security.*
  const secView = fs.readFileSync(path.join(APP_DIR, 'web', 'views', 'settings', 'tab-security.js'), 'utf8');
  ok(!/livegrab\.security\.prefs/.test(secView), '安全页签不再写 localStorage（假开关已修）');
  ok(/kit\.set\('security\.trustLan'/.test(secView), '安全页签经 kit.set 写入 settings.security.trustLan');
  ok(/kit\.set\('security\.sessionDays'/.test(secView), '安全页签经 kit.set 写入 settings.security.sessionDays');

  // 契约：通知页签 onLive 开关落到 notify.onLive（此前无 DB 列、写不进库）
  const ntView = fs.readFileSync(path.join(APP_DIR, 'web', 'views', 'settings', 'tab-notify.js'), 'utf8');
  ok(/'notify\.onLive'/.test(ntView), '通知页签开播开关写到 notify.onLive');
}
// ============ 5. 并发排队（D16） ============
// ============ 4b. 并发重复启动保护 ============
async function testPullBlockedBackoff() {
  suite('拉流被平台拒绝（403/风控）的冷却重试策略');
  // 纯函数：错误分类（不误判 URL 参数里的数字）与退避时长
  ok(isPullBlocked('http://pull-hls-l26.douyincdn.com/third/x.m3u8?sign=abc: Server returned 403 Forbidden (access denied)'), '403 Forbidden 判定为平台拒绝');
  ok(isPullBlocked('Server returned 401 Unauthorized'), '401 判定为平台拒绝');
  ok(isPullBlocked('Server returned 429 Too Many Requests'), '429（限流）判定为平台拒绝');
  ok(!isPullBlocked('Connection refused'), '连接拒绝不算平台拒绝');
  ok(!isPullBlocked('Operation timed out'), '超时不算平台拒绝');
  ok(!isPullBlocked('Server returned 404 Not Found'), '404 不算平台拒绝');
  ok(!isPullBlocked('http://x/y.m3u8?expire=6ada0124&sign=403fabc'), 'URL 参数里含 403 不误判');
  eq(reconnectDelay({ blocked: false, attempt: 1 }), 2000, '普通断流第 1 次重连等 2s');
  eq(reconnectDelay({ blocked: true, attempt: 1 }), 15000, '被拒第 1 次冷却 15s');
  eq(reconnectDelay({ blocked: true, attempt: 3 }), 60000, '被拒第 3 次冷却 60s');
  eq(reconnectDelay({ blocked: true, attempt: 5 }), 120000, '被拒第 5 次冷却 120s');
  eq(reconnectDelay({ blocked: true, attempt: 99 }), 120000, '被拒超出表长封顶 120s');

  // 行为：403 后 3 秒内不得出现第二次拉取（普通断流 2s 就会重试；被拒则冷却 ≥15s）
  const e = await makeEngine('blocked', { FAKE_FAIL_HTTP: '403' });
  const task = await e.scheduler.createTask({ url: 'https://example.com/live.m3u8', platform: 'direct', anchorName: '风控测试' });
  await e.scheduler.tick();
  const entered = await waitFor(() => (e.scheduler.recorders.get(task.id)?.reconnectAttempt || 0) >= 1, 8000, '首次失败进入重连锁');
  ok(entered, 'ffmpeg 报 403 后进入重连');
  const rec = e.scheduler.recorders.get(task.id);
  ok(isPullBlocked(rec.lastStderrError), 'stderr 被识别为平台拒绝', String(rec.lastStderrError || '').slice(0, 60));
  await sleep(3000);
  eq(rec.reconnectAttempt, 1, '403 冷却期内不重试（普通断流此时已第 2 次）');
  const blockedEvt = e.events.filter((x) => x.type === 'task' && /拉流被平台拒绝/.test(x.task?.statusMessage || ''));
  ok(blockedEvt.length > 0, '任务状态显示风控/限流提示', blockedEvt[0]?.task?.statusMessage);
  task.autoRecord = false;
  await e.store.saveTask(task);
  await e.scheduler.stopTask(task.id);
  delete process.env.FAKE_FAIL_HTTP; // 不影响后续套件
}

async function testConcurrentStart() {
  suite('并发启动保护（真实事故：两个 ffmpeg 写同一分段文件）');
  const e = await makeEngine('race', { FAKE_SEGMENT_MS: '200', FAKE_SEGMENTS_TOTAL: '2', FAKE_SEGMENT_MB: '0.1', FAKE_DURATION: '5' });
  let spawns = 0;
  e.scheduler.mediaMod = {
    ...fakeMedia,
    spawnFfmpeg: (...a) => { spawns++; return fakeMedia.spawnFfmpeg(...a); },
  };
  const task = await e.scheduler.createTask({ url: 'https://example.com/race.m3u8', platform: 'direct', anchorName: '并发测试' });
  // 模拟"调度 tick"与"手动开始录制"同时进入启动流程（旧实现会起两个 ffmpeg 写同一个文件）
  const [r1, r2] = await Promise.all([
    e.scheduler.startTask(task.id, { reason: 'manual' }),
    e.scheduler.startTask(task.id, { reason: 'manual' }),
  ]);
  const outcomes = [r1?.result, r2?.result];
  eq(outcomes.filter((r) => r?.started).length, 1, '并发启动只有一个真正开始录制');
  eq(outcomes.filter((r) => r?.already).length, 1, '重复的一次被幂等拦截');
  eq(e.scheduler.recorders.size, 1, '同一任务只有一个录制作业实例');
  eq(e.store.sessions.length, 1, '只创建一个场次（不会出现两份并行场次）');
  eq(spawns, 1, '只拉起一个 ffmpeg 进程', `spawn=${spawns}`);

  // 已在录制中的任务再被启动，同样必须拒绝
  const again = await e.scheduler._startRecording(e.store.getTask(task.id), { reason: 'live' });
  ok(again?.already === true, '录制中的任务再次启动被拒绝');
  eq(spawns, 1, '拒绝后没有新增 ffmpeg 进程');

  const stopped = await e.scheduler.stopTask(task.id);
  ok(stopped.stopped, '并发保护下仍能正常停止收尾');
  await waitFor(() => e.store.getTask(task.id).status === 'stopped', 8000, '收尾完成');
}

// ============ 4c. 同主播同日重复录制不得覆盖已有分段 ============
async function testRepeatSessionNaming() {
  suite('同主播同日重复录制：不覆盖已存在的分段文件');
  const e = await makeEngine('dup', { FAKE_SEGMENT_MS: '200', FAKE_SEGMENTS_TOTAL: '2', FAKE_SEGMENT_MB: '0.1', FAKE_DURATION: '5' });
  const t1 = await e.scheduler.createTask({ url: 'https://example.com/dup1.m3u8', platform: 'direct', anchorName: '同名主播' });
  await e.scheduler.tick();
  const ok1 = await waitFor(() => (e.store.sessions[0]?.segments?.length || 0) >= 1, 8000, '第一场产生分段');
  if (!ok1) return;
  const s1 = e.store.sessions[0];
  const firstSeg = s1.segments[0].path;
  // 造一个"已被占用的 _2 基名分段"（模拟上一场遗留：基名 + _2 + 001.ts）
  const decoy = path.join(path.dirname(firstSeg), `${path.basename(firstSeg).replace(/\.ts$/, '')}_2001.ts`);
  await fsp.writeFile(decoy, Buffer.alloc(4096, 7));
  const decoySize = fs.statSync(decoy).size;

  const t2 = await e.scheduler.createTask({ url: 'https://example.com/dup2.m3u8', platform: 'direct', anchorName: '同名主播' });
  await e.scheduler.tick();
  const started2 = await waitFor(() => e.store.getTask(t2.id).status === 'recording', 8000, '第二场开录');
  ok(started2, '同主播同日第二场可以开录（房间号不同，不算重复任务）');
  const s2 = e.store.sessions.find((s) => s.taskId === t2.id);
  await waitFor(() => (s2?.segments?.length || 0) >= 1, 8000, '第二场产生分段');
  ok(fs.existsSync(decoy) && fs.statSync(decoy).size === decoySize, '已被占用的后缀不会被新一轮录制覆盖（旧实现在这里会同名覆盖）', `${decoySize} → ${fs.existsSync(decoy) ? fs.statSync(decoy).size : '文件消失'}`);
  const seg2 = (s2?.segments || [])[0]?.path;
  ok(seg2 && seg2 !== decoy, '第二场选了不同的分段文件名', seg2 ? path.basename(seg2) : '无分段');
  ok(seg2 && path.basename(seg2) !== path.basename(firstSeg), '第二场分段与第一场分段不同名');
  await e.scheduler.stopTask(t1.id).catch(() => {});
  await e.scheduler.stopTask(t2.id).catch(() => {});
  await sleep(300);
}

// ============ 4d. 今日统计口径 ============
async function testTodayStats() {
  suite('今日统计口径（时区当天 / 分段累加 / 派生文件不计时长）');
  const e = await makeEngine('today');
  const now = new Date();
  const at = (dayOffset, h, m) => { const d = new Date(now); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const f = (completedAt, bytes, durationSec) => ({ id: uid('f'), completedAt, createdAt: completedAt, bytes, durationSec });
  e.store.state.sessions.push(
    { // 跨天会话：昨天开录，今天 00:30 结束
      id: 's_cross', startedAt: at(-1, 23, 0), endedAt: at(0, 0, 30), bytes: 3000, durationSec: 900,
      segments: [f(at(-1, 23, 50), 1000, 600), f(at(0, 0, 20), 2000, 300)],
      extras: [f(at(0, 0, 25), 500, 0)],
    },
    { // 全部在昨天
      id: 's_yest', startedAt: at(-1, 20, 0), endedAt: at(-1, 22, 0), bytes: 7000, durationSec: 500,
      segments: [f(at(-1, 21, 0), 7000, 500)], extras: [],
    },
    { // 全部在今天：派生文件（合并/转封装）只计文件与体积，时长不得重复累加
      id: 's_today', startedAt: at(0, 9, 0), endedAt: at(0, 10, 0), bytes: 300, durationSec: 240,
      segments: [f(at(0, 9, 30), 100, 120), f(at(0, 10, 0), 200, 120)],
      extras: [f(at(0, 10, 5), 50, 7200)],
    },
  );
  const st = e.scheduler.todayStats();
  eq(st.todayFiles, 5, '今日文件数只统计当天收尾的文件（跨天会话只算今天那部分）');
  eq(st.todayBytes, 2850, '今日体积按当天文件累加');
  eq(st.todayDurationSec, 540, '今日录制时长 = 当天各分段时长累加（派生文件不重复计时长）');
  eq(e.scheduler.status().stats.todayDurationSec, 540, '总览 stats 使用同一口径');
}

async function testQueue() {
  suite('并发上限与排队（D16）');
  const e = await makeEngine('queue', { FAKE_SEGMENT_MS: '200', FAKE_SEGMENTS_TOTAL: '2', FAKE_SEGMENT_MB: '0.1' });
  e.store.settings.maxConcurrency = 2;
  e.store.settings.platformCaps.direct = 1;
  await e.store.persist();
  const t1 = await e.scheduler.createTask({ url: 'https://example.com/a.m3u8', platform: 'direct', anchorName: 'A' });
  const t2 = await e.scheduler.createTask({ url: 'https://example.com/b.m3u8', platform: 'direct', anchorName: 'B' });
  await e.scheduler.tick();
  const anyStarted = await waitFor(() => e.store.tasks.some((t) => t.status === 'recording'), 8000, '有任务开始录制');
  if (!anyStarted) {
    console.log(`  [诊断] ${e.store.tasks.map((t) => `${t.anchorName}:${t.status}/${t.lastError || '-'}`).join(' | ')}`);
    console.log(`  [日志] ${e.logger.query({ limit: 14 }).map((l) => `${l.level}:${l.msg}`).join(' || ')}`);
  }
  ok(anyStarted, '并发有空位时任务开始录制');
  await e.scheduler.tick();
  const recList = e.store.tasks.filter((t) => t.status === 'recording');
  const qList = e.store.tasks.filter((t) => t.status === 'queued');
  eq(recList.length, 1, '平台上限=1 时只允许一路同时录制');
  eq(qList.length, 1, '另一个任务保持排队');
  ok(/平台上限/.test(qList[0]?.queueReason || ''), '排队原因写明平台上限', qList[0]?.queueReason);
  const running = recList[0];
  const waiting = qList[0];
  running.autoRecord = false;
  await e.store.saveTask(running);
  await e.scheduler.stopTask(running.id);
  await waitFor(() => e.store.getTask(waiting.id).status === 'recording', 12000, '空出并发后排队任务自动开始');
  ok(true, '有空位后排队任务自动开始录制');
  waiting.autoRecord = false;
  await e.store.saveTask(waiting);
  await e.scheduler.stopTask(waiting.id);

  // 全局上限
  e.store.settings.platformCaps.direct = 8;
  e.store.settings.maxConcurrency = 1;
  await e.store.persist();
  const t3 = await e.scheduler.createTask({ url: 'https://example.com/c.m3u8', platform: 'direct', anchorName: 'C' });
  const t4 = await e.scheduler.createTask({ url: 'https://example.com/d.m3u8', platform: 'direct', anchorName: 'D' });
  await e.scheduler.tick();
  const cqDone = await waitFor(() => [t3.id, t4.id].some((it) => e.store.getTask(it)?.status === 'recording') && [t3.id, t4.id].some((it) => e.store.getTask(it)?.status === 'queued'), 8000, 'C/D 一个录制一个排队');
  ok(cqDone, '全局上限=1 时 C/D 一路录制、一路排队');
  const cq = [t3, t4].map((x) => e.store.getTask(x.id));
  const qu = cq.find((t) => t.status === 'queued');
  ok(/全局上限/.test(qu?.queueReason || ''), '排队原因写明全局上限', qu?.queueReason);
  await e.scheduler.tick();
  await e.scheduler.batch('stop', [t3.id, t4.id]);
  await e.scheduler.batch('delete', [t3.id, t4.id]);
  eq(e.store.getTask(t3.id), null, '批量删除生效');
  for (const t of e.store.tasks) t.autoRecord = false;
  e.scheduler.stopPolling();
}

// ============ 6. 鉴权 ============
async function testAuth() {
  suite('鉴权（D1）');
  const dir = p('auth-config');
  const auth = await new Auth(dir).init();
  eq(auth.mode, 'init', '首次启动为初始化模式');
  let weak = false;
  try { await auth.createUser({ username: 'admin', password: '123' }); } catch (e) { weak = e.code === 'WEAK_PASSWORD'; }
  ok(weak, '弱密码被拒绝');
  await auth.createUser({ username: 'admin', password: 'livegrab123' });
  eq(auth.mode, 'login', '初始化后进入登录模式');
  let again = false;
  try { await auth.createUser({ username: 'admin', password: 'livegrab123' }); } catch (e) { again = e.code === 'ALREADY_INIT'; }
  ok(again, '不能重复初始化');
  const usersRaw = await fsp.readFile(path.join(dir, 'users.json'), 'utf8');
  ok(!usersRaw.includes('livegrab123'), '密码不以明文落盘');
  ok(/"hash"/.test(usersRaw) && /"salt"/.test(usersRaw), '密码以 scrypt 哈希 + salt 保存');

  const user = await auth.verifyLogin({ username: 'admin', password: 'livegrab123', ip: '1.2.3.4' });
  eq(user.username, 'admin', '正确密码登录成功');
  let bad = false;
  try { await auth.verifyLogin({ username: 'admin', password: 'wrong', ip: '1.2.3.4' }); } catch (e) { bad = e.code === 'BAD_CREDENTIALS'; }
  ok(bad, '错误密码被拒绝');
  for (let i = 0; i < 4; i++) { await auth.verifyLogin({ username: 'admin', password: 'wrong', ip: '9.9.9.9' }).catch(() => {}); }
  ok(auth.lockRemainSec('9.9.9.9') === 0, '失败 4 次不锁定（防止误伤）');
  const stillOk = await auth.verifyLogin({ username: 'admin', password: 'livegrab123', ip: '9.9.9.9' }).then(() => true).catch(() => false);
  ok(stillOk, '失败 4 次后正确密码仍可登录');
  for (let i = 0; i < 5; i++) { await auth.verifyLogin({ username: 'admin', password: 'wrong', ip: '9.9.9.9' }).catch(() => {}); }
  let locked = false;
  try { await auth.verifyLogin({ username: 'admin', password: 'livegrab123', ip: '9.9.9.9' }); } catch (e) { locked = e.code === 'LOCKED'; }
  ok(locked, '连续失败 5 次后锁定该 IP');

  const s = auth.issue(true, 30);
  ok(auth.verifyToken(s.token)?.sub === 'admin', '会话令牌可校验');
  ok(auth.verifyToken(`${s.token}x`) === null, '篡改令牌校验失败');
  const secret = (await fsp.readFile(path.join(dir, 'secret.key'), 'utf8')).trim();
  const b64 = (x) => Buffer.from(x).toString('base64url');
  const expiredBody = b64(JSON.stringify({ sub: 'admin', iat: Date.now() - 7200_000, exp: Date.now() - 3600_000 }));
  const expiredSig = b64(crypto.createHmac('sha256', secret).update(expiredBody).digest());
  ok(auth.verifyToken(`${expiredBody}.${expiredSig}`) === null, '过期令牌无效（签名合法也不行）');
  const noExpBody = b64(JSON.stringify({ sub: 'admin', iat: Date.now() }));
  const noExpSig = b64(crypto.createHmac('sha256', secret).update(noExpBody).digest());
  ok(auth.verifyToken(`${noExpBody}.${noExpSig}`) === null, '无 exp 的令牌无效');
  const cookies = parseCookies({ headers: { cookie: `a=1; ${'lg_session'}=${encodeURIComponent(s.token)}` } });
  ok(cookies.lg_session === s.token, 'Cookie 解析正确');
  await auth.changePassword({ oldPassword: 'livegrab123', newPassword: 'newpass123' });
  let oldBad = false;
  try { await auth.verifyLogin({ username: 'admin', password: 'livegrab123', ip: '5.5.5.5' }); } catch { oldBad = true; }
  ok(oldBad, '改密后旧密码失效');
  await auth.verifyLogin({ username: 'admin', password: 'newpass123', ip: '5.5.5.5' });
  ok(true, '改密后新密码可用');
}

// ============ 7. util ============
async function testUtil() {
  suite('工具函数');
  eq(formatBytes(0), '0 B', 'formatBytes 0');
  eq(formatBytes(1024), '1.00 KB', 'formatBytes KB');
  eq(formatBytes(1.94 * 1024 ** 3), '1.94 GB', 'formatBytes GB');
  eq(formatDuration(3725), '01:02:05', 'formatDuration');
  const r = parseRange('bytes=100-199', 1000);
  ok(r.start === 100 && r.end === 199, 'Range 解析');
  ok(parseRange('bytes=-100', 1000).start === 900, 'Range 后缀解析');
  ok(parseRange('bytes=2000-3000', 1000) === 'invalid', 'Range 越界');
  ok(parseRange(null, 1000) === null, '无 Range 返回 null');
  eq(parseRange('bytes=0-', 50).end, 49, 'Range 开区间到文件末');
  // 版本号必须真实来自 app/package.json（曾经在 ESM 里误用 __dirname 被 catch 吞掉，恒返回 0.0.0）
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
  eq(VERSION, pkg.version, 'VERSION 与 app/package.json 一致（非 0.0.0 兜底）');
  // errText：错误日志详情格式化（message + 关键字段 + cause 链 + 堆栈顶部帧）
  eq(errText(null), '未知错误', 'errText(null) 安全降级');
  eq(errText('boom'), 'boom', 'errText(字符串) 原样返回');
  const plain = new Error('炸了');
  plain.code = 'EOI';
  ok(errText(plain).startsWith('炸了（code=EOI）'), 'errText 带 code 标签');
  ok(errText(plain).includes(' @ at '), 'errText 普通 Error 带堆栈顶部帧');
  ok(!errText(plain).includes('\n'), 'errText 堆栈压成单行（日志按行存储）');
  const httpErr = new HttpError('X', '用户可见');
  eq(errText(httpErr), '用户可见（code=X status=400）', 'errText(HttpError) 只带 code/status、不带堆栈');
  ok(errText(httpErr, { withStack: true }).includes(' @ at '), 'errText withStack 可强制带堆栈');
  const wrapped = new Error('外层', { cause: new TypeError('内层') });
  ok(errText(wrapped).includes('外层'), 'errText 含外层 message');
  ok(errText(wrapped).includes('cause: 内层'), 'errText 展开 cause 链');
  const evt = { code: 'SPAWN_FAILED', message: 'ffmpeg 启动失败' };
  eq(errText(evt), 'ffmpeg 启动失败（code=SPAWN_FAILED）', 'errText 兼容事件载荷对象（recorder error 事件）');
  // seekRatio：播放器进度条点击定位（容器 rotate(90deg) 模拟横屏时沿 clientY 取比例）
  const rectH = { left: 0, top: 0, width: 300, height: 6 };
  eq(seekRatio(rectH, 150, 0), 0.5, 'seekRatio 未旋转：中点命中一半');
  eq(seekRatio(rectH, 300, 0), 1, 'seekRatio 未旋转：条末端为 1');
  eq(seekRatio(rectH, 999, 0), 1, 'seekRatio 未旋转：点过头裁剪到 1');
  eq(seekRatio(rectH, -50, 0), 0, 'seekRatio 未旋转：负值裁剪到 0');
  const rectR = { left: 0, top: 40, width: 6, height: 300 }; // 旋转后包围盒：视觉长度在 height
  eq(seekRatio(rectR, 0, 190, true), 0.5, 'seekRatio 旋转：沿 clientY 命中一半');
  eq(seekRatio(rectR, 0, 40, true), 0, 'seekRatio 旋转：视觉起点为 0');
  eq(seekRatio(rectR, 0, 999, true), 1, 'seekRatio 旋转：越界裁剪到 1');
  eq(seekRatio({ left: 0, top: 0, width: 0, height: 0 }, 10, 10), 0, 'seekRatio 零宽高安全降级');
}

// ============ 8. HTTP 冒烟 ============
async function testHttp() {
  suite('HTTP 服务冒烟（真实进程）');
  const configDir = p('http-config');
  const recordRoot = p('http-record');
  await fsp.mkdir(recordRoot, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), CONFIG_DIR: configDir, RECORD_ROOT: recordRoot, FFMPEG_PATH: 'nonexistent-ffmpeg' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const started = await waitFor(async () => {
    try { const r = await fetch(`${base}/api/health`); return r.ok; } catch { return false; }
  }, 20000, '服务启动');
  if (!started) { console.log(out.slice(-1500)); child.kill(); return; }
  ok(true, '服务在随机端口启动');

  const health = await (await fetch(`${base}/api/health`)).json();
  ok(health.ok && health.data.status === 'ok', 'GET /api/health 免登录可用');
  ok(health.data.ffmpeg.available === false, '未安装 ffmpeg 时健康检查如实报告', JSON.stringify(health.data.ffmpeg));

  const mode = await (await fetch(`${base}/api/auth/mode`)).json();
  eq(mode.data.mode, 'init', 'GET /api/auth/mode 首次为 init');

  let unauth = await fetch(`${base}/api/tasks`);
  eq(unauth.status, 401, '未登录访问受保护接口返回 401');

  const initRes = await fetch(`${base}/api/auth/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'livegrab123' }),
  });
  ok(initRes.ok, 'POST /api/auth/init 初始化管理员');
  const cookie = (initRes.headers.getSetCookie?.() || [])[0]?.split(';')[0] || initRes.headers.get('set-cookie')?.split(';')[0];
  ok(!!cookie && cookie.includes('lg_session'), '初始化后下发会话 Cookie', cookie);
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const j = async (r) => (await r).json();

  const me = await j(fetch(`${base}/api/auth/me`, { headers: H }));
  eq(me.data.user, 'admin', 'GET /api/auth/me 返回当前用户');

  const wrongLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'nope' }),
  });
  eq(wrongLogin.status, 401, '错误密码登录返回 401');

  const settings = await j(fetch(`${base}/api/settings`, { headers: H }));
  ok(settings.data.maxConcurrency === 8 && settings.data.cookies?.douyin?.has === false, 'GET /api/settings 返回默认设置并脱敏 Cookie');
  const putSettings = await j(fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ maxConcurrency: 6, platformCaps: { direct: 3 } }) }));
  ok(putSettings.data.maxConcurrency === 6 && putSettings.data.platformCaps.direct === 3, 'PUT /api/settings 局部更新生效');

  const cookieSet = await j(fetch(`${base}/api/settings/cookie`, { method: 'POST', headers: H, body: JSON.stringify({ platform: 'douyin', cookie: 'ttwid=abc; sessionid=def' }) }));
  ok(cookieSet.data.cookie.has === true, 'POST /api/settings/cookie 保存 Cookie');
  const settings2 = await j(fetch(`${base}/api/settings`, { headers: H }));
  ok(settings2.data.cookies.douyin.has === true && !JSON.stringify(settings2.data).includes('sessionid=def'), 'Cookie 只回传是否存在，不回传明文');

  const naming = await j(fetch(`${base}/api/naming`, { headers: H }));
  ok(naming.data.profiles.length >= 3 && naming.data.variables.length === 12, 'D12 命名配置 ≥3 套 + 12 个变量');
  const preview = await j(fetch(`${base}/api/naming/preview`, {
    method: 'POST', headers: H, body: JSON.stringify({ fnTemplate: '{日期}_{主播}_{清晰度}_{序号}', dirTemplate: '{平台}/{主播}/{日期}' }),
  }));
  ok(preview.data.lines.length === 3 && preview.data.lines[0].file.endsWith('_001.ts'), 'POST /api/naming/preview 出 3 行预览', preview.data.lines[0].file);

  const plats = await j(fetch(`${base}/api/platforms`, { headers: H }));
  ok(plats.data.items.length >= 8, 'GET /api/platforms 返回平台清单', `${plats.data.items.length} 个`);
  ok(plats.data.items.some((x) => x.id === 'douyin' && x.tier === 'stable'), '平台分层信息完整');

  const resolved = await j(fetch(`${base}/api/resolve`, { method: 'POST', headers: H, body: JSON.stringify({ url: 'https://example.com/test.m3u8' }) }));
  eq(resolved.data.platform, 'direct', 'POST /api/resolve 识别直链');

  const created = await j(fetch(`${base}/api/tasks`, {
    method: 'POST', headers: H, body: JSON.stringify({ url: 'https://example.com/test.m3u8', platform: 'direct', anchorName: '冒烟任务', autoRecord: false }),
  }));
  ok(created.data.id && created.data.platform === 'direct', 'POST /api/tasks 创建任务');
  const taskId = created.data.id;
  const dup = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { ...H }, body: JSON.stringify({ url: 'https://example.com/test.m3u8', platform: 'direct', autoRecord: false }),
  });
  eq(dup.status, 409, '重复房间返回 409');

  const patched = await j(fetch(`${base}/api/tasks/${taskId}`, { method: 'PATCH', headers: H, body: JSON.stringify({ quality: 'audio' }) }));
  eq(patched.data.quality, 'audio', 'PATCH /api/tasks/:id 生效');
  const listed = await j(fetch(`${base}/api/tasks`, { headers: H }));
  ok(listed.data.items.length === 1, 'GET /api/tasks 返回 1 个任务');
  const status = await j(fetch(`${base}/api/status`, { headers: H }));
  ok(status.data.stats && status.data.disk && status.data.engine, 'GET /api/status 结构完整');
  ok(Array.isArray(status.data.recent), '总览返回最近事件（日志页用它渲染「最近事件」）');
  ok(typeof status.data.stats.todayDurationSec === 'number' && typeof status.data.stats.todayFiles === 'number' && typeof status.data.stats.activeCount === 'number',
    '总览统计含 今日时长/今日文件数/并发（口径字段齐全）');
  const files = await j(fetch(`${base}/api/files`, { headers: H }));
  ok(files.data.summary && Array.isArray(files.data.items), 'GET /api/files 返回场次与汇总');
  ok(!('tree' in files.data) && !('jobs' in files.data), 'GET /api/files 已移除冗余 tree/jobs（死字段清理）');
  const treeRes = await fetch(`${base}/api/files/tree`, { headers: H });
  ok(treeRes.status === 404, '死端点 /api/files/tree 已移除（404）');
  const trash = await j(fetch(`${base}/api/trash`, { headers: H }));
  ok(trash.data.count === 0, 'GET /api/trash 初始为空');
  const logs = await j(fetch(`${base}/api/logs`, { headers: H, body: undefined }));
  ok(Array.isArray(logs.data.items) && logs.data.items.length > 0, 'GET /api/logs 有启动日志', `${logs.data.items.length} 条`);
  ok(logs.data.retentionDays === 14, 'D14 日志保留策略可查');

  const envInfo = await j(fetch(`${base}/api/settings/env`, { headers: H }));
  ok(envInfo.data.tz === 'Asia/Shanghai' && envInfo.data.ffmpegAvailable === false, 'GET /api/settings/env 返回时区与引擎状态', JSON.stringify(envInfo.data).slice(0, 120));

  const savedNaming = await j(fetch(`${base}/api/naming`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ activeId: 'p_bilibili', profiles: [...naming.data.profiles, { id: 'p_custom', name: '自定义', fnTemplate: '{主播}_{序号}', dirTemplate: '{平台}/{日期}', options: {} }] }),
  }));
  ok(savedNaming.data.activeId === 'p_bilibili' && savedNaming.data.profiles.length === naming.data.profiles.length + 1, 'PUT /api/naming 保存配置与绑定');
  const namingBack = await j(fetch(`${base}/api/naming`, { headers: H }));
  ok(namingBack.data.activeId === 'p_bilibili' && namingBack.data.profiles.some((p) => p.id === 'p_custom'), 'D12 命名配置已持久化');

  const delCookie = await j(fetch(`${base}/api/settings/cookie?platform=douyin`, { method: 'DELETE', headers: H }));
  ok(delCookie.data.ok === true, 'DELETE /api/settings/cookie 清除 Cookie');
  const settings3 = await j(fetch(`${base}/api/settings`, { headers: H }));
  ok(settings3.data.cookies.douyin.has === false, '清除后平台 Cookie 状态回到未配置');

  const scan = await j(fetch(`${base}/api/files/scan`, { method: 'POST', headers: H, body: '{}' }));
  ok(typeof scan.data.added === 'number' && typeof scan.data.missing === 'number' && typeof scan.data.unregistered === 'number', 'POST /api/files/scan 返回扫描统计', JSON.stringify(scan.data));
  const unregRes = await fetch(`${base}/api/files/unregistered`, { headers: H });
  ok(unregRes.status === 404, '死端点 /api/files/unregistered 已移除（404）');

  const batch = await j(fetch(`${base}/api/tasks/batch`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'delete', ids: [taskId] }) }));  ok(batch.data.okIds.length === 1, 'POST /api/tasks/batch 批量删除');
  const del = await fetch(`${base}/api/tasks/${taskId}`, { method: 'DELETE', headers: H });
  eq(del.status, 404, '删除后再取返回 404');

  const notifyTest = await j(fetch(`${base}/api/notify/test`, { method: 'POST', headers: H, body: '{}' }));
  ok(notifyTest.data.skipped === 'no-webhook', '未配置 Webhook 时测试通知被跳过');

  const badJson = await fetch(`${base}/api/tasks`, { method: 'POST', headers: H, body: '{oops' });
  eq(badJson.status, 400, '非法 JSON 返回 400');

  const logo = await fetch(`${base}/api/unknown-endpoint`, { headers: H });
  eq(logo.status, 404, '未知接口返回 404');

  child.kill();
  await sleep(500);
  ok(true, '服务已关闭');
}

/* 前端视图守卫（静态扫描）：视图的异步绘制必须经过各自模块的 boundRoot，
   否则路由切走后迟到的绘制会覆盖新视图（曾导致页面串页 / 旧视图覆盖新视图）。 */
function testViewGuards() {
  suite('web 视图守卫');
  const viewsDir = path.join(APP_DIR, 'web', 'views');
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(fp);
      else if (ent.name.endsWith('.js')) files.push(fp);
    }
  })(viewsDir);
  const rel = (arr) => arr.map((f) => path.relative(APP_DIR, f).replace(/\\/g, '/')).join(', ');
  ok(files.length >= 6, `扫到视图模块 ${files.length} 个`);

  const byId = files.filter((f) => /getElementById\(\s*['"]view['"]\s*\)/.test(fs.readFileSync(f, 'utf8')));
  ok(byId.length === 0, '视图不按 id 直取 #view（必须走 boundRoot 守卫）', rel(byId));

  const noDestroy = files.filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /\blet boundRoot\b/.test(src) && !/export function destroy\s*\(/.test(src);
  });
  ok(noDestroy.length === 0, '使用 boundRoot 的视图都导出 destroy()（路由切走时置空）', rel(noDestroy));

  const appSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'app.js'), 'utf8');
  ok(/makeViewCtx\(/.test(appSrc), 'app.js 为每次渲染注入绑定 token 的 ctx 门面');
  ok(/isActive = \(\) => runtime\.view === token/.test(appSrc), 'ctx.isActive() 能反映当前活动视图');
  ok(/stopView\(\);\s*\n\s*\n\s*let mod;/.test(appSrc), '路由切换先作废旧视图（在导入新模块之前）');

  /* nextFrame 不能只等 requestAnimationFrame：后台标签页 / 被遮挡窗口 / 无头或节流渲染 /
     省电模式下 rAF 可能长时间不回调，只等它会让 handleRoute 永久卡死（视图不再重绘、无报错）。
     必须带定时器兜底。 */
  const nf = appSrc.match(/function nextFrame\(\)\s*\{[\s\S]*?\n\}/);
  ok(!!nf, 'app.js 存在 nextFrame()（路由渲染前的等帧）');
  ok(!!nf && /setTimeout\(/.test(nf[0]), 'nextFrame() 带 setTimeout 兜底（rAF 被节流/停止时路由不会卡死）');

  /* 手机播放器强制横屏：旋转必须落在内层舞台上。
     全屏元素会被 UA 样式表强制 position/inset/width/height/transform 全部 !important（含 transform:none），
     所以把旋转写在 #plBox 上时，一进全屏就完全失效（「点了横屏没反应」的根因）。 */
  const uiSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'ui.js'), 'utf8');
  ok(/class="pv-mobile"\s+id="plBox"[\s\S]*?class="pv-stage"\s+id="plStage"/.test(uiSrc), '手机播放器有内层舞台 #plStage（旋转/布局的落点）');
  const iStage = uiSrc.indexOf('id="plStage"');
  ok(iStage > 0 && uiSrc.indexOf('id="plVideo"', iStage) > iStage && uiSrc.indexOf('id="plOrient"', iStage) > iStage, '视频与控制条都挂在舞台 #plStage 内（随之一起旋转）');
  const cssSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'app.css'), 'utf8');
  const onBox = cssSrc.match(/\.pv-mobile\.pv-land\s*\{[^}]*\}/);
  ok(!onBox || !/transform\s*:/.test(onBox[0]), '不把旋转加在全屏元素 #plBox 上（UA 会强制其 transform:none !important）');
  ok(/\.pv-mobile\.pv-land\s+\.pv-stage\s*\{[^}]*transform\s*:\s*translate\(-50%,\s*-50%\)\s*rotate\(90deg\)/.test(cssSrc), '强制横屏：舞台宽高互换 + 旋转 90°');
  ok(/@media\s*\(orientation:landscape\)\s*\{[\s\S]{0,220}?\.pv-mobile\.pv-land\s+\.pv-stage\s*\{[^}]*transform\s*:\s*none/.test(cssSrc), '设备真转横屏后由媒体查询取消旋转（不靠 JS 判断方向）');
  ok(!/orientLockFailed|orientLockUnsupported/.test(uiSrc), '方向锁失败不再弹提示（CSS 旋转兜底，不打断观看）');

  /* 任务管理查询框（用户报「刚输入一个字就查询、查询不能正常用」）：
     搜索防抖必须走局部重绘（paintResults），绝不能触发全量 paint() 重建 #tkQ，
     否则每敲一个字焦点/光标就丢、无法连续输入；2s 轮询同样只局部重绘，不得抢焦点；
     防抖 300ms 给足连续输入/中文组词时间。 */
  const tasksSrc = fs.readFileSync(path.join(APP_DIR, 'web', 'views', 'tasks.js'), 'utf8');
  ok(/function paintResults\s*\(/.test(tasksSrc), '任务视图有 paintResults()（只重绘结果区，不重建搜索框）');
  ok(/setTimeout\(\(\) => \{ state\.page = 1; tick\(ctx, false\); \}, 300\)/.test(tasksSrc), '任务查询防抖 = 局部重绘 tick(ctx,false) + 300ms（不再一输就查、不抢焦点）');
  ok(/ctx\.onRefresh\(\(\) => tick\(ctx, false\)\)/.test(tasksSrc), '任务视图 2s 轮询走局部重绘（不得抢走搜索框焦点）');
  ok(/function bindTable\s*\(/.test(tasksSrc) && /bindTable\(ctx\)/.test(tasksSrc), '局部重绘后重绑表格行内按钮（换数据不换操作）');

  /* 播放器进度条（用户报「只能点击、不能拖动」）：必须 Pointer Events +
     setPointerCapture，不得退回 onclick；拖动中只回绘预览、松手才写 currentTime；
     横屏时舞台被 rotate(90deg)，seek 方向必须实时读舞台矩阵（不得硬编码 false）。 */
  ok(/export function bindSeekTrack\s*\(/.test(uiSrc), '有 bindSeekTrack()：进度条点击+拖动共用一套 seek');
  ok(uiSrc.includes("addEventListener('pointerdown'") && uiSrc.includes("addEventListener('pointermove'") && uiSrc.includes("addEventListener('pointerup'") && uiSrc.includes("addEventListener('pointercancel'"), '拖动用 Pointer Events 四件套（按下/移动/松手/取消）');
  ok(uiSrc.includes('setPointerCapture'), '按下即捕获指针（手指划出进度条也能继续拖）');
  ok(/bindSeekTrack\(mask\.querySelector\('#plTrack'\)/.test(uiSrc), '桌面播放器进度条走 bindSeekTrack');
  ok(/bindSeekTrack\(track,/.test(uiSrc) && /getRotated: \(\) => isRotated90/.test(uiSrc), '手机播放器进度条走 bindSeekTrack，横屏方向动态读舞台矩阵');
  ok(!/mask\.querySelector\('#plTrack'\)\.onclick/.test(uiSrc) && !/track\.onclick\s*=/.test(uiSrc), '两条进度条都不再只用 onclick（拖动必须接线）');
  ok(/export function isRotated90\s*\(/.test(uiSrc) && /matrix\\\(/.test(uiSrc), 'isRotated90() 读 computed transform 矩阵实时判断旋转');
  ok(/touch-action:none/.test(cssSrc) && /\.pv-track::before/.test(cssSrc) && /\.pv-mtrack::before/.test(cssSrc), '进度条 touch-action:none + 伪元素扩触控命中区（拖动才按得准）');
}

/* 更新链路守卫（静态扫描）：拉取必须在「弱网/代理会改写长连接」的现实下仍然可用，
   并在 git 传输彻底不可用时走快照通道兜底。这些是踩过的坑，用断言钉死。 */
function testUpdateGuards() {
  suite('更新链路守卫');
  const upd = fs.readFileSync(path.join(APP_DIR, 'server', 'update.js'), 'utf8');

  ok(/http\.version=HTTP\/1\.1/.test(upd), 'git 传输层强制 HTTP/1.1（HTTP2 framing / ref listing 报错的根因）');
  ok(/protocol\.version=0/.test(upd), '降级档位带 protocol v0（绕开 v2 的 ref 通告解析）');
  ok(/FETCH_PLAN\s*=\s*\[[\s\S]*?\]\s*;/.test(upd) && (upd.match(/legacyRefs:\s*true/g) || []).length >= 2, '拉取失败有多档降级重试计划');
  ok(/GIT_TERMINAL_PROMPT:\s*'0'/.test(upd), '禁用 git 交互式凭据提示（无 token 时不挂在等待输入）');
  ok(/classifyGitError/.test(upd) && /_logGitAdvice/.test(upd), '失败后按原因分级并给出可操作建议');
  ok(/'merge',\s*'--ff-only',\s*'FETCH_HEAD'/.test(upd), '快进用本地 FETCH_HEAD（不再为同一段网络赌第二次）');
  ok(!/'pull',\s*'--ff-only'/.test(upd), '不再调用 git pull --ff-only（fetch + merge 两步各自可控）');
  ok(!/\[[^\]]*'fetch',\s*'origin'/.test(upd), 'fetch 不写死 origin（远端取配置地址）');

  ok(/codeload\.github\.com/.test(upd), 'git 传输不可用时走 codeload 快照通道');
  ok(/zlib\.gunzipSync/.test(upd) && /function parseTarEntries/.test(upd), '零依赖解包 tar.gz（不依赖容器内 tar/curl）');
  ok(/livegrab-snapshot\.json/.test(upd), '快照状态写入 .git 内标记文件（不污染工作区）');
  ok(/_contentDigest/.test(upd) && /reset',\s*'--hard',\s*'FETCH_HEAD'/.test(upd), '快照后可按内容指纹安全自愈对齐 git 索引');
  ok(/'ls-tree',\s*'-r',\s*'-z'/.test(upd), '只清理「旧 commit 跟踪过」的文件（-z 取原始路径，避免非 ASCII 被转义而算错删除集）');

  const ep = fs.readFileSync(path.join(APP_DIR, '..', 'deploy', 'entrypoint.sh'), 'utf8');
  ok(/GIT_FIX=.*http\.version=HTTP\/1\.1/.test(ep), '容器首次克隆同样走 HTTP/1.1 + protocol v0');
  ok(/while\s+\[[^\]]*CLONE_TRY[^\]]*\]/.test(ep), '容器首次克隆失败会自动重试（3 次）');
  ok(/GIT_TERMINAL_PROMPT=0/.test(ep), '容器克隆禁用交互式凭据提示（否则私库无 token 时启动卡死）');
}

// ============ 12. 审计遗留死代码清理 ============
async function testDeadCodeRemainder() {
  suite('审计遗留死代码清理');
  const APP = APP_DIR;
  const srv = fs.readFileSync(path.join(APP, 'server', 'server.js'), 'utf8');
  const storage = fs.readFileSync(path.join(APP, 'server', 'storage.js'), 'utf8');
  const tasks = fs.readFileSync(path.join(APP, 'web', 'views', 'tasks.js'), 'utf8');
  const api = fs.readFileSync(path.join(APP, 'web', 'api.js'), 'utf8');
  const pfTab = fs.readFileSync(path.join(APP, 'web', 'views', 'settings', 'tab-platform.js'), 'utf8');

  // 死端点 / 死字段已移除
  ok(!/route\(\s*'GET',\s*'\/api\/files\/tree'/.test(srv), '死端点 /api/files/tree 已从 server.js 移除');
  ok(!/route\(\s*'GET',\s*'\/api\/files\/unregistered'/.test(srv), '死端点 /api/files/unregistered 已从 server.js 移除');
  ok(!/route\(\s*'POST',\s*'\/api\/files\/import'/.test(srv), '死端点 /api/files/import 已从 server.js 移除');
  ok(!/function treeFor/.test(srv) && !/treeFor\(/.test(srv), 'treeFor 辅助函数已移除（/api/files 不再返回 tree/jobs）');
  ok(!/async importExternal/.test(storage), 'storage.importExternal 死方法已移除');
  ok(!/filesTree/.test(api) && !/unregistered:/.test(api) && !/importFiles/.test(api), 'api.js 死包装 filesTree/unregistered/importFiles 已移除');

  // customText 不再被保存时无条件清空
  ok(!/payload\.overrides\.customText\s*=\s*null/.test(tasks), '保存任务不再无条件清空 customText（老任务的自定义文本得以保留）');
  ok(!/\[\s*'recording',\s*'stopping',\s*'merging'\s*\]/.test(tasks), "任务状态 'merging' 永不产生，录制判定已剔除死状态");

  // 平台默认启用口径统一：后端 platformList 以 tier 为准，前端改用 p.enabled
  const list = resolvers.platformList({ platformEnabled: {}, platformCaps: {} });
  const acfun = list.find((p) => p.id === 'acfun');
  const douyin = list.find((p) => p.id === 'douyin');
  const direct = list.find((p) => p.id === 'direct');
  ok(acfun && acfun.enabled === false, "planned 平台（acfun）默认 disabled（与前端 p.enabled 一致）");
  ok(douyin && douyin.enabled === true, 'stable 平台（douyin）默认 enabled');
  ok(direct && direct.enabled === true, 'direct（直链）默认 enabled（前端映射已补全）');
  ok(!/enabledSet\[p\.id\]\s*!==\s*false/.test(tasks), '前端平台下拉不再用不一致的 !== false 表达式');
  ok(!/platformEnabled\)\s*\|\|\s*\{\}\)\s*\[p\.id\]/.test(tasks), '前端编辑态平台过滤改用 p.enabled（与后端 platformList 一致）');
  ok(!/\(kit\.state\.settings\.platformEnabled \|\| \{\}\)\[p\.id\]/.test(pfTab), '平台设置页开关改用 p.enabled（与后端口径一致）');
}

// ============ 11. 代理（按平台 / 系统更新） ============
async function testProxy() {
  suite('代理（按平台 / 系统更新）');
  const { effectiveProxyForPlatform, runWithProxy, proxyStore } = proxyFetch;

  // 生效代理 = 平台开关开 且 全局代理已配置；否则空（直连）
  eq(effectiveProxyForPlatform('douyin', { platformUseProxy: {}, proxy: 'http://1.2.3.4:7890' }), '', '开关未开 → 直连（空）');
  eq(effectiveProxyForPlatform('douyin', { platformUseProxy: { douyin: true }, proxy: '' }), '', '开关开但无全局代理 → 直连（空）');
  eq(effectiveProxyForPlatform('douyin', { platformUseProxy: { douyin: true }, proxy: 'http://1.2.3.4:7890' }), 'http://1.2.3.4:7890', '开关开且已配代理 → 返回该代理');
  eq(effectiveProxyForPlatform('bili', { platformUseProxy: { douyin: true }, proxy: 'http://1.2.3.4:7890' }), '', '其它平台开关未开 → 直连（空）');

  // 代理地址归一化：缺协议自动补 http://（否则 new URL / git -c http.proxy 都可能异常）
  eq(proxyFetch.normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890', '代理缺协议自动补 http://');
  eq(proxyFetch.normalizeProxy('socks5h://1.2.3.4:1080'), 'socks5h://1.2.3.4:1080', '带协议的代理原样保留');
  eq(proxyFetch.normalizeProxy('   '), '', '空代理归一化为空');
  eq(effectiveProxyForPlatform('douyin', { platformUseProxy: { douyin: true }, proxy: '127.0.0.1:7890' }), 'http://127.0.0.1:7890', '生效代理缺协议自动补全');

  // runWithProxy：空代理直接执行；有代理时注入 AsyncLocalStorage 上下文
  const r1 = await runWithProxy('', async () => proxyStore.getStore()?.proxy || '');
  eq(r1, '', 'runWithProxy 空代理：上下文无代理，直接执行');
  const r2 = await runWithProxy('http://9.9.9.9:1080', async () => proxyStore.getStore()?.proxy || '');
  eq(r2, 'http://9.9.9.9:1080', 'runWithProxy 有代理：注入到 AsyncLocalStorage 上下文（解析器内 httpGet 自动读取）');

  // 持久化：platformUseProxy 经 db 落盘与重载
  const dir = p('proxy-config');
  const store = await openStore(dir);
  await store.updateSettings({ platformUseProxy: { douyin: true, bilibili: false } });
  const reloaded = await openStore(dir);
  ok(reloaded.settings.platformUseProxy?.douyin === true && reloaded.settings.platformUseProxy?.bilibili === false,
    'platformUseProxy 落盘并可重载', JSON.stringify(reloaded.settings.platformUseProxy || {}));

  // 系统更新守卫：update.js 优先使用代理
  const upd = fs.readFileSync(path.join(APP_DIR, 'server', 'update.js'), 'utf8');
  ok(/getProxy/.test(upd) && /_proxy\(\)/.test(upd), 'UpdateManager 注入 getProxy 读取全局代理');
  ok(/await this\._fetch\(/.test(upd) && /httpGetViaProxy|httpGetBufferViaProxy/.test(upd), 'GitHub API / 快照下载经代理客户端（无代理时回退 fetch）');
  ok(/HTTPS_PROXY/.test(upd) && /HTTP_PROXY/.test(upd), 'git fetch 经 HTTPS_PROXY/HTTP_PROXY 走代理');
  ok(/_gitProxyArgs/.test(upd) && /http\.proxy=\$\{proxy\}/.test(upd) && /https\.proxy=\$\{proxy\}/.test(upd), 'git fetch 显式 -c http.proxy/https.proxy（比环境变量更稳，兼容 socks）');
  ok(/ALL_PROXY/.test(upd) && /NO_PROXY/.test(upd), 'git 环境注入 ALL_PROXY 并清空 NO_PROXY（防 socks 不生效/被绕过）');
  ok(/return \[\.\.\.this\._gitProxyArgs\(\)/.test(upd), '拉取参数实际带上代理 -c');

  // CONNECT 隧道必须手写握手：用 http.request({socket}) 时 Node 不会写 CONNECT（开了代理反而连不通）
  const pf = fs.readFileSync(path.join(APP_DIR, 'server', 'proxy-fetch.js'), 'utf8');
  ok(/CONNECT \$\{targetHost\}:\$\{targetPort\}/.test(pf), 'CONNECT 隧道用手写握手（不依赖 http.request 的 socket 选项）');
}

// ============ 主流程 ============
(async () => {
  console.log(`LiveGrab 测试开始（临时目录 ${tmpRoot}）`);
  await rmrf(tmpRoot);
  await fsp.mkdir(tmpRoot, { recursive: true });
  const suites = [testUtil, testNaming, testStore, testResolvers, testAuth, testRecordChain, testRemuxFollowGlobal, testPullBlockedBackoff, testConcurrentStart, testRepeatSessionNaming, testTodayStats, testQueue, testHttp, testViewGuards, testUpdateGuards, testProxy, testSegmentEndReason, testSegmentGuards, testFfmpegGuards, testFileScanGuards, testFileOrder, testRecorderLiveProxy, testAuditConsistency, testAuditRemainder, testDeadCodeRemainder];
  for (const s of suites) {
    try { await s(); } catch (e) {
      failed++;
      failures.push(`${currentSuite} / 异常抛出：${e.message}`);
      console.log(`  FAIL  套件异常：${e.stack}`);
    }
  }
  console.log(`\n================ 结果 ================`);
  console.log(`PASS ${passed} ｜ FAIL ${failed}`);
  if (failures.length) {
    console.log('失败清单：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  await rmrf(tmpRoot);
  process.exit(failed ? 1 : 0);
})();
