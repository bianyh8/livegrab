/* ==========================================================================================
   LiveGrab · ui/_overlays.frag.js —— 弹窗类片段（任务弹窗 / 桌面播放器 / 删除确认 / 手机播放器）
   ------------------------------------------------------------------------------------------
   对齐 production（以代码为准，文案 1:1 取自 app/web/i18n/zh-CN.json）：
     · app/web/views/tasks.js  openTaskDialog() 的 footer 按钮分支、taskShell()、field()、
                               qualityHint()、namingHint()、segTableHtml()、resolvedCard()、QUALITY_CARDS
     · app/web/ui.js           openDialog()（.modal / .modal-h / .modal-b / .modal-f）、
                               confirmDialog()、openPlayer()（桌面播放器）、openMobilePlayer()（竖屏全屏）
     · app/web/app.css         .modal / .player / .pv-xx / .pv-mobile 的类名与排版
   导出：
     renderTaskModal(ctx, mode, D, h)   mode = 'new' | 'detail'
     renderPlayer(ctx, arg, D, h)       桌面播放器（整段塞进 #playerMask）
     renderConfirm(ctx, arg, D, h)      删除确认（整段塞进 #modalMask）
     renderMobilePlayer(ctx, arg, D, h) 手机全屏播放器（整段塞进 #playerMask）
   约定：骨架把返回值整体写进遮罩容器，因此这里只返回 .modal / .pv-mobile 本体，不自带 .mask。
        所有动态文本一律 h.esc()；无 <script>、无外部资源、无 document 访问。
   ========================================================================================== */

/* ---------- 文案（zh-CN.json 原文） ---------- */
const T = {
  /* 任务弹窗 */
  newTaskTitle: '新建录制任务',
  detailTitle: '任务详情',
  close: '关闭',
  cancel: '取消',
  resolve: '解析',
  pauseSegment: '暂停本段',
  stop: '停止',
  saveChanges: '保存修改',
  createTask: '创建任务',
  kSource: '直播地址',
  room: '房间号',
  anchorNameLabel: '主播名称',
  colQuality: '清晰度',
  namingTab: '命名规则',
  kPoll: '轮询规则',
  kReconnect: '重连次数',
  csvSegment: '分段策略',
  segMinutesLabel: '每段时长（秒）',
  segSizeLabel: '分段大小',
  autoRecordLabel: '开播自动录制',
  monitorOnlyLabel: '仅监控，不录制',
  monitorOn: '已开启仅监控：只监控直播状态，不会开始录制。',
  monitorOff: '关闭则按正常任务录制（使用全局命名与存储设置）。',
  urlEditTip: '粘贴直播间/分享链接自动识别并回填；编辑已有任务直接改地址即可',
  pasteUrlPh: '粘贴任意支持的平台直播间链接（自动识别平台），或先选平台再输入房间号',
  roomPh: '指定平台后填写',
  anchorPh: '解析后自动填充',
  namingExample: '示例：',
  qualityHint: '· 超标自动回退，文件名记真实档位',
  qualityFallback: '· 不可用时按回退顺序自动降档，文件名记真实档位',
  currentSessionNote: '· <b style="color:var(--warn)">本场沿用旧参数，下一场生效</b>',
  currentSel: '当前选择：',
  segNone: '不分段',
  segByTimeCard: '按时间分段',
  segBySize: '按文件大小',
  segHeader: '分段（{0}）',
  segIndex: '序号',
  segName: '文件名',
  segDuration: '时长',
  segSize: '体积',
  csvStatus: '状态',
  noSegs: '暂无分段记录（未开始录制或分段未入库）。',
  recording: '录制中',
  qOrigin: '原画', qOriginName: '原画 1080P60', qOriginKbps: '≈ 8000 kbps',
  qBluray: '蓝光', qBlurayName: '蓝光 1080P', qBlurayKbps: '≈ 6000 kbps',
  qUhd: '超清', qUhdName: '超清 720P', qUhdKbps: '≈ 3000 kbps',
  qHd: '高清', qHdName: '高清 540P', qHdKbps: '≈ 1500 kbps',
  qSd: '标清', qSdName: '标清 360P', qSdKbps: '≈ 800 kbps',
  qAudio: '仅音频', qAudioName: '仅音频 AAC 128k', qAudioKbps: '≈ 128 kbps',
  live: '直播中',
  notLive: '未直播',
  unknownAnchor: '未知主播',
  roomNoShort: '房号 {0}',
  onlineNow: '· 当前在线 {0}',
  segEarlyEnd: '提前结束',
  detail: '详情',
  /* 桌面播放器 */
  playback: '回放',
  remuxStreaming: '边转边播 · 不可拖动',
  directPlay: '直接播放 · 可拖动',
  srcM4A: '源：M4A（服务端转封装）',
  srcTSFLV: '源：TS/FLV（服务端 -c copy 转 fMP4）',
  srcDirect: '源：MP4 / M4A（直接播放）',
  browserPlayerHint: '浏览器内置播放器 · 不调用本机播放器、不依赖桌面环境',
  segments: '分段',
  segsHint: '（共 {0} 段；可单独播放任意分段，也可合并后整场回放）',
  playHint1: 'TS 片段由服务端 <span class="mono">ffmpeg -c copy</span> 边转边播、不落盘；成品 MP4 直接播放；正在录制的分段只播已写入的部分。若浏览器不支持所选音轨/编码，会给出明确提示而不是静默黑屏。<b>同时最多 {0} 路转封装回放</b>，超出会提示“{1}”；关闭播放器即释放；MP4 直放不受此限制。',
  playbackBusy: '当前回放较多，请稍后再试',
  copyDirectLink: '复制直链',
  remuxMp4: '转封装 MP4',
  mergeWhole: '合并整场',
  recorded: '已录完',
  togglePlay: '播放 / 暂停',
  mute: '静音',
  rate: '倍速',
  fitContain: '适应',
  fitFill: '铺满',
  rotate: '旋转画面',
  fullscreen: '全屏',
  switchOrient: '切换横屏 / 竖屏',
  /* 删除确认 */
  deleteFileTitle: '删除录制文件',
  moveToTrash: '移入回收站',
};

const QUALITY_CARDS = [
  { id: 'origin', labelKey: 'qOrigin', kbpsKey: 'qOriginKbps', crown: true },
  { id: 'bluray', labelKey: 'qBluray', kbpsKey: 'qBlurayKbps' },
  { id: 'uhd', labelKey: 'qUhd', kbpsKey: 'qUhdKbps' },
  { id: 'hd', labelKey: 'qHd', kbpsKey: 'qHdKbps' },
  { id: 'sd', labelKey: 'qSd', kbpsKey: 'qSdKbps' },
  { id: 'audio', labelKey: 'qAudio', kbpsKey: 'qAudioKbps' },
];
const QNAME = {
  origin: 'qOriginName', bluray: 'qBlurayName', uhd: 'qUhdName',
  hd: 'qHdName', sd: 'qSdName', audio: 'qAudioName',
};
/* 分段结束原因 → 徽标（timeout=按设定时长自然轮转，不显示） */
const SEG_END_TEXT = { reconnect: '断流重连', stopped: '提前收尾', offline: '主播下播', user: '手动停止' };

const pad = (n) => String(n).padStart(2, '0');
function fmtDateOf(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/* 开关（原型 h 未提供 switchEl，按 ui.js switchEl() 结构内联） */
function swEl(on, attrs) {
  return '<div class="switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" tabindex="0" ' + (attrs || '') + '><i></i></div>';
}
/* tasks.js field()：标签在控件上方，span=true 横跨整行 */
function field(label, ctl, sub, span) {
  return '<div' + (span ? ' style="grid-column:1/-1"' : '') + '>'
    + (label ? '<div style="font-size:12px;color:var(--txt-2);margin-bottom:6px">' + label + '</div>' : '')
    + ctl
    + (sub || '')
    + '</div>';
}
function optList(options, value, h) {
  return options.map((o) => {
    const v = typeof o === 'object' ? o.v : o;
    const label = typeof o === 'object' ? o.label : String(o);
    const extra = (typeof o === 'object' && o.extra) || '';
    return '<option value="' + h.esc(String(v)) + '"' + extra + (String(v) === String(value) ? ' selected' : '') + '>' + h.esc(label) + '</option>';
  }).join('');
}
const selF = (id, opts, val, cls, h) => '<select class="select' + (cls || '') + '" id="' + id + '">' + optList(opts, val, h) + '</select>';
const NUM_INLINE = (w) => 'max-width:' + (w || 100) + 'px';
function fmtOnline(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
  return String(v);
}

/* ==========================================================================================
   1. 任务弹窗（新建 / 详情）—— 对齐 tasks.js openTaskDialog() + taskShell()
   ========================================================================================== */
export function renderTaskModal(ctx, mode, D, h) {
  const isDetail = mode === 'detail';
  const task = isDetail ? (D.taskDetail || null) : null;
  const settings = D.settings || {};
  const naming = D.naming || {};
  const profiles = naming.profiles || [];
  const platforms = (D.platforms || []).filter((p) => p.enabled || (task && task.platform === p.id));
  const ov = (task && task.overrides) || {};

  const quality = ov.quality || settings.defaultQuality || 'origin';
  const segmentMode = ov.segmentMode || settings.defaultSegmentMode || 'time';
  const namingProfileId = ov.namingProfileId || naming.activeId || (profiles[0] || {}).id || '';
  const pollIntervalSec = Number((task && task.pollIntervalSec) || settings.pollIntervalSec || 60);
  const reconnectMax = Number(task && task.reconnectMax != null ? task.reconnectMax : (settings.reconnectMax || 5));
  const segmentMinutes = Number((task && task.segmentMinutes) || settings.defaultSegmentMinutes || 3600);
  const segmentSizeMB = Number((task && task.segmentSizeMB) || settings.defaultSegmentSizeMB || 2048);
  const autoRecord = task ? task.autoRecord !== false : true;
  const monitorOnly = task ? !!task.monitorOnly : !!settings.defaultMonitorOnly;
  const recording = !!(task && (task.status === 'recording' || task.status === 'stopping'));

  const displayRoom = task ? ((task.platform === 'douyin' && task.shortId) ? String(task.shortId) : String(task.roomId || '')) : '';
  const roomPh = task && task.platform === 'douyin' ? '抖音号 / 房间号 / 直播链接' : T.roomPh;

  /* 下拉选项（taskShell() 同源） */
  const platOpts = [{ v: '', label: '指定平台', extra: 'hidden' }].concat(platforms.map((p) => ({ v: p.id, label: p.name })));
  const pollOpts = [...new Set([30, 60, 120, 180, 300, pollIntervalSec || 60])].filter((v) => v > 0)
    .sort((a, b) => a - b).map((v) => ({ v: String(v), label: v + ' 秒' }));
  const rcNums = [3, 5, 8, 10];
  if (!rcNums.includes(reconnectMax)) rcNums.push(reconnectMax);
  const rcOpts = rcNums.slice().sort((a, b) => a - b).map((o) => ({ v: String(o), label: o + ' 次' }));
  const namingOpts = profiles.length ? profiles.map((p) => ({ v: p.id, label: p.name || p.id })) : [{ v: '', label: '（无命名配置）' }];
  const segOpts = [{ v: 'none', label: T.segNone }, { v: 'time', label: T.segByTimeCard }, { v: 'size', label: T.segBySize }];
  const segSizeOpts = [...new Set([1024, 2048, 4096, 8192, segmentSizeMB])].sort((a, b) => a - b)
    .map((m) => ({ v: String(m), label: (Math.round(m / 1024 * 10) / 10) + ' GB' }));

  /* 提示行：qualityHint() / namingHint() */
  const qualityHint = recording
    ? T.qualityFallback + T.currentSessionNote
    : T.currentSel + '<b style="color:var(--txt)">' + h.esc(T[QNAME[quality]] || quality) + '</b>' + T.qualityHint;
  const prof = profiles.find((x) => x.id === namingProfileId) || profiles[0] || {};
  const namingHint2 = prof && (prof.fnTemplate || prof.dirTemplate)
    ? T.namingExample + h.esc((prof.dirTemplate || '{平台}/{主播}/{日期}') + '-' + (prof.fnTemplate || '{日期}_{主播}_{序号}'))
    : '';

  /* ---- 分段表（segTableHtml()） ---- */
  const segs = (task && task.segments) || [];
  const segTable = !segs.length
    ? '<div class="note">' + T.noSegs + '</div>'
    : '<table>'
      + '<thead><tr><th style="width:70px">' + T.segIndex + '</th><th>' + T.segName + '</th><th>' + T.segDuration + '</th><th>' + T.segSize + '</th><th>' + T.csvStatus + '</th></tr></thead>'
      + '<tbody>' + segs.map((s) => '<tr>'
        + '<td class="mono" data-label="' + T.segIndex + '">' + String(s.segmentIndex || 0).padStart(3, '0') + '</td>'
        + '<td class="mono" style="font-size:12px;word-break:break-all" data-label="' + T.segName + '">' + h.esc(s.name || s.path || '—') + '</td>'
        + '<td data-label="' + T.segDuration + '">' + h.esc(h.fmtDur(s.durationSec || 0)) + '</td>'
        + '<td data-label="' + T.segSize + '">' + h.esc(h.fmtBytes(s.bytes || 0)) + '</td>'
        + '<td data-label="' + T.csvStatus + '">'
        + (s.status === 'recording'
          ? '<span class="chip wait"><i class="dot"></i>' + T.recording + '</span>'
          : h.esc(s.status || 'done'))
        + (s.endReason && s.endReason !== 'timeout'
          ? '<span class="chip warn" style="margin-left:6px">' + h.esc(SEG_END_TEXT[s.endReason] || T.segEarlyEnd) + '</span>'
          : '')
        + '</td></tr>').join('') + '</tbody></table>';

  /* ---- 解析结果卡（resolvedCard()） ---- */
  const live = task && task.liveStatus === 'live';
  const plat = h.platformInfo((task && task.platform) || '');
  const resolvedCard = isDetail && task
    ? '<div class="resolved">'
      + '<div class="avatar">' + h.esc(String(task.anchorName || '?').slice(0, 1)) + '</div>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
      + h.esc(task.anchorName || T.unknownAnchor)
      + '<span class="chip ' + (task.platform === 'douyin' ? 'dy' : task.platform === 'bilibili' ? 'bili' : '') + '">' + h.esc(task.platformName || plat.name) + '</span>'
      + (live ? '<span class="chip on"><i class="dot"></i>' + T.live + '</span>' : '<span class="chip wait"><i class="dot"></i>' + T.notLive + '</span>')
      + '</div>'
      + '<div style="font-size:11.5px;color:var(--txt-3);margin-top:3px">'
      + T.roomNoShort.replace('{0}', h.esc((task.platform === 'douyin' && task.shortId) ? task.shortId : (task.roomId || '—')))
      + (task.title ? ' · ' + h.esc(task.title) : '')
      + T.onlineNow.replace('{0}', h.esc(fmtOnline(12800)))
      + '</div>'
      + '</div></div>'
    : '';

  /* ---- body ---- */
  const body = '<div class="tk-grid3" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px">'
    + field(T.kSource,
      '<input class="input mono" id="edUrl" value="' + h.esc((task && task.sourceUrl) || '') + '" placeholder="' + T.pasteUrlPh + '" />',
      '<div class="hintline">' + T.urlEditTip + '</div>', true)
    + field('平台', selF('edPlat', platOpts, (task && task.platform) || '', (task && task.platform) ? '' : ' ph', h))
    + field(T.room, '<input class="input mono" id="edRoom" value="' + h.esc(displayRoom) + '" placeholder="' + roomPh + '" />')
    + field(T.anchorNameLabel, '<input class="input" id="edAnchor" value="' + h.esc((task && task.anchorName) || '') + '" placeholder="' + T.anchorPh + '" />')
    + field(T.colQuality,
      '<div class="mini-row" id="edQGrid" style="justify-content:flex-start">'
      + QUALITY_CARDS.map((q) => '<span class="mini' + (quality === q.id ? ' sel' : '') + '">' + (q.crown ? '★ ' : '') + T[q.labelKey] + '</span>').join('')
      + '</div>',
      '<div class="hintline" id="edQualityHint" title="' + h.esc(QUALITY_CARDS.map((q) => T[q.labelKey] + ' ' + T[q.kbpsKey]).join(' / ')) + '">' + qualityHint + '</div>', true)
    + field(T.namingTab, selF('edNaming', namingOpts, namingProfileId, '', h), '<div class="hintline" id="edNamingHint">' + namingHint2 + '</div>')
    + field(T.kPoll, selF('edPoll', pollOpts, String(pollIntervalSec), '', h))
    + field(T.kReconnect, selF('edReconnect', rcOpts, String(reconnectMax), '', h))
    + '</div>'

    + '<div class="tk-grid2" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px;margin-top:14px">'
    + field(T.csvSegment, selF('edSegMode', segOpts, segmentMode, '', h))
    /* 分段参数：按时间 → 每段时长；按大小 → 分段大小（production 两个单元格按模式显隐，这里用 display 对齐） */
    + '<div id="edSegParamCol"><div id="edSegMinCell" style="' + (segmentMode === 'time' ? '' : 'display:none') + '">'
    + field(T.segMinutesLabel,
      '<input class="input" id="edSegMin" type="number" min="1" step="1" value="' + segmentMinutes + '" />',
      '<div class="hintline">任意数字，单位秒，如 3600 = 1 小时</div>')
    + '</div><div id="edSegSizeCell" style="' + (segmentMode === 'size' ? '' : 'display:none') + '">'
    + field(T.segSizeLabel, '<div class="row" style="align-items:center;gap:8px"><select class="select f1" id="edSegSize">'
      + optList(segSizeOpts, String(segmentSizeMB), h) + '</select></div>')
    + '</div></div>'
    + field(T.autoRecordLabel, swEl(autoRecord, 'id="edAuto"'))
    + field(T.monitorOnlyLabel, swEl(monitorOnly, 'id="edMonitor"'),
      '<div class="hintline" id="edMonitorHint">' + (monitorOnly ? T.monitorOn : T.monitorOff) + '</div>')
    + '</div>'

    + (isDetail
      ? '<div class="sect"><span class="n">≡</span>' + T.segHeader.replace('{0}', segs.length) + '</div>' + segTable
      : '')
    + '<div id="edResolved">' + resolvedCard + '</div>';

  /* ---- footer（openTaskDialog 的按钮分支） ---- */
  const foot = '<div class="modal-f">'
    + '<button class="btn ghost" onclick="Proto.closeModal()">' + (isDetail ? T.close : T.cancel) + '</button>'
    + '<button class="btn" id="edResolve">' + T.resolve + '</button>'
    + (isDetail && task && task.status === 'recording'
      ? '<button class="btn">' + T.pauseSegment + '</button><button class="btn danger">' + T.stop + '</button>'
      : '')
    + '<button class="btn primary">' + (isDetail ? T.saveChanges : T.createTask) + '</button>'
    + '</div>';

  return '<div class="modal" style="width:min(620px,94vw)">'
    + '<div class="modal-h"><h3>' + (isDetail ? T.detailTitle + ' · ' + h.esc((task && task.id) || '') : T.newTaskTitle) + '</h3>'
    + '<span class="x" onclick="Proto.closeModal()">✕</span></div>'
    + '<div class="modal-b">' + body + '</div>'
    + foot
    + '</div>';
}

/* ==========================================================================================
   2. 桌面播放器（ui.js openPlayer() 的静态还原）—— 默认展示「边转边播」态
   ========================================================================================== */
export function renderPlayer(ctx, arg, D, h) {
  /* 取文件库中第 1 条 TS 录制中分段作为示例；找不到则退化为纯文案 */
  const files = D.files || [];
  const hit = files.find((x) => x.tag === 'TS') || {};
  const f = hit.f || {};
  const s = hit.s || {};
  const mode = 'remux';                     /* TS/FLV：服务端 -c copy 边转边播，不可拖动 */
  const name = f.name || '2026-10-20_雪衣容_原画_002.ts';
  const platformName = s.platformName || '抖音';
  const platform = s.platform || 'douyin';
  const qualityLabel = '原画 1080P60';
  const kind = 'remux';
  const segs = (D.taskDetail && D.taskDetail.segments) || [];
  const concurrency = Number(((D.status || {}).engine || {}).playConcurrency || 2);
  const total = Number(f.durationSec) || 2285;

  const modeChip = mode === 'remux'
    ? { cls: 'chip wait', text: T.remuxStreaming }
    : { cls: 'chip on', text: T.directPlay };
  const srcText = mode === 'remux' ? (kind === 'audio' ? T.srcM4A : T.srcTSFLV) : T.srcDirect;

  const segChips = segs.map((x) => {
    const idx = String(x.segmentIndex || 0).padStart(3, '0');
    if (x.status === 'recording') return '<span class="chip wait"><i class="dot"></i>' + idx + ' ' + T.recording + '</span>';
    const on = x.id === f.id;
    return '<span class="chip' + (on ? ' on' : '') + '">' + idx + ' ' + T.recorded + '</span>';
  }).join('');

  return '<div class="modal pv-modal" style="width:min(1000px,94vw)">'
    + '<div class="modal-h">'
    + '<h3 class="mono" style="font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + h.esc(name) + '</h3>'
    + '<span class="chip" style="margin-left:10px">' + h.esc(platformName) + '</span>'
    + '<span class="chip">' + h.esc(qualityLabel) + '</span>'
    + '<span class="' + modeChip.cls + '"><i class="dot"></i>' + h.esc(modeChip.text) + '</span>'
    + '<span class="x" onclick="Proto.closePlayer()">✕</span>'
    + '</div>'
    + '<div class="modal-b" style="padding:0">'
    /* 16:9 黑色舞台：居中的 ▶ 占位（真实实现是 <video>）。
       原型里整段弹窗要在一屏内看完，故舞台高度压到 46vh（production 是 68vh）。 */
    + '<div class="player" id="plBox" style="aspect-ratio:16/9;max-height:46vh">'
    + '<div class="pv-ico" style="width:74px;height:74px;border-radius:50%;display:grid;place-items:center;font-size:26px;color:rgba(255,255,255,.82);background:rgba(10,13,19,.55);border:1px solid rgba(255,255,255,.16)">▶</div>'
    + '<div class="pv-badge">' + h.esc(srcText) + '</div>'
    + '<div class="pv-hint">' + h.esc(T.browserPlayerHint) + '</div>'
    + '</div>'
    /* 控制条（pv-bar） */
    + '<div class="pv-bar" id="plBar">'
    + '<button class="pv-btn" title="' + T.togglePlay + '">⏯</button>'
    + '<span class="mono" style="font-size:11.5px;color:var(--txt-3)">' + h.fmtDur(0) + '</span>'
    + '<div class="pv-track" id="plTrack"><i id="plFill" style="width:0%"></i></div>'
    + '<span class="mono" style="font-size:11.5px;color:var(--txt-3)">' + h.fmtDur(total) + '</span>'
    + '<button class="pv-btn" title="' + T.mute + '">🔈</button>'
    + '<button class="pv-btn" title="' + T.rate + '">1.0x</button>'
    + '<button class="pv-btn" title="' + T.fitFill + '">' + T.fitContain + '</button>'
    + '<button class="pv-btn" title="' + T.rotate + '">⟳</button>'
    + '<button class="pv-btn" title="' + T.fullscreen + '">⛶</button>'
    + '</div>'
    /* 分段 + 回放说明 */
    + '<div class="pv-extra" style="padding:16px 20px">'
    + '<div style="font-size:12.5px;color:var(--txt-2)">' + T.segments
    + ' <span style="color:var(--txt-3)">' + T.segsHint.replace('{0}', segs.length) + '</span></div>'
    + '<div class="pv-segs">' + segChips + '</div>'
    + '<div class="hintline" style="margin-top:12px">'
    + T.playHint1.replace('{0}', concurrency).replace('{1}', T.playbackBusy)
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="modal-f">'
    + '<button class="btn ghost">' + T.copyDirectLink + '</button>'
    + '<button class="btn ghost">' + T.remuxMp4 + '</button>'
    + '<button class="btn ghost">' + T.mergeWhole + '</button>'
    + '<button class="btn primary" onclick="Proto.closePlayer()">' + T.close + '</button>'
    + '</div>'
    + '</div>';
}

/* ==========================================================================================
   3. 删除确认（ui.js confirmDialog() 的静态还原，src/files.js 删除文案）
   ========================================================================================== */
export function renderConfirm(ctx, arg, D, h) {
  const files = D.files || [];
  const hit = files.find((x) => x.f && x.f.status === 'done' && x.f.ext === 'ts') || files[0] || {};
  const f = hit.f || {};
  const name = f.name || '2026-10-19_阿澈Che_原画_001.ts';
  const size = h.fmtBytes(f.bytes || 0);
  const trashDays = Number(((D.settings || {}).trashRetentionDays) || 7);

  const text = '<div style="font-size:13px;line-height:1.9;color:var(--txt-2)">'
    + '将删除 <b class="mono">' + h.esc(name) + '</b>（' + h.esc(size) + '）并移入回收站 <span class="mono">/data/.trash</span>；'
    + '同名的刮削图片 / 描述（.jpg / .nfo）一并移入，可随时还原。'
    + '<div style="margin-top:8px;font-size:12px;color:var(--txt-3)">源 .ts 是否保留由「系统设置」决定，不在本次删除范围；回收站保留 '
    + trashDays + ' 天，可去「回收站」页还原。</div>'
    + '</div>';

  return '<div class="modal" style="width:min(320px,94vw)">'
    + '<div class="modal-h"><h3>' + T.deleteFileTitle + '</h3><span class="x" onclick="Proto.closeModal()">✕</span></div>'
    + '<div class="modal-b">' + text + '</div>'
    + '<div class="modal-f">'
    + '<button class="btn ghost" onclick="Proto.closeModal()">' + T.cancel + '</button>'
    + '<button class="btn danger" onclick="Proto.closeModal()">' + T.moveToTrash + '</button>'
    + '</div>'
    + '</div>';
}

/* ==========================================================================================
   4. 手机全屏播放器（ui.js openMobilePlayer() 的竖屏默认态）
   ========================================================================================== */
export function renderMobilePlayer(ctx, arg, D, h) {
  const files = D.files || [];
  const hit = files.find((x) => x.tag === 'TS') || {};
  const f = hit.f || {};
  const total = Number(f.durationSec) || 2285;

  const ICON_ORIENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="7.5" y="3.5" width="9" height="17" rx="2"/>'
    + '<path d="M4 9.5A8.5 8.5 0 0 1 18.5 6.5"/>'
    + '<path d="M18.5 2.5v4.5H14"/>'
    + '</svg>';

  /* 手机播放器：外层沿用骨架 .pv-mobile（position:relative;width:100%;height:100%），
     内联尺寸兜底，保证在 #playerMask 里铺满整屏（真实播放器同样铺满全屏）。 */
  return '<div class="pv-mobile" id="plBox" style="position:fixed;inset:0;width:100vw;height:100vh">'
    + '<div class="pv-stage" id="plStage">'
    /* 舞台中央播放占位（真实实现是 <video> 铺满） */
    + '<div class="pv-ico" style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none">'
    + '<div style="width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font-size:22px;color:rgba(255,255,255,.82);background:rgba(10,13,19,.5);border:1px solid rgba(255,255,255,.16)">▶</div>'
    + '</div>'
    /* 右上角关闭 */
    + '<div class="pv-mtools" id="plMBar">'
    + '<button class="pv-mbtn danger" onclick="Proto.closePlayer()" title="' + T.close + '">✕</button>'
    + '</div>'
    /* 底部控制条：进度 + 时间 + 倍速 + 横竖屏切换 */
    + '<div class="pv-mctl" id="plMCtl">'
    + '<div class="pv-mtrack" id="plMTrack"><i id="plMFill" style="width:0%"></i></div>'
    + '<div class="pv-mrow" style="position:relative;display:flex;align-items:center;gap:10px;width:100%">'
    + '<span class="mono">' + h.fmtDur(0) + '</span>'
    + '<span class="mono" style="color:rgba(255,255,255,.6)">' + h.fmtDur(total) + '</span>'
    /* 骨架的 .spacer 是 flex:1，而 .pv-mrow 会被父级拉伸：右侧按钮改成绝对定位对齐靠右，避免溢出 */
    + '<div style="position:absolute;right:0;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:8px">'
    + '<button class="pv-mbtn small" title="' + T.rate + '">1.0x</button>'
    + '<button class="pv-mbtn small ico" id="plOrient" title="' + T.switchOrient + '" aria-label="' + T.switchOrient + '">' + ICON_ORIENT + '</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div>';
}
