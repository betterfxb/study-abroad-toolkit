/**
 * 端到端联调（需要 intelligence-service 在 localhost:8090 运行）。
 *
 * 验证链路：
 *   伪造一个 ApplyWeb 风格表单页 → 字段提取 → 真实调用 /ext/v1/match-fields
 *   → 生成填充计划 → 写回 DOM → 校验 → 打印逐字段结果
 *
 * 运行：
 *   cd apps/intelligence && uvicorn app.main:app --port 8090
 *   cd apps/extension && node tests/integration_e2e.js
 */

import { matchFields, health } from '../src/core/api-client.js';
import { scanPage } from '../src/core/field-extractor.js';
import { planInstructions, summarize } from '../src/core/planner.js';
import { applyPlan } from '../src/core/filler.js';
import { findMissingRequired } from '../src/core/validator.js';
import { FakeElement, makePage } from './fake-dom.js';

const BASE = process.env.INTELLIGENCE_BASE || 'http://localhost:8090';

/** 构造一个 ApplyWeb 风格的表单页（含 label / select / textarea / 必填） */
function buildApplyWebPage() {
  const { html, body } = makePage();

  const add = (tag, attrs, opts = {}) => {
    const el = new FakeElement(tag, attrs, opts);
    body.appendChild(el);
    return el;
  };

  // Personal Information
  add('input', { id: 'lastName', name: 'lastName', type: 'text' },
    { labels: [new FakeElement('label', {}, { text: 'Family Name' })] });
  add('input', { id: 'firstName', name: 'firstName', type: 'text' },
    { labels: [new FakeElement('label', {}, { text: 'Given Name' })] });
  add('input', { id: 'email', name: 'email', type: 'email' },
    { labels: [new FakeElement('label', {}, { text: 'Email Address' })] });
  add('input', { id: 'phone', name: 'phone', type: 'tel' },
    { labels: [new FakeElement('label', {}, { text: 'Phone Number' })] });
  add('input', { id: 'dob', name: 'dob', type: 'date', placeholder: 'MM/DD/YYYY' },
    { labels: [new FakeElement('label', {}, { text: 'Date of Birth' })] });
  add('select', { id: 'gender', name: 'gender' },
    { labels: [new FakeElement('label', {}, { text: 'Gender' })],
      options: [{ value: '', text: '-- 请选择 --' }, { value: 'M', text: 'Male' }, { value: 'F', text: 'Female' }] });
  add('select', { id: 'country', name: 'country' },
    { labels: [new FakeElement('label', {}, { text: 'Country of Residence' })],
      options: [{ value: '', text: '-- 请选择 --' }, { value: 'CN', text: 'China' }, { value: 'US', text: 'United States' }] });
  add('select', { id: 'citizenship', name: 'citizenship' },
    { labels: [new FakeElement('label', {}, { text: 'Country of Citizenship' })],
      options: [{ value: '', text: '-- 请选择 --' }, { value: 'CN', text: 'China' }, { value: 'US', text: 'United States' }] });

  // Address
  add('input', { id: 'city', name: 'city', type: 'text' },
    { labels: [new FakeElement('label', {}, { text: 'City' })] });
  add('select', { id: 'state', name: 'state' },
    { labels: [new FakeElement('label', {}, { text: 'State / Province' })],
      options: [{ value: '', text: '-- 请选择 --' }, { value: 'Beijing', text: 'Beijing' }, { value: 'CA', text: 'California' }] });

  // Education
  add('input', { id: 'school', name: 'school', type: 'text' },
    { labels: [new FakeElement('label', {}, { text: 'Institution Name' })] });
  add('input', { id: 'major', name: 'major', type: 'text' },
    { labels: [new FakeElement('label', {}, { text: 'Major / Field of Study' })] });
  add('input', { id: 'gpa', name: 'gpa', type: 'number' },
    { labels: [new FakeElement('label', {}, { text: 'GPA' })] });

  // 自定义题干（不应被填）
  add('textarea', { id: 'purpose', name: 'purpose' },
    { labels: [new FakeElement('label', {}, { text: 'State your purpose for graduate study' })] });

  // 必填但档案缺失
  add('input', { id: 'postal', name: 'postal', type: 'text', required: 'required' },
    { labels: [new FakeElement('label', {}, { text: 'Postal Code' })] });

  return { html, body };
}

/** 评测档案（规范化值，结构与契约 §2 profile 一致） */
const PROFILE = {
  basic_info: {
    last_name: 'Chen', first_name: 'Feng',
    email: 'Feng.Chen@Example.com', phone: '+86 138-0000-0000',
    gender: 'M', birth_date: '2003-01-15', citizenship: 'CN',
  },
  addresses: [{ type: 'permanent', country: 'CN', province: '北京', city: 'Beijing' }],
  education: [{ school: 'Peking University', major: 'Computer Science', gpa: { value: 88, scale: '100' } }],
};

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`); }
}

async function main() {
  console.log('='.repeat(64));
  console.log('插件 ↔ intelligence-service 端到端联调');
  console.log('='.repeat(64));

  // 0) 健康检查
  const h = await health({ baseUrl: BASE });
  if (!h.ok) {
    console.log(`\n服务不可用（${BASE}）：${h.error}`);
    console.log('请先启动： cd apps/intelligence && uvicorn app.main:app --port 8090');
    process.exit(2);
  }
  console.log(`\n服务正常 · 词典 ${h.data.dictionary_slots} 槽位 · 阈值 ${h.data.auto_fill_threshold}/${h.data.review_threshold}`);

  // 1) 字段提取
  const { html } = buildApplyWebPage();
  const fields = scanPage(html);
  console.log(`\n[1] 字段提取：${fields.length} 个可填字段`);
  check('提取到 15 个字段', fields.length === 15);

  // 2) 真实匹配
  const res = await matchFields({
    page_url: 'https://apply.applyweb.com/apply/step3',
    system_code: 'applyweb',
    profile: PROFILE,
    fields,
  }, { baseUrl: BASE });
  check('匹配请求成功', res.ok);
  if (!res.ok) { console.log(`  错误：${res.error}`); process.exit(1); }

  const data = res.data;
  console.log(`[2] 匹配结果：识别 ${data.stats.matched}/${data.stats.total}，`
    + `自动填 ${data.stats.fill}，待复核 ${data.stats.review}，档案缺失 ${data.stats.no_value}`);
  console.log(`    识别率 ${(data.summary['识别率'] * 100).toFixed(1)}% · 填充率 ${(data.summary['填充率'] * 100).toFixed(1)}%`);

  const byKey = Object.fromEntries(data.instructions.map((i) => [i.selector, i]));
  check('姓氏识别为 basic_info.last_name', byKey['#lastName']?.field_key === 'basic_info.last_name');
  check('邮箱识别为 basic_info.email', byKey['#email']?.field_key === 'basic_info.email');
  check('GPA 识别为 education 槽位', String(byKey['#gpa']?.field_key || '').startsWith('education'));
  check('题干字段未被误填', !byKey['#purpose'] || byKey['#purpose'].value === '');

  // 3) 生成填充计划
  const plan = planInstructions(data.instructions);
  const stats = summarize(plan, fields.length);
  console.log(`\n[3] 填充计划：自动 ${stats.fill} · 待复核 ${stats.review} · 跳过 ${stats.skip}`);

  // 4) 写回 DOM
  const applied = applyPlan(html, plan);
  console.log(`[4] 执行结果：写入 ${applied.filled} · 待复核 ${applied.review} · 失败 ${applied.failed}`);
  check('至少写入 6 个字段', applied.filled >= 6);
  check('无执行失败', applied.failed === 0);

  // 5) 抽查关键字段的实际值
  const q = (id) => html.querySelector(`#${id}`)?.value;
  console.log('\n[5] 逐字段值（抽查）');
  console.log(`    #lastName = ${q('lastName')}    #email = ${q('email')}    #phone = ${q('phone')}`);
  console.log(`    #dob = ${q('dob')}    #gender = ${q('gender')}    #country = ${q('country')}`);
  console.log(`    #citizenship = ${q('citizenship')}    #city = ${q('city')}    #state = ${q('state')}    #gpa = ${q('gpa')}`);

  check('邮箱已转小写', q('email') === 'feng.chen@example.com');
  check('电话去分隔符', q('phone') === '+8613800000000');
  check('日期按 placeholder 格式化', q('dob') === '01/15/2003');
  check('性别下拉选中 Male', q('gender') === 'M');
  check('居住国 → address.country 选中 China', q('country') === 'CN');
  check('国籍 → basic_info.citizenship 选中 China', q('citizenship') === 'CN');
  check('GPA 百分制换算为 4.0 制', q('gpa') === '3.7');
  check('题干 textarea 保持为空', !q('purpose'));

  // 6) 必填缺口
  const missing = findMissingRequired(html.querySelectorAll('input, select, textarea'));
  console.log(`\n[6] 必填缺口：${missing.length} 项 ${missing.map((m) => m.selector).join(', ') || '（无）'}`);
  check('识别出 Postal Code 缺口', missing.some((m) => m.selector === '#postal'));

  // 7) 多步向导：用户点「下一步」→ 自动识别新步骤并重新填充
  console.log('\n[7] 多步向导（换步识别 + 新步骤自动填充）');
  {
    const { StepWatcher } = await import('../src/core/step-watcher.js');

    const build = (rows) => {
      const page = makePage();
      for (const [tag, attrs, label, opts] of rows) {
        page.body.appendChild(new FakeElement(tag, attrs, { ...(opts || {}), labels: [new FakeElement('label', {}, { text: label })] }));
      }
      return page;
    };

    // 第 1 步：个人信息页
    const s1 = build([
      ['input', { id: 's1_last', name: 'lastName', type: 'text' }, 'Family Name'],
      ['input', { id: 's1_email', name: 'email', type: 'email' }, 'Email Address'],
    ]);
    // 第 2 步：教育背景页（字段集合完全不同）
    const s2 = build([
      ['input', { id: 's2_school', name: 'school', type: 'text' }, 'Institution Name'],
      ['input', { id: 's2_major', name: 'major', type: 'text' }, 'Major / Field of Study'],
      ['input', { id: 's2_gpa', name: 'gpa', type: 'number' }, 'GPA'],
    ]);

    const f1 = scanPage(s1.html);
    const f2 = scanPage(s2.html);
    console.log(`    第 1 步字段 ${f1.length} 个 · 第 2 步字段 ${f2.length} 个`);
    check('第 1 步提取到 2 个字段', f1.length === 2);
    check('第 2 步提取到 3 个字段', f2.length === 3);

    let clock = 0;
    const watcher = new StepWatcher({ stableMs: 800, now: () => clock });

    // 首屏（第 1 步）：需稳定窗口后才确认；URL 带易变参数 _t 不应干扰
    watcher.observe({ url: 'https://apply.applyweb.com/apply?step=1&_t=1', fields: f1, text: 'Step 1 of 3' });
    clock = 900;
    const e1 = watcher.observe({ url: 'https://apply.applyweb.com/apply?step=1&_t=2', fields: f1, text: 'Step 1 of 3' });
    check('第 1 步被确认', Boolean(e1) && e1.index === 1);
    check('第 1 步识别步骤文案', e1.label === '第 1 / 3 步');
    check('易变参数不干扰换步判定', e1.fingerprint === watcher.committed);

    // 用户点「下一步」→ URL 与字段同时变化，需重新稳定
    clock = 1000;
    watcher.observe({ url: 'https://apply.applyweb.com/apply?step=2', fields: f2, text: 'Step 2 of 3' });
    clock = 1900;
    const e2 = watcher.observe({ url: 'https://apply.applyweb.com/apply?step=2', fields: f2, text: 'Step 2 of 3' });
    check('第 2 步被自动识别', Boolean(e2) && e2.index === 2);
    check('第 2 步 label 带总数', e2.label === '第 2 / 3 步');
    check('换步后指纹发生变化', e1.fingerprint !== e2.fingerprint);
    check('会话累计 2 步', watcher.count === 2);

    // 第 2 步字段走真实匹配 → 填充（等价于插件自动重扫后 doFill）
    const res2 = await matchFields({
      page_url: 'https://apply.applyweb.com/apply?step=2',
      system_code: 'applyweb',
      profile: PROFILE,
      fields: f2,
    }, { baseUrl: BASE });
    check('第 2 步匹配请求成功', res2.ok);
    if (res2.ok) {
      const applied2 = applyPlan(s2.html, planInstructions(res2.data.instructions));
      console.log(`    第 2 步：写入 ${applied2.filled} · 待复核 ${applied2.review} · 失败 ${applied2.failed}`);
      check('第 2 步至少写入 2 个字段', applied2.filled >= 2);
      check('第 2 步无执行失败', applied2.failed === 0);
      check('第 2 步院校已填充', s2.html.querySelector('#s2_school')?.value === 'Peking University');
      check('第 2 步 GPA 已换算为 4.0 制', s2.html.querySelector('#s2_gpa')?.value === '3.7');
      console.log(`    抽查：school=${s2.html.querySelector('#s2_school')?.value} · `
        + `major=${s2.html.querySelector('#s2_major')?.value} · gpa=${s2.html.querySelector('#s2_gpa')?.value}`);
    }
  }

  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(64));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('联调异常：', e); process.exit(1); });
