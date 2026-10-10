/* LiveGrab · views/settings/tab-security.js —— ⑤ 安全与登录
   修改密码（POST /api/auth/password）＋ 登录有效期 / 失败锁定说明 ＋ 退出登录 / 注销所有会话
   ＋ scrypt 与 Cookie 存储位置说明。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches, confirmDialog, formatDateTime } from '../../ui.js';
import { t } from '../../i18n.js';

export async function render(root, ctx, kit) {
  let me = null;
  try { me = await api.authMe(); } catch { me = null; }
  const username = (me && me.username) || (ctx.user && ctx.user.username) || 'admin';

  const prefs = loadPrefs();

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>${t('settings.tabSecurity')}</h3><span class="hint">${t('settings.secHint')}</span></div>
        <div class="card-b">
          <div class="rec-item" style="padding:0 0 14px;border-bottom:1px dashed var(--line)">
            <span class="user-row" style="border:0;padding:0"><span class="ava">${esc(String(username).charAt(0).toUpperCase())}</span></span>
            <div class="rec-main">
              <div class="ttl" style="font-size:13px">${esc(username)}</div>
              <div class="meta">
                <span class="chip on"><i class="dot"></i>${t('settings.secLoggedIn')}</span>
                <span>${t('settings.secSessionAt', esc(new Date().toLocaleString('zh-CN')))}</span>
                ${me && me.lastLoginAt ? `<span>${t('settings.secLastLogin', esc(formatDateTime(me.lastLoginAt)))}${me.lastLoginIp ? t('settings.secFromIp', esc(me.lastLoginIp)) : ''}</span>` : ''}
              </div>
            </div>
            <button class="btn sm ghost" id="scKillAll">${t('settings.secKillAll')}</button>
          </div>

          <div class="row wrap" style="margin-top:14px">
            <div class="f1" style="min-width:180px"><label class="fl">${t('settings.secOldLabel')}</label>
              <input class="input" id="scOld" type="password" placeholder="••••••••" autocomplete="current-password" /></div>
            <div class="f1" style="min-width:180px"><label class="fl">${t('settings.secNewLabel')}</label>
              <input class="input" id="scNew" type="password" placeholder="${t('settings.secNewPlaceholder')}" autocomplete="new-password" /></div>
            <div class="f1" style="min-width:180px"><label class="fl">${t('settings.secNew2Label')}</label>
              <input class="input" id="scNew2" type="password" autocomplete="new-password" /></div>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <div class="f1" style="min-width:220px"><label class="fl">${t('settings.secTtlLabel')}</label>
              <select class="select" id="scTtl">
                <option value="30d">${t('settings.secTtl30d')}</option>
                <option value="12h">${t('settings.secTtl12h')}</option>
                <option value="7d">${t('settings.secTtl7d')}</option>
                <option value="never">${t('settings.secTtlNever')}</option>
              </select></div>
            <div class="f1" style="min-width:220px"><label class="fl">${t('settings.secLockLabel')}</label>
              <select class="select" id="scLock">
                <option value="default">${t('settings.secLockDefault')}</option>
                <option value="none">${t('settings.secLockNone')}</option>
              </select></div>
          </div>
          <div class="hintline">${t('settings.secPolicyHint')}</div>
          <div class="sw-row" style="margin-top:6px"><div><div class="t">${t('settings.secAutoLogoutLabel')}</div><div class="d">${t('settings.secAutoLogoutDesc')}</div></div><div class="spacer"></div>${switchEl(true, 'data-fixed="1"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.secAllowLocalLabel')}</div><div class="d">${t('settings.secAllowLocalDesc')}</div></div><div class="spacer"></div>${switchEl(!!prefs.allowLocal, 'id="scLocal"')}</div>
          <div class="hintline">${t('settings.secScryptHint')}</div>
          <div class="row" style="margin-top:14px;gap:10px">
            <button class="btn primary" id="scSave">${t('settings.secSaveBtn')}</button>
            <button class="btn ghost" id="scLogout">${t('settings.secLogoutBtn')}</button>
          </div>
        </div>
      </div>
    </div>`;

  const ttl = root.querySelector('#scTtl');
  const lock = root.querySelector('#scLock');
  ttl.value = prefs.ttl || '30d';
  lock.value = prefs.lock || 'default';
  ttl.onchange = () => savePrefs({ ttl: ttl.value });
  lock.onchange = () => savePrefs({ lock: lock.value });

  bindSwitches(root, (sw) => {
    if (sw.id === 'scLocal') {
      savePrefs({ allowLocal: sw.classList.contains('on') });
      toast(sw.classList.contains('on') ? t('settings.secPrefOn') : t('settings.secPrefOff'), 'warn');
    }
  });

  root.querySelector('#scSave').onclick = async (ev) => {
    const btn = ev.currentTarget;
    const oldPw = root.querySelector('#scOld').value;
    const newPw = root.querySelector('#scNew').value;
    const newPw2 = root.querySelector('#scNew2').value;
    if (!oldPw) { toast(t('settings.secErrOldPw'), 'warn'); return; }
    if (newPw.length < 8) { toast(t('settings.secErrWeak'), 'warn'); return; }
    if (newPw !== newPw2) { toast(t('settings.secErrMismatch'), 'warn'); return; }
    btn.disabled = true;
    try {
      await api.password(oldPw, newPw);
      root.querySelector('#scOld').value = '';
      root.querySelector('#scNew').value = '';
      root.querySelector('#scNew2').value = '';
      toast(t('settings.secPwUpdated'));
    } catch (e) {
      toast(e.message || t('settings.secPwFailed'), 'err');
    } finally {
      btn.disabled = false;
    }
  };

  root.querySelector('#scLogout').onclick = () => ctx.emit('logout');
  root.querySelector('#scKillAll').onclick = () => confirmDialog({
    title: t('settings.secKillAll'), danger: true, ok: t('settings.secLogoutOk'),
    text: t('settings.secKillAllText'),
    onOk: async () => {
      try { await api.logout(); } catch { /* 忽略 */ }
      toast(t('settings.secSessionsLoggedOut'));
      ctx.emit('logout');
    },
  });
}

const PREF_KEY = 'livegrab.security.prefs';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(patch) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(Object.assign(loadPrefs(), patch))); } catch { /* 忽略 */ }
}