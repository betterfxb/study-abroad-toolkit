/**
 * 档案拉取纯逻辑：判定服务端档案是否有「可填充内容」、以可注入 storage 落盘。
 *
 * 数据形状 = 契约 §2 白名单（basic_info / education / tests / experiences / addresses / documents / preferences）。
 * 覆盖策略：**只有有内容的服务端档案才写本地**——空档案绝不能打掉用户手填的本地档案；
 * documents / preferences 不计入内容判定（材料列表 ≠ 表单可填值）。
 *
 * storage 须提供 `set(items) -> Promise`（chrome.storage.local 或测试桩），
 * 因此本模块零 DOM 依赖，可直接在 Node 中测试。
 */

/** 参与覆盖判定的可填充数组键 */
const CONTENT_ARRAY_KEYS = ['education', 'tests', 'experiences', 'addresses'];

function hasNonEmptyValue(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return false;
}

/**
 * 服务端档案是否包含可填充内容。
 * @param {unknown} profile
 * @returns {boolean}
 */
export function hasProfileContent(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;

  const basicInfo = profile.basic_info;
  if (basicInfo && typeof basicInfo === 'object' && !Array.isArray(basicInfo)) {
    for (const value of Object.values(basicInfo)) {
      if (hasNonEmptyValue(value)) return true;
    }
  }
  for (const key of CONTENT_ARRAY_KEYS) {
    const arr = profile[key];
    if (Array.isArray(arr) && arr.length > 0) return true;
  }
  return false;
}

/**
 * 有内容才写入本地 storage（chrome.storage.local 同构）。
 * @param {unknown} profile 服务端 GET /api/v1/profile 的 data
 * @param {{set:(items:object)=>Promise<unknown>}} storage
 * @returns {Promise<{saved:boolean, reason?:string}>}
 */
export async function saveProfileIfNonEmpty(profile, storage) {
  if (!hasProfileContent(profile)) return { saved: false, reason: 'empty' };
  if (!storage || typeof storage.set !== 'function') return { saved: false, reason: 'no-storage' };
  await storage.set({ profile });
  return { saved: true };
}
