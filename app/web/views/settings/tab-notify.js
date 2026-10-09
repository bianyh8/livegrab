/* LiveGrab · views/settings/tab-notify.js —— ④ 通知
   Webhook ＋ 6 个事件开关 ＋ 60 秒去重开关（D18）＋ 5/15/45 秒重试开关 ＋ 测试发送。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches } from '../../ui.js';
import { read } from './tabkit.js';

export async function render(root, ctx, kit) {
  const n = read(kit.state, 'notify', {}) || {};
  const dedupeSec = Number(n.dedupeSec != null ? n.dedupeSec : 60) || 60;
  const retryOn = n.retry !== false;

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>通知</h3><span class="hint">Server 酱 / 企业微信 / Telegram / 自建 Webhook 均可</span></div>
        <div class="card-b">
          <div class="form-row">
            <label class="fl">Webhook 地址</label>
            <input class="input mono" id="ntHook" placeholder="https://sctapi.ftqq.com/xxx.send" value="${esc(n.webhook || '')}" />
            <div class="hintline">留空表示不发送通知（事件仍写入运行日志）。通知正文包含：任务名、平台、清晰度、文件路径与错误摘要，便于直接在手机上判断要不要处理。</div>
          </div>
          <div class="sw-row"><div><div class="t">监控到开播</div><div class="d">检测到直播间开始直播时发一条通知（含开播时间）；录制开始/结束不再通知</div></div><div class="spacer"></div>${switchEl(n.onLive !== false, 'id="ntStart"')}</div>
          <div class="sw-row"><div><div class="t">录制失败与自动重试</div><div class="d">断流超限、鉴权失败、磁盘满</div></div><div class="spacer"></div>${switchEl(n.onError !== false, 'id="ntError"')}</div>
          <div class="sw-row"><div><div class="t">磁盘空间告警</div><div class="d">剩余空间低于保留下限时提醒</div></div><div class="spacer"></div>${switchEl(n.onDisk !== false, 'id="ntDisk"')}</div>
          <div class="sw-row"><div><div class="t">Cookie 过期提醒</div><div class="d">平台 Cookie 失效或即将过期</div></div><div class="spacer"></div>${switchEl(!!n.onCookie, 'id="ntCookie"')}</div>
          <div class="divider"></div>
          <div class="sw-row"><div><div class="t">同任务同类事件 <span id="ntDedupeTx">${dedupeSec}</span> 秒内只发一次</div><div class="d">防断流抖动刷屏；去重后再计入次数（D18，默认 60 秒）</div></div><div class="spacer"></div>${switchEl(n.dedupe !== false, 'id="ntDedupe"')}</div>
          <div class="form-row" style="margin:-4px 0 12px 0">
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="ntDedupeSec" style="width:100px" value="${esc(String(dedupeSec))}" />
              <span style="color:var(--txt-3);font-size:12.5px">秒（默认 60）</span>
            </div>
          </div>
          <div class="sw-row"><div><div class="t">发送失败时按 5 / 15 / 45 秒重试 3 次</div><div class="d">最终失败写入运行日志，不影响录制（D18）</div></div><div class="spacer"></div>${switchEl(retryOn, 'id="ntRetry"')}</div>
          <button class="btn" id="ntTest" style="margin-top:12px">发送测试通知</button>
        </div>
      </div>
    </div>`;

  kit.bind(root.querySelector('#ntHook'), 'notify.webhook');
  kit.bind(root.querySelector('#ntDedupeSec'), 'notify.dedupeSec', 'number');
  const dedupeSecInput = root.querySelector('#ntDedupeSec');
  dedupeSecInput.oninput = () => { root.querySelector('#ntDedupeTx').textContent = dedupeSecInput.value || '0'; };

  bindSwitches(root, (sw) => {
    const map = {
      ntStart: 'notify.onLive', ntError: 'notify.onError', ntDisk: 'notify.onDisk',
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
    btn.textContent = '发送中…';
    try {
      const r = await api.notifyTest();
      if (r && r.success) toast('测试通知已发送（含去重与重试说明）');
      else if (r && r.skipped === 'no-webhook') toast('请先填写 Webhook 地址', 'warn');
      else if (r && r.skipped) toast('测试通知未发送：当前事件被去重或开关关闭', 'warn');
      else toast('发送未成功：' + ((r && r.error) || '请检查 Webhook 地址是否有效、机器人是否可用'), 'err');
    } catch (e) {
      toast(e.message || '测试通知发送失败（请检查 Webhook 地址与网络）', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
}
