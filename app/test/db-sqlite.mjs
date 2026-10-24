// SQLite 持久层回归测试（v2 db.js + store.js）：表结构 / 落库口径 / 关库重开闭环 / 旧库作废重建。
// 运行：node test/db-sqlite.mjs      （无需 ffmpeg / 无需网络，全部在临时目录里跑完即清）
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDb, schemaVersion, SCHEMA_VERSION } from '../server/db.js';
import { Store } from '../server/store.js';
import { buildRoomUrl } from '../server/resolvers/room-url.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-db-test-'));
const dbPath = path.join(tmp, 'livegrab.db');
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name} ${extra}`); }
};

const db = openDb(dbPath);
check('schema_version == 2', schemaVersion(db) === SCHEMA_VERSION, `got ${schemaVersion(db)}`);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
for (const t of ['meta', 'settings', 'platform_caps', 'platform_enabled', 'notify', 'security', 'cookies', 'customize',
  'naming', 'naming_profiles', 'naming_variables', 'tasks', 'task_overrides', 'sessions', 'files',
  'trash', 'trash_files', 'trash_sessions']) {
  check(`表 ${t} 存在`, tables.includes(t));
}
const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name);
check('无 data_json（tasks/sessions/files）', !['tasks', 'sessions', 'files'].some((t) => cols(t).includes('data_json')));
check('无 file_relations 表', !tables.includes('file_relations'));
check('files.thumbnail_path/scrape_path 存在', ['thumbnail_path', 'scrape_path'].every((c) => cols('files').includes(c)));
check('tasks 无 avatar/segments/quality_fallback 列', !['avatar', 'segments', 'quality_fallback'].some((c) => cols('tasks').includes(c)));
check('naming_variables 已补种', db.prepare('SELECT COUNT(*) c FROM naming_variables').get().c >= 12);

const store = await new Store(tmp).init(db);
check('settings 单行已落库', db.prepare('SELECT COUNT(*) c FROM settings').get().c === 1);
check('命名档已落库 3 个', db.prepare('SELECT COUNT(*) c FROM naming_profiles').get().c === 3);

// ---------- 任务 ----------
const t = Store.newTask({
  platform: 'douyin', roomId: '12345', anchorName: '测试主播',
  sourceUrl: buildRoomUrl('douyin', { roomId: '12345' }),
  overrides: { quality: 'hd' }, reconnectMax: 3,
});
await store.addTask(t);
check('任务入库', db.prepare('SELECT COUNT(*) c FROM tasks').get().c === 1);
check('source_url 规范为直播间地址', db.prepare('SELECT source_url u FROM tasks').get().u === 'https://live.douyin.com/12345');
check('overrides 落子表', db.prepare('SELECT value v FROM task_overrides WHERE task_id = ?').get(t.id).v === '"hd"');
check('reconnect_max 落真实列', db.prepare('SELECT reconnect_max m FROM tasks').get().m === 3);
check('newTask 无 avatar/segments/qualityFallback', !('avatar' in t) && !('segments' in t) && !('qualityFallback' in t));

// ---------- 场次 + 文件 ----------
store.settings.recordRoot = tmp; // 模拟 bootstrap 注入
const seg = { id: 'f1', kind: 'segment', name: 'a.ts', path: path.join(tmp, 'rec', 'a.ts'), relPath: 'rec/a.ts', ext: 'ts', bytes: 1024, status: 'ok', segmentIndex: 1, createdAt: '2026-01-01T00:00:00.000Z' };
const merged = { id: 'f2', kind: 'merged', name: 'a.mp4', path: path.join(tmp, 'rec', 'a.mp4'), ext: 'mp4', bytes: 2048, status: 'ok', segmentIndex: 0, sourceFileId: 'f1' };
const s = {
  id: 's1', taskId: t.id, platform: 'douyin', platformName: '抖音', roomId: '12345', streamer: '测试主播', title: '标题',
  quality: 'origin', qualityLabel: '原画', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T01:00:00.000Z',
  durationSec: 3600, bytes: 3072, status: 'completed', dir: path.join(tmp, 'rec'), relDir: 'rec',
  taskSnapshot: { anchorName: '测试主播', roomId: '12345' }, segments: [seg], extras: [merged], merged, mp4: null,
};
await store.addSession(s);
check('场次入库', db.prepare('SELECT COUNT(*) c FROM sessions').get().c === 1);
check('文件入库 2 行', db.prepare('SELECT COUNT(*) c FROM files').get().c === 2);
check('merged_file_id 指向合并文件', db.prepare('SELECT merged_file_id m FROM sessions').get().m === 'f2');
check('snap_anchor_name 快照写入', db.prepare('SELECT snap_anchor_name a FROM sessions').get().a === '测试主播');
check('source_file_id 落列', db.prepare("SELECT source_file_id s FROM files WHERE id='f2'").get().s === 'f1');

await store.setFileThumbnailByPath(seg.path, path.join(tmp, 'rec', 'a.jpg'));
check('thumbnail_path 按路径回写', db.prepare('SELECT thumbnail_path p FROM files WHERE id = ?').get('f1').p === 'rec/a.jpg');

// 刮削侧车：与 storage._markArt 同一条写入口（改 rec 后 saveSession）
seg.scrapePath = 'rec/a.nfo';
await store.saveSession(s);
check('scrape_path 落列（刮削信息）', db.prepare("SELECT scrape_path p FROM files WHERE id='f1'").get().p === 'rec/a.nfo');

// ---------- 外部文件 ----------
store.state.external.push({ id: 'f9', kind: 'unregistered', name: 'x.mp4', path: path.join(tmp, 'ext', 'x.mp4'), bytes: 10, status: 'ok' });
await store.persist();
check('外部文件落 kind=external', db.prepare("SELECT kind k FROM files WHERE id='f9'").get().k === 'external');
check('外部文件 session_id 为 NULL', db.prepare("SELECT session_id s FROM files WHERE id='f9'").get().s === null);

// ---------- 回收站快照 ----------
const trEntry = {
  id: 'tr1', kind: 'session', name: '测试主播 · 标题', bytes: 3072,
  deletedAt: new Date().toISOString(), expireAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  items: [
    { origPath: seg.path, trashPath: path.join(tmp, '.trash', '1__a.ts'), name: 'a.ts', bytes: 1024, kind: 'segment', record: { ...seg } },
    { origPath: path.join(tmp, 'rec', 'a.jpg'), trashPath: null, name: 'a.jpg', bytes: 5, kind: 'sidecar' },
  ],
  session: s,
};
await store.addTrash(trEntry);
check('回收站主表 1 行', db.prepare('SELECT COUNT(*) c FROM trash').get().c === 1);
check('回收站文件快照 2 行', db.prepare('SELECT COUNT(*) c FROM trash_files').get().c === 2);
check('回收站场次快照 1 行', db.prepare('SELECT COUNT(*) c FROM trash_sessions').get().c === 1);
check('场次快照保留主播名', db.prepare('SELECT streamer x FROM trash_sessions').get().x === '测试主播');
check('侧车项无 record → file_id 为空', db.prepare("SELECT file_id f FROM trash_files WHERE kind='sidecar'").get().f === null);

// ---------- 设置 / Cookie / 命名 写穿透 ----------
await store.updateSettings({ maxConcurrency: 3, qualityFallback: ['origin', 'hd'], mergeOnStop: true });
check('设置写穿透（含逗号串 quality_fallback）', db.prepare('SELECT quality_fallback q FROM settings').get().q === 'origin,hd');
check('mergeOnStop 落列', db.prepare('SELECT merge_on_stop m FROM settings').get().m === 1);
await store.setCookie('douyin', 'ttwid=abc123; other=1');
const ck = db.prepare("SELECT value v, ttwid t FROM cookies WHERE platform='douyin'").get();
check('Cookie 明文入库 + ttwid 提取', !!ck.v && ck.t === 'abc123');
check('cookies 无 __ttwid 行', !db.prepare("SELECT 1 x FROM cookies WHERE platform='__ttwid'").get());
await store.setNaming({ activeId: 'p_douyin' });
check('命名 activeId 写穿透', db.prepare('SELECT active_id a FROM naming').get().a === 'p_douyin');
await store.updateSettings({ customize: { testKey: { a: 1 } } });
check('customize 以 JSON 文本入库', db.prepare("SELECT value v FROM customize WHERE key='testKey'").get().v === '{"a":1}');

// ---------- 关库重开：持久化闭环 ----------
db.close();
const db2 = openDb(dbPath);
const store2 = await new Store(tmp).init(db2);
check('重开后任务恢复', store2.tasks.length === 1 && store2.tasks[0].id === t.id);
check('重开后 overrides 恢复', store2.tasks[0].overrides?.quality === 'hd');
check('重开后 sourceUrl 恢复', store2.tasks[0].sourceUrl === 'https://live.douyin.com/12345');
check('重开后 reconnectMax 恢复', store2.tasks[0].reconnectMax === 3);
check('重开后场次+文件恢复', store2.sessions.length === 1 && store2.sessions[0].segments.length === 1 && store2.sessions[0].merged?.id === 'f2');
check('重开后 thumbnailPath 恢复', store2.sessions[0].segments[0].thumbnailPath === 'rec/a.jpg');
check('重开后 scrapePath 恢复（刮削信息）', store2.sessions[0].segments[0].scrapePath === 'rec/a.nfo');
check('重开后 taskSnapshot 恢复', store2.sessions[0].taskSnapshot?.anchorName === '测试主播');
check('重开后外部文件恢复为 unregistered', store2.external.length === 1 && store2.external[0].kind === 'unregistered');
check('重开后回收站恢复(items/session)', store2.trash.length === 1 && store2.trash[0].items.length === 2
  && store2.trash[0].items[0].record?.id === 'f1' && store2.trash[0].session?.streamer === '测试主播');
check('重开后设置恢复', store2.settings.maxConcurrency === 3 && store2.settings.qualityFallback.join(',') === 'origin,hd' && store2.settings.mergeOnStop === true);
check('重开后 Cookie 恢复且 valid', !!store2.settings.cookies.douyin?.value && store2.settings.cookies.douyin.valid === true && store2.settings.cookies.douyin.ttwid === 'abc123');
check('重开后 customize 解析回对象', store2.settings.customize.testKey?.a === 1);
check('重开不会重复插入 settings', db2.prepare('SELECT COUNT(*) c FROM settings').get().c === 1);
// ---------- importExternal：未登记文件 → 独立场次（路径推断平台/主播、文件名推断开始时间） ----------
store2.settings.recordRoot = tmp; // 运行时由启动参数注入，测试需手动给
fs.mkdirSync(path.join(tmp, '抖音', '测试主播'), { recursive: true });
fs.mkdirSync(path.join(tmp, '哔哩哔哩', '央视网快看'), { recursive: true });
const fx1Path = path.join(tmp, '抖音', '测试主播', '2026-03-01-12-30-00-001.mp4');
const fx2Path = path.join(tmp, '哔哩哔哩', '央视网快看', '2026-02-10-08-00-00-001.ts');
fs.writeFileSync(fx1Path, 'x'.repeat(16));
fs.writeFileSync(fx2Path, 'y'.repeat(16));
const pushExt = (id, name, p, relPath, ext, bytes) => {
  store2.external.push({
    id, kind: 'unregistered', name, path: p, relPath, ext, bytes, status: 'ok',
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:00.000Z', durationSec: 0, segmentIndex: 0,
  });
};
pushExt('fx1', '2026-03-01-12-30-00-001.mp4', fx1Path, '抖音/测试主播/2026-03-01-12-30-00-001.mp4', 'mp4', 12345);
pushExt('fx2', '2026-02-10-08-00-00-001.ts', fx2Path, '哔哩哔哩/央视网快看/2026-02-10-08-00-00-001.ts', 'ts', 67890);
pushExt('fx3', '2026-01-01-00-00-00-001.mp4', path.join(tmp, '不存在.mp4'), '抖音/幽灵/2026-01-01-00-00-00-001.mp4', 'mp4', 1); // 磁盘不存在 → 应跳过
const { Storage } = await import('../server/storage.js');
const storage = new Storage({ store: store2, logger: { info() {}, warn() {}, error() {} } });
// 现由扫描自动登记（storage._registerUnregistered），不再有 importExternal 死方法
let imported = 0;
for (const rec of [...store2.external]) {
  if (await storage._registerUnregistered(rec)) imported++;
}
check('未登记文件只导入磁盘存在的（跳过不存在的 f9/fx3）', imported === 2);
const sx1 = store2.sessions.find((s) => s.segments[0]?.id === 'fx1');
const sx2 = store2.sessions.find((s) => s.segments[0]?.id === 'fx2');
check('导入后外部区移除', store2.external.filter((f) => f.id === 'fx1' || f.id === 'fx2').length === 0);
check('每个外部文件生成独立场次', !!sx1 && !!sx2 && store2.sessions.length === 3);
check('平台/主播由路径推断（抖音）', sx1.platform === 'douyin' && sx1.platformName === '抖音' && sx1.streamer === '测试主播');
check('平台/主播由路径推断（哔哩哔哩）', sx2.platform === 'bilibili' && sx2.platformName === '哔哩哔哩' && sx2.streamer === '央视网快看');
check('标题取文件名', sx1.title === '2026-03-01-12-30-00-001');
const localIso = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).toISOString(); // 文件名时间戳是本地时间
check('开始时间由文件名推断', sx1.startedAt === localIso(2026, 3, 1, 12, 30, 0) && sx2.startedAt === localIso(2026, 2, 10, 8, 0, 0));
check('文件行原地升级为 segment（复用原 id，path 无冲突）', db2.prepare("SELECT kind k, session_id s FROM files WHERE id='fx1'").get().k === 'segment'
  && db2.prepare("SELECT session_id s FROM files WHERE id='fx1'").get().s === sx1.id);
check('场次 platform 落库', db2.prepare('SELECT platform p FROM sessions WHERE id = ?').get(sx1.id).p === 'douyin');

// ---------- scan：未登记文件自动注册为独立场次（不经前端导入） ----------
fs.mkdirSync(path.join(tmp, '虎牙', '某主播'), { recursive: true });
const autoPath = path.join(tmp, '虎牙', '某主播', '2026-04-05-09-30-00-001.mp4');
fs.writeFileSync(autoPath, 'z'.repeat(32));
const scanRes = await storage.scan();
const sa = store2.sessions.find((s) => s.segments[0]?.path === autoPath);
check('scan 自动注册未登记文件为场次', !!sa && scanRes.added === 1);
check('scan 自动注册后未登记区清空（含幽灵条目）', store2.external.length === 0);
check('自动注册按路径/文件名推断平台·主播·时间', sa.platform === 'huya' && sa.platformName === '虎牙'
  && sa.streamer === '某主播' && sa.startedAt === localIso(2026, 4, 5, 9, 30, 0));
check('自动注册场次落库（platform=huya）', db2.prepare('SELECT platform p FROM sessions WHERE id = ?').get(sa.id).p === 'huya');
check('自动注册文件行 kind=segment 且归属该场次', db2.prepare('SELECT kind k, session_id s FROM files WHERE path = ?').get(autoPath).s === sa.id);
db2.close();
const db3 = openDb(dbPath);
const store3 = await new Store(tmp).init(db3);
const sx1b = store3.sessions.find((s) => s.id === sx1.id);
check('导入的场次重开后恢复（含文件归属）', !!sx1b && sx1b.segments[0]?.id === 'fx1' && sx1b.platform === 'douyin');
check('自动注册的场次重开后恢复', store3.sessions.some((s) => s.id === sa.id && s.platform === 'huya'));

// ---------- 重复独立场次清理：扫描先注册的产物场次让位给录制场次（v0.1.45 修复） ----------
store3.settings.recordRoot = tmp;
const dupPath = path.join(tmp, '抖音', '测试主播', '2026-05-20-10-00-00-001.mp4');
fs.writeFileSync(dupPath, 'q'.repeat(32));
const dupFile = (id, sid) => ({
  id, sessionId: sid, kind: 'segment', name: '2026-05-20-10-00-00-001.mp4', path: dupPath,
  relPath: '抖音/测试主播/2026-05-20-10-00-00-001.mp4', ext: 'mp4', bytes: 32, durationSec: 0,
  status: 'ok', segmentIndex: 0, createdAt: '2026-05-20T10:00:00.000Z', completedAt: '2026-05-20T10:01:00.000Z',
});
const baseSession = (id, taskId, fid) => ({
  id, taskId, platform: 'douyin', platformName: '抖音', streamer: '测试主播', title: 'x',
  startedAt: '2026-05-20T10:00:00.000Z', endedAt: null, durationSec: 0, bytes: 32, status: 'done',
  dir: path.dirname(dupPath), relDir: '抖音/测试主播', segments: [dupFile(fid, id)],
  extras: [], merged: null, mp4: null, namingProfileId: null, taskSnapshot: { anchorName: '', roomId: '' },
});
const realS = baseSession('s_real', 't_real', 'fa1');
await store3.addSession(realS); // 真实录制场次写库成功
const orphanS = baseSession('s_orphan', null, 'fb1');
store3.state.sessions.push(orphanS); // 独立场次只存在于内存（DB 写会 path UNIQUE 冲突——正是要修的 bug 场景）
store3._invalidateIndex?.();
const storage3 = new Storage({ store: store3, logger: { info() {}, warn() {}, error() {} } });
storage3.activePathsFn = () => [];
const scDup = await storage3.scan();
check('扫描清理重复独立场次（让位给真实场次）', !store3.sessions.some((s) => s.id === 's_orphan'));
check('真实场次保留', !!store3.sessions.find((s) => s.id === 's_real'));
check('清理计数计入扫描结果', scDup.total >= 1);
// _dropOrphanSessionByPath 独立验证（remux/merge 收编前的预防路径）
const orphanS2 = baseSession('s_orphan2', null, 'fb2');
store3.state.sessions.push(orphanS2);
store3._invalidateIndex?.();
const dropped = await storage3._dropOrphanSessionByPath(dupPath);
check('_dropOrphanSessionByPath 让位独立场次', dropped === 1 && !store3.sessions.some((s) => s.id === 's_orphan2'));
// 独立场次校准：存量 startedAt 用旧 Date.UTC 解析差 8 小时，scan 应按文件名（本地时间）修正
const healS = baseSession('s_heal', null, 'fh1');
healS.startedAt = new Date(Date.UTC(2026, 4, 20, 18, 0, 0)).toISOString(); // 旧 bug：文件名 18:00 被 Date.UTC 解析存成 18:00Z（本地 18:00 应为 10:00Z）
const healPath = path.join(tmp, '抖音', '测试主播', '2026-05-20-18-00-00-001.mp4');
fs.writeFileSync(healPath, 'h'.repeat(16));
healS.segments[0].path = healPath;
healS.segments[0].relPath = '抖音/测试主播/2026-05-20-18-00-00-001.mp4';
healS.segments[0].name = '2026-05-20-18-00-00-001.mp4';
healS.dir = path.dirname(healPath);
healS.durationSec = 0;
store3.state.sessions.push(healS);
store3._invalidateIndex?.();
const storage3b = new Storage({ store: store3, logger: { info() {}, warn() {}, error() {} } });
storage3b.activePathsFn = () => [];
await storage3b.scan();
const healAfter = store3.sessions.find((s) => s.id === 's_heal');
check('独立场次校准：startedAt 按文件名本地时间修正', !!healAfter && healAfter.startedAt === localIso(2026, 5, 20, 18, 0, 0));

// ---------- 独立场次归位（v0.1.50）：同一场次被时序竞争拆散 → 按「同目录 + 同秒」归位回真实场次 ----------
// 线上实况（用户 NAS 库）：真场次只认领了 002/004（段号 2/4），001/003 掉成独立场次（段号 0、时间 .000），
// 文件库因此显示 002,004,001,003 —— 段号乱序的根因在这里，不是排序函数挑错字段。
const ownSec = new Date(localIso(2026, 5, 21, 18, 0, 0)).getTime();
const ownF2 = path.join(tmp, '抖音', '测试主播', '2026-05-21-18-00-00-002.mp4');
const lostF1 = path.join(tmp, '抖音', '测试主播', '2026-05-21-18-00-00-001.mp4');
fs.writeFileSync(ownF2, 'a'.repeat(32));
fs.writeFileSync(lostF1, 'b'.repeat(32));
const rowOf = (id, p, sid, kind, si) => ({
  id, sessionId: sid, kind, name: path.basename(p), path: p, relPath: `抖音/测试主播/${path.basename(p)}`,
  ext: 'mp4', bytes: 32, durationSec: 12, status: 'ok', segmentIndex: si,
  createdAt: new Date(ownSec).toISOString(), completedAt: new Date(ownSec).toISOString(),
});
await store3.addSession({
  id: 's_own', taskId: 't_own', platform: 'douyin', platformName: '抖音', streamer: '测试主播', title: 'x',
  startedAt: new Date(ownSec + 73).toISOString(), endedAt: null, durationSec: 12, bytes: 32, status: 'done',
  dir: path.dirname(ownF2), relDir: '抖音/测试主播',
  segments: [], extras: [rowOf('f_own2', ownF2, 's_own', 'mp4', 2)],
  merged: null, mp4: null, namingProfileId: null, taskSnapshot: { anchorName: '', roomId: '' },
});
// lostF1 只存在于磁盘（掉队文件）：扫描会先把它注册成独立场次，随后归位逻辑必须把它并回 s_own
const storage3c = new Storage({ store: store3, logger: { info() {}, warn() {}, error() {}, debug() {} } });
storage3c.activePathsFn = () => [];
await storage3c.scan();
const ownAfter = store3.sessions.find((s) => s.id === 's_own');
const lostRow = (ownAfter?.extras || []).find((f) => f.path === lostF1);
check('独立场次归位：掉队文件并入真实场次', !!lostRow);
check('归位段号从文件名补回（…-001 → 1）', lostRow?.segmentIndex === 1);
check('归位后空壳独立场次被清理',
  !store3.sessions.some((s) => !s.taskId && [...(s.segments || []), ...(s.extras || [])].some((f) => f.path === lostF1)));
const dbLost = db3.prepare('SELECT session_id s, segment_index i, kind k FROM files WHERE path = ?').get(lostF1);
check('归位落库：files.session_id/segment_index/kind 正确',
  dbLost?.s === 's_own' && dbLost?.i === 1 && dbLost?.k === 'mp4');
check('归位不产生重复文件行', db3.prepare('SELECT COUNT(*) c FROM files WHERE path = ?').get(lostF1).c === 1);

// 扫描不得抢注「正在转封装的输出」（抢注会占住 files.path → 真实场次收编失败，文件永久掉队成独立场次）
const inflight = path.join(tmp, '抖音', '测试主播', '2026-05-22-18-00-00-009.mp4');
fs.writeFileSync(inflight, 'c'.repeat(16));
const storage3d = new Storage({ store: store3, logger: { info() {}, warn() {}, error() {}, debug() {} } });
storage3d.activePathsFn = () => [];
storage3d._remuxInflight.set(inflight, Promise.resolve());
await storage3d.scan();
check('扫描跳过正在转封装的输出（不抢注独立场次）',
  !store3.sessions.some((s) => [...(s.segments || []), ...(s.extras || [])].some((f) => f.path === inflight)));
storage3d._remuxInflight.clear();
db3.close();

// ---------- 老库升级：notify 表缺 on_live/dedupe 列（v0.1.36 迁移 bug：开播通知被静默关闭） ----------
const { default: Database } = await import('better-sqlite3');
const oldPath = path.join(tmp, 'old-notify.db');
const oldDb = new Database(oldPath);
oldDb.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta(key,value) VALUES('schema_version','2');
  CREATE TABLE notify (id INTEGER PRIMARY KEY CHECK (id = 1), webhook TEXT, on_start INTEGER, on_end INTEGER, on_error INTEGER, on_disk INTEGER, on_cookie INTEGER, dedupe_sec INTEGER, retry INTEGER);
  INSERT INTO notify(id, webhook, on_start, on_end, on_error, on_disk, on_cookie, dedupe_sec, retry) VALUES(1, 'https://example.com/hook', 1,1,1,1,0,60,1);`);
oldDb.close();
const dbOld = openDb(oldPath);
check('老库迁移补 on_live 列', dbOld.prepare("SELECT name FROM pragma_table_info('notify')").all().some((c) => c.name === 'on_live'));
check('老库存量行 on_live 修正为 1（开播通知不丢失）', dbOld.prepare('SELECT on_live FROM notify WHERE id=1').get().on_live === 1);
const storeOld = await new Store(tmp).init(dbOld);
check('迁移后读取 onLive=true', storeOld.settings.notify.onLive === true);
// 开播通知闩锁列：老库必须补上，否则「每场直播只通知一次」退化回只按 liveStatus 跳变
check('老库迁移补 tasks.live_notified_at 列', dbOld.prepare("SELECT name FROM pragma_table_info('tasks')").all().some((c) => c.name === 'live_notified_at'));
dbOld.close();

// ---------- 旧 v1 库（data_json）作废重建 ----------
const v1Path = path.join(tmp, 'v1.db');
const v1 = new Database(v1Path);
v1.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','1'); CREATE TABLE tasks (id TEXT PRIMARY KEY, data_json TEXT NOT NULL); INSERT INTO tasks VALUES('t_old','{}');");
v1.close();
const v2 = openDb(v1Path);
check('v1 库被作废重建为 v2 空库', schemaVersion(v2) === 2 && v2.prepare('SELECT COUNT(*) c FROM tasks').get().c === 0);
v2.close();
check('作废重建前保留 .bak 备份（不再直接删除）', fs.readdirSync(tmp).some((f) => f.startsWith('v1.db.bak-')));

// ---------- 脏 schema_version / 更高版本：绝不能静默删库重建 ----------
const dirtyPath = path.join(tmp, 'dirty.db');
const d1 = new Database(dirtyPath);
d1.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','2abc'); CREATE TABLE tasks (id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('keepme');");
d1.close();
let dirtyErr = null;
try { openDb(dirtyPath); } catch (e) { dirtyErr = e; }
check('非法 schema_version（2abc）拒绝启动，而不是当成旧库删掉', !!dirtyErr && /不是合法整数/.test(dirtyErr.message), dirtyErr && dirtyErr.message);
const d2 = new Database(dirtyPath, { readonly: true });
check('拒绝启动后原库数据仍在（未删一行）', d2.prepare('SELECT COUNT(*) c FROM tasks').get().c === 1);
d2.close();

const newerPath = path.join(tmp, 'newer.db');
const n1 = new Database(newerPath);
n1.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','99'); CREATE TABLE tasks (id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('future');");
n1.close();
let newerErr = null;
try { openDb(newerPath); } catch (e) { newerErr = e; }
check('结构版本高于程序支持时拒绝启动（不降级删库）', !!newerErr && /高于本程序支持/.test(newerErr.message), newerErr && newerErr.message);
const n2 = new Database(newerPath, { readonly: true });
check('更高版本库原数据仍在', n2.prepare('SELECT COUNT(*) c FROM tasks').get().c === 1);
n2.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${ok} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
