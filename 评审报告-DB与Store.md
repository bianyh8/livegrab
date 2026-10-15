# 评审报告：`app/server/db.js`（表结构） + `app/server/store.js`（写穿透）

- 评审范围：`app/server/db.js`、`app/server/store.js`（两个文件为评审对象）。`app/server/server.js:122-132`、`app/server/storage.js`、`app/server/scheduler.js` 仅作为**调用点证据**引用，未纳入实现评价。
- 验收基线：`SQLite-重构方案.md`（307 行，未跟踪新增）。
- 评审方式：只读；除本报告外未新建/修改仓库内任何文件。临时探针脚本放在 `C:\Users\admin\AppData\Local\Temp\lgprobe\`，不在仓库内。
- 被评审版本（评审当时实测）：`app/server/store.js` 884 行 / 42319 字节 / SHA-256 `E1CD8FD470048BC557AB93BA458478A17D32962A416347695FEE4D1F216BC3E8`；`app/server/db.js` 357 行 / 12269 字节 / SHA-256 `AF8D252E7ECBD26F9773E2777BFE2325435E7FE0CBDC9E224EA9455BAAEBD20E`。
- **注意（版本漂移）**：评审过程中 `db.js` 被并发修改过一次（在 `db.js:334-335` 增加 `oldVer` + `console.warn` 两行，文件由 355 行变 357 行，mtime 03:12:07）。本报告所有 `db.js` 行号以**修改后的 357 行版本**为准；`store.js` 在评审期间未变化。若两文件再次变更，H2/M1/M3 等行号需重新核对（结论不变，但引用位置可能偏移）。

---

## ① 结论

**有条件通过**：SQLite v2 单写路径 +「先改内存、再行级写库」+ `persist()` 全量对账的主线设计成立，18 张表全部真实列（无 `data_json`）、写穿透字段完备、两套回归测试全绿（66/0、228/0）；但存在 **2 个高级问题**必须先修——`schemaVersion()` 吞掉一切异常导致「读库出错 = 判为旧库 = 直接删库」的不可逆数据丢失路径，以及 `files.path UNIQUE` 与 `file_upsert(ON CONFLICT(id))` 不匹配导致写穿透与 `persist()` 兜底会被同一份坏数据**永久同时毒化**——修掉这 2 项后即可通过。

| 级别 | 数量 |
|---|---|
| 阻断 | 0 |
| 高 | 2（H1、H2） |
| 中 | 5（M1–M5） |
| 低 | 9（L1–L9） |

---

## ② 逐项核查表

### 2.1 高级问题（建议合并前必修）

| # | 问题 | 级别 | 证据（file:line） | 建议修法 |
|---|---|---|---|---|
| H1 | `schemaVersion()` 捕获**所有**异常并返回 0；`openDb` 的判据是 `!== SCHEMA_VERSION`，于是「读 meta 出错」被等同于「旧版库」，直接 `rmSync` 删除 `db/-wal/-shm` 后重建空库。删库前无备份、无二次校验（仅有 `console.warn`），属不可逆数据丢失路径 | 高 | `app/server/db.js:298-305`（`catch { return 0 }`）、`app/server/db.js:333-346`（判据 + `fs.rmSync` + 重建）、`app/server/db.js:335`（仅 warn） | ①把「meta 表不存在」（空库/首次部署）与「读取抛错」区分开：能把文件 `new Database()` 打开且 `PRAGMA integrity_check` 通过时，**不得**删除；②删除前先 `rename` 为 `livegrab.db.bak-<timestamp>`；③仅在显式配置（如 `LIVEGRAB_ALLOW_DB_RESET=1`）下才允许删除 |
| H2 | `files.path` 是全局 `UNIQUE`（`db.js:200`），而 `file_upsert` 是 `ON CONFLICT(id)`（`store.js:135`）：当同一物理路径挂在两个不同 id 的条目上时必然 `UNIQUE constraint failed: files.path`。该异常发生在 `_writeSessionRows`（`store.js:554-559`）与 `persist()`（`store.js:515-535`）的**同一个大事务**内 → 整库回滚；而内存已先被改（`store.js:747-751`/`772-776`），于是内存与 DB 分叉，且**此后每一次 `persist()` 都会失败**（写穿透与兜底同时失效）。放大路径：`server.js:721-723` 关停时 `await store.persist()` 抛错 → `server.close()` 与 8 秒兜底 `setTimeout` 都不会执行，SIGTERM 无法退出（只剩 `server.js:727` 的 `unhandledRejection` 日志） | 高 | `app/server/db.js:200`、`app/server/store.js:135`、`app/server/store.js:554-559`、`app/server/store.js:515-535`、`app/server/store.js:747-751`、`app/server/server.js:721-723` | ①`file_upsert` 改为按路径归并（`ON CONFLICT(path) DO UPDATE SET ...`）或在写入前按 `path` 归一去重并告警；②`persist()` 改为**逐场次 try/catch + 收集失败清单**，避免一行坏数据毁掉整次落盘；③内存侧维护 `path → fileId` 唯一索引，重复登记时拒绝并告警；④写入失败时回滚内存（见 M1） |

### 2.2 中级问题

| # | 问题 | 级别 | 证据（file:line） | 建议修法 |
|---|---|---|---|---|
| M1 | `_tx()` 只保证 **DB** 事务：`this.db.transaction(fn)()`。所有 mutator 都是「先改内存、再落库」，落库抛错时内存保留新值 → 内存领先 DB；若在下次成功落盘前进程重启，该改动**静默丢失**（下一次成功的 `persist()` 会自愈，故平时不显现） | 中 | `app/server/store.js:510-512`；受影响写方法 `store.js:693-697/699-703/706-717/719-722/727-740/761-767/785-791/854-858/860-863` | `_tx` 内先快照将被改动的内存切片（或让 mutator 走「构造新对象 → 事务写入 → 提交后替换内存」），失败时恢复 |
| M2 | 无 db 时**静默不落库**：`persist()` 首行 `if (!this.db) return;`（不抛错），加上 15 处 `if (this.db)` 守卫，`init(db)` 又不校验入参 → 传 `null/undefined` 时所有写操作「成功返回」、无异常无日志，表现为服务正常但重启后全部丢失 | 中 | `app/server/store.js:516`、`349-356`、`695/701/715/721/739/749/757/765/774/781/789/839/847/856/862` | `init(db)` 内 `if (!db) throw new Error('store: 缺少 SQLite 连接')`；守卫收敛为一处构造期断言 |
| M3 | DDL 只在「重建分支」执行：`db.exec(DDL)` 位于 `if (schemaVersion(db) !== SCHEMA_VERSION)` 内。正常 v2 库打开时**不会**执行 `CREATE TABLE IF NOT EXISTS`，因此「已标记 v2 但缺表/半损坏」的库永远无法自愈 → `store.init()` 抛 `no such table: settings` → `main().catch` → `process.exit(1)` 启动崩溃循环 | 中 | `app/server/db.js:342`（DDL 在分支内）、`app/server/db.js:333-346`、`app/server/server.js:731-734` | 把 `db.exec(DDL)` 提到分支之外（`IF NOT EXISTS` 本身幂等），重建分支只负责删旧文件 + 写 meta |
| M4 | WAL 回退路径未校验同步级别：`journal_mode = WAL` 与 `synchronous = NORMAL` 在同一 `try` 内；回退分支只设 `journal_mode = DELETE`。而 better-sqlite3 的 `pragma()` 在文件系统不支持 WAL 时**不一定抛错**（可能只返回实际模式），此时会形成 `journal_mode=delete + synchronous=NORMAL` —— SQLite 文档明确该组合在掉电/OS 崩溃时存在损坏数据库的可能 | 中 | `app/server/db.js:286-295`；本机实测（P7）走 WAL 分支为 `journal_mode=wal, synchronous=1, foreign_keys=1` | `const mode = db.pragma('journal_mode = WAL', { simple: true })`；仅当 `mode === 'wal'` 时设 `NORMAL`，否则设 `FULL`，并把实际模式写日志 |
| M5 | `notify.retry` 类型漂移：写库用 `numOrNull(n.retry)`（存 1/0），读回时**不做** `!!`（同组 `on_start/on_end/...` 都做了）→ 重启后 `settings.notify.retry` 由 `true` 变为 `1`，再经 `settingsView()`（深拷贝后原样 JSON）返回前端 | 中 | `app/server/store.js:649`（写）、`app/server/store.js:372`（读）、`app/server/server.js:596-604` | 读回改 `retry: !!nrow.retry`，或写侧统一 `v ? 1 : 0` 并在读侧统一 `!!` |

### 2.3 低级问题

| # | 问题 | 级别 | 证据（file:line） | 建议修法 |
|---|---|---|---|---|
| L1 | `session.created_at` 语义被替换成 `startedAt`：`sessionToRow` 写 `created_at: strOrNull(s.startedAt)`，`rowToSession` 又把它读成 `createdAt`。而 `scheduler.js:347-353` 建场次时**不设** `createdAt` → 重启前 API 无该字段、重启后凭空出现 `createdAt = startedAt`（字段形状前后不一致）；若将来真正给 `createdAt` 赋值会被静默覆盖（实测 P8） | 低 | `app/server/store.js:273`、`app/server/store.js:292`、`app/server/scheduler.js:347-353` | sessions 表增独立 `created_at` 列并落 `s.createdAt`；或删除内存里的 `createdAt` 字段 |
| L2 | 预编译语句缓存无生命周期：`this._stmts = {}` 从不清理，`init()` 换连接时也不清 → 同一实例复用旧 Statement 会抛 `The database connection is not open`（实测 P4）。`Store` 类结尾（884 行）无 `close()`/`reset()` | 低 | `app/server/store.js:336-337`、`502-508`、`349-356`、`884`（类结束，无 close） | `init()` 首行 `this._stmts = {}`；补 `close()`：清缓存 + `this.db.close()` |
| L3 | 死代码/未使用导出：`getMeta()` 全仓零调用（`db_created_at` 只写不读）；`isEmpty()` 全仓零调用且 `catch { return true }` 会把「读取失败」谎报为「库为空」；`naming_variables_delete_all` 定义后从未使用 | 低 | `app/server/db.js:312-315`、`app/server/db.js:344`、`app/server/db.js:350-356`、`app/server/store.js:154` | 删除，或补调用点；`isEmpty()` 失败应抛错而非返回 `true` |
| L4 | 平台字典「默认值复活」：`loadFromDb` 把 `platform_caps/platform_enabled` 直接合并进 `DEFAULT_SETTINGS` 里的对象，而 `_writeSettings` 每次都 delete-all 重写 → DB 中被删除的平台键在重启后会以默认值重新出现 | 低 | `app/server/store.js:366-367`、`app/server/store.js:646-655` | 读库前先把两个字典置为 `{}`，或用默认值兜底循环（当前 UI 无删除平台键入口，**推测**无实际影响） |
| L5 | `trash_files` 列与方案不一致：方案为 `trash_id, id, kind, ...`，实现去掉 `id`、增加 `file_id` 与 `trash_path`，且无主键/唯一约束 | 低 | `SQLite-重构方案.md:189-190`、`app/server/db.js:237-258`、`app/server/store.js:594-608` | 方案文档同步为 `file_id + trash_path`；考虑 `PRIMARY KEY(trash_id, file_id)` |
| L6 | 约束弱于方案：方案声明 `tasks` 的 7 列（`platform/room_id/short_id/source_url/anchor_name/platform_anchor_name/title`）为 `NOT NULL DEFAULT ''`，实现无 NOT NULL/DEFAULT；`rowToTask` 对 `platform/status` 等无兜底 → 手工/异常写入 NULL 后内存出现 `null` | 低 | `SQLite-重构方案.md:108-114`、`app/server/db.js:105-155`、`app/server/store.js:197-216` | 按方案补齐 NOT NULL/DEFAULT；`rowToTask` 对关键枚举字段兜底（公开 API 无法触发，**推测**） |
| L7 | `settings.defaultMonitorOnly` 无列无默认：被 `scheduler.js:181`、`app/web/views/tasks.js:602` 读取，但 `DEFAULT_SETTINGS`（`store.js:11-50`）与 DDL（`db.js:24-50`）都没有 → 全局「仅监控」默认永远是 `false` 且无法持久化。**非本次回归**（HEAD 的 `DEFAULT_SETTINGS` 同样没有） | 低 | `app/server/store.js:11-50`、`app/server/db.js:24-50`、`app/server/scheduler.js:181`、`app/web/views/tasks.js:602` | 要么补列 + 默认值，要么删除这两处读取 |
| L8 | 判据被重复计算：分支内再调一次 `schemaVersion(db)` 取 `oldVer` 做日志，与判据两次查询，极端情况下日志与实际判据不一致 | 低 | `app/server/db.js:333-335` | `const oldVer = schemaVersion(db); if (oldVer !== SCHEMA_VERSION) { ... }` |
| L9 | 无进程级 checkpoint：全仓无 `db.close()` 调用（关停只 `await store.persist()` 后 `process.exit`），进程退出时 `-wal/-shm` 留在盘上（实测 P7：显式 `close()` 后两文件消失）。数据可恢复（下次打开重放 WAL），仅提示收敛性 | 低 | `app/server/server.js:711-724`、`app/server/store.js`（无 `close()`） | 在 shutdown 中 `store.close()`（配合 L2） |

### 2.4 强制核查项逐条答复

| # | 核查项 | 判定 | 依据 |
|---|---|---|---|
| 1 | DDL 相对方案是超集还是子集 | **超集**（18/18 表一致）。7 张表实现多列；唯一「方案有·实现无」的是 `trash_files.id`（被 `file_id`+`trash_path` 取代）；`tasks` 的 NOT NULL 约束实现**弱于**方案 | 见 2.5 差异表；`db.js` 与方案逐表比对（P-ddl 探针实测） |
| 2 | 是否残留 `data_json`／整包 JSON 存储；三大表是否全拆列 | **已全部废除**。`data_json` 仅出现在 5 处注释（`db.js:5,8,325`、`store.js:4`、`server.js:125`），DDL 与 SQL 语句中零出现；`file_relations`/`scrape_json` 在代码与方案中均不存在。`tasks`(49 列)/`sessions`(23 列)/`files`(21 列) 全部真实列；嵌套结构走子表 `task_overrides`、`trash_files`、`trash_sessions` | `grep data_json|file_relations|scrape_json app/server/*.js app/test/*.js` 结果仅注释；`db.js:16-284` DDL |
| 3 | 写穿透完备性：每个可变内存字段是否都有列/子表 | **完备**。静态扫描 `server/**` 全部 `task.x = / session.x = / file.x =` 赋值，得到 43/19/8 个字段名，与 `TASK_COLS`(48)/`SESSION_COLS`(22)/`FILE_COLS`(20) 比对后**无缺列**（`play.js` 的 `clients/proc/released`、`auth.js` 的 `lockUntil` 是播放会话与登录记录的误报；`server.js:601-602` 的 `cookies/env` 是 `settingsView()` 的深拷贝视图）。`DEFAULT_SETTINGS` 32 个顶层键中 `recordRoot/configDir` 故意不入库（`store.js:12-13`），其余全部有列或子表。唯一缺口是 L7 的 `defaultMonitorOnly`（既有问题） | `fields.mjs` 探针输出；`store.js:68-108` 列常量；`scheduler.js:242-248` 白名单 + `_overridesFrom` 白名单 |
| 4 | `persist()` 截断重写是否可能误删数据 | **不会误删「内存里有」的数据**（写入源就是内存）；会删除「DB 有而内存没有」的行，这正是方案 §3 的对账口径。FK 风险仅存在于 `trash_files`/`trash_sessions → trash(id)`，实测同事务内先删子表、重插父表、再插子表，CASCADE 未误删（P10：trash 1 / trash_files 1 往返一致）。**真正的数据分叉来自 H2**（整库回滚 + 内存不回滚），不是 `persist()` 删出来的 | `store.js:515-535`（顺序：settings→naming→tasks→overrides→files→sessions→external→trash→trash 子表）、`db.js:257,282`（FK）、P10 实测 |
| 5 | 事务与回滚：`_tx` 抛错后内存是否回滚 | **DB 侧回滚（ACID），内存侧不回滚**（M1）。另：`addTask/saveTask/addSession/saveSession/setFileThumbnailByPath` 不走 `_tx`，但均为单条语句（SQLite 隐式事务，原子）；组合写入（`files_delete_session` + N×`file_upsert`）由 `_writeSession` 的 `_tx` 包裹。`_stmt` 缓存永不失效（L2）。**未发现「部分写入」缺口，只发现「整库回滚 + 内存不回滚」缺口** | `store.js:510-512`、`554-563`、`749/757/774/781/839/847`；P2 实测 |
| 6 | 关闭重开往返保真度 | 回归套件 66/66 覆盖：任务+overrides、场次 `segments/extras/merged/mp4/taskSnapshot`、文件 `thumbnailPath/scrapePath`、外部文件回落 `unregistered`、回收站 `items/session`、设置、Cookie `valid`、`customize` JSON、settings 幂等、v1 作废。已知保真缺口：`session.createdAt`（L1）；回收站会话快照重开后无 `createdAt`，`qualityFallback` 亦未在 `trash_sessions` 中重建 | `app/test/db-sqlite.mjs`（66 项）；`store.js:263-294`、`445-484`、`587-621` |
| 7 | 与 HEAD 行为差异（有意的 vs 回归） | **无回归**。①`DEFAULT_SETTINGS` 顶层键与取值与 HEAD 完全一致（HEAD 也没有 `defaultMonitorOnly`）；②`deepMerge` 语义一致（返回新对象、数组整体替换、不改入参，`store.js:52-64`）；③`newTask()` 去掉 `avatar/segments/qualityFallback`（方案 §0 明确删除），新增 `platformAnchorName/overrides/nextPollAt/failCount/failNotified/liveStatus/nameLocked`——全部有对应列；④**`persist()` 语义有真实变化**：HEAD 是「JSON 原子写 + 串行链 + `catch` 吞错打印」，现在是「单事务全量对账 + 打印并**抛出**」（`store.js:531-534`）→ 调用方必须处理异常，`scheduler.js:480` 用 `.catch(()=>{})` 吞掉、其余 `await`，关停路径的后果见 H2 | `git show HEAD:app/server/store.js`（275 行）对比；`scheduler.js:53,480`、`server.js:269,611,721`、`storage.js` 8 处调用点 |
| 8 | `openDb` 返回 null／早退路径是否会让上层静默不落库 | `openDb` **无 null 返回路径**，只有「删除重建」路径。上层 `bootstrap()` 无 try/catch（`server.js:122-132`），`main().catch` → `process.exit(1)`，启动期存储异常是 fail-fast（可接受）。**静默不落库的风险来自 M2 的 `if (this.db)` 守卫，不来自 `openDb`** | `db.js:328-348`、`server.js:122-132`、`server.js:731-734` |

### 2.5 实现 DDL 与方案差异表

探针实测（`ddl-diff2.mjs`）：表集合 18/18 完全一致（`meta, settings, platform_caps, platform_enabled, notify, security, cookies, customize, naming, naming_profiles, naming_variables, tasks, task_overrides, sessions, files, trash, trash_files, trash_sessions`）。

| 表 | 方案列数 → 实现列数 | 实现有·方案无 | 方案有·实现无 |
|---|---|---|---|
| `settings` | 24 → 25 | `id INTEGER PRIMARY KEY CHECK(id=1)` | — |
| `notify` | 8 → 9 | `id`（同上单行主键） | — |
| `security` | 4 → 5 | `id` | — |
| `cookies` | 3 → 4 | `updated_at` | — |
| `naming` | 1 → 2 | `id` | — |
| `naming_profiles` | 7 → 12 | `options_date_format`、`options_seq_digits`、`options_time_format`、`options_dup_strategy`、`options_max_name_chars` | — |
| `tasks` | 48 → 49 | `reconnect_max`（并且方案声明 7 列 NOT NULL，实现未加） | — |
| `files` | 21 → 21 | 列集合相同，仅书写顺序不同 | — |
| `trash_files` | 18 → 19 | `file_id`、`trash_path` | `id` |
| 其余 9 表 | 完全一致 | — | — |
| 索引 | 11 → 12 | `idx_trash_files_trash` | — |
| 外键 | 0 → 2 | `trash_files.trash_id → trash(id) ON DELETE CASCADE`、`trash_sessions.trash_id → trash(id) ON DELETE CASCADE` | — |

差异判定：实现是方案的**超集**，除 `trash_files.id` 外不存在「方案要求但未实现」的列；新增的 `id` 单行主键列让 `WHERE id=1` 与 `ON CONFLICT(id)` 可用，属合理增强；方案 §0 提到的 `data_json`、`file_relations`、`scrape_json` 均已废除。

---

## ③ 实际执行的命令与观察到的结果

工作目录均为 `D:\10-应用数据\文档\deepseek-harness\LiveGrab\app`（Node v24.20.0，Windows，better-sqlite3 已安装）。

### 3.1 回归测试 1：`node test/db-sqlite.mjs`

```
EXIT=0
  OK  重开后 thumbnailPath 恢复
  OK  重开后 scrapePath 恢复（刮削信息）
  OK  重开后 taskSnapshot 恢复
  OK  重开后外部文件恢复为 unregistered
  OK  重开后回收站恢复(items/session)
  OK  重开后设置恢复
  OK  重开后 Cookie 恢复且 valid
  OK  重开后 customize 解析回对象
  OK  重开不会重复插入 settings
  OK  v1 库被作废重建为 v2 空库
结果：66 通过 / 0 失败
```

### 3.2 回归测试 2：`node test/run.js`

```
EXIT=0
  PASS  非法 JSON 返回 400  → 期望 400，实际 400
  PASS  未知接口返回 404  → 期望 404，实际 404
  PASS  服务已关闭
================ 结果 ================
PASS 228 ｜ FAIL 0
```

### 3.3 结构差异探针：`node ddl-diff2.mjs`（全文，节选关键行）

```
文档表(18): meta, settings, platform_caps, ... , trash_sessions
代码表(18): meta, settings, platform_caps, ... , trash_sessions
文档有·代码无: (无)    代码有·文档无: (无)

[settings] 文档24 / 代码25   代码有·文档无: id
[notify] 文档8 / 代码9       代码有·文档无: id
[security] 文档4 / 代码5     代码有·文档无: id
[cookies] 文档3 / 代码4      代码有·文档无: updated_at
[naming] 文档1 / 代码2       代码有·文档无: id
[naming_profiles] 文档7 / 代码12  代码有·文档无: options_date_format, options_seq_digits, options_time_format, options_dup_strategy, options_max_name_chars
[tasks] 文档48 / 代码49      代码有·文档无: reconnect_max
[files] 文档21 / 代码21      列集合相同，仅顺序不同
[trash_files] 文档18 / 代码19  文档有·代码无: id / 代码有·文档无: file_id, trash_path
索引 文档=11 代码=12  代码索引·文档无: idx_trash_files_trash
FK：文档=false 代码=true
  代码: FOREIGN KEY (trash_id) REFERENCES trash(id) ON DELETE CASCADE   ×2
```

（注：该探针的 `NOT NULL` 与 `meta` 两栏受方案注释文本干扰，属**解析伪影**，未采信；`meta.db_created_at` 在方案里只是注释中列举的 key 名（`SQLite-重构方案.md:70`），不是列，实现以 meta 行的形式写入，二者等价。所有约束结论均以源码 `db.js` 人工复核为准。）

### 3.4 行为探针：`node probe.mjs`（10 组，逐字粘贴观察结果）

```
===== P1 两个场次同路径 session_files → persist() =====
addSession#2 抛错: UNIQUE constraint failed: files.path
内存场次数=2，DB files 行数=1，DB sessions 行数=1
persist 抛出: UNIQUE constraint failed: files.path
persist 后 files 行数=1，sessions 行数=1
→ 结论：内存 2 场次，DB 只有 1 场次；此后每次 persist 都会因 UNIQUE(path) 整库事务回滚（写穿透与兜底同时失效）

===== P2 _tx() 抛错后的内存/DB 一致性 =====
写库异常: probe-fail
内存 logLevel=TRACE（DB 中=DEBUG）
用另一 Store 重读 DB：logLevel=DEBUG
→ 结论：_tx 无内存快照回滚，内存已被改（true），DB 未落 → 重启后该改动静默丢失

===== P3 DEFAULT_SETTINGS 全键关闭重开往返 =====
差异:
  platformCaps:   写前={...,"__probe":"v"} 重开={...,"__probe":0}
  platformEnabled:写前={...,"__probe":"v"} 重开={...,"__probe":true}
  notify:         写前={...,"retry":true,"__probe":"v"} 重开={...,"retry":1}
  security:       写前={...,"__probe":"v"} 重开={...}（自定义键未落库）
  cookies:        写前={"__probe":"v"} 重开={"__probe":{"value":"","ttwid":"","updatedAt":null,"valid":false}}

===== P4 _stmts 缓存在 db 关闭/替换后的表现 =====
换连接后 addTask: 抛错: The database connection is not open
同一实例再 init(db2): 抛错: The database connection is not open
→ 结论：_stmts 缓存不清空，旧 Statement 绑定已关闭的连接

===== P5 meta 表结构异常（读取抛错）时的 openDb 行为 =====
造库：schemaVersion() = 0（应为 0，来源=异常吞掉）
openDb 前目录: livegrab.db；max_concurrency=42
openDb 后表: cookies, customize, files, meta, ...（18 张全新空表）
设置行: []
→ 结论：读 meta 抛错被当成"版本不符"，旧数据被 rmSync 删除并重建空库

===== P6 schema_version=3 的库被 openDb 作废 =====
造库：version=3，tasks 行数=1
重开后 version=2，tasks 行数=0
→ 结论：非 2 的任何版本（含更高版本）一律删库重建，无备份/无提示

===== P7 PRAGMA 实测值与本机 WAL 文件 =====
journal_mode=wal synchronous=1 foreign_keys=1
目录文件: livegrab.db, livegrab.db-shm, livegrab.db-wal
close 后目录文件: livegrab.db

===== P8 session.createdAt 是否被 startedAt 覆盖 =====
写前 createdAt=2024-05-05T09:59:00.000Z startedAt=2024-05-05T10:00:00.000Z
重开 createdAt=2024-05-05T10:00:00.000Z startedAt=2024-05-05T10:00:00.000Z
→ 结论：createdAt 被 startedAt 覆盖（信息丢失）

===== P9 同场次内同路径不同 id 的文件 =====
addSession 结果：写入成功（sessionFiles 去重后仅 1 行）
files 行数=1（内存 segments 长度=2）persist 成功
（说明 sessionFiles 的 path 去重生效，未触发 UNIQUE 冲突）

===== P10 foreign_keys=ON 下 persist 全量重写的删表顺序 =====
trash 行=1 trash_files 行=1
persist 成功（trash_files 先删后写，FK CASCADE 未触发删除）
persist 后 trash 行=1 trash_files 行=1
```

### 3.5 DDL 分支探针：`node p11.mjs`

```
首次 openDb：版本=2，表数=18
v2 库删掉 settings 表后再 openDb：版本=2，settings 表存在=false
Store.init 抛错: no such table: settings
DDL 是否在正常(v2)分支执行过：否（只在 version!==2 的重建分支执行）
```

### 3.6 探针运行中捕获的两个失败输出原文（stderr）

首次运行 P1 时未捕获异常，直接暴露 `file_upsert` 的失败位置（同一异常在 H2 中即为整库回滚点）：

```
store.js:558
    for (const f of sessionFiles(session)) ins.run(fileToRow(session, f));
                                               ^
SqliteError: UNIQUE constraint failed: files.path
    at Store._writeSessionRows (.../app/server/store.js:558:48)
    at .../app/server/store.js:562:25
    at sqliteTransaction (.../better-sqlite3/lib/methods/transaction.js:65:24)
    at Store._tx (.../app/server/store.js:511:28)
    at Store._writeSession (.../app/server/store.js:562:10)
    at Store.addSession (.../app/server/store.js:774:23)
  code: 'SQLITE_CONSTRAINT_UNIQUE'
```

`persist()` 的失败日志格式（`store.js:531-534`，打印后**继续抛出**，与 HEAD 的吞错语义不同）：

```
[store] SQLite 落盘失败：UNIQUE constraint failed: files.path
[store] SQLite 落盘失败：The database connection is not open
[store] SQLite 落盘失败：probe-fail
```

`p11.mjs` 捕获到的删库告警原文（唯一提示渠道，`db.js:335`）：

```
[db] 检测到旧版/未知数据库（schema_version=0 ≠ 2），按设计作废重建为 v2 空库（原文件已删除，不保留旧数据）
```

### 3.7 仓库状态与写穿透静态扫描

```
$ git diff --stat
 app/docs/CONTRACT.md          |   4 +-
 app/package.json              |   4 +
 app/server/naming.js          |   2 +-
 app/server/resolvers/index.js |   2 +-
 app/server/scheduler.js       |  34 +-
 app/server/server.js          |  70 ++--
 app/server/storage.js         |  88 +++--
 app/server/store.js           | 751 ++++++++++++++++++++++++++++++++++++++----
 app/test/run.js               |  22 +-
 app/web/views/tasks.js        |   2 +-
 10 files changed, 819 insertions(+), 160 deletions(-)

$ git status --porcelain   # 未跟踪：SQLite-重构方案.md、app/server/db.js、app/server/legacy-cleanup.js、
                           # app/server/resolvers/room-url.js、app/test/db-sqlite.mjs、app/package-lock.json、
                           # 评审报告-接线与启动.md（他人报告）
$ Select-String -Path app/server/*.js,app/test/*.js -Pattern "data_json|file_relations|scrape_json"
db.js:5 / db.js:8 / db.js:325 / server.js:125 / store.js:4   ← 全部是注释
$ node fields.mjs
== newTask() 字段 vs TASK_COLS ==      （全部有对应列）
== 运行期 "task.xxx =" 赋值（共 43 个字段），无对应列者 == （无）
== 运行期 "session.xxx =" 赋值（共 19 个字段）== 仅 play.js 播放会话与 server.js settingsView 视图的误报
== 运行期 "file.xxx =" 赋值（共 8 个字段）== 仅 auth.js 登录记录误报
$ 未被使用的 SQL 键: naming_variables_delete_all
$ isEmpty / getMeta 调用点: 仅定义（db.js:312、db.js:350），零调用
```

### 3.8 版本漂移记录

评审过程中 `app/server/db.js` 被并发改动一次（`db.js:334-335` 新增 `oldVer` + `console.warn`，355 行 → 357 行）。评审结论基于改动后的 357 行版本；`app/server/store.js` 在评审期间哈希始终为 `E1CD8FD4…`（884 行）。

---

## ④ 无法验证的盲区

1. **NAS / 网络卷的真实 WAL 回退行为**（M4）：本机为 NTFS，实测走的始终是 `journal_mode=wal` 分支。无法确认在 SMB/NFS 上 `db.pragma('journal_mode = WAL')` 是抛错还是静默降级，因此「DELETE+NORMAL」是否真会出现标为**推测**。
2. **真实断电 / OS 崩溃下的持久性**：`synchronous=NORMAL` + WAL 的掉电语义无法在测试机上复现，未做掉电注入。
3. **多进程并发访问同一 `livegrab.db`**：本次未验证（单进程 better-sqlite3 同步 API 无并发问题；若将来有第二个进程写库，`SQLITE_BUSY` 与 `schemaVersion()` 吞异常的组合会显著放大 H1）。
4. **真实 ffmpeg 录制长跑 + 磁盘写满**：`SQLITE_FULL`/`EIO` 下 M1（内存不回滚）的实际后果未做端到端验证。
5. **H2 的可达性**：同物理路径挂两个不同 id 条目的**具体用户操作序列**未在 UI 全链路上复现（本报告用直接构造内存的方式确定其失败行为）。`storage.js:270` 的注释承认历史数据存在「同一物理文件被登记为多个条目」，但全新 v2 空库起步后能否经 `restoreTrash`（`storage.js:295-329`）与 `scan()` 重绑（`storage.js:99-113`）等路径自然产生，标为**推测**。
6. **生产旧库样本**：仓库内无 v1 `livegrab.db` 样本，H1 中「读取错误的真实成因」（文件损坏 / 权限 / 半写）只能用「meta 表结构异常」模拟。
7. **回收站还原的字段完备性**：`_loadTrash` 未重建 `entry.session.createdAt`，`trash_sessions` 也未落 `qualityFallback`；这些字段是否为还原路径所必需，取决于 `storage.restoreTrash` 与前端展示，本次未逐字段回归（只跑了既有 66 项用例）。
8. **Linux / arm64 / Docker 部署**：`better-sqlite3 ^13.0.3` 的 prebuild 可用性、容器内 `/config` 卷的 WAL 支持、时区/路径分隔符对 `_relOf()`（`store.js:579-585`，Windows 反斜杠归一为 `/`）的影响未验证。
9. **长期运行下的 `_stmts` 内存占用**：语句数量固定（约 30 条），未见泄漏，但未做长跑观测。
10. **范围外未评价**：`app/server/storage.js`、`scheduler.js`、`server.js` 的其余逻辑（含启动/关停接线）不属于本次评审对象；相关工作已由另一份 `评审报告-接线与启动.md` 覆盖，本报告对其仅作调用点引用。本报告也未评价方案文档本身的设计取舍（如「不迁移、旧库作废」）是否合理，只评价实现与该方案的偏离。
