#!/usr/bin/env node
/**
 * 官网冒烟测试（零第三方依赖）。
 *
 * 覆盖：文件齐全 / 令牌引用与无硬编码色值 / 本地链接不断链 /
 * SEO 基础 / 合规红线（否定语境） / 体积约束 / 多页交叉导航。
 *
 * 运行：node apps/site/test/smoke.js
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 所有 HTML 页（首页 + P1 三页） */
const PAGES = [
  'index.html',
  'apply/index.html',
  'jobs/index.html',
  'extension/index.html',
];

/** P2 全站 11 页 */
const ALL_PAGES = [
  ...PAGES,
  'gpa/index.html',
  'docs/index.html',
  'docs/about/index.html',
  'welcome/index.html',
  'privacy/index.html',
  'terms/index.html',
  'pricing/index.html',
];

console.log('官网冒烟测试（零依赖）\n');

test('文件齐全：首页 + P1 三页 + 样式 + 脚本', () => {
  for (const f of [...PAGES, 'assets/site.css', 'assets/site.js']) {
    ok(existsSync(join(ROOT, f)), `缺文件：${f}`);
  }
});

test('设计令牌随站走且与控制台源一致（部署独立性）', () => {
  for (const p of PAGES) {
    const html = read(p);
    ok(/tokens\.css/.test(html), `${p} 未引用 tokens.css`);
  }
  const siteTokens = read('assets/tokens.css');
  const consoleTokens = readFileSync(resolve(ROOT, '../console/src/styles/tokens.css'), 'utf8');
  ok(siteTokens === consoleTokens, 'assets/tokens.css 与控制台源不一致（需同步复制）');
});

test('site.css 无硬编码色值（全部走 var(--)）', () => {
  const css = read('assets/site.css');
  const hard = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok(hard.length === 0, `发现硬编码色值：${hard.slice(0, 5).join(', ')}`);
  ok(/var\(--blue\)/.test(css), '未使用主色令牌');
  ok(/var\(--gold/.test(css), '未使用金色令牌');
});

test('本地链接不断链（锚点与资源存在）', () => {
  for (const page of PAGES) {
    const dir = join(ROOT, dirname(page));
    const html = read(page);
    const hrefs = [...html.matchAll(/href="([^"#]+)(#[^"]*)?"/g)].map((m) => m[1]);
    for (const h of hrefs) {
      if (/^(https?:|data:|mailto:|tel:)/.test(h)) continue;
      // 解析相对路径（页面在子目录时 ../ 前缀）
      const target = resolve(dir, h);
      ok(existsSync(target), `${page} 链接不存在：${h}`);
    }
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    for (const a of anchors) ok(ids.has(a), `${page} 锚点无对应 id：#${a}`);
  }
});

test('SEO 基础：标题 / 描述 / OG / viewport（全部页）', () => {
  for (const p of PAGES) {
    const html = read(p);
    ok(/<title>[^<]{6,}<\/title>/.test(html), `${p} 缺少 title`);
    ok(/meta name="description" content="[^"]{20,}"/.test(html), `${p} 缺少 description`);
    ok(/og:title/.test(html) && /og:description/.test(html), `${p} 缺少 OG 标签`);
    ok(/meta name="viewport"/.test(html), `${p} 缺少 viewport`);
  }
});

test('合规红线：提交类文案只出现在否定语境（全部页）', () => {
  for (const p of PAGES) {
    const html = read(p);
    ok(/不自动提交/.test(html), `${p} 缺少「不自动提交」承诺`);
    const text = html.replace(/<[^>]*>/g, '');
    const re = /(自动提交|一键提交|代提交)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 4), m.index);
      ok(/[不无禁杜绝免]/.test(before), `${p} 可疑提交文案缺少否定语境：…${before}${m[0]}`);
    }
  }
});

test('site.js 体积约束（< 100 行非空）', () => {
  const js = read('assets/site.js');
  const lines = js.split('\n').filter((l) => l.trim()).length;
  ok(lines > 0 && lines < 100, `site.js 非空行 ${lines}，超限`);
});

test('窄屏断点与控制台一致（960/560）', () => {
  const css = read('assets/site.css');
  ok(/max-width:\s*960px/.test(css), '缺少 960 断点');
  ok(/max-width:\s*560px/.test(css), '缺少 560 断点');
});

console.log('\n动效（方案 docs/官网动效方案.md）');

test('关键 keyframes 存在（rise/drift/pulse-soft/sweep）', () => {
  const css = read('assets/site.css');
  for (const k of ['rise', 'drift', 'pulse-soft', 'sweep']) {
    ok(new RegExp(`@keyframes\\s+${k}\\b`).test(css), `缺少 @keyframes ${k}`);
  }
});

test('进场与滚动触发机制完整（.rv/.in/IO/一次性解绑）', () => {
  const css = read('assets/site.css');
  ok(/html\.js\s+\.rv\s*\{[^}]*opacity:\s*0/.test(css), '缺少无 JS 回退（html.js 限定隐藏）');
  ok(/\.rv\.in/.test(css), '缺少 .in 触发态');
  const js = read('assets/site.js');
  ok(/IntersectionObserver/.test(js), '未用 IntersectionObserver');
  ok(/unobserve/.test(js), '非一次性触发（缺 unobserve）');
  ok(/threshold:\s*0\.15/.test(js), '阈值不是 0.15');
  for (const p of PAGES) {
    const html = read(p);
    ok(/class="[^"]*\brv\b/.test(html), `${p} 页面无 .rv 挂载点`);
  }
  ok(/--d:\s*\d+ms/.test(read('index.html')), '缺少 stagger 变量');
});

test('熄火规则完整（系统偏好＋手动开关）', () => {
  const css = read('assets/site.css');
  ok(/prefers-reduced-motion:\s*reduce/.test(css), '缺少 reduce 熄火');
  ok(/data-motion="off"/.test(css) || /data-motion=.off./.test(css), '缺少手动开关熄火');
  for (const p of PAGES) {
    ok(/id="motionToggle"/.test(read(p)), `${p} 页脚缺开关按钮`);
  }
});

test('动效只用 transform/opacity（无重排属性动画）', () => {
  const css = read('assets/site.css');
  const motionBlock = css.slice(css.indexOf('动效'));
  const bad = [...motionBlock.matchAll(/animation:[^;]*(width|height|margin|padding|top|left)\b/gi)];
  ok(bad.length === 0, `发现重排属性动画：${bad.slice(0, 2).map((m) => m[0]).join(' / ')}`);
});

test('site.js 仍在体积内（< 100 行非空）', () => {
  const js = read('assets/site.js');
  const lines = js.split('\n').filter((l) => l.trim()).length;
  ok(lines > 0 && lines < 100, `site.js 非空行 ${lines}，超限`);
});

test('移动端菜单下拉过渡（max-height，非 display 硬切）', () => {
  const css = read('assets/site.css');
  ok(/\.site-nav\s*\{[^}]*max-height:\s*0/.test(css), '菜单缺收起态 max-height:0');
  ok(/\.site-nav\.open\s*\{[^}]*max-height:\s*\d+px/.test(css), '菜单缺展开态 max-height');
  ok(/transition:[^;]*max-height/.test(css), '菜单缺 max-height 过渡');
});

test('首滚卸光晕显存 hint（settled 机制，常驻进度条监听）', () => {
  const css = read('assets/site.css');
  ok(/html\.settled\s+\.hero::before/.test(css), '缺少 settled 卸 hint 规则');
  const js = read('assets/site.js');
  ok(/classList\.add\('settled'\)/.test(js), 'JS 未在滚动加 settled');
  ok(/passive:\s*true/.test(js), '滚动监听非 passive');
  ok(/scrollProgress/.test(js), '缺少滚动进度条');
  ok(/glow-follow/.test(js) && /pointer:\s*fine/.test(js), '跟随光斑未限桌面细指针');
});

test('循环动画仅氛围三处（漂移/HOT/跑马灯，防廉价感）', () => {
  const css = read('assets/site.css');
  const loops = [...css.matchAll(/animation:[^;]*infinite/gi)];
  ok(loops.length >= 1, '缺少氛围循环');
  ok(loops.every((m) => /drift|pulse-soft|slide-x/.test(m[0])), `存在非白名单循环：${loops.map((m) => m[0]).join(' / ')}`);
  ok(/\.marquee:hover\s+\.marquee-track\s*\{[^}]*paused/.test(css), '跑马灯缺悬停暂停');
});

test('新增实用构件齐全（mock 窗/FAQ/CTA/页脚矩阵/眉题）', () => {
  const html = read('index.html');
  for (const s of ['hero-visual', 'marquee-track', '<details', 'cta-panel', 'foot-matrix', 'eyebrow', 'scrollProgress']) {
    ok(html.includes(s), `缺少构件：${s}`);
  }
  const css = read('assets/site.css');
  for (const c of ['.mock', '.faq-list', '.cta-panel', '.foot-matrix', '.eyebrow', '.scroll-progress', '.grad', '.glow-follow']) {
    ok(css.includes(c), `缺少样式：${c}`);
  }
});

console.log('\nP1 多页交叉导航');

test('P1 三页均含产品线页脚交叉链接', () => {
  for (const p of ['apply/index.html', 'jobs/index.html', 'extension/index.html']) {
    const html = read(p);
    ok(/href="\.\.\/index\.html"/.test(html), `${p} 缺回首页链接`);
    ok(/href="\.\.\/apply\/index\.html"/.test(html), `${p} 页脚缺 apply 链接`);
    ok(/href="\.\.\/jobs\/index\.html"/.test(html), `${p} 页脚缺 jobs 链接`);
    ok(/href="\.\.\/extension\/index\.html"/.test(html), `${p} 页脚缺 extension 链接`);
  }
});

test('首页产品卡片链接到 P1 三页', () => {
  const html = read('index.html');
  ok(/href="apply\/index\.html"/.test(html), '首页缺 apply 链接');
  ok(/href="jobs\/index\.html"/.test(html), '首页缺 jobs 链接');
  ok(/href="extension\/index\.html"/.test(html), '首页缺 extension 链接');
});

test('P1 三页各自含 hero + FAQ + CTA + motionToggle', () => {
  for (const p of ['apply/index.html', 'jobs/index.html', 'extension/index.html']) {
    const html = read(p);
    ok(/class="hero"/.test(html), `${p} 缺 hero`);
    ok(/<details/.test(html), `${p} 缺 FAQ 手风琴`);
    ok(/cta-panel/.test(html), `${p} 缺 CTA 横幅`);
    ok(/id="motionToggle"/.test(html), `${p} 缺动效开关`);
    ok(/class="scroll-progress"/.test(html), `${p} 缺滚动进度条`);
  }
});

console.log('\nP1.5 内容丰富化');

test('首页新三分区：数据实力条 / 架构简图 / 使用前后对比', () => {
  const html = read('index.html');
  for (const s of ['id="stats"', 'id="arch"', 'id="compare"', 'stats-bar', 'arch-flow', 'compare-col']) {
    ok(html.includes(s), `首页缺少构件：${s}`);
  }
  const css = read('assets/site.css');
  for (const c of ['.stats-bar', '.arch-flow', '.compare', '.compare-col.before', '.compare-col.after']) {
    ok(css.includes(c), `site.css 缺少样式：${c}`);
  }
});

test('数字滚动：data-count 挂载 + site.js count-up 一次性触发', () => {
  const html = read('index.html');
  const nums = [...html.matchAll(/data-count="[\d.]+"/g)];
  ok(nums.length >= 5, `data-count 元素不足（实得 ${nums.length}，需 ≥5）`);
  const js = read('assets/site.js');
  ok(/data-count/.test(js), 'site.js 未读取 data-count');
  ok(/requestAnimationFrame/.test(js), 'site.js 数字滚动未用 rAF');
  ok(/performance\.now/.test(js), 'site.js 数字滚动缺计时基准');
  ok(/data-decimal/.test(js), 'site.js 未处理小数位');
});

test('apply 页：平台兼容度矩阵 + 54 槽位字段分组', () => {
  const html = read('apply/index.html');
  for (const s of ['id="platforms"', 'id="slots"', 'class="tbl"', 'slot-grid', 'slot-group', 'ApplyWeb', 'Liaison', 'Slate']) {
    ok(html.includes(s), `apply 页缺少：${s}`);
  }
  const css = read('assets/site.css');
  for (const c of ['.tbl', '.slot-grid', '.slot-group', '.slot-tag']) {
    ok(css.includes(c), `site.css 缺少样式：${c}`);
  }
});

test('jobs 页：信息源三卡 + 订阅规则示例', () => {
  const html = read('jobs/index.html');
  for (const s of ['id="sources"', 'src-grid', 'src-card', 'rule-demo', '"keywords"']) {
    ok(html.includes(s), `jobs 页缺少：${s}`);
  }
  const css = read('assets/site.css');
  for (const c of ['.src-grid', '.src-card', '.rule-demo']) {
    ok(css.includes(c), `site.css 缺少样式：${c}`);
  }
});

test('extension 页：更新日志（版本号 + 条目）', () => {
  const html = read('extension/index.html');
  for (const s of ['id="changelog"', 'changelog', 'cl-item', 'class="ver"', '0.1.0']) {
    ok(html.includes(s), `extension 页缺少：${s}`);
  }
  const css = read('assets/site.css');
  ok(css.includes('.changelog'), 'site.css 缺少 .changelog 样式');
  ok(css.includes('.cl-item'), 'site.css 缺少 .cl-item 样式');
});

test('P1.5 构件齐全：时间线 / 面包屑 / 相关阅读 / 图标位', () => {
  const css = read('assets/site.css');
  for (const c of ['.timeline', '.crumbs', '.related', '.badge-wall']) {
    ok(css.includes(c), `site.css 缺少样式：${c}`);
  }
  const jobs = read('jobs/index.html');
  ok(/class="icon"/.test(jobs), 'jobs 页信息源卡缺图标位');
});

test('三产品页含相关阅读内链互荐（.related）', () => {
  for (const p of ['apply/index.html', 'jobs/index.html', 'extension/index.html']) {
    const html = read(p);
    ok(/class="related"/.test(html), `${p} 缺相关阅读块`);
    const links = [...html.matchAll(/class="related"[\s\S]*?<\/div>/g)][0]?.[0] || '';
    const hrefs = [...links.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    ok(hrefs.length >= 2, `${p} 相关阅读链接不足 2 条`);
    ok(hrefs.every((h) => h.includes('index.html')), `${p} 相关阅读含非页面链接`);
  }
});

test('P1.5 新构件窄屏适配（960/560 断点覆盖新样式）', () => {
  const css = read('assets/site.css');
  const m960 = css.slice(css.indexOf('max-width: 960px'), css.indexOf('max-width: 560px'));
  ok(/stats-bar/.test(m960), '960 断点缺 stats-bar 适配');
  ok(/slot-grid/.test(m960), '960 断点缺 slot-grid 适配');
  ok(/compare/.test(m960), '960 断点缺 compare 适配');
  const m560 = css.slice(css.indexOf('max-width: 560px'));
  ok(/src-grid/.test(m560), '560 断点缺 src-grid 适配');
  ok(/arch-flow/.test(m560), '560 断点缺 arch-flow 适配');
});

console.log('\nP2 信任层与 SEO');

test('P2 七页文件齐全（gpa/docs/about/welcome/privacy/terms/pricing + gpa.js）', () => {
  for (const f of [
    'gpa/index.html', 'assets/gpa.js', 'docs/index.html', 'docs/about/index.html',
    'welcome/index.html', 'privacy/index.html', 'terms/index.html', 'pricing/index.html',
    'sitemap.xml', 'robots.txt',
  ]) {
    ok(existsSync(join(ROOT, f)), `缺文件：${f}`);
  }
});

test('gpa 页：三模式换算 + 加权计算器 + 参照表 + 双 JSON-LD', () => {
  const html = read('gpa/index.html');
  for (const s of ['data-mode="pct"', 'data-mode="five"', 'data-mode="four"', 'courseTable', 'id="weighted"', 'id="table"', 'gpa.js', '90–100']) {
    ok(html.includes(s), `gpa 页缺少：${s}`);
  }
  ok((html.match(/application\/ld\+json/g) || []).length >= 2, 'gpa 页 JSON-LD 不足 2 块');
});

test('gpa.js 与 gpa.ts 阶梯口径一致（单一事实源）', () => {
  const js = read('assets/gpa.js');
  const ts = readFileSync(resolve(ROOT, '../console/src/lib/gpa.ts'), 'utf8');
  for (const pair of ['[90, 4.0]', '[85, 3.7]', '[82, 3.3]', '[78, 3.0]', '[75, 2.7]', '[72, 2.3]', '[68, 2.0]', '[64, 1.5]', '[60, 1.0]']) {
    ok(js.includes(pair), `gpa.js 缺阶梯：${pair}`);
    const m = pair.match(/\[(\d+), ([\d.]+)\]/);
    ok(ts.includes(`>= ${m[1]}`) && ts.includes(`return ${m[2]}`), `gpa.ts 阶梯不一致：${pair}`);
  }
  for (const uk of ['>= 70', '>= 60', '>= 50', '>= 40']) {
    ok(js.includes(uk), `gpa.js 缺英制阈值：${uk}`);
  }
});

test('docs 页四章齐全 + 交叉链接', () => {
  const html = read('docs/index.html');
  for (const s of ['id="ch1"', 'id="ch2"', 'id="ch3"', 'id="ch4"', '不自动提交', 'about/index.html', '../gpa/index.html', '../jobs/index.html']) {
    ok(html.includes(s), `docs 页缺少：${s}`);
  }
});

test('docs/about 页：团队 + 技术栈表 + 联系方式', () => {
  const html = read('docs/about/index.html');
  for (const s of ['留学生助手开发团队', 'class="tbl"', 'React 18', 'NestJS', 'id="contact"', '下架']) {
    ok(html.includes(s), `about 页缺少：${s}`);
  }
});

test('welcome 页：三步上手 + UTM 采集', () => {
  const html = read('welcome/index.html');
  for (const s of ['id="steps"', '完善个人资料', '建一条订阅', '安装浏览器插件', 'qz.utm', 'URLSearchParams']) {
    ok(html.includes(s), `welcome 页缺少：${s}`);
  }
});

test('privacy 页：收集范围表 + 保护 + 权利', () => {
  const html = read('privacy/index.html');
  for (const s of ['id="scope"', 'class="tbl"', '只存哈希不存原文', 'id="protect"', 'id="rights"', '本地优先']) {
    ok(html.includes(s), `privacy 页缺少：${s}`);
  }
});

test('terms 页：合规红线面板 + 责任边界', () => {
  const html = read('terms/index.html');
  for (const s of ['id="service"', 'id="compliance"', '不破解验证码', 'id="duty"', '院校官方口径', '最终责任']) {
    ok(html.includes(s), `terms 页缺少：${s}`);
  }
});

test('pricing 页：免费声明 + 付费预告 + FAQ JSON-LD', () => {
  const html = read('pricing/index.html');
  for (const s of ['目前全部免费', 'id="future"', '提前公示', '保留免费基础版', 'ld+json', 'FAQPage']) {
    ok(html.includes(s), `pricing 页缺少：${s}`);
  }
});

test('sitemap.xml：11 条 URL 且与实际文件一一对应', () => {
  const sm = read('sitemap.xml');
  ok(/^<\?xml/.test(sm), 'sitemap 缺 XML 声明');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(locs.length === 11, `sitemap URL 数 ${locs.length}，需 11`);
  for (const loc of locs) {
    const path = loc.replace(/^https?:\/\/[^/]+/, '');
    const file = path.endsWith('/') ? path + 'index.html' : path;
    ok(existsSync(join(ROOT, file)), `sitemap 指向不存在的页面：${path}`);
  }
  ok(/jobs\/<\/loc><changefreq>daily/.test(sm), 'jobs 页未设 daily');
});

test('robots.txt：允许全站且指向 sitemap', () => {
  const rb = read('robots.txt');
  ok(/User-agent: \*/.test(rb), '缺 User-agent');
  ok(/Allow: \//.test(rb), '缺 Allow');
  ok(/Sitemap: .*sitemap\.xml/.test(rb), '缺 sitemap 指向');
});

test('JSON-LD 结构化数据全部可解析（6 页）', () => {
  const withLd = ['index.html', 'gpa/index.html', 'apply/index.html', 'jobs/index.html', 'extension/index.html', 'pricing/index.html'];
  for (const p of withLd) {
    const html = read(p);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    ok(blocks.length >= 1, `${p} 无 JSON-LD`);
    for (const b of blocks) {
      let obj;
      try { obj = JSON.parse(b[1]); } catch (e) { throw new Error(`${p} JSON-LD 解析失败：${e.message}`); }
      ok(obj['@context'] && obj['@type'], `${p} JSON-LD 缺 @context/@type`);
      if (obj['@type'] === 'FAQPage') ok(Array.isArray(obj.mainEntity) && obj.mainEntity.length >= 3, `${p} FAQPage mainEntity 不足`);
    }
  }
});

test('全站 11 页 SEO 基础（title/description/OG/viewport）', () => {
  for (const p of ALL_PAGES) {
    const html = read(p);
    ok(/<title>[^<]{6,}<\/title>/.test(html), `${p} 缺少 title`);
    ok(/meta name="description" content="[^"]{20,}"/.test(html), `${p} 缺少 description`);
    ok(/og:title/.test(html) && /og:description/.test(html), `${p} 缺少 OG`);
    ok(/meta name="viewport"/.test(html), `${p} 缺少 viewport`);
  }
});

test('全站 11 页合规红线（不自动提交承诺 + 否定语境）', () => {
  for (const p of ALL_PAGES) {
    const html = read(p);
    ok(/不自动提交|不代替你点|绝不.*提交|只负责填充/.test(html), `${p} 缺合规承诺`);
    const text = html.replace(/<[^>]*>/g, '');
    const re = /(自动提交|一键提交|代提交)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 4), m.index);
      ok(/[不无禁杜绝免]/.test(before), `${p} 可疑提交文案：…${before}${m[0]}`);
    }
  }
});

test('全站 11 页本地链接不断链（含 P2 新页）', () => {
  for (const page of ALL_PAGES) {
    const dir = join(ROOT, dirname(page));
    const html = read(page);
    const hrefs = [...html.matchAll(/href="([^"#]+)(#[^"]*)?"/g)].map((m) => m[1]);
    for (const h of hrefs) {
      if (/^(https?:|data:|mailto:|tel:)/.test(h)) continue;
      const target = resolve(dir, h);
      ok(existsSync(target), `${page} 链接不存在：${h}`);
    }
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const anchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    for (const a of anchors) ok(ids.has(a), `${page} 锚点无对应 id：#${a}`);
  }
});

test('页脚占位已清零且四页互链 P2 页面', () => {
  for (const p of ALL_PAGES) {
    const html = read(p);
    ok(!/随 P2 上线/.test(html), `${p} 残留 P2 占位文案`);
    ok(/id="motionToggle"/.test(html), `${p} 缺动效开关`);
    ok(/site\.js/.test(html), `${p} 未引 site.js`);
  }
  for (const p of ['index.html', 'apply/index.html', 'jobs/index.html', 'extension/index.html', 'gpa/index.html']) {
    const html = read(p);
    ok(/docs\/index\.html|\.\.\/docs\/index\.html/.test(html), `${p} 页脚缺使用手册链接`);
    ok(/privacy\/index\.html|\.\.\/privacy\/index\.html/.test(html), `${p} 页脚缺隐私政策链接`);
    ok(/terms\/index\.html|\.\.\/terms\/index\.html/.test(html), `${p} 页脚缺用户协议链接`);
  }
});

console.log('\nP3 自动化');

test('build-jobs.py 可执行且快照结构合法、日期不超 3 天', () => {
  ok(existsSync(join(ROOT, 'scripts/build-jobs.py')), '缺 scripts/build-jobs.py');
  const src = read('scripts/build-jobs.py');
  ok(/sqlite3/.test(src), 'build-jobs 未用 stdlib sqlite3');
  ok(/jobs-snapshot\.json/.test(src), 'build-jobs 未写快照文件');
  ok(/沿用已有快照/.test(src), 'build-jobs 缺降级提示');
  const snapPath = join(ROOT, 'assets/jobs-snapshot.json');
  ok(existsSync(snapPath), '缺 assets/jobs-snapshot.json（先跑 build-jobs.py）');
  const snap = JSON.parse(read('assets/jobs-snapshot.json'));
  ok(typeof snap.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(snap.updated_at), '快照缺 updated_at');
  ok(Array.isArray(snap.jobs) && snap.jobs.length > 0, '快照 jobs 为空');
  ok(typeof snap.total === 'number', '快照缺 total');
  for (const j of snap.jobs) {
    for (const k of ['company', 'title', 'city', 'deadline']) {
      ok(typeof j[k] === 'string', `快照岗位缺字段 ${k}`);
    }
    ok(Array.isArray(j.tags), '快照岗位 tags 非数组');
  }
  const ageDays = (Date.now() - new Date(snap.updated_at).getTime()) / 86400000;
  ok(ageDays >= 0 && ageDays <= 3, `快照过期：${ageDays.toFixed(1)} 天`);
});

test('jobs 页接入快照：静态降级 + 加载器挂载点', () => {
  const html = read('jobs/index.html');
  for (const s of ['id="snapshotLive"', 'id="snapshotStamp"', 'id="snapshotWarn"', 'jobs-snapshot.js']) {
    ok(html.includes(s), `jobs 页缺少快照构件：${s}`);
  }
  const items = (html.match(/snapshotLive"[\s\S]*?<\/div>/) || [''])[0];
  const lis = (items.match(/<li /g) || []).length;
  ok(lis >= 5, `静态降级列表不足 5 条（${lis}）`);
  const js = read('assets/jobs-snapshot.js');
  ok(/fetch\(/.test(js), '加载器未用 fetch');
  ok(/no-cache/.test(js), '加载器未禁缓存');
  ok(/esc\(/.test(js) && /&amp;/.test(js), '加载器缺 XSS 转义');
  ok(/86400000/.test(js), '加载器缺超期判断（3 天黄条）');
});

test('sync-tokens.py 与 deploy-site.ps1 齐全', () => {
  ok(existsSync(join(ROOT, 'scripts/sync-tokens.py')), '缺 scripts/sync-tokens.py');
  const st = read('scripts/sync-tokens.py');
  ok(/tokens\.css/.test(st) && /shutil/.test(st), 'sync-tokens 逻辑不完整');
  ok(/parents\[3\]/.test(st), 'sync-tokens 根路径层级错误（应为 parents[3]）');
  const deploy = readFileSync(resolve(ROOT, '../../deploy/deploy-site.ps1'), 'utf8');
  ok(/smoke\.mjs/.test(deploy), 'deploy 未接冒烟');
  ok(/build-jobs\.py/.test(deploy), 'deploy 未重建快照');
  ok(/Compress-Archive/.test(deploy), 'deploy 未打包');
});

test('零构建约束未破坏：无打包配置、新增 JS 均为独立 IIFE', () => {
  for (const f of ['assets/site.js', 'assets/gpa.js', 'assets/jobs-snapshot.js']) {
    const js = read(f);
    ok(/\(function\s*\(/.test(js), `${f} 非 IIFE 包裹`);
    ok(!/import\s|require\(|export\s/.test(js), `${f} 出现模块语法（零构建约束）`);
  }
  ok(!existsSync(join(ROOT, 'package.json')), 'site 出现 package.json（应零构建）');
  ok(!existsSync(join(ROOT, 'vite.config.js')) && !existsSync(join(ROOT, 'webpack.config.js')), 'site 出现打包配置');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('官网冒烟测试全部通过 ✓');