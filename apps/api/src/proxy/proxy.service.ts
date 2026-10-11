/**
 * 上游服务代理：把 crawler-service / intelligence-service 统一到网关之下，
 * 让控制台与插件只需面对一个 Base URL（并统一 trace_id）。
 *
 * 上游不可用时返回 503 + 业务错误码，不影响网关自身可用性。
 */

import { Injectable, Logger } from '@nestjs/common';

export interface ForwardResult {
  status: number;
  contentType: string;
  /** 文本原文（CSV 等） */
  text?: string;
  /** 原始字节（保留 UTF-8 BOM，fetch().text() 会剥掉 BOM） */
  buffer?: Buffer;
  /** JSON 解析结果 */
  json?: any;
  ok: boolean;
  error?: string;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger('Proxy');

  readonly crawlerBase = process.env.CRAWLER_BASE || 'http://localhost:8100';
  readonly intelligenceBase = process.env.INTELLIGENCE_BASE || 'http://localhost:8090';

  private readonly timeoutMs = Number(process.env.PROXY_TIMEOUT_MS || 15000);

  async forward(
    base: string,
    path: string,
    options: { method?: string; query?: Record<string, any>; body?: any; traceId?: string; accept?: string } = {},
  ): Promise<ForwardResult> {
    const { method = 'GET', query, body, traceId, accept } = options;
    const qs = this.buildQuery(query);
    const url = `${base.replace(/\/$/, '')}${path}${qs}`;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(traceId ? { 'X-Trace-Id': traceId } : {}),
          ...(accept ? { Accept: accept } : {}),
        },
        body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json().catch(() => null);
        return { status: res.status, contentType, json, ok: res.ok };
      }
      // 非 JSON：按原始字节读取，避免 fetch().text() 剥离 UTF-8 BOM
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, contentType, buffer, text: buffer.toString('utf8'), ok: res.ok };
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      const msg = err?.name === 'AbortError' ? '上游服务超时' : (err?.message || '上游服务不可达');
      this.logger.warn(`代理失败 ${url}: ${msg}`);
      return { status: 503, contentType: 'application/json', ok: false, error: msg };
    }
  }

  /** 构造查询串（跳过空值，数组展开为重复键） */
  private buildQuery(query?: Record<string, any>): string {
    if (!query) return '';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        for (const item of v) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
      } else {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      }
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  /**
   * 统一归一化上游响应为网关契约封装。
   *   * 上游已封装（含 code）→ 取其 data / message / code，trace_id 换成网关的
   *   * 上游裸对象（如 crawler /jobs）→ 整体作为 data
   */
  normalize(result: ForwardResult, traceId: string) {
    if (!result.ok) {
      return {
        code: result.status === 404 ? 2001 : 4002,
        message: result.error || result.json?.detail || `上游返回 ${result.status}`,
        data: null,
        trace_id: traceId,
      };
    }
    const upstream = result.json;
    if (upstream && typeof upstream === 'object' && typeof upstream.code === 'number') {
      return {
        code: upstream.code,
        message: upstream.message ?? 'ok',
        data: upstream.data ?? null,
        trace_id: traceId,
      };
    }
    return { code: 0, message: 'ok', data: upstream ?? null, trace_id: traceId };
  }
}
