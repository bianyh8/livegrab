/* LiveGrab · views/tasks.js —— 录制任务
   工具条（搜索/平台/状态/排序/导出/新建）＋ 批量操作条（D7）＋ 状态相关行内操作
   ＋ 新建/编辑/详情任务弹窗（统一单页网格表单：地址/平台/房间号/主播名 + 清晰度卡片 + 命名/轮询/重连 + 分段与开关）。 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  esc, formatBytes, formatDuration, formatDateTime, platBadge, platIcon, segmentStrategyText,
  qualityLabelOf, emptyBox, toast, confirmDialog, openDialog, downloadText, switchEl, bindSwitches,
} from '../ui.js';

const state = {
  tasks: [],
  platforms: [],
  q: '',
  platform: '',
  status: '',
  liveStatus: '',
  sort: 'created',
  sortDir: 'desc',
  selected: new Set(),
  page: 1,
  pages: 1,
  hash: '',
  pending: false,
  bound: false,
  openNew: false,
  filterOpen: false, // 查询条件默认折叠
};

let boundRoot = null;
let offModal = null;
let boundCtx = null;

/* 分页：默认每页 10 条（任务/文件/回收站统一） */
const PAGE_SIZE = 10;
function pagerHTML(id, page, pages, total) {
  return `<div class="pager" id="${id}">
    <button class="btn sm ghost" data-pg="first"${page <= 1 ? ' disabled' : ''}>«</button>
    <button class="btn sm ghost" data-pg="prev"${page <= 1 ? ' disabled' : ''}>‹ ${t('common.pagerPrev')}</button>
    <span class="pager-info">${t('common.pagerInfo', page, pages, total)}</span>
    <button class="btn sm ghost" data-pg="next"${page >= pages ? ' disabled' : ''}>${t('common.pagerNext')} ›</button>
    <button class="btn sm ghost" data-pg="last"${page >= pages ? ' disabled' : ''}>»</button>
  </div>`;
}
function bindPager(root, pagerId, st, paintFn) {
  const el = root.querySelector('#' + pagerId);
  if (!el) return;
  el.querySelectorAll('[data-pg]').forEach((b) => {
    b.onclick = () => {
      const map = { first: 1, prev: st.page - 1, next: st.page + 1, last: st.pages };
      st.page = Math.max(1, Math.min(st.pages, map[b.dataset.pg]));
      paintFn();
    };
  });
}

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('tasks.loading')}</div></div>`;
  if (!state.bound) {
    state.bound = true;
    offModal = ctx.on('open-task-modal', (id) => { if (id) openTaskDialog(ctx, id); else state.openNew = true; });
  }
  // 全局 2s 轮询只做局部重绘（paintResults），不得重建工具栏/搜索框而抢走输入焦点
  ctx.onRefresh(() => tick(ctx, false));
  await tick(ctx, true);
}

export function destroy() {
  if (offModal) { offModal(); offModal = null; }
  state.bound = false;
  state.openNew = false;
  boundRoot = null;
}

async function tick(ctx, full) {
  if (state.pending) return;
  state.pending = true;
  try {
    if (!state.platforms.length) {
      try {
        const p = await api.platforms();
        state.platforms = (p && p.items) || [];
      } catch { state.platforms = []; }
    }
    const r = await api.tasks({
      page: state.page, pageSize: PAGE_SIZE, sort: state.sort, sortDir: state.sortDir,
      q: state.q, platform: state.platform, status: state.status, liveStatus: state.liveStatus,
    });
    state.tasks = (r && r.items) || [];
    state.total = Number((r && r.total) || state.tasks.length);
    state.pages = Math.max(1, Number((r && r.pages) || 1));
    if (state.openNew) { state.openNew = false; openTaskDialog(ctx, null); }
    // full=true → 全量重绘（初始/筛选/排序/折叠/排序移动等离散操作）；
    // full=false → 仅重绘结果区（搜索防抖/翻页/2s 轮询），不重建工具栏与搜索框，避免焦点丢失。
    if (full) paint(ctx, true); else paintResults(ctx);
  } catch (e) {
    if (full && boundRoot) {
      boundRoot.innerHTML = `<div class="card"><div class="empty">${t('tasks.loadFailed', esc(e.message || e))}</div></div>`;
    }
  } finally {
    state.pending = false;
  }
}

/* ---------- 过滤 / 排序 ----------
   注意：过滤与排序已迁移到后端（/api/tasks 支持 q/platform/liveStatus/status/sort/sortDir 参数），
   前端仅持有当前页数据并直接渲染，不再本地 slice。 */

/* 自定义排序：上移/下移。后端分页后仅持有当前页数据，
   需先拉取全量顺序（不带分页参数），在完整序列上交换相邻项后再整体提交。 */
async function moveTask(id, dir) {
  let all = [];
  try {
    const r = await api.tasks({ sort: 'custom' });
    all = (r && r.items) || [];
  } catch { all = []; }
  const i = all.findIndex((t) => t.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= all.length) return;
  const item = all[i];
  all.splice(i, 1);
  all.splice(j, 0, item);
  state.hash = '';
  try { await api.tasksReorder(all.map((x) => x.id)); }
  catch (e) { toast(e.message || t('tasks.sortSaveFail'), 'err'); }
  tick(boundCtx, true);
}

/* 去掉主播名里的 emoji/符号与变体选择符（例如 ❄️雪衣容 → 雪衣容） */
function stripEmoji(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}\u{FE00}\u{FE0E}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function platName(id) {
  const p = state.platforms.find((x) => x.id === id);
  return (p && p.name) || '';
}

/* ---------- 渲染 ---------- */

/* 记录 root 内当前聚焦元素的 id 与光标位置（重绘后恢复，避免输入被打断）。 */
function captureFocus(root) {
  const a = (typeof document !== 'undefined') && document.activeElement;
  if (!a || !a.id || !root.contains(a)) return null;
  return {
    id: a.id,
    start: typeof a.selectionStart === 'number' ? a.selectionStart : null,
    end: typeof a.selectionEnd === 'number' ? a.selectionEnd : null,
  };
}
function restoreFocus(root, f) {
  if (!f) return;
  const el = root.querySelector('#' + f.id);
  if (!el || typeof el.focus !== 'function') return;
  try {
    el.focus();
    if (f.start != null && typeof el.setSelectionRange === 'function') el.setSelectionRange(f.start, f.end == null ? f.start : f.end);
  } catch { /* ignore */ }
}

/* 结果区指纹：paint 与 paintResults 共用同一套判据，数据/筛选/勾选/翻页无变化时跳过重绘。 */
function listHash() {
  const list = state.tasks;
  return JSON.stringify(list.map((t) => [
    t.id, t.status, t.queueReason, t.retryCount, t.statusMessage, t.qualityLabel,
    t.live && t.live.elapsedSec, t.live && t.live.bytes, t.live && t.live.segmentIndex, t.updatedAt,
  ])) + '|' + state.q + '|' + state.platform + '|' + state.liveStatus + '|' + state.status + '|' + state.sort + '|' + state.sortDir + '|' + Array.from(state.selected).join(',') + '|p' + state.page + '|tot' + state.total;
}

/* 仅重绘结果区（表格 + 分页 + 查询条件摘要），不重建工具栏与搜索框。
   搜索输入防抖、翻页与全局 2s 轮询都走这里：避免重建 #tkQ 导致焦点/光标丢失、
   中文输入法（IME）组合被打断——这正是任务管理「查询不能正常用、刚输入一个字就查询」的根因。 */
function paintResults(ctx) {
  const root = boundRoot;
  if (!root) return;
  if (state.page > state.pages) state.page = state.pages;
  const list = state.tasks;
  const hash = listHash();
  if (hash === state.hash) { syncBatchBar(); return; }
  state.hash = hash;
  const focus = captureFocus(root);
  const tbl = root.querySelector('#tkTable');
  if (tbl) tbl.innerHTML = table(list);
  const pagerEl = root.querySelector('#tkPager');
  if (pagerEl) pagerEl.outerHTML = pagerHTML('tkPager', state.page, state.pages, state.total);
  const sumEl = root.querySelector('#tkFilterToggle .tq-summary');
  if (sumEl) sumEl.innerHTML = filterSummary();
  bindTable(ctx);
  bindPager(root, 'tkPager', state, () => { state.hash = ''; tick(ctx, false); });
  syncBatchBar();
  restoreFocus(root, focus);
}

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  if (state.page > state.pages) state.page = state.pages;
  const list = state.tasks;
  const pageList = list;
  const hash = listHash();
  if (!force && hash === state.hash) { syncBatchBar(); return; }
  state.hash = hash;

  const focus = captureFocus(root);
  root.innerHTML = `
    <div class="card">
      <div class="tq-toggle" id="tkFilterToggle" role="button">
        <span class="tq-title">${t('tasks.filterTitle')}</span>
        <span class="tq-summary">${filterSummary()}</span>
        <span class="tq-arrow">${state.filterOpen ? '▴' : '▾'}</span>
        <div class="spacer"></div>
        <button class="btn sm primary" id="tkNew" style="flex:0 0 auto">${t('tasks.newTask')}</button>
      </div>
      <div class="toolbar tq" id="tkFilterBar" style="${state.filterOpen ? '' : 'display:none'}">
        <input class="input" id="tkQ" style="width:170px" placeholder="${t('tasks.searchPh')}" value="${esc(state.q)}" />
        <select class="select" id="tkPlat" style="width:108px">
          <option value="">${t('common.allPlatforms')}</option>
          ${state.platforms.filter((p) => p.enabled || state.platform === p.id).map((p) => `<option value="${esc(p.id)}"${state.platform === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <select class="select" id="tkLive" style="width:118px">
          ${[['', t('tasks.allLiveStatus')], ['live', t('tasks.live')], ['offline', t('tasks.notLive')]]
            .map(([v, label]) => `<option value="${v}"${state.liveStatus === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="select" id="tkStatus" style="width:128px">
          ${[['', t('tasks.allRecordStatus')], ['recording', t('common.recording')], ['stopping', t('common.stopping')], ['paused', t('common.paused')], ['queued', t('common.queued')], ['waiting', t('common.waiting')], ['completed', t('common.completed')], ['stopped', t('tasks.stopped')], ['error', t('common.error')]]
            .map(([v, label]) => `<option value="${v}"${state.status === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="select" id="tkSort" style="width:138px">
          ${[['custom', t('tasks.sortCustom')], ['created', t('tasks.sortByCreated')], ['duration', t('tasks.sortByDuration')], ['size', t('tasks.sortBySize')], ['status', t('tasks.sortByStatus')]]
            .map(([v, label]) => `<option value="${v}"${state.sort === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="select" id="tkSortDir" style="width:80px" title="${t('tasks.sortDirTip')}">
          ${[['desc', t('tasks.sortDesc')], ['asc', t('tasks.sortAsc')]]
            .map(([v, label]) => `<option value="${v}"${state.sortDir === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="tkExport">${t('logs.export')}</button>
      </div>
      <div class="toolbar" style="border-top:1px dashed var(--line);padding-top:12px">
        <span class="chip ${state.selected.size ? 'on' : ''}" id="tkSelChip"><i class="dot"></i>${t('tasks.selected', state.selected.size)}</span>
        <button class="btn sm ghost" id="tkSelAll">${t('files.selectAll')}</button>
        <span class="chip">${t('tasks.oneTaskTip')}</span>
        <div class="spacer"></div>
        <button class="btn sm" data-batch="refresh" title="${t('tasks.batchRefreshTip')}">${t('tasks.batchRefresh')}</button>
        <button class="btn sm" data-batch="start">${t('tasks.batchStart')}</button>
        <button class="btn sm" data-batch="stop">${t('common.stopRecord')}</button>
        <button class="btn sm danger" data-batch="delete">${t('tasks.batchDelete')}</button>
      </div>
      <div class="hintline" style="margin:0 0 12px 2px">${t('tasks.batchHint')}${state.sort === 'custom' ? t('tasks.customSortHint') : t('tasks.customSortTip')}</div>
      <div id="tkTable">${table(pageList)}</div>
      ${pagerHTML('tkPager', state.page, state.pages, state.total)}
    </div>`;

  bind(ctx);
  restoreFocus(root, focus);
}

/* 拉取符合当前筛选的全量任务（不带分页参数时后端返回全量）：
   用于跨页全选、批量删除统计与 CSV 导出。 */
async function fetchAllTasks() {
  try {
    const r = await api.tasks({
      sort: state.sort, sortDir: state.sortDir,
      q: state.q, platform: state.platform, status: state.status, liveStatus: state.liveStatus,
    });
    return (r && r.items) || [];
  } catch { return []; }
}
async function fetchAllIds() {
  const all = await fetchAllTasks();
  return all.map((t) => t.id);
}

/* 查询条件摘要（折叠头显示当前生效条件，无条件时显示"全部"） */function filterSummary() {
  const parts = [];
  if (String(state.q || '').trim()) parts.push(t('tasks.searchPh') + '：' + String(state.q).trim());
  if (state.platform) { const p = state.platforms.find((x) => x.id === state.platform); if (p) parts.push(p.name); }
  if (state.liveStatus === 'live') parts.push(t('tasks.live'));
  else if (state.liveStatus === 'offline') parts.push(t('tasks.notLive'));
  else if (state.liveStatus === 'unknown') parts.push(t('common.unknown'));
  if (state.status) {
    const m = { recording: t('common.recording'), stopped: t('tasks.stopped'), queued: t('common.queued'), waiting: t('common.waiting'), completed: t('common.completed'), error: t('common.error'), idle: t('common.idle') };
    if (m[state.status]) parts.push(m[state.status]);
  }
  if (state.sort !== 'created' || state.sortDir !== 'desc') {
    const s = { custom: t('tasks.sortCustom'), created: t('tasks.sortByCreated'), duration: t('tasks.sortByDuration'), size: t('tasks.sortBySize'), status: t('tasks.sortByStatus') };
    parts.push((s[state.sort] || state.sort) + (state.sortDir === 'asc' ? ' ↑' : ' ↓'));
  }
  return parts.length ? parts.join(' · ') : t('logs.taskAll');
}

function table(list) {
  if (!list.length) {
    return emptyBox(state.tasks.length ? t('tasks.noFiltered') : t('tasks.noTasks'));
  }
  return `<table class="tk-tbl">
    <thead><tr>
      <th style="width:34px"><input type="checkbox" class="cb" id="tkAll"${list.every((t) => state.selected.has(t.id)) ? ' checked' : ''} /></th>
      <th>${t('tasks.colTask')}</th><th style="width:60px">${t('settings.pfColPlatform')}</th><th>${t('tasks.colLive')}</th><th>${t('tasks.colRecord')}</th><th>${t('tasks.colQuality')}</th>${state.sort === 'custom' ? '<th style="width:46px">' + t('tasks.colSort') + '</th>' : ''}<th style="text-align:right">${t('tasks.colOps')}</th>
    </tr></thead>
    <tbody>${list.map(row).join('')}</tbody>
  </table>`;
}

function row(item) {
  const name = state.platforms.find((p) => p.id === item.platform);
  const checked = state.selected.has(item.id) ? ' checked' : '';
  const isLive = item.liveStatus === 'live' || item.status === 'recording';
  // 头像规则：正在录制/收尾中 → 录像首帧（实时画面，/api/tasks/:id/thumb）；
  // 未开始录制（含已有历史录制但当前没在录）→ 主播平台头像
  const recording = item.status === 'recording' || item.status === 'stopping';
  const avatarImg = recording
    ? `<img class="tk-thumb" loading="lazy" src="/api/tasks/${esc(item.id)}/thumb" alt="" onerror="this.style.display='none'" />`
    : (item.avatar ? `<img class="tk-thumb" loading="lazy" src="/api/tasks/${esc(item.id)}/avatar" alt="" onerror="this.style.display='none'" />` : '');
  return `<tr data-id="${esc(item.id)}">
    <td><input type="checkbox" class="cb" data-pick="${esc(item.id)}"${checked} /></td>
    <td>
      <div class="tk-cell">
        <div class="tk-avatar">
          <span class="tk-ph">${esc((item.anchorName || item.name || '?').slice(0, 1))}</span>
          ${avatarImg}
          ${isLive ? '<span class="tk-live"><i></i>' + t('tasks.live') + '</span>' : ''}
        </div>
        <div class="tk-bio">
          <div style="font-weight:600">${esc(item.anchorName || item.name || t('common.unnamed'))}</div>
          <div class="sub">${esc(item.title || t('tasks.noTitle'))}</div>
        </div>
      </div>
    </td>
    <td data-label="${t('settings.pfColPlatform')}">${platIcon(item.platform, (name && name.name) || platName(item.platform) || item.platformName)}</td>
    <td data-label="${t('tasks.colLive')}">${liveStatusCell(item)}</td>
    <td data-label="${t('tasks.colRecord')}">${recStatusCell(item)}</td>
    <td data-label="${t('tasks.colQuality')}"><span class="chip">${esc(qualityLabelOf(item))}</span></td>
    ${state.sort === 'custom' ? `<td data-label="${t('tasks.colSort')}">
      <div class="mvrow">
        <span class="rnk">${esc(String((state.page - 1) * PAGE_SIZE + state.tasks.indexOf(item) + 1))}</span>
        <button class="mvbtn" data-mv="up" data-id="${esc(item.id)}" title="${t('tasks.moveUp')}">↑</button>
        <button class="mvbtn" data-mv="down" data-id="${esc(item.id)}" title="${t('tasks.moveDown')}">↓</button>
      </div>
    </td>` : ''}
    <td><div class="acts">${rowActions(item).join('')}</div></td>
  </tr>`;
}

/* 状态拆为两列：直播状态（看播） + 录制状态（任务自身的录制工作流） */
function liveStatusCell(item) {
  const live = item.liveStatus === 'live' || item.status === 'recording';
  return live
    ? '<span class="chip on"><i class="dot"></i>' + t('tasks.live') + '</span>'
    : '<span class="chip off"><i class="dot"></i>' + t('tasks.notLive') + '</span>';
}

function recStatusCell(item) {
  const recording = ['recording', 'stopping'].includes(item.status);
  if (recording) return '<span class="pulse"><b></b>' + t('common.recording') + '</span>';
  if (item.sessionHold) return '<span class="chip bili" title="' + t('tasks.sessionHeldTip') + '"><i class="dot"></i>' + t('tasks.sessionHeld') + '</span>';
  if (item.monitorOnly) return '<span class="chip bili" title="' + t('tasks.monitorOnlyTip') + '"><i class="dot"></i>' + t('common.monitorOnly') + '</span>';
  if (item.manualHeld || item.status === 'stopped') return '<span class="chip off" title="' + t('tasks.stoppedTip') + '"><i class="dot"></i>' + t('tasks.stopped') + '</span>';
  if (item.status === 'error') return '<span class="chip err"><i class="dot"></i>' + t('tasks.abnormal') + '</span>';
  return '<span class="chip"><i class="dot"></i>' + t('tasks.notRecorded') + '</span>';
}

/** 是否正在录制（含收尾/合并中，此刻都该给「停止本场」而不是「录制本场」） */
function isRecording(item) {
  return ['recording', 'stopping'].includes(item.status);
}

/**
 * 「本场」按钮（只录/只停这一次，不改任何配置）的显示状态：
 * - 任何任务都适用：正在录制 → 「停止本场」；直播中且未录制 → 「录制本场」。
 *   自动录制任务点「停止本场」= 本场挂起（sessionHold）：本场不再被轮询自动拉起，下播自动解除，
 *   下次开播照旧按系统配置自动录制；点「录制本场」只录本场、不改 autoRecord。
 * 返回 'stop-once' | 'record-once' | null（未直播且未录制时不给本场按钮）。
 */
export function sessionAction(item) {
  if (isRecording(item)) return 'stop-once';
  return item.liveStatus === 'live' ? 'record-once' : null;
}

function rowActions(item) {
  const id = esc(item.id);
  const acts = [];
  const recording = isRecording(item);
  const session = sessionAction(item);      // 「本场」按钮：由录制状态决定，仅对不会自动续录的任务显示
  const permanentTip = item.autoRecord === false; // 「开始/停止录制」是否带「永久」说明（沿用原逻辑）
  if (recording) {
    // 正在录制：本场（停本次）＋ 永久停止录制；「停止录制」逻辑不变
    if (session === 'stop-once') {
      acts.push(`<button class="btn sm danger" data-act="stop-once" data-id="${id}" title="${t('tasks.stopOnceTip')}">${t('tasks.stopOnce')}</button>`);
    }
    acts.push(permanentTip
      ? `<button class="btn sm danger" data-act="stop" data-id="${id}" title="${t('tasks.stopPermanentTip')}">${t('common.stopRecord')}</button>`
      : `<button class="btn sm danger" data-act="stop" data-id="${id}">${t('common.stopRecord')}</button>`);
  } else if (item.liveStatus === 'live') {
    // 直播中未录制：本场（只录本次）＋ 开始录制；「开始录制」逻辑不变
    if (session === 'record-once') {
      acts.push(`<button class="btn sm ok" data-act="record-once" data-id="${id}" title="${t('tasks.recordOnceTip')}">${t('tasks.recordOnce')}</button>`);
    }
    acts.push(permanentTip
      ? `<button class="btn sm ok" data-act="start" data-id="${id}" title="${t('tasks.startPermanentTip')}">${t('tasks.batchStart')}</button>`
      : `<button class="btn sm ok" data-act="start" data-id="${id}"${item.monitorOnly ? ' title="' + t('tasks.monitorOnlyStartTip') + '"' : ''}>${t('tasks.batchStart')}</button>`);
  } else {
    acts.push(`<button class="btn sm" data-act="check" data-id="${id}" title="${t('common.checkLiveTip')}">${t('common.checkLive')}</button>`);
  }
  acts.push(`<button class="btn sm ghost" data-act="detail" data-id="${id}">${t('common.detail')}</button>`);
  return acts;
}

/* ---------- 交互 ---------- */

/* 绑定表格内元素（自定义排序移动 / 全选 / 行勾选 / 行内操作）。
   全量 paint 与局部 paintResults 都会重建 #tkTable，行内按钮需重新绑定，故单独抽出；
   工具栏、批量条不在 #tkTable 内，保持原绑定，不在此重复绑。 */
function bindTable(ctx) {
  const root = boundRoot;
  if (!root) return;

  root.querySelectorAll('[data-mv]').forEach((btn) => {
    btn.onclick = () => moveTask(btn.dataset.id, btn.dataset.mv === 'up' ? -1 : 1);
  });

  const all = root.querySelector('#tkAll');
  if (all) all.onchange = () => {
    // 后端分页后「全选」应选中符合当前筛选的全部任务（跨页），需拉全量 id
    void (async () => {
      const ids = await fetchAllIds();
      ids.forEach((id) => { all.checked ? state.selected.add(id) : state.selected.delete(id); });
      state.hash = '';
      paint(ctx, true);
    })();
  };

  root.querySelectorAll('[data-pick]').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.pick;
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      syncBatchBar();
    };
  });

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const task = state.tasks.find((t) => t.id === id);
      if (act === 'detail') { openTaskDialog(ctx, id); return; }
      if (act === 'log') {
        toast(t('tasks.redirectedLogs'));
        window.location.hash = '#/logs?task=' + encodeURIComponent(id);
        return;
      }
      if (act === 'priority') { toast(t('tasks.priorityToast', (task && task.queueReason) || t('common.waitSlot'))); return; }
      if (act === 'delete') { removeTask(task, ctx); return; }
      btn.disabled = true;
      try {
        await api.taskAction(id, act);
        const msg = {
          start: t('tasks.startDone'),
          pause: t('tasks.pauseDone'),
          stop: t('tasks.stopDone'),
          resume: t('tasks.resumeDone'),
          check: t('tasks.checkDone'),
          retry: t('tasks.retryDone'),
          'record-once': t('tasks.recordOnceDone'),
          'stop-once': t('tasks.stopOnceDone'),
        }[act] || t('tasks.actionDone');
        toast(msg);
        state.hash = '';
        ctx.invalidate('dashboard');
      } catch (e) {
        toast(e.message || t('tasks.actionFail'), 'err');
      } finally {
        btn.disabled = false;
      }
    };
  });
}

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;
  boundCtx = ctx;

  const q = root.querySelector('#tkQ');
  if (q) {
    let timer = null;
    q.oninput = () => {
      state.q = q.value;
      clearTimeout(timer);
      // 只走局部重绘（paintResults），绝不重建搜索框；300ms 防抖给足连续输入/中文组词时间
      timer = setTimeout(() => { state.page = 1; tick(ctx, false); }, 300);
    };
  }
  const fToggle = root.querySelector('#tkFilterToggle');
  if (fToggle) fToggle.onclick = () => { state.filterOpen = !state.filterOpen; state.hash = ''; paint(ctx, true); };
  const bindSel = (id, key) => {
    const node = root.querySelector(id);
    if (!node) return;
    node.onchange = () => { state[key] = node.value; state.page = 1; state.hash = ''; tick(ctx, true); };
  };
  bindSel('#tkPlat', 'platform');
  bindSel('#tkLive', 'liveStatus');
  bindSel('#tkStatus', 'status');
  bindSel('#tkSort', 'sort');
  bindSel('#tkSortDir', 'sortDir');

  root.querySelector('#tkNew').onclick = (e) => {
    if (e) e.stopPropagation(); // 按钮位于查询条件折叠头内，避免冒泡触发折叠切换
    openTaskDialog(ctx, null);
  };
  root.querySelector('#tkExport').onclick = () => { void exportCsv(); };

  const selAll = root.querySelector('#tkSelAll');
  if (selAll) selAll.onclick = () => {
    void (async () => {
      const ids = await fetchAllIds();
      const allSel = ids.length > 0 && ids.every((id) => state.selected.has(id));
      ids.forEach((id) => { allSel ? state.selected.delete(id) : state.selected.add(id); });
      state.hash = '';
      paint(ctx, true);
    })();
  };

  root.querySelectorAll('[data-batch]').forEach((btn) => {
    btn.onclick = () => batch(ctx, btn.dataset.batch);
  });
  // 翻页需重新向后端请求对应页数据；走局部重绘，避免重建工具栏/搜索框
  bindPager(root, 'tkPager', state, () => { state.hash = ''; tick(ctx, false); });

  bindTable(ctx);
  syncBatchBar();
}

function syncBatchBar() {
  const chip = boundRoot && boundRoot.querySelector('#tkSelChip');
  if (chip) {
    chip.className = 'chip' + (state.selected.size ? ' on' : '');
    chip.innerHTML = `<i class="dot"></i>${t('tasks.selected', state.selected.size)}`;
  }
}

async function batch(ctx, action) {
  const ids = Array.from(state.selected);
  if (!ids.length) { toast(t('tasks.selectFirst'), 'warn'); return; }
  if (ids.length > 50) { toast(t('tasks.batchLimit'), 'warn'); return; }

  if (action === 'delete') {
    // 选中可能跨页，统计需基于全量数据而非当前页
    const all = await fetchAllTasks();
    const picked = all.filter((t) => ids.includes(t.id));
    const withFiles = picked.filter((t) => t.sessionId).length;
    const files = picked.reduce((n, t) => n + ((t.segments && t.segments.length) || (t.live && t.live.segmentIndex) || 1), 0);
    const bytes = picked.reduce((n, t) => n + (Number(t.totalBytes) || Number(t.live && t.live.bytes) || 0), 0);
    confirmDialog({
      title: t('tasks.batchDeleteTitle'),
      danger: true,
      ok: t('common.delete'),
      text: t('tasks.deleteBatchBody1', ids.length) + (withFiles ? t('tasks.deleteBatchBound', withFiles) : '') + t('tasks.deleteBatchBody2') + t('tasks.deleteBatchSize', files, formatBytes(bytes)),
      onOk: async () => {
        try {
          const r = await api.batch('delete', ids);
          const failed = (r && r.failed) || [];
          if (failed.length) toast(t('tasks.deleteBatchPartial', ids.length - failed.length, failed.length, failed[0].message || ''), 'warn');
          else toast(t('tasks.deleteBatchOk', ids.length));
          state.selected.clear();
          state.hash = '';
          ctx.invalidate('dashboard');
        } catch (e) { toast(e.message || t('tasks.batchDeleteFail'), 'err'); }
      },
    });
    return;
  }

  try {
    const r = await api.batch(action, ids);
    const ok = (r && r.okIds) || [];
    const failed = (r && r.failed) || [];
    const verb = { start: t('tasks.batchStart'), stop: t('tasks.stop'), check: t('tasks.verbCheck'), refresh: t('common.refresh') }[action] || t('tasks.verbProcess');
    let msg = t('tasks.batchDone', verb, ok.length);
    if (failed.length) msg += t('tasks.batchFailed', failed.length, failed[0].message || t('tasks.failReasonUnknown'));
    if (r && r.note) msg += ' · ' + r.note;
    toast(msg);
    ctx.invalidate('dashboard');
  } catch (e) {
    toast(e.message || t('tasks.batchFail'), 'err');
  }
}

function removeTask(task, ctx) {
  if (!task) return;
  const files = (task.segments && task.segments.length) || 1;
  const bytes = Number(task.totalBytes) || Number(task.live && task.live.bytes) || 0;
  confirmDialog({
    title: t('tasks.deleteTitle'),
    danger: true,
    ok: t('common.delete'),
    text: t('tasks.deleteBody1', esc(task.anchorName || task.name || task.id)) + t('tasks.deleteBody2') + t('tasks.deleteSize', files, formatBytes(bytes)),
    onOk: async () => {
      try {
        await api.deleteTask(task.id);
        toast(t('tasks.deletedOk'));
        state.selected.delete(task.id);
        state.hash = '';
        ctx.invalidate('dashboard');
      } catch (e) {
        if (e.code === 'RECORDING_LOCKED' || e.status === 409) {
          confirmDialog({
            title: t('tasks.recordingTitle'),
            danger: true,
            ok: t('tasks.stopAndDelete'),
            text: t('tasks.recordingDeleteText'),
            onOk: async () => {
              try { await api.deleteTask(task.id, true); toast(t('tasks.stoppedAndDeleted')); state.hash = ''; }
              catch (e2) { toast(e2.message || t('files.deleteFailed'), 'err'); }
            },
          });
        } else toast(e.message || t('files.deleteFailed'), 'err');
      }
    },
  });
}

async function exportCsv() {
  // 后端分页后导出需拉取符合当前筛选的全量数据
  const list = await fetchAllTasks();
  if (!list.length) { toast(t('tasks.noExport'), 'warn'); return; }
  const head = [t('tasks.csvId'), t('tasks.csvAnchor'), t('tasks.csvTitle'), t('settings.pfColPlatform'), t('tasks.csvRoom'), t('tasks.colQuality'), t('tasks.csvSegment'), t('tasks.csvStatus'), t('tasks.csvDuration'), t('tasks.csvSize'), t('tasks.csvCreated')];
  const rows = list.map((t) => [
    t.id, t.anchorName || t.name || '', t.title || '', platName(t.platform) || t.platform || '', roomLabel(t),
    qualityLabelOf(t), segmentStrategyText(t), (t.status || ''),
    formatDuration(Number(t.totalDurationSec) || Number(t.live && t.live.elapsedSec) || 0),
    formatBytes(Number(t.totalBytes) || Number(t.live && t.live.bytes) || 0),
    formatDateTime(t.createdAt),
  ]);
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadText(`livegrab_tasks_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  toast(t('tasks.exportedOk'));
}

/* ---------- 详情 ---------- */

/* ================= 统一任务弹窗：新建 / 详情 / 编辑共用同一模板，每行一个栏位，详情即编辑 ================= */

/**
 * 网格栏位：标签在控件上方（参照弹窗设计稿），控件占满所在列。
 * span=true 时横跨整行（直播地址 / 清晰度）。
 */
function field(label, ctl, sub = '', span = false) {
  return `<div${span ? ' style="grid-column:1/-1"' : ''}>
    ${label ? `<div style="font-size:12px;color:var(--txt-2);margin-bottom:6px">${label}</div>` : ''}
    ${ctl}
    ${sub}
  </div>`;
}

function optList(options, value) {
  return options.map((o) => {
    const v = typeof o === 'object' ? o.v : o;
    const label = typeof o === 'object' ? o.label : String(o);
    const extra = (typeof o === 'object' && o.extra) || '';
    return `<option value="${esc(String(v))}"${extra}${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

async function openTaskDialog(ctx, id) {
  let task = null;
  if (id) {
    try { task = await api.task(id); } catch (e) { toast(e.message || t('tasks.readTaskFail'), 'err'); return; }
  }
  const [n, s] = await Promise.allSettled([api.naming(), api.settings()]);
  const naming = n.status === 'fulfilled' ? n.value : null;
  const settings = s.status === 'fulfilled' ? s.value : null;

  const profiles = (naming && naming.profiles) || [];
  const effectiveQuality = (task && task.overrides && task.overrides.quality) || '';
  const effectiveSeg = (task && task.overrides && task.overrides.segmentMode) || '';
  const effectiveNaming = (task && task.overrides && task.overrides.namingProfileId) || '';
  // 命名"全局默认" = 当前激活的命名配置（activeId），与后端 pickProfile 兜底一致
  const namingActive = (naming && naming.activeId) || (profiles.find((p) => p.binding && p.binding.type === 'none') || {}).id || (profiles[0] || {}).id || '';
  const segGlobal = (settings && settings.defaultSegmentMode) || 'time';
  const reconnectGlobal = Number(settings && settings.reconnectMax) || 5;
  const d = {
    id: id || null,
    task: task || null,
    url: task ? (task.sourceUrl || '') : '',
    platform: task ? task.platform : '',
    roomId: task ? String(task.roomId || '') : '',
    shortId: task ? String(task.shortId || '') : '',
    // 房间号输入框显示值：抖音显示短号（抖音号），其余平台显示房间号；解析后回填短号
    displayRoom: task ? ((task.platform === 'douyin' && task.shortId) ? String(task.shortId) : String(task.roomId || '')) : '',
    anchorName: task ? (task.anchorName || '') : '',
    anchorEdited: false,
    resolved: task ? {
      anchorName: task.anchorName, title: task.title,
      platform: task.platform, roomId: task.roomId, shortId: task.shortId,
      liveStatus: task.liveStatus === 'offline' ? 'offline' : 'live',
      online: null, qualityOptions: [],
    } : null,
    avatarDirty: false, // 仅当本弹窗内重新解析过才保存头像（避免每次编辑都重复下载）
    // 清晰度：不再有"跟随全局"选项，直接落到全局默认值（无任务级覆盖时默认显示全局值）
    quality: effectiveQuality || ((settings && (settings.defaultQuality || settings.quality)) || 'origin'),
    qualityGlobal: (settings && (settings.defaultQuality || settings.quality)) || 'origin',
    // 分段：不再有"跟随全局"，直接落到全局默认
    segmentMode: effectiveSeg || segGlobal,
    segmentGlobal: segGlobal,
    segmentMinutes: task ? (task.segmentMinutes || 3600) : ((settings && settings.defaultSegmentMinutes) || 3600),
    segmentSizeMB: task ? (task.segmentSizeMB || 2048) : ((settings && settings.defaultSegmentSizeMB) || 2048),
    autoMerge: false, // 已删除「分段文件处理」选项，固定保留独立分段
    // 命名：不再有"跟随全局"，直接落到当前激活的命名配置
    namingProfileId: effectiveNaming || namingActive,
    namingGlobal: namingActive,
    profiles,
    // 轮询 / 重连（重连不再有"跟随全局"，默认带全局值）
    pollIntervalSec: Number(task ? (task.pollIntervalSec || 60) : ((settings && settings.pollIntervalSec) || 60)),
    pollGlobal: Number((settings && settings.pollIntervalSec) || 60), // 全局「全局轮询检测」值，用于判断是否跟随全局
    reconnectMax: Number(task && task.reconnectMax != null ? task.reconnectMax : reconnectGlobal),
    reconnectGlobal,
    startDelaySec: Number(task ? (task.startDelaySec || 5) : ((settings && settings.startDelaySec) || 5)),
    stopDelaySec: Number(task ? (task.stopDelaySec || 30) : ((settings && settings.stopDelaySec) || 30)),
    // 开关
    autoRecord: task ? task.autoRecord !== false : true,
    monitorOnly: task ? !!task.monitorOnly : !!((settings && settings.defaultMonitorOnly)),
    recording: !!(task && (task.status === 'recording' || task.status === 'stopping')),
    // 平台列表（编辑已有任务时保留其平台；列表未加载时兜底当前平台）
    platforms: state.platforms.filter((p) => p.enabled || (task && task.platform === p.id))
      .concat(task && !state.platforms.some((p) => p.id === task.platform) ? [{ id: task.platform, name: task.platformName || task.platform, tier: '' }] : []),
  };

  const dialog = openDialog({
    title: d.id ? `${t('tasks.detailTitle')} · ${d.id}` : t('tasks.newTaskTitle'),
    width: 'min(620px, 94vw)',
    body: taskShell(d),
    footer: (close, body) => {
      const buttons = [];
      const b1 = document.createElement('button');
      b1.className = 'btn ghost';
      b1.textContent = d.id ? t('common.close') : t('common.cancel');
      b1.onclick = close;
      buttons.push(b1);
      // 解析按钮：放在「取消/关闭」与「创建/保存修改」之间
      const br = document.createElement('button');
      br.className = 'btn';
      br.id = 'edResolve';
      br.textContent = t('tasks.resolve');
      br.onclick = () => { if (d.onResolve) d.onResolve(); };
      buttons.push(br);
      if (d.id && d.task) {
        if (d.task.status === 'recording') {
          const bp = document.createElement('button');
          bp.className = 'btn';
          bp.textContent = t('tasks.pauseSegment');
          bp.onclick = async () => { try { await api.taskAction(d.id, 'pause'); toast(t('tasks.pauseSegmentDone')); close(); } catch (e) { toast(e.message, 'err'); } };
          const bs = document.createElement('button');
          bs.className = 'btn danger';
          bs.textContent = t('tasks.stop');
          bs.onclick = async () => { try { await api.taskAction(d.id, 'stop'); toast(t('tasks.stopDone')); close(); } catch (e) { toast(e.message, 'err'); } };
          buttons.push(bp, bs);
        } else if (d.task.status === 'error') {
          const br = document.createElement('button');
          br.className = 'btn ok';
          br.textContent = t('tasks.retry');
          br.onclick = async () => { try { await api.taskAction(d.id, 'retry'); toast(t('tasks.retryDone')); close(); } catch (e) { toast(e.message, 'err'); } };
          buttons.push(br);
        }
        const bs2 = document.createElement('button');
        bs2.className = 'btn primary';
        bs2.textContent = t('tasks.saveChanges');
        bs2.onclick = () => submit(d, dialog, bs2, ctx);
        buttons.push(bs2);
      } else {
        const bs = document.createElement('button');
        bs.className = 'btn primary';
        bs.textContent = t('tasks.createTask');
        bs.onclick = () => submit(d, dialog, bs, ctx);
        buttons.push(bs);
      }
      return buttons;
    },
  });

  bindEditor(d, dialog.body, ctx);
}

function taskShell(d) {
  // 新建任务时平台下拉显示提示"指定平台"（hidden 空选项：下拉列表里不出现该项；ph 类灰字提示，效果同文本框 placeholder。不用 disabled，避免触发浏览器禁用渲染导致文字永久置灰）
  const platOpts = [{ v: '', label: t('tasks.platChoose'), extra: 'hidden' }, ...d.platforms.map((p) => ({ v: p.id, label: p.name }))];
  const pollOpts = [...new Set([30, 60, 120, 180, 300, Number(d.pollIntervalSec) || 60])].map((v) => ({ v: String(v), label: `${v} ${t('common.seconds')}` }));
  const rcNums = [3, 5, 8, 10];
  if (!rcNums.includes(Number(d.reconnectMax))) rcNums.push(Number(d.reconnectMax));
  if (!rcNums.includes(Number(d.reconnectGlobal))) rcNums.push(Number(d.reconnectGlobal));
  const rcOpts = rcNums.map((o) => ({ v: String(o), label: `${o} ${t('settings.recReconnUnit')}` }));
  const namingOpts = d.profiles.length ? d.profiles.map((p) => ({ v: p.id, label: p.name || p.id })) : [];
  const segOpts = [
    { v: 'none', label: t('seg.none') },
    { v: 'time', label: t('tasks.segByTimeCard') },
    { v: 'size', label: t('settings.recSegBySize') },
  ];
  const segTimeStyle = d.segmentMode === 'time' ? '' : 'display:none';
  const segSizeStyle = d.segmentMode === 'size' ? '' : 'display:none';
  const roomPh = d.platform === 'douyin' ? t('tasks.douyinRoomPh') : t('tasks.roomPh');
  const segSizeRaw = [...new Set([1024, 2048, 4096, 8192, Number(d.segmentSizeMB) || 2048])].map((m) => ({ v: String(m), label: `${Math.round(m / 1024 * 10) / 10} ${t('tasks.gb')}` }));
  // 下拉框默认 width:100% 占满所在列；cls 可附加样式类（如平台未选的灰字提示 ph）
  const selF = (id, opts, val, cls = '') => `<select class="select${cls}" id="${id}">${optList(opts, val)}</select>`;
  // 三列等宽网格（平台/房间号/主播名称 与 命名/轮询/重连 两行列对齐）＋ 两列网格（分段策略、开关）
  return `
  <div class="tk-grid3" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px">
    ${field(t('tasks.kSource'),
      `<input class="input mono" id="edUrl" value="${esc(d.url)}" placeholder="${t('tasks.pasteUrlPh')}" />`,
      `<div class="hintline">${t('tasks.urlEditTip')}</div>`, true)}
    ${field(t('settings.pfColPlatform'), selF('edPlat', platOpts, d.platform, d.platform ? '' : ' ph'))}
    ${field(t('tasks.csvRoom'),
      `<input class="input mono" id="edRoom" value="${esc(d.displayRoom)}" placeholder="${roomPh}" />`)}
    ${field(t('tasks.anchorNameLabel'),
      `<input class="input" id="edAnchor" value="${esc(d.anchorName)}" placeholder="${t('tasks.anchorPh')}" />`)}
    ${field(t('tasks.colQuality'),
      `<div class="mini-row" id="edQGrid" style="justify-content:flex-start">
        ${QUALITY_CARDS.map((q) => `<span class="mini${d.quality === q.id ? ' sel' : ''}" data-q="${q.id}" title="${esc(t(q.resKey))} · ${esc(t(q.kbpsKey))}">${q.crown ? '★ ' : ''}${t(q.labelKey)}</span>`).join('')}
      </div>`,
      `<div class="hintline" id="edQualityHint">${qualityHint(d)}</div>`, true)}
    ${field(t('settings.tabNaming'), selF('edNaming', namingOpts, d.namingProfileId),
      `<div class="hintline" id="edNamingHint">${namingHint(d)}</div>`)}
    ${field(t('tasks.kPoll'), selF('edPoll', pollOpts, String(d.pollIntervalSec)))}
    ${field(t('tasks.kReconnect'), selF('edReconnect', rcOpts, String(d.reconnectMax)))}
  </div>
  <div class="tk-grid2" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px;margin-top:14px">
    ${field(t('tasks.csvSegment'), selF('edSegMode', segOpts, d.segmentMode))}
    <div id="edSegParamCol">
      <div id="edSegMinCell" style="${segTimeStyle}">${field(t('tasks.segMinutesLabel'),
        `<input class="input" id="edSegMin" type="number" min="1" step="1" value="${Number(d.segmentMinutes) || 3600}" />`,
        `<div class="hintline">${t('settings.recSegMinHint')}</div>`)}</div>
      <div id="edSegSizeCell" style="${segSizeStyle}">${field(t('tasks.segSizeLabel'), selF('edSegSize', segSizeRaw, String(d.segmentSizeMB)))}</div>
    </div>
    ${field(t('tasks.autoRecordLabel'), switchEl(d.autoRecord, 'id="edAuto"'))}
    ${field(t('tasks.monitorOnlyLabel'), switchEl(d.monitorOnly, 'id="edMonitor"'),
      `<div class="hintline" id="edMonitorHint">${d.monitorOnly ? t('tasks.monitorOn') : t('tasks.monitorOff')}</div>`)}
  </div>
  ${d.id ? `<div class="sect"><span class="n">≡</span>${t('tasks.segHeader', (d.task && (d.task.segments || []).length) || 0)}</div>
    ${segTableHtml(d.task)}` : ''}
  <div id="edResolved"></div>`;
}

function qualityHint(d) {
  if (d.recording) return t('tasks.qualityFallback') + t('tasks.currentSessionNote');
  return `${t('tasks.currentSel')}<b style="color:var(--txt)">${esc(t(QNAME[d.quality]) || d.quality || 'origin')}</b>${t('tasks.qualityHint')}`;
}

function namingHint(d) {
  const p = d.profiles.find((x) => x.id === d.namingProfileId) || d.profiles[0];
  if (!p) return '';
  return t('tasks.namingExample') + esc((p.dirTemplate || '{平台}/{主播}/{日期}') + '-' + (p.fnTemplate || '{日期}_{主播}_{序号}'));
}

/* 分段结束原因 → 徽标文案（timeout=按设定时长自然轮转，不显示） */
const SEG_END_TEXT = { reconnect: '断流重连', stopped: '提前收尾', offline: '主播下播', user: '手动停止' };

function segTableHtml(task) {
  if (!task) return '';
  const segs = task.segments || [];
  if (!segs.length) return `<div class="note">${t('tasks.noSegs')}</div>`;
  return `<table>
    <thead><tr><th style="width:70px">${t('tasks.segIndex')}</th><th>${t('tasks.segName')}</th><th>${t('tasks.segDuration')}</th><th>${t('tasks.segSize')}</th><th>${t('tasks.csvStatus')}</th></tr></thead>
    <tbody>${segs.map((s) => `<tr>
      <td class="mono" data-label="${t('tasks.segIndex')}">${String(s.segmentIndex || 0).padStart(3, '0')}</td>
      <td class="mono" style="font-size:12px;word-break:break-all" data-label="${t('tasks.segName')}">${esc(s.name || s.path || '—')}</td>
      <td data-label="${t('tasks.segDuration')}">${esc(formatDuration(s.durationSec || 0))}</td>
      <td data-label="${t('tasks.segSize')}">${esc(formatBytes(s.bytes || 0))}</td>
      <td data-label="${t('tasks.csvStatus')}">${s.status === 'recording' ? '<span class="chip wait"><i class="dot"></i>' + t('common.recording') + '</span>' : esc(s.status || 'done')}${s.endReason && s.endReason !== 'timeout' ? `<span class="chip warn" style="margin-left:6px" title="${esc(t('tasks.segEarlyTip'))}">${esc(SEG_END_TEXT[s.endReason] || t('tasks.segEarlyEnd'))}</span>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

/* ---------- 新建 / 编辑绑定与提交 ---------- */

const QUALITY_CARDS = [
  { id: 'origin', labelKey: 'tasks.qOrigin', resKey: 'tasks.qOriginRes', kbpsKey: 'tasks.qOriginKbps', crown: true },
  { id: 'bluray', labelKey: 'tasks.qBluray', resKey: 'tasks.qBlurayRes', kbpsKey: 'tasks.qBlurayKbps' },
  { id: 'uhd', labelKey: 'tasks.qUhd', resKey: 'tasks.qUhdRes', kbpsKey: 'tasks.qUhdKbps' },
  { id: 'hd', labelKey: 'tasks.qHd', resKey: 'tasks.qHdRes', kbpsKey: 'tasks.qHdKbps' },
  { id: 'sd', labelKey: 'tasks.qSd', resKey: 'tasks.qSdRes', kbpsKey: 'tasks.qSdKbps' },
  { id: 'audio', labelKey: 'tasks.qAudio', resKey: 'tasks.qAudioRes', kbpsKey: 'tasks.qAudioKbps' },
];

const QNAME = { origin: 'tasks.qOriginName', bluray: 'tasks.qBlurayName', uhd: 'tasks.qUhdName', hd: 'tasks.qHdName', sd: 'tasks.qSdName', audio: 'tasks.qAudioName' };
/** 前台展示用房间号：抖音显示短号（抖音号），其余平台显示房间号 */
function roomLabel(x) {
  if (!x) return '';
  if (x.platform === 'douyin') return String(x.shortId || '').trim() || String(x.roomId || '');
  return String(x.roomId || '');
}

const TOKENS = ['{日期}', '{主播}', '{平台}', '{房间号}', '{标题}', '{清晰度}', '{序号}', '{时间}', '{任务}', '{分辨率}', '{时长}', '{自定义}'];

const SAMPLE = {
  '{主播}': '某某小主播', '{平台}': '抖音', '{房间号}': '23456789', '{标题}': '今天打排位 冲王者',
  '{日期}': '2025-06-01', '{时间}': '20-13-05', '{清晰度}': '原画', '{序号}': '001', '{任务}': 'task_07',
  '{分辨率}': '1920x1080', '{时长}': '01-00-00', '{自定义}': '自定义',
};

function resolvedCard(d) {
  const r = d.resolved || {};
  const live = r.liveStatus === 'live';
  return `<div class="resolved">
    <div class="avatar">${esc((r.anchorName || '?').slice(0, 1))}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13.5px;font-weight:600">${esc(r.anchorName || t('common.unknownAnchor'))}
        <span class="chip ${platformChipCls(r.platform)}" style="margin-left:6px">${esc(platNameOf(r.platform))}</span>
        ${live ? '<span class="chip on"><i class="dot"></i>' + t('tasks.live') + '</span>'
               : '<span class="chip wait"><i class="dot"></i>' + t('tasks.notLive') + '</span>'}
      </div>
      <div style="font-size:11.5px;color:var(--txt-3);margin-top:3px">
        ${t('tasks.roomNoShort', esc((r.platform === 'douyin' && r.shortId) ? r.shortId : (r.roomId || '—')))}${r.title ? ' · ' + esc(r.title) : ''}${r.online != null ? t('tasks.onlineNow', esc(fmtOnline(r.online))) : ''}${r.note ? ` · ${esc(r.note)}` : ''}
      </div>
    </div>
  </div>`;
}

function platformChipCls(id) { return id === 'douyin' ? 'dy' : id === 'bilibili' ? 'bili' : ''; }
function platNameOf(id) { const p = state.platforms.find((x) => x.id === id); return (p && p.name) || id || t('plat.unknown'); }
function fmtOnline(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1) + ' ' + t('tasks.wan');
  return String(v);
}

function bindEditor(d, body, ctx) {
  // 解析按钮在弹窗底部（取消与保存之间），不在 body 内 → 从整个 modal 里查
  const resolveBtn = (body.closest('.modal') || body).querySelector('#edResolve');
  const urlInput = body.querySelector('#edUrl');
  const roomInput = body.querySelector('#edRoom');
  const anchorInput = body.querySelector('#edAnchor');
  const platSel = body.querySelector('#edPlat');
  const qGrid = body.querySelector('#edQGrid');
  const pollSel = body.querySelector('#edPoll');
  const rcSel = body.querySelector('#edReconnect');
  const namingSel = body.querySelector('#edNaming');
  const segMode = body.querySelector('#edSegMode');

  const setRoomPh = () => {
    if (roomInput) roomInput.placeholder = d.platform === 'douyin' ? t('tasks.douyinRoomPh') : t('tasks.roomPh');
  };
  const setQHint = () => { const el = body.querySelector('#edQualityHint'); if (el) el.innerHTML = qualityHint(d); };
  const setNamingHint = () => { const el = body.querySelector('#edNamingHint'); if (el) el.innerHTML = namingHint(d); };
  function setSegUI() {
    const show = (id, on) => { const el = body.querySelector('#' + id); if (el) el.style.display = on ? '' : 'none'; };
    show('edSegMinCell', d.segmentMode === 'time');
    show('edSegSizeCell', d.segmentMode === 'size');
  }

  async function doResolve({ silent } = {}) {
    const url = urlInput ? urlInput.value.trim() : (d.url || '');
    const rid = roomInput ? roomInput.value.trim() : String(d.roomId || '');
    if (!url && !((d.resolved && d.resolved.roomId) || (d.platform && rid))) {
      if (!silent) toast(t('tasks.pasteLinkWarn'), 'warn');
      return null;
    }
    if (resolveBtn) { resolveBtn.disabled = true; resolveBtn.textContent = t('tasks.resolving'); }
    try {
      const r = await api.resolve(url || rid, url ? undefined : d.platform);
      d.resolved = r;
      d.avatarDirty = true;
      d.platform = r.platform || d.platform;
      d.roomId = String(r.roomId || rid || '');
      // 房间号输入框显示短号（抖音号）；内部 roomId 仍用 19 位内部号
      d.shortId = r.shortId ? String(r.shortId) : '';
      d.displayRoom = (d.platform === 'douyin' && d.shortId) ? d.shortId : d.roomId;
      if (roomInput) roomInput.value = d.displayRoom;
      if (platSel && [...platSel.options].some((o) => o.value === d.platform)) {
        platSel.value = d.platform;
        platSel.classList.toggle('ph', !d.platform);
      }
      if (r.anchorName) {
        const clean = stripEmoji(r.anchorName);
        // 用户已手动改过主播名：解析不覆盖自定义名（只保留平台名供内部使用）
        if (!d.anchorEdited) {
          d.anchorName = clean;
          if (anchorInput) anchorInput.value = clean;
        } else {
          d.platformAnchorName = clean;
        }
      }
      const rc = body.querySelector('#edResolved'); if (rc) rc.innerHTML = resolvedCard(d);
      setRoomPh();
      if (!silent) toast(t('tasks.resolvedOk'));
      return r;
    } catch (e) {
      if (!silent) toast(e.message || t('tasks.resolveFail'), 'err');
      return null;
    } finally {
      if (resolveBtn) { resolveBtn.disabled = false; resolveBtn.textContent = t('tasks.resolve'); }
    }
  }

  // 指定平台 + 房间号后自动带入主播名称（静默解析，主播名已手动填过则不覆盖）
  async function autoFromRoom() {
    const rid = roomInput ? roomInput.value.trim() : '';
    if (!d.platform || !rid) return;
    if (d.resolved && (String(d.resolved.roomId) === rid || (d.displayRoom && String(d.displayRoom) === rid))) return; // 本房间已解析，不再重复请求
    await doResolve({ silent: true });
  }

  // 底部「解析」按钮（footer 在 bindEditor 之前创建，通过 d.onResolve 挂钩）
  d.onResolve = () => doResolve({ silent: false });
  if (resolveBtn) resolveBtn.onclick = d.onResolve;
  if (platSel) platSel.onchange = () => {
    d.platform = platSel.value;
    platSel.classList.toggle('ph', !platSel.value);
    setRoomPh();
    const rid = roomInput ? roomInput.value.trim() : '';
    if (rid) autoFromRoom();
  };
  if (roomInput) {
    roomInput.oninput = () => { const v = roomInput.value.trim(); d.roomId = v; d.displayRoom = v; };
    roomInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); autoFromRoom(); } };
    roomInput.onblur = () => { autoFromRoom(); };
  }
  if (urlInput) urlInput.oninput = () => { d.url = urlInput.value.trim(); };
  if (anchorInput) anchorInput.oninput = () => { d.anchorName = anchorInput.value.trim(); d.anchorEdited = true; };
  // 清晰度：横向卡片，点选即生效（无"跟随全局"选项，默认值即全局默认）
  if (qGrid) qGrid.querySelectorAll('[data-q]').forEach((card) => {
    card.onclick = () => {
      d.quality = card.dataset.q || '';
      qGrid.querySelectorAll('[data-q]').forEach((c) => c.classList.toggle('sel', c === card));
      setQHint();
    };
  });
  if (pollSel) pollSel.onchange = () => { d.pollIntervalSec = Number(pollSel.value) || 60; };
  if (rcSel) rcSel.onchange = () => { d.reconnectMax = rcSel.value === '' ? '' : Number(rcSel.value); };
  if (namingSel) namingSel.onchange = () => { d.namingProfileId = namingSel.value; setNamingHint(); };
  if (segMode) segMode.onchange = () => { d.segmentMode = segMode.value; setSegUI(); };

  const segMin = body.querySelector('#edSegMin');
  if (segMin) segMin.onchange = () => { d.segmentMinutes = Number(segMin.value); };
  const segSize = body.querySelector('#edSegSize');
  if (segSize) segSize.onchange = () => { d.segmentSizeMB = Number(segSize.value); };

  bindSwitches(body, (sw) => {
    if (sw.id === 'edAuto') d.autoRecord = sw.classList.contains('on');
    if (sw.id === 'edMonitor') {
      d.monitorOnly = sw.classList.contains('on');
      // 仅监控隐含不自动录制，避免开关打架
      const edAuto = body.querySelector('#edAuto');
      if (d.monitorOnly && edAuto && edAuto.classList.contains('on')) {
        edAuto.classList.remove('on');
        d.autoRecord = false;
      }
      const hint = body.querySelector('#edMonitorHint');
      if (hint) hint.textContent = d.monitorOnly
        ? t('tasks.monitorOn')
        : t('tasks.monitorOff');
    }
  });
}

async function submit(d, dialog, btn, ctx) {
  const url = (d.url || '').trim();
  // 编辑已有任务且直播地址未改 → 不触发后台重解析，改用 平台 + 房间号 直接回填；
  // 改了地址（或新建）→ 提交 url 由后台解析回填
  const urlChanged = !!(url && (!d.task || url !== (d.task.sourceUrl || '')));
  const payload = {};
  if (urlChanged) payload.url = url;
  else if (d.platform && d.roomId) { payload.platform = d.platform; payload.roomId = d.roomId; }
  else if (url) payload.url = url;
  else { toast(t('tasks.fillLinkWarn'), 'warn'); return; }
  // 抖音短号变化时同步提交，后台直接落库（无需重新解析）
  if (d.platform === 'douyin' && d.shortId && d.shortId !== (d.task && d.task.shortId)) payload.shortId = d.shortId;

  payload.overrides = {};
  // 以下四项规则一致：无"跟随全局"选项，弹窗默认值即全局默认；仅当所选与任务当前生效值不同时才显式覆盖
  // （跟随全局的任务保持跟随，全局调整后自动生效；录制中任务"原样保存"不会误触发锁定提示）
  const curQ = (d.task && d.task.overrides && d.task.overrides.quality) || '';
  if (d.quality && d.quality !== curQ && d.quality !== (curQ || d.qualityGlobal)) payload.overrides.quality = d.quality;
  const curSeg = (d.task && d.task.overrides && d.task.overrides.segmentMode) || '';
  if (d.segmentMode && d.segmentMode !== curSeg && d.segmentMode !== (curSeg || d.segmentGlobal)) payload.overrides.segmentMode = d.segmentMode;
  const curNaming = (d.task && d.task.overrides && d.task.overrides.namingProfileId) || '';
  if (d.namingProfileId && d.namingProfileId !== curNaming && d.namingProfileId !== (curNaming || d.namingGlobal)) payload.overrides.namingProfileId = d.namingProfileId;
  payload.container = null;
  payload.remuxToMp4 = null;
  if (d.segmentMode === 'time') payload.segmentMinutes = d.segmentMinutes;
  if (d.segmentMode === 'size') payload.segmentSizeMB = d.segmentSizeMB;
  payload.autoMerge = false; // 已删除「分段文件处理」选项，默认保留独立分段
  payload.autoRecord = d.autoRecord;
  payload.monitorOnly = d.monitorOnly;
  // 轮询间隔：默认跟随全局（弹窗默认值即全局值，改全局后未自定义的任务自动生效）；
  // 选了与全局不同的值才写成任务级自定义，从自定义改回全局值则显式置 null 恢复跟随全局
  const curPollOv = Number(d.task && d.task.overrides && d.task.overrides.pollIntervalSec) || 0;
  const newPoll = Number(d.pollIntervalSec) || 0;
  if (newPoll) {
    if (newPoll === Number(d.pollGlobal)) { if (curPollOv) payload.overrides.pollIntervalSec = null; }
    else payload.overrides.pollIntervalSec = newPoll;
  }
  // 重连：默认带全局值；仅当与任务当前生效值不同才提交（跟随全局的任务保持跟随）
  const curR = Number(d.task && d.task.reconnectMax != null ? d.task.reconnectMax : d.reconnectGlobal) || 5;
  const newR = Number(d.reconnectMax) || 5;
  if (newR !== curR) payload.reconnectMax = newR;
  if (d.resolved && d.resolved.avatar && d.avatarDirty) payload.avatar = d.resolved.avatar; // 重新解析后保存：头像落盘到本地目录
  if (d.anchorName && d.anchorName.trim()) { payload.anchorName = d.anchorName.trim(); payload.anchorNameLocked = true; } // 保存过非空主播名即锁定，解析刷新不再覆盖

  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('common.saving');
  try {
    if (d.id) await api.patchTask(d.id, payload);
    else await api.createTask(payload);
    dialog.close();
    toast(d.id ? t('tasks.updated') : t('tasks.created'));
    state.hash = '';
    ctx.invalidate('dashboard');
  } catch (e) {
    if (e.code === 'DUPLICATE_ROOM' || e.status === 409) {
      toast(t('tasks.dupRoom'), 'warn');
    } else if (e.code === 'RECORDING_LOCKED') {
      toast(t('tasks.recordingChanged'), 'warn');
    } else {
      toast(e.message || t('tasks.saveFail'), 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
