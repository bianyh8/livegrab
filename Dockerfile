# LiveGrab 直播录制台 —— 单容器镜像（Node 内置能力 + 系统 ffmpeg，零 npm 依赖）
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="LiveGrab 直播录制台" \
      org.opencontainers.image.description="抖音/B站/快手/虎牙/斗鱼/小红书/微博 直播分段录制，带 Web 管理页面" \
      org.opencontainers.image.version="0.1.0"

ENV NODE_ENV=production \
    PORT=8080 \
    RECORD_ROOT=/data \
    CONFIG_DIR=/config \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

# ffmpeg 是唯一的外部依赖（录制/转封装/合并/回放全靠它）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -version | head -n 1

WORKDIR /app

# 只复制运行需要的东西；没有 npm install，没有 node_modules
COPY app/package.json ./package.json
COPY app/server ./server
COPY app/web ./web
COPY app/test ./test
COPY app/docs ./docs
COPY README.md ./README.md

RUN mkdir -p /data /config

VOLUME ["/data", "/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 收到 SIGTERM 会优雅收尾正在录制的分段（compose 里留了 stop_grace_period）
STOPSIGNAL SIGTERM
CMD ["node", "server/server.js"]
