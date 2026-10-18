/* LiveGrab · views/logs.js —— 运行日志
   级别 / 任务 / 平台 / 关键字过滤 ＋ 后端分页查询（历史全量，按文件分页）＋ SSE 实时追加 ＋ 保留策略说明
   ＋ 导出 / 复制 ＋ 按日期清除日志。 */

import { api, normalizeLogLine } from '../api.js';
import { t } from '../i18n.js';
import { esc, formatLogTime, formatBytes, emptyBox, toast, copyText, downloadText, confirmDialog, openDialog, el, captureFocus, restoreFocus } from '../ui.js';

const PAGE_SIZE = 50;
const EXPORT_MAX = 20000;

const state = {
  level: '',
  taskId: '',
  platform: '',
  q: '',
  rows: [],
  files: [],
  tasks: [],
  newestFirst: true,
  lastTs: 0,
  paused: false,
  pending: false,
  bound: false,
  livePending: false,
  page: 1,
  pageSize: PAGE_SIZE,
  total: 0,
  pages: 1,
  limits: { logRetentionDays: 14, logLevel: 'INFO' },
};

let boundRoot = null;
let offLog = null;
let onRefreshAll = null;

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('logs.loading')}</div></div>`;

  /* 支持 #/logs?task=xxx 从任务页「日志」按钮带入过滤条件 */
  const m = (location.hash || '').match(/[?&]task=([^&]+)/);
  if (m) { state.taskId = decodeURIComponent(m[1]); }

  if (offLog) { offLog(); offLog = null; }
  offLog = ctx.on('log', (raw) => {
    const line = normalizeLogLine(raw);
    if (!line || state.paused) return;
    // 仅当位于最新页（第 1 页）且无过滤条件时实时追加；否则防抖刷新，让新日志经分页查询进入当前视图
    const liveOk = state.page === 1 && !state.level && !state.taskId && !state.platform && !String(state.q || '').trim();
    if (liveOk) {
      const ts = new Date(line.ts || 0).getTime();
      if (ts > state.lastTs) state.lastTs = ts;
      state.total += 1;
      state.pages = Math.max(1, Math.ceil(state.total / state.pageSize));
      appendRow(line);
    } else if (!state.livePending) {
      state.livePending = true;
      setTimeout(() => {
        state.livePending = false;
        if (state.paused || !boundRoot) return; // 暂停时取消这次防抖刷新，避免“点了暂停仍刷出新日志”
        refresh(ctx, true);
      }, 1200);
    }
  });

  if (onRefreshAll) { onRefreshAll(); onRefreshAll = null; }
  onRefreshAll = ctx.on('refresh-all', () => { if (boundRoot) { state.pending = false; refresh(ctx); } });

  // 全局 2s 轮询会调用这里的回调：暂停实时追加时跳过自动刷新，
  // 否则每 2 秒拉取重绘仍会把新日志刷出来，导致「暂停」形同虚设。
  // 注意：仅拦截自动轮询；筛选/翻页/清除等用户主动操作仍直接调用 refresh()，不受暂停影响。
  ctx.onRefresh(() => { if (!state.paused) refresh(ctx, false, false); });
  await refresh(ctx, true);
}

export function destroy() {
  if (offLog) { offLog(); offLog = null; }
  if (onRefreshAll) { onRefreshAll(); onRefreshAll = null; }
  state.bound = false;
  boundRoot = null;
}

async function refresh(ctx, initial, full = true) {
  const root = boundRoot;
  if (!root) return;
  if (state.pending) return;
  state.pending = true;
  try {
    if (!state.limitsFetched) {
      state.limitsFetched = true;
      try {
        const st = await api.settings();
        state.limits = {
          logRetentionDays: Number(st && st.logRetentionDays) || 14,
          logLevel: (st && st.logLevel) || 'INFO',
        };
        // 页面默认显示全部级别：不随后端"默认日志级别"预设过滤，用户可在下拉手动切换
      } catch { /* 用默认值 */ }
    }
    const r = await api.logs({
      level: state.level, taskId: state.taskId, q: state.q || '',
      page: state.page, pageSize: state.pageSize, order: state.newestFirst ? 'desc' : 'asc',
    });
    state.rows = r.items || [];
    state.total = Number(r.total) || 0;
    state.page = Math.max(1, Number(r.page) || 1);
    state.pageSize = Number(r.pageSize) || state.pageSize;
    state.pages = Math.max(1, Number(r.pages) || Math.ceil(state.total / state.pageSize));
    state.tasks = r.tasks || [];
    state.files = r.files || [];
    state.lastTs = state.rows.reduce((mx, l) => Math.max(mx, new Date(l.ts || 0).getTime()), 0);
    if (full) paint(ctx); else paintResults(ctx);
  } catch (e) {
    if (initial) root.innerHTML = `<div class="card"><div class="empty">${t('logs.loadFailed', esc(e.message || e))}</div></div>`;
  } finally {
    state.pending = false;
  }
}

/* ---------- 过滤（当前页数据上的本地兜底过滤） ---------- */

/** 排序已由后端按 order 完成，这里只做与 SSE 实时追加共用的兜底过滤 */
function filtered() {
  return state.rows.filter(matches);
}

/* 导出 / 复制：一次性拉取全量匹配日志（最多 EXPORT_MAX 条） */
async function fetchAllFiltered() {
  const r = await api.logs({
    level: state.level, taskId: state.taskId, q: state.q || '',
    page: 1, pageSize: EXPORT_MAX, order: state.newestFirst ? 'desc' : 'asc',
  });
  return (r.items || []).filter(matches);
}

/* ---------- 渲染 ---------- */

function pagerHtml() {
  return `
    <div class="pager" id="lgPager">
      <button class="btn sm ghost" id="lgFirst"${state.page <= 1 ? ' disabled' : ''} title="${t('logs.firstPage')}">«</button>
      <button class="btn sm ghost" id="lgPrev"${state.page <= 1 ? ' disabled' : ''}>‹ ${t('common.pagerPrev')}</button>
      <span class="pager-info">${t('logs.pagerInfo', state.page, state.pages, state.total)}</span>
      <button class="btn sm ghost" id="lgNext"${state.page >= state.pages ? ' disabled' : ''}>${t('common.pagerNext')} ›</button>
      <button class="btn sm ghost" id="lgLast"${state.page >= state.pages ? ' disabled' : ''} title="${t('logs.lastPage')}">»</button>
      <span class="pager-go">${t('logs.goPage')} <input class="input" id="lgPageGo" type="number" min="1" max="${state.pages}" value="${state.page}" style="width:56px;padding:4px 6px" /> <button class="btn sm ghost" id="lgGo">${t('logs.goBtn')}</button></span>
    </div>`;
}

function hintHtml() {
  const totalBytes = state.files.reduce((n, f) => n + (Number(f.bytes) || 0), 0);
  const retDays = Number(state.limits.logRetentionDays) || 14;
  const retLevel = esc(state.limits.logLevel || 'INFO');
  let hint = t('logs.hint', retDays, retLevel, state.pageSize);
  if (state.files.length) hint += t('logs.filesNote', state.files.length, esc(formatBytes(totalBytes)));
  return hint;
}

/** 全量渲染：工具栏 + 结果区。仅在初始/筛选切换/排序切换/清除等离散操作时调用。
 *  注意：会重建 #lgQ 搜索框，因此输入过程中绝不能走这里（见 paintResults / rerender(..., false)）。 */
function paint(ctx) {
  const root = boundRoot;
  if (!root) return;
  const focus = captureFocus(root);
  root.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="log-filters">
          <select class="select" id="lgLevel" style="width:130px">
            ${[['', t('logs.levelAll')], ['INFO', 'INFO'], ['WARN', 'WARN'], ['ERROR', 'ERROR'], ['DEBUG', 'DEBUG']]
              .map(([v, lbl]) => `<option value="${v}"${state.level === v ? ' selected' : ''}>${lbl}</option>`).join('')}
          </select>
          <select class="select" id="lgTask" style="width:190px">
            <option value="">${t('logs.taskAll')}</option>
            ${state.tasks.map((tk) => `<option value="${esc(tk.id)}"${state.taskId === tk.id ? ' selected' : ''}>${esc(tk.name)}</option>`).join('')}
            ${state.taskId && !state.tasks.some((tk) => tk.id === state.taskId)
              ? `<option value="${esc(state.taskId)}" selected>${t('logs.taskLocked', esc(state.taskId))}</option>` : ''}
          </select>
          <select class="select" id="lgPlat" style="width:140px">
            ${[['', t('common.allPlatforms')], ['抖音', t('plat.douyin')], ['哔哩哔哩', t('plat.bilibili')], ['快手', t('plat.kuaishou')], ['虎牙', t('plat.huya')], ['斗鱼', t('plat.douyu')], ['小红书', t('plat.xiaohongshu')], ['微博', t('plat.weibo')]]
              .map(([v, lbl]) => `<option value="${v}"${state.platform === v ? ' selected' : ''}>${lbl}</option>`).join('')}
          </select>
          <input class="input" id="lgQ" style="width:200px" placeholder="${t('logs.qPlaceholder')}" value="${esc(state.q)}" />
        </div>
        <div class="spacer"></div>
        <div class="log-actions">
          <button class="btn sm ghost" id="lgOrder" title="${t('logs.toggleOrder')}">${state.newestFirst ? t('logs.newestFirst') : t('logs.newestLast')}</button>
          <span class="chip ${state.paused ? 'wait' : 'on'} link" id="lgLive" style="cursor:pointer"><i class="dot"></i>${state.paused ? t('logs.livePaused') : t('logs.liveStreaming')}</span>
          <button class="btn sm danger" id="lgClear">${t('logs.clear')}</button>
          <button class="btn sm ghost" id="lgCopy">${t('common.copy')}</button>
          <button class="btn sm ghost" id="lgExport">${t('logs.export')}</button>
        </div>
      </div>
      <div class="hintline" style="margin:0 16px 12px" id="lgHint">${hintHtml()}</div>
      <div class="card-b" style="padding:0" id="lgTable">${table()}</div>
      ${pagerHtml()}
      <div class="hintline" style="margin:10px 16px 14px" id="lgCount"></div>
    </div>`;

  bind(ctx);
  restoreFocus(root, focus);
  syncCount();
}

/** 仅重绘结果区（表格 + 分页 + 计数 + 说明），不重建工具栏与搜索框。
 *  搜索输入与全局 2s 轮询都走这里：避免重绘搜索框导致焦点/光标丢失、中文输入法（IME）组合被打断。 */
function paintResults(ctx) {
  const root = boundRoot;
  if (!root) return;
  const focus = captureFocus(root);
  const tbl = root.querySelector('#lgTable');
  if (tbl) tbl.innerHTML = table();
  const pagerEl = root.querySelector('#lgPager');
  if (pagerEl) pagerEl.outerHTML = pagerHtml();
  const hintEl = root.querySelector('#lgHint');
  if (hintEl) hintEl.innerHTML = hintHtml();
  bindPager(ctx);
  restoreFocus(root, focus);
  syncCount();
}

function table() {
  const rows = filtered();
  if (!rows.length) return emptyBox(state.rows.length ? t('logs.emptyFiltered') : t('logs.empty'));
  return `<table>
    <thead><tr><th style="width:120px">${t('logs.colTime')}</th><th style="width:80px">${t('logs.colLevel')}</th><th style="width:170px">${t('logs.colTask')}</th><th>${t('logs.colMsg')}</th></tr></thead>
    <tbody id="lgBody">${rows.map(row).join('')}</tbody>
  </table>`;
}

function row(l) {
  const level = String(l.level || 'INFO').toUpperCase();
  return `<tr><td class="mono" style="color:var(--txt-3)" data-label="${t('logs.colTime')}">${esc(formatLogTime(l.ts))}</td>
    <td data-label="${t('logs.colLevel')}"><span class="lv ${esc(level)}">${esc(level)}</span></td>
    <td data-label="${t('logs.colTask')}">${esc(l.taskName || '—')}</td>
    <td class="logline">${esc(l.msg || '')}</td></tr>`;
}

function appendRow(line) {
  const tbody = boundRoot && boundRoot.querySelector('#lgBody');
  if (!tbody) return;
  if (!matches(line)) return;
  const tmp = document.createElement('tbody');
  tmp.innerHTML = row(line);
  const tr = tmp.firstElementChild;
  if (state.newestFirst) tbody.insertBefore(tr, tbody.firstChild);
  else tbody.appendChild(tr);
  syncCount();
}

function matches(l) {
  if (state.level && String(l.level || '').toUpperCase() !== state.level) return false;
  if (state.taskId && l.taskId !== state.taskId) return false;
  if (state.platform && !String(l.msg || '').includes(state.platform) && !String(l.platform || '').includes(state.platform)) return false;
  const kw = state.q.trim().toLowerCase();
  if (kw && !String(l.msg || '').toLowerCase().includes(kw) && !String(l.taskName || '').toLowerCase().includes(kw)) return false;
  return true;
}

function syncCount() {
  const node = boundRoot && boundRoot.querySelector('#lgCount');
  if (node) node.textContent = t('logs.count', state.total, state.rows.length, state.newestFirst ? t('logs.newestFirst') : t('logs.newestLast'), state.page, state.pages);
  const live = boundRoot && boundRoot.querySelector('#lgLive');
  if (live) {
    live.className = 'chip ' + (state.paused ? 'wait' : 'on');
    live.innerHTML = `<i class="dot"></i>${state.paused ? t('logs.livePaused') : t('logs.liveStreaming')}`;
  }
}

/* ---------- 交互 ---------- */

/** 应用筛选补丁并刷新。full=true 全量重绘（会重建搜索框）；false 仅重绘结果区。
 *  搜索输入/轮询/翻页一律走 full=false，保证搜索框不被重建、焦点与中文输入法不被打断。 */
async function rerender(ctx, patch, full = true) {
  Object.assign(state, patch);
  state.pending = false;
  await refresh(ctx, true, full);
}

/** 绑定分页按钮。paint() 后由 bind() 调用；paintResults() 重建分页块后需再次调用。 */
function bindPager(ctx) {
  const root = boundRoot;
  if (!root) return;
  const goto = (page) => {
    const p = Math.max(1, Math.min(state.pages, Number(page) || 1));
    if (p !== state.page) rerender(ctx, { page: p }, false);
  };
  const pg = (id, page) => {
    const b = root.querySelector(id);
    if (b) b.onclick = () => goto(page);
  };
  pg('#lgFirst', 1);
  pg('#lgPrev', state.page - 1);
  pg('#lgNext', state.page + 1);
  pg('#lgLast', state.pages);
  const goBtn = root.querySelector('#lgGo');
  const goIn = root.querySelector('#lgPageGo');
  if (goBtn) goBtn.onclick = () => goto(goIn ? goIn.value : state.page);
  if (goIn) goIn.onkeydown = (e) => { if (e.key === 'Enter' && goBtn) goBtn.click(); };
}

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;

  const level = root.querySelector('#lgLevel');
  if (level) level.onchange = () => rerender(ctx, { level: level.value, page: 1 });
  const task = root.querySelector('#lgTask');
  if (task) task.onchange = () => rerender(ctx, { taskId: task.value, page: 1 });
  const plat = root.querySelector('#lgPlat');
  if (plat) plat.onchange = () => rerender(ctx, { platform: plat.value, page: 1 });

  const q = root.querySelector('#lgQ');
  if (q) {
    let timer = null;
    q.oninput = () => {
      state.q = q.value;
      clearTimeout(timer);
      // 局部更新结果（full=false）：不重建搜索框，输入可连续、中文输入法组合不被打断
      timer = setTimeout(() => rerender(ctx, { q: q.value, page: 1 }, false), 300);
    };
  }

  const live = root.querySelector('#lgLive');
  if (live) live.onclick = () => {
    state.paused = !state.paused;
    if (state.paused) state.livePending = false; // 取消已在等待的防抖刷新
    syncCount();
    toast(state.paused ? t('logs.pauseLiveToast') : t('logs.resumeLiveToast'));
    if (!state.paused) refresh(ctx, false, false); // 恢复时立即补拉暂停期间的最新日志
  };

  const order = root.querySelector('#lgOrder');
  if (order) order.onclick = () => rerender(ctx, { newestFirst: !state.newestFirst, page: 1 });

  bindPager(ctx);

  const copy = root.querySelector('#lgCopy');
  if (copy) copy.onclick = async () => {
    try {
      const text = (await fetchAllFiltered()).map((l) => `[${formatLogTime(l.ts)}] ${String(l.level || 'INFO').toUpperCase()} ${l.taskName || '-'} ${l.msg || ''}`).join('\n');
      copyText(text || t('logs.noLogs'), t('logs.copied'));
    } catch (e) { toast(e.message || t('logs.loadFailed'), 'err'); }
  };
  const exp = root.querySelector('#lgExport');
  if (exp) exp.onclick = async () => {
    try {
      const text = (await fetchAllFiltered()).map((l) => `[${formatLogTime(l.ts)}] ${String(l.level || 'INFO').toUpperCase()} ${l.taskName || '-'} ${l.msg || ''}`).join('\r\n');
      downloadText(`livegrab_logs_${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain;charset=utf-8');
      toast(t('logs.exportedToast'));
    } catch (e) { toast(e.message || t('logs.loadFailed'), 'err'); }
  };

  const clear = root.querySelector('#lgClear');
  if (clear) clear.onclick = () => askClearRange(ctx);
}

/* ---------- 清除日志（预设时间范围） ---------- */

const CLEAR_RANGES = [
  ['1h', t('logs.clear1h')],
  ['24h', t('logs.clear24h')],
  ['7d', t('logs.clear7d')],
  ['30d', t('logs.clear1m')],
  ['all', t('logs.clearAll')],
];

/* 不同时间范围用不同颜色标记（绿/蓝/黄/紫/红，红为最破坏性操作） */
const CLEAR_STYLE = {
  '1h': 'color:#9bf3d3;border-color:rgba(46,230,168,.35);background:rgba(46,230,168,.10)',
  '24h': 'color:#cfe0ff;border-color:rgba(91,140,255,.4);background:rgba(91,140,255,.12)',
  '7d': 'color:#ffd08a;border-color:rgba(247,178,59,.35);background:rgba(247,178,59,.10)',
  '30d': 'color:#d9c6ff;border-color:rgba(169,123,255,.4);background:rgba(169,123,255,.12)',
  'all': 'color:#ffa3a8;border-color:rgba(242,84,91,.4);background:rgba(242,84,91,.12)',
};

function askClearRange(ctx) {
  openDialog({
    title: t('logs.clear'),
    width: '320px',
    body: `<div style="display:flex;flex-direction:column;gap:8px;padding:2px 0">${CLEAR_RANGES
      .map(([v, label]) => `<button class="btn" data-clear="${v}" style="width:100%;${CLEAR_STYLE[v] || ''}">${esc(label)}</button>`).join('')}</div>`,
    footer: (close, bodyEl) => {
      bodyEl.querySelectorAll('[data-clear]').forEach((btn) => {
        btn.onclick = () => { close(); doClear(btn.dataset.clear, ctx); };
      });
      const cancel = el('button', 'btn ghost', t('common.cancel'));
      cancel.onclick = close;
      return [cancel];
    },
  });
}

function dateFmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function doClear(range, ctx) {
  const now = Date.now();
  const DAY = 86400000;
  let from = '';
  let to = dateFmt(new Date(now));
  if (range === '1h') from = to;
  else if (range === '24h') from = dateFmt(new Date(now - DAY));
  else if (range === '7d') from = dateFmt(new Date(now - 6 * DAY));
  else if (range === '30d') from = dateFmt(new Date(now - 29 * DAY));
  else { from = ''; to = ''; }
  confirmDialog({
    title: t('logs.clear'),
    text: range === 'all' ? t('logs.clearAllConfirm') : t('logs.clearConfirm', from, to),
    ok: t('logs.clear'),
    danger: true,
    onOk: async () => {
      try {
        const r = await api.clearLogs(from, to);
        toast(t('logs.clearDone', String((r && r.removed) || 0)));
        state.rows = [];
        state.files = [];
        state.page = 1;
        state.total = 0;
        state.pages = 1;
        await refresh(ctx, true);
      } catch (e) {
        toast((e && e.message) || t('logs.clearFail'), 'err');
      }
    },
  });
}
