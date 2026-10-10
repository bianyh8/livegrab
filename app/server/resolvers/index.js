// 平台识别与统一入口
import { HttpError } from '../util.js';
import * as bilibili from './bilibili.js';
import * as douyin from './douyin.js';
import * as cn from './cn.js';
import * as direct from './direct.js';

export const Q = {
  origin: { id: 'origin', label: '原画', note: '最高可用画质' },
  bluray: { id: 'bluray', label: '蓝光', note: '1080P' },
  uhd: { id: 'uhd', label: '超清', note: '720P' },
  hd: { id: 'hd', label: '高清', note: '540P' },
  sd: { id: 'sd', label: '标清', note: '360P' },
  audio: { id: 'audio', label: '仅音频', note: 'AAC 128k' },
};

const q = (...ids) => ids.map((id) => Q[id]);

export const PLATFORMS = [
  {
    id: 'bilibili', name: '哔哩哔哩', handler: bilibili, tier: 'stable',
    match: /(?:live\.bilibili\.com|b23\.tv|bilibili\.com\/blanc)/i,
    qualities: q('origin', 'bluray', 'uhd', 'hd', 'sd', 'audio'),
    cap: 4, needCookie: false, cookieHow: 'qr',
    note: '官方公开接口，多档清晰度可切换',
  },
  {
    id: 'douyin', name: '抖音', handler: douyin, tier: 'stable',
    match: /(?:live\.douyin\.com|v\.douyin\.com|douyin\.com\/user)/i,
    qualities: q('origin', 'uhd', 'hd', 'sd', 'audio'),
    cap: 4, needCookie: false, cookieHow: '免登录',
    note: '实测（2026-10）移动端接口免登录即可解析并录制（房间号请填 19 位内部号，短号需 Cookie）；接口变更时可粘 Cookie 兜底，或用「直链」任务',
  },
  {
    id: 'huya', name: '虎牙', handler: cn.huya, tier: 'stable',
    match: /huya\.com/i, qualities: q('origin', 'bluray', 'hd', 'sd', 'audio'),
    cap: 3, needCookie: false, cookieHow: 'none', note: '页面内嵌流地址解析',
  },
  {
    id: 'douyu', name: '斗鱼', handler: cn.douyu, tier: 'stable',
    match: /douyu\.com/i, qualities: q('origin', 'bluray', 'hd', 'sd', 'audio'),
    cap: 3, needCookie: false, cookieHow: 'none', note: '公开接口解析',
  },
  {
    id: 'kuaishou', name: '快手', handler: cn.kuaishou, tier: 'stable',
    match: /(?:live\.kuaishou\.com|kuaishou\.com)/i, qualities: q('origin', 'hd', 'sd', 'audio'),
    cap: 3, needCookie: true, cookieHow: 'auto', note: '可自动获取 Cookie（约 24 小时）',
  },
  {
    id: 'xiaohongshu', name: '小红书', handler: cn.xiaohongshu, tier: 'experimental',
    match: /xiaohongshu\.com/i, qualities: [Q.origin], cap: 2, needCookie: true, cookieHow: 'paste',
    note: '实验性：仅默认画质、不可切换',
  },
  {
    id: 'weibo', name: '微博', handler: cn.weibo, tier: 'experimental',
    match: /weibo\.com|weibo\.cn/i, qualities: q('hd'), cap: 2, needCookie: true, cookieHow: 'paste',
    note: '实验性：最高 720P',
  },
  {
    id: 'acfun', name: 'AcFun', handler: null, tier: 'planned',
    match: /acfun\.cn/i, qualities: q('origin', 'hd', 'sd'), cap: 2, needCookie: false, cookieHow: 'none',
    note: '待接入（P1）',
  },
  {
    id: 'direct', name: '直链', handler: direct, tier: 'stable',
    match: null, qualities: q('origin', 'audio'), cap: 8, needCookie: false, cookieHow: 'none',
    note: '直接粘贴 m3u8 / flv / ts / mp4 流地址，不解析平台',
  },
];

export function getPlatform(id) { return PLATFORMS.find((p) => p.id === id) || null; }

export function detectPlatform(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const pref = /^([a-z]+):(.*)$/i.exec(s);
  if (pref && getPlatform(pref[1].toLowerCase())) return pref[1].toLowerCase();
  if (/^https?:\/\//i.test(s)) {
    for (const p of PLATFORMS) if (p.match && p.match.test(s)) return p.id;
    if (/\.(m3u8|flv|ts|mp4|m4a)(\?|$)/i.test(s)) return 'direct';
    return null;
  }
  return null;
}

export function roomIdFrom(platformId, input) {
  const p = getPlatform(platformId);
  const s = String(input || '').trim();
  if (platformId === 'direct') return s;
  const pref = /^[a-z]+:(.*)$/i.exec(s);
  const body = pref ? pref[1] : s;
  if (p?.handler?.roomIdFrom) {
    const r = p.handler.roomIdFrom(body);
    if (r) return r;
  }
  const m = /(\d{3,})/.exec(body);
  return m ? m[1] : body;
}

export function platformList(settings) {
  const caps = settings?.platformCaps || {};
  const enabled = settings?.platformEnabled || {};
  return PLATFORMS.map((p) => ({
    id: p.id, name: p.name, tier: p.tier, note: p.note,
    enabled: enabled[p.id] ?? p.tier !== 'planned',
    implemented: !!p.handler,
    needCookie: p.needCookie, cookieHow: p.cookieHow,
    qualities: p.qualities,
    cap: caps[p.id] ?? p.cap,
    active: 0,
  }));
}

export async function resolveRoom(input, ctx = {}) {
  const url = String(input || '').trim();
  if (!url) throw new HttpError('INVALID_URL', '请输入直播间地址或房间号', 400);
  const platformId = ctx.platform || detectPlatform(url);
  if (!platformId) {
    throw new HttpError('INVALID_URL', '无法识别平台：可粘贴完整直播间链接，或先手动指定平台再输入房间号（也支持直链 m3u8/flv/ts）', 400);
  }
  const p = getPlatform(platformId);
  if (!p?.handler) throw new HttpError('NOT_IMPLEMENTED', `${p?.name || platformId} 暂未接入，可在"直链"里粘贴流地址`, 400);
  const roomId = roomIdFrom(platformId, url);
  const info = await p.handler.resolveRoom({ roomId, url, settings: ctx.settings, logger: ctx.logger });
  return {
    platform: p.id, platformName: p.name, tier: p.tier, roomId: info.roomId || roomId,
    url, anchorName: info.anchorName || '', title: info.title || '', avatar: info.avatar || '',
    liveStatus: info.liveStatus || 'unknown', online: info.online ?? null,
    qualityOptions: info.qualityOptions || p.qualities,
    // 解析器给出的具体原因优先（例如"未开播：接口 10011"），否则回落到平台通用说明
    note: info.note || p.note, platformNote: p.note,
  };
}

/**
 * 轻量直播状态探测（公用轮询方法）：
 * 只判断直播开/关，不回传 / 不写主播信息（anchorName/title/avatar 等）。
 * 调度器定时轮询统一走这里，主播信息只在「编辑界面点解析」时通过 resolveRoom 刷新，
 * 从而减少轮询带来的流量与资源消耗，也避免覆盖用户自定义的主播名。
 */
export async function probeLive(input, ctx = {}) {
  const url = String(input || '').trim();
  const platformId = ctx.platform || detectPlatform(url);
  if (!platformId) return { platform: null, liveStatus: 'unknown', online: null };
  const p = getPlatform(platformId);
  if (!p?.handler) return { platform: p?.id || platformId, liveStatus: 'unknown', online: null };
  const roomId = roomIdFrom(platformId, url);
  // probe:true 通知解析器跳过主播信息补全请求（抖音短号回查、B站主播信息接口等），只返回直播状态
  const info = await p.handler.resolveRoom({ roomId, url, settings: ctx.settings, logger: ctx.logger, probe: true });
  return {
    platform: p.id, platformName: p.name, roomId: info.roomId || roomId,
    liveStatus: info.liveStatus || 'unknown', online: info.online ?? null,
  };
}

/** 按 task.quality → settings.qualityFallback 依次尝试，返回第一个可用流 */
export async function resolveStream(task, ctx = {}) {
  const p = getPlatform(task.platform);
  if (!p?.handler) throw new HttpError('NOT_IMPLEMENTED', `${p?.name || task.platform} 暂未接入`, 400);
  const settings = ctx.settings || {};
  const order = [task.quality, ...(task.qualityFallback || []), ...(settings.qualityFallback || [])]
    .filter((v, i, a) => v && a.indexOf(v) === i);
  const tried = [];
  for (const quality of order) {
    try {
      const r = await p.handler.resolveStream({
        roomId: String(task.roomId || ''), quality, task, settings, logger: ctx.logger,
      });
      if (r?.url) {
        return { ...r, quality, qualityLabel: Q[quality]?.label || quality, platformName: p.name, tried };
      }
      tried.push(`${quality}: 无可用地址`);
    } catch (e) {
      tried.push(`${quality}: ${e.message}`);
      if (e.code === 'AUTH' || e.code === 'BLOCKED' || e.code === 'ROOM_NOT_FOUND') throw e;
    }
  }
  const err = new HttpError('NO_STREAM', `所有清晰度均不可用（${tried.join('；')}）`, 502);
  err.tried = tried;
  throw err;
}
