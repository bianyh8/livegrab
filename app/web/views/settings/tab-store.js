/* LiveGrab · views/settings/tab-store.js —— ② 存储
   存储与清理（根目录 + 检测、保留下限、成品保留、回收站）。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches } from '../../ui.js';
import { t } from '../../i18n.js';
import { read } from './tabkit.js';

export async function render(root, ctx, kit) {
  const s = kit.state.settings || {};

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>${t('settings.recStorageTitle')}</h3><span class="hint">${t('settings.recStorageHint')}</span></div>
        <div class="card-b">
          <div class="form-row">
            <label class="fl">${t('settings.recRootLabel')}</label>
            <div class="row">
              <input class="input mono f1" id="setRoot" value="${esc(read(kit.state, 'recordRoot', '/data'))}" />
              <button class="btn" id="setCheck">${t('tasks.verbCheck')}</button>
            </div>
            <div class="hintline">${t('settings.recRootHint')}</div>
          </div>
          <div class="row wrap">
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recDiskLimitLabel')}</label>
              <div class="row" style="align-items:center;gap:8px">
                <input class="input" id="setDiskLimit" style="width:100px" value="${esc(String(read(kit.state, 'diskLimitGB', 20)))}" />
                <span style="color:var(--txt-3);font-size:12.5px">${t('settings.recDiskTrigger')}</span>
              </div>
            </div>
            <div class="f1" style="min-width:200px"><label class="fl">${t('settings.recRetentionLabel')}</label>
              <div class="row" style="align-items:center;gap:8px">
                <input class="input" id="setRetention" style="width:100px" value="${esc(String(read(kit.state, 'retentionDays', 30)))}" />
                <span style="color:var(--txt-3);font-size:12.5px">${t('settings.recRetentionAfter')}</span>
              </div>
            </div>
          </div>
          <div class="sw-row"><div><div class="t">${t('settings.recSkipLiveSeg')}</div><div class="d">${t('settings.recSkipLiveSegDesc')}</div></div><div class="spacer"></div>${switchEl(true, 'data-fixed="1"')}</div>
          <div class="sw-row"><div><div class="t">${t('settings.recToTrash')}</div><div class="d">${t('settings.recToTrashDesc')}</div></div><div class="spacer"></div>${switchEl(s.deleteToTrash !== false, 'id="setTrash"')}</div>
          <div class="form-row" style="margin:4px 0 0">
            <label class="fl">${t('settings.recTrashRetention')}</label>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="setTrashDays" style="width:100px" value="${esc(String(read(kit.state, 'trashRetentionDays', 7)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">${t('settings.recTrashAfter')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  kit.bind(root.querySelector('#setRoot'), 'recordRoot');
  kit.bind(root.querySelector('#setDiskLimit'), 'diskLimitGB', 'number');
  kit.bind(root.querySelector('#setRetention'), 'retentionDays', 'number');
  kit.bind(root.querySelector('#setTrashDays'), 'trashRetentionDays', 'number');

  bindSwitches(root, (sw) => {
    const on = sw.classList.contains('on');
    if (sw.id === 'setTrash') kit.set('deleteToTrash', on);
  });

  const check = root.querySelector('#setCheck');
  check.onclick = async () => {
    check.disabled = true;
    const old = check.textContent;
    check.textContent = t('settings.recChecking');
    try {
      const r = await api.filesScan();
      toast(t('settings.recScanResult', read(kit.state, 'recordRoot', '/data'), Number(r && r.added) || 0, Number(r && r.updated) || 0, Number(r && r.missing) || 0));
    } catch (e) {
      toast(t('settings.recScanFail', e.message || t('settings.recRootNotWritable')), 'err');
    } finally {
      check.disabled = false;
      check.textContent = old;
    }
  };
}
