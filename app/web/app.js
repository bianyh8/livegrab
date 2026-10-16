/* LiveGrab · app.js
   应用外壳：鉴权门、hash 路由、2s 轮询当前页、SSE /api/events、全局工具注入。
   零依赖、无构建步骤，只用原生 ESM。 */

import { api, ApiError, setUnauthorizedHandler } from './api.js';
import {
  toast, confirmDialog, formatBytes, formatDuration, formatDurationCn, formatDateTime,
} from './ui.js';
import { loadI18n, t } from './i18n.js';

/* ================= 路由表 ================= */

const ROUTES = [
  { page: 'dashboard', file: 'dashboard', title: t('nav.overview'), sub: t('nav.overviewSub') },
  { page: 'tasks', file: 'tasks', title: t('nav.tasks'), sub: t('nav.tasksSub') },
  { page: 'files', file: 'files', title: t('nav.files'), sub: t('nav.filesSub') },
  { page: 'settings', file: 'settings/index', title: t('nav.settings'), sub: t('nav.settingsSub') },
  { page: 'logs', file: 'logs', title: t('nav.logs'), sub: t('nav.logsSub') },
  { page: 'trash', file: 'trash', title: t('nav.trash'), sub: t('nav.trashSub') },
];
const DEFAULT_PAGE = 'dashboard';

/* ================= 运行时状态 ================= */

const runtime = {
  authed: false,
  user: null,
  tab: false,
  page: null,
  loaded: {},
  view: null,
  viewSeq: 0,
  navSeq: 0,
  tick: 0,
  viewRaf: false,
  loggedInAt: null,
  limits: { maxConcurrency: 8 },
  lastTasks: [],
  topChipText: '',
};

const listeners = new Map();

const ctx = {
  api,
  toast,
  confirm: confirmDialog,
  formatBytes,
  formatDuration,
  formatDurationCn,
  formatDateTime,
  /* 视图注册自己的局部刷新函数（2s 轮询调用，返回 false 表示不再需要刷新）。
     实际渲染时会被 makeViewCtx 换成绑定到本次视图 token 的版本，
     以免旧视图迟到的注册覆盖新视图的刷新逻辑。 */
  onRefresh(fn) {
    if (typeof fn === 'function' && runtime.view) runtime.view.refresh = fn;
  },
  /* 视图间事件总线（SSE 与跨页局部刷新用） */
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  },
  emit(evt, ...args) {
    const set = listeners.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(...args); } catch (e) { console.error('[LiveGrab] 事件处理失败', evt, e); }
    }
  },
  /* 打开「新建/编辑录制任务」弹窗：任何页面点顶栏按钮或总览详情都走这里 */
  openTaskModal(id) {
    if (runtime.page === 'tasks' && runtime.view && runtime.view.page === 'tasks') {
      ctx.emit('open-task-modal', id || null);
      return;
    }
    navigate('tasks');
    /* 等任务页完成挂载（它订阅 open-task-modal）后再触发 */
    setTimeout(() => ctx.emit('open-task-modal', id || null), 80);
  },
  invalidate(page) {
    runtime.loaded[page] = false;
  },
  get limits() { return runtime.limits; },
  get page() { return runtime.page; },
  get user() { return runtime.user; },
  navigate,
};

/* ================= 工具 ================= */

function el(id) { return document.getElementById(id); }

function setText(id, text) { const n = el(id); if (n) n.textContent = text; }

function showLoginErr(msg) {
  const box = el('loginErr');
  const tx = el('loginErrTx');
  if (!box || !tx) return;
  tx.textContent = msg;
  box.classList.add('show');
}
function hideLoginErr() { const b = el('loginErr'); if (b) b.classList.remove('show'); }

function describeError(e) {
  if (!e) return t('common.unknownError');
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS' || e.code === 'BAD_CREDENTIALS') return t('login.errWrong');
    if (e.code === 'LOCKED') return e.message || t('login.errLocked');
    if (e.code === 'WEAK_PASSWORD') return e.message || t('login.errWeak');
    if (e.code === 'ALREADY_INIT') return t('login.errInit');
    if (e.code === 'NETWORK') return e.message;
    return e.message || e.code;
  }
  return e.message || String(e);
}

/* ================= 鉴权门 ================= */

let loginMode = 'login';

function applyLoginMode(mode) {
  loginMode = mode;
  const init = mode === 'init';
  setText('loginTitle', init ? t('login.initTitle') : t('login.title'));
  setText('loginSub', init
    ? t('login.initHint')
    : t('login.hint'));
  const p2 = el('loginPass2Row');
  if (p2) p2.style.display = init ? '' : 'none';
  const row = el('loginRememberRow');
  if (row) row.style.display = init ? 'none' : 'flex';
  const pass = el('loginPass');
  if (pass) {
    pass.setAttribute('autocomplete', init ? 'new-password' : 'current-password');
    pass.value = '';
  }
  const pass2 = el('loginPass2');
  if (pass2) pass2.value = '';
  setText('loginSwitchHint', init ? t('login.switchHintInit') : t('login.switchHintLogin'));
  setText('loginSwitchLink', init ? t('login.switchToLogin') : t('login.initTitle'));
  setText('loginBtn', init ? t('login.btnCreate') : t('login.btnLogin'));
  hideLoginErr();
}

export function showLoginPage() {
  runtime.authed = false;
  stopLoop();
  stopView();
  const app = el('appRoot');
  if (app) app.style.display = 'none';
  const login = el('loginPage');
  if (login) login.classList.remove('hide');
  const view = el('view');
  if (view) view.innerHTML = '';
  if (el('loginPass')) el('loginPass').value = '';
  if (el('loginPass2')) el('loginPass2').value = '';
  document.body.style.overflow = '';
}

async function enterApp(user) {
  runtime.authed = true;
  runtime.user = user || runtime.user;
  const login = el('loginPage');
  if (login) login.classList.add('hide');
  const app = el('appRoot');
  if (app) app.style.display = 'flex';
  if (runtime.user) {
    setText('userName', runtime.user.username || 'admin');
    setText('userAva', String(runtime.user.username || 'A').charAt(0).toUpperCase());
    setText('tbUserName', runtime.user.username || 'admin');
    setText('tbUserAva', String(runtime.user.username || 'A').charAt(0).toUpperCase());
  }
  setText('userMeta', t('app.userMeta', new Date().toTimeString().slice(0, 5)));
  setText('tbUserMeta', t('app.userMeta', new Date().toTimeString().slice(0, 5)));
  startLoop();
  await handleRoute(true);
}

function hideSplash() { const s = document.getElementById('bootSplash'); if (s) s.remove(); }

async function checkAuth() {
  let mode = 'login';
  try {
    const m = await api.authMode();
    mode = (m && m.mode) || 'login';
  } catch (e) {
    mode = 'login';
    if (e instanceof ApiError && e.code === 'NETWORK') {
      applyLoginMode('login');
      showLoginPage();
      hideSplash();
      showLoginErr(t('common.errConn', e.message));
      return;
    }
  }
  try {
    const me = await api.authMe();
    if (me && (me.username || me.ok)) { await enterApp(me); hideSplash(); return; }
  } catch { /* 未登录，进入登录页 */ }
  applyLoginMode(mode);
  showLoginPage();
  hideSplash();
}

function bindLogin() {
  const link = el('loginSwitchLink');
  if (link) link.onclick = () => applyLoginMode(loginMode === 'login' ? 'init' : 'login');

  const forgot = el('loginForgot');
  if (forgot) forgot.onclick = () => toast(t('login.forgot'));

  const t1 = el('pwToggle1');
  if (t1) t1.onclick = () => togglePw(t1, 'loginPass');
  const t2 = el('pwToggle2');
  if (t2) t2.onclick = () => togglePw(t2, 'loginPass2');

  const form = el('loginForm');
  if (form) form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = el('loginBtn');
    const u = (el('loginUser').value || '').trim();
    const p = el('loginPass').value;
    const p2 = el('loginPass2').value;
    if (!u) { showLoginErr(t('login.errUsername')); return; }
    if (!p) { showLoginErr(t('login.errPassword')); return; }
    const init = loginMode === 'init';
    if (init && p.length < 8) { showLoginErr(t('login.errPassLen')); return; }
    if (init && p !== p2) { showLoginErr(t('login.errPassMismatch')); return; }
    hideLoginErr();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = init ? t('login.loadingCreate') : t('login.loadingLogin');
    try {
      const remember = !!(el('loginRemember') && el('loginRemember').checked);
      if (init) await api.init(u, p);
      else await api.login(u, p, remember);
      let me = { username: u };
      try { me = await api.authMe() || me; } catch { /* 忽略 */ }
      runtime.loggedInAt = Date.now();
      toast(init ? t('login.created') : t('login.greeting'));
      await enterApp(me);
    } catch (e) {
      showLoginErr(describeError(e));
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

function togglePw(btn, id) {
  const input = el(id);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? t('login.hidePwd') : t('login.showPwd');
}

async function doLogout() {
  try { await api.logout(); } catch { /* 忽略 */ }
  runtime.user = null;
  runtime.page = null;
  runtime.loaded = {};
  stopView();
  stopLoop();
  closeSse();
  applyLoginMode('login');
  showLoginPage();
  toast(t('login.loggedOut'));
}

/* ================= 路由 ================= */

function parseHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const page = h.split('?')[0].split('/')[0];
  return ROUTES.some((r) => r.page === page) ? page : DEFAULT_PAGE;
}

export function navigate(page) {
  const target = '#/' + page;
  if (location.hash === target) { handleRoute(false); return; }
  location.hash = target;
}

function stopView() {
  if (runtime.view && typeof runtime.view.destroy === 'function') {
    try { runtime.view.destroy(); } catch (e) { console.error('[LiveGrab] 视图清理失败', e); }
  }
  runtime.view = null;
}

/** 等一帧，避免先清空 DOM 再异步加载模块导致的可见闪烁。
    注意：不能只依赖 requestAnimationFrame —— 页面在后台标签页、窗口被遮挡、无头/节流渲染
    或低电量省电模式下，rAF 可能长时间不回调甚至完全停止。此时若只等 rAF，handleRoute 会
    永久卡在这一步：地址栏 hash 变了、页面标题也更新了，但视图始终不重绘（表现为「点导航没反应」），
    且不会有任何报错。故加一个定时器兜底，保证渲染一定会继续往下走。 */
function nextFrame() {
  return new Promise((resolve) => {
    let settled = false;
    const fin = () => { if (!settled) { settled = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fin);
    setTimeout(fin, 48);
  });
}

/* 单次视图渲染的 ctx 门面：所有会「延时生效」的接口都绑定本次视图 token。
   视图在 await 之后调用 ctx.isActive() 即可判断自己是否已被路由切走，
   避免迟到的绘制/注册污染新视图。 */
function makeViewCtx(token) {
  const c = Object.create(ctx);
  c.onRefresh = (fn) => {
    if (runtime.view === token && typeof fn === 'function') token.refresh = fn;
  };
  c.isActive = () => runtime.view === token;
  return c;
}

async function handleRoute(first) {
  if (!runtime.authed) return;
  const page = parseHash();
  const route = ROUTES.find((r) => r.page === page) || ROUTES[0];

  document.querySelectorAll('#nav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  // 底部 Tab 高亮：日志/回收站归入「更多」
  const MORE_PAGES = ['logs', 'trash'];
  document.querySelectorAll('#tabBar .tb-item').forEach((n) => {
    n.classList.toggle('on', n.dataset.page === page || (n.id === 'tbMore' && MORE_PAGES.includes(page)));
  });
  closeMorePanel();
  setText('pageTitle', route.title);
  setText('pageSub', route.sub);

  const changed = runtime.page !== page;
  runtime.page = page;

  if (!changed && !first && runtime.loaded[page]) return;

  const root = el('view');
  if (!root) return;

  /* 本次导航序号：只有「最后一次」导航有权渲染。
     两次导航在极短时间内相继发生（例如总览数据还在路上就切到设置页）时，两次 handleRoute
     会各自挂在 import/等帧的 await 上并发推进。若先发起的旧导航晚于新导航恢复，它会重新把
     runtime.view 抢回自己，并在 render 里重新武装模块级 boundRoot —— 于是旧视图的迟到绘制
     反而覆盖了新视图（表现为「切到设置页后又被总览盖掉」）。用序号把过期的导航挡在渲染之前。 */
  const myNav = (runtime.navSeq += 1);

  // 旧视图立即作废（DOM 先留着，等新视图渲染时再清空，避免闪烁）：
  // 之后它任何迟到的异步绘制都会因 boundRoot/token 失效而被丢弃。
  stopView();

  let mod;
  try {
    mod = await import('./views/' + route.file + '.js');
  } catch (e) {
    console.error('[LiveGrab] 视图模块加载失败', page, e);
    if (runtime.navSeq !== myNav) return; // 已被更新的导航接管：不要动 DOM，也不要作废它的视图
    stopView();
    root.innerHTML = `<div class="card"><div class="empty">${t('pageLoad.failed', escText(e && e.message || e))}</div></div>`;
    return;
  }
  if (runtime.navSeq !== myNav) return; // 已被更新的导航取代：直接放弃，不碰 DOM / runtime.view

  await nextFrame();
  if (runtime.navSeq !== myNav) return;

  if (changed) root.innerHTML = '';
  runtime.view = { page, destroy: null, refresh: null, seq: (runtime.viewSeq += 1) };
  const myToken = runtime.view;
  if (typeof mod.destroy === 'function') runtime.view.destroy = mod.destroy;

  try {
    await mod.render(root, makeViewCtx(myToken));
    if (runtime.view !== myToken) return;
    runtime.loaded[page] = true;
    await refreshOnce();
  } catch (e) {
    console.error('[LiveGrab] 视图渲染失败', page, e);
    if (runtime.view === myToken) {
      root.innerHTML = `<div class="card"><div class="empty">${t('pageRender.failed', escText(e && e.message || e))}</div></div>`;
    }
  }
}

function escText(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ================= 轮询与 SSE ================= */

let pollTimer = null;

function startLoop() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { tick(); }, 2000);
  tick();
}

function stopLoop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function refreshOnce() {
  if (runtime.view && typeof runtime.view.refresh === 'function') {
    try { await runtime.view.refresh(); } catch (e) { console.error('[LiveGrab] 局部刷新失败', e); }
  }
}

async function tick() {
  if (!runtime.authed) return;
  runtime.tick = (runtime.tick + 1) % 9;
  if (runtime.tick === 2) pullStatus(); // 约每 6s 拉一次全量 status，刷新顶栏下载带宽等
  await refreshOnce();
}

async function pullStatus() {
  if (!runtime.authed) return;
  try {
    const st = await api.status();
    applyStatus(st);
    runtime.emit('status', st);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'NETWORK') return;
    /* 404 等实现差异静默忽略，页面各自会再拉一次数据 */
  }
}

function applyStatus(st) {
  if (!st || typeof st !== 'object') return;
  const stats = st.stats || {};

  if (typeof stats.concurrencyCap === 'number') runtime.limits.maxConcurrency = stats.concurrencyCap;

  const nDash = el('navDashBadge');
  if (nDash) {
    const rec = Number(stats.recordingCount) || 0;
    nDash.textContent = t('topbar.recording', rec);
    nDash.style.display = rec > 0 ? '' : 'none';
  }
  // 底部 Tab 录制角标（仅手机显示）
  const tbDash = el('tbDashBadge');
  if (tbDash) {
    const rec = Number(stats.recordingCount) || 0;
    tbDash.textContent = rec ? String(rec) : '';
    tbDash.style.display = rec > 0 ? '' : 'none';
  }

  // 导航徽标：任务管理 = 任务总数；文件管理 = 录制文件总大小
  const taskCnt = Array.isArray(st.tasks) ? st.tasks.length : 0;
  const nTask = el('navTaskBadge');
  if (nTask) { nTask.textContent = taskCnt || ''; nTask.style.display = taskCnt ? '' : 'none'; }
  const tbTask = el('tbTaskBadge');
  if (tbTask) { tbTask.textContent = taskCnt || ''; tbTask.style.display = taskCnt ? '' : 'none'; }
  const fileBytes = (st.platformStore || []).reduce((a, p) => a + (p.bytes || 0), 0);
  const nFile = el('navFileBadge');
  if (nFile) { const txt = fileBytes ? formatBytes(fileBytes) : ''; nFile.textContent = txt; nFile.style.display = txt ? '' : 'none'; }
  const tbFile = el('tbFileBadge');
  if (tbFile) { const txt = fileBytes ? formatBytes(fileBytes) : ''; tbFile.textContent = txt; tbFile.style.display = txt ? '' : 'none'; }

  // 顶栏不再显示「下载带宽」：与总览『实时带宽』同源(stats.downSpeed)，已下放总览展示，删去冗余
}

let sse = null;

function startSse() {
  if (!runtime.authed || typeof EventSource === 'undefined') return;
  if (sse) return;
  try { sse = new EventSource('/api/events'); } catch { sse = null; return; }
  sse.addEventListener('log', (ev) => {
    let line = null;
    try { line = JSON.parse(ev.data); } catch { return; }
    ctx.emit('log', line);
  });
  sse.addEventListener('task', (ev) => {
    ctx.emit('task', safeParse(ev.data));
    pullStatus();
  });
  sse.addEventListener('files', (ev) => ctx.emit('files', safeParse(ev.data)));
  sse.addEventListener('status', (ev) => {
    const d = safeParse(ev.data);
    if (d && d.stats) applyStatus(d);
    ctx.emit('status', d);
  });
  sse.addEventListener('ping', () => { /* 心跳，无需处理 */ });
  sse.onerror = () => { /* EventSource 自带重连 */ };
}

function stopSse() { if (sse) { sse.close(); sse = null; } }
function closeSse() { stopSse(); }

function safeParse(data) {
  try { return JSON.parse(data); } catch { return null; }
}

/* ================= 侧边栏与顶栏 ================= */

function bindChrome() {
  document.querySelectorAll('#nav .nav-item').forEach((item) => {
    item.addEventListener('click', () => navigate(item.dataset.page));
  });
  const out = el('logoutBtn');
  if (out) out.onclick = () => doLogout();

  // 手机底部 Tab
  document.querySelectorAll('#tabBar .tb-item[data-page]').forEach((item) => {
    item.addEventListener('click', () => { closeMorePanel(); navigate(item.dataset.page); });
  });
  const tbMore = el('tbMore');
  const panel = el('tbMorePanel');
  if (tbMore && panel) tbMore.onclick = (ev) => {
    ev.stopPropagation();
    panel.classList.toggle('show');
  };
  panel?.querySelectorAll('.mi[data-page]').forEach((m) => {
    m.addEventListener('click', () => { closeMorePanel(); navigate(m.dataset.page); });
  });
  const tbLogout = el('tbLogout');
  if (tbLogout) tbLogout.onclick = () => { closeMorePanel(); doLogout(); };
  document.addEventListener('click', (ev) => {
    if (panel && panel.classList.contains('show') && !panel.contains(ev.target) && ev.target !== tbMore) closeMorePanel();
  });
}

function closeMorePanel() {
  const panel = el('tbMorePanel');
  if (panel) panel.classList.remove('show');
}

/* ================= 启动 ================= */

async function boot() {
  setUnauthorizedHandler(() => {
    if (!runtime.authed) return;
    runtime.authed = false;
    applyLoginMode('login');
    showLoginPage();
    showLoginErr(t('common.errInvalid'));
  });
  bindChrome();
  bindLogin();
  ctx.on('logout', () => { doLogout(); });
  ctx.on('refresh-all', () => { ctx.invalidate(runtime.page); });
  window.addEventListener('hashchange', () => { handleRoute(false); });
  try {
    // 时区不在前台显示/修改（默认 Asia/Shanghai，Docker 里由 compose 的 environment: TZ 提供），
    // 这里只在前端启动时探活一次，失败也不阻塞登录页。
    await api.health();
  } catch { /* 后端尚未就绪也不阻塞登录页 */ }
  await checkAuth();
  void loadI18n().catch(() => {}); // 拉取可外部编辑的字典覆盖（默认字典已同步可用，不阻塞首帧）
  startSse();
}

boot();
