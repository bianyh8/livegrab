// 安全与一致性回归（2026-10-24 全局审查修复项）
// 覆盖：脏 schema/版本（见 db-sqlite.mjs）、直链协议白名单、SSRF 地址校验、
//       会话撤销/改密失效、文件库排序全序与合并产物定序。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK  ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? `  → ${extra}` : ''}`); }
}
const eq = (a, b, name) => check(name, a === b, `期望 ${b}，实际 ${a}`);

const { Auth } = await import('file://' + path.join(APP, 'server', 'auth.js').replace(/\\/g, '/'));
const { resolveRoom } = await import('file://' + path.join(APP, 'server', 'resolvers', 'direct.js').replace(/\\/g, '/'));
const { assertRemoteUrl, isPrivateHost } = await import('file://' + path.join(APP, 'server', 'util.js').replace(/\\/g, '/'));
const { compareFileRow, sortFileRows } = await import('file://' + path.join(APP, 'server', 'file-order.js').replace(/\\/g, '/'));
const { Store } = await import('file://' + path.join(APP, 'server', 'store.js').replace(/\\/g, '/'));
const { openDb } = await import('file://' + path.join(APP, 'server', 'db.js').replace(/\\/g, '/'));

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-sec-'));

/* ---------- 1) 直链解析器：只认网络协议 ---------- */
console.log('\n[1] 直链协议白名单');
for (const bad of ['file:///etc/passwd.ts', '/data/movie.mp4', 'data:text/plain,hi.ts', 'concat:a|b.ts']) {
  let err = null;
  try { await resolveRoom({ roomId: bad }); } catch (e) { err = e; }
  check(`拒绝 ${bad}`, !!err && err.code === 'INVALID_URL', err && err.code);
}
for (const good of ['https://example.com/a.m3u8', 'http://192.168.1.9:8080/live.flv', 'rtmp://example.com/live/x']) {
  let err = null;
  try { await resolveRoom({ roomId: good }); } catch (e) { err = e; }
  check(`接受 ${good}`, !err, err && err.message);
}

/* ---------- 2) SSRF 地址校验 ---------- */
console.log('\n[2] 服务端出网地址校验');
for (const bad of ['http://127.0.0.1:8080/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/a.jpg', 'http://[::1]/x', 'http://localhost:9000/x']) {
  let err = null;
  try { assertRemoteUrl(bad, { label: '测试地址' }); } catch (e) { err = e; }
  check(`拒绝内网目标 ${bad}`, !!err && err.code === 'INVALID_URL');
}
check('允许公网 https', !!assertRemoteUrl('https://cdn.example.com/a.jpg'));
check('allowPrivate 放行局域网（自建流场景）', !!assertRemoteUrl('http://192.168.1.9/live.flv', { allowPrivate: true, allowRtmp: true }));
check('isPrivateHost 不再把 fc 开头的域名当内网', isPrivateHost('fc.example.com') === false);
check('isPrivateHost 正确识别 IPv4-mapped IPv6', isPrivateHost('::ffff:192.168.1.2') === true);

/* ---------- 3) 会话撤销 / 改密失效 ---------- */
console.log('\n[3] 会话生命周期');
const authDir = path.join(tmp, 'auth');
const auth = await new Auth(authDir).init();
await auth.createUser({ username: 'admin', password: 'livegrab123' });
const s1 = auth.issue(true, 30);
check('新签发的 token 可校验', auth.verifyToken(s1.token)?.sub === 'admin');
const fakeReq = { headers: { cookie: `lg_session=${encodeURIComponent(s1.token)}` } };
auth.revoke(fakeReq);
check('登出后同一 token 立刻失效（服务端撤销，不只是清 Cookie）', auth.verifyToken(s1.token) === null);

const s2 = auth.issue(false, 30);
check('另一个会话仍然有效（撤销只作用于当前 jti）', auth.verifyToken(s2.token)?.sub === 'admin');
await auth.changePassword({ oldPassword: 'livegrab123', newPassword: 'newpass456' });
check('改密后所有旧 token 失效（epoch 自增）', auth.verifyToken(s2.token) === null);
const s3 = auth.issue(false, 30);
check('改密后新签发的 token 有效', auth.verifyToken(s3.token)?.sub === 'admin');
await auth.revokeAll();
check('「注销所有会话」后最新 token 也失效', auth.verifyToken(s3.token) === null);
const usersRaw = await fsp.readFile(path.join(authDir, 'users.json'), 'utf8');
check('epoch 已持久化（重启后旧 token 仍失效）', /"epoch"\s*:\s*[1-9]/.test(usersRaw));

/* ---------- 4) 文件库排序：全序 + 合并产物定序 ---------- */
console.log('\n[4] 文件库排序');
const row = (sid, startedAt, kind, seg, name, tag = '') => ({
  f: { id: `${sid}-${name}`, kind, segmentIndex: seg, name, path: `/data/${sid}/${name}` },
  s: { id: sid, startedAt, relDir: '' }, tag,
});
const mergedNamedNumber = [
  row('s1', '2026-10-18T10:00:00Z', 'segment', 2, '2026-10-18-18-00-00-002.mp4'),
  row('s1', '2026-10-18T10:00:00Z', 'merged', 0, '合集2.mp4'),
  row('s1', '2026-10-18T10:00:00Z', 'segment', 3, '2026-10-18-18-00-00-003.mp4'),
];
eq(sortFileRows(mergedNamedNumber.slice()).map((r) => r.f.name).join(','),
  '2026-10-18-18-00-00-002.mp4,2026-10-18-18-00-00-003.mp4,合集2.mp4',
  '合并产物即使名字带数字也排在同场次最后');

// 全序：除 path 外完全相同的两行，比较结果必须非 0（否则 sort 退化成输入顺序）
const a = { f: { id: 'x', kind: 'segment', name: 'same.ts', path: '/data/a/same.ts' }, s: { id: 'sA', startedAt: '2026-10-18T10:00:00Z', relDir: 'd' } };
const b = { f: { id: 'y', kind: 'segment', name: 'same.ts', path: '/data/b/same.ts' }, s: { id: 'sB', startedAt: '2026-10-18T10:00:00Z', relDir: 'd' } };
check('比较器对「仅路径不同」的两行也给出确定顺序', compareFileRow(a, b) !== 0 && compareFileRow(a, b) === -compareFileRow(b, a));
const shuffled = [a, b, { ...a, f: { ...a.f, path: '/data/c/same.ts', id: 'z' } }];
eq(sortFileRows(shuffled.slice()).map((r) => r.f.path).join(','),
  sortFileRows(shuffled.slice().reverse()).map((r) => r.f.path).join(','),
  '打乱输入顺序后排序结果一致');

/* ---------- 5) Store：不完整 task 对象不再因 NOT NULL 整批回滚 ---------- */
console.log('\n[5] 持久层健壮性');
const db = openDb(path.join(tmp, 'store.db'));
const store = await new Store(path.join(tmp, 'store-root')).init(db);
let addErr = null;
try {
  await store.addTask({ id: 't_partial', platform: 'direct', status: 'idle' });
} catch (e) { addErr = e; }
check('缺 shortId/roomId 等字段的 task 仍能落库（NOT NULL 列写空串）', !addErr, addErr && addErr.message);
const rowDb = db.prepare('SELECT short_id, room_id, anchor_name FROM tasks WHERE id = ?').get('t_partial');
check('库里存的是空串而不是 NULL（NOT NULL 约束不再被绕过）',
  rowDb && rowDb.short_id === '' && rowDb.room_id === '' && rowDb.anchor_name === '');
db.close();

/* ---------- 6) 凭据落盘加密（Cookie / 更新 token） ---------- */
console.log('\n[6] 凭据静态加密');
const encDir = path.join(tmp, 'enc-cfg');
const encDbPath = path.join(tmp, 'enc.db');
const encDb = openDb(encDbPath);
const encStore = await new Store(encDir).init(encDb);
await encStore.setCookie('douyin', 'sessionid=SECRETSESSION; ttwid=TTWID123');
await encStore.updateSettings({ customize: { ...(encStore.settings.customize || {}), updateToken: 'ghp_SECRETTOKEN' } });
const rawCookie = encDb.prepare("SELECT value FROM cookies WHERE platform = 'douyin'").get().value;
check('Cookie 落盘为密文（enc:v1: 前缀）', String(rawCookie).startsWith('enc:v1:'));
check('库里搜不到明文 Cookie', !String(rawCookie).includes('SECRETSESSION'));
const rawTok = encDb.prepare("SELECT value FROM customize WHERE key = 'updateToken'").get().value;
check('更新 token 落盘为密文', String(rawTok).startsWith('"enc:v1:'), rawTok.slice(0, 24));
check('库里搜不到明文 token', !String(rawTok).includes('ghp_SECRETTOKEN'));
check('密钥文件权限 0600', (fs.statSync(path.join(encDir, '.store-key')).mode & 0o777) === 0o600);
encDb.close();

const encDb2 = openDb(encDbPath);
const encStore2 = await new Store(encDir).init(encDb2);
eq(encStore2.settings.cookies.douyin.value, 'sessionid=SECRETSESSION; ttwid=TTWID123', '重启后 Cookie 解密回明文供解析器使用');
eq(encStore2.settings.customize.updateToken, 'ghp_SECRETTOKEN', '重启后更新 token 解密回明文');
// 老库兼容：手工写入一条明文 Cookie，应能直接读出来
encDb2.prepare("UPDATE cookies SET value = 'plain=1' WHERE platform = 'douyin'").run();
const encStore3 = await new Store(encDir).init(encDb2);
eq(encStore3.settings.cookies.douyin.value, 'plain=1', '老库明文 Cookie 仍可读取（自动兼容）');
await encStore3.setCookie('douyin', 'plain=1');
check('再次落盘时明文被升级为密文', String(encDb2.prepare("SELECT value FROM cookies WHERE platform='douyin'").get().value).startsWith('enc:v1:'));
encDb2.close();

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
