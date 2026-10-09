// 直链：直接粘贴 m3u8 / flv / ts / mp4 流地址（不解析平台，也便于自测）
import { HttpError } from '../util.js';

const OK_EXT = /\.(m3u8|flv|ts|mp4|m4a|mkv|rtmp)(\?|$)/i;

export function roomIdFrom(input) { return String(input || '').trim(); }

export async function resolveRoom({ roomId, url }) {
  const target = String(roomId || url || '').trim();
  if (!target) throw new HttpError('INVALID_URL', '请输入流地址', 400);
  if (!/^(https?|rtmp):\/\//i.test(target) && !OK_EXT.test(target)) {
    throw new HttpError('INVALID_URL', '看起来不是流地址：请粘贴 http(s):// 开头的 m3u8 / flv / ts / mp4 链接', 400);
  }
  const name = target.split('/').pop()?.split('?')[0] || target;
  return {
    roomId: target,
    anchorName: '直链任务',
    title: name,
    avatar: '',
    liveStatus: 'live', // 直链不做开播轮询，创建后立即开始
    online: null,
    qualityOptions: [
      { id: 'origin', label: '原始流', note: '直接复制，不转码' },
      { id: 'audio', label: '仅音频', note: 'AAC 128k' },
    ],
  };
}

export async function resolveStream({ roomId, quality }) {
  return { url: String(roomId), resolution: '', headers: {}, qualityActual: quality };
}
