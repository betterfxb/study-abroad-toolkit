/**
 * 内容脚本：页面侧的编排入口。
 *
 * 单页流程（对齐架构详设 §3 关键设计点 1 状态机）：
 *   IDLE → SCANNING（采集字段）→ FILLING（应用指令）→ SAVING（校验+上报）→ DONE
 *   任一环节命中验证码/风控 → BLOCKED，暂停并提示人工。
 *
 * **多步向导**：网申普遍 5~7 步。插件监听页面变化（URL / DOM），
 * 用户点「下一步」后自动识别新步骤并重新扫描填充，跨步骤累计会话进度。
 * 首次进入页面只提示、不自动写数据；用户点过一次「一键填充」后，本会话
 * 后续步骤才自动填充（`armed`）——保证「人工主导、可复核」。
 *
 * 合规红线：**不点击提交/下一步按钮，不绕过验证码**。
 *
 * 注意：MV3 内容脚本不支持静态 ESM import，故用动态 import 引入核心模块。
 */

(async () => {
  const coreBase = chrome.runtime.getURL('src/core/');
  const sharedBase = chrome.runtime.getURL('src/shared/');

  const [{ MSG, STATE, STEP_STABLE_MS }, { detectSystemCode }, { scanPage },
    { planInstructions, summarize }, { applyPlan },
    { validateElement, detectBlockers, findMissingRequired },
    { StepController }, { StepWatcher },
    { siteKey, touchRecord, findResumable, pruneStore, formatResumeHint, loadStore, saveStore }] = await Promise.all([
    import(`${sharedBase}constants.js`),
    import(`${sharedBase}config.js`),
    import(`${coreBase}field-extractor.js`),
    import(`${coreBase}planner.js`),
    import(`${coreBase}filler.js`),
    import(`${coreBase}validator.js`),
    import(`${coreBase}step-controller.js`),
    import(`${coreBase}step-watcher.js`),
    import(`${coreBase}session-store.js`),
  ]);

  // 防止重复注入
  if (window.__qiuzhiInjected) return;
  window.__qiuzhiInjected = true;

  // ------------------------------------------------------------------ 浮窗 UI
  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'qiuzhi-panel-host';
    const shadow = host.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('src/content/panel.css');
    shadow.appendChild(link);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head">
        <span class="dot" data-role="dot"></span>
        <span class="title">留学网申助手</span>
        <button class="close" title="收起">×</button>
      </div>
      <div class="body">
        <div class="status" data-role="status">待命</div>
        <div class="stats" data-role="stats"></div>
        <label class="auto">
          <input type="checkbox" data-role="auto" checked>
          <span>进入新步骤自动填充</span>
        </label>
      </div>
      <div class="foot">
        <button class="primary" data-role="scan">扫描字段</button>
        <button class="primary" data-role="fill">一键填充</button>
      </div>
    `;
    shadow.appendChild(panel);

    const $ = (role) => shadow.querySelector(`[data-role="${role}"]`);
    return {
      host,
      shadow,
      setStatus: (text, tone = '') => {
        const el = $('status');
        el.textContent = text;
        el.className = `status ${tone}`.trim();
      },
      setStats: (text) => { $('stats').textContent = text || ''; },
      setDot: (tone) => { $('dot').className = `dot ${tone}`.trim(); },
      onScan: (fn) => $('scan').addEventListener('click', fn),
      onFill: (fn) => $('fill').addEventListener('click', fn),
      onClose: (fn) => shadow.querySelector('.close').addEventListener('click', fn),
      onToggleAuto: (fn) => $('auto').addEventListener('change', (e) => fn(e.target.checked)),
      setAuto: (on) => { $('auto').checked = Boolean(on); },
      setBusy: (busy) => {
        $('scan').disabled = busy;
        $('fill').disabled = busy;
      },
    };
  }

  const ui = buildPanel();
  document.documentElement.appendChild(ui.host);
  ui.onClose(() => { ui.host.style.display = 'none'; });

  // ------------------------------------------------------------------ 状态机与会话
  const controller = new StepController({
    onChange: (next) => {
      const tone = next === STATE.BLOCKED || next === STATE.ERROR ? 'bad'
        : next === STATE.DONE ? 'good' : '';
      ui.setDot(tone);
    },
  });

  const systemCode = detectSystemCode(location.href);
  let lastFields = [];
  let lastPlan = null;

  /** 会话状态：跨步骤累计 */
  const session = {
    /** 用户是否已表达过填充意图（首次进入不自动写数据） */
    armed: false,
    /** 自动填充新步骤（用户可关） */
    autoFill: true,
    steps: 0,
    filled: 0,
    review: 0,
    missing: 0,
    busy: false,
  };

  // 读取 popup 保存的「新步骤自动填充」偏好（默认开）
  try {
    const stored = await chrome.storage.local.get(['autoFill']);
    if (stored?.autoFill === false) session.autoFill = false;
  } catch {
    /* storage 不可用则保持默认 */
  }
  ui.setAuto(session.autoFill);

  // 断点续填：恢复本站上次进度（只提示、不自动写数据，armed 门禁不变）
  const resumeSiteKey = siteKey(location.href);
  let resumeHint = '';
  async function persistProgress(patch) {
    try {
      const store = pruneStore(await loadStore());
      store[resumeSiteKey] = touchRecord(store[resumeSiteKey], {
        systemCode, url: location.href, ...patch,
      });
      await saveStore(null, store);
    } catch {
      /* 进度持久化失败不阻断主流程 */
    }
  }
  try {
    const prev = findResumable(await loadStore(), resumeSiteKey);
    if (prev) {
      session.steps = prev.stepIndex || 0;
      session.filled = prev.filled || 0;
      session.review = prev.review || 0;
      session.missing = prev.missing || 0;
      resumeHint = formatResumeHint(prev);
      renderStats();
    }
  } catch {
    /* 无历史进度则正常冷启动 */
  }

  function renderStats() {
    const parts = [];
    if (session.steps > 0) parts.push(`第 ${session.steps} 步`);
    if (session.armed) parts.push(`累计填充 ${session.filled}`);
    if (session.missing > 0) parts.push(`必填缺口 ${session.missing}`);
    ui.setStats(parts.join(' · '));
  }

  // ------------------------------------------------------------------ 扫描
  function doScan() {
    controller.reset();
    controller.transition(STATE.SCANNING);

    const blocked = detectBlockers(document);
    if (blocked.blocked) {
      controller.transition(STATE.BLOCKED, blocked);
      ui.setStatus(`已暂停：${blocked.reason}`, 'bad');
      chrome.runtime.sendMessage({ type: MSG.SESSION_BLOCK, reason: blocked.reason }).catch(() => {});
      return [];
    }

    lastFields = scanPage(document);
    controller.tryTransition(STATE.DONE);
    ui.setStatus(`识别到 ${lastFields.length} 个可填字段`, 'good');
    renderStats();
    return lastFields;
  }

  // ------------------------------------------------------------------ 填充
  async function doFill(options = {}) {
    const { auto = false } = options;

    if (!lastFields.length) doScan();
    if (!lastFields.length) {
      ui.setStatus('当前页面没有可填字段', 'bad');
      return { ok: false, reason: 'no_fields' };
    }

    session.busy = true;
    ui.setBusy(true);
    ui.setStatus(auto ? '检测到新步骤，正在填充…' : '正在请求字段匹配…');

    const res = await chrome.runtime.sendMessage({
      type: MSG.MATCH_FIELDS,
      page_url: location.href,
      system_code: systemCode,
      fields: lastFields,
    });

    if (!res || !res.ok) {
      controller.tryTransition(STATE.ERROR, res);
      ui.setStatus(`匹配失败：${res?.error || '未知错误'}`, 'bad');
      session.busy = false;
      ui.setBusy(false);
      return { ok: false, reason: 'match_failed' };
    }

    const data = res.data || {};
    if (data.blocked) {
      controller.transition(STATE.BLOCKED, data);
      ui.setStatus('服务端判定需人工处理，已暂停', 'bad');
      session.busy = false;
      ui.setBusy(false);
      return { ok: false, reason: 'blocked' };
    }

    controller.transition(STATE.FILLING);
    const plan = planInstructions(data.instructions || []);
    lastPlan = plan;

    const applied = applyPlan(document, plan);
    controller.transition(STATE.SAVING);

    // 校验：只统计真正写入的
    let okCount = 0;
    let reviewCount = 0;
    for (const log of applied.logs) {
      if (log.result === 'filled') okCount += 1;
      else if (log.result === 'review') reviewCount += 1;
    }

    const stats = summarize(plan, lastFields.length);
    const missing = findMissingRequired(collectAllControls());

    // 累计到会话 + 持久化断点
    session.armed = true;
    session.filled += okCount;
    session.review += reviewCount;
    session.missing = missing.length;
    void persistProgress({
      stepIndex: session.steps, filled: session.filled,
      review: session.review, missing: session.missing,
    });

    controller.tryTransition(STATE.DONE);
    ui.setStatus(
      `${auto ? '新步骤已自动填充' : '已填充'} ${okCount} 个字段` +
      `（自动 ${stats.fill} / 待复核 ${stats.review}）`,
      'good',
    );
    renderStats();

    // 上报（失败不阻断）
    chrome.runtime.sendMessage({
      type: MSG.REPORT_LOGS,
      payload: {
        session_id: data.session_id ?? null,
        logs: applied.logs.map((l) => ({
          field_key: l.field_key || null,
          selector: l.selector,
          confidence: l.confidence ?? null,
          result: l.result,
        })),
      },
    }).catch(() => {});

    session.busy = false;
    ui.setBusy(false);
    return { ok: true, filled: okCount, review: reviewCount, missing: missing.length };
  }

  /** 采集全部控件用于必填校验 */
  function collectAllControls() {
    return Array.from(document.querySelectorAll('input, select, textarea'));
  }

  // ------------------------------------------------------------------ 多步向导
  const watcher = new StepWatcher({
    stableMs: STEP_STABLE_MS,
    onStepChange: (event) => {
      session.steps = event.index;
      renderStats();
      // 未填充也记步骤，跨天回来能定位到上次离开的步骤
      void persistProgress({ stepIndex: event.index });

      chrome.runtime.sendMessage({
        type: MSG.STEP_CHANGED,
        payload: {
          index: event.index,
          label: event.label,
          field_count: event.fieldCount,
          url: event.url,
        },
      }).catch(() => {});

      if (!event.fillable) {
        ui.setStatus(`已进入${event.label}（无表单字段）`);
        return;
      }
      if (!session.autoFill) {
        ui.setStatus(`${event.label}：识别到 ${event.fieldCount} 个字段，点「一键填充」继续`);
        return;
      }
      // 首次进入只提示：不写数据，等用户主动点一次
      if (!session.armed) {
        ui.setStatus(`${event.label}：识别到 ${event.fieldCount} 个字段，点「一键填充」开始`);
        return;
      }
      if (session.busy) return;

      // 自动：重新扫描本步骤字段后填充
      lastFields = scanPage(document);
      void doFill({ auto: true });
    },
  });

  /** 取一段页面文本用于识别「Step 2 of 5」这类步骤文案 */
  function pageText() {
    try {
      return (document.body?.textContent || '').slice(0, 3000);
    } catch {
      return '';
    }
  }

  /** 采集快照并交给监听器判断是否换步 */
  function observeSnapshot() {
    const blocked = detectBlockers(document);
    if (blocked.blocked) return; // 风控页面不参与步骤判定

    const fields = scanPage(document);
    watcher.observe({ url: location.href, fields, text: pageText() });
  }

  // DOM 变化 → 防抖后判定
  let observeTimer = null;
  function scheduleObserve() {
    if (observeTimer) clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      observeTimer = null;
      observeSnapshot();
    }, 300);
  }

  try {
    const observer = new MutationObserver(scheduleObserve);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* 某些页面禁止观察，忽略 */
  }

  // URL 变化（SPA 的 pushState 不触发 popstate，故轮询兜底）
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleObserve();
    }
  }, 1000);
  window.addEventListener('popstate', scheduleObserve);
  window.addEventListener('hashchange', scheduleObserve);

  // 首屏先判定一次（页面已就绪的情况）
  scheduleObserve();

  // ------------------------------------------------------------------ 绑定
  ui.onScan(() => { doScan(); });
  ui.onFill(() => { void doFill(); });
  ui.onToggleAuto((on) => {
    session.autoFill = on;
    // 同步给 popup，保持两处开关一致
    chrome.storage.local.set({ autoFill: on }).catch(() => {});
    ui.setStatus(on ? '已开启：进入新步骤会自动填充' : '已关闭自动填充');
    renderStats();
  });

  // 后台触发（popup 点「开始填充」）
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.START_FILL) {
      doFill().then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (message?.type === MSG.RESCAN) {
      doScan();
      sendResponse({ ok: true, count: lastFields.length });
      return true;
    }
    if (message?.type === MSG.TOGGLE_AUTO) {
      session.autoFill = Boolean(message.enabled);
      ui.setAuto(session.autoFill);
      sendResponse({ ok: true, autoFill: session.autoFill });
      return true;
    }
    return false;
  });

  ui.setStatus(resumeHint || `已就绪 · 平台 ${systemCode}`);
})();
