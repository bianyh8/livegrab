/* LiveGrab · views/tasks.js —— 录制任务
   工具条（搜索/平台/状态/排序/导出/新建）＋ 批量操作条（D7）＋ 状态相关行内操作
   ＋ 新建/编辑任务弹窗（4 步纵排，②③④ 带「跟随全局」chip，D11）。 */

import { api } from '../api.js';
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
  root.innerHTML = `<div class="card"><div class="empty">正在加载任务…</div></div>`;
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
      boundRoot.innerHTML = `<div class="card"><div class="empty">任务加载失败：${esc(e.message || e)}</div></div>`;
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
  const t = state.tasks[i];
  state.tasks.splice(i, 1);
  state.tasks.splice(j, 0, t);
  state.hash = '';
  try { await api.tasksReorder(state.tasks.map((x) => x.id)); }
  catch (e) { toast(e.message || '排序保存失败', 'err'); }
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
      <div class="toolbar">
        <input class="input" id="tkQ" style="width:250px" placeholder="搜索主播 / 房间号 / 标题…" value="${esc(state.q)}" />
        <select class="select" id="tkPlat" style="width:150px">
          <option value="">全部平台</option>
          ${state.platforms.filter((p) => state.enabledSet[p.id] !== false || state.platform === p.id).map((p) => `<option value="${esc(p.id)}"${state.platform === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <select class="select" id="tkLive" style="width:150px">
          ${[['', '全部直播状态'], ['live', '直播中'], ['offline', '未直播'], ['unknown', '未知']]
            .map(([v, t]) => `<option value="${v}"${state.liveStatus === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="select" id="tkStatus" style="width:150px">
          ${[['', '全部录制状态'], ['recording', '录制中'], ['stopped', '已停止'], ['queued', '排队中'], ['waiting', '等待开播'], ['completed', '已完成'], ['error', '错误'], ['idle', '待机']]
            .map(([v, t]) => `<option value="${v}"${state.status === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="select" id="tkSort" style="width:158px">
          ${[['custom', '自定义排序'], ['created', '按创建时间排序'], ['duration', '按已录时长排序'], ['size', '按文件大小排序'], ['status', '按状态排序']]
            .map(([v, t]) => `<option value="${v}"${state.sort === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <select class="select" id="tkSortDir" style="width:80px" title="排序方向（自定义排序为手动顺序，不受此控制）">
          ${[['desc', '倒序'], ['asc', '顺序']]
            .map(([v, t]) => `<option value="${v}"${state.sortDir === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="tkExport">导出</button>
        <button class="btn sm primary" id="tkNew">＋ 新建任务</button>
      </div>
      <div class="toolbar" style="border-top:1px dashed var(--line);padding-top:12px">
        <span class="chip ${state.selected.size ? 'on' : ''}" id="tkSelChip"><i class="dot"></i>已选 ${state.selected.size} 项</span>
        <span class="chip">1 任务 = 1 直播间；同一房间不允许两条启用任务</span>
        <div class="spacer"></div>
        <button class="btn sm" data-batch="start">批量启动</button>
        <button class="btn sm" data-batch="pause">批量暂停</button>
        <button class="btn sm" data-batch="stop">停止录制</button>
        <button class="btn sm danger" data-batch="delete">批量删除</button>
      </div>
      <div class="hintline" style="margin:0 0 12px 2px">批量操作单次上限 50 条；并发不足时部分成功，会明确告知"已启动 N 条、M 条进入排队"。删除默认只解除任务管理、不动已录文件。${state.sort === 'custom' ? '当前为自定义排序：点击行尾 ↑ / ↓ 调整顺序（即实际任务执行顺序）。' : '排序下拉选「自定义排序」后，可手动调整任务顺序。'}</div>
      <div id="tkTable">${table(list)}</div>
    </div>`;

  bind(ctx);
}

function table(list) {
  if (!list.length) {
    return emptyBox(state.tasks.length ? '没有符合筛选条件的任务' : '还没有录制任务，点右上角「新建任务」添加第一个直播间');
  }
  return `<table>
    <thead><tr>
      <th style="width:34px"><input type="checkbox" class="cb" id="tkAll"${list.every((t) => state.selected.has(t.id)) ? ' checked' : ''} /></th>
      <th>任务 / 直播间</th><th style="width:60px">平台</th><th>直播状态</th><th>录制状态</th><th>清晰度</th>${state.sort === 'custom' ? '<th style="width:46px">排序</th>' : ''}<th style="text-align:right">操作</th>
    </tr></thead>
    <tbody>${list.map(row).join('')}</tbody>
  </table>`;
}

function row(t) {
  const name = state.platforms.find((p) => p.id === t.platform);
  const checked = state.selected.has(t.id) ? ' checked' : '';
  const isLive = t.liveStatus === 'live' || t.status === 'recording';
  const avatarImg = isLive
    ? `<img class="tk-thumb" loading="lazy" src="/api/tasks/${esc(t.id)}/thumb" alt="" onerror="this.style.display='none'" />`
    : (t.avatar ? `<img class="tk-thumb" loading="lazy" src="${esc(t.avatar)}" alt="" onerror="this.style.display='none'" />` : '');
  return `<tr data-id="${esc(t.id)}">
    <td><input type="checkbox" class="cb" data-pick="${esc(t.id)}"${checked} /></td>
    <td>
      <div class="tk-cell">
        <div class="tk-avatar">
          <span class="tk-ph">${esc((t.anchorName || t.name || '?').slice(0, 1))}</span>
          ${avatarImg}
          ${isLive ? '<span class="tk-live"><i></i>直播中</span>' : ''}
        </div>
        <div class="tk-bio">
          <div style="font-weight:600">${esc(t.anchorName || t.name || '未命名任务')}${t.monitorOnly ? ' <span class="tag">仅监控</span>' : ''}</div>
          <div class="sub">${esc(t.title || '（暂无标题）')} · 房号 ${esc(t.roomId || '—')}</div>
        </div>
      </div>
    </td>
    <td>${platIcon(t.platform, (name && name.name) || platName(t.platform) || t.platformName)}</td>
    <td>${liveStatusCell(t)}</td>
    <td>${recStatusCell(t)}</td>
    <td><span class="chip">${esc(qualityLabelOf(t))}</span></td>
    ${state.sort === 'custom' ? `<td>
      <div class="mvrow">
        <span class="rnk">${esc(String(state.tasks.indexOf(t) + 1))}</span>
        <button class="mvbtn" data-mv="up" data-id="${esc(t.id)}" title="上移（上一优先级）">↑</button>
        <button class="mvbtn" data-mv="down" data-id="${esc(t.id)}" title="下移">↓</button>
      </div>
    </td>` : ''}
    <td><div class="acts">${rowActions(t).join('')}</div></td>
  </tr>`;
}

/* 状态拆为两列：直播状态（看播） + 录制状态（任务自身的录制工作流） */
function liveStatusCell(t) {
  const live = t.liveStatus === 'live' || t.status === 'recording';
  return live
    ? '<span class="chip on"><i class="dot"></i>直播中</span>'
    : '<span class="chip off"><i class="dot"></i>未直播</span>';
}

function recStatusCell(t) {
  const recording = ['recording', 'stopping', 'merging'].includes(t.status);
  if (recording) return '<span class="pulse"><b></b>录制中</span>';
  if (t.monitorOnly) return '<span class="chip bili" title="该任务仅监控直播状态，不录制"><i class="dot"></i>仅监控</span>';
  if (t.manualHeld || t.status === 'stopped') return '<span class="chip off" title="已停止录制，等你手动开始"><i class="dot"></i>已停止</span>';
  if (t.status === 'error') return '<span class="chip err"><i class="dot"></i>异常</span>';
  return '<span class="chip"><i class="dot"></i>未录制</span>';
}

function rowActions(t) {
  const id = esc(t.id);
  const acts = [];
  const recording = ['recording', 'stopping', 'merging'].includes(t.status);
  if (recording) {
    acts.push(`<button class="btn sm danger" data-act="stop" data-id="${id}">停止录制</button>`);
  } else if (t.liveStatus === 'live') {
    acts.push(`<button class="btn sm ok" data-act="start" data-id="${id}"${t.monitorOnly ? ' title="仅录制本场，不改变仅监控设置"' : ''}>开始录制</button>`);
  } else {
    acts.push(`<button class="btn sm" data-act="check" data-id="${id}" title="立即检测该直播间是否已开播">立即检测</button>`);
  }
  acts.push(`<button class="btn sm ghost" data-act="detail" data-id="${id}">详情</button>`);
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
        toast('已跳转到运行日志并锁定该任务');
        window.location.hash = '#/logs?task=' + encodeURIComponent(id);
        return;
      }
      if (act === 'priority') { toast('排队原因：' + ((task && task.queueReason) || '等待并发空位') + '（提权由调度器实现，UI 已提交）'); return; }
      if (act === 'delete') { removeTask(task, ctx); return; }
      btn.disabled = true;
      try {
        await api.taskAction(id, act);
        const msg = {
          start: '已立即开始录制（跳过开播检测）',
          pause: '已暂停：本段已结束并入库，拉流已停止，不占用并发',
          stop: '已停止并开始转封装',
          resume: '已继续录制，新分段序号续接',
          check: '已立即轮询一次开播状态',
          retry: '已立即重试',
        }[act] || '操作完成';
        toast(msg);
        state.hash = '';
        ctx.invalidate('dashboard');
      } catch (e) {
        toast(e.message || '操作失败', 'err');
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
    chip.innerHTML = `<i class="dot"></i>已选 ${state.selected.size} 项`;
  }
}

async function batch(ctx, action) {
  const ids = Array.from(state.selected);
  if (!ids.length) { toast('请先勾选要操作的任务', 'warn'); return; }
  if (ids.length > 50) { toast('批量操作单次上限 50 条，请减少勾选数量', 'warn'); return; }

  if (action === 'delete') {
    const picked = state.tasks.filter((t) => ids.includes(t.id));
    const withFiles = picked.filter((t) => t.sessionId).length;
    const files = picked.reduce((n, t) => n + ((t.segments && t.segments.length) || (t.live && t.live.segmentIndex) || 1), 0);
    const bytes = picked.reduce((n, t) => n + (Number(t.totalBytes) || Number(t.live && t.live.bytes) || 0), 0);
    confirmDialog({
      title: '批量删除任务',
      danger: true,
      ok: '删除',
      text: `将删除 <b>${ids.length}</b> 条任务${withFiles ? `（其中 ${withFiles} 条已绑定整场文件）` : ''}。<br>
             已录文件默认<b>不删除</b>，仅解除任务管理；如需清理请到「录制文件」页删除整场。<br>
             <span style="color:var(--txt-3)">涉及约 ${files} 个文件 / ${esc(formatBytes(bytes))}（仅为提示口径）。</span>`,
      onOk: async () => {
        try {
          const r = await api.batch('delete', ids);
          const failed = (r && r.failed) || [];
          if (failed.length) toast(`已删除 ${ids.length - failed.length} 条，${failed.length} 条失败：${failed[0].message || ''}`, 'warn');
          else toast(`已删除 ${ids.length} 条任务`);
          state.selected.clear();
          state.hash = '';
          ctx.invalidate('dashboard');
        } catch (e) { toast(e.message || '批量删除失败', 'err'); }
      },
    });
    return;
  }

  try {
    const r = await api.batch(action, ids);
    const ok = (r && r.okIds) || [];
    const failed = (r && r.failed) || [];
    const verb = { start: '启动', pause: '暂停', stop: '停止', check: '检测' }[action] || '处理';
    let msg = `已${verb} ${ok.length} 条`;
    if (failed.length) msg += `，${failed.length} 条失败（${failed[0].message || '原因未知'}）`;
    if (r && r.note) msg += ' · ' + r.note;
    toast(msg);
    ctx.invalidate('dashboard');
  } catch (e) {
    toast(e.message || '批量操作失败', 'err');
  }
}

function removeTask(task, ctx) {
  if (!task) return;
  const files = (task.segments && task.segments.length) || 1;
  const bytes = Number(task.totalBytes) || Number(task.live && task.live.bytes) || 0;
  confirmDialog({
    title: '删除任务',
    danger: true,
    ok: '删除',
    text: `将删除任务「${esc(task.anchorName || task.name || task.id)}」。<br>
           已录文件默认<b>不删除</b>；如需清理请到「录制文件」页删除整场。<br>
           <span style="color:var(--txt-3)">该任务已录约 ${files} 个文件 / ${esc(formatBytes(bytes))}。</span>`,
    onOk: async () => {
      try {
        await api.deleteTask(task.id);
        toast('已删除任务（已录文件保留）');
        state.selected.delete(task.id);
        state.hash = '';
        ctx.invalidate('dashboard');
      } catch (e) {
        if (e.code === 'RECORDING_LOCKED' || e.status === 409) {
          confirmDialog({
            title: '任务正在录制',
            danger: true,
            ok: '停止并删除',
            text: '该任务正在录制中，删除前需先停止。是否立即停止并删除？',
            onOk: async () => {
              try { await api.deleteTask(task.id, true); toast('已停止并删除任务'); state.hash = ''; }
              catch (e2) { toast(e2.message || '删除失败', 'err'); }
            },
          });
        } else toast(e.message || '删除失败', 'err');
      }
    },
  });
}

function exportCsv() {
  const list = filtered();
  if (!list.length) { toast('没有可导出的任务', 'warn'); return; }
  const head = ['任务ID', '主播', '标题', '平台', '房间号', '清晰度', '分段策略', '状态', '已录时长', '文件大小', '创建时间'];
  const rows = list.map((t) => [
    t.id, t.anchorName || t.name || '', t.title || '', platName(t.platform) || t.platform || '', t.roomId || '',
    qualityLabelOf(t), segmentStrategyText(t), (t.status || ''),
    formatDuration(Number(t.totalDurationSec) || Number(t.live && t.live.elapsedSec) || 0),
    formatBytes(Number(t.totalBytes) || Number(t.live && t.live.bytes) || 0),
    formatDateTime(t.createdAt),
  ]);
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadText(`livegrab_tasks_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  toast('已导出任务清单 CSV');
}

/* ---------- 详情 ---------- */

function detailDialog(task, ctx) {
  if (!task) return;
  const segs = task.segments || [];
  openDialog({
    title: '任务详情',
    wide: true,
    body: `
      <div class="kv" style="grid-template-columns:110px 1fr">
        <div class="k">任务</div><div>${esc(task.anchorName || task.name || '—')} · ${esc(task.title || '（暂无标题）')}</div>
        <div class="k">平台</div><div>${platBadge(task.platform, platName(task.platform) || task.platformName)}　房间 ${esc(task.roomId || '—')}</div>
        <div class="k">源地址</div><div class="mono" style="font-size:12px;word-break:break-all">${esc(task.sourceUrl || '—')}</div>
        <div class="k">清晰度</div><div>期望 ${esc(task.quality || '—')}${task.qualityActual ? ` · 实际 ${esc(task.qualityActual)}` : ''}</div>
        <div class="k">分段策略</div><div>${esc(segmentStrategyText(task))} · 自动合并 ${task.autoMerge ? '开' : '关'}</div>
        <div class="k">命名配置</div><div>${esc((task.overrides && task.overrides.namingProfileId) || task.namingProfileId || '跟随全局')}</div>
        <div class="k">状态</div><div>${statusCell(task)}</div>
        <div class="k">轮询</div><div>每 ${Number(task.pollIntervalSec || 60)} 秒 · 开播延迟 ${Number(task.startDelaySec || 5)} 秒 · 下播延迟 ${Number(task.stopDelaySec || 30)} 秒</div>
        <div class="k">重连次数</div><div>${Number(task.reconnectCount || 0)} 次</div>
        <div class="k">累计</div><div>${esc(formatDuration(Number(task.totalDurationSec) || 0))} · ${esc(formatBytes(Number(task.totalBytes) || 0))}</div>
        <div class="k">时间</div><div>创建 ${esc(formatDateTime(task.createdAt))}${task.startedAt ? ' · 开始 ' + esc(formatDateTime(task.startedAt)) : ''}${task.endedAt ? ' · 结束 ' + esc(formatDateTime(task.endedAt)) : ''}</div>
      </div>
      <div class="sect"><span class="n">≡</span>分段（${segs.length}）</div>
      ${segs.length ? `<table>
        <thead><tr><th style="width:70px">序号</th><th>文件名</th><th>时长</th><th>体积</th><th>状态</th></tr></thead>
        <tbody>${segs.map((s) => `<tr>
          <td class="mono">${String(s.index || 0).padStart(3, '0')}</td>
          <td class="mono" style="font-size:12px;word-break:break-all">${esc(s.name || s.path || '—')}</td>
          <td>${esc(formatDuration(s.durationSec || 0))}</td>
          <td>${esc(formatBytes(s.bytes || 0))}</td>
          <td>${s.status === 'recording' ? '<span class="chip wait"><i class="dot"></i>录制中</span>' : esc(s.status || 'done')}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="note">暂无分段记录（未开始录制或分段未入库）。</div>`}`,
    footer: (close) => {
      const buttons = [];
      const b1 = document.createElement('button');
      b1.className = 'btn ghost';
      b1.textContent = '关闭';
      b1.onclick = close;
      buttons.push(b1);
      if (task.status === 'recording') {
        const bp = document.createElement('button');
        bp.className = 'btn';
        bp.textContent = '暂停本段';
        bp.onclick = async () => { try { await api.taskAction(task.id, 'pause'); toast('已暂停：本段已结束并入库'); close(); } catch (e) { toast(e.message, 'err'); } };
        const bs = document.createElement('button');
        bs.className = 'btn danger';
        bs.textContent = '停止';
        bs.onclick = async () => { try { await api.taskAction(task.id, 'stop'); toast('已停止并开始转封装'); close(); } catch (e) { toast(e.message, 'err'); } };
        buttons.push(bp, bs);
      } else if (task.status === 'error') {
        const br = document.createElement('button');
        br.className = 'btn ok';
        br.textContent = '重试';
        br.onclick = async () => { try { await api.taskAction(task.id, 'retry'); toast('已立即重试'); close(); } catch (e) { toast(e.message, 'err'); } };
        buttons.push(br);
      }
      const be = document.createElement('button');
      be.className = 'btn primary';
      be.textContent = '编辑';
      be.onclick = () => { close(); openEditor(ctx, task.id); };
      buttons.push(be);
      return buttons;
    },
  });
}

/* ---------- 新建 / 编辑弹窗（4 步纵排） ---------- */

const QUALITY_CARDS = [
  { id: 'origin', label: '原画', res: '1080P60 · 最高画质', kbps: '≈ 8000 kbps', crown: true },
  { id: 'bluray', label: '蓝光', res: '1080P30', kbps: '≈ 6000 kbps' },
  { id: 'uhd', label: '超清', res: '720P', kbps: '≈ 3000 kbps' },
  { id: 'hd', label: '高清', res: '540P · 省流量', kbps: '≈ 1500 kbps' },
  { id: 'sd', label: '标清', res: '360P · 弱网可用', kbps: '≈ 800 kbps' },
  { id: 'audio', label: '仅音频', res: 'AAC 128k · 省空间', kbps: '≈ 128 kbps' },
];

const QNAME = { origin: '原画 1080P60', bluray: '蓝光 1080P', uhd: '超清 720P', hd: '高清 540P', sd: '标清 360P', audio: '仅音频 AAC 128k' };
function platHintText(p) {
  const base = '当前平台：' + (p ? platNameOf(p) : '未指定');
  if (p === 'douyin') return base + ' · <span class="h">填 19 位房间号</span>';
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
    try { task = await api.task(id); } catch (e) { toast(e.message || '读取任务失败', 'err'); return; }
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
    title: d.id ? '编辑录制任务' : '新建录制任务',
    wide: true,
    body: shell(d),
    footer: (close, body) => {
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = '取消';
      cancel.onclick = close;
      const save = document.createElement('button');
      save.className = 'btn primary';
      save.textContent = d.id ? '保存修改' : '创建任务';
      save.onclick = () => submit(d, dialog, save);
      return [cancel, save];
    },
  });

  bindEditor(d, dialog.body, ctx);
  updatePreview(d, dialog.body);
}

function shell(d) {
  return `
    <div class="sect"><span class="n">1</span>直播间地址</div>
    <div class="row">
      <input class="input f1 mono" id="edUrl" value="${esc(d.url)}" placeholder="粘贴任意支持的平台直播间链接（自动识别平台），或先选平台再输入房间号" />
      <button class="btn" id="edResolve">解析</button>
    </div>
    <div class="row wrap" style="margin-top:8px;align-items:center;gap:8px">
      <span style="font-size:12px;color:var(--txt-3);flex:0 0 auto">手动指定平台</span>
      ${d.platforms.map((p) => `<span class="chip" data-plat="${esc(p.id)}" style="cursor:pointer"><i class="dot" style="background:var(--${p.id === 'douyin' ? 'dy' : p.id === 'bilibili' ? 'bili-2' : 'accent'})"></i>${esc(p.name)}${tierName(p.tier) ? ` <span class="tag">${esc(tierName(p.tier))}</span>` : ''}</span>`).join('')}
    </div>
    <div class="row wrap" style="margin-top:8px;align-items:center;gap:8px">
      <span style="font-size:12px;color:var(--txt-3);flex:0 0 auto;white-space:nowrap">房间号</span>
      <input class="input mono" id="edRoom" style="width:200px;min-width:140px" value="${esc(d.roomId)}" placeholder="指定平台后填写，自动带入主播" />
      <span class="hintline" id="edPlatHint" style="margin:0;white-space:nowrap;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis">${platHintText(d.platform)}</span>
      <span style="flex:0 0 auto;color:var(--line-2);font-size:13px">│</span>
      <span style="font-size:12px;color:var(--txt-3);flex:0 0 auto;white-space:nowrap">主播名称</span>
      <input class="input f1" id="edAnchor" style="min-width:180px" value="${esc(d.anchorName)}" placeholder="解析后自动填充，可手动修改" />
    </div>
    <div class="hintline">粘贴链接自动识别；识别失败或被风控拦截时：手动指定平台 → 输入房间号，<b>松开即自动带入主播名称</b>。部分平台需先在「系统设置 › 平台账号」填 Cookie。<b>1 任务 = 1 直播间</b>。抖音免登录解析只认 <b>19 位内部房间号</b>（地址栏那串长数字），短号需先在「平台账号」填 Cookie。</div>
    <div id="edResolved">${d.resolved ? resolvedCard(d) : ''}</div>

    <div class="sect"><span class="n">2</span>清晰度 ${followChip(d.followQuality, 'q')}</div>
    <div class="mini-row" id="edQGrid">
      ${QUALITY_CARDS.map((q) => `<span class="mini${d.quality === q.id ? ' sel' : ''}" data-q="${q.id}" title="${esc(q.res)} · ${esc(q.kbps)}${q.crown ? ' · 推荐' : ''}">${q.crown ? '★ ' : ''}${q.label}</span>`).join('')}
    </div>
    <div class="hintline" id="edQualityHint">选择：<b style="color:var(--txt)">${esc(QNAME[d.quality] || d.quality)}</b> · ${esc((QUALITY_CARDS.find((x) => x.id === d.quality) || {}).res || '')} · 超标自动回退，文件名记真实档位${d.recording ? ' · <b style="color:var(--warn)">本场沿用旧参数，下一场生效</b>' : ''}</div>
    <div class="note" style="margin-top:10px">平台差异：抖音 / 快手 / 虎牙 / 斗鱼 / B站 支持多档；小红书仅默认画质、不可切换；微博最高 720P；淘宝 / 京东 / 视频号 需 Cookie。</div>

    <div class="sect"><span class="n">3</span>分段策略 ${followChip(d.followSeg, 'seg')}</div>
    <div class="mini-row" id="edSegGrid">
      <span class="mini${d.segmentMode === 'time' ? ' sel' : ''}" data-seg="time" title="每段固定时长，适合长期挂机">按时间分段</span>
      <span class="mini${d.segmentMode === 'size' ? ' sel' : ''}" data-seg="size" title="便于分卷存储与快速拷贝">按文件大小</span>
      <span class="mini${d.segmentMode === 'none' ? ' sel' : ''}" data-seg="none" title="单文件直到下播">不分段</span>
      <span class="mini i">时长 / 大小 / 合并方式见下方</span>
    </div>
    <div class="row wrap" id="edSegPanel" style="margin-top:12px;${d.segmentMode === 'none' ? 'display:none' : ''}">
      <div class="f1" style="min-width:170px"><label class="fl">每段时长</label>
        <select class="select" id="edSegMin">
          ${[30, 60, 120, 180].map((m) => `<option value="${m}"${d.segmentMinutes === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}
        </select></div>
      <div class="f1" style="min-width:170px"><label class="fl">分段大小</label>
        <select class="select" id="edSegSize">
          ${[1024, 2048, 4096, 8192].map((m) => `<option value="${m}"${d.segmentSizeMB === m ? ' selected' : ''}>${Math.round(m / 1024 * 10) / 10} GB</option>`).join('')}
        </select></div>
      <div class="f1" style="min-width:170px"><label class="fl">分段文件处理</label>
        <select class="select" id="edAutoMerge">
          <option value="0"${!d.autoMerge ? ' selected' : ''}>保留独立分段</option>
          <option value="1"${d.autoMerge ? ' selected' : ''}>结束后合并为单文件</option>
        </select></div>
    </div>

    <div class="row" style="margin-top:14px;align-items:center;gap:10px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--txt-2)">开播自动录制 ${switchEl(d.autoRecord, 'id="edAuto"')}</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--txt-2)">仅监控，不录制 ${switchEl(d.monitorOnly, 'id="edMonitor"')}</label>
      <div class="hintline" style="margin-top:6px" id="edMonitorHint">${d.monitorOnly ? '已开启仅监控：只监控直播状态，不会开始录制。' : '关闭则按正常任务录制（命名与存储全部跟随全局设置）。'}</div>
    </div>`;
}

let settings0 = null;

function followChip(on, kind) {
  return `<span class="chip ${on ? 'on' : ''}" data-follow="${kind}" style="margin-left:8px;font-weight:400;cursor:pointer">
    <i class="dot"></i>${on ? '跟随全局' : '自定义（仅本任务）'}</span>`;
}

function resolvedCard(d) {
  const r = d.resolved || {};
  const live = r.liveStatus === 'live';
  return `<div class="resolved">
    <div class="avatar">${esc((r.anchorName || '?').slice(0, 1))}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13.5px;font-weight:600">${esc(r.anchorName || '未知主播')}
        <span class="chip ${platformChipCls(r.platform)}" style="margin-left:6px">${esc(platNameOf(r.platform))}</span>
        ${live ? '<span class="chip on"><i class="dot"></i>直播中</span>'
               : '<span class="chip wait"><i class="dot"></i>未直播</span>'}
      </div>
      <div style="font-size:11.5px;color:var(--txt-3);margin-top:3px">
        房间号 ${esc(r.roomId || '—')}${r.title ? ' · ' + esc(r.title) : ''}${r.online != null ? ` · 当前在线 ${esc(fmtOnline(r.online))}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}
      </div>
    </div>
  </div>`;
}

function platformChipCls(id) { return id === 'douyin' ? 'dy' : id === 'bilibili' ? 'bili' : ''; }
function platNameOf(id) { const p = state.platforms.find((x) => x.id === id); return (p && p.name) || id || '未知平台'; }
function fmtOnline(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
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
      if (!silent) toast('请粘贴直播间链接，或指定平台 + 房间号', 'warn');
      return null;
    }
    if (resolveBtn) { resolveBtn.disabled = true; resolveBtn.textContent = '解析中…'; }
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
      if (!silent) toast('已解析直播间信息');
      return r;
    } catch (e) {
      if (!silent) toast(e.message || '解析失败，请改用「手动指定平台 + 房间号」', 'err');
      return null;
    } finally {
      if (resolveBtn) { resolveBtn.disabled = false; resolveBtn.textContent = '解析'; }
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
      if (hint) hint.innerHTML = `当前选择：<b style="color:var(--txt)">${esc(QNAME[d.quality] || d.quality)}</b> · 不可用时按设置中的「清晰度回退顺序」自动回退，文件名记录真实档位${d.recording ? ' · <b style="color:var(--warn)">本场沿用旧参数，下一场生效</b>' : ''}`;
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
        ? '已开启仅监控：只监控直播状态，不会开始录制。'
        : '关闭则按正常任务录制（命名与存储全部跟随全局设置）。';
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
    chip.innerHTML = `<i class="dot"></i>${on ? '跟随全局' : '自定义（仅本任务）'}`;
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
    fileEl.textContent = '预览不可用（后端 /api/naming/preview 无响应）';
  }
}

async function submit(d, dialog, btn) {
  const url = (d.url || '').trim();
  const payload = {};
  if (url) payload.url = url;
  else if (d.platform && d.roomId) { payload.platform = d.platform; payload.roomId = d.roomId; }
  else { toast('请填写直播间地址，或指定平台 + 房间号', 'warn'); return; }

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
  if (d.anchorName && d.anchorName.trim()) { payload.anchorName = d.anchorName.trim(); payload.anchorNameLocked = true; } // 保存过非空主播名即锁定，解析刷新不再覆盖

  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    if (d.id) await api.patchTask(d.id, payload);
    else await api.createTask(payload);
    dialog.close();
    toast(d.id ? '任务已更新' : '任务已创建，等待开播或立即开始录制');
    state.hash = '';
    ctx.invalidate('dashboard');
  } catch (e) {
    if (e.code === 'DUPLICATE_ROOM' || e.status === 409) {
      toast('该直播间已有启用中的任务：1 个任务对应 1 个直播间，请编辑现有任务或先停用', 'warn');
    } else if (e.code === 'RECORDING_LOCKED') {
      toast('任务正在录制中，清晰度/分段/命名改动将在下一场生效', 'warn');
    } else {
      toast(e.message || '保存失败', 'err');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
