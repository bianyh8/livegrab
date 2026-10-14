// room-url.js —— 各平台直播间规范地址的唯一推导入口
//
// 背景：以前任务里存的是「用户粘贴的原始地址」，或退化成 `platform:roomId` 这种非 URL 串，
// 前端无法直接展示/跳转。v2 起统一在创建/编辑任务时推导一次，落库到 tasks.source_url。
// 各平台 resolver 仍只负责解析（返回 url/anchorName/title/avatar），不再各自拼地址。
//
// 推导规则（与各平台真实地址形态一致）：
//   douyin      https://live.douyin.com/<roomId>
//   bilibili    https://live.bilibili.com/<roomId>
//   kuaishou    https://live.kuaishou.com/u/<shortId|roomId>
//   huya        https://www.huya.com/<roomId>
//   douyu       https://www.douyu.com/<roomId>
//   xiaohongshu https://www.xiaohongshu.com/<shortId|roomId>
//   weibo       https://weibo.com/l/wblive/p/show/<roomId>
//   direct      直链流：原样使用（无直播页）
export function buildRoomUrl(platform, { roomId = '', shortId = '', rawUrl = '' } = {}) {
  const rid = String(roomId || '').trim();
  const sid = String(shortId || '').trim();
  switch (platform) {
    case 'douyin': return rid ? `https://live.douyin.com/${rid}` : rawUrl || '';
    case 'bilibili': return rid ? `https://live.bilibili.com/${rid}` : rawUrl || '';
    case 'kuaishou': return (sid || rid) ? `https://live.kuaishou.com/u/${sid || rid}` : rawUrl || '';
    case 'huya': return rid ? `https://www.huya.com/${rid}` : rawUrl || '';
    case 'douyu': return rid ? `https://www.douyu.com/${rid}` : rawUrl || '';
    case 'xiaohongshu': return (sid || rid) ? `https://www.xiaohongshu.com/${sid || rid}` : rawUrl || '';
    case 'weibo': return rid ? `https://weibo.com/l/wblive/p/show/${rid}` : rawUrl || '';
    case 'direct': return rawUrl || rid || '';
    default: return rawUrl || (platform && rid ? `${platform}:${rid}` : '');
  }
}
