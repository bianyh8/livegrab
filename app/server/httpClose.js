/* LiveGrab · server/httpClose.js —— HTTP 服务关闭工具（零依赖，便于单测）

背景（真实故障）：更新完成后自重启会 `await server.close()`，但
`server.close()` 只在「所有连接都关闭」后才回调；页面通过 `/api/events` 开着
keep-alive 的 SSE 长连接，会让回调永不触发 —— 进程于是既不退出、也不再接受新连接
（表现为「更新成功、服务在跑，但网页打不开、需手工重启容器」）。
因此关闭前必须主动断开 SSE，并对 `server.close()` 加超时兜底。 */

/** 主动断开全部 SSE 连接并清空集合。sseClients 为可迭代集合（通常为 Set）。 */
export function closeAllSse(sseClients) {
  if (!sseClients) return;
  try {
    for (const c of sseClients) { try { c.end(); } catch { /* ignore */ } }
  } catch { /* ignore */ }
  if (typeof sseClients.clear === 'function') sseClients.clear();
}

/** 优雅关闭 HTTP 服务：先断开 SSE，再 server.close()，并用超时兜底保证一定继续。
 *  @param {import('node:http').Server} server
 *  @param {Set<any>} [sseClients] 需要主动断开的 SSE 响应集合
 *  @param {number} [timeoutMs=3000] 超时兜底：到点无论连接是否收尾都继续
 *  @returns {Promise<void>} */
export function closeHttpServer(server, sseClients, timeoutMs = 3000) {
  closeAllSse(sseClients);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { server.close(finish); } catch { finish(); }
    // Node 18.2+：强制销毁剩余连接（含轮询等在途请求），避免个别连接拖住关闭
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    // 兜底：不 unref，确保进程活到兜底触发，绝不会被长连接永久阻塞
    setTimeout(finish, timeoutMs);
  });
}
