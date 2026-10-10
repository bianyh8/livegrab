/* LiveGrab · i18n.js —— 界面文案外置
   字典单一来源为 app/web/i18n/zh-CN.json（后端 GET /api/i18n 读取，可外部编辑/换语言）。
   TODO_NOTE：为避免首帧异步闪 key，此处内置一份 DEFAULT_DICT 做首帧同步兜底，
   与 zh-CN.json 内容保持一致；loadI18n() 再用后端 JSON 覆盖（后端为权威，可不暂停改稿）。
   t(key, ...args) 查字典返回文案，缺键回退 key 本身；{0}{1} 为参数占位。 */

// 与 app/web/i18n/zh-CN.json 保持一致（改任一处须同步此处）
const DEFAULT_DICT = {
  'common.detail': '详情',
  'common.stopRecord': '停止录制',
  'common.checkLive': '立即检测',
  'common.cancel': '取消',
  'common.ok': '确定',
  'common.confirm': '请确认',
  'common.save': '保存',
  'common.delete': '删除',
  'common.refresh': '刷新',
  'common.close': '关闭',
  'common.error': '错误',
  'common.unknown': '未知',
  'common.unknownError': '未知错误',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFail': '复制失败，请手动选择文本',
  'common.loading': '正在加载…',
  'common.search': '搜索',
  'common.all': '全部',
  'common.allPlatforms': '全部平台',
  'common.unitRoad': '路',
  'common.unitItem': '个',
  'common.hour': '小时',
  'common.minute': '分',
  'common.minutes': '分钟',
  'common.seconds': '秒',
  'common.justNow': '刚刚',
  'common.minAgo': '{0} 分钟前',
  'common.hrAgo': '{0} 小时前',
  'common.dayAgo': '{0} 天前',
  'common.recording': '录制中',
  'common.waiting': '等待开播',
  'common.queued': '排队中',
  'common.completed': '已完成',
  'common.stopped': '手动停止',
  'common.stopping': '停止中',
  'common.merging': '合并中',
  'common.idle': '待机',
  'common.engineOk': '引擎正常',
  'common.ffmpegUnavailable': 'ffmpeg 不可用',
  'common.errConn': '无法连接后端服务（{0}）',
  'common.errInvalid': '登录已失效，请重新登录',

  'plat.douyin': '抖音',
  'plat.bilibili': '哔哩哔哩',
  'plat.kuaishou': '快手',
  'plat.huya': '虎牙',
  'plat.douyu': '斗鱼',
  'plat.xiaohongshu': '小红书',
  'plat.weibo': '微博',
  'plat.acfun': 'AcFun',
  'plat.cc': '网易CC',
  'plat.wechat': '视频号',
  'plat.more': '更多平台',
  'plat.unknown': '未知平台',

  'tier.stable': '稳定',
  'tier.experimental': '实验性',
  'tier.planned': '规划中',

  'seg.none': '不分段',
  'seg.bySize': '按大小 · {0} GB',
  'seg.byTime': '按时间 · {0} 分钟',

  'nav.overview': '总览',
  'nav.tasks': '录制任务',
  'nav.files': '录制文件',
  'nav.events': '最近事件',
  'nav.settings': '系统设置',
  'nav.logs': '运行日志',
  'nav.trash': '回收站',
  'nav.overviewSub': '实时监控中的直播间与录制状态',
  'nav.tasksSub': '管理监控列表、清晰度与分段策略',
  'nav.filesSub': '浏览、回放、转封装与清理已录制文件',
  'nav.eventsSub': '引擎与任务的关键动作（最新在前）',
  'nav.settingsSub': '录制与存储、命名规则、平台账号、通知、安全与登录',
  'nav.logsSub': '引擎与每个任务的详细运行记录',
  'nav.trashSub': '已删除录制文件与刮削图片/描述，可还原或清空',

  'topbar.recording': '{0} 录制中',
  'topbar.refreshStatus': '已重新拉取所有直播间状态',
  'app.userMeta': '管理员 · 本次登录 {0}',

  'login.title': '登录管理台',
  'login.initTitle': '初始化管理员账号',
  'login.hint': '请输入管理员账号与密码以访问录制管理台',
  'login.initHint': '首次部署，请设置管理员账号与密码（密码至少 8 位）',
  'login.switchToLogin': '返回登录',
  'login.switchToInit': '初始化管理员账号',
  'login.btnLogin': '登 录',
  'login.btnCreate': '创建并登录',
  'login.loadingLogin': '正在登录…',
  'login.loadingCreate': '正在创建…',
  'login.showPwd': '显示',
  'login.hidePwd': '隐藏',
  'login.errUsername': '请输入用户名',
  'login.errPassword': '请输入密码',
  'login.errPassLen': '密码至少 8 位',
  'login.errPassMismatch': '两次输入的密码不一致',
  'login.errWrong': '用户名或密码错误',
  'login.errLocked': '失败次数过多，已临时锁定，请稍后再试',
  'login.errWeak': '密码强度不足（至少 8 位）',
  'login.errInit': '账号已初始化，请直接登录',
  'login.created': '管理员账号已创建，已自动登录',
  'login.greeting': '登录成功，欢迎回来',
  'login.loggedOut': '已退出登录',
  'login.forgot': '请联系部署管理员：删除容器内 /config/users.json 后重启即可重新初始化密码',

  'pageLoad.failed': '页面加载失败：{0}',
  'pageRender.failed': '页面渲染失败：{0}',

  'events.loading': '正在加载事件…',
  'events.loadFailed': '事件加载失败：{0}',
  'events.title': '最近事件',
  'events.hint': '引擎与任务的关键动作 · 最新在前 · 最多 {0} 条',
  'events.fullLog': '完整记录（含过滤、导出）请到左侧「运行日志」页查看。',
  'events.empty': '暂无事件',

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
  'dashboard.totalDuration': '累计录制时长',
  'dashboard.noRecording': '当前没有正在录制的任务',
  'dashboard.recording': '正在录制',
  'dashboard.recordingHint': '{0} 路 · 分段写入中',
  'dashboard.pauseAll': '全部暂停',
  'dashboard.diskRemain': '磁盘剩余',
  'dashboard.diskUsed': '已用',
  'dashboard.diskTotal': '共',
  'dashboard.diskTrash': '回收站',
  'dashboard.diskAlert': '⚠ 磁盘剩余 {0}，低于保留下限时会自动清理最旧的成品文件；录制中请及时清理空间。',
  'dashboard.platforms': '{0} 平台',
  'dashboard.noFile': '暂无录制文件',
  'dashboard.checkLiveTip': '立即检测该直播间是否已开播',
  'dashboard.unnamed': '未命名任务',
  'dashboard.room': '房间 {0}',
  'dashboard.writtenSeg': '第 {0} 段 · 已写 {1}',
  'dashboard.writtenSingle': '单文件 · 已写 {0}',
  'dashboard.singleFile': '单文件',
  'dashboard.currentSeg': '本段 {0}',
  'dashboard.waitSlot': '等待并发空位',
  'dashboard.pollSec': '轮询 {0} 秒',
  'dashboard.notLive': '未开播',
  'dashboard.toPlay': '待播',
  'dashboard.queuedTag': '排队',
  'dashboard.segPerMin': '{0} 分钟/段',
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