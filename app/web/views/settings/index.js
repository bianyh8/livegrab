/* LiveGrab · views/settings/index.js —— 系统设置入口
   5 个页签：① 录制与存储 ② 命名规则 ③ 平台账号 ④ 通知 ⑤ 安全与登录（§6.5.1 修正）。
   各页签实现放 views/settings/tab-*.js，统一通过 tabkit.js 读写设置。 */

import { esc, toast } from '../../ui.js';
import { makeKit } from './tabkit.js';

export const page = 'settings';

const TABS = [
  { id: 'rec', label: '录制与存储' },
  { id: 'naming', label: '命名规则' },
  { id: 'platform', label: '平台账号' },
  { id: 'notify', label: '通知' },
  { id: 'security', label: '安全与登录' },
];

const state = {
  tab: 'rec',
  settings: null,
  env: null,
  platforms: [],
  user: null,
  dirty: false,
  saveTimer: null,
  pendingPatch: {},
};

let boundRoot = null;
let activeTab = null;
let ctxRef = null;

export async function render(root, ctx) {
  boundRoot = root;
  ctxRef = ctx;
  root.innerHTML = `<div class="card"><div class="empty">正在加载设置…</div></div>`;

  const [s, e, p] = await Promise.allSettled([ctx.api.settings(), ctx.api.env(), ctx.api.platforms()]);
  if (s.status === 'fulfilled') state.settings = s.value || {};
  else toast('读取设置失败：' + (s.reason && s.reason.message || ''), 'err');
  if (e.status === 'fulfilled') state.env = e.value || {};
  if (p.status === 'fulfilled') state.platforms = (p.value && p.value.items) || [];

  root.innerHTML = `
    <div class="tabs" id="settingsTabs">
      ${TABS.map((t) => `<div class="tab${state.tab === t.id ? ' on' : ''}" data-tab="${t.id}">${esc(t.label)}</div>`).join('')}
    </div>
    <div id="tabHost"></div>`;

  root.querySelectorAll('#settingsTabs .tab').forEach((tab) => {
    tab.onclick = () => {
      if (state.tab === tab.dataset.tab) return;
      state.tab = tab.dataset.tab;
      root.querySelectorAll('#settingsTabs .tab').forEach((x) => x.classList.toggle('on', x === tab));
      mount(ctx);
    };
  });

  ctx.onRefresh(() => { /* 设置页不做 2s 轮询重绘，避免打断输入 */ });
  await mount(ctx);
}

export function destroy() {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; flush(ctxRef); }
  if (activeTab && typeof activeTab.destroy === 'function') { try { activeTab.destroy(); } catch { /* ignore */ } }
  activeTab = null;
  boundRoot = null;
}

async function mount(ctx) {
  const host = boundRoot && boundRoot.querySelector('#tabHost');
  if (!host) return;
  if (activeTab && typeof activeTab.destroy === 'function') { try { activeTab.destroy(); } catch { /* ignore */ } }
  host.innerHTML = '';
  const kit = makeKit(state, ctx, () => queueSave(ctx));
  const paneHost = document.createElement('div');
  paneHost.className = 'tabpane active';
  host.appendChild(paneHost);

  let mod;
  try {
    if (state.tab === 'rec') mod = await import('./tab-rec.js');
    else if (state.tab === 'naming') mod = await import('./tab-naming.js');
    else if (state.tab === 'platform') mod = await import('./tab-platform.js');
    else if (state.tab === 'notify') mod = await import('./tab-notify.js');
    else mod = await import('./tab-security.js');
    activeTab = mod;
    await mod.render(paneHost, ctx, kit);
  } catch (e) {
    paneHost.innerHTML = `<div class="card"><div class="empty">该页签加载失败：${esc(e && e.message || e)}</div></div>`;
  }
}

/* ---------- 设置保存（合并补丁 + 500ms 去抖） ---------- */

function queueSave(ctx) {
  state.dirty = true;
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flush(ctx), 500);
}

async function flush(ctx) {
  if (!ctx || !state.dirty) return;
  state.dirty = false;
  state.saveTimer = null;
  try {
    await ctx.api.saveSettings(state.settings);
    toast('设置已保存');
  } catch (e) {
    toast(e.message || '设置保存失败', 'err');
  }
}

/** 命名页签用：立即保存整个命名配置（PUT /api/naming） */
export async function saveNaming(ctx, naming) {
  try {
    await ctx.api.saveNaming(naming);
    toast('命名配置已保存');
  } catch (e) {
    toast(e.message || '命名配置保存失败', 'err');
  }
}
