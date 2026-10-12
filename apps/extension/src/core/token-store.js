/**
 * 插件鉴权 Token：纯逻辑 + 可注入 storage → 可在 Node 中零依赖测试。
 *
 * 设计：
 *   * 登录（popup 邮箱密码）→ 网关 /api/v1/auth/login → 存 access+refresh；
 *   * access 2h 过期，401 时用 refresh（30d）静默续期并重放一次；
 *   * 粘贴 Token 为兜底（无 refresh，401 即提示重新获取）；
 *   * 凭证只进 chrome.storage.local，密码绝不落盘。
 */

export const AUTH_KEY = 'ext:auth:v1';

/** 构造登录请求体（纯函数，便于断言） */
export function toLoginBody(email, password) {
  return { email: String(email || '').trim(), password: String(password || '') };
}

/** 构造刷新请求体 */
export function toRefreshBody(refreshToken) {
  return { refresh_token: String(refreshToken || '') };
}

/**
 * 归一化 token 记录。
 * @param {{access_token:string, refresh_token?:string, expires_at?:number, email?:string, pasted?:boolean}} raw
 */
export function createAuth(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const access = String(src.access_token || '');
  if (!access) return null;
  return {
    access_token: access,
    refresh_token: String(src.refresh_token || ''),
    email: String(src.email || ''),
    // 粘贴 Token 未知过期时间 → 不设 expires_at（401 时直接判失效）
    expires_at: Number.isFinite(src.expires_at) && src.expires_at > 0 ? src.expires_at : 0,
    pasted: src.pasted === true,
  };
}

/** 登录响应 TokenBundle → createAuth 输入（expires_in 秒 → 绝对时刻） */
export function fromTokenBundle(bundle, now = Date.now(), email = '') {
  const src = bundle && typeof bundle === 'object' ? bundle : {};
  const ttl = Number(src.expires_in);
  return createAuth({
    access_token: src.access_token,
    refresh_token: src.refresh_token,
    email,
    expires_at: Number.isFinite(ttl) && ttl > 0 ? now + ttl * 1000 : 0,
    pasted: false,
  });
}

/** access 是否仍可用（留 30s 提前量；无 expires_at 的粘贴 Token 视为可用） */
export function isFresh(auth, now = Date.now(), skewMs = 30000) {
  if (!auth || !auth.access_token) return false;
  if (!auth.expires_at) return true;
  return auth.expires_at - skewMs > now;
}

/** 是否具备刷新能力（有 refresh_token 且非粘贴） */
export function canRefresh(auth) {
  return !!(auth && !auth.pasted && auth.refresh_token);
}

/**
 * 选请求头：新鲜 access → X-Ext-Token；过期但可刷新 → 仍返回（调用方 401 后刷新重放）；
 * 无凭证 → null。
 */
export function pickExtHeader(auth) {
  if (!auth || !auth.access_token) return null;
  return { 'X-Ext-Token': auth.access_token };
}
