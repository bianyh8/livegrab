/* LiveGrab · views/logs.js —— 运行日志
   级别 / 任务 / 平台 / 关键字过滤 ＋ SSE 实时追加 ＋ 保留策略说明 ＋ 导出 / 复制 ＋ 按日期清除日志。
   「最近事件」已并入本页（不再有独立最近事件页），这里是完整的运行日志。 */

import { api, normalizeLogLine } from '../api.js';
import { t } from '../i18n.js';
import { esc, formatLogTime, formatBytes, emptyBox, toast, copyText, downloadText, confirmDialog } from '../ui.js';

const MAX_ROWS = 2000;

const state = {
  level: '',
  taskId: '',
  platform: '',
  q: '',
  rows: [],
  files: [],
  newestFirst: true,
  lastTs: 0,
  paused: false,
  pending: false,
  bound: false,
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
    state.rows.push(line);
    if (state.rows.length > MAX_ROWS) state.rows.splice(0, state.rows.length - MAX_ROWS);
    const ts = new Date(line.ts || 0).getTime();
    if (ts > state.lastTs) state.lastTs = ts;
    appendRow(line, ctx);
  });

  if (onRefreshAll) { onRefreshAll(); onRefreshAll = null; }
  onRefreshAll = ctx.on('refresh-all', () => { if (boundRoot) { state.pending = false; refresh(ctx); } });

  ctx.onRefresh(() => refresh(ctx));
  await refresh(ctx, true);
}

export function destroy() {
  if (offLog) { offLog(); offLog = null; }
  if (onRefreshAll) { onRefreshAll(); onRefreshAll = null; }
  state.bound = false;
  boundRoot = null;
}

async function refresh(ctx, initial) {
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
        if (!state.level && state.limits.logLevel && state.limits.logLevel !== 'INFO') state.level = state.limits.logLevel;
      } catch { /* 用默认值 */ }
    }
    if (initial || !state.rows.length || root.querySelector('#lgTable') === null) {
      const r = await api.logs({ level: state.level, taskId: state.taskId, q: state.q || '', limit: MAX_ROWS });
      const items = (r && r.items) || [];
      state.rows = items.slice(-MAX_ROWS);
      state.files = (r && r.files) || [];
      state.lastTs = state.rows.reduce((mx, l) => Math.max(mx, new Date(l.ts || 0).getTime()), 0);
      paint(ctx);
      return;
    }
    /* 轮询兜底：SSE 断线时用增量补齐 */
    const r = await api.logs({ level: state.level, taskId: state.taskId, q: state.q || '', limit: MAX_ROWS });
    const items = (r && r.items) || [];
    state.files = (r && r.files) || [];
    const fresh = items.filter((l) => new Date(l.ts || 0).getTime() > state.lastTs);
    if (fresh.length) {
      state.rows = state.rows.concat(fresh).slice(-MAX_ROWS);
      state.lastTs = fresh.reduce((mx, l) => Math.max(mx, new Date(l.ts || 0).getTime()), state.lastTs);
      paint(ctx);
      scrollBottom();
    } else {
      syncCount();
    }
  } catch (e) {
    if (initial) root.innerHTML = `<div class="card"><div class="empty">${t('logs.loadFailed', esc(e.message || e))}</div></div>`;
  } finally {
    state.pending = false;
  }
}

/* ---------- 过滤 ---------- */

function filtered() {
  const task = state.taskId;
  const plat = state.platform;
  const kw = state.q.trim().toLowerCase();
  const rows = state.rows.filter((l) => {
    if (state.level && String(l.level || '').toUpperCase() !== state.level) return false;
    if (task && l.taskId !== task) return false;
    if (plat && !String(l.msg || '').includes(plat) && !String(l.platform || '').includes(plat)) return false;
    if (kw && !String(l.msg || '').toLowerCase().includes(kw) && !String(l.taskName || '').toLowerCase().includes(kw)) return false;
    return true;
  });
  return state.newestFirst ? rows.slice().reverse() : rows;
}

/* ---------- 渲染 ---------- */

function paint(ctx) {
  const root = boundRoot;
  if (!root) return;
  const tasks = [...new Set(state.rows.map((l) => l.taskName).filter(Boolean))];
  const totalBytes = state.files.reduce((n, f) => n + (Number(f.bytes) || 0), 0);
  const retDays = Number(state.limits.logRetentionDays) || 14;
  const retLevel = esc(state.limits.logLevel || 'INFO');
  let hint = t('logs.hint', retDays, retLevel, MAX_ROWS);
  if (state.files.length) hint += t('logs.filesNote', state.files.length, esc(formatBytes(totalBytes)));

  root.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <select class="select" id="lgLevel" style="width:130px">
          ${[['', t('logs.levelAll')], ['INFO', 'INFO'], ['WARN', 'WARN'], ['ERROR', 'ERROR'], ['DEBUG', 'DEBUG']]
            .map(([v, lbl]) => `<option value="${v}"${state.level === v ? ' selected' : ''}>${lbl}</option>`).join('')}
        </select>
        <select class="select" id="lgTask" style="width:190px">
          <option value="">${t('logs.taskAll')}</option>
          ${tasks.map((tk) => {
            const id = (state.rows.find((l) => l.taskName === tk) || {}).taskId || '';
            return `<option value="${esc(id)}"${state.taskId === id ? ' selected' : ''}>${esc(tk)}</option>`;
          }).join('')}
          ${state.taskId && !tasks.some((tk) => (state.rows.find((l) => l.taskName === tk) || {}).taskId === state.taskId)
            ? `<option value="${esc(state.taskId)}" selected>${t('logs.taskLocked', esc(state.taskId))}</option>` : ''}
        </select>
        <select class="select" id="lgPlat" style="width:140px">
          ${[['', t('common.allPlatforms')], ['抖音', t('plat.douyin')], ['哔哩哔哩', t('plat.bilibili')], ['快手', t('plat.kuaishou')], ['虎牙', t('plat.huya')], ['斗鱼', t('plat.douyu')], ['小红书', t('plat.xiaohongshu')], ['微博', t('plat.weibo')]]
            .map(([v, lbl]) => `<option value="${v}"${state.platform === v ? ' selected' : ''}>${lbl}</option>`).join('')}
        </select>
        <input class="input" id="lgQ" style="width:200px" placeholder="${t('logs.qPlaceholder')}" value="${esc(state.q)}" />
        <button class="btn sm ghost" id="lgOrder" title="${t('logs.toggleOrder')}">${state.newestFirst ? t('logs.newestFirst') : t('logs.newestLast')}</button>
        <div class="spacer"></div>
        <input type="date" class="input" id="lgFrom" style="width:158px" title="${t('logs.clearFrom')}" />
        <input type="date" class="input" id="lgTo" style="width:158px" title="${t('logs.clearTo')}" />
        <button class="btn sm ghost" id="lgClear">${t('logs.clear')}</button>
        <span class="chip ${state.paused ? 'wait' : 'on'}" id="lgLive" style="cursor:pointer"><i class="dot"></i>${state.paused ? t('logs.livePaused') : t('logs.liveStreaming')}</span>
        <button class="btn sm ghost" id="lgCopy">${t('common.copy')}</button>
        <button class="btn sm ghost" id="lgExport">${t('logs.export')}</button>
      </div>
      <div class="hintline" style="margin:0 16px 12px">${hint}</div>
      <div class="card-b" style="padding:0" id="lgTable">${table()}</div>
      <div class="hintline" style="margin:10px 16px 14px" id="lgCount"></div>
    </div>`;

  bind(ctx);
  syncCount();
  scrollBottom();
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
  return `<tr><td class="mono" style="color:var(--txt-3)">${esc(formatLogTime(l.ts))}</td>
    <td><span class="lv ${esc(level)}">${esc(level)}</span></td>
    <td>${esc(l.taskName || '—')}</td>
    <td class="logline">${esc(l.msg || '')}</td></tr>`;
}

function appendRow(line, ctx) {
  const tbody = boundRoot && boundRoot.querySelector('#lgBody');
  if (!tbody) return;
  if (!matches(line)) return;
  const tmp = document.createElement('tbody');
  tmp.innerHTML = row(line);
  const tr = tmp.firstElementChild;
  if (state.newestFirst) tbody.insertBefore(tr, tbody.firstChild);
  else tbody.appendChild(tr);
  while (tbody.children.length > MAX_ROWS) {
    if (state.newestFirst) tbody.removeChild(tbody.lastElementChild);
    else tbody.removeChild(tbody.firstElementChild);
  }
  if (!state.paused) scrollBottom();
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

function scrollBottom() {
  const tb = boundRoot && boundRoot.querySelector('#lgTable');
  if (!tb) return;
  const box = tb.closest('.card') || tb.parentElement;
  if (box && box.scrollHeight) { /* 视口滚动交给浏览器；页面本身不设固定高度 */ }
}

function syncCount() {
  const node = boundRoot && boundRoot.querySelector('#lgCount');
  if (node) node.textContent = t('logs.count', state.rows.length, filtered().length, state.newestFirst ? t('logs.newestFirst') : t('logs.newestLast'), MAX_ROWS);
  const live = boundRoot && boundRoot.querySelector('#lgLive');
  if (live) {
    live.className = 'chip ' + (state.paused ? 'wait' : 'on');
    live.innerHTML = `<i class="dot"></i>${state.paused ? t('logs.livePaused') : t('logs.liveStreaming')}`;
  }
}

/* ---------- 交互 ---------- */

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;

  const rerender = async (patch) => {
    Object.assign(state, patch);
    state.pending = false;
    await refresh(ctx, true);
  };

  const level = root.querySelector('#lgLevel');
  if (level) level.onchange = () => rerender({ level: level.value });
  const task = root.querySelector('#lgTask');
  if (task) task.onchange = () => rerender({ taskId: task.value });
  const plat = root.querySelector('#lgPlat');
  if (plat) plat.onchange = () => rerender({ platform: plat.value });

  const q = root.querySelector('#lgQ');
  if (q) {
    let timer = null;
    q.oninput = () => {
      state.q = q.value;
      clearTimeout(timer);
      timer = setTimeout(() => { const t = root.querySelector('#lgTable'); if (t) t.innerHTML = table(); syncCount(); }, 200);
    };
  }

  const live = root.querySelector('#lgLive');
  if (live) live.onclick = () => { state.paused = !state.paused; syncCount(); toast(state.paused ? t('logs.pauseLiveToast') : t('logs.resumeLiveToast')); };

  const order = root.querySelector('#lgOrder');
  if (order) order.onclick = () => {
    state.newestFirst = !state.newestFirst;
    order.textContent = state.newestFirst ? t('logs.newestFirst') : t('logs.newestLast');
    const t = root.querySelector('#lgTable');
    if (t) t.innerHTML = table();
    syncCount();
  };

  const copy = root.querySelector('#lgCopy');
  if (copy) copy.onclick = () => {
    const text = filtered().map((l) => `[${formatLogTime(l.ts)}] ${String(l.level || 'INFO').toUpperCase()} ${l.taskName || '-'} ${l.msg || ''}`).join('\n');
    copyText(text || t('logs.noLogs'), t('logs.copied'));
  };
  const exp = root.querySelector('#lgExport');
  if (exp) exp.onclick = () => {
    const text = filtered().map((l) => `[${formatLogTime(l.ts)}] ${String(l.level || 'INFO').toUpperCase()} ${l.taskName || '-'} ${l.msg || ''}`).join('\r\n');
    downloadText(`livegrab_logs_${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain;charset=utf-8');
    toast(t('logs.exportedToast'));
  };

  const fFrom = root.querySelector('#lgFrom');
  const fTo = root.querySelector('#lgTo');
  const clear = root.querySelector('#lgClear');
  if (clear) clear.onclick = () => {
    const from = (fFrom && fFrom.value) || '';
    const to = (fTo && fTo.value) || '';
    if (!from && !to) { toast(t('logs.clearNoRange'), 'warn'); return; }
    confirmDialog({
      title: t('logs.clear'),
      text: t('logs.clearConfirm', from || '…', to || '…'),
      ok: t('logs.clear'),
      danger: true,
      onOk: async () => {
        try {
          const r = await api.clearLogs(from, to);
          toast(t('logs.clearDone', String((r && r.removed) || 0)));
          state.rows = [];
          state.files = [];
          await refresh(ctx, true);
        } catch (e) {
          toast((e && e.message) || t('logs.clearFail'), 'err');
        }
      },
    });
  };
}
