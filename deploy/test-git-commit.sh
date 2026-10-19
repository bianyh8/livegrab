#!/bin/sh
# deploy/git-commit.cjs 的 fixture 测试（不依赖 docker、不依赖真 git 仓库形态）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/deploy/git-commit.cjs"
TMP="$(mktemp -d)"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
# 用法: expect_ok <名字> <期望提交号> <git目录> [ref]
expect() {
  got="$(node "$RES" "$3" ${4:+"$4"})"
  if [ "$got" = "$2" ]; then ok "$1 → $got"; else no "$1：期望 $2，实得 '$got'"; fi
}

SHA_A=0123456789abcdef0123456789abcdef01234567
SHA_B=89abcdef0123456789abcdef0123456789abcdef
SHORT=abcdef1

# ① 松散 ref（git clone / pull 后的常规形态）
mk() { rm -rf "$TMP/$1"; mkdir -p "$TMP/$1/refs/heads"; }
mk loose
printf 'ref: refs/heads/main\n' > "$TMP/loose/HEAD"
printf '%s\n' "$SHA_A" > "$TMP/loose/refs/heads/main"
expect "① 松散 ref（HEAD → refs/heads/main）" "$SHA_A" "$TMP/loose"

# ② packed-refs（ref 被 git pack-refs 打包，refs/heads/main 文件不存在）
mk packed
printf 'ref: refs/heads/main\n' > "$TMP/packed/HEAD"
printf '# pack-refs with: peeled fully-peeled sorted \n%s refs/heads/main\n%s refs/heads/dev\n^%s\n' \
  "$SHA_A" "$SHA_B" "$SHA_B" > "$TMP/packed/packed-refs"
rm -rf "$TMP/packed/refs"
expect "② packed-refs（无松散文件）" "$SHA_A" "$TMP/packed"
expect "②b packed-refs 指定其它分支" "$SHA_B" "$TMP/packed" refs/heads/dev

# ③ detached HEAD（HEAD 里直接是提交号）
mk detached
printf '%s\n' "$SHA_B" > "$TMP/detached/HEAD"
rm -rf "$TMP/detached/refs"
expect "③ detached HEAD" "$SHA_B" "$TMP/detached"

# ④ 没有 .git（源码包 / 构建上下文缺 .git）→ 空串，且退出码 0
rm -rf "$TMP/none"; mkdir -p "$TMP/none"
got="$(node "$RES" "$TMP/none"; echo "|rc=$?")"
[ "$got" = "|rc=0" ] && ok "④ 无 .git → 空串 + 退出码 0" || no "④ 无 .git：实得 '$got'"
[ -d "$TMP/none" ] && [ ! -f "$TMP/none/.git" ] && ok "④b 未创建任何文件" || no "④b 目录被污染"

# ⑤ refs/remotes/origin/HEAD 是符号 ref（内容是 'ref: ...'），不能被当成提交号；靠兜底候选解析
mk symref
printf 'ref: refs/remotes/origin/main\n' > "$TMP/symref/HEAD"
mkdir -p "$TMP/symref/refs/remotes/origin"
printf 'ref: refs/remotes/origin/main\n' > "$TMP/symref/refs/remotes/origin/HEAD"
printf '%s\n' "$SHA_A" > "$TMP/symref/refs/remotes/origin/main"
rm -rf "$TMP/symref/refs/heads"
expect "⑤ 符号 ref 不被误当提交号" "$SHA_A" "$TMP/symref"

# ⑥ 垃圾内容（HEAD 里是乱码）→ 空串，不输出脏值
mk junk
printf 'not-a-sha\n' > "$TMP/junk/HEAD"
rm -rf "$TMP/junk/refs"
got="$(node "$RES" "$TMP/junk")"
[ -z "$got" ] && ok "⑥ 垃圾内容 → 空串" || no "⑥ 垃圾内容：实得 '$got'"

# ⑦ 短 sha（某些 CI 只留短号）→ 接受 7 位以上十六进制
mk short
printf 'ref: refs/heads/main\n' > "$TMP/short/HEAD"
printf '%s\n' "$SHORT" > "$TMP/short/refs/heads/main"
expect "⑦ 短 sha" "$SHORT" "$TMP/short"

# ⑧ 真实仓库自检（本仓库 .git）：应与 git rev-parse HEAD 一致
if [ -d "$ROOT/.git" ] && command -v git >/dev/null 2>&1; then
  want="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
  got="$(node "$RES" "$ROOT/.git")"
  if [ -n "$want" ] && [ "$got" = "$want" ]; then ok "⑧ 与 git rev-parse HEAD 一致（$got）"
  else no "⑧ 真实仓库：git=$want 脚本=$got"; fi
else
  printf '  SKIP  ⑧ 本机无 .git 或无 git 命令\n'
fi

rm -rf "$TMP"
printf '结果：%d 通过 / %d 失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
