#!/usr/bin/env bash
# LiveGrab 自动更新脚本（群晖 NAS 用）
# 功能：git pull → 有新提交才重建镜像 → 重启容器；数据/配置目录（./data ./config）不动
#       架构 B 下容器从 ./config/src 运行代码，本脚本额外在宿主机同步该目录并在有更新时重启容器
# 用法：放在 /volume1/docker/livegrab/deploy/update.sh，chmod +x
#       群晖「控制面板 → 任务计划 → 新增 → 计划的任务 → 用户自定义脚本」
#       运行命令：bash /volume1/docker/livegrab/deploy/update.sh
#       计划：建议每 10~15 分钟一次（设置里可勾选「运行以下命令」重复执行）
# 注意：页面「系统设置 → 立即更新」会在容器内自行完成代码更新，本脚本与其等价；
#       两者都只做快进拉取，本地有未提交改动时会记日志并跳过。
set -uo pipefail

BASE=/volume1/docker/livegrab
LOG="$BASE/update.log"
REPO=https://github.com/bianyh8/livegrab.git

echo "=== $(date '+%F %T') 检查更新 ===" >> "$LOG"

# 1) 确保是 git 仓库（首次部署时若文件夹不是 clone 的，自动转换为 git 仓库并保留 data/config）
if [ ! -d "$BASE/.git" ]; then
  echo "  [初始化] $BASE 不是 git 仓库，开始转换（保留 data/config）" >> "$LOG"
  cd /volume1/docker || { echo "  ❌ /volume1/docker 不存在" >> "$LOG"; exit 1; }
  BK="livegrab.bak.$(date +%s)"
  mv livegrab "$BK" || { echo "  ❌ 无法移动 livegrab" >> "$LOG"; exit 1; }
  git clone "$REPO" livegrab || { echo "  ❌ git clone 失败" >> "$LOG"; mv "$BK" livegrab; exit 1; }
  for d in data config; do
    if [ -d "$BK/$d" ]; then cp -a "$BK/$d" livegrab/ 2>>"$LOG"; fi
  done
  echo "  [初始化] 完成，旧目录备份在 $BK（确认无误后可删除）" >> "$LOG"
fi

cd "$BASE" || exit 1

# 2) 拉取远程
git fetch origin >/dev/null 2>>"$LOG" || { echo "  ⚠️ git fetch 失败（网络？），跳过本次" >> "$LOG"; exit 0; }
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null || echo "$LOCAL")
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "  无新提交（$LOCAL），跳过构建" >> "$LOG"
  exit 0
fi

# 3) 更新代码（只快进，不产生 merge commit；本地有未提交改动会失败并记录）
git pull --ff-only origin main 2>>"$LOG" || git pull --ff-only origin master 2>>"$LOG" || {
  echo "  ❌ git pull 失败（本地可能有未提交改动），请手动处理" >> "$LOG"
  exit 1
}
echo "  新提交：$LOCAL → $(git rev-parse HEAD)" >> "$LOG"

# 4) 同步容器运行代码（架构 B：容器从 ./config/src 运行，重建镜像不会自动更新它）
#    在宿主机直接 pull：群晖计划任务以 root 运行，与容器内 root 写入的文件属主一致。
#    拉不动（目录不存在/属主不符/无凭据）不阻塞——容器下次启动会自动克隆，或页面「立即更新」可补救。
SRC="$BASE/config/src"
CODE_MOVED=0
if [ -d "$SRC/.git" ]; then
  BEFORE=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo "")
  if git -C "$SRC" pull --ff-only origin main >>"$LOG" 2>&1 || git -C "$SRC" pull --ff-only origin master >>"$LOG" 2>&1; then
    AFTER=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$BEFORE" ] && [ "$BEFORE" != "$AFTER" ]; then
      CODE_MOVED=1
      echo "  容器运行代码已更新：${BEFORE:0:12} → ${AFTER:0:12}" >> "$LOG"
    fi
  else
    echo "  ⚠️ 容器运行代码（$SRC）更新失败，请在页面点「立即更新」，或删除该目录后重启容器重新克隆" >> "$LOG"
  fi
else
  echo "  容器运行代码目录不存在（$SRC），将在容器下次启动时自动克隆" >> "$LOG"
fi

# 5) 重建并重启（兼容 docker compose / docker-compose）
#    构建时注入当前 commit，供容器内「系统更新」精确比对版本（避免误报更新）。
BUILD_COMMIT=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "")
if docker compose version >/dev/null 2>&1; then
  BUILD_COMMIT="$BUILD_COMMIT" docker compose build >>"$LOG" 2>&1 || { echo "  ❌ docker compose 构建失败，详见上方日志" >> "$LOG"; exit 1; }
  docker compose up -d >>"$LOG" 2>&1 || { echo "  ❌ docker compose 启动失败，详见上方日志" >> "$LOG"; exit 1; }
elif command -v docker-compose >/dev/null 2>&1; then
  BUILD_COMMIT="$BUILD_COMMIT" docker-compose build >>"$LOG" 2>&1 || { echo "  ❌ docker-compose 构建失败，详见上方日志" >> "$LOG"; exit 1; }
  docker-compose up -d >>"$LOG" 2>&1 || { echo "  ❌ docker-compose 启动失败，详见上方日志" >> "$LOG"; exit 1; }
else
  echo "  ❌ 未找到 docker compose / docker-compose" >> "$LOG"
  exit 1
fi

# 6) 运行代码有更新时重启容器加载（镜像未变化时 up -d 不会重启容器）
if [ "$CODE_MOVED" = "1" ]; then
  if docker compose version >/dev/null 2>&1; then
    if docker compose restart livegrab >>"$LOG" 2>&1; then echo "  已重启容器加载新代码" >> "$LOG"; else echo "  ⚠️ 重启失败，请手动 docker compose restart livegrab" >> "$LOG"; fi
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose restart livegrab >>"$LOG" 2>&1 || echo "  ⚠️ 重启失败，请手动重启容器" >> "$LOG"
  fi
fi

echo "  ✅ 部署完成 $(date '+%F %T')" >> "$LOG"
