/**
 * 订阅匹配与推送编排（契约 §6.2）。
 *
 * 流程：
 *   1. 从 crawler-service 拉取时间窗口内的岗位（一次拉取可服务多个订阅）
 *   2. 用 matching.service 的纯函数做匹配与排序
 *   3. 与历史推送记录比对去重（UNIQUE(subscription_id, job_id) 双保险）
 *   4. 落推送记录；需要回调的渠道（webhook / wechat）**合并成一次请求**发出
 *
 * 渠道语义：
 *   * webhook / wechat：真实 HTTP POST 到订阅的 webhook_url，成功记 `sent`、失败记 `failed`
 *   * email：渲染主题与正文后排队（`pending`），由外部发信器消费（网关不内置 SMTP 客户端）
 */

import { Injectable, Logger } from '@nestjs/common';
import { BizError, ErrorCode } from '../common/biz-error';
import { pageResult, parsePagination } from '../common/pagination';
import { DatabaseService } from '../db/database.service';
import { ProxyService } from '../proxy/proxy.service';
import { SubscriptionsService, view, type SubscriptionRow } from '../subscriptions/subscriptions.service';
import { matchJobs, renderDigestTitle, type JobLike, type MatchInput } from './matching';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_SCAN_LIMIT = 200;
const MAX_SCAN_LIMIT = 500;
const MAX_PREVIEW_ITEMS = 50;
const WEBHOOK_TIMEOUT_MS = 8000;

export interface DeliveryRow {
  id: number;
  subscription_id: number;
  user_id: number;
  job_id: number;
  channel: string;
  status: string;
  score: number;
  title: string;
  payload: string;
  error: string;
  created_at: string;
  sent_at: string;
}

export interface RunOptions {
  windowDays?: number;
  limit?: number;
  traceId?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notify');

  constructor(
    private readonly db: DatabaseService,
    private readonly subs: SubscriptionsService,
    private readonly proxy: ProxyService,
  ) {}

  // ---------------------------------------------------------------- 数据源
  /** 拉取时间窗口内的岗位（来自 crawler-service） */
  private async fetchJobs(windowDays: number, limit: number, traceId: string): Promise<JobLike[]> {
    const since = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
    const r = await this.proxy.forward(this.proxy.crawlerBase, '/jobs', {
      query: { date_from: since, status: 'all', size: limit, sort: 'published_at:desc' },
      traceId,
    });
    if (!r.ok || !r.json) {
      throw new BizError(
        ErrorCode.SOURCE_FAILED,
        r.error || `岗位库不可用（HTTP ${r.status}）`,
        503,
      );
    }
    const items = Array.isArray(r.json.items) ? r.json.items : [];
    return items as JobLike[];
  }

  private toInput(row: SubscriptionRow): MatchInput {
    return {
      keywords: safeArray(row.keywords),
      cities: safeArray(row.cities),
      education: row.education || '',
      requireAllKeywords: Boolean(row.require_all_keywords),
    };
  }

  private normOpts(opts: RunOptions) {
    const windowDays = clampInt(opts.windowDays, DEFAULT_WINDOW_DAYS, 1, 90);
    const limit = clampInt(opts.limit, DEFAULT_SCAN_LIMIT, 1, MAX_SCAN_LIMIT);
    return { windowDays, limit, traceId: opts.traceId || '' };
  }

  // ---------------------------------------------------------------- 预览
  /** 预览匹配结果，不写任何记录 */
  async preview(userId: number, id: number, opts: RunOptions = {}) {
    const row = this.subs.getOwned(userId, id);
    const { windowDays, limit, traceId } = this.normOpts(opts);

    const jobs = await this.fetchJobs(windowDays, limit, traceId);
    const matched = matchJobs(this.toInput(row), jobs);

    return {
      subscription: view(row),
      window_days: windowDays,
      scanned: jobs.length,
      matched: matched.length,
      items: matched.slice(0, MAX_PREVIEW_ITEMS).map(({ job, result }) => ({
        ...job,
        match_score: result.score,
        match_reason: result.reason,
        match_hits: result.hits,
      })),
    };
  }

  // ---------------------------------------------------------------- 执行
  /** 立即执行一次（按归属校验，供用户接口调用） */
  async run(userId: number, id: number, opts: RunOptions = {}) {
    return this.runRow(this.subs.getOwned(userId, id), opts);
  }

  /**
   * 执行指定的订阅行：匹配 → 去重 → 落记录 → 推送。
   * **不做归属校验**，供调度器按到期列表直接调用（入参是数据库原始行）。
   */
  async runRow(row: SubscriptionRow, opts: RunOptions = {}) {
    if (!row.enabled) throw BizError.invalid('订阅已停用，请先启用再执行');

    const { windowDays, limit, traceId } = this.normOpts(opts);
    const jobs = await this.fetchJobs(windowDays, limit, traceId);
    const result = await this.deliver(row, jobs, traceId);
    this.subs.touchRun(row.id);

    return {
      subscription_id: row.id,
      name: row.name,
      window_days: windowDays,
      scanned: jobs.length,
      matched: result.matched,
      delivered: result.delivered,
      duplicate: result.duplicate,
      status: result.status,
      channel: row.channel,
      error: result.error,
    };
  }

  /** 批量执行全部启用中的订阅（供调度器调用），岗位只拉一次 */
  async runAll(opts: RunOptions = {}) {
    const rows = this.subs.listEnabled();
    if (!rows.length) {
      return { subscriptions: 0, scanned: 0, matched: 0, delivered: 0, duplicate: 0, items: [] };
    }

    const { windowDays, limit, traceId } = this.normOpts(opts);
    const jobs = await this.fetchJobs(windowDays, limit, traceId);

    const items: any[] = [];
    let matched = 0;
    let delivered = 0;
    let duplicate = 0;

    for (const row of rows) {
      const r = await this.deliver(row, jobs, traceId);
      this.subs.touchRun(row.id);
      matched += r.matched;
      delivered += r.delivered;
      duplicate += r.duplicate;
      items.push({
        subscription_id: row.id,
        name: row.name,
        channel: row.channel,
        matched: r.matched,
        delivered: r.delivered,
        duplicate: r.duplicate,
        status: r.status,
        error: r.error,
      });
    }

    return {
      subscriptions: rows.length,
      scanned: jobs.length,
      matched,
      delivered,
      duplicate,
      items,
    };
  }

  /**
   * 单个订阅的落库与推送。
   * 先去重落记录（保证幂等），再把本次新增的合并成一次推送。
   */
  private async deliver(row: SubscriptionRow, jobs: JobLike[], traceId: string) {
    const matched = matchJobs(this.toInput(row), jobs);

    const existing = new Set(
      this.db
        .all<{ job_id: number }>(
          'SELECT job_id FROM subscription_deliveries WHERE subscription_id = ?',
          row.id,
        )
        .map((r) => r.job_id),
    );

    const fresh = matched.filter((m) => !existing.has(Number(m.job.id)));
    const duplicate = matched.length - fresh.length;

    if (!fresh.length) {
      return { matched: matched.length, delivered: 0, duplicate, status: 'no_new', error: '' };
    }

    const now = new Date().toISOString();
    const subject = renderDigestTitle(row.name, fresh.length);
    const items = fresh.map(({ job, result }) => ({
      id: Number(job.id),
      company: job.company || '',
      title: job.title || '',
      city: job.city || '',
      salary: job.salary || '',
      education_req: job.education_req || '',
      deadline: job.deadline || '',
      url: job.article?.url || '',
      source: job.article?.account_name || '',
      published_at: job.article?.published_at || '',
      score: result.score,
      reason: result.reason,
    }));
    const payload = { subject, count: items.length, items };

    // 1) 先落记录（INSERT OR IGNORE + 唯一约束，双保险）
    const ids: number[] = [];
    this.db.tx(() => {
      for (const it of items) {
        const res = this.db.run(
          `INSERT OR IGNORE INTO subscription_deliveries(
             subscription_id, user_id, job_id, channel, status, score, title, payload, error, created_at, sent_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, '', ?, '')`,
          row.id, row.user_id, it.id, row.channel, it.score, subject, JSON.stringify(payload), now,
        );
        if (Number(res.changes) > 0) ids.push(Number(res.lastInsertRowid));
      }
    });

    if (!ids.length) {
      return { matched: matched.length, delivered: 0, duplicate, status: 'no_new', error: '' };
    }

    // 2) 需要回调的渠道：真实发送
    if (row.channel === 'webhook' || row.channel === 'wechat') {
      const body = row.channel === 'wechat'
        ? { msgtype: 'markdown', markdown: { content: renderWechatMarkdown(row.name, items) } }
        : { subscription: { id: row.id, name: row.name }, generated_at: now, count: items.length, items };

      const sent = await this.postWebhook(row.webhook_url, body);
      const status = sent.ok ? 'sent' : 'failed';
      const sentAt = sent.ok ? new Date().toISOString() : '';
      for (const did of ids) {
        this.db.run(
          'UPDATE subscription_deliveries SET status = ?, error = ?, sent_at = ? WHERE id = ?',
          status, sent.error || '', sentAt, did,
        );
      }
      if (!sent.ok) this.logger.warn(`订阅 ${row.id} 推送失败：${sent.error}`);
      return { matched: matched.length, delivered: ids.length, duplicate, status, error: sent.error || '' };
    }

    // 3) email：排队等待外部发信器
    return { matched: matched.length, delivered: ids.length, duplicate, status: 'pending', error: '' };
  }

  private async postWebhook(url: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
    if (!url) return { ok: false, error: '未配置 webhook_url' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, error: `推送目标返回 HTTP ${res.status}` };
      return { ok: true };
    } catch (e: any) {
      clearTimeout(timer);
      return { ok: false, error: e?.name === 'AbortError' ? '推送超时' : (e?.message || '推送失败') };
    }
  }

  // ---------------------------------------------------------------- 记录查询
  /** 我的推送记录（可按订阅 / 状态过滤） */
  listDeliveries(userId: number, query: Record<string, any> = {}) {
    const p = parsePagination(query);
    const where = ['user_id = ?'];
    const params: any[] = [userId];

    if (query.subscription_id !== undefined && query.subscription_id !== '') {
      where.push('subscription_id = ?');
      params.push(Number(query.subscription_id));
    }
    if (query.status) {
      where.push('status = ?');
      params.push(String(query.status));
    }
    const clause = `WHERE ${where.join(' AND ')}`;

    const total = this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM subscription_deliveries ${clause}`, ...params,
    )!.c;
    const rows = this.db.all<DeliveryRow>(
      `SELECT * FROM subscription_deliveries ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params, p.size, p.offset,
    );

    return pageResult(
      rows.map((r) => ({
        id: r.id,
        subscription_id: r.subscription_id,
        job_id: r.job_id,
        channel: r.channel,
        status: r.status,
        score: r.score,
        title: r.title,
        error: r.error,
        created_at: r.created_at,
        sent_at: r.sent_at,
        payload: safeJson(r.payload),
      })),
      total,
      p,
    );
  }

  /** 推送统计：按状态汇总，供控制台展示 */
  deliveryStats(userId: number) {
    const rows = this.db.all<{ status: string; c: number }>(
      'SELECT status, COUNT(*) AS c FROM subscription_deliveries WHERE user_id = ? GROUP BY status',
      userId,
    );
    const out: Record<string, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    let total = 0;
    for (const r of rows) {
      out[r.status] = Number(r.c);
      total += Number(r.c);
    }
    return { total, ...out };
  }
}

// ------------------------------------------------------------------ 工具
function safeArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function safeJson(raw: string): any {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function clampInt(v: unknown, dft: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 企业微信机器人 markdown */
function renderWechatMarkdown(name: string, items: Array<Record<string, any>>): string {
  const lines = [`**${renderDigestTitle(name, items.length)}**`, ''];
  for (const it of items.slice(0, 10)) {
    lines.push(
      `> **${it.company}** · ${it.title}\n> ${it.city} | ${it.salary || '面议'} | 截止 ${it.deadline || '未标注'}`,
    );
  }
  if (items.length > 10) lines.push(`\n…… 另有 ${items.length - 10} 个岗位，请登录控制台查看。`);
  return lines.join('\n');
}
