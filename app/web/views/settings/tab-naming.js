/* LiveGrab · views/settings/tab-naming.js —— ② 命名规则（核心页签）
   命名配置卡片（下拉 / 绑定范围 / 新建 / 复制 / 删除，D12）＋ 文件名模板 + 变量 chip 插入光标处
   ＋ 目录模板 ＋ 日期格式 / 序号位数 / 时间格式 / 非法字符 / 重名策略 / 截断长度
   ＋ 右侧实时预览（POST /api/naming/preview 渲染 3 行）＋ 变量表（12 个变量）。 */

import { api } from '../../api.js';
import { esc, toast, num } from '../../ui.js';

const FALLBACK_TOKENS = [
  ['{主播}', '主播昵称', '某某小主播'],
  ['{平台}', '平台名称', '抖音 / 哔哩哔哩'],
  ['{房间号}', '直播间房间号', '23456789'],
  ['{标题}', '当次直播标题', '今天打排位 冲王者'],
  ['{日期}', '录制开始日期（格式见上）', '2025-06-01'],
  ['{时间}', '录制开始时间', '20-13-05'],
  ['{清晰度}', '实际使用的清晰度', '原画 / 蓝光 / 仅音频'],
  ['{序号}', '分段序号，按位数补零', '001'],
  ['{任务}', '任务 ID', 'task_07'],
  ['{分辨率}', '实际分辨率', '1920x1080'],
  ['{时长}', '分段时长（录制完成后才可知，仅合并命名用）', '01-00-00'],
  ['{自定义}', '任务级自定义文本，可在任务中单独覆盖', '—'],
];

const DATE_FORMATS = [
  ['YYYY-MM-DD', 'YYYY-MM-DD（2025-06-01）'],
  ['YYYYMMDD', 'YYYYMMDD（20250601）'],
  ['YYYY.MM.DD', 'YYYY.MM.DD（2025.06.01）'],
  ['YYYY年MM月DD日', 'YYYY年MM月DD日（2025年06月01日）'],
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

export async function render(root, ctx, kit) {
  root.innerHTML = `<div class="card"><div class="empty">正在加载命名配置…</div></div>`;
  try {
    const n = await api.naming();
    state.naming = n || { profiles: [], activeId: 'default', variables: [] };
    state.variables = (n && n.variables) || [];
    const profiles = state.naming.profiles || [];
    if (!profiles.length) {
      state.naming.profiles = [{
        id: 'default', name: '通用（默认）',
        fnTemplate: '{日期}_{主播}_{清晰度}_{序号}',
        dirTemplate: '{平台}/{主播}/{日期}',
        options: {}, binding: { type: 'none', value: '' },
      }];
    }
    state.activeId = state.naming.activeId || state.naming.profiles[0].id;
  } catch (e) {
    root.innerHTML = `<div class="card"><div class="empty">命名配置加载失败：${esc(e.message || e)}</div></div>`;
    return;
  }
  paint(ctx, kit);
}

export function destroy() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

function profile() {
  return (state.naming.profiles || []).find((p) => p.id === state.activeId) || (state.naming.profiles || [])[0];
}

function opts() {
  const p = profile();
  if (!p.options) p.options = {};
  return p.options;
}

function paint(ctx, kit, keepPreview) {
  const p = profile();
  const o = opts();
  const binding = p.binding || { type: 'none', value: '' };
  const variables = state.variables.length ? state.variables : FALLBACK_TOKENS.map(([token, desc, example]) => ({ token, desc, example }));

  /* 绑定范围：一个下拉同时表达「不绑定 / 按平台 / 按任务」 */
  const bindingValue = binding.type === 'platform' ? 'p:' + binding.value
    : binding.type === 'task' ? 't:' + binding.value : 'none';
  const taskOptions = kit.state.tasks || [];

  const host = document.getElementById('tabHost');
  if (!host) return;
  const pane = host.querySelector('.tabpane') || host;
  pane.innerHTML = `
    <div class="grid2b">
      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>命名配置</h3><span class="hint">一个配置 = 一套「文件名模板 + 目录模板 + 日期格式 + 冲突策略」，可绑定到平台或任务</span>
            <div class="spacer"></div>
            <button class="btn sm ghost" id="nmCopy">复制</button>
            <button class="btn sm ghost" id="nmNew">新建</button>
            <button class="btn sm danger" id="nmDel">删除</button>
          </div>
          <div class="card-b">
            <div class="row wrap">
              <div class="f1" style="min-width:240px"><label class="fl">当前配置</label>
                <select class="select" id="nmProfile">
                  ${(state.naming.profiles || []).map((x) => {
                    const b = x.binding || {};
                    const tag = b.type === 'platform' ? `（绑定：${esc(platName(kit, b.value))}）` : b.type === 'task' ? `（绑定：任务 ${esc(b.value)}）` : '（未绑定）';
                    return `<option value="${esc(x.id)}"${x.id === state.activeId ? ' selected' : ''}>${esc(x.name || x.id)} ${tag}</option>`;
                  }).join('')}
                </select></div>
              <div class="f1" style="min-width:240px"><label class="fl">绑定范围</label>
                <select class="select" id="nmBinding">
                  <option value="none"${bindingValue === 'none' ? ' selected' : ''}>不绑定（作为新任务默认）</option>
                  ${kit.state.platforms.map((pl) => `<option value="p:${esc(pl.id)}"${bindingValue === 'p:' + pl.id ? ' selected' : ''}>按平台：${esc(pl.name)}</option>`).join('')}
                  ${taskOptions.map((t) => `<option value="t:${esc(t.id)}"${bindingValue === 't:' + t.id ? ' selected' : ''}>按任务：${esc(t.anchorName || t.name || t.id)}</option>`).join('')}
                </select></div>
              <div class="f1" style="min-width:200px"><label class="fl">配置名称</label>
                <input class="input" id="nmName" maxlength="40" value="${esc(p.name || p.id || '')}" placeholder="命名配置名称，便于区分多套模板" />
              </div>
            </div>
            <div class="hintline">任务里"跟随全局"时使用其平台对应的配置；任务里自定义过则优先用任务自己的。渲染顺序永远是：变量替换 → 非法字符处理 → 去首尾空格与点 → 截断 → 重名去重 → 拼接扩展名。</div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>文件名模板</h3><span class="hint">点击下方变量即可插入到光标处</span>
            <div class="spacer"></div>
            <button class="btn sm ghost" data-preset="dy">抖音预设</button>
            <button class="btn sm ghost" data-preset="bili">B站预设</button>
          </div>
          <div class="card-b">
            <div class="form-row">
              <label class="fl">文件名格式</label>
              <input class="input mono" id="nmFn" value="${esc(p.fnTemplate || '')}" />
              <div class="hintline">不含扩展名；扩展名由「封装格式」自动决定（.ts / .mp4 / .m4a / .flv）</div>
            </div>
            <div class="form-row">
              <label class="fl">插入变量</label>
              <div class="tokens" id="nmTokens">
                ${variables.map((v) => `<span class="token" data-token="${esc(v.token)}" title="${esc(v.desc || '')}">${esc(v.token)}</span>`).join('')}
              </div>
            </div>
            <div class="form-row">
              <label class="fl">目录结构模板</label>
              <input class="input mono" id="nmDir" value="${esc(p.dirTemplate || '')}" />
              <div class="hintline">相对「存储根目录」，留空表示全部平铺到根目录；支持 / 创建多级子目录（<span class="mono">\\</span> 会自动归一化为 <span class="mono">/</span>）</div>
            </div>
            <div class="divider"></div>
            <div class="row wrap">
              <div class="f1" style="min-width:170px">
                <label class="fl">日期格式</label>
                <select class="select" id="nmDate">
                  ${DATE_FORMATS.map(([v, t]) => `<option value="${esc(v)}"${(o.dateFormat || 'YYYY-MM-DD') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}
                </select>
              </div>
              <div class="f1" style="min-width:150px">
                <label class="fl">分段序号位数</label>
                <select class="select" id="nmPad">
                  ${[3, 2, 4].map((v) => `<option value="${v}"${Number(o.seqPad || 3) === v ? ' selected' : ''}>${v} 位（${'0'.repeat(v - 1)}1）</option>`).join('')}
                </select>
              </div>
              <div class="f1" style="min-width:150px">
                <label class="fl">时间格式</label>
                <select class="select" id="nmTime">
                  ${TIME_FORMATS.map(([v, t]) => `<option value="${esc(v)}"${(o.timeFormat || 'HH-mm-ss') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="row wrap" style="margin-top:16px">
              <div class="f1" style="min-width:240px">
                <label class="fl">非法字符处理</label>
                <select class="select" id="nmIllegal">
                  <option value="replace"${(o.illegal || 'replace') === 'replace' ? ' selected' : ''}>替换为下划线 _（推荐）</option>
                  <option value="remove"${o.illegal === 'remove' ? ' selected' : ''}>直接删除</option>
                  <option value="keep"${o.illegal === 'keep' ? ' selected' : ''}>保留（可能失败）</option>
                </select>
                <div class="hintline">跨平台并集过滤 <span class="mono">\\ / : * ? " &lt; &gt; |</span> 与首尾空格、点</div>
              </div>
              <div class="f1" style="min-width:240px">
                <label class="fl">重名策略</label>
                <select class="select" id="nmDup">
                  <option value="suffix"${(o.duplicate || 'suffix') === 'suffix' ? ' selected' : ''}>追加 _2 _3 序号（推荐）</option>
                  <option value="timestamp"${o.duplicate === 'timestamp' ? ' selected' : ''}>追加录制时间戳</option>
                  <option value="overwrite"${o.duplicate === 'overwrite' ? ' selected' : ''}>覆盖同名文件</option>
                </select>
              </div>
            </div>
            <div class="form-row" style="margin-top:16px">
              <label class="fl">超长名称处理</label>
              <div class="row" style="align-items:center;gap:12px">
                <input class="input" id="nmMax" style="width:130px" value="${esc(String(num(o.maxLength || 120, 0)))}" />
                <span style="color:var(--txt-3);font-size:12.5px">字符，超出时截断并在结尾保留序号（Linux 单层目录名上限 255 <b>字节</b>，中文按 UTF-8 约 3 字节/字，故 120 字符更保险）</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>变量说明</h3><span class="hint">共 ${variables.length} 个可用变量</span></div>
          <div class="card-b" style="padding:0">
            <table>
              <thead><tr><th style="width:130px">变量</th><th>说明</th><th style="width:220px">示例值</th></tr></thead>
              <tbody>${variables.map((v) => `<tr>
                <td class="mono" style="color:#a9c0ff">${esc(v.token)}</td>
                <td>${esc(v.desc || '')}</td>
                <td class="mono" style="color:var(--txt-2)">${esc(v.example || '—')}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>实时预览</h3><span class="hint">示例数据</span>
            <div class="spacer"></div><button class="btn sm primary" id="nmSave">保存命名配置</button></div>
          <div class="card-b">
            <div class="preview">
              <div class="pth" id="nmPrevDir">/data/</div>
              <div id="nmPrevBody">—</div>
            </div>
            <div class="divider"></div>
            <div class="kv">
              <div class="k">完整路径长度</div><div id="nmPathLen" class="mono">—</div>
              <div class="k">扩展名</div><div class="mono">.ts（录制中）→ .mp4（转封装后）</div>
              <div class="k">排序效果</div><div>同一直播间分段按名称自然排序连续</div>
            </div>
            <div class="divider"></div>
            <div class="note">同一模板需同时满足：① 同一场直播的多分段可连续排序；② 不同直播间不互相覆盖；③ 文件名中可直接看出日期与清晰度。未识别变量会原样保留并提示。</div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><h3>目录树预览</h3></div>
          <div class="card-b"><div class="tree" id="nmTree">—</div></div>
        </div>
      </div>
    </div>`;

  bind(ctx, kit);
  if (!keepPreview) runPreview();
}

function platName(kit, id) {
  const p = (kit.state.platforms || []).find((x) => x.id === id);
  return (p && p.name) || id;
}

function bind(ctx, kit) {
  const pane = (document.getElementById('tabHost') || {}).querySelector ? document.getElementById('tabHost').querySelector('.tabpane') : null;
  if (!pane) return;

  pane.querySelector('#nmProfile').onchange = (e) => {
    state.activeId = e.target.value;
    saveActive(ctx, kit);
    paint(ctx, kit);
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
      toast(btn.dataset.preset === 'dy' ? '已应用抖音预设模板' : '已应用 B 站预设模板');
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
      id, name: '新配置 ' + (state.naming.profiles.length + 1),
      fnTemplate: '{日期}_{主播}_{清晰度}_{序号}', dirTemplate: '{平台}/{主播}/{日期}',
      options: {}, binding: { type: 'none', value: '' },
    });
    state.activeId = id;
    state.naming.activeId = id;
    persist(ctx, true);
    paint(ctx, kit);
    toast('已新建空白命名配置');
  };

  pane.querySelector('#nmCopy').onclick = () => {
    const src = profile();
    const id = 'p_' + Date.now().toString(36);
    state.naming.profiles.push({
      id, name: (src.name || src.id) + '_副本',
      fnTemplate: src.fnTemplate, dirTemplate: src.dirTemplate,
      options: Object.assign({}, src.options), binding: { type: 'none', value: '' },
    });
    state.activeId = id;
    state.naming.activeId = id;
    persist(ctx, true);
    paint(ctx, kit);
    toast(`已复制为新配置「${(src.name || src.id)}_副本」`);
  };

  pane.querySelector('#nmDel').onclick = () => {
    const src = profile();
    if ((state.naming.profiles || []).length <= 1) { toast('至少保留一套命名配置', 'warn'); return; }
    if (src.id === 'default') { toast('默认配置不可删除；请先改绑使用它的任务', 'warn'); return; }
    state.naming.profiles = state.naming.profiles.filter((x) => x.id !== src.id);
    state.activeId = state.naming.profiles[0].id;
    state.naming.activeId = state.activeId;
    persist(ctx, true);
    paint(ctx, kit);
    toast('已删除该命名配置（使用它的任务将回落到平台配置）');
  };
}

function markDirty(ctx, kit, immediate) {
  state.dirty = true;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { runPreview(); if (immediate) persist(ctx, false); }, immediate ? 0 : 300);
}

async function persist(ctx, notify) {
  state.naming.activeId = state.activeId;
  try {
    await api.saveNaming(state.naming);
    state.dirty = false;
    if (notify) toast('命名配置已保存');
  } catch (e) {
    toast(e.message || '命名配置保存失败', 'err');
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

async function runPreview() {
  const pane = document.getElementById('tabHost') && document.getElementById('tabHost').querySelector('.tabpane');
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
      + `<div class="pth" style="opacity:.55">… 录制结束后转封装为同名 .mp4</div>`
      + (warnings.length ? `<div class="pth" style="color:var(--warn)">${esc(warnings.join('；'))}</div>` : '');
    const last = lines[lines.length - 1] || {};
    lenEl.textContent = last.fullPath
      ? `${last.chars || String(last.fullPath).length} 字符 / ${last.bytes || '?'} 字节 · 文件名 ${last.fileNameBytes || '?'} 字节（单层名上限 255 字节）`
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
      + `<div class="pth" style="opacity:.55">（后端预览接口不可用，以上为本地兜底渲染）</div>`;
    lenEl.textContent = '—';
    if (treeEl) treeEl.textContent = '—';
  }
}
