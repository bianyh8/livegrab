/* LiveGrab · views/settings/tab-security.js —— ⑥ 安全与登录
   修改密码（POST /api/auth/password）＋ 登录有效期 / 失败锁定 ＋ 退出登录 / 注销所有会话
   ＋ scrypt 与 Cookie 存储位置说明。

   注意：本页所有「安全策略」开关（登录有效期 / 失败锁定 / 允许局域网免登）一律经 kit.set 写入
   settings.security.* 并随设置页统一落库（PUT /api/settings → store → SQLite）。
   不再写 localStorage：此前只写 localStorage 是假开关——后端 auth.js 读的是 settings.security.*，
   刷新/重启后 localStorage 的值丢失，等于没设置。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches, confirmDialog, formatDateTime } from '../../ui.js';
import { t } from '../../i18n.js';

// 登录有效期下拉 → security.sessionDays（天，记住我时生效）
const TTL_DAYS = { '30d': 30, '12h': 0.5, '7d': 7, 'never': 365 };
function daysToTtl(d) {
  if (d == null) return '30d';
  if (Number(d) >= 365) return 'never';          // never 以 365 天近似表达「基本不过期」
  if (Math.abs(Number(d) - 0.5) < 0.01) return '12h';
  if (Math.abs(Number(d) - 7) < 0.01) return '7d';
  return '30d';
}
// 失败锁定下拉：default=后端默认(5次/10分)，none=实质上不锁定（连续失败阈值设为极大值）
function lockToLimits(v) {
  if (v === 'none') return { failLimit: 9999, failLockMin: 0 };
  return { failLimit: 5, failLockMin: 10 };
}
function limitsToLock(failLimit) {
  return (failLimit != null && Number(failLimit) >= 9999) ? 'none' : 'default';
}

export async function render(root, ctx, kit) {
  let me = null;
  try { me = await api.authMe(); } catch { me = null; }
  const username = (me && me.username) || (ctx.user && ctx.user.username) || 'admin';

  // 安全策略来自后端 settings.security（落库、可重载），不再读 localStorage
  const sec = (kit.state.settings && kit.state.settings.security) || {};
  const initialTtl = daysToTtl(sec.sessionDays);
  const initialLock = limitsToLock(sec.failLimit);
  const initialLocal = !!sec.trustLan;

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
          <div class="sw-row"><div><div class="t">${t('settings.secAllowLocalLabel')}</div><div class="d">${t('settings.secAllowLocalDesc')}</div></div><div class="spacer"></div>${switchEl(initialLocal, 'id="scLocal"')}</div>
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
  ttl.value = initialTtl;
  lock.value = initialLock;
  // 经 kit.set 写入 settings.security.*，由设置页 500ms 去抖统一落库（不再是 localStorage 假开关）
  ttl.onchange = () => { const days = TTL_DAYS[ttl.value] ?? 30; kit.set('security.sessionDays', days); };
  lock.onchange = () => { const lim = lockToLimits(lock.value); kit.set('security.failLimit', lim.failLimit); kit.set('security.failLockMin', lim.failLockMin); };

  bindSwitches(root, (sw) => {
    if (sw.id === 'scLocal') {
      const on = sw.classList.contains('on');
      kit.set('security.trustLan', on);
      toast(on ? t('settings.secPrefOn') : t('settings.secPrefOff'), 'warn');
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
