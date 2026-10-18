#!/bin/sh
# LiveGrab 容器入口：只负责「选代码目录 + 记录启动事件」。
#   · 首次部署：直接用镜像内置代码 /app 启动——不 clone、不装依赖、不联网、不涉及 git；
#   · 更新过的实例：页面「立即更新」把新版本落位到 ${CONFIG_DIR}/src/app，跨容器重建保留，
#     所以只要该目录完整就用它；
#   · 代理与下载全部在服务进程内完成（页面「系统设置 → 平台账号 → 网络代理」），见 README「更新与代理」。
#
# 日志约定：本脚本的事件除 Docker stdout 外，还以「LEVEL 消息」写入 ${CONFIG_DIR}/.bootstrap-events；
#   服务启动后由 server.js 读取并转写为正式日志（前缀 [容器启动]）后删除——容器引导信息因此也进
#   「运行日志」页，重启后仍可查。
#
# 路径可用环境变量覆盖（便于测试与特殊部署）：
#   LIVEGRAB_SRC_DIR    新版本落位根目录，默认 ${CONFIG_DIR}/src
#   LIVEGRAB_IMAGE_APP  镜像内置代码目录，默认 /app
set -u

SRC="${LIVEGRAB_SRC_DIR:-${CONFIG_DIR:-/config}/src}"
IMAGE_APP="${LIVEGRAB_IMAGE_APP:-/app}"
EVT_FILE="${CONFIG_DIR:-/config}/.bootstrap-events"

log() { echo "[entrypoint] $*"; }
evt() { printf '%s %s\n' "$1" "$2" >> "$EVT_FILE" 2>/dev/null || true; }

# 读 package.json 的版本号（镜像里一定有 node）
pkgver() { node -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$1/package.json" 2>/dev/null || true; }
# 语义化版本比较：a>b 输出 1，a<b 输出 -1，相等输出 0
vercmp() {
  node -e 'const v=(s)=>String(s||"").replace(/^v/i,"").split(".").map((x)=>parseInt(x,10)||0);
    const a=v(process.argv[1]),b=v(process.argv[2]);
    const d=(a[0]-b[0])||(a[1]-b[1])||(a[2]-b[2]);
    process.stdout.write(d>0?"1":d<0?"-1":"0")' "$1" "$2" 2>/dev/null || true
}

# 上次更新中断留下的暂存目录（未激活的新版本）：丢弃，避免下次解包撞名
# 注意：$SRC/app.old 是「上一个版本」，保留着当手动回滚用（下次更新时才会被替换）
rm -rf "$SRC/.update-stage" 2>/dev/null || true

APP_DIR="$IMAGE_APP"
if [ -f "$SRC/app/server/server.js" ]; then
  # 上次「立即更新」落位的新版本：一般优先运行它（更新结果跨容器重建保留）。
  # 但重建镜像后镜像版本可能更高，那种情况跑镜像是用户的本意——否则会出现
  # 「明明重建了新镜像，页面还显示旧版本」的困惑。
  APP_DIR="$SRC/app"
  SRC_VER=$(pkgver "$SRC/app")
  IMG_VER=$(pkgver "$IMAGE_APP")
  if [ -n "$IMG_VER" ] && [ -n "$SRC_VER" ] && [ "$(vercmp "$IMG_VER" "$SRC_VER")" = "1" ]; then
    APP_DIR="$IMAGE_APP"
    log "镜像版本 v$IMG_VER 高于上次更新的 v$SRC_VER：本次运行镜像内置代码 $IMAGE_APP"
    evt INFO "镜像版本 v$IMG_VER 高于上次更新落位的 v$SRC_VER，本次运行镜像内置代码"
  else
    log "使用持久化代码目录：$APP_DIR（页面「立即更新」落位的新版本 v${SRC_VER:-?}）"
    evt INFO "使用持久化代码目录 $APP_DIR（v${SRC_VER:-?}，跨容器重建保留）"
  fi
elif [ -e "$SRC/app" ]; then
  log "代码目录不完整（$SRC/app 缺少 server/server.js），回退镜像内置代码 $IMAGE_APP"
  evt WARN "代码目录不完整（$SRC/app），已回退镜像内置代码；可在页面重新「立即更新」修复"
else
  log "使用镜像内置代码：$IMAGE_APP（首次部署，不联网）"
  evt INFO "使用镜像内置代码 $IMAGE_APP（首次部署；点「立即更新」后新版落位到 $SRC/app）"
fi

# 依赖自愈：落位目录的 node_modules 是指向镜像基线的软链；镜像重建后软链可能悬空，
# 这里修好它（悬空 → 重建软链；整个缺失 → 补一条），避免「启动即崩、页面打不开」。
if [ "$APP_DIR" != "$IMAGE_APP" ]; then
  if [ -L "$APP_DIR/node_modules" ] && [ ! -d "$APP_DIR/node_modules" ]; then
    rm -f "$APP_DIR/node_modules"
    log "node_modules 软链失效（镜像已重建），重新指向 $IMAGE_APP/node_modules"
    evt WARN "node_modules 软链失效，已重新指向镜像基线"
  fi
  if [ ! -d "$APP_DIR/node_modules" ] && [ -d "$IMAGE_APP/node_modules" ]; then
    ln -s "$IMAGE_APP/node_modules" "$APP_DIR/node_modules" 2>/dev/null || true
    # 有些文件系统不支持软链（甚至 ln 静默失败）：以「能否真的读到」为准，读不到就整份复制
    if [ ! -d "$APP_DIR/node_modules" ]; then
      rm -f "$APP_DIR/node_modules" 2>/dev/null || true
      cp -a "$IMAGE_APP/node_modules" "$APP_DIR/node_modules" 2>/dev/null \
        || log "node_modules 准备失败（不影响启动；服务会在需要时报错）"
    fi
  fi
fi

# 交给服务进程：更新时要往哪里落位新版本、依赖基线在哪
export LIVEGRAB_SRC_DIR="$SRC"
export LIVEGRAB_IMAGE_APP="$IMAGE_APP"

cd "$APP_DIR" || { log "无法进入 $APP_DIR"; exit 1; }
log "启动服务：$APP_DIR"
exec "$@"
