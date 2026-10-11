/**
 * 后台 Service Worker。
 *
 * 职责：
 *   ① 代内容脚本发起跨域请求（SW 拥有 host_permissions，不受页面 CSP 限制）；
 *   ② 维护填写会话状态（session_id / 当前步骤 / 统计），供断点续填；
 *   ③ 响应 popup 的健康检查与设置读写。
 */

import { MSG } from '../shared/constants.js';
import { CONFIG } from '../shared/config.js';
import { health, matchFields, reportLogs } from '../core/api-client.js';

/** 内存态会话（SW 可能被回收，关键状态另存 chrome.storage.session） */
let currentSession = null;

async function getConfig() {
  const stored = await chrome.storage.local.get(['baseUrl', 'profile']);
  return {
    baseUrl: stored.baseUrl || CONFIG.INTELLIGENCE_BASE,
    profile: stored.profile || null,
  };
}

/** 匹配字段：注入档案 + 平台标识后转发 */
async function handleMatchFields(message) {
  const cfg = await getConfig();
  const payload = {
    session_id: message.session_id ?? currentSession?.id ?? null,
    page_url: message.page_url || '',
    system_code: message.system_code || '',
    profile: cfg.profile,
    fields: message.fields || [],
  };
  const res = await matchFields(payload, { baseUrl: cfg.baseUrl });
  if (res.ok && payload.session_id) {
    currentSession = { id: payload.session_id, page_url: payload.page_url, at: Date.now() };
  }
  return res;
}

/** 消息路由 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === MSG.MATCH_FIELDS) {
    handleMatchFields(message).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 异步响应
  }

  if (type === MSG.REPORT_LOGS) {
    getConfig()
      .then((cfg) => reportLogs(message.payload, { baseUrl: cfg.baseUrl }))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (type === MSG.SESSION_BLOCK) {
    currentSession = { ...(currentSession || {}), blocked: true, reason: message.reason || '', at: Date.now() };
    sendResponse({ ok: true });
    return true;
  }

  // 多步向导：记录当前步骤，并在扩展图标上显示进度角标
  if (type === MSG.STEP_CHANGED) {
    const payload = message.payload || {};
    const stepIndex = Number(payload.index) || 0;
    currentSession = {
      ...(currentSession || {}),
      step: stepIndex,
      step_label: payload.label || '',
      page_url: payload.url || currentSession?.page_url || '',
      at: Date.now(),
    };
    if (_sender?.tab?.id) {
      chrome.action.setBadgeText({ tabId: _sender.tab.id, text: stepIndex ? String(stepIndex) : '' });
      chrome.action.setBadgeBackgroundColor({ tabId: _sender.tab.id, color: '#2563eb' });
    }
    sendResponse({ ok: true, step: stepIndex });
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
    getConfig().then(sendResponse).catch(() => sendResponse({ baseUrl: CONFIG.INTELLIGENCE_BASE, profile: null }));
    return true;
  }

  if (type === 'ext:set-config') {
    const patch = {};
    if (typeof message.baseUrl === 'string') patch.baseUrl = message.baseUrl;
    if (message.profile !== undefined) patch.profile = message.profile;
    chrome.storage.local.set(patch).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[留学网申助手] 已安装');
});
