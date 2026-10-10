/* LiveGrab · views/trash.js —— 回收站
   独立导航页（在「运行日志」下方）。列出回收站内容，支持逐个还原 / 全部还原 / 一键清空。
   数据来自 GET /api/trash；还原 POST /api/trash/restore；清空 POST /api/trash/empty。 */

import { api } from '../api.js';
import { esc, formatBytes, formatDateTime, emptyBox, toast, confirmDialog } from '../ui.js';

export const page = 'trash';

const state = { items: [], bytes: 0, retentionDays: 7, hash: '', pending: false, bound: false };

let boundRoot = null;

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">正在加载回收站…</div></div>`;
  if (!state.bound) state.bound = true;
  ctx.onRefresh(() => tick(ctx));
  await tick(ctx, true);
}

export function destroy() { boundRoot = null; }

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    const r = await api.trash();
    state.items = (r && (r.items || [])) || [];
    state.bytes = Number((r && (r.bytes != null ? r.bytes : r.total)) || 0);
    if (r && r.count != null) state.retentionDays = Number(r.retentionDays || state.retentionDays);
    paint(ctx, initial);
  } catch (e) {
    if (initial) boundRoot.innerHTML = `<div class="card"><div class="empty">回收站加载失败：${esc(e.message || '未知错误')}</div></div>`;
  } finally {
    state.pending = false;
  }
}

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  const hash = JSON.stringify([state.items.map((t) => [t.id, t.name, t.bytes]), state.bytes]);
  if (!force && hash === state.hash) return;
  state.hash = hash;

  const items = state.items;
  root.innerHTML = `
    <div class="card">
      <div class="card-h">
        <h3>回收站</h3>
        <span class="hint">${items.length} 项 · ${esc(formatBytes(state.bytes))}</span>
        <div class="spacer"></div>
        <button class="btn sm" id="trRestoreAll"${items.length ? '' : ' disabled'}>全部还原</button>
        <button class="btn sm danger" id="trEmpty"${items.length ? '' : ' disabled'}>清空回收站</button>
      </div>
      <div class="card-b">
        ${items.length
          ? `<div class="hintline" style="margin:0 0 12px">回收站文件保留在 <span class="mono">/data/.trash</span>，按设置保留 ${Number(state.retentionDays) || 7} 天自动清理。含媒体文件与其同名的刮削图片/描述（.jpg/.nfo），均一并可还原。</div>
             ${items.map((t) => trashLine(t, ctx)).join('')}`
          : emptyBox('回收站为空')}
      </div>
    </div>`;
  bind(ctx);
}

function trashLine(t, ctx) {
  const meta = t.items || [];
  const media = meta.find((it) => it.kind !== 'sidecar' && it.kind !== 'poster' && it.kind !== 'nfo') || meta[0] || {};
  const fileCount = meta.filter((it) => it.kind !== 'sidecar').length;
  const hasSidecar = meta.some((it) => it.kind === 'sidecar');
  const extLabel = (media.name ? String(media.name).split('.').pop() : '媒体').toUpperCase();
  const inner = `
        <span class="th-ph" style="display:none">${esc(extLabel)}</span>
        <img class="tk-thumb" loading="lazy" src="/api/trash/${esc(t.id)}/thumb" alt="" onerror="this.style.display='none';this.previousElementSibling.style.display=''" />`;
  return `
    <div class="fl-item" style="align-items:flex-start" data-trash="${esc(t.id)}">
      <div class="fl-ico plain">${inner}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name || media.name || '未命名')}
          <span class="chip" style="margin-left:6px">${t.kind === 'session' ? '整场' : '单个文件'}</span>
          ${hasSidecar ? '<span class="chip" style="margin-left:6px">含刮削</span>' : ''}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:11.5px;color:var(--txt-3)">
          <span>${esc(formatBytes(t.bytes || 0))}</span>
          <span>${fileCount > 1 ? `${fileCount} 个文件` : '1 个媒体文件'}</span>
          <span>删除于 ${esc(formatDateTime(t.deletedAt || t.createdAt))}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-trash-act="restore" data-id="${esc(t.id)}">还原</button>
      </div>
    </div>`;
}

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;
  const ra = root.querySelector('#trRestoreAll');
  if (ra) ra.onclick = () => {
    const ids = state.items.map((t) => t.id);
    if (!ids.length) { toast('回收站为空', 'warn'); return; }
    confirmDialog({
      title: '全部还原', ok: '还原',
      text: `将把回收站内 <b>${ids.length}</b> 项（含刮削图片/描述）放回原位置。`,
      onOk: async () => {
        try { const r = await api.trashRestore(ids); toast(`已还原 ${Number(r && r.restored) || ids.length} 项`); state.hash = ''; await tick(ctx, true); }
        catch (e) { toast(e.message || '还原失败', 'err'); }
      },
    });
  };
  const em = root.querySelector('#trEmpty');
  if (em) em.onclick = () => {
    confirmDialog({
      title: '清空回收站', danger: true, ok: '清空',
      text: `将永久删除回收站内 ${state.items.length} 项（<b>${esc(formatBytes(state.bytes))}</b>），含刮削图片/描述，<b>不可还原</b>。`,
      onOk: async () => {
        try { await api.trashEmpty(); toast('回收站已清空'); state.hash = ''; await tick(ctx, true); }
        catch (e) { toast(e.message || '清空失败', 'err'); }
      },
    });
  };
  root.querySelectorAll('[data-trash-act="restore"]').forEach((btn) => {
    btn.onclick = async () => {
      try { await api.trashRestore([btn.dataset.id]); toast('已还原'); state.hash = ''; await tick(ctx, true); }
      catch (e) { toast(e.message || '还原失败', 'err'); }
    };
  });
}