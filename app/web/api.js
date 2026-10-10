/* LiveGrab · api.js
   统一 fetch 封装：同源 Cookie、统一解包 {ok,data} / {ok:false,error}、401 跳登录。
   零依赖，仅浏览器原生 API。 */

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code || '请求失败');
    this.name = 'ApiError';
    this.code = code || 'ERROR';
    this.status = status || 0;
  }
}

let onUnauthorized = null;
/** 注册未登录回调（由 app.js 注入：清空状态并回到登录页） */
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

/** 统一解包：优先 {ok:true,data}，兼容直接返回数据体的端点 */
async function unwrap(res) {
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (body && typeof body === 'object' && 'ok' in body) {
    if (body.ok) return body.data;
    const err = body.error || {};
    throw new ApiError(err.code || 'ERROR', err.message || '请求失败', res.status);
  }
  if (res.ok) return body === null ? {} : body;
  throw new ApiError('HTTP_' + res.status, 'HTTP ' + res.status, res.status);
}

async function request(method, url, body, opts = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {},
  };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError('NETWORK', '无法连接到服务，请确认容器仍在运行', 0);
  }
  if (res.status === 401 && opts.noAuthRedirect !== true) {
    if (typeof onUnauthorized === 'function') onUnauthorized();
    throw new ApiError('UNAUTHORIZED', '登录已失效，请重新登录', 401);
  }
  return unwrap(res);
}

/* ================= 字段归一化（兼容后端 LogLine 的 ts/time 命名） ================= */

/** 后端 §6.5.3 LogLine 的字段名在本文件统一归一化，视图只读 ts/level/taskId/taskName/msg */
export function normalizeLogLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ts = raw.ts != null ? raw.ts : (raw.time != null ? raw.time : raw.at);
  return {
    ts: ts != null ? ts : Date.now(),
    level: String(raw.level || 'INFO').toUpperCase(),
    taskId: raw.taskId || raw.task || null,
    taskName: raw.taskName || null,
    msg: raw.msg != null ? raw.msg : (raw.message != null ? raw.message : ''),
    raw,
  };
}

function normalizeLogs(r) {
  if (!r) return { items: [], files: [] };
  const items = (Array.isArray(r.items) ? r.items : Array.isArray(r.logs) ? r.logs : [])
    .map(normalizeLogLine).filter(Boolean);
  return { items, files: Array.isArray(r.files) ? r.files : [] };
}

function qs(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

export const api = {
  get: (url, params) => request('GET', url + qs(params)),
  post: (url, body, opts) => request('POST', url, body === undefined ? {} : body, opts),
  put: (url, body) => request('PUT', url, body === undefined ? {} : body),
  patch: (url, body) => request('PATCH', url, body === undefined ? {} : body),
  del: (url, body) => request('DELETE', url, body),

  /* ---- 语义化快捷方法（按 §6.5.2 冻结端点） ---- */
  health: () => request('GET', '/api/health', null, { noAuthRedirect: true }),
  authMode: () => request('GET', '/api/auth/mode', null, { noAuthRedirect: true }),
  authMe: () => request('GET', '/api/auth/me', null, { noAuthRedirect: true }),
  login: (username, password, remember) => request('POST', '/api/auth/login', { username, password, remember: !!remember }, { noAuthRedirect: true }),
  init: (username, password) => request('POST', '/api/auth/init', { username, password }, { noAuthRedirect: true }),
  logout: () => request('POST', '/api/auth/logout', {}, { noAuthRedirect: true }),
  password: (oldPassword, newPassword) => request('POST', '/api/auth/password', { oldPassword, newPassword }),

  platforms: () => request('GET', '/api/platforms'),
  status: () => request('GET', '/api/status'),
  tasks: () => request('GET', '/api/tasks'),
  task: (id) => request('GET', '/api/tasks/' + encodeURIComponent(id)),
  createTask: (payload) => request('POST', '/api/tasks', payload),
  patchTask: (id, payload) => request('PATCH', '/api/tasks/' + encodeURIComponent(id), payload),
  deleteTask: (id, force) => request('DELETE', '/api/tasks/' + encodeURIComponent(id) + (force ? '?force=1' : '')),
  taskAction: (id, action) => request('POST', `/api/tasks/${encodeURIComponent(id)}/${action}`, {}),
  batch: (action, ids) => request('POST', '/api/tasks/batch', { action, ids }),
  tasksReorder: (ids) => request('POST', '/api/tasks/order', { ids }),
  resolve: (url, platform) => request('POST', '/api/resolve', platform ? { url, platform } : { url }),

  naming: () => request('GET', '/api/naming'),
  saveNaming: (payload) => request('PUT', '/api/naming', payload),
  namingPreview: (payload) => request('POST', '/api/naming/preview', payload),

  settings: () => request('GET', '/api/settings'),
  saveSettings: (payload) => request('PUT', '/api/settings', payload),
  env: () => request('GET', '/api/settings/env'),
  saveCookie: (platform, cookie) => request('POST', '/api/settings/cookie', { platform, cookie }),
  delCookie: (platform) => request('DELETE', '/api/settings/cookie?platform=' + encodeURIComponent(platform)),
  notifyTest: () => request('POST', '/api/notify/test', {}),

  files: (params) => request('GET', '/api/files' + qs(params)),
  filesTree: async (params) => {
    try { return await request('GET', '/api/files/tree' + qs(params)); }
    catch (e) {
      if (e && e.code === 'HTTP_404' && params && Object.keys(params).length) return request('GET', '/api/files/tree');
      throw e;
    }
  },
  filesScan: () => request('POST', '/api/files/scan', {}),
  unregistered: () => request('GET', '/api/files/unregistered'),
  importFiles: (paths) => request('POST', '/api/files/import', { paths }),
  remux: (fileId) => request('POST', `/api/files/${encodeURIComponent(fileId)}/remux`, {}),
  merge: (sessionId) => request('POST', '/api/files/merge', { sessionId }),
  filesDelete: (payload) => request('POST', '/api/files/delete', payload),
  streamUrl: (fileId) => `/api/files/${encodeURIComponent(fileId)}/stream`,
  downloadUrl: (fileId) => `/api/files/${encodeURIComponent(fileId)}/download`,
  play: (fileId) => request('POST', '/api/play', { fileId }),
  releasePlay: (playId) => request('DELETE', '/api/play/' + encodeURIComponent(playId)),
  playStreamUrl: (playId) => `/api/play/${encodeURIComponent(playId)}/stream`,

  trash: () => request('GET', '/api/trash'),
  trashRestore: (ids) => request('POST', '/api/trash/restore', { ids }),
  trashEmpty: () => request('POST', '/api/trash/empty', {}),
  trashPurge: (ids) => request('POST', '/api/trash/purge', { ids }),

  logs: async (params) => normalizeLogs(await request('GET', '/api/logs' + qs(params))),
};

export default api;
