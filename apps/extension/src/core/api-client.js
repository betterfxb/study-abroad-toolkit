/**
 * 服务端客户端：调用 intelligence-service 的插件侧接口。
 *
 * 运行位置：**后台 Service Worker**（拥有 host_permissions，可跨域请求）。
 * 内容脚本不直接请求，而是通过 chrome.runtime 消息转发，避免被页面 CSP 拦截。
 *
 * fetch 实现可注入 → 可在 Node 中零依赖测试。
 */

import { CONFIG } from '../shared/config.js';

/** 带超时的 JSON 请求 */
async function requestJson(url, { method = 'GET', body, fetchImpl, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'fetch 不可用' };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const res = await doFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);

    if (!res || !res.ok) {
      return { ok: false, error: `HTTP ${res ? res.status : 'unknown'}` };
    }
    const json = await res.json();
    // 契约通用封装：{ code, message, data, trace_id }
    if (json && typeof json.code === 'number' && json.code !== 0) {
      return { ok: false, error: json.message || `业务错误 ${json.code}` };
    }
    return { ok: true, data: json?.data ?? json };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const msg = err?.name === 'AbortError' ? '请求超时' : (err?.message || '网络错误');
    return { ok: false, error: msg };
  }
}

/**
 * 字段匹配。
 * @param {{session_id?:number, page_url?:string, system_code?:string, fields:Array}} payload
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
export function matchFields(payload, options = {}) {
  const base = options.baseUrl || CONFIG.INTELLIGENCE_BASE;
  return requestJson(`${base}/ext/v1/match-fields`, {
    method: 'POST',
    body: payload,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

/** 获取字段词典（用于插件端核对版本） */
export function fetchDictionary(options = {}) {
  const base = options.baseUrl || CONFIG.INTELLIGENCE_BASE;
  return requestJson(`${base}/ext/v1/dictionary`, { fetchImpl: options.fetchImpl });
}

/** 健康检查 */
export function health(options = {}) {
  const base = options.baseUrl || CONFIG.INTELLIGENCE_BASE;
  return requestJson(`${base}/health`, { fetchImpl: options.fetchImpl, timeoutMs: 3000 });
}

/**
 * 上报字段级结果（契约 §4.2）。失败不阻断主流程。
 */
export function reportLogs(payload, options = {}) {
  const base = options.baseUrl || CONFIG.INTELLIGENCE_BASE;
  return requestJson(`${base}/ext/v1/fill-logs`, {
    method: 'POST',
    body: payload,
    fetchImpl: options.fetchImpl,
  });
}
