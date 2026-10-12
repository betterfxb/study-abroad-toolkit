/**
 * 后台 Service Worker。
 *
 * 职责：
 *   ① 代内容脚本发起跨域请求（SW 拥有 host_permissions，不受页面 CSP 限制）；
 *   ② 维护填写会话状态（serverId / 当前步骤 / 统计），供断点续填与服务端同步；
 *   ③ 鉴权：登录/粘贴 Token、401 自动 refresh 重放一次；
 *   ④ 响应 popup 的健康检查与设置读写。
 *
 * 同步语义：全部 fail-open——会话上传/统计 PATCH/阻断上报失败绝不阻断填充。
 */

import { MSG } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { health, matchFields, reportLogs, login as apiLogin, refreshAuth, createSession, patchSession, blockSession } from '../core/api-client.js';
import { AUTH_KEY, createAuth, fromTokenBundle, canRefresh } from '../core/token-store.js';
import { statsFromLogs, mergeStats, sessionCreatePayload, sessionPatchPayload, shouldSync } from '../core/session-sync.js';

/** 内存态会话（SW 可能被回收，关键状态另存 chrome.storage.session） */
let currentSession = null;

async function getConfig() {
  const stored = await chrome.storage.local.get(['baseUrl', 'gatewayBase', 'profile']);
  return {
    baseUrl: stored.baseUrl || CONFIG.INTELLIGENCE_BASE,
    gatewayBase: stored.gatewayBase || CONFIG.GATEWAY_BASE,
    profile: stored.profile || null,
  };
}

// ---------------------------------------------------------------- 鉴权

async function getAuth() {
  try {
    const obj = await chrome.storage.local.get([AUTH_KEY]);
    return createAuth(obj[AUTH_KEY]);
  } catch {
    return null;
  }
}

async function setAuth(auth) {
  if (!auth) return chrome.storage.local.remove([AUTH_KEY]);
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

/**
 * 带凭证调用网关：无凭证 → skipped；401 → refresh 重放一次；刷新失败 → 清凭证。
 * @returns {Promise<{ok:boolean, skipped?:boolean, authExpired?:boolean, ...}>}
 */
async function withAuthedCall(fn) {
  const auth = await getAuth();
  if (!shouldSync(auth)) return { ok: false, skipped: true, error: '未登录' };

  const cfg = await getConfig();
  let res = await fn(auth.access_token, cfg);
  if (res && res.status === 401) {
    if (canRefresh(auth)) {
      const r = await refreshAuth({ refresh_token: auth.refresh_token, gatewayBase: cfg.gatewayBase });
      const bundle = r.ok ? r.data : null;
      if (bundle && bundle.access_token) {
        const next = fromTokenBundle(bundle, Date.now(), auth.email);
        await setAuth(next);
        res = await fn(next.access_token, cfg);
      } else {
        await setAuth(null);
        return { ok: false, authExpired: true, error: '登录已过期，请重新登录' };
      }
    } else {
      await setAuth(null);
      return { ok: false, authExpired: true, error: 'Token 已失效，请重新获取' };
    }
  }
  return res;
}

/** 无凭证时的静默跳过（未登录不阻断、不打扰） */
function skipped() {
  return Promise.resolve({ ok: false, skipped: true, error: '未登录' });
}

/** 确保服务端会话存在（有凭证时创建一次；幂等） */
async function ensureServerSession({ systemCode = '', stepIndex = 0 } = {}) {
  if (currentSession && currentSession.serverId) return currentSession.serverId;
  const res = await withAuthedCall((token, cfg) =>
    createSession(sessionCreatePayload({ systemCode, stepIndex }), { token, gatewayBase: cfg.gatewayBase }));
  if (res.ok && res.data && res.data.id) {
    currentSession = { ...(currentSession || {}), serverId: res.data.id, at: Date.now() };
    return res.data.id;
  }
  return null;
}

// ---------------------------------------------------------------- 消息路由

async function handleMatchFields(message) {
  const cfg = await getConfig();
  const systemCode = message.system_code || '';
  // 有凭证才建服务端会话；建不起来（未登录/失败）照常走本地流程
  const serverId = shouldSync(await getAuth()) ? await ensureServerSession({ systemCode, stepIndex: message.step_index }) : null;
  const payload = {
    session_id: message.session_id ?? serverId ?? null,
    page_url: message.page_url || '',
    system_code: systemCode,
    profile: cfg.profile,
    fields: message.fields || [],
  };
  const res = await matchFields(payload, { baseUrl: cfg.baseUrl });
  if (res.ok) {
    currentSession = {
      ...(currentSession || {}),
      id: payload.session_id,
      serverId: serverId ?? currentSession?.serverId ?? null,
      page_url: payload.page_url,
      system_code: systemCode,
      stats: currentSession?.stats || null,
      at: Date.now(),
    };
  }
  return res;
}

/** 上报日志：注入会话 id → 401 自动续期重放 → 采纳返回的 session_id → PATCH 累计统计 */
async function handleReportLogs(message) {
  const auth = await getAuth();
  if (!shouldSync(auth)) return skipped();
  const payload = { ...(message.payload || {}) };
  if (payload.session_id == null && currentSession?.serverId) payload.session_id = currentSession.serverId;

  const res = await withAuthedCall((token, cfg) =>
    reportLogs(payload, { token, gatewayBase: cfg.gatewayBase }));
  if (!res.ok) return res;

  const sessionId = res.data?.session_id ?? payload.session_id ?? null;
  if (sessionId && (!currentSession || currentSession.serverId !== sessionId)) {
    currentSession = { ...(currentSession || {}), serverId: sessionId, at: Date.now() };
  }
  // 统计累计 + PATCH（fail-open：PATCH 失败不影响上报结果）
  const stats = mergeStats(currentSession?.stats, statsFromLogs(payload.logs));
  currentSession = { ...(currentSession || {}), stats, at: Date.now() };
  if (sessionId) {
    withAuthedCall((token, cfg) =>
      patchSession(sessionId, sessionPatchPayload({ stats }), { token, gatewayBase: cfg.gatewayBase }))
      .catch(() => {});
  }
  return res;
}

/** 换步：PATCH step_index（fail-open） */
async function handleStepChanged(payload) {
  const stepIndex = Number(payload.index) || 0;
  currentSession = {
    ...(currentSession || {}),
    step: stepIndex,
    step_label: payload.label || '',
    page_url: payload.url || currentSession?.page_url || '',
    at: Date.now(),
  };
  const serverId = currentSession.serverId;
  if (serverId && shouldSync(await getAuth())) {
    withAuthedCall((token, cfg) =>
      patchSession(serverId, sessionPatchPayload({ stepIndex: stepIndex }), { token, gatewayBase: cfg.gatewayBase }))
      .catch(() => {});
  }
  return stepIndex;
}

/** 阻断上报 → blocked（fail-open） */
async function handleBlock(reason) {
  currentSession = { ...(currentSession || {}), blocked: true, reason: reason || '', at: Date.now() };
  const serverId = currentSession.serverId;
  if (serverId && shouldSync(await getAuth())) {
    withAuthedCall((token, cfg) =>
      blockSession(serverId, reason, { token, gatewayBase: cfg.gatewayBase }))
      .catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === MSG.MATCH_FIELDS) {
    handleMatchFields(message).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }

  if (type === MSG.REPORT_LOGS) {
    handleReportLogs(message).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (type === MSG.SESSION_BLOCK) {
    handleBlock(message.reason || '').then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
    return true;
  }

  // 多步向导：记录当前步骤，并在扩展图标上显示进度角标
  if (type === MSG.STEP_CHANGED) {
    const payload = message.payload || {};
    handleStepChanged(payload).then((stepIndex) => {
      if (_sender?.tab?.id) {
        chrome.action.setBadgeText({ tabId: _sender.tab.id, text: stepIndex ? String(stepIndex) : '' });
        chrome.action.setBadgeBackgroundColor({ tabId: _sender.tab.id, color: '#2563eb' });
      }
      sendResponse({ ok: true, step: stepIndex });
    }).catch(() => sendResponse({ ok: true, step: 0 }));
    return true;
  }

  if (type === 'ext:health') {
    getConfig()
      .then((cfg) => health({ baseUrl: cfg.baseUrl }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (type === 'ext:get-config') {
    getConfig().then(sendResponse).catch(() => sendResponse({ baseUrl: CONFIG.INTELLIGENCE_BASE, gatewayBase: CONFIG.GATEWAY_BASE, profile: null }));
    return true;
  }

  if (type === 'ext:set-config') {
    const patch = {};
    if (typeof message.baseUrl === 'string') patch.baseUrl = message.baseUrl;
    if (typeof message.gatewayBase === 'string') patch.gatewayBase = message.gatewayBase;
    if (message.profile !== undefined) patch.profile = message.profile;
    chrome.storage.local.set(patch).then(() => sendResponse({ ok: true }));
    return true;
  }

  // ------------------------------------------------------------ 鉴权消息

  if (type === 'ext:login') {
    getConfig()
      .then((cfg) => apiLogin({ email: message.email, password: message.password, gatewayBase: cfg.gatewayBase }))
      .then(async (res) => {
        if (!res.ok) return res;
        const auth = fromTokenBundle(res.data, Date.now(), String(message.email || '').trim());
        if (!auth) return { ok: false, error: '登录响应缺少 access_token' };
        await setAuth(auth);
        return { ok: true, data: { email: auth.email, expires_at: auth.expires_at } };
      })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (type === 'ext:set-token') {
    const auth = createAuth({ access_token: String(message.token || '').trim(), pasted: true });
    if (!auth) { sendResponse({ ok: false, error: 'Token 不能为空' }); return true; }
    setAuth(auth).then(() => sendResponse({ ok: true, data: { pasted: true } })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (type === 'ext:logout') {
    setAuth(null).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'ext:auth-state') {
    getAuth().then((auth) => {
      if (!auth) return { ok: true, data: { authed: false } };
      return { ok: true, data: { authed: true, email: auth.email, pasted: auth.pasted === true } };
    }).then(sendResponse).catch(() => sendResponse({ ok: true, data: { authed: false } }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[留学网申助手] 已安装');
});
