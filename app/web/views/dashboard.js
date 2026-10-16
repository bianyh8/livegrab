/* LiveGrab · views/dashboard.js —— 总览
   3 张统计卡（任务 / 当日 / 存储与磁盘，口径照 D2）＋ 正在录制（分段进度条 + 全部暂停/停止）。
   排队/等待开播/仅监控不在总览展示（2026-10-10 起移除任务状态卡，任务详情见任务管理页）。
   数据来自 GET /api/status。最近事件已并入「运行日志」页；磁盘只在统计卡里出现一次（不再有第二张磁盘卡）；
   引擎/ffmpeg 细节也不再在总览展示（见「运行日志」页）。 */

import { api } from '../api.js';
import { t as _t } from '../i18n.js';
import {
  esc, formatBytes, formatDuration,
  platBadge, segTrack, emptyBox, toast, qualityLabelOf, segDurText,
} from '../ui.js';

export const page = 'dashboard';

const state = { tasks: [], booted: false, pending: false, lastStatus: null };

let boundRoot = null;

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="stack"><div class="card"><div class="empty">${_t('dashboard.loading')}</div></div></div>`;
  ctx.onRefresh(() => tick(ctx));
  await tick(ctx, true);
}

export function destroy() { boundRoot = null; }

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    const [st, tk] = await Promise.allSettled([api.status(), api.tasks()]);
    const status = st.status === 'fulfilled' ? (st.value || {}) : null;
    if (tk.status === 'fulfilled') state.tasks = (tk.value && tk.value.items) || [];
    state.lastStatus = status;
    state.booted = true;
    paint(ctx, status);
  } finally {
    state.pending = false;
  }
}

function tasksOfType(type) {
  return state.tasks.filter((t) => t.status === type);
}

function paint(ctx, status) {
  const root = boundRoot;
  if (!root) return;
  if (!status && !state.tasks.length) {
    root.innerHTML = `<div class="card"><div class="card-b">
      <div class="empty">${_t('dashboard.loadFailed')}</div>
    </div></div>`;
    return;
  }
  const stats = (status && status.stats) || {};
  const disk = (status && status.disk) || {};
  const recording = (status && status.recording) || [];
  // 仅监控：从任务全量里筛出 monitorOnly，统计卡展示数量
  const monitorList = state.tasks.filter((t) => t.monitorOnly);

  const recCount = num(stats.recordingCount, recording.length);
  const cap = num(stats.concurrencyCap, ctx.limits.maxConcurrency);
  const queuedCount = num(stats.queuedCount, (status && status.queue || []).length);
  const usedBytes = Number(disk.usedBytes) || 0;
  const totalBytes = Number(disk.totalBytes) || 0;
  const freeBytes = Number(disk.freeBytes) || Math.max(0, totalBytes - usedBytes);
  const trashBytes = Number(disk.trashBytes) || 0;
  const pstore = (status && status.platformStore) || [];
  const platformTotal = pstore.reduce((a, p) => a + (p.bytes || 0), 0);
  const bw = Number(stats.downSpeed) || 0;
  const bwText = bw > 8 * 1024 * 1024 ? `${(bw / (8 * 1024 * 1024)).toFixed(1)} MB/s` : (bw > 0 ? `${Math.round(bw / (8 * 1024))} KB/s` : '0');
  const liveCount = state.tasks.filter((t) => t.liveStatus === 'live').length;
  const waitNum = Number(stats.waitingCount) || 0;
  const usePct = recCount && cap ? Math.round((recCount / cap) * 100) : 0;
  const totalDurationSec = Number(stats.totalDurationSec) || 0;

  root.innerHTML = `
    ${diskAlert(freeBytes)}
    <div class="ov-grid3">
      <div class="card">
        <div class="card-h"><h3>${_t('dashboard.taskStats')}</h3></div>
        <div class="card-b ov-col">
          <div class="ovstat"><div class="k">${_t('dashboard.recording')}</div><div class="v">${recCount}<small>${_t('common.unitRoad')}</small></div></div>
          <div class="ovstat"><div class="k">${_t('dashboard.statLive')}</div><div class="v">${liveCount}<small>${_t('common.unitItem')}</small></div></div>
          <div class="ovstat"><div class="k">${_t('common.monitorOnly')}</div><div class="v">${monitorList.length}<small>${_t('common.unitItem')}</small></div></div>
          <div class="ovstat"><div class="k">${_t('common.queued')}</div><div class="v">${queuedCount}<small>${_t('common.unitItem')}</small></div></div>
          <div class="ovstat"><div class="k">${_t('common.waiting')}</div><div class="v">${waitNum}<small>${_t('common.unitItem')}</small></div></div>
          <div class="ovstat"><div class="k">${_t('dashboard.statConcur')}</div><div class="v"><span style="color:var(--ok);vertical-align:middle">${recCount}</span> <span style="color:var(--txt-2);vertical-align:middle">/</span> <span style="color:var(--err);vertical-align:middle">${cap}</span></div><div class="minibar"><i style="width:${usePct}%"></i></div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>${_t('dashboard.todayStats')}</h3></div>
        <div class="card-b ov-col">
          <div class="ovstat"><div class="k">${_t('dashboard.todayDuration')}</div><div class="v">${todayDuration(stats.todayDurationSec)}</div></div>
          <div class="ovstat"><div class="k">${_t('dashboard.totalDuration')}</div><div class="v">${todayDuration(totalDurationSec)}</div></div>
          <div class="ovstat"><div class="k">${_t('dashboard.todayFiles')}</div><div class="v">${Number(stats.todayFiles) || 0}<small>${_t('common.unitItem')}</small></div></div>
          <div class="ovstat"><div class="k">${_t('dashboard.todayBytes')}</div><div class="v">${esc(formatBytes(stats.todayBytes))}</div></div>
          <div class="ovstat"><div class="k">${_t('dashboard.bandwidth')}</div><div class="v">${bwText}</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>${_t('dashboard.storeStats')}</h3><span class="hint">${esc(formatBytes(platformTotal))}</span></div>
        <div class="card-b pkb" style="padding:14px 14px 12px">
          ${platformStoreBlock(pstore)}
          ${diskSection({ usedBytes, totalBytes, freeBytes, trashBytes })}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>${_t('dashboard.recording')}</h3><span class="hint">${_t('dashboard.recordingHint', recCount)}</span><div class="spacer"></div>${recCount ? `<button class="btn sm ghost" data-act="pause-all">${_t('dashboard.pauseAll')}</button>` : ''}</div>
      <div class="card-b" style="padding:0">
        ${recording.length ? recording.map(recItem).join('') : emptyBox(_t('dashboard.noRecording'))}
      </div>
    </div>`;

  bind(root, ctx);
}

/* ---------- 片段 ---------- */

function num(v, fallback) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : (fallback || 0);
}

function todayDuration(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}<small>${_t('common.hour')}</small> ${m}<small>${_t('common.minute')}</small>`;
  return `${m}<small>${_t('common.minutes')}</small>`;
}

/* 存储分布：左侧环形 + 右侧平台文字，环形中心合计为红色 */
function platformStoreBlock(pstore) {
  const total = (pstore || []).reduce((a, p) => a + (p.bytes || 0), 0);
  const list = (pstore || []).filter((p) => p.bytes > 0);
  // 无录制文件也显示环形（空环），便于与磁盘信息同卡展示
  if (!total || !list.length) {
    const empty = `<svg viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="12"/><text x="50" y="54" text-anchor="middle" fill="var(--warn)" font-size="14" font-weight="700">0 B</text></svg>`;
    return `<div class="pkbody"><div class="pkdonut">${empty}</div><div class="pkleg pk-empty" style="justify-content:center">${_t('dashboard.noFile')}</div></div>`;
  }
  const colors = ['#4f9cf7', '#34c77b', '#f2b93d', '#e0615d', '#9b6ff0', '#2bb3c0', '#f472b6', '#a3b0c2'];
  const R = 38, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = list.map((p, i) => {
    const frac = (p.bytes || 0) / total;
    const len = frac * C;
    const a = {
      color: colors[i % colors.length],
      dasharray: `${len} ${C - len}`,
      dashoffset: -offset,
      name: esc(p.name || p.platform || _t('common.unknown')),
      size: esc(formatBytes(p.bytes)),
    };
    offset += len;
    return a;
  });
  const svg = `<svg viewBox="0 0 100 100" width="100" height="100">
    <circle cx="50" cy="50" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>
    ${arcs.map((a) => `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${a.color}" stroke-width="12" stroke-dasharray="${a.dasharray}" stroke-dashoffset="${a.dashoffset}" transform="rotate(-90 50 50)"/>`).join('')}
    <text x="50" y="47" text-anchor="middle" fill="var(--warn)" font-size="13" font-weight="700">${esc(formatBytes(total))}</text>
    <text x="50" y="65" text-anchor="middle" fill="var(--txt-3)" font-size="8.5">${_t('dashboard.platforms', list.length)}</text>
  </svg>`;
  const leg = `<div class="pkleg">${arcs.slice(0, 10).map((a) => `<span><i style="background:${a.color}"></i>${a.name}<b>${a.size}</b></span>`).join('')}</div>`;
  return `<div class="pkbody"><div class="pkdonut">${svg}</div>${leg}</div>`;
}

function diskAlert(free) {
  const limit = 20 * 1024 * 1024 * 1024;
  if (free > 0 && free < limit) {
    return `<div class="login-err show" style="margin:0 0 14px;display:flex"><span>⚠ ${_t('dashboard.diskAlert', esc(formatBytes(free)))}</span></div>`;
  }
  return '';
}

/* 磁盘信息块：并入「存储分布」卡，显示剩余/已用/回收站 + 占用条 */
function diskSection({ usedBytes, totalBytes, freeBytes, trashBytes }) {
  const pct = totalBytes > 0 ? Math.min(100, Math.max(2, (usedBytes / totalBytes) * 100)) : 0;
  const low = freeBytes > 0 && freeBytes < 5 * 1024 * 1024 * 1024;
  return `
    <div class="pkdisk">
      <div class="dd"><span>${_t('dashboard.diskRemain')} <b class="c-rem${low ? ' down' : ''}">${esc(formatBytes(freeBytes))}</b></span><span>${_t('dashboard.diskUsed')} <b class="c-used">${esc(formatBytes(usedBytes))}</b></span><span>${_t('dashboard.diskTotal')} <b>${esc(formatBytes(totalBytes))}</b></span>${trashBytes ? `<span>${_t('nav.trash')} <b class="c-trash">${esc(formatBytes(trashBytes))}</b></span>` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
}

function recItem(t) {
  const quality = qualityLabelOf(t);
  const isAudio = t.quality === 'audio';
  const live = t.live || {};
  const segIndex = Number(live.segmentIndex || t.segmentIndex || 1);
  const segOf = segLabel(t);
  const total = segOf === 'none' ? 1 : Math.max(segIndex + 1, 6);
  const elapsed = Number(live.elapsedSec || 0);
  const bytes = Number(live.bytes || 0);
  const perSeg = Math.max(1, Math.round(elapsed / Math.max(1, segIndex)));
  const current = Math.max(0, elapsed - perSeg * (segIndex - 1));

  return `
    <div class="rec-item">
      <div class="thumb">
        <span class="th-ph">${isAudio ? 'AUDIO' : 'LIVE'}</span>
        <img class="tk-thumb" loading="lazy" src="/api/tasks/${esc(t.id)}/thumb" alt="" onerror="this.style.display='none'" />
      </div>
      <div class="rec-main">
        <div class="ttl">${esc(t.name || t.anchorName || _t('common.unnamed'))}${t.title ? ' · ' + esc(t.title) : ''}</div>
        <div class="meta">
          ${platBadge(t.platform, t.platformName)}<span>${_t('common.room', esc(t.roomId || '—'))}</span>
          <span class="chip">${esc(quality)}</span>
          <span class="chip">${segOf === 'none' ? _t('seg.none') : esc(segOf)}</span>
          <span class="chip on"><i class="dot"></i>${segOf === 'none' ? _t('dashboard.writtenSingle', esc(formatBytes(bytes))) : _t('dashboard.writtenSeg', segIndex, esc(formatBytes(bytes)))}</span>
        </div>
        ${isAudio && segOf === 'none'
          ? `<div class="bar" style="width:100%"><i style="width:${Math.min(95, Math.max(4, Math.round((current / (60 * 60)) * 100)))}%"></i></div>`
          : segTrack(Math.max(0, segIndex - 1), segIndex - 1, total)}
      </div>
      <div class="rec-right">
        <div class="tm">${esc(formatDuration(elapsed))}</div>
        <div style="font-size:11px;color:var(--txt-3)">${segOf === 'none' ? _t('dashboard.singleFile') : _t('dashboard.currentSeg', esc(formatDuration(current))) /* current=本段已录秒数，仅用于时长 */}</div>
        <div class="acts" style="margin-top:7px">
          <button class="btn sm danger" data-act="stop" data-id="${esc(t.id)}">${_t('common.stopRecord')}</button>
        </div>
      </div>
    </div>`;
}

function segLabel(t) {
  if (t.segmentMode === 'none') return 'none';
  if (t.segmentMode === 'size') return _t('seg.bySize', Math.round((t.segmentSizeMB || 2048) / 1024 * 10) / 10);
  return _t('dashboard.segPerMin', segDurText(t.segmentMinutes));
}

/* ---------- 交互 ---------- */

function bind(root, ctx) {
  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      btn.disabled = true;
      try {
        if (act === 'pause') { await api.taskAction(id, 'pause'); toast(_t('tasks.pauseDone')); }
        else if (act === 'stop') { await api.taskAction(id, 'stop'); toast(_t('tasks.stopDone')); }
        else if (act === 'start') { await api.taskAction(id, 'start'); toast(_t('dashboard.startToast')); }
        else if (act === 'check') { await api.taskAction(id, 'check'); toast(_t('dashboard.checkToast')); }
        else if (act === 'pause-all') {
          const ids = tasksOfType('recording').map((t) => t.id);
          if (!ids.length) { toast(_t('dashboard.noRecording'), 'warn'); return; }
          const r = await api.batch('pause', ids);
          toast(_t('dashboard.pausedAll', (r && r.okIds ? r.okIds.length : ids.length)));
        } else if (act === 'detail') {
          ctx.openTaskModal(id);
          return;
        }
        ctx.invalidate('dashboard');
      } catch (e) {
        toast(e.message || _t('tasks.actionFail'), 'err');
      } finally {
        btn.disabled = false;
        if (act !== 'pause-all') await tick(ctx);
      }
    });
  });
}
