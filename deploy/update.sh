#!/usr/bin/env bash
# LiveGrab 自动更新脚本（群晖 NAS 用）
# 功能：git pull → 有新提交才重建镜像 → 重启容器；数据/配置目录（./data ./config）不动
# 用法：放在 /volume1/docker/livegrab/deploy/update.sh，chmod +x
#       群晖「控制面板 → 任务计划 → 新增 → 计划的任务 → 用户自定义脚本」
#       运行命令：bash /volume1/docker/livegrab/deploy/update.sh
#       计划：建议每 10~15 分钟一次（设置里可勾选「运行以下命令」重复执行）
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

# 4) 重建并重启（兼容 docker compose / docker-compose）
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build >>"$LOG" 2>&1 || { echo "  ❌ docker compose 构建失败，详见上方日志" >> "$LOG"; exit 1; }
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build >>"$LOG" 2>&1 || { echo "  ❌ docker-compose 构建失败，详见上方日志" >> "$LOG"; exit 1; }
else
  echo "  ❌ 未找到 docker compose / docker-compose" >> "$LOG"
  exit 1
fi

echo "  ✅ 部署完成 $(date '+%F %T')" >> "$LOG"
