/* LiveGrab · i18n build —— 唯一维护入口
   build.mjs 负责：①把 ADD 中新增键并入 zh-CN.json；②删 REMOVE 中的废弃键；
   ③把「同文案不同 key」归一到单一 key（新建 common.* 或取组内 key）并同步改写各视图引用；
   ④据此重新生成 app/web/i18n.js 的 DEFAULT_DICT。
   用法：node app/web/i18n/build.mjs
   改文案/加键：编辑 ADD / REMOVE 后运行本脚本；zh-CN.json 是运行时权威，i18n.js 由它生成。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..');
const dictPath = path.join(here, 'zh-CN.json');
const outPath = path.join(webDir, 'i18n.js');

/* ---------------- ① 新增键（common 与各页页面键；不含已归到 common 的旧页键） ---------------- */
const ADD = {
  // common 级（跨页同名文案）
  'common.recorded': '已录完',
  'common.playback': '回放',
  'common.paused': '已暂停',
  'tasks.sessionHeld': '本场已停',
  'tasks.sessionHeldTip': '已停止本场 · 下播前不再自动录制，下次开播照旧自动录制',
  'common.unknownAnchor': '未知主播',
  'common.monitorOnly': '仅监控',
  'common.waitSlot': '等待并发空位',
  'common.unnamed': '未命名任务',
  'common.room': '房间 {0}',
  'common.checkLiveTip': '立即检测该直播间是否已开播',

  // dashboard 补键
  'dashboard.startToast': '已开始录制本场直播（仅监控房间的一次性录制，设置不变）',
  'dashboard.checkToast': '已刷新开播状态',
  'dashboard.pausedAll': '已暂停 {0} 条任务（结束当前分段，不占用并发）',

  // login
  'login.switchHintInit': '已经初始化过？',
  'login.switchHintLogin': '首次部署？',

  // ui（播放器/弹窗等）
  'ui.promptTitle': '请输入', 'ui.emptyContent': '内容不能为空',
  'ui.playbackBusy': '当前回放较多，请稍后再试', 'ui.playStartFail': '无法开始回放',
  'ui.remuxStreaming': '边转边播 · 不可拖动', 'ui.directPlay': '直接播放 · 可拖动',
  'ui.srcM4A': '源：M4A（服务端转封装）', 'ui.srcTSFLV': '源：TS/FLV（服务端 -c copy 转 fMP4）',
  'ui.srcDirect': '源：MP4 / M4A（直接播放）',
  'ui.browserPlayerHint': '浏览器内置播放器 · 不调用本机播放器、不依赖桌面环境',
  'ui.segments': '分段', 'ui.segsHint': '（共 {0} 段；可单独播放任意分段，也可合并后整场回放）',
  'ui.playHint': 'TS 片段由服务端 <span class="mono">ffmpeg -c copy</span> 边转边播、不落盘；成品 MP4 直接播放；正在录制的分段只播已写入的部分。若浏览器不支持所选音轨/编码，会给出明确提示而不是静默黑屏。<b>同时最多 {0} 路转封装回放</b>，超出会提示“{1}”；关闭播放器即释放；MP4 直放不受此限制。',
  'ui.copyDirectLink': '复制直链', 'ui.remuxMp4': '转封装 MP4', 'ui.mergeWhole': '合并整场',
  'ui.playUnsupported': '该文件浏览器无法直接播放（编码不支持或转封装失败）',
  'ui.remuxNoSeek': '边转边播不支持拖动，请等待转完再拖动',
  'ui.directLinkCopied': '已复制直链（局域网内可分享）', 'ui.remuxQueued': '已生成 MP4 转封装任务',
  'ui.remuxFail': '转封装失败', 'ui.mergeInvalid': '该文件不属于整场记录，无法合并',
  'ui.mergeQueued': '已提交合并整场任务',
  'ui.fitContain': '适应', 'ui.fitFill': '铺满', 'ui.rotate': '旋转画面', 'ui.fullscreen': '全屏',
  'ui.switchOrient': '切换横屏 / 竖屏',

  // trash
  'trash.loading': '正在加载回收站…', 'trash.loadFail': '回收站加载失败：{0}',
  'trash.itemUnit': '项', 'trash.restoreAll': '全部还原', 'trash.purgeAll': '清空回收站',
  'trash.restore': '还原', 'trash.purge': '清空',
  'trash.empty': '回收站为空', 'trash.media': '媒体', 'trash.unnamed': '未命名',
  'trash.kindSession': '整场', 'trash.kindSingle': '单个文件', 'trash.hasScrape': '含刮削',
  'trash.multipleFiles': '{0} 个文件', 'trash.singleFile': '1 个媒体文件',
  'trash.deletedAt': '删除于 {0}',
  'trash.retentionHint': '回收站文件保留在 <span class="mono">/data/.trash</span>，按设置保留 {0} 天自动清理。含媒体文件与其同名的刮削图片/描述（.jpg/.nfo），均一并可还原。',
  'trash.restoreAllText': '将把回收站内 <b>{0}</b> {1}（含刮削图片/描述）放回原位置。',
  'trash.restoredN': '已还原 {0} 项', 'trash.restoreDone': '已还原', 'trash.restoreFail': '还原失败',
  'trash.purgeAllText': '将永久删除回收站内 {0} {1}（<b>{2}</b>），含刮削图片/描述，<b>不可还原</b>。',
  'trash.purgedAll': '回收站已清空', 'trash.purgeFail': '清空失败', 'trash.purgeTitle': '永久清除',
  'trash.thisItem': '该项',
  'trash.purgeText': '将从回收站 <b>永久清除</b> 「{0}」（{1}）及其全部文件（含刮削图片/描述），<b>不可还原</b>。',
  'trash.purged': '已清除 {0} 项', // files
  'files.loadingLibrary': '正在加载文件库…', 'files.loadFailed': '文件库加载失败：{0}',
  'files.libraryTitle': '录制文件库', 'files.videoCount': '{0} 个视频文件',
  'files.searchPlaceholder': '搜索 文件名/主播/标题', 'files.anchorPlaceholder': '主播名称',
  'files.allTypes': '全部类型', 'files.clear': '清除', 'files.extTs': '.ts 直播流', 'files.extMp4': '.mp4 / m4a',
  'files.extM4a': '.m4a 音频', 'files.selectAll': '全选', 'files.selectedCount': '已选中 {0} 项',
  'files.deleteSelected': '删除所选', 'files.noFilteredFiles': '没有符合筛选条件的录制文件',
  'files.selectThisFile': '选择该文件', 'files.missing': '文件缺失',
  'files.duration': '时长 {0}', 'files.play': '播放', 'files.query': '查询', 'files.download': '下载',
  'files.recordNotFound': '找不到该文件记录', 'files.recordingCannotDelete': '录制中的分段不可删除',
  'files.moveToTrash': '移入回收站', 'files.permanentDelete': '永久删除',
  'files.deleteFileTitle': '删除录制文件', 'files.thatFile': '该文件',
  'files.deleteToTrashText': '将删除 <b>{0}</b>（{1}）并移入回收站 <span class="mono">/data/.trash</span>（同名的刮削图片/描述 .jpg/.nfo 一并已随行可还原）。<br><span style="color:var(--txt-3)">源 .ts 是否保留由「系统设置」决定，不在本次删除范围。保留 7 天，可去「回收站」页还原。</span>',
  'files.deletePermanentText': '将从磁盘 <b>永久删除</b> <b>{0}</b>（{1}）及同名的刮削图片/描述 .jpg/.nfo，<b>不可还原</b>。<br><span style="color:var(--txt-3)">源 .ts 是否保留由「系统设置」决定，不在本次删除范围。若需留底请先到系统设置打开「删除时移入回收站」。</span>',
  'files.deleteToTrashSelected': '将删除选中的 <b>{0}</b> 个文件 / <b>{1}</b>，并移入回收站 <span class="mono">/data/.trash</span>（连同同名的刮削图片/描述，可去「回收站」页还原）。<br><span style="color:var(--txt-3)">录制中的分段不会被删除。</span>',
  'files.deletePermanentSelected': '将从磁盘 <b>永久删除</b> 选中的 <b>{0}</b> 个文件 / <b>{1}</b> 及其同名的刮削图片/描述，<b>不可还原</b>。<br><span style="color:var(--txt-3)">录制中的分段不会被删除。若需留底请先到系统设置打开「删除时移入回收站」。</span>',
  'files.toastDeletedPermanent': '已永久删除', 'files.toastDeletedTrash': '已移入回收站',
  'files.deletedCount': '（{0} 项）', 'files.deletedCountBytes': '（{0} 项 / {1}）',
  'files.deleteFailed': '删除失败', 'files.readTrashSettingFailed': '读取删除设置失败，请重试',

  // files（勾选合并 + 查询反馈 + 合并中状态；2026-10-22 补登此前直接写进生成物的孤儿键）
  'files.mergeSelected': '合并',
  'files.mergeTitle': '合并所选文件',
  'files.mergeKeep': '合并(保留源文件)',
  'files.mergeDeleteSource': '合并(删除源文件)',
  'files.mergeText': '将按列表顺序把后面 <b>{0}</b> 个文件的内容依次追加，生成全新文件，源文件保持不变。<br><span style=\"color:var(--txt-3)\">「合并(保留源文件)」保留全部源文件（合并后共 {1} 个）；「合并(删除源文件)」把全部源文件移出磁盘，仅保留合并结果（受「删除时移入回收站」开关控制）。</span>',
  'files.mergeNameLabel': '文件名',
  'files.mergeNameHint': '扩展名自动使用源文件格式；合并结果继承第一个文件的场次信息（平台/主播/开播时间）',
  'files.mergeNameRequired': '请填写合并后的文件名',
  'files.mergeNeedTwo': '至少选择 2 个文件才能合并',
  'files.mergeMixedExt': '仅支持合并相同格式的文件',
  'files.mergeFailed': '合并失败',
  'files.mergedDone': '合并完成',
  'files.merging': '合并中',
  'files.queryApplied': '已按当前条件查询',
  'files.refreshed': '已刷新',

  // logs
  'logs.loading': '正在加载日志…', 'logs.loadFailed': '日志加载失败：{0}',
  'logs.levelAll': '全部级别', 'logs.taskAll': '全部任务', 'logs.taskLocked': '已锁定任务 {0}',
  'logs.qPlaceholder': '关键字过滤…', 'logs.toggleOrder': '切换日志排序',
  'logs.newestFirst': '最新在前', 'logs.newestLast': '最新在后',
  'logs.liveStreaming': '实时追加中', 'logs.livePaused': '实时追加已暂停',
  'logs.pauseLiveToast': '已暂停实时追加（后台仍在采集）', 'logs.resumeLiveToast': '已恢复实时追加',
  'logs.export': '导出',
  'logs.hint': '日志按天写入容器内 <span class="mono">/config/logs/YYYY-MM-DD.log</span>，保留 <b>{0} 天</b>，单文件超 <b>50 MB</b> 自动切分；默认级别 <b>{1}</b>（可切 WARN / ERROR / DEBUG）。页面默认加载最近 {2} 条，DEBUG 会包含 ffmpeg 全量 stderr、增长很快，排查完建议切回 INFO。',
  'logs.filesNote': '现有日志文件 {0} 个 / {1}。',
  'logs.empty': '暂无日志', 'logs.emptyFiltered': '没有符合过滤条件的日志',
  'logs.colTime': '时间', 'logs.colLevel': '级别', 'logs.colTask': '任务', 'logs.colMsg': '消息',
  'logs.count': '共 {0} 条（显示 {1} 条 · {2}）· 单次最多保留最近 {3} 条', 'logs.noLogs': '（无日志）',
  'logs.copied': '日志已复制到剪贴板', 'logs.exportedToast': '已导出日志',

  // settings
  'settings.tabRec': '录制', 'settings.tabStore': '存储', 'settings.tabNaming': '命名规则', 'settings.tabPlatform': '平台账号',
  'settings.tabNotify': '通知', 'settings.tabSecurity': '安全与登录', 'settings.tabUpdate': '系统更新',
  'settings.loading': '正在加载设置…', 'settings.loadFailed': '读取设置失败：{0}',
  'settings.tabLoadFailed': '该页签加载失败：{0}', 'settings.saved': '设置已保存',
  'settings.saveFailed': '设置保存失败', 'settings.namingSaved': '命名配置已保存',
  'settings.namingSaveFailed': '命名配置保存失败',
  'settings.pfImportButton': '导入',
  // settings · 系统更新
  'settings.upTitle': '更新管理', 'settings.upHint': '从 GitHub 获取最新代码，自动完成更新并重启',
  'settings.upCurrent': '当前版本', 'settings.upLatest': '最新版本',
  'settings.upDeployed': '已部署', 'settings.upAvailable': '可用更新',
  'settings.upCommitTime': '提交时间', 'settings.upCommitId': 'Commit ID', 'settings.upBranch': '分支',
  'settings.upCheckBtn': '检查更新', 'settings.upApplyBtn': '立即更新',
  'settings.upNewTip': '发现新提交 {0}，点「立即更新」即可切换。',
  'settings.upUpToDate': '当前代码已是最新（与远端提交一致）。',
  'settings.upRemoteUnavailable': '无法获取远程版本信息（仓库不可见或网络异常），请稍后再试。',
  'settings.upNotChecked': '尚未检查更新，点击「检查更新」从 GitHub 获取最新版本。',
  'settings.upChecking': '正在检查更新…',
  'settings.upProgressTitle': '更新进度',
  'settings.upTaskLabel': '当前任务：', 'settings.upElapsed': '已用时间', 'settings.upEstimate': '预计',
  'settings.upLogTitle': '更新日志', 'settings.upLogAlsoInLogs': '同步记录到「运行日志」页', 'settings.upNotesTitle': '更新说明', 'settings.upNotesMain': '主要更新内容', 'settings.upNotesFix': '修复内容',
  'settings.upNotesNone': '暂无更新说明。',
  'settings.upApplyConfirmTitle': '确认立即更新？',
  'settings.upApplyConfirmSelf': '将从 GitHub 下载远端最新提交的源码归档，解包校验后切换到新目录，并自动重启服务加载新代码（容器部署）；本地源码目录则走增量拉取。更新期间请勿关闭页面。',
  'settings.upApplyConfirmManual': '当前部署既不在容器内、也没有 git 源码目录，无法在线更新。点击后会在日志里生成手动更新步骤。更新期间请勿关闭页面。',
  'settings.upApplyStarted': '更新任务已启动',
  'settings.upApplyBusy': '更新任务正在进行中，请稍候',
  'settings.upCheckFailed': '检查更新失败：{0}',
  'settings.upRepo': '仓库 {0} · 分支 {1}',
  'settings.upPhaseIdle': '空闲', 'settings.upPhaseFetch': '下载更新', 'settings.upPhasePull': '更新代码',
  'settings.upPhaseExtract': '解包校验', 'settings.upPhaseSwitch': '切换到新版本',
  'settings.upPhaseInstall': '安装依赖', 'settings.upPhaseError': '未完成',
  'settings.upLogEmpty': '暂无更新日志。',
  'settings.upLatestChip': '最新',
  'settings.upPrivateRepoHint': '当前为私有仓库：请设置环境变量 LIVEGRAB_GITHUB_TOKEN（GitHub Personal Access Token）后重启服务，即可自动检测更新。',

  // tasks
  'tasks.loading': '正在加载任务…', 'tasks.loadFailed': '任务加载失败：{0}',
  'tasks.readTaskFail': '读取任务失败', 'tasks.sortSaveFail': '排序保存失败',
  'tasks.searchPh': '搜索主播 / 房间号 / 标题…', 'tasks.allLiveStatus': '全部直播状态',
  'tasks.live': '直播中', 'tasks.notLive': '未直播', 'tasks.allRecordStatus': '全部录制状态',
  'tasks.stopped': '已停止', 'tasks.sortCustom': '自定义排序', 'tasks.sortByCreated': '按创建时间排序',
  'tasks.sortByDuration': '按已录时长排序', 'tasks.sortBySize': '按文件大小排序',
  'tasks.sortByStatus': '按状态排序', 'tasks.sortDesc': '倒序', 'tasks.sortAsc': '顺序',
  'tasks.sortDirTip': '排序方向（自定义排序为手动顺序，不受此控制）', 'tasks.newTask': '＋ 新建任务', 'tasks.selected': '已选 {0} 项',
  'tasks.oneTaskTip': '1 任务 = 1 直播间；同一房间不允许两条启用任务',
  'tasks.batchStart': '批量启动', 'tasks.batchPause': '批量暂停', 'tasks.batchDelete': '批量删除',
  'tasks.batchHint': '批量操作单次上限 50 条；并发不足时部分成功，会明确告知"已启动 N 条、M 条进入排队"。删除默认只解除任务管理、不动已录文件。',
  'tasks.customSortHint': '当前为自定义排序：点击行尾 ↑ / ↓ 调整顺序（即实际任务执行顺序）。',
  'tasks.customSortTip': '排序下拉选「自定义排序」后，可手动调整任务顺序。',
  'tasks.noFiltered': '没有符合筛选条件的任务',
  'tasks.noTasks': '还没有录制任务，点右上角「新建任务」添加第一个直播间',
  'tasks.colTask': '任务 / 直播间', 'tasks.colLive': '直播状态',
  'tasks.colRecord': '录制状态', 'tasks.colQuality': '清晰度', 'tasks.colSort': '排序', 'tasks.colOps': '操作',
  'tasks.noTitle': '（暂无标题）', 'tasks.roomNoShort': '房号 {0}',
  'tasks.moveUp': '上移（上一优先级）', 'tasks.moveDown': '下移',
  'tasks.monitorOnlyTip': '该任务仅监控直播状态，不录制',
  'tasks.stoppedTip': '已停止录制，等你手动开始', 'tasks.abnormal': '异常', 'tasks.notRecorded': '未录制',
  'tasks.monitorOnlyStartTip': '仅录制本场，不改变仅监控设置',
  'tasks.redirectedLogs': '已跳转到运行日志并锁定该任务',
  'tasks.priorityToast': '排队原因：{0}（提权由调度器实现，UI 已提交）',
  'tasks.startDone': '已立即开始录制（跳过开播检测）',
  'tasks.pauseDone': '已暂停：本段已结束并入库，拉流已停止，不占用并发',
  'tasks.stopDone': '已停止并开始转封装', 'tasks.resumeDone': '已继续录制，新分段序号续接',
  'tasks.checkDone': '已立即轮询一次开播状态', 'tasks.retryDone': '已立即重试',
  'tasks.actionDone': '操作完成', 'tasks.actionFail': '操作失败',
  'tasks.selectFirst': '请先勾选要操作的任务', 'tasks.batchLimit': '批量操作单次上限 50 条，请减少勾选数量',
  'tasks.batchDeleteTitle': '批量删除任务', 'tasks.deleteBatchBody1': '将删除 <b>{0}</b> 条任务',
  'tasks.deleteBatchBound': '（其中 {0} 条已绑定整场文件）',
  'tasks.deleteBatchBody2': '。<br>已录文件默认<b>不删除</b>，仅解除任务管理；如需清理请到「录制文件」页删除整场。<br>',
  'tasks.deleteBatchSize': '<span style="color:var(--txt-3)">涉及约 {0} 个文件 / {1}（仅为提示口径）。</span>',
  'tasks.deleteBatchPartial': '已删除 {0} 条，{1} 条失败：{2}', 'tasks.deleteBatchOk': '已删除 {0} 条任务',
  'tasks.batchDeleteFail': '批量删除失败', 'tasks.verbPause': '暂停',
  'tasks.verbCheck': '检测', 'tasks.verbProcess': '处理',
  'tasks.batchDone': '已{0} {1} 条', 'tasks.batchFailed': '，{0} 条失败（{1}）',
  'tasks.failReasonUnknown': '原因未知', 'tasks.batchFail': '批量操作失败', 'tasks.deleteTitle': '删除任务',
  'tasks.deleteBody1': '将删除任务「{0}」。<br>',
  'tasks.deleteBody2': '已录文件默认<b>不删除</b>；如需清理请到「录制文件」页删除整场。<br>',
  'tasks.deleteSize': '<span style="color:var(--txt-3)">该任务已录约 {0} 个文件 / {1}。</span>',
  'tasks.deletedOk': '已删除任务（已录文件保留）', 'tasks.recordingTitle': '任务正在录制',
  'tasks.stopAndDelete': '停止并删除', 'tasks.recordingDeleteText': '该任务正在录制中，删除前需先停止。是否立即停止并删除？',
  'tasks.stoppedAndDeleted': '已停止并删除任务', 'tasks.noExport': '没有可导出的任务', 'tasks.csvId': '任务ID', 'tasks.csvAnchor': '主播',
  'tasks.csvTitle': '标题', 'tasks.csvRoom': '房间号',
  'tasks.csvSegment': '分段策略', 'tasks.csvStatus': '状态',
  'tasks.csvDuration': '已录时长', 'tasks.csvSize': '文件大小', 'tasks.csvCreated': '创建时间',
  'tasks.exportedOk': '已导出任务清单 CSV', 'tasks.detailTitle': '任务详情', 'tasks.kSource': '源地址', 'tasks.kPoll': '轮询', 'tasks.kReconnect': '重连次数', 'tasks.created': '创建 {0}', 'tasks.segHeader': '分段（{0}）', 'tasks.segIndex': '序号',
  'tasks.segDuration': '时长', 'tasks.segSize': '体积',
  'tasks.noSegs': '暂无分段记录（未开始录制或分段未入库）。', 'tasks.segEarlyEnd': '提前结束', 'tasks.segEarlyTip': '本段未按设定时长自然结束：提前收尾的原因见徽标（断流重连 / 主播下播 / 手动停止）。', 'tasks.pauseSegment': '暂停本段',
  'tasks.pauseSegmentDone': '已暂停：本段已结束并入库', 'tasks.stop': '停止', 'tasks.retry': '重试',
  'tasks.qOrigin': '原画', 'tasks.qOriginRes': '1080P60 · 最高画质',
  'tasks.qOriginKbps': '≈ 8000 kbps', 'tasks.qBluray': '蓝光', 'tasks.qBlurayRes': '1080P30',
  'tasks.qBlurayKbps': '≈ 6000 kbps', 'tasks.qUhd': '超清', 'tasks.qUhdRes': '720P',
  'tasks.qUhdKbps': '≈ 3000 kbps', 'tasks.qHd': '高清', 'tasks.qHdRes': '540P · 省流量',
  'tasks.qHdKbps': '≈ 1500 kbps', 'tasks.qSd': '标清', 'tasks.qSdRes': '360P · 弱网可用',
  'tasks.qSdKbps': '≈ 800 kbps', 'tasks.qAudio': '仅音频', 'tasks.qAudioRes': 'AAC 128k · 省空间',
  'tasks.qAudioKbps': '≈ 128 kbps', 'tasks.qOriginName': '原画 1080P60', 'tasks.qBlurayName': '蓝光 1080P',
  'tasks.qUhdName': '超清 720P', 'tasks.qHdName': '高清 540P', 'tasks.qSdName': '标清 360P',
  'tasks.qAudioName': '仅音频 AAC 128k', 'tasks.newTaskTitle': '新建录制任务', 'tasks.saveChanges': '保存修改', 'tasks.createTask': '创建任务',
  'tasks.pasteUrlPh': '粘贴任意支持的平台直播间链接（自动识别平台），或先选平台再输入房间号',
  'tasks.resolve': '解析', 'tasks.roomPh': '指定平台后填写，自动带入主播', 'tasks.anchorNameLabel': '主播名称',
  'tasks.anchorPh': '解析后自动填充，可手动修改',
  'tasks.qualityHint': '· 超标自动回退，文件名记真实档位',
  'tasks.currentSessionNote': '· <b style="color:var(--warn)">本场沿用旧参数，下一场生效</b>',
  'tasks.segByTimeCard': '按时间分段', 'tasks.segMinutesLabel': '每段时长', 'tasks.segSizeLabel': '分段大小',
  'tasks.autoRecordLabel': '开播自动录制',
  'tasks.monitorOnlyLabel': '仅监控，不录制',
  'tasks.monitorOn': '已开启仅监控：只监控直播状态，不会开始录制。',
  'tasks.monitorOff': '关闭则按正常任务录制（命名与存储全部跟随全局设置）。',
  'tasks.onlineNow': '· 当前在线 {0}', 'tasks.resolving': '解析中…',
  'tasks.pasteLinkWarn': '请粘贴直播间链接，或指定平台 + 房间号',
  'tasks.resolvedOk': '已解析直播间信息', 'tasks.resolveFail': '解析失败，请改用「手动指定平台 + 房间号」',
  'tasks.currentSel': '当前选择：',
  'tasks.qualityFallback': '· 不可用时按设置中的「清晰度回退顺序」自动回退，文件名记录真实档位',
  'tasks.fillLinkWarn': '请填写直播间地址，或指定平台 + 房间号',
  'tasks.updated': '任务已更新', 'tasks.created': '任务已创建，等待开播或立即开始录制',
  'tasks.dupRoom': '该直播间已有启用中的任务：1 个任务对应 1 个直播间，请编辑现有任务或先停用',
  'tasks.recordingChanged': '任务正在录制中，清晰度/分段/命名改动将在下一场生效',
  'tasks.saveFail': '保存失败', 'tasks.gb': 'GB', 'tasks.wan': '万',

  // logs（清除日志：预设时间范围）
  'logs.clear': '清除日志',
  'logs.clear1h': '过去一小时',
  'logs.clear24h': '过去24小时',
  'logs.clear7d': '过去7天',
  'logs.clear1m': '过去一个月',
  'logs.clearAll': '所有时间',
  'logs.clearAllConfirm': '确定清除所有日志吗？删除后不可恢复。',
  'logs.clearConfirm': '确定清除 {0} 至 {1} 的日志吗？删除后不可恢复。',
  'logs.clearDone': '已清除 {0} 个日志文件',
  'logs.clearFail': '清除日志失败',

  // files（日期时间范围查询）
  'files.dateFrom': '起始日期',
  'files.dateTo': '结束日期',
  'files.dateSep': '至',
};

/* ---------------- ② 废弃键（已统一到 common.*） ---------------- */
const REMOVE = [
  'dashboard.statMonitor', 'dashboard.statQueued', 'dashboard.statWaiting',
  'dashboard.waitSlot', 'dashboard.pollSec', 'dashboard.unnamed', 'dashboard.room',
  'dashboard.checkLiveTip', 'dashboard.diskTrash',
  'ui.waitSlot', 'ui.pollSec', 'ui.recorded', 'ui.playback',
  // 死键清理：statusCell 已删除（状态单元格改由各视图自渲染）+ 永不再出现的 merging 状态
  'ui.finishedAt', 'ui.autoRetry', 'common.pollSec', 'common.merging',
  // 死键清理：全仓无任何引用（2026-10-18 清查）
  'common.stopped', 'settings.upInvalidRepo',
  'files.completed', 'files.replay', 'files.unknownAnchor',
  'files.anchorPlaceholder',
  'tasks.unknownAnchor', 'tasks.monitorOnly',
  // 最近事件并入运行日志 + 移除引擎状态提示
  'events.title', 'events.hint', 'events.loading', 'events.loadFailed', 'events.fullLog', 'events.empty',
  'nav.eventsSub', 'common.engineOk', 'common.ffmpegUnavailable',
  // 清除日志改为预设时间范围弹窗（移除旧的日期输入框键）
  'logs.clearFrom', 'logs.clearTo', 'logs.clearNoRange',
  // 顶栏移除「刷新 / 新建录制任务」按钮
  'topbar.refreshStatus',
  // 批量条移除「批量暂停」：暂停功能保留在录制详情弹窗与总览「全部暂停」
  'tasks.batchPause', 'tasks.verbPause',
  // 未登记文件改为扫描时后台自动注册为场次，移除前端「未注册文件」区块文案
  'files.unregTitle', 'files.unregCount', 'files.unregTag', 'files.unregHint', 'files.unregEmpty',
  'files.unregImport', 'files.unregImportAll', 'files.unregImported', 'files.unregImportFail',
  'files.unregScan', 'files.unregScanDone', 'files.unregScanFail',
  // 更新日志卡片移除未实现的「全部日志」筛选占位下拉框
  'settings.upLogAll',
  // 更新确认弹窗按「能否在线自更新」区分（容器归档通道 / 本地 git 均可自更新）；
  // 移除旧的本地/容器二分键与未引用的 upApplyConfirmText
  'settings.upApplyConfirmText', 'settings.upApplyConfirmLocal', 'settings.upApplyConfirmContainer',
  // 死键清理：dedupe 已归并键 + 无视图引用键（2026-10-15 全仓清查）
  'settings.upPhaseDone', 'settings.upDonePhase', 'trash.clear', 'tasks.deleteFail', 'tasks.export', 'tasks.kTime', 'tasks.kTask', 'tasks.startRecord', 'tasks.csvQuality', 'tasks.kQuality', 'tasks.sectQuality', 'tasks.roomNo', 'tasks.kSegment', 'tasks.sectSegment', 'tasks.kStatus', 'tasks.verbStop', 'tasks.segBySizeCard', 'tasks.kNaming', 'tasks.colPlatform', 'tasks.csvPlatform', 'tasks.kPlatform', 'trash.clearFail', 'dashboard.collapseToggle', 'files.merged', 'logs.engineNote', 'tasks.expected', 'tasks.actual', 'tasks.autoMerge', 'tasks.on', 'tasks.off', 'tasks.followGlobal', 'tasks.pollDetail', 'tasks.times', 'tasks.kTotal', 'tasks.started', 'tasks.ended', 'tasks.edit', 'tasks.recommend', 'tasks.editTaskTitle', 'tasks.sectRoomUrl', 'tasks.manualPlatform', 'tasks.platHint1', 'tasks.platHint2', 'tasks.platHint3', 'tasks.platHint4', 'tasks.platHint5', 'tasks.platformDiff', 'tasks.segByTimeTip', 'tasks.segBySizeTip', 'tasks.segNoneTip', 'tasks.segHintBelow', 'tasks.segProcessingLabel', 'tasks.segKeepIndependent', 'tasks.segMergeSingle', 'tasks.customOnly', 'tasks.previewUnavailable', 'tasks.currentPlatform', 'tasks.notSpecified', 'tasks.verbStart', 'settings.upTargetVersion', 'settings.upLocalVer', 'settings.upRestartTip', 'common.loading', 'common.search', 'common.all', 'dashboard.notLive', 'dashboard.toPlay', 'dashboard.queuedTag', 'tasks.douyinHandleHint', 'tasks.statusNewHint', 'tasks.reconnectFollow',
];

/* ---------------- ③ 去重：同文案归一到单一 key ---------------- */
function dedupe(dict) {
  const byVal = new Map();
  for (const k of Object.keys(dict)) {
    const v = dict[k];
    if (!byVal.has(v)) byVal.set(v, []);
    byVal.get(v).push(k);
  }
  const rename = new Map();
  for (const [v, keys] of byVal) {
    if (keys.length <= 1) continue;
    // 优先 common.*；再按字母序取最小者为唯一 canonical
    const canon = keys.find((k) => k.startsWith('common.')) || [...keys].sort()[0];
    for (const k of keys) if (k !== canon) rename.set(k, canon);
    console.log(`  dedupe "${v}" → keep ${canon}, drop ${keys.filter((k) => k !== canon).join(', ')}`);
  }
  return rename;
}

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'i18n') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* ---------------- 执行 ---------------- */
let dict = JSON.parse(readFileSync(dictPath, 'utf8'));
let changed = false;
for (const k of Object.keys(ADD)) {
  if (dict[k] == null) { dict[k] = ADD[k]; changed = true; }
}
for (const k of REMOVE) {
  if (k in dict) { delete dict[k]; changed = true; }
}
const rename = dedupe(dict);
if (rename.size) {
  changed = true;
  for (const f of walk(webDir)) {
    let c = readFileSync(f, 'utf8');
    let fc = c;
    for (const [oldK, newK] of rename) fc = fc.split(`'${oldK}'`).join(`'${newK}'`);
    if (fc !== c) writeFileSync(f, fc, 'utf8');
  }
}
// 从内存中的 dict 删掉被去重取代的旧键（勿再读盘）
for (const [oldK] of rename) if (oldK in dict) delete dict[oldK];
if (changed || rename.size) {
  writeFileSync(dictPath, JSON.stringify(dict, null, 2) + '\n', 'utf8');
}

// ④ 生成 i18n.js
const keyLines = Object.keys(dict).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(dict[k])},`).join('\n');
const js = `/* LiveGrab · i18n.js —— 界面文案外置
   ＃ 本文件由 app/web/i18n/build.mjs 生成，请勿手改 DEFAULT_DICT；
   ＃ 改文案只改 app/web/i18n/zh-CN.json（或 build.mjs 的 ADD/REMOVE）后运行：
　　 node app/web/i18n/build.mjs
   DEFAULT_DICT 做首帧同步兜底；loadI18n() 用后端 /api/i18n 覆盖，后端为权威。 */

const DEFAULT_DICT = {
${keyLines}
};

let dict = DEFAULT_DICT;
const loaded = [];

export function t(key, ...args) {
  let s = dict[key];
  if (s == null) s = key;
  if (args && args.length) {
    args.forEach((v, i) => { s = s.replace(new RegExp('\\\\{' + i + '\\\\}', 'g'), String(v)); });
  }
  return s;
}

export function i18nLoaded() { return loaded.length > 0; }

export async function loadI18n() {
  try {
    const res = await fetch('/api/i18n', { credentials: 'same-origin' });
    if (!res.ok) return false;
    const payload = await res.json();
    const obj = payload && typeof payload === 'object' ? (payload.data ?? payload) : null;
    if (obj && typeof obj === 'object') { dict = { ...DEFAULT_DICT, ...obj }; loaded.push(Date.now()); }
    return true;
  } catch { return loaded.length > 0; }
}
`;
writeFileSync(outPath, js, 'utf8');
console.log(`i18n.js regenerated: ${Object.keys(dict).length} keys, rename=${rename.size}`);