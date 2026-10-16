# LiveGrab P0 · 内部契约（唯一依据，改动必须同步本文件）

## 0. 技术约束（硬性）

- **运行形态**：单容器 Web 服务。浏览器访问 `http://<host>:8080`。
- **唯一 npm 依赖 `better-sqlite3`**（SQLite 存储，原生模块，构建期 `npm ci` 安装）；后端其余部分只用 Node 内置模块（`node:http`/`node:fs`/`node:child_process`/`node:path`/`node:crypto`/`node:os`）。前端为原生 ES Module + 原生 CSS，**无构建步骤**。
- **模块格式**：`app/package.json` 声明 `"type":"module"`，全部使用 ESM `import/export`。
- **Node 版本**：镜像内 `node:22-bookworm-slim`，本机 v24 亦需可运行（不使用实验性 API）。
- **外部依赖**：npm 依赖仅 `better-sqlite3`；系统依赖为 `ffmpeg`/`ffprobe`（镜像内 apt 安装，路径由 `FFMPEG_PATH`/`FFPROBE_PATH` 覆盖，默认 `ffmpeg`/`ffprobe`）。
- **路径**：容器内 `RECORD_ROOT=/data`、`CONFIG_DIR=/config`、`PORT=8080`。

## 1. 目录

```
app/
  package.json          # type:module, scripts: start / test
  server/
    util.js             # 通用工具（无依赖）
    naming.js           # 命名规则引擎（纯函数）
    store.js            # 内存态 + SQLite 写穿透（tasks/sessions/files/settings/naming/trash）
    db.js               # SQLite v2 建库/PRAGMA/表结构（唯一持久化真相源，无 data_json）
    legacy-cleanup.js   # 旧 JSON 遗留清理（独立方法，日后可整段删除）
    logger.js           # 环形日志 + SSE 广播
    storage.js          # 磁盘统计与清理策略
    media.js            # ffmpeg/ffprobe 封装（子代理 A 负责）
    recorder.js         # 单任务录制进程管理：分段/轮转/重连（子代理 A 负责）
    resolvers/
      index.js          # 平台识别 + 统一入口（子代理 B 负责）
      bilibili.js       # B 站解析（子代理 B 负责）
      douyin.js         # 抖音解析（子代理 B 负责）
    scheduler.js        # 轮询开播、并发排队、任务生命周期（Lead 负责）
    server.js           # http 服务：静态 + API + SSE（Lead 负责）
  web/
    index.html app.css app.js api.js views/*.js   # 前端（子代理 C 负责）
  test/
    run.js              # 自带 assert，无框架：node app/test/run.js
    fake-ffmpeg.mjs     # 假 ffmpeg，用于无 ffmpeg 环境下的录制链路测试
docs/ (本文件)
Dockerfile  docker-compose.yml  README.md
```

## 2. 数据模型（store.js 持有）

```js
Task = {
  id: 't_xxx', platform: 'douyin'|'bilibili', roomId: '23456789', sourceUrl: 'https://live.douyin.com/23456789',
  anchorName: '某某小主播', title: '', avatar: '',
  quality: 'origin'|'bluray'|'uhd'|'hd'|'sd'|'audio',   // 期望
  qualityActual: null,                                   // 实际使用（回退后写实际值）
  segmentMode: 'time'|'size'|'none', segmentMinutes: 60, segmentSizeMB: 2048,
  container: 'ts'|'flv'|'mkv', remuxToMp4: true, keepSource: true, autoMerge: false,
  namingProfileId: 'default',
  autoRecord: true, pollIntervalSec: 60, startDelaySec: 5, stopDelaySec: 30,
  status: 'idle'|'waiting'|'queued'|'recording'|'stopping'|'merging'|'completed'|'stopped'|'error',
  statusMessage: '未开播', lastError: null, retryCount: 0, reconnectCount: 0,
  startedAt: null, endedAt: null, totalBytes: 0, totalDurationSec: 0,
  segmentIndex: 0,                                       // 已完成分段数
  currentFile: null,
  segments: [{ index:1, path:'/data/...', name:'...ts', bytes:0, startedAt, endedAt, durationSec, status:'recording'|'done'|'merged'|'deleted' }],
  createdAt, updatedAt
}

FileRecord = {
  id:'f_xxx', taskId, platform, anchorName, quality, qualityLabel,
  name:'2025-06-01_主播_原画_001.ts', path:'/data/抖音/主播/2025-06-01/xxx.ts', relPath, dir,
  ext:'ts', bytes, durationSec, width, height, segmentIndex, status:'recording'|'done'|'remuxed'|'merged'|'deleted',
  createdAt, completedAt
}

Settings = {
  recordRoot:'/data', maxConcurrency:8,
  defaultQuality:'origin', qualityFallback:['origin','bluray','uhd','hd','sd'],
  defaultSegmentMode:'time', defaultSegmentMinutes:60, defaultSegmentSizeMB:2048,
  container:'ts', remuxToMp4:true, keepSource:true, autoMerge:false, reconnectMax:5,
  pollIntervalSec:60, startDelaySec:5, stopDelaySec:30,
  diskLimitGB:20, retentionDays:30, deleteToTrash:false,
  notify:{ webhook:'', onStart:true, onError:true, onDisk:true, onCookie:false },
  cookie:{ douyin:{ value:'', valid:false, updatedAt:null }, bilibili:{ value:'', valid:false, updatedAt:null } },
  proxy:'', userAgent:''
}
```

## 3. HTTP API（server.js 实现，前端按此调用）

统一响应：成功 `200 {ok:true, data}`；失败 `4xx/5xx {ok:false, error:{code,message}}`。请求体 JSON，`Content-Type: application/json`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok:true,data:{status:'ok',ffmpeg:{available,version},uptimeSec}}` |
| GET | `/api/status` | 总览数据：`{recording:[TaskLite], waiting:[TaskLite], queue:[id], stats:{recordingCount,todayBytes,todayFiles,todayDurationSec}, disk:{totalBytes,freeBytes,usedBytes,recordsBytes}, engine:{ffmpegAvailable,ffmpegVersion,concurrency,activeCount}}` |
| GET | `/api/tasks` | 任务数组（含运行时 `live:{bytes,elapsedSec,currentFile,segmentIndex}`） |
| POST | `/api/tasks` | 创建。body: `{url}` 或 `{platform,roomId}`，可选覆盖字段（quality/segmentMode/...）。创建时**不解析**（除 anchorName 为空时异步补全），返回 Task |
| GET | `/api/tasks/:id` | 单任务 |
| PATCH | `/api/tasks/:id` | 局部更新（录制中禁止改 quality/segmentMode，返回 409） |
| DELETE | `/api/tasks/:id` | 删除（录制中返回 409，除非 `?force=1` 先停止） |
| POST | `/api/tasks/:id/start` | 立即开始（跳过开播检测，用于测试/手动） |
| POST | `/api/tasks/:id/stop` | 优雅停止（收尾分段 → 转封装 → 入库） |
| POST | `/api/tasks/:id/pause` | 暂停（关闭当前分段，任务仍占用并发） |
| POST | `/api/tasks/:id/resume` | 继续录制（新开分段，序号续接） |
| POST | `/api/tasks/:id/check` | 立即轮询一次开播状态 |
| POST | `/api/tasks/:id/retry` | 错误任务重试 |
| POST | `/api/resolve` | body `{url}` → RoomInfo（下方 4.1），用于新建弹窗"解析"按钮 |
| GET | `/api/naming` | `{profiles, activeId, options}` |
| PUT | `/api/naming` | 整体更新命名配置 |
| POST | `/api/naming/preview` | body `{fnTemplate,dirTemplate,options?,samples?}` → `{lines:[{dir,file,fullPath,length}], warnings:[]}` |
| GET | `/api/settings` | Settings（cookie.value 脱敏为 `''` + `hasCookie:true`） |
| PUT | `/api/settings` | 局部合并 |
| GET | `/api/files` | query: `dir platform q ext status limit=100 offset=0` → `{total, items:[FileRecord]}` |
| GET | `/api/files/tree` | `{root, children:[{name,path,count,bytes,children?}]}` 按平台/日期两级 |
| POST | `/api/files/scan` | 重新扫描 RECORD_ROOT 并入库（返回 `{added,updated}`） |
| POST | `/api/files/merge` | body `{ids:[...]}` → 合并任务（返回新 FileRecord，异步；用 `status:'merging'` 占位再到 `merged`） |
| POST | `/api/files/:id/remux` | 转封装 MP4 |
| DELETE | `/api/files` | body `{ids:[...]}` 删除文件与记录 |
| GET | `/api/files/:id/stream` | **支持 Range**，`Accept-Ranges: bytes`，`206` 分片，`Content-Type: video/mp2t|video/mp4|audio/*`；用于浏览器内播放 |
| GET | `/api/files/:id/download` | `Content-Disposition: attachment` |
| GET | `/api/logs` | query: `level taskId q limit=200` → `{items:[LogLine]}`；`LogLine={ts,level,taskId,taskName,msg}` |
| GET | `/api/events` | **SSE**：`event: log|task|status`，`data: JSON`；每 15s 发 `:ping` 心跳 |
| POST | `/api/notify/test` | 发送测试通知 |

## 4. 模块接口（跨文件调用必须严格一致）

### 4.1 resolvers/index.js（子代理 B）
```js
export function detectPlatform(input) // 'douyin'|'bilibili'|null；接受完整 URL / 纯房间号+platform 提示
export async function resolveRoom(url, ctx) // ctx={settings,logger}
// → RoomInfo={platform,roomId,url,anchorName,title,avatar,liveStatus:'live'|'offline'|'unknown',online:number|null,qualityOptions:[{id,label,resolution,bitrate}]}
// 失败抛 ResolverError(code:'INVALID_URL'|'ROOM_NOT_FOUND'|'BLOCKED'|'NETWORK'|'AUTH', message)
export async function resolveStream(task, ctx) // ctx={settings,logger}
// → { url, quality, qualityLabel, headers:{'User-Agent':...,'Referer':...,'Cookie'?:...}, resolution }
// 优先级：task.quality → settings.qualityFallback 依次尝试；全失败抛 ResolverError('NO_STREAM')
```
- `quality` 取值固定：`origin|bluray|uhd|hd|sd|audio`。B 站 qn 映射：origin=10000, bluray=400, uhd=250, hd=150, sd=80；audio 走 `-vn` 且取最低 qn。
- 必须只用 `globalThis.fetch`，自带超时（AbortSignal.timeout）与 2 次重试；失败信息要能指导用户（例如"Cookie 失效"）。
- 抖音需要 `ttwid`：先 GET `https://live.douyin.com/` 取 `set-cookie`，再调 `/webcast/room/web/enter/`；HTML 兜底解析 `RENDER_DATA`。

### 4.2 media.js（子代理 A）
```js
export async function ffmpegVersion(ffmpegPath='ffmpeg') // → {available:boolean, version:string|null}
export async function ffprobeJson(ffprobePath='ffprobe', file) // → {durationSec,bytes,width,height}|null
export function buildRecordArgs({streamUrl, outputPattern, container='ts', segmentMode='time', segmentMinutes=60, segmentListPath, startNumber=1, headers={}, audioOnly=false, proxy=''})
// → string[]（不含 ffmpeg 本身；见下方 5. 参数规范）
export function buildRemuxArgs({input, output, audioOnly=false})
export function buildMergeArgs({listFile, output})
export function buildConcatList(inputs) // → 'file \'<escaped>\'\n...'
export async function runFfmpeg({ffmpegPath, args, onStderr, onExit}) // → {code, signal}（子代理 A 可用 spawn 包装）
export function probeDuration(ffprobePath, file)
```

### 4.3 recorder.js（子代理 A）
```js
export class Recorder extends EventEmitter {
  constructor({task, settings, naming, resolveStream, logger, media, onEvent})
  // onEvent(event) 供 scheduler 落库，event 见下
  async start()   // 解析流地址 → 计算输出路径 → spawn ffmpeg → 返回 {ok, quality, qualityLabel, firstSegment}
  async stop(reason='user') // 'q' 优雅退出，8s 未退则 kill；收尾后触发 'finished'
  async pause() / async resume()
  getStats() // → {bytes, elapsedSec, currentFile, segmentIndex, recordingSec}
  // 事件：
  //  'segment'   {index, path, name, bytes, startedAt}          新分段开始
  //  'segment-close' {index, path, bytes, endedAt, durationSec} 分段收尾（写入 files 表）
  //  'reconnect' {attempt, delayMs, error}
  //  'error'     {code, message, retryable}
  //  'finished'  {reason:'user'|'offline'|'error'|'disk', segments:[...]}
}
```
- 按大小轮转：每 2s 检查当前分段文件大小，超过 `segmentSizeMB` 则 `q` 收尾并 `startNumber+1` 重启，分段序号连续。
- 断流重连：进程非正常退出且未在停止流程中 → 指数退避 2/4/8/16/30s，最多 `settings.reconnectMax` 次，序号续接。
- 平台拒绝（403/401/429，风控/限流）：单独走长冷却 15/30/60/120/120s，跳过下播探活、复用当前流地址不重新解析（重试突发会加重封禁，实测抖音 CDN 约 1 分钟冷却后自行恢复）；耗尽后以 `code:'PULL_BLOCKED'` 报错。
- 所有日志通过 `ctx.logger` 输出并带 `taskId`。

### 4.4 naming.js（Lead 已实现，前端与 recorder 只读其返回值）
```js
export const DEFAULT_NAMING
export function qualityLabel(q)                       // 'origin'→'原画' 等
export function buildContext(input)                   // → {vars:{'{日期}':...,...}}
export function renderTemplate(tpl, ctx)              // → {text, unknown:[]}
export function expandDir(tpl, ctx)                   // → 相对路径（已清洗，去首尾 /）
export function planSegmentNames({naming, ctx, count})// → [{index,file,ext,relPath}]；不含 {序号} 时自动追加 _%03d
export function reserveName(fullPath, existsFn)       // → 不冲突的最终路径
export function previewNaming({fnTemplate,dirTemplate,options,samples}) // → {lines,warnings}
```

### 4.5 前端（子代理 C）
- 入口 `app/web/index.html` 引入 `app.css`、`app.js`（`<script type="module">`）。
- `app.js` 负责：左侧导航渲染与路由（hash 路由 `#/dashboard` 等）、顶栏、`#view` 容器、2s 轮询 `/api/status` + `/api/tasks`、SSE `/api/events` 追加日志、`toast()`、`confirmDialog()`、`formatBytes/formatDuration` 工具。
- 每个视图导出 `export function render(root, ctx)`（同步返回 DOM 或 HTML 字符串），必要时导出 `destroy()`。
- 视图模块：`views/dashboard.js`（总览）、`views/tasks.js`（任务表格 + 新建/编辑/详情弹窗）、`views/files.js`（文件库 + 播放器）、`views/settings/`（设置 7 页签：录制 / 存储 / 命名规则 / 平台账号 / 通知 / 安全与登录 / 系统更新，命名规则复用 `POST /api/naming/preview`）、`views/logs.js`。
- 视觉完全沿用 `ui/index.html` 的设计令牌与组件类名（`ui/index.html` 是可读参考，直接复制其 `<style>` 到 `app.css` 并补充缺失类）。

## 5. ffmpeg 参数规范（子代理 A 必须严格实现）

录制（TS 分段，关键帧对齐，直接产出最终文件名）：
```
ffmpeg -hide_banner -loglevel info -nostats
  [-user_agent <ua>] [-headers "<k: v>\r\n<k2: v2>\r\n"] [-http_proxy <proxy>]
  -i <streamUrl>
  [-vn -c:a aac -b:a 128k]                       # audioOnly
  -c copy                                         # 非 audioOnly
  -f segment -segment_time <sec> -segment_format mpegts
  -reset_timestamps 1 -segment_start_number <n>
  -segment_list <listPath> -segment_list_type csv
  <outputPattern>                                 # 形如 /data/抖音/主播/2025-06-01/名字_%03d.ts
```
- `container='flv'` 时 `-segment_format flv`、扩展名 `.flv`；`mkv` 时 `-segment_format matroska`、扩展名 `.mkv`。默认 `ts`。
- `segmentMode:'none'` → 去掉 `-f segment` 全部参数，直接写单文件（文件名不含 `%03d`）。
- `-segment_list` 的 CSV 行：`<path>,<start>,<end>`（秒，float），用于精确登记分段边界与时长。
- 停止：向 stdin 写 `q`（必须 `stdio:['pipe','ignore','pipe']`）。
- 转封装：`ffmpeg -hide_banner -y -i in.ts -c copy -movflags +faststart out.mp4`（audioOnly 用 `-c:a copy` 输出 `.m4a`）。
- 合并：`ffmpeg -hide_banner -y -f concat -safe 0 -i list.txt -c copy out.<ext>`。

## 6.5 v0.1 冻结补充（**与上文冲突时以本节为准**，实现按本节）

### 6.5.1 相对原契约的修正
1. **系统设置 7 个页签**：录制 / 存储 / 命名规则 / 平台账号 / 通知 / 安全与登录 / 系统更新（通知与安全已拆分，见 UI设计说明 §7）。
2. **暂定不占并发**（D4）：暂停 = 结束当前分段 + 停 ffmpeg + 入库并释放并发；恢复 = 重新解析地址、新开分段、序号续接。
3. **删除默认进回收站**（D10）：`/data/.trash`，保留 `trashRetentionDays`（默认 7）天；录制中的 session 禁止删除。
4. **回放不用 HLS**：浏览器（Chrome/Edge）不原生支持 HLS，而本项目禁用第三方依赖 → 回放统一为
   - `.mp4/.m4a` → **直放**（`GET /api/files/:id/stream`，支持 Range，可拖动）；
   - `.ts/.flv/.mkv`（含正在录制的分段）→ **服务端 ffmpeg `-c copy` 边转 fMP4 渐进流**，从 stdout 管道给 `<video>`（不可拖动，播到已转完为止）；`-c copy` 失败时自动重试 `-c:v copy -c:a aac`。
   - 同时最多 `playConcurrency`（默认 2）路转封装回放，超出返回 429 `PLAY_BUSY`（D17）。
5. **文件按"整场"归档**（D8/D9）：见 6.5.3 Session；列表默认返回 session，分段是其子项。
6. **多套命名配置**（D12）：`profiles[]` + 绑定（平台/任务/无）。
7. **并发上限**（D16）：`min(settings.maxConcurrency, settings.platformCaps[platform])`，排队要带原因。
8. **日志保留**（D14）：`/config/logs/YYYY-MM-DD.log`，保留 14 天，单文件 50 MB 切分，默认 INFO。
   - **全链路统一进日志文件**：更新流程（`[更新]` 前缀：环境自检/检查对比/拉取/安装/重启）、容器启动引导（`[容器启动]` 前缀：entrypoint.sh 把克隆/回退/预热/依赖检查写入 `${CONFIG_DIR}/.bootstrap-events`，服务启动后读取转写并删除该文件）、db 初始化等 logger 就绪前的启动消息（先入缓冲、就绪后补写）、路由 5xx（带 `METHOD 路径 + IP + errText`）都不再只进 stdout。
   - **错误详情统一走 `errText(e)`**（util.js）：`message + code/status/errno/syscall/address 标签 + cause 链（≤2 层）+ 堆栈顶部两帧`，压成单行；`HttpError`（预期内的用户可见错误）默认不带堆栈。适用 scheduler/recorder/storage/store/notify/http 助手等全部 error/warn 出口。
   - 去重防刷屏：更新「环境自检」与「检查对比」结果与上次相同不重复记录。
9. **通知**（D18）：同类事件按 `taskId+event` 60 秒去重；失败按 5/15/45 秒重试 3 次。
10. **扫描/一致性**（D19）：索引有而磁盘无 → `missing`；磁盘有而索引无 → 未登记，可导入；都不隐藏。
11. **鉴权**（D1）：`/config/users.json`（scrypt）+ HMAC 签名 Cookie `lg_session`；首次启动 `mode:'init'` 强制设密码；同一 IP 5 次失败锁 10 分钟。除 `/api/health`、`/api/auth/*` 外所有 `/api/*` 需登录，未登录返回 401 `UNAUTHORIZED`。

### 6.5.2 冻结端点（前端按此调用，`{ok,data}` / `{ok:false,error:{code,message}}`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 免登录 |
| GET | `/api/auth/mode` | `{mode:'init'|'login',lockRemainSec}` |
| POST | `/api/auth/init` | `{username,password}` |
| POST | `/api/auth/login` | `{username,password,remember}` |
| POST | `/api/auth/logout` / GET `/api/auth/me` / POST `/api/auth/password` | `{oldPassword,newPassword}` |
| GET | `/api/platforms` | `{items:[{id,name,tier,enabled,needCookie,cookieHow,cookie:{has,updatedAt,valid},qualities:[{id,label,note}],cap,active,note}]}` |
| GET | `/api/status` | `{stats:{recordingCount,activeCount,concurrencyCap,queuedCount,todayFiles,todayBytes,todayDurationSec},disk:{totalBytes,freeBytes,usedBytes,trashBytes},engine:{ffmpegAvailable,ffmpegVersion,tz,version,uptimeSec},recording:[TaskLite],waiting:[TaskLite],queue:[{id,name,reason}],recent:[LogLine]}` |
| GET | `/api/tasks` | `{items:[Task]}`（含 `live:{bytes,elapsedSec,currentFile,segmentIndex}`） |
| POST | `/api/tasks` | `{url}` 或 `{platform,roomId}` + 覆盖字段；重复房间 409 `DUPLICATE_ROOM` |
| POST | `/api/resolve` | `{url}` → `{platform,roomId,anchorName,title,avatar,liveStatus,online,qualityOptions,note}` |
| GET/PATCH/DELETE | `/api/tasks/:id` | PATCH 录制中改 quality/segmentMode/naming → 409 `RECORDING_LOCKED`（改值仅下场生效） |
| POST | `/api/tasks/:id/start\|stop\|pause\|resume\|check\|retry` | |
| POST | `/api/tasks/batch` | `{action:'start'\|'pause'\|'stop'\|'check'\|'delete',ids:[]}` → `{okIds,failed:[{id,message}],note}` |
| GET/PUT | `/api/naming` | `{profiles:[{id,name,fnTemplate,dirTemplate,options,binding:{type,value}}],activeId,variables:[{token,desc,example}]}` |
| POST | `/api/naming/preview` | `{fnTemplate,dirTemplate,options}` → `{lines:[{index,dir,file,fullPath,chars,bytes,fileNameBytes}],warnings:[]}` |
| GET/PUT | `/api/settings` | cookie 一律脱敏为 `{has,updatedAt}` |
| POST | `/api/settings/cookie` | `{platform,cookie}`；DELETE 同路径 `?platform=` |
| GET | `/api/settings/env` | `{tz,recordRoot,configDir,port,ffmpegAvailable,ffmpegVersion,version}` |
| GET | `/api/files` | `?view=platform\|date\|task&platform=&date=&taskId=&status=&q=&limit=&offset=` → `{total,items:[Session],summary:{missing,unregistered,trashCount,trashBytes}}` |
| POST | `/api/files/scan` | `{added,updated,missing,unregistered}` |
| GET | `/api/files/unregistered` / POST `/api/files/import` | `{paths:[]}` |
| POST | `/api/files/:id/remux` / POST `/api/files/merge` | `{fileId}` / `{sessionId}` → `{jobId}`（异步，进度走 SSE `files`） |
| POST | `/api/files/delete` | `{sessionIds?,fileIds?}` → `{movedToTrash,bytes}` |
| GET | `/api/files/:id/stream` / `/api/files/:id/download` | Range 支持 / `attachment` |
| POST | `/api/play` | `{fileId}` → `{playId,mode:'direct'\|'remux',url}`；忙时 429 `PLAY_BUSY` |
| GET | `/api/play/:playId/stream` / DELETE `/api/play/:playId` | fMP4 渐进流 / 手动释放 |
| GET | `/api/trash` / POST `/api/trash/restore` / POST `/api/trash/empty` | 回收站 |
| GET | `/api/logs` | `?level=&taskId=&q=&limit=200` → `{items:[LogLine],files:[{date,bytes}]}` |
| GET | `/api/events` | SSE：`event: log\|task\|files\|status`，15s `:ping` |
| POST | `/api/notify/test` | |

`TaskLite={id,name,platform,platformName,roomId,quality,qualityLabel,status,statusMessage,bytes,elapsedSec}`。
`Task` 在原契约基础上增加：`namingProfileId`、`overrides:{quality?,segmentMode?,namingProfileId?,customText?}`、`queueReason`、`lastError`、`segments[]`、`sessionId`。

### 6.5.3 Session / FileItem（文件库数据形状）
```js
Session = { id, taskId, platform, platformName, roomId, streamer, title,
  quality, qualityLabel, startedAt, endedAt, durationSec, bytes,
  status:'recording'|'done'|'partial'|'error', dir, relDir,
  segments:[FileItem], merged:FileItem|null, mp4:FileItem|null }
FileItem = { id, sessionId, kind:'segment'|'mp4'|'m4a'|'merged'|'unregistered',
  name, path, relPath, ext, bytes, durationSec, width, height,
  createdAt, completedAt, status:'ok'|'recording'|'missing',
  playMode:'direct'|'remux', playUrl, downloadUrl, segmentIndex }
```

### 6.5.4 设置模型增量
```js
Settings += {
  trashRetentionDays:7, deleteToTrash:true, logRetentionDays:14, logLevel:'INFO',
  playConcurrency:2, mergeOnStop:false, recordContainer:'ts',
  platformCaps:{douyin:4,bilibili:4,kuaishou:3,huya:3,douyu:3,xiaohongshu:2,weibo:2},
  platformEnabled:{...}, pollIntervalSec:60, startDelaySec:5, stopDelaySec:30,
  notify:{webhook,onStart,onEnd,onError,onDisk,onCookie,dedupeSec:60},
  naming:{activeId,profiles:[]}, customize:{}
}
```

### 6.5.5 前端（app/web/**）实现要求
- 入口 `app/web/index.html` → `app.css`（已从 `ui/index.html` 抽取，视觉唯一来源）+ `<script type="module" src="./app.js">`。
- hash 路由：`#/dashboard` `#/tasks` `#/files` `#/settings` `#/logs`；未登录时显示登录/初始化页（复用原型 `#loginPage` 结构与类名）。
- 轮询：当前页为 dashboard/tasks 时每 2s 拉 `/api/status`、`/api/tasks`；日志页用 SSE `/api/events`。
- 复用原型的类名与视觉：`card / card-h / toolbar / table / chip / plat xx / fl-item / side-tree / tnode / tabs / tab / tabpane / sw-row / switch / modal / player / toast`。
- 组件：`toast(msg,type)`、`confirmDialog({title,text,ok,onOk})`、任务新建/编辑/详情弹窗（统一单页网格表单，详情即编辑）、文件库（视图切换 + 整场行 + 展开分段 + 回收站/缺失入口）、播放器弹窗（`<video>` + 进度 + 倍速 + 全屏 + 分段列表 + 复制直链/转封装/合并）、设置 7 页签（命名规则页签调 `/api/naming/preview` 出预览）。
- 只允许原生 ESM，禁止任何 CDN / npm 资源（容器可能离线）。

## 6. 测试要求

`node app/test/run.js` 必须能在**没有 ffmpeg、没有网络**的环境下全部通过：
- naming 引擎：变量替换、未知变量、非法字符三种模式、截断、序号补零、目录展开、重名去重、预览。
- store：读写、并发写不丢数据。
- resolvers：URL 识别（离线用例）、错误分支（mock fetch）。
- recorder/media：使用 `app/test/fake-ffmpeg.mjs`（伪造 ffmpeg：忽略参数、按 `-f segment` 语义写递增文件、读 stdin 的 `q` 后正常退出）跑通"启动 → 分段轮转 → 优雅停止 → 分段收尾"全链路。
- server：启动后在随机端口跑一遍主要 API 的 smoke（不依赖 ffmpeg）。

实测（v0.1.14 复测）：`node app/test/run.js` → **PASS 269 ｜ FAIL 0**（含 6 项 web 视图守卫静态断言；无 ffmpeg、无网络）；
`node app/test/update-manager.mjs` → 全部通过（mock GitHub，离线）；
`node app/test/update-git-flow.mjs` → 全部通过（架构 B 容器更新链路，离线自建 git 场景）；
`node app/test/db-sqlite.mjs` → 82 通过（v1→v2 库作废重建等）；
`node app/test/check-docker.mjs` → ALL PASS（37 项：静态校验打包三件套 + 容器形态环境变量真起一次服务；宿主 8080 被占用时自动换端口冒烟）；
`node app/test/e2e-ui.mjs` → 真实浏览器端到端（需要 Edge/Chrome：登录流程、逐页渲染、切页竞态回归、SSE 与前端报错检查，缺浏览器时自动跳过）；
`node app/test/e2e-ffmpeg.mjs` → 真实 ffmpeg 录制链路（缺 ffmpeg 时自动跳过）；
`node app/test/e2e-douyin.mjs` → 抖音真实房间录制（需要真实 ffmpeg + 能访问抖音 + 有房间在播，否则自动跳过）。

---

## 7. 实现对照表（v0.1.0 实测，覆盖 §3/§4 中已过时的行）

§3/§4 是并行开发期的早期设计稿，落地时以下细节按本节为准（其余按 §6.5 冻结契约执行）。

### 7.1 实际文件清单

```
app/server/  server.js scheduler.js recorder.js media.js storage.js play.js naming.js
             store.js auth.js logger.js notify.js util.js
             resolvers/{index,bilibili,douyin,cn,direct,http}.js
app/web/     index.html app.css app.js api.js ui.js
             views/{dashboard,tasks,files,logs}.js
             views/settings/{index,tabkit,tab-rec,tab-naming,tab-platform,tab-notify,tab-security}.js
app/test/    run.js fake-ffmpeg.mjs fake-media.mjs e2e-ui.mjs e2e-ffmpeg.mjs e2e-douyin.mjs check-docker.mjs
```
（早期设计里提到的 `resolvers/index.js` 之外没有单独的 `resolvers/bilibili.ts` 等；`ui.js` 为新增的通用组件库；无 `http.js`，HTTP 层在 `server.js` 内。）

### 7.2 与 §3 端点表的差异（以本节为准）

| 端点 | 实际形状 |
|---|---|
| `GET /api/health` | `{status,version,uptimeSec,tz,ffmpeg:{available,version,ffmpegAvailable,ffmpegVersion}}`（无需登录） |
| `GET /api/status` | 追加 `recordRoot`、`stats.activeCount/queuedCount/concurrencyCap`、`engine:{available,version,ffmpegAvailable,ffmpegVersion,tz,uptimeSec,node,playConcurrency}`（两套字段名并存，前端读 `ffmpegAvailable/ffmpegVersion`） |
| `GET /api/auth/me` | `{username,user,authenticated,lastLoginAt,lastLoginIp,sessionExpiresAt}`（**必须叫 `username`**，前端鉴权门依赖它） |
| `POST/PATCH /api/tasks` | 接受 `overrides:{quality,segmentMode,namingProfileId,customText}` 与扁平字段两种写法；**`null`/`''` 表示恢复「跟随全局」**；录制中改这四项 → `409 RECORDING_LOCKED` 但 overrides 已保存、下一场生效 |
| `GET /api/tasks` | 每项含 `name`、`overrides`、`live:{bytes,elapsedSec,currentFile,segmentIndex}` |
| `POST /api/files/merge` | body `{sessionId}`（不是 `{ids}`），异步占位 `merging` → `merged` |
| `POST /api/files/delete` | body `{sessionIds?,fileIds?}` → `{movedToTrash,bytes}`；录制中返回 409 |
| `GET /api/files/unregistered` | `{items:[...]}` |
| `POST /api/settings/cookie` / `DELETE ?platform=` | 整条替换 / 删除键（走 `store.setCookie/clearCookie`，**不能**用 `updateSettings`——deepMerge 无法删键） |
| `GET /api/settings/env` | `{tz,recordRoot,configDir,port,ffmpegAvailable,ffmpegVersion,version}` |
| `GET /api/events` | SSE，`event: log\|task\|files\|status\|settings`，15s `:ping` |
| `PUT /api/naming` | 深合并：`profiles` 为数组时**整体替换**，`activeId` 直接覆盖 |

### 7.3 回放与录制要点（实测行为）

- 录制：`ffmpeg -f segment`，`-reset_timestamps 1`、`-segment_start_number` 续接；优雅停止写 stdin `q`，等收尾入库；大小轮转由轮询 `statSync` 触发（`-segment_time` 只是估算上限）。
- 目录与命名：`/data/{平台显示名}/{主播}/{日期}/{日期}_{主播}_{清晰度}_{序号}.ts`（如 `直链/真实录制A/2026-10-09/2026-10-09_真实录制A_001.ts`），序号从 `001` 开始，暂停恢复后续接不覆盖。
- 后处理（D5）：停止后按 `remuxToMp4` 自动把**每个分段**转封装成同名 `.mp4`（`-c copy`），产物挂在 `session.extras`（`kind:'mp4'`），同时把首个/单段的成品同时写入 `session.mp4`；`autoMerge` 打开时改为自动合并。合并整场（`POST /api/files/merge`，至少 2 段）产出 `_整场.ts`（`session.merged`），随后按 `remuxToMp4` 再转出 `_整场.mp4`（也进 `session.extras`）。
- `GET /api/files` 的每个场次都返回 `extras`，前端文件库据此显示「已生成 MP4 ×N」并在展开区列出 MP4 副本（可播放/下载/删除）——转封装与合并产物**不能只存在索引里而在界面上看不见**。
- `GET /api/status` 的 `recording[]` 用完整任务形状（含 `live:{bytes,elapsedSec,segmentIndex,currentFile,dir}`），前端总览的实时进度直接读它；`tasks[]` 仍是精简形状。
- 回放：MP4/M4A 直放（Range + `Accept-Ranges`），TS/FLV/MKV 走 `-c copy` → fMP4 渐进流（`-movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1`），失败降级 `-c:v copy -c:a aac`；`playConcurrency` 默认 2，超出 429 `PLAY_BUSY`（测试已覆盖）。
- 磁盘保护：录制开始前检查剩余空间，低于 `diskLimitGB` 时拒绝开录并把「磁盘剩余 X 低于阈值 Y」写进任务状态与日志。
- 抖音解析（2026-10 实测，v0.1.10 复测）：**优先走移动端接口** `webcast.amemv.com/webcast/room/reflow/info/`（带 Android 客户端 UA + 公共参数），**无需任何 Cookie** 即可拿到房间元数据；`webcast/room/web/enter/` 是**权威的开播状态与 HLS 流路径**（短号 web_rid + 首页匿名 ttwid + a_bogus 签名，匿名可用，实测 200），档位映射与移动端同名因此复用同一套 `QUALITY_KEYS`；移动端元数据兜底；页面兜底（`RENDER_DATA`/内嵌 flv）已失效但保留。
- 抖音房间号有两套 ID，分工不同：**19 位内部房间号**（`live.douyin.com/<19位>`）走移动端接口免登录解析；**短号（web_rid，数字或文字抖音号）** 走 web/enter（匿名 ttwid 可用）。两路都失败时才报错：短号报 `ROOM_ID_FORMAT`（HTTP 400，引导粘贴分享链接 / 填 Cookie / 用直链），19 位号报 `BLOCKED`（HTTP 502）——**不能**把解析失败当成"未开播"静默轮询；仅当接口明确返回 `10011`（未开播或房间无效）时才按未开播处理，任务转 `waiting` 继续等待开播。
- 解析器给出的具体原因（如「移动端接口 10011：未开播或房间号无效」）必须优先于平台通用说明显示：`resolveRoom()` 返回 `note: info.note || p.note`，平台通用说明另存 `platformNote`。
- 平台信息接口被风控/废弃时必须报错而不是静默降级：B站 `xlive/web-room/v1/index/getInfoByRoom` 已返回 `code=-352`，改用 `room/v1/Room/get_info` + `live_user/v1/UserInfo/get_anchor_in_room`；房间信息接口返回非 0 code 时抛 `BLOCKED`（旧实现不校验 code，会把 20/20 正在直播的房间判成「未开播」，已修并有回归断言）。
- 空回放/空磁盘等异常都不许静默：`GET /api/files` 的 `summary.missing/unregistered` 与回收站计数必须如实返回。
- 扫描一致性（D19）：`POST /api/files/scan` 返回 `{added,updated,missing,unregistered,cleaned,total}`。**幽灵"未登记"条目必须被清理**：① 文件已从磁盘消失；② 该路径已归属某个场次（转封装/合并产物可能先被一次扫描记成"未登记"、随后又被登记为场次产物——旧实现是 `filter(... || true)` 空过滤，会让幽灵条目永久挂在文件库）。登记产物时（`remux`/`mergeSession`）也立即按路径清掉同名外部条目。
- **同一任务任一时刻只能有一个录制作业**（真实事故：2026-10-09 兰知春序，两个 ffmpeg 同时写同一个分段文件）。启动流程里有多个 await（保存场次、探测流、拉起 ffmpeg），而 `task.status='recording'` 只在 await 之后才写入，调度 tick（默认 5s）与「手动开始录制」并发进入时会各自起一个 ffmpeg。修复：`_startRecording` 变幂等外壳（同步占位的 `starting` 集合 + `recorders`/状态双保险），重复调用返回 `{already:true}` 并写 WARN 日志；分段模式的重名检测改为"目录里任何以该基名开头的文件都算占用"（旧实现只判断 `base+首个序号`，会选中已被占用的 `_2` 后缀并把上一场分段同名覆盖）。两者都有回归断言（`testConcurrentStart` / `testRepeatSessionNaming`）。

- **0 字节空分段必须清理**：ffmpeg 在分段轮转/停止的瞬间会先创建下一个分段文件再退出，留下 0 字节残渣。`_onSegmentClose` 对 `bytes<=0`（含磁盘实际 0 字节）的分段写 WARN 日志并删除文件，不登记进文件库——否则它会以"未登记文件"身份永久挂在文件库（真实 ffmpeg 端到端实测发现）。recorder 侧 `_tick`/`_finalize`/`pause` 共用 `_dropEmptySegments()` 也在源头清理。0 字节没有数据，删除不算静默丢数据。
- **页面显示从简、口径必须写在页面上**：顶栏只在有内容时出现（`录制中 N 路 / 上限 M`、`排队 N`、`等待开播 N`），空闲时不显示「并发 0/8」，也不再显示 `ffmpeg version … Copyright …` 这类长串（ffmpeg 细节进「运行日志」页与启动日志，日志里也只留第一行、去掉 Copyright 段）。总览页只保留：3 张统计卡、正在录制、排队/等待开播，且**正在录制与排队/等待开播改为上下整宽排布**（不再左右分栏，每块拉通全宽）；**磁盘信息只在总览统计卡展示一次**（侧边栏左下角「存储 …/… GB」文案与进度条、原第二张"磁盘占用"甜甜圈卡都已删除）；总览页**不再显示「统计口径」长文案**（口径收敛到各统计卡副标题与本文档）、**引擎信息卡已删除**、**左上角品牌副标题「抖音 · 哔哩哔哩 自动分段录制」已删除**、**时区不再在前台显示/修改**（侧边栏 TZ chip 与「系统设置 › 录制与存储」的时区只读项都已移除；默认 `Asia/Shanghai`，Docker 里由 compose 的 `environment: TZ` 提供，进程内 `if (!process.env.TZ) process.env.TZ = 'Asia/Shanghai'` 兜底——该赋值必须在任何时间格式化之前）。总览页不再有「最近事件」面板，事件改由「运行日志」页展示（同一份日志环，默认**最新在前**，可切换）。统计口径（后端实现一致）：「今日」= 服务器当天 00:00 起算，跨天会话按**单个文件**归属到收尾那天（`todayStats()` 按 `completedAt` 的 TZ 日键过滤，不再按场次整体归属）；「录制时长」= 当日各分段实际时长累加（非墙钟），转封装/合并等派生文件只计文件数与体积、**不重复计时长**；「并发」= 正在运行 ffmpeg 的任务数（`activeCount()` 排除已暂停）；磁盘读自 `RECORD_ROOT` 挂载点。断言见 `testTodayStats` 与 `e2e-ui`（`dashboard 磁盘占用只出现 1 次`、`dashboard 已删除引擎信息卡片`、每页 `左下角已无「存储」磁盘文案`、`不再出现「统计口径」/「时区」/「TZ 」/「最近事件」/「ffmpeg version」/「Copyright」/「并发 0/」`、`settings 不再出现「平台并发上限」`、每页 `侧边栏已无时区 chip` 与 `左上角品牌副标题文案已删除`）。
- **平台设置收敛**（2026-10 定版）：① 平台级「并发上限 / 启用」**只在「系统设置 › 平台账号」一处**展示与编辑，「录制与存储」的「平台并发上限」整卡已删除（不再重复）；② 平台账号里「可用清晰度」改成紧凑显示（最多 3 个短名 + `等 N 档`，完整列表放 `title` 提示），不再堆一长串 chip；③ 在平台账号里停用某平台后，**任务页的新建/编辑表单与筛选下拉里不再出现该平台**（添加被隐藏；编辑一条已存在的该平台任务时仍保留其平台以便可编辑，不会把任务"卡死"）；④ 稳定性/分层的英文代号（`stable`/`experimental`/`planned`）**前台一律不显示英文**：平台名后的分层 tag 与「稳定性」列都走统一的 `tierName()` 中文映射（稳定/实验性/规划中），稳定性列的详细说明折成悬停 `title`、平时不占行高（改动在此边界内有断言：e2e 校验 `#tabHost` 文本里没有 `stable`）。
- **「最近事件」没有独立页面**：早期方案曾是左侧导航独立页（`views/events.js`，v0.1.0 前后），后已删除并入「运行日志」页——事件与日志同一份日志环，默认**最新在前**，可切换顺序；「运行日志」页即唯一入口（过滤 / 排序 / 导出 / 保留策略 / 实时追加）。
- **视图的异步绘制必须走本视图的 `boundRoot`，禁止按 id 直取 `#view`**（2026-10-16 定版）：路由切换时 `handleRoute` 先 `stopView()` 作废旧视图（DOM 留着避免闪烁）再挂载新视图；每次渲染注入的 `ctx` 由 `makeViewCtx(token)` 生成，`ctx.isActive()` 表示该视图是否仍是当前活动视图，`ctx.onRefresh()` 也只对仍活动的视图生效。凡 `await` 之后再写 DOM 的视图都必须自查（`if (!boundRoot || !isActive(ctx)) return;`），否则迟到的绘制会覆盖新页面（历史症状：切到「运行日志」后视图里出现设置页页签、切到「设置」后被总览整页覆盖、旧视图的 `onRefresh` 把新视图的轮询刷成空转）。两层防线：`testViewGuards`（静态扫描——视图不得 `getElementById('view')`、用 `boundRoot` 的视图必须导出 `destroy()`、`app.js` 必须注入绑定 token 的 ctx 门面）＋ `e2e-ui` 的两条「切页竞态回归」（页面内把 `/api/settings`、`/api/status` 各延迟 800 ms，200 ms 后切页，断言目标页未被覆盖；临时停用守卫可稳定复现失败）。

### 7.4 已验证 / 未验证（诚实边界）

- 已验证：全部后端逻辑（269 项断言，含假 ffmpeg 的完整录制链路 + 6 项 web 视图守卫静态断言）、HTTP 冒烟（真实进程、47 个端点）、真实浏览器端到端（登录页→密码→控制台、退出后错密码提示、6 个页面渲染内容（总览 / 任务 / 文件库 / 设置 / 运行日志 / 回收站，无独立事件页）、设置页内切到「平台账号」页签核对、两条切页竞态回归、无前端报错、SSE 未登录 401 / 登录后 `event: status`）、原型 DOM 自检（52 项）。
- 已验证（真实 ffmpeg，41 项）：本地造 3 路直播流 → 真实分段录制（时间/大小轮转、ffprobe 校验时长与编码、命名规则落盘）→ 暂停/恢复序号续接 → 停止收尾与自动转封装 MP4（ffprobe 校验 h264 1280×720）→ 合并整场时长与分段之和相符 → 回放（MP4 Range 206 + TS fMP4 `ftyp/moof/mdat`）→ 重扫描 `added/missing` 为 0 → 回收站往返 → 磁盘保护 → 无头浏览器核对文件库渲染出 MP4 副本且无前端报错。
- 实测（真实外网，2026-10）：
  - **抖音免登录录制（22 项断言，`app/test/e2e-douyin.mjs`）**：匿名 feed 找在播房间 → `settings.cookies` 为空解析出主播/标题/在线人数/live → 原画档 `FULL_HD1` → 真实调度器录出 `抖音/<主播>/<日期>/<日期>_<主播>_原画_001.ts`（ffprobe：h264 1920×1080）→ 按 15 秒轮转到第 2 段 → 停止后自动转封装 MP4（h264）→ 文件库登记（`platform:'douyin'`、段数 2）。同时验证 `10011` 按未开播处理、全挂时报 `BLOCKED` 且给出 Cookie/直链两条出路。
  - **该套件必须对"上游限速"免疫（2026-10-09 复测发现）**：抖音匿名拉流实测会被限速（轮询期间字节数连续 24 s 持平在 1835008 不动），而 `-segment_time` 按**流时间**切分，所以轮转在墙钟上可能晚到 40 s+。因此：轮转等待放宽到 90 s 并打印"检测到拉流限速"提示；MP4 时长断言不再用固定秒数，改为**"至少覆盖最长分段、未被截断"**（`mp4Dur >= maxSeg - 2`），因为 ts 容器对被"停止"截断的最末分段会高估时长（实测 MP4 16.0 s / 最长分段 16.0 s / 分段合计 17.3 s）。这两处改动只是去掉对上游网速的隐式依赖，不放宽任何录制正确性判据（仍有：轮转段序 ≥2、磁盘 ≥2 个 .ts、MP4 含 h264 视频流、文件库登记）。
  - **B站匿名可用**：`room/v1/Room/get_info` + `live_user/v1/UserInfo/get_anchor_in_room` + `xlive/web-room/v2/index/getRoomPlayInfo` 无需 Cookie 即可拿到真实 flv 地址并拉流成功（真实 ffmpeg 4 秒，h264 540×960 3072 kb/s）。
  - **抖音 web 接口匿名可用（v0.1.10 复测修正）**：`webcast/room/web/enter/` 用短号 web_rid + 首页匿名 ttwid + a_bogus 签名即可返回有效房间数据与 HLS 流（实测 200）——早期（v0.1.0 前后）实测的 `status_code=4001038` 需登录态结论已不成立，web/enter 现在是短号的权威解析路径；页面兜底仍失效（`RENDER_DATA` 已移除、房间页内嵌 `.flv/.m3u8` 命中数为 0、`LIVE_SSR_DATA_ID` 只含 AB 配置）。
- 已验证（真实外网直播间的真实录制，2026-10-09）：抖音「兰知春序」（19 位房间号 `7694422853944462115`）免登录录制真实落盘 —— `data/抖音/兰知春序/2026-10-09/` 下产出完整分段（原画档，329 MB / 1080×1920），随后的重启恢复、分段收尾入库、暂停都正常。**同时暴露并修复了两个真 bug**：① 调度 tick 与手动开始并发导致同一任务起两个 ffmpeg 写同一文件（日志实锤 `忽略重复启动`）；② 重名检测遗漏"基名已派生其它分段"导致新一轮录制同名覆盖上一场分段（修复后新会话自动改用 `_3` 前缀）。事故期间的产物 `..._2001/2002/2003.ts` 是双进程写入的混乱文件，已保留在磁盘上供人工清理，未做自动删除。
- 未验证：**抖音移动端接口之外的自研解析**（快手/虎牙/斗鱼真实房间）、**小红书/微博**（未接入）、**Docker 镜像构建**（开发机无 Docker）。需在部署宿主机上确认。
- **运维红线（接访时实测踩过一次）**：不要强杀 node 进程。Windows 的 `Stop-Process -Force`＝`TerminateProcess`，不触发服务的 `SIGTERM/`SIGINT`，正在录制的分段会被直接截断成一个没有转封装的 `.ts`（数据不丢：下次启动扫描登记为「未登记」→ 文件库「导入」后「转封装」可补 MP4）。正确的停止方式：Docker 用 `docker compose stop`、本机用 `start-local.cmd` 的 Ctrl+C，二者都走 `shutdown('SIGTERM'/'SIGINT')` 优雅收尾（先落最后一段再转封装再退出）。曾经强杀导致了一段真实 251 MB 录制未转封装，已用同款 ffmpeg 参数手工补转出 230.8 MB / 6:26 的 MP4（`-c copy -movflags +faststart`）。
