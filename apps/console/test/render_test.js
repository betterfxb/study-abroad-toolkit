#!/usr/bin/env node
/**
 * 渲染冒烟测试：把 App.tsx 用 esbuild 打包后做服务端渲染（renderToString），
 * 验证四个 Tab 的组件树**真实渲染不抛错**，并断言关键文案出现。
 *
 * 这比"编译通过"更进一步：能抓出运行时解引用、初始状态崩溃、Provider 缺失等问题。
 *
 * 运行：node test/render_test.js
 * 若 esbuild 不可用则自动跳过（退出码 0）。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TMP = join(ROOT, 'node_modules', '.tmp');
const OUT = join(TMP, 'render-bundle.cjs');

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- 依赖检查
let esbuild = null;
try {
  esbuild = require('esbuild');
} catch {
  esbuild = null;
}

if (!esbuild) {
  console.log('跳过渲染测试：未找到 esbuild（vite 依赖）。');
  process.exit(0);
}

// ---------------------------------------------------------------- 打包
console.log('渲染冒烟测试（esbuild 打包 + 服务端渲染）\n');

mkdirSync(TMP, { recursive: true });

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'App.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
  outfile: OUT,
  logLevel: 'silent',
});

// ---------------------------------------------------------------- DOM 桩
globalThis.window = {
  location: { hash: '' },
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
  open() {},
};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

const React = require('react');
const { renderToString } = require('react-dom/server');
const mod = require(OUT);
const App = mod.default;

ok(typeof App === 'function', 'App 默认导出应为组件');

function renderAt(hash) {
  globalThis.window.location.hash = hash;
  return renderToString(React.createElement(App));
}

// ---------------------------------------------------------------- 用例
console.log('1. 应用外壳');

test('五个 Tab 均可渲染且不抛异常', () => {
  for (const h of ['#/home', '#/jobs', '#/subscriptions', '#/apply', '#/gpa', '#/profile']) {
    const html = renderAt(h);
    ok(html.length > 500, `${h} 渲染结果过短（${html.length}）`);
  }
});

test('未知 hash 回落首页', () => {
  const html = renderAt('#/nonsense');
  ok(html.includes('留学网申自动填写'), '未知 hash 未回落首页');
});

console.log('\n2. Tab 1 · 工具集首页');

test('渲染 Hero 与 8 张工具卡片', () => {
  const html = renderAt('#/home');
  ok(html.includes('AI 驱动，载你走完留学申请与实习求职'), '缺少 Hero 标题');
  const titles = [
    '留学网申自动填写', '实习信息聚合', '简历优化 AI', '文书精修 AI',
    '院校项目库', '推荐信管理', '申请进度表', '成绩换算',
  ];
  for (const t of titles) ok(html.includes(t), `缺少卡片：${t}`);
});

test('HOT 徽标与合规标签渲染', () => {
  const html = renderAt('#/home');
  ok(html.includes('HOT'), '缺少 HOT 徽标');
  ok(html.includes('不自动提交'), '缺少「不自动提交」合规标签');
  ok(html.includes('不会代替你提交'), '缺少免责声明');
});

test('首页新手引导横幅渲染（未关闭时）', () => {
  const html = renderAt('#/home');
  ok(html.includes('三步上手'), '缺少引导标题');
  ok(html.includes('去看岗位'), '缺少引导落点按钮');
  ok(html.includes('不再提示'), '缺少关闭入口');
});

test('顶栏渲染全部导航项与登录入口', () => {
  const html = renderAt('#/home');
  for (const n of ['工具集首页', '实习信息汇总', '岗位订阅', '申请进度', '成绩换算', '资料库']) {
    ok(html.includes(n), `缺少导航：${n}`);
  }
  ok(html.includes('登录 / 注册'), '未登录时应显示登录入口');
});

console.log('\n3. Tab 2 · 实习信息汇总');

test('渲染筛选器与空态（数据加载前）', () => {
  const html = renderAt('#/jobs');
  for (const s of ['岗位筛选', '全部城市', '全部学历', '仅在招', '导出 CSV', '重置']) {
    ok(html.includes(s), `缺少筛选项：${s}`);
  }
  ok(html.includes('加载中') || html.includes('命中'), '缺少加载/统计区');
});

console.log('\n4. Tab 3 / 4 / 5 · 未登录拦截');

test('岗位订阅在未登录时给出登录引导', () => {
  const html = renderAt('#/subscriptions');
  ok(html.includes('需要登录'), '缺少登录引导');
  ok(html.includes('登录 / 注册'), '缺少登录按钮');
});

test('申请进度在未登录时给出登录引导', () => {
  const html = renderAt('#/apply');
  ok(html.includes('需要登录'), '缺少登录引导');
  ok(html.includes('登录 / 注册'), '缺少登录按钮');
});

test('资料库在未登录时给出登录引导', () => {
  const html = renderAt('#/profile');
  ok(html.includes('需要登录'), '缺少登录引导');
});

console.log('\n5. Tab 6 · 成绩换算（独立承接页）');

test('渲染成绩换算页与换算参照表', () => {
  const html = renderAt('#/gpa');
  ok(html.includes('成绩换算'), '缺少标题');
  ok(html.includes('GPA 4.0'), '缺少 GPA 说明');
  ok(html.includes('换算参照表'), '缺少换算参照表');
  ok(html.includes('加权 GPA'), '缺少加权结果区');
});

// ---------------------------------------------------------------- 清理
rmSync(OUT, { force: true });

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('渲染冒烟测试全部通过 \u2713');
