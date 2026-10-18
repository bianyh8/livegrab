/* LiveGrab · views/settings/tab-rec.js —— ① 录制
   录制默认参数（默认清晰度 / 回退顺序 / 分段 / 容器 / 并发 / 后处理 / 日志）。
   平台级「并发上限 / 启用」等合并到「③ 平台账号」，这里不再重复。
   时区不在前台显示/修改：默认 Asia/Shanghai，Docker 里由 compose 的 environment: TZ 提供。 */

import { esc, switchEl, bindSwitches } from '../../ui.js';
import { t } from '../../i18n.js';
import { read } from './tabkit.js';

const QUALITIES = [
  ['origin', t('settings.qOriginHighest')],
  ['bluray', t('tasks.qBlurayName')],
  ['uhd', t('tasks.qUhdName')],
  ['hd', t('tasks.qHdName')],
  ['sd', t('tasks.qSdName')],
  ['audio', t('tasks.qAudioName')],
];
const QLABEL = { origin: t('tasks.qOrigin'), bluray: t('tasks.qBluray'), uhd: t('tasks.qUhd'), hd: t('tasks.qHd'), sd: t('tasks.qSd'), audio: t('tasks.qAudio') };

export async function render(root, ctx, kit) {
  const s = kit.state.settings || {};
  const fallback = (s.qualityFallback || ['origin', 'bluray', 'uhd', 'hd', 'sd']).map((q) => QLABEL[q] || q).join(' → ');

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>${t('settings.recDefaultsTitle')}</h3><span class="hint">${t('settings.recDefaultsHint')}</span></div>
        <div class="card-b">
          <div class="row wrap">
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recDefaultQuality')}</label>
              <select class="select" id="setQuality">
                ${QUALITIES.map(([v, lbl]) => `<option value="${v}"${read(kit.state, 'defaultQuality', 'origin') === v ? ' selected' : ''}>${lbl}</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:260px"><label class="fl">${t('settings.recFallbackLabel')}</label>
              <input class="input mono" id="setFallback" value="${esc(fallback)}" />
              <div class="hintline">${t('settings.recFallbackHint')}</div>
            </div>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recSegMinLabel')}</label>
              <input class="input" id="setSegMin" type="number" min="1" step="1" value="${esc(String(Number(read(kit.state, 'defaultSegmentMinutes', 3600)) || 3600))}" />
              <div class="hintline">${t('settings.recSegMinHint')}</div></div>
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recSegModeLabel')}</label>
              <select class="select" id="setSegMode">
                ${[['time', t('settings.recSegByTime')], ['size', t('settings.recSegBySize')], ['none', t('seg.none')]].map(([v, lbl]) => `<option value="${v}"${read(kit.state, 'defaultSegmentMode', 'time') === v ? ' selected' : ''}>${lbl}</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recContainerLabel')}</label>
              <select class="select" id="setContainer">
                ${[['ts', t('settings.recContainerTs')], ['flv', 'FLV'], ['mkv', 'MKV']].map(([v, lbl]) => `<option value="${v}"${read(kit.state, 'recordContainer', read(kit.state, 'container', 'ts')) === v ? ' selected' : ''}>${lbl}</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recConcurrencyLabel')}</label>
              <input class="input" id="setConcurrency" value="${esc(String(read(kit.state, 'maxConcurrency', 8)))}" />
              <div class="hintline">${t('settings.recConcurrencyHint')}</div></div>
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recPlayConcurrencyLabel')}</label>
              <input class="input" id="setPlayConcurrency" value="${esc(String(read(kit.state, 'playConcurrency', 2)))}" />
              <div class="hintline">${t('settings.recPlayConcurrencyHint')}</div></div>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recLogDaysLabel')}</label>
              <input class="input" id="setLogDays" value="${esc(String(read(kit.state, 'logRetentionDays', 14)))}" />
              <div class="hintline">${t('settings.recLogDaysHint')}</div></div>
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recLogLevelLabel')}</label>
              <select class="select" id="setLogLevel">
                ${['INFO', 'WARN', 'ERROR', 'DEBUG'].map((v) => `<option value="${v}"${read(kit.state, 'logLevel', 'INFO') === v ? ' selected' : ''}>${v}${v === 'DEBUG' ? t('settings.recLogDebugNote') : ''}</option>`).join('')}
              </select></div>
          </div>
          <div class="divider"></div>
          <div class="sw-row"><div><div class="t">${t('settings.recRemuxLabel')}</div><div class="d">${t('settings.recRemuxDesc')}</div></div><div class="spacer"></div>${switchEl(s.remuxToMp4 !== false, 'id="setRemux"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recKeepSourceLabel')}</div><div class="d">${t('settings.recKeepSourceDesc')}</div></div><div class="spacer"></div>${switchEl(s.keepSource !== false, 'id="setKeep"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recAutoMergeLabel')}</div><div class="d">${t('settings.recAutoMergeDesc')}</div></div><div class="spacer"></div>${switchEl(!!s.autoMerge, 'id="setAutoMerge"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recMergeOnStopLabel')}</div><div class="d">${t('settings.recMergeOnStopDesc')}</div></div><div class="spacer"></div>${switchEl(!!s.mergeOnStop, 'id="setMergeOnStop"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recDeleteAfterMergeLabel')}</div><div class="d">${t('settings.recDeleteAfterMergeDesc')}</div></div><div class="spacer"></div>${switchEl(s.deleteAfterMerge !== false, 'id="setDeleteAfterMerge"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recDefaultMonitorLabel')}</div><div class="d">${t('settings.recDefaultMonitorDesc')}</div></div><div class="spacer"></div>${switchEl(!!read(kit.state, 'defaultMonitorOnly', false), 'id="setDefaultMonitor"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recReconnectLabel')}</div><div class="d">${t('settings.recReconnectDesc')}</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="setReconnectMax" style="width:74px" value="${esc(String(read(kit.state, 'reconnectMax', 5)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">${t('settings.recReconnUnit')}</span>
            </div></div>
        </div>
      </div>
    </div>`;

  /* 输入绑定 */
  kit.bind(root.querySelector('#setQuality'), 'defaultQuality');
  kit.bind(root.querySelector('#setConcurrency'), 'maxConcurrency', 'number');
  kit.bind(root.querySelector('#setPlayConcurrency'), 'playConcurrency', 'number');
  kit.bind(root.querySelector('#setLogDays'), 'logRetentionDays', 'number');
  kit.bind(root.querySelector('#setLogLevel'), 'logLevel');
  kit.bind(root.querySelector('#setReconnectMax'), 'reconnectMax', 'number');
  kit.bind(root.querySelector('#setSegMin'), 'defaultSegmentMinutes', 'number');
  kit.bind(root.querySelector('#setSegMode'), 'defaultSegmentMode');
  kit.bind(root.querySelector('#setContainer'), 'recordContainer');

  const fallbackInput = root.querySelector('#setFallback');
  fallbackInput.onchange = () => {
    const ids = fallbackInput.value.split(/[\/→>，,]+/).map((x) => x.trim()).filter(Boolean)
      .map((x) => Object.keys(QLABEL).find((k) => QLABEL[k] === x) || x)
      .filter((x) => QLABEL[x]);
    kit.set('qualityFallback', ids);
  };

  bindSwitches(root, (sw) => {
    const id = sw.id;
    const on = sw.classList.contains('on');
    if (id === 'setRemux') kit.set('remuxToMp4', on);
    else if (id === 'setKeep') kit.set('keepSource', on);
    else if (id === 'setAutoMerge') kit.set('autoMerge', on);
    else if (id === 'setMergeOnStop') kit.set('mergeOnStop', on);
    else if (id === 'setDeleteAfterMerge') kit.set('deleteAfterMerge', on);
    else if (id === 'setDefaultMonitor') kit.set('defaultMonitorOnly', on);
  });
}
