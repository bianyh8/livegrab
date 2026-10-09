// 命名规则引擎（纯函数，无副作用）
import { byteLength, formatDate, formatTime, DATE_FORMAT_KEYS, TIME_FORMAT_KEYS } from './util.js';

export const QUALITY_LABELS = {
  origin: '原画', bluray: '蓝光', uhd: '超清', hd: '高清', sd: '标清', audio: '仅音频',
};
export const QUALITY_IDS = Object.keys(QUALITY_LABELS);
export const qualityLabel = (q) => QUALITY_LABELS[q] || String(q || '');

// 跨平台并集：Linux 只禁 / 与 NUL，但宿主可能是 Windows/macOS，bind mount 后这些名字会落盘失败
const ILLEGAL_RE = /[\\/:*?"<>|\u0000-\u001f]/g;
export const MAX_COMPONENT_BYTES = 255;
const RESERVED_BYTES = 16; // 给扩展名/序号留余量

export const VARIABLES = [
  { token: '{主播}', desc: '主播昵称', example: '某某小主播' },
  { token: '{平台}', desc: '平台名称', example: '抖音 / 哔哩哔哩' },
  { token: '{房间号}', desc: '直播间房间号', example: '23456789' },
  { token: '{标题}', desc: '当次直播标题', example: '今天打排位 冲王者' },
  { token: '{日期}', desc: '录制开始日期（格式见下）', example: '2025-06-01' },
  { token: '{时间}', desc: '录制开始时间', example: '20-13-05' },
  { token: '{清晰度}', desc: '实际使用的清晰度', example: '原画 / 蓝光 / 仅音频' },
  { token: '{序号}', desc: '分段序号，按位数补零', example: '001' },
  { token: '{任务}', desc: '任务 ID', example: 'task_07' },
  { token: '{分辨率}', desc: '实际分辨率', example: '1920x1080' },
  { token: '{时长}', desc: '分段时长（录制完成后才可知，仅合并命名用）', example: '01-00-00' },
  { token: '{自定义}', desc: '任务级自定义文本，可在任务中单独覆盖', example: '—' },
];

export const DEFAULT_OPTIONS = {
  dateFormat: 'YYYY-MM-DD',
  seqDigits: 3,
  timeFormat: 'HH-mm-ss',
  illegal: 'replace', // replace | drop | keep
  dupStrategy: 'suffix', // suffix | timestamp | overwrite
  maxNameChars: 120,
};

export const SEQ_PLACEHOLDER = '@@SEQ@@';

export const DEFAULT_NAMING = {
  activeId: 'p_default',
  profiles: [
    {
      id: 'p_douyin', name: '抖音风格',
      fnTemplate: '{日期}_{主播}_{清晰度}_{序号}',
      dirTemplate: '{平台}/{主播}/{日期}',
      options: { ...DEFAULT_OPTIONS },
      binding: { type: 'platform', value: 'douyin' },
    },
    {
      id: 'p_bilibili', name: 'B站风格',
      fnTemplate: '{平台}_{主播}_{日期}_{标题}',
      dirTemplate: '{平台}/{日期}/{主播}',
      options: { ...DEFAULT_OPTIONS },
      binding: { type: 'platform', value: 'bilibili' },
    },
    {
      id: 'p_default', name: '通用（默认）',
      fnTemplate: '{日期}_{主播}_{序号}',
      dirTemplate: '{平台}/{主播}/{日期}',
      options: { ...DEFAULT_OPTIONS },
      binding: { type: 'none', value: '' },
    },
  ],
};

export const NAMING_OPTION_CHOICES = {
  dateFormat: DATE_FORMAT_KEYS,
  timeFormat: TIME_FORMAT_KEYS,
  seqDigits: [2, 3, 4],
  illegal: ['replace', 'drop', 'keep'],
  dupStrategy: ['suffix', 'timestamp', 'overwrite'],
};

export function pickProfile(naming, { profileId, platform, taskId } = {}) {
  const n = naming || DEFAULT_NAMING;
  const list = Array.isArray(n.profiles) && n.profiles.length ? n.profiles : DEFAULT_NAMING.profiles;
  const byId = (id) => list.find((p) => p.id === id);
  if (profileId && byId(profileId)) return byId(profileId);
  if (taskId) {
    const t = list.find((p) => p.binding?.type === 'task' && p.binding.value === taskId);
    if (t) return t;
  }
  if (platform) {
    const p = list.find((x) => x.binding?.type === 'platform' && x.binding.value === platform);
    if (p) return p;
  }
  return byId(n.activeId) || list.find((p) => p.binding?.type === 'none') || list[0];
}

/**
 * 统一取"单个命名配置"：允许传 profile、命名配置集合（含 profiles）、或裸模板对象。
 * 之前 buildOutputPattern / planSegmentNames / buildMergedName 用 `naming || 默认`，
 * 直接把集合当 profile 用，导致 fnTemplate 为 undefined、名字退化成 unnamed。
 */
export function resolveProfile(naming, profile, pick = {}) {
  if (profile && (profile.fnTemplate || profile.options || profile.id)) return profile;
  if (naming && Array.isArray(naming.profiles) && naming.profiles.length) return pickProfile(naming, pick);
  if (naming && (naming.fnTemplate || naming.dirTemplate)) return naming;
  return DEFAULT_NAMING.profiles[0];
}

export function seqText(index, digits = 3) {
  return String(index).padStart(Number(digits) || 3, '0');}

export function buildContext({
  task, room, anchorName, title, platform, platformName, roomId,
  index = 1, startAt = new Date(), quality = 'origin', resolution = '', durationSec = 0, customText = '',
} = {}) {
  const t = task || {};
  const start = startAt instanceof Date ? startAt : new Date(startAt || Date.now());
  const opts = DEFAULT_OPTIONS;
  const q = quality || t.quality || 'origin';
  const vars = {
    '{主播}': anchorName ?? room?.anchorName ?? t.anchorName ?? '未知主播',
    '{平台}': platformName ?? room?.platformName ?? t.platformName ?? String(platform ?? t.platform ?? ''),
    '{房间号}': String(roomId ?? room?.roomId ?? t.roomId ?? ''),
    '{标题}': title ?? room?.title ?? t.title ?? '',
    '{日期}': formatDate(start, opts.dateFormat),
    '{时间}': formatTime(start, opts.timeFormat),
    '{清晰度}': qualityLabel(q),
    '{序号}': seqText(index, opts.seqDigits),
    '{任务}': String(t.id ?? ''),
    '{分辨率}': resolution || t.resolution || '',
    '{时长}': durationSec ? secToClock(durationSec) : '',
    '{自定义}': customText || t.customText || '',
  };
  return { vars, startAt: start, options: { ...opts }, quality: q };
}

export function secToClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${h}-${m}-${String(s % 60).padStart(2, '0')}`;
}

/** 用 ctx.options 重新渲染日期/时间/序号（预览与保存都走同一套） */
function refill(text, ctx, index) {
  const o = { ...DEFAULT_OPTIONS, ...(ctx.options || {}) };
  return String(text)
    .replace(/\{日期\}/g, formatDate(ctx.startAt instanceof Date ? ctx.startAt : new Date(ctx.startAt || Date.now()), o.dateFormat))
    .replace(/\{时间\}/g, formatTime(ctx.startAt instanceof Date ? ctx.startAt : new Date(ctx.startAt || Date.now()), o.timeFormat))
    .replace(/\{序号\}/g, seqText(index, o.seqDigits));
}

export function renderTemplate(tpl, ctx, index = 1) {
  const unknown = [];
  const vars = { ...(ctx?.vars || {}) };
  const text = String(tpl ?? '').replace(/\{[^{}]*\}/g, (m) => {
    if (Object.prototype.hasOwnProperty.call(vars, m)) return vars[m];
    if (m === '{日期}' || m === '{时间}' || m === '{序号}') return m; // 交给 refill
    unknown.push(m);
    return m;
  });
  return { text: refill(text, ctx, index), unknown: [...new Set(unknown)] };
}

export function sanitizeComponent(text, mode = 'replace') {
  let s = String(text ?? '');
  if (mode === 'keep') {
    // 保留模式也至少要挡住路径分隔符与控制字符（安全底线）
    s = s.replace(/[/\\\u0000-\u001f]/g, '_');
  } else if (mode === 'drop') {
    s = s.replace(ILLEGAL_RE, '');
  } else {
    s = s.replace(ILLEGAL_RE, '_');
  }
  return s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
}

function cutTo(text, maxChars, maxBytes) {
  let out = String(text);
  while (out.length > maxChars || byteLength(out) > maxBytes) {
    if (!out.length) break;
    out = out.slice(0, -1);
  }
  return out;
}

/** 截断但保留结尾的 _序号，避免把分段序号切掉 */
export function truncateKeepSeq(text, maxChars = 120) {
  const m = /_(\d+)$/.exec(text);
  const tail = m ? m[0] : '';
  const head = m ? text.slice(0, -tail.length) : text;
  const budgetChars = Math.max(8, maxChars - tail.length);
  const budgetBytes = Math.max(8, MAX_COMPONENT_BYTES - RESERVED_BYTES - byteLength(tail));
  return cutTo(head, budgetChars, budgetBytes) + tail;
}

/** 文件名（不含扩展名）→ 清洗/截断后的成品名 */
export function renderName(tpl, ctx, index, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...(ctx?.options || {}), ...options };
  const { text, unknown } = renderTemplate(tpl, ctx, index);
  const cleaned = sanitizeComponent(text, o.illegal);
  const final_ = truncateKeepSeq(cleaned || 'unnamed', Number(o.maxNameChars) || 120);
  return { name: final_ || 'unnamed', unknown, overlong: cleaned.length !== final_.length };
}

export function expandDir(tpl, ctx, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...(ctx?.options || {}), ...options };
  const { text, unknown } = renderTemplate(tpl, ctx, 1);
  const comps = String(text).split(/[\\/]+/).map((c) => sanitizeComponent(c, o.illegal))
    .filter((c) => c && c !== '.' && c !== '..')
    .map((c) => cutTo(c, 120, MAX_COMPONENT_BYTES - RESERVED_BYTES));
  return { dir: comps.join('/'), unknown };
}

/**
 * ffmpeg 输出模板：把 {序号} 换成 printf 形式 %0Nd（没有 {序号} 就自动追加 _%0Nd）
 * 返回 { pattern（含 %0Nd 的文件名）、dir、baseName、seqInName、unknown }
 */
export function buildOutputPattern({ naming, ctx, ext = 'ts', profile } = {}) {
  const p = resolveProfile(naming, profile, { platform: ctx?.platform, taskId: ctx?.taskId, profileId: ctx?.profileId });
  const o = { ...DEFAULT_OPTIONS, ...(p.options || {}) };
  const digits = Number(o.seqDigits) || 3;
  const printf = `%0${digits}d`;
  const tpl = String(p.fnTemplate || '{日期}_{主播}_{序号}');

  const hasSeq = tpl.includes('{序号}');
  const staged = tpl.replace(/\{序号\}/g, SEQ_PLACEHOLDER);
  const { text, unknown } = renderTemplate(staged, ctx, 1);
  let name = sanitizeComponent(text, o.illegal);
  if (hasSeq) {
    name = name.replace(new RegExp(SEQ_PLACEHOLDER, 'g'), printf);
  } else {
    name = `${truncateKeepSeq(name, (Number(o.maxNameChars) || 120) - digits - 1)}_${printf}`;
  }
  // 截断保护（%0Nd 占位符本身要留着，所以按 base 名裁）
  if (byteLength(name.replace(printf, seqText(1, digits))) > MAX_COMPONENT_BYTES - RESERVED_BYTES) {
    const parts = name.split(printf);
    parts[0] = cutTo(parts[0], Math.max(8, (Number(o.maxNameChars) || 120) - digits - 1),
      MAX_COMPONENT_BYTES - RESERVED_BYTES - digits - 8);
    name = parts.join(printf);
  }
  return {
    pattern: `${name}.${ext}`,
    dir: expandDir(p.dirTemplate, ctx, o).dir,
    baseName: name,
    seqInName: hasSeq,
    unknown,
  };
}

/** 用于"合并整场"命名：不含序号 */
export function buildMergedName({ naming, ctx, ext = 'mp4', profile, suffix = '' } = {}) {
  const p = resolveProfile(naming, profile, { platform: ctx?.platform, taskId: ctx?.taskId, profileId: ctx?.profileId });
  const o = { ...DEFAULT_OPTIONS, ...(p.options || {}) };
  const tpl = String(p.fnTemplate || '{日期}_{主播}_{序号}').replace(/\{序号\}/g, '').replace(/[_\-\.]+$/, '');
  const { text } = renderTemplate(tpl, ctx, 1);
  let name = sanitizeComponent(text + (suffix || '') + '_整场', o.illegal);
  name = truncateKeepSeq(name, Number(o.maxNameChars) || 120);
  return { name: `${name || 'merged'}.${ext}` };
}

export function planSegmentNames({ naming, ctx, count = 3, ext = 'ts', profile } = {}) {
  const p = resolveProfile(naming, profile, { platform: ctx?.platform, taskId: ctx?.taskId, profileId: ctx?.profileId });
  const out = [];
  // 与 buildOutputPattern 保持一致：模板没有 {序号} 时，实际落盘会自动补 _序号，预览也要体现
  const base = String(p.fnTemplate || '{日期}_{主播}_{序号}');
  const tpl = base.includes('{序号}') ? base : `${base.replace(/[_\-.\s]+$/, '')}_{序号}`;
  const { dir } = expandDir(p.dirTemplate, ctx, p.options || {});
  for (let i = 1; i <= count; i++) {
    const { name } = renderName(tpl, ctx, i, p.options || {});
    out.push({ index: i, dir, file: `${name}.${ext}`, relPath: `${dir}/${name}.${ext}` });
  }
  return out;
}

/** 重名去重：suffix → _2/_3；timestamp → _YYYYMMDDHHmmss；overwrite → 原样 */
export function reserveName(fullPath, exists, strategy = 'suffix') {
  if (strategy === 'overwrite' || !exists(fullPath)) return fullPath;
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(fullPath);
  const stem = m[1];
  const ext = m[2] || '';
  if (strategy === 'timestamp') {
    const t = new Date();
    const stamp = `${formatDate(t, 'YYYYMMDD')}${formatTime(t, 'HHmmss').replace(/-/g, '')}`;
    return `${stem}_${stamp}${ext}`;
  }
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}_${i}${ext}`;
    if (!exists(cand)) return cand;
  }
  return `${stem}_${Date.now()}${ext}`;
}

export function previewNaming({ fnTemplate, dirTemplate, options = {}, samples = 3 } = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const startAt = new Date(2025, 5, 1, 20, 13, 5); // 固定示例时间，保证预览稳定
  const ctx = {
    startAt,
    options: o,
    vars: {
      '{主播}': '某某小主播', '{平台}': '抖音', '{房间号}': '23456789', '{标题}': '今天打排位 冲王者',
      '{清晰度}': '原画', '{任务}': 'task_07', '{分辨率}': '1920x1080',
      '{时长}': '01-00-00', '{自定义}': '自定义',
    },
  };
  const warnings = [];
  const dirRes = expandDir(dirTemplate, ctx, o);
  const lines = [];
  for (let i = 1; i <= Math.max(1, Math.min(10, Number(samples) || 3)); i++) {
    const { name, unknown, overlong } = renderName(fnTemplate, ctx, i, o);
    const file = `${name}.ts`;
    const rel = dirRes.dir ? `${dirRes.dir}/${file}` : file;
    const fullPath = `/data/${rel}`;
    lines.push({
      index: i, dir: dirRes.dir, file, relPath: rel, fullPath,
      chars: fullPath.length, bytes: byteLength(fullPath), fileNameBytes: byteLength(file),
    });
    if (unknown.length) warnings.push(`未知变量：${unknown.join(' ')}（会原样保留）`);
    if (overlong) warnings.push(`名称超过 ${o.maxNameChars} 字符，已截断（保留结尾序号）`);
    if (byteLength(file) > MAX_COMPONENT_BYTES - RESERVED_BYTES) warnings.push('单层文件名接近 255 字节上限，宿主为 Windows/macOS 时可能落盘失败');
  }
  if (!dirRes.dir) warnings.push('目录模板为空：所有文件平铺到存储根目录');
  return { lines, warnings: [...new Set(warnings)] };
}
