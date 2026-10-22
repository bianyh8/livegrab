/* LiveGrab · merge-dialog.js —— 合并所选文件（弹框）
   文件库勾选 ≥2 个文件点「合并」后弹出：按文件库原有排序列出这些文件，
   按住左侧 ⋮⋮ 拖动可调整顺序（鼠标 / 触屏同一套 pointer 事件），
   填文件名、决定是否删源，点「合并」按当前顺序把后面的内容依次追加到第一个文件之后。
   顺序只由这里决定：勾选先后是操作痕迹，不代表第 1、2、3 集的播放顺序。 */

import { t } from './i18n.js';
import { esc, el, formatBytes, formatDuration, toast, openDialog } from './ui.js';

const stemOf = (name) => String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '');

function metaOf(row) {
  const f = row.f || {};
  const s = row.s || {};
  return [
    s.platformName || s.platform || '',
    s.streamer || '',
    formatBytes(f.bytes || 0),
    f.durationSec ? formatDuration(f.durationSec) : '',
  ].filter(Boolean).join(' · ');
}

function rowHTML(row, i) {
  const f = row.f || {};
  return `<div class="mg-row" data-id="${esc(f.id)}">
    <span class="mg-handle" title="${t('merge.dragTip')}" aria-label="${t('merge.dragTip')}">⋮⋮</span>
    <span class="mg-idx">${i + 1}</span>
    <span class="mg-nm">${esc(f.name || f.relPath || '')}</span>
    <span class="mg-meta">${esc(metaOf(row))}</span>
  </div>`;
}

function renumber(list) {
  list.querySelectorAll('.mg-row').forEach((node, i) => {
    const n = node.querySelector('.mg-idx');
    if (n) n.textContent = String(i + 1);
  });
}

/* 拖动排序：按住左侧手柄拖动整行，落点决定插到目标行前/后；松手把 DOM 顺序回写成 order。 */
function bindDrag(list, getOrder, setOrder) {
  if (!list) return;
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target && e.target.closest ? e.target.closest('.mg-handle') : null;
    if (!handle) return;
    const row = handle.closest('.mg-row');
    if (!row || row.parentNode !== list) return;
    e.preventDefault();
    row.classList.add('mg-dragging');

    const onMove = (ev) => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const over = under && under.closest ? under.closest('.mg-row') : null;
      if (!over || over === row || over.parentNode !== list) return;
      const rect = over.getBoundingClientRect();
      list.insertBefore(row, ev.clientY > rect.top + rect.height / 2 ? over.nextSibling : over);
      renumber(list);
    };
    const done = () => {
      row.classList.remove('mg-dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', done);
      document.removeEventListener('pointercancel', done);
      const byId = new Map(getOrder().map((r) => [String(r.f.id), r]));
      const next = [];
      list.querySelectorAll('.mg-row').forEach((node) => {
        const r = byId.get(String(node.dataset.id));
        if (r) next.push(r);
      });
      if (next.length === getOrder().length) setOrder(next);
      renumber(list);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', done);
    document.addEventListener('pointercancel', done);
  });
}

/**
 * 打开合并弹框。
 * @param rows          合并顺序初值（文件库现有排序）：[{ f, s, tag }]
 * @param deleteSources 「合并后把源文件移入回收站」的默认值（由调用方取系统设置）
 * @param onSubmit      ({ ids, name, deleteSources }) => Promise<boolean>，返回 true 才关闭弹框
 */
export function openMergeDialog({ rows, deleteSources = false, onSubmit }) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (list.length < 2) { toast(t('files.mergeNeedTwo'), 'warn'); return null; }

  let order = list;
  let del = !!deleteSources;
  let busy = false;

  const defName = `${stemOf(list[0].f && (list[0].f.name || list[0].f.relPath))}(合并)`;

  return openDialog({
    title: t('merge.title'),
    width: 'min(560px,92vw)',
    body: `<div class="hintline" style="margin-top:0">${t('merge.count', list.length)} · ${t('merge.dragHint')}</div>
      <div class="mg-list" id="mgList">${order.map(rowHTML).join('')}</div>
      <div class="form-row" style="margin-top:12px">
        <label class="fl">${t('files.mergeNameLabel')}</label>
        <input class="input" id="mgName" value="${esc(defName)}" />
        <div class="hintline">${t('files.mergeNameHint')}</div>
      </div>
      <label class="mg-del">
        <input type="checkbox" class="cb" id="mgDel"${del ? ' checked' : ''} />
        <span>${t('merge.deleteSources')}</span>
      </label>`,
    footer: (close, body) => {
      const listEl = body.querySelector('#mgList');
      const nameEl = body.querySelector('#mgName');
      const delEl = body.querySelector('#mgDel');
      if (delEl) delEl.onchange = () => { del = !!delEl.checked; };
      bindDrag(listEl, () => order, (next) => { order = next; });

      const cancel = el('button', 'btn ghost', t('common.cancel'));
      const go = el('button', 'btn primary', t('files.mergeSelected'));
      cancel.onclick = close;
      go.onclick = async () => {
        if (busy) return;
        const name = String((nameEl && nameEl.value) || '').trim();
        if (!name) { toast(t('files.mergeNameRequired'), 'warn'); if (nameEl) nameEl.focus(); return; }
        if (order.length < 2) { toast(t('files.mergeNeedTwo'), 'warn'); return; }

        busy = true;
        go.disabled = true;
        go.textContent = t('merge.submitting');
        if (listEl) listEl.classList.add('mg-busy');
        let ok = false;
        try {
          ok = await onSubmit({ ids: order.map((r) => r.f.id), name, deleteSources: del });
        } finally {
          busy = false;
          go.disabled = false;
          go.textContent = t('files.mergeSelected');
          if (listEl) listEl.classList.remove('mg-busy');
        }
        if (ok) close(); // 失败留在弹框：顺序与输入都保留，可直接重试
      };
      if (nameEl) setTimeout(() => { nameEl.focus(); nameEl.select(); }, 30);
      return [cancel, go];
    },
  });
}
