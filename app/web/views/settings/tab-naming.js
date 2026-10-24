/* LiveGrab · views/settings/tab-naming.js —— ③ 命名规则（核心页签）
   命名配置卡片（下拉 / 绑定范围 / 新建 / 复制 / 删除，D12）＋ 文件名模板 + 变量 chip 插入光标处
   ＋ 目录模板 ＋ 日期格式 / 序号位数 / 时间格式 / 非法字符 / 重名策略 / 截断长度
   ＋ 右侧实时预览（POST /api/naming/preview 渲染 3 行）＋ 变量表（12 个变量）。 */

import { api } from '../../api.js';
import { esc, toast, num } from '../../ui.js';
import { t } from '../../i18n.js';

const FALLBACK_TOKENS = [
  ['{主播}', t('settings.nmVarAnchorDesc'), t('settings.nmVarAnchorEx')],
  ['{平台}', t('settings.nmVarPlatformDesc'), t('settings.nmVarPlatformEx')],
  ['{房间号}', t('settings.nmVarRoomDesc'), '23456789'],
  ['{标题}', t('settings.nmVarTitleDesc'), t('settings.nmVarTitleEx')],
  ['{日期}', t('settings.nmVarDateDesc'), '2025-06-01'],
  ['{时间}', t('settings.nmVarTimeDesc'), '20-13-05'],
  ['{清晰度}', t('settings.nmVarQualityDesc'), t('settings.nmVarQualityEx')],
  ['{序号}', t('settings.nmVarSeqDesc'), '001'],
  ['{任务}', t('settings.nmVarTaskDesc'), 'task_07'],
  ['{分辨率}', t('settings.nmVarResolutionDesc'), '1920x1080'],
  ['{时长}', t('settings.nmVarDurationDesc'), '01-00-00'],
  ['{自定义}', t('settings.nmVarCustomDesc'), '—'],
];

const DATE_FORMATS = [
  ['YYYY-MM-DD', 'YYYY-MM-DD（2025-06-01）'],
  ['YYYYMMDD', 'YYYYMMDD（20250601）'],
  ['YYYY.MM.DD', 'YYYY.MM.DD（2025.06.01）'],
  ['YYYY年MM月DD日', t('settings.dateFormatCn')],
];
const TIME_FORMATS = [
  ['HH-mm-ss', 'HH-mm-ss（20-13-05）'],
  ['HHmmss', 'HHmmss（201305）'],
  ['HH.mm', 'HH.mm（20.13）'],
];

const state = {
  naming: null,
  variables: [],
  activeId: '',
  dirty: false,
  timer: null,
  previewToken: 0,
};

/* render 传入的页签根节点（.tabpane）：所有查询与重绘都从这里出发。
   过去用 document.getElementById('tabHost') 反查 —— 那是外层容器，多页签/设置页重挂
   时会查到旧节点甚至另一个页签的 DOM（预览写到不存在的地方、绑定绑到已卸载的树）。 */
let boundRoot = null;

/** 查询根：render 给的就是 .tabpane 本身，兜底再找一层（兼容传入外层 #tabHost 的调用）。 */
function paneOf(root) {
  if (!root) return null;
  if (root.classList && root.classList.contains('tabpane')) return root;
  return root.querySelector('.tabpane') || root;
}

export async function render(root, ctx, kit) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">${t('settings.nmLoading')}</div></div>`;
  try {
    const n = await api.naming();
    state.naming = n || { profiles: [], activeId: 'default', variables: [] };
    state.variables = (n && n.variables) || [];
    const profiles = state.naming.profiles || [];
    if (!profiles.length) {
      state.naming.profiles = [{
        id: 'default', name: t('settings.nmDefaultProfile'),
        fnTemplate: '{日期}_{主播}_{清晰度}_{序号}',
        dirTemplate: '{平台}/{主播}/{日期}',
        options: {}, binding: { type: 'none', value: '' },
      }];
    }
    state.activeId = state.naming.activeId || state.naming.profiles[0].id;
  } catch (e) {
    root.innerHTML = `<div class="card"><div class="empty">${t('settings.nmLoadFailed', esc(e.message || e))}</div></div>`;
    return;
  }
  paint(root, ctx, kit);
}

export function destroy() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  boundRoot = null;
}

function profile() {
  return (state.naming.profiles || []).find((p) => p.id === state.activeId) || (state.naming.profiles || [])[0];
}

function opts() {
  const p = profile();
  if (!p.options) p.options = {};
  return p.options;
}

function paint(root, ctx, kit, keepPreview) {
  const p = profile();
  const o = opts();
  const binding = p.binding || { type: 'none', value: '' };
  const variables = state.variables.length ? state.variables : FALLBACK_TOKENS.map(([token, desc, example]) => ({ token, desc, example }));

  /* 绑定范围：一个下拉同时表达「不绑定 / 按平台 / 按任务」 */
  const bindingValue = binding.type === 'platform' ? 'p:' + binding.value
    : binding.type === 'task' ? 't:' + binding.value : 'none';
  const taskOptions = kit.state.tasks || [];

  const pane = paneOf(root);
  if (!pane) return;
  boundRoot = root;
  pane.innerHTML = `
    <div class="grid2b">
      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>${t('settings.nmConfigTitle')}</h3><span class="hint">${t('settings.nmConfigHint')}</span>
            <div class="spacer"></div>
            <button class="btn sm ghost" id="nmCopy">${t('common.copy')}</button>
            <button class="btn sm ghost" id="nmNew">${t('settings.nmNew')}</button>
            <button class="btn sm danger" id="nmDel">${t('common.delete')}</button>
          </div>
          <div class="card-b">
            <div class="row wrap">
              <div class="f1" style="min-width:240px"><label class="fl">${t('settings.nmCurrentProfile')}</label>
                <select class="select" id="nmProfile">
                  ${(state.naming.profiles || []).map((x) => {
                    const b = x.binding || {};
                    const tag = b.type === 'platform' ? t('settings.nmBoundPlatform', esc(platName(kit, b.value))) : b.type === 'task' ? t('settings.nmBoundTask', esc(b.value)) : t('settings.nmUnbound');
                    return `<option value="${esc(x.id)}"${x.id === state.activeId ? ' selected' : ''}>${esc(x.name || x.id)} ${tag}</option>`;
                  }).join('')}
                </select></div>
              <div class="f1" style="min-width:240px"><label class="fl">${t('settings.nmBindingLabel')}</label>
                <select class="select" id="nmBinding">
                  <option value="none"${bindingValue === 'none' ? ' selected' : ''}>${t('settings.nmBindingNone')}</option>
                  ${kit.state.platforms.map((pl) => `<option value="p:${esc(pl.id)}"${bindingValue === 'p:' + pl.id ? ' selected' : ''}>${t('settings.nmBindingPlatform', esc(pl.name))}</option>`).join('')}
                  ${taskOptions.map((tk) => `<option value="t:${esc(tk.id)}"${bindingValue === 't:' + tk.id ? ' selected' : ''}>${t('settings.nmBindingTask', esc(tk.anchorName || tk.name || tk.id))}</option>`).join('')}
                </select></div>
              <div class="f1" style="min-width:200px"><label class="fl">${t('settings.nmNameLabel')}</label>
                <input class="input" id="nmName" maxlength="40" value="${esc(p.name || p.id || '')}" placeholder="${t('settings.nmNamePlaceholder')}" />
              </div>
            </div>
            <div class="hintline">${t('settings.nmFollowGlobalHint')}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>${t('settings.nmFnTitle')}</h3><span class="hint">${t('settings.nmFnHint')}</span>
            <div class="spacer"></div>
            <button class="btn sm ghost" data-preset="dy">${t('settings.nmPresetDy')}</button>
            <button class="btn sm ghost" data-preset="bili">${t('settings.nmPresetBili')}</button>
          </div>
          <div class="card-b">
            <div class="form-row">
              <label class="fl">${t('settings.nmFnFormatLabel')}</label>
              <input class="input mono" id="nmFn" value="${esc(p.fnTemplate || '')}" />
              <div class="hintline">${t('settings.nmFnHint1')}</div>
            </div>
            <div class="form-row">
              <label class="fl">${t('settings.nmInsertVarLabel')}</label>
              <div class="tokens" id="nmTokens">
                ${variables.map((v) => `<span class="token" data-token="${esc(v.token)}" title="${esc(v.desc || '')}">${esc(v.token)}</span>`).join('')}
              </div>
            </div>
            <div class="form-row">
              <label class="fl">${t('settings.nmDirLabel')}</label>
              <input class="input mono" id="nmDir" value="${esc(p.dirTemplate || '')}" />
              <div class="hintline">${t('settings.nmDirHint')}</div>
            </div>
            <div class="divider"></div>
            <div class="row wrap">
              <div class="f1" style="min-width:170px">
                <label class="fl">${t('settings.nmDateLabel')}</label>
                <select class="select" id="nmDate">
                  ${DATE_FORMATS.map(([v, lbl]) => `<option value="${esc(v)}"${(o.dateFormat || 'YYYY-MM-DD') === v ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}
                </select>
              </div>
              <div class="f1" style="min-width:150px">
                <label class="fl">${t('settings.nmPadLabel')}</label>
                <select class="select" id="nmPad">
                  ${[3, 2, 4].map((v) => `<option value="${v}"${Number(o.seqPad || 3) === v ? ' selected' : ''}>${t('settings.nmPadOption', v, '0'.repeat(v - 1) + '1')}</option>`).join('')}
                </select>
              </div>
              <div class="f1" style="min-width:150px">
                <label class="fl">${t('settings.nmTimeLabel')}</label>
                <select class="select" id="nmTime">
                  ${TIME_FORMATS.map(([v, lbl]) => `<option value="${esc(v)}"${(o.timeFormat || 'HH-mm-ss') === v ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="row wrap" style="margin-top:16px">
              <div class="f1" style="min-width:240px">
                <label class="fl">${t('settings.nmIllegalLabel')}</label>
                <select class="select" id="nmIllegal">
                  <option value="replace"${(o.illegal || 'replace') === 'replace' ? ' selected' : ''}>${t('settings.nmIllegalReplace')}</option>
                  <option value="remove"${o.illegal === 'remove' ? ' selected' : ''}>${t('settings.nmIllegalRemove')}</option>
                  <option value="keep"${o.illegal === 'keep' ? ' selected' : ''}>${t('settings.nmIllegalKeep')}</option>
                </select>
                <div class="hintline">${t('settings.nmIllegalHint')}</div>
              </div>
              <div class="f1" style="min-width:240px">
                <label class="fl">${t('settings.nmDupLabel')}</label>
                <select class="select" id="nmDup">
                  <option value="suffix"${(o.duplicate || 'suffix') === 'suffix' ? ' selected' : ''}>${t('settings.nmDupSuffix')}</option>
                  <option value="timestamp"${o.duplicate === 'timestamp' ? ' selected' : ''}>${t('settings.nmDupTimestamp')}</option>
                  <option value="overwrite"${o.duplicate === 'overwrite' ? ' selected' : ''}>${t('settings.nmDupOverwrite')}</option>
                </select>
              </div>
            </div>
            <div class="form-row" style="margin-top:16px">
              <label class="fl">${t('settings.nmMaxLabel')}</label>
              <div class="row" style="align-items:center;gap:12px">
                <input class="input" id="nmMax" style="width:130px" value="${esc(String(num(o.maxLength || 120, 0)))}" />
                <span style="color:var(--txt-3);font-size:12.5px">${t('settings.nmMaxHint')}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>${t('settings.nmVarsTitle')}</h3><span class="hint">${t('settings.nmVarsHint', variables.length)}</span></div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th style="width:130px">${t('settings.nmColVar')}</th><th>${t('settings.nmColDesc')}</th><th style="width:220px">${t('settings.nmColExample')}</th></tr></thead>
              <tbody>${variables.map((v) => `<tr>
                <td class="mono" style="color:#a9c0ff" data-label="${t('settings.nmColVar')}">${esc(v.token)}</td>
                <td data-label="${t('settings.nmColDesc')}">${esc(v.desc || '')}</td>
                <td class="mono" style="color:var(--txt-2)" data-label="${t('settings.nmColExample')}">${esc(v.example || '—')}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>${t('settings.nmPreviewTitle')}</h3><span class="hint">${t('settings.nmPreviewHint')}</span>
            <div class="spacer"></div><button class="btn sm primary" id="nmSave">${t('settings.nmSaveTitle')}</button></div>
          <div class="card-b">
            <div class="preview">
              <div class="pth" id="nmPrevDir">/data/</div>
              <div id="nmPrevBody">—</div>
            </div>
            <div class="divider"></div>
            <div class="kv">
              <div class="k">${t('settings.nmPathLenLabel')}</div><div id="nmPathLen" class="mono">—</div>
              <div class="k">${t('settings.nmExtLabel')}</div><div class="mono">${t('settings.nmExtValue')}</div>
              <div class="k">${t('settings.nmSortLabel')}</div><div>${t('settings.nmSortValue')}</div>
            </div>
            <div class="divider"></div>
            <div class="note">${t('settings.nmNote')}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>${t('settings.nmTreeTitle')}</h3></div>
          <div class="card-b"><div class="tree" id="nmTree">—</div></div>
        </div>
      </div>
    </div>`;

  bind(root, ctx, kit);
  if (!keepPreview) runPreview(ctx);
}

function platName(kit, id) {
  const p = (kit.state.platforms || []).find((x) => x.id === id);
  return (p && p.name) || id;
}

function bind(root, ctx, kit) {
  const pane = paneOf(root);
  if (!pane) return;

  pane.querySelector('#nmProfile').onchange = (e) => {
    state.activeId = e.target.value;
    saveActive(ctx, kit);
    paint(root, ctx, kit);
  };

  pane.querySelector('#nmBinding').onchange = (e) => {
    const v = e.target.value;
    const p = profile();
    if (v === 'none') p.binding = { type: 'none', value: '' };
    else if (v.startsWith('p:')) p.binding = { type: 'platform', value: v.slice(2) };
    else p.binding = { type: 'task', value: v.slice(2) };
    markDirty(ctx, kit, true);
  };

  pane.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      const p = profile();
      if (btn.dataset.preset === 'dy') { p.fnTemplate = '{日期}_{主播}_{清晰度}_{序号}'; p.dirTemplate = '{平台}/{主播}/{日期}'; }
      else { p.fnTemplate = '{平台}_{主播}_{日期}_{标题}'; p.dirTemplate = '{平台}/{日期}/{主播}'; }
      pane.querySelector('#nmFn').value = p.fnTemplate;
      pane.querySelector('#nmDir').value = p.dirTemplate;
      markDirty(ctx, kit, true);
      toast(btn.dataset.preset === 'dy' ? t('settings.nmPresetDyUsed') : t('settings.nmPresetBiliUsed'));
    };
  });

  const fn = pane.querySelector('#nmFn');
  fn.oninput = () => { profile().fnTemplate = fn.value; markDirty(ctx, kit); };
  const dir = pane.querySelector('#nmDir');
  dir.oninput = () => { profile().dirTemplate = dir.value.replace(/\\+/g, '/'); if (dir.value.includes('\\')) dir.value = profile().dirTemplate; markDirty(ctx, kit); };

  const nmName = pane.querySelector('#nmName');
  if (nmName) nmName.oninput = () => { profile().name = nmName.value.trim(); markDirty(ctx, kit); };

  pane.querySelectorAll('[data-token]').forEach((tok) => {
    tok.onclick = () => {
      const t = tok.dataset.token;
      const start = fn.selectionStart != null ? fn.selectionStart : fn.value.length;
      const end = fn.selectionEnd != null ? fn.selectionEnd : fn.value.length;
      fn.value = fn.value.slice(0, start) + t + fn.value.slice(end);
      fn.focus();
      fn.setSelectionRange(start + t.length, start + t.length);
      profile().fnTemplate = fn.value;
      markDirty(ctx, kit);
    };
  });

  const bindOpt = (sel, key, cast) => {
    const node = pane.querySelector(sel);
    if (!node) return;
    node.onchange = () => { opts()[key] = cast ? cast(node.value) : node.value; markDirty(ctx, kit, true); };
  };
  bindOpt('#nmDate', 'dateFormat');
  bindOpt('#nmPad', 'seqPad', Number);
  bindOpt('#nmTime', 'timeFormat');
  bindOpt('#nmIllegal', 'illegal');
  bindOpt('#nmDup', 'duplicate');
  bindOpt('#nmMax', 'maxLength', Number);

  pane.querySelector('#nmSave').onclick = async () => await persist(ctx, true);

  pane.querySelector('#nmNew').onclick = () => {
    const id = 'p_' + Date.now().toString(36);
    state.naming.profiles.push({
      id, name: t('settings.nmNewName', state.naming.profiles.length + 1),
      fnTemplate: '{日期}_{主播}_{清晰度}_{序号}', dirTemplate: '{平台}/{主播}/{日期}',
      options: {}, binding: { type: 'none', value: '' },
    });
    state.activeId = id;
    state.naming.activeId = id;
    persist(ctx, true);
    paint(root, ctx, kit);
    toast(t('settings.nmCreated'));
  };

  pane.querySelector('#nmCopy').onclick = () => {
    const src = profile();
    const id = 'p_' + Date.now().toString(36);
    state.naming.profiles.push({
      id, name: (src.name || src.id) + t('settings.nmSuffixCopy'),
      fnTemplate: src.fnTemplate, dirTemplate: src.dirTemplate,
      options: Object.assign({}, src.options), binding: { type: 'none', value: '' },
    });
    state.activeId = id;
    state.naming.activeId = id;
    persist(ctx, true);
    paint(root, ctx, kit);
    toast(t('settings.nmCopiedAs', (src.name || src.id) + t('settings.nmSuffixCopy')));
  };

  pane.querySelector('#nmDel').onclick = () => {
    const src = profile();
    if ((state.naming.profiles || []).length <= 1) { toast(t('settings.nmKeepAtLeast'), 'warn'); return; }
    if (src.id === 'default') { toast(t('settings.nmDefaultNotDel'), 'warn'); return; }
    state.naming.profiles = state.naming.profiles.filter((x) => x.id !== src.id);
    state.activeId = state.naming.profiles[0].id;
    state.naming.activeId = state.activeId;
    persist(ctx, true);
    paint(root, ctx, kit);
    toast(t('settings.nmDeleted'));
  };
}

function markDirty(ctx, kit, immediate) {
  state.dirty = true;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { runPreview(ctx); if (immediate) persist(ctx, false); }, immediate ? 0 : 300);
}

async function persist(ctx, notify) {
  state.naming.activeId = state.activeId;
  try {
    await api.saveNaming(state.naming);
    state.dirty = false;
    if (notify) toast(t('settings.namingSaved'));
  } catch (e) {
    toast(e.message || t('settings.namingSaveFailed'), 'err');
  }
}

function saveActive(ctx, kit) {
  state.naming.activeId = state.activeId;
  persist(ctx, false);
}

function sampleDate(fmt) {
  const y = '2025', m = '06', d = '01';
  if (fmt === 'YYYYMMDD') return y + m + d;
  if (fmt === 'YYYY.MM.DD') return y + '.' + m + '.' + d;
  if (fmt === 'YYYY年MM月DD日') return y + '年' + m + '月' + d + '日';
  return `${y}-${m}-${d}`;
}

async function runPreview(ctx) {
  /* 预览是异步（POST /api/naming/preview）且由防抖定时器触发：路由已经切走时必须直接丢弃，
     否则会把结果写到已卸载/别人的 DOM 上（过去用 document.getElementById('tabHost') 反查，
     切页后甚至写到另一个页签里）。 */
  if (ctx && typeof ctx.isActive === 'function' && !ctx.isActive()) return;
  const pane = paneOf(boundRoot);
  if (!pane) return;
  const dirEl = pane.querySelector('#nmPrevDir');
  const bodyEl = pane.querySelector('#nmPrevBody');
  const lenEl = pane.querySelector('#nmPathLen');
  const treeEl = pane.querySelector('#nmTree');
  if (!bodyEl) return;
  const p = profile();
  const token = ++state.previewToken;
  try {
    const r = await api.namingPreview({
      fnTemplate: p.fnTemplate || '{日期}_{主播}',
      dirTemplate: p.dirTemplate || '',
      options: p.options || {},
    });
    if (token !== state.previewToken) return;
    const lines = (r && r.lines) || [];
    const warnings = (r && r.warnings) || [];
    dirEl.textContent = '/data/' + (lines[0] && lines[0].dir ? lines[0].dir + '/' : '');
    bodyEl.innerHTML = lines.map((l) => `<div class="fn">${esc(l.file)}</div>`).join('')
      + `<div class="pth" style="opacity:.55">${t('settings.nmPreviewRemuxNote')}</div>`
      + (warnings.length ? `<div class="pth" style="color:var(--warn)">${esc(warnings.join('；'))}</div>` : '');
    const last = lines[lines.length - 1] || {};
    lenEl.textContent = last.fullPath
      ? t('settings.nmPathLenValue', last.chars || String(last.fullPath).length, last.bytes || '?', last.fileNameBytes || '?')
      : '—';
    if (treeEl) {
      const dir = (lines[0] && lines[0].dir) || '';
      const parts = dir ? dir.split('/') : [];
      treeEl.innerHTML = `<div>/data/</div>`
        + parts.map((x, i) => `<div>${'&nbsp;'.repeat(2)}${'│&nbsp;&nbsp;'.repeat(i)}├─ <span class="d">${esc(x)}</span>/</div>`).join('')
        + lines.map((l) => `<div>${'&nbsp;'.repeat(2)}${'│&nbsp;&nbsp;'.repeat(parts.length)}└─ <span class="f">${esc(l.file)}</span></div>`).join('');
    }
  } catch (e) {
    if (token !== state.previewToken) return;
    /* 后端未就绪时本地兜底渲染，保证模板效果可见 */
    const fill = (tpl, seq) => String(tpl || '').replace(/\{[^}]+\}/g, (m) => {
      if (m === '{序号}') return String(seq).padStart(Number(opts().seqPad || 3), '0');
      if (m === '{日期}') return sampleDate(opts().dateFormat || 'YYYY-MM-DD');
      const hit = FALLBACK_TOKENS.find(([tk]) => tk === m);
      return hit ? hit[2] : m;
    });
    const dir = fill(p.dirTemplate || '').split('/').filter(Boolean).join('/');
    dirEl.textContent = '/data/' + (dir ? dir + '/' : '');
    bodyEl.innerHTML = [1, 2, 3].map((i) => `<div class="fn">${esc(fill(p.fnTemplate, i))}.ts</div>`).join('')
      + `<div class="pth" style="opacity:.55">${t('settings.nmPreviewFallback')}</div>`;
    lenEl.textContent = '—';
    if (treeEl) treeEl.textContent = '—';
  }
}