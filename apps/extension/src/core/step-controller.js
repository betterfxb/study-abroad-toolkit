/**
 * 步骤控制器：状态机 IDLE → SCANNING → FILLING → SAVING → NEXT_STEP → DONE。
 * （对齐架构详设 §3 关键设计点 1）
 *
 * 纯逻辑，无 DOM 依赖 → 可在 Node 中直接测试。
 * 任何非法转移都会被拒绝并抛出，避免静默进入错误状态。
 */

import { STATE, TRANSITIONS } from '../shared/constants.js';

export class StepController {
  /**
   * @param {{onChange?: (next: string, prev: string, payload?: any) => void, initial?: string}} options
   */
  constructor(options = {}) {
    this.state = options.initial || STATE.IDLE;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.history = [{ state: this.state, payload: null, at: Date.now() }];
    this.context = {};
  }

  /** 当前状态允许到达的状态 */
  allowed() {
    return TRANSITIONS[this.state] || [];
  }

  /** 判断某次转移是否合法 */
  can(next) {
    return this.allowed().includes(next);
  }

  /**
   * 执行状态转移。非法转移抛错。
   * @param {string} next
   * @param {object} [payload] 附加数据（统计、错误信息等）
   */
  transition(next, payload = null) {
    if (!this.can(next)) {
      throw new Error(`非法状态转移：${this.state} → ${next}`);
    }
    const prev = this.state;
    this.state = next;
    if (payload && typeof payload === 'object') {
      Object.assign(this.context, payload);
    }
    this.history.push({ state: next, payload, at: Date.now() });
    if (this.onChange) this.onChange(next, prev, payload);
    return this.state;
  }

  /** 尝试转移，失败返回 false（用于「尽力而为」的场景，如自动收尾） */
  tryTransition(next, payload = null) {
    if (!this.can(next)) return false;
    this.transition(next, payload);
    return true;
  }

  /** 回到起点，准备下一轮扫描 */
  reset() {
    const prev = this.state;
    this.state = STATE.IDLE;
    this.history.push({ state: STATE.IDLE, payload: null, at: Date.now() });
    if (this.onChange) this.onChange(STATE.IDLE, prev, null);
    return this.state;
  }

  get isTerminal() {
    return this.state === STATE.DONE;
  }
}
