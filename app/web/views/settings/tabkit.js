/* LiveGrab · views/settings/tabkit.js
   设置页签共用的小工具：统一的「改设置 → 去抖保存」入口，避免每个页签各写一套。
   set(path, value) 会写入 state.settings 并触发 PUT /api/settings（500ms 去抖）。 */

export function read(state, path, fallback) {
  let cur = state.settings || {};
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }
  return cur === null || cur === undefined ? fallback : cur;
}

export function makeKit(state, ctx, notify) {
  const set = (path, value) => {
    const parts = path.split('.');
    let cur = state.settings;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    if (typeof notify === 'function') notify();
  };
  return {
    state,
    ctx,
    api: ctx.api,
    get: (path, fallback) => read(state, path, fallback),
    set,
    /** 绑定输入框：change/input 事件把值写回设置 */
    bind(input, path, type = 'text') {
      if (!input) return;
      const handler = () => {
        if (type === 'number') set(path, Number(input.value) || 0);
        else if (type === 'bool') set(path, !!input.checked);
        else set(path, input.value);
      };
      input.addEventListener('change', handler);
      if (type === 'text') input.addEventListener('input', handler);
    },
  };
}
