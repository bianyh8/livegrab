/* LiveGrab · views/trash.js —— 回收站
   独立导航页（在「运行日志」下方）。列出回收站内容，支持逐个还原 / 全部还原 / 一键清空。
   数据来自 GET /api/trash；还原 POST /api/trash/restore；清空 POST /api/trash/empty。 */

import { api } from '../api.js';
import { esc, formatBytes, formatDateTime, emptyBox, toast, confirmDialog, pagerHTML, bindPager } from '../ui.js';
import { t } from '../i18n.js';

export const page = 'trash';

const state = { items: [], total: 0, bytes: 0, retentionDays: 7, page: 1, pages: 1, hash: '', pending: false, bound: false };

/* 分页：默认每页 10 条（任务/文件/回收站统一） */
const PAGE_SIZE = 10;

let boundRoot = null;

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('trash.loading')}</div></div>`;
  if (!state.bound) state.bound = true;
  ctx.onRefresh(() => tick(ctx));
  await tick(ctx, true);
}

export function destroy() { boundRoot = null; }

async function tick(ctx, initial) {
  if (state.pending) return;
  state.pending = true;
  try {
    const r = await api.trash({ page: state.page, pageSize: PAGE_SIZE });
    state.items = (r && (r.items || [])) || [];
    state.total = Number((r && r.total != null ? r.total : state.items.length) || 0);
    state.pages = Math.max(1, Number((r && r.pages) || 1));
    state.bytes = Number((r && (r.bytes != null ? r.bytes : r.total)) || 0);
    if (r && r.retentionDays != null) state.retentionDays = Number(r.retentionDays || state.retentionDays);
    paint(ctx, initial);
  } catch (e) {
    if (initial && boundRoot) boundRoot.innerHTML = `<div class="card"><div class="empty">${t('trash.loadFail', esc(e.message || t('common.unknownError')))}</div></div>`;
  } finally {
    state.pending = false;
  }
}

function paint(ctx, force) {
  const root = boundRoot;
  if (!root) return;
  const hash = JSON.stringify([state.items.map((t) => [t.id, t.name, t.bytes]), state.total, 'p' + state.page]);
  if (!force && hash === state.hash) return;
  state.hash = hash;

  const items = state.items; // 后端分页：当前页数据
  if (state.page > state.pages) state.page = state.pages;
  root.innerHTML = `
    <div class="card">
      <div class="card-h">
        <h3>${t('nav.trash')}</h3>
        <span class="hint">${state.total} ${t('trash.itemUnit')} · ${esc(formatBytes(state.bytes))}</span>
        <div class="spacer"></div>
        <button class="btn sm" id="trRestoreAll"${state.total ? '' : ' disabled'}>${t('trash.restoreAll')}</button>
        <button class="btn sm danger" id="trEmpty"${state.total ? '' : ' disabled'}>${t('trash.purgeAll')}</button>
      </div>
      <div class="card-b">
        ${state.total
          ? `<div class="hintline" style="margin:0 0 12px">${t('trash.retentionHint', Number(state.retentionDays) || 7)}</div>
             ${items.map((t) => trashLine(t, ctx)).join('')}
             ${pagerHTML('trPager', state.page, state.pages, state.total)}`
          : emptyBox(t('trash.empty'))}
      </div>
    </div>`;
  bind(ctx);
}

function trashLine(item, ctx) {
  const meta = item.items || [];
  const media = meta.find((it) => it.kind !== 'sidecar' && it.kind !== 'poster' && it.kind !== 'nfo') || meta[0] || {};
  const fileCount = meta.filter((it) => it.kind !== 'sidecar').length;
  const hasSidecar = meta.some((it) => it.kind === 'sidecar');
  const extLabel = (media.name ? String(media.name).split('.').pop() : t('trash.media')).toUpperCase();
  const inner = `
        <span class="th-ph" style="display:none">${esc(extLabel)}</span>
        <img class="tk-thumb" loading="lazy" src="/api/trash/${esc(item.id)}/thumb" alt="" onerror="this.style.display='none';this.previousElementSibling.style.display=''" />`;
  return `
    <div class="fl-item" style="align-items:flex-start" data-trash="${esc(item.id)}">
      <div class="fl-ico plain">${inner}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name || media.name || t('trash.unnamed'))}
          <span class="chip" style="margin-left:6px">${item.kind === 'session' ? t('trash.kindSession') : t('trash.kindSingle')}</span>
          ${hasSidecar ? `<span class="chip" style="margin-left:6px">${t('trash.hasScrape')}</span>` : ''}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:11.5px;color:var(--txt-3)">
          <span>${esc(formatBytes(item.bytes || 0))}</span>
          <span>${fileCount > 1 ? t('trash.multipleFiles', fileCount) : t('trash.singleFile')}</span>
          <span>${t('trash.deletedAt', esc(formatDateTime(item.deletedAt || item.createdAt)))}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-trash-act="restore" data-id="${esc(item.id)}">${t('trash.restore')}</button>
        <button class="btn sm danger" data-trash-act="purge" data-id="${esc(item.id)}">${t('files.clear')}</button>
      </div>
    </div>`;
}

function bind(ctx) {
  const root = boundRoot;
  if (!root) return;
  const ra = root.querySelector('#trRestoreAll');
  if (ra) ra.onclick = () => {
    void (async () => {
      // 全部还原需覆盖所有页：拉全量（不带分页参数）
      let ids = [];
      try {
        const r = await api.trash();
        ids = ((r && r.items) || []).map((x) => x.id);
      } catch { ids = []; }
      if (!ids.length) { toast(t('trash.empty'), 'warn'); return; }
      confirmDialog({
        title: t('trash.restoreAll'), ok: t('trash.restore'),
        text: t('trash.restoreAllText', ids.length, t('trash.itemUnit')),
        onOk: async () => {
          try { const r = await api.trashRestore(ids); toast(t('trash.restoredN', Number(r && r.restored) || ids.length)); state.hash = ''; state.page = 1; await tick(ctx, true); }
          catch (e) { toast(e.message || t('trash.restoreFail'), 'err'); }
        },
      });
    })();
  };
  const em = root.querySelector('#trEmpty');
  if (em) em.onclick = () => {
    confirmDialog({
      title: t('trash.purgeAll'), danger: true, ok: t('trash.purge'),
      text: t('trash.purgeAllText', state.total, t('trash.itemUnit'), esc(formatBytes(state.bytes))),
      onOk: async () => {
        try { await api.trashEmpty(); toast(t('trash.purgedAll')); state.hash = ''; state.page = 1; await tick(ctx, true); }
        catch (e) { toast(e.message || t('trash.purgeFail'), 'err'); }
      },
    });
  };
  root.querySelectorAll('[data-trash-act="restore"]').forEach((btn) => {
    btn.onclick = async () => {
      try { await api.trashRestore([btn.dataset.id]); toast(t('trash.restoreDone')); state.hash = ''; await tick(ctx, true); }
      catch (e) { toast(e.message || t('trash.restoreFail'), 'err'); }
    };
  });
  root.querySelectorAll('[data-trash-act="purge"]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const item = state.items.find((x) => x.id === id);
      confirmDialog({
        title: t('trash.purgeTitle'), danger: true, ok: t('files.clear'),
        text: t('trash.purgeText', esc(item && item.name || t('trash.thisItem')), esc(formatBytes(item && item.bytes || 0))),
        onOk: async () => {
          try { const r = await api.trashPurge([id]); toast(t('trash.purged', Number(r && r.purged) || 1)); state.hash = ''; await tick(ctx, true); }
          catch (e) { toast(e.message || t('settings.pfClearFail'), 'err'); }
        },
      });
    };
  });
  // 翻页需重新向后端请求对应页数据
  bindPager(root, 'trPager', state, () => { state.hash = ''; tick(ctx, true); });
}