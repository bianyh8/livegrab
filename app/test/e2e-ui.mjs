// 端到端 UI 验证：起真实服务 → CDP 驱动 Edge 真实等待后读渲染文本 + 截图 + 收集控制台报错
// 用法：node app/test/e2e-ui.mjs   （需要 Edge/Chrome，可用 EDGE_PATH 指定可执行文件；找不到则跳过）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE = process.execPath;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const ROOT = path.join(APP, '..');
const UI = path.join(ROOT, 'ui');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!fs.existsSync(EDGE)) {
  console.log(`跳过 UI 端到端验证：找不到浏览器（${EDGE}）。可设置 EDGE_PATH 指向 Edge/Chrome 后重试。`);
  process.exit(0);
}
const TMP = path.join(os.tmpdir(), `livegrab-e2e-${Date.now()}`);
const CFG = path.join(TMP, 'config');
const REC = path.join(TMP, 'record');
const PORT = 18099;
const CDP = 19333;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CFG, { recursive: true });
fs.mkdirSync(REC, { recursive: true });

let bad = 0;
const line = (s) => console.log(s);
const check = (cond, label, extra = '') => { if (!cond) bad++; line(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`); };

// 1) 预置：内网免登录 + 初始化管理员（无头浏览器可直接进控制台）
const storeUrl = 'file:///' + path.join(APP, 'server/store.js').replace(/\\/g, '/');
const seed = spawnSync(NODE, ['-e', `Promise.all([import(process.argv[1]), import(process.argv[3])]).then(async ([m, dbm]) => { const db = dbm.openDb(process.argv[4]); const s = await new m.Store(process.argv[2]).init(db); await s.updateSettings({security:{trustLan:true,maxConcurrency:6}}); db.close(); console.log('seeded'); }).catch((e) => { console.error('seed ERR: ' + (e?.message || e)); process.exit(1); })`, storeUrl, CFG, 'file:///' + path.join(APP, 'server', 'db.js').replace(/\\/g, '/'), path.join(CFG, 'livegrab.db')], { encoding: 'utf8' });
line(`1) 预置配置: ${(seed.stdout || '').trim()}${seed.stderr ? ' ERR:' + seed.stderr : ''}`);
// 账号必须在服务启动前就存在（服务启动时把 users.json 读进内存，之后写文件不会热加载）
const authSeed = spawnSync(NODE, ['-e', `import(process.argv[1]).then(async m=>{const a=await new (m.Auth)(process.argv[2]).init();if(!a.users)await a.createUser({username:'admin',password:'livegrab123'});console.log('admin ok')})`, 'file:///' + path.join(APP, 'server', 'auth.js').replace(/\\/g, '/'), CFG], { encoding: 'utf8' });
line(`1) 预置账号: ${(authSeed.stdout || '').trim()}${authSeed.stderr ? ' ERR:' + authSeed.stderr : ''}`);

// 2) 起服务
const env = { ...process.env, PORT: String(PORT), CONFIG_DIR: CFG, RECORD_ROOT: REC, FFMPEG_PATH: 'nonexistent-ffmpeg', TZ: 'Asia/Shanghai', LIVEGRAB_VERSION: '0.1.0' };
const srv = spawn(NODE, [path.join(APP, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d; });
srv.stderr.on('data', (d) => { srvOut += `[err] ${d}`; });
let up = false;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* retry */ } await sleep(400); }
if (!up) { line('服务启动失败：\n' + srvOut); process.exit(1); }
const health = (await (await fetch(`${BASE}/api/health`)).json()).data;
line(`2) 服务已启动: tz=${health.tz} version=${health.version} ffmpeg=${health.ffmpeg.available}`);
check(health.tz === 'Asia/Shanghai', 'TZ 由容器环境变量生效');
check(health.ffmpeg.available === false, '缺 ffmpeg 时如实上报不可用');
const me = await (await fetch(`${BASE}/api/auth/me`)).json();
check(me.ok && me.data.username === 'lan', '/api/auth/me 返回 username（前端鉴权门依赖）', JSON.stringify(me.data));

// 3) 造数据
const post = async (p, body) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());
const tA = await post('/api/tasks', { url: 'https://example.com/verify-a.m3u8', platform: 'direct', anchorName: '验证任务A', overrides: { quality: 'origin' }, segmentMode: 'time', segmentMinutes: 30, autoRecord: false });
const tB = await post('/api/tasks', { url: 'https://example.com/verify-b.flv', platform: 'direct', anchorName: '验证任务B', overrides: { quality: 'audio' }, autoRecord: false });
const tC = await post('/api/tasks', { url: 'https://example.com/verify-c.ts', platform: 'direct', anchorName: '验证任务C', segmentMode: 'size', segmentSizeMB: 1024, autoRecord: false });
const tD = await post('/api/tasks', { url: 'https://example.com/verify-d.ts', platform: 'direct', anchorName: '验证任务D', monitorOnly: true, autoRecord: false });
line(`3) 建任务: ${[tA, tB, tC, tD].map((t) => `${t.data?.anchorName || 'ERR'}(q=${t.data?.quality})`).join(' / ')}`);
check(tA.data?.quality === 'origin' && tB.data?.quality === 'audio', 'overrides.quality 生效为实际档位');
check(tC.data?.segmentMode === 'size', '分段方式（大小）写入任务');
check(tD.data?.monitorOnly === true, '仅监控（monitorOnly）写入任务');
const st = (await (await fetch(`${BASE}/api/status`)).json()).data;
check(st.tasks.length === 4 && st.engine.ffmpegAvailable === false && !!st.recordRoot, '/api/status 字段完整（含 engine.ffmpegAvailable / recordRoot）');
const tree = (await (await fetch(`${BASE}/api/files/tree?view=platform`)).json()).data;
check(Array.isArray(tree.children), '/api/files/tree 返回 children 数组');

// 4) CDP：真实等待后读页面渲染文本
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(TMP, 'edge')}`, '--window-size=1600,1100', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* retry */ }
  await sleep(400);
}
if (!wsUrl) { line('无法连接 Edge CDP'); srv.kill(); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 300));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Runtime.enable');

// 4a) 真实登录流程：关掉内网免登录，走"登录页 → 输密码 → 提交 → 进控制台 / 错密码报错"
{
  const offTrust = await (await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ security: { trustLan: false } }) })).json();
  check(offTrust.ok === true, '4a 已关闭内网免登录（改为真实 Cookie 会话）');
  consoleErrors.length = 0;
  await send('Page.navigate', { url: `${BASE}/#/dashboard` });
  await sleep(1800);
  const before = await send('Runtime.evaluate', { expression: `JSON.stringify({hidden: !!document.querySelector('#loginPage.hide'), title: (document.querySelector('#loginTitle')||{}).textContent, view: (document.querySelector('#view')||{}).innerText||''})`, returnByValue: true });
  const b = JSON.parse(before.result?.result?.value || '{}');
  check(b.hidden === false && b.view.trim().length === 0, '4a 未登录时只显示登录页', `标题=${b.title}`);
  const after = await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      document.querySelector('#loginUser').value = 'admin';
      document.querySelector('#loginPass').value = 'livegrab123';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 2400));
      return JSON.stringify({ hidden: !!document.querySelector('#loginPage.hide'), view: (document.querySelector('#view')||{}).innerText || '', user: (document.querySelector('#userName')||{}).textContent || '', cookie: document.cookie.includes('lg_session'), me: await fetch('/api/auth/me').then((r) => r.json()).then((x) => (x.data && x.data.username) || null).catch(() => null) });
    })()`,
    returnByValue: true,
  });
  const a = JSON.parse(after.result?.result?.value || '{}');
  check(a.hidden === true && a.view.trim().length > 40, '4a 正确密码提交后进入控制台', `视图 ${a.view.trim().length} 字符`);
  check(a.user === 'admin' && a.me === 'admin', '4a 顶栏显示登录用户且会话 Cookie 有效（HttpOnly，JS 读不到是预期）', `${a.user} / /api/auth/me=${a.me}`);
  const badPw = await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      document.querySelector('#logoutBtn').click();
      await new Promise((r) => setTimeout(r, 800));
      document.querySelector('#loginUser').value = 'admin';
      document.querySelector('#loginPass').value = 'wrong-password';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 1800));
      const err = document.querySelector('#loginErr');
      return JSON.stringify({ hidden: !!document.querySelector('#loginPage.hide'), errShown: !!err && getComputedStyle(err).display !== 'none', errText: (document.querySelector('#loginErrTx')||{}).textContent || '' });
    })()`,
    returnByValue: true,
  });
  const c = JSON.parse(badPw.result?.result?.value || '{}');
  check(c.hidden === false && c.errShown === true, '4a 退出后错误密码留在登录页并提示', c.errText);
  const reLogin = await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      document.querySelector('#loginPass').value = 'livegrab123';
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 2400));
      return JSON.stringify({ hidden: !!document.querySelector('#loginPage.hide'), user: (document.querySelector('#userName')||{}).textContent || '' });
    })()`,
    returnByValue: true,
  });
  const d2 = JSON.parse(reLogin.result?.result?.value || '{}');
  check(d2.hidden === true && d2.user === 'admin', '4a 重新登录成功（后续页面走真实会话）');
  const badConsole = consoleErrors.filter((e) => /LiveGrab|Uncaught|not a function|is not defined/.test(e));
  check(badConsole.length === 0, '4a 登录流程无前端报错', badConsole.slice(0, 2).join(' | '));
}

const PAGES = [
  { pg: 'dashboard', needles: ['正在录制', '排队', '磁盘'], absent: ['最近事件', 'ffmpeg version', 'Copyright', '并发 0/', '时区', 'TZ ', '统计口径'] },
  { pg: 'tasks', needles: ['验证任务A', '验证任务B', '验证任务C', '仅监控', '直播', '录制状态', '新建'], absent: ['分段策略', '命名规则'] },
  { pg: 'files', needles: ['文件库'] },
  { pg: 'settings', needles: ['命名规则', '平台账号', '系统更新'], absent: ['时区', '来自容器环境变量 TZ', 'TZ ', '平台并发上限'] },
  { pg: 'logs', needles: ['日志', '调度器就绪', '最新在前'], absent: ['Copyright'] },
  { pg: 'trash', needles: ['回收站'], absent: ['Copyright'], minLen: 20 },
];
for (const { pg, needles, absent = [], minLen = 40 } of PAGES) {
  consoleErrors.length = 0;
  await send('Page.navigate', { url: `${BASE}/#/${pg}` });
  await sleep(2600);
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({view: (document.querySelector('#view')||{}).innerText || '', viewLen: ((document.querySelector('#view')||{}).innerHTML||'').length, loginHidden: !!document.querySelector('#loginPage.hide'), user: (document.querySelector('#userName')||{}).textContent, engineChip: (document.querySelector('#engineChip')||{}).textContent, disk: (document.querySelector('#diskText')||{}).textContent, hasDiskText: !!document.querySelector('#diskText'), hasTz: !!document.querySelector('#tzChip'), brand: (document.querySelector('.brand small')||{}).textContent || '', top: (document.querySelector('#topChip')||{}).textContent, topShown: (document.querySelector('#topChip')||{}).style.display !== 'none'})`,
    returnByValue: true,
  });
  const v = JSON.parse(r.result?.result?.value || '{}');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const pngPath = path.join(UI, `_app-${pg}.png`);
  if (shot.result?.data) fs.writeFileSync(pngPath, Buffer.from(shot.result.data, 'base64'));
  fs.writeFileSync(path.join(TMP, `view-${pg}.html`), v.view || '', 'utf8');
  const rendered = (v.view || '').trim().length > minLen;
  line(`\n4) ${pg}: 视图文本 ${(v.view || '').length} 字符 / HTML ${v.viewLen} / 截图 ${fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0} 字节`);
  line(`   登录页已隐藏=${v.loginHidden} 用户=${v.user} 引擎=${v.engineChip} 磁盘=${v.disk} 时区chip=${v.hasTz} 顶栏=${v.topShown ? v.top : '(隐藏)'}`);
  line(`   视图前 120 字: ${(v.view || '').replace(/\n+/g, ' / ').slice(0, 120)}`);
  check(rendered, `${pg} 渲染出内容`);
  check(v.loginHidden === true, `${pg} 已通过鉴权进入控制台`);
  check(v.hasTz === false, `${pg} 侧边栏已无时区 chip（时区不在前台显示）`);
  check(v.hasDiskText === false, `${pg} 左下角已无「存储 …/… GB」磁盘文案（磁盘只在总览统计卡展示）`);
  check(!String(v.brand || '').includes('自动分段录制'), `${pg} 左上角品牌副标题文案已删除`, JSON.stringify(v.brand || ''));
  for (const n of needles) check((v.view || '').includes(n) || `${v.engineChip || ''}${v.disk || ''}`.includes(n), `${pg} 视图含「${n}」`, (v.view || '').includes(n) ? '' : '（未在视图文本中找到）');
  for (const n of absent) {
    const inView = (v.view || '').includes(n);
    const inChrome = `${v.engineChip || ''}${v.disk || ''}${v.top || ''}${v.brand || ''}`.includes(n);
    check(!inView && !inChrome, `${pg} 不再出现「${n}」（简化显示）`, inView ? '仍出现在视图' : inChrome ? '仍出现在顶栏/侧栏' : '');
  }
  if (pg === 'dashboard') {
    // 磁盘信息只在「存储统计」卡出现一次（DOM 计数，比文本匹配更稳）
    const dq = await send('Runtime.evaluate', { expression: `document.querySelectorAll('#view .pkdisk').length`, returnByValue: true });
    const dn = Number(dq?.result?.result?.value || 0);
    check(dn === 1, `dashboard 磁盘信息块只出现 1 次（去掉重复卡片）`, `实际 ${dn} 次`);
    check(!/引擎/.test(v.view || ''), 'dashboard 已删除引擎信息卡片');
  }
  if (pg === 'settings') {
    // 存储页签：回收站设置随「录制与存储」拆分后移到存储页签，切过去核对
    await send('Runtime.evaluate', { expression: `document.querySelector('#settingsTabs [data-tab="store"]') && document.querySelector('#settingsTabs [data-tab="store"]').click()`, returnByValue: true });
    await sleep(1200);
    const stab = await send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{const h=document.querySelector('#tabHost')||{};const txt=h.innerText||'';return {txt}})())`,
      returnByValue: true,
    });
    const s = JSON.parse(stab?.result?.result?.value || '{}');
    check(/回收站/.test(s.txt || ''), '存储页签含「回收站」设置（拆分后随存储页签展示）');
    await send('Runtime.evaluate', { expression: `document.querySelector('#settingsTabs [data-tab="platform"]') && document.querySelector('#settingsTabs [data-tab="platform"]').click()`, returnByValue: true });
    await sleep(1600);
    const ptab = await send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{const h=document.querySelector('#tabHost')||{};const html=h.innerHTML||'';const txt=h.innerText||'';return {txt, html, hasCapsCard: html.includes('平台并发上限')}})())`,
      returnByValue: true,
    });
    const p = JSON.parse(ptab?.result?.result?.value || '{}');
    check(/可用清晰度/.test(p.txt || ''), '平台账号页含「可用清晰度」列（页签切换后正常渲染）');
    check(!p.hasCapsCard, '平台账号页不再重复「平台并发上限」卡片（只保留并发上限列）');
    check(!/原画 1080P60/.test(p.txt || ''), '平台账号清晰度已简化为紧凑显示（不再堆一长串档位 chip）');
    check(!/\bstable\b/.test(p.txt || ''), '平台账号不再显示 stable 等英文代号（已翻译成中文）');
  }
  const badConsole = consoleErrors.filter((e) => /LiveGrab|Uncaught|not a function|is not defined|undefined is not/.test(e));
  check(badConsole.length === 0, `${pg} 无前端报错`, badConsole.slice(0, 2).join(' | '));
}

// 5) SSE（此时内网免登录已关，必须带会话 Cookie；顺带验证未登录会被拒）
{
  const anon = await fetch(`${BASE}/api/events`, { headers: { Accept: 'text/event-stream' } });
  check(anon.status === 401, '5) 未登录时 SSE 被拒（401）', String(anon.status));
  const lr = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'livegrab123' }) });
  const cookie = (lr.headers.getSetCookie ? lr.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  check(cookie.includes('lg_session'), '5) Node 侧登录拿到 lg_session');
  let head = ''; let ctype = '';
  try {
    const ac = new AbortController();
    const res = await fetch(`${BASE}/api/events`, { signal: ac.signal, headers: { Accept: 'text/event-stream', Cookie: cookie } });
    ctype = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const { value } = await reader.read();
    head = Buffer.from(value || []).toString('utf8');
    await reader.cancel().catch(() => {});
    ac.abort();
  } catch (e) { head = 'ERR ' + e.message; }
  check(/event: status/.test(head) && /text\/event-stream/.test(ctype), 'SSE /api/events 正常', head.slice(0, 50).replace(/\n/g, '|'));
}

ws.close();
edge.kill();
srv.kill('SIGTERM');
await sleep(1000);
line(`\n临时目录: ${TMP}`);
line(`==== 端到端结果：${bad === 0 ? 'ALL PASS' : `${bad} 项失败`} ====`);
process.exit(bad ? 1 : 0);
