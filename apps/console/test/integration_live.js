#!/usr/bin/env node
/**
 * 控制台真实联调（走真实 HTTP，不 mock）。
 *
 * 验证控制台实际使用的每一条链路：
 *   网关健康 → 上游聚合 → 岗位列表/聚合项/CSV 导出 → 注册登录 → 资料读写 → 申请创建 → 未认证拦截
 *
 * 用法：
 *   node test/integration_live.js
 *   GATEWAY_BASE=http://127.0.0.1:8080 node test/integration_live.js
 *
 * 网关未启动时自动跳过（退出码 0），避免 CI 误报。
 */

const GW = process.env.GATEWAY_BASE || 'http://127.0.0.1:8080';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, label = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e.message}`);
  }
}

/** 统一请求：返回 { status, json, buffer } */
async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${GW}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, json, buffer: buf };
}

// ------------------------------------------------------------------ 前置探测
console.log('控制台真实联调');
console.log(`网关：${GW}\n`);

let reachable = false;
try {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 2500);
  const r = await fetch(`${GW}/health`, { signal: c.signal });
  clearTimeout(t);
  reachable = r.ok;
  console.log(`网关健康检查：HTTP ${r.status}`);
} catch (e) {
  console.log(`网关未启动（${e.name}: ${e.message}）`);
}

if (!reachable) {
  console.log('\n跳过联调：请先启动网关（apps/api：npm run start:dev），再重跑本脚本。');
  console.log('提示：本机 8080 可能被环境代理拦截，curl 需加 --noproxy \'*\'；本脚本用 Node fetch 直连。');
  process.exit(0);
}

// ------------------------------------------------------------------ 1. 上游聚合
console.log('\n1. 网关与上游服务');

let upstreamOk = false;
await test('GET /api/v1/meta/services 返回三方健康状态', async () => {
  const r = await req('GET', '/api/v1/meta/services');
  ok(r.json && r.json.code === 0, `code 应为 0，实际 ${r.json?.code}`);
  const d = r.json.data;
  ok(d.gateway && d.gateway.ok === true, 'gateway 应 ok');
  ok(typeof d.crawler?.ok === 'boolean', 'crawler 缺少 ok');
  ok(typeof d.intelligence?.ok === 'boolean', 'intelligence 缺少 ok');
  upstreamOk = Boolean(d.crawler?.ok);
  console.log(`      crawler=${d.crawler.ok} intelligence=${d.intelligence.ok}`);
});

// ------------------------------------------------------------------ 2. 岗位链路
console.log('\n2. 岗位库（控制台 Tab 2 依赖）');

if (!upstreamOk) {
  console.log('  ! 采集服务未就绪，跳过岗位相关用例');
} else {
  await test('GET /api/v1/jobs 返回分页结构', async () => {
    const r = await req('GET', '/api/v1/jobs?size=3&status=all');
    ok(r.json?.code === 0, `code 应为 0，实际 ${r.json?.code} ${r.json?.message || ''}`);
    const d = r.json.data;
    ok(typeof d.total === 'number', 'total 应为数字');
    ok(Array.isArray(d.items), 'items 应为数组');
    ok(d.items.length <= 3, 'size 未生效');
    if (d.items[0]) {
      const j = d.items[0];
      for (const k of ['id', 'company', 'title', 'city', 'salary', 'status', 'tags', 'article']) {
        ok(k in j, `岗位缺少字段 ${k}`);
      }
      ok(Array.isArray(j.tags), 'tags 应为数组');
      ok(j.article && 'account_name' in j.article, 'article 缺少 account_name');
    }
    console.log(`      命中 ${d.total} 条`);
  });

  await test('GET /api/v1/jobs/facets 返回四类聚合项', async () => {
    const r = await req('GET', '/api/v1/jobs/facets?top=10');
    ok(r.json?.code === 0, `code 应为 0，实际 ${r.json?.code}`);
    const d = r.json.data;
    for (const k of ['cities', 'companies', 'educations', 'tags']) {
      ok(Array.isArray(d[k]), `facets 缺少 ${k}`);
    }
    if (d.cities[0]) ok('value' in d.cities[0] && 'count' in d.cities[0], '聚合项结构不符');
  });

  await test('筛选参数 keyword / city 生效且不报错', async () => {
    const r = await req('GET', '/api/v1/jobs?keyword=实习&size=5');
    ok(r.json?.code === 0, `关键词筛选失败：${r.json?.message || ''}`);
    const r2 = await req('GET', '/api/v1/jobs?min_confidence=0.6&sort=confidence:desc&size=5');
    ok(r2.json?.code === 0, `置信度筛选失败：${r2.json?.message || ''}`);
  });

  await test('GET /api/v1/jobs/export.csv 带 UTF-8 BOM（Excel 不乱码）', async () => {
    const r = await req('GET', '/api/v1/jobs/export.csv?status=all');
    ok(r.status === 200, `HTTP 应为 200，实际 ${r.status}`);
    const bom = r.buffer.subarray(0, 3);
    eq([...bom], [0xef, 0xbb, 0xbf], 'CSV BOM 字节');
    const head = r.buffer.toString('utf8').split('\n')[0];
    ok(head.includes('公司'), `CSV 表头异常：${head.slice(0, 60)}`);
  });
}

// ------------------------------------------------------------------ 3. 鉴权
console.log('\n3. 鉴权（控制台登录态依赖）');

const email = `console_${Date.now()}_${Math.floor(Math.random() * 1000)}@example.com`;
const password = 'Test123456';
let accessToken = '';
let refreshToken = '';

await test('POST /api/v1/auth/register 注册并签发双 token', async () => {
  const r = await req('POST', '/api/v1/auth/register', { body: { email, password, nickname: '控制台联调' } });
  ok(r.json?.code === 0, `注册失败：${r.json?.code} ${r.json?.message || ''}`);
  const d = r.json.data;
  ok(typeof d.access_token === 'string' && d.access_token.length > 20, 'access_token 异常');
  ok(typeof d.refresh_token === 'string' && d.refresh_token.length > 20, 'refresh_token 异常');
  ok(typeof d.expires_in === 'number', 'expires_in 异常');
  eq(d.email, email, 'email 回显');
  accessToken = d.access_token;
  refreshToken = d.refresh_token;
});

await test('POST /api/v1/auth/login 用同账号登录成功', async () => {
  const r = await req('POST', '/api/v1/auth/login', { body: { email, password } });
  ok(r.json?.code === 0, `登录失败：${r.json?.code} ${r.json?.message || ''}`);
});

await test('POST /api/v1/auth/refresh 轮换 refresh_token', async () => {
  const r = await req('POST', '/api/v1/auth/refresh', { body: { refresh_token: refreshToken } });
  ok(r.json?.code === 0, `刷新失败：${r.json?.code} ${r.json?.message || ''}`);
  // 注意：JWT 以秒为精度，同一秒内签发的 token 字符串可能完全相同，
  // 因此「是否轮换」必须以随机生成的 refresh_token 为准，不能用 access_token 判断。
  ok(typeof r.json.data.access_token === 'string' && r.json.data.access_token.length > 20, 'access_token 异常');
  ok(r.json.data.refresh_token !== refreshToken, 'refresh_token 应已轮换（防重放）');
  refreshToken = r.json.data.refresh_token;
});

await test('无 token 访问 /api/v1/profile 返回 1002', async () => {
  const r = await req('GET', '/api/v1/profile');
  ok(r.json?.code === 1002, `应返回 1002，实际 ${r.json?.code}`);
});

// ------------------------------------------------------------------ 4. 资料
console.log('\n4. 资料读写（控制台 Tab 4 依赖）');

await test('PATCH /api/v1/profile 局部更新并回读一致', async () => {
  const stamp = `张${Date.now() % 10000}`;
  const p = await req('PATCH', '/api/v1/profile', {
    token: accessToken,
    body: { basic_info: { last_name: stamp, first_name: '三' }, preferences: { intake: '2027 Fall' } },
  });
  ok(p.json?.code === 0, `写入失败：${p.json?.code} ${p.json?.message || ''}`);

  const g = await req('GET', '/api/v1/profile', { token: accessToken });
  ok(g.json?.code === 0, '读取失败');
  eq(g.json.data.basic_info.last_name, stamp, 'last_name 回读');
  eq(g.json.data.basic_info.first_name, '三', 'first_name 回读');
  eq(g.json.data.preferences.intake, '2027 Fall', 'preferences 回读');
});

await test('PUT /api/v1/profile 拒绝白名单外字段', async () => {
  const r = await req('PUT', '/api/v1/profile', { token: accessToken, body: { evil_field: 1 } });
  ok(r.json?.code === 1001, `应返回 1001，实际 ${r.json?.code}`);
});

// ------------------------------------------------------------------ 5. 申请
console.log('\n5. 申请与院校（控制台 Tab 3 依赖）');

await test('GET /api/v1/institutions 返回院校项目库', async () => {
  const r = await req('GET', '/api/v1/institutions?size=5', { token: accessToken });
  ok(r.json?.code === 0, `查询失败：${r.json?.code}`);
  ok(Array.isArray(r.json.data.items), 'items 应为数组');
  if (r.json.data.items[0]) {
    const i = r.json.data.items[0];
    for (const k of ['id', 'name', 'country', 'program', 'platform']) ok(k in i, `院校缺少 ${k}`);
  }
});

await test('POST /api/v1/applications 创建后出现在列表中', async () => {
  const c = await req('POST', '/api/v1/applications', {
    token: accessToken,
    body: { institution_name: '联调测试大学', program: 'MSc Data Science', platform: 'Slate', deadline: '2027-01-15' },
  });
  ok(c.json?.code === 0, `创建失败：${c.json?.code} ${c.json?.message || ''}`);
  eq(c.json.data.status, 'draft', '初始状态');
  eq(c.json.data.progress, 0, '初始进度');
  const id = c.json.data.id;

  const l = await req('GET', '/api/v1/applications?size=10', { token: accessToken });
  ok(l.json?.code === 0, '列表查询失败');
  ok(l.json.data.items.some((a) => a.id === id), '新建申请未出现在列表');

  const u = await req('PATCH', `/api/v1/applications/${id}`, {
    token: accessToken, body: { status: 'submitted', progress: 60, notes: '已提交' },
  });
  ok(u.json?.code === 0, `更新失败：${u.json?.message || ''}`);
  eq(u.json.data.status, 'submitted', '状态更新');
  eq(u.json.data.progress, 60, '进度更新');
});

await test('PATCH /api/v1/applications/{id} 拒绝非法状态', async () => {
  const l = await req('GET', '/api/v1/applications?size=1', { token: accessToken });
  const id = l.json.data.items[0]?.id;
  ok(id, '缺少可测申请');
  const r = await req('PATCH', `/api/v1/applications/${id}`, { token: accessToken, body: { status: 'nonsense' } });
  ok(r.json?.code === 1001, `应返回 1001，实际 ${r.json?.code}`);
});

await test('推荐人：登记 → 列表 → 标记已邀请', async () => {
  const l = await req('GET', '/api/v1/applications?size=1', { token: accessToken });
  const id = l.json.data.items[0].id;

  const a = await req('POST', `/api/v1/applications/${id}/recommenders`, {
    token: accessToken, body: { name: '王教授', email: 'prof@example.edu', title: '教授', org: '某大学' },
  });
  ok(a.json?.code === 0, `添加推荐人失败：${a.json?.message || ''}`);
  eq(a.json.data.status, 'pending', '初始推荐人状态');

  const list = await req('GET', `/api/v1/applications/${id}/recommenders`, { token: accessToken });
  ok(list.json?.code === 0, '推荐人列表失败');
  ok(Array.isArray(list.json.data), '推荐人应为数组');

  const inv = await req('POST', `/api/v1/applications/${id}/recommenders/${a.json.data.id}/invite`, { token: accessToken });
  ok(inv.json?.code === 0, `标记邀请失败：${inv.json?.message || ''}`);
  eq(inv.json.data.status, 'invited', '推荐人状态');
});

// ------------------------------------------------------------------ 6. 岗位订阅
console.log('\n6. 岗位订阅与推送（控制台 Tab 3 依赖）');

const { createServer } = await import('node:http');

const received = [];
const hookServer = createServer((request, response) => {
  let raw = '';
  request.on('data', (c) => { raw += c; });
  request.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw || '{}'); } catch { /* 忽略非 JSON */ }
    received.push(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
});
await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

let subId = 0;

await test('POST /api/v1/subscriptions 创建 webhook 订阅', async () => {
  const r = await req('POST', '/api/v1/subscriptions', {
    token: accessToken,
    body: {
      name: '联调订阅', keywords: ['实习'], cities: ['北京'],
      channel: 'webhook', webhook_url: hookUrl,
    },
  });
  ok(r.json?.code === 0, `创建失败：${r.json?.message || ''}`);
  eq(r.json.data.webhook_url, hookUrl, 'webhook_url 回显');
  ok(Array.isArray(r.json.data.keywords), 'keywords 应为数组');
  subId = r.json.data.id;
});

await test('GET /api/v1/subscriptions 列表包含新订阅', async () => {
  const r = await req('GET', '/api/v1/subscriptions', { token: accessToken });
  ok(r.json?.code === 0, '列表失败');
  ok(r.json.data.items.some((s) => s.id === subId), '新订阅未出现在列表');
});

await test('GET /{id}/preview 返回匹配结果且不触发推送', async () => {
  const r = await req('GET', `/api/v1/subscriptions/${subId}/preview?window_days=30`, { token: accessToken });
  ok(r.json?.code === 0, `预览失败：${r.json?.message || ''}`);
  ok(r.json.data.scanned > 0, '扫描量应大于 0');
  ok(r.json.data.matched > 0, '应命中岗位');
  ok(typeof r.json.data.items[0].match_score === 'number', '缺少 match_score');
  ok(typeof r.json.data.items[0].match_reason === 'string', '缺少 match_reason');
  eq(received.length, 0, '预览不应触发推送');
});

await test('POST /{id}/run 真实推送并保证幂等', async () => {
  const r1 = await req('POST', `/api/v1/subscriptions/${subId}/run?window_days=30`, { token: accessToken });
  ok(r1.json?.code === 0, `执行失败：${r1.json?.message || ''}`);
  eq(r1.json.data.status, 'sent', '首次执行状态');
  ok(r1.json.data.delivered > 0, '应有推送量');
  eq(received.length, 1, 'webhook 应收到 1 次推送');
  ok(Array.isArray(received[0]?.items) && received[0].items.length > 0, '推送载荷缺少岗位');

  const r2 = await req('POST', `/api/v1/subscriptions/${subId}/run?window_days=30`, { token: accessToken });
  eq(r2.json.data.delivered, 0, '二次执行不应重复推送');
  eq(r2.json.data.status, 'no_new', '二次执行状态');
  eq(received.length, 1, 'webhook 不应收到重复推送');
});

await test('GET /api/v1/notifications 返回推送记录', async () => {
  const r = await req('GET', '/api/v1/notifications?size=5', { token: accessToken });
  ok(r.json?.code === 0, '记录查询失败');
  ok(r.json.data.total > 0, '应有推送记录');
  ok(typeof r.json.data.items[0].payload?.items?.[0]?.title === 'string', '记录缺少岗位载荷');
});

await test('GET /api/v1/notifications/stats 返回状态统计', async () => {
  const r = await req('GET', '/api/v1/notifications/stats', { token: accessToken });
  ok(r.json?.code === 0, '统计失败');
  ok(r.json.data.sent > 0, 'sent 应大于 0');
  ok(typeof r.json.data.pending === 'number', '缺少 pending');
});

await test('PATCH /{id} 停用后不可执行', async () => {
  const p = await req('PATCH', `/api/v1/subscriptions/${subId}`, {
    token: accessToken, body: { enabled: false },
  });
  ok(p.json?.code === 0, '停用失败');
  eq(p.json.data.enabled, false, 'enabled 应为 false');
  const run = await req('POST', `/api/v1/subscriptions/${subId}/run`, { token: accessToken });
  eq(run.json.code, 1001, '停用订阅执行应被拒');
});

await test('DELETE /{id} 删除订阅并级联清理推送记录', async () => {
  const d = await req('DELETE', `/api/v1/subscriptions/${subId}`, { token: accessToken });
  ok(d.json?.code === 0, '删除失败');
  const n = await req('GET', '/api/v1/notifications', { token: accessToken });
  eq(n.json.data.total, 0, '推送记录应被级联清理');
});

hookServer.close();

// ------------------------------------------------------------------ 汇总
console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('控制台真实联调全部通过 \u2713');
