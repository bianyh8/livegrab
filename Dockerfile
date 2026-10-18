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

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim

# 版本号由构建参数注入（compose 里从 .env 的 APP_VERSION 传），避免与 app/package.json
# 长期漂移——此前这里写死 "0.1.35"，早已落后实际版本，镜像元数据因此不准。
ARG APP_VERSION=0.1.46

LABEL org.opencontainers.image.title="LiveGrab 直播录制台" \
      org.opencontainers.image.description="抖音/B站/快手/虎牙/斗鱼/小红书/微博 直播分段录制，带 Web 管理页面" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production \
    PORT=8080 \
    RECORD_ROOT=/data \
    CONFIG_DIR=/config \
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

# 直接复用构建阶段编译好的 node_modules（含 better-sqlite3 原生 .node，两阶段同为 bookworm/glibc，可通用）
COPY --from=build /app/node_modules ./node_modules
COPY app/server ./server
COPY app/web ./web
COPY app/test ./test
COPY app/docs ./docs
COPY README.md ./README.md
# package.json 必须进运行阶段：「系统更新」的 localInfo() 从 <appDir>/package.json 读本地版本，
# 漏掉这行会导致容器内版本显示 0.0.0、版本比对永远误报「可更新」。
COPY app/package.json ./package.json

# 构建时注入 commit（由 docker compose 的 build.args 传入，手动构建时 --build-arg BUILD_COMMIT=xxx），
# 写入 .build-info.json。容器里没有 .git，更新判定就是「远端 HEAD 的 commit vs 本地记录的 commit」，
# 传了才能从第一次点「立即更新」起就精确；没传则第一次按「有更新」处理一次，落位后即以 sha 精确比对
# （见 update.js 的 _computeHasUpdate）。
ARG BUILD_COMMIT=""
RUN VER=$(node -p "require('./package.json').version") \
 && echo "{\"version\":\"${VER}\",\"commit\":\"${BUILD_COMMIT}\",\"builtAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > /app/.build-info.json

RUN mkdir -p /data /config

VOLUME ["/data", "/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 收到 SIGTERM 会优雅收尾正在录制的分段（compose 里留了 stop_grace_period）
STOPSIGNAL SIGTERM

# 入口脚本只选代码目录：有 ${CONFIG_DIR}/src/app（页面更新落位的新版本）就跑它，否则跑镜像内 /app。
# 首启不 clone、不装依赖、不联网；更新在服务进程内完成（下载归档 → 原子切换 → 自重启）。
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/server.js"]
