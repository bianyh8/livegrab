/* ==========================================================================================
   LiveGrab · ui/_views_settings.frag.js —— 「系统设置」7 个页签的高保真静态片段
   ------------------------------------------------------------------------------------------
   对齐 production（以代码为准，文案 1:1 取自 app/web/i18n/zh-CN.json）：
     · app/web/views/settings/index.js        页签顺序 rec / store / naming / platform / notify / security / update
     · app/web/views/settings/tabkit.js       设置项「改即写 settings + 500ms 去抖 PUT /api/settings」
     · app/web/views/settings/tab-rec.js      录制（默认参数网格 → 日志行 → 6 个开关 → 断流重连）
     · app/web/views/settings/tab-store.js    存储（根目录 + 检测 / 保留下限 / 成品保留 / 3 条开关与回收站）
     · app/web/views/settings/tab-naming.js   命名规则（配置卡 / 模板卡 / 12 变量表 ｜ 实时预览 / 目录树）
     · app/web/views/settings/tab-platform.js 平台账号（8 列表格 + 代理/UA + 开播监控）
     · app/web/views/settings/tab-notify.js   通知（Webhook / 4 事件 / 去重 / 重试 / 测试）
     · app/web/views/settings/tab-security.js 安全与登录（账号条 / 改密 / 有效期与失败锁定 / 开关 / scrypt）
     · app/web/views/settings/tab-update.js   系统更新（横幅 / 更新源配置 / 版本对比 / 更新说明 + 更新日志）
     · app/web/app.css                        类名与布局（tabs/tab/tabpane、card、row wrap、sw-row、tokens、
                                              preview、tree、up-*、rec-item、resolved、kv、note、divider、sect）
     · app/server/store.js                    DEFAULT_SETTINGS 默认值（maxConcurrency 8 / pollIntervalSec 60 …）
   导出：renderSettings(ctx, tab, D, h) → HTML 字符串（骨架把它写进 #view）。
   骨架已对 [data-stab] 做页签点击委托，这里只标 data-stab，不再自带事件。
   约束：只用骨架已有类（少量必要 inline style）；无 <script>、无外部资源、无网络请求；动态文本一律 h.esc()。
   ========================================================================================== */

/* ---------- 文案字典（zh-CN.json 原文） ---------- */
const TXT = {
  /* 页签（settings.tabXxx） */
  tabRec: '录制',
  tabStore: '存储',
  tabNaming: '命名规则',
  tabPlatform: '平台账号',
  tabNotify: '通知',
  tabSecurity: '安全与登录',
  tabUpdate: '系统更新',
  /* 通用 */
  saveBtn: '保存',
  savedAuto: '修改即自动保存（500ms 去抖）',
  add: '新建',
  copy: '复制',
  del: '删除',
  /* rec */
  recDefaultsTitle: '录制默认参数',
  recDefaultsHint: '新建任务时的默认值，可被任务单独覆盖',
  recDefaultQuality: '默认清晰度',
  recFallbackLabel: '清晰度回退顺序',
  recFallbackHint: '按 <span class="mono">/</span> 或 <span class="mono">→</span> 分隔；留空表示不回退、失败即报错。',
  recSegMinLabel: '分段时长（秒）',
  recSegMinHint: '任意数字，单位秒，如 3600 = 1 小时',
  recSegModeLabel: '默认分段方式',
  recSegByTime: '按时间',
  recSegBySize: '按文件大小',
  recContainerLabel: '录制中封装格式',
  recContainerTs: 'TS（推荐，断流容错好）',
  recConcurrencyLabel: '最大并发录制数',
  recConcurrencyHint: '实际并发 = min(全局上限, 「平台账号」里的平台上限)',
  recPlayConcurrencyLabel: '并发回放上限',
  recPlayConcurrencyHint: '同时最多 N 路 TS/FLV 转封装回放，超出返回 429；MP4 直放不受限',
  recLogDaysLabel: '日志保留天数',
  recLogDaysHint: '按天切分，超期自动清理',
  recLogLevelLabel: '默认日志级别',
  recLogDebugNote: '（含 ffmpeg 全量 stderr，增长快）',
  recRemuxLabel: '录制结束自动转封装 MP4',
  recRemuxDesc: '使用 ffmpeg -c copy 无损封转，秒级完成',
  recKeepSourceLabel: '保留原始 TS 分段',
  recKeepSourceDesc: '关闭则转封装成功后删除源文件，可省约 30% 空间',
  recAutoMergeLabel: '分段结束后自动合并为单文件',
  recAutoMergeDesc: '适合赛事、歌回等需要完整成片的场景',
  recMergeOnStopLabel: '停止时合并整场（mergeOnStop）',
  recMergeOnStopDesc: '停止录制后自动把本场分段合并为一个文件',
  recDeleteAfterMergeLabel: '合并后删除原始分段',
  recDeleteAfterMergeDesc: '合并整场后自动删除原始 .ts 分段，仅保留整场文件（释放重复占用的空间）',
  recDefaultMonitorLabel: '新任务默认「仅监控，不录制」',
  recDefaultMonitorDesc: '开启后新建任务只监控直播状态、不录制；可在任务里单独改',
  recReconnectLabel: '断流自动重连',
  recReconnectDesc: '断流指数退避 2/4/8/16/30 秒；触发风控（403）时自动拉长冷却至最长 2 分钟，避免频繁重试',
  recReconnUnit: '次',
  qOriginHighest: '原画（最高可用）',
  qBlurayName: '蓝光 1080P',
  qUhdName: '超清 720P',
  qHdName: '高清 540P',
  qSdName: '标清 360P',
  qAudioName: '仅音频 AAC 128k',
  /* store */
  recStorageTitle: '存储与清理',
  recStorageHint: '录制文件与回收站都落在容器内挂载卷',
  recRootLabel: '存储根目录（容器内）',
  recRootHint: '必须是<b>容器内</b>的绝对路径，且与启动时的挂载一致：<span class="mono">-v /你的宿主目录:/data</span>。浏览器无法选择宿主文件夹，所以这里只做"路径存在且可写"检测；换目录请改挂载后重启容器。',
  recDiskLimitLabel: '磁盘保留下限',
  recDiskTrigger: 'GB 以下触发清理',
  recRetentionLabel: '成品文件保留',
  recRetentionAfter: '天后自动删除',
  recSkipLiveSeg: '清理时跳过正在录制的分段',
  recSkipLiveSegDesc: '保护当前分段与临时文件，避免录到一半被删',
  recToTrash: '删除时移入回收站',
  recToTrashDesc: '落到 <span class="mono">/data/.trash</span>，可还原 / 一键清空',
  recTrashRetention: '回收站保留',
  recTrashAfter: '天后自动清理',
  verbCheck: '检测',
  /* naming */
  nmConfigTitle: '命名配置',
  nmConfigHint: '一个配置 = 一套「文件名模板 + 目录模板 + 日期格式 + 冲突策略」，可绑定到平台或任务',
  nmCurrentProfile: '当前配置',
  nmBindingLabel: '绑定范围',
  nmBindingNone: '不绑定（作为新任务默认）',
  nmNameLabel: '配置名称',
  nmNamePlaceholder: '命名配置名称，便于区分多套模板',
  nmFollowGlobalHint: '任务里"跟随全局"时使用其平台对应的配置；任务里自定义过则优先用任务自己的。渲染顺序永远是：变量替换 → 非法字符处理 → 去首尾空格与点 → 截断 → 重名去重 → 拼接扩展名。',
  nmFnTitle: '文件名模板',
  nmFnHint: '点击下方变量即可插入到光标处',
  nmPresetDy: '抖音预设',
  nmPresetBili: 'B站预设',
  nmFnFormatLabel: '文件名格式',
  nmFnHint1: '不含扩展名；扩展名由「封装格式」自动决定（.ts / .mp4 / .m4a / .flv）',
  nmInsertVarLabel: '插入变量',
  nmDirLabel: '目录结构模板',
  nmDirHint: '相对「存储根目录」，留空表示全部平铺到根目录；支持 / 创建多级子目录（<span class="mono">\\</span> 会自动归一化为 <span class="mono">/</span>）',
  nmDateLabel: '日期格式',
  nmPadLabel: '分段序号位数',
  nmTimeLabel: '时间格式',
  nmIllegalLabel: '非法字符处理',
  nmIllegalReplace: '替换为下划线 _（推荐）',
  nmIllegalRemove: '直接删除',
  nmIllegalKeep: '保留（可能失败）',
  nmIllegalHint: '跨平台并集过滤 <span class="mono">\\ / : * ? " &lt; &gt; |</span> 与首尾空格、点',
  nmDupLabel: '重名策略',
  nmDupSuffix: '追加 _2 _3 序号（推荐）',
  nmDupTimestamp: '追加录制时间戳',
  nmDupOverwrite: '覆盖同名文件',
  nmMaxLabel: '超长名称处理',
  nmMaxHint: '字符，超出时截断并在结尾保留序号（Linux 单层目录名上限 255 <b>字节</b>，中文按 UTF-8 约 3 字节/字，故 120 字符更保险）',
  nmVarsTitle: '变量说明',
  nmVarsHint: '共 {0} 个可用变量',
  nmColVar: '变量',
  nmColDesc: '说明',
  nmColExample: '示例值',
  nmPreviewTitle: '实时预览',
  nmPreviewHint: '示例数据',
  nmSaveTitle: '保存命名配置',
  nmPathLenLabel: '完整路径长度',
  nmExtLabel: '扩展名',
  nmExtValue: '.ts（录制中）→ .mp4（转封装后）',
  nmSortLabel: '排序效果',
  nmSortValue: '同一直播间分段按名称自然排序连续',
  nmNote: '同一模板需同时满足：① 同一场直播的多分段可连续排序；② 不同直播间不互相覆盖；③ 文件名中可直接看出日期与清晰度。未识别变量会原样保留并提示。',
  nmTreeTitle: '目录树预览',
  nmPreviewRemuxNote: '… 录制结束后转封装为同名 .mp4',
  nmPathLenValue: '{0} 字符 / {1} 字节 · 文件名 {2} 字节（单层名上限 255 字节）',
  nmBindingPlatform: '按平台：{0}',
  nmBindingTask: '按任务：{0}',
  nmBoundPlatform: '（绑定：{0}）',
  nmBoundTask: '（绑定：任务 {0}）',
  nmUnbound: '（未绑定）',
  nmPadOption: '{0} 位（{1}）',
  dateFormatCn: 'YYYY年MM月DD日（2025年06月01日）',
  /* platform */
  pfTitle: '平台与账号',
  pfHint: '{0} 个平台已接入；Cookie 是平台级的，一个平台一份',
  pfImport: '批量导入 Cookie',
  pfRecheck: '重新检测',
  pfColPlatform: '平台',
  pfColCookie: '登录 / Cookie',
  pfColQuality: '可用清晰度',
  pfColCap: '并发上限',
  pfColStability: '稳定性',
  pfColEnabled: '启用',
  pfColProxy: '代理',
  pfColProxyHint: '按平台独立开关：开启且上方填写了代理地址时，该平台的解析与录制走代理；否则直连',
  pfProxyLabel: '网络代理（可选）',
  pfUaLabel: 'User-Agent（可选）',
  pfUaPlaceholder: '留空则使用内置 UA',
  pfProxyHint: '此地址只作用于网络访问：仅下方「代理」列开关打开的平台走它，未开启的平台一律直连（容器环境里的代理变量不会绕过开关）。「检查更新 / 立即更新」也用它，代理连不上会自动改直连。留空则全部直连。不影响录制文件写入。',
  pfMonitorTitle: '开播监控',
  pfMonitorHint: '全局参数，可被任务单独覆盖',
  pfPollLabel: '全局轮询检测',
  pfPollDesc: '按任务分别设置间隔，默认 60 秒',
  pfStartDelayLabel: '开播后延迟开始',
  pfStartDelayDesc: '避开开场广告与黑屏',
  pfStopDelayLabel: '下播后延迟停止',
  pfStopDelayDesc: '防止提前截断结尾',
  pfDefaultQuality: '默认画质',
  pfMoreTiers: '等 {0} 档',
  pfNoLogin: '免登录',
  pfCookieSet: 'Cookie 已配置',
  pfUpdated: '更新于 {0}',
  pfCookieInvalid: 'Cookie 可能已失效',
  pfCookieMissing: '未配置',
  pfNeedCookie: '需要 Cookie',
  pfUntested: '待实测',
  pfPasteCookie: '粘贴 Cookie',
  pfQrLogin: '扫码登录',
  pfPasteBtn: '粘贴',
  pfAutoFetch: '自动获取',
  pfUpdateCookie: '更新 Cookie',
  pfFillCookie: '填写 Cookie',
  pfColProxyOn: '走代理',
  pfColProxyOff: '直连',
  pfDisabled: '停用',
  clear: '清除',
  seconds: '秒',
  unknown: '未知',
  /* notify */
  ntHint: 'Server 酱 / 企业微信 / Telegram / 自建 Webhook 均可',
  ntWebhookLabel: 'Webhook 地址',
  ntWebhookHint: '留空表示不发送通知（事件仍写入运行日志）。通知正文包含：任务名、平台、清晰度、文件路径与错误摘要，便于直接在手机上判断要不要处理。',
  ntOnLiveLabel: '监控到开播',
  ntOnLiveDesc: '检测到直播间开始直播时发一条通知（含开播时间）；录制开始/结束不再通知',
  ntOnErrorLabel: '录制失败与自动重试',
  ntOnErrorDesc: '断流超限、鉴权失败、磁盘满',
  ntOnDiskLabel: '磁盘空间告警',
  ntOnDiskDesc: '剩余空间低于保留下限时提醒',
  ntOnCookieLabel: 'Cookie 过期提醒',
  ntOnCookieDesc: '平台 Cookie 失效或即将过期',
  ntDedupeLabel: '同任务同类事件 {0} 秒内只发一次',
  ntDedupeDesc: '防断流抖动刷屏；去重后再计入次数（默认 60 秒）',
  ntDedupeSecSuffix: '秒（默认 60）',
  ntRetryLabel: '发送失败时按 5 / 15 / 45 秒重试 3 次',
  ntRetryDesc: '最终失败写入运行日志，不影响录制',
  ntTestBtn: '发送测试通知',
  /* security */
  secHint: '单管理员账号，凭据仅保存在容器内 /config',
  secLoggedIn: '已登录',
  secSessionAt: '本次会话建立于 {0}',
  secLastLogin: '上次登录 {0}',
  secFromIp: ' · 来自 {0}',
  secKillAll: '注销所有会话',
  secOldLabel: '当前密码',
  secNewLabel: '新密码',
  secNewPlaceholder: '至少 8 位',
  secNew2Label: '确认新密码',
  secTtlLabel: '登录有效期',
  secTtl30d: '30 天（记住我时）',
  secTtl12h: '12 小时',
  secTtl7d: '7 天',
  secTtlNever: '永不过期（不推荐）',
  secLockLabel: '登录失败限制',
  secLockDefault: '5 次失败后锁定 10 分钟',
  secLockNone: '不限制（仅内网使用）',
  secPolicyHint: '服务端固定策略：同一 IP 连续 <b>5 次</b>失败锁定 <b>10 分钟</b>。上面两项为浏览器本地偏好，仅影响本页提示与「记住我」默认勾选；服务端暂未提供对应接口。',
  secAutoLogoutLabel: '会话失效后自动跳回登录页',
  secAutoLogoutDesc: '接口返回 401 时前端清空本地状态并跳转登录',
  secAllowLocalLabel: '允许内网免登录',
  secAllowLocalDesc: '仅建议在可信内网开启；公网映射端口时务必关闭（当前版本未实现）',
  secScryptHint: '密码以 <span class="mono">scrypt</span> 哈希保存在容器内 <span class="mono">/config/users.json</span>，不可逆；首次启动（该文件不存在）强制进入初始化设密码模式，没有默认口令。会话为 HMAC 签名 Cookie（<span class="mono">lg_session</span>）。忘记密码可删除容器内 <span class="mono">/config/users.json</span> 后重启，重新初始化。',
  secSaveBtn: '保存新密码',
  secLogoutBtn: '退出登录',
  /* update */
  upTitle: '更新管理',
  upHint: '从 GitHub 获取最新代码，自动完成更新并重启',
  upCurrent: '当前版本',
  upLatest: '最新版本',
  upDeployed: '已部署',
  upAvailable: '可用更新',
  upLatestChip: '最新',
  upCommitTime: '提交时间',
  upCommitId: 'Commit ID',
  upBranch: '分支',
  upCheckBtn: '检查更新',
  upApplyBtn: '立即更新',
  upUpToDate: '当前代码已是最新（与远端提交一致）。',
  upNewTip: '发现新提交 {0}，点「立即更新」即可切换。',
  upRemoteUnavailable: '无法获取远程版本信息（仓库不可见或网络异常），请稍后再试。',
  upNotChecked: '尚未检查更新，点击「检查更新」从 GitHub 获取最新版本。',
  upLogTitle: '更新日志',
  upLogAlsoInLogs: '同步记录到「运行日志」页',
  upNotesTitle: '更新说明',
  upNotesMain: '主要更新内容',
  upNotesFix: '修复内容',
  upNotesNone: '暂无更新说明。',
  upLogEmpty: '暂无更新日志。',
  upRepo: '仓库 {0} · 分支 {1}',
  upRepoCfgTitle: '更新源配置',
  upRepoCfgHint: '自定义从哪个仓库/分支拉取更新（公共仓库可留空 Token，私有仓库需填写）',
  upRepoAddrLabel: '仓库地址',
  upRepoAddrHint: '支持 owner/repo 或 https://github.com/owner/repo.git',
  upTokenLabel: '访问 Token',
  upTokenHint: '公共仓库留空即可；私有仓库需填写（更新拉取时校验）',
  upGotoGithub: '前往 GitHub 仓库',
  upSaveConfig: '保存配置',
  upPhaseIdle: '空闲',
  upFailedBanner: '上次更新未完成（代码未被改动，服务仍在正常运行）：多为网络或代理问题，可直接再次点击「重试更新」。',
};

/* ---------- 静态数据（与 production 同源） ---------- */
const TABS = [
  ['rec', 'tabRec'], ['store', 'tabStore'], ['naming', 'tabNaming'], ['platform', 'tabPlatform'],
  ['notify', 'tabNotify'], ['security', 'tabSecurity'], ['update', 'tabUpdate'],
];

/* tab-rec.js QUALITIES / QLABEL */
const QUALITIES = [['origin', 'qOriginHighest'], ['bluray', 'qBlurayName'], ['uhd', 'qUhdName'], ['hd', 'qHdName'], ['sd', 'qSdName'], ['audio', 'qAudioName']];
const QLABEL = { origin: '原画', bluray: '蓝光', uhd: '超清', hd: '高清', sd: '标清', audio: '仅音频' };
const QNAME = {
  origin: '原画 1080P60', bluray: '蓝光 1080P', uhd: '超清 720P',
  hd: '高清 540P', sd: '标清 360P', audio: '仅音频 AAC 128k',
};

/* tab-naming.js DATE_FORMATS / TIME_FORMATS */
const DATE_FORMATS = [
  ['YYYY-MM-DD', 'YYYY-MM-DD（2025-06-01）'],
  ['YYYYMMDD', 'YYYYMMDD（20250601）'],
  ['YYYY.MM.DD', 'YYYY.MM.DD（2025.06.01）'],
  ['YYYY年MM月DD日', 'YYYY年MM月DD日（2025年06月01日）'],
];
const TIME_FORMATS = [['HH-mm-ss', 'HH-mm-ss（20-13-05）'], ['HHmmss', 'HHmmss（201305）'], ['HH.mm', 'HH.mm（20.13）']];

/* 变量说明兜底表（server/naming.js VARIABLES 同文） */
const VAR_FALLBACK = [
  ['{主播}', '主播昵称', '某某小主播'], ['{平台}', '平台名称', '抖音 / 哔哩哔哩'],
  ['{房间号}', '直播间房间号', '23456789'], ['{标题}', '当次直播标题', '今天打排位 冲王者'],
  ['{日期}', '录制开始日期（格式见下）', '2025-06-01'], ['{时间}', '录制开始时间', '20-13-05'],
  ['{清晰度}', '实际使用的清晰度', '原画 / 蓝光 / 仅音频'], ['{序号}', '分段序号，按位数补零', '001'],
  ['{任务}', '任务 ID', 'task_07'], ['{分辨率}', '实际分辨率', '1920x1080'],
  ['{时长}', '分段时长（录制完成后才可知，仅合并命名用）', '01-00-00'], ['{自定义}', '任务级自定义文本，可在任务中单独覆盖', '—'],
];

/* ---------- 小工具 ---------- */
const pad = (n) => String(n).padStart(2, '0');
/* 只保留日期 + 时分（与原型的 fmtDateTime 一致，避免秒级抖动） */
function dateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fromNow(ts) {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return Math.floor(diff / 86400) + ' 天前';
}
function hhmmss(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => pad(x)).join(':');
}
/* 原型里设置项是静态快照：数字输入宽 100%，用 min-width 收窄成 production 的紧凑宽度 */
const NUM_INLINE = (w) => 'max-width:' + (w || 104) + 'px';

/* 开关行（production tab-*.js 的 .sw-row 结构：<div>标题/说明</div><div class="spacer"></div>switch） */
function swRow(t, d, on, attrs) {
  return '<div class="sw-row"><div><div class="t">' + t + '</div><div class="d">' + d + '</div></div>'
    + '<div class="spacer"></div>' + swEl(on, attrs) + '</div>';
}
/* 原型的 window.h 没有 switchEl，这里按 ui.js switchEl() 的结构内联一份 */
function swEl(on, attrs) {
  return '<div class="switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" tabindex="0" ' + (attrs || '') + '><i></i></div>';
}
/* 带单位后缀的数字输入（production：74/100px 输入框 + 灰色单位文字） */
function numUnit(label, value, unit, hint, width) {
  return '<div class="f1" style="min-width:200px"><label class="fl">' + label + '</label>'
    + '<div class="row" style="align-items:center;gap:8px">'
    + '<input class="input" style="' + NUM_INLINE(width) + '" value="' + value + '" />'
    + '<span style="color:var(--txt-3);font-size:12.5px">' + unit + '</span></div>'
    + (hint ? '<div class="hintline">' + hint + '</div>' : '')
    + '</div>';
}
function selOpts(list, value) {
  return list.map((o) => {
    const v = Array.isArray(o) ? o[0] : o;
    const label = Array.isArray(o) ? o[1] : String(o);
    return '<option value="' + v + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + label + '</option>';
  }).join('');
}

/* ==========================================================================================
   ① 录制（tab-rec.js）
   ========================================================================================== */
function recTab(D, h) {
  const s = (D.settings || {});
  const fallback = (s.qualityFallback || ['origin', 'bluray', 'uhd', 'hd', 'sd']).map((q) => QLABEL[q] || q).join(' → ');
  return '<div class="stack">'
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.recDefaultsTitle + '</h3><span class="hint">' + TXT.recDefaultsHint + '</span>'
    + '<div class="spacer"></div><span class="chip on"><i class="dot"></i>' + TXT.savedAuto + '</span></div>'
    + '<div class="card-b">'

    /* 第一行：清晰度 / 回退顺序 / 分段时长 / 分段方式 / 封装 / 并发 / 回放 */
    + '<div class="row wrap">'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recDefaultQuality + '</label>'
    + '<select class="select">' + selOpts(QUALITIES.map(([v, k]) => [v, TXT[k]]), s.defaultQuality || 'origin') + '</select></div>'
    + '<div class="f1" style="min-width:260px"><label class="fl">' + TXT.recFallbackLabel + '</label>'
    + '<input class="input mono" value="' + h.esc(fallback) + '" />'
    + '<div class="hintline">' + TXT.recFallbackHint + '</div></div>'
    + '</div>'

    + '<div class="row wrap" style="margin-top:16px">'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recSegMinLabel + '</label>'
    + '<input class="input" value="' + h.esc(String(Number(s.defaultSegmentMinutes != null ? s.defaultSegmentMinutes : 3600) || 3600)) + '" />'
    + '<div class="hintline">' + TXT.recSegMinHint + '</div></div>'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recSegModeLabel + '</label>'
    + '<select class="select">' + selOpts([['time', TXT.recSegByTime], ['size', TXT.recSegBySize], ['none', '不分段']], s.defaultSegmentMode || 'time') + '</select></div>'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recContainerLabel + '</label>'
    + '<select class="select">' + selOpts([['ts', TXT.recContainerTs], ['flv', 'FLV'], ['mkv', 'MKV']], s.recordContainer || 'ts') + '</select></div>'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recConcurrencyLabel + '</label>'
    + '<input class="input" value="' + h.esc(String(s.maxConcurrency != null ? s.maxConcurrency : 8)) + '" />'
    + '<div class="hintline">' + TXT.recConcurrencyHint + '</div></div>'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recPlayConcurrencyLabel + '</label>'
    + '<input class="input" value="' + h.esc(String(s.playConcurrency != null ? s.playConcurrency : 2)) + '" />'
    + '<div class="hintline">' + TXT.recPlayConcurrencyHint + '</div></div>'
    + '</div>'

    /* 第二行：日志保留 / 日志级别 */
    + '<div class="row wrap" style="margin-top:16px">'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recLogDaysLabel + '</label>'
    + '<input class="input" value="' + h.esc(String(s.logRetentionDays != null ? s.logRetentionDays : 14)) + '" />'
    + '<div class="hintline">' + TXT.recLogDaysHint + '</div></div>'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.recLogLevelLabel + '</label>'
    + '<select class="select">' + selOpts(['INFO', 'WARN', 'ERROR', ['DEBUG', 'DEBUG' + TXT.recLogDebugNote]], s.logLevel || 'INFO') + '</select></div>'
    + '</div>'

    + '<div class="divider"></div>'
    + swRow(TXT.recRemuxLabel, TXT.recRemuxDesc, s.remuxToMp4 !== false)
    + swRow(TXT.recKeepSourceLabel, TXT.recKeepSourceDesc, s.keepSource !== false)
    + swRow(TXT.recAutoMergeLabel, TXT.recAutoMergeDesc, !!s.autoMerge)
    + swRow(TXT.recMergeOnStopLabel, TXT.recMergeOnStopDesc, !!s.mergeOnStop)
    + swRow(TXT.recDeleteAfterMergeLabel, TXT.recDeleteAfterMergeDesc, s.deleteAfterMerge !== false)
    + swRow(TXT.recDefaultMonitorLabel, TXT.recDefaultMonitorDesc, !!s.defaultMonitorOnly)

    /* 断流重连：右侧内联输入 + 「次」 */
    + '<div class="sw-row"><div><div class="t">' + TXT.recReconnectLabel + '</div><div class="d">' + TXT.recReconnectDesc + '</div></div><div class="spacer"></div>'
    + '<div class="row" style="align-items:center;gap:8px">'
    + '<input class="input" style="width:74px" value="' + h.esc(String(s.reconnectMax != null ? s.reconnectMax : 5)) + '" />'
    + '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.recReconnUnit + '</span>'
    + '</div></div>'
    + '</div></div></div>';
}

/* ==========================================================================================
   ② 存储（tab-store.js）
   ========================================================================================== */
function storeTab(D, h) {
  const s = (D.settings || {});
  return '<div class="stack">'
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.recStorageTitle + '</h3><span class="hint">' + TXT.recStorageHint + '</span>'
    + '<div class="spacer"></div><span class="chip on"><i class="dot"></i>' + TXT.savedAuto + '</span></div>'
    + '<div class="card-b">'
    + '<div class="form-row">'
    + '<label class="fl">' + TXT.recRootLabel + '</label>'
    + '<div class="row">'
    + '<input class="input mono f1" value="' + h.esc(s.recordRoot || '/data') + '" />'
    + '<button class="btn">' + TXT.verbCheck + '</button>'
    + '</div>'
    + '<div class="hintline">' + TXT.recRootHint + '</div>'
    + '</div>'
    + '<div class="row wrap">'
    + numUnit(TXT.recDiskLimitLabel, h.esc(String(s.diskLimitGB != null ? s.diskLimitGB : 20)), TXT.recDiskTrigger, '', 100)
    + numUnit(TXT.recRetentionLabel, h.esc(String(s.retentionDays != null ? s.retentionDays : 30)), TXT.recRetentionAfter, '', 100)
    + '</div>'
    + swRow(TXT.recSkipLiveSeg, TXT.recSkipLiveSegDesc, true, 'data-fixed="1"')
    + swRow(TXT.recToTrash, TXT.recToTrashDesc, s.deleteToTrash !== false)
    + '<div class="form-row" style="margin:10px 0 0">'
    + '<label class="fl">' + TXT.recTrashRetention + '</label>'
    + '<div class="row" style="align-items:center;gap:8px">'
    + '<input class="input" style="' + NUM_INLINE(100) + '" value="' + h.esc(String(s.trashRetentionDays != null ? s.trashRetentionDays : 7)) + '" />'
    + '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.recTrashAfter + '</span>'
    + '</div>'
    + '</div>'
    + '</div></div></div>';
}

/* ==========================================================================================
   ③ 命名规则（tab-naming.js）
   ========================================================================================== */
function namingTab(D, h) {
  const nm = D.naming || {};
  const profiles = nm.profiles || [];
  const active = profiles.find((p) => p.id === nm.activeId) || profiles[0] || {};
  const o = active.options || {};
  const variables = (nm.variables && nm.variables.length ? nm.variables : VAR_FALLBACK.map(([token, desc, example]) => ({ token, desc, example })));
  const preview = (nm.preview && nm.preview.lines) || [];
  const platforms = D.platforms || [];
  const tasks = D.tasks || [];

  /* 绑定范围下拉：不绑定 / 按平台 / 按任务（production 用一个下拉表达三种） */
  const binding = active.binding || { type: 'none', value: '' };
  const bindingValue = binding.type === 'platform' ? 'p:' + binding.value : binding.type === 'task' ? 't:' + binding.value : 'none';
  const platName = (id) => { const p = platforms.find((x) => x.id === id); return (p && p.name) || id; };
  const profileOpts = profiles.map((x) => {
    const b = x.binding || {};
    const tag = b.type === 'platform' ? TXT.nmBoundPlatform.replace('{0}', h.esc(platName(b.value)))
      : b.type === 'task' ? TXT.nmBoundTask.replace('{0}', h.esc(b.value)) : TXT.nmUnbound;
    return '<option value="' + h.esc(x.id) + '"' + (x.id === (active.id || '') ? ' selected' : '') + '>' + h.esc(x.name || x.id) + ' ' + tag + '</option>';
  }).join('');

  /* 预览块：/data/<目录>/ + 3 行文件名 + 转封装提示 */
  const dir0 = (preview[0] && preview[0].dir) || '';
  const last = preview[preview.length - 1] || {};
  const lenText = last.fullPath
    ? TXT.nmPathLenValue.replace('{0}', last.chars || String(last.fullPath).length)
      .replace('{1}', last.bytes || '?').replace('{2}', last.fileNameBytes || '?')
    : '—';

  /* 目录树：与 tab-naming.js runPreview() 同一套 ├─ / └─ 画法，仅用 <div>/<span> 与 &nbsp; */
  const parts = dir0 ? dir0.split('/') : [];
  const tree = '<div>/data/</div>'
    + parts.map((x, i) => '<div>' + '&nbsp;'.repeat(2) + '│&nbsp;&nbsp;'.repeat(i) + '├─ <span class="d">' + h.esc(x) + '</span>/</div>').join('')
    + preview.map((l) => '<div>' + '&nbsp;'.repeat(2) + '│&nbsp;&nbsp;'.repeat(parts.length) + '└─ <span class="f">' + h.esc(l.file) + '</span></div>').join('');

  return '<div class="grid2b">'
    /* ---------------- 左栏 ---------------- */
    + '<div class="stack">'

    /* 命名配置卡 */
    + '<div class="card">'
    + '<div class="card-h"><h3 style="white-space:nowrap">' + TXT.nmConfigTitle + '</h3><span class="hint">' + TXT.nmConfigHint + '</span>'
    + '<div class="spacer"></div>'
    + '<button class="btn sm ghost">' + TXT.copy + '</button>'
    + '<button class="btn sm ghost">' + TXT.add + '</button>'
    + '<button class="btn sm danger">' + TXT.del + '</button>'
    + '</div>'
    + '<div class="card-b">'
    + '<div class="row wrap">'
    + '<div class="f1" style="min-width:240px"><label class="fl">' + TXT.nmCurrentProfile + '</label>'
    + '<select class="select">' + profileOpts + '</select></div>'
    + '<div class="f1" style="min-width:240px"><label class="fl">' + TXT.nmBindingLabel + '</label>'
    + '<select class="select">'
    + '<option value="none"' + (bindingValue === 'none' ? ' selected' : '') + '>' + TXT.nmBindingNone + '</option>'
    + platforms.map((pl) => '<option value="p:' + h.esc(pl.id) + '"' + (bindingValue === 'p:' + pl.id ? ' selected' : '') + '>' + TXT.nmBindingPlatform.replace('{0}', h.esc(pl.name)) + '</option>').join('')
    + tasks.map((tk) => '<option value="t:' + h.esc(tk.id) + '"' + (bindingValue === 't:' + tk.id ? ' selected' : '') + '>' + TXT.nmBindingTask.replace('{0}', h.esc(tk.anchorName || tk.name || tk.id)) + '</option>').join('')
    + '</select></div>'
    + '<div class="f1" style="min-width:200px"><label class="fl">' + TXT.nmNameLabel + '</label>'
    + '<input class="input" maxlength="40" value="' + h.esc(active.name || active.id || '') + '" placeholder="' + TXT.nmNamePlaceholder + '" /></div>'
    + '</div>'
    + '<div class="hintline">' + TXT.nmFollowGlobalHint + '</div>'
    + '</div></div>'

    /* 文件名模板卡 */
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.nmFnTitle + '</h3><span class="hint">' + TXT.nmFnHint + '</span>'
    + '<div class="spacer"></div>'
    + '<button class="btn sm ghost">' + TXT.nmPresetDy + '</button>'
    + '<button class="btn sm ghost">' + TXT.nmPresetBili + '</button>'
    + '</div>'
    + '<div class="card-b">'
    + '<div class="form-row">'
    + '<label class="fl">' + TXT.nmFnFormatLabel + '</label>'
    + '<input class="input mono" value="' + h.esc(active.fnTemplate || '') + '" />'
    + '<div class="hintline">' + TXT.nmFnHint1 + '</div>'
    + '</div>'
    + '<div class="form-row">'
    + '<label class="fl">' + TXT.nmInsertVarLabel + '</label>'
    + '<div class="tokens">' + variables.map((v) => '<span class="token" title="' + h.esc(v.desc || '') + '">' + h.esc(v.token) + '</span>').join('') + '</div>'
    + '</div>'
    + '<div class="form-row">'
    + '<label class="fl">' + TXT.nmDirLabel + '</label>'
    + '<input class="input mono" value="' + h.esc(active.dirTemplate || '') + '" />'
    + '<div class="hintline">' + TXT.nmDirHint + '</div>'
    + '</div>'
    + '<div class="divider"></div>'
    + '<div class="row wrap">'
    + '<div class="f1" style="min-width:170px"><label class="fl">' + TXT.nmDateLabel + '</label>'
    + '<select class="select">' + selOpts(DATE_FORMATS, o.dateFormat || 'YYYY-MM-DD') + '</select></div>'
    + '<div class="f1" style="min-width:150px"><label class="fl">' + TXT.nmPadLabel + '</label>'
    + '<select class="select">' + selOpts([3, 2, 4].map((v) => [v, TXT.nmPadOption.replace('{0}', v).replace('{1}', '0'.repeat(v - 1) + '1')]), o.seqPad || 3) + '</select></div>'
    + '<div class="f1" style="min-width:150px"><label class="fl">' + TXT.nmTimeLabel + '</label>'
    + '<select class="select">' + selOpts(TIME_FORMATS, o.timeFormat || 'HH-mm-ss') + '</select></div>'
    + '</div>'
    + '<div class="row wrap" style="margin-top:16px">'
    + '<div class="f1" style="min-width:240px"><label class="fl">' + TXT.nmIllegalLabel + '</label>'
    + '<select class="select">' + selOpts([['replace', TXT.nmIllegalReplace], ['remove', TXT.nmIllegalRemove], ['keep', TXT.nmIllegalKeep]], o.illegal || 'replace') + '</select>'
    + '<div class="hintline">' + TXT.nmIllegalHint + '</div></div>'
    + '<div class="f1" style="min-width:240px"><label class="fl">' + TXT.nmDupLabel + '</label>'
    + '<select class="select">' + selOpts([['suffix', TXT.nmDupSuffix], ['timestamp', TXT.nmDupTimestamp], ['overwrite', TXT.nmDupOverwrite]], o.duplicate || 'suffix') + '</select></div>'
    + '</div>'
    + '<div class="form-row" style="margin:16px 0 0">'
    + '<label class="fl">' + TXT.nmMaxLabel + '</label>'
    + '<div class="row" style="align-items:center;gap:12px">'
    + '<input class="input" style="' + NUM_INLINE(130) + '" value="' + h.esc(String(o.maxLength || 120)) + '" />'
    + '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.nmMaxHint + '</span>'
    + '</div></div>'
    + '</div></div>'

    /* 变量说明表（12 行） */
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.nmVarsTitle + '</h3><span class="hint">' + TXT.nmVarsHint.replace('{0}', variables.length) + '</span></div>'
    + '<div class="card-b" style="padding:0">'
    + '<table><thead><tr><th style="width:130px">' + TXT.nmColVar + '</th><th>' + TXT.nmColDesc + '</th><th style="width:220px">' + TXT.nmColExample + '</th></tr></thead>'
    + '<tbody>' + variables.map((v) => '<tr>'
      + '<td class="mono" style="color:#a9c0ff" data-label="' + TXT.nmColVar + '">' + h.esc(v.token) + '</td>'
      + '<td data-label="' + TXT.nmColDesc + '">' + h.esc(v.desc || '') + '</td>'
      + '<td class="mono" style="color:var(--txt-2)" data-label="' + TXT.nmColExample + '">' + h.esc(v.example || '—') + '</td>'
      + '</tr>').join('') + '</tbody></table>'
    + '</div></div>'
    + '</div>'

    /* ---------------- 右栏 ---------------- */
    + '<div class="stack">'

    /* 实时预览卡（唯一的「保存命名配置」按钮所在） */
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.nmPreviewTitle + '</h3><span class="hint">' + TXT.nmPreviewHint + '</span>'
    + '<div class="spacer"></div><button class="btn sm primary">' + TXT.nmSaveTitle + '</button></div>'
    + '<div class="card-b">'
    + '<div class="preview">'
    + '<div class="pth">' + h.esc('/data/' + (dir0 ? dir0 + '/' : '')) + '</div>'
    + preview.map((l) => '<div class="fn">' + h.esc(l.file) + '</div>').join('')
    + '<div class="pth" style="opacity:.55">' + TXT.nmPreviewRemuxNote + '</div>'
    + '</div>'
    + '<div class="hintline" style="margin-top:8px">本页不随其它设置自动保存：模板/格式改完后点右上角「' + TXT.nmSaveTitle + '」提交（PUT /api/naming）。</div>'
    + '<div class="divider"></div>'
    + '<div class="kv">'
    + '<div class="k">' + TXT.nmPathLenLabel + '</div><div class="mono">' + h.esc(lenText) + '</div>'
    + '<div class="k">' + TXT.nmExtLabel + '</div><div class="mono">' + TXT.nmExtValue + '</div>'
    + '<div class="k">' + TXT.nmSortLabel + '</div><div>' + TXT.nmSortValue + '</div>'
    + '</div>'
    + '<div class="divider"></div>'
    + '<div class="note">' + TXT.nmNote + '</div>'
    + '</div></div>'

    /* 目录树预览卡 */
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.nmTreeTitle + '</h3><span class="hint">' + h.esc((dir0 || '/') + '') + '</span></div>'
    + '<div class="card-b"><div class="tree">' + tree + '</div></div>'
    + '</div>'

    + '</div>'
    + '</div>';
}

/* ==========================================================================================
   ④ 平台账号（tab-platform.js）
   ========================================================================================== */
const TIER_CN = { stable: '稳定', experimental: '实验性', planned: '规划中' };
const QSHORT = { origin: '原画', bluray: '蓝光', uhd: '超清', hd: '高清', sd: '标清', audio: '仅音频' };

function platformTab(D, h) {
  const s = (D.settings || {});
  const platforms = D.platforms || [];

  /* 与 tab-platform.js row()/qualitiesCell()/cookieCell()/stabilityChip()/actions() 同构 */
  const qCell = (qs) => {
    const list = qs || [];
    if (!list.length) return '<span class="chip plain"><i class="dot"></i>' + TXT.pfDefaultQuality + '</span>';
    const chunks = list.slice(0, 3).map((q) => '<span class="chip plain">' + h.esc(QSHORT[q.id] || q.label || q.id) + '</span>');
    if (list.length > 3) chunks.push('<span class="tag">' + TXT.pfMoreTiers.replace('{0}', list.length) + '</span>');
    return chunks.join(' ');
  };
  const cookieCell = (p) => {
    const c = p.cookie || {};
    const has = c.has != null ? c.has : !!p.cookieSet;
    /* cookieHow 是枚举值（qr / auto / paste / none / 免登录 文案），'none' 不能直接上屏 */
    const how = p.cookieHow && p.cookieHow !== 'none' ? p.cookieHow : TXT.pfNoLogin;
    if (!p.needCookie && !has) return '<span class="chip on"><i class="dot"></i>' + h.esc(how) + '</span>';
    const updated = TXT.pfUpdated.replace('{0}', h.esc(c.updatedAt ? dateTime(c.updatedAt) : TXT.unknown));
    if (has && c.valid !== false) {
      return '<span class="chip on"><i class="dot"></i>' + TXT.pfCookieSet + '</span>'
        + '<div class="sub">' + updated + (c.updatedAt ? '（' + h.esc(fromNow(c.updatedAt)) + '）' : '') + '</div>';
    }
    if (has) return '<span class="chip err"><i class="dot"></i>' + TXT.pfCookieInvalid + '</span><div class="sub">' + updated + '</div>';
    return '<span class="chip err"><i class="dot"></i>' + TXT.pfCookieMissing + '</span><div class="sub">' + h.esc(how) + '</div>';
  };
  const stability = (p) => {
    const tier = String(p.tier || '');
    const note = p.note || '';
    const label = TIER_CN[tier] || (note ? note.split('：')[0] : '') || TXT.pfUntested;
    const cls = tier === 'experimental' ? 'err' : (tier === 'stable' ? 'on' : 'wait');
    /* 原型不输出内联 title（浏览器原生 tooltip 会盖住截图）：说明折进下一行的 .sub */
    return '<span class="chip ' + cls + '" style="cursor:help"><i class="dot"></i>' + h.esc(label) + '</span>'
      + (note ? '<div class="sub" style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + h.esc(note) + '</div>' : '');
  };
  const actions = (p) => {
    const has = (p.cookie && p.cookie.has) || !!p.cookieSet;
    const btns = [];
    if (p.id === 'douyin') btns.push('<button class="btn sm">' + TXT.pfPasteCookie + '</button>');
    else if (p.id === 'bilibili') { btns.push('<button class="btn sm">' + TXT.pfQrLogin + '</button>'); btns.push('<button class="btn sm ghost">' + TXT.pfPasteBtn + '</button>'); }
    else if (p.id === 'kuaishou') btns.push('<button class="btn sm ghost">' + TXT.pfAutoFetch + '</button>');
    else if (p.needCookie) btns.push('<button class="btn sm">' + (has ? TXT.pfUpdateCookie : TXT.pfFillCookie) + '</button>');
    else btns.push('<button class="btn sm ghost">' + TXT.verbCheck + '</button>');
    if (has) btns.push('<button class="btn sm danger">' + TXT.clear + '</button>');
    return btns.join('');
  };

  const rows = platforms.map((p) => {
    const useProxy = !!(s.platformUseProxy || {})[p.id];
    const cap = (s.platformCaps || {})[p.id] != null ? s.platformCaps[p.id] : (p.cap != null ? p.cap : 2);
    return '<tr>'
      + '<td data-label="' + TXT.pfColPlatform + '"><div style="display:flex;align-items:center;gap:7px;white-space:nowrap">'
      + '<span class="plat ' + h.esc(h.platformInfo(p.id).cls) + '"><i>' + h.esc(h.platformInfo(p.id).letter) + '</i>' + h.esc(p.name) + '</span>'
      + (h.tierName(p.tier) ? '<span class="tag" style="white-space:nowrap">' + h.esc(h.tierName(p.tier)) + '</span>' : '') + '</div></td>'
      + '<td data-label="' + TXT.pfColCookie + '">' + cookieCell(p) + '</td>'
      + '<td data-label="' + TXT.pfColQuality + '">' + qCell(p.qualities) + '</td>'
      + '<td data-label="' + TXT.pfColCap + '"><input class="input" style="width:80px" value="' + h.esc(String(cap)) + '" /></td>'
      + '<td data-label="' + TXT.pfColStability + '">' + stability(p) + '</td>'
      + '<td data-label="' + TXT.pfColProxy + '">' + swEl(useProxy) + '</td>'
      + '<td data-label="' + TXT.pfColEnabled + '">' + swEl(!!p.enabled) + '</td>'
      + '<td><div class="acts">' + actions(p) + '</div></td>'
      + '</tr>';
  }).join('');

  return '<div class="stack">'
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.pfTitle + '</h3><span class="hint">' + TXT.pfHint.replace('{0}', platforms.length) + '</span>'
    + '<div class="spacer"></div>'
    + '<button class="btn sm ghost">' + TXT.pfImport + '</button>'
    + '<button class="btn sm ghost">' + TXT.pfRecheck + '</button>'
    + '</div>'
    + '<div class="card-b" style="padding:0">'
    + (platforms.length ? '<table><thead><tr>'
      + '<th>' + TXT.pfColPlatform + '</th><th>' + TXT.pfColCookie + '</th><th>' + TXT.pfColQuality + '</th>'
      + '<th style="width:110px">' + TXT.pfColCap + '</th><th>' + TXT.pfColStability + '</th>'
      + '<th style="width:76px">' + TXT.pfColProxy + '</th><th style="width:76px">' + TXT.pfColEnabled + '</th>'
      + '<th style="text-align:right">操作</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>' : h.emptyBox('平台清单加载中'))
    + '</div>'
    + '<div class="card-b" style="border-top:1px solid var(--line)">'
    + '<div class="row wrap">'
    + '<div class="f1" style="min-width:260px"><label class="fl">' + TXT.pfProxyLabel + '</label>'
    + '<input class="input mono" placeholder="http://192.168.1.10:7890" value="' + h.esc(s.proxy || '') + '" /></div>'
    + '<div class="f1" style="min-width:260px"><label class="fl">' + TXT.pfUaLabel + '</label>'
    + '<input class="input mono" placeholder="' + TXT.pfUaPlaceholder + '" value="' + h.esc(s.userAgent || '') + '" /></div>'
    + '</div>'
    + '<div class="hintline">' + TXT.pfProxyHint + '</div>'
    + '</div>'
    + '</div>'

    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.pfMonitorTitle + '</h3><span class="hint">' + TXT.pfMonitorHint + '</span>'
    + '<div class="spacer"></div><span class="chip on"><i class="dot"></i>' + TXT.savedAuto + '</span></div>'
    + '<div class="card-b">'
    + '<div class="sw-row"><div><div class="t">' + TXT.pfPollLabel + '</div><div class="d">' + TXT.pfPollDesc + '</div></div><div class="spacer"></div>'
    + '<div class="row" style="align-items:center;gap:8px"><input class="input" style="width:74px" value="' + h.esc(String(s.pollIntervalSec != null ? s.pollIntervalSec : 60)) + '" /><span style="color:var(--txt-3);font-size:12.5px">' + TXT.seconds + '</span></div></div>'
    + '<div class="sw-row"><div><div class="t">' + TXT.pfStartDelayLabel + '</div><div class="d">' + TXT.pfStartDelayDesc + '</div></div><div class="spacer"></div>'
    + '<div class="row" style="align-items:center;gap:8px"><input class="input" style="width:74px" value="' + h.esc(String(s.startDelaySec != null ? s.startDelaySec : 5)) + '" /><span style="color:var(--txt-3);font-size:12.5px">' + TXT.seconds + '</span></div></div>'
    + '<div class="sw-row"><div><div class="t">' + TXT.pfStopDelayLabel + '</div><div class="d">' + TXT.pfStopDelayDesc + '</div></div><div class="spacer"></div>'
    + '<div class="row" style="align-items:center;gap:8px"><input class="input" style="width:74px" value="' + h.esc(String(s.stopDelaySec != null ? s.stopDelaySec : 30)) + '" /><span style="color:var(--txt-3);font-size:12.5px">' + TXT.seconds + '</span></div></div>'
    + '</div>'
    + '</div>'
    + '</div>';
}

/* ==========================================================================================
   ⑤ 通知（tab-notify.js）
   ========================================================================================== */
function notifyTab(D, h) {
  const n = ((D.settings || {}).notify) || {};
  const dedupeSec = Number(n.dedupeSec != null ? n.dedupeSec : 60) || 60;
  return '<div class="stack">'
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.tabNotify + '</h3><span class="hint">' + TXT.ntHint + '</span>'
    + '<div class="spacer"></div><span class="chip on"><i class="dot"></i>' + TXT.savedAuto + '</span></div>'
    + '<div class="card-b">'
    + '<div class="form-row">'
    + '<label class="fl">' + TXT.ntWebhookLabel + '</label>'
    + '<input class="input mono" placeholder="https://sctapi.ftqq.com/xxx.send" value="' + h.esc(n.webhook || '') + '" />'
    + '<div class="hintline">' + TXT.ntWebhookHint + '</div>'
    + '</div>'
    + swRow(TXT.ntOnLiveLabel, TXT.ntOnLiveDesc, n.onLive !== false)
    + swRow(TXT.ntOnErrorLabel, TXT.ntOnErrorDesc, n.onError !== false)
    + swRow(TXT.ntOnDiskLabel, TXT.ntOnDiskDesc, n.onDisk !== false)
    + swRow(TXT.ntOnCookieLabel, TXT.ntOnCookieDesc, !!n.onCookie)
    + '<div class="divider"></div>'
    /* 去重条：标题里的秒数取当前值（production 用 #ntDedupeTx 动态占位） */
    + swRow(TXT.ntDedupeLabel.replace('{0}', '<span class="mono">' + dedupeSec + '</span>'), TXT.ntDedupeDesc, n.dedupe !== false)
    + '<div class="form-row" style="margin:-4px 0 12px 0">'
    + '<div class="row" style="align-items:center;gap:8px">'
    + '<input class="input" style="' + NUM_INLINE(100) + '" value="' + h.esc(String(dedupeSec)) + '" />'
    + '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.ntDedupeSecSuffix + '</span>'
    + '</div></div>'
    + swRow(TXT.ntRetryLabel, TXT.ntRetryDesc, n.retry !== false)
    + '<button class="btn" style="margin-top:12px">' + TXT.ntTestBtn + '</button>'
    + '</div></div></div>';
}

/* ==========================================================================================
   ⑥ 安全与登录（tab-security.js）
   ========================================================================================== */
function securityTab(D, h) {
  const sec = ((D.settings || {}).security) || {};
  const username = (D.user && D.user.username) || 'admin';
  const days = Number(sec.sessionDays);
  const ttl = days >= 365 ? 'never' : (Math.abs(days - 0.5) < 0.01 ? '12h' : (Math.abs(days - 7) < 0.01 ? '7d' : '30d'));
  const lock = (sec.failLimit != null && Number(sec.failLimit) >= 9999) ? 'none' : 'default';
  const now = D.now || Date.now();
  const sessionAt = dateTime(now);
  const lastLogin = dateTime(now - 3 * 3600 * 1000);

  return '<div class="stack">'
    + '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.tabSecurity + '</h3><span class="hint">' + TXT.secHint + '</span>'
    + '<div class="spacer"></div><span class="chip on"><i class="dot"></i>' + TXT.savedAuto + '</span></div>'
    + '<div class="card-b">'

    /* 当前账号条（复用 .rec-item） */
    + '<div class="rec-item" style="padding:0 0 14px;border-bottom:1px dashed var(--line)">'
    + '<div class="avatar" style="width:40px;height:40px;flex:0 0 40px">' + h.esc(String(username).charAt(0).toUpperCase()) + '</div>'
    + '<div class="rec-main">'
    + '<div class="ttl" style="font-size:13px">' + h.esc(username) + '</div>'
    + '<div class="meta">'
    + '<span class="chip on"><i class="dot"></i>' + TXT.secLoggedIn + '</span>'
    + '<span>' + TXT.secSessionAt.replace('{0}', h.esc(sessionAt)) + '</span>'
    + '<span>' + TXT.secLastLogin.replace('{0}', h.esc(lastLogin)) + TXT.secFromIp.replace('{0}', '192.168.1.24') + '</span>'
    + '</div></div>'
    + '<button class="btn sm ghost">' + TXT.secKillAll + '</button>'
    + '</div>'

    /* 改密：3 个 password */
    + '<div class="row wrap" style="margin-top:14px">'
    + '<div class="f1" style="min-width:180px"><label class="fl">' + TXT.secOldLabel + '</label>'
    + '<input class="input" type="password" placeholder="••••••••" autocomplete="current-password" /></div>'
    + '<div class="f1" style="min-width:180px"><label class="fl">' + TXT.secNewLabel + '</label>'
    + '<input class="input" type="password" placeholder="' + TXT.secNewPlaceholder + '" autocomplete="new-password" /></div>'
    + '<div class="f1" style="min-width:180px"><label class="fl">' + TXT.secNew2Label + '</label>'
    + '<input class="input" type="password" autocomplete="new-password" /></div>'
    + '</div>'

    + '<div class="row wrap" style="margin-top:16px">'
    + '<div class="f1" style="min-width:220px"><label class="fl">' + TXT.secTtlLabel + '</label>'
    + '<select class="select">' + selOpts([['30d', TXT.secTtl30d], ['12h', TXT.secTtl12h], ['7d', TXT.secTtl7d], ['never', TXT.secTtlNever]], ttl) + '</select></div>'
    + '<div class="f1" style="min-width:220px"><label class="fl">' + TXT.secLockLabel + '</label>'
    + '<select class="select">' + selOpts([['default', TXT.secLockDefault], ['none', TXT.secLockNone]], lock) + '</select></div>'
    + '</div>'
    + '<div class="hintline">' + TXT.secPolicyHint + '</div>'
    + '<div class="sw-row" style="margin-top:6px"><div><div class="t">' + TXT.secAutoLogoutLabel + '</div><div class="d">' + TXT.secAutoLogoutDesc + '</div></div><div class="spacer"></div>' + swEl(true, 'data-fixed="1"') + '</div>'
    + swRow(TXT.secAllowLocalLabel, TXT.secAllowLocalDesc, !!sec.trustLan)
    + '<div class="hintline">' + TXT.secScryptHint + '</div>'
    + '<div class="row" style="margin-top:14px;gap:10px">'
    + '<button class="btn primary">' + TXT.secSaveBtn + '</button>'
    + '<button class="btn ghost">' + TXT.secLogoutBtn + '</button>'
    + '</div>'
    + '</div></div></div>';
}

/* ==========================================================================================
   ⑦ 系统更新（tab-update.js）
   ========================================================================================== */
function updateTab(D, h) {
  const u = D.update || {};
  const local = u.local || {};
  const latest = u.latest || {};
  const hasUpdate = !!u.hasUpdate;
  const remoteUnavailable = !!u.remoteUnavailable;
  const running = !!u.running || !!u.checking;
  const failed = !running && u.phase === 'error';
  const snapshot = u.snapshot || null;
  const isRestart = u.phase === 'restart';
  const custom = ((D.settings || {}).customize) || {};

  const curVer = local.version ? ((local.tag && local.tag !== 'v' + local.version) ? local.tag : 'v' + local.version) : '—';
  const latestVer = remoteUnavailable ? '—' : (latest.tag || (latest.version ? 'v' + latest.version : '—'));
  const curChip = '<span class="chip on"><i class="dot"></i>' + TXT.upDeployed + '</span>';
  const latestChip = remoteUnavailable
    ? '<span class="chip off"><i class="dot"></i>' + TXT.unknown + '</span>'
    : hasUpdate
      ? '<span class="chip wait"><i class="dot"></i>' + TXT.upAvailable + '</span>'
      : '<span class="chip on"><i class="dot"></i>已完成</span>';
  const sameVer = !!(local.version && latest.version && local.version === latest.version);
  const newLabel = (hasUpdate && sameVer && latest.commit) ? latestVer + ' · ' + latest.commit : latestVer;
  const tip = remoteUnavailable
    ? '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.upRemoteUnavailable + '</span>'
    : hasUpdate
      ? '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.upNewTip.replace('{0}', '<b style="color:var(--warn)">' + h.esc(newLabel) + '</b>') + '</span>'
      : '<span style="color:var(--txt-3);font-size:12.5px">' + TXT.upUpToDate + '</span>';
  const applyDisabled = running || remoteUnavailable || !hasUpdate;

  const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>';
  const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
  const ICON_GITHUB = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2z"/></svg>';
  const ICON_WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="flex:0 0 16px"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';

  /* ---- 更新源配置卡 ---- */
  const configCard = '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.upRepoCfgTitle + '</h3><span class="hint">' + TXT.upRepoCfgHint + '</span></div>'
    + '<div class="card-b">'
    + '<div class="row wrap" style="gap:16px 18px">'
    + '<div class="f1" style="min-width:260px"><label class="fl">' + TXT.upRepoAddrLabel + '</label>'
    + '<input class="input mono" placeholder="owner/repo 或 https://github.com/owner/repo.git" value="' + h.esc(custom.updateRepo || u.repo || '') + '" />'
    + '<div class="hintline">' + TXT.upRepoAddrHint + '</div></div>'
    + '<div class="f1" style="min-width:160px"><label class="fl">' + TXT.upBranch + '</label>'
    + '<input class="input" placeholder="main" value="' + h.esc(custom.updateBranch || u.branch || 'main') + '" /></div>'
    + '<div class="f1" style="min-width:260px"><label class="fl">' + TXT.upTokenLabel + '</label>'
    + '<input class="input mono" type="password" autocomplete="off" placeholder="' + TXT.upTokenHint + '" value="' + h.esc(custom.updateToken || '') + '" />'
    + '<div class="hintline">' + TXT.upTokenHint + '</div></div>'
    + '</div>'
    + '<div class="row" style="margin-top:16px;gap:10px;align-items:center;flex-wrap:wrap">'
    + '<button class="btn">' + ICON_GITHUB + TXT.upGotoGithub + '</button>'
    + '<button class="btn primary">' + TXT.upSaveConfig + '</button>'
    + '</div>'
    + '</div></div>';

  /* ---- 版本对比卡 ---- */
  const verCard = '<div class="card">'
    + '<div class="card-h"><h3>' + TXT.upTitle + '</h3><span class="hint">' + TXT.upHint + '</span></div>'
    + '<div class="card-b">'
    + '<div class="up-grid">'
    /* 当前版本 */
    + '<div class="up-vcard">'
    + '<div class="up-vlabel">' + TXT.upCurrent + '</div>'
    + '<div class="up-vnum">' + h.esc(curVer) + ' ' + curChip + '</div>'
    + '<div class="up-vrows">'
    + '<div class="up-vr"><b>' + TXT.upCommitTime + '</b><span>' + h.esc(local.commitAt ? dateTime(local.commitAt) : '—') + '</span></div>'
    + '<div class="up-vr"><b style="flex:0 0 76px">' + TXT.upCommitId + '</b><span>' + h.esc(local.commit || '—') + '</span></div>'
    + '<div class="up-vr"><b>' + TXT.upBranch + '</b><span>' + h.esc(local.branch || u.branch || 'main') + '</span></div>'
    + '</div></div>'
    /* 箭头 */
    + '<div class="up-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>'
    /* 最新版本 */
    + '<div class="up-vcard' + (hasUpdate && !remoteUnavailable ? ' hot' : '') + '">'
    + '<div class="up-vlabel">' + TXT.upLatest + '</div>'
    + '<div class="up-vnum">' + h.esc(latestVer) + ' ' + latestChip + '</div>'
    + '<div class="up-vrows">'
    + '<div class="up-vr"><b>' + TXT.upCommitTime + '</b><span>' + h.esc(latest.commitAt ? dateTime(latest.commitAt) : '—') + '</span></div>'
    + '<div class="up-vr"><b style="flex:0 0 76px">' + TXT.upCommitId + '</b><span>' + h.esc(latest.commit || '—') + '</span></div>'
    + '<div class="up-vr"><b>' + TXT.upBranch + '</b><span>' + h.esc(u.branch || latest.branch || 'main') + '</span></div>'
    + '</div></div>'
    + '</div>'
    + '<div class="row" style="margin-top:18px;gap:10px;align-items:center;flex-wrap:wrap">'
    + '<button class="btn"' + (u.checking ? ' disabled' : '') + '>' + ICON_REFRESH + TXT.upCheckBtn + '</button>'
    + '<button class="btn primary"' + (applyDisabled ? ' disabled' : '') + '>' + ICON_DOWNLOAD + TXT.upApplyBtn + '</button>'
    + tip
    + '</div>'
    + '<div class="hintline" style="margin-top:10px">' + TXT.upRepo.replace('{0}', h.esc(u.repo || u.gitUrl || '—')).replace('{1}', h.esc(u.branch || 'main')) + '</div>'
    + '</div></div>';

  /* ---- 更新进度卡（仅更新/检查进行中显示） ---- */
  const progressCard = running ? '<div class="card">'
    + '<div class="card-h"><h3>更新进度</h3><span class="chip bili" style="margin-left:auto"><i class="dot"></i>' + TXT.upPhaseIdle + '</span></div>'
    + '<div class="card-b"><div class="up-bar"><i style="width:' + Math.min(100, Math.max(0, Number(u.progress) || 0)) + '%"></i></div>'
    + '<div class="row" style="justify-content:space-between;font-size:12px;color:var(--txt-3);margin-top:2px">'
    + '<span>已用时间 <b style="color:var(--txt-2)">' + h.fmtDur(u.elapsedSec || 0) + '</b></span><span>预计 <b style="color:var(--txt-2)">—</b></span></div>'
    + (isRestart ? '<div class="up-restart-note"><i class="up-spin"></i><span>服务正在自动重启以加载新版本，预计几秒后自动恢复，无需手动操作。</span></div>' : '')
    + '</div></div>' : '';

  /* ---- 更新说明（左） ---- */
  const notesBody = (!remoteUnavailable && latest.tag)
    ? '<div class="row" style="align-items:center;gap:10px">'
      + '<span class="mono" style="font-size:16px;font-weight:700">' + h.esc(latestVer) + '</span>'
      + (hasUpdate ? '<span class="chip wait"><i class="dot"></i>' + TXT.upAvailable + '</span>' : '<span class="chip on"><i class="dot"></i>' + TXT.upLatestChip + '</span>')
      + (latest.commitAt ? '<span style="color:var(--txt-3);font-size:12px">' + h.esc(dateTime(latest.commitAt).slice(0, 10)) + '</span>' : '')
      + '</div>'
      + '<div class="divider"></div>'
      + (latest.releaseNotes
        ? '<div style="font-size:12px;color:var(--txt-3);letter-spacing:.5px;margin-bottom:8px">' + TXT.upNotesMain + '</div>'
          + '<div style="font-size:13px;color:var(--txt-2);white-space:pre-wrap">' + h.esc(latest.releaseNotes) + '</div>'
        : '<div class="empty" style="padding:10px 0">' + TXT.upNotesNone + '</div>')
      + (latest.commitMsg ? '<div class="hintline" style="margin-top:10px">' + TXT.upNotesFix + '：' + h.esc(latest.commitMsg) + '</div>' : '')
    : '<div class="empty" style="padding:14px 0">' + (remoteUnavailable ? TXT.upRemoteUnavailable : TXT.upNotChecked) + '</div>';

  /* ---- 更新日志（右） ---- */
  const logs = (u.log || []).slice();
  const logBody = logs.length ? logs.map((l) => '<div>'
    + '<span class="dl-tl">' + h.esc(hhmmss(l.ts)) + '</span>'
    + '<span class="' + (l.level === 'OK' ? 'dl-ok' : l.level === 'ERR' ? 'dl-err' : l.level === 'WARN' ? 'dl-warn' : 'dl-nfo') + '">'
    + h.esc(l.level === 'OK' ? '[OK]  ' : l.level === 'ERR' ? '[ERR] ' : l.level === 'WARN' ? '[WARN]' : '[INFO]') + '</span>'
    + '<span class="dl-msg ' + (l.level === 'OK' ? 'dl-ok' : l.level === 'ERR' ? 'dl-err' : '') + '">' + h.esc(l.msg) + '</span>'
    + '</div>').join('') : '<div class="empty" style="padding:14px 0">' + TXT.upLogEmpty + '</div>';

  return '<div class="stack">'
    /* 横幅：restart / 上次失败 / 快照通道（Mock 中 snapshot 为空、phase !== error，故均不显示；
       模板保留以保证数据变化时结构完整） */
    + (isRestart ? '<div class="up-banner restart"><i class="up-spin"></i><span>服务正在自动重启以加载新版本，预计几秒后自动恢复，无需手动操作。</span></div>' : '')
    + (failed ? '<div class="up-banner err">' + ICON_WARN + '<span>' + TXT.upFailedBanner + '</span></div>' : '')
    + (snapshot ? '<div class="up-banner snap">' + ICON_WARN + '<span>代码已由快照通道更新到 <b class="mono">' + h.esc(String(snapshot.commit || snapshot.tag || '').slice(0, 12)) + '</b>（v' + h.esc(String(snapshot.version || '')) + '）：工作区已是最新，git 索引会在下次成功联网时自动对齐。</span></div>' : '')

    + configCard
    + verCard
    + progressCard

    + '<div class="up-two">'
    + '<div class="card"><div class="card-h"><h3>' + TXT.upNotesTitle + '</h3></div>'
    + '<div class="card-b">' + notesBody + '</div></div>'
    + '<div class="card"><div class="card-h"><h3>' + TXT.upLogTitle + '</h3><span class="hint">' + TXT.upLogAlsoInLogs + '</span></div>'
    + '<div class="card-b up-logbox">' + logBody + '</div></div>'
    + '</div>'
    + '</div>';
}

/* ==========================================================================================
   入口
   ========================================================================================== */
export function renderSettings(ctx, tab, D, h) {
  /* 页签以 URL hash 为准（#/settings/naming），使刷新 / 分享链接都能停在同一页签；
     ctx.state.settingsTab 作为兜底（骨架渲染前会先写入）。 */
  const fromHash = String((ctx && ctx.state) || location.hash || '').match(/settings\/([a-z]+)/);
  const wanted = (fromHash && fromHash[1]) || tab || (ctx && ctx.state && ctx.state.settingsTab) || 'rec';
  const cur = TABS.some(([id]) => id === wanted) ? wanted : 'rec';
  const tabs = '<div class="tabs" id="settingsTabs">'
    + TABS.map(([id, key]) => '<div class="tab' + (id === cur ? ' on' : '') + '" data-stab="' + id + '">' + TXT[key] + '</div>').join('')
    + '</div>';

  let body = '';
  try {
    if (cur === 'rec') body = recTab(D, h);
    else if (cur === 'store') body = storeTab(D, h);
    else if (cur === 'naming') body = namingTab(D, h);
    else if (cur === 'platform') body = platformTab(D, h);
    else if (cur === 'notify') body = notifyTab(D, h);
    else if (cur === 'security') body = securityTab(D, h);
    else body = updateTab(D, h);
  } catch (e) {
    body = '<div class="card"><div class="card-b"><div class="empty">' + h.esc('该页签加载失败：' + ((e && e.message) || e)) + '</div></div></div>';
  }
  return tabs + '<div class="tabpane active">' + body + '</div>';
}
