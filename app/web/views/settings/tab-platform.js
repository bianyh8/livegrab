/* LiveGrab · views/settings/tab-platform.js —— ③ 平台账号
   平台表格：平台 / 登录与 Cookie / 可用清晰度 / 并发上限 / 稳定性 / 启用 / 操作（D13）
   ＋ Cookie 批量导入 ＋ 网络代理 ＋ 开播监控参数。 */

import { api } from '../../api.js';
import {
  esc, toast, switchEl, bindSwitches, promptDialog, openDialog, formatDateTime, fromNow, platformInfo, tierName,
} from '../../ui.js';
import { read } from './tabkit.js';

export async function render(root, ctx, kit) {
  const s = kit.state.settings || {};
  const platforms = kit.state.platforms || [];

  root.innerHTML = `
    <div class="stack" style="max-width:1100px">
      <div class="card">
        <div class="card-h"><h3>平台与账号</h3>
          <span class="hint">${platforms.length || 0} 个平台已接入；Cookie 是平台级的，一个平台一份</span>
          <div class="spacer"></div>
          <button class="btn sm ghost" id="pfImport">批量导入 Cookie</button>
          <button class="btn sm ghost" id="pfReload">重新检测</button>
        </div>
        <div class="card-b" style="padding:0">
          ${platforms.length ? `<table>
            <thead><tr>
              <th>平台</th><th>登录 / Cookie</th><th>可用清晰度</th><th style="width:110px">并发上限</th><th>稳定性</th><th style="width:76px">启用</th><th style="text-align:right">操作</th>
            </tr></thead>
            <tbody>${platforms.map((p) => row(p, kit)).join('')}</tbody>
          </table>` : `<div class="empty">平台清单加载中（/api/platforms 无响应时无法显示）</div>`}
        </div>
        <div class="card-b" style="border-top:1px solid var(--line)">
          <div class="row wrap">
            <div class="f1" style="min-width:260px">
              <label class="fl">网络代理（可选）</label>
              <input class="input mono" id="pfProxy" placeholder="http://127.0.0.1:7890" value="${esc(s.proxy || '')}" />
            </div>
            <div class="f1" style="min-width:260px">
              <label class="fl">User-Agent（可选）</label>
              <input class="input mono" id="pfUa" placeholder="留空则使用内置 UA" value="${esc(s.userAgent || '')}" />
            </div>
          </div>
          <div class="hintline">代理仅影响拉流与解析请求，不经过录制文件写入。海外平台必须走代理，否则会解析超时。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>开播监控</h3><span class="hint">全局参数，可被任务单独覆盖</span></div>
        <div class="card-b">
          <div class="sw-row"><div><div class="t">全局轮询检测</div><div class="d">按任务分别设置间隔，默认 60 秒</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="pfPoll" style="width:74px" value="${esc(String(read(kit.state, 'pollIntervalSec', 60)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">秒</span>
            </div></div>
          <div class="sw-row"><div><div class="t">开播后延迟开始</div><div class="d">避开开场广告与黑屏</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="pfStartDelay" style="width:74px" value="${esc(String(read(kit.state, 'startDelaySec', 5)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">秒</span>
            </div></div>
          <div class="sw-row"><div><div class="t">下播后延迟停止</div><div class="d">防止提前截断结尾</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="pfStopDelay" style="width:74px" value="${esc(String(read(kit.state, 'stopDelaySec', 30)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">秒</span>
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
    const id = sw.dataset.pen;
    if (!id) return;
    const map = Object.assign({}, kit.state.settings.platformEnabled || {});
    map[id] = sw.classList.contains('on');
    kit.set('platformEnabled', map);
    toast(`${platformName(platforms, id)} 已${map[id] ? '启用' : '停用'}（停用后不参与开播轮询）`);
  });

  root.querySelectorAll('[data-cookie]').forEach((btn) => {
    btn.onclick = () => cookieFlow(btn.dataset.cookie, kit, root, ctx);
  });
  root.querySelectorAll('[data-qr]').forEach((btn) => {
    btn.onclick = () => toast('B 站扫码登录为 P1：当前版本请在浏览器登录后粘贴 Cookie（页面内扫码后续批次补齐）', 'warn');
  });
  root.querySelectorAll('[data-detect]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api.filesScan();
        toast(`${platformName(platforms, btn.dataset.detect)} 可用性检测完成（按 /data 扫描结果返回）`);
      } catch (e) { toast(e.message || '检测失败', 'err'); }
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
      toast('已重新检测所有平台可用性');
    } catch (e) { toast(e.message || '重新检测失败', 'err'); }
    finally { btn.disabled = false; }
  };

  root.querySelector('#pfImport').onclick = () => openDialog({
    title: '批量导入 Cookie',
    body: `<div class="form-row">
        <label class="fl">粘贴 Cookie（支持 JSON 或 Netscape 格式）</label>
        <textarea class="input mono" id="pfBatch" rows="8" placeholder='{"douyin":"ttwid=...; sessionid=...","bilibili":"SESSDATA=..."}
# Netscape HTTP Cookie File
.live.bilibili.com	TRUE	/	FALSE	0	SESSDATA	xxx'></textarea>
        <div class="hintline">JSON：<span class="mono">{"平台id": "Cookie 字符串"}</span>；Netscape：浏览器扩展导出的 cookies.txt 原文。平台 id 见左侧平台表格（douyin / bilibili / kuaishou / huya / douyu 等）。</div>
      </div>`,
    footer: (close, body) => {
      const cancel = document.createElement('button');
      cancel.className = 'btn ghost';
      cancel.textContent = '取消';
      cancel.onclick = close;
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = '导入';
      ok.onclick = async () => {
        const text = body.querySelector('#pfBatch').value.trim();
        if (!text) { toast('请粘贴 Cookie 内容', 'warn'); return; }
        const pairs = parseBatch(text);
        if (!pairs.length) { toast('未能解析出平台 Cookie，请检查格式', 'err'); return; }
        ok.disabled = true;
        let done = 0;
        for (const [platform, cookie] of pairs) {
          try { await api.saveCookie(platform, cookie); done++; } catch { /* 单个失败不影响其它 */ }
        }
        ok.disabled = false;
        close();
        toast(`已导入 ${done}/${pairs.length} 个平台的 Cookie`);
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
  const enabled = (kit.state.settings.platformEnabled || {})[p.id] !== false;
  const cap = (kit.state.settings.platformCaps || {})[p.id] != null
    ? (kit.state.settings.platformCaps || {})[p.id]
    : (p.cap != null ? p.cap : 2);

  return `<tr>
    <td><span class="plat ${esc(platformInfo(p.id).cls)}"><i>${esc(platformInfo(p.id).letter)}</i>${esc(p.name)}</span>${tierName(p.tier) ? ` <span class="tag">${esc(tierName(p.tier))}</span>` : ''}</td>
    <td>${cookieCell(p, has, valid)}</td>
    <td title="${esc(qualitiesFull(p.qualities))}">${qualitiesCell(p.qualities)}</td>
    <td><input class="input" style="width:80px" data-pcap="${esc(p.id)}" value="${esc(String(cap))}" /></td>
    <td>${stabilityChip(p)}</td>
    <td>${switchEl(enabled, `data-pen="${esc(p.id)}"`)}</td>
    <td><div class="acts">${actions(p, has)}</div></td>
  </tr>`;
}

/* 清晰度只在「平台账号」里用一个紧凑字段：最多显示 3 档短名 + 「等 N 档」，全表放 title 提示 */
const QSHORT = { origin: '原画', bluray: '蓝光', uhd: '超清', hd: '高清', sd: '标清', audio: '仅音频' };
function qShort(q) {
  if (!q || q.id === 'default' || !q.id) return '默认画质';
  if (QSHORT[q.id]) return QSHORT[q.id];
  return (String(q.label || q.id).replace(/[（(].*?[)）]/g, '').trim()) || q.id;
}
function qualitiesCell(qs) {
  const list = qs || [];
  if (!list.length) return '<span class="chip plain"><i class="dot"></i>默认画质</span>';
  const chunks = list.slice(0, 3).map((q) => `<span class="chip plain">${esc(qShort(q))}</span>`);
  if (list.length > 3) chunks.push(`<span class="tag">等 ${list.length} 档</span>`);
  return chunks.join(' ');
}
function qualitiesFull(qs) {
  return (qs || []).map((q) => q.label || qShort(q)).join('、');
}

function cookieCell(p, has, valid) {
  if (!p.needCookie && !has) {
    return `<span class="chip on"><i class="dot"></i>${esc(p.cookieHow || '免登录')}</span>`;
  }
  if (has && valid !== false) {
    return `<span class="chip on"><i class="dot"></i>Cookie 已配置</span><div class="sub">更新于 ${esc(cookie.updatedAt ? formatDateTime(cookie.updatedAt) : '未知')}${cookie.updatedAt ? `（${esc(fromNow(cookie.updatedAt))}）` : ''}</div>`;
  }
  if (has) {
    return `<span class="chip err"><i class="dot"></i>Cookie 可能已失效</span><div class="sub">更新于 ${esc(cookie.updatedAt ? formatDateTime(cookie.updatedAt) : '未知')}</div>`;
  }
  return `<span class="chip err"><i class="dot"></i>未配置</span><div class="sub">${esc(p.cookieHow || '需要 Cookie')}</div>`;
}

/* 稳定性：按 tier 拉中文徽标（stable/experimental/planned 不再显示英文），细节折成悬停 title */
function stabilityChip(p) {
  const t = String(p.tier || '');
  const note = p.note || '';
  const label = tierName(t) || (note ? note.split('：')[0] || '待实测' : '待实测');
  const cls = t === 'experimental' ? 'err' : (t === 'stable' ? 'on' : 'wait');
  return `<span class="chip ${cls}" style="cursor:help"${note ? ` title="${esc(note)}"` : ''}><i class="dot"></i>${esc(label)}</span>`;
}

function actions(p, has) {
  const id = esc(p.id);
  const btns = [];
  if (p.id === 'douyin') btns.push(`<button class="btn sm" data-cookie="${id}">粘贴 Cookie</button>`);
  else if (p.id === 'bilibili') {
    btns.push(`<button class="btn sm" data-qr="${id}">扫码登录</button>`);
    btns.push(`<button class="btn sm ghost" data-cookie="${id}">粘贴</button>`);
  } else if (p.id === 'kuaishou') btns.push(`<button class="btn sm ghost" data-cookie="${id}">自动获取</button>`);
  else if (p.needCookie) btns.push(`<button class="btn sm" data-cookie="${id}">${has ? '更新 Cookie' : '填写 Cookie'}</button>`);
  else btns.push(`<button class="btn sm ghost" data-detect="${id}">检测</button>`);
  if (has) btns.push(`<button class="btn sm danger" data-clear="${id}">清除</button>`);
  return btns.join('');
}

/* ---------- Cookie 流程 ---------- */

const HOWTO = {
  douyin: '抖音无公开扫码接口：请在浏览器登录抖音后打开开发者工具，复制完整 Cookie 字符串（<b>必须包含 ttwid 与 sessionid</b>），粘贴到下方输入框。',
  bilibili: 'B 站原画需要登录：可粘贴完整 Cookie（必须包含 <b>SESSDATA</b>）；页面内扫码登录为 P1，当前先用粘贴方式。',
  xiaohongshu: '请粘贴小红书 Cookie（若为 xhslink 短链，请先在浏览器中打开得到直播间地址）。',
  kuaishou: '快手支持自动获取 Cookie，通常无需手动填写；如需覆盖，可直接粘贴。',
};

function cookieFlow(platform, kit, root, ctx) {
  const list = kit.state.platforms || [];
  const p = list.find((x) => x.id === platform) || { id: platform, name: platform };
  if (platform === 'kuaishou') {
    promptDialog({
      title: '快手 Cookie（自动获取）',
      label: 'Cookie（可留空，留空表示继续使用自动获取）',
      placeholder: 'kuaishou.web.cp.api_st=...',
      hint: '快手的 Cookie 通常由解析器自动获取（有效期约 24 小时）。只有自动获取失败时才需要手动粘贴覆盖。',
      onOk: (v) => saveCookie(platform, v, kit, root, ctx),
    });
    return;
  }
  promptDialog({
    title: `配置 ${p.name} Cookie`,
    label: 'Cookie（直接粘贴，整行即可）',
    placeholder: 'ttwid=...; sessionid=...;',
    multiline: true,
    rows: 7,
    hint: HOWTO[platform] || '请粘贴浏览器中该平台的完整 Cookie 字符串。',
    onOk: (v) => saveCookie(platform, v, kit, root, ctx),
  });
}

async function saveCookie(platform, cookie, kit, root, ctx) {
  try {
    await api.saveCookie(platform, cookie);
    toast('Cookie 已保存（服务端脱敏存储，页面不再回显）');
    paintReload(root, ctx, kit);
  } catch (e) {
    toast(e.message || 'Cookie 保存失败', 'err');
  }
}

async function clearCookie(platform, kit, root, ctx) {
  try {
    await api.delCookie(platform);
    toast('已清除该平台 Cookie');
    paintReload(root, ctx, kit);
  } catch (e) {
    toast(e.message || '清除失败', 'err');
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
