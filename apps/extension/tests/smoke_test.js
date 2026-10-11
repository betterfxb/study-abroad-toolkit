/**
 * 冒烟测试（零第三方依赖）。
 *
 * 插件核心逻辑不访问全局 document，因此用一个最小 DOM 桩即可在 Node 中验证：
 *   字段提取 / 标签定位 / 选择器生成 / 填充计划 / 填充执行 / 校验 / 阻断检测 / 状态机 / API 客户端
 *
 * 运行： node tests/smoke_test.js
 */

import { readFileSync } from 'node:fs';
import { HIGHLIGHT, LOCAL_ONLY_FIELDS, MSG, STATE, STEP_STABLE_MS, THRESHOLD } from '../src/shared/constants.js';
import { detectSystemCode } from '../src/shared/config.js';
import { buildSelector, collectOptions, findLabel, isFillable } from '../src/core/dom-utils.js';
import { buildFieldSpec, collectCandidates, extractFields, scanPage } from '../src/core/field-extractor.js';
import { classify, planInstructions, summarize } from '../src/core/planner.js';
import { applyInstruction, applyPlan, matchOption } from '../src/core/filler.js';
import { detectBlockers, findAdvanceButtons, findMissingRequired, validateElement } from '../src/core/validator.js';
import { StepController } from '../src/core/step-controller.js';
import {
  StepWatcher, detectStepMeta, fieldsSignature, normalizeUrl,
  renderStepLabel, simpleHash, stepFingerprint,
} from '../src/core/step-watcher.js';
import { matchFields } from '../src/core/api-client.js';
import {
  RESUME_MAX_ENTRIES, RESUME_TTL_MS, createRecord, findResumable, formatResumeHint,
  loadStore, pruneStore, saveStore, siteKey, touchRecord,
} from '../src/core/session-store.js';
import { FakeElement, makePage } from './fake-dom.js';

// ============================================================ 测试框架
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  [FAIL] ${name}`); }
}

function group(title) { console.log(`\n${title}`); }

// ============================================================ [1] dom-utils
group('[1] DOM 工具（选择器 / 标签 / 选项 / 可填判定）');
{
  const el = new FakeElement('input', { id: 'lastName' });
  check('id 优先生成 #id 选择器', buildSelector(el) === '#lastName');

  const el2 = new FakeElement('input', { name: 'email' });
  check('无 id 时用 name 选择器', buildSelector(el2) === 'input[name="email"]');

  const el3 = new FakeElement('input', { type: 'checkbox' });
  check('无 id/name 时用 type 选择器', buildSelector(el3) === 'input[type="checkbox"]');

  const el4 = new FakeElement('input');
  check('全无时用 nth-of-type', buildSelector(el4, 2) === 'input:nth-of-type(3)');

  const label = new FakeElement('label', {}, { text: 'Family Name' });
  const withLabel = new FakeElement('input', { id: 'x' }, { labels: [label] });
  check('通过 labels 取标签', findLabel(withLabel) === 'Family Name');

  const withAria = new FakeElement('input', { 'aria-label': 'Date of Birth' });
  check('通过 aria-label 取标签', findLabel(withAria) === 'Date of Birth');

  const parentLabel = new FakeElement('label', {}, { text: 'GPA' });
  const child = new FakeElement('input');
  parentLabel.appendChild(child);
  check('通过父级 label 取标签', findLabel(child) === 'GPA');

  const prev = new FakeElement('span', {}, { text: 'State' });
  const wrap = new FakeElement('div');
  wrap.appendChild(prev);
  const after = new FakeElement('input');
  wrap.appendChild(after);
  check('通过前置兄弟取标签', findLabel(after) === 'State');

  const sel = new FakeElement('select', {}, {
    options: [
      { value: '', text: '-- 请选择 --' },
      { value: 'CA', text: 'California' },
      { value: 'NY', text: 'New York' },
    ],
  });
  const opts = collectOptions(sel);
  check('select 选项过滤占位项', opts.length === 2 && opts[0] === 'California');

  check('text 可填', isFillable(new FakeElement('input', { type: 'text' })));
  check('hidden 不可填', !isFillable(new FakeElement('input', { type: 'hidden' })));
  check('submit 不可填', !isFillable(new FakeElement('input', { type: 'submit' })));
  check('disabled 不可填', !isFillable(new FakeElement('input', {}, { disabled: true })));
  check('readonly 不可填', !isFillable(new FakeElement('input', {}, { readOnly: true })));
  check('不可见不可填', !isFillable(new FakeElement('input', {}, { visible: false })));
}

// ============================================================ [2] 字段提取
group('[2] 字段提取器');
{
  const spec = buildFieldSpec(new FakeElement('select', { id: 'state', name: 'state' }, {
    options: [{ value: 'CA', text: 'California' }],
  }), 0);
  check('select 类型归一化', spec.type === 'select');
  check('select 采集选项', spec.options.length === 1);
  check('selector 正确', spec.selector === '#state');

  const ta = buildFieldSpec(new FakeElement('textarea', { id: 'sop' }), 0);
  check('textarea 类型归一化', ta.type === 'textarea');

  const num = buildFieldSpec(new FakeElement('input', { id: 'gpa', type: 'number', maxlength: '5' }), 0);
  check('maxlength 转数字', num.maxlength === 5);
  const noMl = buildFieldSpec(new FakeElement('input', { id: 'plain', type: 'text' }), 0);
  check('缺省 maxlength 归一为 null（DOM -1=无限制）', noMl.maxlength === null);

  const req = buildFieldSpec(new FakeElement('input', { id: 'r', required: 'required' }), 0);
  check('required 识别', req.required === true);

  const dup = new FakeElement('input', { id: 'same' });
  const fields = extractFields([dup, new FakeElement('input', { id: 'same' }), new FakeElement('input', { id: 'other' })]);
  check('同选择器去重', fields.length === 2);

  const { html, body } = makePage();
  body.appendChild(new FakeElement('input', { id: 'a', type: 'text' }));
  body.appendChild(new FakeElement('input', { id: 'h', type: 'hidden' }));
  body.appendChild(new FakeElement('select', { id: 's' }));
  const cands = collectCandidates(html);
  check('候选采集过滤 hidden', cands.length === 2);

  const scanned = scanPage(html);
  check('scanPage 端到端', scanned.length === 2 && scanned.some((f) => f.selector === '#s'));
}

// ============================================================ [3] 填充计划
group('[3] 填充计划器');
{
  check('≥0.90 自动填', classify(0.95) === 'fill');
  check('0.60~0.90 待复核', classify(0.75) === 'review');
  check('<0.60 跳过', classify(0.4) === 'skip');
  check('非法置信度跳过', classify(undefined) === 'skip');
  check('阈值常量与契约一致', THRESHOLD.AUTO_FILL === 0.90 && THRESHOLD.REVIEW === 0.60);

  const plan = planInstructions([
    { selector: '#a', field_key: 'basic_info.last_name', value: 'Chen', confidence: 0.98 },
    { selector: '#b', field_key: 'basic_info.email', value: 'a@b.com', confidence: 0.75 },
    { selector: '#c', field_key: 'basic_info.city', value: '', confidence: 0.99 },
    { selector: '#d', field_key: 'basic_info.phone', value: '138', confidence: 0.3 },
  ]);
  check('自动填 1 项', plan.fill.length === 1);
  check('待复核 1 项', plan.review.length === 1);
  check('空值跳过', plan.skip.some((i) => i.selector === '#c' && i.reason === '空值'));
  check('低置信跳过', plan.skip.some((i) => i.selector === '#d'));

  const localKey = LOCAL_ONLY_FIELDS[0];
  const plan2 = planInstructions([{ selector: '#p', field_key: localKey, value: 'X', confidence: 0.99 }]);
  check('敏感字段降级为待复核', plan2.review.length === 1 && plan2.fill.length === 0);

  const overWords = { words: 1200, cjk_chars: 0, chars: 6000, limit_words: 1000, limit_chars: null, ok: false, exceeds_by_words: 200, exceeds_by_chars: 0 };
  const plan3 = planInstructions([{ selector: '#sop', field_key: 'essays.statement_of_purpose', value: 'word ', confidence: 0.98, word_check: overWords }]);
  check('文书超限降级为待复核', plan3.review.length === 1 && plan3.fill.length === 0);
  check('文书超限原因含字数提示', plan3.review[0].reason.includes('超字数') && plan3.review[0].word_check.ok === false);
  const okWords = { ...overWords, words: 10, chars: 50, ok: true, exceeds_by_words: 0 };
  const plan4 = planInstructions([{ selector: '#sop', field_key: 'essays.statement_of_purpose', value: 'word ', confidence: 0.98, word_check: okWords }]);
  check('文书限内不降级', plan4.fill.length === 1 && plan4.review.length === 0);

  const stats = summarize(plan, 4);
  check('统计 fill 计数', stats.fill === 1);
  check('统计填充率', stats.fillRate === 0.5);
  check('统计自动填充率', stats.autoFillRate === 0.25);
}

// ============================================================ [4] 填充执行
group('[4] 填充执行器');
{
  const sel = new FakeElement('select', {}, {
    options: [
      { value: 'CA', text: 'California' },
      { value: 'NY', text: 'New York' },
    ],
  });
  check('选项精确匹配', matchOption(sel, 'California')?.value === 'CA');
  check('选项按 value 匹配', matchOption(sel, 'NY')?.value === 'NY');
  check('选项近似匹配', matchOption(sel, 'calif')?.exact === false);
  check('无匹配返回 null', matchOption(sel, 'Texas') === null);

  const txt = new FakeElement('input', { id: 'ln', type: 'text' });
  let fired = [];
  txt.addEventListener('input', () => fired.push('input'));
  txt.addEventListener('change', () => fired.push('change'));
  const r1 = applyInstruction(txt, { selector: '#ln', value: 'Chen', confidence: 0.98 });
  check('text 填充成功', r1.ok && txt.value === 'Chen');
  check('触发 input+change 事件', fired.join(',') === 'input,change');
  check('自动填加标记类', txt.classList.contains(HIGHLIGHT.FILLED));

  const r2 = applyInstruction(sel, { selector: '#s', value: 'California', confidence: 0.95 });
  check('select 精确填充', r2.result === 'filled' && sel.value === 'CA');

  const r3 = applyInstruction(sel, { selector: '#s', value: 'calif', confidence: 0.95 });
  check('select 近似填充降级为 review', r3.result === 'review');
  check('review 加高亮类', sel.classList.contains(HIGHLIGHT.REVIEW));

  const cb = new FakeElement('input', { id: 'agree', type: 'checkbox' }, { value: 'true' });
  const r4 = applyInstruction(cb, { selector: '#agree', value: 'true', confidence: 0.9 });
  check('checkbox 勾选', r4.ok && cb.checked === true);

  const r5 = applyInstruction(txt, { selector: '#ln', value: '', confidence: 0.9 });
  check('空值指令跳过', r5.result === 'skipped');

  const r6 = applyInstruction(null, { selector: '#none', value: 'x' });
  check('元素不存在失败', r6.result === 'failed');

  const { html, body } = makePage();
  const a = new FakeElement('input', { id: 'f1', type: 'text' });
  const b = new FakeElement('input', { id: 'f2', type: 'text' });
  body.appendChild(a); body.appendChild(b);
  const applied = applyPlan(html, {
    fill: [{ selector: '#f1', field_key: 'k1', value: 'V1', confidence: 0.99 }],
    review: [{ selector: '#f2', field_key: 'k2', value: 'V2', confidence: 0.7 }],
  });
  check('applyPlan 统计 filled', applied.filled === 1);
  check('applyPlan 统计 review', applied.review === 1);
  check('applyPlan 生成日志', applied.logs.length === 2);
  check('applyPlan 值写入', a.value === 'V1' && b.value === 'V2');

  const missing = applyPlan(html, { fill: [{ selector: '#nope', value: 'x' }], review: [] });
  check('缺失元素记为 skipped', missing.logs[0].result === 'skipped');
}

// ============================================================ [5] 校验与阻断
group('[5] 校验器 / 阻断检测');
{
  const t = new FakeElement('input', { type: 'text' }, { value: 'Chen' });
  check('文本校验通过', validateElement(t, { value: 'Chen' }).ok);

  const empty = new FakeElement('input', { type: 'text' });
  check('空值校验失败', !validateElement(empty, { value: 'X' }).ok);

  const sel = new FakeElement('select', {}, { value: 'CA', options: [{ value: 'CA', text: 'CA' }] });
  check('下拉校验通过', validateElement(sel, { value: 'CA' }).ok);

  const cb = new FakeElement('input', { type: 'checkbox' }, { checked: false });
  check('未勾选校验失败', !validateElement(cb, { value: 'true' }).ok);

  const req = new FakeElement('input', { id: 'r1', required: 'required', 'aria-label': 'Email' });
  const opt = new FakeElement('input', { id: 'o1' });
  const miss = findMissingRequired([req, opt]);
  check('必填缺口识别', miss.length === 1 && miss[0].selector === '#r1');

  const { html, body } = makePage();
  check('干净页面无阻断', detectBlockers(html).blocked === false);
  body.appendChild(new FakeElement('div', { class: 'g-recaptcha' }));
  check('验证码容器判为阻断', detectBlockers(html).blocked === true);

  const { html: h2, body: b2 } = makePage();
  b2.textContent = '请完成安全验证后继续';
  check('验证码文案判为阻断', detectBlockers(h2).blocked === true);

  const { html: h3, body: b3 } = makePage();
  const btn = new FakeElement('button', { id: 'next' }, { text: 'Save and Continue' });
  b3.appendChild(btn);
  const btns = findAdvanceButtons(h3);
  check('识别下一步按钮', btns.length === 1);
  check('按钮选择器正确', btns[0].selector === '#next');
}

// ============================================================ [6] 状态机
group('[6] 步骤控制器');
{
  const sc = new StepController();
  check('初始 IDLE', sc.state === STATE.IDLE);
  sc.transition(STATE.SCANNING);
  sc.transition(STATE.FILLING);
  sc.transition(STATE.SAVING);
  sc.transition(STATE.DONE);
  check('合法链路到达 DONE', sc.state === STATE.DONE && sc.isTerminal);
  check('历史记录完整', sc.history.length === 5);

  const sc2 = new StepController();
  let threw = false;
  try { sc2.transition(STATE.FILLING); } catch { threw = true; }
  check('非法转移抛错', threw);
  check('tryTransition 非法返回 false', sc2.tryTransition(STATE.DONE) === false);

  const sc3 = new StepController();
  sc3.transition(STATE.SCANNING);
  sc3.transition(STATE.BLOCKED);
  check('可进入 BLOCKED', sc3.state === STATE.BLOCKED);
  check('BLOCKED 可回到 IDLE', sc3.tryTransition(STATE.IDLE) === true);

  let changed = null;
  const sc4 = new StepController({ onChange: (n) => { changed = n; } });
  sc4.transition(STATE.SCANNING);
  check('onChange 回调触发', changed === STATE.SCANNING);
}

// ============================================================ [7] API 客户端
group('[7] 服务端客户端');
{
  const okFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, message: 'ok', data: { instructions: [] }, trace_id: 't' }),
  });
  const r1 = await matchFields({ fields: [] }, { fetchImpl: okFetch, timeoutMs: 1000 });
  check('成功解包 data', r1.ok && Array.isArray(r1.data.instructions));

  const bizFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: 3001, message: '需要验证码', data: null }),
  });
  const r2 = await matchFields({ fields: [] }, { fetchImpl: bizFetch, timeoutMs: 1000 });
  check('业务错误码透传', !r2.ok && r2.error === '需要验证码');

  const httpFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r3 = await matchFields({ fields: [] }, { fetchImpl: httpFetch, timeoutMs: 1000 });
  check('HTTP 错误处理', !r3.ok && r3.error === 'HTTP 503');

  const netFetch = async () => { throw new Error('ECONNREFUSED'); };
  const r4 = await matchFields({ fields: [] }, { fetchImpl: netFetch, timeoutMs: 1000 });
  check('网络错误处理', !r4.ok && r4.error === 'ECONNREFUSED');

  const abortFetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const r5 = await matchFields({ fields: [] }, { fetchImpl: abortFetch, timeoutMs: 1000 });
  check('超时错误处理', !r5.ok && r5.error === '请求超时');
}

// ============================================================ [8] 平台识别
group('[8] 平台识别');
{
  check('ApplyWeb', detectSystemCode('https://apply.applyweb.com/x') === 'applyweb');
  check('Liaison', detectSystemCode('https://liaisoncas.com/app') === 'liaison');
  check('CommonApp', detectSystemCode('https://apply.commonapp.org/') === 'commonapp');
  check('未知平台回退 generic', detectSystemCode('https://example.edu/apply') === 'generic');
  check('空 URL 回退 unknown', detectSystemCode('') === 'unknown');
}

// ============================================================ [9] 多步向导
group('[9] 多步向导（步骤指纹 / 稳定窗口 / 文案识别）');
{
  // --- URL 归一化：剔除易变参数、排序、保留语义参数
  check('剔除 _t 时间戳参数', normalizeUrl('https://a.com/apply?_t=123&step=2') === 'https://a.com/apply?step=2');
  check('剔除 _ 缓存参数', !normalizeUrl('https://a.com/x?_=9&id=1').includes('_=9'));
  check('参数排序：顺序不同视为同一 URL',
    normalizeUrl('https://a.com/x?b=2&a=1') === normalizeUrl('https://a.com/x?a=1&b=2'));
  check('排序结果确定（a 在前）', normalizeUrl('https://a.com/x?b=2&a=1') === 'https://a.com/x?a=1&b=2');
  check('保留语义参数', normalizeUrl('https://a.com/x?step=2').includes('step=2'));
  check('hash 参与指纹', normalizeUrl('https://a.com/x#step2') === 'https://a.com/x#step2');
  check('空串安全返回空串', normalizeUrl('') === '');
  check('非法 URL 原样返回', normalizeUrl('not a url') === 'not a url');

  // --- 轻量哈希
  check('哈希稳定', simpleHash('abc') === simpleHash('abc'));
  check('不同输入不同哈希', simpleHash('abc') !== simpleHash('abd'));
  check('哈希为 base36 非负整数串', /^[0-9a-z]+$/.test(simpleHash('hello world')));

  // --- 字段签名：label > name/id > type
  check('优先取 label（小写归一）', fieldsSignature([{ label: 'Email', name: 'x1' }]) === 'L:email');
  check('label 缺失回退 name', fieldsSignature([{ name: 'email' }]) === 'N:email');
  check('name 缺失回退 id', fieldsSignature([{ id: 'email' }]) === 'N:email');
  check('全缺回退 type（小写归一）', fieldsSignature([{ type: 'TEXT' }]) === 'T:text');
  check('空数组返回空串', fieldsSignature([]) === '');
  check('非数组安全返回空串', fieldsSignature(null) === '');
  check('字段顺序无关（签名排序）',
    fieldsSignature([{ label: 'B' }, { label: 'A' }]) === fieldsSignature([{ label: 'A' }, { label: 'B' }]));
  {
    const many = Array.from({ length: 50 }, (_, i) => ({ label: `f${i}` }));
    check('签名字段数上限 40', fieldsSignature(many).split('|').length === 40);
  }

  // --- 步骤指纹
  const sigA = [{ label: 'Email' }];
  const sigB = [{ label: 'School' }];
  check('指纹对相同输入稳定',
    stepFingerprint('https://a.com/s1', sigA) === stepFingerprint('https://a.com/s1', sigA));
  check('URL 变化 → 指纹变化',
    stepFingerprint('https://a.com/s1', sigA) !== stepFingerprint('https://a.com/s2', sigA));
  check('字段变化 → 指纹变化',
    stepFingerprint('https://a.com/s1', sigA) !== stepFingerprint('https://a.com/s1', sigB));
  check('易变参数不影响指纹',
    stepFingerprint('https://a.com/s1?_t=1', sigA) === stepFingerprint('https://a.com/s1?_t=2', sigA));

  // --- 步骤文案识别
  {
    const m1 = detectStepMeta('Please complete Step 2 of 5 below');
    check('识别 "Step 2 of 5"', m1 && m1.index === 2 && m1.total === 5);
    const m2 = detectStepMeta('Page 3/7');
    check('识别 "Page 3/7"', m2 && m2.index === 3 && m2.total === 7);
    const m3 = detectStepMeta('2 of 5 steps');
    check('识别 "2 of 5 steps"', m3 && m3.index === 2 && m3.total === 5);
    const m4 = detectStepMeta('请填写第 3 步');
    check('识别 "第 3 步"', m4 && m4.index === 3 && m4.total === null);
    const m5 = detectStepMeta('第 4 步，共 6 步');
    check('识别 "第 4 步，共 6 步"', m5 && m5.index === 4 && m5.total === 6);
    check('普通文本返回 null', detectStepMeta('Welcome to the application') === null);
    check('空文本返回 null', detectStepMeta('') === null);
    check('非字符串安全返回 null', detectStepMeta(null) === null);
    check('序号 0 视为非法', detectStepMeta('Step 0 of 5') === null);
  }

  // --- 进度文案渲染
  check('有总数渲染 x/y', renderStepLabel({ index: 2, total: 5 }, 1) === '第 2 / 5 步');
  check('无总数只渲染序号', renderStepLabel({ index: 3, total: null }, 1) === '第 3 步');
  check('无 meta 用回退序号', renderStepLabel(null, 4) === '第 4 步');

  // --- StepWatcher：稳定窗口
  {
    let clock = 0;
    const w = new StepWatcher({ stableMs: 800, now: () => clock });
    const f1 = [{ label: 'Email' }];
    const f2 = [{ label: 'School' }];

    check('首次快照不触发（开始计时）', w.observe({ url: 'https://a.com/step1', fields: f1 }) === null);
    clock = 400;
    check('未达稳定窗口不触发', w.observe({ url: 'https://a.com/step1', fields: f1 }) === null);
    clock = 900;
    const ev1 = w.observe({ url: 'https://a.com/step1', fields: f1 });
    check('稳定窗口后确认第 1 步', Boolean(ev1) && ev1.index === 1);
    check('事件带指纹字符串', typeof ev1.fingerprint === 'string' && ev1.fingerprint.length > 0);
    check('事件标记可填', ev1.fillable === true && ev1.fieldCount === 1);
    check('事件 label 回退为序号', ev1.label === '第 1 步');

    clock = 1000;
    check('相同指纹不重复触发', w.observe({ url: 'https://a.com/step1', fields: f1 }) === null);

    clock = 1100;
    check('指纹变化先重计时', w.observe({ url: 'https://a.com/step2', fields: f2 }) === null);
    clock = 1300;
    check('抖动回旧指纹不触发', w.observe({ url: 'https://a.com/step1', fields: f1 }) === null);
    clock = 1400;
    check('再次切回新指纹仍在计时', w.observe({ url: 'https://a.com/step2', fields: f2 }) === null);
    clock = 2300;
    const ev2 = w.observe({ url: 'https://a.com/step2', fields: f2 });
    check('确认第 2 步', Boolean(ev2) && ev2.index === 2);
    check('会话累计 2 步', w.count === 2);
    check('history 记录两步', w.history.length === 2);

    w.reset();
    check('reset 清空计数与历史', w.count === 0 && w.history.length === 0);
    clock = 3000;
    w.observe({ url: 'https://a.com/step2', fields: f2 });
    clock = 4000;
    const ev3 = w.observe({ url: 'https://a.com/step2', fields: f2 });
    check('reset 后同指纹可重新确认第 1 步', Boolean(ev3) && ev3.index === 1);
  }

  // --- StepWatcher：回调与文案联动
  {
    let clock = 0;
    const seen = [];
    const w = new StepWatcher({ stableMs: 500, now: () => clock, onStepChange: (e) => seen.push(e) });
    w.observe({ url: 'https://b.com/p1', fields: [{ label: 'A' }], text: 'Step 2 of 5' });
    clock = 600;
    const ev = w.observe({ url: 'https://b.com/p1', fields: [{ label: 'A' }], text: 'Step 2 of 5' });
    check('onStepChange 回调被调用', seen.length === 1 && seen[0] === ev);
    check('事件 label 采用页面文案', ev.label === '第 2 / 5 步');
    check('事件 meta 解析正确', ev.meta && ev.meta.index === 2 && ev.meta.total === 5);

    let c2 = 0;
    const w2 = new StepWatcher({ stableMs: 100, now: () => c2 });
    w2.observe({ url: 'https://c.com/done', fields: [], text: '' });
    c2 = 200;
    const ev2 = w2.observe({ url: 'https://c.com/done', fields: [], text: '' });
    check('无字段步骤 fillable=false', ev2.fillable === false && ev2.fieldCount === 0);
    check('无字段步骤仍计步', ev2.index === 1);
  }

  // --- 常量契约
  check('STEP_STABLE_MS 为 800', STEP_STABLE_MS === 800);
  check('MSG.STEP_CHANGED 已定义', MSG.STEP_CHANGED === 'ext:step-changed');
  check('MSG.TOGGLE_AUTO 已定义', MSG.TOGGLE_AUTO === 'ext:toggle-auto');
  check('StepWatcher 默认稳定窗口 800ms', new StepWatcher().stableMs === 800);
}

// ============================================================ [10] 源码契约
group('[10] 源码契约（多步向导接线 / 合规红线）');
{
  const root = new URL('..', import.meta.url);
  const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

  const manifest = JSON.parse(read('manifest.json'));
  check('manifest 声明 storage 权限', manifest.permissions.includes('storage'));
  check('manifest 声明 action（支持角标）', Boolean(manifest.action));
  check('内容脚本注册在 document_idle', manifest.content_scripts[0].run_at === 'document_idle');
  check('step-watcher 可被页面访问',
    manifest.web_accessible_resources[0].resources.includes('src/core/*.js'));

  const content = read('src/content/content-script.js');
  check('内容脚本引入 StepWatcher', content.includes('step-watcher.js') && content.includes('new StepWatcher'));
  check('内容脚本注入稳定窗口常量', content.includes('STEP_STABLE_MS'));
  check('内容脚本上报 STEP_CHANGED', content.includes('MSG.STEP_CHANGED'));
  check('内容脚本处理 TOGGLE_AUTO', content.includes('MSG.TOGGLE_AUTO'));
  check('内容脚本持久化自动填充偏好', content.includes('chrome.storage.local'));
  check('内容脚本监听 DOM 变化', content.includes('MutationObserver'));
  check('内容脚本兜底轮询 URL 变化', content.includes('setInterval'));
  check('内容脚本监听 hashchange', content.includes('hashchange'));
  check('首次进入只提示不写数据（armed 门禁）', content.includes('session.armed'));
  check('自动填充前检查 busy 防止并发', content.includes('session.busy'));

  const sw = read('src/background/service-worker.js');
  check('SW 处理 STEP_CHANGED', sw.includes('MSG.STEP_CHANGED'));
  check('SW 写入步骤角标', sw.includes('setBadgeText'));

  const popupHtml = read('src/popup/popup.html');
  const popupJs = read('src/popup/popup.js');
  check('popup 提供自动填充开关', popupHtml.includes('id="auto"'));
  check('popup 发送 toggle-auto', popupJs.includes('ext:toggle-auto'));
  check('popup 读取 autoFill 偏好', popupJs.includes("get(['autoFill'])"));

  const panelCss = read('src/content/panel.css');
  check('浮窗含自动填充开关样式', panelCss.includes('.auto'));

  // 合规红线：绝不代替用户点击提交 / 下一步
  const sources = [
    content, sw, popupJs,
    read('src/core/filler.js'), read('src/core/validator.js'),
    read('src/core/step-watcher.js'), read('src/core/step-controller.js'),
  ].join('\n');
  check('无 .click( 调用', !/\.click\s*\(/.test(sources));
  check('无 .submit( 调用', !/\.submit\s*\(/.test(sources));
  check('无 requestSubmit 调用', !/requestSubmit/.test(sources));
  check('无 form.submit 相关绕过', !/form\s*\.\s*submit/i.test(sources));
}

// ============================================================ [11] 本地断点续填
group('[11] 本地断点续填（session-store）');
{
  check('站点键去查询串与 hash', siteKey('https://Apply.Example.edu/apply/step3?_t=123#x') === 'apply.example.edu/apply/step3');
  check('站点键去尾斜杠', siteKey('https://a.edu/apply/') === 'a.edu/apply');
  check('不同路径键不同', siteKey('https://a.edu/a') !== siteKey('https://a.edu/b'));

  const now = Date.now();
  const rec = createRecord({ systemCode: 'slate', url: 'https://a.edu/apply', stepIndex: 2, filled: 5 }, now);
  check('建记录归一化', rec.key === 'a.edu/apply' && rec.stepIndex === 2 && rec.updatedAt === now);
  const touched = touchRecord(rec, { filled: 8 }, now + 1000);
  check('覆盖更新并刷新时间', touched.filled === 8 && touched.updatedAt === now + 1000 && touched.key === rec.key);

  const store = { [rec.key]: rec };
  check('有进度可恢复', findResumable(store, rec.key, now) === rec);
  check('无记录不可恢复', findResumable({}, rec.key, now) === null);
  check('过期不可恢复', findResumable(store, rec.key, now + RESUME_TTL_MS + 1) === null);
  check('零进度不可恢复', findResumable({ k: createRecord({ url: 'https://a.edu/x' }, now) }, 'k', now) === null);

  const hint = formatResumeHint(rec, now);
  check('提示含步骤与填充数', hint.includes('第 2 步') && hint.includes('5 个'));
  check('空记录无提示', formatResumeHint(null) === '');

  const big = {};
  for (let i = 0; i < RESUME_MAX_ENTRIES + 5; i += 1) {
    big[`k${i}`] = createRecord({ url: `https://a.edu/p${i}` }, now - i * 1000);
  }
  const pruned = pruneStore({ ...big, old: createRecord({ url: 'https://a.edu/old' }, now - RESUME_TTL_MS - 1) });
  check('过期被清理', !('old' in pruned));
  check('按新旧截断上限', Object.keys(pruned).length === RESUME_MAX_ENTRIES);

  const fakeStorage = { data: {}, get: async (k) => ({ [k]: fakeStorage.data[k] }), set: async (o) => { Object.assign(fakeStorage.data, o); } };
  const saved = await saveStore(fakeStorage, store);
  const loaded = await loadStore(fakeStorage);
  check('存取往返一致', saved === true && loaded[rec.key]?.filled === 5);
  const memLoaded = await loadStore(null);
  check('无 chrome 时内存兜底可用', memLoaded && typeof memLoaded === 'object');

  const content = readFileSync(new URL('../src/content/content-script.js', import.meta.url), 'utf8');
  check('内容脚本引入 session-store', content.includes('session-store.js'));
  check('填充后持久化进度', content.includes('persistProgress'));
  check('恢复只提示不自动写（armed 门禁保留）', content.includes('resumeHint'));
}

// ============================================================ 汇总
console.log('\n' + '='.repeat(60));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过');
