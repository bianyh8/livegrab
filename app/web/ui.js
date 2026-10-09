/* LiveGrab · ui.js
   视图共用的渲染工具：格式化、徽标、开关、toast、确认框、输入框弹窗、播放器弹窗。
   视觉类名全部来自 app.css（从 ui/index.html 抽取），不引入任何第三方资源。 */

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
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
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

/** 21:04:12.318 —— 日志行用的毫秒级时间戳 */
export function formatLogTime(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** 相对时间：「刚刚 / 12 分钟前 / 3 天前」 */
export function fromNow(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
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
  douyin: { cls: 'dy', letter: '抖', name: '抖音' },
  bilibili: { cls: 'bili', letter: 'B', name: '哔哩哔哩' },
  kuaishou: { cls: 'ks', letter: '快', name: '快手' },
  huya: { cls: 'huya', letter: '虎', name: '虎牙' },
  douyu: { cls: 'douyu', letter: '鱼', name: '斗鱼' },
  xiaohongshu: { cls: 'xhs', letter: '红', name: '小红书' },
  weibo: { cls: 'wb', letter: '微', name: '微博' },
  acfun: { cls: 'ac', letter: 'A', name: 'AcFun' },
  cc: { cls: 'cc', letter: 'CC', name: '网易CC' },
  yy: { cls: 'yy', letter: 'YY', name: 'YY' },
  wechat: { cls: 'wx', letter: '视', name: '视频号' },
  more: { cls: 'more', letter: '＋', name: '更多平台' },
};

export function platformInfo(id) {
  return PLATFORMS[id] || { cls: 'plain', letter: '?', name: id || '未知平台' };
}

/** 平台分层代号 → 中文（stable/experimental/planned 等前台不得出现英文） */
const TIER_CN = { stable: '稳定', experimental: '实验性', planned: '规划中' };
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
  idle: { text: '待机', chip: 'off' },
  waiting: { text: '等待开播', chip: 'wait' },
  queued: { text: '排队中', chip: 'wait' },
  recording: { text: '录制中', chip: 'on' },
  stopping: { text: '停止中', chip: 'wait' },
  merging: { text: '合并中', chip: 'wait' },
  completed: { text: '已完成', chip: 'on' },
  stopped: { text: '手动停止', chip: 'off' },
  error: { text: '错误', chip: 'err' },
};

export function statusMeta(status) {
  return STATUS_META[status] || { text: status || '未知', chip: '' };
}

/** 任务状态单元格：脉冲点 / chip + 子行 */
export function statusCell(task) {
  const m = statusMeta(task.status);
  const sub = [];
  if (task.status === 'recording') {
    sub.push(`${formatDuration(task.live ? task.live.elapsedSec : 0)} · ${formatBytes(task.live ? task.live.bytes : 0)}`);
  } else if (task.status === 'queued') {
    sub.push(esc(task.queueReason || '等待并发空位'));
  } else if (task.status === 'error') {
    const max = task.retryMax || 5;
    sub.push(`${esc(task.lastError || task.statusMessage || '未知错误')} · 自动重试 ${task.retryCount || 0}/${max}`);
  } else if (task.status === 'waiting') {
    sub.push(`轮询 ${task.pollIntervalSec || 60} 秒`);
  } else if (task.status === 'completed' || task.status === 'stopped') {
    if (task.endedAt) sub.push(`${formatTime(task.endedAt)} 结束 · ${formatBytes(task.totalBytes || 0)}`);
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
  if (mode === 'none') return '不分段';
  if (mode === 'size') return `按大小 · ${Math.round((task.segmentSizeMB || 2048) / 1024 * 10) / 10} GB`;
  return `按时间 · ${task.segmentMinutes || 60} 分钟`;
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
export function confirmDialog({ title = '请确认', text = '', ok = '确定', cancel = '取消', danger = false, onOk } = {}) {
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
export function promptDialog({ title = '请输入', label = '', value = '', placeholder = '', multiline = false, rows = 6, ok = '保存', hint = '', onOk } = {}) {
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
      const b1 = el('button', 'btn ghost', '取消');
      const b2 = el('button', 'btn primary', ok);
      b1.onclick = close;
      b2.onclick = () => {
        const v = input ? input.value.trim() : '';
        if (!v) { toast('内容不能为空', 'warn'); return; }
        close();
        if (typeof onOk === 'function') onOk(v);
      };
      if (input) setTimeout(() => input.focus(), 30);
      return [b1, b2];
    },
  });
}

/** 通用弹窗骨架：body 传 HTML 字符串，footer 传 (close, bodyEl)=>[buttons] */
export function openDialog({ title = '', body = '', footer = null, wide = false }) {
  const mask = document.getElementById('modalMask');
  if (!mask) return { close() {} };
  mask.innerHTML = '';
  const modal = el('div', 'modal');
  if (wide) modal.style.width = 'min(1000px,94vw)';
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

/**
 * openPlayer(ctx, {fileId, name, platform, platformName, qualityLabel, kind, segments, session, onChanged})
 * kind: 'direct' | 'remux' | 'audio'
 */
export async function openPlayer(ctx, opts) {
  const mask = document.getElementById('playerMask');
  if (!mask) return;
  closePlayer();

  const segs = Array.isArray(opts.segments) ? opts.segments : [];
  let info;
  try {
    info = await ctx.api.play(opts.fileId);
  } catch (e) {
    if (e.code === 'PLAY_BUSY') {
      toast('当前回放较多，请稍后再试', 'warn');
      return;
    }
    toast(e.message || '无法开始回放', 'err');
    return;
  }
  const mode = info.mode || 'direct';
  const url = mode === 'remux' ? ctx.api.playStreamUrl(info.playId) : (info.url || ctx.api.streamUrl(opts.fileId));

  playerState = { playId: info.playId || null, fileId: opts.fileId };

  const modeChip = mode === 'remux'
    ? { cls: 'chip wait', text: '边转边播 · 不可拖动' }
    : { cls: 'chip on', text: '直接播放 · 可拖动' };
  const srcText = mode === 'remux'
    ? (opts.kind === 'audio' ? '源：M4A（服务端转封装）' : '源：TS/FLV（服务端 -c copy 转 fMP4）')
    : '源：MP4 / M4A（直接播放）';

  mask.innerHTML = `
    <div class="modal" style="width:min(1000px,94vw)">
      <div class="modal-h">
        <h3 class="mono" style="font-size:13.5px">${esc(opts.name || '回放')}</h3>
        <span class="chip" style="margin-left:10px">${esc(opts.platformName || platformInfo(opts.platform).name)}</span>
        <span class="chip">${esc(opts.qualityLabel || '—')}</span>
        <span class="${modeChip.cls}" id="plMode"><i class="dot"></i>${esc(modeChip.text)}</span>
        <span class="x" id="plClose">✕</span>
      </div>
      <div class="modal-b" style="padding:0">
        <div class="player">
          <video id="plVideo" src="${esc(url)}" playsinline style="width:100%;height:100%;background:#000;display:block"></video>
          <div class="pv-badge" id="plSrc">${esc(srcText)}</div>
          <div class="pv-hint">浏览器内置播放器 · 不调用本机播放器、不依赖桌面环境</div>
        </div>
        <div class="pv-bar">
          <button class="pv-btn" id="plToggle">⏯</button>
          <span class="mono" style="font-size:11.5px;color:var(--txt-3)" id="plNow">00:00</span>
          <div class="pv-track" id="plTrack"><i id="plFill" style="width:0%"></i></div>
          <span class="mono" style="font-size:11.5px;color:var(--txt-3)" id="plTotal">--:--</span>
          <button class="pv-btn" id="plMute">🔈</button>
          <button class="pv-btn" id="plRate">1.0x</button>
          <button class="pv-btn" id="plFull">⛶</button>
        </div>
        <div style="padding:16px 20px">
          ${segs.length ? `<div style="font-size:12.5px;color:var(--txt-2)">分段 <span style="color:var(--txt-3)">（共 ${segs.length} 段；可单独播放任意分段，也可合并后整场回放）</span></div>
          <div class="pv-segs">${segs.map((s) => {
            const idx = String(s.segmentIndex || 0).padStart(3, '0');
            const cls = s.status === 'recording' ? 'chip wait' : (s.id === opts.fileId ? 'chip on' : 'chip');
            return `<span class="${cls}" data-seg="${esc(s.id)}" style="cursor:pointer">${s.status === 'recording' ? '<i class="dot"></i>' : ''}${idx} ${s.status === 'recording' ? '录制中' : '已录完'}</span>`;
          }).join('')}</div>` : ''}
          <div class="hintline" style="margin-top:12px">TS 片段由服务端 <span class="mono">ffmpeg -c copy</span> 边转边播、不落盘；成品 MP4 直接播放；正在录制的分段只播已写入的部分。若浏览器不支持所选音轨/编码，会给出明确提示而不是静默黑屏。<b>同时最多 2 路转封装回放</b>，超出会提示"当前回放较多，请稍后再试"；关闭播放器即释放；MP4 直放不受此限制。</div>
        </div>
      </div>
      <div class="modal-f">
        <button class="btn ghost" id="plCopy">复制直链</button>
        <button class="btn ghost" id="plRemux">转封装 MP4</button>
        <button class="btn ghost" id="plMerge">合并整场</button>
        <button class="btn primary" id="plClose2">关闭</button>
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
  video.onerror = () => toast('该文件浏览器无法直接播放（编码不支持或转封装失败）', 'err');

  mask.querySelector('#plToggle').onclick = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
  video.onclick = () => { video.paused ? video.play().catch(() => {}) : video.pause(); };
  muteBtn.onclick = () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? '🔇' : '🔈'; };
  rateBtn.onclick = () => { rateIdx = (rateIdx + 1) % rates.length; video.playbackRate = rates[rateIdx]; rateBtn.textContent = rates[rateIdx].toFixed(1) + 'x'; };
  mask.querySelector('#plFull').onclick = () => { const p = video.parentElement; (document.fullscreenElement ? document.exitFullscreen() : (p.requestFullscreen ? p.requestFullscreen() : Promise.resolve())).catch(() => {}); };
  mask.querySelector('#plTrack').onclick = (e) => {
    if (mode === 'remux') { toast('边转边播不支持拖动，请等待转完再拖动', 'warn'); return; }
    if (!isFinite(video.duration) || !video.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
  };
  mask.querySelector('#plClose').onclick = closePlayer;
  mask.querySelector('#plClose2').onclick = closePlayer;
  mask.querySelector('#plCopy').onclick = () => copyText(location.origin + ctx.api.downloadUrl(opts.fileId), '已复制直链（局域网内可分享）');
  mask.querySelector('#plRemux').onclick = async () => {
    try { await ctx.api.remux(opts.fileId); toast('已生成 MP4 转封装任务'); if (opts.onChanged) opts.onChanged(); }
    catch (e) { toast(e.message || '转封装失败', 'err'); }
  };
  mask.querySelector('#plMerge').onclick = async () => {
    if (!opts.session || !opts.session.id) { toast('该文件不属于整场记录，无法合并', 'warn'); return; }
    try { await ctx.api.merge(opts.session.id); toast('已提交合并整场任务'); if (opts.onChanged) opts.onChanged(); }
    catch (e) { toast(e.message || '合并失败', 'err'); }
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

export function closePlayer() {
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
  const done = () => toast(okMsg || '已复制');
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
    } catch { toast('复制失败，请手动选择文本', 'warn'); }
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
