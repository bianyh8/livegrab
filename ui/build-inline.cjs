/* LiveGrab 原型构建：把 ui/_*.frag.js 内联进 ui/index.html（产出可 file:// 双击打开的单文件原型）。
   用法：在仓库根目录执行  node ui/build-inline.cjs .   */
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const ui = path.join(root, 'ui');
const idxPath = path.join(ui, 'index.html');

const FILES = ['_views_dashboard.frag.js', '_views_tasks.frag.js', '_views_files.frag.js',
  '_views_settings.frag.js', '_views_logs.frag.js', '_views_trash.frag.js', '_overlays.frag.js'];

const BEGIN = '<!-- LGFRAGS:BEGIN -->';
const END = '<!-- LGFRAGS:END -->';

let html = fs.readFileSync(idxPath, 'utf8');

// 幂等：先移除旧块（必须在任何插入之前）
const bi = html.indexOf(BEGIN);
if (bi >= 0) {
  const ei = html.indexOf(END, bi);
  if (ei < 0) { console.error('旧构建块缺少结束标记，拒绝继续'); process.exit(1); }
  html = html.slice(0, bi) + html.slice(ei + END.length);
  html = html.replace(/^\s*\n/, '');
  console.log('已移除旧的内联块');
}

// 生成内联块
const parts = [];
const failed = [];
for (const f of FILES) {
  const p = path.join(ui, f);
  if (!fs.existsSync(p)) { failed.push(f); continue; }
  let src = fs.readFileSync(p, 'utf8');
  const names = [];
  const re = /export\s+function\s+([A-Za-z0-9_$]+)/g;
  let m; while ((m = re.exec(src))) names.push(m[1]);
  if (!names.length) { failed.push(f + '(no export)'); continue; }
  src = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
  names.forEach((n) => {
    src = src.replace(new RegExp('export\\s+function\\s+' + n + '\\b'), 'window.LG_FRAG.' + n + ' = function ');
  });
  if (/<\/script/i.test(src)) { failed.push(f + '(contains </script>)'); continue; }
  parts.push('/* ==== ' + f + ' ==== */\n(function(){\n' + src + '\n})();');
}

const block = BEGIN + '\n<script>\n' + 'window.LG_FRAG = window.LG_FRAG || {};\n' + parts.join('\n') + '\n</script>\n' + END + '\n';

// 插到 </body> 之前（加载器 script 之后，HTML 层，绝不会落进 JS 注释里）
const anchor = '</body>';
const ai = html.lastIndexOf(anchor);
if (ai < 0) { console.error('找不到 </body>'); process.exit(1); }
html = html.slice(0, ai) + block + html.slice(ai);

fs.writeFileSync(idxPath, html, 'utf8');
console.log('OK inlined=' + parts.length + ' bytes=' + block.length + (failed.length ? (' FAILED=' + failed.join(',')) : ''));
