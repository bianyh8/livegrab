// 文件库行的确定性排序（/api/files 分页前调用）
//
// 规则（用户确认）：① 按 startedAt 倒序（最新录制在前，字段值，不依赖命名规则；
// 正常场次=录制开始时间，独立场次由 scan 校准/磁盘时间兜底）；
// ② 同一时间聚合按 relDir（主播/场次目录）连在一起；
// ③ 目录内分段按 segmentIndex 升序在前、派生 mp4/m4a 居中、合并最后；
// ④ 文件名仅做最后兜底（保证任意数据都有确定全序）。
//
// 注意：不能按 session.id 排——扫描注册的独立场次（taskId=null）每段一个 session、
// id 随机，按 id 排会出现 002,004,001,003 这种「随机」顺序；也不要从文件名解析
// 时间戳当主键——命名模板可配置，模板一变解析就失效（用户明确提醒）。

const tsOf = (v) => {
  const t = new Date(v || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** 行内文件类型排名：分段 0 < 派生 1 < 合并 2（派生含 mp4/m4a，合并最后） */
function kindRank(row) {
  const f = row && row.f;
  if (f && f.kind === 'segment') return 0;
  if (row && row.tag === '合并') return 2;
  return 1;
}

/** 文件行 { f, s, tag } 的稳定比较器 */
export function compareFileRow(a, b) {
  const A = a || {};
  const B = b || {};
  const sa = A.s || {};
  const sb = B.s || {};
  const fa = A.f || {};
  const fb = B.f || {};

  // 1) 录制开始时间倒序（最新在前；字段值，命名模板无关）
  const byTime = tsOf(sb.startedAt) - tsOf(sa.startedAt);
  if (byTime) return byTime;

  // 2) 同目录聚拢（同主播同时间的多段连在一起；跨目录按目录名，避免随机 session id 打乱）
  const byDir = String(sa.relDir || '').localeCompare(String(sb.relDir || ''));
  if (byDir) return byDir;

  // 3) 分段在前、派生居中、合并最后（先分桶，避免派生文件按 segmentIndex 插进分段中间）
  const byKind = kindRank(A) - kindRank(B);
  if (byKind) return byKind;

  // 4) 桶内按分段序号升序（字段值；独立场次恒 0 时落到下一步）
  const byIndex = (Number(fa.segmentIndex) || 0) - (Number(fb.segmentIndex) || 0);
  if (byIndex) return byIndex;

  // 5) 兜底：文件名（自然序，001<002<…；仅保证全序，不承担主排序职责）
  return String(fa.name || fa.relPath || '').localeCompare(String(fb.name || fb.relPath || ''));
}

/** 就地排序并返回（便于 `const rows = sortFileRows(rows)` 链式使用） */
export function sortFileRows(rows) {
  if (Array.isArray(rows)) rows.sort(compareFileRow);
  return rows;
}
