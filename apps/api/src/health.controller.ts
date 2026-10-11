/** 健康检查：网关自身 + 上游依赖聚合（无需鉴权） */

import { Controller, Get, Req } from '@nestjs/common';
import { ProxyService } from './proxy/proxy.service';

@Controller()
export class HealthController {
  constructor(private readonly proxy: ProxyService) {}

  @Get('health')
  async health(@Req() req: any) {
    const [crawler, intelligence] = await Promise.all([
      this.proxy.forward(this.proxy.crawlerBase, '/health', { traceId: req.traceId }),
      this.proxy.forward(this.proxy.intelligenceBase, '/health', { traceId: req.traceId }),
    ]);
    return {
      ok: true,
      service: 'api-gateway',
      version: '0.1.0',
      upstream: {
        crawler: crawler.ok ? 'up' : 'down',
        intelligence: intelligence.ok ? 'up' : 'down',
      },
    };
  }
}
