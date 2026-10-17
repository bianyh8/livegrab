// 文件库行的确定性排序（/api/files 分页前调用）
//
// 背景（用户反馈「文件排序很混乱」）：/api/files 原先把 store.sessions 逐场次铺平后
// 不做任何排序，直接分页切片。而 store.sessions 的顺序本身不稳定——运行期 addSession 用
// unshift 把新场次插到最前（新→旧），重启后却是 SELECT * 的库内顺序（旧→新/任意）。
// 于是「刷新/重启/翻页」时整张表的顺序会跳，同一场次的分段是否连在一起也全凭运气。
//
// 这里给出一条稳定、可解释的默认顺序：
//   1) 按录制开始时间倒序（最新的在最前）；
//   2) 同一场次（session.id）的文件聚合在一起，且相对次序稳定；
//   3) 同一场次内：分段按 segmentIndex 升序在前，派生文件（mp4/合并/m4a）排在分段之后；
//   4) 兜底按文件名，保证任意初始顺序都得到唯一确定的结果。

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

  // 1) 最新录制在前
  const byTime = tsOf(sb.startedAt) - tsOf(sa.startedAt);
  if (byTime) return byTime;

  // 2) 同一场次聚拢（id 唯一，保证同场次行相邻且顺序确定）
  const bySession = String(sa.id || '').localeCompare(String(sb.id || ''));
  if (bySession) return bySession;

  // 3) 分段在前、派生居中、合并最后
  const byKind = kindRank(A) - kindRank(B);
  if (byKind) return byKind;

  // 4) 分段按序号升序
  const byIndex = (Number(fa.segmentIndex) || 0) - (Number(fb.segmentIndex) || 0);
  if (byIndex) return byIndex;

  // 5) 兜底：文件名
  return String(fa.name || fa.relPath || '').localeCompare(String(fb.name || fb.relPath || ''));
}

/** 就地排序并返回（便于 `const rows = sortFileRows(rows)` 链式使用） */
export function sortFileRows(rows) {
  if (Array.isArray(rows)) rows.sort(compareFileRow);
  return rows;
}
