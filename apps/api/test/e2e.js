/**
 * api-gateway 端到端测试。
 *
 * 在内存 SQLite 上真实启动 Nest 应用，用 fetch 走完整 HTTP 链路验证契约：
 *   响应封装 / trace_id / 鉴权 / Profile(JSON Merge Patch) / 院校 / 申请 / 推荐人 /
 *   订阅 / 材料 / 简历解析 / 幂等 / 错误码 / 代理降级 / 跨用户隔离
 *
 * 运行：npm test   （= tsc 构建 + node --experimental-sqlite test/e2e.js）
 * 无需外部依赖：上游服务不可用时验证的是「优雅降级」而非成功路径。
 */

require('reflect-metadata');

process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
// 指向不存在的上游，验证降级
process.env.CRAWLER_BASE = 'http://127.0.0.1:59999';
process.env.INTELLIGENCE_BASE = 'http://127.0.0.1:59998';
// 调度器保持开启，但把间隔拉到上限，避免测试期间自动 tick 干扰断言
process.env.SCHEDULER_INTERVAL_MS = '3600000';
// 关闭限流：既有 242+ 项断言的请求量会撞上限额。限流本身在 [18] 组用运行时开启验证
process.env.RATE_LIMIT_ENABLED = '0';
// 管理员白名单：注册时命中即赋 role=admin（用于 [19] 管理后台鉴权验证）
process.env.ADMIN_EMAILS = 'admin-e2e@t.com, ops@example.com';
// 对象存储落盘到临时目录，避免污染项目根目录
process.env.STORAGE_DIR = require('path').join(
  require('os').tmpdir(), `qz-storage-e2e-${Date.now()}`,
);

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const {
  RateLimitService, SlidingWindowLimiter, matchRateLimitRule, isRateLimitExempt,
} = require('../dist/common/rate-limit');

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

function group(title) {
  console.log(`\n${title}`);
}

let BASE = '';

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
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors();
  await app.listen(0, '127.0.0.1');
  BASE = await app.getUrl();
  console.log('='.repeat(64));
  console.log(`api-gateway 端到端测试 · ${BASE}`);
  console.log('='.repeat(64));

  // ------------------------------------------------------------ [1] 封装与 trace
  group('[1] 响应封装 / trace_id');
  {
    const r = await api('GET', '/health');
    check('健康检查 200', r.status === 200);
    check('统一封装含 code/message/data/trace_id',
      r.json.code === 0 && r.json.message === 'ok' && 'data' in r.json && typeof r.json.trace_id === 'string');
    check('响应头回写 X-Trace-Id', !!r.headers.get('x-trace-id'));

    const r2 = await api('GET', '/health', { headers: { 'X-Trace-Id': 'trace-abc-123' } });
    check('复用上游 trace_id', r2.json.trace_id === 'trace-abc-123');

    const r3 = await api('GET', '/health');
    check('trace_id 全局唯一', r3.json.trace_id !== r.json.trace_id);
  }

  // ------------------------------------------------------------ [2] 鉴权
  group('[2] 鉴权 Auth');
  let tokenA = '';
  let refreshA = '';
  let userA = 0;
  {
    const reg = await api('POST', '/api/v1/auth/register', {
      body: { email: 'alice@example.com', password: 'secret123', nickname: 'Alice' },
    });
    check('注册成功', reg.status === 201 || reg.status === 200);
    check('返回 access_token', typeof reg.json.data?.access_token === 'string');
    check('返回 refresh_token', typeof reg.json.data?.refresh_token === 'string');
    check('expires_in = 7200', reg.json.data?.expires_in === 7200);
    tokenA = reg.json.data.access_token;
    refreshA = reg.json.data.refresh_token;
    userA = reg.json.data.user_id;

    const dup = await api('POST', '/api/v1/auth/register', {
      body: { email: 'alice@example.com', password: 'secret123' },
    });
    check('重复邮箱注册被拒', dup.json.code === 1001);

    const badPwd = await api('POST', '/api/v1/auth/register', {
      body: { email: 'bob@example.com', password: '123' },
    });
    check('弱密码被拒（1001）', badPwd.json.code === 1001);

    const badEmail = await api('POST', '/api/v1/auth/register', {
      body: { email: 'not-an-email', password: 'secret123' },
    });
    check('非法邮箱被拒（1001）', badEmail.json.code === 1001);

    const login = await api('POST', '/api/v1/auth/login', {
      body: { email: 'alice@example.com', password: 'secret123' },
    });
    check('登录成功', login.json.code === 0 && !!login.json.data.access_token);
    tokenA = login.json.data.access_token;
    refreshA = login.json.data.refresh_token;

    const wrong = await api('POST', '/api/v1/auth/login', {
      body: { email: 'alice@example.com', password: 'wrongpass' },
    });
    check('错误密码返回 1002', wrong.json.code === 1002 && wrong.status === 401);

    const refreshed = await api('POST', '/api/v1/auth/refresh', { body: { refresh_token: refreshA } });
    check('刷新 token 成功', refreshed.json.code === 0 && !!refreshed.json.data.access_token);
    check('刷新后签发新 refresh_token', refreshed.json.data.refresh_token !== refreshA);

    const replay = await api('POST', '/api/v1/auth/refresh', { body: { refresh_token: refreshA } });
    check('旧 refresh_token 已吊销（防重放）', replay.json.code === 1002);

    tokenA = refreshed.json.data.access_token;
    refreshA = refreshed.json.data.refresh_token;
  }

  // ------------------------------------------------------------ [3] 未认证
  group('[3] 未认证访问');
  {
    const r = await api('GET', '/api/v1/profile');
    check('无凭证访问 profile → 401', r.status === 401);
    check('错误码 1002', r.json.code === 1002);

    const bad = await api('GET', '/api/v1/profile', { token: 'garbage.token.value' });
    check('无效 token → 1002', bad.json.code === 1002);

    const ext = await api('GET', '/api/v1/profile', { headers: { 'X-Ext-Token': tokenA } });
    check('插件 X-Ext-Token 凭证可用', ext.json.code === 0);
  }

  // ------------------------------------------------------------ [4] Profile
  group('[4] 用户资料 Profile');
  {
    const empty = await api('GET', '/api/v1/profile', { token: tokenA });
    check('初始资料为空对象', empty.json.code === 0 && JSON.stringify(empty.json.data) === '{}');

    const put = await api('PUT', '/api/v1/profile', {
      token: tokenA,
      body: {
        basic_info: { last_name: 'Feng', first_name: 'Zong', email: 'a@b.com', gender: 'M' },
        education: [{ school: 'Tsinghua University', degree: 'Bachelor', major: 'CS' }],
        addresses: [{ type: 'permanent', country: 'CN', city: 'Beijing' }],
      },
    });
    check('PUT 全量替换成功', put.json.code === 0 && put.json.data.basic_info.last_name === 'Feng');

    const patched = await api('PATCH', '/api/v1/profile', {
      token: tokenA,
      body: { basic_info: { phone: '+8613800138000' }, preferences: { locale: 'zh-CN' } },
    });
    check('PATCH 深合并保留原字段', patched.json.data.basic_info.last_name === 'Feng');
    check('PATCH 新增叶子字段', patched.json.data.basic_info.phone === '+8613800138000');
    check('PATCH 新增顶层段', patched.json.data.preferences.locale === 'zh-CN');

    const del = await api('PATCH', '/api/v1/profile', {
      token: tokenA,
      body: { basic_info: { gender: null } },
    });
    check('JSON Merge Patch: null 删除键', del.json.data.basic_info.gender === undefined);

    const bad = await api('PATCH', '/api/v1/profile', {
      token: tokenA,
      body: { unknown_section: { x: 1 } },
    });
    check('非法顶层字段被拒（1001）', bad.json.code === 1001);

    const persist = await api('GET', '/api/v1/profile', { token: tokenA });
    check('资料已持久化', persist.json.data.education?.[0]?.school === 'Tsinghua University');
  }

  // ------------------------------------------------------------ [5] 院校
  group('[5] 院校项目');
  {
    const r = await api('GET', '/api/v1/institutions', { token: tokenA });
    check('院校列表可用', r.json.code === 0 && r.json.data.total === 8);
    check('含平台字段', typeof r.json.data.items[0].platform === 'string');

    const filtered = await api('GET', '/api/v1/institutions?platform=applyweb', { token: tokenA });
    check('按平台筛选', filtered.json.data.items.every((i) => i.platform === 'applyweb'));

    const paged = await api('GET', '/api/v1/institutions?page=1&size=3', { token: tokenA });
    check('分页生效', paged.json.data.items.length === 3 && paged.json.data.total === 8);

    const kw = await api('GET', '/api/v1/institutions?keyword=Computer', { token: tokenA });
    check('关键词搜索', kw.json.data.total > 0);
  }

  // ------------------------------------------------------------ [6] 申请
  group('[6] 申请管理');
  let appId = 0;
  {
    const created = await api('POST', '/api/v1/applications', {
      token: tokenA,
      body: { institution_id: 1, notes: '目标校' },
    });
    check('按 institution_id 创建申请', created.json.code === 0);
    check('自动带出院校信息', created.json.data.institution_name.includes('Massachusetts'));
    check('自动带出平台', created.json.data.platform === 'applyweb');
    check('初始状态 draft', created.json.data.status === 'draft');
    appId = created.json.data.id;

    const noName = await api('POST', '/api/v1/applications', { token: tokenA, body: {} });
    check('缺院校信息被拒（1001）', noName.json.code === 1001);

    const list = await api('GET', '/api/v1/applications', { token: tokenA });
    check('申请列表可用', list.json.data.total === 1);

    const upd = await api('PATCH', `/api/v1/applications/${appId}`, {
      token: tokenA,
      body: { status: 'in_progress', progress: 40 },
    });
    check('更新状态与进度', upd.json.data.status === 'in_progress' && upd.json.data.progress === 40);

    const badStatus = await api('PATCH', `/api/v1/applications/${appId}`, {
      token: tokenA, body: { status: 'nonsense' },
    });
    check('非法 status 被拒（1001）', badStatus.json.code === 1001);

    const badProgress = await api('PATCH', `/api/v1/applications/${appId}`, {
      token: tokenA, body: { progress: 999 },
    });
    check('progress 越界被拒（1001）', badProgress.json.code === 1001);

    const empty = await api('PATCH', `/api/v1/applications/${appId}`, { token: tokenA, body: {} });
    check('空更新被拒（1001）', empty.json.code === 1001);

    const notFound = await api('PATCH', '/api/v1/applications/99999', {
      token: tokenA, body: { status: 'submitted' },
    });
    check('不存在的申请 → 2001', notFound.json.code === 2001);

    const byStatus = await api('GET', '/api/v1/applications?status=in_progress', { token: tokenA });
    check('按状态筛选', byStatus.json.data.total === 1);
    const byStatus2 = await api('GET', '/api/v1/applications?status=offer', { token: tokenA });
    check('无匹配状态返回 0 条', byStatus2.json.data.total === 0);
  }

  // ------------------------------------------------------------ [7] 推荐人
  group('[7] 推荐人');
  {
    const added = await api('POST', `/api/v1/applications/${appId}/recommenders`, {
      token: tokenA,
      body: { name: 'Prof. Zhang', email: 'zhang@univ.edu', title: 'Professor', org: 'PKU' },
    });
    check('添加推荐人', added.json.code === 0 && added.json.data.status === 'pending');
    const rid = added.json.data.id;

    const noName = await api('POST', `/api/v1/applications/${appId}/recommenders`, {
      token: tokenA, body: { email: 'x@y.com' },
    });
    check('缺姓名被拒（1001）', noName.json.code === 1001);

    const list = await api('GET', `/api/v1/applications/${appId}/recommenders`, { token: tokenA });
    check('推荐人列表', list.json.data.length === 1);

    const invited = await api('POST', `/api/v1/applications/${appId}/recommenders/${rid}/invite`, {
      token: tokenA,
    });
    check('标记已邀请', invited.json.data.status === 'invited' && !!invited.json.data.invited_at);

    const bad = await api('POST', `/api/v1/applications/${appId}/recommenders/99999/invite`, {
      token: tokenA,
    });
    check('不存在推荐人 → 2001', bad.json.code === 2001);
  }

  // ------------------------------------------------------------ [8] 订阅
  group('[8] 实习订阅');
  let subId = 0;
  {
    const created = await api('POST', '/api/v1/subscriptions', {
      token: tokenA,
      body: { name: '北京数据分析', keywords: ['数据分析', 'SQL'], cities: '北京,上海', channel: 'email' },
    });
    check('创建订阅', created.json.code === 0);
    check('keywords 字符串解析为数组', Array.isArray(created.json.data.keywords) && created.json.data.keywords.length === 2);
    check('cities 逗号分隔解析', created.json.data.cities.length === 2);
    check('enabled 默认 true', created.json.data.enabled === true);
    subId = created.json.data.id;

    const badChannel = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: { name: 'x', channel: 'telegram' },
    });
    check('非法 channel 被拒（1001）', badChannel.json.code === 1001);

    const noName = await api('POST', '/api/v1/subscriptions', { token: tokenA, body: {} });
    check('缺名称被拒（1001）', noName.json.code === 1001);

    const patched = await api('PATCH', `/api/v1/subscriptions/${subId}`, {
      token: tokenA, body: { enabled: false, keywords: ['数据分析'] },
    });
    check('修改订阅', patched.json.data.enabled === false && patched.json.data.keywords.length === 1);

    const list = await api('GET', '/api/v1/subscriptions', { token: tokenA });
    check('订阅列表', list.json.data.total === 1);

    const removed = await api('DELETE', `/api/v1/subscriptions/${subId}`, { token: tokenA });
    check('删除订阅', removed.json.code === 0);

    const after = await api('GET', '/api/v1/subscriptions', { token: tokenA });
    check('删除后列表为空', after.json.data.total === 0);

    const delMissing = await api('DELETE', `/api/v1/subscriptions/${subId}`, { token: tokenA });
    check('删除不存在 → 2001', delMissing.json.code === 2001);
  }

  // ------------------------------------------------------------ [9] 材料
  group('[9] 材料与上传');
  let docId = 0;
  {
    const pre = await api('POST', '/api/v1/documents/presign', {
      token: tokenA,
      body: { file_name: 'transcript.pdf', mime: 'application/pdf', file_size: 1048576, doc_type: 'transcript' },
    });
    check('预签名返回 upload_url', typeof pre.json.data?.upload_url === 'string');
    check('预签名返回 file_key', String(pre.json.data?.file_key).startsWith(`u/${userA}/transcript/`));
    check('预签名有效期 900s', pre.json.data?.expires_in === 900);

    const badType = await api('POST', '/api/v1/documents/presign', {
      token: tokenA, body: { file_name: 'x.pdf', doc_type: 'illegal' },
    });
    check('非法 doc_type 被拒（1001）', badType.json.code === 1001);

    const tooBig = await api('POST', '/api/v1/documents/presign', {
      token: tokenA, body: { file_name: 'x.pdf', doc_type: 'cv', file_size: 999 * 1024 * 1024 },
    });
    check('超限文件被拒（1001）', tooBig.json.code === 1001);

    const reg = await api('POST', '/api/v1/documents', {
      token: tokenA,
      body: { file_key: pre.json.data.file_key, file_name: 'transcript.pdf', doc_type: 'transcript', file_size: 1048576 },
    });
    check('登记材料', reg.json.code === 0);
    docId = reg.json.data.id;

    const list = await api('GET', '/api/v1/documents?doc_type=transcript', { token: tokenA });
    check('按类型列出材料', list.json.data.total === 1);

    const other = await api('GET', '/api/v1/documents?doc_type=cv', { token: tokenA });
    check('其他类型为空', other.json.data.total === 0);

    const removed = await api('DELETE', `/api/v1/documents/${docId}`, { token: tokenA });
    check('删除材料', removed.json.code === 0);
  }

  // ------------------------------------------------------------ [10] 简历解析
  group('[10] 简历解析');
  {
    const resumeText = [
      '张三',
      'zhangsan@example.com | 13800138000',
      '教育经历',
      '清华大学 计算机科学与技术 本科 2022-2026',
      '实习经历',
      '字节跳动 后端开发实习生',
      '技能',
      'Python, Java, SQL, Docker, PyTorch, Machine Learning',
    ].join('\n');

    const parsed = await api('POST', '/api/v1/resumes/parse', {
      token: tokenA, body: { text: resumeText },
    });
    check('解析简历成功', parsed.json.code === 0);
    check('抽取姓名', parsed.json.data.parsed.basic_info.name === '张三');
    check('抽取邮箱', parsed.json.data.parsed.basic_info.email === 'zhangsan@example.com');
    check('抽取手机号', parsed.json.data.parsed.basic_info.phone === '13800138000');
    check('识别学历', parsed.json.data.parsed.education.some((e) => e.degree === 'Bachelor'));
    check('识别技能', parsed.json.data.parsed.skills.includes('Python') && parsed.json.data.parsed.skills.includes('Docker'));
    check('标注为启发式结果', parsed.json.data.parsed.method === 'heuristic');
    check('版本号 v1', parsed.json.data.version === 1);

    const list = await api('GET', '/api/v1/resumes', { token: tokenA });
    check('简历版本列表', list.json.data.total === 1);

    const updated = await api('PUT', `/api/v1/resumes/${parsed.json.data.id}`, {
      token: tokenA, body: { name: '定制版简历', parsed: { basic_info: { name: '张三' }, skills: ['Go'] } },
    });
    check('更新简历', updated.json.data.name === '定制版简历' && updated.json.data.parsed.skills[0] === 'Go');

    const empty = await api('POST', '/api/v1/resumes/parse', { token: tokenA, body: {} });
    check('缺文本被拒（1001）', empty.json.code === 1001);
  }

  // ------------------------------------------------------------ [11] 幂等
  group('[11] 幂等 Idempotency-Key');
  {
    const key = 'idem-key-' + Date.now();
    const b = { name: '幂等订阅', keywords: ['测试'] };
    const r1 = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: b, headers: { 'Idempotency-Key': key },
    });
    const r2 = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: b, headers: { 'Idempotency-Key': key },
    });
    check('两次请求返回同一订阅 id', r1.json.data.id === r2.json.data.id);

    const list = await api('GET', '/api/v1/subscriptions', { token: tokenA });
    check('幂等未产生重复记录', list.json.data.total === 1);

    const key2 = 'idem-key-2-' + Date.now();
    const r3 = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: { name: '另一订阅' }, headers: { 'Idempotency-Key': key2 },
    });
    check('不同 Key 正常创建', r3.json.code === 0 && r3.json.data.name === '另一订阅');
  }

  // ------------------------------------------------------------ [12] 跨用户隔离
  group('[12] 跨用户数据隔离');
  {
    const bob = await api('POST', '/api/v1/auth/register', {
      body: { email: 'bob@example.com', password: 'secret123' },
    });
    const tokenB = bob.json.data.access_token;
    check('用户 B 注册成功', bob.json.data.user_id !== userA);

    const bApps = await api('GET', '/api/v1/applications', { token: tokenB });
    check('B 看不到 A 的申请', bApps.json.data.total === 0);

    const bSubs = await api('GET', '/api/v1/subscriptions', { token: tokenB });
    check('B 看不到 A 的订阅', bSubs.json.data.total === 0);

    const bDocs = await api('GET', '/api/v1/documents', { token: tokenB });
    check('B 看不到 A 的材料', bDocs.json.data.total === 0);

    const steal = await api('PATCH', `/api/v1/applications/${appId}`, {
      token: tokenB, body: { status: 'offer' },
    });
    check('B 无法修改 A 的申请 → 2001', steal.json.code === 2001);

    const bProfile = await api('GET', '/api/v1/profile', { token: tokenB });
    check('B 的资料独立为空', JSON.stringify(bProfile.json.data) === '{}');
  }

  // ------------------------------------------------------------ [13] 代理降级
  group('[13] 上游代理与降级');
  {
    const jobs = await api('GET', '/api/v1/jobs');
    check('上游不可用时优雅降级（非 500）', jobs.status === 503 || jobs.json.code === 4002);
    check('降级响应仍是契约封装', 'code' in jobs.json && 'trace_id' in jobs.json);

    const meta = await api('GET', '/api/v1/meta/services');
    check('服务聚合返回网关自身', meta.json.data.gateway.ok === true);
    check('标记上游不可用', meta.json.data.crawler.ok === false && meta.json.data.intelligence.ok === false);

    const match = await api('POST', '/ext/v1/match-fields', { body: { fields: [] } });
    check('插件接口在上游不可用时优雅降级', match.status === 503 || match.json.code === 4002);

    const gpa = await api('POST', '/api/v1/gpa/convert', { body: { value: 88 } });
    check('GPA 换算在上游不可用时优雅降级', gpa.status === 503 || gpa.json.code === 4002);
    check('GPA 降级响应仍是契约封装', 'code' in gpa.json && 'trace_id' in gpa.json);
  }

  // ------------------------------------------------------------ [14] 未知路由
  // ------------------------------------------------------------ [14] 订阅匹配与推送
  group('[14] 订阅匹配与推送');
  {
    // ---- 匹配引擎（纯函数，不依赖上游）
    const M = require('../dist/notifications/matching.js');
    const job = {
      id: 1, company: '字节跳动', title: '数据分析实习生', city: '北京',
      education_req: '本科', major_req: '统计学', tags: ['互联网', '数据分析'],
      confidence: 0.9, article: { title: '字节跳动数据分析实习招聘', account_name: '实习速递' },
    };
    const text = M.jobSearchText(job);
    check('岗位检索文本含公司/标签/来源',
      text.includes('字节跳动') && text.includes('互联网') && text.includes('实习速递'));

    const hit = M.matchJob({ keywords: ['数据分析'], cities: ['北京'], education: '本科' }, job);
    check('关键词+城市+学历 全命中', hit.matched === true && hit.score > 0.8);
    check('匹配说明可读', typeof hit.reason === 'string' && hit.reason.length > 0);
    check('命中关键词被记录', hit.hits.length === 1 && hit.hits[0] === '数据分析');

    check('关键词未命中则不匹配', M.matchJob({ keywords: ['量化'] }, job).matched === false);
    check('城市不符则不匹配',
      M.matchJob({ keywords: ['数据分析'], cities: ['上海'] }, job).matched === false);
    check('学历不符则不匹配',
      M.matchJob({ keywords: ['数据分析'], education: '博士' }, job).matched === false);
    check('岗位学历「不限」时放行',
      M.matchJob({ keywords: ['数据分析'], education: '博士' }, { ...job, education_req: '不限' }).matched === true);
    check('多关键词默认 OR 召回',
      M.matchJob({ keywords: ['量化', '数据分析'] }, job).matched === true);
    check('require_all_keywords 严格模式',
      M.matchJob({ keywords: ['量化', '数据分析'], requireAllKeywords: true }, job).matched === false);
    check('空条件全量通过',
      M.matchJob({ keywords: [], cities: [], education: '' }, job).matched === true);
    check('关键词大小写不敏感',
      M.matchJob({ keywords: ['SQL'] }, { ...job, title: 'sql 实习生' }).matched === true);
    check('城市双向包含（北京市 / 北京）',
      M.matchJob({ cities: ['北京市'] }, job).matched === true);

    const ranked = M.matchJobs({ keywords: ['数据分析', '互联网'] }, [
      { ...job, id: 1, confidence: 0.4 },
      { ...job, id: 2, confidence: 0.95 },
    ]);
    check('匹配结果按相关度排序', ranked.length === 2 && ranked[0].job.id === 2);
    check('未命中岗位被过滤', M.matchJobs({ keywords: ['不存在的词'] }, [job]).length === 0);
    check('推送标题含订阅名与数量', M.renderDigestTitle('北京数据分析', 3).includes('3'));

    // ---- 订阅字段扩展与校验
    const needUrl = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: { name: 'webhook 订阅', channel: 'webhook' },
    });
    check('webhook 渠道缺地址被拒（1001）', needUrl.json.code === 1001);

    const badUrl = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: { name: 'x', channel: 'webhook', webhook_url: 'ftp://a.b/c' },
    });
    check('webhook_url 协议非法被拒（1001）', badUrl.json.code === 1001);

    const withUrl = await api('POST', '/api/v1/subscriptions', {
      token: tokenA,
      body: {
        name: '北京数据分析', keywords: ['数据分析'], cities: ['北京'],
        channel: 'webhook', webhook_url: 'https://example.com/hook', require_all_keywords: true,
      },
    });
    check('创建 webhook 订阅', withUrl.json.code === 0);
    check('webhook_url 回显', withUrl.json.data.webhook_url === 'https://example.com/hook');
    check('require_all_keywords 回显', withUrl.json.data.require_all_keywords === true);
    check('last_run_at 初始为空', withUrl.json.data.last_run_at === '');
    const pushSubId = withUrl.json.data.id;

    const inconsistent = await api('PATCH', `/api/v1/subscriptions/${pushSubId}`, {
      token: tokenA, body: { webhook_url: '' },
    });
    check('渠道与地址一致性校验（1001）', inconsistent.json.code === 1001);

    const toEmail = await api('PATCH', `/api/v1/subscriptions/${pushSubId}`, {
      token: tokenA, body: { channel: 'email', webhook_url: '' },
    });
    check('改为 email 后允许清空地址', toEmail.json.code === 0 && toEmail.json.data.webhook_url === '');

    // ---- 上游不可用时的优雅降级（本测试环境 crawler 指向不存在的端口）
    const preview = await api('GET', `/api/v1/subscriptions/${pushSubId}/preview`, { token: tokenA });
    check('上游不可用 → 预览返回 4002', preview.json.code === 4002);
    check('预览降级 HTTP 503', preview.status === 503);

    const run = await api('POST', `/api/v1/subscriptions/${pushSubId}/run`, { token: tokenA });
    check('上游不可用 → 执行返回 4002', run.json.code === 4002);

    // ---- 停用订阅不可执行
    const disabled = await api('POST', '/api/v1/subscriptions', {
      token: tokenA, body: { name: '停用的', keywords: ['x'], enabled: false },
    });
    const runDisabled = await api('POST', `/api/v1/subscriptions/${disabled.json.data.id}/run`, {
      token: tokenA,
    });
    check('停用订阅执行被拒（1001）', runDisabled.json.code === 1001);

    // ---- 推送记录与统计
    const notis = await api('GET', '/api/v1/notifications', { token: tokenA });
    check('推送记录列表可用', notis.json.code === 0 && notis.json.data.total === 0);
    const stats = await api('GET', '/api/v1/notifications/stats', { token: tokenA });
    check('推送统计返回各状态计数',
      stats.json.code === 0 && stats.json.data.total === 0 && stats.json.data.sent === 0);
    const filtered = await api('GET', `/api/v1/notifications?subscription_id=${pushSubId}&status=sent`, {
      token: tokenA,
    });
    check('推送记录支持按订阅与状态过滤', filtered.json.code === 0 && filtered.json.data.total === 0);

    // ---- 权限与隔离
    const runAll = await api('POST', '/api/v1/subscriptions/run-all', { token: tokenA });
    check('批量执行需管理员（1003）', runAll.json.code === 1003);

    const anon = await api('GET', '/api/v1/notifications');
    check('未认证访问推送记录 → 1002', anon.json.code === 1002);

    // 另一个用户访问他人订阅
    const emailC = `push_${Date.now()}@example.com`;
    const regC = await api('POST', '/api/v1/auth/register', {
      body: { email: emailC, password: 'Test123456' },
    });
    const tokenC = regC.json.data.access_token;
    const cross = await api('GET', `/api/v1/subscriptions/${pushSubId}/preview`, { token: tokenC });
    check('跨用户访问订阅 → 2001', cross.json.code === 2001);
    const crossRun = await api('POST', `/api/v1/subscriptions/${pushSubId}/run`, { token: tokenC });
    check('跨用户执行订阅 → 2001', crossRun.json.code === 2001);
    const cNotis = await api('GET', '/api/v1/notifications', { token: tokenC });
    check('推送记录按用户隔离', cNotis.json.data.total === 0);

    // ---- 清理
    const del1 = await api('DELETE', `/api/v1/subscriptions/${pushSubId}`, { token: tokenA });
    const del2 = await api('DELETE', `/api/v1/subscriptions/${disabled.json.data.id}`, { token: tokenA });
    check('清理测试订阅', del1.json.code === 0 && del2.json.code === 0);
  }

  /** 管理员 token（[15] 内取得，[16] 复用） */
  let adminToken = '';

  // ------------------------------------------------------------ [15] 订阅定时调度
  group('[15] 订阅定时调度（表达式 / 到期判定 / tick）');
  {
    const S = require('../dist/common/schedule');
    const { DatabaseService } = require('../dist/db/database.service');
    const db = app.get(DatabaseService);
    const TZ = 480; // 东八区
    const iso = (d) => (d ? d.toISOString() : null);

    // ---- 表达式解析
    check('空表达式 → 不自动执行', S.parseSchedule('').kind === 'none');
    check('null → 不自动执行', S.parseSchedule(null).kind === 'none');
    check('hourly 解析', S.parseSchedule('hourly').kind === 'hourly');
    const pDaily = S.parseSchedule('daily@09:30');
    check('daily@HH:MM 解析', pDaily.kind === 'daily' && pDaily.hour === 9 && pDaily.minute === 30);
    check('daily 非法小时 → null', S.parseSchedule('daily@24:00') === null);
    check('daily 非法分钟 → null', S.parseSchedule('daily@09:60') === null);
    check('daily 缺冒号 → null', S.parseSchedule('daily@0900') === null);
    const w1 = S.parseSchedule('weekly@MO,WE,FR@08:30');
    check('weekly 解析星期集合', w1.kind === 'weekly' && JSON.stringify(w1.days) === '[1,3,5]');
    check('weekly 去重并升序',
      JSON.stringify(S.parseSchedule('weekly@FR,MO,MO@09:00').days) === '[1,5]');
    check('weekly 非法星期 → null', S.parseSchedule('weekly@XX@09:00') === null);
    check('weekly 空星期 → null', S.parseSchedule('weekly@@09:00') === null);
    const e1 = S.parseSchedule('every:15m');
    check('every:Nm 解析', e1.kind === 'interval' && e1.intervalMs === 900000);
    check('every:Nh 解析', S.parseSchedule('every:6h').intervalMs === 21600000);
    check('every:0m → null', S.parseSchedule('every:0m') === null);
    check('every 超上限 → null', S.parseSchedule('every:2000m') === null);
    check('中文口语 → null', S.parseSchedule('每天九点') === null);
    check('isValidSchedule 判定', S.isValidSchedule('hourly') === true && S.isValidSchedule('nope') === false);

    // ---- 下次执行时间（2026-10-09 是周五）
    check('daily：北京 08:00 → 当天 09:00',
      iso(S.nextRunAt('daily@09:00', '2026-10-09T00:00:00Z', TZ)) === '2026-10-09T01:00:00.000Z');
    check('daily：正好到点 → 顺延次日',
      iso(S.nextRunAt('daily@09:00', '2026-10-09T01:00:00Z', TZ)) === '2026-10-10T01:00:00.000Z');
    check('daily：跨月边界',
      iso(S.nextRunAt('daily@09:00', '2026-10-31T02:00:00Z', TZ)) === '2026-11-01T01:00:00.000Z');
    check('weekly：当天未到点 → 当天',
      iso(S.nextRunAt('weekly@FR@09:00', '2026-10-09T00:00:00Z', TZ)) === '2026-10-09T01:00:00.000Z');
    check('weekly：当天已过点 → 下周五',
      iso(S.nextRunAt('weekly@FR@09:00', '2026-10-09T01:00:00Z', TZ)) === '2026-10-16T01:00:00.000Z');
    check('weekly：多选取最近一天',
      iso(S.nextRunAt('weekly@MO,WE,FR@09:00', '2026-10-09T02:00:00Z', TZ)) === '2026-10-12T01:00:00.000Z');
    check('hourly：下一个整点',
      iso(S.nextRunAt('hourly', '2026-10-09T01:23:45Z', TZ)) === '2026-10-09T02:00:00.000Z');
    check('interval：锚点 + 间隔',
      iso(S.nextRunAt('every:30m', '2026-10-09T01:00:00Z', TZ)) === '2026-10-09T01:30:00.000Z');
    check('不自动执行 → null', S.nextRunAt('', '2026-10-09T01:00:00Z', TZ) === null);
    check('非法表达式 → null', S.nextRunAt('nope', '2026-10-09T01:00:00Z', TZ) === null);
    check('UTC 时区偏移 0 时按 UTC 计算',
      iso(S.nextRunAt('daily@09:00', '2026-10-09T00:00:00Z', 0)) === '2026-10-09T09:00:00.000Z');

    // ---- 到期判定
    const NOW = new Date('2026-10-09T02:00:00Z');
    check('从未执行 → 立即到期', S.isDue('daily@09:00', null, NOW, TZ) === true);
    check('刚执行完 → 未到期', S.isDue('daily@09:00', NOW, NOW, TZ) === false);
    check('上次执行在一天前 → 已到期',
      S.isDue('daily@09:00', new Date('2026-10-08T01:00:00Z'), NOW, TZ) === true);
    check('不自动执行 → 永不到期', S.isDue('', null, NOW, TZ) === false);

    // ---- 文案
    check('文案：每天', S.describeSchedule('daily@09:00') === '每天 09:00');
    check('文案：每周多日', S.describeSchedule('weekly@MO,WE@08:30') === '每周一、周三 08:30');
    check('文案：每 15 分钟', S.describeSchedule('every:15m') === '每 15 分钟');
    check('文案：每 2 小时', S.describeSchedule('every:2h') === '每 2 小时');
    check('文案：每小时', S.describeSchedule('hourly') === '每小时');
    check('文案：不自动执行', S.describeSchedule('') === '不自动执行');
    check('时区偏移解析默认东八区', S.resolveTzOffset(undefined) === 480);
    check('时区偏移解析夹取范围', S.resolveTzOffset('9999') === 840);

    // ---- 接口：带 schedule 的增改
    const sch = await api('POST', '/api/v1/subscriptions', {
      token: tokenA,
      body: { name: '定时订阅-e2e', keywords: '数据分析', channel: 'email', schedule: 'daily@09:00' },
    });
    check('创建带 schedule 的订阅 → code 0', sch.json.code === 0);
    check('返回 schedule', sch.json.data.schedule === 'daily@09:00');
    check('返回 schedule_text', sch.json.data.schedule_text === '每天 09:00');
    check('自动算出 next_run_at', typeof sch.json.data.next_run_at === 'string' && sch.json.data.next_run_at.length > 0);
    const schId = sch.json.data.id;

    const bad = await api('PATCH', `/api/v1/subscriptions/${schId}`, {
      token: tokenA, body: { schedule: '每天九点' },
    });
    check('非法表达式 → 1001', bad.json.code === 1001);

    const cleared = await api('PATCH', `/api/v1/subscriptions/${schId}`, {
      token: tokenA, body: { schedule: '' },
    });
    check('清空表达式 → 不自动执行',
      cleared.json.data.schedule === '' && cleared.json.data.next_run_at === '');

    // 配一个停用的定时订阅：不应被调度器捞起
    const off = await api('POST', '/api/v1/subscriptions', {
      token: tokenA,
      body: { name: '停用定时-e2e', keywords: '产品', channel: 'email', schedule: 'hourly' },
    });
    const offId = off.json.data.id;
    await api('PATCH', `/api/v1/subscriptions/${offId}`, { token: tokenA, body: { enabled: false } });

    // 把两条都强制置为「早已到期」，模拟时间推进
    const PAST = '2026-01-01T00:00:00.000Z';
    await api('PATCH', `/api/v1/subscriptions/${schId}`, { token: tokenA, body: { schedule: 'every:15m' } });
    db.run('UPDATE subscriptions SET next_run_at = ? WHERE id IN (?, ?)', PAST, schId, offId);

    // ---- 权限：非管理员不可访问
    const denied = await api('GET', '/api/v1/scheduler/status', { token: tokenA });
    check('非管理员读调度状态 → 1003', denied.json.code === 1003);
    const deniedTick = await api('POST', '/api/v1/scheduler/tick', { token: tokenA });
    check('非管理员触发 tick → 1003', deniedTick.json.code === 1003);

    // ---- 造一个管理员（与真实部署一致：角色落在 users.role，签发进 JWT）
    const adminEmail = `sched-admin-${Date.now()}@e2e.dev`;
    await api('POST', '/api/v1/auth/register', {
      body: { email: adminEmail, password: 'Sched12345', nickname: '调度管理员' },
    });
    const adminId = db.get('SELECT id FROM users WHERE email = ?', adminEmail).id;
    db.run("UPDATE users SET role = 'admin' WHERE id = ?", adminId);
    const login = await api('POST', '/api/v1/auth/login', {
      body: { email: adminEmail, password: 'Sched12345' },
    });
    adminToken = login.json.data.access_token;
    check('管理员登录成功', typeof adminToken === 'string' && adminToken.length > 20);

    // ---- 调度器状态
    const st = await api('GET', '/api/v1/scheduler/status', { token: adminToken });
    check('调度状态 → code 0', st.json.code === 0);
    check('调度器默认开启', st.json.data.enabled === true);
    check('tick 间隔读自环境变量', st.json.data.interval_ms === 3600000);
    check('时区偏移为东八区', st.json.data.tz_offset_minutes === 480);
    check('统计到定时订阅', st.json.data.scheduled >= 1);
    check('到期数 ≥ 1', st.json.data.due >= 1);
    check('有下次执行时刻', typeof st.json.data.next_run_at === 'string');

    // ---- 手动 tick：上游不可用 → 单条失败但不中断
    const tick = await api('POST', '/api/v1/scheduler/tick', { token: adminToken });
    check('tick → code 0', tick.json.code === 0);
    check('tick 扫到到期订阅', tick.json.data.scanned >= 1);
    check('tick 本轮未并发', tick.json.data.busy === false);

    const ids = tick.json.data.items.map((i) => i.subscription_id);
    check('停用订阅未被调度', !ids.includes(offId));
    check('启用订阅被调度', ids.includes(schId));

    const mine = tick.json.data.items.find((i) => i.subscription_id === schId);
    check('上游不可用 → 该条记失败', mine && mine.ok === false);
    check('失败原因被记录', mine && typeof mine.error === 'string' && mine.error.length > 0);
    check('失败计数正确', tick.json.data.failed >= 1);

    // ---- 关键：失败也要推进 next_run_at，避免热循环
    const after = db.get('SELECT next_run_at FROM subscriptions WHERE id = ?', schId).next_run_at;
    check('失败后 next_run_at 已推进', after !== PAST && after > new Date().toISOString().slice(0, 10));

    const tick2 = await api('POST', '/api/v1/scheduler/tick', { token: adminToken });
    check('紧接着再 tick → 不再重复扫描', tick2.json.data.scanned === 0);

    // ---- 重新启用：next_run_at 重算，不补跑历史
    const reOn = await api('PATCH', `/api/v1/subscriptions/${offId}`, {
      token: tokenA, body: { enabled: true },
    });
    check('重新启用后重算 next_run_at',
      reOn.json.data.next_run_at > new Date().toISOString().slice(0, 10));

    // ---- 清理
    const delSch = await api('DELETE', `/api/v1/subscriptions/${schId}`, { token: tokenA });
    const delOff = await api('DELETE', `/api/v1/subscriptions/${offId}`, { token: tokenA });
    check('清理测试订阅', delSch.json.code === 0 && delOff.json.code === 0);
  }

  // ------------------------------------------------------------ [16] 分布式调度
  group('[16] 分布式调度（多实例抢占）');
  {
    const { SchedulerService } = require('../dist/scheduler/scheduler.service');
    const { DatabaseService } = require('../dist/db/database.service');
    const { SubscriptionsService } = require('../dist/subscriptions/subscriptions.service');
    const { NotificationsService } = require('../dist/notifications/notifications.service');
    const db = app.get(DatabaseService);
    const subs = app.get(SubscriptionsService);
    const notify = app.get(NotificationsService);

    // 两个实例共用同一个数据库 —— 模拟多副本部署
    const instA = new SchedulerService(db, subs, notify);
    const instB = new SchedulerService(db, subs, notify);
    check('两实例标识互不相同', instA.instanceId !== instB.instanceId);
    check('实例标识含 pid', instA.instanceId.includes(String(process.pid)));
    check('默认锁 TTL 为 5 分钟', instA.lockTtlMs === 300000);

    process.env.SCHEDULER_INSTANCE_ID = 'e2e-explicit-instance';
    const instC = new SchedulerService(db, subs, notify);
    check('可用环境变量显式指定实例标识', instC.instanceId === 'e2e-explicit-instance');
    delete process.env.SCHEDULER_INSTANCE_ID;

    // 造一条到期订阅
    const made = await api('POST', '/api/v1/subscriptions', {
      token: tokenA,
      body: { name: '抢占测试-e2e', keywords: '实习', channel: 'email', schedule: 'every:15m' },
    });
    check('创建抢占测试订阅', made.json.code === 0);
    const cid = made.json.data.id;

    const PAST2 = '2020-01-01T00:00:00.000Z';
    const nowIso = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 300000).toISOString();
    db.run('UPDATE subscriptions SET next_run_at = ? WHERE id = ?', PAST2, cid);

    // ---- 原子抢占
    check('实例 A 抢到锁', subs.claimDue(cid, instA.instanceId, nowIso, staleBefore) === true);
    check('实例 B 抢不到（核心互斥）',
      subs.claimDue(cid, instB.instanceId, nowIso, staleBefore) === false);
    check('实例 A 不会重复持锁',
      subs.claimDue(cid, instA.instanceId, nowIso, staleBefore) === false);
    const lockRow = db.get('SELECT locked_by, locked_at FROM subscriptions WHERE id = ?', cid);
    check('锁归属写入正确', lockRow.locked_by === instA.instanceId && lockRow.locked_at !== '');
    check('有效锁计数 ≥ 1', subs.lockedCount(staleBefore) >= 1);

    // ---- B 的 tick 应当「让出」而不是重复执行
    const tickB = await instB.tick();
    check('B 扫到候选', tickB.scanned >= 1);
    check('B 让出被占用的订阅', tickB.skipped >= 1);
    check('B 未执行任何订阅', tickB.ran === 0 && tickB.items.length === 0);

    // ---- 锁过期（持有者崩溃）后可被接管
    const futureStale = new Date(Date.now() + 60000).toISOString();
    check('陈旧锁可被实例 B 接管',
      subs.claimDue(cid, instB.instanceId, nowIso, futureStale) === true);
    subs.releaseLock(cid);
    check('releaseLock 清空归属',
      db.get('SELECT locked_by FROM subscriptions WHERE id = ?', cid).locked_by === '');

    // ---- 停用 / 未到点的订阅不可被抢占
    db.run('UPDATE subscriptions SET enabled = 0 WHERE id = ?', cid);
    check('停用订阅不可抢占', subs.claimDue(cid, instA.instanceId, nowIso, staleBefore) === false);
    db.run('UPDATE subscriptions SET enabled = 1, next_run_at = ? WHERE id = ?',
      new Date(Date.now() + 3600000).toISOString(), cid);
    check('未到点订阅不可抢占', subs.claimDue(cid, instA.instanceId, nowIso, staleBefore) === false);

    // ---- A 完整跑一轮：抢占 → 执行 → 推进并释放
    db.run('UPDATE subscriptions SET next_run_at = ? WHERE id = ?', PAST2, cid);
    const tickA = await instA.tick();
    check('A 抢到并执行（上游不可用记失败）', tickA.ran + tickA.failed >= 1);
    check('A 本轮未让出', tickA.skipped === 0);
    const afterA = db.get('SELECT next_run_at, locked_at FROM subscriptions WHERE id = ?', cid);
    check('执行后锁已释放', afterA.locked_at === '');
    check('执行后 next_run_at 已推进', afterA.next_run_at > nowIso);

    const tickB2 = await instB.tick();
    check('B 紧接着扫描到 0（已被推进）', tickB2.scanned === 0);

    // ---- 实例退出时释放自己持有的锁
    db.run('UPDATE subscriptions SET next_run_at = ? WHERE id = ?', PAST2, cid);
    subs.claimDue(cid, instA.instanceId, nowIso, staleBefore);
    check('退出前确认持锁',
      db.get('SELECT locked_by FROM subscriptions WHERE id = ?', cid).locked_by === instA.instanceId);
    check('releaseInstanceLocks 释放该实例的锁',
      subs.releaseInstanceLocks(instA.instanceId) >= 1);
    check('释放后该订阅锁已清空',
      db.get('SELECT locked_by FROM subscriptions WHERE id = ?', cid).locked_by === '');

    // ---- 状态接口暴露分布式信息
    const st2 = await api('GET', '/api/v1/scheduler/status', { token: adminToken });
    check('状态含 instance_id',
      typeof st2.json.data.instance_id === 'string' && st2.json.data.instance_id.length > 0);
    check('状态含 lock_ttl_ms', st2.json.data.lock_ttl_ms === 300000);
    check('状态含 locked 计数', typeof st2.json.data.locked === 'number');
    // 累计计数器：多实例互斥的判定必须用它（last_result 只保留最近一轮，逐轮采样会漏）
    const CUM_KEYS = ['scanned_total', 'ran_total', 'failed_total', 'skipped_total', 'busy_ticks'];
    check('状态含累计计数器', CUM_KEYS.every((k) => typeof st2.json.data[k] === 'number'));
    check('累计计数器非负', CUM_KEYS.every((k) => st2.json.data[k] >= 0));

    // ---- 日志模式解析与只读故障识别（纯函数，直接单测）
    // 背景：Windows 上 WAL + 多进程同时打开会让一方连接永久只读（实测约 40%），
    //       故默认按平台选择日志模式，并保留 SQLITE_JOURNAL_MODE 覆盖开关。
    const dbmod = require('../dist/db/database.service');
    const savedJm = process.env.SQLITE_JOURNAL_MODE;
    delete process.env.SQLITE_JOURNAL_MODE;
    const defaultJm = dbmod.resolveJournalMode('/tmp/x.db');
    check('默认日志模式按平台选择（Windows=delete 规避 WAL 多进程缺陷）',
      process.platform === 'win32' ? defaultJm === 'delete' : defaultJm === 'wal');
    check('内存库默认 memory', dbmod.resolveJournalMode(':memory:') === 'memory');
    process.env.SQLITE_JOURNAL_MODE = 'wal';
    check('SQLITE_JOURNAL_MODE 可覆盖', dbmod.resolveJournalMode('/tmp/x.db') === 'wal');
    process.env.SQLITE_JOURNAL_MODE = ' WAL ';
    check('环境变量大小写与空白容错', dbmod.resolveJournalMode('/tmp/x.db') === 'wal');
    process.env.SQLITE_JOURNAL_MODE = 'bogus';
    let jmThrew = false;
    try { dbmod.resolveJournalMode('/tmp/x.db'); } catch { jmThrew = true; }
    check('非法 SQLITE_JOURNAL_MODE 快速失败', jmThrew);
    if (savedJm === undefined) delete process.env.SQLITE_JOURNAL_MODE;
    else process.env.SQLITE_JOURNAL_MODE = savedJm;

    check('isReadonlyError 精确识别只读故障',
      dbmod.isReadonlyError({ errcode: 8 }) === true
      && dbmod.isReadonlyError(new Error('attempt to write a readonly database')) === true
      && dbmod.isReadonlyError(new Error('database is locked')) === false
      && dbmod.isReadonlyError(null) === false);

    const delC = await api('DELETE', `/api/v1/subscriptions/${cid}`, { token: tokenA });
    check('清理抢占测试订阅', delC.json.code === 0);
  }

  // ------------------------------------------------------------ [17] 未知路由
  group('[17] 未知路由');
  {
    const r = await api('GET', '/api/v1/does-not-exist');
    check('未知路由 → 404', r.status === 404);
    check('错误码 2001', r.json.code === 2001);
    check('错误响应也带 trace_id', typeof r.json.trace_id === 'string');
  }

  // ------------------------------------------------------------ [18] 接口限流
  group('[18] 接口限流（契约 §9.6：X-RateLimit-* 响应头）');
  {
    // ---------- 纯逻辑：滑动窗口 ----------
    const rule = { name: 't', prefix: '/', windowMs: 1000, limit: 2 };
    const lim = new SlidingWindowLimiter({ now: () => 0 });

    const h1 = lim.hit('k', rule, 0);
    check('第 1 次命中放行（remaining=1）', h1.allowed === true && h1.remaining === 1);
    const h2 = lim.hit('k', rule, 100);
    check('第 2 次命中放行（remaining=0）', h2.allowed === true && h2.remaining === 0);
    const h3 = lim.hit('k', rule, 200);
    check('第 3 次超限时被拒绝', h3.allowed === false && h3.remaining === 0);
    check('被拒绝时给出 retryAfter', h3.retryAfter >= 1);
    const h4 = lim.hit('k', rule, 900);
    check('窗口内持续请求仍被拒绝', h4.allowed === false);
    // 窗口需完全滑过最后一次写入的命中（100 + 1000），故取 1101 而非 1001
    const h5 = lim.hit('k', rule, 1101);
    check('窗口滑过后恢复放行', h5.allowed === true && h5.remaining === 1);
    check('被拒绝的命中不写入窗口（不惩罚性延长）',
      h3.resetAt === h4.resetAt && h5.resetAt > h4.resetAt);

    // ---------- 纯逻辑：规则匹配与豁免 ----------
    const rules = [
      { name: 'default', prefix: '/', windowMs: 60000, limit: 300 },
      { name: 'auth', prefix: '/api/v1/auth/', windowMs: 60000, limit: 10 },
      { name: 'login', prefix: '/api/v1/auth/login', windowMs: 60000, limit: 5 },
    ];
    check('规则按最长前缀匹配', matchRateLimitRule('/api/v1/auth/login', rules).name === 'login');
    check('未命中更长前缀时回退到较短前缀',
      matchRateLimitRule('/api/v1/auth/refresh', rules).name === 'auth');
    check('无匹配规则返回 null', matchRateLimitRule('/zzz', [{ name: 'a', prefix: '/api', windowMs: 1, limit: 1 }]) === null);
    check('健康检查与元信息豁免限流',
      isRateLimitExempt('/health') === true && isRateLimitExempt('/api/v1/meta/services') === true);
    check('业务路径不豁免', isRateLimitExempt('/api/v1/jobs') === false);

    // ---------- HTTP：按 IP 限流 ----------
    const rl = app.get(RateLimitService);
    rl.configure({
      enabled: true,
      skip: [],
      rules: [{ name: 'login', prefix: '/api/v1/auth/login', windowMs: 60000, limit: 3 }],
    });

    const seq = [];
    for (let i = 0; i < 3; i += 1) {
      seq.push(await api('POST', '/api/v1/auth/login', { body: { email: 'x@y.com', password: 'bad' } }));
    }
    check('限额内不被限流（前 3 次非 429）', seq.every((r) => r.status !== 429));
    check('响应带 X-RateLimit-Limit', seq[0].headers.get('x-ratelimit-limit') === '3');
    check('X-RateLimit-Remaining 递减 2→1→0',
      seq.map((r) => r.headers.get('x-ratelimit-remaining')).join(',') === '2,1,0');
    check('响应带 X-RateLimit-Reset', !!seq[0].headers.get('x-ratelimit-reset'));

    const over = await api('POST', '/api/v1/auth/login', { body: { email: 'x@y.com', password: 'bad' } });
    check('超限返回 HTTP 429', over.status === 429);
    check('超限错误码 4003', over.json.code === 4003);
    check('超限响应带 Retry-After', Number(over.headers.get('retry-after')) >= 1);
    check('超限响应仍带 trace_id', typeof over.json.trace_id === 'string');

    const otherIp = await api('POST', '/api/v1/auth/login', {
      body: { email: 'x@y.com', password: 'bad' },
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    check('换 IP 后独立计数（不受影响）', otherIp.status !== 429);

    // ---------- HTTP：按用户限流 ----------
    const ru1 = await api('POST', '/api/v1/auth/register', {
      body: { email: `rl-${Date.now()}-a@t.com`, password: 'pw123456' },
    });
    const ru2 = await api('POST', '/api/v1/auth/register', {
      body: { email: `rl-${Date.now()}-b@t.com`, password: 'pw123456' },
    });
    const tk1 = ru1.json.data && ru1.json.data.access_token;
    const tk2 = ru2.json.data && ru2.json.data.access_token;
    check('限流测试用户注册成功', !!tk1 && !!tk2);

    rl.configure({
      enabled: true,
      skip: [],
      rules: [{ name: 'sched', prefix: '/api/v1/scheduler/', windowMs: 60000, limit: 2, byUser: true }],
    });

    const s1 = await api('GET', '/api/v1/scheduler/status', { token: tk1 });
    const s2 = await api('GET', '/api/v1/scheduler/status', { token: tk1 });
    const s3 = await api('GET', '/api/v1/scheduler/status', { token: tk1 });
    check('同一用户前 2 次放行', s1.status !== 429 && s2.status !== 429);
    check('同一用户第 3 次被限流', s3.status === 429 && s3.json.code === 4003);

    const sOther = await api('GET', '/api/v1/scheduler/status', { token: tk2 });
    check('不同用户独立计数（不受影响）', sOther.status !== 429);

    // 恢复：关闭限流，避免影响后续
    rl.configure({ enabled: false });
    check('关闭后不再限流', (await api('GET', '/api/v1/scheduler/status', { token: tk1 })).status !== 429);
  }

  // ------------------------------------------------------------ [19] 管理后台
  group('[19] 管理后台（契约 §6.3 · 代理 + 管理员限定）');
  {
    const { isAdminEmail } = require('../dist/auth/auth.service');

    check('isAdminEmail 命中白名单', isAdminEmail('admin-e2e@t.com') === true);
    check('isAdminEmail 大小写不敏感', isAdminEmail('ADMIN-E2E@T.COM') === true);
    check('isAdminEmail 支持多值（第二个条目）', isAdminEmail('ops@example.com') === true);
    check('isAdminEmail 未命中返回 false', isAdminEmail('someone@t.com') === false);
    // 注意：显式传 undefined 会触发默认参数读 env，故这里用 '' 与 null 验证「未配置」
    check('isAdminEmail 未配置白名单时恒为 false',
      isAdminEmail('admin-e2e@t.com', '') === false && isAdminEmail('admin-e2e@t.com', null) === false);
    check('isAdminEmail 对非字符串安全', isAdminEmail(null) === false && isAdminEmail(123) === false);
    check('isAdminEmail 支持逗号以外的分隔符',
      isAdminEmail('a@t.com', 'a@t.com、b@t.com') === true);

    // 注册管理员与普通用户各一名
    const ra = await api('POST', '/api/v1/auth/register', {
      body: { email: 'admin-e2e@t.com', password: 'pw123456' },
    });
    const adminToken = ra.json.data && ra.json.data.access_token;
    check('白名单邮箱注册成功', !!adminToken);
    check('白名单邮箱注册即为管理员', ra.json.code === 0);

    const rn = await api('POST', '/api/v1/auth/register', {
      body: { email: `normal-${Date.now()}@t.com`, password: 'pw123456' },
    });
    const normalToken = rn.json.data && rn.json.data.access_token;
    check('普通用户注册成功', !!normalToken);

    // ---------- 鉴权三层 ----------
    const noAuth = await api('GET', '/api/v1/admin/sources');
    check('未登录访问管理接口 → 401', noAuth.status === 401);
    check('未登录错误码 1002', noAuth.json.code === 1002);

    const asUser = await api('GET', '/api/v1/admin/sources', { token: normalToken });
    check('普通用户访问管理接口 → 403', asUser.status === 403);
    check('普通用户错误码 1003', asUser.json.code === 1003);
    check('普通用户不会拿到上游信息（data 为 null）', asUser.json.data === null);

    // 管理员：上游不可达时应是 503/4002（证明鉴权通过并已转发），而非 403
    const asAdmin = await api('GET', '/api/v1/admin/sources', { token: adminToken });
    check('管理员不被权限拦截（非 403 / 非 401）',
      asAdmin.status !== 403 && asAdmin.status !== 401);
    check('管理员请求已转发到采集服务（不可达时 4002）', asAdmin.json.code === 4002);

    // ---------- 各端点均受管理员保护 ----------
    const endpoints = [
      ['GET', '/api/v1/admin/tasks'],
      ['GET', '/api/v1/admin/adapters'],
      ['GET', '/api/v1/admin/degrade'],
    ];
    let allBlocked = true;
    for (const [m, p] of endpoints) {
      const r = await api(m, p, { token: normalToken });
      if (r.status !== 403) allBlocked = false;
    }
    check('所有管理端点对普通用户统一 403', allBlocked);

    let adminAllPass = true;
    for (const [m, p] of endpoints) {
      const r = await api(m, p, { token: adminToken });
      if (r.status === 403 || r.status === 401) adminAllPass = false;
    }
    check('所有管理端点对管理员放行（走代理）', adminAllPass);

    // 写操作同样受保护
    const wUser = await api('POST', '/api/v1/admin/degrade', {
      token: normalToken, body: { level: 3, reason: 'x' },
    });
    check('写操作（切换降级）对普通用户 403', wUser.status === 403 && wUser.json.code === 1003);
    const wAdmin = await api('POST', '/api/v1/admin/degrade', {
      token: adminToken, body: { level: 3, reason: 'x' },
    });
    check('写操作对管理员放行（走代理）', wAdmin.status !== 403 && wAdmin.json.code === 4002);

    // 过期下架同样受保护（代理到 crawler /admin/jobs/expire）
    const xUser = await api('POST', '/api/v1/admin/jobs/expire', { token: normalToken });
    check('过期下架对普通用户 403', xUser.status === 403 && xUser.json.code === 1003);
    const xAdmin = await api('POST', '/api/v1/admin/jobs/expire', { token: adminToken });
    check('过期下架对管理员放行（走代理）', xAdmin.status !== 403 && xAdmin.json.code === 4002);
  }

  // ------------------------------------------------------------ [20] 对象存储
  group('[20] 对象存储（契约 §3 · 本地驱动真实落盘）');
  {
    const st = require('../dist/documents/storage');
    const { resolveObjectPath, resolveStorageDriver } = st;

    // ---------- 纯函数：路径穿越防护 ----------
    const root = process.env.STORAGE_DIR;
    let threw = false;
    try { resolveObjectPath(root, '../etc/passwd'); } catch { threw = true; }
    check('拒绝向上一级穿越（../）', threw);

    threw = false;
    try { resolveObjectPath(root, 'a/../../b'); } catch { threw = true; }
    check('拒绝含 .. 段的 key', threw);

    threw = false;
    try { resolveObjectPath(root, ''); } catch { threw = true; }
    check('拒绝空 key', threw);

    threw = false;
    try { resolveObjectPath(root, 'a'.repeat(600)); } catch { threw = true; }
    check('拒绝超长 key', threw);

    const okPath = resolveObjectPath(root, 'u/1/cv/abc.pdf');
    check('合法 key 解析到根目录之内', okPath.startsWith(root));
    check('合法 key 支持中文与多级目录',
      resolveObjectPath(root, 'u/1/成绩单/abc.pdf').includes('成绩单'));

    // ---------- 驱动解析 ----------
    check('默认驱动为 local', resolveStorageDriver(undefined, { rootDir: root }).name === 'local');
    check('显式 local 驱动', resolveStorageDriver('local', { rootDir: root }).name === 'local');
    threw = false;
    try { resolveStorageDriver('s3', { rootDir: root }); } catch { threw = true; }
    check('s3 驱动未接入时快速失败（不做静默降级）', threw);
    threw = false;
    try { resolveStorageDriver('bogus', { rootDir: root }); } catch { threw = true; }
    check('未知驱动快速失败', threw);

    // ---------- HTTP 全链路：presign → 上传 → 登记 → 下载 → 删除 ----------
    const ru = await api('POST', '/api/v1/auth/register', {
      body: { email: `store-${Date.now()}@t.com`, password: 'pw123456' },
    });
    const tk = ru.json.data && ru.json.data.access_token;
    const uid = ru.json.data && ru.json.data.user_id;
    check('存储测试用户注册成功', !!tk);

    const ps = await api('POST', '/api/v1/documents/presign', {
      token: tk,
      body: { file_name: 'my-cv.pdf', doc_type: 'cv', file_size: 11 },
    });
    check('presign 成功', ps.json.code === 0);
    const fileKey = ps.json.data.file_key;
    check('file_key 带用户目录隔离前缀', String(fileKey).startsWith(`u/${uid}/`));
    check('presign 返回 PUT 方法与驱动名',
      ps.json.data.method === 'PUT' && ps.json.data.driver === 'local');

    const uploadUrl = ps.json.data.upload_url;
    const absUrl = /^https?:\/\//.test(uploadUrl) ? uploadUrl : `${BASE}${uploadUrl}`;
    const payload = 'hello-world';
    const up = await fetch(absUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tk}` },
      body: payload,
    });
    const upJson = await up.json().catch(() => ({}));
    check('上传返回 200', up.status === 200, up.status);
    check('上传成功并返回字节数', upJson.code === 0 && upJson.data && upJson.data.size === payload.length);

    // 跨用户写入必须被拒（file_key 归属校验）
    const ru2 = await api('POST', '/api/v1/auth/register', {
      body: { email: `store2-${Date.now()}@t.com`, password: 'pw123456' },
    });
    const tk2 = ru2.json.data && ru2.json.data.access_token;
    const cross = await fetch(absUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tk2}` },
      body: 'x',
    });
    check('跨用户写入他人 file_key → 403', cross.status === 403);

    const reg = await api('POST', '/api/v1/documents', {
      token: tk,
      body: {
        file_key: fileKey, file_name: 'my-cv.pdf', doc_type: 'cv',
        mime: 'application/pdf', file_size: payload.length,
      },
    });
    check('登记材料成功', reg.json.code === 0);
    const docId = reg.json.data && reg.json.data.id;

    const dl = await fetch(`${BASE}/api/v1/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${tk}` },
    });
    const body = await dl.text();
    check('下载返回 200', dl.status === 200);
    check('下载内容与上传完全一致', body === payload);

    const dlOther = await fetch(`${BASE}/api/v1/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${tk2}` },
    });
    check('跨用户下载 → 404', dlOther.status === 404);

    const del = await api('DELETE', `/api/v1/documents/${docId}`, { token: tk });
    check('删除材料成功', del.json.code === 0);
    check('删除时同步清理存储对象', del.json.data && del.json.data.storage_cleaned === true);

    const dlGone = await fetch(`${BASE}/api/v1/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${tk}` },
    });
    check('删除后无法再下载', dlGone.status === 404);
  }

  // ------------------------------------------------------------ [21] 填写会话与日志
  group('[21] 填写会话与日志（契约 §4.2 / §4.3 · 网关本地实现）');
  {
    const ra = await api('POST', '/api/v1/auth/register', {
      body: { email: `exta-${Date.now()}@t.com`, password: 'pw123456' },
    });
    const tkA = ra.json.data && ra.json.data.access_token;
    const rb = await api('POST', '/api/v1/auth/register', {
      body: { email: `extb-${Date.now()}@t.com`, password: 'pw123456' },
    });
    const tkB = rb.json.data && rb.json.data.access_token;
    check('会话测试用户注册成功', !!tkA && !!tkB);

    const noAuth = await api('POST', '/ext/v1/sessions', { body: {} });
    check('未登录建会话 → 401/1002', noAuth.status === 401 && noAuth.json.code === 1002);

    const cs = await api('POST', '/ext/v1/sessions', {
      token: tkA, body: { system_code: 'applyweb', step_index: 0 },
    });
    check('建会话成功', cs.json.code === 0 && cs.json.data.status === 'running');
    const sid = cs.json.data && cs.json.data.id;

    const viaExt = await fetch(`${BASE}/ext/v1/sessions/${sid}`, {
      headers: { 'X-Ext-Token': tkA },
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
    check('插件凭证 X-Ext-Token 可查会话', viaExt.status === 200 && viaExt.json.data.id === sid);

    const pt = await api('PATCH', `/ext/v1/sessions/${sid}`, {
      token: tkA, body: { step_index: 2, stats: { filled: 3 } },
    });
    check('更新步骤与统计', pt.json.data.step_index === 2 && pt.json.data.stats.filled === 3);
    const badStatus = await api('PATCH', `/ext/v1/sessions/${sid}`, {
      token: tkA, body: { status: 'nope' },
    });
    check('非法状态 → 1001', badStatus.json.code === 1001);

    const rep = await api('POST', '/ext/v1/fill-logs', {
      token: tkA,
      body: {
        session_id: sid,
        logs: [
          { field_key: 'basic_info.last_name', selector: '#ln', confidence: 0.98, result: 'filled' },
          { field_key: null, selector: '#q1', result: 'skipped' },
        ],
      },
    });
    check('上报日志成功', rep.json.code === 0 && rep.json.data.stored === 2);

    const got = await api('GET', `/ext/v1/sessions/${sid}`, { token: tkA });
    check('会话详情含上报日志', got.json.data.logs.length === 2);

    const orphan = await api('POST', '/ext/v1/fill-logs', {
      token: tkA, body: { logs: [{ selector: '#a', result: 'filled' }] },
    });
    check('无会话上报自动建会话', orphan.json.code === 0 && orphan.json.data.session_id !== sid);

    const empty = await api('POST', '/ext/v1/fill-logs', { token: tkA, body: { logs: [] } });
    check('空日志 → 1001', empty.json.code === 1001);
    const badResult = await api('POST', '/ext/v1/fill-logs', {
      token: tkA, body: { session_id: sid, logs: [{ selector: '#a', result: 'nope' }] },
    });
    check('非法 result → 1001', badResult.json.code === 1001);

    const cross = await api('GET', `/ext/v1/sessions/${sid}`, { token: tkB });
    check('跨用户查会话 → 2001', cross.json.code === 2001);
    const crossLog = await api('POST', '/ext/v1/fill-logs', {
      token: tkB, body: { session_id: sid, logs: [{ selector: '#a', result: 'filled' }] },
    });
    check('跨用户上报 → 2001', crossLog.json.code === 2001);

    const blk = await api('POST', `/ext/v1/sessions/${sid}/block`, {
      token: tkA, body: { reason: 'captcha' },
    });
    check('上报阻断标记 blocked', blk.json.data.status === 'blocked' && blk.json.data.stats.block_reason === 'captcha');
    const resume = await api('PATCH', `/ext/v1/sessions/${sid}`, {
      token: tkA, body: { status: 'running' },
    });
    check('blocked 可回到 running', resume.json.data.status === 'running');
  }

  await app.close();

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
  console.error('测试异常：', e);
  process.exit(1);
});
