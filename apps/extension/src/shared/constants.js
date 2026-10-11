/**
 * 全局常量：状态机、消息类型、置信度阈值。
 * 阈值必须与 intelligence-service（app/config.py）保持一致，否则两端行为会漂移。
 */

/** 步骤控制器状态（对齐架构详设 §3 关键设计点 1） */
export const STATE = Object.freeze({
  IDLE: 'IDLE',
  SCANNING: 'SCANNING',
  FILLING: 'FILLING',
  SAVING: 'SAVING',
  NEXT_STEP: 'NEXT_STEP',
  DONE: 'DONE',
  BLOCKED: 'BLOCKED',
  ERROR: 'ERROR',
});

/** 状态机合法转移：当前状态 → 允许到达的状态集合 */
export const TRANSITIONS = Object.freeze({
  [STATE.IDLE]: [STATE.SCANNING],
  [STATE.SCANNING]: [STATE.FILLING, STATE.BLOCKED, STATE.ERROR],
  [STATE.FILLING]: [STATE.SAVING, STATE.BLOCKED, STATE.ERROR],
  [STATE.SAVING]: [STATE.NEXT_STEP, STATE.DONE, STATE.ERROR],
  [STATE.NEXT_STEP]: [STATE.SCANNING, STATE.DONE, STATE.BLOCKED, STATE.ERROR],
  [STATE.DONE]: [STATE.SCANNING],
  [STATE.BLOCKED]: [STATE.IDLE, STATE.SCANNING],
  [STATE.ERROR]: [STATE.IDLE, STATE.SCANNING],
});

/** 置信度阈值（与 intelligence-service 对齐） */
export const THRESHOLD = Object.freeze({
  AUTO_FILL: 0.90,
  REVIEW: 0.60,
});

/** 填充动作 */
export const ACTION = Object.freeze({
  FILL: 'fill',
  REVIEW: 'review',
  SKIP: 'skip',
});

/** 插件 ↔ 后台 ↔ 页面 的消息类型 */
export const MSG = Object.freeze({
  // 页面 → 后台
  MATCH_FIELDS: 'ext:match-fields',
  REPORT_LOGS: 'ext:report-logs',
  // 后台 → 页面
  START_FILL: 'ext:start-fill',
  RESCAN: 'ext:rescan',
  // 页面 → 后台（会话）
  SESSION_BLOCK: 'ext:session-block',
  // 页面 → 后台（多步向导：确认换步，上报进度）
  STEP_CHANGED: 'ext:step-changed',
  // 后台 / popup → 页面：切换自动填充
  TOGGLE_AUTO: 'ext:toggle-auto',
  // 广播
  STATE_CHANGED: 'ext:state-changed',
});

/**
 * 多步向导：换步判定的稳定窗口（毫秒）。
 * 页面加载中 DOM 会反复变化，只有指纹持续稳定这段时间才确认换步。
 */
export const STEP_STABLE_MS = 800;

/** 表单控件选择器 */
export const FORM_CONTROL_SELECTOR = 'input, select, textarea';

/** 需要跳过的 input 类型 */
export const SKIP_INPUT_TYPES = Object.freeze([
  'hidden', 'submit', 'button', 'reset', 'image', 'file',
]);

/** 敏感字段：默认不上云、本地填充（与 intelligence-service settings.local_only_fields 对齐） */
export const LOCAL_ONLY_FIELDS = Object.freeze([
  'basic_info.passport_name',
  'basic_info.passport_number',
  'documents.transcript',
]);

/** 高亮样式类名（注入到宿主页面） */
export const HIGHLIGHT = Object.freeze({
  REVIEW: 'qiuzhi-fill-review',
  FILLED: 'qiuzhi-fill-filled',
  PANEL: 'qiuzhi-panel',
});
