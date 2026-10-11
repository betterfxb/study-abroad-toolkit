/**
 * 填充计划器：把服务端返回的 instructions 分组、排序、分级。
 *
 * 纯逻辑，无 DOM 依赖 → 可在 Node 中直接测试。
 * 分级依据服务端给出的 action，但插件端**二次校验**置信度阈值，
 * 避免服务端版本与插件不一致时出现越权自动填充。
 */

import { ACTION, LOCAL_ONLY_FIELDS, THRESHOLD } from '../shared/constants.js';

/**
 * 按置信度重算动作（插件侧权威口径）。
 * @param {number} confidence
 * @returns {'fill'|'review'|'skip'}
 */
export function classify(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return ACTION.SKIP;
  if (c >= THRESHOLD.AUTO_FILL) return ACTION.FILL;
  if (c >= THRESHOLD.REVIEW) return ACTION.REVIEW;
  return ACTION.SKIP;
}

/**
 * 把指令列表拆成「自动填 / 待复核 / 跳过」三组。
 *
 * 规则：
 *   * 空值（value 为空）一律跳过；
 *   * 敏感字段（LOCAL_ONLY_FIELDS）**不自动填**，降级为待复核；
 *   * 最终动作以插件侧重算的 classify(confidence) 为准（服务端 action 仅作参考）。
 */
export function planInstructions(instructions, options = {}) {
  const list = Array.isArray(instructions) ? instructions : [];
  const plan = { fill: [], review: [], skip: [] };

  for (const instr of list) {
    if (!instr || !instr.selector) continue;
    const value = instr.value ?? '';
    if (value === '' || value === null) {
      plan.skip.push({ ...instr, reason: instr.reason || '空值' });
      continue;
    }

    let action = classify(instr.confidence);
    let reason = instr.reason || '';

    if (LOCAL_ONLY_FIELDS.includes(instr.field_key)) {
      if (action === ACTION.FILL) {
        action = ACTION.REVIEW;
        reason = '敏感字段，需人工确认';
      }
    }

    // 文书超字数（服务端 word_check.ok === false）：只降级、不截断，
    // 与敏感字段同理——交由用户删减后复核（word_check 随指令透传）。
    if (instr.word_check && instr.word_check.ok === false) {
      if (action === ACTION.FILL) {
        action = ACTION.REVIEW;
      }
      if (!reason.includes('超字数') && !reason.includes('超限')) {
        const wc = instr.word_check;
        const hint = wc.exceeds_by_words
          ? `文书超字数：约${wc.words}词/限${wc.limit_words}词`
          : `文书超长：${wc.chars}字符/限${wc.limit_chars}字符`;
        reason = reason ? `${reason}；${hint}` : hint;
      }
    }

    if (action === ACTION.FILL) plan.fill.push({ ...instr });
    else if (action === ACTION.REVIEW) plan.review.push({ ...instr, reason });
    else plan.skip.push({ ...instr, reason: reason || '置信度不足' });
  }

  // 高置信度优先填，减少页面抖动
  const byConfidence = (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0);
  plan.fill.sort(byConfidence);
  plan.review.sort(byConfidence);
  return plan;
}

/** 汇总统计（与契约 §4.1 summary 口径一致） */
export function summarize(plan, totalFields) {
  const total = totalFields || 0;
  const filled = plan.fill.length + plan.review.length;
  return {
    total,
    fill: plan.fill.length,
    review: plan.review.length,
    skip: plan.skip.length,
    fillRate: total ? Number((filled / total).toFixed(4)) : 0,
    autoFillRate: total ? Number((plan.fill.length / total).toFixed(4)) : 0,
  };
}
