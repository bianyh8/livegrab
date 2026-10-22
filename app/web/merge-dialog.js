/* LiveGrab · merge-dialog.js —— 合并所选文件（弹框）
   文件库勾选 ≥2 个文件点「合并」后弹出：按文件库原有排序列出这些文件，
   按住左侧 ⋮⋮ 拖动可调整顺序（鼠标 / 触屏同一套 pointer 事件），
   行尾 ✕ 可把该文件移出本次合并；填文件名、决定是否删源，点「合并」
   按当前顺序把后面的内容依次追加到第一个文件之后。
   顺序只由这里决定：勾选先后是操作痕迹，不代表第 1、2、3 集的播放顺序。

   布局（2026-10-22）：弹框改三段式 ——
     ① 说明行（固定）② 文件列表（可视 5 行，超出在列表内部滚动）
     ③ 文件名 + 删源勾选（固定，不随列表滚动）。弹框本身不滚动。 */

import { t } from './i18n.js';
import { esc, el, toast, openDialog, switchEl, bindSwitches, formatBytes, formatDuration } from './ui.js';

/** 列表默认可见行数：第 6 行起在列表内部滚动（高度由 CSS 的 --mg-rows 同步） */
const VISIBLE_ROWS = 5;

const stemOf = (name) => String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '');

/** 产物名默认值：第一个文件名去扩展名 +「(合并)」 */
const defaultNameOf = (row) => `${stemOf(row && row.f && (row.f.name || row.f.relPath))}(合并)`;

/* 行内：文件名完整显示（可换行、不截断）+ 大小 · 时长。
   平台/主播名不再放进来（列表里冗余），但大小与时长要留——合并前要能确认分量。 */
function rowHTML(row, i) {
  const f = row.f || {};
  const name = f.name || f.relPath || '';
  const meta = [formatBytes(f.bytes || 0), f.durationSec ? formatDuration(f.durationSec) : ''].filter(Boolean).join(' · ');
  return `<div class="mg-row" data-id="${esc(f.id)}">
    <span class="mg-handle" title="${t('merge.dragTip')}" aria-label="${t('merge.dragTip')}">⋮⋮</span>
    <span class="mg-idx">${i + 1}</span>
    <span class="mg-nm" title="${esc(name)}">${esc(name)}</span>
    ${meta ? `<span class="mg-meta">${esc(meta)}</span>` : ''}
    <button type="button" class="mg-x" data-act="del" title="${t('merge.remove')}" aria-label="${t('merge.remove')}">✕</button>
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
 * @param deleteSources 「合并后把源文件移入回收站」的默认值（由调用方取系统设置 deleteAfterMerge）
 * @param trashEnabled  系统是否开启「删除时移入回收站」（deleteToTrash）：决定删源文案是「移入回收站」还是「直接删除」
 * @param onSubmit      ({ ids, name, deleteSources }) => Promise<boolean>，返回 true 才关闭弹框
 */
export function openMergeDialog({ rows, deleteSources = false, trashEnabled = true, onSubmit }) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (list.length < 2) { toast(t('files.mergeNeedTwo'), 'warn'); return null; }

  let order = list;
  let del = !!deleteSources;
  let busy = false;
  let nameDirty = false; // 用户改过文件名后，删除行不再覆盖它

  /* 删源开关文案随两件事动态变化：
     · 开关开/关 → 删不删源文件（关就是全部保留，不存在「进不进回收站」的问题）
     · 系统「删除时移入回收站」开关 → 删掉之后是进回收站可还原，还是直接从磁盘消失 */
  const delText = () => {
    if (!del) return t('merge.keepSources');
    return trashEnabled ? t('merge.deleteTrash') : t('merge.deleteForever');
  };

  return openDialog({
    title: t('merge.title'),
    width: 'min(560px,92vw)',
    cls: 'mg-modal', // 三段式布局 + 弹框自身不滚动（只有列表滚）
    body: `<div class="mg-body">
      <div class="hintline mg-hint" style="margin-top:0">
        <span id="mgCount">${t('merge.count', list.length)}</span> · ${t('merge.dragHint')}
      </div>
      <div class="mg-list" id="mgList" style="--mg-rows:${VISIBLE_ROWS}">${order.map(rowHTML).join('')}</div>
      <div class="hintline mg-empty" id="mgEmpty" style="display:none">${t('merge.empty')}</div>
      <div class="mg-form">
        <div class="form-row" style="margin-top:12px">
          <label class="fl">${t('files.mergeNameLabel')}</label>
          <input class="input" id="mgName" value="${esc(defaultNameOf(list[0]))}" />
          <div class="hintline">${t('files.mergeNameHint')}</div>
        </div>
        <div class="mg-del">
          <span id="mgDelTxt">${delText()}</span>
          ${switchEl(del, 'id="mgDel"')}
        </div>
      </div>
    </div>`,
    footer: (close, body) => {
      const listEl = body.querySelector('#mgList');
      const countEl = body.querySelector('#mgCount');
      const emptyEl = body.querySelector('#mgEmpty');
      const nameEl = body.querySelector('#mgName');
      const delEl = body.querySelector('#mgDel');
      const delTxtEl = body.querySelector('#mgDelTxt');
      // 开关沿用全局 .switch 组件（点击与 Enter/空格都走 bindSwitches），文案只换不改弹框结构
      bindSwitches(body, (sw) => {
        if (!delEl || sw !== delEl) return;
        del = sw.classList.contains('on');
        if (delTxtEl) delTxtEl.textContent = delText();
      });
      if (nameEl) nameEl.addEventListener('input', () => { nameDirty = true; });
      bindDrag(listEl, () => order, (next) => { order = next; });

      const cancel = el('button', 'btn ghost', t('common.cancel'));
      const go = el('button', 'btn primary', t('files.mergeSelected'));
      cancel.onclick = close;

      /* 列表状态同步：文件数文案、空态提示、「合并」可用性。
         删行只动弹框内的待合并清单，不影响文件库里的勾选与磁盘文件。 */
      const refresh = () => {
        if (countEl) countEl.textContent = t('merge.count', order.length);
        if (emptyEl) emptyEl.style.display = order.length ? 'none' : '';
        go.disabled = busy || order.length < 2; // 不足 2 个直接不可点，不用点了才报错
      };

      /* 行尾 ✕：把该文件移出本次合并（不删文件、不改勾选），序号重排、计数刷新 */
      if (listEl) {
        listEl.addEventListener('click', (ev) => {
          const btn = ev.target && ev.target.closest ? ev.target.closest('.mg-x') : null;
          if (!btn || busy) return;
          const node = btn.closest('.mg-row');
          const id = node && node.dataset.id;
          const i = order.findIndex((r) => String(r.f.id) === String(id));
          if (i < 0) return;
          ev.preventDefault();
          ev.stopPropagation(); // 别让行上的拖动/点击逻辑接住这次点击
          order = order.slice(0, i).concat(order.slice(i + 1));
          if (node) node.remove();
          renumber(listEl);
          // 文件名还停在默认值（用户没手改过）时，跟着第一个文件一起更新
          if (!nameDirty && nameEl && order.length) nameEl.value = defaultNameOf(order[0]);
          refresh();
        });
      }

      go.onclick = async () => {
        if (busy || order.length < 2) return;
        const name = String((nameEl && nameEl.value) || '').trim();
        if (!name) { toast(t('files.mergeNameRequired'), 'warn'); if (nameEl) nameEl.focus(); return; }

        busy = true;
        go.textContent = t('merge.submitting');
        if (listEl) listEl.classList.add('mg-busy');
        refresh();
        let ok = false;
        try {
          ok = await onSubmit({ ids: order.map((r) => r.f.id), name, deleteSources: del });
        } finally {
          busy = false;
          go.textContent = t('files.mergeSelected');
          if (listEl) listEl.classList.remove('mg-busy');
          refresh();
        }
        if (ok) close(); // 失败留在弹框：顺序与输入都保留，可直接重试
      };

      refresh();
      if (nameEl) setTimeout(() => { nameEl.focus(); nameEl.select(); }, 30);
      return [cancel, go];
    },
  });
}
