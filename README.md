# LiveGrab 直播录制台

自托管的**直播录制管理台**：自动监控直播间，开播即录、按策略分段、按规则命名入库，带完整 Web 管理界面。个人/小团队长期存档直播内容（切片、留档）用。

- **单容器 Web 服务**：浏览器访问 `http://<主机>:8080` 即可，全部操作在页面完成，无需桌面壳。
- **零 npm 依赖、无构建步骤**：后端只用 Node 内置模块，ffmpeg 以子进程方式调度，前端为静态 ESM。
- **免 Docker 也能跑**：本机装了 Node 20+ 与 ffmpeg 可直接运行（见 [本地运行](#本地运行)）。

---

## 功能特性

- **开播检测自动录制**：轮询直播间状态，开播自动拉流、下播自动收尾；可设「仅监控」只盯状态不录。
- **分段策略**：按时长 / 按大小分段，断线自动重连，停止时优雅收尾当前分段。
- **成品处理**：TS/FLV 分段转封装 MP4、整场合档、浏览器内置播放器回放（边转边播）。
- **命名规则**：模板化文件名与目录结构（主播/平台/标题/日期/清晰度等变量 + 实时预览）。
- **文件库**：成品平铺浏览、搜索筛选、播放、下载、删除；删除默认进回收站（含刮削图片/描述）。
- **运行日志**：按级别/任务/关键字过滤，最新在前 / 实时追加。
- **通知**：Webhook 推送（开播、录制结束、磁盘不足等事件）。
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
> 镜像名 `livegrab:0.1.0`，容器名 `livegrab`，`restart: unless-stopped` 自动开机自启。

**③ 打开页面**
```
http://<主机IP>:8080
```
首次打开会引导**初始化管理员账号**（设置用户名与密码）。

**④ 数据落盘位置**
compose 相对 `livegrab/` 目录挂载：

| 挂载点 | 内容 | 建议 |
|---|---|---|
| `./data` → `/data` | 录制成品与分段 | 占空间最大，挂到大容量磁盘 |
| `./config` → `/config` | 账号哈希、Cookie、任务、场次索引、日志 | 长期保留 |

### 环境变量（`docker-compose.yml` 可调）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LIVEGRAB_PORT` | `8080` | 宿主机映射端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `PORT` / `RECORD_ROOT` / `CONFIG_DIR` | `8080` / `/data` / `/config` | 容器内端口与卷路径 |

> 需要走代理拉流时，在 compose 里给容器加 `HTTPS_PROXY`（参考文件内注释）。

### 日常更新

```bash
cd livegrab
git pull
docker compose up -d --build
```
> `docker compose up` 检测到镜像/配置变化会自动重建，数据在挂载卷里不受影响。改端口用 `LIVEGRAB_PORT=9000 docker compose up -d`，改时区用 `TZ=Asia/Shanghai`。

### 不想克隆也能直接构建

```bash
docker build -t livegrab:0.1.0 https://github.com/bianyh8/livegrab.git
docker run -d --name livegrab -p 8080:8080 \
  -v "$PWD/data:/data" -v "$PWD/config:/config" \
  -e TZ=Asia/Shanghai --restart unless-stopped \
  livegrab:0.1.0
```
（compose 方式更省事，这个适合想手写 `run` 的情况。）

### 停止 / 排障

- 停止：`docker compose stop`（已配置 `stop_grace_period: 30s`，会先把当前分段收尾再退出）；彻底移除：`docker compose down`。
- 看日志：`docker compose logs -f --tail=200 livegrab`。

---

## 本地运行（免 Docker）

需要 **Node.js ≥ 20** 与 **ffmpeg**（在 `PATH` 中）。

```bash
start-local.cmd        # Windows：双击或命令行运行
# 或手动：
#   cd app && PORT=8080 RECORD_ROOT=./data CONFIG_DIR=./config node server/server.js
```

打开 `http://127.0.0.1:8080`。

## 测试

```bash
cd app
node test/run.js              # 常规单元测试（含 API / 解析 / 存储）
node test/check-docker.mjs    # Docker 打包自检（无需装 Docker）：Dockerfile/compose/.dockerignore 静态校验 + 容器形态冒烟 + 零依赖校验
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
start-local.cmd  # 本地一键启动
```

## 健康检查

```bash
curl http://<主机>:8080/api/health
```

---

> 本项目按需自托管，不提供任何形式的担保。
