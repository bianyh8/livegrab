/* LiveGrab · i18n.js —— 界面文案外置
   字典存放于 app/web/i18n/zh-CN.json（后端 GET /api/i18n 读取，可外部编辑/换语言）。
   t(key, ...args) 查字典返回文案，缺键回退到 key 本身；{0}{1} 为参数占位。
   加载失败时字典为空，界面会短暂显示 key，随后被成功加载覆盖。 */

let dict = {};
const loaded = [];

export function t(key, ...args) {
  let s = dict[key];
  if (s == null) s = key;
  if (args && args.length) {
    args.forEach((v, i) => { s = s.replace(new RegExp('\\{' + i + '\\}', 'g'), String(v)); });
  }
  return s;
}

// 供离屏/不依赖网络时同步访问是否已就位
export function i18nLoaded() { return loaded.length > 0; }

// 拉取后端字典并合并（后端 JSON 为权威，覆盖当前 dict）
export async function loadI18n() {
  try {
    const res = await fetch('/api/i18n', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data === 'object') { dict = data; loaded.push(Date.now()); }
  } catch { /* 网络失败：保留当前 dict（可能为空），不阻塞启动 */ }
  return i18nLoaded();
}