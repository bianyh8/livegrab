/* LiveGrab · views/settings/tab-platform.js —— ④ 平台账号
   平台表格：平台 / 登录与 Cookie / 可用清晰度 / 并发上限 / 稳定性 / 启用 / 操作（D13）
   ＋ Cookie 批量导入 ＋ 网络代理 ＋ 开播监控参数。 */

import { api } from '../../api.js';
import {
  esc, toast, switchEl, bindSwitches, promptDialog, openDialog, formatDateTime, fromNow, platformInfo, tierName,
} from '../../ui.js';
import { t } from '../../i18n.js';
import { read } from './tabkit.js';

export async function render(root, ctx, kit) {
  const s = kit.state.settings || {};
  const platforms = kit.state.platforms || [];

  root.innerHTML = `
    <div class="stack" style="max-width:1100px">
      <div class="card">
        <div class="card-h"><h3>${t('settings.pfTitle')}</h3>
          <span class="hint">${t('settings.pfHint', platforms.length || 0)}</span>
          <div class="spacer"></div>
          <button class="btn sm ghost" id="pfImport">${t('settings.pfImport')}</button>
          <button class="btn sm ghost" id="pfReload">${t('settings.pfRecheck')}</button>
        </div>
        <div class="card-b" style="padding:0">
          ${platforms.length ? `<table>
            <thead><tr>
              <th>${t('settings.pfColPlatform')}</th><th>${t('settings.pfColCookie')}</th><th>${t('settings.pfColQuality')}</th><th style="width:110px">${t('settings.pfColCap')}</th><th>${t('settings.pfColStability')}</th><th style="width:76px">${t('settings.pfColProxy')}</th><th style="width:76px">${t('settings.pfColEnabled')}</th><th style="text-align:right">${t('tasks.colOps')}</th>
            </tr></thead>
            <tbody>${platforms.map((p) => row(p, kit)).join('')}</tbody>
          </table>` : `<div class="empty">${t('settings.pfLoadEmpty')}</div>`}
        </div>
        <div class="card-b" style="border-top:1px solid var(--line)">
          <div class="row wrap">
            <div class="f1" style="min-width:260px">
              <label class="fl">${t('settings.pfProxyLabel')}</label>
              <input class="input mono" id="pfProxy" placeholder="http://127.0.0.1:7890" value="${esc(s.proxy || '')}" />
            </div>
            <div class="f1" style="min-width:260px">
              <label class="fl">${t('settings.pfUaLabel')}</label>
              <input class="input mono" id="pfUa" placeholder="${t('settings.pfUaPlaceholder')}" value="${esc(s.userAgent || '')}" />
            </div>
          </div>
          <div class="hintline">${t('settings.pfProxyHint')}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>${t('settings.pfMonitorTitle')}</h3><span class="hint">${t('settings.pfMonitorHint')}</span></div>
        <div class="card-b">
          <div class="sw-row"><div><div class="t">${t('settings.pfPollLabel')}</div><div class="d">${t('settings.pfPollDesc')}</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="pfPoll" style="width:74px" value="${esc(String(read(kit.state, 'pollIntervalSec', 60)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">${t('common.seconds')}</span>
            </div></div>
          <div class="sw-row"><div><div class="t">${t('settings.pfStartDelayLabel')}</div><div class="d">${t('settings.pfStartDelayDesc')}</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="pfStartDelay" style="width:74px" value="${esc(String(read(kit.state, 'startDelaySec', 5)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">${t('common.seconds')}</span>
            </div></div>
          <div class="sw-row"><div><div class="t">${t('settings.pfStopDelayLabel')}</div><div class="d">${t('settings.pfStopDelayDesc')}</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="pfStopDelay" style="width:74px" value="${esc(String(read(kit.state, 'stopDelaySec', 30)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">${t('common.seconds')}</span>
            </div></div>
        </div>
      </div>
    </div>`;

  bindDelegates(root, kit, ctx);

  kit.bind(root.querySelector('#pfProxy'), 'proxy');
  kit.bind(root.querySelector('#pfUa'), 'userAgent');
  kit.bind(root.querySelector('#pfPoll'), 'pollIntervalSec', 'number');
  kit.bind(root.querySelector('#pfStartDelay'), 'startDelaySec', 'number');
  kit.bind(root.querySelector('#pfStopDelay'), 'stopDelaySec', 'number');

  bindSwitches(root, (sw) => {
    const penId = sw.dataset.pen;
    if (penId) {
      const map = Object.assign({}, kit.state.settings.platformEnabled || {});
      map[penId] = sw.classList.contains('on');
      kit.set('platformEnabled', map);
      toast(t('settings.pfToggleToast', platformName(platforms, penId), map[penId] ? t('settings.pfColEnabled') : t('settings.pfDisabled')));
      return;
    }
    const pxyId = sw.dataset.pxy;
    if (pxyId) {
      const map = Object.assign({}, kit.state.settings.platformUseProxy || {});
      map[pxyId] = sw.classList.contains('on');
      kit.set('platformUseProxy', map);
      toast(t('settings.pfProxyToast', platformName(platforms, pxyId), map[pxyId] ? t('settings.pfColProxyOn') : t('settings.pfColProxyOff')));
    }
  });

  root.querySelectorAll('[data-cookie]').forEach((btn) => {
    btn.onclick = () => cookieFlow(btn.dataset.cookie, kit, root, ctx);
  });
  root.querySelectorAll('[data-qr]').forEach((btn) => {
    btn.onclick = () => toast(t('settings.pfQrToast'), 'warn');
  });
  root.querySelectorAll('[data-detect]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.filesScan();
        toast(t('settings.pfDetectDone', platformName(platforms, btn.dataset.detect)));
      } catch (e) { toast(e.message || t('settings.pfDetectFail'), 'err'); }
      finally { btn.disabled = false; }
    };
  });

  root.querySelector('#pfReload').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const r = await api.platforms();
      kit.state.platforms = (r && r.items) || [];
      paintReload(root, ctx, kit);
      toast(t('settings.pfRecheckDone'));
    } catch (e) { toast(e.message || t('settings.pfRecheckFail'), 'err'); }
    finally { btn.disabled = false; }
  };

  root.querySelector('#pfImport').onclick = () => openDialog({
    title: t('settings.pfImport'),
    body: `<div class="form-row">
        <label class="fl">${t('settings.pfPasteLabel')}</label>
        <textarea class="input mono" id="pfBatch" rows="8" placeholder='{"douyin":"ttwid=...; sessionid=...","bilibili":"SESSDATA=..."}
# Netscape HTTP Cookie File
.live.bilibili.com	TRUE	/	FALSE	0	SESSDATA	xxx'></textarea>
        <div class="hintline">${t('settings.pfPasteHint')}</div>
      </div>`,
    footer: (close, body) => {
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = t('common.cancel');
      cancel.onclick = close;
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = t('settings.pfImportButton');
      ok.onclick = async () => {
        const text = body.querySelector('#pfBatch').value.trim();
        if (!text) { toast(t('settings.pfEmptyCookie'), 'warn'); return; }
        const pairs = parseBatch(text);
        if (!pairs.length) { toast(t('settings.pfParseFail'), 'err'); return; }
        ok.disabled = true;
        let done = 0;
        for (const [platform, cookie] of pairs) {
          try { await api.saveCookie(platform, cookie); done++; } catch { /* 单个失败不影响其它 */ }
        }
        ok.disabled = false;
        close();
        toast(t('settings.pfImported', done, pairs.length));
        paintReload(root, ctx, kit);
      };
      return [cancel, ok];
    },
  });
}

/* ---------- 行渲染 ---------- */

function row(p, kit) {
  const cookie = p.cookie || {};
  const has = cookie.has != null ? cookie.has : !!p.cookieSet;
  const valid = cookie.valid;
  const enabled = p.enabled;
  const useProxy = (kit.state.settings.platformUseProxy || {})[p.id] === true;
  const cap = (kit.state.settings.platformCaps || {})[p.id] != null
    ? (kit.state.settings.platformCaps || {})[p.id]
    : (p.cap != null ? p.cap : 2);

  return `<tr>
    <td data-label="${t('settings.pfColPlatform')}"><span class="plat ${esc(platformInfo(p.id).cls)}"><i>${esc(platformInfo(p.id).letter)}</i>${esc(p.name)}</span>${tierName(p.tier) ? ` <span class="tag">${esc(tierName(p.tier))}</span>` : ''}</td>
    <td data-label="${t('settings.pfColCookie')}">${cookieCell(p, has, valid)}</td>
    <td data-label="${t('settings.pfColQuality')}" title="${esc(qualitiesFull(p.qualities))}">${qualitiesCell(p.qualities)}</td>
    <td data-label="${t('settings.pfColCap')}"><input class="input" style="width:80px" data-pcap="${esc(p.id)}" value="${esc(String(cap))}" /></td>
    <td data-label="${t('settings.pfColStability')}">${stabilityChip(p)}</td>
    <td data-label="${t('settings.pfColProxy')}" title="${esc(t('settings.pfColProxyHint'))}">${switchEl(useProxy, `data-pxy="${esc(p.id)}"`)}</td>
    <td data-label="${t('settings.pfColEnabled')}">${switchEl(enabled, `data-pen="${esc(p.id)}"`)}</td>
    <td><div class="acts">${actions(p, has)}</div></td>
  </tr>`;
}

/* 清晰度只在「平台账号」里用一个紧凑字段：最多显示 3 档短名 + 「等 N 档」，全表放 title 提示 */
const QSHORT = { origin: t('tasks.qOrigin'), bluray: t('tasks.qBluray'), uhd: t('tasks.qUhd'), hd: t('tasks.qHd'), sd: t('tasks.qSd'), audio: t('tasks.qAudio') };
function qShort(q) {
  if (!q || q.id === 'default' || !q.id) return t('settings.pfDefaultQuality');
  if (QSHORT[q.id]) return QSHORT[q.id];
  return (String(q.label || q.id).replace(/[（(].*?[)）]/g, '').trim()) || q.id;
}
function qualitiesCell(qs) {
  const list = qs || [];
  if (!list.length) return `<span class="chip plain"><i class="dot"></i>${t('settings.pfDefaultQuality')}</span>`;
  const chunks = list.slice(0, 3).map((q) => `<span class="chip plain">${esc(qShort(q))}</span>`);
  if (list.length > 3) chunks.push(`<span class="tag">${t('settings.pfMoreTiers', list.length)}</span>`);
  return chunks.join(' ');
}
function qualitiesFull(qs) {
  return (qs || []).map((q) => q.label || qShort(q)).join('、');
}

function cookieCell(p, has, valid) {
  if (!p.needCookie && !has) {
    return `<span class="chip on"><i class="dot"></i>${esc(p.cookieHow || t('settings.pfNoLogin'))}</span>`;
  }
  if (has && valid !== false) {
    return `<span class="chip on"><i class="dot"></i>${t('settings.pfCookieSet')}</span><div class="sub">${t('settings.pfUpdated', esc(cookie.updatedAt ? formatDateTime(cookie.updatedAt) : t('common.unknown')))}${cookie.updatedAt ? `（${esc(fromNow(cookie.updatedAt))}）` : ''}</div>`;
  }
  if (has) {
    return `<span class="chip err"><i class="dot"></i>${t('settings.pfCookieInvalid')}</span><div class="sub">${t('settings.pfUpdated', esc(cookie.updatedAt ? formatDateTime(cookie.updatedAt) : t('common.unknown')))}</div>`;
  }
  return `<span class="chip err"><i class="dot"></i>${t('settings.pfCookieMissing')}</span><div class="sub">${esc(p.cookieHow || t('settings.pfNeedCookie'))}</div>`;
}

/* 稳定性：按 tier 拉中文徽标（stable/experimental/planned 不再显示英文），细节折成悬停 title */
function stabilityChip(p) {
  const tierStr = String(p.tier || '');
  const note = p.note || '';
  const label = tierName(tierStr) || (note ? note.split('：')[0] || t('settings.pfUntested') : t('settings.pfUntested'));
  const cls = tierStr === 'experimental' ? 'err' : (tierStr === 'stable' ? 'on' : 'wait');
  return `<span class="chip ${cls}" style="cursor:help"${note ? ` title="${esc(note)}"` : ''}><i class="dot"></i>${esc(label)}</span>`;
}

function actions(p, has) {
  const id = esc(p.id);
  const btns = [];
  if (p.id === 'douyin') btns.push(`<button class="btn sm" data-cookie="${id}">${t('settings.pfPasteCookie')}</button>`);
  else if (p.id === 'bilibili') {
    btns.push(`<button class="btn sm" data-qr="${id}">${t('settings.pfQrLogin')}</button>`);
    btns.push(`<button class="btn sm ghost" data-cookie="${id}">${t('settings.pfPasteBtn')}</button>`);
  } else if (p.id === 'kuaishou') btns.push(`<button class="btn sm ghost" data-cookie="${id}">${t('settings.pfAutoFetch')}</button>`);
  else if (p.needCookie) btns.push(`<button class="btn sm" data-cookie="${id}">${has ? t('settings.pfUpdateCookie') : t('settings.pfFillCookie')}</button>`);
  else btns.push(`<button class="btn sm ghost" data-detect="${id}">${t('tasks.verbCheck')}</button>`);
  if (has) btns.push(`<button class="btn sm danger" data-clear="${id}">${t('files.clear')}</button>`);
  return btns.join('');
}

/* ---------- Cookie 流程 ---------- */

const HOWTO = {
  douyin: t('settings.pfHowtoDouyin'),
  bilibili: t('settings.pfHowtoBilibili'),
  xiaohongshu: t('settings.pfHowtoXiaohongshu'),
  kuaishou: t('settings.pfHowtoKuaishou'),
};

function cookieFlow(platform, kit, root, ctx) {
  const list = kit.state.platforms || [];
  const p = list.find((x) => x.id === platform) || { id: platform, name: platform };
  if (platform === 'kuaishou') {
    promptDialog({
      title: t('settings.pfKuaishouTitle'),
      label: t('settings.pfKuaishouLabel'),
      placeholder: 'kuaishou.web.cp.api_st=...',
      hint: t('settings.pfKuaishouHint'),
      onOk: (v) => saveCookie(platform, v, kit, root, ctx),
    });
    return;
  }
  promptDialog({
    title: t('settings.pfConfigCookie', p.name),
    label: t('settings.pfCookieLabel'),
    placeholder: 'ttwid=...; sessionid=...;',
    multiline: true,
    rows: 7,
    hint: HOWTO[platform] || t('settings.pfCookieHint'),
    onOk: (v) => saveCookie(platform, v, kit, root, ctx),
  });
}

async function saveCookie(platform, cookie, kit, root, ctx) {
  try {
    await api.saveCookie(platform, cookie);
    toast(t('settings.pfCookieSaved'));
    paintReload(root, ctx, kit);
  } catch (e) {
    toast(e.message || t('settings.pfCookieSaveFail'), 'err');
  }
}

async function clearCookie(platform, kit, root, ctx) {
  try {
    await api.delCookie(platform);
    toast(t('settings.pfCookieCleared'));
    paintReload(root, ctx, kit);
  } catch (e) {
    toast(e.message || t('settings.pfClearFail'), 'err');
  }
}

/* 清除按钮与并发上限输入（因为表格是字符串渲染，这里统一委托） */
export function bindDelegates(root, kit, ctx) {
  root.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.onclick = () => clearCookie(btn.dataset.clear, kit, root, ctx);
  });
  root.querySelectorAll('[data-pcap]').forEach((inp) => {
    inp.onchange = () => {
      const map = Object.assign({}, kit.state.settings.platformCaps || {});
      map[inp.dataset.pcap] = Number(inp.value) || 0;
      kit.set('platformCaps', map);
    };
  });
}

async function paintReload(root, ctx, kit) {
  try {
    const [p, s] = await Promise.allSettled([api.platforms(), api.settings()]);
    if (p.status === 'fulfilled') { kit.state.platforms = (p.value && p.value.items) || []; ctx.platforms = kit.state.platforms; }
    if (s.status === 'fulfilled') kit.state.settings = s.value || kit.state.settings;
  } catch { /* 忽略 */ }
  await render(root, ctx, kit);
}

function platformName(list, id) {
  const p = list.find((x) => x.id === id);
  return (p && p.name) || platformInfo(id).name;
}

function parseBatch(text) {
  const out = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v) out.push([k, v]);
      return out;
    } catch { /* 继续按 Netscape 解析 */ }
  }
  const byHost = {};
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const host = cols[0];
    const platform = host.includes('douyin') ? 'douyin'
      : host.includes('bilibili') ? 'bilibili'
      : host.includes('kuaishou') ? 'kuaishou'
      : host.includes('huya') ? 'huya'
      : host.includes('douyu') ? 'douyu'
      : host.includes('xiaohongshu') || host.includes('xhscdn') ? 'xiaohongshu'
      : host.includes('weibo') ? 'weibo' : '';
    if (!platform) continue;
    (byHost[platform] = byHost[platform] || []).push(`${cols[5]}=${cols[6]}`);
  }
  for (const [k, v] of Object.entries(byHost)) out.push([k, v.join('; ')]);
  return out;
}