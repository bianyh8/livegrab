#!/bin/sh
# LiveGrab 容器入口（架构 B：容器内 git 自更新）
#
# 职责：
#   1. 首次启动：把代码仓库 clone 到 ${CONFIG_DIR}/src，并切换到镜像内置版本
#      （保证代码与镜像里的 node_modules 匹配）；私有仓库用 LIVEGRAB_GITHUB_TOKEN
#      走 http.extraheader 认证，token 不落盘到 .git/config。
#   2. 克隆失败（无网络/无 token）：回退镜像内置代码（/app），更新页会给出对应指引；
#      网络恢复后重启容器会重试克隆。
#   3. 后续启动：直接使用 ${CONFIG_DIR}/src 的代码；代码更新由页面「立即更新」完成
#      （git fetch/pull → npm install → 进程内重启），无需宿主机干预。
#
# 路径均可用环境变量覆盖（便于测试与特殊部署）：
#   LIVEGRAB_SRC       代码目录，默认 ${CONFIG_DIR}/src
#   LIVEGRAB_APP_DIR   镜像内置代码目录，默认 /app
#   LIVEGRAB_GIT_URL   仓库完整 URL，默认由 LIVEGRAB_REPO（owner/repo，与「系统更新」页同一配置）推导
#   LIVEGRAB_BRANCH    仓库分支，默认 main（与「系统更新」页同一配置）
set -u

SRC="${LIVEGRAB_SRC:-${CONFIG_DIR:-/config}/src}"
IMAGE_APP="${LIVEGRAB_APP_DIR:-/app}"
REPO_URL="${LIVEGRAB_GIT_URL:-https://github.com/${LIVEGRAB_REPO:-bianyh8/livegrab}.git}"
BRANCH="${LIVEGRAB_BRANCH:-main}"

log() { echo "[entrypoint] $*"; }

# 镜像内没有 git（旧镜像）：只能用内置代码
if ! command -v git >/dev/null 2>&1; then
  log "镜像内没有 git，使用镜像内置代码（$IMAGE_APP）"
  cd "$IMAGE_APP" && exec "$@"
fi

# 自愈：仓库存在但代码不完整（克隆中断/误删）→ 重克
if [ -d "$SRC/.git" ] && [ ! -f "$SRC/app/server/server.js" ]; then
  log "检测到代码目录不完整（$SRC），将重新克隆"
  rm -rf "$SRC"
fi

if [ ! -d "$SRC/.git" ]; then
  log "首次运行：克隆代码仓库 → $SRC"
  rm -rf "$SRC.tmp"
  CLONE_OK=0
  if [ -n "${LIVEGRAB_GITHUB_TOKEN:-}" ]; then
    AUTH=$(printf 'x-access-token:%s' "$LIVEGRAB_GITHUB_TOKEN" | base64 | tr -d '\n')
    git -c "http.extraheader=Authorization: Basic $AUTH" clone -b "$BRANCH" "$REPO_URL" "$SRC.tmp" && CLONE_OK=1
  else
    git clone -b "$BRANCH" "$REPO_URL" "$SRC.tmp" && CLONE_OK=1
  fi
  if [ "$CLONE_OK" = "1" ]; then
    # 原子替换：克隆完整后才落位，避免把半成品 .git 留在 $SRC
    rm -rf "$SRC"
    mv "$SRC.tmp" "$SRC"
    git config --global --add safe.directory "$SRC" 2>/dev/null || true
    # 切到镜像内置版本（.build-info.json 的 version → v<version> 标签），
    # 保证首启代码与镜像内 node_modules 匹配；无对应标签则用仓库最新代码
    if [ -f "$IMAGE_APP/.build-info.json" ]; then
      VER=$(node -e "try{console.log(require('$IMAGE_APP/.build-info.json').version||'')}catch(e){}" 2>/dev/null || true)
      if [ -n "$VER" ] && git -C "$SRC" rev-parse -q --verify "refs/tags/v$VER" >/dev/null 2>&1; then
        git -C "$SRC" checkout -q -B main "refs/tags/v$VER"
        git -C "$SRC" branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
        log "已切换到镜像内置版本 v$VER（后续通过页面「立即更新」升级）"
      else
        log "未找到镜像版本对应的标签 v$VER，使用仓库最新代码"
      fi
    fi
    # 用镜像内编译好的 node_modules 预热（Linux 原生，免去首启现场编译 better-sqlite3）
    if [ ! -d "$SRC/app/node_modules" ] && [ -d "$IMAGE_APP/node_modules" ]; then
      if cp -a "$IMAGE_APP/node_modules" "$SRC/app/node_modules" 2>/dev/null; then
        log "已预热 node_modules"
      else
        log "node_modules 预热失败，将依赖 npm install"
      fi
    fi
  else
    rm -rf "$SRC.tmp"
    log "克隆失败（网络不通，或私有仓库未配置 LIVEGRAB_GITHUB_TOKEN）"
    log "本次使用镜像内置代码启动；网络/token 恢复后重启容器会重试克隆"
  fi
fi

APP_DIR="$SRC/app"
if [ ! -f "$APP_DIR/server/server.js" ]; then
  log "代码目录不可用（$APP_DIR），回退镜像内置代码"
  APP_DIR="$IMAGE_APP"
fi

cd "$APP_DIR" || { log "无法进入 $APP_DIR"; exit 1; }

# 依赖校正：有网时补齐/升级依赖；失败（离线等）不阻断启动，继续使用现有 node_modules
if command -v npm >/dev/null 2>&1 && [ -f package.json ]; then
  if timeout 180 npm install --omit=dev --no-audit --no-fund --prefer-offline >/tmp/livegrab-npm-boot.log 2>&1; then
    log "依赖检查完成"
  else
    log "依赖安装失败或超时（不影响启动，继续使用现有 node_modules）："
    tail -n 3 /tmp/livegrab-npm-boot.log 2>/dev/null | sed 's/^/    /'
  fi
fi

log "启动服务：$APP_DIR"
exec "$@"
