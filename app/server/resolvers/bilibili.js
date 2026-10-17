// B 站直播解析（官方公开接口）
import { HttpError } from '../util.js';
import { httpJson, DESKTOP_UA } from './http.js';

const QN = { origin: 10000, bluray: 400, uhd: 250, hd: 150, sd: 80, audio: 80 };
const QN_BACK = { 30000: 'origin', 20000: 'origin', 10000: 'origin', 401: 'bluray', 400: 'bluray', 250: 'uhd', 150: 'hd', 80: 'sd' };

export function roomIdFrom(input) {
  const s = String(input || '').trim();
  const m = /live\.bilibili\.com\/(?:blanc\/)?(\d+)/i.exec(s)
    || /b23\.tv\/([A-Za-z0-9]+)/i.exec(s)
    || /^(\d{2,})$/.exec(s);
  return m ? m[1] : s;
}

function headers(roomId, settings) {
  const cookie = settings?.cookies?.bilibili?.value || '';
  return {
    'User-Agent': DESKTOP_UA,
    Referer: `https://live.bilibili.com/${roomId}`,
    Origin: 'https://live.bilibili.com',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export async function resolveRoom({ roomId, settings, logger, probe = false }) {
  const init = await httpJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`, {
    headers: headers(roomId, settings), logger, label: 'bili.room_init',
  });
  if (init.code !== 0) throw new HttpError('ROOM_NOT_FOUND', `房间不存在或不可访问（${init.message || init.code}）`, 404);
  const realId = String(init.data?.room_id || roomId);
  // 房间信息用官方现役接口 room/v1/Room/get_info：
  // xlive/web-room/v1/index/getInfoByRoom 已返回 code=-352（2026-10 实测），旧代码没校验 code 会把"接口被拒"静默当成"未开播"
  const info = await httpJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realId}`, {
    headers: headers(realId, settings), logger, label: 'bili.get_info',
  });
  if (info.code !== 0) {
    throw new HttpError('BLOCKED', `B站房间信息接口拒绝（code=${info.code} ${info.message || ''}），请稍后重试或粘贴 Cookie`, 502);
  }
  const d = info.data || {};
  let anchorName = '';
  let avatar = '';
  // 轮询（probe=true）只取直播状态：跳过主播信息接口，减少一次请求
  if (!probe) {
    try {
      const a = await httpJson(`https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${realId}`, {
        headers: headers(realId, settings), logger, label: 'bili.anchor',
      });
      if (a.code === 0) { anchorName = a.data?.info?.uname || ''; avatar = a.data?.info?.face || ''; }
    } catch (e) {
      logger?.debug(`主播信息获取失败（不影响开播判断）：${e.message}`);
    }
  }
  if (anchorName) logger?.debug(`B站取到房间元数据：主播「${anchorName}」，状态：${Number(d.live_status) === 1 ? '开播' : '未开播'}`);
  return {
    roomId: realId,
    anchorName,
    title: d.title || '',
    avatar,
    liveStatus: Number(d.live_status) === 1 ? 'live' : (d.live_status == null ? 'unknown' : 'offline'),
    online: d.online ?? null,
    qualityOptions: [
      { id: 'origin', label: '原画', note: '最高可用' },
      { id: 'bluray', label: '蓝光', note: '1080P' },
      { id: 'uhd', label: '超清', note: '720P' },
      { id: 'hd', label: '高清', note: '540P' },
      { id: 'sd', label: '标清', note: '360P' },
      { id: 'audio', label: '仅音频', note: 'AAC 128k' },
    ],
  };
}

function pickStream(playurl) {
  const streams = playurl?.stream || [];
  const byProto = (name) => streams.find((s) => s.protocol_name === name) || null;
  const candidates = [];
  for (const proto of ['http_stream', 'http_hls']) {
    const st = byProto(proto);
    if (!st) continue;
    for (const fmt of st.format || []) {
      for (const codec of fmt.codec || []) {
        const info = (codec.url_info || [])[0];
        if (!info?.host) continue;
        candidates.push({
          proto, format: fmt.format_name, codec: codec.codec_name,
          url: `${info.host}${codec.base_url}${info.extra || ''}`,
          currentQn: codec.current_qn, acceptQn: codec.accept_qn || [],
          resolution: codec.current_qn ? '' : '',
        });
      }
    }
  }
  // 优先 FLV 直连（延迟低），其次 HLS
  return candidates.find((c) => c.format === 'flv') || candidates.find((c) => c.format === 'ts') || candidates[0] || null;
}

export async function resolveStream({ roomId, quality, settings, logger }) {
  const qn = QN[quality] ?? 10000;
  const url = `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo`
    + `?room_id=${encodeURIComponent(roomId)}&protocol=0,1&format=0,1,2&codec=0,1&qn=${qn}`
    + '&platform=web&ptype=8&dolby=5&panorama=1';
  let j = await httpJson(url, { headers: headers(roomId, settings), logger, label: 'bili.getRoomPlayInfo' });
  if (j.code !== 0) {
    // 旧接口兜底
    j = await httpJson(`https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${encodeURIComponent(roomId)}&qn=${qn}&platform=web`, {
      headers: headers(roomId, settings), logger, label: 'bili.playUrl',
    });
    if (j.code !== 0) throw new HttpError('BLOCKED', `B站接口拒绝（${j.message || j.code}）`, 502);
    const durl = j.data?.durl || [];
    if (!durl.length) throw new HttpError('NO_STREAM', '房间未开播或没有可用流', 502);
    return { url: durl[0].url, resolution: '', headers: headers(roomId, settings), qualityActual: QN_BACK[j.data?.current_qn] || quality };
  }
  const playurl = j.data?.playurl_info?.playurl;
  const pick = pickStream(playurl);
  if (!pick) throw new HttpError('NO_STREAM', j.data?.live_status === 0 ? '主播未开播' : '没有可用流地址', 502);
  return {
    url: pick.url,
    resolution: pick.resolution || '',
    headers: headers(roomId, settings),
    qualityActual: QN_BACK[pick.currentQn] || quality,
    acceptQn: pick.acceptQn,
  };
}
