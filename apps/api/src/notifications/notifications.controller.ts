/**
 * 订阅匹配与推送接口（契约 §6.2 扩展）。
 *
 *   GET  /api/v1/subscriptions/{id}/preview     预览匹配结果（不写记录）
 *   POST /api/v1/subscriptions/{id}/run         立即匹配并推送
 *   POST /api/v1/subscriptions/run-all          批量执行全部启用订阅（管理员）
 *   GET  /api/v1/notifications                  我的推送记录
 *   GET  /api/v1/notifications/stats            推送状态统计
 */

import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { BizError } from '../common/biz-error';
import { NotificationsService } from './notifications.service';

type Traced = Request & { traceId?: string };

@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notify: NotificationsService) {}

  /** 预览：只算不推，用于用户调参 */
  @Get('subscriptions/:id/preview')
  preview(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: Record<string, any>,
    @Req() req: Traced,
  ) {
    return this.notify.preview(user.userId, id, {
      windowDays: query.window_days,
      limit: query.limit,
      traceId: req.traceId,
    });
  }

  /** 立即执行一次匹配与推送 */
  @Post('subscriptions/:id/run')
  run(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: Record<string, any>,
    @Req() req: Traced,
  ) {
    return this.notify.run(user.userId, id, {
      windowDays: query.window_days,
      limit: query.limit,
      traceId: req.traceId,
    });
  }

  /**
   * 批量执行全部启用订阅（调度器 / 运维调用）。
   * 涉及所有用户，限管理员。
   */
  @Post('subscriptions/run-all')
  runAll(
    @CurrentUser() user: AuthUser,
    @Query() query: Record<string, any>,
    @Req() req: Traced,
  ) {
    if (user.role !== 'admin') throw BizError.forbidden('需要管理员权限');
    return this.notify.runAll({
      windowDays: query.window_days,
      limit: query.limit,
      traceId: req.traceId,
    });
  }

  /** 我的推送记录 */
  @Get('notifications')
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, any>) {
    return this.notify.listDeliveries(user.userId, query);
  }

  /** 推送状态统计 */
  @Get('notifications/stats')
  stats(@CurrentUser() user: AuthUser) {
    return this.notify.deliveryStats(user.userId);
  }
}
