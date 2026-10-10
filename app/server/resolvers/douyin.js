// 抖音直播解析（多策略兜底：webcast 接口 → 页面 RENDER_DATA → 正则兜底）
import { HttpError } from '../util.js';
import { httpGet, httpJson, pickSetCookie, cookiesToString, DESKTOP_UA } from './http.js';
import { abSign } from './douyin-sign.js';

const QUALITY_KEYS = {
  origin: ['FULL_HD1', 'HD1', 'SD1', 'SD2'],
  bluray: ['FULL_HD1', 'HD1', 'SD1', 'SD2'],
  uhd: ['HD1', 'FULL_HD1', 'SD1', 'SD2'],
  hd: ['SD1', 'SD2', 'HD1', 'FULL_HD1'],
  sd: ['SD2', 'SD1', 'HD1', 'FULL_HD1'],
  audio: ['SD2', 'SD1', 'HD1', 'FULL_HD1'],
};

/** 去掉主播名里的 emoji/符号与变体选择符，保留中文/字母/数字（用于显示、入库及文件命名） */
function stripEmoji(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}\u{FE00}\u{FE0E}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function roomIdFrom(input) {
  const s = String(input || '').trim();
  // 「直播地址 / 路径段」：19 位数字内部号、数字短号、或主播自定义文字短号（如 xyr_1208）
  const m = /live\.douyin\.com\/([A-Za-z0-9_]+)/i.exec(s)
    || /douyin\.com\/user\/([A-Za-z0-9_-]+)/i.exec(s)
    || /^([A-Za-z0-9_]{3,})$/.exec(s);
  return m ? m[1] : s;
}

/** 优先用户 Cookie；否则抓首页拿 ttwid（仅 web 接口需要；移动端接口免登录，不用 Cookie） */
async function ensureCookie(settings, logger) {
  const userCookie = settings?.cookies?.douyin?.value || '';
  if (userCookie) return userCookie;
  if (settings?.cookies?.douyin?.ttwid) return `ttwid=${settings.cookies.douyin.ttwid}`;
  try {
    const r = await httpGet('https://live.douyin.com/', { retries: 1, logger, label: 'douyin.home' });
    const cookie = cookiesToString(pickSetCookie(r.headers)) || r.headers.get('set-cookie') || '';
    const ttwid = /ttwid=([^;,\s]+)/.exec(cookie)?.[1];
    if (ttwid) {
      settings.__ttwid = ttwid; // 进程内缓存，避免每次重抓
      return `ttwid=${ttwid}`;
    }
  } catch (e) {
    logger?.warn(`抖音首页取 ttwid 失败：${e.message}`, {});
  }
  return '';
}

/** 移动端（Android）客户端 UA 与公共参数：2026-10 实测 reflow/info 免登录即可拿到流地址 */
const MOBILE_UA = 'com.ss.android.ugc.aweme/260401 (Linux; U; Android 12; zh_CN; SM-G988N; Build/SP1A.210812.016; Cronet/107.0.5304.141)';
const MOBILE_PARAMS = {
  type_id: '0', live_id: '1', version_code: '99.99.99', app_id: '1128', device_platform: 'android',
  device_type: 'SM-G988N', os_version: '12', aid: '1128', channel: 'googleplay', ssmix: 'a',
  manifest_version_code: '1', update_version_code: '1', resolution: '1080*1920', dpi: '420',
  language: 'zh', os_api: '31', ac: 'wifi', install_id: '0', device_id: '0',
};

function mobileUrl(roomId) {
  const p = new URLSearchParams({ ...MOBILE_PARAMS, room_id: String(roomId) });
  return signedUrl('https://webcast.amemv.com/webcast/room/reflow/info/', p, MOBILE_UA);
}

/** 给参数附 a_bogus（AB-Log 签名）生成最终请求 URL：签名基于「不含 a_bogus 的 query」计算 */
function signedUrl(base, params, ua) {
  const q = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params).toString();
  return `${base}?${q}&a_bogus=${encodeURIComponent(abSign(q, ua))}`;
}

/** 直播间 Web UA 与 web/enter 参数（顺序需与 a_bogus 计算一致） */
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function webEnterUrl(roomId) {
  const p = new URLSearchParams({
    aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', language: 'zh-CN',
    browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '124.0.0.0',
    web_rid: String(roomId), is_need_double_stream: 'false', msToken: '',
  });
  return signedUrl('https://live.douyin.com/webcast/room/web/enter/', p, WEB_UA);
}

function headers(cookie, roomId) {
  return {
    'User-Agent': DESKTOP_UA,
    Referer: `https://live.douyin.com/${roomId}`,
    Accept: 'application/json, text/plain, */*',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function enterRoom(roomId, settings, logger) {
  const idStr = String(roomId || '');
  // 抖音直播间地址里的短号（web_rid，数字短号或主播自定义文字短号）与内部房间号（19 位）是两套 ID：
  // 实测免登录的移动端接口只认 19 位内部房间号，短号会返回 10011，需用 web 接口（ttwid 即可）映射出 19 位内部号
  const isFullId = /^\d{19}$/.test(idStr);
  // ① 移动端接口优先：2026-10 实测免登录可用（web 端已要求登录态/签名校验，匿名返回 4001038）
  let mobileNote = '';
  try {
    const j = await httpJson(mobileUrl(roomId), {
      headers: { 'User-Agent': MOBILE_UA, Accept: 'application/json' },
      logger, label: 'douyin.mobile', retries: 1,
    });
    const room = j?.data?.room;
    if (j?.status_code === 0 && room) {
      logger?.debug(`抖音移动端接口解析成功（免登录），房间 ${room.id_str || roomId} 状态 ${room.status}`);
      return { room, cookie: '', source: 'mobile' };
    }
    mobileNote = `移动端接口 status_code=${j?.status_code}${j?.data?.message ? ` ${j.data.message}` : ''}`;
    if (j?.status_code === 10011) {
      if (!isFullId) {
        // 19 位以内的数字短号或文字自定义短号：转为 web 接口用 web_rid 映射出 19 位内部号
        mobileNote += `（「${idStr}」像抖音 web_rid 短号，免登录接口只认 19 位内部房间号，转 web 接口映射）`;
      } else {
        // 实测：已下播的 19 位房间号与无效房间号都返回 10011，按"未开播"处理，让任务继续等待开播
        logger?.info(`抖音移动端接口返回 10011（未开播或房间号无效），按未开播处理：${idStr}`, {});
        return {
          room: { _fallback: true, urls: [], nickname: '', title: '', status: 4 },
          cookie: '', source: 'mobile-offline', note: '移动端接口 10011：未开播或房间号无效',
        };
      }
    }
  } catch (e) {
    mobileNote = `移动端接口异常：${e.message}`;
    logger?.debug(`抖音移动端接口失败，转 web 接口：${e.message}`);
  }

  // ② web 接口（含 a_bogus 签名 + ttwid；无需登录即可拿到多数直播间的真实流）
  const cookie = await ensureCookie(settings, logger);
  let apiNote = '';
  try {
    const webHdrs = {
      'User-Agent': WEB_UA,
      Referer: `https://live.douyin.com/${roomId}`,
      Accept: 'application/json, text/plain, */*',
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const j = await httpJson(webEnterUrl(roomId), { headers: webHdrs, logger, label: 'douyin.enter', retries: 1 });
    if (j && j.status_code && j.status_code !== 0) {
      apiNote = `web 接口 status_code=${j.status_code}`;
      logger?.warn(`抖音 web enter 接口返回 status_code=${j.status_code}（需要登录 Cookie 或风控），转页面兜底`, {});
    }
    const room = j?.data?.data?.[0];
    if (room) return { room, cookie, source: 'api' };
  } catch (e) {
    apiNote = `web 接口异常：${e.message}`;
    logger?.debug(`抖音 webcast 接口失败，转页面解析：${e.message}`);
  }

  // ③ 兜底：直接解析直播间页面（2026-10 实测页面已不再内嵌流地址、RENDER_DATA 也已移除）
  let pageErr = '';
  try {
    const page = await httpGet(`https://live.douyin.com/${encodeURIComponent(roomId)}`, { headers: headers(cookie, roomId), logger, label: 'douyin.page', retries: 1 });
    const html = page.text || '';
    let render = null;
    const m = /<script[^>]+id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (m) {
      try { render = JSON.parse(decodeURIComponent(m[1])); } catch { render = null; }
    }
    const urls = [...html.matchAll(/https?:\\?\/\\?\/[^"'\s\\]+?\.(?:flv|m3u8)[^"'\s\\]*/g)]
      .map((x) => x[0].replace(/\\\//g, '/'));
    const nickname = /"nickname":"([^"]{1,40})"/.exec(html)?.[1] || '';
    const title = /"title":"([^"]{1,80})"/.exec(html)?.[1] || '';
    if (urls.length || render) {
      return { room: { _fallback: true, urls, nickname, title, status: urls.length ? 2 : 4 }, cookie, source: 'html' };
    }
    pageErr = `页面兜底也没拿到流地址（页面 ${Math.round(html.length / 1024)}KB，已无 RENDER_DATA/内嵌流）`;
  } catch (e) {
    pageErr = `页面抓取失败：${e.message}`;
  }
  if (!isFullId) {
    throw new HttpError(
      'ROOM_ID_FORMAT',
      `抖音房间号「${idStr}」是 web_rid 短号（数字短号或主播自定义短号，如 xyr_1208）：${mobileNote || '移动端接口无有效返回'}；${apiNote || 'web 接口无有效返回'}。`
      + '免登录的移动端接口只认 19 位内部房间号——请在抖音里打开该直播间，把地址栏里那串 19 位数字填进任务（形如 https://live.douyin.com/7694422853944462115）；'
      + '或在「系统设置 → 平台账号」粘贴登录 Cookie 后重试（web 接口可映射短号，但需要登录态）；也可用「直链」任务。',
      400,
    );
  }
  throw new HttpError(
    'BLOCKED',
    `抖音解析失败：${mobileNote || '移动端接口无有效返回'}；${apiNote || 'web 接口无有效返回'}；${pageErr}。`
    + '若房间号确认无误，可到「系统设置 → 平台账号」粘贴登录后的 Cookie（含 sessionid、ttwid）后重试；'
    + '或用「直链」任务：在浏览器里取到直播间的 flv/m3u8 地址后直接粘贴。',
    502,
  );
}

export async function resolveRoom({ roomId, settings, logger }) {
  const { room, source, note } = await enterRoom(roomId, settings, logger);
  if (room._fallback) {
    return {
      roomId: String(roomId),
      anchorName: stripEmoji(room.nickname || '抖音直播间'),
      title: room.title || '',
      avatar: '',
      liveStatus: room.urls.length ? 'live' : 'offline',
      online: null,
      qualityOptions: [{ id: 'origin', label: '原画', note: '最高可用' }, { id: 'hd', label: '高清', note: '' }, { id: 'audio', label: '仅音频', note: '' }],
      note: note ? `解析方式：${source}（${note}）` : `解析方式：页面兜底（${source}）`,
    };
  }
  // 短号（web_rid）映射到 19 位内部号时，移动接口常只返回极简 room（有 id_str 但缺 owner），
  // 这里用映射出的内部号再回查一次，把主播名/头像/标题补全，避免"房间能解析但主播名为空"。
  if (!(room.owner && room.owner.nickname) && room.id_str && String(room.id_str) !== String(roomId)) {
    try {
      const inner = await enterRoom(room.id_str, settings, logger);
      if (inner && inner.room && !inner.room._fallback && inner.room.owner && inner.room.owner.nickname) {
        room.owner = inner.room.owner;
        if (!room.title && inner.room.title) room.title = inner.room.title;
        logger?.debug(`抖音短号 ${roomId} 映射内部号 ${room.id_str}，回查补全主播名：${inner.room.owner?.nickname}`, {});
      }
    } catch (e) {
      logger?.debug(`抖音短号回查补全失败：${e.message}`, {});
    }
  }
  const status = room.status ?? room.room_status;
  return {
    roomId: String(room.id_str || roomId),
    anchorName: stripEmoji(room.owner?.nickname || ''),
    title: room.title || '',
    avatar: (room.owner?.avatar_thumb?.url_list || [])[0] || '',
    liveStatus: status === 2 ? 'live' : 'offline',
    online: room.stats?.total_user ?? null,
    qualityOptions: [
      { id: 'origin', label: '原画', note: '最高可用' },
      { id: 'uhd', label: '超清', note: '720P' },
      { id: 'hd', label: '高清', note: '540P' },
      { id: 'sd', label: '标清', note: '360P' },
      { id: 'audio', label: '仅音频', note: 'AAC 128k' },
    ],
  };
}

export async function resolveStream({ roomId, quality, settings, logger }) {
  const { room, cookie } = await enterRoom(roomId, settings, logger);
  const keys = QUALITY_KEYS[quality] || QUALITY_KEYS.origin;
  if (room._fallback) {
    if (!room.urls.length) throw new HttpError('NO_STREAM', '主播未开播或未拿到流地址', 502);
    return { url: room.urls[0], resolution: '', headers: headers(cookie, roomId), qualityActual: quality };
  }
  const su = room.stream_url || {};
  const flv = su.flv_pull_url || {};
  const hls = su.hls_pull_url_map || {};
  for (const k of keys) {
    const url = flv[k] || hls[k];
    if (url) {
      return {
        url,
        resolution: su.default_resolution || '',
        headers: headers(cookie, roomId),
        qualityActual: quality,
        qualityKey: k,
      };
    }
  }
  throw new HttpError('NO_STREAM', `直播间没有可用流（状态 ${room.status}），可能未开播或需要登录 Cookie`, 502);
}
