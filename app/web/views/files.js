/* LiveGrab · views/files.js —— 录制文件库
   按「视频文件」直接平铺显示，头部用 平台 / 主播 / 日期 等条件查询；不再有左侧树（全部场次 / 仅音频 / 回收站…）。
   回收站已独立为导航页「回收站」。删除走 POST /api/files/delete（默认进回收站，一并带走同名的刮削 .jpg/.nfo）。 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  esc, formatBytes, formatDuration, formatDateTime, platBadge, emptyBox,
  toast, confirmDialog, openPlayer, platformInfo, pagerHTML, bindPager,
} from '../ui.js';

const state = {
  rows: [],        // 当前页文件行（后端已拍平/过滤/分页）：{ f, s, tag }
  total: 0,
  bytes: 0,
  platforms: [],
  q: '',
  platform: '',
  dateFrom: '',
  dateTo: '',
  ext: '',
  /* 已生效的筛选条件（点「查询」才提交）；输入框草稿暂存在上面的 q/platform/dateFrom/dateTo/ext */
  filters: { q: '', platform: '', dateFrom: '', dateTo: '', ext: '' },
  defaultsSet: false,
  picked: new Set(),
  page: 1,
  pages: 1,
  hash: '',
  pending: false,
  bound: false,
};

/* 分页：默认每页 10 条（任务/文件/回收站统一） */
const PAGE_SIZE = 10;

let boundRoot = null;
let offFiles = null;   // SSE files 事件的退订函数
let offRefresh = null; // 2s 轮询回调的退订函数
let filesTimer = null; // 事件合并定时器（成串事件压成一次请求）

/* 头部「N 个视频 · X MB」的唯一拼装点：整表重绘与 patchSizes 共用，
   避免两处模板各自拼接、日后改文案时漂移。未转义：重绘走 esc()，局部更新走 textContent。 */
function bytesHint() {
  return `${t('files.videoCount', state.total)} · ${formatBytes(state.bytes)}`;
}

/* 默认查询区间：近 7 天（7 天前 → 今天） */
function defaultDateRange() {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(new Date(Date.now() - 7 * 864e5)), to: fmt(new Date()) };
}

/* 把输入框草稿提交为已生效筛选条件（「查询」按钮触发） */
function commitFilters() {
  state.filters = { q: state.q, platform: state.platform, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext };
  state.page = 1;
  state.hash = '';
}

/* 恢复默认查询条件（首次进入页面：默认近 7 天） */
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

/* 完全清空筛选条件（「清除」按钮触发）：关键词/平台/格式 + 日期范围全部清空 → 展示全部日期 */
function clearAllFilters(commit) {
  state.q = '';
  state.platform = '';
  state.ext = '';
  state.dateFrom = '';
  state.dateTo = '';
  state.page = 1;
  if (commit) commitFilters();
}

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('files.loadingLibrary')}</div></div>`;
  if (!state.bound) state.bound = true;
  if (!state.defaultsSet) resetToDefaults(true);
  if (offRefresh) { offRefresh(); offRefresh = null; }
  offRefresh = ctx.onRefresh(() => tick(ctx));
  // 服务端 SSE 的 files 事件：新分段落地 / 删除 / 回放产物生成 / 缺失标记都会推。
  // 收到就立即刷新，不必等下一次 2 秒轮询（轮询保留 —— SSE 断线重连期间靠它自愈）。
  // 事件常成串到来（一次扫描可能连发几条），250ms 合并成一次请求。
  if (offFiles) { offFiles(); offFiles = null; }
  offFiles = ctx.on('files', () => {
    if (filesTimer) clearTimeout(filesTimer);
    filesTimer = setTimeout(() => { filesTimer = null; void tick(ctx); }, 250);
  });
  await tick(ctx, true);
}

export function destroy() {
  if (offFiles) { offFiles(); offFiles = null; }
  if (offRefresh) { offRefresh(); offRefresh = null; }
  if (filesTimer) { clearTimeout(filesTimer); filesTimer = null; }
  boundRoot = null;
}

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    const r = await api.files({
      view: 'platform',
      page: state.page, pageSize: PAGE_SIZE,
      q: state.filters.q, platform: state.filters.platform,
      dateFrom: state.filters.dateFrom, dateTo: state.filters.dateTo, ext: state.filters.ext,
    });
    state.rows = (r && r.items) || [];
    state.total = Number((r && r.total) || 0);
    state.pages = Math.max(1, Number((r && r.pages) || 1));
    state.bytes = Number((r && r.bytes) || 0);
    if (r && Array.isArray(r.platforms)) state.platforms = r.platforms;
    paint(ctx, initial);
    // 整表没重绘时（内容指纹未变），把「大小」这类会持续增长的数字单独补上：
    // 指纹里不含字节数，录制中的分段在长大但总数不变 → 不补的话大小会停在旧值。
    patchSizes();
  } catch (e) {
    if (initial && boundRoot) boundRoot.innerHTML = `<div class="card"><div class="empty">${t('files.loadFailed', esc(e.message || t('common.unknownError')))}</div></div>`;
  } finally {
    state.pending = false;
  }
}

/* 只改「大小」这几个文本节点，不重建 DOM：不动搜索框焦点、不丢勾选、不跳滚动位置。 */
function patchSizes() {
  const root = boundRoot;
  if (!root || !root.isConnected) return;
  const head = root.querySelector('[data-files-bytes]');
  if (head) {
    const txt = bytesHint();
    if (head.textContent !== txt) head.textContent = txt;
  }
  const byId = new Map(state.rows.map((row) => [String(row.f.id), row]));
  for (const el of root.querySelectorAll('[data-file-size]')) {
    const row = byId.get(String(el.dataset.fileSize));
    if (!row) continue; // 这一行已不在当前页（翻页/筛选变了）：等下次整表重绘
    const txt = formatBytes(row.f.bytes || 0);
    if (el.textContent !== txt) el.textContent = txt;
  }
}

/* 拉取符合当前筛选的全量文件行（all=1 不分页）：
   用于跨页全选与批量删除统计。 */
async function fetchAllRows() {
  try {
    const r = await api.files({
      view: 'platform', all: 1,
      q: state.filters.q, platform: state.filters.platform,
      dateFrom: state.filters.dateFrom, dateTo: state.filters.dateTo, ext: state.filters.ext,
    });
    return (r && r.items) || [];
  } catch { return []; }
}

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  const list = state.rows; // 后端分页：当前页数据
  if (state.page > state.pages) state.page = state.pages;
  const allSel = list.length > 0 && list.every(({ f }) => state.picked.has(f.id));
  const hash = JSON.stringify([list.map(({ f, s }) => [f.id, f.status, s.platform, s.streamer, s.startedAt]),
    state.q, state.platform, state.dateFrom, state.dateTo, state.ext, Array.from(state.picked), 'p' + state.page, state.total]);
  if (!force && hash === state.hash) return;
  state.hash = hash;

  root.innerHTML = `
    <div class="card">
      <div class="card-h">
        <h3>${t('files.libraryTitle')}</h3>
        <span class="hint" data-files-bytes>${esc(bytesHint())}</span>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="flRefresh">${t('common.refresh')}</button>
      </div>
      <div class="toolbar" style="padding:10px 16px 12px;flex-wrap:wrap">
        <input class="input" id="flQ" style="width:180px" placeholder="${t('files.searchPlaceholder')}" value="${esc(state.q)}" />
        <select class="select" id="flPlat" style="width:120px">
          <option value="">${t('common.allPlatforms')}</option>
          ${state.platforms.map((p) => `<option value="${esc(p)}"${state.platform === p ? ' selected' : ''}>${esc(platNameOf(p))}</option>`).join('')}
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
      ${pagerHTML('flPager', state.page, state.pages, state.total)}
    </div>`;

  bind(ctx);
}

function platNameOf(id) {
  const m = { douyin: 'plat.douyin', bilibili: 'plat.bilibili', kuaishou: 'plat.kuaishou', huya: 'plat.huya', douyu: 'plat.douyu', xiaohongshu: 'plat.xiaohongshu', weibo: 'plat.weibo', acfun: 'plat.acfun' };
  return (m[id] && t(m[id])) || id || t('common.unknown');
}

function filenameRow({ f, s, tag }) {
  const playing = !!(s && s.status === 'recording');
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
          <span data-file-size="${esc(f.id)}">${esc(formatBytes(f.bytes || 0))}</span>
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

  /* 输入只改草稿，点「查询」才应用；「清除」完全清空（关键词/平台/格式/日期范围） */
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
  if (queryBtn) queryBtn.onclick = () => { commitFilters(); tick(ctx, true); };
  const clearBtn = root.querySelector('#flClear');
  if (clearBtn) clearBtn.onclick = () => { clearAllFilters(true); tick(ctx, true); };
  // 翻页需重新向后端请求对应页数据
  bindPager(root, 'flPager', state, () => { state.hash = ''; tick(ctx, true); });

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
    // 后端分页后「全选」应选中符合当前筛选的全部文件（跨页），需拉全量
    void (async () => {
      const rows = await fetchAllRows();
      if (selAll.checked) rows.forEach(({ f }) => state.picked.add(f.id));
      else rows.forEach(({ f }) => state.picked.delete(f.id));
      state.hash = '';
      paint(ctx, true);
    })();
  };

  const ref = root.querySelector('#flRefresh');
  if (ref) ref.onclick = () => { state.hash = ''; tick(ctx, true); };

  const del = root.querySelector('#flDelPicked');
  if (del) del.onclick = () => { void deleteFiles(Array.from(state.picked), ctx); };

  root.querySelectorAll('[data-file-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const found = findFile(id);
      if (!found) { toast(t('files.recordNotFound'), 'warn'); return; }
      const act = btn.dataset.fileAct;
      if (act === 'play') {
        openPlayer(ctx, filePlayer(found.f, found.s, found.tag));
      } else if (act === 'delete') {
        if (found.s && found.s.status === 'recording') { toast(t('files.recordingCannotDelete'), 'warn'); return; }
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
  // 仅当前页数据；跨页场景（批量删除统计）由 fetchAllRows 另行拉取
  for (const row of state.rows) {
    if (row.f.id === id) return row;
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

async function deleteFiles(ids, ctx) {
  if (!ids.length) return;
  // 选中可能跨页，统计需基于全量数据而非当前页
  const all = await fetchAllRows();
  const rows = ids.map((id) => all.find((r) => r.f.id === id)).filter(Boolean);
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