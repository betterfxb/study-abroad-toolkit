/**
 * 三服务联调测试（需 crawler / intelligence / gateway 均已启动）。
 *
 * 与 test/e2e.js 的区别：
 *   * e2e.js       —— 在内存库上独立启动网关，上游指向不存在的端口，验证**契约与降级**
 *   * 本文件       —— 打真实运行中的网关，验证**跨服务代理**与**完整用户旅程**
 *
 * 运行：
 *   # 终端 1（crawler，指向已入库的 SQLite）
 *   DATABASE_URL="sqlite+aiosqlite:////tmp/gw_jobs.db" uvicorn app.main:app --port 8100
 *   # 终端 2
 *   cd apps/intelligence && uvicorn app.main:app --port 8090
 *   # 终端 3
 *   cd apps/api && npm start
 *   # 终端 4
 *   node test/integration_live.js
 */

const BASE = process.env.GATEWAY_BASE || 'http://127.0.0.1:8080';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
  }
}

function group(t) {
  console.log(`\n${t}`);
}

async function api(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log('='.repeat(64));
  console.log(`三服务联调 · 网关 ${BASE}`);
  console.log('='.repeat(64));

  // ---------------------------------------------------------- [1] 上游健康
  group('[1] 上游服务连通性');
  {
    const h = await api('GET', '/health');
    if (!h.json?.data) {
      console.log(`\n网关不可用：${BASE}`);
      process.exit(2);
    }
    check('网关自身正常', h.json.data.ok === true);
    check('crawler 已连通', h.json.data.upstream.crawler === 'up');
    check('intelligence 已连通', h.json.data.upstream.intelligence === 'up');

    const meta = await api('GET', '/api/v1/meta/services');
    check('服务聚合含词典槽位数', meta.json.data.intelligence.dictionary_slots === 54);
    check('服务聚合含降级层级', typeof meta.json.data.crawler.degrade_level === 'number');
  }

  // ---------------------------------------------------------- [2] 岗位库代理
  group('[2] 岗位库（网关 → crawler）');
  {
    const jobs = await api('GET', '/api/v1/jobs?size=3');
    check('岗位列表可用', jobs.json.code === 0);
    check('返回分页结构', typeof jobs.json.data.total === 'number' && Array.isArray(jobs.json.data.items));
    check('岗位含来源文章', !!jobs.json.data.items[0]?.article?.account_name);

    const facets = await api('GET', '/api/v1/jobs/facets');
    check('聚合筛选项可用', facets.json.code === 0 && Array.isArray(facets.json.data.cities));

    const detail = await api('GET', `/api/v1/jobs/${jobs.json.data.items[0].id}`);
    check('岗位详情可用', detail.json.code === 0 && !!detail.json.data.company);

    const filtered = await api('GET', '/api/v1/jobs?city=北京');
    check('按城市筛选生效', filtered.json.data.items.every((j) => j.city === '北京'));

    const csv = await api('GET', '/api/v1/jobs/export.csv?max_rows=3');
    check('CSV 导出返回文本', typeof csv.text === 'string' && csv.text.length > 0);
    check('CSV 含中文表头', csv.text.includes('公司') && csv.text.includes('岗位'));
    check('CSV 响应头为附件下载', String(csv.headers.get('content-disposition')).includes('attachment'));

    // BOM 必须按原始字节校验：fetch().text() 会自动剥离 BOM
    const rawRes = await fetch(`${BASE}/api/v1/jobs/export.csv?max_rows=3`);
    const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
    check('CSV 带 UTF-8 BOM（原始字节 EF BB BF）',
      rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf);
  }

  // ---------------------------------------------------------- [3] 字段匹配代理
  group('[3] 字段匹配（网关 → intelligence）');
  {
    const r = await api('POST', '/ext/v1/match-fields', {
      body: {
        system_code: 'applyweb',
        profile: {
          basic_info: { last_name: 'Chen', email: 'A@B.COM', gender: 'M', birth_date: '2003-01-15' },
          addresses: [{ country: 'CN', city: 'Beijing', province: '北京' }],
          education: [{ school: 'PKU', major: 'CS', gpa: { value: 88, scale: '100' } }],
        },
        fields: [
          { selector: '#lastName', label: 'Family Name', type: 'text' },
          { selector: '#email', label: 'Email Address', type: 'email' },
          { selector: '#gender', label: 'Gender', type: 'select', options: ['Male', 'Female'] },
          { selector: '#gpa', label: 'GPA', type: 'number' },
          { selector: '#state', label: 'State / Province', type: 'select', options: ['Beijing', 'California'] },
        ],
      },
    });
    check('匹配请求成功', r.json.code === 0);
    const bySel = Object.fromEntries((r.json.data?.instructions || []).map((i) => [i.selector, i]));
    check('识别率 100%', r.json.data.summary['识别率'] === 1);
    check('邮箱转小写', bySel['#email']?.value === 'a@b.com');
    check('GPA 88 → 3.7', bySel['#gpa']?.value === '3.7');
    check('省份 北京 → Beijing', bySel['#state']?.value === 'Beijing');
    check('性别下拉 → Male', bySel['#gender']?.value === 'Male');

    const dict = await api('GET', '/ext/v1/dictionary');
    check('词典可用', dict.json.code === 0 && dict.json.data.count === 54);

    const gpa = await api('POST', '/api/v1/gpa/convert', {
      body: { value: 88, from_scale: '100', to_scale: '4.0', country: 'US' },
    });
    check('GPA 服务端换算 88→3.7', gpa.json.code === 0 && gpa.json.data.value === '3.7');
    check('GPA 换算标注方法与口径', gpa.json.data.method === 'standard_ladder' && /官方换算/.test(gpa.json.data.note));
  }

  // ---------------------------------------------------------- [4] 完整用户旅程
  group('[4] 用户旅程（注册 → 档案 → 申请 → 订阅）');
  {
    const email = `journey_${Date.now()}@test.com`;
    const reg = await api('POST', '/api/v1/auth/register', {
      body: { email, password: 'secret123', nickname: 'Journey' },
    });
    check('注册成功', reg.json.code === 0);
    const token = reg.json.data?.access_token;
    check('获得 access_token', typeof token === 'string' && token.length > 20);

    const put = await api('PUT', '/api/v1/profile', {
      token,
      body: {
        basic_info: { last_name: 'Chen', first_name: 'Feng', email },
        education: [{ school: 'Peking University', gpa: { value: 88, scale: '100' } }],
      },
    });
    check('写入档案', put.json.code === 0 && put.json.data.basic_info.last_name === 'Chen');

    const inst = await api('GET', '/api/v1/institutions?size=1', { token });
    check('院校列表可用', inst.json.data.total >= 8);
    const instId = inst.json.data.items[0].id;

    const app = await api('POST', '/api/v1/applications', {
      token, body: { institution_id: instId },
    });
    check('创建申请', app.json.code === 0 && app.json.data.status === 'draft');
    check('申请带出院校平台', !!app.json.data.platform);
    const appId = app.json.data.id;

    const rec = await api('POST', `/api/v1/applications/${appId}/recommenders`, {
      token, body: { name: 'Prof. Wang', email: 'wang@univ.edu' },
    });
    check('添加推荐人', rec.json.code === 0);

    const inv = await api('POST', `/api/v1/applications/${appId}/recommenders/${rec.json.data.id}/invite`, { token });
    check('标记推荐人已邀请', inv.json.data.status === 'invited');

    const sub = await api('POST', '/api/v1/subscriptions', {
      token, body: { name: '北京实习', keywords: '数据分析,SQL', cities: '北京' },
    });
    check('创建订阅', sub.json.code === 0);
    check('keywords 解析为数组', Array.isArray(sub.json.data.keywords));

    const resume = await api('POST', '/api/v1/resumes/parse', {
      token,
      body: { text: '李四\nlisi@example.com | 13900139000\n技能\nPython, SQL, Docker' },
    });
    check('简历解析成功', resume.json.code === 0 && resume.json.data.parsed.basic_info.email === 'lisi@example.com');
    check('简历技能识别', resume.json.data.parsed.skills.includes('Docker'));

    const profile = await api('GET', '/api/v1/profile', { token });
    check('档案持久化', profile.json.data.education?.[0]?.school === 'Peking University');
  }

  // ------------------------------------------------------------ [5] 订阅匹配与推送
  group('[5] 订阅匹配与推送（真实链路）');
  {
    const http = require('node:http');

    // 本地 webhook 接收器：验证推送真的发出去了
    const received = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw || '{}'); } catch { /* 忽略非 JSON */ }
        received.push({ path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const hookUrl = `http://127.0.0.1:${server.address().port}/hook`;

    const reg = await api('POST', '/api/v1/auth/register', {
      body: { email: `sub_${Date.now()}@example.com`, password: 'Test123456' },
    });
    const token = reg.json.data?.access_token;
    check('注册订阅测试用户', typeof token === 'string');

    const created = await api('POST', '/api/v1/subscriptions', {
      token,
      body: {
        name: '北京实习', keywords: ['实习'], cities: ['北京'],
        channel: 'webhook', webhook_url: hookUrl,
      },
    });
    check('创建 webhook 订阅', created.json.code === 0);
    const subId = created.json.data.id;

    // 预览：只算不推
    const preview = await api('GET', `/api/v1/subscriptions/${subId}/preview?window_days=30`, { token });
    check('预览返回扫描量', preview.json.code === 0 && preview.json.data.scanned > 0);
    check('预览命中北京岗位', preview.json.data.matched > 0);
    check('预览条目带匹配分与说明',
      typeof preview.json.data.items[0]?.match_score === 'number'
      && typeof preview.json.data.items[0]?.match_reason === 'string');
    check('预览不产生推送', received.length === 0);

    // 首次执行：真实推送
    const run1 = await api('POST', `/api/v1/subscriptions/${subId}/run?window_days=30`, { token });
    check('执行返回统计', run1.json.code === 0 && run1.json.data.matched > 0);
    check('首次推送全部送达', run1.json.data.delivered === run1.json.data.matched);
    check('推送状态 sent', run1.json.data.status === 'sent');
    check('webhook 收到推送', received.length === 1);
    check('推送载荷含订阅名与条目',
      received[0]?.body?.subscription?.name === '北京实习'
      && Array.isArray(received[0]?.body?.items)
      && received[0].body.items.length > 0);
    check('推送条目含岗位关键字段',
      typeof received[0].body.items[0].company === 'string'
      && typeof received[0].body.items[0].score === 'number');

    // 二次执行：去重，不再重复推送
    const run2 = await api('POST', `/api/v1/subscriptions/${subId}/run?window_days=30`, { token });
    check('二次执行不重复推送', run2.json.data.delivered === 0);
    check('二次执行标记为重复', run2.json.data.duplicate === run1.json.data.delivered);
    check('二次执行状态 no_new', run2.json.data.status === 'no_new');
    check('webhook 未收到重复推送', received.length === 1);

    // email 渠道：排队等待外部发信器
    const mailSub = await api('POST', '/api/v1/subscriptions', {
      token, body: { name: '全部实习', keywords: ['实习'], channel: 'email' },
    });
    const mailRun = await api('POST', `/api/v1/subscriptions/${mailSub.json.data.id}/run?window_days=30`, { token });
    check('email 渠道落为待发', mailRun.json.data.status === 'pending' && mailRun.json.data.delivered > 0);

    // 推送记录与统计
    const notis = await api('GET', '/api/v1/notifications?size=5', { token });
    check('推送记录可查', notis.json.code === 0 && notis.json.data.total > 0);
    check('推送记录含岗位载荷',
      typeof notis.json.data.items[0]?.payload?.items?.[0]?.title === 'string');
    const stats = await api('GET', '/api/v1/notifications/stats', { token });
    check('统计含 sent 与 pending', stats.json.data.sent > 0 && stats.json.data.pending > 0);
    const byStatus = await api('GET', '/api/v1/notifications?status=sent', { token });
    check('按状态过滤', byStatus.json.data.items.every((d) => d.status === 'sent'));

    // 执行时间回写
    const subs = await api('GET', '/api/v1/subscriptions', { token });
    check('执行后回写 last_run_at', !!subs.json.data.items.find((s) => s.id === subId)?.last_run_at);

    // 失败路径：指向不可达地址
    const badSub = await api('POST', '/api/v1/subscriptions', {
      token,
      body: { name: '坏地址', keywords: ['实习'], channel: 'webhook', webhook_url: 'http://127.0.0.1:59997/hook' },
    });
    const badRun = await api('POST', `/api/v1/subscriptions/${badSub.json.data.id}/run?window_days=30`, { token });
    check('推送失败被记录（failed）', badRun.json.data.status === 'failed' && !!badRun.json.data.error);

    // 清理
    await api('DELETE', `/api/v1/subscriptions/${subId}`, { token });
    await api('DELETE', `/api/v1/subscriptions/${mailSub.json.data.id}`, { token });
    await api('DELETE', `/api/v1/subscriptions/${badSub.json.data.id}`, { token });
    const afterClean = await api('GET', '/api/v1/notifications', { token });
    check('删除订阅级联清理推送记录', afterClean.json.data.total === 0);

    server.close();
  }

  // ------------------------------------------------------------ [6] 订阅定时调度
  group('[6] 订阅定时调度（真实链路）');
  {
    const email = `sched-live-${Date.now()}@e2e.dev`;
    const reg = await api('POST', '/api/v1/auth/register', {
      body: { email, password: 'Sched12345', nickname: '定时联调' },
    });
    check('注册联调用户', reg.json.code === 0);
    const token = reg.json.data.access_token;

    // 建一条带定时的订阅
    const subRes = await api('POST', '/api/v1/subscriptions', {
      token,
      body: { name: '定时联调订阅', keywords: '实习', channel: 'email', schedule: 'every:15m' },
    });
    check('创建带 schedule 的订阅', subRes.json.code === 0);
    check('回显 schedule', subRes.json.data.schedule === 'every:15m');
    check('回显 schedule_text', subRes.json.data.schedule_text === '每 15 分钟');
    check('已算出 next_run_at', Date.parse(subRes.json.data.next_run_at) > Date.now() - 60000);
    const schedId = subRes.json.data.id;

    // 非法表达式被网关拒绝
    const bad = await api('PATCH', `/api/v1/subscriptions/${schedId}`, {
      token, body: { schedule: '每天九点' },
    });
    check('非法表达式 → 1001', bad.json.code === 1001);

    // 改成每天定时
    const dayPatch = await api('PATCH', `/api/v1/subscriptions/${schedId}`, {
      token, body: { schedule: 'daily@09:00' },
    });
    check('改为 daily 生效', dayPatch.json.data.schedule === 'daily@09:00');
    check('daily 文案正确', dayPatch.json.data.schedule_text === '每天 09:00');
    check('next_run_at 已重算',
      Date.parse(dayPatch.json.data.next_run_at) > Date.now() - 60000);

    // 清空 → 不再自动执行
    const clearPatch = await api('PATCH', `/api/v1/subscriptions/${schedId}`, {
      token, body: { schedule: '' },
    });
    check('清空后不自动执行',
      clearPatch.json.data.schedule === '' && clearPatch.json.data.next_run_at === '');

    // 调度运维接口限管理员
    const st = await api('GET', '/api/v1/scheduler/status', { token });
    check('非管理员读调度状态 → 1003', st.json.code === 1003);
    const tk = await api('POST', '/api/v1/scheduler/tick', { token });
    check('非管理员触发 tick → 1003', tk.json.code === 1003);

    // 定时订阅同样走真实匹配与推送（与调度器 tick 执行的是同一条链路）
    const runOnce = await api('POST', `/api/v1/subscriptions/${schedId}/run?window_days=30`, { token });
    check('定时订阅可执行一次', runOnce.json.code === 0);
    check('返回扫描量', typeof runOnce.json.data.scanned === 'number');
    check('执行状态合法',
      ['sent', 'pending', 'failed', 'no_new'].includes(runOnce.json.data.status));
    console.log(`    真实链路执行：扫描 ${runOnce.json.data.scanned} · 命中 ${runOnce.json.data.matched}`
      + ` · 推送 ${runOnce.json.data.delivered} · 状态 ${runOnce.json.data.status}`);

    // 清理
    const delSub = await api('DELETE', `/api/v1/subscriptions/${schedId}`, { token });
    check('清理订阅', delSub.json.code === 0);
  }

  // ------------------------------------------------------------ [7] 填写会话与日志
  group('[7] 填写会话与日志（网关本地）');
  {
    const reg = await api('POST', '/api/v1/auth/register', {
      body: { email: `ext-live-${Date.now()}@e2e.dev`, password: 'Ext12345' },
    });
    const token = reg.json.data.access_token;
    const cs = await api('POST', '/ext/v1/sessions', {
      token, body: { system_code: 'slate', step_index: 1 },
    });
    check('建会话成功', cs.json.code === 0 && cs.json.data.status === 'running');
    const sid = cs.json.data.id;
    const rep = await api('POST', '/ext/v1/fill-logs', {
      headers: { 'X-Ext-Token': token },
      body: { session_id: sid, logs: [{ selector: '#ln', field_key: 'basic_info.last_name', confidence: 0.99, result: 'filled' }] },
    });
    check('插件凭证上报日志成功', rep.json.code === 0 && rep.json.data.stored === 1);
    const got = await api('GET', `/ext/v1/sessions/${sid}`, { token });
    check('断点续填可查到步骤与日志', got.json.data.step_index === 1 && got.json.data.logs.length === 1);
  }

  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('全部通过');
  }
  console.log('='.repeat(64));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('联调异常：', e);
  process.exit(1);
});
