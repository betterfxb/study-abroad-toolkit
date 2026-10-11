/**
 * 实习信息订阅模块（契约 §6.2）。
 *
 * GET    /api/v1/subscriptions       我的订阅
 * POST   /api/v1/subscriptions       新建订阅
 * PATCH  /api/v1/subscriptions/{id}  修改
 * DELETE /api/v1/subscriptions/{id}  删除
 *
 * 本服务只管**规则 CRUD**；匹配与推送编排见 notifications/。
 */

import { Injectable } from '@nestjs/common';
import { BizError } from '../common/biz-error';
import {
  describeSchedule, isValidSchedule, nextRunAt, resolveTzOffset,
} from '../common/schedule';
import { DatabaseService } from '../db/database.service';

const CHANNELS = ['email', 'wechat', 'webhook'];
/** 需要回调地址的渠道 */
const NEEDS_WEBHOOK = ['wechat', 'webhook'];

export interface SubscriptionRow {
  id: number;
  user_id: number;
  name: string;
  keywords: string;
  cities: string;
  education: string;
  channel: string;
  enabled: number;
  require_all_keywords: number;
  webhook_url: string;
  last_run_at: string;
  schedule: string;
  next_run_at: string;
  locked_at: string;
  locked_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * 多值字段归一化：数组原样采用；字符串按分隔符拆。
 *
 * 分隔符必须覆盖**顿号「、」**：控制台的提示文案与占位符示例用的就是顿号
 * （"数据分析、SQL"），若这里只认逗号，用户按提示输入会被整体当成**一个关键词**，
 * 订阅将永远匹配不到任何岗位。
 */
function toJsonArray(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => String(x)).filter(Boolean));
  if (typeof v === 'string' && v.trim()) {
    return JSON.stringify(v.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean));
  }
  return '[]';
}

function parseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 对外视图：把 JSON 字符串还原成数组，enabled 还原成布尔 */
export function view(row: SubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    keywords: parseArray(row.keywords),
    cities: parseArray(row.cities),
    education: row.education,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    require_all_keywords: Boolean(row.require_all_keywords),
    webhook_url: row.webhook_url,
    last_run_at: row.last_run_at,
    schedule: row.schedule || '',
    schedule_text: describeSchedule(row.schedule || ''),
    next_run_at: row.next_run_at || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 校验调度表达式：空串合法（不自动执行），非法表达式抛 1001 */
function validateSchedule(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (!isValidSchedule(s)) {
    throw BizError.invalid(
      'schedule 表达式非法（可用：hourly / daily@09:00 / weekly@MO,WE@09:00 / every:30m / every:6h，留空表示不自动执行）',
    );
  }
  return s;
}

/** 校验回调地址：http(s) 且可解析 */
function validateWebhook(url: string): string {
  const v = url.trim();
  if (!v) return '';
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw BizError.invalid('webhook_url 不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw BizError.invalid('webhook_url 仅支持 http/https');
  }
  return v;
}

@Injectable()
export class SubscriptionsService {
  constructor(private readonly db: DatabaseService) {}

  list(userId: number) {
    const rows = this.db.all<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC',
      userId,
    );
    return { total: rows.length, items: rows.map(view) };
  }

  /** 全部启用中的订阅（供调度器批量执行，不区分用户） */
  listEnabled(): SubscriptionRow[] {
    return this.db.all<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY id ASC',
    );
  }

  private findOwned(userId: number, id: number): SubscriptionRow {
    const row = this.db.get<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE id = ? AND user_id = ?',
      id, userId,
    );
    if (!row) throw BizError.notFound('订阅不存在');
    return row;
  }

  /** 供 notifications 模块使用：按归属取原始行 */
  getOwned(userId: number, id: number): SubscriptionRow {
    return this.findOwned(userId, id);
  }

  create(userId: number, body: any) {
    const name = String(body?.name || '').trim();
    if (!name) throw BizError.invalid('缺少订阅名称');
    const channel = String(body?.channel || 'email');
    if (!CHANNELS.includes(channel)) {
      throw BizError.invalid(`channel 非法（可用：${CHANNELS.join(', ')}）`);
    }
    const webhookUrl = validateWebhook(String(body?.webhook_url || ''));
    if (NEEDS_WEBHOOK.includes(channel) && !webhookUrl) {
      throw BizError.invalid(`channel=${channel} 时必须提供 webhook_url`);
    }
    const schedule = validateSchedule(body?.schedule);

    const now = new Date();
    const nextRun = schedule ? nextRunAt(schedule, now, resolveTzOffset()) : null;
    const res = this.db.run(
      `INSERT INTO subscriptions(user_id, name, keywords, cities, education, channel, enabled,
         require_all_keywords, webhook_url, last_run_at, schedule, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
      userId,
      name,
      toJsonArray(body?.keywords),
      toJsonArray(body?.cities),
      String(body?.education || ''),
      channel,
      body?.enabled === false ? 0 : 1,
      body?.require_all_keywords ? 1 : 0,
      webhookUrl,
      schedule,
      nextRun ? nextRun.toISOString() : '',
      now.toISOString(),
      now.toISOString(),
    );
    return view(this.findOwned(userId, Number(res.lastInsertRowid)));
  }

  update(userId: number, id: number, body: any) {
    const current = this.findOwned(userId, id);
    const sets: string[] = [];
    const params: any[] = [];

    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw BizError.invalid('订阅名称不能为空');
      sets.push('name = ?');
      params.push(name);
    }
    if (body?.keywords !== undefined) {
      sets.push('keywords = ?');
      params.push(toJsonArray(body.keywords));
    }
    if (body?.cities !== undefined) {
      sets.push('cities = ?');
      params.push(toJsonArray(body.cities));
    }
    if (body?.education !== undefined) {
      sets.push('education = ?');
      params.push(String(body.education));
    }
    if (body?.channel !== undefined) {
      if (!CHANNELS.includes(String(body.channel))) {
        throw BizError.invalid(`channel 非法（可用：${CHANNELS.join(', ')}）`);
      }
      sets.push('channel = ?');
      params.push(String(body.channel));
    }
    if (body?.webhook_url !== undefined) {
      sets.push('webhook_url = ?');
      params.push(validateWebhook(String(body.webhook_url)));
    }
    if (body?.require_all_keywords !== undefined) {
      sets.push('require_all_keywords = ?');
      params.push(body.require_all_keywords ? 1 : 0);
    }
    if (body?.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
    }
    if (body?.schedule !== undefined) {
      const schedule = validateSchedule(body.schedule);
      sets.push('schedule = ?');
      params.push(schedule);
      // 表达式变化 → 以当前时刻为锚点重算下次执行（不做历史补跑）
      const next = schedule ? nextRunAt(schedule, new Date(), resolveTzOffset()) : null;
      sets.push('next_run_at = ?');
      params.push(next ? next.toISOString() : '');
    } else if (body?.enabled !== undefined && body.enabled) {
      // 重新启用：重算 next_run_at，避免因停用期间的陈旧值导致「一启用就补跑」
      const next = current.schedule
        ? nextRunAt(current.schedule, new Date(), resolveTzOffset())
        : null;
      sets.push('next_run_at = ?');
      params.push(next ? next.toISOString() : '');
    }
    if (!sets.length) throw BizError.invalid('没有可更新的字段');

    // 渠道与地址的一致性校验（用更新后的值复核）
    const nextChannel = body?.channel !== undefined ? String(body.channel) : current.channel;
    const nextUrl = body?.webhook_url !== undefined
      ? validateWebhook(String(body.webhook_url))
      : current.webhook_url;
    if (NEEDS_WEBHOOK.includes(nextChannel) && !nextUrl) {
      throw BizError.invalid(`channel=${nextChannel} 时必须提供 webhook_url`);
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id, userId);
    this.db.run(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, ...params);
    return view(this.findOwned(userId, id));
  }

  remove(userId: number, id: number) {
    this.findOwned(userId, id);
    this.db.run('DELETE FROM subscription_deliveries WHERE subscription_id = ?', id);
    this.db.run('DELETE FROM subscriptions WHERE id = ? AND user_id = ?', id, userId);
    return { ok: true, id };
  }

  /** 记录一次执行时间 */
  touchRun(id: number) {
    this.db.run('UPDATE subscriptions SET last_run_at = ? WHERE id = ?', new Date().toISOString(), id);
  }

  // ---------------------------------------------------------------- 调度支持

  /** 按 id 取原始行（调度器按到期列表直接执行，不做归属校验） */
  getById(id: number): SubscriptionRow | undefined {
    return this.db.get<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ?', id);
  }

  /** 写入下次执行时刻（空串表示不再自动执行） */
  setNextRun(id: number, iso: string) {
    this.db.run('UPDATE subscriptions SET next_run_at = ? WHERE id = ?', iso || '', id);
  }

  /**
   * 到期订阅**候选**列表：启用中 + 配了表达式 + （未算过 或 已到点）。
   * 走 idx_subscriptions_due 索引，避免每轮全表遍历。
   *
   * 注意：这只是候选集合，**真正的到期判定在 `claimDue()`** ——
   * 候选查询与抢占之间存在时间窗，多实例下必须由原子抢占做最终裁决。
   */
  listDue(nowIso: string): SubscriptionRow[] {
    return this.db.all<SubscriptionRow>(
      `SELECT * FROM subscriptions
        WHERE enabled = 1 AND schedule <> '' AND (next_run_at = '' OR next_run_at <= ?)
        ORDER BY next_run_at ASC, id ASC`,
      nowIso,
    );
  }

  // ---------------------------------------------------------------- 分布式抢占

  /**
   * 原子抢占一条到期订阅：**只有返回 true 的实例才允许执行**。
   *
   * 单条 UPDATE 同时完成三重判断，因此多实例并发时天然互斥（SQLite 的写锁 + 条件更新）：
   *   ① 仍然启用且有表达式；
   *   ② 仍然处于到期状态（未被别的实例推进 `next_run_at`）；
   *   ③ 无人持锁，或持锁时间已超过 TTL（持有者崩溃）。
   *
   * @param staleBeforeIso 早于该时刻的锁视为陈旧，可被抢占
   */
  claimDue(id: number, instanceId: string, nowIso: string, staleBeforeIso: string): boolean {
    const res = this.db.run(
      `UPDATE subscriptions
          SET locked_at = ?, locked_by = ?
        WHERE id = ?
          AND enabled = 1
          AND schedule <> ''
          AND (next_run_at = '' OR next_run_at <= ?)
          AND (locked_at = '' OR locked_at <= ?)`,
      nowIso, instanceId, id, nowIso, staleBeforeIso,
    );
    return Number(res.changes) > 0;
  }

  /** 推进 `next_run_at` 并释放锁（成败都要调用，避免热循环 + 锁泄漏） */
  releaseAdvance(id: number, nextRunAtIso: string) {
    this.db.run(
      `UPDATE subscriptions SET next_run_at = ?, locked_at = '', locked_by = '' WHERE id = ?`,
      nextRunAtIso || '', id,
    );
  }

  /** 仅释放锁，不动 `next_run_at` */
  releaseLock(id: number) {
    this.db.run("UPDATE subscriptions SET locked_at = '', locked_by = '' WHERE id = ?", id);
  }

  /** 实例退出时释放自己持有的全部锁，避免其它实例空等 TTL */
  releaseInstanceLocks(instanceId: string): number {
    const res = this.db.run(
      "UPDATE subscriptions SET locked_at = '', locked_by = '' WHERE locked_by = ? AND locked_at <> ''",
      instanceId,
    );
    return Number(res.changes);
  }

  /** 当前仍被有效持有的锁数量（陈旧锁不计） */
  lockedCount(staleBeforeIso: string): number {
    return Number(this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM subscriptions WHERE locked_at <> '' AND locked_at > ?",
      staleBeforeIso,
    )!.c);
  }

  /** 调度概况：配了定时的订阅数 / 到期数 / 最近一次待执行时刻 */
  scheduledStats(nowIso: string) {
    const scheduled = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM subscriptions WHERE enabled = 1 AND schedule <> ''",
    )!.c;
    const next = this.db.get<{ next_run_at: string }>(
      `SELECT next_run_at FROM subscriptions
        WHERE enabled = 1 AND schedule <> '' AND next_run_at <> ''
        ORDER BY next_run_at ASC LIMIT 1`,
    );
    return {
      scheduled: Number(scheduled),
      due: this.listDue(nowIso).length,
      next_run_at: next?.next_run_at || '',
    };
  }
}

export { CHANNELS, NEEDS_WEBHOOK };
