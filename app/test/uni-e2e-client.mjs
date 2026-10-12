// 统一任务弹窗后端 E2E 客户端：假定服务器已在 http://127.0.0.1:8091 运行（由外部启动）。
import { rmSync } from 'node:fs';

const port = 8091;
const base = `http://127.0.0.1:${port}`;
const dir = process.env.UNI_TEST_DIR;

let cookie = '';
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data.data;
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
};

try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { await api('POST', '/api/auth/init', { username: 'admin', password: 'test1234' }); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!ready) throw new Error('server not ready');

  const st = await api('GET', '/api/settings');
  console.log(`settings: reconnectMax=${st.reconnectMax} poll=${st.pollIntervalSec} defaultQuality=${st.defaultQuality}`);

  const created = await api('POST', '/api/tasks', {
    platform: 'douyin', roomId: '7123456789012345678', anchorName: '测试主播',
    overrides: { quality: 'bluray', segmentMode: 'size', namingProfileId: 'p_douyin' },
    segmentSizeMB: 4096, autoMerge: true, autoRecord: true, monitorOnly: false,
    reconnectMax: 8, pollIntervalSec: 120,
  });
  const tid = created.id;
  console.log(`created: id=${tid} reconnectMax=${created.reconnectMax} poll=${created.pollIntervalSec} overrides=${JSON.stringify(created.overrides)} segMode=${created.segmentMode} size=${created.segmentSizeMB} q=${created.quality}`);

  check('create reconnectMax=8', created.reconnectMax === 8, String(created.reconnectMax));
  check('create poll=120', created.pollIntervalSec === 120, String(created.pollIntervalSec));
  check('create naming override', created.overrides?.namingProfileId === 'p_douyin');
  check('create seg override=size', created.overrides?.segmentMode === 'size');
  check('create segmentSizeMB=4096', created.segmentSizeMB === 4096);
  check('create quality override=bluray', created.overrides?.quality === 'bluray');

  const upd1 = await api('PATCH', `/api/tasks/${tid}`, {
    reconnectMax: null, pollIntervalSec: 180,
    overrides: { namingProfileId: null },
    platform: 'douyin', roomId: '7123456789012345678',
  });
  console.log(`after patch1: reconnectMax=${upd1.reconnectMax} poll=${upd1.pollIntervalSec} overrides=${JSON.stringify(upd1.overrides)}`);
  check('clear reconnect -> null', upd1.reconnectMax === null || upd1.reconnectMax === undefined);
  check('poll=180 after edit', upd1.pollIntervalSec === 180, String(upd1.pollIntervalSec));
  check('naming override cleared', !upd1.overrides?.namingProfileId);
  check('quality override kept', upd1.overrides?.quality === 'bluray');
  check('seg override kept', upd1.overrides?.segmentMode === 'size');

  const upd2 = await api('PATCH', `/api/tasks/${tid}`, { reconnectMax: 3 });
  check('reconnect=3 after edit', upd2.reconnectMax === 3, String(upd2.reconnectMax));

  const upd3 = await api('PATCH', `/api/tasks/${tid}`, { url: created.sourceUrl });
  check('same-url patch keeps sourceUrl', upd3.sourceUrl === created.sourceUrl, upd3.sourceUrl);

  const list = await api('GET', '/api/tasks');
  const item = list.items.find((x) => x.id === tid);
  console.log(`list item: reconnectMax=${item.reconnectMax} poll=${item.pollIntervalSec} overrides=${JSON.stringify(item.overrides)}`);
  check('list serializes reconnectMax', item.reconnectMax === 3, String(item.reconnectMax));
  check('list serializes poll', item.pollIntervalSec === 180, String(item.pollIntervalSec));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? failed.length + ' FAILED' : 'ALL'} of ${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
} finally {
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {}
}
