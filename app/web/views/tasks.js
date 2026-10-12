/* LiveGrab · views/tasks.js —— 录制任务
   工具条（搜索/平台/状态/排序/导出/新建）＋ 批量操作条（D7）＋ 状态相关行内操作
   ＋ 新建/编辑任务弹窗（4 步纵排，②③④ 带「跟随全局」chip，D11）。 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  esc, formatBytes, formatDuration, formatDateTime, platBadge, platIcon, statusCell, segmentStrategyText,
  qualityLabelOf, emptyBox, toast, confirmDialog, openDialog, downloadText, switchEl, bindSwitches, tierName,
} from '../ui.js';

const state = {
  tasks: [],
  platforms: [],
  enabledSet: {},
  enabledInit: false,
  q: '',
  platform: '',
  status: '',
  liveStatus: '',
  sort: 'created',
  sortDir: 'desc',
  selected: new Set(),
  hash: '',
  pending: false,
  bound: false,
  openNew: false,
};

let boundRoot = null;
let offModal = null;
let boundCtx = null;

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('tasks.loading')}</div></div>`;
  if (!state.bound) {
    state.bound = true;
    offModal = ctx.on('open-task-modal', (id) => { if (id) openEditor(ctx, id); else state.openNew = true; });
  }
  ctx.onRefresh(() => tick(ctx));
  await tick(ctx, true);
}

export function destroy() {
  if (offModal) { offModal(); offModal = null; }
  state.bound = false;
  state.openNew = false;
  boundRoot = null;
}

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    if (!state.platforms.length) {
      try {
        const p = await api.platforms();
        state.platforms = (p && p.items) || [];
      } catch { state.platforms = []; }
    }
    if (!state.enabledInit) {
      try {
        const st = await api.settings();
        state.enabledSet = (st && st.platformEnabled) || {};
      } catch { state.enabledSet = {}; }
      state.enabledInit = true;
    }
    const r = await api.tasks();
    state.tasks = (r && r.items) || [];
    if (state.openNew) { state.openNew = false; openEditor(ctx, null); }
    paint(ctx, initial);
  } catch (e) {
    if (initial && boundRoot) {
      boundRoot.innerHTML = `<div class="card"><div class="empty">${t('tasks.loadFailed', esc(e.message || e))}</div></div>`;
    }
  } finally {
    state.pending = false;
  }
}

/* ---------- 过滤 / 排序 ---------- */

function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = state.tasks.filter((t) => {
    if (state.platform && t.platform !== state.platform) return false;
    if (state.liveStatus && t.liveStatus !== state.liveStatus) return false;
    if (state.status && t.status !== state.status) return false;
    if (q) {
      const hay = [t.anchorName, t.name, t.title, t.roomId, t.sourceUrl, t.qualityLabel].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by = {
    created: (a, b) => ts(b.createdAt) - ts(a.createdAt),
    duration: (a, b) => (Number(b.totalDurationSec) || Number(b.live && b.live.elapsedSec) || 0) - (Number(a.totalDurationSec) || Number(a.live && a.live.elapsedSec) || 0),
    size: (a, b) => (Number(b.totalBytes) || Number(b.live && b.live.bytes) || 0) - (Number(a.totalBytes) || Number(a.live && a.live.bytes) || 0),
    status: (a, b) => String(a.status).localeCompare(String(b.status)),
  };
  if (state.sort === 'custom') { /* 保持用户自定义顺序（store 数组顺序） */ }
  else {
    // 现有比较器均为"新/大在前"（倒序）；选「顺序」时取反为升序
    const dir = state.sortDir === 'asc' ? -1 : 1;
    const cmp = by[state.sort] || by.created;
    list = list.slice().sort((a, b) => dir * cmp(a, b));
  }
  return list;
}

function ts(v) { const d = new Date(v || 0); return isNaN(d.getTime()) ? 0 : d.getTime(); }

/* 自定义排序：上移/下移，重排 store 顺序并持久化 */
async function moveTask(id, dir) {
  const i = state.tasks.findIndex((t) => t.id === id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= state.tasks.length) return;
  const item = state.tasks[i];
  state.tasks.splice(i, 1);
  state.tasks.splice(j, 0, item);
  state.hash = '';
  try { await api.tasksReorder(state.tasks.map((x) => x.id)); }
  catch (e) { toast(e.message || t('tasks.sortSaveFail'), 'err'); }
  paint(boundCtx, true);
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

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  const list = filtered();
  const hash = JSON.stringify(list.map((t) => [
    t.id, t.status, t.queueReason, t.retryCount, t.statusMessage, t.qualityLabel,
    t.live && t.live.elapsedSec, t.live && t.live.bytes, t.live && t.live.segmentIndex, t.updatedAt,
  ])) + '|' + state.q + '|' + state.platform + '|' + state.liveStatus + '|' + state.status + '|' + state.sort + '|' + state.sortDir + '|' + Array.from(state.selected).join(',');
  if (!force && hash === state.hash) { syncBatchBar(); return; }
  state.hash = hash;

  root.innerHTML = `
    <div class="card">
      <div class="toolbar tq">
        <input class="input" id="tkQ" style="width:170px" placeholder="${t('tasks.searchPh')}" value="${esc(state.q)}" />
        <select class="select" id="tkPlat" style="width:108px">
          <option value="">${t('common.allPlatforms')}</option>
          ${state.platforms.filter((p) => state.enabledSet[p.id] !== false || state.platform === p.id).map((p) => `<option value="${esc(p.id)}"${state.platform === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <select class="select" id="tkLive" style="width:118px">
          ${[['', t('tasks.allLiveStatus')], ['live', t('tasks.live')], ['offline', t('tasks.notLive')], ['unknown', t('common.unknown')]]
            .map(([v, label]) => `<option value="${v}"${state.liveStatus === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <select class="select" id="tkStatus" style="width:128px">
          ${[['', t('tasks.allRecordStatus')], ['recording', t('common.recording')], ['stopped', t('tasks.stopped')], ['queued', t('common.queued')], ['waiting', t('common.waiting')], ['completed', t('common.completed')], ['error', t('common.error')], ['idle', t('common.idle')]]
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
        <button class="btn sm primary" id="tkNew">${t('tasks.newTask')}</button>
      </div>
      <div class="toolbar" style="border-top:1px dashed var(--line);padding-top:12px">
        <span class="chip ${state.selected.size ? 'on' : ''}" id="tkSelChip"><i class="dot"></i>${t('tasks.selected', state.selected.size)}</span>
        <span class="chip">${t('tasks.oneTaskTip')}</span>
        <div class="spacer"></div>
        <button class="btn sm" data-batch="refresh" title="${t('tasks.batchRefreshTip')}">${t('tasks.batchRefresh')}</button>
        <button class="btn sm" data-batch="start">${t('tasks.batchStart')}</button>
        <button class="btn sm" data-batch="pause">${t('tasks.batchPause')}</button>
        <button class="btn sm" data-batch="stop">${t('common.stopRecord')}</button>
        <button class="btn sm danger" data-batch="delete">${t('tasks.batchDelete')}</button>
      </div>
      <div class="hintline" style="margin:0 0 12px 2px">${t('tasks.batchHint')}${state.sort === 'custom' ? t('tasks.customSortHint') : t('tasks.customSortTip')}</div>
      <div id="tkTable">${table(list)}</div>
    </div>`;

  bind(ctx);
}

function table(list) {
  if (!list.length) {
    return emptyBox(state.tasks.length ? t('tasks.noFiltered') : t('tasks.noTasks'));
  }
  return `<table>
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
    <td>${platIcon(item.platform, (name && name.name) || platName(item.platform) || item.platformName)}</td>
    <td>${liveStatusCell(item)}</td>
    <td>${recStatusCell(item)}</td>
    <td><span class="chip">${esc(qualityLabelOf(item))}</span></td>
    ${state.sort === 'custom' ? `<td>
      <div class="mvrow">
        <span class="rnk">${esc(String(state.tasks.indexOf(item) + 1))}</span>
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
  const recording = ['recording', 'stopping', 'merging'].includes(item.status);
  if (recording) return '<span class="pulse"><b></b>' + t('common.recording') + '</span>';
  if (item.monitorOnly) return '<span class="chip bili" title="' + t('tasks.monitorOnlyTip') + '"><i class="dot"></i>' + t('common.monitorOnly') + '</span>';
  if (item.manualHeld || item.status === 'stopped') return '<span class="chip off" title="' + t('tasks.stoppedTip') + '"><i class="dot"></i>' + t('tasks.stopped') + '</span>';
  if (item.status === 'error') return '<span class="chip err"><i class="dot"></i>' + t('tasks.abnormal') + '</span>';
  return '<span class="chip"><i class="dot"></i>' + t('tasks.notRecorded') + '</span>';
}

function rowActions(item) {
  const id = esc(item.id);
  const acts = [];
  const recording = ['recording', 'stopping', 'merging'].includes(item.status);
  if (recording) {
    acts.push(`<button class="btn sm danger" data-act="stop" data-id="${id}">${t('common.stopRecord')}</button>`);
  } else if (item.liveStatus === 'live') {
    acts.push(`<button class="btn sm ok" data-act="start" data-id="${id}"${item.monitorOnly ? ' title="' + t('tasks.monitorOnlyStartTip') + '"' : ''}>${t('tasks.startRecord')}</button>`);
  } else {
    acts.push(`<button class="btn sm" data-act="check" data-id="${id}" title="${t('common.checkLiveTip')}">${t('common.checkLive')}</button>`);
  }
  acts.push(`<button class="btn sm ghost" data-act="detail" data-id="${id}">${t('common.detail')}</button>`);
  return acts;
}

/* ---------- 交互 ---------- */

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;
  boundCtx = ctx;

  root.querySelectorAll('[data-mv]').forEach((btn) => {
    btn.onclick = () => moveTask(btn.dataset.id, btn.dataset.mv === 'up' ? -1 : 1);
  });

  const q = root.querySelector('#tkQ');
  if (q) {
    let timer = null;
    q.oninput = () => {
      state.q = q.value;
      clearTimeout(timer);
      timer = setTimeout(() => { state.hash = ''; paint(ctx, true); }, 200);
    };
  }
  const bindSel = (id, key) => {
    const node = root.querySelector(id);
    if (!node) return;
    node.onchange = () => { state[key] = node.value; state.hash = ''; paint(ctx, true); };
  };
  bindSel('#tkPlat', 'platform');
  bindSel('#tkLive', 'liveStatus');
  bindSel('#tkStatus', 'status');
  bindSel('#tkSort', 'sort');
  bindSel('#tkSortDir', 'sortDir');

  const all = root.querySelector('#tkAll');
  if (all) all.onchange = () => {
    const list = filtered();
    list.forEach((t) => { all.checked ? state.selected.add(t.id) : state.selected.delete(t.id); });
    state.hash = '';
    paint(ctx, true);
  };

  root.querySelectorAll('[data-pick]').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.pick;
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      syncBatchBar();
    };
  });

  root.querySelector('#tkNew').onclick = () => openEditor(ctx, null);
  root.querySelector('#tkExport').onclick = () => exportCsv();

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const task = state.tasks.find((t) => t.id === id);
      if (act === 'detail') { detailDialog(task, ctx); return; }
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

  root.querySelectorAll('[data-batch]').forEach((btn) => {
    btn.onclick = () => batch(ctx, btn.dataset.batch);
  });

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
    const picked = state.tasks.filter((t) => ids.includes(t.id));
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
    const verb = { start: t('tasks.verbStart'), pause: t('tasks.verbPause'), stop: t('tasks.stop'), check: t('tasks.verbCheck'), refresh: t('common.refresh') }[action] || t('tasks.verbProcess');
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

function exportCsv() {
  const list = filtered();
  if (!list.length) { toast(t('tasks.noExport'), 'warn'); return; }
  const head = [t('tasks.csvId'), t('tasks.csvAnchor'), t('tasks.csvTitle'), t('settings.pfColPlatform'), t('tasks.csvRoom'), t('tasks.colQuality'), t('tasks.csvSegment'), t('tasks.csvStatus'), t('tasks.csvDuration'), t('tasks.csvSize'), t('tasks.csvCreated')];
  const rows = list.map((t) => [
    t.id, t.anchorName || t.name || '', t.title || '', platName(t.platform) || t.platform || '', t.roomId || '',
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

function detailDialog(task, ctx) {
  if (!task) return;
  const segs = task.segments || [];
  openDialog({
    title: t('tasks.detailTitle'),
    wide: true,
    body: `
      <div class="kv" style="grid-template-columns:110px 1fr">
        <div class="k">${t('logs.colTask')}</div><div>${esc(task.anchorName || task.name || '—')} · ${esc(task.title || t('tasks.noTitle'))}</div>
        <div class="k">${t('settings.pfColPlatform')}</div><div>${platBadge(task.platform, platName(task.platform) || task.platformName)}　${t('common.room', esc(task.roomId || '—'))}</div>
        <div class="k">${t('tasks.kSource')}</div><div class="mono" style="font-size:12px;word-break:break-all">${esc(task.sourceUrl || '—')}</div>
        <div class="k">${t('tasks.colQuality')}</div><div>${t('tasks.expected', esc(task.quality || '—'))}${task.qualityActual ? t('tasks.actual', esc(task.qualityActual)) : ''}</div>
        <div class="k">${t('tasks.csvSegment')}</div><div>${esc(segmentStrategyText(task))} ${t('tasks.autoMerge', task.autoMerge ? t('tasks.on') : t('tasks.off'))}</div>
        <div class="k">${t('settings.nmConfigTitle')}</div><div>${esc((task.overrides && task.overrides.namingProfileId) || task.namingProfileId || t('tasks.followGlobal'))}</div>
        <div class="k">${t('tasks.csvStatus')}</div><div>${statusCell(task)}</div>
        <div class="k">${t('tasks.kPoll')}</div><div>${t('tasks.pollDetail', Number(task.pollIntervalSec || 60), Number(task.startDelaySec || 5), Number(task.stopDelaySec || 30))}</div>
        <div class="k">${t('tasks.kReconnect')}</div><div>${t('tasks.times', Number(task.reconnectCount || 0))}</div>
        <div class="k">${t('tasks.kTotal')}</div><div>${esc(formatDuration(Number(task.totalDurationSec) || 0))} · ${esc(formatBytes(Number(task.totalBytes) || 0))}</div>
        <div class="k">${t('logs.colTime')}</div><div>${t('tasks.created', esc(formatDateTime(task.createdAt)))}${task.startedAt ? ' ' + t('tasks.started', esc(formatDateTime(task.startedAt))) : ''}${task.endedAt ? ' ' + t('tasks.ended', esc(formatDateTime(task.endedAt))) : ''}</div>
      </div>
      <div class="sect"><span class="n">≡</span>${t('tasks.segHeader', segs.length)}</div>
      ${segs.length ? `<table>
        <thead><tr><th style="width:70px">${t('tasks.segIndex')}</th><th>${t('tasks.segName')}</th><th>${t('tasks.segDuration')}</th><th>${t('tasks.segSize')}</th><th>${t('tasks.csvStatus')}</th></tr></thead>
        <tbody>${segs.map((s) => `<tr>
          <td class="mono">${String(s.index || 0).padStart(3, '0')}</td>
          <td class="mono" style="font-size:12px;word-break:break-all">${esc(s.name || s.path || '—')}</td>
          <td>${esc(formatDuration(s.durationSec || 0))}</td>
          <td>${esc(formatBytes(s.bytes || 0))}</td>
          <td>${s.status === 'recording' ? '<span class="chip wait"><i class="dot"></i>' + t('common.recording') + '</span>' : esc(s.status || 'done')}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="note">${t('tasks.noSegs')}</div>`}`,
    footer: (close) => {
      const buttons = [];
      const b1 = document.createElement('button');
      b1.className = 'btn ghost';
      b1.textContent = t('common.close');
      b1.onclick = close;
      buttons.push(b1);
      if (task.status === 'recording') {
        const bp = document.createElement('button');
        bp.className = 'btn';
        bp.textContent = t('tasks.pauseSegment');
        bp.onclick = async () => { try { await api.taskAction(task.id, 'pause'); toast(t('tasks.pauseSegmentDone')); close(); } catch (e) { toast(e.message, 'err'); } };
        const bs = document.createElement('button');
        bs.className = 'btn danger';
        bs.textContent = t('tasks.stop');
        bs.onclick = async () => { try { await api.taskAction(task.id, 'stop'); toast(t('tasks.stopDone')); close(); } catch (e) { toast(e.message, 'err'); } };
        buttons.push(bp, bs);
      } else if (task.status === 'error') {
        const br = document.createElement('button');
        br.className = 'btn ok';
        br.textContent = t('tasks.retry');
        br.onclick = async () => { try { await api.taskAction(task.id, 'retry'); toast(t('tasks.retryDone')); close(); } catch (e) { toast(e.message, 'err'); } };
        buttons.push(br);
      }
      const be = document.createElement('button');
      be.className = 'btn primary';
      be.textContent = t('tasks.edit');
      be.onclick = () => { close(); openEditor(ctx, task.id); };
      buttons.push(be);
      return buttons;
    },
  });
}

/* ---------- 新建 / 编辑弹窗（4 步纵排） ---------- */

const QUALITY_CARDS = [
  { id: 'origin', labelKey: 'tasks.qOrigin', resKey: 'tasks.qOriginRes', kbpsKey: 'tasks.qOriginKbps', crown: true },
  { id: 'bluray', labelKey: 'tasks.qBluray', resKey: 'tasks.qBlurayRes', kbpsKey: 'tasks.qBlurayKbps' },
  { id: 'uhd', labelKey: 'tasks.qUhd', resKey: 'tasks.qUhdRes', kbpsKey: 'tasks.qUhdKbps' },
  { id: 'hd', labelKey: 'tasks.qHd', resKey: 'tasks.qHdRes', kbpsKey: 'tasks.qHdKbps' },
  { id: 'sd', labelKey: 'tasks.qSd', resKey: 'tasks.qSdRes', kbpsKey: 'tasks.qSdKbps' },
  { id: 'audio', labelKey: 'tasks.qAudio', resKey: 'tasks.qAudioRes', kbpsKey: 'tasks.qAudioKbps' },
];

const QNAME = { origin: 'tasks.qOriginName', bluray: 'tasks.qBlurayName', uhd: 'tasks.qUhdName', hd: 'tasks.qHdName', sd: 'tasks.qSdName', audio: 'tasks.qAudioName' };
function platHintText(p) {
  const base = t('tasks.currentPlatform') + (p ? platNameOf(p) : t('tasks.notSpecified'));
  if (p === 'douyin') return base + t('tasks.fillRoom19');
  return base;
}

const TOKENS = ['{日期}', '{主播}', '{平台}', '{房间号}', '{标题}', '{清晰度}', '{序号}', '{时间}', '{任务}', '{分辨率}', '{时长}', '{自定义}'];

const SAMPLE = {
  '{主播}': '某某小主播', '{平台}': '抖音', '{房间号}': '23456789', '{标题}': '今天打排位 冲王者',
  '{日期}': '2025-06-01', '{时间}': '20-13-05', '{清晰度}': '原画', '{序号}': '001', '{任务}': 'task_07',
  '{分辨率}': '1920x1080', '{时长}': '01-00-00', '{自定义}': '自定义',
};

async function openEditor(ctx, id) {
  let task = null;
  if (id) {
    try { task = await api.task(id); } catch (e) { toast(e.message || t('tasks.readTaskFail'), 'err'); return; }
  }
  let naming = null;
  let settings = null;
  const [n, s] = await Promise.allSettled([api.naming(), api.settings()]);
  if (n.status === 'fulfilled') naming = n.value;
  if (s.status === 'fulfilled') settings = s.value;

  const d = {
    id: id || null,
    url: task ? (task.sourceUrl || '') : '',
    platform: task ? task.platform : '',
    roomId: task ? String(task.roomId || '') : '',
    resolved: task ? {
      anchorName: task.anchorName, title: task.title, avatar: task.avatar,
      platform: task.platform, roomId: task.roomId,
      liveStatus: task.liveStatus === 'offline' ? 'offline' : 'live',
      online: null, qualityOptions: [],
    } : null,
    autoRecord: task ? task.autoRecord !== false : true,
    monitorOnly: task ? !!task.monitorOnly : !!((settings && settings.defaultMonitorOnly)),
    anchorName: task ? (task.anchorName || '') : '',
    anchorEdited: false, // 主播名是否被手动编辑（手改则锁定，避免被解析结果刷新覆盖）
    followQuality: !(task && task.overrides && task.overrides.quality),
    quality: (task && task.overrides && task.overrides.quality) || (settings && settings.defaultQuality) || 'origin',
    customText: (task && task.overrides && task.overrides.customText) || '',
    recordRoot: (settings && settings.recordRoot) || '/data',
    followSeg: !(task && task.overrides && task.overrides.segmentMode),
    segmentMode: (task && task.overrides && task.overrides.segmentMode) || (settings && settings.defaultSegmentMode) || 'time',
    segmentMinutes: task ? (task.segmentMinutes || 60) : ((settings && settings.defaultSegmentMinutes) || 60),
    segmentSizeMB: task ? (task.segmentSizeMB || 2048) : ((settings && settings.defaultSegmentSizeMB) || 2048),
    followNaming: !(task && task.overrides && task.overrides.namingProfileId),
    namingProfileId: (task && task.overrides && task.overrides.namingProfileId) || (naming && naming.activeId) || 'default',
    container: (task && task.container) || (settings && (settings.recordContainer || settings.container)) || 'ts',
    remuxToMp4: task ? task.remuxToMp4 !== false : true,
    autoMerge: task ? !!task.autoMerge : false,
    recording: !!(task && (task.status === 'recording' || task.status === 'stopping')),
    profiles: (naming && naming.profiles) || [],
    // 平台账号里「停用」的平台不出现在新建表单（编辑已有任务时仍保留其平台以便继续编辑）
    platforms: state.platforms.filter((p) => ((settings && settings.platformEnabled) || {} )[p.id] !== false || (task && task.platform === p.id)),
    preview: '',
  };

  const dialog = openDialog({
    title: d.id ? t('tasks.editTaskTitle') : t('tasks.newTaskTitle'),
    wide: true,
    body: shell(d),
    footer: (close, body) => {
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = t('common.cancel');
      cancel.onclick = close;
      const save = document.createElement('button');
      save.className = 'btn primary';
      save.textContent = d.id ? t('tasks.saveChanges') : t('tasks.createTask');
      save.onclick = () => submit(d, dialog, save, ctx);
      return [cancel, save];
    },
  });

  bindEditor(d, dialog.body, ctx);
  updatePreview(d, dialog.body);
}

function shell(d) {
  return `
    <div class="sect"><span class="n">1</span>${t('tasks.sectRoomUrl')}</div>
    <div class="row">
      <input class="input f1 mono" id="edUrl" value="${esc(d.url)}" placeholder="${t('tasks.pasteUrlPh')}" />
      <button class="btn" id="edResolve">${t('tasks.resolve')}</button>
    </div>
    <div class="row wrap" style="margin-top:8px;align-items:center;gap:8px">
      <span style="font-size:12px;color:var(--txt-3);flex:0 0 auto">${t('tasks.manualPlatform')}</span>
      ${d.platforms.map((p) => `<span class="chip" data-plat="${esc(p.id)}" style="cursor:pointer"><i class="dot" style="background:var(--${p.id === 'douyin' ? 'dy' : p.id === 'bilibili' ? 'bili-2' : 'accent'})"></i>${esc(p.name)}${tierName(p.tier) ? ` <span class="tag">${esc(tierName(p.tier))}</span>` : ''}</span>`).join('')}
    </div>
    <div class="row wrap" style="margin-top:8px;align-items:center;gap:8px">
      <span style="font-size:12px;color:var(--txt-3);flex:0 0 auto;white-space:nowrap">${t('tasks.csvRoom')}</span>
      <input class="input mono" id="edRoom" style="width:200px;min-width:140px" value="${esc(d.roomId)}" placeholder="${t('tasks.roomPh')}" />
      <span class="hintline" id="edPlatHint" style="margin:0;white-space:nowrap;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis">${platHintText(d.platform)}</span>
      <span style="flex:0 0 auto;color:var(--line-2);font-size:13px">│</span>
      <span style="font-size:12px;color:var(--txt-3);flex:0 0 auto;white-space:nowrap">${t('files.anchorPlaceholder')}</span>
      <input class="input f1" id="edAnchor" style="min-width:180px" value="${esc(d.anchorName)}" placeholder="${t('tasks.anchorPh')}" />
    </div>
    <div class="hintline">${t('tasks.platHint1')}${t('tasks.platHint2')}${t('tasks.platHint3')}${t('tasks.platHint4')}${t('tasks.platHint5')}</div>
    <div id="edResolved">${d.resolved ? resolvedCard(d) : ''}</div>

    <div class="sect"><span class="n">2</span>${t('tasks.colQuality')} ${followChip(d.followQuality, 'q')}</div>
    <div class="mini-row" id="edQGrid">
      ${QUALITY_CARDS.map((q) => `<span class="mini${d.quality === q.id ? ' sel' : ''}" data-q="${q.id}" title="${esc(t(q.resKey))} · ${esc(t(q.kbpsKey))}${q.crown ? ' · ' + t('tasks.recommend') : ''}">${q.crown ? '★ ' : ''}${t(q.labelKey)}</span>`).join('')}
    </div>
    <div class="hintline" id="edQualityHint">${t('tasks.currentSel')}<b style="color:var(--txt)">${esc(t(QNAME[d.quality]) || d.quality)}</b> · ${esc(t((QUALITY_CARDS.find((x) => x.id === d.quality) || {}).resKey) || '')}${t('tasks.qualityHint')}${d.recording ? t('tasks.currentSessionNote') : ''}</div>
    <div class="note" style="margin-top:10px">${t('tasks.platformDiff')}</div>

    <div class="sect"><span class="n">3</span>${t('tasks.csvSegment')} ${followChip(d.followSeg, 'seg')}</div>
    <div class="mini-row" id="edSegGrid">
      <span class="mini${d.segmentMode === 'time' ? ' sel' : ''}" data-seg="time" title="${t('tasks.segByTimeTip')}">${t('tasks.segByTimeCard')}</span>
      <span class="mini${d.segmentMode === 'size' ? ' sel' : ''}" data-seg="size" title="${t('tasks.segBySizeTip')}">${t('settings.recSegBySize')}</span>
      <span class="mini${d.segmentMode === 'none' ? ' sel' : ''}" data-seg="none" title="${t('tasks.segNoneTip')}">${t('seg.none')}</span>
      <span class="mini i">${t('tasks.segHintBelow')}</span>
    </div>
    <div class="row wrap" id="edSegPanel" style="margin-top:12px;${d.segmentMode === 'none' ? 'display:none' : ''}">
      <div class="f1" style="min-width:170px"><label class="fl">${t('tasks.segMinutesLabel')}</label>
        <select class="select" id="edSegMin">
          ${[30, 60, 120, 180].map((m) => `<option value="${m}"${d.segmentMinutes === m ? ' selected' : ''}>${m} ${t('common.minutes')}</option>`).join('')}
        </select></div>
      <div class="f1" style="min-width:170px"><label class="fl">${t('tasks.segSizeLabel')}</label>
        <select class="select" id="edSegSize">
          ${[1024, 2048, 4096, 8192].map((m) => `<option value="${m}"${d.segmentSizeMB === m ? ' selected' : ''}>${Math.round(m / 1024 * 10) / 10} ${t('tasks.gb')}</option>`).join('')}
        </select></div>
      <div class="f1" style="min-width:170px"><label class="fl">${t('tasks.segProcessingLabel')}</label>
        <select class="select" id="edAutoMerge">
          <option value="0"${!d.autoMerge ? ' selected' : ''}>${t('tasks.segKeepIndependent')}</option>
          <option value="1"${d.autoMerge ? ' selected' : ''}>${t('tasks.segMergeSingle')}</option>
        </select></div>
    </div>

    <div class="row" style="margin-top:14px;align-items:center;gap:10px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--txt-2)">${t('tasks.autoRecordLabel')} ${switchEl(d.autoRecord, 'id="edAuto"')}</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--txt-2)">${t('tasks.monitorOnlyLabel')} ${switchEl(d.monitorOnly, 'id="edMonitor"')}</label>
      <div class="hintline" style="margin-top:6px" id="edMonitorHint">${d.monitorOnly ? t('tasks.monitorOn') : t('tasks.monitorOff')}</div>
    </div>`;
}

let settings0 = null;

function followChip(on, kind) {
  return `<span class="chip ${on ? 'on' : ''}" data-follow="${kind}" style="margin-left:8px;font-weight:400;cursor:pointer">
    <i class="dot"></i>${on ? t('tasks.followGlobal') : t('tasks.customOnly')}</span>`;
}

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
        ${t('tasks.roomNoShort', esc(r.roomId || '—'))}${r.title ? ' · ' + esc(r.title) : ''}${r.online != null ? t('tasks.onlineNow', esc(fmtOnline(r.online))) : ''}${r.note ? ` · ${esc(r.note)}` : ''}
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
  let resolveBtn = body.querySelector('#edResolve');
  const urlInput = body.querySelector('#edUrl');
  const roomInput = body.querySelector('#edRoom');
  const anchorInput = body.querySelector('#edAnchor');

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
      d.platform = r.platform || d.platform;
      d.roomId = String(r.roomId || rid || '');
      if (roomInput) roomInput.value = d.roomId; // 解析出的房间号直接回填房间号输入框
      if (r.anchorName) {
        const clean = stripEmoji(r.anchorName);
        d.anchorName = clean;
        if (anchorInput) anchorInput.value = clean;
      }
      const rc = body.querySelector('#edResolved'); if (rc) rc.innerHTML = resolvedCard(d);
      const ph = body.querySelector('#edPlatHint'); if (ph) ph.innerHTML = platHintText(d.platform);
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
    if (d.resolved && String(d.resolved.roomId) === rid) return; // 本房间已解析，不再重复请求
    await doResolve({ silent: true });
  }

  if (resolveBtn) resolveBtn.onclick = () => doResolve({ silent: false });

  body.querySelectorAll('[data-plat]').forEach((chip) => {
    chip.onclick = () => {
      d.platform = chip.dataset.plat;
      body.querySelectorAll('[data-plat]').forEach((c) => c.classList.toggle('on', c === chip));
      const ph = body.querySelector('#edPlatHint'); if (ph) ph.innerHTML = platHintText(d.platform);
      const rid = roomInput ? roomInput.value.trim() : '';
      if (rid) autoFromRoom();
    };
    if (d.platform === chip.dataset.plat) chip.classList.add('on');
  });
  if (roomInput) {
    roomInput.oninput = () => { d.roomId = roomInput.value.trim(); };
    roomInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); autoFromRoom(); } };
    roomInput.onblur = () => { autoFromRoom(); };
  }
  if (urlInput) urlInput.oninput = () => { d.url = urlInput.value.trim(); };
  if (anchorInput) anchorInput.oninput = () => { d.anchorName = anchorInput.value.trim(); d.anchorEdited = true; };

  body.querySelectorAll('[data-q]').forEach((card) => {
    card.onclick = () => {
      d.quality = card.dataset.q;
      d.followQuality = false;
      body.querySelectorAll('[data-q]').forEach((c) => c.classList.toggle('sel', c === card));
      refreshFollow(body, d);
      const hint = body.querySelector('#edQualityHint');
      if (hint) hint.innerHTML = `${t('tasks.currentSel')}<b style="color:var(--txt)">${esc(t(QNAME[d.quality]) || d.quality)}</b>${t('tasks.qualityFallback')}${d.recording ? t('tasks.currentSessionNote') : ''}`;
      updatePreview(d, body);
    };
  });

  body.querySelectorAll('[data-seg]').forEach((card) => {
    card.onclick = () => {
      d.segmentMode = card.dataset.seg;
      d.followSeg = false;
      body.querySelectorAll('[data-seg]').forEach((c) => c.classList.toggle('sel', c === card));
      body.querySelector('#edSegPanel').style.display = d.segmentMode === 'none' ? 'none' : 'flex';
      refreshFollow(body, d);
      updatePreview(d, body);
    };
  });

  const segMin = body.querySelector('#edSegMin');
  if (segMin) segMin.onchange = () => { d.segmentMinutes = Number(segMin.value); d.followSeg = false; refreshFollow(body, d); };
  const segSize = body.querySelector('#edSegSize');
  if (segSize) segSize.onchange = () => { d.segmentSizeMB = Number(segSize.value); d.followSeg = false; refreshFollow(body, d); };
  const autoMerge = body.querySelector('#edAutoMerge');
  if (autoMerge) autoMerge.onchange = () => { d.autoMerge = autoMerge.value === '1'; };

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

  body.querySelectorAll('[data-follow]').forEach((chip) => {
    chip.onclick = () => {
      const kind = chip.dataset.follow;
      if (kind === 'q') d.followQuality = !d.followQuality;
      if (kind === 'seg') d.followSeg = !d.followSeg;
      refreshFollow(body, d);
    };
  });
}

function refreshFollow(body, d) {
  body.querySelectorAll('[data-follow]').forEach((chip) => {
    const kind = chip.dataset.follow;
    const on = kind === 'q' ? d.followQuality : kind === 'seg' ? d.followSeg : d.followNaming;
    chip.className = 'chip' + (on ? ' on' : '');
    chip.innerHTML = `<i class="dot"></i>${on ? t('tasks.followGlobal') : t('tasks.customOnly')}`;
  });
}

async function updatePreview(d, body) {
  const dirEl = body.querySelector('#edPrevDir');
  const fileEl = body.querySelector('#edPrevFile');
  if (!dirEl || !fileEl) return;
  const profile = d.profiles.find((p) => p.id === d.namingProfileId) || d.profiles[0];
  const fnTemplate = (profile && profile.fnTemplate) || '{日期}_{主播}_{清晰度}_{序号}';
  const dirTemplate = (profile && profile.dirTemplate) || '{平台}/{主播}/{日期}';
  try {
    const r = await api.namingPreview({ fnTemplate, dirTemplate, options: (profile && profile.options) || {} });
    const lines = (r && r.lines) || [];
    if (!lines.length) { dirEl.textContent = '/data/'; fileEl.textContent = '—'; return; }
    dirEl.textContent = '/data/' + (lines[0].dir ? lines[0].dir + '/' : '');
    fileEl.innerHTML = lines.map((l) => esc(l.file)).join('<br>') + ((r.warnings && r.warnings.length) ? `<div class="pth" style="color:var(--warn)">${esc(r.warnings.join('；'))}</div>` : '');
  } catch {
    dirEl.textContent = '/data/';
    fileEl.textContent = t('tasks.previewUnavailable');
  }
}

async function submit(d, dialog, btn, ctx) {
  const url = (d.url || '').trim();
  const payload = {};
  if (url) payload.url = url;
  else if (d.platform && d.roomId) { payload.platform = d.platform; payload.roomId = d.roomId; }
  else { toast(t('tasks.fillLinkWarn'), 'warn'); return; }

  payload.overrides = {};
  if (!d.followQuality) payload.overrides.quality = d.quality;
  if (!d.followSeg) payload.overrides.segmentMode = d.segmentMode;
  // 命名与存储全部跟随全局设置（刷新已保存的任务级命名/自定义文本/封装/转封装）
  payload.overrides.namingProfileId = null;
  payload.overrides.customText = null;
  payload.container = null;
  payload.remuxToMp4 = null;
  if (d.segmentMode === 'time') payload.segmentMinutes = d.segmentMinutes;
  if (d.segmentMode === 'size') payload.segmentSizeMB = d.segmentSizeMB;
  payload.autoMerge = d.autoMerge;
  payload.autoRecord = d.autoRecord;
  payload.monitorOnly = d.monitorOnly;
  if (d.resolved && d.resolved.avatar) payload.avatar = d.resolved.avatar; // 点击解析后保存：头像落盘到本地目录
  if (d.anchorName && d.anchorName.trim()) { payload.anchorName = d.anchorName.trim(); payload.anchorNameLocked = true; } // 保存过非空主播名即锁定，解析刷新不再覆盖

  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('tasks.saving');
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
