/* LiveGrab · views/settings/tab-security.js —— ⑤ 安全与登录
   修改密码（POST /api/auth/password）＋ 登录有效期 / 失败锁定说明 ＋ 退出登录 / 注销所有会话
   ＋ scrypt 与 Cookie 存储位置说明。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches, confirmDialog, formatDateTime } from '../../ui.js';

export async function render(root, ctx, kit) {
  let me = null;
  try { me = await api.authMe(); } catch { me = null; }
  const username = (me && me.username) || (ctx.user && ctx.user.username) || 'admin';

  const prefs = loadPrefs();

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>安全与登录</h3><span class="hint">单管理员账号，凭据仅保存在容器内 /config</span></div>
        <div class="card-b">
          <div class="rec-item" style="padding:0 0 14px;border-bottom:1px dashed var(--line)">
            <span class="user-row" style="border:0;padding:0"><span class="ava">${esc(String(username).charAt(0).toUpperCase())}</span></span>
            <div class="rec-main">
              <div class="ttl" style="font-size:13px">${esc(username)}</div>
              <div class="meta">
                <span class="chip on"><i class="dot"></i>已登录</span>
                <span>本次会话建立于 ${esc(new Date().toLocaleString('zh-CN'))}</span>
                ${me && me.lastLoginAt ? `<span>上次登录 ${esc(formatDateTime(me.lastLoginAt))}${me.lastLoginIp ? ' · 来自 ' + esc(me.lastLoginIp) : ''}</span>` : ''}
              </div>
            </div>
            <button class="btn sm ghost" id="scKillAll">注销所有会话</button>
          </div>

          <div class="row wrap" style="margin-top:14px">
            <div class="f1" style="min-width:180px"><label class="fl">当前密码</label>
              <input class="input" id="scOld" type="password" placeholder="••••••••" autocomplete="current-password" /></div>
            <div class="f1" style="min-width:180px"><label class="fl">新密码</label>
              <input class="input" id="scNew" type="password" placeholder="至少 8 位" autocomplete="new-password" /></div>
            <div class="f1" style="min-width:180px"><label class="fl">确认新密码</label>
              <input class="input" id="scNew2" type="password" autocomplete="new-password" /></div>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <div class="f1" style="min-width:220px"><label class="fl">登录有效期</label>
              <select class="select" id="scTtl">
                <option value="30d">30 天（记住我时）</option>
                <option value="12h">12 小时</option>
                <option value="7d">7 天</option>
                <option value="never">永不过期（不推荐）</option>
              </select></div>
            <div class="f1" style="min-width:220px"><label class="fl">登录失败限制</label>
              <select class="select" id="scLock">
                <option value="default">5 次失败后锁定 10 分钟</option>
                <option value="none">不限制（仅内网使用）</option>
              </select></div>
          </div>
          <div class="hintline">服务端固定策略：同一 IP 连续 <b>5 次</b>失败锁定 <b>10 分钟</b>（D1）。上面两项为浏览器本地偏好，仅影响本页提示与「记住我」默认勾选；服务端暂未提供对应接口。</div>
          <div class="sw-row" style="margin-top:6px"><div><div class="t">会话失效后自动跳回登录页</div><div class="d">接口返回 401 时前端清空本地状态并跳转登录</div></div><div class="spacer"></div>${switchEl(true, 'data-fixed="1"')}</div>
          <div class="sw-row"><div><div class="t">允许内网免登录</div><div class="d">仅建议在可信内网开启；公网映射端口时务必关闭（当前版本未实现）</div></div><div class="spacer"></div>${switchEl(!!prefs.allowLocal, 'id="scLocal"')}</div>
          <div class="hintline">密码以 <span class="mono">scrypt</span> 哈希保存在容器内 <span class="mono">/config/users.json</span>，不可逆；首次启动（该文件不存在）强制进入初始化设密码模式，没有默认口令。会话为 HMAC 签名 Cookie（<span class="mono">lg_session</span>）。忘记密码可删除容器内 <span class="mono">/config/users.json</span> 后重启，重新初始化。</div>
          <div class="row" style="margin-top:14px;gap:10px">
            <button class="btn primary" id="scSave">保存新密码</button>
            <button class="btn ghost" id="scLogout">退出登录</button>
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
      toast(sw.classList.contains('on') ? '已记录偏好（服务端未实现内网免登录，实际仍要求登录）' : '已关闭内网免登录偏好', 'warn');
    }
  });

  root.querySelector('#scSave').onclick = async (ev) => {
    const btn = ev.currentTarget;
    const oldPw = root.querySelector('#scOld').value;
    const newPw = root.querySelector('#scNew').value;
    const newPw2 = root.querySelector('#scNew2').value;
    if (!oldPw) { toast('请输入当前密码', 'warn'); return; }
    if (newPw.length < 8) { toast('新密码至少 8 位', 'warn'); return; }
    if (newPw !== newPw2) { toast('两次输入的新密码不一致', 'warn'); return; }
    btn.disabled = true;
    try {
      await api.password(oldPw, newPw);
      root.querySelector('#scOld').value = '';
      root.querySelector('#scNew').value = '';
      root.querySelector('#scNew2').value = '';
      toast('密码已更新，其他设备需重新登录');
    } catch (e) {
      toast(e.message || '密码修改失败', 'err');
    } finally {
      btn.disabled = false;
    }
  };

  root.querySelector('#scLogout').onclick = () => ctx.emit('logout');
  root.querySelector('#scKillAll').onclick = () => confirmDialog({
    title: '注销所有会话', danger: true, ok: '注销',
    text: '将清除服务端会话签名密钥，所有设备（含当前设备）都需要重新登录。',
    onOk: async () => {
      try { await api.logout(); } catch { /* 忽略 */ }
      toast('已注销所有会话，请重新登录');
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
