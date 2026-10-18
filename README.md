# LiveGrab 直播录制台

自托管的**直播录制管理台**：自动监控直播间，开播即录、按策略分段、按规则命名入库，带完整 Web 管理界面。个人/小团队长期存档直播内容（切片、留档）用。

- **单容器 Web 服务**：浏览器访问 `http://<主机>:18080` 即可，全部操作在页面完成，无需桌面壳。
- **唯一 npm 依赖 `better-sqlite3`**（SQLite 存储，构建时 `npm ci` 安装），其余后端逻辑只用 Node 内置模块，ffmpeg 以子进程方式调度，前端为静态 ESM、无前端构建步骤。
- **免 Docker 也能跑**：本机装了 Node 22+ 与 ffmpeg 可直接运行（见 [本地运行](#本地运行)）。

---

## 功能特性

- **开播检测自动录制**：轮询直播间状态，开播自动拉流、下播自动收尾；可设「仅监控」只盯状态不录。
- **分段策略**：按时长 / 按大小分段，断线自动重连，停止时优雅收尾当前分段。
- **成品处理**：TS/FLV 分段转封装 MP4、整场合档、浏览器内置播放器回放（边转边播）。
- **手机播放**：手机上点文件直达全屏播放，控制条内一键「横屏」——点一下就横过来（旋转内层舞台，不判断设备方向；Android 上还会尝试真正锁定屏幕方向），再点一下回竖屏。
- **命名规则**：模板化文件名与目录结构（主播/平台/标题/日期/清晰度等变量 + 实时预览）。
- **文件库**：成品平铺浏览、搜索筛选、播放、下载、删除；删除默认进回收站（含刮削图片/描述）。
- **运行日志**：按级别/任务/关键字过滤，最新在前 / 实时追加。
- **通知**：Webhook 推送（开播、录制结束、磁盘不足等事件）。
- **系统更新**：「系统设置 → 系统更新」从 GitHub 拉取最新代码，对比本地版本并自动完成更新、重启服务。
- **安全**：管理员账号、会话策略、未登录拦截。

## 支持的平台

| 平台 | 自动解析 | 说明 |
|---|---|---|
| 抖音 | ✅ | 免登录解析高清流；短号自动映射内部房间号 |
| 哔哩哔哩 | ✅ | 官方公开接口 |
| 快手 | ✅ | 流地址需登录 Cookie |
| 虎牙 | ✅ | 免登录 |
| 斗鱼 | ✅ | 免登录 |
| 小红书 / 微博 | ➖ | 暂未接入自动解析，用「直链」任务粘贴 m3u8/flv 地址 |

平台为可插拔适配器，每个适配器声明能力与依赖（Cookie / 代理 / 清晰度档位），UI 由元信息驱动。

---

## 快速开始（Docker）

**前提**：目标机器装好 Docker（Linux 用 Docker Engine + Compose 插件；Windows/Mac 用 Docker Desktop）。

**① 克隆代码**
```bash
git clone https://github.com/bianyh8/livegrab.git
cd livegrab
```

**② 构建并启动**
```bash
docker compose up -d --build
```
> 镜像里已包含完整源码，**首次启动零网络**：不 clone、不装依赖、不联网，秒起。
> 启动日志只有一行 `[entrypoint] 启动服务：/app`（首次）或 `/config/src/app`（更新过的实例）。

**③ 打开页面**
```
http://<主机IP>:18080
```
首次打开会引导**初始化管理员账号**（设置用户名与密码）。

**④ 数据落盘位置**
compose 相对 `livegrab/` 目录挂载：

| 挂载点 | 内容 | 建议 |
|---|---|---|
| `./data` → `/data` | 录制成品与分段 | 占空间最大，挂到大容量磁盘 |
| `./config` → `/config` | 账号哈希、Cookie、任务、场次索引、日志、SQLite 库（livegrab.db） | 长期保留 |
| `./config/src/app` | 页面「立即更新」落位的新版本代码（更新过之后才存在） | 由容器管理，勿手改；删掉即回到镜像内置版本 |

### 环境变量（`docker-compose.yaml` 可调）

compose 里都有默认值，通常只有端口、时区、Token 需要改：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVEGRAB_PORT` | `18080` | 宿主机映射端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `PORT` / `RECORD_ROOT` / `CONFIG_DIR` | `8080` / `/data` / `/config` | 容器内端口与卷路径 |
| `LIVEGRAB_GITHUB_TOKEN` | （空） | **私有仓库**必备：GitHub Personal Access Token（`repo` 读权限）。用于版本检测与源码下载 |

> 分叉部署要换仓库/分支：直接改页面「更新源配置」（推荐，页面配置优先），
> 或在 compose 的 `environment` 里加 `LIVEGRAB_REPO` / `LIVEGRAB_BRANCH`。
> **代理没有环境变量**——统一在页面「系统设置 → 平台账号 → 网络代理」配一处：
> 录制拉流按「平台代理开关」决定用不用，页面「立即更新」配了就先走代理、失败自动改直连。
> 详见下文「更新与代理」。

## 更新与代理

### 点「立即更新」会发生什么

1. **查版本**：只读 GitHub API，取仓库所有标签里语义化版本最高的一个（不下载代码）；
2. **比版本**：远端**不高于**本地 → 日志写一条「已是最新版本 vX，无需更新」，结束，不下载、不重启；
3. **下载**：远端更高 → 下载该标签的源码归档 `codeload.github.com/<repo>/tar.gz/refs/tags/<tag>`；
4. **解包校验**：解到 `/config/src/.update-stage`，确认 `app/server/server.js` 与 `app/package.json` 存在，版本不低于本地；
5. **准备依赖**：`package.json` 的 `dependencies` 没变 → 软链镜像里的 `/app/node_modules`（零联网，原生模块 ABI 永远跟当前镜像的 Node 一致）；只有变了才 `npm install`；
6. **原子切换**：`.update-stage/app` → `/config/src/app` 用 `rename` 切换，失败自动回滚；旧目录留成 `app.old`（手动回滚点，下次更新时才替换）；
7. **自重启**：优雅停掉录制器与 HTTP，再以新目录为 `cwd` 重新拉起进程，页面自动刷新。

任何一步失败都**不会改动正在运行的代码**，服务继续录制，按钮变「重试更新」，直接再点一次即可。

为什么落在 `/config`：镜像层 `/app` 会被 `docker compose up -d --build` 重置，挂载卷里的代码不会。
所以**重建容器不会把版本打回去**，这也正是「更新结果能长期保留」的原因。

### 版本判定规则

- 只比语义化版本（`0.1.43` > `0.1.42`），**版本相同就不更新**，哪怕 main 上有新提交——否则每点一次都要重下一份同版本归档；
- 本地版本来源：更新过的实例读 `/config/src/app/.livegrab-version.json`（记录落位的标签版本），从没更新过的读镜像构建信息（`.build-info.json`）；
- 归档里 `package.json` 的版本与标签不一致时，以标签为准（避免「改了代码忘改版本号」导致反复提示更新）。

### 代理：只有一个入口

在页面「系统设置 → 平台账号 → 网络代理」填一个地址（如 `http://192.168.1.10:20171`），两条链路各自决定用不用：

| 链路 | 是否用代理 |
|---|---|
| **录制拉流 / 平台解析** | 由「平台代理开关」逐个决定：开了才走，关了一律直连 |
| **检查更新 / 立即更新** | 配了先走代理；代理失败**立刻改直连**并冷却 2 分钟；没配就直连 |

日志会明确写出走的是哪条路：

```
[更新] 检查更新的网络路径：经代理 http://192.168.1.10:20171
[更新] 更新网络路径：直连（未配置更新代理）
[更新] 代理不可用（代理 CONNECT 失败 …），本次改用直连；120 秒内不再尝试代理
```

三个容易踩的点：

- 容器内的 `127.0.0.1` 指向**容器自身**，不是 NAS。代理是独立容器且映射了端口 → 填 NAS 局域网 IP；与 livegrab 同一 compose 网络 → 填服务名（`http://clash:7890`，更稳）。设置页在容器内检测到回环地址会直接警告；
- 纯 SOCKS 端口要写 `socks5://` 前缀；
- 代理容器要开 `allow-lan`，否则局域网 IP 也连不上。

> 为什么代理不放进 compose：`ffmpeg` 会读 `HTTP_PROXY` 环境变量（实测 8.x 对 http/https 输入都生效），
> 一旦在容器上注入，用户在页面上关掉「平台代理开关」的平台也会被强制走代理，开关形同失效。
> 因此服务拉起 `ffmpeg` 时会主动剥离 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（含小写），
> 代理只由显式的 `-http_proxy` 参数决定（日志页可见对应命令行）。

### 私有仓库（Token）

`bianyh8/livegrab` 是私有仓库，检测版本和下载源码都需要 Token：

```bash
# 在 livegrab/ 目录建 .env（别提交到 git），写一行
echo "LIVEGRAB_GITHUB_TOKEN=ghp_你的token" > .env
docker compose up -d          # 重启使环境变量生效
```

- **Token 获取**：GitHub → Settings → Developer settings → Personal access tokens → 勾 `repo` 读权限即可；
- 只经容器环境变量注入，不写数据库、不随接口返回、不在页面展示；
- 也可以在页面「更新源配置」里填 Token（存本地 SQLite，随 `/config` 一起备份）；
- 未配 Token 访问**私有**仓库时，页面明确提示「私有仓库需要配置 GitHub Token」，不会误报有更新；**公开**仓库不会有任何 Token 提示。

公开 / 私有仓库的识别是自动的：先匿名读 GitHub API，404 且配了 Token 时再带认证重试。

### 重建镜像 vs 页面更新

| 变更类型 | 怎么做 |
|---|---|
| 业务代码（绝大多数版本） | 页面「系统设置 → 系统更新 → 立即更新」，约 10~60 秒，不动容器 |
| 换 ffmpeg / Node、改 Dockerfile、改入口脚本 | 宿主机 `git pull && docker compose up -d --build` |

重建后入口脚本按版本取新的那份：`/config/src/app`（上次更新落位）比镜像新就用它，镜像更新就用镜像。
所以**重建不会把版本打回去**；想彻底回到镜像内置版本：`rm -rf ./config/src && docker compose restart livegrab`。

`./config/src` 等于**可执行代码**：能写这个目录 ≈ 能在容器里执行任意代码，请按配置目录的密级对待。

### 常见问题

- **页面提示「无法获取远程版本信息」**：网络不通或私有仓库没配 Token。先看日志里那行「更新网络路径」，确认走的是代理还是直连。
- **更新到一半网络断了**：代码没被改动，服务照常录制，直接再点「重试更新」。
- **更新后打不开页面**：`docker compose logs --tail=100 livegrab` 看新版本是否启动报错；`rm -rf ./config/src && docker compose restart livegrab` 可回到镜像版本。
- **本地免 Docker 运行**（见下文）时，更新走 git 语义：`git fetch` 失败会自动降级 HTTP/1.1 + `protocol.version=0` 重试，仍失败则改用归档覆盖工作区（不动 `.git` 索引，下次联网自动对齐）。

### 容器里到底跑的是哪份代码

镜像里**已经包含完整源码**（`/app/server`、`/app/web`、`/app/package.json`、预编译好的 `node_modules`），
入口脚本只做一件事——选目录：

| 情况 | 运行目录 | 启动耗时 |
|---|---|---|
| 从没更新过（首次部署） | 镜像 `/app` | 秒级，零网络 |
| 页面更新过 | `/config/src/app`（挂载卷，跨容器重建保留） | 秒级 |
| `/config/src/app` 损坏（缺 `server/server.js`） | 回退镜像 `/app`，并在日志里 WARN | 秒级 |

依赖不随代码走：更新落位的新版本里 `node_modules` 是一条指向镜像 `/app/node_modules` 的软链，
所以原生模块（`better-sqlite3`）的 ABI 永远和当前镜像的 Node 一致；镜像重建后软链悬空，入口脚本会自动修好。
只有新版本真的改了 `dependencies`，才会在更新时 `npm install`（装失败则放弃本次更新，旧版本照常用）。

### 不想克隆仓库也能构建

```bash
docker build -t livegrab:latest https://github.com/bianyh8/livegrab.git
docker run -d --name livegrab -p 18080:8080 \
  -v "$PWD/data:/data" -v "$PWD/config:/config" \
  -e TZ=Asia/Shanghai -e LIVEGRAB_GITHUB_TOKEN=ghp_你的token \
  --restart unless-stopped \
  livegrab:latest
```
（compose 方式更省事，这个适合想手写 `run` 的情况。）

### 停止 / 排障

- 停止：`docker compose stop`（已配置 `stop_grace_period: 30s`，会先把当前分段收尾再退出）；彻底移除：`docker compose down`。
- 看日志：`docker compose logs -f --tail=200 livegrab`。
- 运行日志页里，`[容器启动]` 前缀是入口脚本的引导记录（这次用的是哪份代码），`[更新]` 前缀是更新链路（版本对比、网络路径、下载、切换、重启）。
- 更新页出现「重试更新」：上次更新未完成、代码未被改动，直接再点一次即可。
- 更新页提示「无法获取远程版本信息」：网络问题或私有仓库缺 Token，按上文「常见问题」处理。

---

## 本地运行（免 Docker）

需要 **Node.js ≥ 22**（better-sqlite3 要求）与 **ffmpeg**（在 `PATH` 中）。

```bash
start-local.cmd        # Windows：双击或命令行运行
# 或手动：
#   cd app && PORT=8080 RECORD_ROOT=./data CONFIG_DIR=./config node server/server.js
```

打开 `http://127.0.0.1:8080`。

## 测试

```bash
cd app
node test/run.js                # 常规单元测试（含 API / 解析 / 存储），442 项
node test/db-sqlite.mjs         # SQLite 持久层：建表 / 迁移 / 落库往返 / 旧库作废重建，82 项
node test/load.mjs              # 大数据量测试：2000 任务 + 1.2 万文件 + 20 万行日志（约 15s）
                                #   LOAD_SCALE=2 放大一倍，=0.2 快速冒烟
node test/update-manager.mjs   # 更新管理器单元测试（mock GitHub，离线；含容器归档通道：只升不降 / 解包 / 切换 / 回滚）
node test/update-git-flow.mjs  # 本地 git 工作区更新链路集成测试（离线自建 git 场景，无 git 自动跳过）
node test/check-docker.mjs     # Docker 打包自检（无需装 Docker）：静态校验 + 容器形态冒烟 + 更新落位目录启动冒烟 + 依赖校验
node test/e2e-ffmpeg.mjs       # 录制链路端到端（假 ffmpeg：分段 / 收尾 / 转封装 / 合并）
node test/e2e-ui.mjs           # 真实浏览器端到端（需本机 Edge/Chrome，找不到会自动跳过）
```

`test/load.mjs` 用「尽可能多的数据」压测上一轮的性能优化：上万文件下 `findFile` 逐个与
旧线性扫描做黄金比对、20 万行日志的分页/过滤结果与暴力统计逐项核对、上千真实磁盘文件
的扫描幂等性。小样本测不出这些问题——O(n²) 要几千条才肉痛，分页错位要跨页才暴露，
索引失效要「写操作之后再读」才现形。

## 目录结构

```
app/
  server/        # 后端：路由、调度器、录制器、解析器（resolvers/）、存储、命名
  web/           # 前端（静态 ESM，浏览器直载）：视图 views/、i18n、样式
  test/          # 测试
  docs/          # 接口契约等文档
ui/              # UI 设计原型与说明（不进 Docker 镜像）
Dockerfile / docker-compose.yaml / .dockerignore
deploy/          # entrypoint.sh（容器入口：只选代码目录，不联网）
start-local.cmd  # 本地一键启动
```

## 健康检查

```bash
curl http://<主机>:18080/api/health
```

---

> 本项目按需自托管，不提供任何形式的担保。
