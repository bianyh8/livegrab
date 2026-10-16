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
  /* 轮询等待目标页挂载：该页特征词已出现且视图文本连续两次一致才视为稳定。
     固定 sleep 在负载高时会抓成上一页（历史串页误判），这里改为收敛等待。 */
  let prevView = null;
  for (let i = 0; i < 30; i++) {
    const q = await send('Runtime.evaluate', { expression: `((document.querySelector('#view')||{}).innerText||'')`, returnByValue: true });
    const txt = String(q?.result?.result?.value || '');
    const ready = needles.some((n) => txt.includes(n)) || txt.trim().length > minLen;
    if (ready && txt === prevView) break;
    prevView = txt;
    await sleep(200);
  }
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
  if (pg === 'logs') {
    /* 回归：设置页数据在飞行中时切走页面，迟到的绘制不得覆盖新视图。
       页面内把 /api/settings 延迟 800ms，稳定复现该竞态（不靠时序碰运气）。 */
    await send('Runtime.evaluate', { expression: `(() => { const of = window.fetch; window.__lgFetch = of; window.fetch = (u, o) => { const s = String((u && u.url) || u); if (s.includes('/api/settings')) return new Promise((r) => setTimeout(() => r(of(u, o)), 800)); return of(u, o); }; return true; })()` });
    await send('Page.navigate', { url: `${BASE}/#/settings` });
    await sleep(200);
    await send('Page.navigate', { url: `${BASE}/#/logs` });
    await sleep(2000);
    const navq = await send('Runtime.evaluate', { expression: `JSON.stringify({t: ((document.querySelector('#view')||{}).innerText||'').slice(0, 160), tabs: document.querySelectorAll('#settingsTabs').length})`, returnByValue: true });
    const nv = JSON.parse(navq?.result?.result?.value || '{}');
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
    await send('Page.navigate', { url: `${BASE}/#/settings` });
    await sleep(2200);
    const dashq = await send('Runtime.evaluate', { expression: `JSON.stringify({t: ((document.querySelector('#view')||{}).innerText||'').slice(0, 160), pk: document.querySelectorAll('#view .pkdisk').length, tabs: document.querySelectorAll('#settingsTabs').length})`, returnByValue: true });
    const dv = JSON.parse(dashq?.result?.result?.value || '{}');
    line(`   切页竞态回归(总览): #view .pkdisk=${dv.pk} / #settingsTabs=${dv.tabs} / 视图=${String(dv.t || '').replace(/\n+/g, ' / ').slice(0, 40)}`);
    check(dv.pk === 0 && dv.tabs === 1, '总览页迟到绘制不再回写 #view（设置页未被覆盖）', `pkdisk=${dv.pk} settingsTabs=${dv.tabs}`);
    check(String(dv.t || '').includes('命名规则'), '切走后视图仍是目标页（设置）', String(dv.t || '').replace(/\n+/g, ' / ').slice(0, 40));
    await send('Runtime.evaluate', { expression: `window.fetch = window.__lgFetch2 || window.fetch` });
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
