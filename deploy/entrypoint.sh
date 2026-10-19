#!/bin/sh
# LiveGrab 容器入口：部署「运行目录」并记录启动事件。
#
# 目录语义（v0.1.52 起，用户确认的「安装包」模型）：
#   ${IMAGE_APP}  镜像内源码（默认 /app）= 你的「安装包」：只被读取，运行时永不修改；
#   ${RUN_DIR}    运行目录（默认 /opt/.run）= 当前实际跑的代码：
#                    · 首启 / 重建容器后可写层清空 → 从镜像源码部署一份；
#                    · 已存在 → 直接跑它（页面「立即更新」替换的就是这个目录）；
#   ${RUN_DIR}.old  上一个版本（保留作手动回滚，下次更新时才会被替换）；
#   ${RUN_DIR}.stage 更新暂存（未激活的新版本，启动时丢弃）；
#   ${DEPS_DIR}   依赖基线（默认 /opt/node_modules）：代码替换不碰它，运行目录里只放软链；
#   ${CONFIG_DIR} 设置 / 账号 / cookie / livegrab.db（默认 /config）；
#   /data         录像成品。
#
# 语义约定（与用户确认过）：
#   · 启动就跑「当前装的这一版」，不与远端、也不与镜像做任何版本比较或仲裁；
#   · 只有页面点「立即更新」才会下载新版本并替换运行目录；
#   · 重建容器（up -d --build / 删容器重建）= 重新安装 → 可写层清空 → 再部署回镜像版本
#     （像本地安装包是 1.0，过几个月再装一次，装的还是 1.0，不会自动跳最新）。
#   想跨容器重建保留更新结果（可选）：把宿主目录挂到 ${RUN_DIR} 即可，本脚本会自动适配。
#
# 日志约定：本脚本的事件除 Docker stdout 外，还以「LEVEL 消息」写入 ${CONFIG_DIR}/.bootstrap-events；
#   服务启动后由 server.js 读取并转写为正式日志（前缀 [容器启动]）后删除——容器引导信息因此也进
#   「运行日志」页，重启后仍可查。
#
# 路径可用环境变量覆盖（便于测试与特殊部署）：
#   LIVEGRAB_IMAGE_APP  镜像源码目录，默认 /app
#   LIVEGRAB_RUN_DIR    运行目录，默认 /opt/.run
#   LIVEGRAB_DEPS_DIR   依赖基线目录，默认 /opt/node_modules
set -u

IMAGE_APP="${LIVEGRAB_IMAGE_APP:-/app}"
RUN_DIR="${LIVEGRAB_RUN_DIR:-/opt/.run}"
DEPS_DIR="${LIVEGRAB_DEPS_DIR:-/opt/node_modules}"
EVT_FILE="${CONFIG_DIR:-/config}/.bootstrap-events"

log() { echo "[entrypoint] $*"; }
evt() { printf '%s %s\n' "$1" "$2" >> "$EVT_FILE" 2>/dev/null || true; }

# 读 package.json 的版本号（镜像里一定有 node）
pkgver() { node -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$1/package.json" 2>/dev/null || true; }
# 读 JSON 里的某个字符串字段（容器里没 jq，用 node；读不到就输出空）
jsonfield() { node -e 'try{process.stdout.write(String(require(process.argv[1])[process.argv[2]]||""))}catch(e){}' "$1" "$2" 2>/dev/null || true; }

# 上次更新中断留下的暂存目录（未激活的新版本）：丢弃，避免下次解包撞名。
# 注意：${RUN_DIR}.old 是「上一个版本」，保留着当手动回滚用（下次更新时才会被替换）。
rm -rf "$RUN_DIR.stage" 2>/dev/null || true

# ---------- ① 部署运行目录（只在缺失时做；不做任何版本比较） ----------
if [ ! -f "$RUN_DIR/server/server.js" ]; then
  if [ ! -f "$IMAGE_APP/server/server.js" ]; then
    log "镜像内源码缺失（$IMAGE_APP/server/server.js 不存在），无法部署运行目录"
    evt ERR "镜像内源码缺失（$IMAGE_APP），无法部署运行目录 $RUN_DIR"
    exit 1
  fi
  log "首次部署运行目录：$IMAGE_APP → $RUN_DIR（镜像源码视为安装包，不做任何改动）"
  rm -rf "$RUN_DIR" 2>/dev/null || true
  mkdir -p "$RUN_DIR" || { log "无法创建运行目录 $RUN_DIR"; exit 1; }
  for d in server web test docs; do
    [ -d "$IMAGE_APP/$d" ] && cp -a "$IMAGE_APP/$d" "$RUN_DIR/" 2>/dev/null
  done
  for f in package.json README.md .build-info.json; do
    [ -f "$IMAGE_APP/$f" ] && cp -a "$IMAGE_APP/$f" "$RUN_DIR/" 2>/dev/null
  done
  VER="$(pkgver "$IMAGE_APP")"
  SHA="$(jsonfield "$IMAGE_APP/.build-info.json" commit)"
  BUILT="$(jsonfield "$IMAGE_APP/.build-info.json" builtAt)"
  # 版本标记：运行目录的权威版本来源（页面「已部署」就读它；容器重建后随可写层一起消失）
  node -e 'const fs=require("fs");const p=process.argv[1],ver=process.argv[2]||"",sha=process.argv[3]||"",built=process.argv[4]||"";
    fs.writeFileSync(p,JSON.stringify({version:ver,tag:ver?("v"+ver):"",commit:sha?String(sha).slice(0,12):"",commitFull:sha,commitAt:built,remoteTag:"",pkgVersion:ver,from:"image",at:Date.now()},null,2));' \
    "$RUN_DIR/.livegrab-version.json" "$VER" "$SHA" "$BUILT" 2>/dev/null \
    || log "版本标记写入失败（不影响启动；页面可能显示镜像版本）"
  log "运行目录已部署：v${VER:-?}${SHA:+ / $(printf %.8s "$SHA")}"
  evt INFO "首次部署运行目录 $RUN_DIR（镜像 v${VER:-?}${SHA:+ / $(printf %.8s "$SHA")}）；重建容器会重新部署回镜像版本"
else
  RVER="$(pkgver "$RUN_DIR")"
  RSHA="$(jsonfield "$RUN_DIR/.livegrab-version.json" commit)"
  log "使用已有运行目录：$RUN_DIR（v${RVER:-?}${RSHA:+ / $(printf %.8s "$RSHA")}，含页面更新结果）"
  evt INFO "使用已有运行目录 $RUN_DIR（v${RVER:-?}${RSHA:+ / $(printf %.8s "$RSHA")}）"
fi

# ---------- ② 依赖基线（独立目录，代码替换不碰它） ----------
if [ ! -d "$DEPS_DIR" ] && [ -d "$IMAGE_APP/node_modules" ]; then
  OLD_DEPS="$DEPS_DIR"
  DEPS_DIR="$IMAGE_APP/node_modules"
  log "依赖基线 $OLD_DEPS 不存在，回退镜像内依赖 $DEPS_DIR"
fi
# 依赖基线更新后留下的上一份（<基线>.prev）：新的依赖已经在跑，这份启动时清掉就行
rm -rf "$DEPS_DIR.prev" 2>/dev/null || true
# 软链悬空（依赖基线换了 / 镜像重建）：重建；完全缺失：补一条
if [ -L "$RUN_DIR/node_modules" ] && [ ! -d "$RUN_DIR/node_modules" ]; then
  rm -f "$RUN_DIR/node_modules"
  log "node_modules 软链失效，重新指向依赖基线 $DEPS_DIR"
  evt WARN "node_modules 软链失效，已重新指向依赖基线"
fi
if [ ! -e "$RUN_DIR/node_modules" ] && [ -d "$DEPS_DIR" ]; then
  ln -s "$DEPS_DIR" "$RUN_DIR/node_modules" 2>/dev/null || true
  # 有些文件系统不支持软链（甚至 ln 静默失败）：以「能否真的读到」为准，读不到就整份复制
  if [ ! -d "$RUN_DIR/node_modules" ]; then
    rm -f "$RUN_DIR/node_modules" 2>/dev/null || true
    cp -a "$DEPS_DIR" "$RUN_DIR/node_modules" 2>/dev/null \
      || log "node_modules 准备失败（不影响启动；服务会在需要时报错）"
  fi
fi

# 交给服务进程：镜像源码位置 / 运行目录 / 依赖基线（更新流程据此判断落位目标）
export LIVEGRAB_IMAGE_APP="$IMAGE_APP"
export LIVEGRAB_RUN_DIR="$RUN_DIR"
export LIVEGRAB_DEPS_DIR="$DEPS_DIR"

cd "$RUN_DIR" || { log "无法进入 $RUN_DIR"; exit 1; }
log "启动服务：$RUN_DIR"
exec "$@"
