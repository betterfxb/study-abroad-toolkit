/**
 * 对外统一入口：把 crawler-service 与 intelligence-service 收敛到网关之下。
 *
 *   GET  /api/v1/jobs*             → crawler-service 岗位库（读侧）
 *   POST /api/v1/gpa/convert       → intelligence-service GPA 换算（纯计算，免鉴权）
 *   POST /ext/v1/match-fields      → intelligence-service 字段匹配
 *   GET  /ext/v1/dictionary        → intelligence-service 字段词典
 *   （POST /ext/v1/fill-logs 与会话接口由 ExtModule 本地实现，不再转发——
 *    intelligence 无状态，会话归属用户必须落在网关）
 *   GET  /api/v1/meta/services     → 上游服务健康聚合
 *
 * 说明：岗位检索与字段匹配对插件/控制台开放；生产环境应加限流与插件 token 校验。
 */

import { All, Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ProxyService } from './proxy.service';

type Traced = Request & { traceId?: string };

@Controller()
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}

  // ------------------------------------------------------------ 岗位库（crawler）
  @Get('api/v1/jobs')
  async jobs(@Req() req: Traced, @Query() query: Record<string, any>) {
    const r = await this.proxy.forward(this.proxy.crawlerBase, '/jobs', {
      query, traceId: req.traceId,
    });
    return this.proxy.normalize(r, req.traceId || '');
  }

  @Get('api/v1/jobs/facets')
  async jobsFacets(@Req() req: Traced, @Query() query: Record<string, any>) {
    const r = await this.proxy.forward(this.proxy.crawlerBase, '/jobs/facets', {
      query, traceId: req.traceId,
    });
    return this.proxy.normalize(r, req.traceId || '');
  }

  /** CSV 导出：直接透传二进制/文本，不套 JSON 封装 */
  @Get('api/v1/jobs/export.csv')
  async jobsExport(@Req() req: Traced, @Res() res: Response, @Query() query: Record<string, any>) {
    const r = await this.proxy.forward(this.proxy.crawlerBase, '/jobs/export.csv', {
      query, traceId: req.traceId,
    });
    if (!r.ok || (!r.buffer && r.text === undefined)) {
      res.status(r.status).json({
        code: 4002,
        message: r.error || `上游返回 ${r.status}`,
        data: null,
        trace_id: req.traceId || '',
      });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="jobs.csv"');
    // 发原始字节，保留上游的 UTF-8 BOM（Excel 直接打开不乱码）
    res.send(r.buffer ?? Buffer.from(r.text ?? '', 'utf8'));
  }

  @Get('api/v1/jobs/:id')
  async jobDetail(@Req() req: Traced, @Query() query: Record<string, any>) {
    const id = req.params.id;
    const r = await this.proxy.forward(this.proxy.crawlerBase, `/jobs/${id}`, {
      query, traceId: req.traceId,
    });
    return this.proxy.normalize(r, req.traceId || '');
  }

  /** GPA 换算：纯计算无敏感数据，与岗位库同样免鉴权；上游不可用时 503 + 4002 */
  @All('api/v1/gpa/convert')
  async gpaConvert(@Req() req: Traced) {
    const r = await this.proxy.forward(this.proxy.intelligenceBase, '/internal/gpa/convert', {
      method: 'POST', body: req.body, traceId: req.traceId,
    });
    return this.proxy.normalize(r, req.traceId || '');
  }

  // ------------------------------------------------------------ 字段匹配（intelligence）
  @All('ext/v1/match-fields')
  async matchFields(@Req() req: Traced) {
    const r = await this.proxy.forward(this.proxy.intelligenceBase, '/ext/v1/match-fields', {
      method: 'POST', body: req.body, traceId: req.traceId,
    });
    return this.proxy.normalize(r, req.traceId || '');
  }

  @Get('ext/v1/dictionary')
  async dictionary(@Req() req: Traced) {
    const r = await this.proxy.forward(this.proxy.intelligenceBase, '/ext/v1/dictionary', {
      traceId: req.traceId,
    });
    return this.proxy.normalize(r, req.traceId || '');
  }

  // ------------------------------------------------------------ 元信息
  @Get('api/v1/meta/services')
  async services(@Req() req: Traced) {
    const [crawler, intelligence] = await Promise.all([
      this.proxy.forward(this.proxy.crawlerBase, '/health', { traceId: req.traceId }),
      this.proxy.forward(this.proxy.intelligenceBase, '/health', { traceId: req.traceId }),
    ]);
    return {
      gateway: { ok: true, service: 'api-gateway' },
      crawler: crawler.ok ? { ok: true, ...(crawler.json || {}) } : { ok: false, error: crawler.error },
      intelligence: intelligence.ok
        ? { ok: true, ...(intelligence.json || {}) }
        : { ok: false, error: intelligence.error },
    };
  }
}
