// 关闭 HTTP 服务回归测试（离线、自包含）：
//   验证「更新后自重启」不会被页面开着的 SSE 长连接卡死。
//   对照组复现根因：单独 server.close() 时，存在 keep-alive 长连接 → 回调不触发；
//   修复后：closeHttpServer 先断开 SSE 并带超时兜底，必然在兜底时限内返回。
import http from 'node:http';
import { closeAllSse, closeHttpServer } from '../server/httpClose.js';

let bad = 0;
const check = (cond, label, extra = '') => { if (!cond) bad++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  → ${extra}` : ''}`); };

/** 起一个「只发 SSE、不结束响应」的服务（模拟真实 /api/events 长连接） */
function startSseServer() {
  const sseClients = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    // 刻意不 res.end()：保持长连接（与真实 SSE 一致）
  });
  return { server, sseClients };
}

/** 建立客户端长连接并等到 TCP 建连 + 服务端登记完成 */
async function openSse(port) {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events' });
  await new Promise((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
  req.on('data', () => {}); // 持续消费，避免背压
  await new Promise((r) => setTimeout(r, 150));
  return req;
}

console.log('== 对照组：仅 server.close() 会被长连接拖住（复现根因） ==');
{
  const { server } = startSseServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cli = await openSse(port);
  const closedFast = await new Promise((resolve) => {
    let done = false;
    server.close(() => { done = true; resolve(true); });
    setTimeout(() => { if (!done) resolve(false); }, 1000);
  });
  check(closedFast === false, '有长连接时 server.close() 1s 内不回调（复现「重启卡死」根因）', `closedFast=${closedFast}`);
  try { cli.destroy(); } catch { /* ignore */ }
}

console.log('== 修复后：closeHttpServer 必然在兜底时限内返回 ==');
{
  const { server, sseClients } = startSseServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cli = await openSse(port);
  check(sseClients.size === 1, 'SSE 长连接已建立并登记', String(sseClients.size));
  const t0 = Date.now();
  await closeHttpServer(server, sseClients, 1500);
  const dt = Date.now() - t0;
  check(dt < 3000, 'closeHttpServer 在超时兜底内返回（不被长连接永久阻塞）', `${dt}ms`);
  check(sseClients.size === 0, 'SSE 连接集合已清空', String(sseClients.size));
  try { cli.destroy(); } catch { /* ignore */ }
}

console.log('== 边界：无 SSE 连接时也应快速关闭 ==');
{
  const { server, sseClients } = startSseServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  await closeHttpServer(server, sseClients, 1500);
  const dt = Date.now() - t0;
  check(dt < 1000, '无连接时快速返回', `${dt}ms`);
}

console.log('== closeAllSse 幂等 / 容错 ==');
{
  check((() => { try { closeAllSse(null); return true; } catch { return false; } })(), 'closeAllSse(null) 不抛错');
  const set = new Set();
  let ended = 0;
  set.add({ end() { ended++; } });
  closeAllSse(set);
  check(ended === 1 && set.size === 0, 'closeAllSse 调用 end() 并清空集合', `ended=${ended} size=${set.size}`);
}

console.log(bad === 0 ? '\n关闭 HTTP 服务：全部通过 ✅' : `\n${bad} 项失败 ❌`);
process.exit(bad ? 1 : 0);
