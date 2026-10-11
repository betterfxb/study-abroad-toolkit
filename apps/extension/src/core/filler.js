/**
 * 填充执行器：把一条填充指令写进真实表单控件，并触发必要事件。
 *
 * 关键约束（架构详设 §3）：
 *   * **只填充，绝不提交** —— 本模块不点击任何提交/下一步按钮；
 *   * 触发 `input` + `change` 事件，保证 React/Vue 受控组件能感知值变化；
 *   * 待复核字段加高亮，自动填字段加标记，便于用户一眼识别。
 *
 * DOM 依赖通过元素自身方法访问，可用最小 DOM 桩在 Node 中测试。
 */

import { ACTION, HIGHLIGHT } from '../shared/constants.js';

/** 归一化文本：去空白、小写 */
function norm(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 安全派发事件 */
function fire(el, type, EventCtor) {
  if (typeof el.dispatchEvent !== 'function') return;
  let evt;
  try {
    const Ctor = EventCtor || (typeof Event !== 'undefined' ? Event : null);
    evt = Ctor ? new Ctor(type, { bubbles: true }) : { type, bubbles: true };
  } catch {
    evt = { type, bubbles: true };
  }
  try {
    el.dispatchEvent(evt);
  } catch {
    /* 桩环境可能不支持，忽略 */
  }
}

/**
 * 在 select 的选项中找最匹配的一项。
 * @returns {{value: string, text: string, exact: boolean}|null}
 */
export function matchOption(el, value) {
  const options = el.options ? Array.from(el.options) : [];
  if (!options.length) return null;
  const target = norm(value);
  if (!target) return null;

  // ① 精确匹配文本或 value
  for (const opt of options) {
    const text = norm(opt.text ?? opt.textContent);
    const val = norm(opt.value);
    if (text === target || val === target) {
      return { value: opt.value, text: opt.text ?? opt.textContent ?? '', exact: true };
    }
  }

  // ② 包含匹配（双向）
  let best = null;
  for (const opt of options) {
    const text = norm(opt.text ?? opt.textContent);
    const val = norm(opt.value);
    if (!text && !val) continue;
    if ((text && (text.includes(target) || target.includes(text))) ||
        (val && (val.includes(target) || target.includes(val)))) {
      if (!best) best = { value: opt.value, text: opt.text ?? opt.textContent ?? '', exact: false };
    }
  }
  return best;
}

/** 给元素加高亮类（桩环境用 classList.add 的简化实现） */
function addClass(el, cls) {
  if (el.classList && typeof el.classList.add === 'function') {
    el.classList.add(cls);
  } else if (typeof el.className === 'string') {
    el.className = `${el.className} ${cls}`.trim();
  }
}

/**
 * 应用一条填充指令。
 * @param {Element} el
 * @param {{selector:string, field_key:string, value:string, confidence:number, action?:string}} instr
 * @returns {{ok: boolean, result: 'filled'|'review'|'skipped'|'failed', value: string, reason?: string}}
 */
export function applyInstruction(el, instr) {
  if (!el) return { ok: false, result: 'failed', value: '', reason: '元素不存在' };

  const value = instr.value ?? '';
  if (value === '' || value === null) {
    return { ok: false, result: 'skipped', value: '', reason: '空值' };
  }

  const tag = (el.tagName || 'input').toLowerCase();
  const type = (el.getAttribute?.('type') || el.type || 'text').toLowerCase();

  // ---------------------------------------------------------- select
  if (tag === 'select') {
    const hit = matchOption(el, value);
    if (!hit) {
      return { ok: false, result: 'failed', value: '', reason: '下拉无匹配选项' };
    }
    el.value = hit.value;
    fire(el, 'input');
    fire(el, 'change');
    const cls = hit.exact ? HIGHLIGHT.FILLED : HIGHLIGHT.REVIEW;
    addClass(el, cls);
    return {
      ok: true,
      result: hit.exact ? 'filled' : 'review',
      value: hit.value,
      reason: hit.exact ? undefined : '选项为近似匹配',
    };
  }

  // ---------------------------------------------------------- checkbox / radio
  if (type === 'checkbox' || type === 'radio') {
    const target = norm(value);
    const own = norm(el.value);
    const shouldCheck = target === 'true' || target === '1' || target === 'yes' ||
      (own && (own === target || target.includes(own)));
    if (shouldCheck) {
      el.checked = true;
      fire(el, 'input');
      fire(el, 'change');
      addClass(el, HIGHLIGHT.FILLED);
      return { ok: true, result: 'filled', value: el.value ?? 'true' };
    }
    return { ok: false, result: 'skipped', value: '', reason: '复选框不匹配' };
  }

  // ---------------------------------------------------------- text / textarea / number / date
  try {
    el.value = value;
  } catch {
    return { ok: false, result: 'failed', value: '', reason: '赋值失败' };
  }
  fire(el, 'input');
  fire(el, 'change');

  const review = instr.action === ACTION.REVIEW;
  addClass(el, review ? HIGHLIGHT.REVIEW : HIGHLIGHT.FILLED);
  return {
    ok: true,
    result: review ? 'review' : 'filled',
    value,
    reason: review ? (instr.reason || '需人工复核') : undefined,
  };
}

/**
 * 批量执行填充计划。按 selector 在 root 中查元素。
 * @param {Document|Element} root
 * @param {{fill:Array, review:Array}} plan
 * @returns {{logs: Array, filled: number, review: number, failed: number}}
 */
export function applyPlan(root, plan) {
  const logs = [];
  let filled = 0;
  let review = 0;
  let failed = 0;

  const run = (list, action) => {
    for (const instr of list) {
      const el = root?.querySelector?.(instr.selector);
      if (!el) {
        logs.push({ selector: instr.selector, field_key: instr.field_key, result: 'skipped', reason: '未找到元素' });
        continue;
      }
      const res = applyInstruction(el, { ...instr, action });
      logs.push({
        selector: instr.selector,
        field_key: instr.field_key,
        result: res.result,
        confidence: instr.confidence,
        reason: res.reason,
      });
      if (res.result === 'filled') filled += 1;
      else if (res.result === 'review') review += 1;
      else if (res.result === 'failed') failed += 1;
    }
  };

  run(plan.fill || [], ACTION.FILL);
  run(plan.review || [], ACTION.REVIEW);

  return { logs, filled, review, failed };
}
