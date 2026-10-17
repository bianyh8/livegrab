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
  /* 轮询等待目标页挂载：该页特征词已出现，且视图文本连续多次读数一致，才视为渲染稳定。
     此前用「长度 > minLen」作为就绪条件之一——切页瞬间 #view 仍是上一页的长文本，
     会被误判为「已就绪」，于是下一页（如回收站）在数据回来前就被采样 → 偶发 FAIL。
     现改为必须命中特征词，并要求连续 3 次读数一致（收敛等待），彻底消除该时序抖动。 */
  let prevView = null;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    const q = await send('Runtime.evaluate', { expression: `((document.querySelector('#view')||{}).innerText||'')`, returnByValue: true });
    const txt = String(q?.result?.result?.value || '');
    const ready = needles.some((n) => txt.includes(n)) && txt.trim().length > minLen;
    if (ready && txt === prevView) { if (++stable >= 2) break; } else stable = 0;
    prevView = txt;
    await sleep(200);
  }
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({view: (document.querySelector('#view')||{}).innerText || '', viewLen: ((document.querySelector('#view')||{}).innerHTML||'').length, hash: location.hash, loginHidden: !!document.querySelector('#loginPage.hide'), user: (document.querySelector('#userName')||{}).textContent, engineChip: (document.querySelector('#engineChip')||{}).textContent, disk: (document.querySelector('#diskText')||{}).textContent, hasDiskText: !!document.querySelector('#diskText'), hasTz: !!document.querySelector('#tzChip'), brand: (document.querySelector('.brand small')||{}).textContent || '', top: (document.querySelector('#topChip')||{}).textContent, topShown: (document.querySelector('#topChip')||{}).style.display !== 'none'})`,
    returnByValue: true,
  });
  const v = JSON.parse(r.result?.result?.value || '{}');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const pngPath = path.join(UI, `_app-${pg}.png`);
  if (shot.result?.data) fs.writeFileSync(pngPath, Buffer.from(shot.result.data, 'base64'));
  fs.writeFileSync(path.join(TMP, `view-${pg}.html`), v.view || '', 'utf8');
  const rendered = (v.view || '').trim().length > minLen;
  line(`\n4) ${pg}: 视图文本 ${(v.view || '').length} 字符 / HTML ${v.viewLen} / 截图 ${fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0} 字节`);
  line(`   路由=${v.hash} 登录页已隐藏=${v.loginHidden} 用户=${v.user} 引擎=${v.engineChip} 磁盘=${v.disk} 时区chip=${v.hasTz} 顶栏=${v.topShown ? v.top : '(隐藏)'}`);
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
  if (pg === 'logs') {
    /* 回归：设置页数据在飞行中时切走页面，迟到的绘制不得覆盖新视图。
       页面内把 /api/settings 延迟 800ms，稳定复现该竞态（不靠时序碰运气）。 */
    await send('Runtime.evaluate', { expression: `(() => { const of = window.fetch; window.__lgFetch = of; window.fetch = (u, o) => { const s = String((u && u.url) || u); if (s.includes('/api/settings')) return new Promise((r) => setTimeout(() => r(of(u, o)), 800)); return of(u, o); }; return true; })()` });
    await send('Page.navigate', { url: `${BASE}/#/settings` });
    await sleep(200);
    const raceAt = Date.now();
    await send('Page.navigate', { url: `${BASE}/#/logs` });
    /* 收敛等待：等运行日志页渲染完成，且跨过设置页迟到绘制窗口（/api/settings 被延迟 800ms）。 */
    let nv = {};
    for (let i = 0; i < 40; i++) {
      const navq = await send('Runtime.evaluate', { expression: `JSON.stringify({t: ((document.querySelector('#view')||{}).innerText||'').slice(0, 160), tabs: document.querySelectorAll('#settingsTabs').length})`, returnByValue: true });
      nv = JSON.parse(navq?.result?.result?.value || '{}');
      const converged = nv.tabs === 0 && String(nv.t || '').includes('最新在前');
      if (converged && Date.now() - raceAt >= 1600) break;
      await sleep(200);
    }
    line(`   切页竞态回归: #settingsTabs=${nv.tabs} / 视图=${String(nv.t || '').replace(/\n+/g, ' / ').slice(0, 50)}`);
    check(nv.tabs === 0, '设置页加载中切走后，其迟到绘制不再覆盖新视图', `#settingsTabs=${nv.tabs}`);
    check(String(nv.t || '').includes('最新在前'), '切走后视图仍是目标页（运行日志）', String(nv.t || '').replace(/\n+/g, ' / ').slice(0, 50));
    await send('Runtime.evaluate', { expression: `window.fetch = window.__lgFetch || window.fetch` });

    /* 回归：暂停「实时追加」后，全局 2s 轮询不得再请求 /api/logs。
       此前暂停只拦了 SSE 追加，2s 轮询仍会重绘拉入新日志 → 暂停形同虚设。
       用 fetch 计数跨两个轮询周期验证，不靠时序碰运气。 */
    const liveq = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        grouped: !!document.querySelector('.log-actions #lgLive') && !!document.querySelector('.log-actions #lgOrder') && !!document.querySelector('.log-actions #lgClear'),
        filterGrouped: !!document.querySelector('.log-filters #lgLevel'),
        label: (document.querySelector('#lgLive')||{}).innerText || ''
      })`,
      returnByValue: true,
    });
    const lv = JSON.parse(liveq?.result?.result?.value || '{}');
    line(`   日志工具栏分组: 按钮区=${lv.grouped} 筛选区=${lv.filterGrouped} chip=${JSON.stringify(lv.label)}`);
    check(lv.grouped && lv.filterGrouped, '日志工具栏：操作按钮归入 .log-actions / 筛选归入 .log-filters', JSON.stringify(lv));
    check(String(lv.label).includes('实时追加中'), '初始为「实时追加中」', String(lv.label));

    await send('Runtime.evaluate', { expression: `(() => {
      window.__lgLogCalls = 0;
      const of = window.fetch; window.__lgFetchLogs = of;
      window.fetch = (u, o) => { const s = String((u && u.url) || u); if (s.includes('/api/logs')) window.__lgLogCalls++; return of(u, o); };
      document.querySelector('#lgLive').click();
      return true;
    })()` });
    await sleep(120);
    const pl = await send('Runtime.evaluate', { expression: `(document.querySelector('#lgLive')||{}).innerText || ''`, returnByValue: true });
    check(String(pl?.result?.result?.value || '').includes('已暂停'), '点击后切换为「实时追加已暂停」', String(pl?.result?.result?.value || ''));

    await sleep(4600); // 跨过至少两个 2s 轮询周期
    const cq = await send('Runtime.evaluate', { expression: `window.__lgLogCalls`, returnByValue: true });
    const nCalls = Number(cq?.result?.result?.value || 0);
    check(nCalls === 0, '暂停后 2s 轮询不再请求日志（新日志不会被刷出）', `paused 期间 /api/logs 调用 ${nCalls} 次`);

    await send('Runtime.evaluate', { expression: `document.querySelector('#lgLive').click()` }); // 恢复
    await sleep(400);
    const rl = await send('Runtime.evaluate', { expression: `(document.querySelector('#lgLive')||{}).innerText || ''`, returnByValue: true });
    const rc = await send('Runtime.evaluate', { expression: `window.__lgLogCalls`, returnByValue: true });
    check(String(rl?.result?.result?.value || '').includes('实时追加中'), '恢复后回到「实时追加中」', String(rl?.result?.result?.value || ''));
    check(Number(rc?.result?.result?.value || 0) >= 1, '恢复后立即补拉最新日志', `resume 后 /api/logs 调用 ${rc?.result?.result?.value}`);
    await send('Runtime.evaluate', { expression: `window.fetch = window.__lgFetchLogs || window.fetch` });

    /* 回归：关键字搜索框输入不被重绘打断。
       此前搜索框在 paint() 里被整体重建，输入触发 300ms 防抖重绘后焦点/光标丢失、无法继续输入；
       全局 2s 轮询同样会重绘。修复后搜索走局部重绘（paintResults），搜索框节点保持不变。
       用节点标记 __lgKeep 判「同一 DOM 节点未被重建」，比只看焦点更灵敏。 */
    await send('Runtime.evaluate', { expression: `(() => {
      const q = document.querySelector('#lgQ');
      if (!q) return;
      q.__lgKeep = 1; q.focus(); q.value = '调度'; q.dispatchEvent(new Event('input', { bubbles: true }));
    })()` });
    await sleep(800); // 跨过 300ms 防抖 + 一次查询/重绘
    const sq1 = await send('Runtime.evaluate', { expression: `JSON.stringify({
      focus: (document.activeElement||{}).id || '',
      val: (document.querySelector('#lgQ')||{}).value || '',
      sameNode: (document.querySelector('#lgQ')||{}).__lgKeep === 1,
    })`, returnByValue: true });
    const s1 = JSON.parse(sq1?.result?.result?.value || '{}');
    line(`   搜索框重绘回归: 焦点=${s1.focus} 值=${JSON.stringify(s1.val)} 同节点=${s1.sameNode}`);
    check(s1.sameNode === true, '输入关键字后搜索框未被重建（同一 DOM 节点）', JSON.stringify(s1));
    check(s1.focus === 'lgQ', '输入后搜索框保持焦点（可连续输入）', `focus=${s1.focus}`);
    check(s1.val === '调度', '搜索框内容完整保留', JSON.stringify(s1.val));

    await sleep(2600); // 再跨一个 2s 轮询周期：轮询重绘也不得夺走焦点/内容
    const sq2 = await send('Runtime.evaluate', { expression: `JSON.stringify({
      focus: (document.activeElement||{}).id || '',
      val: (document.querySelector('#lgQ')||{}).value || '',
      sameNode: (document.querySelector('#lgQ')||{}).__lgKeep === 1,
    })`, returnByValue: true });
    const s2 = JSON.parse(sq2?.result?.result?.value || '{}');
    check(s2.sameNode && s2.focus === 'lgQ' && s2.val === '调度', '跨 2s 轮询后搜索框仍保持焦点与内容', JSON.stringify(s2));
    // 清理：清空搜索并恢复完整列表
    await send('Runtime.evaluate', { expression: `(() => { const q = document.querySelector('#lgQ'); if (q) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); } })()` });
    await sleep(500);

    /* 同类回归（总览页）：/api/status 迟到返回时，总览不得回写 #view 覆盖当前页。
       目标页选设置页——它不做 2s 轮询重绘，迟到覆盖不会被轮询刷掉，判据更灵敏；
       判据用总览独有的磁盘块 #view .pkdisk 与设置页页签计数双向校验。 */
    await send('Runtime.evaluate', { expression: `(() => { const of = window.fetch; window.__lgFetch2 = of; window.fetch = (u, o) => { const s = String((u && u.url) || u); if (s.includes('/api/status')) return new Promise((r) => setTimeout(() => r(of(u, o)), 800)); return of(u, o); }; return true; })()` });
    await send('Page.navigate', { url: `${BASE}/#/dashboard` });
    await sleep(200);
    const raceAt2 = Date.now();
    await send('Page.navigate', { url: `${BASE}/#/settings` });
    /* 收敛等待：等设置页渲染完成（出现设置页页签与「命名规则」），且至少跨过迟到绘制的窗口
       （/api/status 被延迟 800ms，其迟到回调必然已发生）后再采样判据。
       固定 sleep 在负载高时会采到「设置页还没渲染完」的中间态（tabs=0）→ 偶发 FAIL。 */
    let dv = {};
    for (let i = 0; i < 40; i++) {
      const dashq = await send('Runtime.evaluate', { expression: `JSON.stringify({t: ((document.querySelector('#view')||{}).innerText||'').slice(0, 160), pk: document.querySelectorAll('#view .pkdisk').length, tabs: document.querySelectorAll('#settingsTabs').length, hash: location.hash, title: (document.querySelector('#pageTitle')||{}).textContent || ''})`, returnByValue: true });
      dv = JSON.parse(dashq?.result?.result?.value || '{}');
      const converged = dv.pk === 0 && dv.tabs === 1 && String(dv.t || '').includes('命名规则');
      if (converged && Date.now() - raceAt2 >= 1600) break;
      await sleep(200);
    }
    line(`   切页竞态回归(总览): hash=${dv.hash} title=${dv.title} #view .pkdisk=${dv.pk} / #settingsTabs=${dv.tabs} / 视图=${String(dv.t || '').replace(/\n+/g, ' / ').slice(0, 40)}`);
    check(dv.pk === 0 && dv.tabs === 1, '总览页迟到绘制不再回写 #view（设置页未被覆盖）', `pkdisk=${dv.pk} settingsTabs=${dv.tabs}`);
    check(String(dv.t || '').includes('命名规则'), '切走后视图仍是目标页（设置）', String(dv.t || '').replace(/\n+/g, ' / ').slice(0, 40));
    await send('Runtime.evaluate', { expression: `window.fetch = window.__lgFetch2 || window.fetch` });
  }
  if (pg === 'tasks') {
    /* 回归：任务管理查询框输入不被重绘打断（用户报「刚输入一个字就查询、查询不能正常用」）。
       此前 #tkQ 搜索防抖走全量 paint() 整体重建，输入触发重绘后焦点/光标丢失、无法连续输入；
       全局 2s 轮询同样全量重绘抢焦点。修复后搜索/翻页/轮询都走局部重绘（paintResults），
       搜索框节点保持不变。用节点标记 __tkKeep 判「同一 DOM 节点未被重建」，比只看焦点更灵敏。
       注意：查询条件默认折叠，先点折叠头展开（该步会全量重建一次 #tkQ），再标记+输入。 */
    await send('Runtime.evaluate', { expression: `document.querySelector('#tkFilterToggle') && document.querySelector('#tkFilterToggle').click()` });
    await sleep(400); // 等展开后的全量重绘完成（此步会重建一次 #tkQ）
    await send('Runtime.evaluate', { expression: `(() => {
      const q = document.querySelector('#tkQ');
      if (!q) return;
      q.__tkKeep = 1; q.focus(); q.value = '验证'; q.dispatchEvent(new Event('input', { bubbles: true }));
    })()` });
    await sleep(900); // 跨过 300ms 防抖 + 一次查询/重绘
    const tq1 = await send('Runtime.evaluate', { expression: `JSON.stringify({
      focus: (document.activeElement||{}).id || '',
      val: (document.querySelector('#tkQ')||{}).value || '',
      sameNode: (document.querySelector('#tkQ')||{}).__tkKeep === 1,
      summary: ((document.querySelector('#tkFilterToggle .tq-summary')||{}).innerText || '').trim(),
    })`, returnByValue: true });
    const t1 = JSON.parse(tq1?.result?.result?.value || '{}');
    line(`   任务查询框重绘回归: 焦点=${t1.focus} 值=${JSON.stringify(t1.val)} 同节点=${t1.sameNode} 摘要=${JSON.stringify(t1.summary)}`);
    check(t1.sameNode === true, '输入关键字后任务查询框未被重建（同一 DOM 节点）', JSON.stringify(t1));
    check(t1.focus === 'tkQ', '输入后任务查询框保持焦点（可连续输入）', `focus=${t1.focus}`);
    check(t1.val === '验证', '任务查询框内容完整保留', JSON.stringify(t1.val));
    check(String(t1.summary).includes('验证'), '查询条件摘要已反映当前关键字（确认走了局部重绘）', JSON.stringify(t1.summary));

    await sleep(2600); // 再跨一个 2s 轮询周期：轮询重绘也不得夺走焦点/内容
    const tq2 = await send('Runtime.evaluate', { expression: `JSON.stringify({
      focus: (document.activeElement||{}).id || '',
      val: (document.querySelector('#tkQ')||{}).value || '',
      sameNode: (document.querySelector('#tkQ')||{}).__tkKeep === 1,
    })`, returnByValue: true });
    const t2 = JSON.parse(tq2?.result?.result?.value || '{}');
    check(t2.sameNode && t2.focus === 'tkQ' && t2.val === '验证', '跨 2s 轮询后任务查询框仍保持焦点与内容', JSON.stringify(t2));
    // 清理：清空查询并恢复完整列表
    await send('Runtime.evaluate', { expression: `(() => { const q = document.querySelector('#tkQ'); if (q) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); } })()` });
    await sleep(600);
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

    // 系统更新页签：模块顺序应为 更新源配置（置顶）→ 更新管理 → 左「更新说明」/ 右「更新日志」
    await send('Runtime.evaluate', { expression: `document.querySelector('#settingsTabs [data-tab="update"]') && document.querySelector('#settingsTabs [data-tab="update"]').click()`, returnByValue: true });
    let u = {};
    /* 收敛等待：更新页签异步渲染——进入时先拉 updateStatus，未检查过还会再触发一次 check，
       而 check 要访问 GitHub（离线/网络受限时按 15s 超时计），最慢约 16s 才落到 paint。
       固定等待 9s 会在网络受限时抓到「加载中」空壳 → 偶发 FAIL；这里给足 24s 预算。 */
    for (let i = 0; i < 80; i++) {
      const utab = await send('Runtime.evaluate', {
        expression: `JSON.stringify((() => {
          const host = document.querySelector('#tabHost');
          if (!host) return { err: 'no tabHost' };
          const heads = [...host.querySelectorAll('.card h3')];
          const titles = heads.map((h) => (h.innerText || '').trim());
          const idx = (kw) => titles.findIndex((s) => s.includes(kw));
          const leftOf = (kw) => { const h = heads.find((x) => (x.innerText || '').includes(kw)); return h ? Math.round(h.getBoundingClientRect().left) : -1; };
          return { titles, iCfg: idx('更新源配置'), iMgmt: idx('更新管理'), iNotes: idx('更新说明'), iLog: idx('更新日志'), notesLeft: leftOf('更新说明'), logLeft: leftOf('更新日志') };
        })())`,
        returnByValue: true,
      });
      u = JSON.parse(utab?.result?.result?.value || '{}');
      if (u.iCfg === 0 && u.iMgmt === 1 && u.iNotes > 1 && u.iLog > 1) break;
      await sleep(300);
    }
    line(`   更新页模块顺序: ${JSON.stringify(u.titles)}`);
    check(u.iCfg === 0 && u.iMgmt === 1, '更新页模块顺序：更新源配置置顶、其下为更新管理', JSON.stringify(u.titles));
    check(u.iNotes > u.iMgmt && u.iLog > u.iMgmt, '更新说明/更新日志位于更新管理之后', JSON.stringify(u.titles));
    check(u.notesLeft >= 0 && u.logLeft >= 0 && u.notesLeft < u.logLeft, '更新说明在左、更新日志在右', `notes=${u.notesLeft} log=${u.logLeft}`);
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

/* 6) 手机播放器「横屏」按钮：**全屏下必须真的转过去**
   回归背景：曾把旋转写在 #plBox 上，而 #plBox 正是全屏元素——UA 样式表对全屏元素
   强制 position/inset/width/height/transform 全部 !important（含 transform:none），
   于是「点横屏」在任何进了全屏的手机上一点反应都没有。现改为旋转内层舞台 #plStage。
   这里用真机同款路径复现：真实触摸进全屏 → 真实点击横屏 → 量几何。 */
{
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  /* 无头下的页面默认被当成「未聚焦/后台」，合成输入不会带来用户激活，
     requestFullscreen 一律被拒（not granted）、rAF 也可能被节流。显式开启聚焦模拟。 */
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  /* 记录 requestFullscreen 的成败，便于断言失败时直接看出原因（UA 拒绝 → 无用户手势/被策略拦） */
  await send('Runtime.evaluate', { expression: `(() => {
    window.__fsLog = [];
    const f = Element.prototype.requestFullscreen;
    if (f && !f.__lgPatched) {
      const wrap = function () {
        const p = f.apply(this, arguments);
        if (p && p.then) p.then(() => window.__fsLog.push('ok:' + this.id), (e) => window.__fsLog.push('rej:' + this.id + ':' + ((e && (e.message || e.name)) || e)));
        return p;
      };
      wrap.__lgPatched = true;
      Element.prototype.requestFullscreen = wrap;
    }
    return true;
  })()` });

  const geom = `JSON.stringify({
    fs: document.fullscreenElement ? document.fullscreenElement.id : null,
    land: document.getElementById('plBox').classList.contains('pv-land'),
    boxT: getComputedStyle(document.getElementById('plBox')).transform,
    stageT: getComputedStyle(document.getElementById('plStage')).transform,
    stageW: getComputedStyle(document.getElementById('plStage')).width,
    stageH: getComputedStyle(document.getElementById('plStage')).height,
    ctl: (() => { const r = document.getElementById('plMCtl').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  })`;
  const readGeom = async () => JSON.parse((await send('Runtime.evaluate', { expression: geom, returnByValue: true })).result?.result?.value || '{}');
  const rectOf = async (sel) => JSON.parse((await send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return '{}';const b=el.getBoundingClientRect();return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)})})()`, returnByValue: true })).result?.result?.value || '{}');
  /* 一律走真实鼠标点击：CDP 的 tap 手势只发 touch、不合成 click，且不被计入用户手势
     （实测 tap 进全屏会被 UA 以「not granted」拒绝）。 */
  const click = async (sel) => {
    const r = await rectOf(sel);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(400);
  };

  /* 手机上播放器是从「点文件行」这个手势里打开的（openPlayer 里立刻 enterFs 才拿得到全屏）。
     这里同样在真实点击里打开，否则首次无手势的请求会被拒并污染该源的权限状态。 */
  await send('Runtime.evaluate', { expression: `(() => {
    const b = document.createElement('button');
    b.id = 'e2eOpenPlayer';
    b.style.cssText = 'position:fixed;left:6px;top:6px;width:64px;height:36px;z-index:9999';
    b.textContent = 'open';
    b.addEventListener('click', async () => {
      const m = await import('/ui.js');
      m.openMobilePlayer({ api: { downloadUrl: () => '' } }, { fileId: 'e2e-orient', name: '横屏回归' }, { mode: 'direct', playId: null }, 'direct', 'data:video/mp4;base64,AAAAIGZ0eXBpc29t');
    });
    document.body.appendChild(b);
    return true;
  })()` });
  await click('#e2eOpenPlayer');
  await send('Runtime.evaluate', { expression: `document.getElementById('e2eOpenPlayer')?.remove()` });
  const opened = await send('Runtime.evaluate', { expression: `!!document.querySelector('#plStage')`, returnByValue: true });
  check(opened.result?.result?.value === true, '6) 手机播放器已渲染（视频与控制条在内层舞台 #plStage 内）');

  /* 等全屏真正生效再断言：CDP 合成的手势不一定被算作用户激活（UA 会以 not granted 拒绝），
     而全屏是本段的前提条件。这里连点画面收敛等待——app 里 click 会补一次 enterFs，
     每次点击都是新的手势机会；拿不到就如实报 FAIL 并把 requestFullscreen 的返回打出来。 */
  let g0 = {};
  for (let i = 0; i < 8; i++) {
    g0 = await readGeom();
    if (g0.fs) break;
    await click('#plBox');
  }
  const fslog0 = (await send('Runtime.evaluate', { expression: `JSON.stringify({log: window.__fsLog, enabled: document.fullscreenEnabled})`, returnByValue: true })).result?.result?.value;
  check(g0.fs === 'plBox', '6) 播放器处于全屏（复现该 bug 的前提条件）', String(fslog0));
  check(g0.land === false && g0.ctl[0] > g0.ctl[1], '6) 初始为竖屏（控制条横跨屏幕宽度）', `ctl=${g0.ctl} 舞台=${g0.stageW}×${g0.stageH}`);

  await click('#plOrient');
  const g1 = await readGeom();
  line(`   横屏: 舞台=${g1.stageW}×${g1.stageH} transform=${g1.stageT} 控制条=${g1.ctl}`);
  check(g1.land === true && g1.stageW !== g1.stageH && /matrix\(0,\s*1,\s*-1,\s*0,/.test(g1.stageT), '6) 全屏下点「横屏」真的转过去了（舞台宽高互换 + 旋转 90°）', `舞台=${g1.stageW}×${g1.stageH}`);
  check(g1.ctl[1] > g1.ctl[0], '6) 控制条随舞台转为竖排（内容确实横过来了）', `ctl=${g1.ctl}`);
  check(g1.boxT === 'none', '6) 旋转不依赖全屏元素本身（UA 对其强制 transform:none !important）', `boxT=${g1.boxT}`);

  await click('#plOrient');
  const g2 = await readGeom();
  check(g2.land === false && g2.ctl[0] > g2.ctl[1], '6) 再点一次回到竖屏', `ctl=${g2.ctl}`);

  await send('Runtime.evaluate', { awaitPromise: true, expression: `import('/ui.js').then((m) => m.closePlayer())` });
  await sleep(300);
  const cleared = await send('Runtime.evaluate', { expression: `JSON.stringify({fs: !!document.fullscreenElement, stage: !!document.querySelector('#plStage')})`, returnByValue: true });
  check(JSON.parse(cleared.result?.result?.value || '{}').stage === false, '6) 关闭播放器后舞台已移除');
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
}

/* 7) 播放器进度条「按住拖动」seek（用户反馈：只能点击、不能拖动）
   回归背景：进度条历来只绑 onclick——只能点、不能拖。现改为 Pointer Events +
   setPointerCapture：按下即定位（原点击行为保留）、拖动中只回绘预览不写
   currentTime、松手才结算。data: 视频没有时长，先 stub duration/currentTime，
   再按真实鼠标 pressed→moved→released 序列驱动。 */
{
  /* 竖屏视口：桌面横窗口下浏览器 orientation 就是 landscape，媒体查询会按设计
     取消舞台旋转（设备本就横屏，无需模拟），那样测不到「强制横屏」的旋转路径。 */
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
  const rectOf = async (sel) => JSON.parse((await send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return '{}';const b=el.getBoundingClientRect();return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)})})()`, returnByValue: true })).result?.result?.value || '{}');
  const click = async (sel) => {
    const r = await rectOf(sel);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(400);
  };
  const openSeekPlayer = async (mode) => {
    await send('Runtime.evaluate', { expression: `(() => {
      const b = document.createElement('button');
      b.id = 'e2eSeekPlayer';
      b.style.cssText = 'position:fixed;left:6px;top:6px;width:64px;height:36px;z-index:9999';
      b.textContent = 'open';
      b.addEventListener('click', async () => {
        const m = await import('/ui.js');
        m.openMobilePlayer({ api: { downloadUrl: () => '' } }, { fileId: 'e2e-seek', name: '拖动回归' }, { mode: ${JSON.stringify(mode)}, playId: null }, ${JSON.stringify(mode)}, 'data:video/mp4;base64,AAAAIGZ0eXBpc29t');
      });
      document.body.appendChild(b);
      return true;
    })()` });
    await click('#e2eSeekPlayer');
    await send('Runtime.evaluate', { expression: `document.getElementById('e2eSeekPlayer')?.remove()` });
    await sleep(300);
    await send('Runtime.evaluate', { expression: `(() => {
      const v = document.getElementById('plVideo');
      if (!v) return false;
      Object.defineProperty(v, 'duration', { configurable: true, get: () => 100 });
      let ct = 0;
      window.__seekLog = [];
      Object.defineProperty(v, 'currentTime', {
        configurable: true,
        get: () => ct,
        set: (x) => { ct = x; window.__seekLog.push(x); },
      });
      return true;
    })()` });
  };
  const trackRect = async () => JSON.parse((await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector('#plMTrack'); if (!el) return '{}'; const b = el.getBoundingClientRect(); return JSON.stringify({ l: b.left, t: b.top, w: b.width, h: b.height, mx: b.left + b.width / 2, my: b.top + b.height / 2 }); })()`, returnByValue: true })).result?.result?.value || '{}');
  const seekLog = async () => JSON.parse((await send('Runtime.evaluate', { expression: `JSON.stringify(window.__seekLog || [])`, returnByValue: true })).result?.result?.value || '[]');

  await openSeekPlayer('direct');
  /* 竖屏：按住 25% 处 → 拖到 60% → 松手。设计：按下/拖动只回绘预览，松手才写 currentTime */
  const r0 = await trackRect();
  check(r0.w > 0 && r0.h > 0, '7) 进度条已渲染', JSON.stringify(r0));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r0.l + r0.w * 0.25, y: r0.my, button: 'left', clickCount: 1 });
  await sleep(150);
  const afterDown = await seekLog();
  const fillDown = (await send('Runtime.evaluate', { expression: `document.getElementById('plMFill').style.width`, returnByValue: true })).result?.result?.value;
  check(afterDown.length === 0 && parseFloat(fillDown) > 22 && parseFloat(fillDown) < 28, '7) 按下只回绘预览（定位 25%），不写 currentTime', `log=${JSON.stringify(afterDown)} fill=${fillDown}`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r0.l + r0.w * 0.6, y: r0.my, button: 'left' });
  await sleep(150);
  const afterMove = await seekLog();
  check(afterMove.length === 0, '7) 拖动过程中不写 currentTime（只回绘预览，避免反复寻址）', JSON.stringify(afterMove));
  const fillW = (await send('Runtime.evaluate', { expression: `document.getElementById('plMFill').style.width`, returnByValue: true })).result?.result?.value;
  check(parseFloat(fillW) > 55 && parseFloat(fillW) < 65, '7) 拖动预览已回绘填充条（60%）', String(fillW));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r0.l + r0.w * 0.6, y: r0.my, button: 'left', clickCount: 1 });
  await sleep(150);
  const afterUp = await seekLog();
  check(afterUp.length === 1 && Math.abs(afterUp[0] - 60) < 2, '7) 松手结算到 60%（拖动 seek 生效）', JSON.stringify(afterUp));

  /* 横屏：舞台整体 rotate(90deg)，进度条水平轴在屏幕上呈竖直，必须沿 clientY 取比例 */
  await click('#plOrient');
  await sleep(400);
  const land0 = (await send('Runtime.evaluate', { expression: `JSON.stringify({ land: document.getElementById('plBox').classList.contains('pv-land'), stageT: getComputedStyle(document.getElementById('plStage')).transform })`, returnByValue: true })).result?.result?.value;
  line(`   横屏诊断: ${land0}`);
  const r1 = await trackRect();
  check(r1.h > r1.w, '7) 横屏后进度条呈竖直（包围盒宽高互换）', `w=${r1.w} h=${r1.h}`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r1.mx, y: r1.t + r1.h * 0.25, button: 'left', clickCount: 1 });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r1.mx, y: r1.t + r1.h * 0.75, button: 'left' });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r1.mx, y: r1.t + r1.h * 0.75, button: 'left', clickCount: 1 });
  await sleep(150);
  const afterLand = await seekLog();
  check(afterLand.length === 2 && Math.abs(afterLand[1] - 75) < 2, '7) 横屏拖动沿屏幕竖直方向取比例（松手结算到 75%）', JSON.stringify(afterLand));

  await send('Runtime.evaluate', { awaitPromise: true, expression: `import('/ui.js').then((m) => m.closePlayer())` });
  await sleep(200);

  /* remux 边转边播：不可 seek，按下只提示 */
  await openSeekPlayer('remux');
  const r2 = await trackRect();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r2.l + r2.w * 0.5, y: r2.my, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r2.l + r2.w * 0.5, y: r2.my, button: 'left', clickCount: 1 });
  await sleep(150);
  const remuxLog = await seekLog();
  check(remuxLog.length === 0, '7) remux 边转边播不可拖动/点击 seek', JSON.stringify(remuxLog));
  const remuxToast = (await send('Runtime.evaluate', { expression: `document.getElementById('toastTx') ? document.getElementById('toastTx').textContent : ''`, returnByValue: true })).result?.result?.value;
  check(!!remuxToast && remuxToast.length > 0, '7) remux 模式按下有提示（toast）', String(remuxToast));
  await send('Runtime.evaluate', { awaitPromise: true, expression: `import('/ui.js').then((m) => m.closePlayer())` });
  await send('Emulation.clearDeviceMetricsOverride');
}

ws.close();
edge.kill();
srv.kill('SIGTERM');
await sleep(1000);
line(`\n临时目录: ${TMP}`);
line(`==== 端到端结果：${bad === 0 ? 'ALL PASS' : `${bad} 项失败`} ====`);
process.exit(bad ? 1 : 0);
