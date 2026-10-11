/**
 * DOM 工具：为字段生成稳定选择器、定位标签文本。
 *
 * 本模块只依赖传入元素自身的标准 DOM 属性（getAttribute / labels / textContent 等），
 * 不访问 window/document 全局，因此可在 Node 中用最小 DOM 桩直接测试。
 */

/** 转义 CSS 标识符中的特殊字符 */
export function cssEscape(value) {
  const s = String(value ?? '');
  if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
    return CSS.escape(s);
  }
  // 零依赖回退：仅保留安全字符
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/**
 * 为元素生成一个尽量稳定、尽量唯一的选择器。
 * 优先级：id → name → 组合属性。
 */
export function buildSelector(el, index = 0) {
  const tag = (el.tagName || 'input').toLowerCase();
  const id = el.getAttribute?.('id') || el.id || '';
  if (id) return `#${cssEscape(id)}`;

  const name = el.getAttribute?.('name') || el.name || '';
  if (name) return `${tag}[name="${String(name).replace(/"/g, '\\"')}"]`;

  const type = el.getAttribute?.('type') || el.type || '';
  if (type) return `${tag}[type="${type}"]`;

  return `${tag}:nth-of-type(${index + 1})`;
}

/** 取元素的可见文本（去掉多余空白） */
export function cleanText(node) {
  if (!node) return '';
  const raw = node.textContent ?? '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

/**
 * 定位字段的标签文本。按可靠性降级：
 *   ① 关联的 <label>（labels / for=id）
 *   ② aria-label
 *   ③ aria-labelledby 指向的元素
 *   ④ 包裹型 <label>（父元素）
 *   ⑤ 前置兄弟文本（ApplyWeb / Slate 常见「文字 + 输入框」同行布局）
 *   ⑥ table 布局的上一格（部分老系统）
 */
export function findLabel(el) {
  // ① 显式关联 label
  if (el.labels && el.labels.length) {
    const text = cleanText(el.labels[0]);
    if (text) return text;
  }

  // ② aria-label
  const aria = el.getAttribute?.('aria-label');
  if (aria && aria.trim()) return aria.trim();

  // ③ aria-labelledby
  const labelledBy = el.getAttribute?.('aria-labelledby');
  if (labelledBy) {
    const doc = el.ownerDocument;
    const target = doc?.getElementById?.(labelledBy);
    const text = cleanText(target);
    if (text) return text;
  }

  // ④ 包裹型 label（父元素是 label）
  let p = el.parentElement;
  let depth = 0;
  while (p && depth < 3) {
    if ((p.tagName || '').toLowerCase() === 'label') {
      const text = cleanText(p);
      if (text) return text;
    }
    p = p.parentElement;
    depth += 1;
  }

  // ⑤ 前置兄弟文本
  const prev = el.previousElementSibling;
  const prevText = cleanText(prev);
  if (prevText && prevText.length <= 120) return prevText;

  // ⑥ table 布局：上一格的文本
  const td = el.closest?.('td');
  const prevTd = td?.previousElementSibling;
  const tdText = cleanText(prevTd);
  if (tdText && tdText.length <= 120) return tdText;

  return '';
}

/** 取邻近文本（字段上下文），用于消歧 */
export function findNearText(el) {
  const fieldset = el.closest?.('fieldset, section, .form-group, .field, tr');
  const legend = fieldset?.querySelector?.('legend, h1, h2, h3, h4, .title, th');
  const text = cleanText(legend);
  if (text && text.length <= 120) return text;
  return '';
}

/** 采集 select 的选项文本 */
export function collectOptions(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag !== 'select' || !el.options) return [];
  return Array.from(el.options)
    .map((o) => {
      // 真实 <option> 同时具备 .text 与 .textContent；优先用 .text
      const raw = o.text ?? o.textContent ?? o.value ?? '';
      return String(raw).replace(/\s+/g, ' ').trim();
    })
    .filter((t) => t && !/^(--|请选择|select|choose|选择)/i.test(t));
}

/** 判断元素是否可见、是否应参与填充 */
export function isFillable(el) {
  const tag = (el.tagName || '').toLowerCase();
  if (!['input', 'select', 'textarea'].includes(tag)) return false;

  const type = (el.getAttribute?.('type') || el.type || 'text').toLowerCase();
  if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return false;

  if (el.disabled) return false;
  if (el.readOnly) return false;

  // 尺寸为 0 通常意味着隐藏（Node 桩中不存在该属性，跳过）
  if (typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect();
    if (rect && rect.width === 0 && rect.height === 0) return false;
  }

  const style = el.style;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;

  return true;
}
