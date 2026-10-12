/**
 * 插件运行配置。
 * PoC 阶段直连本地 intelligence-service；生产环境改为 api-gateway 地址。
 */

export const CONFIG = Object.freeze({
  /** 字段匹配服务地址（intelligence-service） */
  INTELLIGENCE_BASE: 'http://localhost:8090',
  /** 网关地址（鉴权 / fill-logs / 服务端会话） */
  GATEWAY_BASE: 'http://localhost:8080',
  /** 请求超时（毫秒） */
  REQUEST_TIMEOUT_MS: 15000,
  /** 单次上报的最大字段数 */
  MAX_FIELDS_PER_REQUEST: 200,
  /** 填充后等待页面响应的时间（毫秒） */
  SETTLE_MS: 120,
});

/** 页面平台识别规则（用于 system_code 与个性化适配） */
const SYSTEM_PATTERNS = [
  { code: 'applyweb', test: /applyweb\.com|apply\.applyweb/i },
  { code: 'liaison', test: /liaisoncas\.com|liaison\./i },
  { code: 'slate', test: /slate\.|apply\.\w+\.edu/i },
  { code: 'commonapp', test: /commonapp\.org/i },
  { code: 'gradcas', test: /gradcas\.|cas\.liaisoncas/i },
];

/** 根据 URL 判断网申平台标识 */
export function detectSystemCode(url) {
  if (!url) return 'unknown';
  for (const p of SYSTEM_PATTERNS) {
    if (p.test.test(url)) return p.code;
  }
  return 'generic';
}
