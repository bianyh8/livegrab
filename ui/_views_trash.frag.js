/* LiveGrab · ui/_views_trash.frag.js —— 回收站（原型片段，纯 HTML 字符串，不绑定事件）
   ------------------------------------------------------------------------------------------
   对齐 production：app/web/views/trash.js（整篇 166 行）
     · card-h：t('nav.trash')「回收站」+ hint「N 项 · X」+ spacer + #trRestoreAll「全部还原」+ #trEmpty「清空回收站」(danger)
       —— total 为 0 时两个按钮 disabled（trash.js：${state.total ? '' : ' disabled'}）
     · card-b：t('trash.retentionHint')（含 <span class="mono">/data/.trash</span> 与 保留天数）
              + 每条 trashLine(item)：.fl-item > .fl-ico.plain（缩略图占位）>
                文件名 + 整场/单个文件 chip + 含刮削 chip（hasSidecar）
                + 第二行：体积 / 文件数（multipleFiles|singleFile）/ 删除于（deletedAt）
                + 右侧「还原」/「清空」
              + pagerHTML('trPager', page, pages, total)；空态 emptyBox(t('trash.empty'))
     · 保留天数取 D.settings.trashRetentionDays（trash.js 由 r.retentionDays 写入 state.retentionDays，默认 7）
   · 文案 1:1 取自 app/web/i18n/zh-CN.json 的 trash.* / nav.* / files.clear；类名全部来自骨架 ui/index.html。
   · 骨架差异：h.pagerHTML 输出「第 1 / 1 页」；production ui.js / common.pagerInfo 为「第 1/1 页」，本片段按 production 输出。
   ------------------------------------------------------------------------------------------ */

const PAGE_SIZE = 10; // trash.js：PAGE_SIZE（任务/文件/回收站统一每页 10 条）
const RETENTION_FALLBACK = 7;

/* trash.js trashLine()：缩略图失败时的扩展名占位（媒体文件名后缀 → 大写） */
function extOf(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1).toUpperCase() : '';
}

export function renderTrash(ctx, D, h) {
  const items = (D && D.trash) || [];
  const total = items.length;

  /* 体积：trash.js api.trash() 的 r.bytes（无则退回 items 求和） */
  const bytesOf = (it) => Number(it && it.bytes) || 0;
  const bytes = items.reduce((n, it) => n + bytesOf(it), 0) || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
  const page = 1;
  const pageItems = items.slice(0, PAGE_SIZE);

  const retentionDays = Number(D && D.settings && D.settings.trashRetentionDays) || RETENTION_FALLBACK;

  const body = total
    ? `<div class="hintline" style="margin:0 0 12px">回收站文件保留在 <span class="mono">/data/.trash</span>，按设置保留 ${h.esc(String(retentionDays))} 天自动清理。含媒体文件与其同名的刮削图片/描述（.jpg/.nfo），均一并可还原。</div>
       ${pageItems.map((it) => trashLine(it, h)).join('')}
       ${pagerHtml('trPager', page, pages, total)}`
    : h.emptyBox('回收站为空');

  return `
  <div class="card">
    <div class="card-h">
      <h3>回收站</h3>
      <span class="hint">${h.esc(`${total} 项`)} · ${h.esc(h.fmtBytes(bytes))}</span>
      <div class="spacer"></div>
      <button class="btn sm" id="trRestoreAll"${total ? '' : ' disabled'}>全部还原</button>
      <button class="btn sm danger" id="trEmpty"${total ? '' : ' disabled'}>清空回收站</button>
    </div>
    <div class="card-b">
      ${body}
    </div>
  </div>`;
}

/* ---------- 单条：对齐 trash.js trashLine(item) ---------- */
function trashLine(item, h) {
  const it = item || {};
  const meta = Array.isArray(it.items) ? it.items : [];
  /* 主媒体文件：跳过 sidecar / poster / nfo 后的第一个（trash.js 同逻辑） */
  const media = meta.find((x) => x && x.kind !== 'sidecar' && x.kind !== 'poster' && x.kind !== 'nfo') || meta[0] || {};
  const fileCount = meta.filter((x) => x && x.kind !== 'sidecar').length;
  /* trash.js 原文只认 sidecar；原型 mock 里刮削附件标记为 poster/nfo，故一并视为「含刮削」 */
  const hasSidecar = meta.some((x) => x && (x.kind === 'sidecar' || x.kind === 'poster' || x.kind === 'nfo'));
  const extLabel = extOf(media.name) || '媒体';
  const name = it.name || media.name || '未命名';

  return `
    <div class="fl-item" style="align-items:flex-start" data-trash="${h.esc(it.id)}">
      <div class="fl-ico plain" title="${h.esc(name)}"><span class="th-ph">${h.esc(extLabel)}</span></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;min-width:0;font-size:13px;font-weight:600">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0" title="${h.esc(name)}">${h.esc(name)}</span>
          <span class="chip" style="margin-left:6px;flex:0 0 auto">${it.kind === 'session' ? '整场' : '单个文件'}</span>
          ${hasSidecar ? `<span class="chip" style="margin-left:6px;flex:0 0 auto">含刮削</span>` : ''}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:5px;font-size:11.5px;color:var(--txt-3)">
          <span>${h.esc(h.fmtBytes(it.bytes || 0))}</span>
          <span>${h.esc(fileCount > 1 ? `${fileCount} 个文件` : '1 个媒体文件')}</span>
          <span>${h.esc(`删除于 ${h.fmtDateTime(it.deletedAt || it.createdAt)}`)}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-trash-act="restore" data-id="${h.esc(it.id)}">还原</button>
        <button class="btn sm danger" data-trash-act="purge" data-id="${h.esc(it.id)}" data-confirm>清除</button>
      </div>
    </div>`;
}

/* ---------- 分页：production ui.js pagerHTML()（第 N/M 页 · 共 K 条） ---------- */
function pagerHtml(id, page, pages, total) {
  return `<div class="pager" id="${id}">
        <button class="btn sm ghost" data-pg="first"${page <= 1 ? ' disabled' : ''}>«</button>
        <button class="btn sm ghost" data-pg="prev"${page <= 1 ? ' disabled' : ''}>‹ 上一页</button>
        <span class="pager-info">第 ${page}/${pages} 页 · 共 ${total} 条</span>
        <button class="btn sm ghost" data-pg="next"${page >= pages ? ' disabled' : ''}>下一页 ›</button>
        <button class="btn sm ghost" data-pg="last"${page >= pages ? ' disabled' : ''}>»</button>
      </div>`;
}
