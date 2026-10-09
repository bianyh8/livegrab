/* LiveGrab · views/files.js —— 录制文件库
   按「视频文件」直接平铺显示，头部用 平台 / 主播 / 日期 等条件查询；不再有左侧树（全部场次 / 仅音频 / 回收站…）。
   回收站已独立为导航页「回收站」。删除走 POST /api/files/delete（默认进回收站，一并带走同名的刮削 .jpg/.nfo）。 */

import { api } from '../api.js';
import {
  esc, formatBytes, formatDuration, formatDateTime, platBadge, emptyBox,
  toast, confirmDialog, openPlayer, platformInfo,
} from '../ui.js';

const state = {
  sessions: [],
  q: '',
  platform: '',
  anchor: '',
  date: '',
  ext: '',
  picked: new Set(),
  hash: '',
  pending: false,
  bound: false,
};

let boundRoot = null;

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">正在加载文件库…</div></div>`;
  if (!state.bound) state.bound = true;
  ctx.onRefresh(() => tick(ctx));
  await tick(ctx, true);
}

export function destroy() { boundRoot = null; }

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    const r = await api.files({ view: 'platform', q: state.q });
    state.sessions = (r && r.items) || [];
    paint(ctx, initial);
  } catch (e) {
    if (initial) boundRoot.innerHTML = `<div class="card"><div class="empty">文件库加载失败：${esc(e.message || '未知错误')}</div></div>`;
  } finally {
    state.pending = false;
  }
}

/* 把「整场」拍平成「单个文件」行：分段 + 转封装/合并副本 + mp4/m4a；按 id 去重（同一成品可能同时挂在 extras 与 mp4） */
function allFiles() {
  const out = [];
  for (const s of state.sessions) {
    const seen = new Set();
    const push = (f, tag) => { if (f && f.id && !seen.has(f.id)) { seen.add(f.id); out.push({ f, s, tag }); } };
    (s.segments || []).forEach((x) => push(x, null));
    (s.extras || []).forEach((x) => push(x, x.kind === 'm4a' ? 'M4A' : x.kind === 'merged' ? '合并' : 'MP4'));
    if (s.mp4) push(s.mp4, 'MP4');
    if (s.merged) push(s.merged, '合并');
  }
  return out;
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const anchorQ = state.anchor.trim().toLowerCase();
  return allFiles().filter(({ f, s, tag }) => {
    if (state.platform && s.platform !== state.platform) return false;
    if (anchorQ && !String(s.streamer || '').toLowerCase().includes(anchorQ)) return false;
    if (state.date && String(s.startedAt || '').slice(0, 10) !== state.date) return false;
    if (state.ext) {
      const e = String(f.ext || tag || '').toLowerCase();
      if (e !== state.ext && !(state.ext === 'mp4' && (e === 'mp4' || e === 'm4a'))) return false;
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
    state.q, state.platform, state.anchor, state.date, state.ext, Array.from(state.picked)]);
  if (!force && hash === state.hash) return;
  state.hash = hash;

  const totalBytes = state.sessions.reduce((n, s) => n + (s.bytes || 0), 0);

  root.innerHTML = `
    <div class="card">
      <div class="card-h">
        <h3>录制文件库</h3>
        <span class="hint">${list.length} 个视频文件 · ${esc(formatBytes(totalBytes))}</span>
        <div class="spacer"></div>
        <button class="btn sm ghost" id="flRefresh">刷新</button>
      </div>
      <div class="toolbar" style="padding:10px 16px 12px;flex-wrap:wrap">
        <input class="input" id="flQ" style="width:180px" placeholder="搜索 文件名/主播/标题" value="${esc(state.q)}" />
        <select class="select" id="flPlat" style="width:120px">
          <option value="">全部平台</option>
          ${platforms.map((p) => `<option value="${esc(p)}"${state.platform === p ? ' selected' : ''}>${esc(platNameOf(p))}</option>`).join('')}
        </select>
        <input class="input" id="flAnchor" style="width:150px" placeholder="主播名称" value="${esc(state.anchor)}" />
        <input type="date" class="input" id="flDate" style="width:150px" value="${esc(state.date)}" />
        <select class="select" id="flExt" style="width:120px">
          ${[['', '全部类型'], ['ts', '.ts 直播流'], ['mp4', '.mp4 / m4a'], ['m4a', '.m4a 音频']].map(([v, t]) => `<option value="${v}"${state.ext === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--txt-2);cursor:pointer"><input type="checkbox" class="cb" id="flSelAll"${allSel ? ' checked' : ''} /> 全选</label>
        <span class="chip ${state.picked.size ? 'on' : ''}" id="flPickChip"><i class="dot"></i>已选中 ${state.picked.size} 项</span>
        <button class="btn sm danger" id="flDelPicked"${state.picked.size ? '' : ' disabled'}>删除所选</button>
      </div>
      <div style="padding:0 16px 16px" id="flBody">
        ${list.length ? list.map(filenameRow).join('') : emptyBox('没有符合筛选条件的录制文件')}
      </div>
    </div>`;

  bind(ctx);
}

function platNameOf(id) {
  const m = { douyin: '抖音', bilibili: '哔哩哔哩', kuaishou: '快手', huya: '虎牙', douyu: '斗鱼', xiaohongshu: '小红书', weibo: '微博', acfun: 'AcFun' };
  return m[id] || id || '未知';
}

function filenameRow({ f, s, tag }) {
  const playing = f.status === 'recording';
  const missing = f.status === 'missing';
  const icoCls = platformInfo(s.platform).cls;
  const extLabel = tag || (f.ext ? f.ext.toUpperCase() : 'TS');
  return `
    <div class="fl-item" style="align-items:flex-start" data-file="${esc(f.id)}">
      <input type="checkbox" class="cb" data-pick-file="${esc(f.id)}"${state.picked.has(f.id) ? ' checked' : ''} title="选择该文件" style="margin-top:6px" />
      <div class="fl-ico ${esc(icoCls)}">
        ${missing
          ? `<span class="th-ph">${esc(extLabel)}</span>`
          : `<span class="th-ph" style="display:none">${esc(extLabel)}</span><img class="tk-thumb" loading="lazy" src="/api/files/${esc(f.id)}/thumb" alt="" onerror="this.style.display='none';this.previousElementSibling.style.display=''" />`}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name || f.relPath || '—')}
          ${tag ? `<span class="chip">${esc(tag)}</span>` : ''}
          ${playing ? '<span class="chip wait" style="margin-left:6px"><i class="dot"></i>录制中</span>' : missing ? '<span class="chip err" style="margin-left:6px">文件缺失</span>' : '<span class="chip on" style="margin-left:6px"><i class="dot"></i>已录完</span>'}
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:5px;font-size:11.5px;color:var(--txt-3);flex-wrap:wrap">
          ${platBadge(s.platform, s.platformName)}
          <span>${esc(s.streamer || '未知主播')}</span>
          <span>${esc(formatDateTime(s.startedAt))}</span>
          <span>时长 ${esc(formatDuration(f.durationSec || s.durationSec || 0))}</span>
          <span>${esc(formatBytes(f.bytes || 0))}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-file-act="play" data-id="${esc(f.id)}"${missing ? ' disabled' : ''}>播放</button>
        <a class="btn sm ghost" href="${esc(api.downloadUrl(f.id))}" download>下载</a>
        <button class="btn sm danger" data-file-act="delete" data-id="${esc(f.id)}"${playing || missing ? ' disabled' : ''}>删除</button>
      </div>
    </div>`;
}

/* ---------- 交互 ---------- */

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;

  const q = root.querySelector('#flQ');
  if (q) q.oninput = () => { state.q = q.value; state.hash = ''; paint(ctx, true); };
  const plat = root.querySelector('#flPlat');
  if (plat) plat.onchange = () => { state.platform = plat.value; state.hash = ''; paint(ctx, true); };
  const anchor = root.querySelector('#flAnchor');
  if (anchor) anchor.oninput = () => { state.anchor = anchor.value; state.hash = ''; paint(ctx, true); };
  const date = root.querySelector('#flDate');
  if (date) date.onchange = () => { state.date = date.value; state.hash = ''; paint(ctx, true); };
  const ext = root.querySelector('#flExt');
  if (ext) ext.onchange = () => { state.ext = ext.value; state.hash = ''; paint(ctx, true); };

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
      if (!found) { toast('找不到该文件记录', 'warn'); return; }
      const act = btn.dataset.fileAct;
      if (act === 'play') {
        openPlayer(ctx, filePlayer(found.f, found.s, found.tag));
      } else if (act === 'delete') {
        if (found.f.status === 'recording') { toast('录制中的分段不可删除', 'warn'); return; }
        confirmDialog({
          title: '删除录制文件', danger: true, ok: '移入回收站',
          text: `将删除 <b>${esc(found.f.name || '该文件')}</b>（${esc(formatBytes(found.f.bytes || 0))}）并移入回收站 <span class="mono">/data/.trash</span>（同名的刮削图片/描述 .jpg/.nfo 一并已随行可还原）。<br><span style="color:var(--txt-3)">源 .ts 是否保留由「系统设置」决定，不在本次删除范围。保留 7 天，可去「回收站」页还原。</span>`,
          onOk: async () => {
            try {
              const r = await api.filesDelete({ fileIds: [id] });
              toast(`已移入回收站（${Number(r && r.movedToTrash) || 1} 项）`);
              state.picked.delete(id);
              state.hash = '';
              await tick(ctx, true);
            } catch (e) { toast(e.message || '删除失败', 'err'); }
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
    name: f.name || f.relPath || '回放',
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
  confirmDialog({
    title: '删除录制文件',
    danger: true,
    ok: '移入回收站',
    text: `将删除选中的 <b>${ids.length}</b> 个文件 / <b>${esc(formatBytes(bytes))}</b>，并移入回收站 <span class="mono">/data/.trash</span>（连同同名的刮削图片/描述，可去「回收站」页还原）。<br><span style="color:var(--txt-3)">录制中的分段不会被删除。</span>`,
    onOk: async () => {
      try {
        const r = await api.filesDelete({ fileIds: ids });
        toast(`已移入回收站（${Number(r && r.movedToTrash) || ids.length} 项 / ${esc(formatBytes(r && r.bytes != null ? r.bytes : bytes))}）`);
        ids.forEach((id) => state.picked.delete(id));
        state.hash = '';
        await tick(ctx, true);
      } catch (e) { toast(e.message || '删除失败', 'err'); }
    },
  });
}