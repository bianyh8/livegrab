# LiveGrab 数据库存储重架构方案（SQLite 唯一存储 · v2-final）

> 状态：**设计方案（已实现并通过验证）**
> 基线：Node v24（ESM）；Windows 本地 / NAS 部署；重构前旧服务运行于 8080 端口、写 `config\state.json`（该端口现已停止，`state.json` 已删除）。
> 核心变化：**全新空库起步，无 state.json、无导入、无迁移；旧数据用户自行处理。**
>
> **实施落地情况（已完成）**：`app/server/db.js`（18 张表 v2 schema + `SCHEMA_VERSION=2`）、`app/server/store.js`（内存态 + 行级 SQL 写穿透）、`app/server/legacy-cleanup.js`（一次性旧 JSON 清理，可整段删除）；`app/server/migrate.js` 与 `app/scripts/*`、`package.json` 的 `migrate`/`check:db` 脚本、`LIVEGRAB_MIRROR_JSON` 镜像逻辑均已删除；`config/state.json` 已清除，首启即建全新空库。
> 实施相对本文档 DDL 的少量**增补**（均为「代码是文档超集」，无遗漏项）：单行表增加主键 `id`；`naming_profiles` 把 `options` 完整展开为 5 个 `options_*` 列；`tasks` 增加 `reconnect_max`；`trash_files` 用 `file_id`（等价文档中的 `id`）并增加 `trash_path`；`cookies` 增加 `updated_at`（`valid` 由 `value` 派生、不落列）。逐项对照见《重构完成报告.md》第 3 节。

---

## 0. 决策记录（用户逐项拍板，均为最终结论）

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 存储主从 | **SQLite 唯一主存储**（`config/livegrab.db`）；应用直接读写 SQLite；彻底删除 state.json 镜像与"内存→DB→JSON"同步链 |
| 2 | 旧数据 | **不导入、不迁移**；全新空库起步；旧 JSON 由**独立方法** `cleanupLegacyFiles()` 一次性删除（下次不需要时直接移除该方法） |
| 3 | data_json | 全部废除，`tasks`/`sessions`/`files` 全拆列；嵌套结构拆子表 |
| 4 | 直播地址 | 统一推导为可访问地址，存 `tasks.source_url`（所有平台一个推导函数） |
| 5 | 主播名 | 双列：`anchor_name`（用户定义/生效）+ `platform_anchor_name`（平台名）；展示用户定义优先 |
| 6 | 预览/刮削 | `files` 加两列：`thumbnail_path`（海报/首帧图路径）+ `scrape_path`（刮削 .nfo 路径）；**不建 scrapes 表** |
| 7 | quality_fallback | 存逗号串（如 `origin,bluray,uhd,hd,sd`） |
| 8 | cookies | **明文入库**（`cookies` 子表，value + ttwid；与旧 JSON 同安全级别） |
| 9 | 冗余清理 | 删 `task.avatar`(URL)/`task.segments` 死字段/`settings.env`/`__ttwid`/`configDir`/`file_relations` 表 |
| 10 | 驱动 | better-sqlite3（Node 24 / Windows x64） |
| 11 | 回收站 | `trash` + `trash_files` + `trash_sessions`（会话主体快照拆列，恢复时主播信息随行重建） |
| 12 | 功能范围 | P1–P4 优先；`keepSource` 不变；不做内容去重；数据管理 UI 后续 |

---

## 1. 目标架构

```
config\
  livegrab.db          ← 唯一持久化真相源（18 张表，WAL）
  livegrab.db-wal / -shm ← 运行时生成
  state.json           ← 新代码启动时直接删除（旧数据，不保留）
  meta\...             ← 头像/元数据缓存（不变）
  logs\...             ← 不变
```

```
┌──────────────────────────────────────────────────┐
│  SQLite（livegrab.db）＝唯一持久化真相源            │
│  无 state.json 读写；无 data_json 列；无迁移逻辑    │
├──────────────────────────────────────────────────┤
│  Store 内存模型 ＝ 运行时缓存/工作集                 │
│  启动 loadFromDb() 全量加载                        │
│  每次变更：同方法内「SQL 事务写库 + 更新内存」       │
│  （写穿透，单写路径，无二次写入）                    │
├──────────────────────────────────────────────────┤
│  API 读内存缓存（与库一致）；Scheduler 高频操作不变   │
└──────────────────────────────────────────────────┘
```

- 启动即空库 → 以 `DEFAULT_SETTINGS` / 空任务 / 空会话初始化并建表，全新可用。
- 不读、不写、不删 `state.json`；不兼容 v1 旧库（`SCHEMA_VERSION = 2`，检测到旧库直接作废重建）。

---

## 2. 表结构（完整 DDL，18 张表）

```sql
PRAGMA journal_mode = WAL;          -- NAS 不支持时 openDb 自动回退 DELETE
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ── 元信息 ─────────────────────────────────────
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,           -- schema_version | db_created_at
  value TEXT NOT NULL
);

-- ── 全局配置：单行 24 列（无嵌套、无 JSON）─────
-- record_root / config_dir 为运行时环境，不入库
CREATE TABLE settings (
  max_concurrency INTEGER, default_quality TEXT,
  quality_fallback TEXT,             -- 逗号串 'origin,bluray,uhd,hd,sd'
  default_segment_mode TEXT, default_segment_minutes INTEGER, default_segment_size_mb INTEGER,
  record_container TEXT, remux_to_mp4 INTEGER, keep_source INTEGER,
  auto_merge INTEGER, merge_on_stop INTEGER, reconnect_max INTEGER,
  poll_interval_sec INTEGER, start_delay_sec INTEGER, stop_delay_sec INTEGER,
  disk_limit_gb INTEGER, retention_days INTEGER, delete_to_trash INTEGER,
  trash_retention_days INTEGER, log_retention_days INTEGER, log_level TEXT,
  play_concurrency INTEGER, proxy TEXT, user_agent TEXT
);
CREATE TABLE platform_caps    (platform TEXT PRIMARY KEY, value INTEGER);   -- douyin/bilibili/... 每平台一行
CREATE TABLE platform_enabled (platform TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE notify (webhook TEXT, on_start INTEGER, on_end INTEGER, on_error INTEGER,
                     on_disk INTEGER, on_cookie INTEGER, dedupe_sec INTEGER, retry INTEGER);  -- 单行
CREATE TABLE security (session_days INTEGER, fail_limit INTEGER, fail_lock_min INTEGER, trust_lan INTEGER); -- 单行
CREATE TABLE cookies (platform TEXT PRIMARY KEY, value TEXT, ttwid TEXT);   -- 明文（决策 8）
CREATE TABLE customize (key TEXT PRIMARY KEY, value TEXT);

-- ── 命名 ───────────────────────────────────────
CREATE TABLE naming (active_id TEXT);   -- 单行
CREATE TABLE naming_profiles (
  id TEXT PRIMARY KEY, name TEXT,
  fn_template TEXT, dir_template TEXT,
  options_illegal TEXT,                 -- 原 options.illegal
  binding_type TEXT, binding_value TEXT
);
CREATE TABLE naming_variables (token TEXT PRIMARY KEY, desc TEXT, example TEXT);

-- ── 任务：全拆列（无 data_json）────────────────
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT '',
  short_id TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',          -- 统一推导后的可访问直播地址
  anchor_name TEXT NOT NULL DEFAULT '',         -- 用户定义/生效主播名（展示优先）
  platform_anchor_name TEXT NOT NULL DEFAULT '',-- 平台显示名
  title TEXT NOT NULL DEFAULT '',
  avatar_file TEXT,                             -- 本地缓存头像路径（原 avatar URL 已删）
  quality TEXT, quality_actual TEXT, quality_label TEXT,
  segment_mode TEXT, segment_minutes INTEGER, segment_size_mb INTEGER,
  container TEXT, remux_to_mp4 INTEGER, keep_source INTEGER, auto_merge INTEGER,
  naming_profile_id TEXT, custom_text TEXT,
  auto_record INTEGER, monitor_only INTEGER, manual_held INTEGER,
  poll_interval_sec INTEGER, start_delay_sec INTEGER, stop_delay_sec INTEGER,
  status TEXT, status_message TEXT, queue_reason TEXT, last_error TEXT,
  retry_count INTEGER, reconnect_count INTEGER,
  started_at TEXT, ended_at TEXT, total_bytes INTEGER, total_duration_sec REAL,
  segment_index INTEGER, current_file TEXT, session_id TEXT,
  next_poll_at INTEGER, fail_count INTEGER, fail_notified INTEGER,
  live_status TEXT, name_locked INTEGER, platform_name TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_poll   ON tasks(next_poll_at);
CREATE INDEX idx_tasks_platform ON tasks(platform);

-- 任务级自定义（overrides 动态键 → 子表）
CREATE TABLE task_overrides (
  task_id TEXT NOT NULL,
  key TEXT NOT NULL,        -- quality / segmentMode / namingProfileId / customText ...
  value TEXT,
  PRIMARY KEY (task_id, key)
);

-- ── 会话：全拆列 + 成品指针 ────────────────────
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  platform TEXT, platform_name TEXT, room_id TEXT,
  streamer TEXT, title TEXT,                  -- streamer=主播名快照（不依赖任务）
  quality TEXT, quality_label TEXT,
  started_at TEXT, ended_at TEXT, duration_sec REAL, bytes INTEGER,
  status TEXT, dir TEXT, rel_dir TEXT,
  naming_profile_id TEXT,
  snap_anchor_name TEXT, snap_room_id TEXT,   -- 原 taskSnapshot 拆列
  merged_file_id TEXT, mp4_file_id TEXT,      -- 指针 → files.id
  created_at TEXT, updated_at TEXT
);
CREATE INDEX idx_sessions_task     ON sessions(task_id);
CREATE INDEX idx_sessions_streamer ON sessions(streamer);
CREATE INDEX idx_sessions_started  ON sessions(started_at);

-- ── 文件：一个物理文件一行（含 external）────────
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,                  -- 物理路径唯一 → 防"同名两份"
  session_id TEXT, task_id TEXT,              -- external: 两者 NULL
  kind TEXT NOT NULL,                         -- segment|merged|mp4|m4a|external|thumb
  name TEXT, rel_path TEXT, ext TEXT,
  bytes INTEGER, duration_sec REAL, width INTEGER, height INTEGER,
  status TEXT DEFAULT 'ok',                   -- ok|missing|recording
  segment_index INTEGER,
  source_file_id TEXT,                        -- 派生来源（mp4 ← 源 ts）
  thumbnail_path TEXT,                        -- 海报/预览图侧夹 <同名>.jpg（决策 6）
  scrape_path TEXT,                           -- 刮削元数据侧夹 <同名>.nfo（决策 6）
  created_at TEXT, completed_at TEXT, updated_at TEXT,
  deleted INTEGER DEFAULT 0
);
CREATE INDEX idx_files_session ON files(session_id);
CREATE INDEX idx_files_kind    ON files(kind);
CREATE INDEX idx_files_status  ON files(status);
CREATE INDEX idx_files_source  ON files(source_file_id);

-- ── 回收站：条目 + 文件快照 + 会话主体快照 ──────
CREATE TABLE trash (
  id TEXT PRIMARY KEY, kind TEXT,             -- session|file
  name TEXT, bytes INTEGER,
  deleted_at TEXT, expire_at TEXT,
  session_id TEXT
);
CREATE INDEX idx_trash_expire ON trash(expire_at);
CREATE TABLE trash_files (                    -- 回收站内文件快照（恢复时重建 files 行）
  trash_id TEXT NOT NULL, id TEXT, kind TEXT,
  name TEXT, path TEXT, rel_path TEXT, ext TEXT,
  bytes INTEGER, duration_sec REAL, width INTEGER, height INTEGER,
  status TEXT, segment_index INTEGER, source_file_id TEXT,
  thumbnail_path TEXT, scrape_path TEXT,
  created_at TEXT, completed_at TEXT
);
CREATE TABLE trash_sessions (                 -- 会话主体快照（恢复时重建 sessions 行，主播信息随行恢复）
  trash_id TEXT PRIMARY KEY, session_id TEXT,
  task_id TEXT, platform TEXT, platform_name TEXT, room_id TEXT,
  streamer TEXT, title TEXT, quality TEXT, quality_label TEXT,
  started_at TEXT, ended_at TEXT, duration_sec REAL,
  status TEXT, dir TEXT, rel_dir TEXT, naming_profile_id TEXT,
  snap_anchor_name TEXT, snap_room_id TEXT,
  merged_file_id TEXT, mp4_file_id TEXT
);
```

### 会话/文件视图重建规则（全查库，无 JSON）

| 视图 | SQL 语义 |
|---|---|
| 会话 `segments` | `files WHERE session_id=? AND kind='segment' ORDER BY segment_index` |
| 会话 `extras` | `files WHERE session_id=? AND kind IN ('merged','mp4','m4a')` |
| 会话 `merged` / `mp4` | join `sessions.merged_file_id` / `mp4_file_id` |
| 未登记 `external` 列表 | `files WHERE session_id IS NULL AND kind='external' AND deleted=0` |
| 任务最近首帧 | `thumbnail_path`（`<同名>.jpg`）或实时分段 |

---

## 3. 读写口径（与被拒镜像式方案的实质区别）

| 项 | 旧方案（作废） | 新方案 |
|---|---|---|
| 持久化 | state.json + SQLite 双写 | **仅 SQLite** |
| 写入 | persist() 全量同步 + JSON 镜像 | **行级 SQL 事务写穿透**（同方法写库+更新内存） |
| 读取 | API 读内存 | API 读内存缓存（启动全量加载，与库一致） |
| data_json | 有 | 无 |
| 旧数据 | 迁移/持续同步 | **不导入，全新空库** |

---

## 4. 直播地址统一推导（决策 4）

新增 `app/server/resolvers/room-url.js`：`buildRoomUrl(platform, { roomId, shortId, rawUrl })`。
创建/编辑任务解析后一律推导入库 `tasks.source_url`；调度器探测仍用原输入（存于 `room_id`/`short_id`，不丢信息）。

| 平台 | 推导地址 |
|---|---|
| douyin | `https://live.douyin.com/{roomId}` |
| bilibili | `https://live.bilibili.com/{roomId}` |
| kuaishou | `https://live.kuaishou.com/u/{shortId \|\| roomId}` |
| huya | `https://www.huya.com/{roomId}` |
| douyu | `https://www.douyu.com/{roomId}` |
| xiaohongshu | `https://www.xiaohongshu.com/{shortId \|\| roomId}` |
| weibo | `https://weibo.com/l/wblive/p/show/{roomId}` |
| direct | 原样 URL |

---

## 5. 冗余/臃肿数据清理清单

| 位置 | 字段 | 处理 |
|---|---|---|
| tasks | `avatar`（URL） | **删除**，只留 `avatar_file`（本地缓存路径） |
| tasks | `segments` | **删除**（死字段，代码从未写入） |
| tasks | `qualityFallback` | **删除**（随全局 `settings.quality_fallback`） |
| settings | `env` / `__ttwid` / `configDir` / `recordRoot` | **不入库**（运行时/进程缓存） |
| files | `scrape_json`（JSON 列） | **不用 JSON**，改为 `scrape_path`（.nfo 路径，决策 6） |
| 旧表 | `file_relations` | **删除**（`files.source_file_id` 已表达派生关系） |
| 旧表 | 各表 `data_json` | **删除**（全拆列） |

---

## 6. 部署与代码改动清单

### 6.1 删除 / 停用（不再存在）
- ~~`app/server/migrate.js`、`app/scripts/migrate-to-sqlite.mjs`、`app/scripts/check-sqlite.mjs`~~（核实 2026-10-13：这三份文件在本仓 HEAD 与全部提交历史中均不存在，无删除动作；实际删除的是本仓 `app/package.json` 中临时添加过的 `migrate`/`check:db` 脚本，以及 `LIVEGRAB_MIRROR_JSON`/`jsonMirror` 过渡逻辑与 `store.enableDb()` 的 JSON 镜像分支）
- `LIVEGRAB_JSON_MIRROR`、`jsonMirror` 过渡逻辑、`store.enableDb()` 的 JSON 镜像分支
- `store.js` 中 `readJson`/`writeJsonAtomic`/`syncStateToDb` 的持久化路径

### 6.2 重写
- `app/server/db.js`：v2 schema（上节 DDL），`SCHEMA_VERSION = 2`，`openDb`（WAL→DELETE 降级），保留 `setMeta`/`getMeta`/`schemaVersion`
- `app/server/store.js`：`Store.init()` 改为 `loadFromDb(db)`（从库全量加载 settings/tasks/sessions/trash/external）；所有 `saveTask/saveSession/addSession/removeTask/removeSession/addTrash/...` 写穿透到 SQLite（单事务）；`persist()` 移除 JSON 写，改为刷库（或直接废弃）

### 6.3 修改
- `app/server/server.js` `bootstrap()`：去迁移/镜像逻辑，openDb → 建表 → loadFromDb；**调用 `cleanupLegacyFiles()`**；`thumbFileFor`/`serveThumb` 落盘海报后回写 `files.thumbnail_path`
- `app/server/scheduler.js`：createTask/editTask 推导 `source_url` 入库；会话创建写入 `sessions` 全列
- `app/server/storage.js`：`writeArt()` 生成海报/nfo 后回写该代表文件行的 `thumbnail_path`/`scrape_path`；`moveToTrash` 按新 `trash`/`trash_files`/`trash_sessions` 拆列写入；`saveAvatar` 仅维护 `task.avatar_file`
- `app/server/resolvers/`：新增 `room-url.js`；各平台 resolver 保持返回 `{url, anchorName, title, avatar}`，调度器统一推导
- `app/server/legacy-cleanup.js`（新增）：`cleanupLegacyFiles()` 一次性旧 JSON 清理

### 6.4 旧 JSON 清理（独立方法，一次性）

新增 `app/server/legacy-cleanup.js`，导出 **`cleanupLegacyFiles(configDir)`**：

```js
// 一次性遗留清理：删除旧 JSON 状态与旧版备份（全新空库，不保留旧数据）
export function cleanupLegacyFiles(configDir) {
  // 1) 旧运行状态 state.json（存在即删）
  // 2) 旧版备份目录 config/backup-pre-sqlite/（含旧 state.backup json 与旧代码备份）
}
```

- `bootstrap()` 仅**一行调用**：`cleanupLegacyFiles(CONFIG_DIR)`。
- **下次不再需要清理时：删除 `legacy-cleanup.js` 文件 + 移除那一行调用即可**，不影响任何其它逻辑。
- 旧 v1 `livegrab.db` 作废重建由 `db.js` 的 schema 版本检测负责，**不**混入本方法。

---

## 7. 验证要点（下一次重启时）

1. 空库启动：首次启动即创建 v2 库并可用，任务/会话/文件均为空；启动后确认 `config/state.json` 与 `config/backup-pre-sqlite/` 已被 `cleanupLegacyFiles()` 删除。
2. 新建任务 → 任务行入库，`source_url` 为推导地址，主播名双列正确。
3. 开录 → 会话行 + 分段 files 行入库；停止 → 海报/nfo 生成并回写 `thumbnail_path`/`scrape_path`。
4. 前端：任务管理（头像/首帧）、文件库（主播名/平台/预览图）、回收站（恢复后主播信息随行重建）全部正常。
5. 统计：sidebar 任务/会话/占用字节与文件清单一致（P2）。
6. 注意：当前环境 PATH 无 ffmpeg，录制会 ENOENT——验证前先确认 ffmpeg/ffprobe 可用。
