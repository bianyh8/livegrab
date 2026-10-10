/* LiveGrab · i18n.js —— 界面文案外置
   字典单一来源为 app/web/i18n/zh-CN.json（后端 GET /api/i18n 读取，可外部编辑/换语言）。
   TODO_NOTE：为避免首帧异步闪 key，此处内置一份 DEFAULT_DICT 做首帧同步兜底，
   与 zh-CN.json 内容保持一致；loadI18n() 再用后端 JSON 覆盖（后端为权威，可不暂停改稿）。
   t(key, ...args) 查字典返回文案，缺键回退 key 本身；{0}{1} 为参数占位。 */

// 与 app/web/i18n/zh-CN.json 保持一致（改任一处须同步此处）
const DEFAULT_DICT = {
  'dashboard.loading': '正在加载总览…',
  'dashboard.loadFailed': '无法读取总览数据（后端 /api/status 尚未返回）。稍后会自动重试。',
  'dashboard.taskStats': '任务统计',
  'dashboard.todayStats': '今日统计',
  'dashboard.storeStats': '存储统计',
  'dashboard.statRecording': '正在录制',
  'dashboard.statLive': '正在直播',
  'dashboard.statMonitor': '仅监控',
  'dashboard.statQueued': '排队中',
  'dashboard.statWaiting': '等待开播',
  'dashboard.statConcur': '并发使用率',
  'dashboard.todayDuration': '今日录制时长',
  'dashboard.todayFiles': '今日新增文件',
  'dashboard.todayBytes': '今日已录大小',
  'dashboard.bandwidth': '实时带宽',
  'dashboard.avgRate': '录制码率均值',
  'dashboard.totalDuration': '累计录制时长',
  'dashboard.noRecording': '当前没有正在录制的任务',
  'dashboard.recording': '正在录制',
  'dashboard.recordingHint': '{0} 路 · 分段写入中',
  'dashboard.pauseAll': '全部暂停',
  'dashboard.stopRecord': '停止录制',
  'dashboard.detail': '详情',
  'dashboard.checkLive': '立即检测',
  'dashboard.unitRoad': '路',
  'dashboard.unitItem': '个',
  'dashboard.unitPerRoad': ' / 路',
  'dashboard.hour': '小时',
  'dashboard.minute': '分',
  'dashboard.minutes': '分钟',
  'dashboard.diskRemain': '磁盘剩余',
  'dashboard.diskUsed': '已用',
  'dashboard.diskTotal': '共',
  'dashboard.diskTrash': '回收站',
  'dashboard.diskAlert': '⚠ 磁盘剩余 {0}，低于保留下限时会自动清理最旧的成品文件；录制中请及时清理空间。',
  'dashboard.platforms': '{0} 平台',
  'dashboard.noFile': '暂无录制文件',
};

let dict = DEFAULT_DICT;
const loaded = [];

export function t(key, ...args) {
  let s = dict[key];
  if (s == null) s = key;
  if (args && args.length) {
    args.forEach((v, i) => { s = s.replace(new RegExp('\\{' + i + '\\}', 'g'), String(v)); });
  }
  return s;
}

// 远程字典是否已就位（默认字典已是可用中文，仅作状态记录）
export function i18nLoaded() { return loaded.length > 0; }

// 拉取后端字典并覆盖（后端 JSON 为权威，可外部改稿）
export async function loadI18n() {
  try {
    const res = await fetch('/api/i18n', { credentials: 'same-origin' });
    if (!res.ok) return false;
    const payload = await res.json();
    // 后端 ok() 统一包成 { ok:true, data:... }，取 data 层为字典本体
    const obj = payload && typeof payload === 'object' ? (payload.data ?? payload) : null;
    if (obj && typeof obj === 'object') { dict = { ...DEFAULT_DICT, ...obj }; loaded.push(Date.now()); }
    return true;
  } catch { /* 网络失败：保留默认字典（已是中文），不阻塞 */ }
  return loaded.length > 0;
}