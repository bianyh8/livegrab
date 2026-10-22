// 端到端验证「录制文件库」的三件事：
//   ① 录制中的文件变大 → 行内大小自动跟新，且不重建整表（搜索框焦点不丢）
//   ② 新增/变动 → 服务端 SSE 的 files 事件把页面在 ~300ms 内刷新（不必等 2s 轮询）
//   ③ 工具栏「扫描磁盘」按钮确实会打 POST /api/files/scan 并把列表回拉一遍
// 用法：node app/test/e2e-files-refresh.mjs （需要 Chrome/Edge；EDGE_PATH 或 CHROME_PATH 指定可执行文件，找不到则跳过）
// 真实 Chromium（headless）→ 真实服务 → 造文件 → 改大小/新增 → 读 DOM 与网络时序
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const CHROME = process.env.EDGE_PATH || process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!fs.existsSync(CHROME)) {
  console.log(`跳过：找不到浏览器（${CHROME}）。可用 EDGE_PATH / CHROME_PATH 指向 Chrome/Edge 后重试。`);
  process.exit(0);
}
const NODE = process.execPath;
const TMP = path.join(os.tmpdir(), `livegrab-e2e-files-${Date.now()}`);
const CFG = path.join(TMP, 'config');
const REC = path.join(TMP, 'record');
const PORT = 18097;
const CDP = 19334;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(REC, { recursive: true });

let bad = 0;
const check = (cond, label, extra = '') => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`); };

// 1) 预置：内网免登录 + 账号
const storeUrl = 'file://' + path.join(APP, 'server/store.js');
const dbUrl = 'file://' + path.join(APP, 'server/db.js');
spawnSync(NODE, ['-e', `Promise.all([import(process.argv[1]), import(process.argv[3])]).then(async ([m, dbm]) => { const db = dbm.openDb(process.argv[4]); const s = await new m.Store(process.argv[2]).init(db); await s.updateSettings({security:{trustLan:true,maxConcurrency:6}}); db.close(); console.log('seeded'); }).catch((e) => { console.error('seed ERR: ' + (e?.message || e)); process.exit(1); })`, storeUrl, CFG, dbUrl, path.join(CFG, 'livegrab.db')], { encoding: 'utf8' });
spawnSync(NODE, ['-e', `import(process.argv[1]).then(async m=>{const a=await new (m.Auth)(process.argv[2]).init();if(!a.users)await a.createUser({username:'admin',password:'livegrab123'});console.log('admin ok')})`, 'file://' + path.join(APP, 'server/auth.js'), CFG], { encoding: 'utf8' });

// 2) 造第一个媒体文件（文件名时间戳 = 今天，落在默认「近 7 天」区间内）
const dir1 = path.join(REC, 'douyin', '验证主播');
fs.mkdirSync(dir1, { recursive: true });
const f1 = path.join(dir1, '验证主播_2026-10-19_10-00-00_001.flv');
const MiB = 1024 * 1024;
fs.writeFileSync(f1, Buffer.alloc(MiB, 7));

// 3) 起服务：扫描定时器拉长，避免后台扫描干扰时序测量
const env = { ...process.env, PORT: String(PORT), CONFIG_DIR: CFG, RECORD_ROOT: REC, FFMPEG_PATH: 'nonexistent-ffmpeg', SCAN_INTERVAL_MS: '600000', TZ: 'Asia/Shanghai', LIVEGRAB_VERSION: '0.1.0' };
const srv = spawn(NODE, [path.join(APP, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += `[err] ${d}`; });
let up = false;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* retry */ } await sleep(300); }
if (!up) { console.log('服务启动失败:\n' + srvOut); srv.kill(); process.exit(1); }
const scan = async () => (await (await fetch(`${BASE}/api/files/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json());
await scan();
await sleep(200);

// 4) 起 Chromium
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(TMP, 'chrome')}`, '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* retry */ }
  await sleep(300);
}
if (!wsUrl) { console.log('无法连接 Chromium CDP'); srv.kill(); chrome.kill(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const reqLog = []; // { t, url }
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error'].includes(m.params.type)) {
    consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
  }
  if (m.method === 'Network.requestWillBeSent' && /\/api\/files(\/scan)?(\?|$)/.test(m.params.request.url)) {
    reqLog.push({ t: Date.now(), url: m.params.request.url });
  }
};
const cmd = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Network.enable');
// 记录 SSE files 事件到达时间（包一层 addEventListener，不影响原逻辑）
await cmd('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__sseT = [];
    (() => { const orig = EventSource.prototype.addEventListener;
      EventSource.prototype.addEventListener = function (type, fn, opts) {
        if (type === 'files') { const self = this; return orig.call(self, type, function (e) { window.__sseT.push(Date.now()); return fn.call(self, e); }, opts); }
        return orig.call(this, type, fn, opts);
      }; })();`,
});

await cmd('Page.navigate', { url: `${BASE}/#/files` });
// 等文件库把第一个文件渲染出来
let shown = false;
for (let i = 0; i < 100; i++) { if ((await ev('document.body.innerText')).includes('验证主播')) { shown = true; break; } await sleep(200); }
console.log(`\n[环境] 文件库列表已渲染=${shown}`);
if (!shown) console.log((await ev('document.body.innerText')).slice(0, 1200));

console.log('\n【A】录制中文件变大 → 大小自动跟新（不重建整表，焦点不丢）');
// 查询条件默认收起（与任务管理一致）：先点折叠栏展开，否则 #flQ 不可聚焦，探针失效
await ev('document.querySelector("#flFilterToggle").click()');
await sleep(250);
const sizeBefore = await ev('JSON.stringify([...document.querySelectorAll("[data-file-size]")].map(e=>e.textContent))');
await ev('document.querySelector("#flQ").focus(); document.activeElement && document.activeElement.id');
const focusBefore = await ev('document.activeElement && document.activeElement.id');
check(focusBefore === 'flQ', '搜索框已聚焦（作为「不重建整表」的探针）', String(focusBefore));
const sseBefore = await ev('window.__sseT.length');
fs.appendFileSync(f1, Buffer.alloc(2 * MiB, 9));
await scan();
let sizeAfter = sizeBefore; let tChanged = 0;
const tScan = Date.now();
for (let i = 0; i < 150; i++) { // 最多 6s
  sizeAfter = await ev('JSON.stringify([...document.querySelectorAll("[data-file-size]")].map(e=>e.textContent))');
  if (sizeAfter !== sizeBefore) { tChanged = Date.now(); break; }
  await sleep(40);
}
const sseT = await ev('window.__sseT.slice()');
check(sizeAfter !== sizeBefore, '行内大小文本变了', `${sizeBefore} → ${sizeAfter}`);
check(Array.isArray(sseT) && sseT.length > sseBefore, '收到 SSE files 事件', `事件数 ${sseBefore} → ${sseT?.length}`);
if (tChanged) {
  const lastSse = sseT[sseT.length - 1];
  check(tChanged - lastSse < 1200, 'SSE 到达后 1.2s 内完成刷新（证明是事件驱动，不是 2s 轮询）', `${tChanged - lastSse}ms`);
  check(tChanged - tScan < 2500, '总体反应时间', `${tChanged - tScan}ms`);
  const off = reqLog.filter((r) => r.t >= lastSse && r.t <= tChanged);
  check(off.length >= 1, 'SSE 之后确实发了一次 /api/files 请求', `${off.length} 次`);
}
const focusAfter = await ev('document.activeElement && document.activeElement.id');
check(focusAfter === 'flQ', '刷新后搜索框焦点仍在（DOM 没被整表重建）', String(focusAfter));

console.log('\n【B】新增一个文件 → SSE 立即刷出（不等轮询）');
const dir2 = path.join(REC, 'bilibili', '第二主播');
fs.mkdirSync(dir2, { recursive: true });
const f2 = path.join(dir2, '第二主播_2026-10-19_11-00-00_001.flv');
fs.writeFileSync(f2, Buffer.alloc(512 * 1024, 3));
const sseBefore2 = await ev('window.__sseT.length');
const tScan2 = Date.now();
await scan();
let seen2 = false; let tSeen2 = 0;
for (let i = 0; i < 120; i++) {
  if ((await ev('document.body.innerText')).includes('第二主播')) { seen2 = true; tSeen2 = Date.now(); break; }
  await sleep(40);
}
const sse2 = await ev('window.__sseT.slice()');
check(seen2, '新文件出现在列表里');
check(sse2.length > sseBefore2, '收到 SSE files 事件', `${sseBefore2} → ${sse2.length}`);
if (seen2 && sse2.length > sseBefore2) {
  const last = sse2[sse2.length - 1];
  check(tSeen2 - last < 1200, 'SSE 到达后 1.2s 内刷出（不是等 2s 轮询）', `${tSeen2 - last}ms`);
  check(tSeen2 - tScan2 < 2500, '总体反应时间', `${tSeen2 - tScan2}ms`);
}

console.log('\n【C】「扫描磁盘」按钮真的会打扫描接口 + 回拉列表');
await sleep(600);
const reqBefore = reqLog.length;
await ev('document.querySelector("#flScan").click()');
for (let i = 0; i < 60; i++) {
  if (reqLog.slice(reqBefore).some((r) => /\/api\/files\/scan/.test(r.url))) break;
  await sleep(30);
}
const hitUrls = reqLog.slice(reqBefore).map((r) => r.url);
check(hitUrls.some((u) => /\/api\/files\/scan/.test(u)), '点「扫描磁盘」调用了 POST /api/files/scan', hitUrls.filter((u) => /scan/.test(u))[0] || `${hitUrls.length} 次请求`);
await sleep(200);
/* 扫描是 POST 返回后才回拉列表：固定 300ms 太脆（扫描耗时随目录大小变），
   改成最多等 4s，出现 /api/files? 即通过。 */
let pulled = false;
for (let i = 0; i < 133; i++) {
  if (reqLog.slice(reqBefore).some((r) => /\/api\/files\?/.test(r.url))) { pulled = true; break; }
  await sleep(30);
}
check(pulled, '扫描后重新拉取了文件列表', `${reqLog.length - reqBefore} 次请求`);

console.log('\n【D】控制台无报错');
check(consoleErrors.length === 0, '无 console error', consoleErrors.slice(0, 3).join(' | '));

const stop = await ev('document.querySelector("#flScan") ? "ok" : "gone"');
console.log(`\n[收尾] 页面状态=${stop}  结果：${bad === 0 ? '全部通过 ✅' : `${bad} 项失败 ❌`}`);
ws.close(); chrome.kill(); srv.kill();
process.exit(bad === 0 ? 0 : 1);
