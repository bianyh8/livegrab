/* LiveGrab · app.js
   应用外壳：鉴权门、hash 路由、2s 轮询当前页、SSE /api/events、全局工具注入。
   零依赖、无构建步骤，只用原生 ESM。 */

import { api, ApiError, setUnauthorizedHandler } from './api.js';
import {
  toast, confirmDialog, formatBytes, formatDuration, formatDurationCn, formatDateTime,
} from './ui.js';

/* ================= 路由表 ================= */

const ROUTES = [
  { page: 'dashboard', file: 'dashboard', title: '总览', sub: '实时监控中的直播间与录制状态' },
  { page: 'tasks', file: 'tasks', title: '录制任务', sub: '管理监控列表、清晰度与分段策略' },
  { page: 'files', file: 'files', title: '录制文件', sub: '浏览、回放、转封装与清理已录制文件' },
  { page: 'events', file: 'events', title: '最近事件', sub: '引擎与任务的关键动作（最新在前）' },
  { page: 'settings', file: 'settings/index', title: '系统设置', sub: '录制与存储、命名规则、平台账号、通知、安全与登录' },
  { page: 'logs', file: 'logs', title: '运行日志', sub: '引擎与每个任务的详细运行记录' },
  { page: 'trash', file: 'trash', title: '回收站', sub: '已删除录制文件与刮削图片/描述，可还原或清空' },
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
  /* 视图注册自己的局部刷新函数（2s 轮询调用，返回 false 表示不再需要刷新） */
  onRefresh(fn) {
    if (typeof fn === 'function') runtime.view.refresh = fn;
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
  if (!e) return '未知错误';
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS' || e.code === 'BAD_CREDENTIALS') return '用户名或密码错误';
    if (e.code === 'LOCKED') return e.message || '失败次数过多，已临时锁定，请稍后再试';
    if (e.code === 'WEAK_PASSWORD') return e.message || '密码强度不足（至少 8 位）';
    if (e.code === 'ALREADY_INIT') return '账号已初始化，请直接登录';
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
  setText('loginTitle', init ? '初始化管理员账号' : '登录管理台');
  setText('loginSub', init
    ? '首次部署，请设置管理员账号与密码（密码至少 8 位）'
    : '请输入管理员账号与密码以访问录制管理台');
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
  setText('loginSwitchHint', init ? '已经初始化过？' : '首次部署？');
  setText('loginSwitchLink', init ? '返回登录' : '初始化管理员账号');
  setText('loginBtn', init ? '创建并登录' : '登 录');
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
  }
  setText('userMeta', '管理员 · 本次登录 ' + new Date().toTimeString().slice(0, 5));
  startLoop();
  await handleRoute(true);
}

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
      showLoginErr('无法连接后端服务（' + e.message + '）');
      return;
    }
  }
  try {
    const me = await api.authMe();
    if (me && (me.username || me.ok)) { await enterApp(me); return; }
  } catch { /* 未登录，进入登录页 */ }
  applyLoginMode(mode);
  showLoginPage();
}

function bindLogin() {
  const link = el('loginSwitchLink');
  if (link) link.onclick = () => applyLoginMode(loginMode === 'login' ? 'init' : 'login');

  const forgot = el('loginForgot');
  if (forgot) forgot.onclick = () => toast('请联系部署管理员：删除容器内 /config/users.json 后重启即可重新初始化密码');

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
    if (!u) { showLoginErr('请输入用户名'); return; }
    if (!p) { showLoginErr('请输入密码'); return; }
    const init = loginMode === 'init';
    if (init && p.length < 8) { showLoginErr('密码至少 8 位'); return; }
    if (init && p !== p2) { showLoginErr('两次输入的密码不一致'); return; }
    hideLoginErr();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = init ? '正在创建…' : '正在登录…';
    try {
      const remember = !!(el('loginRemember') && el('loginRemember').checked);
      if (init) await api.init(u, p);
      else await api.login(u, p, remember);
      let me = { username: u };
      try { me = await api.authMe() || me; } catch { /* 忽略 */ }
      runtime.loggedInAt = Date.now();
      toast(init ? '管理员账号已创建，已自动登录' : '登录成功，欢迎回来');
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
  btn.textContent = show ? '隐藏' : '显示';
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
  toast('已退出登录');
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

/** 等一帧，避免先清空 DOM 再异步加载模块导致的可见闪烁 */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function handleRoute(first) {
  if (!runtime.authed) return;
  const page = parseHash();
  const route = ROUTES.find((r) => r.page === page) || ROUTES[0];

  document.querySelectorAll('#nav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === page));
  setText('pageTitle', route.title);
  setText('pageSub', route.sub);
  const newBtn = el('newTaskBtn');
  if (newBtn) newBtn.style.display = (page === 'dashboard' || page === 'tasks') ? '' : 'none';

  const changed = runtime.page !== page;
  runtime.page = page;

  if (!changed && !first && runtime.loaded[page]) return;

  const root = el('view');
  if (!root) return;

  let mod;
  try {
    mod = await import('./views/' + route.file + '.js');
  } catch (e) {
    console.error('[LiveGrab] 视图模块加载失败', page, e);
    stopView();
    root.innerHTML = `<div class="card"><div class="empty">页面加载失败：${escText(e && e.message || e)}</div></div>`;
    return;
  }

  await nextFrame();
  stopView();
  if (changed) root.innerHTML = '';
  runtime.view = { page, destroy: null, refresh: null };
  const myToken = runtime.view;
  if (typeof mod.destroy === 'function') runtime.view.destroy = mod.destroy;

  try {
    await mod.render(root, ctx);
    if (runtime.view !== myToken) return;
    runtime.loaded[page] = true;
    await refreshOnce();
  } catch (e) {
    console.error('[LiveGrab] 视图渲染失败', page, e);
    if (runtime.view === myToken) {
      root.innerHTML = `<div class="card"><div class="empty">页面渲染失败：${escText(e && e.message || e)}</div></div>`;
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
  const engine = st.engine || {};

  if (typeof stats.concurrencyCap === 'number') runtime.limits.maxConcurrency = stats.concurrencyCap;

  const chip = el('engineChip');
  if (chip) {
    if (engine.ffmpegAvailable) { chip.className = 'chip on'; chip.innerHTML = '<i class="dot"></i>引擎正常'; }
    else { chip.className = 'chip err'; chip.innerHTML = '<i class="dot"></i>ffmpeg 不可用'; }
  }

  const nDash = el('navDashBadge');
  if (nDash) {
    const rec = Number(stats.recordingCount) || 0;
    nDash.textContent = rec + ' 录制中';
    nDash.style.display = rec > 0 ? '' : 'none';
  }

  const top = el('topChip');
  if (top) {
    // 顶栏只显示下载带宽；未录制(无流量)时固定显示 0
    const bw = Number(stats.downSpeed) || 0;
    runtime.topChipText = `下载带宽 ${bw > 0 ? fmtRate(bw) : '0'}`;
    top.textContent = runtime.topChipText;
    top.style.display = '';
  }
}

function fmtRate(bitsPerSec) {
  const b = Number(bitsPerSec) || 0;
  if (b > 8 * 1024 * 1024) return `${(b / (8 * 1024 * 1024)).toFixed(1)} MB/s`;
  if (b > 0) return `${Math.round(b / (8 * 1024))} KB/s`;
  return '—';
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
  const refresh = el('refreshBtn');
  if (refresh) refresh.onclick = () => {
    runtime.invalidate(runtime.page);
    runtime.emit('refresh-all');
    pullStatus();
    refreshOnce();
    toast('已重新拉取所有直播间状态');
  };
  const nb = el('newTaskBtn');
  if (nb) nb.onclick = () => ctx.openTaskModal(null);
  const out = el('logoutBtn');
  if (out) out.onclick = () => doLogout();
}

/* ================= 启动 ================= */

async function boot() {
  setUnauthorizedHandler(() => {
    if (!runtime.authed) return;
    runtime.authed = false;
    applyLoginMode('login');
    showLoginPage();
    showLoginErr('登录已失效，请重新登录');
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
  startSse();
}

boot();
