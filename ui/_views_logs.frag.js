/* LiveGrab · ui/_views_logs.frag.js —— 运行日志（原型片段，纯 HTML 字符串，不绑定事件）
   ------------------------------------------------------------------------------------------
   对齐 production：app/web/views/logs.js（整篇 424 行）
     · card > toolbar（13px 16px 内边距，wrap）：
         左 .log-filters  级别 #lgLevel（全部级别/INFO/WARN/ERROR/DEBUG）
                          任务 #lgTask（全部任务 + 出现过的任务名）
                          平台 #lgPlat（全部平台 + 7 个平台，按中文名过滤）
                          关键字 #lgQ（placeholder「关键字过滤…」）
         右 .log-actions  排序切换 #lgOrder（最新在前）/ 实时追加 chip（.chip.on 实时追加中）/
                          清除日志（danger）/ 复制 / 导出
     · hintline #lgHint = t('logs.hint', 保留天数, 默认级别, 每页条数) + t('logs.filesNote')（现有日志文件 N 个 / X）
       —— logs.js hintHtml()：files 由 api.logs 返回，原型以「日志按天命名」的日期集合当日志文件
     · #lgTable 表格：时间（mono, txt-3）/ 级别 .lv / 任务 / 消息 .logline；空态 emptyBox(t('logs.empty'))
     · 分页 = logs.js 的 pagerHtml()：« / ‹ 上一页 / 第 N / M 页 · 共 K 条 / 下一页 › / » / 跳至 [ ] 跳转
     · 底部 #lgCount = t('logs.count', 总数, 本页条数, 排序文案, 当前页, 总页数)
   · 文案 1:1 取自 app/web/i18n/zh-CN.json 的 logs.* / common.*；table/thead/td[data-label] 让骨架的移动端卡片化生效。
   · 骨架差异：production .lv 只有 INFO/WARN/ERROR，DEBUG 在 app.css 里无配色 —— 本片段用 inline style 补紫色徽标。
   ------------------------------------------------------------------------------------------ */

const PAGE_SIZE = 50; // logs.js：PAGE_SIZE
const RETENTION_FALLBACK = 14; // logs.js：state.limits 默认值
const LEVEL_FALLBACK = 'INFO';

/* logs.js row()：级别大写，未知级别按 INFO 显示 */
const LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
const LV_STYLE = {
  /* .lv.INFO/.WARN/.ERROR 来自骨架 CSS；DEBUG 补 production 同色系（#a97bff → #d9c6ff） */
  DEBUG: 'background:rgba(169,123,255,.14);color:#d9c6ff',
};

/* logs.js paint() 的平台下拉：按中文名做消息子串过滤 */
const PLATFORM_FILTERS = [
  ['douyin', '抖音'], ['bilibili', '哔哩哔哩'], ['kuaishou', '快手'], ['huya', '虎牙'],
  ['douyu', '斗鱼'], ['xiaohongshu', '小红书'], ['weibo', '微博'],
];

export function renderLogs(ctx, D, h) {
  const limits = (D && D.logLimits) || {};
  const retDays = Number(limits.logRetentionDays) || RETENTION_FALLBACK;
  const retLevel = limits.logLevel || LEVEL_FALLBACK;

  /* 倒序（最新在前）—— 对应 api.logs order:'desc' */
  const rows = ((D && D.logs) || []).slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
  const page = 1;
  const pageRows = rows.slice(0, PAGE_SIZE);

  /* 任务下拉：接口 r.tasks（出现过的任务集合，按日志顺序去重） */
  const taskNames = [];
  rows.forEach((l) => { const n = l && l.taskName; if (n && !taskNames.includes(n)) taskNames.push(n); });

  /* 日志文件集合：按天写入 → 日志里出现的自然日 = 现有日志文件 */
  const dayKeys = [];
  rows.forEach((l) => {
    const ts = Number(l && l.ts) || 0;
    if (!ts) return;
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!dayKeys.includes(key)) dayKeys.push(key);
  });
  /* 原型不具备文件系统视角：单文件大小按「50 MB 上限内的示意值」估算，仅用于 hint 里的「/ X」占位 */
  const fileBytes = dayKeys.length * 2.4 * 1024 * 1024;

  const table = pageRows.length
    ? `<table>
        <thead><tr>
          <th style="width:160px">时间</th><th style="width:80px">级别</th><th style="width:170px">任务</th><th>消息</th>
        </tr></thead>
        <tbody id="lgBody">${pageRows.map((l) => logRow(l, h)).join('')}</tbody>
      </table>`
    : h.emptyBox(total ? '没有符合过滤条件的日志' : '暂无日志');

  const orderLabel = '最新在前';

  return `
  <div class="card">
    <div class="toolbar">
      <div class="log-filters">
        <select class="select" id="lgLevel" style="width:130px" title="按级别过滤">
          <option value="">全部级别</option>
          ${LEVELS.map((v) => `<option value="${v}">${v}</option>`).join('')}
        </select>
        <select class="select" id="lgTask" style="width:190px" title="按任务过滤">
          <option value="">全部任务</option>
          ${taskNames.map((n) => `<option value="${h.esc(n)}">${h.esc(n)}</option>`).join('')}
        </select>
        <select class="select" id="lgPlat" style="width:140px" title="按平台过滤">
          <option value="">全部平台</option>
          ${PLATFORM_FILTERS.map(([v, n]) => `<option value="${h.esc(n)}">${h.esc(n)}</option>`).join('')}
        </select>
        <input class="input" id="lgQ" style="width:200px" placeholder="关键字过滤…" value="" />
      </div>
      <div class="spacer"></div>
      <div class="log-actions">
        <button class="btn sm ghost" id="lgOrder" title="切换日志排序">${orderLabel}</button>
        <span class="chip on" id="lgLive" style="cursor:pointer" title="点击暂停/恢复实时追加"><i class="dot"></i>实时追加中</span>
        <button class="btn sm danger" id="lgClear" data-confirm>清除日志</button>
        <button class="btn sm ghost" id="lgCopy">复制</button>
        <button class="btn sm ghost" id="lgExport">导出</button>
      </div>
    </div>

    <div class="hintline" style="margin:0 16px 12px" id="lgHint">日志按天写入容器内 <span class="mono">/config/logs/YYYY-MM-DD.log</span>，保留 <b>${h.esc(String(retDays))} 天</b>，单文件超 <b>50 MB</b> 自动切分；默认级别 <b>${h.esc(retLevel)}</b>（可切 WARN / ERROR / DEBUG）。分页浏览历史日志（每页 ${PAGE_SIZE} 条），DEBUG 会包含 ffmpeg 全量 stderr、增长很快，排查完建议切回 INFO。${dayKeys.length ? `现有日志文件 ${dayKeys.length} 个 / ${h.esc(h.fmtBytes(fileBytes))}。` : ''}</div>

    <div class="card-b" style="padding:0" id="lgTable">${table}</div>

    ${pagerHtml(page, pages, total)}

    <div class="hintline" style="margin:10px 16px 14px" id="lgCount">${countText(total, pageRows.length, orderLabel, page, pages)}</div>
  </div>`;
}

/* ---------- 单行：对齐 logs.js row() ---------- */
function logRow(l, h) {
  const level = String((l && l.level) || 'INFO').toUpperCase();
  const extra = LV_STYLE[level] ? ` style="${LV_STYLE[level]}"` : '';
  const taskName = (l && l.taskName) || '—';
  return `<tr>
    <td class="mono" style="color:var(--txt-3);white-space:nowrap" data-label="时间">${h.esc(h.fmtLogTime(l && l.ts))}</td>
    <td data-label="级别"><span class="lv ${h.esc(level)}"${extra}>${h.esc(level)}</span></td>
    <td data-label="任务" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px" title="${h.esc(taskName)}">${h.esc(taskName)}</td>
    <td class="logline" data-label="消息">${h.esc((l && l.msg) || '')}</td>
  </tr>`;
}

/* ---------- 分页：logs.js pagerHtml()（页大小与 PagerInfo 均按 logs.* 文案） ---------- */
function pagerHtml(page, pages, total) {
  return `<div class="pager" id="lgPager">
      <button class="btn sm ghost" id="lgFirst"${page <= 1 ? ' disabled' : ''} title="第一页">«</button>
      <button class="btn sm ghost" id="lgPrev"${page <= 1 ? ' disabled' : ''}>‹ 上一页</button>
      <span class="pager-info">第 ${page} / ${pages} 页 · 共 ${total} 条</span>
      <button class="btn sm ghost" id="lgNext"${page >= pages ? ' disabled' : ''}>下一页 ›</button>
      <button class="btn sm ghost" id="lgLast"${page >= pages ? ' disabled' : ''} title="最后一页">»</button>
      <span class="pager-go">跳至 <input class="input" id="lgPageGo" type="number" min="1" max="${pages}" value="${page}" style="width:56px;padding:4px 6px" /> <button class="btn sm ghost" id="lgGo">跳转</button></span>
    </div>`;
}

/* ---------- 计数行：logs.js syncCount() 的 t('logs.count', …) ---------- */
function countText(total, shown, orderLabel, page, pages) {
  return `共 ${total} 条 · 第 ${page} / ${pages} 页 · 本页 ${shown} 条 · ${orderLabel}`;
}
