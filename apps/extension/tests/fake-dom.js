/**
 * 最小 DOM 桩（仅测试用，零第三方依赖）。
 *
 * 支撑插件的 DOM 相关逻辑在 Node 中运行：元素属性、标签定位、选择器匹配、
 * 事件派发、class 操作等，覆盖代码实际用到的 DOM 子集。
 */

function parseCompound(part) {
  let s = part.trim();
  let tag = null;
  const tm = s.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tm) { tag = tm[1].toLowerCase(); s = s.slice(tm[1].length); }
  const tokens = [];
  const re = /(#[\w-]+|\.[\w-]+|\[[^\]]*\])/g;
  let m;
  while ((m = re.exec(s))) tokens.push(m[0]);
  return { tag, tokens };
}

function matchToken(el, tok) {
  if (tok[0] === '#') return el.id === tok.slice(1);
  if (tok[0] === '.') return el._classes.has(tok.slice(1));
  const inner = tok.slice(1, -1).trim();
  const am = inner.match(/^([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*(i)?$/);
  if (!am) return false;
  const [, name, op, q1, q2, bare, ci] = am;
  const attr = el.getAttribute(name);
  if (attr === null) return false;
  if (!op) return true;
  let a = String(attr);
  let v = String(q1 ?? q2 ?? bare ?? '');
  if (ci) { a = a.toLowerCase(); v = v.toLowerCase(); }
  if (op === '=') return a === v;
  if (op === '*=') return a.includes(v);
  if (op === '^=') return a.startsWith(v);
  if (op === '$=') return a.endsWith(v);
  if (op === '~=') return a.split(/\s+/).includes(v);
  if (op === '|=') return a === v || a.startsWith(`${v}-`);
  return false;
}

export function matchesSelector(el, selector) {
  return selector.split(',').some((part) => {
    const c = parseCompound(part);
    if (c.tag && (el.tagName || '').toLowerCase() !== c.tag) return false;
    return c.tokens.every((t) => matchToken(el, t));
  });
}

export class FakeElement {
  constructor(tag, attrs = {}, opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this._attrs = {};
    for (const [k, v] of Object.entries(attrs)) this._attrs[k.toLowerCase()] = String(v);
    this.children = [];
    this.parentElement = null;
    this.ownerDocument = null;
    this._text = opts.text ?? '';
    this._value = opts.value ?? '';
    this.checked = opts.checked ?? false;
    this.disabled = opts.disabled ?? false;
    this.readOnly = opts.readOnly ?? false;
    this.style = opts.style ?? {};
    this._options = opts.options ?? null;
    this._labels = opts.labels ?? [];
    this._visible = opts.visible !== false;
    this._listeners = {};
    const cls = opts.className ?? this._attrs.class ?? '';
    this._classes = new Set(String(cls).split(/\s+/).filter(Boolean));
    if ('required' in this._attrs) this.required = true;
  }

  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = String(v); }
  get name() { return this._attrs.name || ''; }
  get type() { return this._attrs.type || ''; }
  get placeholder() { return this._attrs.placeholder || ''; }
  get maxLength() { return this._attrs.maxlength ? Number(this._attrs.maxlength) : -1; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get options() { return this._options; }
  get labels() { return this._labels; }
  get className() { return Array.from(this._classes).join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (c) => { self._classes.add(c); },
      remove: (c) => { self._classes.delete(c); },
      contains: (c) => self._classes.has(c),
    };
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v); this.children = []; }

  getAttribute(k) { return this._attrs[String(k).toLowerCase()] ?? null; }
  setAttribute(k, v) { this._attrs[String(k).toLowerCase()] = String(v); }
  hasAttribute(k) { return String(k).toLowerCase() in this._attrs; }

  appendChild(c) { c.parentElement = this; c.ownerDocument = this.ownerDocument || this; this.children.push(c); return c; }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const sib = this.parentElement.children;
    const i = sib.indexOf(this);
    return i > 0 ? sib[i - 1] : null;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (matchesSelector(cur, sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (matchesSelector(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  getElementById(id) {
    for (const el of this.querySelectorAll('*')) if (el.id === id) return el;
    return null;
  }

  getBoundingClientRect() {
    return this._visible ? { width: 120, height: 24 } : { width: 0, height: 0 };
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatchEvent(evt) { (this._listeners[evt?.type] || []).forEach((f) => f(evt)); return true; }
}

/** 构造 <html><body>…</body></html> */
export function makePage() {
  const html = new FakeElement('html');
  const body = new FakeElement('body', {}, { text: '' });
  html.appendChild(body);
  html.ownerDocument = html;
  body.ownerDocument = html;
  return { html, body };
}
