/* LiveGrab · ui/_views_files.frag.js —— 录制文件库（原型片段，纯 HTML 字符串，不绑定事件）
   ------------------------------------------------------------------------------------------
   对齐 production：app/web/views/files.js（整篇 405 行）
     · card-h「录制文件库」+ .hint「N 个视频文件 · X MB」= t('files.videoCount') + formatBytes(bytes)
       （files.js 的 bytesHint()；N / bytes 按当前筛选的全量统计）
     · toolbar：#flQ 搜索 / #flPlat 平台 / #flDateFrom·#flDateTo（默认近 7 天，defaultDateRange()）/
       「至」#flExt 类型 / #flQuery 查询 / #flClear 清除 / spacer / 全选 + 已选中 N 项 + 删除所选
     · 行 = filenameRow({ f, s, tag })：勾选框 / .fl-ico + 平台色类（platformInfo(platform).cls）/
       文件名 + tag chip + 状态 chip（录制中 wait / 文件缺失 err / 已录完 on）/ 第二行 meta
       （platBadge、主播、formatDateTime(startedAt)、时长、大小）/ 右侧播放·下载·删除
       —— 按钮禁用规则照源码：missing → 播放 disabled；playing（s.status==='recording'）或 missing → 删除 disabled
     · 末尾 pagerHTML('flPager', page, pages, total)；空态 emptyBox(t('files.noFilteredFiles'))
   · 文案 1:1 取自 app/web/i18n/zh-CN.json 的 files.* / common.*；类名全部来自骨架 ui/index.html。
   · 骨架差异：接口 h.pagerHTML 生成「第 1 / 1 页」；production ui.js / common.pagerInfo 为「第 1/1 页」。本片段输出 production 文案。
   ------------------------------------------------------------------------------------------ */

const PAGE_SIZE = 10; // files.js：PAGE_SIZE —— 后端分页；mock 共 10 条 → 1 页 10 条

/* files.js defaultDateRange()：近 7 天（7 天前 → 今天），本地时间 YYYY-MM-DD */
function defaultDateRange() {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(new Date(Date.now() - 7 * 864e5)), to: fmt(new Date()) };
}

/* files.js platNameOf()：平台 id → 中文名（与 D.platforms 的 name 一致） */
const PLAT_NAME = {
  douyin: '抖音', bilibili: '哔哩哔哩', kuaishou: '快手', huya: '虎牙', douyu: '斗鱼',
  xiaohongshu: '小红书', weibo: '微博', acfun: 'AcFun', cc: '网易CC', yy: 'YY', wechat: '微信视频号', direct: '直链',
};

/* files.js filenameRow() 的 options：全部类型 / .ts 直播流 / .mp4 / m4a / .m4a 音频 */
const EXT_OPTIONS = [
  ['', '全部类型'],
  ['ts', '.ts 直播流'],
  ['mp4', '.mp4 / m4a'],
  ['m4a', '.m4a 音频'],
];

export function renderFiles(ctx, D, h) {
  const rows = (D && D.files) || [];
  const set = new Set((D && D.platforms ? D.platforms : []).map((p) => p.id));

  /* 全量统计（对齐后端 r.total / r.bytes）：videoCount 与头部 hint 均基于筛选后的全量 */
  const total = rows.length;
  const bytes = rows.reduce((n, r) => n + (Number(r && r.f && r.f.bytes) || 0), 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);

  /* 平台下拉：真实数据里出现过的平台优先，补上配置里已接入的平台 */
  const platOrder = ['douyin', 'bilibili', 'kuaishou', 'huya', 'douyu', 'xiaohongshu', 'weibo', 'acfun', 'cc', 'yy', 'wechat', 'direct'];
  const platIds = [];
  rows.forEach(({ s }) => { const id = s && s.platform; if (id && !platIds.includes(id)) platIds.push(id); });
  platOrder.forEach((id) => { if (set.has(id) && !platIds.includes(id)) platIds.push(id); });
  platIds.sort((a, b) => platOrder.indexOf(a) - platOrder.indexOf(b));

  const { from, to } = defaultDateRange();

  /* 勾选状态：原型默认 0 项（已选中 N 项 chip 灰、删除所选 disabled）；若上游往 ctx.state 里写了勾选则如实反映 */
  const picked = (ctx && ctx.state && ctx.state.filesPicked instanceof Set) ? ctx.state.filesPicked : new Set();
  const allSel = rows.length > 0 && rows.every(({ f }) => picked.has(f.id));
  const pickedBytes = rows.reduce((n, { f }) => (picked.has(f.id) ? n + (Number(f.bytes) || 0) : n), 0);

  const body = rows.length
    ? rows.map((row) => fileRow(row, h, picked)).join('')
    : h.emptyBox('没有符合筛选条件的录制文件');

  return `
  <div class="card">
    <div class="card-h">
      <h3>录制文件库</h3>
      <span class="hint" data-files-bytes>${h.esc(`${total} 个视频文件`)} · ${h.esc(h.fmtBytes(bytes))}</span>
      <div class="spacer"></div>
      <button class="btn sm ghost" id="flRefresh">刷新</button>
    </div>

    <div class="toolbar" style="padding:10px 16px 12px;flex-wrap:wrap">
      <input class="input" id="flQ" style="width:180px" placeholder="搜索 文件名/主播/标题" value="" />
      <select class="select" id="flPlat" style="width:120px">
        <option value="">全部平台</option>
        ${platIds.map((id) => `<option value="${h.esc(id)}">${h.esc(PLAT_NAME[id] || h.platformInfo(id).name)}</option>`).join('')}
      </select>
      <input type="date" class="input" id="flDateFrom" style="width:150px" title="起始日期" value="${h.esc(from)}" />
      <span style="color:var(--txt-3);font-size:12px">至</span>
      <input type="date" class="input" id="flDateTo" style="width:150px" title="结束日期" value="${h.esc(to)}" />
      <select class="select" id="flExt" style="width:120px">
        ${EXT_OPTIONS.map(([v, label]) => `<option value="${v}">${h.esc(label)}</option>`).join('')}
      </select>
      <button class="btn sm primary" id="flQuery">查询</button>
      <button class="btn sm ghost" id="flClear">清除</button>
      <div class="spacer"></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--txt-2);cursor:pointer">
        <input type="checkbox" class="cb" id="flSelAll"${allSel ? ' checked' : ''} /> 全选
      </label>
      <span class="chip${picked.size ? ' on' : ''}" id="flPickChip"><i class="dot"></i>${h.esc(`已选中 ${picked.size} 项`)}${picked.size ? `<span class="mono" style="color:var(--txt-3)">· ${h.esc(h.fmtBytes(pickedBytes))}</span>` : ''}</span>
      <button class="btn sm danger" id="flDelPicked"${picked.size ? '' : ' disabled'}>删除所选</button>
    </div>

    <div style="padding:0 16px 16px" id="flBody">
      ${body}
    </div>

    ${pagerHtml('flPager', 1, pages, total)}
  </div>`;
}

/* ---------- 单行：对齐 files.js filenameRow({ f, s, tag }) ----------
   结构说明：.fl-item 内只有「勾选框 / .fl-ico / 主块 / .acts」四个直接子元素。
   骨架移动端媒体查询会把 .fl-item 改成 flex-wrap:wrap，并让 .fl-item .acts 撑满一行（flex:1 1 100%）；
   而 .acts 是源码里真正的 class（ui.js 无它、app.css 里是 .acts{display:flex;gap:6px;justify-content:flex-end}），
   内容块不能再占用 .acts 这个类名，否则桌面端的 justify-content:flex-end 会作用到文件名行上（文件名被推到右侧、状态芯片跑远）。
   因此内容块用 inline 样式表达，只有右侧按钮组保留 class="acts" → 桌面/移动端两种布局都能正确折行。 */
function fileRow({ f, s, tag }, h, picked) {
  const fps = f || {};
  const ses = s || {};
  const playing = ses.status === 'recording';
  const missing = fps.status === 'missing';
  const icoCls = h.platformInfo(ses.platform).cls;
  const extLabel = tag || (fps.ext ? String(fps.ext).toUpperCase() : 'TS');
  const name = fps.name || fps.relPath || '—';
  const dur = h.fmtDur(fps.durationSec || ses.durationSec || 0);

  const chip = playing
    ? `<span class="chip wait" style="margin-left:6px"><i class="dot"></i>录制中</span>`
    : missing
      ? `<span class="chip err" style="margin-left:6px">文件缺失</span>`
      : `<span class="chip on" style="margin-left:6px"><i class="dot"></i>已录完</span>`;

  return `
    <div class="fl-item" style="align-items:flex-start" data-file="${h.esc(fps.id)}">
      <input type="checkbox" class="cb" data-pick-file="${h.esc(fps.id)}"${picked.has(fps.id) ? ' checked' : ''} title="选择该文件" style="margin-top:6px" />
      <div class="fl-ico ${h.esc(icoCls)}" title="${h.esc(name)}">
        <span class="th-ph">${h.esc(extLabel)}</span>
      </div>
      <div style="flex:1 1 160px;min-width:0;align-self:center">
        <div style="display:flex;align-items:center;min-width:0;font-size:13px;font-weight:600">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto" title="${h.esc(name)}">${h.esc(name)}</span>
          ${tag ? `<span class="chip" style="margin-left:6px;flex:0 0 auto">${h.esc(tag)}</span>` : ''}
          <span style="flex:0 0 auto">${chip}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:6px;font-size:11.5px;color:var(--txt-3);flex-wrap:wrap">
          <span style="display:inline-flex;flex:0 0 auto">${h.platBadge(ses.platform, ses.platformName)}</span>
          <span style="flex:0 0 auto">${h.esc(ses.streamer || '未知主播')}</span>
          <span class="mono" style="flex:0 0 auto">${h.esc(h.fmtDateTime(ses.startedAt))}</span>
          <span style="flex:0 0 auto">${h.esc(`时长 ${dur}`)}</span>
          <span data-file-size="${h.esc(fps.id)}" style="flex:0 0 auto">${h.esc(h.fmtBytes(fps.bytes || 0))}</span>
        </div>
      </div>
      <div class="acts">
        <button class="btn sm ghost" data-file-act="play" data-id="${h.esc(fps.id)}"${missing ? ' disabled title="文件缺失，无法播放"' : ' data-play'}>播放</button>
        <a class="btn sm ghost" style="text-decoration:none" href="#" download>下载</a>
        <button class="btn sm danger" data-file-act="delete" data-id="${h.esc(fps.id)}"${playing || missing ? ` disabled title="${playing ? '录制中的分段不可删除' : '文件缺失'}"` : ' data-confirm'}>删除</button>
      </div>
    </div>`;
}

/* ---------- 分页：production ui.js pagerHTML()（文案见 common.pagerInfo：第 N/M 页 · 共 K 条） ---------- */
function pagerHtml(id, page, pages, total) {
  return `<div class="pager" id="${id}">
      <button class="btn sm ghost" data-pg="first"${page <= 1 ? ' disabled' : ''}>«</button>
      <button class="btn sm ghost" data-pg="prev"${page <= 1 ? ' disabled' : ''}>‹ 上一页</button>
      <span class="pager-info">第 ${page}/${pages} 页 · 共 ${total} 条</span>
      <button class="btn sm ghost" data-pg="next"${page >= pages ? ' disabled' : ''}>下一页 ›</button>
      <button class="btn sm ghost" data-pg="last"${page >= pages ? ' disabled' : ''}>»</button>
    </div>`;
}
