/**
 * 填充校验器 + 阻断检测。
 *
 * 校验器：填充后核对「值是否真的写进去了」，并统计必填项缺口。
 * 阻断检测：识别验证码 / 人机验证 / 提交按钮，命中则上报 blocked=true，
 *          插件必须暂停并提示人工（合规红线：不绕过验证码、不自动提交）。
 *
 * 纯逻辑 + 只读 DOM 属性 → 可在 Node 中测试。
 */

import { SKIP_INPUT_TYPES } from '../shared/constants.js';

function norm(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 校验单个字段是否填充成功。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateElement(el, instr) {
  if (!el) return { ok: false, reason: '元素不存在' };
  const tag = (el.tagName || 'input').toLowerCase();
  const type = (el.getAttribute?.('type') || el.type || 'text').toLowerCase();
  const expected = instr.value ?? '';

  if (tag === 'select') {
    if (!el.value) return { ok: false, reason: '下拉未选中' };
    return { ok: true };
  }

  if (type === 'checkbox' || type === 'radio') {
    if (!el.checked) return { ok: false, reason: '未勾选' };
    return { ok: true };
  }

  const actual = String(el.value ?? '');
  if (actual === '') return { ok: false, reason: '值为空' };
  if (expected && norm(actual) !== norm(expected)) {
    // 页面脚本可能规范化了值（如日期格式），只要非空即视为成功，仅记录差异
    return { ok: true, reason: `值被页面改写：${actual}` };
  }
  return { ok: true };
}

/**
 * 统计必填但未填的字段（人工补全清单）。
 * @param {Element[]} elements
 * @returns {Array<{selector:string, label:string}>}
 */
export function findMissingRequired(elements) {
  const missing = [];
  for (const el of elements || []) {
    if (!el) continue;
    const required = Boolean(el.required ?? el.getAttribute?.('required') !== null);
    if (!required) continue;
    const tag = (el.tagName || 'input').toLowerCase();
    const type = (el.getAttribute?.('type') || el.type || 'text').toLowerCase();
    if (tag === 'input' && SKIP_INPUT_TYPES.includes(type)) continue;

    const empty = (type === 'checkbox' || type === 'radio') ? !el.checked
      : !String(el.value ?? '').trim();
    if (empty) {
      missing.push({
        selector: el.getAttribute?.('id') ? `#${el.getAttribute('id')}` : (el.getAttribute?.('name') || tag),
        label: String(el.getAttribute?.('aria-label') || el.getAttribute?.('name') || ''),
      });
    }
  }
  return missing;
}

/** 阻断特征：验证码 / 人机验证 / 风控提示 */
const BLOCKER_PATTERNS = [
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /g-recaptcha/i,
  /geetest|极验/i,
  /cf-challenge|cloudflare.*challenge/i,
  /人机验证|验证码|滑动验证|安全验证/,
];

/**
 * 检测页面是否存在阻断因素。
 * @param {Document|Element} root
 * @returns {{blocked: boolean, reason: string}}
 */
export function detectBlockers(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return { blocked: false, reason: '' };
  }

  // ① 验证码容器
  const candidates = root.querySelectorAll(
    '[class*="captcha" i], [id*="captcha" i], iframe[src*="recaptcha" i], ' +
    'iframe[src*="hcaptcha" i], [class*="geetest" i], [id*="geetest" i], [class*="turnstile" i]'
  );
  if (candidates && candidates.length) {
    return { blocked: true, reason: '检测到人机验证' };
  }

  // ② 文案特征
  const text = String(root.body?.textContent ?? root.textContent ?? '');
  for (const p of BLOCKER_PATTERNS) {
    if (p.test(text)) {
      return { blocked: true, reason: '页面提示需要安全验证' };
    }
  }

  return { blocked: false, reason: '' };
}

/**
 * 检测页面是否已出现「提交 / 下一步」按钮（仅用于提示，**绝不自动点击**）。
 */
export function findAdvanceButtons(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const nodes = root.querySelectorAll('button, input[type="submit"], a[role="button"]');
  const out = [];
  for (const el of nodes || []) {
    const label = String(el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
    if (/^(submit|next|continue|save and continue|提交|下一步|继续|保存并继续)/i.test(label)) {
      out.push({ label, selector: el.getAttribute?.('id') ? `#${el.getAttribute('id')}` : 'button' });
    }
  }
  return out;
}
