// 文件库行的确定性排序（/api/files 分页前调用）
//
// 规则（用户确认）：① 按 startedAt 倒序（最新录制在前）；
// ② 同一场次的分段/产物聚在一起（同目录）；③ 场次内按段号升序（001→002→003→004…）；
// ④ 同一分段的源文件排在转封装产物之前、合并文件最后；⑤ 文件名仅做最后兜底（保证全序）。
//
// 线上实锤的三个坑（2026-10 用户 NAS 库数据）：
//  · **场次分桶必须秒级对齐**：同一场次的行可能由不同路径登记（录制场次 vs 扫描/转封装收编），
//    startedAt 相差几百毫秒（.000 与 .073），按毫秒比较会把同一场次劈成两块 →
//    段号顺序变成 002,004,001,003（用户报的「乱」正是这个）。
//  · **段号不能只看字段值**：扫描登记的独立场次 segmentIndex 恒 0，转封装产物却带真实段号，
//    两者混在同一场次里按字段值排必错 → 段号为 0 时用文件名尾部序号兜底。
//  · 不能按 session.id 排（独立场次 id 随机 → 002,004,001,003）；也不要从文件名解析
//    「场次时间」当主排序键——命名模板可配置，模板一变解析就失效（用户明确提醒）。
//    文件名只负责「同一场次内部定序」：序号位置固定，不随模板字段顺序变化。

const tsOf = (v) => {
  const t = new Date(v || 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** 场次分桶时间（秒级）：同一场次的毫秒级差异不应把它拆成两个桶 */
const bucketOf = (v) => Math.floor(tsOf(v) / 1000);

/** 段序键：字段值优先（>0）；缺失（独立场次/扫描登记的分段恒 0）时用文件名尾部序号兜底；
 *  两者都没有（派生/合并等无段号产物）→ 排到同场次末尾。 */
export function segmentKeyOf(file) {
  const idx = Number(file && file.segmentIndex) || 0;
  if (idx > 0) return idx;
  const m = /(\d+)(?=\.[^.]+$)/.exec(String((file && file.name) || ''));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

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

  // 1) 场次开始时间倒序（最新在前；秒级分桶，同一场次的毫秒差不再把场次劈开）
  const byTime = bucketOf(sb.startedAt) - bucketOf(sa.startedAt);
  if (byTime) return byTime;

  // 2) 同目录聚拢（同主播同场次的多段连在一起；跨目录按目录名，避免随机 session id 打乱）
  const byDir = String(sa.relDir || '').localeCompare(String(sb.relDir || ''));
  if (byDir) return byDir;

  // 3) 场次内按段号升序（001→002→003→004）：字段值优先，段号缺失时用文件名尾部序号兜底
  const bySeg = segmentKeyOf(fa) - segmentKeyOf(fb);
  if (bySeg) return bySeg;

  // 4) 同一段号/序号的行：源分段在前、派生居中、合并最后
  const byKind = kindRank(A) - kindRank(B);
  if (byKind) return byKind;

  // 5) 兜底：文件名（自然序，001<002<…；仅保证全序，不承担主排序职责）
  return String(fa.name || fa.relPath || '')
    .localeCompare(String(fb.name || fb.relPath || ''), undefined, { numeric: true });
}

/** 就地排序并返回（便于 `const rows = sortFileRows(rows)` 链式使用） */
export function sortFileRows(rows) {
  if (Array.isArray(rows)) rows.sort(compareFileRow);
  return rows;
}
