/**
 * 字段提取器：把网页表单控件转成 intelligence-service 需要的 FieldSpec 列表。
 *
 * 设计要点：
 *   * `extractFields(elements)` 只依赖元素自身的 DOM 属性，**不访问全局 document**，
 *     因此可用最小 DOM 桩在 Node 中直接测试。
 *   * `collectCandidates(root)` 负责从页面选取候选控件（唯一接触全局 DOM 的函数）。
 */

import { FORM_CONTROL_SELECTOR } from '../shared/constants.js';
import { buildSelector, collectOptions, findLabel, findNearText, isFillable } from './dom-utils.js';

/**
 * 把单个元素转成 FieldSpec（契约 §4.1 req.fields 的元素结构）。
 */
export function buildFieldSpec(el, index = 0) {
  const tag = (el.tagName || 'input').toLowerCase();
  const rawType = (el.getAttribute?.('type') || el.type || '').toLowerCase();
  const type = tag === 'select' ? 'select'
    : tag === 'textarea' ? 'textarea'
    : (rawType || 'text');

  // DOM 缺省 maxLength 为 -1（= 无限制），必须归一为 null，
  // 否则服务端会把 -1 当成字符上限，全员误判超限（maxlength 语义：null = 无限制）
  const maxlengthRaw = el.getAttribute?.('maxlength') ?? el.maxLength;
  const maxlengthParsed = maxlengthRaw === null || maxlengthRaw === undefined || maxlengthRaw === ''
    ? null
    : Number(maxlengthRaw);
  const maxlength = maxlengthParsed !== null && maxlengthParsed > 0 ? maxlengthParsed : null;

  return {
    selector: buildSelector(el, index),
    label: findLabel(el),
    name: String(el.getAttribute?.('name') || el.name || ''),
    id: String(el.getAttribute?.('id') || el.id || ''),
    placeholder: String(el.getAttribute?.('placeholder') || el.placeholder || ''),
    aria_label: String(el.getAttribute?.('aria-label') || ''),
    near_text: findNearText(el),
    type,
    options: collectOptions(el),
    required: Boolean(el.required ?? el.getAttribute?.('required') !== null),
    maxlength: Number.isFinite(maxlength) ? maxlength : null,
  };
}

/**
 * 批量提取。输入为元素数组（已过滤），输出 FieldSpec 数组。
 * 同一选择器只保留第一个，避免重复字段污染匹配。
 */
export function extractFields(elements) {
  const out = [];
  const seen = new Set();
  let index = 0;
  for (const el of elements) {
    if (!el) continue;
    const spec = buildFieldSpec(el, index);
    index += 1;
    if (!spec.selector || seen.has(spec.selector)) continue;
    seen.add(spec.selector);
    out.push(spec);
  }
  return out;
}

/**
 * 从页面根节点采集候选控件。这是唯一接触全局 DOM 的函数。
 * @param {Document|Element} root
 * @returns {Element[]}
 */
export function collectCandidates(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const nodes = Array.from(root.querySelectorAll(FORM_CONTROL_SELECTOR));
  return nodes.filter(isFillable);
}

/** 一步到位：从页面根节点采集并提取 */
export function scanPage(root) {
  return extractFields(collectCandidates(root));
}
