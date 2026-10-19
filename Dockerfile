# LiveGrab 直播录制台 —— 单容器镜像（Node 内置能力 + 系统 ffmpeg，唯一 npm 依赖 better-sqlite3）
# 多阶段：构建阶段装工具链编译 better-sqlite3 原生模块；运行阶段保持精简（不含编译工具）
FROM node:22-bookworm-slim AS build

WORKDIR /app

# 编译 better-sqlite3 所需工具链（node-gyp：python3 + make + g++）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# 只复制依赖清单，装完即可拿到含 better-sqlite3 原生 .node 的 node_modules
# 注意：package-lock.json 已移出版本控制（见 commit ddae99a，避免自更新被锁文件卡死），
# 故使用 npm install 而非 npm ci（后者必须存在锁文件）。单依赖 better-sqlite3，解析确定。
COPY app/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

# ---------- 提交号解析阶段 ----------
# 构建上下文里带了 .git 的「指针文件」（.dockerignore 只放行 HEAD/refs/packed-refs，历史对象不进上下文），
# 这里直接用 deploy/git-commit.cjs 解析出当前提交号。为什么要这一步：compose 只做 ${VAR:-默认} 插值、
# 不做 shell 展开，`BUILD_COMMIT=$(git rev-parse HEAD)` 在 compose 里是死字符串，只能由用户在命令行传参；
# 于是「git pull 之后直接 up -d --build」永远带不上 commit，更新页就会误报「可用更新」一次。
# 本阶段的结果只以一个几字节的文本文件交给运行阶段；源码包/CI 浅检出等没有 .git 的情况输出空串，构建照常成功。
FROM node:22-bookworm-slim AS gitinfo
COPY . /ctx/
RUN node /ctx/deploy/git-commit.cjs /ctx/.git > /tmp/commit.txt \
 && echo "从构建上下文解析出的提交号: $(cat /tmp/commit.txt)"

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim

# 版本号由构建参数注入（compose 里从 .env 的 APP_VERSION 传），避免与 app/package.json
# 长期漂移——此前这里写死 "0.1.35"，早已落后实际版本，镜像元数据因此不准。
ARG APP_VERSION=0.1.53

LABEL org.opencontainers.image.title="LiveGrab 直播录制台" \
      org.opencontainers.image.description="抖音/B站/快手/虎牙/斗鱼/小红书/微博 直播分段录制，带 Web 管理页面" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production \
    PORT=8080 \
    RECORD_ROOT=/data \
    CONFIG_DIR=/config \
    LIVEGRAB_RUN_DIR=/opt/.run \
    LIVEGRAB_DEPS_DIR=/opt/node_modules \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

# ffmpeg 是唯一的外部依赖（录制/转封装/合并/回放全靠它）。git 只留给排障时手工查看
# ${CONFIG_DIR}/src 下的历史，在线更新已改为「按 commit 下载 GitHub 源码归档」，不再需要 git。
# 运行时也必须保留编译工具链（python3/make/g++）：唯一运行时依赖 better-sqlite3 是原生模块，
# 新版本若变更依赖声明，容器内更新需要现场编译；缺工具链会让更新失败（服务仍在跑旧版本）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata git python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -n 1

WORKDIR /app

# 直接复用构建阶段编译好的 node_modules（含 better-sqlite3 原生 .node，两阶段同为 bookworm/glibc，可通用），
# 但**放在 /opt/node_modules**（依赖基线）而不是 /app：运行目录里只放一条指向它的软链，
# 于是「点更新换代码」= 整目录替换，永远不会碰到依赖、也不必为每次更新重装 27MB。
COPY --from=build /app/node_modules /opt/node_modules
COPY app/server ./server
COPY app/web ./web
COPY app/test ./test
COPY app/docs ./docs
COPY README.md ./README.md
# package.json 必须进运行阶段：「系统更新」的 localInfo() 从 <appDir>/package.json 读本地版本，
# 漏掉这行会导致容器内版本显示 0.0.0、版本比对永远误报「可更新」。
COPY app/package.json ./package.json

# 提交号写进 .build-info.json（容器里没有 .git，更新判定就是「远端 HEAD 的 commit vs 本地记录的 commit」）：
#   ① BUILD_COMMIT 构建参数显式传了 → 以它为准（手动构建 / 特殊 CI 用）；
#   ② 否则用 gitinfo 阶段从构建上下文 .git 解析出的提交号 → `docker compose up -d --build` 零参数即精确；
#   ③ 都没有（源码包/浅检出）→ 记为空字符串，第一次点「立即更新」先按「有更新」处理一次，落位后即以 sha 精确比对
#      （见 update.js 的 _computeHasUpdate）。
ARG BUILD_COMMIT=""
COPY --from=gitinfo /tmp/commit.txt /tmp/gitcommit.txt
RUN VER=$(node -p "require('./package.json').version") \
 && COMMIT="${BUILD_COMMIT:-$(cat /tmp/gitcommit.txt 2>/dev/null)}" \
 && echo "{\"version\":\"${VER}\",\"commit\":\"${COMMIT}\",\"builtAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > /app/.build-info.json \
 && rm -f /tmp/gitcommit.txt \
 && echo "镜像构建信息: $(cat /app/.build-info.json)"

RUN mkdir -p /data /config

VOLUME ["/data", "/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 收到 SIGTERM 会优雅收尾正在录制的分段（compose 里留了 stop_grace_period）
STOPSIGNAL SIGTERM

# 入口脚本只做一件事：把镜像内源码 /app 部署成「运行目录」（默认 /opt/.run），再 cd 过去执行。
#   首启不 clone、不装依赖、不联网；页面「立即更新」在服务进程内完成（下载归档 → 整目录原子切换 → 自重启）。
#   重建容器 = 可写层清空 → 重新部署回镜像版本（安装包语义），不做任何版本比较与仲裁。
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/server.js"]
