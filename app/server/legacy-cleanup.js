// legacy-cleanup.js —— 旧 JSON 时代的遗留文件清理（独立方法，整体可删）
//
// 用途：v2 起 SQLite 是唯一存储，旧 JSON 状态与旧备份不再需要。
// 只做「删除」一件事，调用点仅有一处（server.js bootstrap）。
// 以后若已无历史包袱，删掉本文件 + bootstrap 里那一行调用即可，不影响其它逻辑。
import fs from 'node:fs/promises';
import path from 'node:path';

/** 需要清理的遗留项（相对 configDir） */
const LEGACY_TARGETS = [
  { rel: 'state.json', label: 'state.json（旧 JSON 状态）' },
  { rel: 'backup-pre-sqlite', label: 'backup-pre-sqlite（旧迁移备份目录）' },
];

/**
 * 清理旧 JSON 遗留文件；不存在则跳过。返回被清理项的说明数组（用于日志）。
 * @param {string} configDir 配置目录（config/）
 */
export async function cleanupLegacyFiles(configDir) {
  const removed = [];
  for (const t of LEGACY_TARGETS) {
    const p = path.join(configDir, t.rel);
    try {
      const st = await fs.lstat(p);
      if (st.isDirectory()) await fs.rm(p, { recursive: true, force: true });
      else await fs.rm(p, { force: true });
      removed.push(t.label);
    } catch { /* 不存在或已清理：忽略 */ }
  }
  return removed;
}
