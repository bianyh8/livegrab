/* LiveGrab · views/files.js —— 录制文件库
   按「视频文件」直接平铺显示，头部用 平台 / 主播 / 日期 等条件查询；不再有左侧树（全部场次 / 仅音频 / 回收站…）。
   回收站已独立为导航页「回收站」。删除走 POST /api/files/delete（默认进回收站，一并带走同名的刮削 .jpg/.nfo）。 */

import { api } from '../api.js';
import { t } from '../i18n.js';
import {
  esc, formatBytes, formatDuration, formatDateTime, platBadge, emptyBox,
  toast, confirmDialog, openPlayer, platformInfo, pagerHTML, bindPager,
  captureFocus, restoreFocus,
} from '../ui.js';
import { openMergeDialog } from '../merge-dialog.js';

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
  filterOpen: false, // 查询条件默认收起（与任务管理一致）；点标题行展开/收起
  picked: new Set(),
  merging: new Set(), // 正在合并中的文件 id（行状态显示「合并中」，期间禁止再合并/删除）
  page: 1,
  pages: 1,
  hash: '',
  pending: false,
  /* 请求飞行中用户又点了翻页/筛选：不能静默丢弃，标记后由本轮 finally 再跑一次 */
  reloadQueued: false,
  reloadFull: false,
  bound: false,
};

/* 分页：默认每页 10 条（任务/文件/回收站统一） */
const PAGE_SIZE = 10;

let boundRoot = null;
let offFiles = null;   // SSE files 事件的退订函数
let offRefresh = null; // 2s 轮询回调的退订函数
let filesTimer = null; // 事件合并定时器（成串事件压成一次请求）
/* 搜索框防抖定时器提到模块级：destroy 里必须 clearTimeout，否则切页后 300ms 到点仍在旧视图上请求/重绘。 */
let searchTimer = null;

/* 头部「N 个视频 · X MB」的唯一拼装点：整表重绘与 patchSizes 共用，
   避免两处模板各自拼接、日后改文案时漂移。未转义：重绘走 esc()，局部更新走 textContent。 */
function bytesHint() {
  return `${t('files.videoCount', state.total)} · ${formatBytes(state.bytes)}`;
}

/* 默认查询区间：近 7 天（7 天前 → 今天） */function defaultDateRange() {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(new Date(Date.now() - 7 * 864e5)), to: fmt(new Date()) };
}

/* 把输入框草稿提交为已生效筛选条件（查询/筛选变更时触发）。
   同时清空勾选：换了条件后原勾选的文件可能已不在列表里，留着会被「删除所选」带走。 */
function commitFilters() {
  state.filters = { q: state.q, platform: state.platform, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext };
  state.page = 1;
  state.hash = '';
  // 筛选条件变了：旧勾选可能已不在结果集里，必须清空（翻页不清，见 bindPager）
  clearPicked();
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
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  boundRoot = null;
}

async function tick(ctx, full) {
  /* 请求未回来时用户又翻页/改筛选：老写法直接 return 会把这次点击静默丢掉（页码变了、列表不动）。
     改成脏标记，finally 里按最新 state 补跑一次。 */
  if (state.pending) { state.reloadQueued = true; state.reloadFull = state.reloadFull || !!full; return; }
  state.pending = true;
  state.reloadQueued = false;
  state.reloadFull = false;
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
    // full=true → 全量重绘（初始/筛选/折叠/勾选变化）；
    // full=false → 仅重绘结果区（搜索防抖/翻页/2s 轮询），不重建工具栏与搜索框，避免焦点丢失。
    if (full) paint(ctx, true); else paintResults(ctx);
    // 整表没重绘时（内容指纹未变），把「大小」这类会持续增长的数字单独补上：
    // 指纹里不含字节数，录制中的分段在长大但总数不变 → 不补的话大小会停在旧值。
    patchSizes();
  } catch (e) {
    if (full && boundRoot) boundRoot.innerHTML = `<div class="card"><div class="empty">${t('files.loadFailed', esc(e.message || t('common.unknownError')))}</div></div>`;
  } finally {
    state.pending = false;
    if (state.reloadQueued) {
      state.reloadQueued = false;
      const queuedFull = state.reloadFull;
      state.reloadFull = false;
      void tick(ctx, queuedFull);
    }
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

/* 结果区指纹：paint 与 paintResults 共用同一套判据，数据/筛选/勾选/翻页无变化时跳过重绘。
   指纹用「草稿值」（state.q/platform/…）——它们就是工具栏输入框里渲染出来的内容，
   与模板 value= 一一对应；filters 只是查询用的已提交副本（防抖后两者必然同步）。 */
function listHash() {
  const list = state.rows;
  return JSON.stringify([
    /* 行模板用到的字段都要进指纹。漏掉 f.name / s.segmentCount / s.merged / s.mp4 时，
       「改名」或「本场只剩一个文件」这类变化不会触发重绘 → 行上的时间与时长停在旧值
       （这正是刚修好的「分段行时间/时长」bug 的回归口）。字节数仍交给 patchSizes 局部补。 */
    list.map(({ f, s }) => [
      f.id, f.status, f.name, f.ext, f.segmentIndex,
      s.platform, s.streamer, s.startedAt, Number(s.segmentCount) || 0, !!s.merged, !!s.mp4,
      f.createdAt, f.durationSec]),
    state.q, state.platform, state.dateFrom, state.dateTo, state.ext,
    Array.from(state.picked), 'p' + state.page, state.total,
  ]);
}

/* 仅重绘结果区（文件列表 + 分页），不重建工具栏与搜索框。
   搜索输入防抖、翻页与全局 2s 轮询都走这里：避免重建 #flQ 导致焦点/光标丢失、
   中文输入法（IME）组合被打断（与任务管理同一套交互约定）。 */
function paintResults(ctx) {
  const root = boundRoot;
  if (!root) return;
  if (state.page > state.pages) state.page = state.pages;
  const list = state.rows;
  const hash = listHash();
  if (hash === state.hash) return;
  state.hash = hash;
  const focus = captureFocus(root);
  const body = root.querySelector('#flBody');
  if (body) body.innerHTML = list.length ? list.map(filenameRow).join('') : emptyBox(t('files.noFilteredFiles'));
  const pagerEl = root.querySelector('#flPager');
  if (pagerEl) pagerEl.outerHTML = pagerHTML('flPager', state.page, state.pages, state.total);
  bindRows(ctx);
  /* 翻页保留勾选：合并/删除需要跨页挑选（如同场次分段分布在多页）。
     只有筛选条件变化（commitFilters）才清空——那时行会离开结果集，留着会误删屏幕外的文件。 */
  bindPager(root, 'flPager', state, () => { state.hash = ''; tick(ctx, false); });
  syncPickedBar();
  restoreFocus(root, focus);
}

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  const list = state.rows; // 后端分页：当前页数据
  if (state.page > state.pages) state.page = state.pages;
  const allSel = list.length > 0 && list.every(({ f }) => state.picked.has(f.id));
  const hash = listHash();
  if (!force && hash === state.hash) return;
  state.hash = hash;
  const focus = captureFocus(root);

  root.innerHTML = `
    <div class="card">
      <!-- 标题行兼任查询条件折叠开关：一行里「录制文件库 + 数量说明 + 箭头」。与任务管理的
           折叠头同为「标题 + 说明 + 箭头」三段式，只是不另占一行（用户要的就是这一行的样式）。
           点整行收起/展开下面的筛选行；收起时只留这一行，列表紧接着往下排。 -->
      <div class="card-h fl-head" id="flFilterToggle" role="button" aria-expanded="${state.filterOpen ? 'true' : 'false'}">
        <h3>${t('files.libraryTitle')}</h3>
        <span class="hint" data-files-bytes>${esc(bytesHint())}</span>
        <div class="spacer"></div>
        <span class="tq-arrow">${state.filterOpen ? '▴' : '▾'}</span>
      </div>
      <div class="toolbar fl-filter" id="flFilterBar" style="${state.filterOpen ? '' : 'display:none'}">
        <input class="input" id="flQ" placeholder="${t('files.searchPlaceholder')}" value="${esc(state.q)}" />
        <select class="select" id="flPlat" style="width:120px">
          <option value="">${t('common.allPlatforms')}</option>
          ${state.platforms.map((p) => `<option value="${esc(p)}"${state.platform === p ? ' selected' : ''}>${esc(platNameOf(p))}</option>`).join('')}
        </select>
        <select class="select" id="flExt" style="width:120px">
          ${[['', 'files.allTypes'], ['ts', 'files.extTs'], ['mp4', 'files.extMp4'], ['m4a', 'files.extM4a']].map(([v, k]) => `<option value="${v}"${state.ext === v ? ' selected' : ''}>${t(k)}</option>`).join('')}
        </select>
        <div class="fl-range">
          <input type="date" class="fl-range-in" id="flDateFrom" title="${t('files.dateFrom')}" value="${esc(state.dateFrom)}" />
          <span class="fl-range-sep">${t('files.dateSep')}</span>
          <input type="date" class="fl-range-in" id="flDateTo" title="${t('files.dateTo')}" value="${esc(state.dateTo)}" />
        </div>
        <button class="btn sm ghost" id="flClear">${t('files.clearFilters')}</button>
      </div>
      <div class="fl-selbar">
        <label class="fl-selall"><input type="checkbox" class="cb" id="flSelAll"${allSel ? ' checked' : ''} /> ${t('files.selectAll')}</label>
        <span class="chip ${state.picked.size ? 'on' : ''}" id="flPickChip"><i class="dot"></i>${t('files.selectedCount', state.picked.size)}</span>
        ${state.picked.size && state.pages > 1 ? `<span class="fl-pick-keep">${t('files.pickedKeep')}</span>` : ''}
        <div class="spacer"></div>
        <div class="fl-actions">
          <button class="btn sm danger" id="flDelPicked"${state.picked.size && !state.merging.size ? '' : ' disabled'}>${t('files.deleteSelected')}</button>
          <button class="btn sm ok" id="flMergePicked"${state.picked.size >= 2 && !state.merging.size ? '' : ' disabled'}>${t('files.mergeFileBtn')}</button>
          <button class="btn sm ok" id="flScan">${t('files.scanDisk')}</button>
        </div>
      </div>
      <div style="padding:0 16px 16px" id="flBody">
        ${list.length ? list.map(filenameRow).join('') : emptyBox(t('files.noFilteredFiles'))}
      </div>
      ${pagerHTML('flPager', state.page, state.pages, state.total)}
    </div>`;

  bind(ctx);
  restoreFocus(root, focus);
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
  // 时间/时长按「这一行自己的文件」显示：
  // 分段行用 f.createdAt（该段真实开录时间），派生行（转封装/合并）才回落到场次开始时间。
  // 旧实现一律用 s.startedAt → 同一场次的 002/003/004 全显示同一个时间（19:35），看不出每段是几点录的。
  const isSegment = Number(f.segmentIndex) > 0;
  const rowTime = (isSegment ? f.createdAt : null) || s.startedAt || f.createdAt || '';
  // 时长只认本文件；文件自带时长为 0 时，仅当这场次只有这一个文件才回落场次总时长（否则会张冠李戴）
  const ownDur = Number(f.durationSec) || 0;
  const onlyFile = (Number(s.segmentCount) || 0) === 1 && !s.merged && !s.mp4;
  const durSec = ownDur || (onlyFile ? Number(s.durationSec) || 0 : 0);
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
          ${state.merging.has(f.id) ? `<span class="chip wait" style="margin-left:6px"><i class="dot"></i>${t('files.merging')}</span>` : playing ? `<span class="chip wait" style="margin-left:6px"><i class="dot"></i>${t('common.recording')}</span>` : missing ? `<span class="chip err" style="margin-left:6px">${t('files.missing')}</span>` : `<span class="chip on" style="margin-left:6px"><i class="dot"></i>${t('common.recorded')}</span>`}
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:5px;font-size:11.5px;color:var(--txt-3);flex-wrap:wrap">
          ${platBadge(s.platform, s.platformName)}
          <span>${esc(s.streamer || t('common.unknownAnchor'))}</span>
          <span>${esc(formatDateTime(rowTime))}</span>
          <span>${esc(t('files.duration', esc(formatDuration(durSec))))}</span>
          <span data-file-size="${esc(f.id)}">${esc(formatBytes(f.bytes || 0))}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-file-act="play" data-id="${esc(f.id)}"${missing || state.merging.has(f.id) ? ' disabled' : ''}>${t('files.play')}</button>
        <a class="btn sm ghost" href="${esc(api.downloadUrl(f.id))}" download>${t('files.download')}</a>
        <button class="btn sm danger" data-file-act="delete" data-id="${esc(f.id)}"${playing || missing || state.merging.has(f.id) ? ' disabled' : ''}>${t('common.delete')}</button>
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

  /* 点标题行收起/展开查询条件（与任务管理的折叠头同一套交互：箭头朝下=收起、朝上=展开）。
     只重绘本视图（paint），不重新请求：条件没变，数据也不用重拉。 */
  const filterToggle = root.querySelector('#flFilterToggle');
  if (filterToggle) filterToggle.onclick = () => { state.filterOpen = !state.filterOpen; paint(ctx, true); };

  /* 与任务管理一致：搜索框输入即查询（300ms 防抖，给足连续输入/中文组词时间），
     不再单独设「查询」按钮——草稿/提交两套状态本就重复，且「还没输完就查询」的体验也更顺。
     「清除」保留（清空关键词/平台/格式/日期范围）。「刷新」给 toast 反馈，避免点了不知道生效没。 */
  const q = root.querySelector('#flQ');
  if (q) {
    q.oninput = () => {
      state.q = q.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        commitFilters();
        /* 只重绘结果区（paintResults）：全量 paint 会重建 #flQ，把正在输入的中文组词（IME）打断、
           焦点与光标也一起丢。与任务管理/日志页同一套约定。 */
        tick(ctx, false);
      }, 300);
    };
  }
  const plat = root.querySelector('#flPlat');
  if (plat) plat.onchange = () => { state.platform = plat.value; commitFilters(); tick(ctx, true); };
  const dateFrom = root.querySelector('#flDateFrom');
  const dateTo = root.querySelector('#flDateTo');
  if (dateFrom) {
    bindDatePicker(dateFrom);
    dateFrom.onchange = () => {
      state.dateFrom = dateFrom.value;
      /* 选完开始日期后「无条件」把结束日期覆盖成同一个值（用户明确要求：同一天的起止区间最多），
         改完再单独去调结束日期即可把区间拉长。清空开始日期时不动结束日期。 */
      if (dateTo && state.dateFrom) {
        dateTo.value = state.dateFrom;
        state.dateTo = state.dateFrom;
      }
      commitFilters(); tick(ctx, true);
    };
  }
  if (dateTo) {
    bindDatePicker(dateTo);
    dateTo.onchange = () => { state.dateTo = dateTo.value; commitFilters(); tick(ctx, true); };
  }
  const ext = root.querySelector('#flExt');
  if (ext) ext.onchange = () => { state.ext = ext.value; commitFilters(); tick(ctx, true); };

  const clearBtn = root.querySelector('#flClear');
  if (clearBtn) clearBtn.onclick = () => {
    clearAllFilters(true);
    tick(ctx, true);
    toast(t('files.queryApplied'));
  };
  // 翻页需重新向后端请求对应页数据（走局部重绘，不重建工具栏/搜索框）。
  // 勾选跨页保留：用户要能「第 1 页选两个 + 第 2 页选一个」再合并；删除时 targets 仍按
  // 当前筛选结果过滤（fetchAllRows），屏幕外的行不会被误删。
  bindPager(root, 'flPager', state, () => { state.hash = ''; tick(ctx, false); });

  const selAll = root.querySelector('#flSelAll');
  if (selAll) selAll.onchange = () => {
    /* 全选只作用于当前页：勾上=把本页所有行加入选择集，取消=把本页所有行移出。
       其他页已选中的行保持不动（选择集按 id 记，跨页累积由用户自己逐个勾）。 */
    state.rows.forEach(({ f }) => { selAll.checked ? state.picked.add(f.id) : state.picked.delete(f.id); });
    state.hash = '';
    paint(ctx, true);
  };

  /* 扫描磁盘：真的走 POST /api/files/scan 重扫录制目录（重新登记未入库文件、标出缺失、
     顺带归位改名的文件），再整表刷新。不是「重新请求一次列表」——那个用翻页/筛选就会做。 */
  const scanBtn = root.querySelector('#flScan');
  if (scanBtn) scanBtn.onclick = async () => {
    if (scanBtn.disabled) return;
    scanBtn.disabled = true;
    const oldTxt = scanBtn.textContent;
    scanBtn.textContent = t('files.scanning');
    try {
      const r = await api.filesScan();
      state.hash = '';
      await tick(ctx, true);
      toast(t('files.scanDone',
        Number(r && r.added) || 0,
        Number(r && r.updated) || 0,
        Number(r && r.missing) || 0));
    } catch (e) {
      toast(t('files.scanFail', (e && e.message) || t('common.unknownError')), 'err');
    } finally {
      scanBtn.disabled = false;
      scanBtn.textContent = oldTxt; // 整表重绘后这个节点已被替换，赋值只为「未重绘」的异常分支兜底
    }
  };

  const del = root.querySelector('#flDelPicked');
  if (del) del.onclick = () => { void deleteFiles(Array.from(state.picked), ctx); };

  const mg = root.querySelector('#flMergePicked');
  if (mg) mg.onclick = () => { void mergeFiles(ctx); };

  bindRows(ctx);
}

/* 行内绑定（勾选框 / 播放 / 下载 / 删除）：全量 paint 与局部 paintResults 都会重建 #flBody，
   行内按钮需重新绑定，故单独抽出（与任务管理 bindTable 同一形态）。 */
function bindRows(ctx) {
  const root = boundRoot;
  if (!root) return;

  root.querySelectorAll('[data-pick-file]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) state.picked.add(cb.dataset.pickFile);
      else state.picked.delete(cb.dataset.pickFile);
      state.hash = '';
      syncPickedBar();
    };
  });

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

/* 清空勾选并同步 chip / 表头全选 / 行内勾选框（筛选、翻页、清除条件时调用）。 */
function clearPicked() {
  if (!state.picked.size) return;
  state.picked.clear();
  state.hash = '';
  syncPickedBar();
  const root = boundRoot;
  if (!root) return;
  root.querySelectorAll('[data-pick-file]').forEach((cb) => { cb.checked = false; });
  const all = root.querySelector('#flSelAll');
  if (all) { all.checked = false; all.indeterminate = false; }
}

/* 只更新「已选中 N 项 / 删除所选」这几个文本与可用态，不重建 DOM：
   勾选框在结果区（会随 paintResults 重建），但工具栏的选中计数要跟着变，
   这里单独同步，避免勾一个就整表重绘（勾选计数变了 → hash 变 → 必要时才重绘）。 */
function syncPickedBar() {
  const root = boundRoot;
  if (!root) return;
  const chip = root.querySelector('#flPickChip');
  if (chip) {
    chip.classList.toggle('on', state.picked.size > 0);
    chip.innerHTML = `<i class="dot"></i>${t('files.selectedCount', state.picked.size)}`;
  }
  const del = root.querySelector('#flDelPicked');
  if (del) del.disabled = state.picked.size === 0 || state.merging.size > 0;
  const mg = root.querySelector('#flMergePicked');
  if (mg) mg.disabled = state.picked.size < 2 || state.merging.size > 0;
  const selAll = root.querySelector('#flSelAll');
  if (selAll) {
    const list = state.rows;
    const pickedOnPage = list.filter(({ f }) => state.picked.has(f.id)).length;
    selAll.checked = list.length > 0 && pickedOnPage === list.length;
    selAll.indeterminate = pickedOnPage > 0 && pickedOnPage < list.length;
  }
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
  /* 勾选即契约：选中的就是用户要删的，跨页选中的同样删（不再按「当前筛选结果里可见」
     过滤——那会让翻页/筛选后的选择静默失效）。统计仍按全量数据取，当前页没有的行也能算准大小。 */
  const targets = Array.from(new Set(ids));
  const all = await fetchAllRows();
  const rows = targets.map((id) => all.find((r) => r.f.id === id)).filter(Boolean);
  let bytes = 0;
  rows.forEach(({ f }) => { bytes += Number(f.bytes) || 0; });
  trashEnabled().then((toTrash) => {
    const tr = toTrash ? t('files.moveToTrash') : t('files.permanentDelete');
    confirmDialog({
      title: t('files.deleteFileTitle'),
      danger: true,
      ok: tr,
      text: toTrash
        ? t('files.deleteToTrashSelected', targets.length, esc(formatBytes(bytes)))
        : t('files.deletePermanentSelected', targets.length, esc(formatBytes(bytes))),
      onOk: async () => {
        try {
          const r = await api.filesDelete({ fileIds: targets });
          toast((r && r.useTrash === false ? t('files.toastDeletedPermanent') : t('files.toastDeletedTrash')) + t('files.deletedCountBytes', Number(r && r.movedToTrash) || targets.length, esc(formatBytes(r && r.bytes != null ? r.bytes : bytes))));
          targets.forEach((id) => state.picked.delete(id));
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

/* 勾选合并：弹小框（merge-dialog.js）——按本列表现有顺序列出勾选的文件，
   可拖动调整顺序后再合并。顺序 = 文件列表展示顺序（fetchAllRows 返回后端 sortFileRows 稳定序），
   不用勾选顺序——勾选先后是用户操作痕迹，不代表「第 1、2、3 集」的播放顺序。 */
async function mergeFiles(ctx) {
  if (state.merging.size) return; // 已有合并在进行，按钮也已禁用，双保险
  const all = await fetchAllRows();
  const byId = new Map(all.map((r) => [r.f.id, r]));
  // 解包行包装：byId 里存的是 { f, s, tag }，文件字段在 .f 上（直接取 .name 会拿到 undefined）
  const rows = all.filter(({ f }) => state.picked.has(f.id));
  const seen = new Set(rows.map((r) => r.f.id));
  for (const id of state.picked) { const row = byId.get(id); if (row && !seen.has(id)) rows.push(row); } // 兜底：不在当前筛选结果里的勾选项
  if (rows.length < 2) { toast(t('files.mergeNeedTwo'), 'warn'); return; }

  // 客户端先做格式一致性预检，即时反馈；后端仍强校验
  const ext0 = String((rows[0].f && rows[0].f.ext) || '').toLowerCase();
  if (rows.some((r) => String((r.f && r.f.ext) || '').toLowerCase() !== ext0)) {
    toast(t('files.mergeMixedExt'), 'warn');
    return;
  }

  openMergeDialog({
    rows,
    ...(await mergeOptions()),
    onSubmit: (payload) => runMerge({ ...payload }, ctx),
  });
}

/* 合并弹框的两个与系统设置相关的初值：
   · deleteSources = 「合并后删除原始分段」（设置 → 录制），决定勾选框默认勾不勾
   · trashEnabled  = 「删除时移入回收站」（设置 → 存储），决定删源文案是「移入回收站」还是「直接删除」 */
async function mergeOptions() {
  try {
    const s = await api.settings();
    return { deleteSources: s.deleteAfterMerge !== false, trashEnabled: s.deleteToTrash !== false };
  } catch { return { deleteSources: true, trashEnabled: true }; }
}

/* 执行合并：标记「合并中」（行状态 + 禁用行内操作），成功后清掉已删源的勾选。
   返回 true 表示成功（弹框据此关闭），失败留在弹框便于原样重试。 */
async function runMerge({ ids, name, deleteSources }, ctx) {
  ids.forEach((id) => state.merging.add(id));
  paint(ctx, true); // 先亮「合并中」行状态（指纹不含合并态，须强制重绘）
  let ok = false;
  try {
    const r = await api.filesMergeSelected(ids, deleteSources, name);
    const outName = (r && r.item && r.item.name) || name || '';
    if (deleteSources) ids.forEach((id) => state.picked.delete(id)); // 全部源文件已移除
    toast(t('files.mergedDone') + (outName ? `：${outName}` : ''));
    ok = true;
  } catch (e) {
    toast(e.message || t('files.mergeFailed'), 'err');
  } finally {
    ids.forEach((id) => state.merging.delete(id));
    state.hash = '';
    await tick(ctx, true); // 成功/失败都复位重绘：状态还原、按钮恢复可用
  }
  return ok;
}