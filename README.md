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
- **命名规则**：模板化文件名与目录结构（主播/平台/标题/日期/清晰度等变量 + 实时预览）。
- **文件库**：成品平铺浏览、搜索筛选、播放、下载、删除；删除默认进回收站（含刮削图片/描述）。
- **运行日志**：按级别/任务/关键字过滤，最新在前 / 实时追加。
- **通知**：Webhook 推送（开播、录制结束、磁盘不足等事件）。
- **系统更新**：「系统设置 → 系统更新」从 GitHub 拉取最新代码，对比本地版本并自动构建部署。
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
> 镜像名 `livegrab:latest`，容器名 `livegrab`，`restart: unless-stopped` 自动开机自启。
> 首次启动时容器会把代码仓库自动 clone 到 `./config/src`（私有仓库需先配好 `LIVEGRAB_GITHUB_TOKEN`，见下文），日志里可看到 `[entrypoint]` 开头的克隆进度。

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
| `./config/src` | 容器实际运行的代码（git  clone，架构 B） | 由容器管理，勿手改；删除后重启容器会重新克隆 |

### 环境变量（`docker-compose.yml` 可调）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVEGRAB_PORT` | `18080` | 宿主机映射端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `PORT` / `RECORD_ROOT` / `CONFIG_DIR` | `8080` / `/data` / `/config` | 容器内端口与卷路径 |
| `LIVEGRAB_GITHUB_TOKEN` | （空） | **私有仓库**必备：GitHub Personal Access Token（需 `repo` 读权限）。用于版本检测、首启 clone、页面更新拉码三处 |
| `LIVEGRAB_REPO` | `bianyh8/livegrab` | 更新检查与 clone 的目标仓库（`owner/repo`），分叉部署时改这里 |
| `LIVEGRAB_BRANCH` | `main` | 更新检查与 clone 的目标分支 |
| `LIVEGRAB_GIT_URL` | 由 `LIVEGRAB_REPO` 推导 | 仓库完整 clone URL（非 GitHub 托管时才需要显式设置） |

> 需要走代理拉流时，在 compose 里给容器加 `HTTPS_PROXY`（参考文件内注释）。

### 系统更新（公开 / 私有仓库）

「系统设置 → 系统更新」从 GitHub 拉取最新版本对比时，**会自动判断仓库可见性**：

| 仓库类型 | 是否需要 Token | 页面行为 |
| --- | --- | --- |
| 公开仓库 | ❌ 不需要 | 匿名读取 GitHub API，开箱即用 |
| 私有仓库 | ✅ 需要 | 匿名读取失败后自动带 Token 重试 |

代码仓库 `bianyh8/livegrab` 当前是**私有仓库**，容器内需要提供 GitHub Token：

```bash
# ① 在 livegrab/ 目录建 .env 文件（不要提交到 git），写一行：
echo "LIVEGRAB_GITHUB_TOKEN=ghp_你的token" > .env
# ② 重启使环境变量生效
docker compose up -d
```

- **Token 获取**：GitHub → Settings → Developer settings → Personal access tokens → Generate new token，勾选 `repo` 权限即可。
- **Token 仅通过容器环境变量注入**，不写入数据库、不随接口返回、不在页面展示，安全性最高。
- 本地免 Docker 运行（见下）时，服务会自动读取本机 `~/.git-credentials` 里的 GitHub 凭据，无需额外配置。
- 页面行为：配置好 token 后「系统更新」页会显示远程最新版本，有新版本时「立即更新」按钮可用（容器内自动执行 git fetch → 快进拉取 → 安装依赖 → 自动重启，全程约 10~60 秒，页面有进度与重启提示）。
- 未配置 token 访问**私有**仓库时，页面会明确提示「私有仓库需要配置 GitHub Token」，不会误报有新版本；**公开**仓库则不会有任何 token 相关提示。

### 容器里代码从哪来、怎么更新（架构 B）

镜像本身**不包含业务源码**（只含 `node_modules` 基线、ffmpeg、git 和入口脚本）。容器首次启动时，入口脚本 `deploy/entrypoint.sh` 会把仓库 clone 到 `./config/src`、切换到镜像内置版本，之后服务从该目录运行。因此：

- **日常更新 = 页面点「立即更新」**：容器内自己完成 `git pull → npm install → 重启`，不动镜像、不丢录制，宿主机无需干预。
- **镜像级变更才需要在宿主机重建**（更换 ffmpeg / Node 版本、修改入口脚本本身）：
  ```bash
  cd livegrab && git pull && docker compose up -d --build
  ```
- **群晖 NAS 定时更新**：用仓库里的 `deploy/update.sh`（同步宿主机仓库、`./config/src` 与镜像，有更新才重启）。
- `./config/src` 由容器管理：能写该目录 ≈ 能在容器内执行代码，请按配置目录的密级对待；代码目录损坏时会自动重克，也可手动 `rm -rf ./config/src` 后重启容器恢复。

### 不想克隆也能直接构建

```bash
docker build -t livegrab:latest https://github.com/bianyh8/livegrab.git
docker run -d --name livegrab -p 18080:8080 \
  -v "$PWD/data:/data" -v "$PWD/config:/config" \
  -e TZ=Asia/Shanghai -e LIVEGRAB_GITHUB_TOKEN=ghp_你的token \
  --restart unless-stopped \
  livegrab:latest
```
（compose 方式更省事，这个适合想手写 `run` 的情况。私有仓库不配 token 也能启动，但首启 clone 会失败并回退镜像内置代码。）

### 停止 / 排障

- 停止：`docker compose stop`（已配置 `stop_grace_period: 30s`，会先把当前分段收尾再退出）；彻底移除：`docker compose down`。
- 看日志：`docker compose logs -f --tail=200 livegrab`。
- 更新页提示「容器内未检测到代码仓库」：首启克隆失败（网络/ token），修好后重启容器即可，页面「立即更新」在此期间不可用。
- 容器行为异常、怀疑代码目录损坏：`rm -rf ./config/src` 后 `docker compose restart livegrab`，会重新克隆到镜像内置版本。

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
node test/run.js                # 常规单元测试（含 API / 解析 / 存储）
node test/update-manager.mjs   # 更新管理器单元测试（mock GitHub，离线）
node test/update-git-flow.mjs  # 架构 B 容器更新链路集成测试（离线自建 git 场景，无 git 自动跳过）
node test/check-docker.mjs     # Docker 打包自检（无需装 Docker）：Dockerfile/compose/.dockerignore 静态校验 + 容器形态冒烟 + 依赖校验（唯一第三方依赖 better-sqlite3）
```

## 目录结构

```
app/
  server/        # 后端：路由、调度器、录制器、解析器（resolvers/）、存储、命名
  web/           # 前端（静态 ESM，浏览器直载）：视图 views/、i18n、样式
  test/          # 测试
  docs/          # 接口契约等文档
ui/              # UI 设计原型与说明（不进 Docker 镜像）
Dockerfile / docker-compose.yml / .dockerignore
deploy/          # entrypoint.sh（容器入口：clone/回退/启动）、update.sh（群晖定时更新）
start-local.cmd  # 本地一键启动
```

## 健康检查

```bash
curl http://<主机>:18080/api/health
```

---

> 本项目按需自托管，不提供任何形式的担保。
