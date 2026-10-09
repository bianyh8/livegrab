/* LiveGrab · views/events.js —— 最近事件（左侧导航「最近事件」）
   展示引擎与任务的关键动作（logger 环抽最新 N 条，最新在前），随 status SSE 实时刷新；
   完整记录见「运行日志」页。 */

import { api } from '../api.js';
import { esc, formatLogTime, emptyBox } from '../ui.js';

const MAX_EVENTS = 20;

let boundRoot = null;
let offStatus = null;

const state = { events: [], pending: false };

export function destroy() {
  if (offStatus) { offStatus(); offStatus = null; }
  boundRoot = null;
}

export async function render(root, ctx) {
  boundRoot = root;
  root.innerHTML = `<div class="card"><div class="empty">正在加载事件…</div></div>`;

  if (offStatus) { offStatus(); offStatus = null; }
  offStatus = ctx.on('status', () => refreshEvents());

  ctx.onRefresh(() => refreshEvents());
  await refreshEvents(true);
}

async function refreshEvents(initial) {
  const root = boundRoot;
  if (!root || state.pending) return;
  state.pending = true;
  try {
    const st = await api.status().catch(() => null);
    state.events = (st && st.recent) || [];
    if (initial || !root.querySelector('#evList')) {
      paint();
    } else {
      const box = root.querySelector('#evList');
      if (box) box.innerHTML = eventsHtml();
    }
  } catch (e) {
    if (initial) root.innerHTML = `<div class="card"><div class="empty">事件加载失败：${esc(e.message || e)}</div></div>`;
  } finally {
    state.pending = false;
  }
}

function paint() {
  const root = boundRoot;
  if (!root) return;
  root.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>最近事件</h3><span class="hint">引擎与任务的关键动作 · 最新在前 · 最多 ${MAX_EVENTS} 条</span></div>
      <div class="card-b" id="evList">${eventsHtml()}</div>
    </div>
    <div class="hintline" style="margin:2px 2px 0">完整记录（含过滤、导出）请到左侧「运行日志」页查看。</div>`;
}

function eventsHtml() {
  if (!state.events.length) return emptyBox('暂无事件');
  return `<div class="tl">${state.events.slice(0, MAX_EVENTS).map((l) => {
    const level = String(l.level || 'INFO').toUpperCase();
    const cls = level === 'ERROR' ? 'e' : level === 'WARN' ? '' : 'i';
    const who = l.taskName ? `${esc(l.taskName)} · ` : '';
    return `<div class="tl-item ${cls}"><div class="tx">${who}${esc(l.msg || '')}</div><div class="tm">${esc(formatLogTime(l.ts))}</div></div>`;
  }).join('')}</div>`;
}