/* LiveGrab · ui/_views_dashboard.frag.js —— 原型片段：对齐 app/web/views/dashboard.js
 *
 * 结构（与 production paint() 一一对应）：
 *   磁盘告警条（free < 20GB 才显示 .login-err.show）
 *   .ov-grid3：任务统计 / 今日统计 / 存储统计（platformStoreBlock 环形图 + diskSection）
 *   「正在录制」卡：recItem() 列表 + 全部暂停
 * 数据：D.status（= GET /api/status，形状见 app/server/scheduler.js status()）、D.tasks（LITE 任务）
 * 文案：app/web/i18n/zh-CN.json 原文照抄。
 * 本文件只返回 HTML 字符串：不绑定事件、不操作 DOM；按钮用 [data-act] / [data-open-task] 交给骨架委托。
 */

/* ---------- i18n（zh-CN 原文，格式串 {0} 按位替换） ---------- */
const ZH = {
  'dashboard.diskAlert': '⚠ 磁盘剩余 {0}，低于保留下限时会自动清理最旧的成品文件；录制中请及时清理空间。',
  'dashboard.taskStats': '任务统计',
  'dashboard.recording': '正在录制',
  'common.unitRoad': '路',
  'dashboard.statLive': '正在直播',
  'common.unitItem': '个',
  'common.monitorOnly': '仅监控',
  'common.queued': '排队中',
  'common.waiting': '等待开播',
  'dashboard.statConcur': '并发使用率',
  'dashboard.todayStats': '今日统计',
  'dashboard.todayDuration': '今日录制时长',
  'dashboard.totalDuration': '累计录制时长',
  'common.hour': '小时',
  'common.minute': '分',
  'common.minutes': '分钟',
  'dashboard.todayFiles': '今日新增文件',
  'dashboard.todayBytes': '今日已录大小',
  'dashboard.bandwidth': '实时带宽',
  'dashboard.storeStats': '存储统计',
  'dashboard.noFile': '暂无录制文件',
  'dashboard.platforms': '{0} 平台',
  'common.unknown': '未知',
  'dashboard.recordingHint': '{0} 路 · 分段写入中',
  'dashboard.pauseAll': '全部暂停',
  'dashboard.noRecording': '当前没有正在录制的任务',
  'common.unnamed': '未命名任务',
  'common.room': '房间 {0}',
  'seg.none': '不分段',
  'dashboard.writtenSeg': '第 {0} 段 · 已写 {1}',
  'dashboard.writtenSingle': '单文件 · 已写 {0}',
  'dashboard.singleFile': '单文件',
  'dashboard.currentSeg': '本段 {0}',
  'dashboard.segPerMin': '{0}/段',
  'common.hour': '小时',
  'common.seconds': '秒',
  'dashboard.diskRemain': '磁盘剩余',
  'dashboard.diskUsed': '已用',
  'dashboard.diskTotal': '共',
  'nav.trash': '回收站',
  'common.stopRecord': '停止录制',
  'dashboard.loadFailed': '无法读取总览数据（后端 /api/status 尚未返回）。稍后会自动重试。',
};

function t(key, ...args) {
  const s = ZH[key] != null ? ZH[key] : key;
  return String(s).replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : args[Number(i)]));
}

/* ---------- 渲染入口 ---------- */
export function renderDashboard(ctx, D, h) {
  // 与 production 一致：/api/status 未返回且任务为空 → 加载失败占位
  const status = (D && D.status) || null;
  const allTasks = (D && D.tasks) || [];
  if (!status && !allTasks.length) {
    return `<div class="card"><div class="card-b"><div class="empty">${h.esc(t('dashboard.loadFailed'))}</div></div></div>`;
  }

  const stats = (status && status.stats) || {};
  const disk = (status && status.disk) || {};
  const recording = (status && status.recording) || [];
  const monitorList = allTasks.filter((x) => x.monitorOnly);

  const recCount = num(stats.recordingCount, recording.length);
  const cap = num(stats.concurrencyCap, 8);
  const queuedCount = num(stats.queuedCount, ((status && status.queue) || []).length);
  const usedBytes = Number(disk.usedBytes) || 0;
  const totalBytes = Number(disk.totalBytes) || 0;
  const freeBytes = Number(disk.freeBytes) || Math.max(0, totalBytes - usedBytes);
  const trashBytes = Number(disk.trashBytes) || 0;
  const pstore = (status && status.platformStore) || [];
  const platformTotal = pstore.reduce((a, p) => a + (Number(p.bytes) || 0), 0);
  const bw = Number(stats.downSpeed) || 0;
  const bwText = bw > 8 * 1024 * 1024
    ? `${(bw / (8 * 1024 * 1024)).toFixed(1)} MB/s`
    : (bw > 0 ? `${Math.round(bw / (8 * 1024))} KB/s` : '0');
  const liveCount = allTasks.filter((x) => x.liveStatus === 'live').length;
  const waitNum = Number(stats.waitingCount) || 0;
  const usePct = recCount && cap ? Math.min(100, Math.round((recCount / cap) * 100)) : 0;
  const totalDurationSec = Number(stats.totalDurationSec) || 0;

  return `
    ${diskAlert(freeBytes, h)}
    <div class="ov-grid3">
      <div class="card">
        <div class="card-h"><h3>${h.esc(t('dashboard.taskStats'))}</h3></div>
        <div class="card-b ov-col">
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.recording'))}</div><div class="v">${recCount}<small>${h.esc(t('common.unitRoad'))}</small></div></div>
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.statLive'))}</div><div class="v">${liveCount}<small>${h.esc(t('common.unitItem'))}</small></div></div>
          <div class="ovstat"><div class="k">${h.esc(t('common.monitorOnly'))}</div><div class="v">${monitorList.length}<small>${h.esc(t('common.unitItem'))}</small></div></div>
          <div class="ovstat"><div class="k">${h.esc(t('common.queued'))}</div><div class="v">${queuedCount}<small>${h.esc(t('common.unitItem'))}</small></div></div>
          <div class="ovstat"><div class="k">${h.esc(t('common.waiting'))}</div><div class="v">${waitNum}<small>${h.esc(t('common.unitItem'))}</small></div></div>
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.statConcur'))}</div><div class="v"><span style="color:var(--ok);vertical-align:middle">${recCount}</span> <span style="color:var(--txt-2);vertical-align:middle">/</span> <span style="color:var(--err);vertical-align:middle">${cap}</span></div><div class="minibar"><i style="width:${usePct}%"></i></div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>${h.esc(t('dashboard.todayStats'))}</h3></div>
        <div class="card-b ov-col">
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.todayDuration'))}</div><div class="v">${todayDuration(stats.todayDurationSec, h)}</div></div>
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.totalDuration'))}</div><div class="v">${todayDuration(totalDurationSec, h)}</div></div>
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.todayFiles'))}</div><div class="v">${Number(stats.todayFiles) || 0}<small>${h.esc(t('common.unitItem'))}</small></div></div>
          <div class="ovstat"><div class="k">${h.esc(t('dashboard.todayBytes'))}</div><div class="v">${h.esc(h.fmtBytes(stats.todayBytes))}</div></div>
          <div class="ovstat ov-wide"><div class="k">${h.esc(t('dashboard.bandwidth'))}</div><div class="v">${h.esc(bwText)}</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>${h.esc(t('dashboard.storeStats'))}</h3><span class="hint">${h.esc(h.fmtBytes(platformTotal))}</span></div>
        <div class="card-b pkb">
          ${platformStoreBlock(pstore, h)}
          ${diskSection({ usedBytes, totalBytes, freeBytes, trashBytes }, h)}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${h.esc(t('dashboard.recording'))}</h3><span class="hint">${h.esc(t('dashboard.recordingHint', recCount))}</span><div class="spacer"></div>${recCount ? `<button class="btn sm ghost" data-act="pause-all">${h.esc(t('dashboard.pauseAll'))}</button>` : ''}</div>
      <div class="card-b" style="padding:0">
        ${recording.length ? recording.map((x) => recItem(x, h)).join('') : h.emptyBox(t('dashboard.noRecording'))}
      </div>
    </div>`;
}

/* ---------- 片段 ---------- */

function num(v, fallback) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : (fallback || 0);
}

/* 秒 → 「X 小时 Y 分」/「Y 分钟」（与 dashboard.js todayDuration 逐字一致） */
function todayDuration(sec, h) {
  const s = Number(sec) || 0;
  const hh = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (hh > 0) return `${hh}<small>${h.esc(t('common.hour'))}</small> ${m}<small>${h.esc(t('common.minute'))}</small>`;
  return `${m}<small>${h.esc(t('common.minutes'))}</small>`;
}

/* 存储分布：左侧环形 + 右侧平台图例，环形中心合计为红色（arcs 算法照 platformStoreBlock） */
function platformStoreBlock(pstore, h) {
  const total = (pstore || []).reduce((a, p) => a + (Number(p.bytes) || 0), 0);
  const list = (pstore || []).filter((p) => Number(p.bytes) > 0);
  if (!total || !list.length) {
    const empty = `<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="12"/><text x="50" y="54" text-anchor="middle" fill="var(--warn)" font-size="14" font-weight="700">0 B</text></svg>`;
    return `<div class="pkbody"><div class="pkdonut">${empty}</div><div class="pkleg pk-empty" style="justify-content:center">${h.esc(t('dashboard.noFile'))}</div></div>`;
  }
  const colors = ['#4f9cf7', '#34c77b', '#f2b93d', '#e0615d', '#9b6ff0', '#2bb3c0', '#f472b6', '#a3b0c2'];
  const R = 38;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = list.map((p, i) => {
    const frac = (Number(p.bytes) || 0) / total;
    const len = frac * C;
    const a = {
      color: colors[i % colors.length],
      dasharray: `${len.toFixed(3)} ${(C - len).toFixed(3)}`,
      dashoffset: (-offset).toFixed(3),
      name: h.esc(p.name || p.platform || t('common.unknown')),
      size: h.esc(h.fmtBytes(p.bytes)),
    };
    offset += len;
    return a;
  });
  const svg = `<svg viewBox="0 0 100 100" width="100" height="100">
    <circle cx="50" cy="50" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>
    ${arcs.map((a) => `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${a.color}" stroke-width="12" stroke-dasharray="${a.dasharray}" stroke-dashoffset="${a.dashoffset}" transform="rotate(-90 50 50)"/>`).join('')}
    <text x="50" y="47" text-anchor="middle" fill="var(--warn)" font-size="13" font-weight="700">${h.esc(h.fmtBytes(total))}</text>
    <text x="50" y="65" text-anchor="middle" fill="var(--txt-3)" font-size="8.5">${h.esc(t('dashboard.platforms', list.length))}</text>
  </svg>`;
  const leg = `<div class="pkleg">${arcs.slice(0, 10).map((a) => `<span><i style="background:${a.color}"></i><span style="overflow:hidden;text-overflow:ellipsis">${a.name}</span><b>${a.size}</b></span>`).join('')}</div>`;
  return `<div class="pkbody"><div class="pkdonut">${svg}</div>${leg}</div>`;
}

/* 磁盘告警：free < 20GB 才出现（当前 mock 剩余 518.9 GB → 不渲染任何节点） */
function diskAlert(free, h) {
  const limit = 20 * 1024 * 1024 * 1024;
  if (free > 0 && free < limit) {
    return `<div class="login-err show" style="margin:0 0 14px;display:flex"><span>${h.esc(t('dashboard.diskAlert', h.fmtBytes(free)))}</span></div>`;
  }
  return '';
}

/* 磁盘信息块：并入「存储统计」卡，显示剩余/已用/共/回收站 + 占用条 */
function diskSection({ usedBytes, totalBytes, freeBytes, trashBytes }, h) {
  const pct = totalBytes > 0 ? Math.min(100, Math.max(2, (usedBytes / totalBytes) * 100)) : 0;
  const low = freeBytes > 0 && freeBytes < 5 * 1024 * 1024 * 1024;
  return `
    <div class="pkdisk">
      <div class="dd"><span>${h.esc(t('dashboard.diskRemain'))} <b class="c-rem${low ? ' down' : ''}">${h.esc(h.fmtBytes(freeBytes))}</b></span><span>${h.esc(t('dashboard.diskUsed'))} <b class="c-used">${h.esc(h.fmtBytes(usedBytes))}</b></span><span>${h.esc(t('dashboard.diskTotal'))} <b>${h.esc(h.fmtBytes(totalBytes))}</b></span>${trashBytes ? `<span>${h.esc(t('nav.trash'))} <b class="c-trash">${h.esc(h.fmtBytes(trashBytes))}</b></span>` : ''}</div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    </div>`;
}

/* 正在录制的一行：缩略图占位 + 标题/平台/房间号/chip + 分段轨道 + 右侧时长与停止按钮 */
function recItem(x, h) {
  const quality = h.qualityLabelOf(x);
  const isAudio = x.quality === 'audio';
  const live = x.live || {};
  const segIndex = Number(live.segmentIndex || x.segmentIndex || 1);
  const segOf = segLabel(x, h);
  const total = segOf === 'none' ? 1 : Math.max(segIndex + 1, 6);
  const elapsed = Number(live.elapsedSec) || 0;
  const bytes = Number(live.bytes) || 0;
  const perSeg = Math.max(1, Math.round(elapsed / Math.max(1, segIndex)));
  const current = Math.max(0, elapsed - perSeg * (segIndex - 1));

  return `
    <div class="rec-item">
      <div class="thumb"><span class="th-ph">${isAudio ? 'AUDIO' : 'LIVE'}</span></div>
      <div class="rec-main">
        <div class="ttl">${h.esc(x.name || x.anchorName || t('common.unnamed'))}${x.title ? ' · ' + h.esc(x.title) : ''}</div>
        <div class="meta">
          ${h.platBadge(x.platform, x.platformName)}<span>${h.esc(t('common.room', x.roomId || '—'))}</span>
          <span class="chip">${h.esc(quality)}</span>
          <span class="chip">${segOf === 'none' ? h.esc(t('seg.none')) : h.esc(segOf)}</span>
          <span class="chip on"><i class="dot"></i>${segOf === 'none' ? h.esc(t('dashboard.writtenSingle', h.fmtBytes(bytes))) : h.esc(t('dashboard.writtenSeg', segIndex, h.fmtBytes(bytes)))}</span>
        </div>
        ${isAudio && segOf === 'none'
          ? `<div class="bar" style="width:100%"><i style="width:${Math.min(95, Math.max(4, Math.round((current / (60 * 60)) * 100)))}%"></i></div>`
          : h.segTrack(Math.max(0, segIndex - 1), segIndex - 1, total)}
      </div>
      <div class="rec-right">
        <div class="tm">${h.esc(h.fmtDur(elapsed))}</div>
        <div style="font-size:11px;color:var(--txt-3)">${segOf === 'none' ? h.esc(t('dashboard.singleFile')) : h.esc(t('dashboard.currentSeg', h.fmtDur(current)))}</div>
        <div class="acts" style="margin-top:7px">
          <button class="btn sm danger" data-act="stop" data-id="${h.esc(x.id)}">${h.esc(t('common.stopRecord'))}</button>
        </div>
      </div>
    </div>`;
}

/* 分段策略 chip 文案：不分段 / 按大小 · X GB / 「N 小时|N 分钟|N 秒」/段 */
function segLabel(x, h) {
  if (x.segmentMode === 'none') return 'none';
  if (x.segmentMode === 'size') return `按大小 · ${Math.round(((Number(x.segmentSizeMB) || 2048) / 1024) * 10) / 10} GB`;
  return t('dashboard.segPerMin', h.segDurText(x.segmentMinutes));
}
