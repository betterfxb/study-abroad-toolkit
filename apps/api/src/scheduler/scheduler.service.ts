/**
 * 订阅定时调度器（契约 §6.2 定时执行）。
 *
 * 职责：按固定节奏 tick 一次，把**已到点**的订阅交给 notifications 服务执行。
 *
 * 设计要点：
 *   * **到期判定走 SQL**：`next_run_at` 落库并建索引，tick 只查「启用中 + 有表达式 +
 *     已到点」的行，不遍历全表。
 *   * **多实例互斥（分布式）**：候选查询与执行之间用**原子抢占**（`claimDue` 单条条件 UPDATE）
 *     裁决，只有抢到的实例才执行；锁带 TTL，持有者崩溃后可被其它实例接管。
 *     因此同一订阅在多实例部署下**只会被执行一次**。
 *   * **失败也要推进 next_run_at**：否则一个上游不可用的订阅会被每轮反复重试，形成热循环。
 *   * **单飞**：上一轮 tick 未结束时直接跳过，避免同实例内并发重复推送。
 *   * **逐订阅隔离**：单个订阅抛错不影响同轮其它订阅。
 *   * **不阻塞进程退出**：定时器 `unref()`，测试/CI 里不会挂住。
 *   * 零第三方依赖：不引入 cron / Redis 锁，表达式解析在 `common/schedule.ts`（纯函数）。
 *
 * 环境变量：
 *   SCHEDULER_ENABLED=0        关闭调度（默认开启）
 *   SCHEDULER_INTERVAL_MS       tick 间隔，默认 60000（夹在 5s ~ 1h）
 *   SCHEDULER_TZ_OFFSET         时区偏移分钟，默认 480（东八区）
 *   SCHEDULER_INSTANCE_ID       实例标识，默认 hostname:pid:随机（多实例部署建议显式指定）
 *   SCHEDULER_LOCK_TTL_MS       抢占锁 TTL，默认 300000（夹在 30s ~ 1h）
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { nextRunAt, resolveTzOffset } from '../common/schedule';
import { DatabaseService } from '../db/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscriptionsService, type SubscriptionRow } from '../subscriptions/subscriptions.service';

const DEFAULT_INTERVAL_MS = 60000;
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 3600000;
const DEFAULT_LOCK_TTL_MS = 300000;
const MIN_LOCK_TTL_MS = 30000;
const MAX_LOCK_TTL_MS = 3600000;

export interface TickItem {
  subscription_id: number;
  name: string;
  ok: boolean;
  status: string;
  delivered: number;
  error: string;
}

export interface TickResult {
  at: string;
  /** 本轮到期的订阅数 */
  scanned: number;
  /** 成功执行数 */
  ran: number;
  /** 失败数（不影响其它订阅） */
  failed: number;
  /** 被其它实例抢占（或已被推进）而让出的数量 */
  skipped: number;
  /** 上一轮尚未结束而跳过 */
  busy: boolean;
  items: TickItem[];
}

export interface SchedulerStatus {
  enabled: boolean;
  instance_id: string;
  interval_ms: number;
  lock_ttl_ms: number;
  tz_offset_minutes: number;
  scheduled: number;
  due: number;
  locked: number;
  next_run_at: string;
  running: boolean;
  ticks: number;
  /** 因上一轮未结束而跳过的轮次（单飞保护触发次数） */
  busy_ticks: number;
  /**
   * 累计指标（自本实例启动起）。多实例互斥的判定要用**累计值**：
   * `last_result` 只保留最近一轮，采样必然漏掉「真正执行的那一轮」。
   */
  scanned_total: number;
  ran_total: number;
  failed_total: number;
  skipped_total: number;
  last_tick_at: string;
  last_result: TickResult | null;
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Scheduler');

  readonly enabled: boolean;
  readonly instanceId: string;
  readonly intervalMs: number;
  readonly lockTtlMs: number;
  readonly tzOffsetMinutes: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;
  private busyTicks = 0;
  private scannedTotal = 0;
  private ranTotal = 0;
  private failedTotal = 0;
  private skippedTotal = 0;
  private lastTickAt = '';
  private lastResult: TickResult | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly subs: SubscriptionsService,
    private readonly notify: NotificationsService,
  ) {
    this.enabled = process.env.SCHEDULER_ENABLED !== '0';
    this.instanceId = resolveInstanceId();
    this.intervalMs = clampInt(
      process.env.SCHEDULER_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS,
    );
    this.lockTtlMs = clampInt(
      process.env.SCHEDULER_LOCK_TTL_MS, DEFAULT_LOCK_TTL_MS, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS,
    );
    this.tzOffsetMinutes = resolveTzOffset();
  }

  onModuleInit() {
    const filled = this.backfill();
    if (!this.enabled) {
      this.logger.log(`调度器已关闭（SCHEDULER_ENABLED=0），回填 ${filled} 条 next_run_at`);
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(
      `调度器已启动：实例 ${this.instanceId} · 每 ${this.intervalMs / 1000}s 扫描一次`
      + ` · 锁 TTL ${this.lockTtlMs / 1000}s · 时区偏移 ${this.tzOffsetMinutes}min · 回填 ${filled} 条`,
    );
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 释放本实例持有的锁，避免其它实例空等 TTL（有在跑的任务时交给它的 finally 释放）
    if (!this.running) {
      try {
        const n = this.subs.releaseInstanceLocks(this.instanceId);
        if (n > 0) this.logger.log(`退出时释放了 ${n} 个抢占锁`);
      } catch {
        /* 关闭阶段的清理失败不影响退出 */
      }
    }
  }

  /**
   * 为「配了表达式但没有 next_run_at」的订阅补算（幂等）。
   * 锚点优先取 last_run_at，其次 created_at —— 老库升级后不会一启动就集中补跑。
   */
  private backfill(): number {
    const rows = this.db.all<SubscriptionRow>(
      "SELECT * FROM subscriptions WHERE schedule <> '' AND next_run_at = ''",
    );
    let filled = 0;
    for (const row of rows) {
      const anchor = row.last_run_at || row.created_at;
      const next = nextRunAt(row.schedule, anchor || new Date(), this.tzOffsetMinutes);
      if (next) {
        this.subs.setNextRun(row.id, next.toISOString());
        filled += 1;
      }
    }
    return filled;
  }

  /** 推进 next_run_at 并释放抢占锁（成败都必须调用） */
  private advanceAndRelease(row: SubscriptionRow, from: Date) {
    const next = nextRunAt(row.schedule, from, this.tzOffsetMinutes);
    this.subs.releaseAdvance(row.id, next ? next.toISOString() : '');
  }

  /**
   * 执行一轮调度扫描。
   * @returns 本轮结果（上一轮未结束时会带 `busy: true` 直接返回）
   */
  async tick(): Promise<TickResult> {
    if (this.running) {
      this.busyTicks += 1;
      return {
        at: new Date().toISOString(), scanned: 0, ran: 0, failed: 0, skipped: 0, busy: true, items: [],
      };
    }
    this.running = true;

    const at = new Date();
    const nowIso = at.toISOString();
    const staleBeforeIso = new Date(at.getTime() - this.lockTtlMs).toISOString();
    const items: TickItem[] = [];
    let ran = 0;
    let failed = 0;
    let skipped = 0;

    try {
      const candidates = this.subs.listDue(nowIso);
      for (const row of candidates) {
        // 原子抢占：多实例并发时只有一个能拿到；拿不到就让给别的实例
        if (!this.subs.claimDue(row.id, this.instanceId, nowIso, staleBeforeIso)) {
          skipped += 1;
          continue;
        }
        try {
          const r = await this.notify.runRow(row, {
            traceId: `sched-${this.instanceId}-${row.id}-${at.getTime()}`,
          });
          ran += 1;
          items.push({
            subscription_id: row.id, name: row.name, ok: true,
            status: r.status, delivered: r.delivered, error: r.error,
          });
        } catch (e: any) {
          failed += 1;
          const msg = e?.message || String(e);
          items.push({
            subscription_id: row.id, name: row.name, ok: false,
            status: 'error', delivered: 0, error: msg,
          });
          this.logger.warn(`订阅 ${row.id}（${row.name}）执行失败：${msg}`);
        } finally {
          // 成败都推进 + 释放锁：避免失败订阅被反复重试、避免锁泄漏
          this.advanceAndRelease(row, at);
        }
      }

      this.ticks += 1;
      this.scannedTotal += candidates.length;
      this.ranTotal += ran;
      this.failedTotal += failed;
      this.skippedTotal += skipped;
      this.lastTickAt = nowIso;
      this.lastResult = {
        at: nowIso,
        scanned: candidates.length,
        ran,
        failed,
        skipped,
        busy: false,
        items,
      };
      if (candidates.length) {
        this.logger.log(
          `调度 tick：到期 ${candidates.length} · 执行 ${ran} · 失败 ${failed} · 让出 ${skipped}`,
        );
      }
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  status(): SchedulerStatus {
    const nowIso = new Date().toISOString();
    const staleBeforeIso = new Date(Date.now() - this.lockTtlMs).toISOString();
    const s = this.subs.scheduledStats(nowIso);
    return {
      enabled: this.enabled,
      instance_id: this.instanceId,
      interval_ms: this.intervalMs,
      lock_ttl_ms: this.lockTtlMs,
      tz_offset_minutes: this.tzOffsetMinutes,
      scheduled: s.scheduled,
      due: s.due,
      locked: this.subs.lockedCount(staleBeforeIso),
      next_run_at: s.next_run_at,
      running: this.running,
      ticks: this.ticks,
      busy_ticks: this.busyTicks,
      scanned_total: this.scannedTotal,
      ran_total: this.ranTotal,
      failed_total: this.failedTotal,
      skipped_total: this.skippedTotal,
      last_tick_at: this.lastTickAt,
      last_result: this.lastResult,
    };
  }
}

/** 实例标识：显式配置优先，否则 hostname:pid:随机（保证同机多进程也互不相同） */
function resolveInstanceId(): string {
  const env = String(process.env.SCHEDULER_INSTANCE_ID || '').trim();
  if (env) return env;
  return `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

function clampInt(v: unknown, dft: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
