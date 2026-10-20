/* LiveGrab · ui/_views_tasks.frag.js —— 原型片段：对齐 app/web/views/tasks.js
 *
 * 结构（与 production paint() 一一对应）：
 *   .tq-toggle 折叠头（查询条件 + 当前条件摘要 + ▾ + 新建任务）
 *   .toolbar.tq 查询条件（默认折叠 display:none）
 *   .toolbar 批量条（已选 N 项 / 全选 / 1 任务 = 1 直播间 · 批量刷新·开始录制·停止录制·批量删除）
 *   .hintline 批量说明 + 自定义排序提示
 *   #tkTable 表格（勾选 / 任务·直播间 / 平台 / 直播状态 / 录制状态 / 清晰度 / 排序↑↓ / 操作）
 *   pagerHTML('tkPager', …)
 * 数据：D.tasks（serializeTask 形状）、D.platforms，查询状态见下方 QS。
 * 文案：app/web/i18n/zh-CN.json 原文照抄（注意 tasks.batchHint 内是半角引号 "…"）。
 * 本文件只返回 HTML 字符串：不绑定事件、不操作 DOM；按钮用 [data-open-task] / [data-new-task] 交给骨架委托。
 */

/* ---------- i18n（zh-CN 原文，格式串 {0} 按位替换） ---------- */
const ZH = {
  'tasks.filterTitle': '查询条件',
  'tasks.newTask': '＋ 新建任务',
  'tasks.searchPh': '搜索主播 / 房间号 / 标题…',
  'common.allPlatforms': '全部平台',
  'tasks.allLiveStatus': '全部直播状态',
  'tasks.live': '直播中',
  'tasks.notLive': '未直播',
  'tasks.allRecordStatus': '全部录制状态',
  'common.recording': '录制中',
  'common.stopping': '停止中',
  'common.paused': '已暂停',
  'common.queued': '排队中',
  'common.waiting': '等待开播',
  'common.completed': '已完成',
  'tasks.stopped': '已停止',
  'common.error': '错误',
  'common.idle': '待机',
  'common.unknown': '未知',
  'tasks.sortCustom': '自定义排序',
  'tasks.sortByCreated': '按创建时间排序',
  'tasks.sortByDuration': '按已录时长排序',
  'tasks.sortBySize': '按文件大小排序',
  'tasks.sortByStatus': '按状态排序',
  'tasks.sortDirTip': '排序方向（自定义排序为手动顺序，不受此控制）',
  'tasks.sortDesc': '倒序',
  'tasks.sortAsc': '顺序',
  'logs.export': '导出',
  'tasks.selected': '已选 {0} 项',
  'files.selectAll': '全选',
  'tasks.oneTaskTip': '1 任务 = 1 直播间；同一房间不允许两条启用任务',
  'tasks.batchRefresh': '批量刷新',
  'tasks.batchRefreshTip': '重新解析全部选中任务的主播信息（主播名/标题/头像/直播状态），不会自动开始录制',
  'tasks.batchStart': '开始录制',
  'common.stopRecord': '停止录制',
  'tasks.batchDelete': '批量删除',
  'tasks.batchHint': '批量操作单次上限 50 条；并发不足时部分成功，会明确告知"已启动 N 条、M 条进入排队"。删除默认只解除任务管理、不动已录文件。',
  'tasks.customSortHint': '当前为自定义排序：点击行尾 ↑ / ↓ 调整顺序（即实际任务执行顺序）。',
  'tasks.customSortTip': '排序下拉选「自定义排序」后，可手动调整任务顺序。',
  'logs.taskAll': '全部',
  'tasks.noFiltered': '没有符合筛选条件的任务',
  'tasks.noTasks': '还没有录制任务，点右上角「新建任务」添加第一个直播间',
  'tasks.colTask': '任务 / 直播间',
  'settings.pfColPlatform': '平台',
  'tasks.colLive': '直播状态',
  'tasks.colRecord': '录制状态',
  'tasks.colQuality': '清晰度',
  'tasks.colSort': '排序',
  'tasks.colOps': '操作',
  'common.unnamed': '未命名任务',
  'tasks.noTitle': '（暂无标题）',
  'tasks.sessionHeld': '本场已停',
  'tasks.sessionHeldTip': '已停止本场 · 下播前不再自动录制，下次开播照旧自动录制',
  'common.monitorOnly': '仅监控',
  'tasks.monitorOnlyTip': '该任务仅监控直播状态，不录制',
  'tasks.stoppedTip': '已停止录制，等你手动开始',
  'tasks.abnormal': '异常',
  'tasks.notRecorded': '未录制',
  'tasks.stopOnce': '停止本场',
  'tasks.stopOnceTip': '只停止本场录制，不改变自动录制配置，下次仍按系统配置运行',
  'tasks.recordOnce': '录制本场',
  'tasks.recordOnceTip': '只录制本场直播，不改变自动录制配置，下次仍按系统配置运行',
  'tasks.stopPermanentTip': '永久停止并关闭自动录制：以后开播不再自动录制',
  'tasks.startPermanentTip': '开启自动录制：本场及以后每次开播都自动录制',
  'tasks.monitorOnlyStartTip': '仅录制本场，不改变仅监控设置',
  'common.checkLive': '立即检测',
  'common.checkLiveTip': '立即检测该直播间是否已开播',
  'common.detail': '详情',
  'tasks.moveUp': '上移（上一优先级）',
  'tasks.moveDown': '下移',
};

function t(key, ...args) {
  const s = ZH[key] != null ? ZH[key] : key;
  return String(s).replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : args[Number(i)]));
}

/* 分页：与 production 一致，默认每页 10 条 */
const PAGE_SIZE = 10;

/* 原型查询状态：默认展示「自定义排序」以便评审看到排序 ↑↓ 列；筛选条件为空 → 摘要显示"全部" */
const QS = {
  q: '',
  platform: '',
  liveStatus: '',
  status: '',
  sort: 'custom',
  sortDir: 'desc',
  page: 1,
  pages: 1,
  selected: new Set(),
  filterOpen: false, // 查询条件默认折叠
};

/* 录制状态下拉：与 tasks.js paint() 的选项表逐项一致 */
const REC_STATUS_OPTS = [
  ['', 'tasks.allRecordStatus'],
  ['recording', 'common.recording'],
  ['stopping', 'common.stopping'],
  ['paused', 'common.paused'],
  ['queued', 'common.queued'],
  ['waiting', 'common.waiting'],
  ['completed', 'common.completed'],
  ['stopped', 'tasks.stopped'],
  ['error', 'common.error'],
];

const SORT_OPTS = [
  ['custom', 'tasks.sortCustom'],
  ['created', 'tasks.sortByCreated'],
  ['duration', 'tasks.sortByDuration'],
  ['size', 'tasks.sortBySize'],
  ['status', 'tasks.sortByStatus'],
];

/* 折叠箭头：production 用 ▴/▾ 字符，原型改用内联 SVG 折线（避免小字号下字形不可见） */
function arrowSVG(open) {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${open ? 180 : 0}deg);transition:transform .15s"><path d="M6 9l6 6 6-6"/></svg>`;
}

/* ---------- 渲染入口 ---------- */
export function renderTasks(ctx, D, h) {
  const tasks = (D && D.tasks) || [];
  const platforms = (D && D.platforms) || [];
  const platName = (id) => {
    const p = platforms.find((x) => x.id === id);
    return (p && p.name) || (h.platformInfo(id) || {}).name || String(id || '');
  };

  // 过滤（后端 /api/tasks 支持 q/platform/liveStatus/status，前端仅原型内演示）
  let list = tasks.slice();
  if (QS.platform) list = list.filter((x) => x.platform === QS.platform);
  if (QS.liveStatus) list = list.filter((x) => (x.liveStatus || '') === QS.liveStatus);
  if (QS.status) list = list.filter((x) => x.status === QS.status);
  if (String(QS.q || '').trim()) {
    const s = String(QS.q).trim().toLowerCase();
    list = list.filter((x) => `${x.anchorName || ''} ${x.title || ''} ${x.roomId || ''}`.toLowerCase().includes(s));
  }
  const total = list.length;
  QS.pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (QS.page > QS.pages) QS.page = QS.pages;
  // 自定义排序：数组顺序即执行顺序
  const pageList = list.slice((QS.page - 1) * PAGE_SIZE, (QS.page - 1) * PAGE_SIZE + PAGE_SIZE);
  const platformOptions = platforms.filter((p) => p.enabled || QS.platform === p.id);

  return `
    <div class="card">
      <div class="tq-toggle" id="tkFilterToggle" role="button">
        <span class="tq-title">${h.esc(t('tasks.filterTitle'))}</span>
        <span class="tq-summary">${filterSummary(h, platName)}</span>
        <span class="tq-arrow">${arrowSVG(QS.filterOpen)}</span>
        <div class="spacer"></div>
        <button class="btn sm primary" id="tkNew" data-new-task style="flex:0 0 auto">${h.esc(t('tasks.newTask'))}</button>
      </div>
      <div class="toolbar tq" id="tkFilterBar" style="${QS.filterOpen ? '' : 'display:none'}">
        <input class="input" id="tkQ" style="width:170px" placeholder="${h.esc(t('tasks.searchPh'))}" value="${h.esc(QS.q)}" />
        <select class="select" id="tkPlat" style="width:108px">
          <option value="">${h.esc(t('common.allPlatforms'))}</option>
          ${platformOptions.map((p) => `<option value="${h.esc(p.id)}"${QS.platform === p.id ? ' selected' : ''}>${h.esc(p.name)}</option>`).join('')}
        </select>
        <select class="select" id="tkLive" style="width:118px">
          ${[['', t('tasks.allLiveStatus')], ['live', t('tasks.live')], ['offline', t('tasks.notLive')]]
            .map(([v, label]) => `<option value="${v}"${QS.liveStatus === v ? ' selected' : ''}>${h.esc(label)}</option>`).join('')}
        </select>
        <select class="select" id="tkStatus" style="width:128px">
          ${REC_STATUS_OPTS.map(([v, key]) => `<option value="${v}"${QS.status === v ? ' selected' : ''}>${h.esc(t(key))}</option>`).join('')}
        </select>
        <select class="select" id="tkSort" style="width:138px">
          ${SORT_OPTS.map(([v, key]) => `<option value="${v}"${QS.sort === v ? ' selected' : ''}>${h.esc(t(key))}</option>`).join('')}
        </select>
        <select class="select" id="tkSortDir" style="width:80px" title="${h.esc(t('tasks.sortDirTip'))}">
          ${[['desc', t('tasks.sortDesc')], ['asc', t('tasks.sortAsc')]]
            .map(([v, label]) => `<option value="${v}"${QS.sortDir === v ? ' selected' : ''}>${h.esc(label)}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="tkExport">${h.esc(t('logs.export'))}</button>
      </div>
      <div class="toolbar" style="border-top:1px dashed var(--line);padding-top:12px">
        <span class="chip${QS.selected.size ? ' on' : ''}" id="tkSelChip"><i class="dot"></i>${h.esc(t('tasks.selected', QS.selected.size))}</span>
        <button class="btn sm ghost" id="tkSelAll">${h.esc(t('files.selectAll'))}</button>
        <span class="chip">${h.esc(t('tasks.oneTaskTip'))}</span>
        <div class="spacer"></div>
        <button class="btn sm" data-batch="refresh" title="${h.esc(t('tasks.batchRefreshTip'))}">${h.esc(t('tasks.batchRefresh'))}</button>
        <button class="btn sm" data-batch="start">${h.esc(t('tasks.batchStart'))}</button>
        <button class="btn sm" data-batch="stop">${h.esc(t('common.stopRecord'))}</button>
        <button class="btn sm danger" data-batch="delete">${h.esc(t('tasks.batchDelete'))}</button>
      </div>
      <div class="hintline" style="margin:0 0 12px 2px">${h.esc(t('tasks.batchHint'))}${h.esc(QS.sort === 'custom' ? t('tasks.customSortHint') : t('tasks.customSortTip'))}</div>
      <div id="tkTable">${table(pageList, total, platforms, h)}</div>
      ${h.pagerHTML('tkPager', QS.page, QS.pages, total)}
    </div>`;
}

/* 查询条件摘要（折叠头显示当前生效条件，无条件时显示"全部"） */
function filterSummary(h, platName) {
  const parts = [];
  if (String(QS.q || '').trim()) parts.push(t('tasks.searchPh') + '：' + String(QS.q).trim());
  if (QS.platform) parts.push(platName(QS.platform));
  if (QS.liveStatus === 'live') parts.push(t('tasks.live'));
  else if (QS.liveStatus === 'offline') parts.push(t('tasks.notLive'));
  else if (QS.liveStatus === 'unknown') parts.push(t('common.unknown'));
  if (QS.status) {
    const m = {
      recording: t('common.recording'), stopped: t('tasks.stopped'), queued: t('common.queued'),
      waiting: t('common.waiting'), completed: t('common.completed'), error: t('common.error'), idle: t('common.idle'),
    };
    if (m[QS.status]) parts.push(m[QS.status]);
  }
  if (QS.sort !== 'created' || QS.sortDir !== 'desc') {
    const s = {};
    SORT_OPTS.forEach(([v, key]) => { s[v] = t(key); });
    parts.push((s[QS.sort] || QS.sort) + (QS.sortDir === 'asc' ? ' ↑' : ' ↓'));
  }
  const text = parts.length ? parts.join(' · ') : t('logs.taskAll');
  // 摘要里含「自定义排序 ↓」等用户可见文本 → 整体过 esc
  return h.esc(text);
}

/* ---------- 表格 ---------- */
function table(list, total, platforms, h) {
  if (!list.length) return h.emptyBox(total ? t('tasks.noFiltered') : t('tasks.noTasks'));
  const head = `
    <thead><tr>
      <th style="width:34px"><input type="checkbox" class="cb" id="tkAll"${list.length && list.every((x) => QS.selected.has(x.id)) ? ' checked' : ''} /></th>
      <th>${h.esc(t('tasks.colTask'))}</th><th style="width:60px">${h.esc(t('settings.pfColPlatform'))}</th><th>${h.esc(t('tasks.colLive'))}</th><th>${h.esc(t('tasks.colRecord'))}</th><th>${h.esc(t('tasks.colQuality'))}</th>${QS.sort === 'custom' ? '<th style="width:46px">' + h.esc(t('tasks.colSort')) + '</th>' : ''}<th style="text-align:right">${h.esc(t('tasks.colOps'))}</th>
    </tr></thead>`;
  return `<table class="tk-tbl">${head}<tbody>${list.map((x, i) => row(x, i, platforms, h)).join('')}</tbody></table>`;
}

function row(item, pageIdx, platforms, h) {
  const p = platforms.find((x) => x.id === item.platform);
  const platName = (p && p.name) || item.platformName || item.platform;
  const checked = QS.selected.has(item.id) ? ' checked' : '';
  const isLive = item.liveStatus === 'live' || item.status === 'recording';
  // 头像规则：录制中显示录像首帧、未录制显示平台头像；原型不请求 /api/tasks/:id/thumb，
  // 一律用首字占位（.tk-ph），保持与 production 相同的 .tk-avatar 结构。
  const ph = h.esc(String(item.anchorName || item.name || '?').slice(0, 1));
  const rank = (QS.page - 1) * PAGE_SIZE + pageIdx + 1;

  return `<tr data-id="${h.esc(item.id)}">
    <td><input type="checkbox" class="cb" data-pick="${h.esc(item.id)}"${checked} /></td>
    <td>
      <div class="tk-cell">
        <div class="tk-avatar">
          <span class="tk-ph">${ph}</span>
          ${isLive ? '<span class="tk-live"><i></i>' + h.esc(t('tasks.live')) + '</span>' : ''}
        </div>
        <div class="tk-bio" style="min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h.esc(item.anchorName || item.name || t('common.unnamed'))}</div>
          <div class="sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h.esc(item.title || t('tasks.noTitle'))}</div>
        </div>
      </div>
    </td>
    <td data-label="${h.esc(t('settings.pfColPlatform'))}">${h.platIcon(item.platform, platName)}</td>
    <td data-label="${h.esc(t('tasks.colLive'))}">${liveStatusCell(item, h)}</td>
    <td data-label="${h.esc(t('tasks.colRecord'))}">${recStatusCell(item, h)}</td>
    <td data-label="${h.esc(t('tasks.colQuality'))}"><span class="chip">${h.esc(h.qualityLabelOf(item))}</span></td>
    ${QS.sort === 'custom' ? `<td data-label="${h.esc(t('tasks.colSort'))}">
      <div class="mvrow">
        <span class="rnk">${rank}</span>
        <button class="mvbtn" data-mv="up" data-id="${h.esc(item.id)}" title="${h.esc(t('tasks.moveUp'))}">↑</button>
        <button class="mvbtn" data-mv="down" data-id="${h.esc(item.id)}" title="${h.esc(t('tasks.moveDown'))}">↓</button>
      </div>
    </td>` : ''}
    <td><div class="acts">${rowActions(item, h).join('')}</div></td>
  </tr>`;
}

/* 状态拆为两列：直播状态（看播） + 录制状态（任务自身的录制工作流） */
function liveStatusCell(item, h) {
  const live = item.liveStatus === 'live' || item.status === 'recording';
  return live
    ? '<span class="chip on"><i class="dot"></i>' + h.esc(t('tasks.live')) + '</span>'
    : '<span class="chip off"><i class="dot"></i>' + h.esc(t('tasks.notLive')) + '</span>';
}

/* 分支顺序与 tasks.js 完全一致：录制中(含 stopping) → 本场已停 → 仅监控 → 已停止 → 异常 → 未录制
   注：production recStatusCell 对 stopping 也显示「录制中」脉冲点，此处保持一致 */
function recStatusCell(item, h) {
  const recording = ['recording', 'stopping'].includes(item.status);
  if (recording) return `<span class="pulse"><b></b>${h.esc(t('common.recording'))}</span>`;
  if (item.sessionHold) return `<span class="chip bili" title="${h.esc(t('tasks.sessionHeldTip'))}"><i class="dot"></i>${h.esc(t('tasks.sessionHeld'))}</span>`;
  if (item.monitorOnly) return `<span class="chip bili" title="${h.esc(t('tasks.monitorOnlyTip'))}"><i class="dot"></i>${h.esc(t('common.monitorOnly'))}</span>`;
  if (item.manualHeld || item.status === 'stopped') return `<span class="chip off" title="${h.esc(t('tasks.stoppedTip'))}"><i class="dot"></i>${h.esc(t('tasks.stopped'))}</span>`;
  if (item.status === 'error') return `<span class="chip err"><i class="dot"></i>${h.esc(t('tasks.abnormal'))}</span>`;
  return `<span class="chip"><i class="dot"></i>${h.esc(t('tasks.notRecorded'))}</span>`;
}

/** 是否正在录制（含收尾中） */
function isRecording(item) {
  return ['recording', 'stopping'].includes(item.status);
}

/** 本场按钮：录制中 → 'stop-once'；直播中且未录制 → 'record-once'；否则 null */
function sessionAction(item) {
  if (isRecording(item)) return 'stop-once';
  return item.liveStatus === 'live' ? 'record-once' : null;
}

/* 行操作：四条分支（录制中 / 直播中未录制 / 未直播）+ 详情按钮 */
function rowActions(item, h) {
  const id = h.esc(item.id);
  const acts = [];
  const recording = isRecording(item);
  const session = sessionAction(item);
  const permanentTip = item.autoRecord === false;
  if (recording) {
    if (session === 'stop-once') {
      acts.push(`<button class="btn sm danger" data-act="stop-once" data-id="${id}" title="${h.esc(t('tasks.stopOnceTip'))}">${h.esc(t('tasks.stopOnce'))}</button>`);
    }
    acts.push(permanentTip
      ? `<button class="btn sm danger" data-act="stop" data-id="${id}" title="${h.esc(t('tasks.stopPermanentTip'))}">${h.esc(t('common.stopRecord'))}</button>`
      : `<button class="btn sm danger" data-act="stop" data-id="${id}">${h.esc(t('common.stopRecord'))}</button>`);
  } else if (item.liveStatus === 'live') {
    if (session === 'record-once') {
      acts.push(`<button class="btn sm ok" data-act="record-once" data-id="${id}" title="${h.esc(t('tasks.recordOnceTip'))}">${h.esc(t('tasks.recordOnce'))}</button>`);
    }
    acts.push(permanentTip
      ? `<button class="btn sm ok" data-act="start" data-id="${id}" title="${h.esc(t('tasks.startPermanentTip'))}">${h.esc(t('tasks.batchStart'))}</button>`
      : `<button class="btn sm ok" data-act="start" data-id="${id}"${item.monitorOnly ? ' title="' + h.esc(t('tasks.monitorOnlyStartTip')) + '"' : ''}>${h.esc(t('tasks.batchStart'))}</button>`);
  } else {
    acts.push(`<button class="btn sm" data-act="check" data-id="${id}" title="${h.esc(t('common.checkLiveTip'))}">${h.esc(t('common.checkLive'))}</button>`);
  }
  acts.push(`<button class="btn sm ghost" data-act="detail" data-id="${id}" data-open-task>${h.esc(t('common.detail'))}</button>`);
  return acts;
}
