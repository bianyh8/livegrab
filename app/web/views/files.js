/* LiveGrab · views/files.js —— 录制文件库
   按「视频文件」直接平铺显示，头部用 平台 / 主播 / 日期 等条件查询；不再有左侧树（全部场次 / 仅音频 / 回收站…）。
   回收站已独立为导航页「回收站」。删除走 POST /api/files/delete（默认进回收站，一并带走同名的刮削 .jpg/.nfo）。 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  esc, formatBytes, formatDuration, formatDateTime, platBadge, emptyBox,
  toast, confirmDialog, openPlayer, platformInfo,
} from '../ui.js';

const state = {
  sessions: [],
  q: '',
  platform: '',
  dateFrom: '',
  dateTo: '',
  ext: '',
  /* 已生效的筛选条件（点「查询」才提交）；输入框草稿暂存在上面的 q/platform/dateFrom/dateTo/ext */
  filters: { q: '', platform: '', dateFrom: '', dateTo: '', ext: '' },
  defaultsSet: false,
  picked: new Set(),
  hash: '',
  pending: false,
  bound: false,
};

let boundRoot = null;

/* 默认查询区间：近 7 天（7 天前 → 今天） */
function defaultDateRange() {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(new Date(Date.now() - 7 * 864e5)), to: fmt(new Date()) };
}

/* 把输入框草稿提交为已生效筛选条件（「查询」按钮触发） */
function commitFilters() {
  state.filters = { q: state.q, platform: state.platform, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext };
  state.hash = '';
}

/* 恢复默认查询条件（「清除」按钮触发 / 首次进入页面） */
function resetToDefaults(commit) {
  const { from, to } = defaultDateRange();
  state.q = '';
  state.platform = '';
  state.ext = '';
  state.dateFrom = from;
  state.dateTo = to;
  state.defaultsSet = true;
  if (commit) commitFilters();
}

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('files.loadingLibrary')}</div></div>`;
  if (!state.bound) state.bound = true;
  if (!state.defaultsSet) resetToDefaults(true);
  ctx.onRefresh(() => tick(ctx));
  await tick(ctx, true);
}

export function destroy() { boundRoot = null; }

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    const r = await api.files({ view: 'platform', q: state.filters.q });
    state.sessions = (r && r.items) || [];
    paint(ctx, initial);
  } catch (e) {
    if (initial) boundRoot.innerHTML = `<div class="card"><div class="empty">${t('files.loadFailed', esc(e.message || t('common.unknownError')))}</div></div>`;
  } finally {
    state.pending = false;
  }
}

/* 把「整场」拍平成「单个文件」行：分段 + 转封装/合并副本 + mp4/m4a；
   按 id 去重（同一成品可能同时挂在 extras 与 mp4），再按路径去重（历史 bug 可能把同一物理文件登记成多个条目） */
function allFiles() {
  const out = [];
  for (const s of state.sessions) {
    const seen = new Set();
    const seenPath = new Set();
    const push = (f, tag) => { if (f && f.id && !seen.has(f.id) && !seenPath.has(f.path)) { seen.add(f.id); seenPath.add(f.path); out.push({ f, s, tag }); } };
    (s.segments || []).forEach((x) => push(x, null));
    (s.extras || []).forEach((x) => push(x, x.kind === 'm4a' ? 'M4A' : x.kind === 'merged' ? '合并' : 'MP4'));
    if (s.mp4) push(s.mp4, 'MP4');
    if (s.merged) push(s.merged, '合并');
  }
  return out;
}

function filtered() {
  const fil = state.filters;
  const q = fil.q.trim().toLowerCase();
  return allFiles().filter(({ f, s, tag }) => {
    if (fil.platform && s.platform !== fil.platform) return false;
    // 日期按场次开始日期做闭区间过滤：仅起始 / 仅结束 / 都填均生效
    const day = String(s.startedAt || '').slice(0, 10);
    if (fil.dateFrom && day < fil.dateFrom) return false;
    if (fil.dateTo && day > fil.dateTo) return false;
    if (fil.ext) {
      const e = String(f.ext || tag || '').toLowerCase();
      if (e !== fil.ext && !(fil.ext === 'mp4' && (e === 'mp4' || e === 'm4a'))) return false;
    }
    if (q) {
      const hay = [f.name, f.relPath, s.streamer, s.title, s.taskId].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  const list = filtered();
  const allSel = list.length > 0 && list.every(({ f }) => state.picked.has(f.id));
  const platforms = [...new Set(state.sessions.map((s) => s.platform).filter(Boolean))];
  const hash = JSON.stringify([list.map(({ f, s }) => [f.id, f.status, s.platform, s.streamer, s.startedAt]),
    state.q, state.platform, state.dateFrom, state.dateTo, state.ext, Array.from(state.picked)]);
  if (!force && hash === state.hash) return;
  state.hash = hash;

  const totalBytes = state.sessions.reduce((n, s) => n + (s.bytes || 0), 0);

  root.innerHTML = `
    <div class="card">
      <div class="card-h">
        <h3>${t('files.libraryTitle')}</h3>
        <span class="hint">${esc(t('files.videoCount', list.length))} · ${esc(formatBytes(totalBytes))}</span>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="flRefresh">${t('common.refresh')}</button>
      </div>
      <div class="toolbar" style="padding:10px 16px 12px;flex-wrap:wrap">
        <input class="input" id="flQ" style="width:180px" placeholder="${t('files.searchPlaceholder')}" value="${esc(state.q)}" />
        <select class="select" id="flPlat" style="width:120px">
          <option value="">${t('common.allPlatforms')}</option>
          ${platforms.map((p) => `<option value="${esc(p)}"${state.platform === p ? ' selected' : ''}>${esc(platNameOf(p))}</option>`).join('')}
        </select>
        <input type="date" class="input" id="flDateFrom" style="width:150px" title="${t('files.dateFrom')}" value="${esc(state.dateFrom)}" />
        <span style="color:var(--txt-3);font-size:12px">${t('files.dateSep')}</span>
        <input type="date" class="input" id="flDateTo" style="width:150px" title="${t('files.dateTo')}" value="${esc(state.dateTo)}" />
        <select class="select" id="flExt" style="width:120px">
          ${[['', 'files.allTypes'], ['ts', 'files.extTs'], ['mp4', 'files.extMp4'], ['m4a', 'files.extM4a']].map(([v, k]) => `<option value="${v}"${state.ext === v ? ' selected' : ''}>${t(k)}</option>`).join('')}
        </select>
        <button class="btn sm" id="flQuery">${t('files.query')}</button>
        <button class="btn sm ghost" id="flClear">${t('files.clear')}</button>
        <div class="spacer"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--txt-2);cursor:pointer"><input type="checkbox" class="cb" id="flSelAll"${allSel ? ' checked' : ''} /> ${t('files.selectAll')}</label>
        <span class="chip ${state.picked.size ? 'on' : ''}" id="flPickChip"><i class="dot"></i>${t('files.selectedCount', state.picked.size)}</span>
        <button class="btn sm danger" id="flDelPicked"${state.picked.size ? '' : ' disabled'}>${t('files.deleteSelected')}</button>
      </div>
      <div style="padding:0 16px 16px" id="flBody">
        ${list.length ? list.map(filenameRow).join('') : emptyBox(t('files.noFilteredFiles'))}
      </div>
    </div>`;

  bind(ctx);
}

function platNameOf(id) {
  const m = { douyin: 'plat.douyin', bilibili: 'plat.bilibili', kuaishou: 'plat.kuaishou', huya: 'plat.huya', douyu: 'plat.douyu', xiaohongshu: 'plat.xiaohongshu', weibo: 'plat.weibo', acfun: 'plat.acfun' };
  return (m[id] && t(m[id])) || id || t('common.unknown');
}

function filenameRow({ f, s, tag }) {
  const playing = f.status === 'recording';
  const missing = f.status === 'missing';
  const icoCls = platformInfo(s.platform).cls;
  const extLabel = tag || (f.ext ? f.ext.toUpperCase() : 'TS');
  return `
    <div class="fl-item" style="align-items:flex-start" data-file="${esc(f.id)}">
      <input type="checkbox" class="cb" data-pick-file="${esc(f.id)}"${state.picked.has(f.id) ? ' checked' : ''} title="${t('files.selectThisFile')}" style="margin-top:6px" />
      <div class="fl-ico ${esc(icoCls)}">
        ${missing
          ? `<span class="th-ph">${esc(extLabel)}</span>`
          : `<span class="th-ph" style="display:none">${esc(extLabel)}</span><img class="tk-thumb" loading="lazy" src="/api/files/${esc(f.id)}/thumb" alt="" onerror="this.style.display='none';this.previousElementSibling.style.display=''" />`}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name || f.relPath || '—')}
          ${tag ? `<span class="chip">${esc(tag)}</span>` : ''}
          ${playing ? `<span class="chip wait" style="margin-left:6px"><i class="dot"></i>${t('common.recording')}</span>` : missing ? `<span class="chip err" style="margin-left:6px">${t('files.missing')}</span>` : `<span class="chip on" style="margin-left:6px"><i class="dot"></i>${t('common.recorded')}</span>`}
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:5px;font-size:11.5px;color:var(--txt-3);flex-wrap:wrap">
          ${platBadge(s.platform, s.platformName)}
          <span>${esc(s.streamer || t('common.unknownAnchor'))}</span>
          <span>${esc(formatDateTime(s.startedAt))}</span>
          <span>${esc(t('files.duration', esc(formatDuration(f.durationSec || s.durationSec || 0))))}</span>
          <span>${esc(formatBytes(f.bytes || 0))}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-file-act="play" data-id="${esc(f.id)}"${missing ? ' disabled' : ''}>${t('files.play')}</button>
        <a class="btn sm ghost" href="${esc(api.downloadUrl(f.id))}" download>${t('files.download')}</a>
        <button class="btn sm danger" data-file-act="delete" data-id="${esc(f.id)}"${playing || missing ? ' disabled' : ''}>${t('common.delete')}</button>
      </div>
    </div>`;
}

/* ---------- 交互 ---------- */

/* 让 date 输入框点击任意位置都能弹出日历（Chrome/Edge 默认只有点尾部图标才有反应） */
function bindDatePicker(input) {
  if (!input || typeof input.showPicker !== 'function') return;
  input.addEventListener('click', () => {
    try { input.showPicker(); } catch { /* 已聚焦或浏览器不支持，忽略 */ }
  });
}

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;

  /* 取消自动查询：输入只改草稿，点「查询」才应用，「清除」恢复默认（近 7 天） */
  const q = root.querySelector('#flQ');
  if (q) q.oninput = () => { state.q = q.value; };
  const plat = root.querySelector('#flPlat');
  if (plat) plat.onchange = () => { state.platform = plat.value; };
  const dateFrom = root.querySelector('#flDateFrom');
  if (dateFrom) {
    bindDatePicker(dateFrom);
    dateFrom.onchange = () => { state.dateFrom = dateFrom.value; };
  }
  const dateTo = root.querySelector('#flDateTo');
  if (dateTo) {
    bindDatePicker(dateTo);
    dateTo.onchange = () => { state.dateTo = dateTo.value; };
  }
  const ext = root.querySelector('#flExt');
  if (ext) ext.onchange = () => { state.ext = ext.value; };

  const queryBtn = root.querySelector('#flQuery');
  if (queryBtn) queryBtn.onclick = () => { commitFilters(); paint(ctx, true); };
  const clearBtn = root.querySelector('#flClear');
  if (clearBtn) clearBtn.onclick = () => { resetToDefaults(true); paint(ctx, true); };

  root.querySelectorAll('[data-pick-file]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) state.picked.add(cb.dataset.pickFile);
      else state.picked.delete(cb.dataset.pickFile);
      state.hash = '';
      paint(ctx, true);
    };
  });
  const selAll = root.querySelector('#flSelAll');
  if (selAll) selAll.onchange = () => {
    const list = filtered();
    if (selAll.checked) list.forEach(({ f }) => state.picked.add(f.id));
    else list.forEach(({ f }) => state.picked.delete(f.id));
    state.hash = '';
    paint(ctx, true);
  };

  const ref = root.querySelector('#flRefresh');
  if (ref) ref.onclick = () => { state.hash = ''; tick(ctx, true); };

  const del = root.querySelector('#flDelPicked');
  if (del) del.onclick = () => deleteFiles(Array.from(state.picked), ctx);

  root.querySelectorAll('[data-file-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const found = findFile(id);
      if (!found) { toast(t('files.recordNotFound'), 'warn'); return; }
      const act = btn.dataset.fileAct;
      if (act === 'play') {
        openPlayer(ctx, filePlayer(found.f, found.s, found.tag));
      } else if (act === 'delete') {
        if (found.f.status === 'recording') { toast(t('files.recordingCannotDelete'), 'warn'); return; }
        const toTrash = await trashEnabled();
        const tr = toTrash ? t('files.moveToTrash') : t('files.permanentDelete');
        confirmDialog({
          title: t('files.deleteFileTitle'), danger: true, ok: tr,
          text: toTrash
            ? t('files.deleteToTrashText', esc(found.f.name || t('files.thatFile')), esc(formatBytes(found.f.bytes || 0)))
            : t('files.deletePermanentText', esc(found.f.name || t('files.thatFile')), esc(formatBytes(found.f.bytes || 0))),
          onOk: async () => {
            try {
              const r = await api.filesDelete({ fileIds: [id] });
              toast((r && r.useTrash === false ? t('files.toastDeletedPermanent') : t('files.toastDeletedTrash')) + t('files.deletedCount', Number(r && r.movedToTrash) || 1));
              state.picked.delete(id);
              state.hash = '';
              await tick(ctx, true);
            } catch (e) { toast(e.message || t('files.deleteFailed'), 'err'); }
          },
        });
      }
    };
  });
}

function findFile(id) {
  for (const s of state.sessions) {
    let out = null;
    (s.segments || []).forEach((x) => { if (x.id === id) out = { f: x, s }; });
    (s.extras || []).forEach((x) => { if (x.id === id) out = { f: x, s, tag: x.kind === 'm4a' ? 'M4A' : x.kind === 'merged' ? '合并' : 'MP4' }; });
    if (s.mp4 && s.mp4.id === id) out = { f: s.mp4, s, tag: 'MP4' };
    if (s.merged && s.merged.id === id) out = { f: s.merged, s, tag: '合并' };
    if (out) return out;
  }
  return null;
}

function filePlayer(f, s, tag) {
  return {
    fileId: f.id,
    name: f.name || f.relPath || t('common.playback'),
    platform: s.platform,
    platformName: s.platformName,
    qualityLabel: s.qualityLabel || '—',
    kind: tag === 'M4A' ? 'audio' : (f.playMode === 'remux' ? 'remux' : (f.ext === 'mp4' || tag === 'MP4' || tag === '合并' ? 'direct' : 'remux')),
    segments: (s && s.segments) || [],
    session: s,
    onChanged: () => { state.hash = ''; },
  };
}

function deleteFiles(ids, ctx) {
  if (!ids.length) return;
  const rows = ids.map((id) => findFile(id)).filter(Boolean);
  let bytes = 0;
  rows.forEach(({ f }) => { bytes += Number(f.bytes) || 0; });
  trashEnabled().then((toTrash) => {
    const tr = toTrash ? t('files.moveToTrash') : t('files.permanentDelete');
    confirmDialog({
      title: t('files.deleteFileTitle'),
      danger: true,
      ok: tr,
      text: toTrash
        ? t('files.deleteToTrashSelected', ids.length, esc(formatBytes(bytes)))
        : t('files.deletePermanentSelected', ids.length, esc(formatBytes(bytes))),
      onOk: async () => {
        try {
          const r = await api.filesDelete({ fileIds: ids });
          toast((r && r.useTrash === false ? t('files.toastDeletedPermanent') : t('files.toastDeletedTrash')) + t('files.deletedCountBytes', Number(r && r.movedToTrash) || ids.length, esc(formatBytes(r && r.bytes != null ? r.bytes : bytes))));
          ids.forEach((id) => state.picked.delete(id));
          state.hash = '';
          await tick(ctx, true);
        } catch (e) { toast(e.message || t('files.deleteFailed'), 'err'); }
      },
    });
  }).catch(() => {
    toast(t('files.readTrashSettingFailed'), 'err');
  });
}

/* 读取「删除时移入回收站」开关（默认开） */
async function trashEnabled() {
  try { const s = await api.settings(); return s.deleteToTrash !== false; }
  catch { return true; }
}