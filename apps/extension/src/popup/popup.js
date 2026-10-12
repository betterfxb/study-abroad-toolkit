/**
 * popup 逻辑：健康检查、触发扫描/填充、设置服务地址。
 * popup 通过消息与后台 SW 通信，由 SW 转发到内容脚本。
 */

const $ = (id) => document.getElementById(id);

/** 当前活动标签页 */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** 健康检查 */
async function checkHealth() {
  const badge = $('health');
  badge.textContent = '检测中…';
  badge.className = 'badge';
  const res = await chrome.runtime.sendMessage({ type: 'ext:health' });
  if (res && res.ok) {
    badge.textContent = `正常（词典 ${res.data?.dictionary_slots ?? '?'} 槽位）`;
    badge.className = 'badge ok';
  } else {
    badge.textContent = `不可用：${res?.error || '未连接'}`;
    badge.className = 'badge bad';
  }
}

/** 向内容脚本发消息（内容脚本未注入时给出提示） */
async function sendToContent(type, extra = {}) {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: '无活动标签页' };
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (e) {
    return { ok: false, error: '请刷新页面后重试（插件尚未注入）' };
  }
}

/** 读取「新步骤自动填充」偏好（默认开） */
async function loadAutoFill() {
  const { autoFill } = await chrome.storage.local.get(['autoFill']);
  $('auto').checked = autoFill !== false;
}

/** 切换「新步骤自动填充」：落盘 + 通知当前页内容脚本 */
async function toggleAutoFill(enabled) {
  await chrome.storage.local.set({ autoFill: enabled });
  await sendToContent('ext:toggle-auto', { enabled });
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'ext:get-config' });
  if (res?.baseUrl) $('baseUrl').value = res.baseUrl;
  if (res?.gatewayBase) $('gatewayBase').value = res.gatewayBase;
}

async function saveSettings() {
  const baseUrl = $('baseUrl').value.trim();
  const gatewayBase = $('gatewayBase').value.trim();
  await chrome.runtime.sendMessage({ type: 'ext:set-config', baseUrl, gatewayBase });
  $('saveHint').textContent = '已保存';
  setTimeout(() => { $('saveHint').textContent = ''; }, 1500);
  checkHealth();
}

// ------------------------------------------------------------ 登录 / Token

function authHint(text, isErr = false) {
  const el = $('authHint');
  el.textContent = text || '';
  el.className = isErr ? 'hint err' : 'hint';
}

/** 拉取登录态并切换区块（密码输入每次操作后清空，绝不驻留） */
async function loadAuthState() {
  const res = await chrome.runtime.sendMessage({ type: 'ext:auth-state' });
  const data = res?.data || {};
  $('authOut').hidden = !!data.authed;
  $('authIn').hidden = !data.authed;
  if (data.authed) {
    $('authBadge').textContent = data.pasted ? `Token 有效${data.email ? ' · ' + data.email : ''}` : `已登录${data.email ? ' · ' + data.email : ''}`;
  }
}

async function doLogin() {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) { authHint('请输入邮箱与密码', true); return; }
  $('login').disabled = true;
  authHint('登录中…');
  const res = await chrome.runtime.sendMessage({ type: 'ext:login', email, password });
  $('login').disabled = false;
  $('password').value = ''; // 密码不驻留
  if (res?.ok) {
    authHint('登录成功，填写进度将同步到服务端');
    await loadAuthState();
  } else {
    authHint(res?.error || '登录失败', true);
  }
}

async function doSaveToken() {
  const token = $('token').value.trim();
  if (!token) { authHint('Token 不能为空', true); return; }
  const res = await chrome.runtime.sendMessage({ type: 'ext:set-token', token });
  if (res?.ok) {
    $('token').value = '';
    authHint('Token 已保存（无自动刷新，失效后请重新粘贴）');
    await loadAuthState();
  } else {
    authHint(res?.error || '保存失败', true);
  }
}

async function doLogout() {
  await chrome.runtime.sendMessage({ type: 'ext:logout' });
  authHint('已退出');
  await loadAuthState();
}

function bind() {
  $('scan').addEventListener('click', async () => {
    const res = await sendToContent('ext:rescan');
    if (!res?.ok) $('health').textContent = res?.error || '操作失败';
  });

  $('fill').addEventListener('click', async () => {
    $('fill').disabled = true;
    const res = await sendToContent('ext:start-fill');
    $('fill').disabled = false;
    if (!res?.ok) $('health').textContent = res?.error || '填充失败';
  });

  $('save').addEventListener('click', saveSettings);

  $('auto').addEventListener('change', (e) => { void toggleAutoFill(e.target.checked); });

  $('login').addEventListener('click', doLogin);
  $('logout').addEventListener('click', doLogout);
  $('saveToken').addEventListener('click', doSaveToken);
  $('showPaste').addEventListener('click', () => {
    const box = $('pasteBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('token').focus();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bind();
  await loadSettings();
  await loadAutoFill();
  await loadAuthState();
  checkHealth();
});
