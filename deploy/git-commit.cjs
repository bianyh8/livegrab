#!/usr/bin/env node
/*
 * 从 .git 目录中解析出当前提交号 —— 只读「指针文件」（HEAD / refs / packed-refs），
 * 不调用 git 命令、不读对象库，所以构建上下文里只需要带几个 KB 的指针文件。
 *
 * 用途：Dockerfile 的 gitinfo 阶段用它把提交号写进镜像的 .build-info.json，
 * 于是 `docker compose up -d --build` 零参数就能带上准确的 commit
 * （compose 不做 shell 展开，`BUILD_COMMIT=$(git rev-parse HEAD)` 这类写法传不进去）。
 *
 * 用法: node deploy/git-commit.cjs [git 目录] [ref]
 *   git 目录  默认 .git
 *   ref       指定 ref（默认取 HEAD 指向的那个）
 * 输出: 40 位提交号；解析不出来输出空字符串。
 * 退出码: 恒为 0 —— 读不到提交号（源码包、CI 浅检出等）不该让构建失败。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** 读一个 ref 指向的提交号：先看松散文件，再看 packed-refs */
function readRef(gitDir, ref) {
  if (!ref) return '';
  try {
    const v = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    // 符号 ref（如 refs/remotes/origin/HEAD 的内容是 "ref: refs/.../main"）不是提交号，交给调用方过滤
    if (v && !v.startsWith('ref:')) return v.split(/\s+/)[0];
  } catch { /* 被 packed 或不存在 */ }
  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#') || s.startsWith('^')) continue; // "^" 行是注释（该 ref 的上一版）
      const [sha, name] = s.split(/\s+/);
      if (name === ref) return sha;
    }
  } catch { /* 没有 packed-refs */ }
  return '';
}

function resolveCommit(gitDir, refArg) {
  let head = '';
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { /* 没有 .git */ }
  let sha = '';
  let ref = refArg || '';
  if (head.startsWith('ref:')) {
    ref = ref || head.slice(4).trim();
    sha = readRef(gitDir, ref);
  } else if (head) {
    sha = head.split(/\s+/)[0]; // detached HEAD：HEAD 里直接就是提交号
  }
  // 兜底候选：工作树 / 浅克隆 / CI 检出的形态各不相同
  for (const cand of [ref, 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main']) {
    if (sha) break;
    sha = readRef(gitDir, cand);
  }
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : '';
}

module.exports = { resolveCommit, readRef };

if (require.main === module) {
  const [gitDir = '.git', ref = ''] = process.argv.slice(2);
  process.stdout.write(resolveCommit(gitDir, ref));
}
