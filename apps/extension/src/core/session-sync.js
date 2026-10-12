/**
 * 服务端会话同步的纯逻辑（网关契约 §4.2）。
 *
 * 只做「本地状态 → 请求载荷」的映射与统计聚合；网络与存储在 service-worker。
 * 失败语义由调用方保证 fail-open：同步失败绝不阻断填充主流程。
 */

/** 网关合法状态（与 ext.service SESSION_STATUS 一致） */
export const SESSION_STATUS = ['running', 'paused', 'completed', 'failed', 'blocked'];

/** 单条日志的结果合法值（契约 §4.1） */
export const LOG_RESULTS = ['filled', 'skipped', 'failed', 'low_confidence', 'manual'];

/** 本地统计：日志数组 → stats 对象（网关 stats 须为对象） */
export function statsFromLogs(logs) {
  const out = { total: 0 };
  for (const r of LOG_RESULTS) out[r] = 0;
  const arr = Array.isArray(logs) ? logs : [];
  for (const item of arr) {
    out.total += 1;
    const r = String(item?.result || 'skipped');
    if (out[r] === undefined) out[r] = 0;
    out[r] += 1;
  }
  return out;
}

/** 累加两次 stats（SW 内存态跨步骤累计） */
export function mergeStats(prev, next) {
  const out = { total: 0 };
  for (const r of LOG_RESULTS) out[r] = 0;
  for (const src of [prev, next]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of Object.keys(out)) {
      const n = Number(src[k]);
      if (Number.isFinite(n) && n > 0) out[k] += n;
    }
  }
  return out;
}

/** POST /ext/v1/sessions 载荷 */
export function sessionCreatePayload({ systemCode = '', stepIndex = 0 } = {}) {
  return {
    system_code: String(systemCode || ''),
    step_index: Math.max(0, Math.floor(Number(stepIndex) || 0)),
  };
}

/** PATCH /ext/v1/sessions/{id} 载荷（只带调用方给出的键；stats 须为对象） */
export function sessionPatchPayload({ stepIndex, stats } = {}) {
  const patch = {};
  if (stepIndex !== undefined && stepIndex !== null) {
    const n = Math.floor(Number(stepIndex));
    if (Number.isFinite(n) && n >= 0) patch.step_index = n;
  }
  if (stats !== undefined && stats !== null && typeof stats === 'object' && !Array.isArray(stats)) {
    patch.stats = stats;
  }
  return patch;
}

/** 是否应发起同步：有凭证 + 有会话目标（或正在创建） */
export function shouldSync(auth) {
  return !!(auth && auth.access_token);
}
