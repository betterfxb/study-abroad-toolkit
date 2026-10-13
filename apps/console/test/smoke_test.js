#!/usr/bin/env node
/**
 * 控制台冒烟测试（零依赖，Node 原生 ESM）。
 *
 * 覆盖四层：
 *   1) 设计令牌与样式契约（与 docs/02-详细设计/04-UI原型.html 对齐）
 *   2) 纯逻辑行为（format.ts / tools.ts，借助 Node 原生 TS 类型擦除直接 import）
 *   3) 源码结构契约（API 客户端方法齐全、路由与组件装配正确）
 *   4) 产品红线（合规文案）与跨应用视觉一致性（插件不得再用旧酒红主色）
 *
 * 运行：npm test
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO = resolve(ROOT, '..', '..');

let pass = 0;
let fail = 0;
const failures = [];

function group(title) {
  console.log(`\n${title}`);
}

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

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function readRepo(rel) {
  return readFileSync(join(REPO, rel), 'utf8');
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}期望 ${b}，实际 ${a}`);
}

// ---------------------------------------------------------------- 加载纯逻辑模块
let fmt = null;
let tools = null;
let tsLoadError = '';

try {
  fmt = await import(new URL('../src/lib/format.ts', import.meta.url).href);
} catch (e) {
  tsLoadError = e.message;
}
try {
  tools = await import(new URL('../src/lib/tools.ts', import.meta.url).href);
} catch (e) {
  if (!tsLoadError) tsLoadError = e.message;
}
let gpa = null;
try {
  gpa = await import(new URL('../src/lib/gpa.ts', import.meta.url).href);
} catch (e) {
  if (!tsLoadError) tsLoadError = e.message;
}

let jobSub = null;
try {
  jobSub = await import(new URL('../src/lib/jobSubscribe.ts', import.meta.url).href);
} catch (e) {
  if (!tsLoadError) tsLoadError = e.message;
}

let apiLib = null;
try {
  apiLib = await import(new URL('../src/lib/api.ts', import.meta.url).href);
} catch (e) {
  if (!tsLoadError) tsLoadError = e.message;
}

// ================================================================ 1. 设计令牌
group('1. 设计令牌与样式契约');

test('tokens.css 主色为 #2563eb（与 UI 原型一致）', () => {
  const css = read('src/styles/tokens.css');
  ok(/--blue:\s*#2563eb/i.test(css), '未找到 --blue: #2563eb');
  ok(/--blue-dark:\s*#1d4ed8/i.test(css), '未找到 --blue-dark');
  ok(/--gold:\s*#d4af37/i.test(css), '未找到 --gold');
});

test('tokens.css 圆角与布局宽度符合规范', () => {
  const css = read('src/styles/tokens.css');
  ok(/--r-lg:\s*16px/.test(css), '--r-lg 应为 16px');
  ok(/--r-md:\s*10px/.test(css), '--r-md 应为 10px');
  ok(/--r-sm:\s*8px/.test(css), '--r-sm 应为 8px');
  ok(/--wrap:\s*1120px/.test(css), '--wrap 应为 1120px');
});

test('global.css 通过 @import 引入 tokens.css', () => {
  ok(/@import\s+['"]\.\/tokens\.css['"]/.test(read('src/styles/global.css')), '缺少 tokens.css 引入');
});

test('global.css 覆盖原型全部关键类名', () => {
  const css = read('src/styles/global.css');
  const need = [
    '.topbar', '.logo-mark', '.nav', '.btn', '.wrap', '.tabs', '.tab', '.hero', '.pill',
    '.grid', '.card', '.hot', '.panel', '.filters', 'table', '.tag', '.src', '.money',
    '.badge', '.bar', '.pager', '.form-grid', '.field', '.modal', '.toasts', '.empty', '.spinner',
  ];
  const missing = need.filter((c) => !css.includes(c));
  eq(missing, [], '缺少类名：');
});

test('控制台样式不得残留旧酒红主色', () => {
  for (const f of ['src/styles/tokens.css', 'src/styles/global.css']) {
    ok(!/#8b254a/i.test(read(f)), `${f} 残留 #8b254a`);
  }
});

// ================================================================ 2. 纯逻辑
group('2. 纯逻辑行为（format / tools）');

if (!fmt || !tools) {
  console.log(`  ! 跳过：无法直接加载 .ts（${tsLoadError.slice(0, 120)}）`);
  console.log('    Node >= 22.18 默认支持类型擦除，可升级 Node 后重跑。');
} else {
  test('fmtDate 处理有效值与空值', () => {
    eq(fmt.fmtDate('2026-03-05'), '2026-03-05');
    eq(fmt.fmtDate(null), '\u2014');
    eq(fmt.fmtDate(undefined), '\u2014');
    eq(fmt.fmtDate('不是日期'), '不是日期');
  });

  test('fmtDateTime 输出 YYYY-MM-DD HH:mm', () => {
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fmt.fmtDateTime('2026-03-05T10:20:00')), '格式不符');
  });

  test('fmtSize 按 1024 进制换算并处理空值', () => {
    eq(fmt.fmtSize(0), '\u2014');
    eq(fmt.fmtSize(-1), '\u2014');
    eq(fmt.fmtSize(512), '512 B');
    eq(fmt.fmtSize(2048), '2.0 KB');
    eq(fmt.fmtSize(1048576), '1.0 MB');
  });

  test('fmtSalary 空值回落为「面议」', () => {
    eq(fmt.fmtSalary(''), '面议');
    eq(fmt.fmtSalary(null), '面议');
    eq(fmt.fmtSalary(' 300/天 '), '300/天');
  });

  test('fmtConfidence / confidenceTone 分档正确', () => {
    eq(fmt.fmtConfidence(0.85), '85%');
    eq(fmt.fmtConfidence(null), '\u2014');
    eq(fmt.confidenceTone(0.9), 'green');
    eq(fmt.confidenceTone(0.65), 'orange');
    eq(fmt.confidenceTone(0.3), 'gray');
    eq(fmt.confidenceTone(null), 'gray');
  });

  test('buildQuery 跳过空值并保留 false', () => {
    eq(fmt.buildQuery({ a: 1, b: '', c: null, d: false, e: undefined }), '?a=1&d=false');
    eq(fmt.buildQuery({}), '');
  });

  test('statusMeta 命中已知状态并兜底未知状态', () => {
    eq(fmt.statusMeta(fmt.APPLICATION_STATUS, 'offer').text, '已录取');
    eq(fmt.statusMeta(fmt.APPLICATION_STATUS, 'offer').tone, 'green');
    const unknown = fmt.statusMeta(fmt.APPLICATION_STATUS, 'weird');
    eq(unknown.tone, 'gray');
    eq(unknown.text, 'weird');
  });

  test('deadlineText 对已过 / 临近 / 充裕分别给出提示', () => {
    eq(fmt.deadlineText(null).text, '\u2014');
    const past = new Date(Date.now() - 3 * 86400000).toISOString();
    ok(fmt.deadlineText(past).text.startsWith('已过'), '过期应提示已过');
    const soon = new Date(Date.now() + 3 * 86400000).toISOString();
    eq(fmt.deadlineText(soon).tone, 'red');
    const far = new Date(Date.now() + 90 * 86400000).toISOString();
    eq(fmt.deadlineText(far).tone, 'green');
  });

  test('shortText 超长截断并加省略号', () => {
    eq(fmt.shortText('abcdef', 3), 'abc\u2026');
    eq(fmt.shortText('abc', 3), 'abc');
    eq(fmt.shortText('', 3), '');
  });

  test('highlightParts 按关键词切分命中段', () => {
    eq(fmt.highlightParts('数据分析实习生', '数据'), [
      { text: '数据', hit: true }, { text: '分析实习生', hit: false },
    ]);
    const multi = fmt.highlightParts('北京数据分析', '北京 分析');
    ok(multi.filter((p) => p.hit).length === 2, '多词应命中两段');
    const ci = fmt.highlightParts('SQL Engineer', 'sql');
    ok(ci[0].hit && ci[0].text === 'SQL', '大小写不敏感且保留原文');
    eq(fmt.highlightParts('C++ 工程师', 'C++')[0], { text: 'C++', hit: true }, '正则字符需转义');
    eq(fmt.highlightParts('abc', ''), [{ text: 'abc', hit: false }], '空关键词不断链');
    eq(fmt.highlightParts('', '数据'), [{ text: '', hit: false }], '空文本不断链');
    eq(fmt.highlightParts(null, '数据'), [{ text: '', hit: false }], 'null 不断链');
  });

  test('新手引导键已定义', () => {
    eq(fmt.GUIDE_KEY, 'qz.guide.v1');
  });

  test('工具卡片为 8 张且字段完整、id 唯一', () => {
    const cards = tools.TOOL_CARDS;
    eq(cards.length, 8, '卡片数量');
    for (const c of cards) {
      ok(c.id && c.title && c.desc && c.meta && c.icon, `卡片字段缺失：${JSON.stringify(c)}`);
      ok(c.action && (c.action.tab || c.action.href || c.action.soon), `卡片 ${c.id} 缺少动作`);
    }
    eq(new Set(cards.map((c) => c.id)).size, 8, 'id 重复数');
  });

  test('HOT 徽标与原型一致（不少于 2 张）', () => {
    const hot = tools.TOOL_CARDS.filter((c) => c.hot).map((c) => c.title);
    eq(hot.length, 2, 'HOT 数量');
    ok(hot.includes('留学网申自动填写') && hot.includes('实习信息聚合'), 'HOT 卡片标题不符');
  });

  test('卡片动作指向合法 Tab', () => {
    const valid = new Set(tools.NAV_ITEMS.map((n) => n.key));
    for (const c of tools.TOOL_CARDS) {
      if (c.action.tab) ok(valid.has(c.action.tab), `${c.id} 指向未知 Tab：${c.action.tab}`);
    }
  });

  test('主导航为 6 项且 key 集合正确', () => {
    eq(
      tools.NAV_ITEMS.map((n) => n.key).sort(),
      ['apply', 'gpa', 'home', 'jobs', 'profile', 'subscriptions'],
    );
  });
}

// ================================================================ 3. 源码结构
group('3. API 客户端与源码结构');

test('api.ts 覆盖网关全部已实现接口', () => {
  const src = read('src/lib/api.ts');
  const methods = [
    'register', 'login', 'refresh', 'logout',
    'getProfile', 'putProfile', 'patchProfile',
    'institutions', 'applications', 'createApplication', 'updateApplication',
    'recommenders', 'addRecommender', 'inviteRecommender',
    'subscriptions', 'createSubscription', 'updateSubscription', 'deleteSubscription',
    'previewSubscription', 'runSubscription', 'notifications', 'notificationStats',
    'presign', 'registerDocument', 'documents', 'deleteDocument', 'parseResume', 'resumes',
    'jobs', 'jobDetail', 'facets', 'services',
  ];
  const missing = methods.filter((m) => !new RegExp(`\\b${m}\\s*:`).test(src));
  eq(missing, [], '缺少接口方法：');
});

test('api.ts 错误码文案覆盖契约全部业务码', () => {
  const src = read('src/lib/api.ts');
  for (const code of [1001, 1002, 1003, 2001, 3001, 4002, 5001, 9001]) {
    ok(new RegExp(`\\b${code}\\s*:`).test(src), `缺少错误码 ${code} 文案`);
  }
});

test('api.ts 不硬编码上游地址（走相对路径 + Vite 代理）', () => {
  const src = read('src/lib/api.ts');
  ok(!/localhost:8080|127\.0\.0\.1/.test(src), '不应在客户端硬编码网关地址');
  ok(/VITE_API_BASE/.test(src), '应支持 VITE_API_BASE 覆盖');
});

test('api.ts 提供 CSV 导出链接与 ApiError.isAuthError', () => {
  const src = read('src/lib/api.ts');
  ok(/export function jobsExportUrl/.test(src), '缺少 jobsExportUrl');
  ok(/get isAuthError\(\)/.test(src), 'ApiError 缺少 isAuthError');
});

test('鉴权层实现 token 持久化与 401 自动刷新', () => {
  const src = read('src/lib/auth.tsx');
  ok(/localStorage/.test(src), '缺少 localStorage 持久化');
  ok(/isAuthError/.test(src), '缺少 401 分支');
  ok(/refreshing/.test(src), '缺少刷新单飞（并发 401 只刷新一次）');
  ok(/export function AuthProvider/.test(src), '缺少 AuthProvider');
  ok(/export function useAuth/.test(src), '缺少 useAuth');
});

test('App.tsx 装配全部四个 Tab', () => {
  const src = read('src/App.tsx');
  for (const c of ['HomeTab', 'JobsTab', 'SubscriptionsTab', 'ApplyTab', 'ProfileTab']) {
    ok(new RegExp(`<${c}\\b`).test(src), `未渲染 ${c}`);
  }
  ok(/AuthProvider/.test(src) && /ToastProvider/.test(src), '缺少全局 Provider');
  ok(/hashchange/.test(src), '缺少 hash 路由监听');
});

test('各组件文件齐备且导出正确', () => {
  const expect = {
    'src/components/Topbar.tsx': 'export function Topbar',
    'src/components/HomeTab.tsx': 'export function HomeTab',
    'src/components/JobsTab.tsx': 'export function JobsTab',
    'src/components/SubscriptionsTab.tsx': 'export function SubscriptionsTab',
    'src/components/ApplyTab.tsx': 'export function ApplyTab',
    'src/components/ProfileTab.tsx': 'export function ProfileTab',
    'src/components/AuthModal.tsx': 'export function AuthModal',
    'src/components/Toasts.tsx': 'export function ToastProvider',
    'src/main.tsx': 'createRoot',
  };
  for (const [file, needle] of Object.entries(expect)) {
    ok(existsSync(join(ROOT, file)), `文件缺失：${file}`);
    ok(read(file).includes(needle), `${file} 缺少 ${needle}`);
  }
});

test('JobsTab 对齐 crawler 的筛选参数与导出能力', () => {
  const src = read('src/components/JobsTab.tsx');
  for (const p of ['keyword', 'city', 'education', 'status', 'min_confidence', 'sort', 'page', 'size']) {
    ok(src.includes(p), `缺少筛选参数 ${p}`);
  }
  ok(/jobsExportUrl/.test(src), '缺少 CSV 导出');
  ok(/api\.facets/.test(src), '缺少聚合筛选项加载');
  ok(/debounce|setTimeout/.test(src), '关键词应做防抖');
});

test('需鉴权的 Tab 统一走 authed 包装', () => {
  for (const f of [
    'src/components/ApplyTab.tsx',
    'src/components/ProfileTab.tsx',
    'src/components/SubscriptionsTab.tsx',
  ]) {
    ok(/authed\(/.test(read(f)), `${f} 未使用 authed 包装`);
  }
});

test('订阅 Tab 覆盖预览 / 执行 / 记录全链路', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  for (const m of ['previewSubscription', 'runSubscription', 'notificationStats', 'notifications']) {
    ok(src.includes(m), `缺少接口调用 ${m}`);
  }
  ok(/webhook_url/.test(src), '缺少回调地址字段');
  ok(/require_all_keywords/.test(src), '缺少关键词匹配模式选项');
  ok(/channel/.test(src), '缺少渠道选择');
});

test('订阅推送状态与渠道文案齐备', () => {
  const src = read('src/lib/format.ts');
  for (const s of ['pending', 'sent', 'failed']) {
    ok(src.includes(s), `缺少推送状态 ${s}`);
  }
  for (const c of ['email', 'wechat', 'webhook']) {
    ok(src.includes(c), `缺少渠道文案 ${c}`);
  }
});

test('资料字段遵循网关白名单', () => {
  const src = read('src/components/ProfileTab.tsx');
  for (const k of ['basic_info', 'education', 'tests', 'preferences']) {
    ok(src.includes(k), `缺少资料块 ${k}`);
  }
  ok(/patchProfile/.test(src), '保存应走 PATCH 局部更新');
});

test('顶栏做上游服务健康检查', () => {
  ok(/api\.services/.test(read('src/components/Topbar.tsx')), 'Topbar 未调用 services 健康接口');
});

// ================================================================ 4. 产品红线
group('4. 产品红线与跨应用一致性');

test('首页声明不代替用户提交', () => {
  const src = read('src/components/HomeTab.tsx');
  ok(/不会代替你提交/.test(src), '缺少「不代替提交」声明');
});

test('推荐信功能声明不代发邀请', () => {
  const src = read('src/components/ApplyTab.tsx');
  ok(/不代发邀请邮件|自行完成/.test(src), '缺少推荐信合规声明');
});

test('控制台源码不出现「自动提交」正向承诺', () => {
  // 只拦截「主动承诺自动化提交」，放过「不自动提交」这类合规声明
  const forbidden = /(自动提交|一键提交|代提交)/g;
  const negations = /[不无禁杜绝免]/;
  const files = [
    'src/components/HomeTab.tsx', 'src/components/JobsTab.tsx',
    'src/components/SubscriptionsTab.tsx',
    'src/components/ApplyTab.tsx', 'src/components/ProfileTab.tsx',
  ];
  for (const f of files) {
    const src = read(f);
    let m;
    forbidden.lastIndex = 0;
    while ((m = forbidden.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 4), m.index);
      ok(negations.test(before), `${f} 出现违规承诺：「${before}${m[0]}」`);
    }
  }
});

test('插件浮窗已统一为蓝色主色（无旧酒红残留）', () => {
  for (const f of ['apps/extension/src/content/panel.css', 'apps/extension/src/popup/popup.css']) {
    const css = readRepo(f);
    ok(!/#8b254a/i.test(css), `${f} 仍残留 #8b254a`);
    ok(/#2563eb/i.test(css), `${f} 未使用主色 #2563eb`);
  }
});

// ================================================================ 5. 订阅定时调度
group('5. 订阅定时调度（控制台侧）');

/** 网关 common/schedule.ts 支持的表达式语法 */
const SCHEDULE_RE = /^(?:hourly|daily@(?:[01]?\d|2[0-3]):[0-5]\d|weekly@(?:SU|MO|TU|WE|TH|FR|SA)(?:,(?:SU|MO|TU|WE|TH|FR|SA))*@(?:[01]?\d|2[0-3]):[0-5]\d|every:\d+(?:m|h))$/;

test('SCHEDULE_PRESETS 首项为「不自动执行」', () => {
  ok(Array.isArray(fmt.SCHEDULE_PRESETS), 'SCHEDULE_PRESETS 未导出');
  eq(fmt.SCHEDULE_PRESETS[0].value, '', '首项 value：');
});

test('SCHEDULE_PRESETS 全部符合网关调度语法', () => {
  const bad = fmt.SCHEDULE_PRESETS
    .filter((p) => p.value !== '')
    .filter((p) => !SCHEDULE_RE.test(p.value))
    .map((p) => p.value);
  eq(bad, [], '不符合语法的预设：');
});

test('SCHEDULE_PRESETS 每项都有中文说明', () => {
  const bad = fmt.SCHEDULE_PRESETS.filter((p) => !p.label || !p.label.trim()).map((p) => p.value);
  eq(bad, [], '缺少 label 的预设：');
});

test('scheduleOptions 空值返回预设本身', () => {
  eq(fmt.scheduleOptions('').length, fmt.SCHEDULE_PRESETS.length, '选项数：');
});

test('scheduleOptions 对已存在的预设不重复追加', () => {
  eq(fmt.scheduleOptions('daily@09:00').length, fmt.SCHEDULE_PRESETS.length, '选项数：');
});

test('scheduleOptions 对自定义表达式补一条，避免被静默改写', () => {
  const list = fmt.scheduleOptions('every:45m');
  eq(list.length, fmt.SCHEDULE_PRESETS.length + 1, '选项数：');
  const last = list[list.length - 1];
  eq(last.value, 'every:45m', '补入值：');
  ok(last.label.includes('every:45m'), '补入项应标明自定义');
});

test('api.ts 的 Subscription 暴露调度字段', () => {
  const src = read('src/lib/api.ts');
  for (const f of ['schedule: string', 'schedule_text: string', 'next_run_at: string']) {
    ok(src.includes(f), `Subscription 缺少字段 ${f}`);
  }
});

test('订阅弹窗可配置自动执行并提交 schedule', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  ok(src.includes('scheduleOptions'), '未使用 scheduleOptions');
  ok(/自动执行/.test(src), '未渲染「自动执行」标签');
  ok(/schedule:\s*form\.schedule/.test(src), '保存时未提交 schedule');
  ok(/base\?\.schedule/.test(src), '编辑时未回填 schedule');
});

test('订阅列表展示下次执行时间', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  ok(src.includes('下次执行'), '表头缺少「下次执行」');
  ok(/fmtDateTime\(s\.next_run_at\)/.test(src), '未格式化 next_run_at');
  ok(src.includes('不自动执行'), '未对未配置定时的订阅给出说明');
});

// ================================================================ 6. 交互易用性改造
group('6. 交互易用性改造（操作步骤 / 布局 / 反馈 / 速度）');

test('splitList 支持顿号（曾因网关只认逗号导致订阅匹配不到岗位）', () => {
  ok(typeof fmt.splitList === 'function', 'format.ts 未导出 splitList');
  eq(fmt.splitList('数据分析、SQL'), ['数据分析', 'SQL'], '顿号拆分：');
});

test('splitList 同时支持半角逗号 / 全角逗号 / 空格，并过滤空项', () => {
  eq(fmt.splitList('北京,上海'), ['北京', '上海'], '半角逗号：');
  eq(fmt.splitList('北京，上海'), ['北京', '上海'], '全角逗号：');
  eq(fmt.splitList('北京 上海'), ['北京', '上海'], '空格：');
  eq(fmt.splitList('北京、， 上海'), ['北京', '上海'], '混用分隔符：');
  eq(fmt.splitList(''), [], '空串：');
});

test('网关 toJsonArray 同样支持顿号（字符串入参也安全）', () => {
  const src = readRepo('apps/api/src/subscriptions/subscriptions.service.ts');
  ok(/split\(\/\[,，、\\s\]\+\/\)/.test(src), '网关拆分正则未覆盖顿号');
});

test('订阅弹窗提交数组而非原始字符串，且有 chips 预览', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  ok(/keywords:\s*splitList\(form\.keywords\)/.test(src), 'keywords 未以数组提交');
  ok(/cities:\s*splitList\(form\.cities\)/.test(src), 'cities 未以数组提交');
  ok(/<Chips/.test(src), '未渲染 chips 预览');
});

test('删除订阅走二次确认（不再点一下就删）', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  ok(src.includes('ConfirmDialog'), '未引入确认弹窗');
  ok(/setConfirmDel\(s\)/.test(src), '删除按钮未改为触发确认');
  ok(!/onClick=\{\(\) => void remove\(s\)\}/.test(src), '删除按钮仍在直接执行删除');
});

test('busy 按「行 + 动作」记录，一条订阅在跑不会锁住其它行', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  ok(/busyKey/.test(src), '未改用 busyKey');
  ok(/busyOf\s*=/.test(src), '缺少 busyOf');
  ok(/busyKey\.startsWith/.test(src), 'rowBusy 未按「行 + 动作」前缀判定');
  ok(/rowBusy\(s\.id\)/.test(src), '按钮未按行判定忙碌');
  ok(!/disabled=\{busyId === s\.id\}/.test(src), '仍在用会锁全表的 busyId');
});

test('预览弹窗可直接推送，省掉「关掉再找按钮」这一来回', () => {
  const src = read('src/components/SubscriptionsTab.tsx');
  ok(/立即推送/.test(src), '预览弹窗缺少「立即推送」');
  ok(/onRun=\{\(\) => void doRun\(/.test(src), '预览弹窗未接上执行');
});

test('岗位页 / 申请页接入 useRequest（防抖 + 竞态保护）', () => {
  ok(read('src/components/JobsTab.tsx').includes('useRequest'), '岗位页未接入 useRequest');
  ok(read('src/components/ApplyTab.tsx').includes('useRequest'), '申请页未接入 useRequest');
  // 申请页之前每敲一个字就发一次请求
  ok(read('src/components/ApplyTab.tsx').includes('useDebounced'), '申请页关键词未加防抖');
  const src = read('src/lib/useRequest.ts');
  ok(/seq\.current/.test(src), 'useRequest 缺少竞态序号保护');
  ok(/initial/.test(src) && /reload/.test(src), 'useRequest 未区分首屏/静默刷新');
});

test('新增样式类到位（表格横向滚动 / 骨架屏 / chips / 紧凑操作组）', () => {
  const css = read('src/styles/global.css');
  for (const c of ['.table-wrap', '.skeleton-row', '.chips', '.row-actions', '.panel-actions']) {
    ok(css.includes(c), `缺少样式类 ${c}`);
  }
  ok(/overflow-x:\s*auto/.test(css), '面板未开启横向滚动');
  ok(css.includes('prefers-reduced-motion'), '未尊重系统「减弱动态效果」偏好');
});

// ================================================================ 7. 成绩换算逻辑
group('7. 成绩换算逻辑（gpa.ts 纯函数）');

test('gpaFromScore 阶梯映射正确', () => {
  const { gpaFromScore } = gpa;
  eq(gpaFromScore(95), 4.0);
  eq(gpaFromScore(90), 4.0);
  eq(gpaFromScore(89), 3.7);
  eq(gpaFromScore(82), 3.3);
  eq(gpaFromScore(78), 3.0);
  eq(gpaFromScore(60), 1.0);
  eq(gpaFromScore(59), 0);
  eq(gpaFromScore(-5), 0);
  eq(gpaFromScore(200), 4.0);
});

test('ukClassFromScore 英制等级正确', () => {
  const { ukClassFromScore } = gpa;
  ok(gpa.ukClassFromScore(85).startsWith('First'), '85 应为 First');
  ok(gpa.ukClassFromScore(65).startsWith('2:1'), '65 应为 2:1');
  ok(gpa.ukClassFromScore(55).startsWith('2:2'), '55 应为 2:2');
  ok(gpa.ukClassFromScore(45).startsWith('Third'), '45 应为 Third');
  ok(gpa.ukClassFromScore(30).startsWith('Fail'), '30 应为 Fail');
});

test('weightedGpa 加权计算正确（含零学分忽略）', () => {
  const { weightedGpa } = gpa;
  const r = weightedGpa([
    { credits: 3, score: 90 },
    { credits: 4, score: 80 },
    { credits: 0, score: 100 },
  ]);
  eq(r.gpa, 3.4, '加权 GPA');
  eq(r.avgPct, 84.3, '加权均分');
  ok(r.ukClass.startsWith('First'), '均分 84.3 应为 First');
  eq(r.points.length, 2, 'points 长度（零学分课程不参与）');
});

test('weightedGpa 空输入安全返回', () => {
  const { weightedGpa } = gpa;
  const r = weightedGpa([]);
  eq(r.gpa, 0);
  eq(r.avgPct, 0);
  eq(r.ukClass, '—');
});

test('GPA_REFERENCE 覆盖全区间且单调', () => {
  const { GPA_REFERENCE } = gpa;
  eq(GPA_REFERENCE.length, 10, '参照表条目数');
  let prev = 5;
  for (const x of GPA_REFERENCE) {
    ok(x.gpa <= prev + 1e-9, `GPA 非单调下降：${x.range}`);
    prev = x.gpa;
  }
});

// ================================================================ 8. 在线表格能力（P1）
group('8. 在线表格能力（P1）：列排序 / 列显隐 / 就地筛选 / 行内编辑');

test('岗位表支持表头点击排序与列显隐与就地筛选', () => {
  const src = read('src/components/JobsTab.tsx');
  ok(/onHeaderSort/.test(src), '缺少表头点击排序');
  ok(/sortIndicator/.test(src), '缺少排序指示符');
  ok(/setVisible/.test(src), '缺少列显隐控制');
  ok(/colFilters/.test(src), '缺少就地筛选状态');
  ok(/displayItems/.test(src), '缺少按筛选后的展示集合');
  // 后端 SORT_FIELDS 允许的可排序列
  ok(/onHeaderSort\('company'\)|onHeaderSort\("company"\)/.test(src), '公司列未接入排序');
  ok(/onHeaderSort\('deadline'\)|onHeaderSort\("deadline"\)/.test(src), '截止列未接入排序');
});

test('进度表支持行内编辑（进度 / 状态）', () => {
  const src = read('src/components/ApplyTab.tsx');
  ok(/commitInline/.test(src), '缺少行内保存逻辑');
  ok(/editCell/.test(src), '缺少行内编辑态');
  ok(/updateApplication/.test(src), '行内编辑未落到更新接口');
});

// ================================================================ 9. 从岗位一键建订阅
group('9. 从岗位一键建订阅（P1）：岗位详情 → 预填规则 → 一次点击');

if (jobSub) {
  test('buildSubscriptionFromJob 按公司 / 标题 / 标签 / 城市预填规则', () => {
    const d = jobSub.buildSubscriptionFromJob({
      company: '字节跳动', title: '字节跳动 数据分析实习生', city: '北京',
      tags: ['数据分析', 'SQL'],
    });
    eq(d.name, '字节跳动·北京 订阅', '订阅名：');
    ok(d.keywords.includes('字节跳动'), '关键词应含公司名');
    ok(d.keywords.includes('数据分析'), '关键词应含标签「数据分析」');
    ok(d.keywords.includes('SQL'), '关键词应含标签「SQL」');
    eq(d.cities, ['北京'], '城市：');
    eq(d.channel, 'email', '默认渠道：');
    eq(d.schedule, 'daily@09:00', '默认调度：');
    eq(d.require_all_keywords, false, '默认任一命中（宽召回）：');
    eq(d.enabled, true, '默认启用：');
    eq(d.education, '', '学历不限：');
  });

  test('buildSubscriptionFromJob 去重：标题等于公司名时不重复入关键词', () => {
    const d = jobSub.buildSubscriptionFromJob({
      company: '微软', title: '微软', city: '上海', tags: [],
    });
    eq(d.keywords, ['微软'], '关键词：');
    eq(d.cities, ['上海'], '城市：');
    eq(d.name, '微软·上海 订阅', '订阅名：');
  });

  test('buildSubscriptionFromJob 对空字段安全兜底', () => {
    const d = jobSub.buildSubscriptionFromJob({ company: '', title: '实习生', city: '', tags: [] });
    eq(d.name, '岗位 订阅', '空公司/城市时的订阅名：');
    eq(d.keywords, ['实习生'], '无公司无标签时回落到标题词：');
    eq(d.cities, [], '无城市则不限制：');
  });
} else {
  console.log('  ! 跳过：无法直接加载 jobSubscribe.ts');
}

test('岗位详情页支持一键建订阅并接入鉴权拦截', () => {
  const src = read('src/components/JobsTab.tsx');
  ok(/一键订阅该岗位/.test(src), '缺少「一键订阅」按钮文案');
  ok(/buildSubscriptionFromJob/.test(src), '未调用 buildSubscriptionFromJob 预填');
  ok(/createSubscription/.test(src), '未调用 createSubscription');
  ok(/useAuth/.test(src), 'JobsTab 未接入 useAuth');
  ok(/onNeedAuth/.test(src), 'JobsTab 未接收 onNeedAuth');
  ok(/authed\(\(t\) => api\.createSubscription/.test(src), '建订阅未走 authed 包装');
});

test('App.tsx 向 JobsTab 传入 onNeedAuth', () => {
  const src = read('src/App.tsx');
  ok(/<JobsTab\s+onNeedAuth=/.test(src), 'App 未向 JobsTab 传 onNeedAuth');
});

// ================================================================ 10. 体验升级：高亮 / 复制投递 / 新手引导 / 窄屏
group('10. 体验升级：关键词高亮 / 复制投递 / 新手引导 / 窄屏');

test('岗位表与详情按搜索词高亮', () => {
  const src = read('src/components/JobsTab.tsx');
  ok(/highlightParts/.test(src), '未接入 highlightParts');
  ok(/<mark[^>]*className="hl"/.test(src), '缺少 mark.hl 高亮节点');
  ok(/kw=\{debouncedKw\}/.test(src), '高亮未使用防抖后的关键词');
  const css = read('src/styles/global.css');
  ok(/\.hl\s*\{/.test(css), '缺少 .hl 样式');
  ok(/var\(--gold-bg\)/.test(css), '.hl 未使用设计令牌');
});

test('岗位详情支持复制投递方式（含降级与反馈）', () => {
  const src = read('src/components/JobsTab.tsx');
  ok(/复制投递方式/.test(src), '缺少「复制投递方式」按钮文案');
  ok(/navigator\.clipboard/.test(src), '未用 clipboard API');
  ok(/execCommand\('copy'\)/.test(src), '缺少 clipboard 降级方案');
  ok(/已复制/.test(src), '缺少复制成功反馈');
});

test('首页新手引导一次性横幅', () => {
  const src = read('src/components/HomeTab.tsx');
  ok(/GUIDE_KEY/.test(src), '未接入引导键');
  ok(/三步上手/.test(src), '缺少引导标题');
  ok(/不再提示/.test(src), '缺少关闭入口');
  ok(/去看岗位/.test(src), '缺少引导落点按钮');
});

test('窄屏：弹窗与面板操作区可换行滚动', () => {
  const css = read('src/styles/global.css');
  ok(/\.modal-f\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '.modal-f 未换行');
  ok(/\.modal\s*\{[^}]*max-height/.test(css), '.modal 缺高度约束');
  ok(/\.modal-b\s*\{[^}]*overflow:\s*auto/.test(css), '.modal-b 不可滚');
  ok(/\.panel-title\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '.panel-title 未换行');
  ok(/\.panel-actions\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '.panel-actions 未换行');
});

// ================================================================ 11. 功能 B · 岗位匹配度
group('11. 岗位匹配度（功能 B · 评分列 / 详情评估 / 档案城市）');

test('matchTone 四档色阶与网关 tier 阈值一致', () => {
  ok(fmt, 'format 模块未加载');
  eq(fmt.matchTone(80), 'green', '80 分');
  eq(fmt.matchTone(100), 'green', '100 分');
  eq(fmt.matchTone(79), 'blue', '79 分');
  eq(fmt.matchTone(60), 'blue', '60 分');
  eq(fmt.matchTone(59), 'orange', '59 分');
  eq(fmt.matchTone(40), 'orange', '40 分');
  eq(fmt.matchTone(39), 'red', '39 分');
  eq(fmt.matchTone(0), 'red', '0 分');
  eq(fmt.matchTone(NaN), 'gray', '非法值');
});

test('api.ts 暴露 matchJobs 端点与评分类型', () => {
  const src = read('src/lib/api.ts');
  ok(/matchJobs:\s*\(token/.test(src), '缺少 matchJobs 方法');
  ok(src.includes("'/api/v1/match/jobs'"), '缺少评分端点路径');
  ok(/interface MatchScore/.test(src), '缺少 MatchScore 类型');
  ok(/interface MatchFactor/.test(src), '缺少 MatchFactor 类型');
  ok(/function matchJobPayload/.test(src), '缺少 matchJobPayload 纯函数');
});

test('matchJobPayload 只带评分所需字段', () => {
  ok(apiLib && apiLib.matchJobPayload, 'api.ts 未加载');
  const job = {
    id: 7, company: '字节跳动', title: '数据分析实习', city: '北京',
    salary: '300/天', duration: '3 个月', education_req: '本科', major_req: '统计学',
    retain_chance: '有', apply_method: '邮件', deadline: '2026-12-01', confidence: 0.9,
    status: 'active', tags: ['互联网'],
    article: { id: 1, title: '字节招聘', account_name: '实习速递', url: 'https://x', published_at: '' },
  };
  const p = apiLib.matchJobPayload(job);
  eq(p.id, 7, 'id');
  eq(p.city, '北京', 'city');
  eq(p.major_req, '统计学', 'major_req');
  eq(p.tags, ['互联网'], 'tags');
  eq(p.article, { title: '字节招聘', account_name: '实习速递' }, 'article 子集');
  ok(!('apply_method' in p), '不应携带 apply_method');
  ok(!('status' in p), '不应携带 status');
});

test('JobsTab 装配评分列（列定义 / 单元格 / 详情评估块）', () => {
  const src = read('src/components/JobsTab.tsx');
  ok(/match:\s*'匹配度'/.test(src), '缺少匹配度列标签');
  ok(/match: true/.test(src), '匹配度列默认可见');
  ok(/MatchCell/.test(src), '缺少 MatchCell 单元格');
  ok(/MatchPanel/.test(src), '缺少详情 MatchPanel');
  ok(/matchMap\s*=\s*useRequest/.test(src), '缺少评分 useRequest');
  ok(/api\.matchJobs\(t,\s*items\.map\(matchJobPayload\)\)/.test(src), '未按页批量打分');
  ok(/matchTone\(score\.score\)/.test(src), '未接入 matchTone 色阶');
  ok(!/onHeaderSort\('match'\)/.test(src), '评分列是客户端指标，不应参与服务端排序');
  ok(/登录查看匹配度/.test(src), '未登录缺少登录引导');
  ok(/FACTOR_STATUS/.test(src), '详情缺少因子状态映射');
});

test('评分请求 fail-open：失败静默降级、未登录不发请求', () => {
  const src = read('src/components/JobsTab.tsx');
  ok(/if \(!user \|\| !items\?\.length\) return \{\}/.test(src), '未登录应直接返回空表');
  ok(/catch \{\s*return \{\};\s*\}/.test(src), '评分失败应静默降级为空表');
});

test('ProfileTab 提供期望工作城市（preferences.preferred_cities）', () => {
  const src = read('src/components/ProfileTab.tsx');
  ok(/期望工作城市/.test(src), '缺少期望工作城市标签');
  ok(/'preferred_cities'/.test(src), '未写入 preferred_cities');
  ok(/匹配度评分/.test(src), '申请偏好说明未提匹配度');
});

// ================================================================ 汇总
console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('控制台冒烟测试全部通过 \u2713');
