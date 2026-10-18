/* LiveGrab · views/settings/index.js —— 系统设置入口
   7 个页签：① 录制 ② 存储 ③ 命名规则 ④ 平台账号 ⑤ 通知 ⑥ 安全与登录 ⑦ 系统更新。
   各页签实现放 views/settings/tab-*.js，统一通过 tabkit.js 读写设置。 */

import { esc, toast } from '../../ui.js';
import { makeKit } from './tabkit.js';
import { t } from '../../i18n.js';

export const page = 'settings';

const TABS = [
  { id: 'rec', label: t('settings.tabRec') },
  { id: 'store', label: t('settings.tabStore') },
  { id: 'naming', label: t('settings.tabNaming') },
  { id: 'platform', label: t('settings.tabPlatform') },
  { id: 'notify', label: t('settings.tabNotify') },
  { id: 'security', label: t('settings.tabSecurity') },
  { id: 'update', label: t('settings.tabUpdate') },
];

const state = {
  tab: 'rec',
  settings: null,
  env: null,
  platforms: [],
  dirty: false,
  saveTimer: null,
};

let boundRoot = null;
let activeTab = null;
let ctxRef = null;

/* 视图是否仍是当前活动视图（路由已切走则为 false）。
   ctx.isActive 由路由器注入；缺省视为活动，仅靠 boundRoot 兜底。 */
function isActive(ctx) {
  return !ctx || typeof ctx.isActive !== 'function' || ctx.isActive();
}

export async function render(root, ctx) {
  boundRoot = root;
  ctxRef = ctx;
  root.innerHTML = `<div class="card"><div class="empty">${t('settings.loading')}</div></div>`;

  const [s, e, p] = await Promise.allSettled([ctx.api.settings(), ctx.api.env(), ctx.api.platforms()]);
  /* 三个请求在飞行中时用户可能已切走：此时不能再写 #view，否则会覆盖新页面 */
  if (!boundRoot || !isActive(ctx)) return;
  if (s.status === 'fulfilled') state.settings = s.value || {};
  else toast(t('settings.loadFailed', (s.reason && s.reason.message) || ''), 'err');
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
  if (!host || !isActive(ctx)) return;
  if (activeTab && typeof activeTab.destroy === 'function') { try { activeTab.destroy(); } catch { /* ignore */ } }
  host.innerHTML = '';
  const kit = makeKit(state, ctx, () => queueSave(ctx));
  const paneHost = document.createElement('div');
  paneHost.className = 'tabpane active';
  host.appendChild(paneHost);

  let mod;
  try {
    if (state.tab === 'rec') mod = await import('./tab-rec.js');
    else if (state.tab === 'store') mod = await import('./tab-store.js');
    else if (state.tab === 'naming') mod = await import('./tab-naming.js');
    else if (state.tab === 'platform') mod = await import('./tab-platform.js');
    else if (state.tab === 'notify') mod = await import('./tab-notify.js');
    else if (state.tab === 'update') mod = await import('./tab-update.js');
    else mod = await import('./tab-security.js');
    activeTab = mod;
    await mod.render(paneHost, ctx, kit);
  } catch (e) {
    paneHost.innerHTML = `<div class="card"><div class="empty">${t('settings.tabLoadFailed', esc((e && e.message) || e))}</div></div>`;
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
    toast(t('settings.saved'));
  } catch (e) {
    toast(e.message || t('settings.saveFailed'), 'err');
  }
}

/** 命名页签用：立即保存整个命名配置（PUT /api/naming） */
export async function saveNaming(ctx, naming) {
  try {
    await ctx.api.saveNaming(naming);
    toast(t('settings.namingSaved'));
  } catch (e) {
    toast(e.message || t('settings.namingSaveFailed'), 'err');
  }
}
