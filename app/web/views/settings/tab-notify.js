/* LiveGrab · views/settings/tab-notify.js —— ⑤ 通知
   Webhook ＋ 4 个事件开关（开播/录制失败/磁盘告警/Cookie 过期）＋ 60 秒去重开关（D18）
   ＋ 5/15/45 秒重试开关 ＋ 测试发送。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches } from '../../ui.js';
import { t } from '../../i18n.js';
import { read } from './tabkit.js';

export async function render(root, ctx, kit) {
  const n = read(kit.state, 'notify', {}) || {};
  const dedupeSec = Number(n.dedupeSec != null ? n.dedupeSec : 60) || 60;
  const retryOn = n.retry !== false;

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>${t('settings.tabNotify')}</h3><span class="hint">${t('settings.ntHint')}</span></div>
        <div class="card-b">
          <div class="form-row">
            <label class="fl">${t('settings.ntWebhookLabel')}</label>
            <input class="input mono" id="ntHook" placeholder="https://sctapi.ftqq.com/xxx.send" value="${esc(n.webhook || '')}" />
            <div class="hintline">${t('settings.ntWebhookHint')}</div>
          </div>
          <div class="sw-row"><div><div class="t">${t('settings.ntOnLiveLabel')}</div><div class="d">${t('settings.ntOnLiveDesc')}</div></div><div class="spacer"></div>${switchEl(n.onLive !== false, 'id="ntLive"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.ntOnErrorLabel')}</div><div class="d">${t('settings.ntOnErrorDesc')}</div></div><div class="spacer"></div>${switchEl(n.onError !== false, 'id="ntError"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.ntOnDiskLabel')}</div><div class="d">${t('settings.ntOnDiskDesc')}</div></div><div class="spacer"></div>${switchEl(n.onDisk !== false, 'id="ntDisk"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.ntOnCookieLabel')}</div><div class="d">${t('settings.ntOnCookieDesc')}</div></div><div class="spacer"></div>${switchEl(!!n.onCookie, 'id="ntCookie"')}</div>
          <div class="divider"></div>
          <div class="sw-row"><div><div class="t">${t('settings.ntDedupeLabel', dedupeSec)}</div><div class="d">${t('settings.ntDedupeDesc')}</div></div><div class="spacer"></div>${switchEl(n.dedupe !== false, 'id="ntDedupe"')}</div>
          <div class="form-row" style="margin:-4px 0 12px 0">
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="ntDedupeSec" style="width:100px" value="${esc(String(dedupeSec))}" />
              <span style="color:var(--txt-3);font-size:12.5px">${t('settings.ntDedupeSecSuffix')}</span>
            </div>
          </div>
          <div class="sw-row"><div><div class="t">${t('settings.ntRetryLabel')}</div><div class="d">${t('settings.ntRetryDesc')}</div></div><div class="spacer"></div>${switchEl(retryOn, 'id="ntRetry"')}</div>
          <button class="btn" id="ntTest" style="margin-top:12px">${t('settings.ntTestBtn')}</button>
        </div>
      </div>
    </div>`;

  kit.bind(root.querySelector('#ntHook'), 'notify.webhook');
  kit.bind(root.querySelector('#ntDedupeSec'), 'notify.dedupeSec', 'number');
  bindSwitches(root, (sw) => {
    const map = {
      ntLive: 'notify.onLive', ntError: 'notify.onError', ntDisk: 'notify.onDisk',
      ntCookie: 'notify.onCookie',
      ntDedupe: 'notify.dedupe', ntRetry: 'notify.retry',
    };
    const path = map[sw.id];
    if (path) kit.set(path, sw.classList.contains('on'));
  });

  root.querySelector('#ntTest').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = t('settings.ntSending');
    try {
      const r = await api.notifyTest();
      if (r && r.success) toast(t('settings.ntSentOk'));
      else if (r && r.skipped === 'no-webhook') toast(t('settings.ntNoWebhook'), 'warn');
      else if (r && r.skipped) toast(t('settings.ntSkipped'), 'warn');
      else toast(t('settings.ntSendFail', (r && r.error) || t('settings.ntSendFailFallback')), 'err');
    } catch (e) {
      toast(e.message || t('settings.ntSendFailed'), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
}