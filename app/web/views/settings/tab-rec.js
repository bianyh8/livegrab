/* LiveGrab · views/settings/tab-rec.js —— ① 录制与存储
   存储与清理（根目录 + 检测、保留下限、成品保留、回收站）
   ＋ 录制默认参数（默认清晰度 / 回退顺序 / 分段时长 / 并发上限 / 后处理开关）。
   平台级「并发上限 / 启用」等合并到「② 平台账号」，这里不再重复（D16）。
   时区不在前台显示/修改：默认 Asia/Shanghai，Docker 里由 compose 的 environment: TZ 提供（D15）。 */

import { api } from '../../api.js';
import { esc, toast, switchEl, bindSwitches } from '../../ui.js';
import { read } from './tabkit.js';

const QUALITIES = [
  ['origin', '原画（最高可用）'],
  ['bluray', '蓝光 1080P'],
  ['uhd', '超清 720P'],
  ['hd', '高清 540P'],
  ['sd', '标清 360P'],
  ['audio', '仅音频 AAC 128k'],
];
const QLABEL = { origin: '原画', bluray: '蓝光', uhd: '超清', hd: '高清', sd: '标清', audio: '仅音频' };

export async function render(root, ctx, kit) {
  const s = kit.state.settings || {};
  const fallback = (s.qualityFallback || ['origin', 'bluray', 'uhd', 'hd', 'sd']).map((q) => QLABEL[q] || q).join(' → ');

  root.innerHTML = `
    <div class="stack" style="max-width:1020px">
      <div class="card">
        <div class="card-h"><h3>存储与清理</h3><span class="hint">录制文件与回收站都落在容器内挂载卷</span></div>
        <div class="card-b">
          <div class="form-row">
            <label class="fl">存储根目录（容器内）</label>
            <div class="row">
              <input class="input mono f1" id="setRoot" value="${esc(read(kit.state, 'recordRoot', '/data'))}" />
              <button class="btn" id="setCheck">检测</button>
            </div>
            <div class="hintline">必须是<b>容器内</b>的绝对路径，且与启动时的挂载一致：<span class="mono">-v /你的宿主目录:/data</span>。浏览器无法选择宿主文件夹，所以这里只做"路径存在且可写"检测；换目录请改挂载后重启容器。</div>
          </div>
          <div class="row wrap">
            <div class="f1" style="min-width:200px"><label class="fl">磁盘保留下限</label>
              <div class="row" style="align-items:center;gap:8px">
                <input class="input" id="setDiskLimit" style="width:100px" value="${esc(String(read(kit.state, 'diskLimitGB', 20)))}" />
                <span style="color:var(--txt-3);font-size:12.5px">GB 以下触发清理</span>
              </div>
            </div>
            <div class="f1" style="min-width:200px"><label class="fl">成品文件保留</label>
              <div class="row" style="align-items:center;gap:8px">
                <input class="input" id="setRetention" style="width:100px" value="${esc(String(read(kit.state, 'retentionDays', 30)))}" />
                <span style="color:var(--txt-3);font-size:12.5px">天后自动删除</span>
              </div>
            </div>
          </div>
          <div class="sw-row"><div><div class="t">清理时跳过正在录制的分段</div><div class="d">保护当前分段与临时文件，避免录到一半被删</div></div><div class="spacer"></div>${switchEl(true, 'data-fixed="1"')}</div>
          <div class="sw-row"><div><div class="t">删除时移入回收站</div><div class="d">落到 <span class="mono">/data/.trash</span>，可还原 / 一键清空（D10）</div></div><div class="spacer"></div>${switchEl(s.deleteToTrash !== false, 'id="setTrash"')}</div>
          <div class="form-row" style="margin:4px 0 0">
            <label class="fl">回收站保留</label>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="setTrashDays" style="width:100px" value="${esc(String(read(kit.state, 'trashRetentionDays', 7)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">天后自动清理</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3>录制默认参数</h3><span class="hint">新建任务时的默认值，可被任务单独覆盖（D11）</span></div>
        <div class="card-b">
          <div class="row wrap">
            <div class="f1" style="min-width:200px"><label class="fl">默认清晰度</label>
              <select class="select" id="setQuality">
                ${QUALITIES.map(([v, t]) => `<option value="${v}"${read(kit.state, 'defaultQuality', 'origin') === v ? ' selected' : ''}>${t}</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:260px"><label class="fl">清晰度回退顺序</label>
              <input class="input mono" id="setFallback" value="${esc(fallback)}" />
              <div class="hintline">按 <span class="mono">/</span> 或 <span class="mono">→</span> 分隔；留空表示不回退、失败即报错。</div>
            </div>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <div class="f1" style="min-width:200px"><label class="fl">分段时长</label>
              <select class="select" id="setSegMin">
                ${[30, 60, 120].map((m) => `<option value="${m}"${Number(read(kit.state, 'defaultSegmentMinutes', 60)) === m ? ' selected' : ''}>${m} 分钟</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:200px"><label class="fl">默认分段方式</label>
              <select class="select" id="setSegMode">
                ${[['time', '按时间'], ['size', '按文件大小'], ['none', '不分段']].map(([v, t]) => `<option value="${v}"${read(kit.state, 'defaultSegmentMode', 'time') === v ? ' selected' : ''}>${t}</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:200px"><label class="fl">录制中封装格式</label>
              <select class="select" id="setContainer">
                ${[['ts', 'TS（推荐，断流容错好）'], ['flv', 'FLV'], ['mkv', 'MKV']].map(([v, t]) => `<option value="${v}"${read(kit.state, 'recordContainer', read(kit.state, 'container', 'ts')) === v ? ' selected' : ''}>${t}</option>`).join('')}
              </select></div>
            <div class="f1" style="min-width:200px"><label class="fl">最大并发录制数</label>
              <input class="input" id="setConcurrency" value="${esc(String(read(kit.state, 'maxConcurrency', 8)))}" />
              <div class="hintline">实际并发 = min(全局上限, 「平台账号」里的平台上限)（D16）</div></div>
            <div class="f1" style="min-width:200px"><label class="fl">并发回放上限</label>
              <input class="input" id="setPlayConcurrency" value="${esc(String(read(kit.state, 'playConcurrency', 2)))}" />
              <div class="hintline">同时最多 N 路 TS/FLV 转封装回放，超出返回 429（D17）；MP4 直放不受限</div></div>
          </div>
          <div class="row wrap" style="margin-top:16px">
            <div class="f1" style="min-width:200px"><label class="fl">日志保留天数</label>
              <input class="input" id="setLogDays" value="${esc(String(read(kit.state, 'logRetentionDays', 14)))}" />
              <div class="hintline">按天切分，超期自动清理（D14）</div></div>
            <div class="f1" style="min-width:200px"><label class="fl">默认日志级别</label>
              <select class="select" id="setLogLevel">
                ${['INFO', 'WARN', 'ERROR', 'DEBUG'].map((v) => `<option value="${v}"${read(kit.state, 'logLevel', 'INFO') === v ? ' selected' : ''}>${v}${v === 'DEBUG' ? '（含 ffmpeg 全量 stderr，增长快）' : ''}</option>`).join('')}
              </select></div>
          </div>
          <div class="divider"></div>
          <div class="sw-row"><div><div class="t">录制结束自动转封装 MP4</div><div class="d">使用 ffmpeg -c copy 无损封转，秒级完成（D5）</div></div><div class="spacer"></div>${switchEl(s.remuxToMp4 !== false, 'id="setRemux"')}</div>
          <div class="sw-row"><div><div class="t">保留原始 TS 分段</div><div class="d">关闭则转封装成功后删除源文件，可省约 30% 空间</div></div><div class="spacer"></div>${switchEl(s.keepSource !== false, 'id="setKeep"')}</div>
          <div class="sw-row"><div><div class="t">分段结束后自动合并为单文件</div><div class="d">适合赛事、歌回等需要完整成片的场景</div></div><div class="spacer"></div>${switchEl(!!s.autoMerge, 'id="setAutoMerge"')}</div>
          <div class="sw-row"><div><div class="t">停止时合并整场（mergeOnStop）</div><div class="d">停止录制后自动把本场分段合并为一个文件</div></div><div class="spacer"></div>${switchEl(!!s.mergeOnStop, 'id="setMergeOnStop"')}</div>
          <div class="sw-row"><div><div class="t">新任务默认「仅监控，不录制」</div><div class="d">开启后新建任务只监控直播状态、不录制；可在任务里单独改</div></div><div class="spacer"></div>${switchEl(!!read(kit.state, 'defaultMonitorOnly', false), 'id="setDefaultMonitor"')}</div>
          <div class="sw-row"><div><div class="t">断流自动重连</div><div class="d">指数退避 2/4/8/16/30 秒</div></div><div class="spacer"></div>
            <div class="row" style="align-items:center;gap:8px">
              <input class="input" id="setReconnectMax" style="width:74px" value="${esc(String(read(kit.state, 'reconnectMax', 5)))}" />
              <span style="color:var(--txt-3);font-size:12.5px">次</span>
            </div></div>
        </div>
      </div>
    </div>`;

  /* 输入绑定 */
  kit.bind(root.querySelector('#setRoot'), 'recordRoot');
  kit.bind(root.querySelector('#setDiskLimit'), 'diskLimitGB', 'number');
  kit.bind(root.querySelector('#setRetention'), 'retentionDays', 'number');
  kit.bind(root.querySelector('#setTrashDays'), 'trashRetentionDays', 'number');
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
    if (id === 'setTrash') kit.set('deleteToTrash', on);
    else if (id === 'setRemux') kit.set('remuxToMp4', on);
    else if (id === 'setKeep') kit.set('keepSource', on);
    else if (id === 'setAutoMerge') kit.set('autoMerge', on);
    else if (id === 'setMergeOnStop') kit.set('mergeOnStop', on);
    else if (id === 'setDefaultMonitor') kit.set('defaultMonitorOnly', on);
  });

  const check = root.querySelector('#setCheck');
  check.onclick = async () => {
    check.disabled = true;
    const old = check.textContent;
    check.textContent = '检测中…';
    try {
      const r = await api.filesScan();
      toast(`已检测：${read(kit.state, 'recordRoot', '/data')} 可访问 · 扫描新增 ${Number(r && r.added) || 0}、更新 ${Number(r && r.updated) || 0}、缺失 ${Number(r && r.missing) || 0}、未登记 ${Number(r && r.unregistered) || 0}`);
    } catch (e) {
      toast('检测失败：' + (e.message || '路径不可访问或不可写'), 'err');
    } finally {
      check.disabled = false;
      check.textContent = old;
    }
  };
}
