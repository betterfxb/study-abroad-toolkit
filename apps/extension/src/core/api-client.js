/**
 * 服务端客户端：调用 intelligence-service 的插件侧接口。
 *
 * 运行位置：**后台 Service Worker**（拥有 host_permissions，可跨域请求）。
 * 内容脚本不直接请求，而是通过 chrome.runtime 消息转发，避免被页面 CSP 拦截。
 *
 * fetch 实现可注入 → 可在 Node 中零依赖测试。
 */

import { CONFIG } from '../shared/config.js';

/** 带超时的 JSON 请求（headers 可注入 → 鉴权头由调用方决定） */
async function requestJson(url, { method = 'GET', body, headers, fetchImpl, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: 'fetch 不可用' };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller && timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const res = await doFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);

    if (!res || !res.ok) {
      return { ok: false, status: res ? res.status : 0, error: `HTTP ${res ? res.status : 'unknown'}` };
    }
    const json = await res.json();
    // 契约通用封装：{ code, message, data, trace_id }
    if (json && typeof json.code === 'number' && json.code !== 0) {
      return { ok: false, status: res.status, error: json.message || `业务错误 ${json.code}` };
    }
    return { ok: true, status: res.status, data: json?.data ?? json };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const msg = err?.name === 'AbortError' ? '请求超时' : (err?.message || '网络错误');
    return { ok: false, status: 0, error: msg };
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
 * fill-logs 只在网关落地（intelligence 无此路由）→ 走 gatewayBase。
 */
export function reportLogs(payload, options = {}) {
  const base = options.gatewayBase || options.baseUrl || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/ext/v1/fill-logs`, {
    method: 'POST',
    body: payload,
    headers: options.token ? { 'X-Ext-Token': options.token } : undefined,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

// ---------------------------------------------------------------- 网关鉴权

/** 登录（POST /api/v1/auth/login）→ TokenBundle */
export function login({ email, password, gatewayBase }, options = {}) {
  const base = gatewayBase || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/api/v1/auth/login`, {
    method: 'POST',
    body: { email: String(email || '').trim(), password: String(password || '') },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || 8000,
  });
}

/** 刷新 access（POST /api/v1/auth/refresh） */
export function refreshAuth({ refresh_token: refreshToken, gatewayBase }, options = {}) {
  const base = gatewayBase || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/api/v1/auth/refresh`, {
    method: 'POST',
    body: { refresh_token: String(refreshToken || '') },
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || 8000,
  });
}

// ------------------------------------------------------- 服务端会话同步
// 全部带 X-Ext-Token；调用方负责 fail-open（失败不阻断填充主流程）。

function extAuth(options) {
  return options.token ? { 'X-Ext-Token': options.token } : undefined;
}

/** 创建填写会话（契约 §4.2 POST /ext/v1/sessions） */
export function createSession(payload, options = {}) {
  const base = options.gatewayBase || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/ext/v1/sessions`, {
    method: 'POST',
    body: payload || {},
    headers: extAuth(options),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

/** 更新步骤与统计（契约 §4.2 PATCH /ext/v1/sessions/{id}） */
export function patchSession(id, patch, options = {}) {
  const base = options.gatewayBase || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/ext/v1/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch || {},
    headers: extAuth(options),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

/** 上报验证码/风控 → blocked（契约 §4.2 POST /ext/v1/sessions/{id}/block） */
export function blockSession(id, reason, options = {}) {
  const base = options.gatewayBase || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/ext/v1/sessions/${encodeURIComponent(id)}/block`, {
    method: 'POST',
    body: { reason: String(reason || '') },
    headers: extAuth(options),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

// ------------------------------------------------------------- 档案拉取

/** 拉取结构化档案（契约 §2 GET /api/v1/profile；守卫同时认 X-Ext-Token 与 Bearer） */
export function fetchProfile(options = {}) {
  const base = options.gatewayBase || CONFIG.GATEWAY_BASE;
  return requestJson(`${base}/api/v1/profile`, {
    method: 'GET',
    headers: extAuth(options),
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || 8000,
  });
}
