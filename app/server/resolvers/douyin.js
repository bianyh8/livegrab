// 抖音直播解析：移动端 reflow/info 取房间元数据（免登录）→ web/enter 权威开播状态与 HLS 流
// （短号 + ttwid 匿名可用）→ 移动端元数据兜底 → 页面兜底（2026-10 实测已失效，保留）
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
  // 「直播地址 / 路径段」：19 位数字内部号、v.douyin.com 分享短码、数字短号、或主播自定义文字短号（如 xyr_1208）
  const m = /live\.douyin\.com\/([A-Za-z0-9_]+)/i.exec(s)
    || /v\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(s)
    || /douyin\.com\/user\/([A-Za-z0-9_-]+)/i.exec(s)
    || /^([A-Za-z0-9_]{3,})$/.exec(s);
  return m ? m[1] : s;
}

/**
 * 输入归一化：把「分享短链 / 主播主页链接」换算成可解析的房间号。
 * - v.douyin.com/xxxx：跟随跳转取最终 live.douyin.com/<19位或短号>；
 * - douyin.com/user/<sec_uid>：查用户当前直播房间（best-effort，被风控时返回空走兜底）；
 * - 其余（裸抖音号 / 19 位房间号 / live.douyin.com 链接）原样返回。
 */
async function normalizeDouyinId(input, settings, logger) {
  const s0 = String(input || '').trim();
  // 调度器传入的是 platform:roomId 形式（如 douyin:xyr_1208），先剥掉前缀
  const pref = /^douyin:(.*)$/i.exec(s0);
  const s = pref ? pref[1].trim() : s0;
  const live = /live\.douyin\.com\/([A-Za-z0-9_]+)/i.exec(s);
  if (live) return live[1]; // 19 位内部号或文字短号（如 xyr_1208）
  const share = /(?:https?:\/\/)?v\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(s);
  if (share) {
    try {
      const r = await httpGet(`https://v.douyin.com/${share[1]}`, { headers: { 'User-Agent': WEB_UA }, retries: 0, logger, label: 'douyin.share' });
      const finalUrl = r.finalUrl || '';
      const m = /live\.douyin\.com\/([A-Za-z0-9_]+)/i.exec(finalUrl);
      if (m) { logger?.debug(`抖音分享短链 → ${m[1]}`, {}); return m[1]; }
      const um = /douyin\.com\/user\/([A-Za-z0-9_-]+)/i.exec(finalUrl);
      if (um) {
        const rid = await profileRoomId(um[1], settings, logger);
        if (rid) return rid;
      }
      logger?.debug(`抖音分享短链未命中直播间地址（最终 ${finalUrl}），用短码直试`, {});
    } catch (e) {
      logger?.debug(`抖音分享短链解析失败，用短码直试：${e.message}`, {});
    }
    return share[1];
  }
  const prof = /douyin\.com\/user\/([A-Za-z0-9_-]+)/i.exec(s);
  if (prof) {
    const rid = await profileRoomId(prof[1], settings, logger);
    if (rid) return rid;
    return prof[1]; // 找不到房间时交给 enterRoom 报明确错误
  }
  return s;
}

/** 通过 web 用户资料接口按 sec_uid 找「当前直播房间」（19 位内部号）；被风控/未开播时返回空串 */
async function profileRoomId(secUid, settings, logger) {
  try {
    const cookie = await ensureCookie(settings, logger);
    const p = new URLSearchParams({
      sec_user_id: secUid, aid: '6383', app_name: 'douyin_web', device_platform: 'web', language: 'zh-CN',
      browser_language: 'zh-CN', browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '124.0.0.0',
    });
    const j = await httpJson(signedUrl('https://www.douyin.com/aweme/v1/web/user/profile/other/', p, WEB_UA), {
      headers: { 'User-Agent': WEB_UA, Referer: `https://www.douyin.com/user/${secUid.slice(0, 12)}`, Accept: 'application/json, text/plain, */*', ...(cookie ? { Cookie: cookie } : {}) },
      logger, label: 'douyin.profile', retries: 1,
    });
    const u = j?.user || {};
    const rid = String(u?.live_room?.room_id || u?.room_id || '');
    if (/^\d{19}$/.test(rid)) {
      logger?.debug(`抖音主页查询命中当前直播房间：${u.unique_id || secUid.slice(0, 12)} → ${rid}`, {});
      return rid;
    }
    logger?.debug(`抖音主页查询：${u.unique_id || secUid.slice(0, 12)}${rid ? ` room_id=${rid}` : '（未开播或无房间）'}`, {});
  } catch (e) {
    logger?.debug(`抖音主页查询失败：${e.message}`, {});
  }
  return '';
}

/** 优先用户 Cookie / 已保存的 ttwid；否则抓首页拿 ttwid（仅 web 接口需要） */
async function ensureCookie(settings, logger) {
  const userCookie = settings?.cookies?.douyin?.value || '';
  if (userCookie) return userCookie;
  if (settings?.__ttwid) return `ttwid=${settings.__ttwid}`;
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
  // 直播间地址短号(web_rid，数字或文字)与 19 位内部房间号是两套 ID。
  // 移动端 reflow 只认 19 位内部号；web/enter 需要短号 web_rid。
  const isFullId = /^\d{19}$/.test(idStr);
  // ① 移动端接口：主要借它的「房间元数据」（owner.short_id / sec_uid / 主播名）。
  //    注意：移动端对部分直播间会把"已开播"误报成 status=4（且其 flv 常为不可拉的 _thirdor4 占位），
  //    所以不采信移动端直播状态，只用它取元数据；权威开播/真流由 web/enter 判定。
  let mobileRoom = null;
  let shortId = isFullId ? '' : idStr; // 短号可直接作 web/enter 的 web_rid
  let mobileNote = '';
  try {
    const j = await httpJson(mobileUrl(roomId), {
      headers: { 'User-Agent': MOBILE_UA, Accept: 'application/json' },
      logger, label: 'douyin.mobile', retries: 1,
    });
    const room = j?.data?.room;
    if (j?.status_code === 0 && room) {
      mobileRoom = room;
      shortId = room.owner?.short_id || room.owner?.display_id || shortId;
      logger?.debug(`抖音移动端接口取到房间元数据：主播「${stripEmoji(room.owner?.nickname || room.nickname || '未知主播')}」，状态：${room.status === 2 ? '开播' : '未开播'}（开播以 web 判定）`);
    } else {
      mobileNote = `移动端接口 status_code=${j?.status_code}${j?.data?.message ? ` ${j.data.message}` : ''}`;
      if (j?.status_code === 10011 && isFullId) {
        // 已下播的 19 位房间号与无效房间号都返回 10011，按"未开播"处理，让任务继续等待开播
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

  // ② web/enter：权威的开播状态 + 真实 HLS 流（需有效 ttwid + a_bogus；web_rid 用短号）
  const cookie = await ensureCookie(settings, logger);
  const webRid = shortId || idStr;
  let apiNote = '';
  try {
    const webHdrs = {
      'User-Agent': WEB_UA,
      Referer: `https://live.douyin.com/${webRid}`,
      Accept: 'application/json, text/plain, */*',
      ...(cookie ? { Cookie: cookie } : {}),
    };
    const j = await httpJson(webEnterUrl(webRid), { headers: webHdrs, logger, label: 'douyin.enter', retries: 1 });
    const room = j?.data?.data?.[0];
    if (j?.status_code === 0 && room) {
      // web 房间数据缺 owner 时用移动端元数据补全（主播名/头像/短号）
      if (mobileRoom && !(room.owner && room.owner.nickname)) room.owner = mobileRoom.owner;
      return { room, cookie, source: 'web', shortId: webRid };
    }
    apiNote = `web 接口 status_code=${j?.status_code}${j?.data?.message ? ` ${j.data.message}` : ''}`;
    logger?.debug(`抖音 web enter 无有效数据（${apiNote}），${mobileRoom ? '退回移动端' : '转页面兜底'}`);
  } catch (e) {
    apiNote = `web 接口异常：${e.message}`;
    logger?.debug(`抖音 webcast 接口失败：${e.message}`);
  }

  // ③ web 失败但移动端拿到房间元数据：退回移动端（其状态可能不准，供 resolveRoom 兜底）
  if (mobileRoom) return { room: mobileRoom, cookie: '', source: 'mobile', shortId };

  // ④ 兜底：直接解析直播间页面（2026-10 实测页面已不再内嵌流地址、RENDER_DATA 也已移除）
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
      `抖音「${idStr}」解析失败（移动/网页接口均无有效返回）：${mobileNote || '移动端接口无有效返回'}；${apiNote || 'web 接口无有效返回'}。`
      + '请确认抖音号输入无误，或直接粘贴直播间分享链接（v.douyin.com/… 可自动转换出 19 位房间号）；'
      + '若主播未开播且主页查询被风控，可到「系统设置 → 平台账号」粘贴登录 Cookie 后重试；也可用「直链」任务。',
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

export async function resolveRoom({ roomId, url = '', settings, logger, probe = false }) {
  const finalId = await normalizeDouyinId(url || roomId, settings, logger);
  const { room, source, note, shortId: webRid } = await enterRoom(finalId || roomId, settings, logger);
  if (room._fallback) {
    return {
      roomId: String(finalId || roomId),
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
  // 轮询（probe=true）只取直播状态，跳过该回查：不补全主播名，减少一次请求与日志噪音。
  if (!probe && !(room.owner && room.owner.nickname) && room.id_str && String(room.id_str) !== String(roomId)) {
    try {
      const inner = await enterRoom(room.id_str, settings, logger);
      if (inner && inner.room && !inner.room._fallback && inner.room.owner && inner.room.owner.nickname) {
        room.owner = inner.room.owner;
        if (!room.title && inner.room.title) room.title = inner.room.title;
        logger?.debug(`抖音短号映射内部号，回查补全主播名：「${inner.room.owner?.nickname}」`, {});
      }
    } catch (e) {
      logger?.debug(`抖音短号回查补全失败：${e.message}`, {});
    }
  }
  const status = room.status ?? room.room_status;
  // 轮询（probe=true）只取直播状态：不计算短号、不补全主播信息、不打"抖音短号计算"日志。
  // 短号（抖音号）只在点击解析 / 批量刷新 / 手动检查时由非 probe 路径统一计算并回写。
  if (probe) {
    return {
      roomId: String(room.id_str || finalId || roomId),
      shortId: '',
      anchorName: '',
      title: '',
      avatar: '',
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
  // 短号（前台展示用）：优先主播抖音号(unique_id/display_id)，其次移动端返回的数字短号，再退回 web_rid
  const handle = String(stripEmoji(room.owner?.unique_id || room.owner?.display_id || room.owner?.short_id || '') || webRid || '');
  logger?.debug(`抖音短号计算：source=${source} unique=${room.owner?.unique_id || ''} display=${room.owner?.display_id || ''} short=${room.owner?.short_id || ''} webRid=${webRid || ''} → "${handle}"`, {});
  return {
    roomId: String(room.id_str || finalId || roomId),
    shortId: handle,
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

/** 取直播间的最高画质 HLS（m3u8 主播单）——live_core_sdk_data 里的 origin */
function originMainHls(su) {
  try {
    const sd = su?.live_core_sdk_data?.pull_data?.stream_data;
    if (!sd) return '';
    const origin = JSON.parse(sd)?.data?.origin?.main;
    return (origin && origin.hls) || '';
  } catch { return ''; }
}

export async function resolveStream({ roomId, quality, settings, logger }) {
  const { room, cookie, shortId } = await enterRoom(roomId, settings, logger);
  const keys = QUALITY_KEYS[quality] || QUALITY_KEYS.origin;
  if (room._fallback) {
    if (!room.urls.length) throw new HttpError('NO_STREAM', '主播未开播或未拿到流地址', 502);
    return { url: room.urls[0], resolution: '', headers: headers(cookie, roomId), qualityActual: quality };
  }
  const su = room.stream_url || {};
  // HLS 优先：抖音 flv 边缘节点在本网络常 404/超时，HLS(m3u8) 可稳定拉流
  const hlsMaster = originMainHls(su);
  const hlsMap = su.hls_pull_url_map || {};
  const flvMap = su.flv_pull_url || {};
  const isTop = quality === 'origin' || quality === 'bluray';
  for (const k of keys) {
    // 每个质量的候选：origin HLS(master) → 该档 HLS → 该档 flv
    const candidates = [];
    if (isTop || !hlsMap[k]) candidates.push(hlsMaster);
    if (hlsMap[k]) candidates.push(hlsMap[k]);
    if (flvMap[k]) candidates.push(flvMap[k]);
    for (const url of candidates) {
      if (!url) continue;
      return {
        url,
        resolution: su.default_resolution || '',
        headers: headers(cookie, roomId),
        qualityActual: quality,
        qualityKey: k,
        proto: /\.m3u8/.test(url) ? 'hls' : 'flv',
      };
    }
  }
  throw new HttpError('NO_STREAM', `直播间没有可用流（状态：${room.status === 2 ? '开播' : '未开播'}），可能未开播或需要登录 Cookie`, 502);
}
