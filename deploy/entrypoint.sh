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
# 日志约定：本脚本的事件（克隆/回退/预热/依赖检查）除 Docker stdout 外，还以
#   「LEVEL 消息」逐行写入 ${CONFIG_DIR}/.bootstrap-events；服务启动后由 server.js
#   读取并转写为正式日志（前缀 [容器启动]）后删除该文件——容器引导信息因此也进
#   日志文件与「运行日志」页，重启后仍可查。
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
EVT_FILE="${CONFIG_DIR:-/config}/.bootstrap-events"

# ---- 代理 ----
# 只在这里算出一个值，给 git / npm 的命令行显式使用；**不导出为 HTTP_PROXY**：
# ffmpeg 会读 HTTP_PROXY（实测对 http/https 输入都生效），一旦导出，用户在页面上关掉
# 「平台代理开关」的录制也会偷偷走代理，且拉流异常时无法区分是平台问题还是代理问题。
# 来源：LIVEGRAB_PROXY（compose 注入）优先；兼容旧配置里手写的 HTTPS_PROXY/HTTP_PROXY。
PROXY_URL="${LIVEGRAB_PROXY:-${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}}"
# 空串一律视为「未配置」（旧 compose 会注入空字符串，部分是「已配置」误判的来源）
[ -z "$PROXY_URL" ] && PROXY_URL=""

log() { echo "[entrypoint] $*"; }
# 启动引导事件 → marker 文件（服务启动后转写进日志文件）；写失败不影响启动
evt() { printf '%s %s\n' "$1" "$2" >> "$EVT_FILE" 2>/dev/null || true; }

# 带代理的 git：用 -c 传参而非环境变量，作用域仅限该次命令（与服务端 update.js 同一策略）
gitx() {
  if [ -n "$PROXY_URL" ]; then
    git -c "http.proxy=$PROXY_URL" -c "https.proxy=$PROXY_URL" "$@"
  else
    git "$@"
  fi
}

# 镜像内没有 git（旧镜像）：只能用内置代码
if ! command -v git >/dev/null 2>&1; then
  log "镜像内没有 git，使用镜像内置代码（$IMAGE_APP）"
  evt WARN "镜像内没有 git，使用镜像内置代码（$IMAGE_APP），无法在线更新"
  cd "$IMAGE_APP" && exec "$@"
fi

# 自愈：仓库存在但代码不完整（克隆中断/误删）→ 重克
if [ -d "$SRC/.git" ] && [ ! -f "$SRC/app/server/server.js" ]; then
  log "检测到代码目录不完整（$SRC），将重新克隆"
  evt INFO "检测到代码目录不完整（$SRC），重新克隆"
  rm -rf "$SRC"
fi

if [ ! -d "$SRC/.git" ]; then
  log "首次运行：克隆代码仓库 → $SRC"
  # 代理来源：compose 的 LIVEGRAB_PROXY（页面里的设置存在 /config 下、且克隆早于服务启动，
  # 此处不可用——这正是「页面配了代理、首次拉代码照样慢」的原因）。
  if [ -n "$PROXY_URL" ]; then
    log "克隆将经代理：$PROXY_URL"
    case "$PROXY_URL" in
      *127.0.0.1*|*localhost*|*0.0.0.0*)
        log "警告：代理用了回环地址（$PROXY_URL）。容器内的 127.0.0.1 指向容器自身，通常连不通；请改用 NAS 局域网 IP 或代理容器名"
        evt WARN "代理地址为回环地址（容器内指向容器自身，通常连不通）：$PROXY_URL"
        ;;
    esac
  else
    log "未设置 LIVEGRAB_PROXY，克隆将直连 GitHub（私有仓库需 LIVEGRAB_GITHUB_TOKEN；网络受限时请配置代理）"
    evt INFO "未设置代理，克隆直连 GitHub"
  fi
  # git 传输层抗抖动（与服务端 update.js 同一套策略）：
  #   「RPC failed; curl 16 Error in the HTTP2 framing layer」与「expected flush after ref listing」
  #   都出在 HTTP/2 / protocol v2 的 ref 通告协商被中间设备（代理、网关、科学上网工具）改写，
  #   改用 HTTP/1.1 + protocol v0 并关掉低速中断即可绕过；克隆失败还会自动重试 3 次。
  GIT_FIX="-c http.version=HTTP/1.1 -c http.postBuffer=524288000 -c protocol.version=0"
  # 禁止交互式凭据提示：私有仓库未配 token 时 git 会挂在「Username for …」等待输入，
  # 容器表现为「启动卡死」，必须让它直接失败。
  GIT_TERMINAL_PROMPT=0
  GIT_ASKPASS=echo
  export GIT_TERMINAL_PROMPT GIT_ASKPASS
  CLONE_OK=0
  CLONE_TRY=1
  while [ "$CLONE_TRY" -le 3 ] && [ "$CLONE_OK" != "1" ]; do
    if [ "$CLONE_TRY" -gt 1 ]; then
      log "克隆失败，第 $CLONE_TRY 次重试（HTTP/1.1 + protocol v0）…"
      evt WARN "克隆失败，第 $CLONE_TRY 次重试"
      sleep 3
    fi
    rm -rf "$SRC.tmp"
    if [ -n "${LIVEGRAB_GITHUB_TOKEN:-}" ]; then
      AUTH=$(printf 'x-access-token:%s' "$LIVEGRAB_GITHUB_TOKEN" | base64 | tr -d '\n')
      gitx $GIT_FIX -c "http.extraheader=Authorization: Basic $AUTH" clone -b "$BRANCH" "$REPO_URL" "$SRC.tmp" && CLONE_OK=1
    else
      gitx $GIT_FIX clone -b "$BRANCH" "$REPO_URL" "$SRC.tmp" && CLONE_OK=1
    fi
    CLONE_TRY=$((CLONE_TRY + 1))
  done
  if [ "$CLONE_OK" = "1" ]; then
    # 原子替换：克隆完整后才落位，避免把半成品 .git 留在 $SRC
    rm -rf "$SRC"
    mv "$SRC.tmp" "$SRC"
    git config --global --add safe.directory "$SRC" 2>/dev/null || true
    # 让容器内的手工 git 操作也走稳定传输（HTTP/2 在弱网/代理下容易断）
    git config --global http.version HTTP/1.1 2>/dev/null || true
    # 切到镜像内置版本（.build-info.json 的 version → v<version> 标签），
    # 保证首启代码与镜像内 node_modules 匹配；无对应标签则用仓库最新代码
    if [ -f "$IMAGE_APP/.build-info.json" ]; then
      VER=$(node -e "try{console.log(require('$IMAGE_APP/.build-info.json').version||'')}catch(e){}" 2>/dev/null || true)
      if [ -n "$VER" ] && git -C "$SRC" rev-parse -q --verify "refs/tags/v$VER" >/dev/null 2>&1; then
        git -C "$SRC" checkout -q -B main "refs/tags/v$VER"
        git -C "$SRC" branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
        log "已切换到镜像内置版本 v$VER（后续通过页面「立即更新」升级）"
        evt INFO "首次运行克隆成功：$SRC，已切换到镜像内置版本 v$VER"
      else
        log "未找到镜像版本对应的标签 v$VER，使用仓库最新代码"
        evt INFO "首次运行克隆成功：$SRC，未找到标签 v$VER，使用仓库最新代码"
      fi
    else
      evt INFO "首次运行克隆成功：$SRC（无构建版本信息，使用仓库最新代码）"
    fi
    # 用镜像内编译好的 node_modules 预热（Linux 原生，免去首启现场编译 better-sqlite3）
    if [ ! -d "$SRC/app/node_modules" ] && [ -d "$IMAGE_APP/node_modules" ]; then
      if cp -a "$IMAGE_APP/node_modules" "$SRC/app/node_modules" 2>/dev/null; then
        log "已预热 node_modules"
        evt INFO "已用镜像内 node_modules 预热（免首启编译 better-sqlite3）"
      else
        log "node_modules 预热失败，将依赖 npm install"
        evt WARN "node_modules 预热失败，将依赖 npm install"
      fi
    fi
  else
    rm -rf "$SRC.tmp"
    log "克隆失败（已重试 3 次：网络不通、私有仓库未配置 LIVEGRAB_GITHUB_TOKEN，或代理改写了 git 连接）"
    log "排查代理：确认 compose/.env 的 LIVEGRAB_PROXY 是「容器能到达」的地址（容器内 127.0.0.1 指向容器自身，应填 NAS 局域网 IP 或代理容器名）"
    log "本次使用镜像内置代码启动；网络/token 恢复后重启容器会重试克隆"
    evt ERROR "克隆失败（已重试 3 次；网络不通或未配置 LIVEGRAB_GITHUB_TOKEN），本次使用镜像内置代码；恢复后重启容器会重试"
  fi
else
  evt INFO "使用持久化代码目录 $SRC（容器重启不丢失，页面「立即更新」在此升级）"
fi

APP_DIR="$SRC/app"
if [ ! -f "$APP_DIR/server/server.js" ]; then
  log "代码目录不可用（$APP_DIR），回退镜像内置代码"
  evt WARN "代码目录不可用（$APP_DIR），回退镜像内置代码 $IMAGE_APP"
  APP_DIR="$IMAGE_APP"
fi

# 自愈：运行目录缺少 node_modules（被某次失败的 npm install 破坏/清空）时，
# 先从镜像内置的 /app/node_modules 原样拷回一份好的原生模块（better-sqlite3 等），
# 避免「启动即崩溃 / 页面打不开」。仅当缺失时拷贝，已存在则不触碰（保留 npm install 的成果）。
if [ ! -d "$APP_DIR/node_modules" ] && [ -d "$IMAGE_APP/node_modules" ]; then
  log "运行目录缺少 node_modules，从镜像内置恢复：$IMAGE_APP/node_modules → $APP_DIR/node_modules"
  evt WARN "运行目录缺少 node_modules，从镜像内置恢复（免现场编译 better-sqlite3）"
  cp -a "$IMAGE_APP/node_modules" "$APP_DIR/node_modules" 2>/dev/null || \
    log "node_modules 恢复失败，将依赖后续 npm install"
fi

cd "$APP_DIR" || { log "无法进入 $APP_DIR"; exit 1; }

# 依赖校正：有网时补齐/升级依赖；失败（离线等）不阻断启动，继续使用现有 node_modules
# npm 有自己的代理配置项（不读 HTTP_PROXY 也行），这里用 npm_config_* 命名，既让 npm 走代理，
# 又不会被 ffmpeg 误读（它只认 HTTP_PROXY）。
if [ -n "$PROXY_URL" ]; then
  export npm_config_proxy="$PROXY_URL"
  export npm_config_https_proxy="$PROXY_URL"
fi
if command -v npm >/dev/null 2>&1 && [ -f package.json ]; then
  if timeout 180 npm install --omit=dev --no-audit --no-fund --prefer-offline >/tmp/livegrab-npm-boot.log 2>&1; then
    log "依赖检查完成"
    evt INFO "启动依赖检查完成"
  else
    NPM_TAIL=$(tail -n 1 /tmp/livegrab-npm-boot.log 2>/dev/null | cut -c1-160)
    log "依赖安装失败或超时（不影响启动，继续使用现有 node_modules）："
    tail -n 3 /tmp/livegrab-npm-boot.log 2>/dev/null | sed 's/^/    /'
    evt WARN "启动依赖安装失败或超时（不影响启动，继续使用现有 node_modules）：${NPM_TAIL:-无输出}"
  fi
fi

log "启动服务：$APP_DIR"
exec "$@"
