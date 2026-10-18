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
check('开始时间由文件名推断', sx1.startedAt === '2026-03-01T12:30:00.000Z' && sx2.startedAt === '2026-02-10T08:00:00.000Z');
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
  && sa.streamer === '某主播' && sa.startedAt === '2026-04-05T09:30:00.000Z');
check('自动注册场次落库（platform=huya）', db2.prepare('SELECT platform p FROM sessions WHERE id = ?').get(sa.id).p === 'huya');
check('自动注册文件行 kind=segment 且归属该场次', db2.prepare('SELECT kind k, session_id s FROM files WHERE path = ?').get(autoPath).s === sa.id);
db2.close();
const db3 = openDb(dbPath);
const store3 = await new Store(tmp).init(db3);
const sx1b = store3.sessions.find((s) => s.id === sx1.id);
check('导入的场次重开后恢复（含文件归属）', !!sx1b && sx1b.segments[0]?.id === 'fx1' && sx1b.platform === 'douyin');
check('自动注册的场次重开后恢复', store3.sessions.some((s) => s.id === sa.id && s.platform === 'huya'));
db3.close();

// ---------- 旧 v1 库（data_json）作废重建 ----------
const { default: Database } = await import('better-sqlite3');
const v1Path = path.join(tmp, 'v1.db');
const v1 = new Database(v1Path);
v1.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','1'); CREATE TABLE tasks (id TEXT PRIMARY KEY, data_json TEXT NOT NULL); INSERT INTO tasks VALUES('t_old','{}');");
v1.close();
const v2 = openDb(v1Path);
check('v1 库被作废重建为 v2 空库', schemaVersion(v2) === 2 && v2.prepare('SELECT COUNT(*) c FROM tasks').get().c === 0);
v2.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${ok} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
