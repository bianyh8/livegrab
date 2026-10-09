/**
 * ui/index.html 自检脚本（保留在仓库里，改完原型就跑一遍）
 *
 *   node ui/selfcheck.mjs --src ui/index.html     # 源码结构 + 内联 JS 提取
 *   node --check ui/_inline.js                    # 内联 JS 语法
 *   <headless-browser> --dump-dom ui/index.html > ui/_dom.html
 *   node ui/selfcheck.mjs --dom ui/_dom.html      # 渲染后 DOM 断言
 */
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
const file = process.argv[3];
if (!mode || !file) {
  console.error('usage: --src <index.html> | --dom <dom.html>');
  process.exit(2);
}
const html = fs.readFileSync(file, 'utf8');
let fails = 0;
const ok = (cond, msg, extra = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + msg + (extra ? '  → ' + extra : ''));
  if (!cond) fails++;
};

if (mode === '--src') {
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const stack = [], errs = [];
  html.split(/\r?\n/).forEach((line, i) => {
    const re = /<(\/?)([a-zA-Z!][a-zA-Z0-9-]*)([^>]*)>/g;
    let m;
    while ((m = re.exec(line))) {
      const name = m[2].toLowerCase();
      if (VOID.has(name) || name.startsWith('!') || (m[3] || '').trimEnd().endsWith('/')) continue;
      if (!m[1]) stack.push({ name, line: i + 1 });
      else {
        const top = stack.pop();
        if (!top) errs.push(`第 ${i + 1} 行多余 </${name}>`);
        else if (top.name !== name) errs.push(`第 ${i + 1} 行 </${name}> 与第 ${top.line} 行 <${top.name}> 不匹配`);
      }
    }
  });
  stack.forEach(s => errs.push(`第 ${s.line} 行 <${s.name}> 未闭合`));
  ok(errs.length === 0, 'HTML 标签配对', errs.slice(0, 8).join(' | '));

  const js = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
  fs.writeFileSync(path.join(path.dirname(file), '_inline.js'), js, 'utf8');
  console.log('  内联脚本字符数:', js.length);

  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]));
  const used = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(x => x[1]));
  ok([...used].every(i => ids.has(i)), 'getElementById 目标均存在', [...used].filter(i => !ids.has(i)).join(','));

  const fns = new Set([...js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(x => x[1]));
  const called = new Set([...html.matchAll(/on(?:click|change|input|submit)="([A-Za-z_$][\w$]*)\(/g)]
    .map(x => x[1]).filter(f => f !== 'if'));
  ok([...called].every(f => fns.has(f)), '内联事件处理函数均已定义', [...called].filter(f => !fns.has(f)).join(','));

  const plats = ['dy','bili','xhs','wb','ks','huya','douyu','ac','cc','yy','wx','more'];
  const missingPlat = plats.filter(p => !new RegExp(`\\.plat\\.${p}\\s*\\{`).test(html));
  ok(missingPlat.length === 0, '平台配色类齐全（12 个）', missingPlat.join(','));
  process.exit(fails ? 1 : 0);
}

if (mode === '--dom') {
  console.log('  DOM 字符数:', html.length);
  // 信息架构
  ok(!html.includes('id="page-naming"') && html.includes('id="tab-naming"'), '命名规则并入系统设置为页签');
  ok((html.match(/class="tab[ "]/g) || []).length === 5, '系统设置页签数为 5');
  ok((html.match(/class="nav-item/g) || []).length === 5, '一级导航为 5 项');
  const s = html.indexOf('id="page-settings"'), e = html.indexOf('id="page-logs"'), p = html.indexOf('id="tab-naming"');
  ok(s > -1 && p > s && p < e, '#tab-naming 位于 #page-settings 区域内');
  ok(html.includes('id="tab-platform"') && html.includes('id="tab-notify"') && html.includes('id="tab-security"'), '页签 3/4/5 挂载正确');
  ok(!html.includes('通知与安全'), '「通知」与「安全与登录」已拆为独立页签');
  ok(/id="tab-security"[\s\S]*?安全与登录/.test(html), '安全与登录在独立页签内');
  ok(/id="tab-notify"[\s\S]*?card-h"><h3>通知<\/h3>[\s\S]*?<\/div><!-- \/tab-notify/.test(html), '通知页签内不含账号安全配置');
  // 登录页
  ok(html.includes('id="loginPage"') && /class="login"/.test(html), '登录页存在且首屏可见');
  ok(html.includes('原型预览：跳过登录直接进入管理台'), '原型跳过入口存在');
  ok(html.includes('安全与登录'), '安全与登录卡片存在');
  // 命名规则
  ok(/2025-06-01_某某小主播_原画_003\.ts/.test(html), '命名预览渲染正确');
  ok(/\d+ 字符 \/ \d+ 字节 · 文件名 \d+ 字节/.test(html), '路径长度按 Linux 字节上限计算');
  // Linux 容器格式（统一 /data + 正斜杠，无 Windows 路径/桌面端操作）
  ok(!/D:\\/.test(html) && !/LiveRec/.test(html), '无 Windows 盘符路径');
  ok(!/Windows/.test(html), '无 Windows 专属文案');
  ok(!/浏览…/.test(html) && !/目录选择器/.test(html), '已移除宿主目录选择器（改为容器内路径检测）');
  ok(/\/data/.test(html) && /单层名上限 255 字节/.test(html), '路径改为 /data 与 Linux 限制');
  // 多平台
  const platUse = (html.match(/class="plat (dy|bili|xhs|wb|ks|huya|douyu|ac|cc|yy|wx|more)"/g) || []).length;
  ok(platUse >= 25, '平台徽标使用次数 ≥ 25', String(platUse));
  ['小红书','微博','快手','虎牙','斗鱼','AcFun'].forEach(n => ok(html.includes(n), `含平台：${n}`));
  ok(/平台与账号/.test(html), '平台账号表格存在');
  ok(/手动指定平台/.test(html), '新建任务含手动指定平台');
  ok(/官方不提供切换/.test(html), '小红书清晰度限制已标注');
  ok(/最高 720P/.test(html), '微博 720P 上限已标注');
  ok(/更多平台/.test(html), '更多平台入口存在');
  // 支持级别（已确认：稳字优先）
  const exp = (html.match(/实验性/g) || []).length;
  ok(exp >= 4, '「实验性」标记 ≥ 4 处（小红书/微博/表单说明）', String(exp));
  ok(/稳定支持（P0）/.test(html), '平台账号卡片标注 P0 稳定支持数量');
  ok(/5 个稳定支持/.test(html), '稳定支持数量为 5');
  // 交付形态：Docker + 浏览器，无桌面端专属操作
  ok(!/资源管理器中定位/.test(html) && !/>定位</.test(html), '已移除录制文件页的「定位」按钮');
  ok(!/打开所在目录/.test(html) && !/>打开目录</.test(html), '已移除任务页的「打开目录」按钮');
  ok(!/调用系统播放器/.test(html) && !/已在浏览器内置播放器中打开/.test(html), '已无系统播放器文案');
  ok(html.includes('id="playerMask"') && /function openPlayer/.test(html) && /function closePlayer/.test(html), '浏览器内置播放器存在');
  const wire = (html.match(/openPlayer\(/g) || []).length;
  ok(wire >= 7, '6 个文件行播放按钮均接入播放器', String(wire));
  ok(/不调用本机播放器/.test(html) && /fMP4/.test(html), '播放器标注浏览器内回放与服务端 fMP4 转封装');
  ok(/同时最多 2 路渐进流转封装回放/.test(html), 'D17 回放并发上限已写入');
  // 已确认决策 D1–D19 落地
  ok(!/统计口径/.test(html), 'D2 页面不再显示「统计口径」长文案（口径收敛到各指标卡副标题与 README/CONTRACT）');
  ok(/1 个任务只对应 1 个直播间|1 任务 = 1 直播间/.test(html), 'D3 基数约定已标注');
  ok(/暂停本段/.test(html) && !/>暂停<\/button>/.test(html), 'D4 暂停语义已改文案');
  ok(/批量启动/.test(html) && /批量暂停/.test(html) && /批量停止/.test(html) && /批量删除/.test(html), 'D7 批量操作条存在');
  ok(/整场已录完/.test(html) && /展开分段/.test(html) && /合并整场/.test(html), 'D8 文件按整场归档');
  ok(/按日期/.test(html) && /按任务/.test(html) && /浏览视图/.test(html), 'D9 文件库多视图切换');
  ok(/回收站/.test(html) && /\.trash/.test(html) && /保留 7 天/.test(html), 'D10 回收站策略已落地');
  ok(/复制<\/button>/.test(html) && /命名配置/.test(html) && /绑定范围/.test(html), 'D12 多套命名配置');
  ok(/粘贴 Cookie/.test(html) && /扫码登录/.test(html), 'D13 Cookie 获取方式已修正');
  ok(/保留 <b>14 天<\/b>|保留 14 天/.test(html), 'D14 日志保留策略已标注');
  ok(!/来自容器环境变量 TZ/.test(html) && !/<label class="fl">时区<\/label>/.test(html), 'D15 时区不再在前台显示/修改（默认 Asia/Shanghai，Docker 取环境变量 TZ）');
  ok(!/自动分段录制/.test(html), '左上角品牌副标题文案已删除');
  ok(/超出抖音平台上限/.test(html), 'D16 排队原因已写明');
  ok(/60 秒内只发一次/.test(html), 'D18 通知去重开关');
  ok(/文件缺失/.test(html) && /未登记文件/.test(html), 'D19 缺失/未登记文件入口');
  process.exit(fails ? 1 : 0);
}
