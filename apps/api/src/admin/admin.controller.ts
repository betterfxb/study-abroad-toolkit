/**
 * 管理后台接口（契约 §6.3 采集管理）。
 *
 *   GET    /api/v1/admin/sources             源列表（含健康度）
 *   POST   /api/v1/admin/sources             新增源
 *   PATCH  /api/v1/admin/sources/{id}        启用/停用、调频控
 *   POST   /api/v1/admin/sources/{id}/run    手动触发一次采集
 *   GET    /api/v1/admin/sources/{id}/health 健康度趋势
 *   POST   /api/v1/admin/degrade             切换降级层级
 *   GET    /api/v1/admin/tasks               任务列表与日志
 *   POST   /api/v1/admin/jobs/expire         手动触发岗位过期下架
 *   GET    /api/v1/admin/adapters            适配器清单
 *   GET    /api/v1/admin/degrade             当前降级层级
 *   POST   /api/v1/admin/degrade/evaluate    自动评估降级
 *
 * 两个设计点：
 *   1. **全部限管理员**：这些接口作用于全平台的采集源，不属于任何单个用户的资源。
 *      判定与 scheduler 一致（`user.role !== 'admin'` → 1003）。
 *   2. **纯代理**：网关不重复实现采集源逻辑，转发到 crawler-service 的 `/admin/*`；
 *      上游不可用时按既有约定返回 503 + 4002，不影响网关自身可用性。
 */

import {
  Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { BizError } from '../common/biz-error';
import { ProxyService } from '../proxy/proxy.service';

type Traced = Request & { traceId?: string };

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly proxy: ProxyService) {}

  /** 统一的管理员校验：非管理员一律 1003，不泄露上游是否存在 */
  private assertAdmin(user: AuthUser) {
    if (!user || user.role !== 'admin') throw BizError.forbidden('需要管理员权限');
  }

  private async toCrawler(
    req: Traced,
    path: string,
    options: { method?: string; query?: Record<string, any>; body?: any } = {},
  ) {
    const r = await this.proxy.forward(this.proxy.crawlerBase, path, {
      ...options,
      traceId: (req as any).traceId,
    });
    return this.proxy.normalize(r, (req as any).traceId || '');
  }

  // ------------------------------------------------------------ 采集源
  @Get('sources')
  sources(@CurrentUser() user: AuthUser, @Req() req: Traced, @Query() query: Record<string, any>) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/sources', { query });
  }

  @Post('sources')
  createSource(@CurrentUser() user: AuthUser, @Req() req: Traced, @Body() body: any) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/sources', { method: 'POST', body });
  }

  @Patch('sources/:id')
  patchSource(
    @CurrentUser() user: AuthUser,
    @Req() req: Traced,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    this.assertAdmin(user);
    return this.toCrawler(req, `/admin/sources/${encodeURIComponent(id)}`, {
      method: 'PATCH', body,
    });
  }

  @Post('sources/:id/run')
  runSource(
    @CurrentUser() user: AuthUser,
    @Req() req: Traced,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    this.assertAdmin(user);
    return this.toCrawler(req, `/admin/sources/${encodeURIComponent(id)}/run`, {
      method: 'POST', body,
    });
  }

  @Get('sources/:id/health')
  sourceHealth(
    @CurrentUser() user: AuthUser,
    @Req() req: Traced,
    @Param('id') id: string,
    @Query() query: Record<string, any>,
  ) {
    this.assertAdmin(user);
    return this.toCrawler(req, `/admin/sources/${encodeURIComponent(id)}/health`, { query });
  }

  // ------------------------------------------------------------ 降级
  @Get('degrade')
  degrade(@CurrentUser() user: AuthUser, @Req() req: Traced) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/degrade');
  }

  @Post('degrade')
  setDegrade(@CurrentUser() user: AuthUser, @Req() req: Traced, @Body() body: any) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/degrade', { method: 'POST', body });
  }

  @Post('degrade/evaluate')
  evaluateDegrade(@CurrentUser() user: AuthUser, @Req() req: Traced) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/degrade/evaluate', { method: 'POST' });
  }

  @Post('jobs/expire')
  expireJobs(@CurrentUser() user: AuthUser, @Req() req: Traced, @Body() body: any) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/jobs/expire', { method: 'POST', body });
  }

  // ------------------------------------------------------------ 其它
  @Get('tasks')
  tasks(@CurrentUser() user: AuthUser, @Req() req: Traced, @Query() query: Record<string, any>) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/tasks', { query });
  }

  @Get('adapters')
  adapters(@CurrentUser() user: AuthUser, @Req() req: Traced) {
    this.assertAdmin(user);
    return this.toCrawler(req, '/admin/adapters');
  }
}
