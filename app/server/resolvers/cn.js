// 国内其他平台：虎牙 / 斗鱼 / 快手（公开页面与接口解析）
// 小红书、微博、AcFun 目前未接入，会明确提示改用「直链」
import { HttpError } from '../util.js';
import { httpGet, httpJson, sliceJsonObject, DESKTOP_UA } from './http.js';

const notImplemented = (name) => {
  throw new HttpError('NOT_IMPLEMENTED', `${name} 暂未接入自动解析：可在"新建任务"里把平台选为「直链」，粘贴该直播间的 m3u8 / flv 流地址录制`, 400);
};

/* ---------------- 虎牙 ---------------- */
export const huya = {
  roomIdFrom(input) {
    const m = /huya\.com\/(?:[a-z]+\/)?(\d+)/i.exec(input) || /^(\d{4,})$/.exec(input);
    return m ? m[1] : input;
  },
  async resolveRoom({ roomId, settings, logger }) {
    const page = await httpGet(`https://www.huya.com/${encodeURIComponent(roomId)}`, {
      headers: { Referer: 'https://www.huya.com/' }, logger, label: 'huya.page',
    });
    const html = page.text || '';
    const nick = /"nick":"([^"]{1,40})"/.exec(html)?.[1] || /<h1[^>]*class="[^"]*host-name[^"]*"[^>]*>([^<]+)</.exec(html)?.[1] || '';
    const title = /"introduction":"([^"]{1,80})"/.exec(html)?.[1] || /<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</.exec(html)?.[1] || '';
    const avatar = /"(?:avatarUrl|avatar)"\s*:\s*"([^"]+)"/.exec(html)?.[1]?.replace(/\\\//g, '/') || '';
    const live = /"liveStatus":"?(\d)/.exec(html)?.[1] === '1' || /"isOn":true/.test(html) || /class="[^"]*live[^"]*"/.test(html);
    logger?.debug(`虎牙取到房间元数据：主播「${nick.trim() || '未知主播'}」，状态：${live ? '开播' : '未开播'}`);
    return {
      roomId: String(roomId), anchorName: nick.trim(), title: title.trim(), avatar,
      liveStatus: live ? 'live' : 'offline', online: null,
      qualityOptions: [{ id: 'origin', label: '原画', note: '' }, { id: 'bluray', label: '蓝光', note: '' }, { id: 'hd', label: '高清', note: '' }, { id: 'audio', label: '仅音频', note: '' }],
    };
  },
  async resolveStream({ roomId, quality, settings, logger }) {
    const page = await httpGet(`https://www.huya.com/${encodeURIComponent(roomId)}`, {
      headers: { Referer: 'https://www.huya.com/' }, logger, label: 'huya.page',
    });
    const html = page.text || '';
    const cfg = /"stream":\s*\{/.exec(html);
    const conf = cfg ? sliceJsonObject(html.slice(html.indexOf('{', cfg.index)), 0) : null;
    const info = conf?.data?.[0]?.gameStreamInfoList?.[0]
      || (() => { const j = sliceJsonObject(html, html.indexOf('hyPlayerConfig')); return j?.stream?.data?.[0]?.gameStreamInfoList?.[0]; })();
    if (info?.sFlvUrl) {
      const base = `${info.sFlvUrl}/${info.sStreamName}.flv?${info.sFlvAntiCode || ''}`.replace(/([^:])\/\//g, '$1/');
      const url = base.startsWith('http') ? base : `https:${base}`;
      return { url, resolution: '', headers: { Referer: `https://www.huya.com/${roomId}`, 'User-Agent': DESKTOP_UA }, qualityActual: quality };
    }
    // 兜底：页面里直接找 flv 地址
    const m = [...html.matchAll(/https?:\/\/[^"'\s]+?\.flv[^"'\s]*/g)].map((x) => x[0]);
    if (m.length) return { url: m[0], resolution: '', headers: { Referer: `https://www.huya.com/${roomId}` }, qualityActual: quality };
    throw new HttpError('NO_STREAM', '虎牙未开播或流地址解析失败（该平台解析逻辑需按最新页面结构验证）', 502);
  },
};

/* ---------------- 斗鱼 ---------------- */
export const douyu = {
  roomIdFrom(input) {
    const m = /douyu\.com\/(?:[a-z]+\/)?(\d+)/i.exec(input) || /^(\d{3,})$/.exec(input);
    return m ? m[1] : input;
  },
  async resolveRoom({ roomId, settings, logger }) {
    const j = await httpJson(`https://www.douyu.com/betard/${encodeURIComponent(roomId)}`, {
      headers: { Referer: `https://www.douyu.com/${roomId}` }, logger, label: 'douyu.betard',
    }).catch(() => null);
    const room = j?.room || {};
    // 斗鱼 avatar 是 {big,middle,small} 对象：取 middle 优先，兼容旧字段 owner_avatar 字符串
    const dyAvatar = (room.avatar && typeof room.avatar === 'object')
      ? (room.avatar.middle || room.avatar.big || room.avatar.small || '')
      : (room.avatar || '');
    logger?.debug(`斗鱼取到房间元数据：主播「${room.nickname || room.owner_name || '未知主播'}」，状态：${Number(room.show_status) === 1 ? '开播' : '未开播'}`);
    return {
      roomId: String(room.room_id || roomId),
      anchorName: room.nickname || room.owner_name || '',
      title: room.room_name || '',
      avatar: dyAvatar || room.owner_avatar || '',
    // 接口被吞成 null（超时/风控）或 show_status 字段缺失时是 unknown 而非 offline：
    // 探测不明确绝不能当"未开播"，否则轮询会把正在录制的任务拦腰停掉（无错误信息的短分段）
    liveStatus: Number(room.show_status) === 1 ? 'live' : (room.show_status == null ? 'unknown' : 'offline'),
      online: room.online ?? null,
      qualityOptions: [{ id: 'origin', label: '原画', note: '' }, { id: 'bluray', label: '蓝光', note: '' }, { id: 'hd', label: '高清', note: '' }, { id: 'audio', label: '仅音频', note: '' }],
    };
  },
  async resolveStream({ roomId, quality, settings, logger }) {
    const j = await httpJson(`https://www.douyu.com/betard/${encodeURIComponent(roomId)}`, {
      headers: { Referer: `https://www.douyu.com/${roomId}` }, logger, label: 'douyu.betard',
    }).catch((e) => { throw new HttpError('NO_STREAM', `斗鱼接口失败：${e.message}`, 502); });
    const room = j?.room || {};
    const rtmpUrl = room.rtmp_url;
    const rtmpLive = room.rtmp_live;
    if (rtmpUrl && rtmpLive) {
      const url = `${rtmpUrl}/${rtmpLive}`;
      if (/\.flv/.test(url)) return { url, resolution: '', headers: { Referer: `https://www.douyu.com/${roomId}` }, qualityActual: quality };
      throw new HttpError('NO_STREAM', '斗鱼返回的是 rtmp 地址，请在容器内安装带 rtmp 支持的 ffmpeg 或改用直链', 502);
    }
    throw new HttpError('NO_STREAM', '斗鱼未开播或流地址解析失败', 502);
  },
};

/* ---------------- 快手 ---------------- */
export const kuaishou = {
  roomIdFrom(input) {
    const m = /kuaishou\.com\/u\/([A-Za-z0-9_-]+)/i.exec(input) || /live\.kuaishou\.com\/([A-Za-z0-9_-]+)/i.exec(input);
    return m ? m[1] : input;
  },
  async resolveRoom({ roomId, settings, logger }) {
    const cookie = settings?.cookies?.kuaishou?.value || '';
    const page = await httpGet(`https://live.kuaishou.com/u/${encodeURIComponent(roomId)}`, {
      headers: { Referer: 'https://live.kuaishou.com/', ...(cookie ? { Cookie: cookie } : {}) }, logger, label: 'ks.page',
    });
    const html = page.text || '';
    const nick = /"name":"([^"]{1,40})"/.exec(html)?.[1] || '';
    const title = /"caption":"([^"]{1,80})"/.exec(html)?.[1] || '';
    const avatar = /"(?:headUrl|avatar)"\s*:\s*"([^"]+)"/.exec(html)?.[1]?.replace(/\\\//g, '/') || '';
    const live = /"liveStreamId"/.test(html) || /"playUrls"/.test(html);
    logger?.debug(`快手取到房间元数据：主播「${nick || '未知主播'}」，状态：${live ? '开播' : '未开播'}`);
    return {
      roomId: String(roomId), anchorName: nick, title, avatar,
      liveStatus: live ? 'live' : 'offline', online: null,
      qualityOptions: [{ id: 'origin', label: '原画', note: '' }, { id: 'hd', label: '高清', note: '' }, { id: 'audio', label: '仅音频', note: '' }],
    };
  },
  async resolveStream({ roomId, quality, settings, logger }) {
    const cookie = settings?.cookies?.kuaishou?.value || '';
    const page = await httpGet(`https://live.kuaishou.com/u/${encodeURIComponent(roomId)}`, {
      headers: { Referer: 'https://live.kuaishou.com/', ...(cookie ? { Cookie: cookie } : {}) }, logger, label: 'ks.page',
    });
    const html = page.text || '';
    const urls = [...html.matchAll(/https?:\\?\/\\?\/[^"'\s\\]+?\.(?:flv|m3u8)[^"'\s\\]*/g)].map((x) => x[0].replace(/\\\//g, '/'));
    if (urls.length) return { url: urls[0], resolution: '', headers: { Referer: `https://live.kuaishou.com/u/${roomId}` }, qualityActual: quality };
    throw new HttpError('AUTH', '快手需要登录 Cookie 才能拿到流地址：请在平台账号里粘贴 Cookie（可自动获取但可能失效）', 502);
  },
};

/* ---------------- 未接入 ---------------- */
export const xiaohongshu = {
  roomIdFrom: (i) => String(i),
  resolveRoom: async () => notImplemented('小红书'),
  resolveStream: async () => notImplemented('小红书'),
};
export const weibo = {
  roomIdFrom: (i) => String(i),
  resolveRoom: async () => notImplemented('微博'),
  resolveStream: async () => notImplemented('微博'),
};
