/**
 * 步骤监听器：判断网申页面是否切换到「新的一步」。
 *
 * 真实网申（ApplyWeb / Liaison / Slate）普遍是 5~7 步向导。插件必须能：
 *   用户点「下一步」→ 页面切换 → **自动**识别并重新扫描填充，而不是让用户手点第二次。
 *
 * 设计要点：
 *   * **纯逻辑**：不访问 document / MutationObserver / 真实定时器。
 *     DOM 事件与防抖调度由 content-script 负责，本模块只做「快照 → 是否换步」的判断，
 *     因此可在 Node 中零依赖测试（时钟通过 `now` 注入）。
 *   * **稳定窗口**：页面加载过程中 DOM 会反复变化，指纹可能抖动。
 *     只有候选指纹持续稳定 `stableMs` 才确认换步，避免误触发。
 *   * **指纹 = 归一化 URL + 字段签名**：URL 捕捉路由式分步，字段签名捕捉同 URL 的
 *     单页分步（很多系统用 JS 切换而 URL 不变）。两者任一变化都算换步。
 *   * **合规**：本模块只「观察」，绝不点击任何按钮。
 */

/** URL 中易变、不表示步骤的参数（每次请求都会变，会污染指纹） */
const VOLATILE_PARAMS = ['_', '_t', '_ts', 'ts', 'timestamp', 't', 'rand', 'nonce', 'cachebust'];

/** 步骤文案识别（中英文 + 常见英文变体） */
const STEP_PATTERNS = [
  /step\s*(\d+)\s*(?:of|\/|out of)\s*(\d+)/i,
  /page\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
  /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:steps|pages)/i,
  /第\s*(\d+)\s*步(?:\s*[，,\/]?\s*共\s*(\d+)\s*步)?/,
];

/**
 * 归一化 URL：剔除易变参数并排序剩余参数。
 * 参数顺序差异（?a=1&b=2 vs ?b=2&a=1）不应被当成换步。
 */
export function normalizeUrl(url) {
  const raw = String(url || '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    for (const p of VOLATILE_PARAMS) u.searchParams.delete(p);
    const entries = [...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    u.search = '';
    for (const [k, v] of entries) u.searchParams.append(k, v);
    return `${u.origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return raw;
  }
}

/** 轻量字符串哈希（djb2），避免指纹过长 */
export function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * 字段签名：描述「这一步有哪些字段」。
 *
 * 优先用 label（语义稳定，不随框架随机 id 变化），
 * label 缺失时回退 name / id，再回退 type。
 */
export function fieldsSignature(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  const parts = [];
  for (const f of fields) {
    const label = String(f?.label || '').trim().toLowerCase();
    if (label) {
      parts.push(`L:${label}`);
      continue;
    }
    const name = String(f?.name || f?.id || '').trim().toLowerCase();
    parts.push(name ? `N:${name}` : `T:${String(f?.type || '').trim().toLowerCase()}`);
  }
  return parts.sort().slice(0, 40).join('|');
}

/** 步骤指纹：归一化 URL + 字段签名哈希 */
export function stepFingerprint(url, fields) {
  return `${normalizeUrl(url)}::${simpleHash(fieldsSignature(fields))}`;
}

/**
 * 从页面文本中提取步骤信息。
 * @returns {{index:number,total:number|null,raw:string}|null}
 */
export function detectStepMeta(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const re of STEP_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const index = Number(m[1]);
    if (!Number.isFinite(index) || index <= 0) continue;
    const total = m[2] ? Number(m[2]) : null;
    return {
      index,
      total: Number.isFinite(total) && total > 0 ? total : null,
      raw: m[0].trim(),
    };
  }
  return null;
}

/** 渲染步骤进度文案 */
export function renderStepLabel(meta, fallbackIndex) {
  if (meta && meta.total) return `第 ${meta.index} / ${meta.total} 步`;
  if (meta) return `第 ${meta.index} 步`;
  return `第 ${fallbackIndex} 步`;
}

export class StepWatcher {
  /**
   * @param {object} [options]
   * @param {(event:object)=>void} [options.onStepChange] 确认换步时回调
   * @param {number} [options.stableMs] 指纹需稳定的时长（默认 800ms）
   * @param {()=>number} [options.now] 时钟（测试注入）
   */
  constructor(options = {}) {
    this.onStepChange = typeof options.onStepChange === 'function' ? options.onStepChange : null;
    this.stableMs = Number.isFinite(options.stableMs) ? options.stableMs : 800;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();

    this.candidate = '';
    this.candidateSince = 0;
    this.committed = '';
    this.stepIndex = 0;
    this.history = [];
  }

  /**
   * 提交一次页面快照。
   * @param {{url?:string, fields?:Array, text?:string}} snapshot
   * @returns {object|null} 确认换步时返回事件，否则 null
   */
  observe(snapshot = {}) {
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const fp = stepFingerprint(snapshot.url, fields);
    const t = this.now();

    // 指纹变化 → 重新开始稳定计时
    if (fp !== this.candidate) {
      this.candidate = fp;
      this.candidateSince = t;
      return null;
    }

    // 尚未稳定
    if (t - this.candidateSince < this.stableMs) return null;

    // 与已确认的步骤相同 → 不重复触发
    if (fp === this.committed) return null;

    this.committed = fp;
    this.stepIndex += 1;

    const meta = detectStepMeta(snapshot.text || '');
    const event = {
      fingerprint: fp,
      index: this.stepIndex,
      url: String(snapshot.url || ''),
      fieldCount: fields.length,
      fillable: fields.length > 0,
      meta,
      label: renderStepLabel(meta, this.stepIndex),
      at: t,
    };
    this.history.push(event);
    if (this.onStepChange) this.onStepChange(event);
    return event;
  }

  /** 会话重置：新一轮填写开始时调用 */
  reset() {
    this.candidate = '';
    this.candidateSince = 0;
    this.committed = '';
    this.stepIndex = 0;
    this.history = [];
  }

  /** 当前已确认的步骤数 */
  get count() {
    return this.stepIndex;
  }
}
