/* LiveGrab · views/settings/tab-update.js —— ⑦ 系统更新
   从 GitHub 拉取最新版本对比 + 检查更新 / 立即更新 + 更新进度 + 更新说明/日志。
   设计：版本对比卡（当前/最新）+ 操作区；进度卡仅更新进行中显示；左说明右日志分栏。

   重绘约定（2026-10-24）：轮询（1.5s）不得整块 root.innerHTML 重绘 —— 那会把「更新源配置」卡里
   正在输入的仓库/分支/Token 内容与焦点一起吃掉（输入一半就没了）。整块渲染只在首次进入/切页回来时做；
   之后按区块（横幅 / 版本卡 / 进度卡 / 说明 / 日志）各自比对 HTML，只有变了的那块才替换，
   配置卡渲染一次后永不重建。若焦点正落在本页输入框里，本轮干脆不更新（下一轮补）。 */

import { api } from '../../api.js';
import { esc, toast, confirmDialog, formatDateTime, formatDuration } from '../../ui.js';
import { t } from '../../i18n.js';

const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
// 失败/快照横幅用的小图标（自带尺寸，不依赖 .btn 的 svg 规则）
const ICON_WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="flex:0 0 16px"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';
const ICON_GITHUB = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z"/></svg>';

let pollTimer = null;
let expectingRestart = false;   // 支持在线自更新（容器归档通道 / 本地 git）时，更新完成后会自动重启服务
let sawRestartPhase = false;    // 后端已进入 restart 阶段
let lastStatus = null;          // 最近一次成功拿到的状态（轮询失败时用于判断）
let reloadedAfterRestart = false;
let kitRef = null;              // 模块级缓存 kit，便于 paint 内读取已保存的更新源配置

/* 各区块上次渲染出的 HTML：key 不变就不动 DOM（配置卡不在此列 —— 它只渲染一次，永不被轮询覆盖） */
const ui = { banners: '', version: '', progress: '', notes: '', log: '' };

export async function render(root, ctx, kit) {
  kitRef = kit || null;
  root.innerHTML = `<div class="card"><div class="empty">${t('settings.loading')}</div></div>`;

  // 首次进入：如果尚未检查过，自动静默检查一次（失败不打扰）
  let st = null;
  try {
    st = await api.updateStatus();
  } catch (e) {
    st = { local: null, latest: null, log: [], running: false, phase: 'idle', progress: 0 };
  }
  if (!st.latest) {
    try { st = await api.updateCheck(); } catch { /* 静默 */ }
  }

  paint(root, st);
  startPolling(root);
}

export function destroy() {
  stopPolling();
  resetBlocks();
}

function resetBlocks() {
  ui.banners = '';
  ui.version = '';
  ui.progress = '';
  ui.notes = '';
  ui.log = '';
}

function startPolling(root) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const st = await api.updateStatus();
      lastStatus = st;
      if (root.isConnected) paint(root, st);
      if (st.phase === 'restart') sawRestartPhase = true;
      // 容器（归档通道）与本地 git 仓库都会在更新完成后自动重启：
      // 记录该意图，便于轮询失败（端口释放瞬间）时仍能提示「重启中」
      if (lastStatus && lastStatus.canSelfUpdate && st.running) {
        expectingRestart = true;
      }
      // 已检测到重启且服务重新上线（空闲）= 新版本已就绪：自动刷新页面
      if ((sawRestartPhase || expectingRestart) && !st.running && !st.checking && !reloadedAfterRestart) {
        reloadedAfterRestart = true;
        stopPolling();
        toast(t('settings.upRestarted'));
        setTimeout(() => location.reload(), 1000);
        return;
      }
      // 更新任务结束且空闲后，自动停止轮询
      if (!st.running && !st.checking) stopPolling();
    } catch {
      // 轮询失败（服务正在释放端口/重启）：若处于将自重启状态，展示「重启中」而非报错
      if ((expectingRestart || sawRestartPhase) && !reloadedAfterRestart && root.isConnected) {
        paintRestarting(root);
      }
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function verNum(local) {
  if (!local || !local.version) return '—';
  return local.tag && local.tag !== `v${local.version}` ? local.tag : `v${local.version}`;
}

/* ================= 渲染：算值 → 拼各区块 HTML → 按区块落 DOM ================= */

/** 把一次 status 算成「各区块的 HTML + 绑定要用的标量」。纯函数（除 sawRestartPhase 记号）。 */
function computeView(st) {
  const local = st.local || {};
  const latest = st.latest || {};
  const running = !!st.running || !!st.checking;
  const hasUpdate = !!st.hasUpdate;
  const remoteUnavailable = !!st.remoteUnavailable;
  const isRestart = st.phase === 'restart';
  if (isRestart) sawRestartPhase = true;
  const curVer = verNum(local);
  const curChip = `<span class="chip on"><i class="dot"></i>${t('settings.upDeployed')}</span>`;
  const latestVer = remoteUnavailable
    ? '—'
    : (latest.tag || (latest.version ? `v${latest.version}` : '—'));
  const latestChip = remoteUnavailable
    ? `<span class="chip off"><i class="dot"></i>${t('common.unknown')}</span>`
    : hasUpdate
      ? `<span class="chip wait"><i class="dot"></i>${t('settings.upAvailable')}</span>`
      : `<span class="chip on"><i class="dot"></i>${t('common.completed')}</span>`;

  // 判据是 commit：会出现「两边版本号相同、只有提交不同」的情况，
  // 这种情况下把短提交号带进提示，否则「v0.1.43 → v0.1.43 有更新」看着像没变化。
  const sameVer = !!(local.version && latest.version && local.version === latest.version);
  const newLabel = (hasUpdate && sameVer && latest.commit) ? `${latestVer} · ${latest.commit}` : latestVer;

  const tip = remoteUnavailable
    ? (st.authHint === 'private-repo-needs-token'
      ? `<span style="color:var(--txt-3);font-size:12.5px">${t('settings.upPrivateRepoHint')}</span>`
      : `<span style="color:var(--txt-3);font-size:12.5px">${t('settings.upRemoteUnavailable')}</span>`)
    : hasUpdate
      ? `<span style="color:var(--txt-3);font-size:12.5px">${t('settings.upNewTip', '<b style="color:var(--warn)">' + esc(newLabel) + '</b>')}</span>`
      : `<span style="color:var(--txt-3);font-size:12.5px">${t('settings.upUpToDate')}</span>`;

  const applyDisabled = running || remoteUnavailable || !hasUpdate;
  // 上次更新失败（代码未被改动）：按钮转为「重试更新」，并给一条明确的横幅，
  // 让用户不必翻日志就知道可以直接再点一次。
  const failed = !running && st.phase === 'error';
  // 快照通道：工作区已更新、git 索引待对齐（下次成功联网会自动对齐）
  const snapshot = st.snapshot || null;
  const applyLabel = failed ? t('settings.upRetryBtn') : t('settings.upApplyBtn');

  const banners = `${isRestart ? `<div class="up-banner restart"><i class="up-spin"></i><span>${t('settings.upRestartingBanner')}</span></div>` : ''}
      ${failed ? `<div class="up-banner err">${ICON_WARN}<span>${t('settings.upFailedBanner')}</span></div>` : ''}
      ${snapshot ? `<div class="up-banner snap">${ICON_WARN}<span>${t('settings.upSnapshotHint', `<b class="mono">${esc(String(snapshot.commit || snapshot.tag || '').slice(0, 12))}</b>`, esc(String(snapshot.version || '')))}</span></div>` : ''}`;

  const version = `
        <div class="card-h"><h3>${t('settings.upTitle')}</h3><span class="hint">${t('settings.upHint')}</span></div>
        <div class="card-b">
          <div class="up-grid">
            <div class="up-vcard">
              <div class="up-vlabel">${t('settings.upCurrent')}</div>
              <div class="up-vnum">${esc(curVer)} ${curChip}</div>
              <div class="up-vrows">
                <div class="up-vr"><b>${t('settings.upCommitTime')}</b><span>${esc(local.commitAt ? formatDateTime(local.commitAt) : '—')}</span></div>
                <div class="up-vr"><b>${t('settings.upCommitId')}</b><span>${esc(local.commit || '—')}</span></div>
                <div class="up-vr"><b>${t('settings.upBranch')}</b><span>${esc(local.branch || st.branch || 'main')}</span></div>
              </div>
            </div>
            <div class="up-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>
            <div class="up-vcard${hasUpdate && !remoteUnavailable ? ' hot' : ''}">
              <div class="up-vlabel">${t('settings.upLatest')}</div>
              <div class="up-vnum">${esc(latestVer)} ${latestChip}</div>
              <div class="up-vrows">
                <div class="up-vr"><b>${t('settings.upCommitTime')}</b><span>${esc(latest.commitAt ? formatDateTime(latest.commitAt) : '—')}</span></div>
                <div class="up-vr"><b>${t('settings.upCommitId')}</b><span>${esc(latest.commit || '—')}</span></div>
                <div class="up-vr"><b>${t('settings.upBranch')}</b><span>${esc(st.branch || 'main')}</span></div>
              </div>
            </div>
          </div>
          <div class="row" style="margin-top:18px;gap:10px;align-items:center;flex-wrap:wrap">
            <button class="btn" id="upCheck" ${st.checking ? 'disabled' : ''}>${ICON_REFRESH}${st.checking ? t('settings.upChecking') : t('settings.upCheckBtn')}</button>
            <button class="btn primary" id="upApply" ${applyDisabled ? 'disabled' : ''}>${ICON_DOWNLOAD}${applyLabel}</button>
            ${tip}
          </div>
          <div class="hintline" style="margin-top:10px">${t('settings.upRepo', esc(st.repo || st.gitUrl || '—'), esc(st.branch || 'main'))}</div>
        </div>`;

  // 进度卡：仅更新/检查进行中显示
  const progress = running ? `
    <div class="card">
      <div class="card-h"><h3>${t('settings.upProgressTitle')}</h3>
        <span class="chip bili" style="margin-left:auto"><i class="dot"></i>${esc(phaseLabel(st.phase, st.mode))}</span></div>
      <div class="card-b">
        ${st.task ? `<div style="font-size:12.5px;color:var(--txt-2)">${t('settings.upTaskLabel')}<span class="mono" style="color:var(--bili-2)">${esc(st.task)}</span></div>` : ''}
        <div class="up-bar"><i style="width:${clampNum(st.progress)}%"></i></div>
        <div class="row" style="justify-content:space-between;font-size:12px;color:var(--txt-3);margin-top:2px">
          <span>${t('settings.upElapsed')} <b style="color:var(--txt-2)">${esc(formatDuration(st.elapsedSec || 0))}</b></span>
          <span>${t('settings.upEstimate')} <b style="color:var(--txt-2)">${esc(estimateLabel(st.phase))}</b></span>
        </div>
        ${isRestart ? `<div class="up-restart-note"><i class="up-spin"></i><span>${t('settings.upRestartingBanner')}</span></div>` : ''}
      </div>
    </div>` : '';

  // 更新说明（左）：仅在有远端版本时展示
  const notes = (!remoteUnavailable && latest.tag) ? `
    <div class="row" style="align-items:center;gap:10px">
      <span style="font-size:16px;font-weight:700;font-family:var(--mono,monospace)">${esc(latestVer)}</span>
      ${hasUpdate ? `<span class="chip wait"><i class="dot"></i>${t('settings.upAvailable')}</span>` : `<span class="chip on"><i class="dot"></i>${t('settings.upLatestChip')}</span>`}
      ${latest.commitAt ? `<span style="color:var(--txt-3);font-size:12px">${esc(fmtDate(latest.commitAt))}</span>` : ''}
    </div>
    <div class="divider"></div>
    ${latest.releaseNotes ? `
      <div style="font-size:12px;color:var(--txt-3);letter-spacing:.5px;margin-bottom:8px">${t('settings.upNotesMain')}</div>
      <div style="font-size:13px;color:var(--txt-2);white-space:pre-wrap">${esc(latest.releaseNotes)}</div>` : `
      <div class="empty" style="padding:10px 0">${t('settings.upNotesNone')}</div>`}
    ${latest.commitMsg ? `<div class="hintline" style="margin-top:10px">${t('settings.upNotesFix')}：${esc(latest.commitMsg)}</div>` : ''}` : `
    <div class="empty" style="padding:14px 0">${remoteUnavailable ? (st.authHint === 'private-repo-needs-token' ? t('settings.upPrivateRepoHint') : t('settings.upRemoteUnavailable')) : t('settings.upNotChecked')}</div>`;

  // 更新日志（右）
  const logs = (st.log || []).slice();
  const log = logs.length ? logs.map((l) => `
    <div>
      <span class="dl-tl">${esc(fmtLogTime(l.ts))}</span>
      <span class="${l.level === 'OK' ? 'dl-ok' : l.level === 'ERR' ? 'dl-err' : l.level === 'WARN' ? 'dl-warn' : 'dl-nfo'}">${esc(l.level === 'OK' ? '[OK]  ' : l.level === 'ERR' ? '[ERR] ' : l.level === 'WARN' ? '[WARN]' : '[INFO]')}</span>
      <span class="dl-msg ${l.level === 'OK' ? 'dl-ok' : l.level === 'ERR' ? 'dl-err' : ''}">${esc(l.msg)}</span>
    </div>`).join('')
    : `<div class="empty" style="padding:14px 0">${t('settings.upLogEmpty')}</div>`;

  return {
    st, local, latest, running, hasUpdate, remoteUnavailable, isRestart, failed, snapshot,
    curVer, latestVer, tip, applyDisabled, applyLabel,
    banners, version, progress, notes, log,
  };
}

/* 更新源配置卡：只在首绘时渲染一次（之后永不重建，输入内容与焦点才不会被轮询吃掉）。 */
function configCardHtml(st) {
  const custom = (kitRef && kitRef.state && kitRef.state.settings && kitRef.state.settings.customize) || {};
  const repoVal = custom.updateRepo || st.repo || '';
  const branchVal = custom.updateBranch || st.branch || 'main';
  const tokenVal = custom.updateToken || ''; // 已配置时来自后端脱敏占位
  return `
    <div class="card" id="upConfigCard">
      <div class="card-h"><h3>${t('settings.upRepoCfgTitle')}</h3><span class="hint">${t('settings.upRepoCfgHint')}</span></div>
      <div class="card-b">
        <div class="row wrap" style="gap:16px 18px">
          <div class="f1" style="min-width:260px"><label class="fl">${t('settings.upRepoAddrLabel')}</label>
            <input class="input mono" id="upRepo" placeholder="owner/repo 或 https://github.com/owner/repo.git" value="${esc(repoVal)}" />
            <div class="hintline">${t('settings.upRepoAddrHint')}</div></div>
          <div class="f1" style="min-width:160px"><label class="fl">${t('settings.upBranch')}</label>
            <input class="input" id="upBranch" placeholder="main" value="${esc(branchVal)}" /></div>
          <div class="f1" style="min-width:260px"><label class="fl">${t('settings.upTokenLabel')}</label>
            <input class="input mono" id="upToken" type="password" autocomplete="off" placeholder="${t('settings.upTokenHint')}" value="${esc(tokenVal)}" />
            <div class="hintline">${t('settings.upTokenHint')}</div></div>
        </div>
        <div class="row" style="margin-top:16px;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn" id="upGithub">${ICON_GITHUB}${t('settings.upGotoGithub')}</button>
          <button class="btn primary" id="upCfgSave">${t('settings.upSaveConfig')}</button>
        </div>
      </div>
    </div>`;
}

function paint(root, st) {
  if (!root || !root.isConnected) return;
  /* 已经渲染过 → 局部更新（按区块 key 比对）。只有首次进入 / 切页回来（#upMain 不在了）才整块重建。 */
  const v = computeView(st);
  if (root.querySelector('#upMain')) { patchView(root, v); return; }

  root.innerHTML = `
    <div class="stack" style="max-width:1100px" id="upMain">
      <div id="upBanners">${v.banners}</div>

      ${configCardHtml(st)}

      <div class="card" id="upVersionCard">${v.version}</div>

      <div id="upProgressSlot">${v.progress}</div>

      <div class="up-two">
        <div class="card">
          <div class="card-h"><h3>${t('settings.upNotesTitle')}</h3></div>
          <div class="card-b" id="upNotes">${v.notes}</div>
        </div>
        <div class="card">
          <div class="card-h"><h3>${t('settings.upLogTitle')}</h3><span class="hint">${t('settings.upLogAlsoInLogs')}</span></div>
          <div class="card-b up-logbox" id="upLog">${v.log}</div>
        </div>
      </div>
    </div>`;

  ui.banners = v.banners;
  ui.version = v.version;
  ui.progress = v.progress;
  ui.notes = v.notes;
  ui.log = v.log;

  bindConfig(root, v);
  bindVersion(root, v);
}

/** 只替换内容真的变了的区块：配置卡不在列表里 —— 它渲染一次后就再也不会被轮询碰到。 */
function patchView(root, v) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  /* 用户正在本页输入（仓库/分支/Token）：这一轮什么都不动，1.5s 后再补。
     进度数字晚一两秒不碍事，把输入打断才是硬伤。 */
  if (active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '')) return;

  const blocks = [
    ['banners', '#upBanners'],
    ['version', '#upVersionCard'],
    ['progress', '#upProgressSlot'],
    ['notes', '#upNotes'],
    ['log', '#upLog'],
  ];
  for (const [key, sel] of blocks) {
    if (ui[key] === v[key]) continue; // 这块没变：DOM 原样保留（含滚动位置）
    const node = root.querySelector(sel);
    if (!node) return; // 页面结构被整体换过（如重启态）：下一轮 paint 会整块渲染
    ui[key] = v[key];
    node.innerHTML = v[key];
    if (key === 'version') bindVersion(root, v); // 版本卡里的按钮随卡片一起重建，需要重绑
  }
}

/* ---- 事件绑定 ---- */

function bindVersion(root, v) {
  const st = v.st;
  const applyLabel = v.applyLabel;

  const checkBtn = root.querySelector('#upCheck');
  if (checkBtn) checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    const old = checkBtn.innerHTML;
    checkBtn.innerHTML = ICON_REFRESH + t('settings.upChecking');
    try {
      const s = await api.updateCheck();
      paint(root, s);
      startPolling(root);
    } catch (e) {
      toast(t('settings.upCheckFailed', (e && e.message) || e), 'err');
      checkBtn.disabled = false;
      checkBtn.innerHTML = old;
    }
  };

  const applyBtn = root.querySelector('#upApply');
  if (applyBtn) applyBtn.onclick = () => {
    const selfUpdate = !!(st && st.canSelfUpdate);
    const confirmText = selfUpdate
      ? t('settings.upApplyConfirmSelf')
      : t('settings.upApplyConfirmManual');
    confirmDialog({
      title: t('settings.upApplyConfirmTitle'),
      danger: true,
      ok: applyLabel,
      text: confirmText,
      onOk: async () => {
        // 新一轮更新：重置重启相关标记
        expectingRestart = false;
        sawRestartPhase = false;
        reloadedAfterRestart = false;
        try {
          const r = await api.updateApply();
          if (r && r.running) {
            toast(t('settings.upApplyStarted'));
            if (selfUpdate) expectingRestart = true; // 支持自更新：将自动重启
          } else if (r && r.busy) toast(t('settings.upApplyBusy'), 'warn');
          const s = await api.updateStatus();
          paint(root, s);
          startPolling(root);
        } catch (e) {
          toast((e && e.message) || t('settings.upCheckFailed', ''), 'err');
        }
      },
    });
  };
}

function bindConfig(root, v) {
  const st = v.st;

  // ---- 更新源配置：前往 GitHub 仓库 ----
  const ghBtn = root.querySelector('#upGithub');
  if (ghBtn) ghBtn.onclick = () => {
    const repoInput = root.querySelector('#upRepo');
    let url = ((repoInput && repoInput.value) || '').trim();
    if (/^https?:\/\//.test(url)) {
      url = url.replace(/\.git$/, '');
    } else if (url) {
      url = 'https://github.com/' + url;
    } else if (st.gitUrl) {
      url = String(st.gitUrl).replace(/\.git$/, '');
    } else if (st.repo) {
      url = 'https://github.com/' + st.repo;
    } else {
      toast(t('settings.upRepoEmpty'), 'warn');
      return;
    }
    window.open(url, '_blank', 'noopener');
  };

  // ---- 更新源配置：保存 ----
  const saveBtn = root.querySelector('#upCfgSave');
  if (saveBtn) saveBtn.onclick = async () => {
    const repoInput = root.querySelector('#upRepo');
    const branchInput = root.querySelector('#upBranch');
    const tokenInput = root.querySelector('#upToken');
    const repo = ((repoInput && repoInput.value) || '').trim();
    const branch = ((branchInput && branchInput.value) || '').trim();
    const token = (tokenInput && tokenInput.value) || ''; // 原始输入（占位或明文）
    const prev = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = t('common.saving');
    try {
      const r = await api.updateConfig({ repo, branch, token });
      toast(t('settings.upSaved'));
      // 同步内存中的 customize，便于后续重绘保留；token 回显脱敏占位
      if (kitRef && kitRef.state && kitRef.state.settings) {
        kitRef.state.settings.customize = Object.assign({}, kitRef.state.settings.customize, {
          updateRepo: r.repo, updateGitUrl: r.gitUrl, updateBranch: r.branch, updateToken: r.token,
        });
      }
      const s2 = await api.updateStatus();
      paint(root, s2); // 局部更新：配置卡不重建，输入框里的值就是刚保存的值
    } catch (e) {
      toast(t('settings.upSaveFailed', (e && e.message) || e), 'err');
      saveBtn.disabled = false;
      saveBtn.innerHTML = prev;
    }
  };
}

function phaseLabel(phase, mode) {
  switch (phase) {
    case 'fetch': return t('settings.upPhaseFetch');
    case 'pull': return mode === 'archive' ? t('settings.upPhaseExtract') : t('settings.upPhasePull');
    case 'install': return t('settings.upPhaseInstall');
    case 'switch': return t('settings.upPhaseSwitch');
    case 'restart': return t('settings.upPhaseRestart');
    case 'done': return t('common.completed');
    case 'error': return t('settings.upPhaseError');
    default: return t('settings.upPhaseIdle');
  }
}

function estimateLabel(phase) {
  if (phase === 'install') return '~ 1 分钟';
  if (phase === 'switch') return '即将完成';
  if (phase === 'pull') return '~ 30 秒';
  if (phase === 'fetch') return '~ 15 秒';
  if (phase === 'restart') return '即将完成';
  return '—';
}

/** 轮询失败（服务正在释放端口/重启）时，展示「自动重启中」全屏提示而非报错。 */
function paintRestarting(root) {
  if (!root || !root.isConnected) return;
  if (root.querySelector('.restart-card')) return; // 已经是重启态：不必反复重建
  resetBlocks(); // 整块换掉了：下次 paint 必须整块重建
  root.innerHTML = `
    <div class="stack" style="max-width:1100px">
      <div class="card restart-card">
        <div class="restart-spinner"></div>
        <h3>${t('settings.upRestartingTitle')}</h3>
        <p class="restart-sub">${t('settings.upRestartingSub')}</p>
      </div>
    </div>`;
}

function clampNum(n) {
  n = Number(n) || 0;
  return Math.min(100, Math.max(0, n));
}

function fmtLogTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch { return String(iso || ''); }
}
