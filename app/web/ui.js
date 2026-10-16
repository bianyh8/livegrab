/* LiveGrab · ui.js
   视图共用的渲染工具：格式化、徽标、开关、toast、确认框、输入框弹窗、播放器弹窗。
   视觉类名全部来自 app.css（从 ui/index.html 抽取），不引入任何第三方资源。 */

import { t } from './i18n.js';

/* ================= 工具 ================= */

/** HTML 转义，所有插入模板的动态文本都必须过一遍 */
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 1.94 GB / 268 MB / 12.4 KB —— 与原型一致的体积格式 */
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '0 B';
  if (b < 1024) return b + ' B';
  const kb = b / 1024;
  if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
  const gb = mb / 1024;
  if (gb < 1024) return (gb < 10 ? gb.toFixed(2) : gb.toFixed(1)) + ' GB';
  const tb = gb / 1024;
  return (tb < 10 ? tb.toFixed(2) : tb.toFixed(1)) + ' TB';
}

/** 「12 小时 38 分」/「38 分 12 秒」 */
export function formatDurationCn(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h} ${t('common.hour')} ${m} ${t('common.minute')}`;
  if (m > 0) return `${m} ${t('common.minute')} ${ss} ${t('common.seconds')}`;
  return `${ss} ${t('common.seconds')}`;
}

/** 01:23:45 / 23:45 */
export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** 2025-06-01 20:13 */
export function formatDateTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 2025-06-01 */
export function formatDate(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 20:13 */
export function formatTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 2025-06-01 21:04:12.318 —— 日志行用的日期+毫秒级时间戳 */
export function formatLogTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 相对时间：「刚刚 / 12 分钟前 / 3 天前」 */
export function fromNow(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return t('common.justNow');
  if (diff < 3600) return t('common.minAgo', Math.floor(diff / 60));
  if (diff < 86400) return t('common.hrAgo', Math.floor(diff / 3600));
  return t('common.dayAgo', Math.floor(diff / 86400));
}

function toDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  const d = new Date(typeof ts === 'number' ? ts : String(ts));
  return isNaN(d.getTime()) ? null : d;
}

/* ================= 平台徽标 ================= */

/** platform id → { cls, letter, name }；cls 对应 app.css 里的 .plat.xx / .fl-ico.xx */
export const PLATFORMS = {
  douyin: { cls: 'dy', letter: '抖', name: t('plat.douyin') },
  bilibili: { cls: 'bili', letter: 'B', name: t('plat.bilibili') },
  kuaishou: { cls: 'ks', letter: '快', name: t('plat.kuaishou') },
  huya: { cls: 'huya', letter: '虎', name: t('plat.huya') },
  douyu: { cls: 'douyu', letter: '鱼', name: t('plat.douyu') },
  xiaohongshu: { cls: 'xhs', letter: '红', name: t('plat.xiaohongshu') },
  weibo: { cls: 'wb', letter: '微', name: t('plat.weibo') },
  acfun: { cls: 'ac', letter: 'A', name: t('plat.acfun') },
  cc: { cls: 'cc', letter: 'CC', name: t('plat.cc') },
  yy: { cls: 'yy', letter: 'YY', name: 'YY' },
  wechat: { cls: 'wx', letter: '视', name: t('plat.wechat') },
  more: { cls: 'more', letter: '＋', name: t('plat.more') },
};

export function platformInfo(id) {
  return PLATFORMS[id] || { cls: 'plain', letter: '?', name: id || t('plat.unknown') };
}

/** 平台分层代号 → 中文（stable/experimental/planned 等前台不得出现英文） */
const TIER_CN = { stable: t('tier.stable'), experimental: t('tier.experimental'), planned: t('tier.planned') };
export function tierName(tier) {
  if (!tier) return '';
  return TIER_CN[tier] || String(tier);
}

/** <span class="plat dy"><i>抖</i>抖音</span> */
export function platBadge(id, nameOverride) {
  const p = platformInfo(id);
  const name = nameOverride || p.name;
  return `<span class="plat ${esc(p.cls)}"><i>${esc(p.letter)}</i>${esc(name)}</span>`;
}

/** 平台图标（不带文字，名称折成悬停 title） */
export function platIcon(id, nameOverride) {
  const p = platformInfo(id);
  const name = nameOverride || p.name;
  return `<span class="plat ${esc(p.cls)}" style="cursor:help" title="${esc(name)}"><i>${esc(p.letter)}</i></span>`;
}

/* ================= 状态语义 ================= */

const STATUS_META = {
  idle: { text: t('common.idle'), chip: 'off' },
  waiting: { text: t('common.waiting'), chip: 'wait' },
  queued: { text: t('common.queued'), chip: 'wait' },
  recording: { text: t('common.recording'), chip: 'on' },
  stopping: { text: t('common.stopping'), chip: 'wait' },
  merging: { text: t('common.merging'), chip: 'wait' },
  completed: { text: t('common.completed'), chip: 'on' },
  stopped: { text: t('common.stopped'), chip: 'off' },
  error: { text: t('common.error'), chip: 'err' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { text: status || t('common.unknown'), chip: '' };
}

/** 任务状态单元格：脉冲点 / chip + 子行 */
export function statusCell(task) {
  const m = statusMeta(task.status);
  const sub = [];
  if (task.status === 'recording') {
    sub.push(`${formatDuration(task.live ? task.live.elapsedSec : 0)} · ${formatBytes(task.live ? task.live.bytes : 0)}`);
  } else if (task.status === 'queued') {
    sub.push(esc(task.queueReason || t('common.waitSlot')));
  } else if (task.status === 'error') {
    const max = task.retryMax || 5;
    sub.push(`${esc(task.lastError || task.statusMessage || t('common.unknownError'))}${t('ui.autoRetry', `${task.retryCount || 0}/${max}`)}`);
  } else if (task.status === 'waiting') {
    sub.push(t('common.pollSec', task.pollIntervalSec || 60));
  } else if (task.status === 'completed' || task.status === 'stopped') {
    if (task.endedAt) sub.push(t('ui.finishedAt', formatTime(task.endedAt), formatBytes(task.totalBytes || 0)));
  } else if (task.statusMessage) {
    sub.push(esc(task.statusMessage));
  }
  const head = task.status === 'recording'
    ? `<span class="pulse"><b></b>${m.text}</span>`
    : `<span class="chip ${esc(m.chip)}"><i class="dot"></i>${esc(m.text)}</span>`;
  return head + (sub.length ? `<div class="sub">${sub.join('')}</div>` : '');
}

export function qualityLabelOf(task) {
  return task.qualityLabel || task.qualityActual || task.quality || '—';
}

export function segmentStrategyText(task) {
  const mode = task.segmentMode || 'time';
  if (mode === 'none') return t('seg.none');
  if (mode === 'size') return t('seg.bySize', Math.round((task.segmentSizeMB || 2048) / 1024 * 10) / 10);
  return t('seg.byTime', segDurText(task.segmentMinutes));
}

/** 分段时长（秒）→ 可读文本：3600 → 1 小时，600 → 10 分钟，90 → 90 秒 */
export function segDurText(sec) {
  const n = Number(sec) || 3600;
  if (n >= 3600 && n % 3600 === 0) return `${n / 3600} ${t('common.hour')}`;
  if (n >= 60 && n % 60 === 0) return `${n / 60} ${t('common.minutes')}`;
  return `${n} ${t('common.seconds')}`;
}

/* ================= 小组件 ================= */

/** 分段进度条（已写完青色、当前段红色渐变、之后为空） */
export function segTrack(done, current, total) {
  const n = Math.max(1, Math.min(12, Number(total) || 6));
  let html = '';
  for (let i = 0; i < n; i++) {
    let cls = 'seg';
    if (i < done) cls += ' done';
    else if (i === current) cls += ' cur';
    html += `<i class="${cls}"></i>`;
  }
  return `<div class="seg-track">${html}</div>`;
}

/** 可点击切换的 .switch */
export function switchEl(on, attrs = '') {
  return `<div class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" tabindex="0" ${attrs}><i></i></div>`;
}

/** 空列表占位 */
export function emptyBox(text) {
  return `<div class="empty">${esc(text)}</div>`;
}

/* ================= toast ================= */

let toastTimer = null;
export function toast(msg, type) {
  const box = document.getElementById('toast');
  const tx = document.getElementById('toastTx');
  if (!box || !tx) return;
  tx.textContent = msg;
  const dot = box.querySelector('i');
  if (dot) {
    dot.style.background = type === 'err' ? 'var(--err)' : type === 'warn' ? 'var(--warn)' : 'var(--ok)';
  }
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}

/* ================= 确认框 / 输入框弹窗（共用 #modalMask） ================= */

/** confirmDialog({title,text,ok,danger,onOk}) */
export function confirmDialog({ title = t('common.confirm'), text = '', ok = t('common.ok'), cancel = t('common.cancel'), danger = false, onOk } = {}) {
  openDialog({
    title,
    body: `<div style="font-size:13px;line-height:1.9;color:var(--txt-2)">${text}</div>`,
    footer: (close) => {
      const b1 = el('button', 'btn ghost', cancel);
      const b2 = el('button', 'btn ' + (danger ? 'danger' : 'primary'), ok);
      b1.onclick = close;
      b2.onclick = () => { close(); if (typeof onOk === 'function') onOk(); };
      return [b1, b2];
    },
  });
}

/**
 * promptDialog({title,label,value,placeholder,multiline,ok,hint,onOk})
 * 用于收集 Cookie / 密码等文本输入（替代不稳定的原生 prompt）。
 */
export function promptDialog({ title = t('ui.promptTitle'), label = '', value = '', placeholder = '', multiline = false, rows = 6, ok = t('common.save'), hint = '', onOk } = {}) {
  openDialog({
    title,
    body: `<div class="form-row">
        ${label ? `<label class="fl">${esc(label)}</label>` : ''}
        ${multiline
          ? `<textarea class="input mono" rows="${rows}" placeholder="${esc(placeholder)}"></textarea>`
          : `<input class="input mono" value="${esc(value)}" placeholder="${esc(placeholder)}" />`}
        ${hint ? `<div class="hintline">${hint}</div>` : ''}
      </div>`,
    footer: (close, body) => {
      const input = body.querySelector('input,textarea');
      const b1 = el('button', 'btn ghost', t('common.cancel'));
      const b2 = el('button', 'btn primary', ok);
      b1.onclick = close;
      b2.onclick = () => {
        const v = input ? input.value.trim() : '';
        if (!v) { toast(t('ui.emptyContent'), 'warn'); return; }
        close();
        if (typeof onOk === 'function') onOk(v);
      };
      if (input) setTimeout(() => input.focus(), 30);
      return [b1, b2];
    },
  });
}

/** 通用弹窗骨架：body 传 HTML 字符串，footer 传 (close, bodyEl)=>[buttons] */
export function openDialog({ title = '', body = '', footer = null, wide = false, width = '' }) {
  const mask = document.getElementById('modalMask');
  if (!mask) return { close() {} };
  mask.innerHTML = '';
  const modal = el('div', 'modal');
  if (wide) modal.style.width = 'min(1000px,94vw)';
  if (width) modal.style.width = width;
  const head = el('div', 'modal-h');
  head.innerHTML = `<h3>${esc(title)}</h3><span class="x">✕</span>`;
  const bodyEl = el('div', 'modal-b');
  bodyEl.innerHTML = body;
  modal.appendChild(head);
  modal.appendChild(bodyEl);

  const close = () => {
    mask.classList.remove('show');
    mask.innerHTML = '';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  if (typeof footer === 'function') {
    const foot = el('div', 'modal-f');
    for (const btn of footer(close, bodyEl) || []) foot.appendChild(btn);
    modal.appendChild(foot);
  }
  head.querySelector('.x').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  mask.appendChild(modal);
  mask.classList.add('show');
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  return { close, body: bodyEl };
}

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ================= 播放器弹窗 ================= */

let playerState = null;
let playerCleanup = [];

/**
 * openPlayer(ctx, {fileId, name, platform, platformName, qualityLabel, kind, segments, session, onChanged})
 * kind: 'direct' | 'remux' | 'audio'
 */
export async function openPlayer(ctx, opts) {
  const mask = document.getElementById('playerMask');
  if (!mask) return;
  closePlayer();
  playerCleanup = [];

  const segs = Array.isArray(opts.segments) ? opts.segments : [];
  let info;
  try {
    info = await ctx.api.play(opts.fileId);
  } catch (e) {
    if (e.code === 'PLAY_BUSY') {
      toast(t('ui.playbackBusy'), 'warn');
      return;
    }
    toast(e.message || t('ui.playStartFail'), 'err');
    return;
  }
  const mode = info.mode || 'direct';
  const url = mode === 'remux' ? ctx.api.playStreamUrl(info.playId) : (info.url || ctx.api.streamUrl(opts.fileId));

  playerState = { playId: info.playId || null, fileId: opts.fileId };

  /* 手机（≤900px）：点播放直接进竖屏全屏，无中间页；全屏内可切横竖屏、可关闭（关闭退回文件页） */
  if (window.matchMedia('(max-width: 900px)').matches) {
    openMobilePlayer(ctx, opts, info, mode, url);
    return;
  }

  const modeChip = mode === 'remux'
    ? { cls: 'chip wait', text: t('ui.remuxStreaming') }
    : { cls: 'chip on', text: t('ui.directPlay') };
  const srcText = mode === 'remux'
    ? (opts.kind === 'audio' ? t('ui.srcM4A') : t('ui.srcTSFLV'))
    : t('ui.srcDirect');

  mask.innerHTML = `
    <div class="modal pv-modal" style="width:min(1000px,94vw)">
      <div class="modal-h">
        <h3 class="mono" style="font-size:13.5px">${esc(opts.name || t('common.playback'))}</h3>
        <span class="chip" style="margin-left:10px">${esc(opts.platformName || platformInfo(opts.platform).name)}</span>
        <span class="chip">${esc(opts.qualityLabel || '—')}</span>
        <span class="${modeChip.cls}" id="plMode"><i class="dot"></i>${esc(modeChip.text)}</span>
        <span class="x" id="plClose">✕</span>
      </div>
      <div class="modal-b" style="padding:0">
        <div class="player" id="plBox">
          <video id="plVideo" src="${esc(url)}" playsinline class="pv-video"></video>
          <div class="pv-badge" id="plSrc">${esc(srcText)}</div>
          <div class="pv-hint">${esc(t('ui.browserPlayerHint'))}</div>
          <span class="pv-x" id="plX2">✕</span>
        </div>
        <div class="pv-bar" id="plBar">
          <button class="pv-btn" id="plToggle" title="播放 / 暂停">⏯</button>
          <span class="mono" style="font-size:11.5px;color:var(--txt-3)" id="plNow">00:00</span>
          <div class="pv-track" id="plTrack"><i id="plFill" style="width:0%"></i></div>
          <span class="mono" style="font-size:11.5px;color:var(--txt-3)" id="plTotal">--:--</span>
          <button class="pv-btn" id="plMute" title="静音">🔈</button>
          <button class="pv-btn" id="plRate" title="倍速">1.0x</button>
          <button class="pv-btn" id="plFit" title="${esc(t('ui.fitFill'))}">${esc(t('ui.fitContain'))}</button>
          <button class="pv-btn" id="plRotate" title="${esc(t('ui.rotate'))}">⟳</button>
          <button class="pv-btn" id="plFull" title="${esc(t('ui.fullscreen'))}">⛶</button>
        </div>
        <div class="pv-extra" style="padding:16px 20px">
          ${segs.length ? `<div style="font-size:12.5px;color:var(--txt-2)">${t('ui.segments')} <span style="color:var(--txt-3)">${t('ui.segsHint', segs.length)}</span></div>
          <div class="pv-segs">${segs.map((s) => {
            const idx = String(s.segmentIndex || 0).padStart(3, '0');
            const cls = s.status === 'recording' ? 'chip wait' : (s.id === opts.fileId ? 'chip on' : 'chip');
            return `<span class="${cls}" data-seg="${esc(s.id)}" style="cursor:pointer">${s.status === 'recording' ? '<i class="dot"></i>' : ''}${idx} ${s.status === 'recording' ? t('common.recording') : t('common.recorded')}</span>`;
          }).join('')}</div>` : ''}
          <div class="hintline" style="margin-top:12px">${t('ui.playHint', 2, t('ui.playbackBusy'))}</div>
        </div>
      </div>
      <div class="modal-f">
        <button class="btn ghost" id="plCopy">${esc(t('ui.copyDirectLink'))}</button>
        ${opts.kind === 'direct' ? '' : `<button class="btn ghost" id="plRemux">${esc(t('ui.remuxMp4'))}</button>
        <button class="btn ghost" id="plMerge">${esc(t('ui.mergeWhole'))}</button>`}
        <button class="btn primary" id="plClose2">${esc(t('common.close'))}</button>
      </div>
    </div>`;

  mask.classList.add('show');
  document.body.style.overflow = 'hidden';
  mask.onclick = (e) => { if (e.target === mask) closePlayer(); };

  const video = mask.querySelector('#plVideo');
  const fill = mask.querySelector('#plFill');
  const nowEl = mask.querySelector('#plNow');
  const totalEl = mask.querySelector('#plTotal');
  const rateBtn = mask.querySelector('#plRate');
  const muteBtn = mask.querySelector('#plMute');
  const rates = [1, 1.5, 2, 0.5];
  let rateIdx = 0;

  const sync = () => {
    nowEl.textContent = formatDuration(video.currentTime || 0);
    if (isFinite(video.duration) && video.duration > 0) {
      totalEl.textContent = formatDuration(video.duration);
      fill.style.width = Math.min(100, (video.currentTime / video.duration) * 100) + '%';
    } else {
      totalEl.textContent = '--:--';
    }
  };
  video.ontimeupdate = sync;
  video.onloadedmetadata = sync;
  video.onerror = () => toast(t('ui.playUnsupported'), 'err');

  mask.querySelector('#plToggle').onclick = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
  video.onclick = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
  muteBtn.onclick = () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? '🔇' : '🔈'; };
  rateBtn.onclick = () => { rateIdx = (rateIdx + 1) % rates.length; video.playbackRate = rates[rateIdx]; rateBtn.textContent = rates[rateIdx].toFixed(1) + 'x'; };

  const playerEl = mask.querySelector('#plBox');
  const pvBar = mask.querySelector('#plBar');

  /* ---- 画面自适应：适应（contain，不变形）↔ 铺满（fill，拉伸） ---- */
  const fitBtn = mask.querySelector('#plFit');
  let fit = false;
  const setFit = (f) => {
    fit = f;
    video.style.objectFit = fit ? 'fill' : 'contain';
    fitBtn.textContent = fit ? t('ui.fitFill') : t('ui.fitContain');
    fitBtn.title = fit ? t('ui.fitContain') : t('ui.fitFill');
  };
  setFit(false);
  fitBtn.onclick = () => setFit(!fit);

  /* ---- 旋转 90°（竖屏视频可横屏观看），按旋转后的外接框精确适配容器 ---- */
  const rotBtn = mask.querySelector('#plRotate');
  playerState.rot = 0;
  const applyRotate = () => {
    const rot = playerState.rot % 360;
    if (rot % 180 === 0) {
      /* 回到 CSS 默认（.pv-video absolute inset:0 铺满播放器） */
      video.style.left = '';
      video.style.top = '';
      video.style.width = '';
      video.style.height = '';
      video.style.margin = '';
      video.style.transform = rot ? `rotate(${rot}deg)` : '';
      return;
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    const a = vw && vh ? vw / vh : 16 / 9;
    const box = playerEl.getBoundingClientRect();
    const bw = box.width || 16, bh = box.height || 9;
    const eh = Math.min(bw, bh / a); /* 旋转后可视宽 = 元素高 */
    const ew = a * eh;               /* 旋转后可视高 = 元素宽 */
    video.style.position = 'absolute';
    video.style.left = '50%';
    video.style.top = '50%';
    video.style.width = ew + 'px';
    video.style.height = eh + 'px';
    video.style.margin = `-${eh / 2}px 0 0 -${ew / 2}px`;
    video.style.transform = `rotate(${rot}deg)`;
  };
  rotBtn.onclick = () => { playerState.rot = (playerState.rot + 90) % 360; applyRotate(); };
  video.addEventListener('loadedmetadata', applyRotate);

  /* ---- 全屏：桌面/Android 对播放器区域全屏；iOS 用 video.webkitEnterFullscreen 兜底 ---- */
  const fsBtn = mask.querySelector('#plFull');
  fsBtn.onclick = () => {
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (inFs) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    } else if (playerEl.requestFullscreen) {
      playerEl.requestFullscreen().catch(() => {});
    }
  };

  /* ---- 横屏沉浸式：无操作 3.2 秒后自动隐藏控制条，触屏/移动即显示 ---- */
  const mqImmersive = window.matchMedia('(orientation:landscape) and (max-width:900px)');
  let hideTimer = null;
  const showCtl = () => {
    pvBar.classList.remove('hid');
    clearTimeout(hideTimer);
    if (mqImmersive.matches) hideTimer = setTimeout(() => pvBar.classList.add('hid'), 3200);
  };
  const onPlayerTouch = () => showCtl();
  playerEl.addEventListener('mousemove', onPlayerTouch);
  playerEl.addEventListener('touchstart', onPlayerTouch, { passive: true });
  playerEl.addEventListener('click', onPlayerTouch);
  const onMqChange = () => { applyRotate(); showCtl(); };
  const onWinResize = () => applyRotate();
  if (mqImmersive.addEventListener) mqImmersive.addEventListener('change', onMqChange);
  window.addEventListener('resize', onWinResize);
  showCtl();

  mask.querySelector('#plX2').onclick = closePlayer;
  playerCleanup.push(() => {
    clearTimeout(hideTimer);
    playerEl.removeEventListener('mousemove', onPlayerTouch);
    playerEl.removeEventListener('touchstart', onPlayerTouch);
    playerEl.removeEventListener('click', onPlayerTouch);
    if (mqImmersive.removeEventListener) mqImmersive.removeEventListener('change', onMqChange);
    window.removeEventListener('resize', onWinResize);
    video.removeEventListener('loadedmetadata', applyRotate);
  });

  mask.querySelector('#plTrack').onclick = (e) => {
    if (mode === 'remux') { toast(t('ui.remuxNoSeek'), 'warn'); return; }
    if (!isFinite(video.duration) || !video.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
  };
  mask.querySelector('#plClose').onclick = closePlayer;
  mask.querySelector('#plClose2').onclick = closePlayer;
  mask.querySelector('#plCopy').onclick = () => copyText(location.origin + ctx.api.downloadUrl(opts.fileId), t('ui.directLinkCopied'));
  const remuxBtn = mask.querySelector('#plRemux');
  if (remuxBtn) remuxBtn.onclick = async () => {
    try { await ctx.api.remux(opts.fileId); toast(t('ui.remuxQueued')); if (opts.onChanged) opts.onChanged(); }
    catch (e) { toast(e.message || t('ui.remuxFail'), 'err'); }
  };
  const mergeBtn = mask.querySelector('#plMerge');
  if (mergeBtn) mergeBtn.onclick = async () => {
    if (!opts.session || !opts.session.id) { toast(t('ui.mergeInvalid'), 'warn'); return; }
    try { await ctx.api.merge(opts.session.id); toast(t('ui.mergeQueued')); if (opts.onChanged) opts.onChanged(); }
    catch (e) { toast(e.message || t('ui.mergeFail'), 'err'); }
  };
  mask.querySelectorAll('[data-seg]').forEach((node) => {
    node.onclick = () => {
      const seg = segs.find((s) => s.id === node.dataset.seg);
      if (!seg) return;
      openPlayer(ctx, Object.assign({}, opts, { fileId: seg.id, name: seg.name }));
    };
  });

  video.play().catch(() => { /* 自动播放被拦截时由用户点播放键 */ });
}

/**
 * 点击位置 → 进度比例（0~1），供播放器进度条 seek 使用。
 * 播放器容器被 rotate(90deg) 模拟横屏时，进度条的水平轴在屏幕上呈竖直方向，
 * 且 getBoundingClientRect 返回的是旋转后的轴对齐包围盒（rect.height = 进度条视觉长度），
 * 此时必须沿 clientY 取比例；未旋转时沿 clientX。结果裁剪到 [0,1]，点到条外也不跳变。
 */
export function seekRatio(rect, clientX, clientY, rotated = false) {
  let ratio;
  if (rotated) ratio = (clientY - rect.top) / rect.height;
  else ratio = (clientX - rect.left) / rect.width;
  if (!isFinite(ratio)) return 0;
  return Math.max(0, Math.min(1, ratio));
}

/* ================= 手机播放器：点播放直达竖屏全屏（无中间页），可切横竖屏、可关闭 ================= */
function openMobilePlayer(ctx, opts, info, mode, url) {
  const mask = document.getElementById('playerMask');
  if (!mask) return;
  closePlayer();
  playerCleanup = [];

  playerState = { playId: info.playId || null, fileId: opts.fileId };

  mask.innerHTML = `
    <div class="pv-mobile" id="plBox">
      <video id="plVideo" src="${esc(url)}" playsinline webkit-playsinline autoplay class="pv-video"></video>
      <div class="pv-mtools" id="plMBar">
        <button class="pv-mbtn danger" id="plMClose" title="${esc(t('common.close'))}">✕</button>
      </div>
      <div class="pv-mctl" id="plMCtl">
        <div class="pv-mtrack" id="plMTrack"><i id="plMFill"></i></div>
        <div class="pv-mrow">
          <span class="mono" id="plMNow">00:00</span>
          <span class="mono" id="plMTotal">--:--</span>
          <div class="spacer"></div>
          <button class="pv-mbtn small" id="plMRate" title="倍速">1.0x</button>
          <button class="pv-mbtn small ico" id="plOrient" title="${esc(t('ui.switchOrient'))}" aria-label="${esc(t('ui.switchOrient'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="7.5" y="3.5" width="9" height="17" rx="2"/>
              <path d="M4 9.5A8.5 8.5 0 0 1 18.5 6.5"/>
              <path d="M18.5 2.5v4.5H14"/>
            </svg>
          </button>
        </div>
      </div>
    </div>`;
  mask.classList.add('show');
  document.body.style.overflow = 'hidden';

  const playerEl = mask.querySelector('#plBox');
  const video = mask.querySelector('#plVideo');
  const bar = mask.querySelector('#plMBar');
  const ctl = mask.querySelector('#plMCtl');
  const orientBtn = mask.querySelector('#plOrient');
  const fill = mask.querySelector('#plMFill');
  const nowEl = mask.querySelector('#plMNow');
  const totalEl = mask.querySelector('#plMTotal');
  const rateBtn = mask.querySelector('#plMRate');
  const rates = [1, 1.5, 2, 0.5];
  let rateIdx = 0;

  /* 进度同步 */
  const sync = () => {
    nowEl.textContent = formatDuration(video.currentTime || 0);
    if (isFinite(video.duration) && video.duration > 0) {
      totalEl.textContent = formatDuration(video.duration);
      fill.style.width = Math.min(100, (video.currentTime / video.duration) * 100) + '%';
    } else {
      totalEl.textContent = '--:--';
    }
  };
  video.ontimeupdate = sync;
  video.onloadedmetadata = sync;

  /* 进度条拖动（直放可拖动；remux 边转边播不可拖） */
  const track = mask.querySelector('#plMTrack');
  track.onclick = (e) => {
    if (mode === 'remux') { toast(t('ui.remuxNoSeek'), 'warn'); return; }
    if (!isFinite(video.duration) || !video.duration) return;
    video.currentTime = seekRatio(track.getBoundingClientRect(), e.clientX, e.clientY, false) * video.duration;
  };

  /* 倍速 */
  rateBtn.onclick = () => {
    rateIdx = (rateIdx + 1) % rates.length;
    video.playbackRate = rates[rateIdx];
    rateBtn.textContent = rates[rateIdx].toFixed(1) + 'x';
  };

  /* 竖屏（默认，contain 完整显示）↔ 横屏：点击「横屏」直接强制切到横屏视图——
     给播放器容器加 .pv-land（宽高互换 + 整体旋转 90°），进度条/时间/按钮随容器一起转为横排。
     不再调用 screen.orientation.lock（iOS Safari 等根本不支持，点了只会弹「不支持/锁失败」），
     也不在 JS 里判断设备方向：用户点了就是横屏，不会因设备未转屏或一次自动同步把选择改回去。
     设备本身转为横屏后，由 app.css 的 (orientation:landscape) 媒体查询取消旋转，回到正常铺满。 */
  let landscape = false;
  const applyOrient = () => {
    playerEl.classList.toggle('pv-land', landscape);
    orientBtn.classList.toggle('land', landscape);
  };
  orientBtn.onclick = () => { landscape = !landscape; applyOrient(); };

  /* 无操作 3 秒自动隐藏控制，触屏/移动即显示（沉浸观看） */
  let hideTimer = null;
  const showBar = () => {
    bar.classList.remove('hid');
    ctl.classList.remove('hid');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { bar.classList.add('hid'); ctl.classList.add('hid'); }, 3200);
  };
  playerEl.addEventListener('touchstart', showBar, { passive: true });
  playerEl.addEventListener('mousemove', showBar);
  showBar();

  video.onclick = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
  video.onerror = () => { if (playerState) toast(t('ui.playUnsupported'), 'err'); };
  mask.querySelector('#plMClose').onclick = closePlayer;
  mask.onclick = (e) => { if (e.target === mask) closePlayer(); };

  /* 直接进入全屏；若被浏览器手势限制拒绝，首次播放/触摸时重试 */
  const enterFs = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    if (playerEl.requestFullscreen) playerEl.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  };
  enterFs();
  video.addEventListener('play', () => enterFs(), { once: true });
  playerEl.addEventListener('touchend', () => { if (!document.fullscreenElement) enterFs(); });

  /* 系统返回键关闭：Android 按返回会先退出全屏（浏览器原生行为）→ 借此直接关闭播放器回文件页；
     不在全屏时（或 iOS 原生播放器结束）→ 用 history 回退监听兜底 */
  let closingByBack = false;
  const onFsChange = () => {
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!inFs && !closingByBack && playerState) { closingByBack = true; closePlayer(); }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  const onIosFsEnd = () => { if (!closingByBack && playerState) { closingByBack = true; closePlayer(); } };
  video.addEventListener('webkitendfullscreen', onIosFsEnd);

  let poppedBack = false;
  try { history.pushState({ lgPlayer: 1 }, ''); } catch { /* ignore */ }
  const onPop = () => { poppedBack = true; if (playerState) { closingByBack = true; closePlayer(); } };
  window.addEventListener('popstate', onPop);

  playerCleanup.push(() => {
    clearTimeout(hideTimer);
    playerEl.removeEventListener('touchstart', showBar);
    playerEl.removeEventListener('mousemove', showBar);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    video.removeEventListener('webkitendfullscreen', onIosFsEnd);
    window.removeEventListener('popstate', onPop);
    // 非返回键关闭时，回退掉自己压入的那条历史（避免残留一步空历史）
    if (!poppedBack && history.state && history.state.lgPlayer) { try { history.back(); } catch { /* ignore */ } }
  });
}

export function closePlayer() {
  (playerCleanup || []).forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  playerCleanup = [];
  /* 手机全屏播放：关闭时一并退出全屏，直接退回文件页 */
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  const mask = document.getElementById('playerMask');
  if (!mask) return;
  const video = mask.querySelector('video');
  if (video) { try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ } }
  if (playerState && playerState.playId) {
    const pid = playerState.playId;
    fetch('/api/play/' + encodeURIComponent(pid), { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
  }
  playerState = null;
  mask.classList.remove('show');
  mask.innerHTML = '';
  document.body.style.overflow = '';
}

/* ================= 剪贴板 ================= */

export function copyText(text, okMsg) {
  const done = () => toast(okMsg || t('common.copied'));
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallback());
  } else fallback();
  function fallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch { toast(t('common.copyFail'), 'warn'); }
  }
}

/* ================= 其它 ================= */

/** 触发浏览器下载（CSV 导出用） */
export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['\ufeff' + text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}

/** 开关点击委托：给 .switch 元素绑定键盘与点击切换 */
export function bindSwitches(root, onChange) {
  root.querySelectorAll('.switch').forEach((sw) => {
    const fire = () => {
      sw.classList.toggle('on');
      sw.setAttribute('aria-checked', sw.classList.contains('on') ? 'true' : 'false');
      if (onChange) onChange(sw);
    };
    sw.addEventListener('click', fire);
    sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } });
  });
}

/** 数值格式化：保留 n 位小数并去掉多余 0 */
export function num(v, digits = 1) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return String(parseFloat(n.toFixed(digits)));
}
