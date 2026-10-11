/**
 * 本地断点续填：跨天/跨次打开同一网申页时恢复上次进度。
 *
 * 纯逻辑 + 可注入 storage → 可在 Node 中零依赖测试。
 * 存储位置：chrome.storage.local（跨浏览器会话保留，TTL 7 天、最多 20 条）。
 * 服务端会话（网关 /ext/v1/sessions）是另一条链路：待插件具备鉴权 Token
 * 后再做同步，本模块只管本地进度（字段计数与步骤，不存字段原文）。
 */

export const RESUME_KEY = 'ext:resume:v1';
/** 进度保留 7 天，过期视为新申请季/已提交，不再提示 */
export const RESUME_TTL_MS = 7 * 24 * 3600 * 1000;
/** 最多保留 20 个站点的进度，按新旧淘汰 */
export const RESUME_MAX_ENTRIES = 20;

/**
 * 站点键：host + pathname（去尾斜杠、小写 host）。
 * 查询串与 hash 多为会话/步骤参数，剔除后同一份申请各步骤归一到同一键。
 */
export function siteKey(url) {
  try {
    const u = new URL(String(url || ''));
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return `${u.host.toLowerCase()}${path}`.slice(0, 200);
  } catch {
    return String(url || '').toLowerCase().slice(0, 200);
  }
}

export function createRecord({ systemCode = '', url = '', stepIndex = 0, filled = 0, review = 0, missing = 0 } = {}, now = Date.now()) {
  return {
    key: siteKey(url),
    systemCode: String(systemCode || ''),
    url: String(url || ''),
    stepIndex: Math.max(0, Math.floor(Number(stepIndex) || 0)),
    filled: Math.max(0, Math.floor(Number(filled) || 0)),
    review: Math.max(0, Math.floor(Number(review) || 0)),
    missing: Math.max(0, Math.floor(Number(missing) || 0)),
    updatedAt: now,
  };
}

/** 用新进度覆盖旧记录（保留 key，刷新 updatedAt） */
export function touchRecord(rec, patch = {}, now = Date.now()) {
  const base = rec && typeof rec === 'object' ? rec : {};
  return createRecord(
    {
      systemCode: patch.systemCode ?? base.systemCode ?? '',
      url: patch.url ?? base.url ?? '',
      stepIndex: patch.stepIndex ?? base.stepIndex ?? 0,
      filled: patch.filled ?? base.filled ?? 0,
      review: patch.review ?? base.review ?? 0,
      missing: patch.missing ?? base.missing ?? 0,
    },
    now,
  );
}

/** 是否有可恢复的进度：存在、未过期、有实质进展（填过字段或走过步骤） */
export function findResumable(store, key, now = Date.now()) {
  const rec = store && typeof store === 'object' ? store[key] : null;
  if (!rec || typeof rec !== 'object') return null;
  if (now - (rec.updatedAt || 0) > RESUME_TTL_MS) return null;
  const progressed = (rec.filled || 0) + (rec.review || 0) > 0 || (rec.stepIndex || 0) > 0;
  return progressed ? rec : null;
}

/** 清理过期 + 按新旧截断，返回新对象（不改入参） */
export function pruneStore(store, now = Date.now()) {
  const src = store && typeof store === 'object' ? store : {};
  const fresh = Object.values(src).filter(
    (r) => r && typeof r === 'object' && now - (r.updatedAt || 0) <= RESUME_TTL_MS,
  );
  fresh.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const out = {};
  for (const r of fresh.slice(0, RESUME_MAX_ENTRIES)) {
    if (r.key) out[r.key] = r;
  }
  return out;
}

/** 恢复提示文案（只提示、不自动写数据，armed 门禁不变） */
export function formatResumeHint(rec, now = Date.now()) {
  if (!rec) return '';
  const days = Math.floor((now - (rec.updatedAt || 0)) / (24 * 3600 * 1000));
  const age = days <= 0 ? '今天' : `${days} 天前`;
  const step = rec.stepIndex > 0 ? `已填到第 ${rec.stepIndex} 步` : '有填充记录';
  const total = (rec.filled || 0) + (rec.review || 0);
  return `上次进度：${step} · 累计填充 ${total} 个（${age}），点「一键填充」继续`;
}

// ------------------------------------------------------------------ 存储适配
let memFallback = {};

/** Node 测试环境无 chrome 时退回内存实现，保证不断链 */
export function resolveStorage() {
  try {
    const s = globalThis.chrome?.storage?.local;
    if (s && typeof s.get === 'function' && typeof s.set === 'function') return s;
  } catch {
    /* ignore */
  }
  return {
    get: async () => ({ ...memFallback }),
    set: async (obj) => { memFallback = { ...memFallback, ...(obj || {}) }; },
  };
}

export async function loadStore(storage) {
  const s = storage || resolveStorage();
  try {
    const obj = await s.get(RESUME_KEY);
    const v = obj?.[RESUME_KEY];
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export async function saveStore(storage, store) {
  const s = storage || resolveStorage();
  try {
    await s.set({ [RESUME_KEY]: store });
    return true;
  } catch {
    return false;
  }
}
